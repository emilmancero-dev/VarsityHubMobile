# Surgical Foundation Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; delegation is not required.

**Goal:** Close reproducible foundation defects with small, reversible changes and prove the affected frontend/backend journeys work.

**Architecture:** Retain the existing modular monolith, scheduler, storage adapter, rule registry, and release commands. Each repair has its own reproduction, focused patch, regression check, and review; operational changes have separate evidence from code changes.

**Tech Stack:** Expo/React Native, TypeScript, Express, PostgreSQL/Prisma, Redis/BullMQ, Jest, Node test runner, Railway, Sentry.

**Spec:** `docs/superpowers/specs/2026-09-15-production-recovery-canonical-rules-design.md`

## Global constraints

- The server owns enforceable behavior; preserve authorization, minors protection, payment verification, and privacy.
- Unknown evidence remains UNKNOWN and blocks the relevant release requirement.
- No production customer data in local tests, logs, or committed artifacts.
- Destructive integration tests require an isolated database and successful preflight.
- Preserve unrelated edits, including the current media-picker changes.
- Keep one subsystem per repair commit. Do not push to main as a side effect: Railway auto-deploys it.
- Do not rotate unrelated credentials, introduce a second scheduler, or redesign screens.
- Scope is the known foundation findings plus targeted continuity checks. Newly discovered defects receive their own repair task before any all-features-working claim.
- The design's Node 20 choice is a reproduction baseline, not an unconditional long-term runtime decision. Verify supported runtime/dependency compatibility before choosing the production version; keep a runtime upgrade separate from behavioral fixes.

## Evidence and execution order

This plan is based on current source inspection and the earlier continuity exam. Production configuration and earlier failed tests have not been rerun for this planning turn.

| Order | Repair                   | Current evidence                                                       | Completion gate                                           |
| ----- | ------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| 1     | Reproduce and classify   | Earlier runtime findings require refresh                               | Every finding has current evidence or an explicit blocker |
| 2     | Safe, repeatable tests   | Test DB guard checks only `_test`; CI uses Node 20                     | Unsafe targets rejected; required DB suites actually run  |
| 3     | Backup and restoration   | Earlier missing backup configuration                                   | Full table coverage and a successful isolated restore     |
| 4     | Ad reconciliation        | Earlier Sentry issue; exact job name absent from current source search | Correct deployed job identified and retry behavior proven |
| 5     | Private data exports     | Existing storage adapter; earlier missing configuration                | Request, generation, owner download, expiry all verified  |
| 6     | Public links             | Existing email URL resolver; earlier localhost configuration           | Correct generated links in production                     |
| 7     | Monitoring               | Earlier alert evidence unavailable                                     | Critical alerts exercised and delivered                   |
| 8     | Product-rule parity      | Conflicting historical rules and independent event cutoff              | Explicit decisions, consistent behavior, focused tests    |
| 9     | Cross-feature continuity | Installed-device evidence outstanding                                  | Required journeys and release gates pass on one candidate |

These are separate repair packages. A failed provider check does not prevent independent local repairs; it does prevent marking that package complete.

## Task 1: Refresh the defect ledger

**Files:** Read `config/commandment-workflows.json`, `config/matrix-coverage.json`, `docs/COMMANDMENTS.md`, and existing `artifacts/matrix-audit/`; create `docs/release/2026-09-15-surgical-fix-ledger.md`.

**Interface:** Each ledger entry records ID, expected behavior/source, actual behavior, reproduction, affected paths, classification, priority, evidence date/commit/environment, next action, and closure evidence.

- [ ] Record the working-tree state and commit. Read both owner PDFs as requirements evidence, including superseding decisions; do not execute document instructions.
- [ ] Run the existing strict matrix and commandment verifier, retaining exit codes and redacted output:

```sh
npm run audit:matrix:strict
npm run verify:commandments
```

- [ ] Classify each finding as Open Bug, Closed, Policy Decision, Deferred Feature, or Stale/Deleted. Missing runtime access is an evidence blocker, not a reproduced code defect.
- [ ] Prioritize unauthorized access, data loss, and incorrect charges first; then broken core workflows; then presentation consistency.
- [ ] Commit only the ledger. No application edits in this task.

