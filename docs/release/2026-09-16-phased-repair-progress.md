# Phased repair execution

Branch: `codex/phased-performance-repairs`, based on `0c9f851f`.
Workspace: `/Users/varsityhub/Code/VarsityHubMobile-performance-repairs`.
Original checkout and its uncommitted media-picker changes are untouched.
Installed dependencies are linked read-only in use from the original checkout; no upgrades.

## Phase 1

- Baseline reproduced: two stale client live-window expectations failed; 16 related assertions passed.
- Reconciled those expectations to the existing September 14 server rule (2h before/6h after), preserving 12h/18h overrides. No posting-permission implementation changed.
- Added exact boundaries, invalid/missing fields, extended windows, and DST-offset coverage. Related client suites: 26 passed.
- A real route/database test reproduced an unknown-DOB candidate in adult suggestions. Applied the canonical `isVerifiedAdult` filter; DOB/preferences stay internal and are not returned.
- Safety regression plus age and server serialization suites: 71 passed. Tests used only the disposable local PostgreSQL audit database with production env loading disabled.
- Both client/server typechecks passed after the safety repair.
- OPEN: details' two-hour visual LIVE label versus Feed's server-bound LIVE label requires a product decision. Posting authority remains server-owned; no label change guessed.
- UNKNOWN: release-device baselines unavailable in this execution; no user-visible speed percentage claimed.

## Phase 2 — local implementation verified

- Removed the composer's overlapping image encoder. The existing shared uploader now owns preparation for both camera and library input.
- Composer-to-transport regression reproduced two native manipulation calls before the fix; normal JPEG/HEIC submission now makes one. PNG/GIF avoid that JPEG conversion. This is a mocked native call count, not a pixel-quality or device-speed measurement.
- Prepared MIME now determines the outgoing extension for JPEG, PNG, GIF, WebP, HEIC and HEIF. Tests inspect actual outgoing form parts with native transport mocked.
- Covered camera/library input, five-item cap, and preparation failure preserving the draft without creating a post. Existing image preparation, routing and recovery regressions remain in the verification set.
- Native alpha/animation preservation, portrait quality and timing/byte comparisons still require physical-device evidence.

## Phase 3 — local implementation verified

- Feed's existing shared QueryClient reuses a viewer-scoped 30-second query-window snapshot. Warm remount regression observes three game calls and four enrichment calls total, with no replacement calls on remount. Explicit refresh and successful Game/Event mutations invalidate intentionally; cursor continuations retain their originating bounds.
- Feed network polling runs only while focused and app-active. Obsolete results are ignored; a request that settles after returning to the screen queues a current refresh. No additional cache or retry subsystem was introduced.
- Discover releases its primary games view independently of optional suggestions/posts, shares one suggestions request, and distinguishes failures from successful empty results. Compatibility fallback is limited to the existing endpoint-version condition and terminal failure propagates.
- Followed-calendar pull refresh and team follow/unfollow invalidation have rendered-screen regressions.
- Independent Astra review approved this repair scope with no unresolved critical/important findings. Nonblocking coverage follow-up: add a deferred-completion test specifically for unread polling (the existing deferred test exercises post polling).
- Release-device usable-content timing and focus/background behavior remain unmeasured.

## Remaining execution / release gates

- Phase 4: implemented locally; see [pagination/backend change summary](2026-09-16-phase4-backend-repairs.md) for regressions, measured query counts, compatibility limits and release cautions. Deployment is still pending.
- Phase 5: device profiling and video cancellation work pending.
- Phase 6: full candidate matrix/device/payment/release verification pending. No deployment or launch approval.
- Phase 1's visual LIVE-label decision is still OPEN. No permission or visual rule was guessed.
- Operational foundation tasks (backup/restore, provider setup, exports and monitoring) remain governed by the earlier foundation plan, not closed by these repairs.

## Execution notes

- Safety and event test corrections were committed separately. Photo preparation is a separate repair commit.
- Feed cache and polling share lifecycle state and regression fixtures; those changes are kept together as one atomic Feed repair rather than splitting partially integrated states. Discover remains independently reviewable.
- Node 20.19.6 used for verification. Jest is configured to force exit; its open-handle advisory is not evidence of device performance.
- Server lint: zero errors, five existing warnings in untouched portions of users.ts. No claim of a warning-free repository.
- Explicit API-client lint: zero errors, 61 warnings across entities.ts and upload.ts; not hidden by the staged-file configuration, which omits apiclient paths.
- No push, merge, provider changes, database migration or production deployment. Rollback is to omit/revert the repair commits; this batch changes no persistent schema.

## Repair commits

- `a10c2df3`: canonical adult suggestions filter and database regression.
- `72bbfbd7`: canonical live-window test reconciliation and boundary coverage.
- `980c88ff`: one composer photo-preparation path and truthful upload format.
- `e5fdbfd0`: independent Discover sections, honest failures and calendar refresh regressions.
- `1e7cb2b7`: viewer-scoped Feed cache, mutation invalidation and active-only polling.

## Verification scope

The following results describe the first repair batch. Latest Phase 4 verification on `41970a96`: **228 client suites / 1,665 tests**, **nine targeted backend suites / 177 tests**, and both full typechecks passed. See the [Phase 4 summary](2026-09-16-phase4-backend-repairs.md) for scope and rollout limits.

- Both client and server full TypeScript checks passed on repair commit `1e7cb2b7`.
- Targeted backend run: 71/71 assertions, three suites, on the disposable local PostgreSQL database with production environment loading disabled. Database server stopped after verification; data files retained.
- Focused post-formatting runs: 39 photo assertions, 12 Discover assertions and 17 Feed/cache assertions passed. Recovery and other client coverage are included in the full-client run.
- Initial broad client run: 1,658 passed, one source-text expectation failed because it required the old calendar-excluding refresh list. Updated it to require the new signed-in suggestions + calendar refresh; 12/12 related assertions then passed. Final broad rerun tracked separately below.
- Final complete client rerun on `1e7cb2b7`: **227/227 suites, 1,659/1,659 tests passed**, zero skipped or failing tests. Command: `node node_modules/jest/bin/jest.js --watchman=false --runInBand --silent --json --outputFile=/private/tmp/varsityhub-performance-repairs-client-final.json` with Node 20.19.6. This checkout excludes the user's separate uncommitted media-picker changes in the original checkout.
- This does not constitute a full server suite, strict matrix run, provider sandbox purchase journey, or installed release-build test.

Historical matrix: 1,619 client passes/two stale failures; 234 backend matrix and 62 supplemental passes. These are historical audit numbers, not this branch's final verification.
