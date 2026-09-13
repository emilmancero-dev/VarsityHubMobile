# Production reliability audit — 2026-09-09

## Verdict and scope

Local source and failure-injection audit completed; production sign-off remains unverified. Three independent subagent reviews subsequently checked the ten findings summarized below against source through `06b5b8d8`. No production data was mutated or deployment performed during the audit. Remediation is tracked separately from the historical verification results.

**Evidence correction:** the original statement “173 passing test assertions” was incorrect. Jest reported 173 passing test cases, but all 11 payment-finalization cases returned before their assertions because the deliberately unreachable database left `dbReady=false`. That run provides **no payment-finalization or receipt-replay verification**. Passing source contracts also do not establish live authorization or database concurrency behavior.

The workspace was already dirty with extensive media changes and changed concurrently during this run (package version changed from 1.0.5 to 1.0.6). HEAD observed near the end: `166031aa`. Findings describe inspected local source, not proof of what installed apps or Railway currently run. Typechecks passed at the point run; they do not certify subsequent concurrent edits.

## Threat model

Reviewed entry points for auth bypass, role escalation, payment spoofing, object-level authorization, webhook replay, stale-cache exposure, and deep-link injection. Highest-impact assets are minor privacy, account sessions, team/org authority, subscriptions, and shared-device cached data. Network faults and delayed asynchronous results also threaten integrity without a malicious actor.

Security evidence below includes mocked behavior and source contracts. It is not a complete authenticated endpoint penetration test: no isolated populated database or dedicated test accounts were established, and live BOLA/payload tampering was not performed.

## Findings

### 1. Closed locally in batch 3: malformed successful JSON silently becomes success with null

Evidence: `apiclient/http.ts:342–350`, successful return near line 487, and refresh retry parsing near lines 403–412.

Reproduction executed using the real HTTP module with mocked fetch: respond HTTP 200, Content-Type application/json, body `{broken`; `httpGet('/audit-probe', {}, undefined, 0)` resolves null instead of rejecting. The focused probe passed, confirming the defect. The same parsing pattern exists after refresh.

Expected: invalid nonempty JSON rejects with a distinguishable protocol error and observable metadata. Actual: callers can enter successful/empty-state handling without learning that the response was corrupt.

Risk: ordinary proxy/backend faults can trigger this; affects every JSON API caller; generally recoverable by refetch but mutation completion becomes ambiguous. Priority: P1 reliability.

Proposed fix: share a response parser across original and refreshed responses, reject malformed nonempty JSON, preserve legitimate empty-body responses, and report endpoint/status/request ID without recording sensitive bodies. Verify both paths with malformed JSON and successful empty response cases. Do not automatically replay mutations.

Local remediation now rejects malformed successful JSON on both paths, preserving status and sanitized endpoint telemetry without automatic replay. Request-ID propagation remains open under finding 2. Historical reproduction above describes the pre-fix source; installed-release behavior is unverified.

### 2. Open bug: backend request ID is lost at the client error boundary

Evidence: `server/src/middleware/logging.ts:16–20` echoes x-request-id. `apiclient/http.ts:289–331` neither creates a request ID nor consumes the response ID; error construction and Sentry context omit it. Pino is initialized independently in `server/src/app.ts:145–172`; custom request-ID logging uses production-disabled debugLog (`server/src/lib/debugLog.ts`). This does not mean production has no HTTP logs; it means the inspected correlation path is incomplete.

Reproduction executed: mocked HTTP 500 with x-request-id `audit-request-123`; caught error has status 500 but no requestId/request_id and its serialized fields omit the ID. Source inspection also confirms the explicit client breadcrumbs omit this header.

Risk: not an authorization exploit; affects incident diagnosis across all API users; recovery requires timestamp/account-based reconstruction. Priority: P2 observability.

Proposed fix: carry one bounded request ID through HTTP headers, error objects, client breadcrumbs, structured server logs and server error context; align Pino's request ID with that value. Check web CORS allow/expose headers. Verify one injected API failure can be found end to end. Database-log correlation and Sentry trace linkage were not demonstrated.

### 3. Recovery gap: scheduled jobs do not configure failure retries

Evidence: `server/src/jobs/scheduler.ts` constructs its own Queue without defaultJobOptions and adds repeatable jobs without attempts/backoff. This queue does not inherit the separate notification/email defaults in `server/src/jobs/queues.ts`. The original 15 failure-propagation and 8 monitoring checks passed, but the failure-propagation cases omitted the actual `db-backup-sync` handler; they did not justify claiming all handlers propagate failures. A concrete lost payment or other business outcome was not established.

