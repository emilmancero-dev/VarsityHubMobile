# Production hardening protocol — September 6, 2026

Work proceeds in the requested order. No native or purchase gate is closed by a database test.

## Phase 1: database repair and repeatable restore

- Restored four missing successful migration files from Git with exact production checksums. Restored two historical files whose comments had changed their checksums. The fifth missing migration-history entry is rolled back; no applied history was fabricated.
- Rehearsed the backup-only SQL repair against a complete isolated restore. The old backup fails schema parity; the repaired clone passes migration deploy and application write/unique/FK probes.
- Applied the same reviewed repair to the configured production backup, with primary/backup metadata preconditions, exclusive destination locks and one transaction. Repaired extension, function, indexes, policies/RLS, and three enum definitions/order.
- Updated the atomic mirror to require PostgreSQL object parity before clearing data; include migration history in the same snapshot and destination transaction; reject incomplete source migrations and unsupported sequences; preserve timestamp microseconds.
- Production refresh copied 59 tables and 4,335 rows, including 156 migration-history rows. Primary and backup migration histories now match exactly by content fingerprint.
- Added a standalone restore script and daily GitHub Actions workflow using PostgreSQL 17. The target must be loopback and explicitly marked `varsity.restore_isolated=on`. Archives remain in memory and disposable databases are removed. Only aggregate evidence is retained.
- Configured dedicated `varsity_restore_reader` roles for primary and backup: SELECT only, default read-only, BYPASSRLS so the backup can be read consistently without granting writes. Reader secrets are scoped to the writable fork's GitHub Actions. Existing API credentials were not rotated or exposed.

Regression proof:

- Reverting `dbBackupSync` to `da61c1f4` makes the updated real-PostgreSQL test fail because the backup retains `old-history` instead of copying `new-history`.
- The timestamp test failed with `.123` versus `.123456`, then passed after preserving PostgreSQL timestamp text.
- The real database test covers middle-table failure rollback of both data/history, successful joint replacement, missing-index refusal and missing-column refusal.
- Schema tests cover columns, constraints, indexes, RLS, policies, triggers, functions, enum order and extensions. Immutable migration tests preserve restored historical checksums.
- Local release gate passed. Both client/server typechecks passed; final focused checks cover subsequent timestamp handling and the expanded server regression list. No skipped typecheck is counted as a pass.

See [backup repair procedure](../../server/backup-migrations/README.md). Scheduled acceptance must run without `RESTORE_REPAIR_SQL`; applying a repair inside every drill would hide a defective backup.

## Remaining ordered gates

| Phase | Required result                                                                                  | Current status                                                                      |
| ----- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1     | Unmodified repaired backup passes migration startup; daily check active; guarded mirror deployed | Passed: deployed mirror, as-is local restore and independent scheduled-runner drill |
| 2     | Durable account-bound purchase intent and re-authentication reconciliation                       | Backend and OTA live; physical and legacy/needs-action cases remain open            |
| 3     | Explicit provider/coverage health, including unsupported leagues                                 | Deployed; unsupported entries disabled                                              |
| 4     | Native dSYM delivery and physical/TestFlight lifetime/session evidence                           | Open; seven-day evidence cannot be manufactured in one session                      |

Whole-service failover, external storage/Redis recovery and ownership/ACL provisioning remain distinct from this database restore drill. Existing PushTicket data remains an intentional ephemeral exclusion.

## Phase 1 operational acceptance

