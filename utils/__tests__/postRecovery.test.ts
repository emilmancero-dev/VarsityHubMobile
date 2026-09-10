import {
  assertCreatedPost,
  reusableUpload,
  recoveryForOwner,
  recoveryAfterPostRejection,
} from '../postRecovery';

describe('post recovery', () => {
  const recovery = { ownerId: 'a', sourceUri: 'trim.mp4', upload: { url: 'https://media/video' } };
  it('reuses uploaded bytes when finalization failed', () => {
    expect(reusableUpload(recovery, 'a', 'trim.mp4')).toEqual(recovery.upload);
  });
  it('never crosses accounts or reuses another trim', () => {
    expect(recoveryForOwner(recovery, 'b')).toBeNull();
    expect(reusableUpload(recovery, 'a', 'other.mp4')).toBeNull();
  });
});

describe('fresh post rejection recovery', () => {
  const recovery = {
    ownerId: 'owner',
    sourceUri: 'local.mp4',
    upload: { url: 'https://media/video' },
    pendingPayload: { client_request_id: 'key', content: 'Original' },
  };
  const editableRejections = [
    { status: 400, data: { error: 'Invalid payload', issues: [] } },
    ...[
      'EVENT_NOT_FOUND',
      'EXCLUSIVE_POSTER_ONLY',
      'POSTING_WINDOW_CLOSED',
      'NO_EVENT_LOCATION',
      'LOCATION_REQUIRED',
      'TOO_FAR_FROM_VENUE',
      'Only team staff or organization admins can post to their team page',
    ].map(error => ({ status: 403, data: { error } })),
    { status: 404, data: { error: 'Team not found' } },
  ];
  it.each(editableRejections)('releases only the first rejected request for %p', error => {
    expect(recoveryAfterPostRejection(recovery, error, true)).toEqual({
      ownerId: 'owner',
      sourceUri: 'local.mp4',
      upload: recovery.upload,
    });
    expect(recoveryAfterPostRejection(recovery, error, false)).toBeNull();
    expect(recovery.pendingPayload.content).toBe('Original');
  });
  it.each([
    new Error('network'),
    { status: 400 },
    { status: 400, data: { error: 'Invalid payload' } },
    { status: 403, data: { error: 'Unknown rejection' } },
    { status: 404, data: { error: 'Not found' } },
    { status: 409, data: { code: 'IDEMPOTENCY_CONFLICT' } },
    { status: 409, data: { code: 'DUPLICATE_POST' } },
    { status: 422, data: { code: 'MEDIA_NOT_READY' } },
    { status: 429, data: { error: 'Too many requests' } },
    { status: 500, data: { error: 'Invalid payload', issues: [] } },
    { status: 400, isProtocolError: true, data: { error: 'Invalid payload', issues: [] } },
  ])('retains recovery for ambiguous or unsupported rejection %p', error => {
    expect(recoveryAfterPostRejection(recovery, error, true)).toBeNull();
  });
});

describe('post creation confirmation', () => {
  it.each([null, undefined, {}, [], 'ok', { id: 1 }, { id: '' }, { id: '   ' }])(
    'rejects an ambiguous successful response %p',
    response => {
      expect(() => assertCreatedPost(response)).toThrow('Could not confirm your post');
    }
  );

  it('accepts the top-level post ID returned by create and idempotent replay', () => {
    expect(() => assertCreatedPost({ id: 'post_confirmed', author_id: 'owner' })).not.toThrow();
  });
});