Expected under the requested audit criterion: retry eligible transient failures with bounded exponential backoff. Actual configuration: failed occurrence has no configured retry policy; a later cron occurrence is a new scheduled execution. No live Redis outage was injected.

Risk: transient provider/DB failures can delay reconciliation/reminders until the next schedule; cross-user impact depends on job; recovery by later run/manual replay. Priority: P2, higher for time-sensitive jobs.

Proposed fix: review idempotency per job, then configure retries only for eligible jobs and test attempt count, delay, exhaustion reporting and replay. Do not blindly retry side effects or add a parallel third-party retry mechanism.

### 4. Open observability defect: production Sentry initialization failure is silent

Evidence: `utils/sentry.ts:178–239`. Missing/placeholder DSN warns only in development. Sentry.init exceptions enter a catch that logs only when `__DEV__`; production initialization is exactly where that catch can execute. The nonblocking behavior is desirable, but there is no independent failure signal in this path.

Risk: configuration/SDK failure disables Sentry without a local production diagnostic. This is not proof of total telemetry loss: `captureException` forwards eligible explicit exceptions to the PostHog adapter before checking Sentry readiness. An independent production-mode probe confirmed zero initialization diagnostics but one subsequent analytics capture. Actual PostHog configuration/delivery and installed-release behavior remain unverified. Priority: P2.

Proposed fix: emit a sanitized independent initialization diagnostic and verify deployment/build readiness plus an actual release-mode canary. Do not make app startup wait for telemetry.

## Deliberate behavior and remaining risks

- Composer recovery after definitive rejection is locally repaired for fresh submissions in batch 4. Previously, `app/(tabs)/create-post.tsx` selected the saved `pendingPayload` before edited content, while validation/event errors did not clear the rejected request. A subsequent retry ignored edits. The new behavioral tests reproduce and fix this for known editable rejections of first submissions; recovered/ambiguous and media-readiness cases remain intentionally unresolved below.
- Phase 4 investigation qualification: even a known rejection on a retry cannot prove an earlier attempt did not commit. Auth/schema gates precede the replay lookup, and a post-replay rejection can race an earlier request still in flight. Recovered/preexisting pending requests therefore require conservative retention; only a fresh request's own definitive rejection supports releasing its key. Media-readiness recovery is also separate: `apiclient/videoUpload.ts` retains an owner/URI checkpoint and reuses a ready session, so clearing only the composer's upload cache cannot guarantee replacement of a rejected media URL.
- Auth expiry deliberately returns never-settling promises (`apiclient/http.ts:450–467`). Independent probes confirmed caller finally blocks remain pending even after aborting in-flight requests. The HTTP function's own finally still runs. AuthProvider independently clears state/storage/cache and redirects to guest home, so a universal permanent spinner is not established. Treat this as settlement/recovery design debt; test persistent callers and handler failure before changing it.
- Highlight upvotes are a reproduced client reconciliation race (`app/highlights.tsx:815–863`). An independent probe used the actual callbacks and a real QueryClient: reversed successful responses left cached tabs at voted/count 1 after the server's final unvote/count 0. Backend serializable transactions protect writes, but post-commit notification work can delay the first response (`server/src/routes/posts.ts:1752–1822`). This proves stale client cache state, not database corruption or deployed incidence.
- Font-load failure was a confirmed conditional startup bug, locally repaired in batch 5. The installed expo-font hook returned `[false, error]` after an injected rejection, while the original RootLayout read only `loaded` and rendered a spinner before mounting ErrorBoundary. A caught hook error is not a render exception for an outer boundary to catch. Installed font assets have not been shown to fail in production.
- Server uncaught exceptions and unhandled rejections call captureException (`server/src/index.ts:334–343`). Tests confirm telemetry SDK check-in failures do not replace job business outcomes. Actual provider reachability and alert delivery remain unverified.

## Additional independently verified backend findings

