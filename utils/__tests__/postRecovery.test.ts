import { reusableUpload, recoveryForOwner } from '../postRecovery';

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
