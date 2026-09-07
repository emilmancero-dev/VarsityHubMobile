# Telemetry verification and remaining gates — September 6, 2026

## What this investigation established

A clean JavaScript test suite cannot establish native crash resolution. A catalog row cannot establish provider coverage. A successful SDK call cannot establish ingestion, indexing, or alert delivery. Backup validation must restore and migrate the database, not merely compare table counts.

The original desktop PDFs are requirements and historical observations, not proof of current behavior. Their remediation history remains in `docs/audits/2026-09-05/notes-remediation.md` and `shipped-notes.md`. Native, recovery and database evidence remains in `RECOVERY_AND_NATIVE_GATES_2026-09-06.md` and `PRODUCTION_HARDENING_2026-09-06.md`.

## Changes in this telemetry release

- Sentry captures the original exception before the optional PostHog mirror. Either reporter can fail without preventing the other from attempting capture.
- PostHog operations contain synchronous SDK failures and rejected screen promises. SDK failures are reported directly to Sentry once per operation per JavaScript runtime, avoiding a recursive mirror loop.
- Fatal and native events reaching the JavaScript `beforeSend` hook bypass expected-business-error filters. This does not imply native events always pass through that JavaScript hook.
- Mirrored exceptions include `sentry_event_id`; Sentry scopes include the available `posthog_session_id`. Existing runtime/OTA properties remain attached. Startup emits `telemetry_initialized` with Sentry initialization readiness, which is not proof of delivery.
- Map mount/unmount, native-map-ready, marker-data revision/counts, app-state transitions and OTA reload requests create breadcrumbs. No coordinates, search text or marker identities are recorded by the new map diagnostics. These are JavaScript lifecycle observations, not native child-pointer lifetime measurements.
- No native dependency, native plugin, billing contract or database schema changed. Session replay remains disabled.

## Regression proof

Baseline implementation: `e4896b2a`. New tests were run against original implementations and the edited implementations were restored afterward.

| Failure                                                | Original result                                    | Fixed result                     |
| ------------------------------------------------------ | -------------------------------------------------- | -------------------------------- |
| PostHog exception prevents original Sentry capture     | Behavioral test failed                             | Pass                             |
| Analytics storage throw escapes a product action       | Behavioral test failed                             | Pass                             |
| Rejected PostHog screen promise is unhandled           | Original run terminated on `Async storage failure` | Promise rejection captured; pass |
| Missing cross-reporter event correlation               | Behavioral test failed                             | Pass                             |
| Fatal event containing `LOCATION_REQUIRED` is filtered | Behavioral test failed                             | Event retained; pass             |
| Missing map lifecycle breadcrumbs                      | New component test failed                          | Lifecycle/count assertions pass  |

`utils/__tests__/telemetryResilience.test.ts` also verifies that Sentry failure preserves PostHog capture and breadcrumb failure cannot break the UI action. Four synchronous baseline assertions failed together in the controlled revert run; an earlier accidentally overlapping run was discarded and is not evidence. The telemetry suite is part of `test:regressions:client`.

Local evidence logs: `/tmp/vh-telemetry-revert-proof.log`, `/tmp/vh-telemetry-before.log`, `/tmp/vh-map-telemetry-before.log`, `/tmp/vh-telemetry-after.log`. These are local artifacts, not durable CI attachments.

## Live pipeline check

A synthetic, information-level event was sent in environment `verification`, without customer data or payment operations:

- Verification ID: `telemetry-verification-78ed01c6-fc0c-4c61-b6a5-f4b11811ce4b`.
- Sentry event: `e8738177026547188f08c3c711fdfe5f`; SDK flush succeeded and authenticated event lookup retrieved the indexed event.
- PostHog companion event: `telemetry_canary`, HTTP 200. Dashboard/query indexing was **not** verified because no personal query credential was established.
- This checks project ingestion using a diagnostic Node process. It does **not** prove delivery from an installed React Native binary, a native crash, or an offline device.

## Alert coverage and operator queries

Read-only Sentry inspection found seven production-specific issue rules: three coach/organization critical-route rules, three coach notification/approval/drift rules, and one new/reappeared/high-priority error rule. An additional high-priority rule has no environment filter. Existing notification actions are email. There was no dedicated rule for native recurrence, purchase recovery, ingestion freshness or restore failure. No notification destinations or live rules were changed in this release. Notification delivery is unverified.

