# Varsity media acquisition

SDK 54's image-picker passthrough branch copies PHAssetResource with network
access disabled. Cloud-only videos therefore fail before JavaScript receives an
asset. Changing export quality merely forces another whole-video encode.

This app-owned iOS Expo module uses PHPicker's NSItemProvider with `.current`
representation and copies its temporary file inside the provider completion.
Photos owns the cloud download and selected-item authorization. There is no
PHAssetResource fast path, video export session, or dependency patch. Mixed
selection retains original image bytes, including transparency/animation.

`utils/pickMedia.ts` routes video-capable iOS library requests here. Camera,
image-only editing, Android and web keep Expo ImagePicker. Results use Expo's
asset shape (duration in milliseconds). Unsupported options such as native
editing/base64 are not requested by those video-capable callers; trim remains
in the app. Cancellation returns `canceled: true`. Acquisition errors reject;
partial copies are removed on failure. Successful files live in Documents/MediaDrafts, excluded from iCloud backup,
and survive OS cache eviction. Confirmed post saves remove only their owned
source/prepared files; drafts and retries retain their files.

Adding this module requires a native app rebuild. Expo Autolinking discovers
`modules/varsity-media-picker`; run `pod install --project-directory=ios` for a
local native workspace. An OTA alone cannot add this module. Old binaries show
an update-required message rather than calling the defective picker path.

Before release, test a physical iPhone with Optimise iPhone Storage: local and
cloud-only MOV/MP4, limited Photos access, mixed image/video selection, picker
cancel, offline cloud download failure, retry, and an edited Photos video.
Simulator compilation cannot prove iCloud/provider behavior on a real device.
