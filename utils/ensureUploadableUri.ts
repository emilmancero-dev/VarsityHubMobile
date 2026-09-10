import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { materializeICloudAssetIfNeeded } from './materializeICloudAsset';

const MAX_IMAGE_DIMENSION = 1920;
const IMAGE_COMPRESS_QUALITY = 0.8;

/** Only downscale the long edge; small images must never be enlarged. */
export function imageUploadResize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Could not read image dimensions. Please select the image again.');
  }
  if (Math.max(width, height) <= MAX_IMAGE_DIMENSION) return [];
  return [
    { resize: width >= height ? { width: MAX_IMAGE_DIMENSION } : { height: MAX_IMAGE_DIMENSION } },
  ];
}

/**
 * Prepare an image once, at the upload boundary. Preserve formats that can carry
 * animation or transparency; JPEG/HEIC photos become bounded JPEGs. Failures are
 * surfaced instead of silently uploading an unprepared, possibly oversized file.
 */
export async function compressImageForUpload(
  uri: string,
  mimeType?: string
): Promise<{ uri: string; mimeType?: string }> {
  const localUri = await materializeICloudAssetIfNeeded(uri);
  const extension = uri.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  const type =
    mimeType?.toLowerCase().split(';')[0] ||
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic', heif: 'image/heif' }[
      extension || ''
    ];
  // PNG/APNG, GIF and WebP may contain alpha or animation. Re-encoding through
  // ImageManipulator can flatten those properties, so keep their original bytes.
  if (!type || !['image/jpeg', 'image/jpg', 'image/heic', 'image/heif'].includes(type)) {
    return { uri: localUri, mimeType };
  }
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(localUri, (width, height) => resolve({ width, height }), reject);
  });
  const result = await ImageManipulator.manipulateAsync(
    localUri,
    imageUploadResize(dimensions.width, dimensions.height),
    { compress: IMAGE_COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
  );
  if (!result.uri) throw new Error('Could not prepare this image. Please select it again.');
  return { uri: result.uri, mimeType: 'image/jpeg' };
}

/** Resolve Photos references without performing a second image conversion. */
export async function ensureUploadableUri(
  uri: string,
  mimeType?: string
): Promise<{ uri: string; mimeType?: string }> {
  return { uri: await materializeICloudAssetIfNeeded(uri), mimeType };
}