Use stable failure-type fingerprints; put receipt IDs, query IDs and source IDs in sanitized context rather than splitting every occurrence into a separate issue. Never attach signed receipts, credentials or provider payloads.

Recommended operational views and alert conditions (proposals, not activated rules):

| Domain            | Query / signal                                                                                                                       | Condition to investigate                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Native            | `environment:production level:fatal` grouped by release and native build; inspect OTA tags where present                             | Any recurrence on a candidate release, including an already-known issue                         |
| Telemetry SDK     | `environment:production context:telemetry_sdk_failure`                                                                               | Any new operation failure; compare startup readiness events                                     |
| Purchase recovery | `environment:production vh_context:apple_iap_reconciliation_recovery_failed` and `vh_context:apple_iap_reconciliation_manual_review` | Failed recovery, growing review backlog or aging unacknowledged intents                         |
| Scheduler         | `environment:production vh_context:scheduler_job_failed` / `scheduler_worker_failed`                                                 | Worker failures or absent expected job completions                                              |
| Backup            | `environment:production vh_context:db_backup_freshness_stale` / `db_backup_freshness_check_failed` plus restore-drill CI             | Stale backup or failed isolated restore/migration, even with matching counts                    |
| Sports ingestion  | Existing provider/job context and persisted catalog health                                                                           | Failed/stale imports; distinguish an explicitly unsupported provider from offseason zero events |

For each activated alert, record owner, environment, query, recurrence threshold, destination and a retrieved delivery confirmation. A configured rule alone is not a passed delivery gate. Validate native dSYM UUID coverage, not just an upload command; React/Hermes symbol-table artifacts are not full DWARF line coverage.

Manual Railway uploads currently expose `deployment_id` but no `RAILWAY_GIT_COMMIT_SHA`, `SOURCE_VERSION` or `SENTRY_RELEASE`. Correlate these events using the recorded deployment ID and release ledger. Automatic source-commit attribution for that deployment path remains an operational gap; do not set a static release environment variable that will silently become stale.

## Verification results

- `npm run release:verify:local`: exit 0, including client and server typechecks, lint, structural/security gates, 174 client regression assertions, 136 server regression assertions and approval suites.
- Additional notes coverage: 5 client suites / 91 assertions and 8 server suites / 61 assertions passed. Covers map autofit/clustering, share links/post mapping, geofence filtering, discovery pagination/filter parity, historical access and share landing privacy.
- Targeted telemetry/map/reload run: 5 suites / 33 assertions passed.
- `npm run release:verify:build`: exit 0. Warnings concerned the pre-commit dirty tree and native store-submission credentials; no blocking errors. Build readiness does not build a native binary.
- `BASE_URL=https://api-production-8ac3.up.railway.app npm run release:verify:runtime`: exit 0. Operator/device acceptance remains separate. Publication IDs are recorded below after completion.

## Remaining gates — explicitly not closed

1. **Native crashes 3T/49:** existing simulator stress and non-null native-child observations did not reproduce the fatal condition. Physical-device crash resolution and seven-day TestFlight evidence remain open. No new native binary or speculative maps patch is included here.
2. **MiLB / MLS NEXT / MLS NEXT Pro:** ESPN/Yahoo-only restriction remains honored. No supported, verified schedule provider for these competitions was established. They must not be represented as connected; TheSportsDB fallback was removed in the preceding release.
3. **Legacy receipt exceptions:** no pending/review rows were observed in the last production inspection, but this cannot discover receipts lost before durable intent recording. Missing transaction/ownership evidence cannot be replaced with guessed fulfillment.
4. **Telemetry operations:** installed-device delivery, PostHog indexing, notification delivery and complete native symbolication remain separate gates. These client fixes improve evidence collection; they do not guarantee every process termination is reportable.
5. **Original visual notes:** automated contracts passed, but device presentation/navigation/media review remains unverified where the notes require visual acceptance.

The preceding actual backup restore/migration drill passed on source `f3a5f98e` (CI run `34068927431`, 63 tables, 4,370 rows, 162 matching migration records). This telemetry-only release does not change that schema. Neither historical counts nor this report are a live database health guarantee.
