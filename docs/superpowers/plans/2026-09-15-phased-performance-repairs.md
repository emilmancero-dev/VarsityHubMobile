# Phased Performance and Continuity Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task inline. Checkboxes track execution; none of the repairs below is complete merely because this plan exists.

**Goal:** Remove confirmed unnecessary work in Feed/Discover and photo preparation, correct continuity defects, and improve video behavior based on device measurements.

**Architecture:** Keep the existing shared QueryClient, modular backend, privacy helpers, media preparation, resumable uploads, and verified video delivery. Each repair gets a focused failing regression, a minimal patch, and an independent commit. Client/API contract changes remain backward-compatible with installed apps.

**Tech Stack:** Expo/React Native, TypeScript, TanStack Query, Express, Prisma/PostgreSQL, Jest, existing native media modules.

**Spec:** `docs/superpowers/specs/2026-09-15-production-recovery-canonical-rules-design.md`; concrete scope comes from `docs/release/2026-09-15-performance-logic-audit.md` and `docs/release/2026-09-15-matrix-continuity-rerun.md`.

**Execution checkpoint (September 16):** See `docs/release/2026-09-16-phased-repair-progress.md` for tested scope and remaining evidence. Checked items below represent completed local work only. Native quality/performance and release gates remain open. Feed cache/polling share lifecycle state and are committed together; Discover and photo repairs are separate. New lifecycle tests are colocated in the existing Feed/Discover rendered suites rather than duplicating their harnesses.

## Global constraints

- Preserve unrelated media-picker edits; record the actual working-tree/build state for each test run.
- Preserve server enforcement of permissions, minors protections, private content, verified payments, and upload limits.
- Use isolated test databases and synthetic accounts; never run destructive tests against production or staging.
- Do not introduce another cache, request retry layer, scheduler, or media pipeline.
- Separate refactoring from behavior changes. No mass deletion, dependency upgrades, or screen redesign as part of these repairs.
- Unknown evidence remains UNKNOWN. Performance success does not automatically mean launch readiness.
- Native measurements require a release build, device model, OS version, network condition, and fixed fixtures. Test elapsed time is not app response time.
- The audit used Node 20.19.6 as a reproduction runtime. Production runtime support is a separate validation decision; do not silently upgrade it with these patches.
- Provider configuration, backups, exports, and monitoring remain covered by `2026-09-15-surgical-foundation-fixes.md`. They are not silently closed by this performance plan.

## Phase overview

| Phase | Deliverable                                         | Exit gate                                                                                                 |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1     | Reliable regression baseline and safety/rule checks | Known failures classified; safety selection tested; authoritative live-window assertions agree            |
| 2     | One photo-preparation path                          | One encode per eligible selected JPEG on normal submission; truthful MIME; preserved PNG/GIF properties   |
| 3     | Responsive Feed/Discover                            | Warm cache reuse, independent sections, one suggestions fetch, visible errors, no inactive-screen polling |
| 4     | Correct pagination and less backend work            | Complete record traversal; requested slices only; privacy computed once per request                       |
| 5     | Measured video improvements                         | Cancellation works and measured playback/upload bottlenecks improve without safety or quality regressions |
| 6     | Full continuity verification and controlled release | Required automated and device evidence passes; remaining operational blockers resolved before launch      |

Phase 1 establishes a trustworthy baseline. Phases 2–4 are independently reviewable packages and should not wait for unavailable device measurements. Phase 5 performance claims require those measurements. Phase 6 assembles evidence for the same candidate build and backend revision.

## Phase 1 — Establish the baseline and protect correctness

**Files:** `__tests__/live-window.test.ts`, `utils/__tests__/liveWindow.test.ts`, `utils/__tests__/eventPresentation.test.ts`, `utils/liveWindow.ts`, `utils/eventPresentation.ts`, `app/game-details/GameDetailsScreen.tsx`, `server/src/__tests__/live-window-serialization.test.ts`, `server/src/routes/users.ts`, `server/src/lib/userAge.ts`; create `server/src/__tests__/suggested-users-age-gate.test.ts` if no equivalent behavior test exists.

**Interfaces:** Preserve serialized `starts_at`, `live_from`, and `live_until`. Suggestions continue returning `{ items: [...] }`. Preserve the distinction between a visual event label and permission to post.

