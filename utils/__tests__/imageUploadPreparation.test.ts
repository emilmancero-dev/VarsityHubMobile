import { Image, Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import {
  compressImageForUpload,
  ensureUploadableUri,
  imageUploadResize,
} from '../ensureUploadableUri';
import { materializeICloudAssetIfNeeded } from '../materializeICloudAsset';
import { isICloudError } from '../isICloudError';

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: jest.fn(),
}));
jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getAssetInfoAsync: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => {
    success(1200, 4000);
  });
  (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({ uri: 'file://prepared.jpg' });
});

test.each([
  [4000, 2000, { width: 1920 }],
  [2000, 4000, { height: 1920 }],
])('bounds the long edge %sx%s', (width, height, resize) => {
  expect(imageUploadResize(width, height)).toEqual([{ resize }]);
});
test('does not upscale small images', () => {
  expect(imageUploadResize(400, 700)).toEqual([]);
});
test('rejects unreadable dimensions', () => {
  expect(() => imageUploadResize(0, 0)).toThrow();
});
test('prepares a portrait once using its height', async () => {
  expect(await compressImageForUpload('file://photo.heic', 'image/heic')).toEqual({
    uri: 'file://prepared.jpg',
    mimeType: 'image/jpeg',
  });
  expect(ImageManipulator.manipulateAsync).toHaveBeenCalledTimes(1);
  expect(ImageManipulator.manipulateAsync).toHaveBeenCalledWith(
    'file://photo.heic',
    [{ resize: { height: 1920 } }],
    { compress: 0.8, format: 'jpeg' }
  );
});
test.each(['png', 'gif', 'webp'])('preserves %s original pixels/animation', async extension => {
  const uri = `file://original.${extension}`;
  expect(await compressImageForUpload(uri, `image/${extension}`)).toEqual({
    uri,
    mimeType: `image/${extension}`,
  });
  expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
});
test('surfaces failed preparation instead of bypassing it', async () => {
  (ImageManipulator.manipulateAsync as jest.Mock).mockRejectedValue(new Error('decode failure'));
  await expect(compressImageForUpload('file://bad.jpg', 'image/jpeg')).rejects.toThrow(
    'decode failure'
  );
});
test('legacy URI preparation does not convert again', async () => {
  await ensureUploadableUri('file://photo.jpg', 'image/jpeg');
  expect(ImageManipulator.manipulateAsync).not.toHaveBeenCalled();
});
test('preserves complete Photos identifiers and downloads images or videos', async () => {
  (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({
    localUri: 'file://download.mov',
  });
  expect(await materializeICloudAssetIfNeeded('ph://UUID/L0/001')).toBe('file://download.mov');
  expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('UUID/L0/001', {
    shouldDownloadFromNetwork: true,
  });
});
test('rejects a nonlocal materialization result', async () => {
  (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({ localUri: 'ph://UUID/L0/001' });
  await expect(materializeICloudAssetIfNeeded('ph://UUID/L0/001')).rejects.toThrow(
    'could not be downloaded'
  );
});
test('does not misdiagnose arbitrary read/decode failures as iCloud', () => {
  expect(isICloudError(new Error('unable to decode public.png: no such file'))).toBe(false);
  expect(isICloudError(new Error('iCloud download failed'))).toBe(true);
});
