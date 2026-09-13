import * as FileSystem from 'expo-file-system/legacy';
import {
  deleteConfirmedMediaDraft,
  isOwnedMediaDraft,
  persistPreparedMedia,
} from '../mediaDraftFiles';
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  makeDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 123 });
});
test('copies prepared cache files to durable Documents before returning', async () => {
  const uri = await persistPreparedMedia('file:///cache/output.mp4');
  expect(uri).toMatch(/^file:\/\/\/documents\/MediaDrafts\/prepared\/.*\.mp4$/);
  expect(FileSystem.copyAsync).toHaveBeenCalledWith({ from: 'file:///cache/output.mp4', to: uri });
});
test('retains an already owned source URI', async () => {
  expect(await persistPreparedMedia('file:///documents/MediaDrafts/source.mov')).toBe(
    'file:///documents/MediaDrafts/source.mov'
  );
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});
test('only confirmed owned files can be deleted', async () => {
  for (const uri of [
    'file:///cache/other.mp4',
    'file:///documents/other.mp4',
    'file:///documents/MediaDrafts/../other.mp4',
    'file:///documents/MediaDrafts/%2e%2e/other.mp4',
  ]) {
    expect(isOwnedMediaDraft(uri)).toBe(false);
    await deleteConfirmedMediaDraft(uri);
  }
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  await deleteConfirmedMediaDraft('file:///documents/MediaDrafts/source.mov');
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///documents/MediaDrafts/source.mov', {
    idempotent: true,
  });
});
test('rejects an unreadable durable copy', async () => {
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
  await expect(persistPreparedMedia('file:///cache/output.mp4')).rejects.toThrow('preserve');
});