- [x] Record the baseline: 1,619 client passes/two stale live-window failures; 234 backend matrix passes; 62 supplemental server passes; strict readiness blocked on installed-app ad purchase evidence. Rerun only if the tree changed materially.
- [ ] Convert the audit's seven isolated reproductions into feature-owned regression tests as their repair packages begin. Keep the historical reproduction harness clearly labeled as pre-fix evidence; its assertions currently expect defects.
- [x] Reconcile the two stale live-window assertions with the governing owner decision and backend serialization. Test exact opening/closing boundaries, legacy missing fields, extended/all-day overrides, timezone changes, and invalid timestamps.
- [x] Establish whether Feed and details intentionally use different LIVE labels. If they should agree, pass server bounds to the existing presentation helper and cover the details consumer. If the decision is unresolved, record that one item OPEN and continue unrelated repairs.
- [x] Reproduce the suggestions query using an adult viewer and synthetic candidates: known adult, minor, unknown DOB, blocked adult, and private adult. Ensure unknown age does not gain adult-discovery visibility; retain existing privacy rules.
- [x] Repair only the reproduced selection gap with the canonical server age logic. Keep the safety patch separate from the event-rule patch.
- [ ] Capture cold/warm Feed and Discover timing, request counts, and representative media phase timings on available release devices. Missing device access does not block deterministic regression repairs, but remains required for speed claims.

**Exit:** The two stale tests are reconciled without weakening posting gates; the age-selection test passes; event label decisions are explicit; local defect baselines and available device measurements are recorded.

## Phase 2 — Remove duplicate photo processing

**Files:** `app/(tabs)/create-post.tsx`, `apiclient/upload.ts`, `utils/ensureUploadableUri.ts`, `utils/__tests__/imageUploadPreparation.test.ts`, `apiclient/__tests__/upload-routing.test.ts`; add `app/__tests__/create-post-image-preparation.test.tsx` for the complete selection-to-upload path.

**Interface:** The shared uploader owns image preparation and passes its prepared URI, MIME type, and filename consistently into transport. Preserve draft recovery, the 10 MB final image cap, and five-item selection.

- [x] Add a regression that selects a 3 MB JPEG through the composer and records native manipulation calls through upload. Confirm the existing two-pass failure.
- [ ] Add PNG-alpha and animated-GIF fixtures over 2 MB; assert their formats are preserved and MIME describes the actual selected/prepared file. Include HEIC-to-JPEG and portrait sizing.
- [x] Remove the composer's overlapping JPEG conversion. Retain selection validation and file materialization; let the common preparation path determine output encoding.
- [ ] Verify single photo, five photos, camera input, library input, upload failure, retry, and draft recovery. Ensure failed preparation cannot bypass size checks.
- [ ] Run the focused photo/client tests and both typechecks. Compare preparation time and bytes for the same fixtures; report actual measurements rather than an estimated speedup.
- [x] Commit this phase independently, with the composer-to-uploader regression included.

**Exit:** A normal JPEG submission makes one encoding pass, PNG/GIF data is not accidentally flattened, and filenames/MIME match prepared output.

## Phase 3 — Make Feed/Discover show useful content promptly

### 3A: Stable feed cache identity

**Files:** `app/feed.tsx`, `utils/feedGameQueries.ts`, `utils/__tests__/feedGameQueries.test.ts`, `__tests__/feed.startup.test.tsx`, `lib/queryClient.ts` only if required.

**Interface:** Reuse the single QueryClient. Cache identity reflects viewer and semantic scope; time bounds belong to a consistent first-page/pagination snapshot. Preserve the current 30-second freshness contract and explicit refresh behavior.

- [x] Add a remount-within-30-seconds test using the real QueryClient and a counted Game API mock; advance time by one millisecond and verify the current duplicate fetch.
- [x] Stabilize game and enrichment keys. Remove coordinates from identity when they do not affect the request; do not change the global-versus-local feed product scope.
- [x] Keep cursor continuation tied to the originating bounds. Invalidate intentionally on refresh, scope/account changes, and relevant mutations; do not cache a moving window forever.
- [x] Verify warm remount makes zero replacement game fetches, explicit refresh obtains fresh data, and another account cannot reuse protected content.

### 3B: Independent Discover sections and honest errors

**Files:** `app/(tabs)/discover/mobile-community.tsx`, `app/__tests__/mobile-community.smoke.test.tsx`; add `app/__tests__/discover-loading-continuity.test.tsx`. Inspect `apiclient/entities.ts` compatibility fallbacks before changing them.

**Interface:** Reuse one viewer-scoped suggestions query returning the existing items. Give games, posts, suggestions, map, and followed calendar independent pending/error states.

- [ ] Add deferred-response tests: games succeed while suggestions stall; posts fail while games succeed; all suggestions fail; truly empty data succeeds.
- [x] Release the primary skeleton when the primary content is ready. Render optional sections as loading/error independently while retaining cached content during refresh.
- [x] Fetch suggestions once at the needed maximum and derive smaller displays locally. Preserve follow updates across both displays.
- [x] Remove serial fallback on ordinary network failure. Retain a compatibility fallback only for a proven endpoint/version condition, with a bounded retry budget and a visible terminal failure.
- [ ] Include followed-calendar refresh and follow/unfollow invalidation in the relevant refresh flow. Verify a changed followed team appears without restarting the app.

