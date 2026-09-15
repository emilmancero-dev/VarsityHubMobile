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
  if (Platform.OS !== 'ios' || !hasVideos) return ImagePicker.launchImageLibraryAsync(options);
  const native = requireOptionalNativeModule<{
    launchLibrary(
      includeImages: boolean,
      selectionLimit: number
    ): Promise<ImagePicker.ImagePickerResult>;
  }>('VarsityMediaPicker');
  if (!native) {
    // Older binaries (pre-1.0.6) don't ship the VarsityMediaPicker native module.
    // Fall back to expo-image-picker's library picker — it's present in every
    // binary and does a full-video export (slower, and less iCloud-friendly than
    // the module's provider-acquisition fast path) but is fully functional, so
    // 1.0.5 users can still select and upload video instead of hitting a wall.
    return ImagePicker.launchImageLibraryAsync(options);
  }
  const includeImages =
    mediaTypes === ImagePicker.MediaTypeOptions.All ||
    (Array.isArray(mediaTypes) && mediaTypes.includes('images'));
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
