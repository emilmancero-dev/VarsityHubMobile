# Production reliability audit — 2026-09-09

## Verdict and scope

Local source and failure-injection audit completed; production sign-off remains unverified. Found two reproduced transport defects, one scheduler recovery gap, and one silent observability initialization failure. No production data was mutated, no deployment was performed, and no application code was changed by this audit.

The workspace was already dirty with extensive media changes and changed concurrently during this run (package version changed from 1.0.5 to 1.0.6). HEAD observed near the end: `166031aa`. Findings describe inspected local source, not proof of what installed apps or Railway currently run. Typechecks passed at the point run; they do not certify subsequent concurrent edits.

## Threat model

Reviewed entry points for auth bypass, role escalation, payment spoofing, object-level authorization, webhook replay, stale-cache exposure, and deep-link injection. Highest-impact assets are minor privacy, account sessions, team/org authority, subscriptions, and shared-device cached data. Network faults and delayed asynchronous results also threaten integrity without a malicious actor.

Security evidence below includes mocked behavior and source contracts. It is not a complete authenticated endpoint penetration test: no isolated populated database or dedicated test accounts were established, and live BOLA/payload tampering was not performed.

## Findings

### 1. Open bug: malformed successful JSON silently becomes success with null

Evidence: `apiclient/http.ts:342–350`, successful return near line 487, and refresh retry parsing near lines 403–412.

Reproduction executed using the real HTTP module with mocked fetch: respond HTTP 200, Content-Type application/json, body `{broken`; `httpGet('/audit-probe', {}, undefined, 0)` resolves null instead of rejecting. The focused probe passed, confirming the defect. The same parsing pattern exists after refresh.

Expected: invalid nonempty JSON rejects with a distinguishable protocol error and observable metadata. Actual: callers can enter successful/empty-state handling without learning that the response was corrupt.

Risk: ordinary proxy/backend faults can trigger this; affects every JSON API caller; generally recoverable by refetch but mutation completion becomes ambiguous. Priority: P1 reliability.

Proposed fix: share a response parser across original and refreshed responses, reject malformed nonempty JSON, preserve legitimate empty-body responses, and report endpoint/status/request ID without recording sensitive bodies. Verify both paths with malformed JSON and successful empty response cases. Do not automatically replay mutations.

### 2. Open bug: backend request ID is lost at the client error boundary

Evidence: `server/src/middleware/logging.ts:16–20` echoes x-request-id. `apiclient/http.ts:289–331` neither creates a request ID nor consumes the response ID; error construction and Sentry context omit it. Pino is initialized independently in `server/src/app.ts:145–172`; custom request-ID logging uses production-disabled debugLog (`server/src/lib/debugLog.ts`). This does not mean production has no HTTP logs; it means the inspected correlation path is incomplete.

Reproduction executed: mocked HTTP 500 with x-request-id `audit-request-123`; caught error has status 500 but no requestId/request_id and its serialized fields omit the ID. Source inspection also confirms the explicit client breadcrumbs omit this header.

Risk: not an authorization exploit; affects incident diagnosis across all API users; recovery requires timestamp/account-based reconstruction. Priority: P2 observability.

Proposed fix: carry one bounded request ID through HTTP headers, error objects, client breadcrumbs, structured server logs and server error context; align Pino's request ID with that value. Check web CORS allow/expose headers. Verify one injected API failure can be found end to end. Database-log correlation and Sentry trace linkage were not demonstrated.

### 3. Recovery gap: scheduled jobs do not configure failure retries

Evidence: `server/src/jobs/scheduler.ts:525` constructs its own Queue without defaultJobOptions; lines 535–544 add repeatable jobs without attempts/backoff. This queue does not inherit the separate defaults in `server/src/jobs/queues.ts:70`. Job handlers correctly propagate errors and worker failures are captured; 15 failure-propagation and 8 monitoring checks passed.

Expected under the requested audit criterion: retry eligible transient failures with bounded exponential backoff. Actual configuration: failed occurrence has no configured retry policy; a later cron occurrence is a new scheduled execution. No live Redis outage was injected.

Risk: transient provider/DB failures can delay reconciliation/reminders until the next schedule; cross-user impact depends on job; recovery by later run/manual replay. Priority: P2, higher for time-sensitive jobs.

Proposed fix: review idempotency per job, then configure retries only for eligible jobs and test attempt count, delay, exhaustion reporting and replay. Do not blindly retry side effects or add a parallel third-party retry mechanism.

### 4. Open observability defect: production Sentry initialization failure is silent

Evidence: `utils/sentry.ts:178–239`. Missing/placeholder DSN warns only in development. Sentry.init exceptions enter a catch that logs only when **DEV**; production initialization is exactly where that catch can execute. The nonblocking behavior is desirable, but there is no independent failure signal in this path.