### 3C: Poll only while active

**Files:** `app/feed.tsx`; add `__tests__/feed-polling-lifecycle.test.tsx`.

- [ ] Use fake timers and focus/AppState transitions to reproduce post-activity polling after blur.
- [x] Tie the network interval to focus and app-active state, prevent overlapping requests, and ignore obsolete completions after account/scope changes.
- [x] Assert zero new polling requests while blurred/backgrounded and one refresh on return; keep local time-based label updates independent.

**Verification:** Run affected Feed/Discover/lifecycle tests, both typechecks, and compare cold/warm request counts and usable-content time on the same fixture/device. Commit 3A, 3B, and 3C separately.

**Exit:** Ready content is usable while optional sections load, failure is distinguishable from empty data, suggestions fetch once per refresh, and hidden screens do no polling work.

## Phase 4 — Correct pagination and reduce backend work

### 4A: Return every post and comment

**Files:** `server/src/routes/feed.ts`, `server/src/routes/posts.ts`, `server/src/__tests__/api-feed-bundle.test.ts`; create `server/src/__tests__/post-comment-pagination.test.ts` for uncovered routes.

**Interface:** Preserve `{ items, nextCursor }`. Use a consistent exclusive cursor identifying the last delivered record. Implementation uses a self-contained timestamp/ID boundary instead of the proposed `skip: 1`, so deleting the anchor does not break continuation. Legacy first-unseen cursors remain inclusive; see the Phase 4 report for compatibility limits.

- [x] Add real isolated-database traversal tests with seven rows and page size two. Assert collected IDs equal the complete expected list and contain no duplicates. Cover bundle people/team feeds, ordinary posts, and comments.
- [x] Correct the lookahead-row/skip mismatch. Test equal timestamps and deterministic ID tie-breaking.
- [x] Test location filtering separately: eligible posts beyond an exhausted over-fetch batch must not become unreachable. Preserve a raw scan cursor if needed and bound any scan loop.
- [x] Test deletion between requests, an invalid cursor, and a client continuing a cursor issued before deployment. Define safe continuation behavior; do not assume old cursors use the new convention.
- [x] Commit the correctness repair before bundle optimizations.

### 4B: Compute only the requested slices

**Files:** `server/src/routes/feed.ts`, `server/src/lib/privacyUtils.ts`, `apiclient/entities.ts`, `app/feed.tsx`, `server/src/__tests__/api-feed-bundle.test.ts`. Query-count assertions live in the existing bundle suite and new `server/src/__tests__/privacy-request-reuse.test.ts` rather than a separate feed-request-work suite.

**Interface:** Add an optional validated `sections` parameter with allowlisted values matching existing bundle keys: `posts`, `posts_followed_teams`, `highlights`, `ads`, `unread_notifications`, `unread_messages`. Omission retains the old full-bundle behavior. Preserve the existing response shape with explicit requested-section handling in the client; do not overwrite unrequested section state with defaults.

- [x] Add tests proving a people-post continuation performs no highlights/ad/count work and a legacy full-bundle request still returns all sections.
- [x] Add request-scoped promise reuse for private-author and private-team decisions. Preserve blocked-user deduplication and all authorization clauses; failed checks must not produce permissive empty exclusions.
- [x] In the warm-private-data fixture, verify three consumers share four viewer authorization queries instead of twelve. Test concurrent consumers, rejection, separate requests, separate viewers, and changed follow permissions; existing block/privacy suites also pass.
- [x] Verify the selective client accepts legacy full-bundle responses and the new server accepts omitted selection. Backend and client support are separate ordered commits.
- [ ] Deploy-compatible order: release server support before dependent clients. Avoid routing new `p2`/`t2` cursors to old API replicas; validate rollout and refresh-on-rollback on release infrastructure. No deployment performed.
- [x] Run privacy, minors, authorization, pagination, and feed regressions against the isolated DB, plus both typechecks. Commit backend and client contract changes independently.

**Local verification:** 177 backend tests across nine suites, 1,665 client tests across 228 suites, and both typechecks passed. Detailed evidence, review findings, commits and remaining rollout limits: `docs/release/2026-09-16-phase4-backend-repairs.md`.

**Exit:** Traversal loses no eligible records; single-section pagination avoids unrelated work; shared privacy checks preserve visibility rules under success and failure.

## Phase 5 — Fix measured video bottlenecks

**Files:** `hooks/usePlaybackLifecycle.ts`, `app/game-details/GameVerticalFeedScreen.tsx`, `components/VideoFirstFrame.tsx` if profiling implicates fallback posters, `utils/compressVideo.ts`, `apiclient/videoUpload.ts`, `server/src/lib/mediaUploadSession.ts`; existing playback, compression, upload-session, and video-upload tests.

