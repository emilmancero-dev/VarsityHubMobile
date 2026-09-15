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
  // VarsityMediaPicker is a NATIVE module that only ships in an eas build, never
  // OTA — so binaries built before it was added (e.g. the shipped 1.0.5 App
  // Store build) don't have it. When it's absent, fall back to the standard
  // Expo picker so users can still select video: the native module avoids an
  // AVAssetExportSession re-encode but is an enhancement, not a requirement.
  // Hard-throwing here left 1.0.5 users with no video-upload path at all.
  if (!native) return ImagePicker.launchImageLibraryAsync(options);
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