- **False backup success:** before remediation, the actual `db-backup-sync` handler logged returned failures and swallowed exceptions. Both injected outcomes produced `in_progress → ok` check-ins and an `ok` heartbeat through `runMonitoredJob`. Logs and some internal Sentry captures exist; “entirely silent” would be inaccurate. The original scheduler tests missed this composition.
- **Backup freshness limitation:** `server/src/lib/backupFreshness.ts` reads table counts, not content or successful-sync timestamps. Equal totals, offsetting table deficits/surpluses, and a backup ahead in row count can return `ok` with misleading “byte-for-byte current” wording. Missing tables do fail. The count heuristic cannot establish restore correctness or detect all stale updates; this does not establish that production backups are stale.
- **Reminder cron gap:** the hourly `:00`/`:30` scheduler ticks query only ±5-minute windows in `notifyUpcomingGames`. An 18:15 event matched none of 48 simulated daily windows. Normal RSVP creation queues exact 06:15/17:15 delayed notifications and date changes reschedule them. The finding is incomplete recovery when delayed scheduling fails, not loss of all reminders.
- **Correlation qualifications:** backend middleware honors and echoes incoming `x-request-id`; Pino separately assigns `req.id`. Ordinary headers may still be present in logs, and Sentry tracing is configured. Client error objects omit the response ID and browser CORS neither permits nor exposes it. End-to-end deployed correlation was not demonstrated.

## Verification actually run

Historical runs below exited 0. These are recorded results from the original snapshot, not current release sign-off:

- Client `npx tsc --noEmit` and server `npx tsc --noEmit --project server/tsconfig.json`, with installed dependencies.
- `npm run check:conflicts`: no markers reported by its configured scan.
- `npm run audit:navigation:fail`: zero REVIEW items.
- `npm run verify:secrets`: passed.
- `npm run verify:error-envelope`: default run inspected committed diff and reported no server changes. Re-ran with `GIT_BASE_SHA=HEAD GIT_HEAD_SHA=WORKTREE`: no new violations in tracked working-tree diff. Untracked files are outside that diff guard.
- Client transport/idempotency/account-boundary suites: 55 tests passed across 3 suites.
- Backend scheduler failure/fallback/monitoring, payment finalization, distributed lock, auth schemas and Sentry/log-redaction suites: Jest reported 54 passing cases across 8 suites. **Eleven payment-finalization cases silently returned without assertions when database setup failed.** Distributed-lock tests exercised local fallback, not cross-replica Redis locking.
- Backend authz matrix, game approval race, team invite race, webhook parser ordering and Google Play fail-closed suites: 23 tests passed across 5 suites. Several are source contracts, not concurrent database/API tests.
- Deep-link suites plus two temporary transport probes: 41 tests passed across 3 suites. The two probes assert the observed defects, not correct product behavior; their passing result is reproduction evidence. Temporary probe file was removed after execution.

Total reported by Jest: 173 passing test cases across 19 suite executions, including 11 payment no-ops and 2 defect-reproduction cases. This is not an assertion count or proof of payment behavior. Client Jest force-exited per its configuration; open-handle freedom was not established.

The independent follow-up reviews ran additional in-memory probes against actual extracted source for transport/auth, Pino correlation, backup handler/check-in composition, count verdicts, reminder windows, highlight callbacks with QueryClient, font-hook failure and Sentry initialization. Seven observability-scrubbing tests also passed; they verify filtering/scrubbing, not provider delivery. No full native-device or database-backed integration pass was performed in those reviews.

Backend test runs used `VARSITYHUB_ENV_PATH=/dev/null`, `DATABASE_URL=postgresql://test:test@127.0.0.1:1/varsityhub_audit`, and empty REDIS_URL to avoid configured production database access. Fetch was mocked for client transport probes; production-looking URL strings in test logs do not represent live requests.

## Outstanding production acceptance work

### First remediation batch (local, not deployed)

- `payments-finalization.test.ts` now throws on database setup failure; all eleven per-test silent returns were removed. With a deliberately unreachable localhost database, the unchanged command previously reported 11 passes and now exits 1 with an explicit setup failure. This verifies the gate, not payment business behavior. A reachable isolated test database is still required for payment acceptance.
- The registered `db-backup-sync` handler now rejects unsuccessful results and rethrows dependency exceptions. Only an absent backup URL plus the exact missing-configuration sentinel is skipped. Regression tests exercise the real handler and monitoring wrapper, confirming failed check-ins and heartbeats for failures and preserving success/disabled behavior.
- Fresh verification: 34 scheduler tests passed across three suites; client and server typechecks passed (server incremental output disabled); conflict, working-tree error-envelope and secret checks passed. The missing-database payment run failed as expected. Independent subagent review found no blocking issues.
- No backup copy/restore or production mutation was run. Freshness timestamps/content verification, client fixes, correlation, retry policy and reminder recovery remain outstanding. Rollback for this batch is reverting the handler/test changes; there is no schema migration or data transformation.

### Second remediation batch: sync evidence and count accuracy (local, not deployed)