Risk: configuration/SDK failure disables intended crash reporting without a local production diagnostic; app-wide monitoring blind spot; recovery requires configuration or release correction. Priority: P2. Source-confirmed; SDK init failure was not injected into an installed release.

Proposed fix: emit a sanitized independent initialization diagnostic and verify deployment/build readiness plus an actual release-mode canary. Do not make app startup wait for telemetry.

## Deliberate behavior and remaining risks

- Auth expiry deliberately returns never-settling promises (`apiclient/http.ts:452,467`). Existing behavior tests confirm refresh failure clears tokens and emits the expiry event while the caller stays pending. This avoids duplicate alerts during redirect, but caller finally blocks cannot execute. Treat this as a policy/design risk rather than a newly introduced defect; test redirect failure, persistent providers and interrupted navigation before changing it to a typed cancellation result.
- Highlight upvote rollback (`app/highlights.tsx:815–863`) restores state and signals only a haptic error plus a development log. Concurrent toggles are not sequenced in this handler, so out-of-order reconciliation remains a race candidate. No device repro was performed; do not report confirmed count corruption. DM send does remove its optimistic item on failure and preserve draft text (`app/message-thread.tsx:294–335`).
- ErrorBoundary surrounds the main provider/screen tree and reports caught render errors with a retry fallback. Root layout/font-loading work precedes that boundary. No rendered crash injection or release-mode global rejection canary was performed.
- Server uncaught exceptions and unhandled rejections call captureException (`server/src/index.ts:334–343`). Tests confirm telemetry SDK check-in failures do not replace job business outcomes. Actual provider reachability and alert delivery remain unverified.

## Verification actually run

All listed runs exited 0:

- Client `npx tsc --noEmit` and server `npx tsc --noEmit --project server/tsconfig.json`, with installed dependencies.
- `npm run check:conflicts`: no markers reported by its configured scan.
- `npm run audit:navigation:fail`: zero REVIEW items.
- `npm run verify:secrets`: passed.
- `npm run verify:error-envelope`: default run inspected committed diff and reported no server changes. Re-ran with `GIT_BASE_SHA=HEAD GIT_HEAD_SHA=WORKTREE`: no new violations in tracked working-tree diff. Untracked files are outside that diff guard.
- Client transport/idempotency/account-boundary suites: 55 tests passed across 3 suites.
- Backend scheduler failure/fallback/monitoring, payment finalization, distributed lock, auth schemas and Sentry/log-redaction suites: 54 tests passed across 8 suites.
- Backend authz matrix, game approval race, team invite race, webhook parser ordering and Google Play fail-closed suites: 23 tests passed across 5 suites. Several are source contracts, not concurrent database/API tests.
- Deep-link suites plus two temporary transport probes: 41 tests passed across 3 suites. The two probes assert the observed defects, not correct product behavior; their passing result is reproduction evidence. Temporary probe file was removed after execution.

Total: 173 passing test assertions across 19 suite executions, including 2 defect-reproduction assertions. Client Jest force-exited per its configuration; open-handle freedom was not established.

Backend test runs used `VARSITYHUB_ENV_PATH=/dev/null`, `DATABASE_URL=postgresql://test:test@127.0.0.1:1/varsityhub_audit`, and empty REDIS_URL to avoid configured production database access. Fetch was mocked for client transport probes; production-looking URL strings in test logs do not represent live requests.

## Outstanding production acceptance work

Use an isolated staging deployment with seeded adult/minor accounts, separate team/org roles, provider sandboxes and a native development/release test build:

1. Execute real BOLA and payload-tampering cases across each protected route; verify expected 401/403/404 and unchanged database rows. Test negative/zero/huge pricing inputs and cross-account receipt replay.
2. Race identical submissions/webhooks/invite acceptances against PostgreSQL and Redis; verify one durable outcome and no duplicate charge/email.
3. Interrupt network mid-upload, auth refresh and optimistic actions on iOS/Android; force invalid refresh credentials and navigation interruption; verify drafts, cleanup and eventual UI recovery.
4. Block third-party endpoints independently; inject UI render crashes and unhandled rejections in a release build; verify core UI remains usable and actual error alerts arrive.
5. Kill workers mid-job and inject transient provider errors; inspect retry/reconciliation outcome across replicas.
6. Trace a failed mobile request into server telemetry and any available database tracing. Inspect real session replays/rage-click evidence only through the configured project with appropriate privacy controls; no replay dashboard was accessed in this audit.

These are outstanding checks, not a production pass. No fixes were shipped; no OTA action is needed for this audit document.