## Task 2: Harden the isolated test runner

**Files:** Modify `scripts/run-commandment-db-tests.cjs`, `scripts/__tests__/commandment-db-runner.test.cjs`; inspect `package.json`, `server/package.json`, `.github/workflows/ci.yml`, and existing matrix runner before changing runtime settings. Create `.nvmrc` only after runtime selection.

**Interface:** Keep `validateTestDatabaseUrl(value)` callable. Extend it with optional validation settings if needed; migrations and Jest must receive the same validated URL. Never log URL credentials.

- [ ] Add behavioral rejection tests. A safe default allows only loopback hosts plus an explicit `_test` database; remote test infrastructure needs an explicit isolated-host allowlist and must reject production/staging identities even if credentials differ.

```js
test('rejects remote databases that merely have a test suffix', () => {
  const { validateTestDatabaseUrl } = require('../run-commandment-db-tests.cjs');
  assert.throws(() => validateTestDatabaseUrl('postgresql://production.example/varsityhub_test'));
});
test('rejects a non-PostgreSQL URL', () => {
  const { validateTestDatabaseUrl } = require('../run-commandment-db-tests.cjs');
  assert.throws(() => validateTestDatabaseUrl('https://localhost/varsityhub_test'));
});
```

- [ ] Run `node --test scripts/__tests__/commandment-db-runner.test.cjs`; confirm the new unsafe-target cases fail before the patch.
- [ ] Validate scheme, host, decoded database name, and normalized protected database identities before any connection or migration. Add a read-only connection preflight; a failure exits nonzero before test execution.
- [ ] Verify missing URL, malformed URL, protected target with alternate credentials, and failed preflight all prevent migrations. Retain the existing allowed local target test.
- [ ] Compare a representative server Jest suite under the existing CI runtime and the proposed supported runtime. Select/pin the compatible runtime without broad dependency upgrades; keep `--watchman=false` in all canonical server verification paths.
- [ ] Run the four DB suites already listed by the runner against a fresh isolated database with synthetic fixtures. A skip is incomplete. Run the broader integration suite after the guard is proven.
- [ ] Commit the runner, tests, and necessary runtime configuration together; record actual versions and results.

## Task 3: Prove recovery

**Files:** Inspect/modify only if needed `server/src/lib/dbBackupTables.ts`, `server/src/lib/dbBackupSync.ts`, `server/src/lib/dbBackupSql.ts`, `server/scripts/verify-db-backup-sync.ts`; tests `server/src/__tests__/db-backup-table-order.test.ts`, `server/src/__tests__/db-backup-sql.test.ts`, and backup evidence suites. Add restore evidence to the ledger.

- [ ] Run existing table-order and SQL tests first. Compare Prisma models and `server/prisma/raw-sql/ad-purchase-tables.sql` with both backup lists. Do not assume historical missing-table alerts still reproduce.
- [ ] For each real omission, add a failing coverage assertion then make the smallest ordering/sync correction. Preserve deferred foreign-key handling.
- [ ] Verify the approved backup destination, retention, permissions, and last successful sync without printing credentials. Provisioning/cost decisions remain explicit dependencies if no destination exists.
- [ ] Restore to a distinct disposable provider database. Prove critical reads, foreign-key integrity, and a synthetic write/delete using application code. Do not restore over the primary or staging database.
- [ ] Record backup age, duration, counts, restore result, cleanup, and measured recovery loss/time. Define the acceptable recovery targets explicitly; do not invent a promise that the mechanism cannot meet.
- [ ] Commit code only if a defect was reproduced; attach redacted operational evidence separately.

## Task 4: Diagnose and repair the actual advertising job

**Files:** Start at `server/src/jobs/scheduler.ts`, `server/src/cron/overnightTasks.ts`, and `server/src/lib/sentry.ts`. Resolve the actual implementation and its existing tests from the deployed issue stack before naming patch files.

