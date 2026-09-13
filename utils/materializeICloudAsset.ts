import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

/**
 * v1.0.2: On iOS, images stored in iCloud Photos may not be locally available.
 * expo-image-picker returns a ph:// URI pointing at the cloud asset, and
 * ImageManipulator fails when it tries to read the file.
 *
 * This helper uses expo-media-library to force iOS to download the image
 * from iCloud before any manipulation or upload. Returns the local file:// URI.
 *
 * On Android or for non-ph:// URIs this is a no-op.
 *
 * v1.0.3: throws a tagged error when materialization fails on an iOS `ph://`
 * URI so callers can surface a clear "photo is in iCloud, open Photos first"
 * message. Previously this swallowed the failure and returned the unusable
 * ph:// URI — downstream code then threw a generic error with an empty message
 * that surfaced as the useless "Image Error — something went wrong" fallback.
 */
export class ICloudMaterializationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ICloudMaterializationError';
  }
}

export async function materializeICloudAssetIfNeeded(uri: string): Promise<string> {
  if (Platform.OS !== 'ios') return uri;

  // Only ph:// URIs reference Apple Photos cloud assets
  if (!uri.startsWith('ph://')) return uri;

  try {
    const assetId = uri.slice('ph://'.length);
    if (!assetId) {
      throw new ICloudMaterializationError('Photos asset identifier is missing.');
    }
    // Keep the complete Photos local identifier, including its /L0/001 suffix.
    const permission = await MediaLibrary.getPermissionsAsync();
    if (!permission.granted) {
      const requested = await MediaLibrary.requestPermissionsAsync();
      if (!requested.granted) {
        throw new Error('Photo library permission is required to read the selected media.');
      }
    }
    const info = await MediaLibrary.getAssetInfoAsync(assetId, {
      shouldDownloadFromNetwork: true,
    });
    if (info?.localUri?.startsWith('file://')) {
      return info.localUri;
    }

    // No localUri came back — this is the common "asset is in iCloud and
    // couldn't be downloaded" path. Throw so the caller shows a clear alert.
    throw new ICloudMaterializationError(
      'This photo is stored in iCloud and could not be downloaded. ' +
        'Open it in the Photos app to download it, then try again.'
    );
  } catch (e) {
    if (e instanceof ICloudMaterializationError) throw e;
    if (__DEV__) console.warn('[media] iCloud materialization failed:', e);
    throw new ICloudMaterializationError(
      'This photo is stored in iCloud and could not be downloaded. ' +
        'Open it in the Photos app to download it, then try again.',
      e
    );
  }
}