- Server commit `5a0cd1d24b3b2db56ee6b28c6e7c6ff9ac32f78b`, successful Railway deployment `bbedd21a-99b0-4b59-ba57-e1554b79b393`. Runtime gate passed after deployment.
- Live scheduler job `forensic-backup-5a0cd1d2-20260906` completed (processedOn `1788722884510`, finishedOn `1788722904281`).
- Unmodified backup local restore: 59 tables / 4,335 rows, content matched, migration deploy and application constraint probes passed; cleaned up at 2026-09-06T19:22:44.717Z. No repair option used.
- Independent GitHub runner [34054960934](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34054960934) succeeded using the dedicated read-only roles. Aggregate artifact `backup-restore-report` retained for 30 days; no raw database artifact uploaded.
- Daily schedule: 07:23 UTC, active in the writable fork default branch through workflow-only commit `e8c1696d`. It checks out the tested server commit above. The application source on fork main was not promoted. Update this pin after future verified production releases; upstream still requires an account with merge access.
- Client regressions: 151 tests; expanded server regressions: 102 tests. The full local release gate and final targeted PostgreSQL/type checks passed.

## Phase 2 implementation and verification

- Added an account-owned `AdPurchaseIntent` and product/receipt ledger before StoreKit checkout. The server derives quantities and prices; Apple `appAccountToken` binds signed receipts to the intent. Unique receipt IDs, one open intent per ad, foreign keys and completion checks enforce storage invariants.
- Receipt storage commits before fulfillment. Inventory, Apple claims, completed transaction log and intent completion share the same serializable transaction. The existing BullMQ scheduler reconciles ready intents every five minutes; authenticated recovery and signed Apple `ONE_TIME_CHARGE` notifications reuse that service.
- One root mobile provider processes unfinished Apple transactions on login, foreground and reconnect. It acknowledges consumables only after authenticated server acceptance and ignores superseded account responses. Recovery never purchases an unpaid remainder automatically. Explicit checkout resumes remaining quantities; the calendar can restore saved dates.
- Found and reproduced a separate receipt trust defect: issuer-name checks accepted a self-signed certificate claiming Apple's name. Replaced that verifier with Apple's official server library pinned to the actual Apple Root CA G3 certificate. Verification checks signatures, certificate purpose, bundle and environment. Offline verification uses signed-date validity; online OCSP was not exercised.
- Real isolated PostgreSQL tests passed: failure injected at intent completion leaves receipts durable and fulfillment rolled back; a fresh Node process finishes recovery; five concurrent receipt deliveries produce one fulfillment; cross-account receipt submission and missing ledger references are rejected. Existing payment/finalization regressions also passed (22 tests across four suites, including the real-crypto forgery test).
- Seven mobile logic tests passed: delayed/failed durability never acknowledges, an account change invalidates a slow result, re-login recovery does not charge, intent creation precedes checkout, duplicate callbacks coalesce, and a superseded account cannot start checkout. These substitute the native StoreKit boundary and are not physical-device interruption evidence.
- Revert proof: premature acknowledgement causes three client test failures. Moving fulfillment back into a separate transaction makes the PostgreSQL fresh-process recovery test fail. Restoring both fixes passes.
- The restore drill now runs the PostgreSQL purchase recovery/finalization suites inside its disposable restored database, after migration startup.

Remaining purchase gates: a legitimate sandbox/TestFlight signed transaction and physical force-kill/re-login sequence; confirmation of App Store Server Notification delivery configuration; self-service resolution for expired/full booking dates; legacy partial receipts without an intent. No App Store Server API key is configured, so server polling of missing Apple receipts is not claimed. Legacy receipt data is preserved. Do not describe these remaining cases as automatically recovered.

Migration rollout: additive migration `20260906194000_durable_ad_purchase_intents`; apply to backup and primary before mobile publication, refresh backup and repeat the as-is restore gate. A brief parity mismatch safely refuses backup clearing. Rollback must retain these tables and receipts; stop new checkout publication and keep the reconciliation service available. Never drop the purchase ledger to roll back client behavior.

## Phase 3 catalog and post-migration restore correction