- Count deficits are summed per table; surplus rows elsewhere cannot cancel missing rows. Count results no longer claim byte equality or restorability. Invalid drift budgets and identical source/backup configuration fail explicitly.
- The schema-completeness regression exposed an omitted `MediaUpload` table. It is now included in the canonical backup table list; the schema declares no foreign-key dependency for this model.
- The actual sync helper records an attempt before copying and records helper-reported success only after copying and cleanup finish. This includes scheduler and direct helper callers. The existing managed Redis connection stores the evidence with no process-memory fallback. A missing/unavailable evidence store prevents starting the copy.
- Freshness requires readable evidence for the current source/target configuration and a successful run started within `BACKUP_MAX_SUCCESS_AGE_HOURS` (default 12 hours, twice the six-hour cadence). Starting another attempt invalidates the prior healthy state. The checker reads evidence before and after counts and requires the same successful run, so a copy during the check cannot silently reuse the earlier verdict.
- Overlapping writers to the same normalized backup destination cannot produce healthy evidence, including source or credential changes. Failed attempts retain the previous success time only for diagnosis; a subsequent nonoverlapping successful run can recover the verdict. Crashed attempts leave an active record and fail closed. After an orphan, stop/confirm the absence of **all** writers, investigate the partial backup, reset only that destination's evidence record, and run a fresh sync before trusting the verdict. Do not reset evidence while a writer could still be active.
- Redis keys and record configuration fingerprints contain hashes, not database credentials. Evidence loss or a configuration change requires a new successful run; it is not treated as a healthy empty state. Redis persistence and endpoint aliases resolving to the same physical database are operational assumptions, not verified here.
- Rollout requires the existing Redis service to be reachable by the worker and the freshness CLI. Deploy between backup runs or drain existing copies: a writer on the old version cannot participate in the new evidence tracking. There is no schema migration or env mutation in this change. Expect a missing-evidence failure until the first tracked sync completes; do not seed a fictitious success marker. The local `verify-db-backup-sync.ts` fixture drill additionally needs an explicit local `VERIFY_REDIS_URL` and **must not be pointed at production databases**. Its fixture creation is destructive.
- The helper still tolerates some schema/sequence differences. A successful marker therefore means helper-reported completion plus age/count checks, not proof of full restore integrity. An isolated restore drill remains required. No live copy or restore was performed during implementation. Rollback is reverting this batch; reverting also removes these evidence guarantees.
- Final local verification: 130 tests passed across 12 backup/scheduler suites, including actual disposable Redis failure/overlap/timeout cases and mocked database boundaries. Independent review reproduced a late Redis dispatch after timeout during shutdown; the added deadline/shutdown guards and regression now prevent it. Client and server typechecks passed; conflict, working-tree error-envelope, secret, formatting and diff checks passed. These checks do not verify production Redis persistence, database copying or restoration.

### Third remediation batch: response validation and composer confirmation (local, not deployed)

- Both original and token-refresh retry responses use one JSON parser. Malformed nonempty successful JSON rejects with `HttpProtocolError`, `INVALID_JSON_RESPONSE`, and the actual HTTP status; legitimate empty bodies and valid JSON `null` retain their transport behavior. Malformed error bodies still surface their HTTP error status.
- Protocol errors bypass automatic retry paths and emit one exception without body/parser details. The new exception context and both HTTP breadcrumb messages/data strip query strings and fragments. This is not a claim that every existing telemetry path is sanitized or that provider delivery was verified; request-ID correlation remains outstanding.
- The composer now requires a nonblank top-level post ID before media cleanup, recovery clearing, draft deletion or success UI. Unconfirmed results preserve the existing pending payload/request ID for explicit retry. Server source confirms `201` creation and `200` replay return this shape, with deterministic per-user/request IDs and conflict handling for changed payloads. The existing database-backed media recovery tests were inspected but not run; database idempotency is not newly certified here.
- TDD reproduced three transport failures, separate query/breadcrumb privacy failures, and three composer cleanup failures before fixes. Final combined run: 80 tests passed across six transport/retry/account-boundary/composer suites. The composer harness executes its actual extracted confirmation block with mocked API/storage, so it verifies cleanup ordering but does not mount the full screen or prove persistence across an app restart. Existing account-boundary/video foundation checks include source contracts. Jest force-exited per configuration; open-handle freedom was not established.
- Independent frontend/backend review found no blocking issue in this batch. Definitive-rejection recovery remains the separate open issue recorded above. No live API calls, device drill, commit or deployment occurred. Rollback is reverting this client-only batch; installed apps need a production client update to receive it.
- Client and server typechecks passed with installed dependencies. Conflict, navigation (zero REVIEW), working-tree error-envelope, secret, scoped formatting and diff checks passed.

