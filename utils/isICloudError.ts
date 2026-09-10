/**
 * Detect iOS iCloud-related media errors.
 *
 * When a user selects a photo/video that hasn't been downloaded from iCloud,
 * iOS surfaces a variety of generic error strings depending on the picker
 * path and OS version. This helper centralises the detection so every media
 * picker in the app reacts consistently.
 *
 * v1.0.2 audit fix: BannerUpload already had this, but create-post.tsx only
 * checked for 'public.png'. Now both share the same list.
 */
export function isICloudError(error: unknown): boolean {
  // v1.0.3: tagged errors from materializeICloudAsset short-circuit the string check.
  const details =
    error && typeof error === 'object' ? (error as { name?: unknown; message?: unknown }) : {};
  if (details.name === 'ICloudMaterializationError') return true;
  const msg = String(details.message || '').toLowerCase();
  return (
    msg.includes('icloud') ||
    msg.includes('not downloaded') ||
    msg.includes('cloud asset') ||
    msg.includes('ph://') ||
    msg.includes('stored in icloud')
  );
}

/** User-facing alert copy for iCloud errors. */
export const ICLOUD_ERROR_TITLE = 'Media Not Available Locally';
export const ICLOUD_ERROR_MESSAGE =
  'This photo or video is stored in iCloud and could not be downloaded. ' +
  'Open it in Photos first to download it, then try again.';
