# Photo/video upload and playback audit — 2026-09-09

Verdict: useful shared foundations, but not yet a consistently reliable end-to-end system. No product code changed in this audit.

Scope: picker acquisition, image preparation, video compression, direct R2/Cloudinary transport and image proxy fallback, post finalization, shared player, vertical feed player, media URL/preview helpers, upload authorization and existing tests. This is source and targeted-test evidence, not certification of every device or live provider configuration. No production uploads, device reproduction, full typechecks, or production logs were run/read.

## Priority findings

### 1. High: iCloud video acquisition can fail before upload starts

User reports iOS `PHPhotosErrorDomain error 3164`. The installed expo-image-picker 17.0.11 `ios/MediaHandler.swift` lines 314–318 and 394 use `PHAssetResourceManager.writeData` with `options: nil` in both passthrough video paths. `constants/video.ts:28` selects Passthrough. Apple documents network access as disabled by default: https://developer.apple.com/documentation/photos/phassetresourcerequestoptions/isnetworkaccessallowed .

The PHPicker branch comments that failures fall back, but the `try await` has no catch: a resource-copy failure escapes before `loadVideoRepresentation`. `app/(tabs)/create-post.tsx:515` only calls the app's materialization helper after the picker returns. It cannot recover a picker rejection. `utils/isICloudError.ts` also does not recognize the reported PHPhotosErrorDomain text.

Expected: acquire a readable local copy, downloading the selected iCloud resource when necessary, with a functional fallback and actionable error. Actual source behavior: cloud-only resource acquisition can reject before app preparation. This is a strong candidate, not proof that this exact dependency code is in the user's installed binary or that 3164 uniquely means iCloud.

Fix: correct both native acquisition paths with explicit network-enabled resource options, cleanup on failure and a real compatible fallback. Preserve passthrough for local assets. Verify local and cloud-only video, limited/full Photos access, offline failure and edited video on a physical iPhone. A native dependency patch requires a new binary; OTA alone cannot deliver it.

### 2. High: playback retry does not retry

`components/VideoPlayer.tsx:237` increments retryKey, but the source depends only on uri. `app/game-details/GameVerticalFeedScreen.tsx:415` has the same problem: videoRetryKey changes UI state only. The installed `expo-video/src/VideoPlayer.tsx:51` recreates the native player only when the serialized source changes. Neither handler reloads/replaces the source.

Reproduction path: emit a playback error, tap retry; error disappears and spinner appears, but no new media load is requested. Fix with an explicit reload or controlled player remount; test an error followed by successful retry using lifecycle-faithful mocks.

### 3. High: failed post save can destroy retry input

`app/(tabs)/create-post.tsx:948` deletes trimmedUri after upload, before `Post.create` at line 991. A rejected/failed create retains picked/trimmed state but may point at a deleted file. Uploaded URLs are local variables and are not reused on the next attempt.

Reproduction: trim a clip, let media upload succeed, fail post creation, retry. Expected: reuse uploaded media or retain local source. Actual: the trimmed file has been scheduled for deletion and retry starts preparation/upload again. Move cleanup after confirmed post persistence and retain the uploaded media result across save retries. Add creation idempotency for ambiguous network outcomes.

### 4. Medium: photo resize is not a longest-edge cap

`utils/ensureUploadableUri.ts:55` always resizes width to 1920. A 1080×1920 portrait becomes approximately 1920×3413; a small image is upscaled. Every successful operation converts to JPEG, losing transparency/animation. Some callers (BannerUpload and story image upload) call this helper before the uploader calls it again.

Fix: inspect dimensions, downscale only when the longest edge exceeds the cap, prepare once, and explicitly define whether animated/transparency assets are supported. Verify portrait, landscape, small image, HEIC, transparent PNG and GIF behavior.

### 5. High for web: upload payload is native-only

Both multipart builders in `apiclient/upload.ts` append `{ uri, name, type }` without a web Blob/File branch. This is React Native's multipart convention. A standards FormData experiment run during this audit returns `[object Object]` for that field. R2 requires `file://` sizing, so browser blob URIs fall through to this multipart path.

Fix: build a Blob/File part on web and retain URI-backed native transport. Verify actual bytes through a browser upload. This was reproduced at the standards FormData boundary, not through a running browser app.

### 6. Medium: storage activation changes playback guarantees

R2 succeeds before Cloudinary is attempted. It returns original bytes without codec normalization, verified duration or derived poster. `prepareVideoForUpload` skips in-spec files regardless of codec; `optimizeVideoUrl` only adds Cloudinary q_auto and leaves R2 untouched. The shared player takes the original URL, while the vertical feed applies that optimization. Therefore there is no single delivery contract guaranteeing the same codec/quality/poster on all surfaces. Codec compatibility needs device testing; a container remux does not convert HEVC to H.264.

Fix: choose an explicit supported playback contract and expose canonical playback/poster URLs from the server. Generate a compatible derivative where required rather than forcing every source through an on-device transcode. Do not enable an additional provider as an implicit change in playback behavior.

### 7. Medium: uploaded asset completion is not server-verified

R2 signs declared MIME/length and a random object key, but does not inspect file bytes or bind an upload record to a user. Post creation accepts an allowlisted URL and optional client-supplied metadata (`server/src/routes/posts.ts:704–717`). Cloudinary's returned max_bytes is explicitly not an enforced signed limit in the route. Host validation is valuable but does not establish ownership, upload completion, actual duration or file content.

Fix: finalize uploads server-side against provider metadata and an owner-bound upload record before attaching media to a post. Enforce limits there and clean up abandoned objects. Prioritize this by abuse impact and storage cost; no live abuse was attempted.

## Concise target system

One acquisition function → one preparation function → one upload operation → server-verified media record → idempotent post save → shared playback lifecycle consuming canonical playback/poster URLs.

Keep direct upload, centralized media host validation, existing size-aware video timeout, progress phases and shared post-mapper parity. Consolidate uploadFile/uploadFileWithProgress routing and player lifecycle logic. Keep surface-specific layout and playback intent separate from common loading/error/retry behavior. Fix acquisition and retry before adding streaming infrastructure.

## Verification actually run

- Client: upload-routing, compressVideo, media, VideoPlayer.playback, post-mapper-consistency: **5 suites, 72 tests passed**.
- Server: api-uploads, media-host-allowlist, mediaUtils: **3 suites, 41 tests passed**.
- Standards FormData experiment confirmed a native URI object serializes as `[object Object]`.
- Inspected installed expo-video hook to verify retry keys do not recreate a player.

Existing player tests mock setup on every render and do not exercise native status/retry behavior. Passing tests therefore do not disprove these defects.

Remaining acceptance matrix: physical iOS/Android plus browser; local/iCloud video; HEVC/H.264, portrait/landscape and edited clips; photos/HEIC/PNG; weak network and background/foreground; trim→upload→save failure; feed/detail/stories/profile/team viewer; first frame, sound, pause/resume, retry and navigation isolation. Record installed app build, iOS version and whether failure happens at selection, trimming or posting to connect the user's 3164 report to the exact native branch.

## Implementation update — 2026-09-09

The iCloud acquisition finding below is retained as historical evidence. The
temporary expo-image-picker dependency patch has been superseded by the app-owned
`modules/varsity-media-picker` iOS module and `utils/pickMedia.ts`. Video-capable
iOS library selection now uses PHPicker's current NSItemProvider representation,
copying its temporary file inside the callback, without the network-disabled
PHAssetResource branch or a whole-video export. The module compiles for the iOS
simulator; real-device iCloud acceptance and a native app rebuild remain release
requirements. See `modules/varsity-media-picker/README.md`.