### Fourth remediation batch: editable fresh rejection recovery (local, not deployed)

- The composer records whether a pending request existed at submission entry. Only a fresh first request rejected by an exact known validation, event-posting or team-access envelope releases its pending payload. Draft text, local media and the uploaded-media result remain available; the next explicit submission uses the edited payload and a new key. The rejection handler surrounds the create call, so upload/preflight/storage errors cannot masquerade as post rejection.
- Clearing the pending request is saved and read back before the in-memory recovery changes. Both persisted owner and recovery must match, and owner guards run before writing and after readback. Failed verification retains the old key and surfaces a storage error. These guards do not make the global `POST_DRAFT` key atomic: a write already in flight can still race an account switch. Account-scoped storage remains separate work.
- Existing/restored pending requests retain their keys on all rejections. Unknown envelopes, auth/rate-limit responses, all conflicts, malformed success, network/timeout/server failures and `MEDIA_NOT_READY` remain conservative. This batch does not reconcile uncertain historical attempts or repair video checkpoints. Server source was traced through validation/replay/insert ordering; no database-backed concurrency test was run.
- Before implementation, actual composer-boundary regressions reproduced the stuck rejected payload and missing persisted reset. Final combined verification: 108 tests passed across six composer/transport/account-boundary suites, including fresh rejection followed by edited submission, previous timeout followed by rejection, silent storage failure and owner changes. The harness executes extracted persistence/request/cleanup code with mocked API/storage; it is not a mounted device or restart drill. Jest force-exited per configuration.
- Independent backend and frontend review found no blocking issue within this scope. Client/server typechecks passed; conflict, navigation (zero REVIEW), working-tree error-envelope, secret, scoped formatting and diff checks passed. No live services, commit or deployment. Rollback is reverting this client-only batch; installed apps require a production client update.

### Fifth remediation batch: font startup recovery (local, not deployed)

- A font-load rejection now replaces the spinner with a themed, system-text recovery screen and accessible **Try again** control. The app stays gated until loading succeeds because the bundle includes icon fonts used for controls. Retry remounts only `FontLoadAttempt`; root OTA and deep-link effects remain mounted.
- A fixed sanitized error reports once per failed attempt through existing telemetry; the original loader error/asset URL is not attached. Reporting exceptions cannot break the recovery controls. Actual provider delivery remains unverified.
- The installed expo-font runtime hook was inspected and exercised: rerender alone cannot retry its empty-dependency effect, while a fresh mount retries. Two regressions failed before the fix. Final startup run passed five tests across two suites, including three focused font cases using actual React lifecycle and extracted installed-hook/root code with mocked native/loading integrations. The existing feed startup tests emitted missing `Event.filter` mock warnings; their passing result does not verify those event fetches. Jest force-exited per configuration.
- Independent review found no blocking issue. This fixes a rejected load, not a loader that never settles. No native-device, visual, real font-download or release verification occurred. Rollback is reverting this client-only batch; installed apps require a production client update.
- Client/server typechecks passed after correcting a test-only missing renderer declaration; the focused three-test suite passed again after that correction. Conflict, navigation (zero REVIEW), working-tree error-envelope, secret, scoped formatting and diff checks passed.

Use an isolated staging deployment with seeded adult/minor accounts, separate team/org roles, provider sandboxes and a native development/release test build:

1. Execute real BOLA and payload-tampering cases across each protected route; verify expected 401/403/404 and unchanged database rows. Test negative/zero/huge pricing inputs and cross-account receipt replay.
2. Race identical submissions/webhooks/invite acceptances against PostgreSQL and Redis; verify one durable outcome and no duplicate charge/email.
3. Interrupt network mid-upload, auth refresh and optimistic actions on iOS/Android; force invalid refresh credentials and navigation interruption; verify drafts, cleanup and eventual UI recovery.
4. Block third-party endpoints independently; inject UI render crashes and unhandled rejections in a release build; verify core UI remains usable and actual error alerts arrive.
5. Kill workers mid-job and inject transient provider errors; inspect retry/reconciliation outcome across replicas.
6. Trace a failed mobile request into server telemetry and any available database tracing. Inspect real session replays/rage-click evidence only through the configured project with appropriate privacy controls; no replay dashboard was accessed in this audit.

These are outstanding checks, not a production pass. None of the five local remediation batches has been shipped. Batches 1–2 change server behavior/tests; batches 3–5 change client behavior and require a client release/update.
