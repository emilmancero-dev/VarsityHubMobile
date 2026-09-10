# Media reliability: implementation and release verification

## What changed

The iOS library acquisition path now uses an app-owned Expo module with PHPicker's current representation and NSItemProvider file delivery. The system downloads cloud assets and the app copies the temporary file inside the delivery callback. No expo-image-picker dependency patch remains. This removes the audited export/resource path implicated in PHPhotosErrorDomain 3164; reproducing that user's exact cloud asset still requires a physical iPhone.

Native selected and prepared files live in Documents/MediaDrafts rather than evictable cache; iOS excludes the directory from backup. Compression is serialized and reused across retries. JPEG/HEIC preparation bounds the long edge without upscaling; PNG/GIF/WebP retain transparency/animation. Prepared images are capped at 10 MB. Videos are capped at 150 MB and 90 seconds, with verified server metadata.

Video upload has one direct Cloudinary path: owner-bound durable sessions, sequential 6 MiB chunks, bounded native reads, acknowledged-offset checkpoints, transient-only retries, and cancellation. A retry probes completion before retransmitting, including when the final acknowledgement was lost. Video bytes do not pass through Railway. Processing prepares H.264/AAC MP4, adaptive HLS and a poster before publishing. Signed webhooks normally establish readiness; delayed-callback recovery checks all derivatives. Cloudinary Admin requests explicitly enable media_metadata because the default response omits duration; a real provider probe caught this and a regression assertion pins the request.

Post drafts checkpoint upload results and freeze the create request before sending it. Owner-scoped deterministic post identifiers and request hashes make response-loss retries idempotent, rejecting changed payloads. New video URLs must match a ready session owned by the uploader across post and story writes. Existing content stays readable. Playback shares one visibility/focus/app-state controller, pauses hidden media, supports actual reload and recreates a native player if replacement hangs. Prepared native videos use HLS; web and retry use MP4.

## Initial verification (before the follow-up fixes below)

- Focused client: 11 suites, 94 tests passed.
- Related media/feed mapper regression: 7 suites, 67 tests passed.
- Server upload, ownership, create replay, signed webhook and cleanup: 3 suites, 33 tests passed. Metadata-request regression rerun passed.
- Client and server TypeScript checks: exit 0.
- Web static export and Android JavaScript/assets export: exit 0. These are not physical-device tests or an Android native APK build.
- Conflict scan and WORKTREE error-envelope gate passed; navigation audit reports no REVIEW items.
- Real Cloudinary probe: 7,978,255-byte synthetic video uploaded in two chunks, reopened the same session, verified metadata, generated HLS and MP4, fetched a valid HLS manifest and received HTTP 206 for MP4 range delivery. Synthetic provider asset and local test session were deleted.
- Native picker compiled for arm64 and x86_64 simulators. The first full Debug build failed at link time: SHA-256 comparison proved locally installed React Core and ReactNativeDependencies were the Release archives, with missing configuration markers. Restored matching Debug archives using the installed upstream replacement scripts; no dependency source patch. The full Debug iOS simulator rebuild then passed (xcodebuild exit 0), including arm64 and x86_64.

Server Jest must run under the tested Node 20 runtime. Node 24 selected by a server-directory shell failed Jest 29 ESM linking before tests executed; using Node 20 passed without changing or mocking the application import graph.

## Release order

1. Deploy the tested server with additive migration `20260910010000_media_upload_sessions`. This adds MediaUpload and nullable Post.client_request_hash. The migration has only been applied to a local test database during this work.
2. Verify Cloudinary configuration and a public HTTPS callback origin through existing API_BASE_URL or RAILWAY_PUBLIC_DOMAIN. Production session creation fails clearly if neither is available. The callback is `/webhooks/media/cloudinary/:sessionId`; raw request body must reach its route before JSON parsing. Signature verification uses CLOUDINARY_WEBHOOK_API_SECRET when provided, otherwise the configured Cloudinary API secret; ensure it matches the key Cloudinary uses for notification signatures. Do not rotate production keys as part of this release.
3. Run a signed upload/processing callback smoke test against the deployed server and confirm ready-session ownership checks. Monitor Sentry video_upload failures and cleanup errors. The daily cleanup expires unready sessions older than 48 hours in batches of 100; it never deletes ready sessions.
4. Ship a new native iOS app build containing VarsityMediaPicker. An OTA alone cannot add this native module. Do not publish this client bundle to older incompatible iOS binaries: the picker deliberately asks for an app update when the module is absent. Repository policy reserves paid EAS build/submit commands for the owner. Subsequent compatible client-only fixes need the usual production EAS update; a server deployment alone does not update installed apps.
5. Run the device acceptance cases below before calling the release complete. No production deployment, configuration mutation, paid build or store submission was performed in this implementation task.

Rollback: roll back client/server binaries first and retain the additive tables/column. Never drop upload state while clients may retry; existing canonical published URLs remain valid independently of rollback.

## Required physical-device acceptance