- Catalog tests failed before the fix because unsupported entries were active. Catalog construction now enables entries only when provider metadata exists. The migration disables empty, providerless database entries while preserving all events and seeded coverage; the isolated clone reports 13 active and 60 disabled entries, zero empty providerless entries still active.
- The API derives `catalog_status` from the configured adapter, latest bounded ingestion record, current events and explicit current-season dates. States include ACTIVE_SYNCING, UNSUPPORTED_PROVIDER, OFFSEASON_NO_EVENTS, STALE_IMPORT, EMPTY_UNVERIFIED and SEEDED_EVENTS. A successful zero import with unknown season dates cannot claim offseason. Old visible events do not conceal a failed/stale import.
- Empty successful imports emit structured `schedule_empty_unverified` telemetry with provider, league, run and window. Missing provider configuration rejects an apply run. Existing per-league failure isolation remains.
- MiLB and MLS NEXT Pro remain unsupported/disabled, not newly imported. Youth MLS NEXT is separate and still has no catalog/provider integration. This is honest coverage handling, not a claim those schedules have been added.
- 22 focused catalog/ingestion tests pass. A stale structural feed test was aligned to the existing shared `fetchDiscoveryItems` contract rather than its retired query-key name.
- The first restore after adding purchase checks failed strict schema parity despite matching contents. A minimal real PostgreSQL dump/restore reproduced `varchar` IN-array deparser normalization. New additive migration `20260906203500_canonical_purchase_predicates` uses explicit text predicates that round-trip identically; it preserves the constraints and unique-index semantics. Historical migration SQL was not edited and parity validation was not relaxed. Acceptance requires rerunning the actual backup drill after this correction is deployed.

## Phase 4 native diagnostics — evidence, not crash closure

Sentry was queried directly on September 6. Both 3T (`7655376217`) and 49 (`7714008476`) refer to iOS release `com.varsithub.varsityhub-ios@1.0.5+56`. Their app UUID `8e445c90-617a-36e8-9d5a-26cb1b785c82` has full debug/symtab/unwind information in Sentry. The live UUID verification script passed. React UUID `76fbcee9-3517-30b3-9dc6-62c4e914e908` and Hermes UUID `80d5528f-2c78-3b90-b90f-747e89a9f880` have symtab/unwind only; those library entries are not full line-level dSYMs. Do not conflate missing dependency line detail with a missing application dSYM.

- 3T: 12 events, latest 2026-09-06T06:41:24Z, event `3fe572adc2a74317abf61c7b9e6097c4`; native interop/marker lifetime remains unresolved.
- 49: 2 events, latest 2026-09-06T15:40:49Z, event `e5197dda7329450c825ce13392e90ad7`; frames include `SharedObjectRegistry.clear` and JSI pointer destruction (`jsi.h:591/1135`), unresolved.
- 3M: issue record exists, latest event still 404. No feed-clipping cause asserted.
- Session API at 2026-09-06T20:37:41Z: 34 build-56 production sessions, crash-free rate **85.294%**. The requested seven-day query is day-rounded by Sentry (August 30–September 7 bounds), with activity on only two days. This is not seven active days, not a confirmed TestFlight-only cohort, and not evidence of stability after a native fix.

Changes prepared for subsequent native builds:

- Retain Sentry's existing debug uploader and verify full app debug information for the exact archive UUID through Sentry's API. Release builds reject disabled upload, missing credentials, missing UUIDs and symbol-table-only matches. An Expo config plugin preserves the gate when regenerating iOS.
- Removed the manual release script's forced `SENTRY_DISABLE_AUTO_UPLOAD=true` and enabled pipeline failure propagation.
- Added read-only `scripts/report-native-session-health.cjs` requiring an explicit release. Empty telemetry cannot report healthy. Session tracking was already enabled; the production EAS environment has the Sentry token and no observed native-upload-disable flag.
- UUID/feature and plugin regeneration tests pass; Xcode project parsing and shell syntax pass. Build readiness is checked separately from actually executing an archive. No simulator, EAS build, or native crash-fix release was performed.

These checks cannot produce source-line information absent from prebuilt React/Hermes artifacts, reproduce native object lifetimes, or manufacture seven days of candidate-build use. Physical reproduction, suitable dependency debug artifacts and a measured candidate-build observation window remain open.