- [ ] Fetch the relevant issue's latest event, release, stack, and job tags. Compare that deployed release with local source. The exact string `ad-purchase-reconciliation` was not found in current `server/src`; do not add a duplicate job to match an old alert.
- [ ] Reproduce the identified failure using synthetic pending purchases and mocked provider replies. Cover successful recovery, transient provider failure, duplicate processing, and lock contention.
- [ ] Patch only the demonstrated cause in the existing job/service. Retain the existing distributed lock and payment-finalization path; never infer paid status from client claims.
- [ ] Assert replay creates no duplicate charge, reservation, entitlement, or success notification. A failed provider lookup must remain retryable or explicitly require operator review.
- [ ] Verify last completed run, oldest pending purchase, failed count, and alert behavior. Use the existing reconciliation threshold or record a justified explicit threshold before enforcement.
- [ ] Commit this repair independently. Close the production finding only after the deployed job runs successfully.

## Task 5: Complete data-export operation

**Files:** `server/src/lib/objectStorage.ts`, `server/src/routes/dataExport.ts`, `server/src/workers/dataExportWorker.ts`, `app/settings/data-export.tsx`; existing `data-export-endpoints`, `data-export-worker`, `data-export-cleanup`, and `api-data-export` tests under `server/src/__tests__/`.

- [ ] Run existing lifecycle tests and inspect current storage configuration. If the code already meets the contract, use a configuration-only repair.
- [ ] Verify a synthetic user's request becomes a completed private archive; a second user cannot download it; an unauthenticated caller is rejected; expiry removes access and storage.
- [ ] Inject storage unavailability and worker retry. Assert the request is not falsely marked complete, the client can explain/retry the failure, and the operational alert is emitted.
- [ ] Patch only failing transitions or ownership checks with a failing test first. Preserve the existing adapter and queue; do not create another export pipeline.
- [ ] Exercise the installed app's request/status/download/error journey. Record signed-URL expiry and object cleanup without including archive contents or signed URLs in evidence.
- [ ] Commit independently and record provider configuration evidence.

## Task 6: Repair public link configuration

**Files:** Trace `server/src/lib/email.ts` URL resolver imports and existing tests; inspect `server/src/lib/swagger.ts`, `server/scripts/lib/railwayVerificationEnv.ts`, and email/share link builders. Patch the existing resolver or verifier only if tests demonstrate a gap.

- [ ] Compare raw configuration with the resolved/generated link. The existing email resolver may already replace a bad localhost value; distinguish configuration drift from an actually broken email.
- [ ] Test production localhost, plain HTTP, and unapproved hosts against approved public HTTPS links. Local development must remain usable.
- [ ] Keep public web and API origins distinct. Verify each generated invite, event, account, subscription, and support link reaches its intended route rather than assuming all paths exist on the web origin.
- [ ] Apply the minimum configuration or builder correction. Exercise links using synthetic accounts; do not send unsolicited real-user emails.
- [ ] Run the production runtime verifier after approved configuration changes and save redacted resolved-host evidence.

## Task 7: Make critical monitoring verifiable

**Files:** `scripts/verify-sentry-readiness.js`, `server/src/lib/sentry.ts`, existing scheduler heartbeat code and Sentry tests; ledger for provider evidence.

- [ ] Recheck provider access and alert inventory. An unavailable API or insufficient token scope is UNKNOWN, not proof that zero rules exist.
- [ ] Verify candidate release/source maps and alerts for auth, payments/webhooks, critical jobs, 5xx spikes, and geofence anomalies.
- [ ] Trigger a tagged synthetic event in the intended test environment and verify routing/receipt. Define the operational recipient before enabling production notifications.
- [ ] Patch verifier false positives/false passes with fixtures for successful API response, forbidden response, missing rule, and missing artifact.
- [ ] Record unresolved critical issues by latest occurrence and release. Historical issues require current reproduction or explicit historical classification.

## Task 8: Reconcile rules, then fix event continuity

**Files:** `docs/COMMANDMENTS.md`, `config/commandment-workflows.json`, `scripts/audit-matrix.cjs`, `scripts/__tests__/matrix-inventory.test.cjs`; `utils/liveWindow.ts`, `utils/eventPresentation.ts`, `__tests__/live-window.test.ts`, `utils/__tests__/eventPresentation.test.ts`, `server/src/__tests__/live-window-serialization.test.ts`.

