import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { assertCreatedPost, recoveryForOwner, recoveryAfterPostRejection } from '../postRecovery';

// Run the actual composer's confirmation boundary without mounting its native
// media/location UI. This catches moving cleanup before the response guard,
// not merely the guard helper's behavior.
const composer = readFileSync(resolve(__dirname, '../../app/(tabs)/create-post.tsx'), 'utf8');
const request = composer.indexOf('await Post.create(pendingPayload)');
const start = composer.lastIndexOf('const pendingPayload =', request);
const end = composer.indexOf('setPostSuccess(true);', request) + 'setPostSuccess(true);'.length;
if (request < 0 || end < start) throw new Error('Composer confirmation boundary not found');
const persistStart = composer.indexOf('const persistRecovery = async');
const persistEnd = composer.indexOf('      await persistRecovery(recoveryForOwner(', persistStart);
const confirmation = ts.transpileModule(
  composer.slice(persistStart, persistEnd) + composer.slice(start, end),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

function fixture(existingPending = true) {
  const pendingPayload = { content: 'Saved post', client_request_id: 'stable-request-1234' };
  const recoveryRef = {
    current: {
      ownerId: 'owner',
      sourceUri: 'draft.mp4',
      upload: { url: 'https://media/uploaded.mp4' },
      ...(existingPending ? { pendingPayload } : {}),
    } as any,
  };
  let stored: any = null;
  const create = jest.fn();
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const setJson = jest.fn(async (_key: string, value: any) => {
    stored = JSON.parse(JSON.stringify(value));
  });
  const success = jest.fn();
  let requestSequence = 0;
  const context = {
    Post: { create },
    payload: { content: 'Saved post' },
    picked: { uri: 'draft.mp4', type: 'video' },
    trimmedUri: null,
    cleanupConfirmedVideoDraft: cleanup,
    recoveryRef,
    assertCreatedPost,
    recoveryForOwner,
    recoveryAfterPostRejection,
    ownerId: 'owner',
    currentOwnerRef: { current: 'owner' },
    content: 'Saved post',
    selectedGameId: undefined,
    selectedEventId: undefined,
    // Used by the post-success confirmation copy (postedEventLabel); null
    // matches the composer's own initial state and is irrelevant to the
    // recovery/retry behavior these tests actually cover.
    suggestedGame: null,
    postType: 'post',
    newPostRequestId: () => `new-request-${++requestSequence}`,
    hadPendingPayload: existingPending,
    clearPostCache: jest.fn(),
    __DEV__: false,
    selectedEventIds: [],
    recordEventPostingUnlock: jest.fn(),
    analytics: { track: jest.fn() },
    ANALYTICS_EVENTS: { POST_CREATED: 'created' },
    settings: {
      setJson,
      getJson: jest.fn(async () => stored),
      SETTINGS_KEYS: { POST_DRAFT: 'draft' },
    },
    setPreviewVisible: jest.fn(),
    setPostSuccess: success,
    setSuccessInfo: jest.fn(),
  };
  const run = () => {
    context.hadPendingPayload = Boolean(recoveryRef.current?.pendingPayload);
    return new Function(...Object.keys(context), `return (async () => { ${confirmation} })();`)(
      ...Object.values(context)
    );
  };
  return {
    context,
    run,
    pendingPayload,
    recoveryRef,
    create,
    cleanup,
    setJson,
    success,
    stored: () => stored,
  };
}

describe('composer preserves an unconfirmed pending post', () => {
  it.each([null, {}, { id: '' }])(
    'retains recovery/draft/media on %p and retries the same request',
    async response => {
      const { run, pendingPayload, recoveryRef, create, cleanup, setJson, success } = fixture();
      create.mockResolvedValueOnce(response).mockResolvedValueOnce({ id: 'post_confirmed' });
      await expect(run()).rejects.toThrow('Could not confirm your post');
      expect(create).toHaveBeenCalledTimes(1); // No automatic retry of unknown outcome.
      expect(recoveryRef.current.pendingPayload).toBe(pendingPayload);
      expect(cleanup).not.toHaveBeenCalled();
      expect(setJson).not.toHaveBeenCalledWith('draft', null);
      expect(success).not.toHaveBeenCalled();

      await run(); // Explicit retry: the persisted payload and request ID are unchanged.
      expect(create).toHaveBeenNthCalledWith(1, pendingPayload);
      expect(create).toHaveBeenNthCalledWith(2, pendingPayload);
      expect(recoveryRef.current).toBeNull();
      expect(cleanup).toHaveBeenCalledWith('draft.mp4');
      expect(setJson).toHaveBeenCalledWith('draft', null);
      expect(success).toHaveBeenCalledWith(true);
    }
  );

  it('persists a fresh validation rejection without its key, then sends edited content with a new key', async () => {
    const f = fixture(false);
    const rejection = { status: 400, data: { error: 'Invalid payload', issues: [] } };
    f.create.mockRejectedValueOnce(rejection).mockResolvedValueOnce({ id: 'post_confirmed' });
    await expect(f.run()).rejects.toBe(rejection);
    expect(f.recoveryRef.current.pendingPayload).toBeUndefined();
    expect(f.stored().recovery.pendingPayload).toBeUndefined();
    expect(f.stored().content).toBe('Saved post');
    expect(f.recoveryRef.current.upload.url).toBe('https://media/uploaded.mp4');
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.success).not.toHaveBeenCalled();
    f.context.payload.content = 'Edited post';
    f.context.content = 'Edited post';
    await f.run();
    expect(f.create.mock.calls.map(([payload]) => payload)).toEqual([
      { content: 'Saved post', client_request_id: 'new-request-1' },
      { content: 'Edited post', client_request_id: 'new-request-2' },
    ]);
  });

  it('never rotates a previously ambiguous request on a later validation rejection', async () => {
    const f = fixture(false);
    const timeout = new Error('Timed out');
    const rejection = { status: 400, data: { error: 'Invalid payload', issues: [] } };
    f.create.mockRejectedValueOnce(timeout).mockRejectedValueOnce(rejection);
    await expect(f.run()).rejects.toBe(timeout);
    const original = f.recoveryRef.current.pendingPayload;
    f.context.payload.content = 'Edits must not replace an unresolved submission';
    await expect(f.run()).rejects.toBe(rejection);
    expect(f.recoveryRef.current.pendingPayload).toBe(original);
    expect(f.create).toHaveBeenNthCalledWith(2, original);
    expect(f.stored().recovery.pendingPayload).toEqual(original);
  });

  it('keeps the rejected key if its removal cannot be verified in storage', async () => {
    const f = fixture(false);
    f.create.mockRejectedValueOnce({ status: 400, data: { error: 'Invalid payload', issues: [] } });
    f.setJson
      .mockImplementationOnce(async (_key, value) => {
        // Persist the first pending request; settings.setJson silently fails on the removal.
        f.context.settings.getJson.mockResolvedValue(JSON.parse(JSON.stringify(value)));
      })
      .mockImplementationOnce(async () => {});
    await expect(f.run()).rejects.toThrow('Could not save upload recovery');
    expect(f.recoveryRef.current.pendingPayload.client_request_id).toBe('new-request-1');
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.success).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, data: { error: 'Unknown rejection' } },
    { status: 422, data: { code: 'MEDIA_NOT_READY' } },
  ])('preserves the exact first request for unsupported rejection %p', async rejection => {
    const f = fixture(false);
    f.create.mockRejectedValueOnce(rejection);
    await expect(f.run()).rejects.toBe(rejection);
    expect(f.recoveryRef.current.pendingPayload.client_request_id).toBe('new-request-1');
    expect(f.setJson).toHaveBeenCalledTimes(1);
  });

  it('does not reset storage or recovery after the submitting account changes', async () => {
    const f = fixture(false);
    const rejection = { status: 400, data: { error: 'Invalid payload', issues: [] } };
    f.create.mockImplementationOnce(async () => {
      f.context.currentOwnerRef.current = 'other';
      throw rejection;
    });
    await expect(f.run()).rejects.toBe(rejection);
    expect(f.recoveryRef.current.pendingPayload.client_request_id).toBe('new-request-1');
    expect(f.setJson).toHaveBeenCalledTimes(1);
  });

  it('does not commit cleared recovery in memory when the account changes during readback', async () => {
    const f = fixture(false);
    f.create.mockRejectedValueOnce({ status: 400, data: { error: 'Invalid payload', issues: [] } });
    f.context.settings.getJson
      .mockImplementationOnce(async () => f.stored())
      .mockImplementationOnce(async () => {
        f.context.currentOwnerRef.current = 'other';
        return f.stored();
      });
    await expect(f.run()).rejects.toThrow('Your account changed');
    expect(f.recoveryRef.current.pendingPayload.client_request_id).toBe('new-request-1');
  });

  it('requires the persisted owner as well as matching recovery before releasing the key', async () => {
    const f = fixture(false);
    f.create.mockRejectedValueOnce({ status: 400, data: { error: 'Invalid payload', issues: [] } });
    f.context.settings.getJson
      .mockImplementationOnce(async () => f.stored())
      .mockImplementationOnce(async () => ({ ...f.stored(), ownerId: 'other' }));
    await expect(f.run()).rejects.toThrow('Could not save upload recovery');
    expect(f.recoveryRef.current.pendingPayload.client_request_id).toBe('new-request-1');
  });
});
