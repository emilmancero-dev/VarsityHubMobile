# Media reliability implementation plan

Goal: replace fragile acquisition/retry behavior with one tested preparation, resumable transfer, verified finalization and playback contract. User authorized execution of all tasks, including necessary root-cause architecture changes; no dependency patches.

Architecture: retain Expo, Express/PostgreSQL, Cloudinary and existing React Query/Redis patterns. Add owner-bound upload sessions in PostgreSQL for resumable direct video chunks and verified derivatives; one canonical MP4 plus eagerly prepared HLS. Keep legacy media readable. Never proxy large videos through Railway or silently switch storage providers mid-transfer.

- [x] Acquisition: replace temporary dependency patch with app-owned supported iOS acquisition path; preserve local copy speed and iCloud download support. Verify native integration and error/cancel handling.
- [x] Photos: dimension-aware downscale without upscaling; explicit animation/transparency behavior, preparation once. Behavioral tests.
- [x] Transfer: one upload entry point and web Blob support; bounded-memory sequential video chunks, durable acknowledged offsets, owner-bound session, cancellation and transient-only retries. Failure/restart tests.
- [x] Finalization: server verifies actual asset metadata, ownership, size/duration, eagerly prepares compatible MP4/HLS/poster and returns only ready assets. Additive migration, authenticated bounded endpoints and tests.
- [x] Posting: retain media checkpoints, preserve source until save confirmation, owner-scoped idempotency with content conflict detection. Simulate lost create response and retry without reupload.
- [x] Playback: common focus/app-state/visibility lifecycle, actual reload, resume without rewind, bounded error states, HLS for prepared native videos and compatible MP4 on web. Behavioral tests.
- [x] Verification: targeted suites, client and server typechecks, formatting/lint/conflict/navigation/envelope checks, review of integrated diff. Native/device/provider tests recorded separately with concrete limitations; no paid builds, production config mutation or deployment.

Dependency interfaces: uploadFile retains existing arguments/result and adds AbortSignal; uploadFileWithProgress delegates to it. Video sessions return signed upload fields and verified URL/width/height/bytes/duration/provider. Post stores optional client_request_hash for deterministic owner-scoped create replay. Existing media fields carry canonical URLs so old clients remain compatible.

Final evidence and outstanding physical-device/release acceptance: [MEDIA_RELIABILITY_RELEASE.md](../../MEDIA_RELIABILITY_RELEASE.md). Local implementation and verification complete; not deployed.