Test a physical iPhone with local and iCloud-only photos/videos, limited Photos access, HEIC, rotated portrait video, HEVC/HDR, 4K and trimmed video. Test Android devices with MP4/WebM and Chrome/Safari desktop/mobile with supported photo/video sources. Exercise feed, fullscreen, profile, team and game viewers, sound, seek, navigation away/back and background/foreground.

Throttle to 256 kbps and 1 Mbps with high latency; disconnect midway through a chunk and immediately after the final chunk; background or terminate the native app; reopen and retry; lose the POST response after server save. Require no duplicate posts, no source deletion before confirmed save, no false published state during processing, eventual recovery when connectivity returns, and only the visible video playing. Measure upload duration, bytes retransmitted, time to first frame, buffering and memory on actual devices before setting performance targets.

Transfers are resumable foreground operations, not an OS background transfer service: app suspension can pause progress. Browser Blob source URLs do not survive a page reload; browser-file reselection may be required. Retained unconfirmed native files are deliberately not evicted automatically. These limits must not be represented as seamless background upload, permanent browser draft storage, or a guarantee of perfect playback on every device/network.

## Repeat the provider probe

`server/scripts/verify-media-pipeline.ts` requires an explicitly supplied localhost test database and a synthetic video fixture no larger than 12 MB. It uses configured Cloudinary credentials, creates one synthetic asset, verifies actual delivery and deletes the asset in a finally block. Never point it at the production database. Use Node 20 and the server's installed tsx executable; never print credentials in logs.

## Follow-up: capture, transfer size, story recovery and playback resolution

The second review found gaps that the initial passing tests did not cover. The final implementation adds:

- Explicit high-quality camera capture with passthrough export, preserving a single later encoding decision. Camera permission is requested only for camera use; selected library items do not require blanket Photos permission. Existing venue/account eligibility checks remain server-authoritative.
- Native H.264 upload target of 4 Mbps at a 1920-pixel maximum long edge, replacing 6 Mbps. Clips above 3 MiB and above 5 Mbps estimated total bitrate are prepared; already efficient clips avoid encoding. Actual output bytes are checked against the duration-based transfer budget (5 Mbps including headroom, or 3 MiB for short clips), in addition to the 150 MiB safety cap. A missing duration on a larger file or a failed mandatory encoder pass no longer silently bypasses preparation. Native sources longer than 90 seconds require trimming before transfer.
- Every native video transfer enters the common preparation boundary. Prepared output reuse checks policy, byte size and modification time, avoiding a second encode by screens that already prepared the video. Browser preparation validates Blob bytes without calling native filesystem functions; browser video encoding remains server-side, so browser uploads do not have the native 4 Mbps target.
- New playback MP4s preserve the 1920-pixel long edge instead of capping at 1280; HLS uses the standard full_hd ladder, retaining intermediate qualities. Existing 1280 URLs keep their previous hd mapping.
- A signed callback that finishes during completion returns ready immediately. Optional CDN readiness timeouts leave the session processing; authentication/permanent provider failures remain visible. The story UI distinguishes transfer from preparing playback.
- Photo/video stories now retain owner/entity-scoped draft, uploaded media and frozen save-request checkpoints. Both story endpoints deduplicate exact request retries; changed content under the same request id conflicts. Failed story/chat uploads retain preview/trim state. Migration 20260910020000_story_request_recovery adds nullable Story.client_request_hash; apply with the server before new clients. The pre-existing event-story migration must also be present (it was missing from the local test database and was applied there).
- Cancel now reaches session/completion HTTP calls and processing sleeps; external cancellation remains AbortError instead of becoming a timeout or retried request. Listeners/timers/controllers are cleaned up.

Measured synthetic provider check: a 20-second 1920×1080 H.264/AAC file of 10,697,037 bytes transferred in 3,394 ms. Ready playback was verified at 31,452 ms total, including provider preparation, polling and ffprobe. Delivered MP4 retained 1920×1080 with audio; HLS manifest and MP4 HTTP206 delivery passed. The synthetic asset and local session were deleted. These are measurements from this machine's connection, not a physical iPhone/stadium benchmark or a native encoder quality comparison. A first attempt exposed an optional readiness timeout, which was fixed and regression-tested before this successful rerun.

The 4 Mbps setting is a target with one-third fewer video bits than 6 Mbps for the same duration; actual size includes audio/container overhead. High-motion sports quality, HDR handling, encoder time and poor-network behavior still require physical-device acceptance. Do not claim identical visual quality, Instagram-equivalent speed, or that a local build has updated installed apps.

Final follow-up verification: 196 distinct client tests and 42 server tests passed across the focused media, capture, HTTP-cancellation, mapper and recovery suites (238 total; repeated runs not double-counted). Full iOS Debug simulator build passed again. Client/server TypeScript, formatting, lint (warnings remain), conflict scan, WORKTREE error-envelope and navigation classification checks were run. The 20-/90-second limits include the same 250ms frame/audio rounding allowance across client and verified server checks. New session-backed stories enforce their verified duration; legacy media URLs have no trusted session duration and retain legacy behavior. No production deployment or store/native distribution was performed.

Final all-platform Expo export (iOS, Android and web) exited 0 after the follow-up changes.
