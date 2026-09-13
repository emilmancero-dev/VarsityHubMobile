# Error disclosure matrix reconciliation — 2026-09-10

The earlier error-disclosure audit is reliable for its tested output paths, but is not proof that sensitive information can never escape. This follow-up reconciles those claims against current source and adds reproducing regression tests. Changes remain local; unrelated existing worktree changes were preserved.

## Threat model and scope

A failed native operation or upstream request can carry implementation details into alerts, API responses, or telemetry. The trust boundary is the conversion from an exception into public output. Authentication, role, payment, IDOR, replay, cache, and deep-link authorization rules were not changed or independently recertified by this scoped audit.

## Reconciled findings

| Claim / finding                                                                 | Classification today         | Proof and root fix                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw client errors and server diagnostics are safe to display                    | Closed for tested paths      | Earlier shared public-message allowlist and private/public AppError metadata separation remain in place. Current scan checks 692 source files.                                                                                                                        |
| An error named ZodError is safe validation output                               | Closed                       | Before-fix regression produced 400 with a private marker from an imitation provider error. `server/src/middleware/errorHandler.ts` now requires an actual ZodError instance; regression returns generic 500.                                                          |
| Unknown-error telemetry excludes request secrets                                | Closed for this capture path | Before-fix nested password, query, and route-param values reached capture context. The handler now omits body/query/params entirely.                                                                                                                                  |
| Shared breadcrumb normalization redacts nested credentials                      | Closed                       | Before-fix nested password survived object serialization. `shared/runtime/sentrySanitization.js` now recursively redacts keys before serialization, with depth and entry limits; nested and cyclic tests pass.                                                        |
| Users on builds missing the native picker receive update advice                 | Closed                       | Before-fix public conversion replaced the advice with generic retry text. `utils/pickMedia.ts` supplies a stable code mapped to authored recovery copy.                                                                                                               |
| Native acquisition rejection contains no OS diagnostic text                     | Closed in source             | Before-fix source-contract regression identified localizedDescription interpolation. The native bridge now rejects with fixed copy; stable ERR_MEDIA_ACQUISITION maps to recovery guidance. Requires native build rollout.                                            |
| Screenshot's PHPhotosErrorDomain 3164 acquisition failure is resolved on device | Open verification            | Current source uses the custom provider acquisition path for iOS videos. Screenshot alone does not establish the cause or installed build. Reproduce library/camera, local/cloud media, cancellation and offline recovery on an iPhone with the current native build. |
| No sensitive information can ever leak anywhere                                 | Unverified blanket claim     | Static analysis is bounded, not whole-program proof. Arbitrary exception strings, analytics auto-capture, and all external telemetry/log storage are not certified by these checks.                                                                                   |

The Zod issue requires an exception shaped like validation output and affects the failing response. Request-copy and breadcrumb issues affect telemetry recipients, not ordinary API readers. Native diagnostics affect the user experiencing acquisition failure. These fixes reduce disclosure at the source rather than relying solely on individual alert text.

## Verification actually run

- Client Jest: 50 tests passed across picker, public-message, upload-error, and API-error suites.
- Server Jest: 31 tests passed across error middleware, error classes, Sentry scrubbing and Sentry tagging suites.
- Node tests: 7 passed across output-flow scanner, nested/cyclic telemetry and native bridge contracts.
- Client and server TypeScript: both exit 0.
- `npm run check:conflicts`, `npm run audit:navigation:fail`, `npm run verify:secrets`: passed.
- `GIT_BASE_SHA=HEAD GIT_HEAD_SHA=WORKTREE npm run verify:error-envelope`: passed, 692 files, zero reported unsafe output flows.
- `xcrun swiftc -frontend -parse modules/varsity-media-picker/ios/VarsityMediaPickerModule.swift`: passed syntax parsing; this is not a device build or runtime test.
- Changed follow-up JS/TS/tests formatted with Prettier; `git diff --check` passed.

## Release limits

No deployment or commit performed. Client JS fixes require `eas update --branch production` for compatible installed builds. Native Swift changes require a new native build and cannot ship by OTA. Server changes require the normal tested server release. No schema changes; rollback is source reversion and the corresponding release. Remaining device verification is not a policy decision and should not be marked closed from static checks.

## Follow-up execution: remaining audit and release checks

Completed the additional audit on 2026-09-10:

- Added shared final-send filters to mobile/server Sentry and PostHog. Both explicit and automatic exception capture now omit arbitrary exception text, request copies, breadcrumbs and custom context. Sentry keeps source file/line locations; PostHog keeps an exception count event. Sentry performance events use their separate final-send hook and omit descriptions and captured payloads.
- Added regressions for final SDK integration, exception/context disclosure, cycles, and performance-event bypass. Shared analytics recursion now stops at the depth limit instead of serializing deep objects unchanged.
- Expanded production HTTP-log credential redaction to API-key/client-secret headers and additional sensitive query parameter names. The new regression failed before the fix and passed afterward.
- Read a bounded sample of 100 existing Railway log lines without displaying log contents. Zero JWT/Bearer or credential-assignment pattern matches were detected. This does not certify historical logs, provider retention settings, arbitrary prose, or every console logging callsite. No remote records were deleted.
- The local release gate initially failed three access-matrix assertions because the local database lacked `Post.client_request_hash`. Verified the database host was localhost, reviewed and applied the two existing additive migrations (`20260910010000_media_upload_sessions`, `20260910020000_story_request_recovery`) with Prisma migrate deploy. No production database changes. The access matrix then passed.
- The canonical local, build, and runtime phases all completed with exit 0. Build readiness reported four nonblocking warnings (dirty tree and submission-account configuration). Runtime checks targeted the configured production API and email configuration; they verify the existing deployment, not these unreleased changes.
- A paired iPhone was detected with VarsityHub 1.0.5 build 59. No Photos interaction test or new native app installation was performed.

The stricter telemetry policy deliberately sacrifices free-text error details, custom error context and per-route performance labels. Error counts, release information and Sentry source locations remain available. Historical provider data and production console output must not be described as universally sanitized by this change.

### Remaining release blocker

Deployment has not been performed. The canonical `docs/release/LAUNCH_READINESS_GATE.md` says “Any required FAIL or UNKNOWN means NO-GO”; real-device verification of the changed native Photos flow remains unknown. No release exception was inferred from the request to run unfinished tasks. The current branch also contains prior commits and unrelated working-tree changes, so publishing the entire checkout would include changes outside this error-disclosure audit. No commit, push, EAS build, submission or production OTA was run.

Next concrete step: install a build containing the current native picker on the iPhone, exercise local/cloud Photos selection and offline recovery, and record the result before releasing the reviewed changes. Client JavaScript uses the usual production OTA path only for compatible builds; Swift requires a native build.

Final verification after the telemetry changes: the local release phase completed again with exit 0 after correcting the new test's `__DEV__` global typing. Both TypeScript checks passed within that phase. Focused coverage totals 59 client tests, 50 server tests, and 11 Node tests across the runs above; the release phase also ran its broader regression and access-matrix suites. Final error-envelope scan still reports 692 files and zero flagged flows. Changed follow-up files pass Prettier and `git diff --check`.