**Interfaces:** Preserve `autoPlay`/`paused` intent, resumable checkpoint ownership, prepared-video reuse, server asset verification, and MP4/HLS/poster readiness. Add optional `signal?: AbortSignal` to preparation options only with working native cancellation/queue semantics.

**September 16 checkpoint:** The uncommitted cancellation draft reproduces and repairs missing signal propagation in JavaScript tests, but review found an Android native promise-settlement race. This item remains unchecked and must not ship until native cancellation/serialization is safe. See `docs/release/2026-09-16-phase5-cancellation-investigation.md` for evidence and the required native repair versus delayed-cancellation decision.

- [ ] Measure release-device first-frame time, active native player count, network bytes, memory, and scroll frame times using short/long clips and rapid swipes on Wi-Fi and constrained network conditions.
- [ ] Measure acquisition, local encoding, transfer, provider processing, and post creation separately. Verify callback delivery before changing the 60-second readiness fallback.
- [ ] Reproduce cancellation during compression followed immediately by a second upload. Read the installed compressor's cancellation API, propagate the existing signal, and ensure an aborted queued job never begins encoding or blocks a later job indefinitely.
- [ ] If profiling confirms excess inactive source loading, load the active item and a small measured neighbor budget. Keep a poster for other cards; explicitly tune initial render count. Verify resume position, rapid swipes, background/foreground, image-only cards, and screen exit.
- [ ] If provider processing dominates, fix callback/configuration or readiness-observation defects with tests. Do not publish unverified assets or sacrifice quality just to end the spinner.
- [ ] Run existing media suites plus new cancellation/loading-budget tests. Compare repeated before/after release-device runs using identical fixtures and conditions.

**Exit:** Cancellation stops the relevant work, retries retain valid progress, and every claimed video improvement has device measurements with no quality, playback, recovery, or verification regression. If evidence shows a candidate is harmless, record it as closed without changing it.

## Phase 6 — Verify continuity, release safely, then consolidate

**Files:** `config/commandment-workflows.json`, `config/matrix-coverage.json`, existing release scripts and evidence reports; targeted source cleanup only after references and regression coverage are established.

- [ ] Run the full client suite, client/server typechecks, canonical matrix, and supplemental tests covering event history/retention, uploads, payments, and the repaired pagination paths.
- [ ] Run physical iOS and Android journeys for Feed/Discover, scroll/playback, photo/video upload, cancel/retry, profile visibility, notifications, and posting boundaries. Include web for supported paths.
- [ ] Record installed-app advertising purchase, server verification, activation, cancellation/failure, and recovery using provider sandbox accounts. Keep the strict advertising workflow blocked until required evidence exists.
- [ ] Update matrix evidence with the actual tested commit/build/environment and test names. Do not relabel a gap as covered because a file exists or an unrelated test passed.
- [ ] Run local/build/runtime release checks from the established release workflow. Confirm unresolved backup/restore, exports, public URLs, reconciliation, and monitoring tasks in the foundation plan before launch sign-off.
- [ ] Review a concrete release candidate before production publication. Server contract support precedes dependent client updates; native capability changes require a binary, not only an OTA update. Record previous server/client versions and rollback procedures.
- [ ] After behavioral repairs pass, consolidate duplicate helpers and retire misleading audit tooling with its callers updated. Delete only confirmed unreferenced files; preserve migrations, safety checks, compatibility paths, and historical evidence.

**Exit:** Required automated gates and installed-device journeys pass on the candidate; no unresolved critical safety/payment/recovery issue remains; measured speed improvements and remaining limitations are documented. A green performance report alone is not launch approval.

## Verification commands

Use the appropriate subset after each repair; run the full set for the final candidate. Database commands require a validated disposable local database and disabled production environment loading.

```sh
npm test -- --watchman=false --runInBand
npx tsc --noEmit
npx tsc --noEmit --project server/tsconfig.json
npm run audit:matrix
npm run audit:matrix:strict
npm run release:verify:local
npm run release:verify:build
```

Per commit, record: original reproduction, scope, focused test result, before/after request/query/encoding counts, applicable device measurements, and rollback. Preserve production settings until the release/configuration action is authorized.

## Coverage self-review

F1 maps to Phase 2; F2/F3/F6 to Phase 3; F4/F5 to Phase 4; F7 and stale tests to Phase 1; M1/M2/M3 to Phase 5; suggestions safety to Phase 1; missing device/ad evidence and cleanup to Phase 6. Operational foundation work stays in its existing plan. No speed percentage, native profile result, or completed repair is assumed.