References: [Sentry debug-file API](https://docs.sentry.io/api/projects/list-a-projects-debug-information-files/), [Sentry session statistics](https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/), [Apple dSYM generation](https://developer.apple.com/documentation/xcode/building-your-app-to-include-debugging-information).

## Latest operational acceptance

- Live server source `73bfa87c`; Railway deployment `12d69347-545a-436b-a610-97a1ed33ce17` succeeded. Runtime gate passed after this deployment.
- Backup refreshed: 62 tables / 4,338 rows, including 159 migration-history rows; primary and backup migration histories match exactly by content fingerprint.
- As-is backup restore after the corrective migration passed at 2026-09-06T20:38:38Z: content match, strict schema parity, migration startup, real purchase recovery and application constraints; disposable target removed.
- Full local release gate passed. Client regression suites: 158 tests; server regression suites: 125 tests. Both TypeScript projects passed. Build readiness passed with four warnings and zero blocking errors; no archive or simulator was run.
- Native gate tests: four pass, including UUID/full-debug checks and Expo regeneration. Actual Sentry UUID validation passes for build 56's application binary. React/Hermes source-line limitations and physical crash reproduction remain open.

## Independent runner acceptance and final account transition

- Daily restore workflow pin updated on fork main by `9d3ba51e`, checking out verified server source `73bfa87c` with the corrective predicates and purchase tests. GitHub run [34058808365](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34058808365) passed the actual backup restore, migration startup, purchase recovery and constraint steps with the dedicated read-only backup roles. Aggregate report retained; no database archive uploaded.
- Live catalog API: 13 entries, with 10 ACTIVE_SYNCING, one STALE_IMPORT (MLB: latest import fetched 337, updated 291, skipped/failed 46), one SEEDED_EVENTS (FIBA), one EMPTY_UNVERIFIED (NCAA baseball: zero fixtures, no confirmed season metadata). Disabled unsupported MiLB/MLS NEXT Pro entries are absent from the active catalog response. These remaining ingestion conditions are visible, not declared resolved.
- Initial authorized OTA group `440b184d-b6d3-4243-b3d0-a045b438e20b`, runtime 1.0.5, source `c9898af6`; Sentry bundle/source-map upload completed.
- Final account-switch regression failed before the follow-up: a new login inherited the previous account's in-flight recovery promise and did not start its own recovery. Recovery now waits for that superseded operation and starts for the current account. Eight focused mobile recovery tests pass afterward; client typecheck passes. No additional charge is initiated by recovery.

## Final mobile publication

- Final production OTA [2d6352bc-1d7a-460d-bda2-efba93114181](https://expo.dev/accounts/varsity-hub/projects/varsityhub/updates/2d6352bc-1d7a-460d-bda2-efba93114181), runtime `1.0.5`, source `1307a5fd372a4a343e61a6e3e6a9e65b413d7c3c`, published 2026-09-06T20:49:06Z.
- iOS update `01a0787b-60db-7d24-9cc9-05fd6db87ff2`; Android update `01a0787b-60db-7686-8d5e-33748d3426aa`. EAS update-view verified both against the exact source commit.
- EAS reported publication, then DNS failure interrupted its final GraphQL read. Verified the existing published group rather than publishing a duplicate; completed the production-environment Sentry source-map upload separately. Upload command succeeded; this does not claim observation of a new production crash with those maps.
- PR #281 remains open and mergeable; fork branch contains the release source. Upstream merge access remains unavailable. API deployment and OTA publication are independently verified, not inferred from the PR.
- The temporary isolated PostgreSQL cluster and restored customer data were removed. GitHub retains only aggregate restore evidence.
- Native build gates are prepared for a subsequent archive. No native binary was built or shipped, and the native crashes remain unresolved. Existing legacy/needs-action purchases and unconnected league providers remain documented open work.

## Follow-up implementation verification for review

- Reproduced a late receipt error from a previous account closing a different account's current checkout. The new test failed before the fix. Receipt failure callbacks now require the original checkout object, current account and matching intent token before changing checkout state; token matching is case-insensitive. Unrelated failures still emit structured `ad_iap_receipt_recovery` telemetry with the original intent ID.
- Ten focused purchase-recovery tests pass, including the late-failure regression, telemetry assertion and a matching-checkout failure control. Full local release workflow passed (160 client regression tests and 125 server regression tests at that run); the additional control/telemetry checks passed afterward. Both client and server TypeScript checks passed, as did staged-file guardrails.
- Runtime verification passed. Build readiness passed with four warnings and no blocking errors. These commands did not build or submit a native binary.
- Fresh independent restore drill [34060166554](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34060166554) passed at 2026-09-06T21:10:29Z: 62 tables / 4,338 rows, exact content match, migrations, purchase recovery and constraints; disposable database cleaned up. No backend/schema change was needed for this follow-up.
- The remaining native crashes, missing providers, legacy/needs-action purchases and physical/TestFlight verification gates remain open. This verification is not blanket certification of every app flow.

### Review OTA publication

The verified follow-up is live through EAS Update on production: [8fa50fd4-e597-4aeb-9d30-bc9d5b70a5f8](https://expo.dev/accounts/varsity-hub/projects/varsityhub/updates/8fa50fd4-e597-4aeb-9d30-bc9d5b70a5f8), source `87cd91984e63b6dee3eb429ccfb76c566b8c4ad0`, runtime `1.0.5`. iOS update `01a07892-855d-77c4-819a-f11227d1892b`; Android update `01a07892-855d-767e-8e89-93d883801e51`. EAS update-view confirmed both platforms and the exact source. Guarded publication and Sentry bundle/source-map upload exited successfully. No native build or simulator was run; the previously listed unfinished native/provider/purchase-exception gates remain open.

## Test-only follow-up: saved purchase date recovery

The user cannot provide the physical device and requested automated verification. Implemented and released explicit owner-controlled replacement dates for unfinished Apple ad purchases, preserving paid products/receipts and using the existing transactional inventory/finalization pipeline. The expired fully paid case fails when the revision logic is disabled and passes with it restored; 24 real-PostgreSQL purchase tests pass. A strict restore failure on the new combined check constraint was caught and corrected with an additive migration before OTA publication; no applied migration was edited.

Latest server source `8398649d`, Railway deployment `d4e86fed-9544-4b7e-ac19-d0bc5f87836a` successful. Refreshed backup: 63 tables / 4,341 rows / 161 exact-matching migration-history records. Independent restore run [34062244395](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34062244395) passed all restore, migration and purchase gates. Latest production OTA [584ca69f-7a69-4a79-8338-da314511522c](https://expo.dev/accounts/varsity-hub/projects/varsityhub/updates/584ca69f-7a69-4a79-8338-da314511522c) verified for iOS/Android runtime 1.0.5 and source `8398649d`; Sentry source-map uploads completed. Full evidence, the failed-then-passing restore, and remaining native/provider/legacy-receipt limits are in [purchase date recovery](PURCHASE_DATE_RECOVERY_2026-09-06.md). This release does not close the native crashes or claim physical-device verification.

## Latest recovery and native execution follow-up

Source `d0ebb4844eea56803315fcd9d49f344085be2914` is live on Railway and [production OTA c5d823cd](https://expo.dev/accounts/varsity-hub/projects/varsityhub/updates/c5d823cd-7400-4fc5-bd29-63b1edf34deb), with both platform source identities and Sentry maps verified. Independent restore run 34064154955 passed. Five reproduced reload/receipt/reconciliation defects were corrected. A local iOS Simulator build and real EventMap stress execution were subsequently performed; this supersedes earlier statements that no simulator/native build had been run. It does not establish a distributed native fix or physical-device crash resolution. Exact test results, automation failures, provider evidence and remaining dependencies are in [the recovery/native evidence record](RECOVERY_AND_NATIVE_GATES_2026-09-06.md).
