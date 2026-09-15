import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { launchMediaLibraryAsync, launchMediaCameraAsync } from '../pickMedia';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { All: 'All', Videos: 'Videos', Images: 'Images' },
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  UIImagePickerControllerQualityType: { High: 0, Low: 2 },
  VideoExportPreset: { Passthrough: 0, H264_1920x1080: 6 },
}));
const launchLibrary = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({ launchLibrary });
  launchLibrary.mockResolvedValue({ canceled: true, assets: null });
});
test('routes mixed iOS selections through provider acquisition', async () => {
  await expect(launchMediaLibraryAsync({ mediaTypes: ['images', 'videos'] })).resolves.toEqual({
    canceled: true,
    assets: null,
  });
  expect(launchLibrary).toHaveBeenCalledWith(true, 1);
  expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
});
test('preserves multi selection limits', async () => {
  await launchMediaLibraryAsync({
    mediaTypes: ['videos'],
    allowsMultipleSelection: true,
    selectionLimit: 3,
  });
  expect(launchLibrary).toHaveBeenCalledWith(false, 3);
});
test('surfaces acquisition errors unchanged', async () => {
  launchLibrary.mockRejectedValueOnce(new Error('offline'));
  await expect(launchMediaLibraryAsync({ mediaTypes: ['videos'] })).rejects.toThrow('offline');
});
test('falls back to the Expo picker when the native module is absent (older build)', async () => {
  // The native VarsityMediaPicker only ships in an eas build, never OTA, so
  // binaries built before it was added (e.g. shipped 1.0.5) don't have it.
  // Video selection must still work there via the standard Expo picker rather
  // than dead-ending on an "Update required" alert.
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(null);
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['videos'] };
  await launchMediaLibraryAsync(options);
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(options);
  expect(launchLibrary).not.toHaveBeenCalled();
});
test.each(['android', 'web'])('retains Expo selection on %s', async os => {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['videos'] };
  await launchMediaLibraryAsync(options);
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(options);
});
test('retains Expo image editing', async () => {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true };
  await launchMediaLibraryAsync(options);
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(options);
});

test.each([['videos'], ['images', 'videos']])(
  'records %j at highest capture quality without an export encode',
  async (...types) => {
    await launchMediaCameraAsync({
      mediaTypes: types as ImagePicker.MediaType[],
      videoMaxDuration: 90,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Low,
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080,
    });
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        videoMaxDuration: 90,
      })
    );
  }
);
test('retains image-only camera controls without changing capture mode', async () => {
  const options: ImagePicker.ImagePickerOptions = { allowsEditing: false, quality: 1 };
  await launchMediaCameraAsync(options);
  expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(options);
});
