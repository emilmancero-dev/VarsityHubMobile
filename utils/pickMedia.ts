import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

async function launchLegacyIOSLibrary(
  includeImages: boolean,
  allowsMultipleSelection: boolean
): Promise<ImagePicker.ImagePickerResult> {
  // Builds before 1.0.6 do not contain VarsityMediaPicker. expo-image-picker's
  // iOS video export can fail for an otherwise valid iCloud asset with
  // PHPhotosErrorDomain 3164 before JS receives a URI. DocumentPicker asks iOS
  // to download and copy the selected item into our cache, which gives the
  // existing upload pipeline an app-readable file:// URI without weakening any
  // event posting permission.
  const result = await DocumentPicker.getDocumentAsync({
    type: includeImages ? ['image/*', 'video/*'] : ['video/*'],
    multiple: allowsMultipleSelection,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return { canceled: true, assets: null };
  return {
    canceled: false,
    assets: result.assets.map(asset => ({
      assetId: null,
      uri: asset.uri,
      width: 0,
      height: 0,
      fileName: asset.name,
      fileSize: asset.size,
      mimeType: asset.mimeType,
      type: asset.mimeType?.startsWith('video/') ? 'video' : 'image',
    })),
  };
}

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
    return launchLegacyIOSLibrary(includeImages, Boolean(options.allowsMultipleSelection));
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