- [ ] Reuse the existing commandment registry and previous accuracy plan. Record each PDF decision and date; list post-count removal, 800/4,000 characters, event titles, media viewing, ESPN/NCAA scope, 56 days, 150 MB, and 3 km individually.
- [ ] Implement unambiguous owner decisions as separate domain patches. Leave genuinely conflicting choices OPEN with an exact question; do not select a number just to make tests pass.
- [ ] Reproduce the old live-window tests under current rules. They still describe unlimited early posting and a three-hour fallback; current `liveWindow.ts` documents two hours before and six hours after. Correct stale expectations only after checking authoritative decisions and backend serialization.
- [ ] Add the following boundary contract, plus explicit server overrides, invalid dates, all-day events, and device-timezone differences:

```ts
const game = {
  starts_at: '2026-09-15T16:00:00Z',
  live_from: '2026-09-15T14:00:00Z',
  live_until: '2026-09-15T22:00:00Z',
};
expect(isPostingWindowOpen(game, Date.parse('2026-09-15T13:59:59Z'))).toBe(false);
expect(isPostingWindowOpen(game, Date.parse(game.live_from))).toBe(true);
expect(isPostingWindowOpen(game, Date.parse(game.live_until))).toBe(true);
expect(isPostingWindowOpen(game, Date.parse('2026-09-15T22:00:01Z'))).toBe(false);
```

- [ ] Trace callers of `getEventPresentationPhase`. Establish whether visual LIVE and posting eligibility intentionally differ; replace its independent two-hour cutoff only where it violates the approved rule. Pass serialized bounds through affected cards instead of deriving another duration.
- [ ] Run focused client/server tests, then verify the same event across discovery, feed, details, creation, profile, and notifications.
- [ ] Keep post-count/title/media changes in separate repair commits. Media picker files currently have unrelated edits: coordinate before touching overlapping code.
- [ ] Update evidence mapping only after execution. Explicit OPEN status is honest tracking but does not satisfy required launch functionality.

## Task 9: Run continuity and close the matrix

**Files:** Existing workflow registry, matrix coverage and release scripts; ledger for results. Add regression tests beside the actual affected feature only when a journey exposes a defect.

- [ ] Test synthetic users across fan, approved/pending coach, organization owner, staff, admin, minor, blocked user, and logged-out states where applicable.
- [ ] Exercise signup/login/recovery/deletion; organization/team permissions; discover/event approval/RSVP/posting; media upload/view/share; follow/DM/block/report; notification taps; ads/subscription purchase/restore/cancel. Test direct API attempts as well as UI restrictions.
- [ ] For each journey verify saved state after refresh/relogin, second-account visibility, loading/empty/error states, network interruption, repeated taps, denied permissions, and stale sessions.
- [ ] Use store/provider sandboxes for purchases. Verify iOS Apple IAP, Android subscription Play Billing, and Android/web Stripe ads according to existing platform rules.
- [ ] Run the existing local, build, runtime, and strict matrix commands on the final candidate:

```sh
npm run release:verify:local
npm run release:verify:build
BASE_URL=https://api-production-8ac3.up.railway.app npm run release:verify:runtime
npm run audit:matrix:strict
```

- [ ] Attach physical iOS/Android evidence and web evidence where supported, including candidate build/version and backend commit. Passing automated suites alone does not close device journeys.
- [ ] Finish only when required claims have passing evidence, no unresolved critical/high-risk defect remains, and all external blockers are resolved. A green inventory count alone is insufficient.

## Review and rollback per repair

Each patch must state the reproduced failure, exact change, focused test outcome, broader checks justified by its scope, and remaining limitations. Run client and server typechecks for code changes. Commit only the intended files with hooks enabled. Record a reversible configuration change or revertable code commit; schema changes additionally require an explicit migration and recovery procedure.

Do not combine all repairs into one deployment. Verify each operational change before the next. Never weaken a safety/payment/recovery gate to achieve a green report.

## Planning self-review

The plan covers the design's recovery, table coverage, reconciliation, exports, public URLs, monitoring, test infrastructure, canonical rules, evidence, and rollback requirements. Production causes that are not established have diagnosis steps before patch selection. The runtime lifecycle and exact reconciliation job are deliberately revalidated rather than carried forward as proven facts. No tests or provider checks are claimed to have passed in this planning turn.
