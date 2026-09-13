import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { prepareVideoForUpload } from '../compressVideo';

jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn() }));
jest.mock('react-native-compressor', () => ({ Video: { compress: jest.fn() } }));
jest.mock('../mediaDraftFiles', () => ({ persistPreparedMedia: jest.fn() }));
jest.mock('@/utils/sentry', () => ({ captureException: jest.fn() }));
const originalFetch = global.fetch;
const originalOS = Platform.OS;
beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  jest.clearAllMocks();
});
afterAll(() => {
  global.fetch = originalFetch;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
});
it('validates a browser video Blob without calling native filesystem or encoding', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, blob: async () => ({ size: 123456 }) })) as any;
  await expect(prepareVideoForUpload('blob:video')).resolves.toMatchObject({
    uri: 'blob:video',
    finalSizeBytes: 123456,
    wasCompressed: false,
  });
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
});
it.each([0, 150 * 1024 * 1024 + 1])('rejects invalid browser video size %s', async size => {
  global.fetch = jest.fn(async () => ({ ok: true, blob: async () => ({ size }) })) as any;
  await expect(prepareVideoForUpload('blob:video')).rejects.toThrow('too large');
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
});
