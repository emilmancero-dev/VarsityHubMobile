import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as ImagePicker from 'expo-image-picker';

/** iOS provider acquisition downloads cloud assets without a full-video export. */
export async function launchMediaLibraryAsync(
  options: ImagePicker.ImagePickerOptions = {}
): Promise<ImagePicker.ImagePickerResult> {
  const mediaTypes = options.mediaTypes;
  const hasVideos =
    mediaTypes === ImagePicker.MediaTypeOptions.All ||
    mediaTypes === ImagePicker.MediaTypeOptions.Videos ||
    (Array.isArray(mediaTypes) && mediaTypes.includes('videos')) ||
    mediaTypes === 'videos';
  const includeImages =
    mediaTypes === ImagePicker.MediaTypeOptions.All ||
    (Array.isArray(mediaTypes) && mediaTypes.includes('images'));
  if (Platform.OS !== 'ios' || !hasVideos) return ImagePicker.launchImageLibraryAsync(options);
  const native = requireOptionalNativeModule<{
    launchLibrary(
      includeImages: boolean,
      selectionLimit: number
    ): Promise<ImagePicker.ImagePickerResult>;
  }>('VarsityMediaPicker');
  if (!native) {
    // Older binaries do not include VarsityMediaPicker. Keep the action true
    // to its "Photo Library" label instead of sending users to the Files app.
    // Cloud-only videos may still surface expo-image-picker's iCloud error on
    // those builds; create-post already explains that failure to the user.
    return ImagePicker.launchImageLibraryAsync(options);
  }
  return native.launchLibrary(
    includeImages,
    options.allowsMultipleSelection ? options.selectionLimit || 10 : 1
  );
}

/** Recording quality is independent of the export preset. Keep camera originals. */
export function launchMediaCameraAsync(
  options: ImagePicker.ImagePickerOptions = {}
): Promise<ImagePicker.ImagePickerResult> {
  const mediaTypes = options.mediaTypes;
  const hasVideos =
    mediaTypes === ImagePicker.MediaTypeOptions.All ||
    mediaTypes === ImagePicker.MediaTypeOptions.Videos ||
    (Array.isArray(mediaTypes) && mediaTypes.includes('videos')) ||
    mediaTypes === 'videos';
  return ImagePicker.launchCameraAsync(
    hasVideos
      ? {
          ...options,
          videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
          videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        }
      : options
  );
}
