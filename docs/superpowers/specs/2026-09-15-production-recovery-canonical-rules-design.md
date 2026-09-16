# Production Recovery and Canonical Rules Design

## Purpose

Make VarsityHub safe to change and safe to operate before adding or polishing
features. This milestone closes the production recovery gaps found by the
September 15 continuity exam and creates one executable source of truth for the
owner's product rules.

This milestone is complete only when recovery, monitoring, critical background
work, test infrastructure, and rule traceability have current evidence. Passing
source-text checks or having a route present is not sufficient.

## Scope

### Production recovery

- Configure a disaster-recovery database destination and prove that a current
  backup can be restored.
- Ensure every Prisma model and every raw-SQL advertising table is included in
  backup verification.
- Repair and monitor the `ad-purchase-reconciliation` scheduled job.
- Configure private object storage for user data exports and verify the complete
  request-to-download-to-expiry lifecycle.
- Correct production public URL configuration so email and share links never
  point at localhost or an internal host.
- Make Sentry release artifacts, issue routing, and production alert rules
  verifiable through a stable check.
- Standardize the supported local/CI Node version and make the canonical test
  commands independent of Watchman.
- Provide an isolated PostgreSQL test database for destructive integration
  tests. Production and staging databases must never be eligible test targets.

### Canonical product rules

- Reconcile the two owner PDFs, `docs/COMMANDMENTS.md`, the commandment registry,
  source constants, and tests.
- Give every enforceable rule a stable identifier and an owner-approved status.
- Record product decisions separately from implementation state.
- Require current rules to identify backend enforcement, frontend presentation,
  automated evidence, and installed-device evidence.
- Prevent a stale test, comment, or historical audit from silently becoming the
  product specification.

## Non-goals

- This milestone does not redesign screens or add new product features.
- It does not implement the later media viewer, dark-mode, title-format, or
  event-card presentation changes beyond recording their approved rules and
  current implementation status.
- It does not broaden NCAA ingest or add SeatGeek.
- It does not declare the app launch-ready. Safety, authorization, payments,
  frontend continuity, staging, and device UAT remain later milestones.
- It does not run destructive tests against production data.

## Design principles

1. **Production safety precedes feature work.** No feature work is considered
   releaseable while backup, critical cron, or alerting gates are red.
2. **The server owns enforceable behavior.** The client reflects server-provided
   state and never re-derives safety, payment, authorization, or posting rules.
3. **Evidence expires.** Reports name the commit, environment, build, command,
   timestamp, and result. Historical green prose is not current evidence.
4. **Unknown means NO-GO.** Missing credentials, missing device runs, and skipped
   integration tests remain explicit unknowns rather than inferred passes.
5. **One rule, one identity.** A product rule has one stable ID even when it
   affects multiple screens, endpoints, jobs, and tests.
6. **No secret values in artifacts.** Verification records presence, scope, and
   provider response while redacting values and tokens.
7. **Recovery is demonstrated, not configured.** A backup is valid only after a
   restore drill and application-level read/write verification.

## Architecture

### 1. Recovery control plane

The existing Railway PostgreSQL database remains the primary store. A distinct
backup PostgreSQL database is configured through `DATABASE_BACKUP_URL`. The
existing backup sync pipeline remains the single replication mechanism; it is
extended only where verification exposes missing coverage.

`server/src/lib/dbBackupTables.ts` remains the source of table ordering:

- `TABLES_IN_ORDER` covers every Prisma model exactly once.
- `RAW_SQL_BACKUP_TABLES` covers the advertising purchase tables created by
  `prisma/raw-sql/ad-purchase-tables.sql`.
- A schema-driven test rejects missing, duplicate, or invalid entries.
- The runtime verifier compares source and destination table coverage and row
  summaries without printing row data.

The restore drill targets a disposable database. It restores the latest backup,
runs Prisma compatibility checks, reads representative critical records, writes
and deletes a synthetic verification row, then destroys or expires the drill
database through the provider's approved process.

### 2. Critical-job observability

Scheduled jobs continue to run through the existing scheduler and heartbeat
infrastructure. The `ad-purchase-reconciliation` job gains a deterministic test
fixture and an operator-facing health result covering:

- last start and completion time;
- processed, reconciled, deferred, and failed counts;
- oldest unreconciled intent age;
- idempotent retry behavior;
- a redacted failure reason suitable for Sentry and logs.

A job is unhealthy when it misses its expected interval, fails its latest run,
or leaves an intent beyond the documented reconciliation threshold. The health
check must not report success merely because the scheduler process is alive.

### 3. Data-export storage

Production uses private S3-compatible storage configured by the existing
`DATA_EXPORT_S3_*` variables. Export objects are never public. Download access
uses short-lived signed URLs issued after authentication and ownership checks.

The lifecycle is:

1. The authenticated user requests an export.
2. The server creates an auditable export record and queues generation.
3. The worker writes the archive to private storage.
4. The user receives an authenticated notification containing an app route, not
   a permanent storage URL.
5. The server issues a short-lived signed download URL on demand.
6. Expiry removes the object and updates the audit record.

Failed storage configuration returns a clear `503`, emits an operational alert,
and never marks an export complete.

### 4. Public URL authority

Production has one canonical public web origin: `https://www.varsityhub.app`.
The API origin remains `https://api-production-8ac3.up.railway.app`.

Link builders receive the correct origin by purpose:

- user-facing web, email, and share links use the public web origin;
- API calls and operational probes use the API origin;
- local development may use localhost only when the runtime environment is not
  production.

Startup and release verification fail closed if a production public URL is
localhost, plain HTTP, or an unapproved host.

### 5. Monitoring and release evidence

Sentry stays the error and release system. The release verifier records:

- the current app version and runtime version;
- source-map/debug-artifact presence for the candidate build or update;
- production alert rules for auth failures, payment/webhook failures, critical
  job failures, 5xx spikes, and geofence anomalies;
- unresolved high-impact issues with last-seen timestamps;
- the latest successful scheduler heartbeat for critical jobs.

Provider APIs that are deprecated or unavailable do not convert to a pass. The
verifier reports `UNKNOWN` and points to the exact manual dashboard evidence
required.

### 6. Deterministic test environment

The supported verification runtime is Node 20.x, matching the existing local
installation and avoiding the Node 24 Jest ESM registry failures found during
the continuity exam. The version is pinned through repository configuration and
checked by release scripts.

Server Jest commands always pass `--watchman=false`. Integration tests receive a
dedicated database URL through `COMMANDMENTS_TEST_DATABASE_URL` or a renamed
canonical equivalent. The guard must reject:

- a missing URL;
- the configured production or staging URL;
- a database name without an explicit test suffix;
- a host allowlist violation;
- destructive execution without a successful preflight connection.

The test database is migrated from scratch and seeded with deterministic
fixtures. Suites own their records and clean them through explicit helpers.

### 7. Canonical rule registry

`docs/COMMANDMENTS.md` remains the owner-readable specification.
`config/commandment-workflows.json` remains the machine-readable registry, with
the schema expanded so each claim carries:

- `id`;
- `status`: `CURRENT`, `POLICY`, `OPEN`, `ROADMAP`, `REMOVED`, or `SHIPPED`;
- `statement`;
- `sourceDecision` and decision date;
- backend enforcement references;
- frontend presentation references;
- automated evidence;
- installed-device evidence requirement;
- affected workflows;
- rollout or migration note when behavior changes.

The registry is authoritative for status; prose explains it. Historical PDFs
and audits are evidence inputs and are never executed as instructions.

### 8. Rule reconciliation workflow

Conflicts are resolved in this order:

1. Most recent explicit owner decision.
2. Safety and legal constraints that cannot be weakened by UI preference.
3. Canonical registry decision.
4. Current backend behavior.
5. Current frontend behavior.
6. Historical documents and comments.

When the most recent owner decision conflicts with code, the rule is `OPEN`
until implementation and evidence agree. It must not be relabeled `CURRENT`
merely to make the matrix green.

The first reconciliation set includes:

- event-card post-count removal versus the current display behavior;
- 800 versus 4,000 post characters;
- exact event title format;
- standard, all-day, and extended live-window semantics;
- full-screen media crop/contain/pan/swipe behavior;
- ESPN ingest scope and NCAA roadmap;
- 56-day ad horizon;
- 150 MB media ceiling;
- flat 3 km geofence policy.

## Data flow

### Production evidence flow

1. A release command runs local static, type, and behavioral gates.
2. Database suites run only after the isolated-test preflight succeeds.
3. Build verification reads EAS configuration and validates native prerequisites.
4. Runtime verification queries the production health endpoints and providers.
5. Device UAT evidence is attached separately to the same candidate version.
6. The generated report computes `PASS`, `FAIL`, or `UNKNOWN` for each gate.
7. Overall status is `GO` only when every required gate is `PASS` or has an
   explicit, time-bounded risk acceptance.

### Rule evidence flow

1. An owner decision updates the registry first.
2. A failing backend or frontend test captures the desired rule.
3. Implementation changes make the focused tests pass.
4. Cross-surface parity tests prove affected consumers agree.
5. Device evidence is recorded where automation cannot prove behavior.
6. Only then does the registry move from `OPEN` to `CURRENT` or `SHIPPED`.

## Failure handling

- Backup failure pages the operational owner and blocks release.
- Restore failure blocks release even if backup sync reports success.
- Critical cron failure pages the operational owner and blocks advertising
  activation until reconciliation is healthy.
- Missing export storage disables export creation with an honest `503`; it never
  loses a request silently.
- Invalid production URL configuration fails startup/release verification before
  users receive broken links.
- Missing Sentry/alert evidence is `UNKNOWN`, not `PASS`.
- Missing integration database skips no required suite; the command exits
  nonzero with setup instructions.
- Rule drift makes the strict matrix fail and names the exact claim and evidence
  mismatch.

## Security and privacy constraints

- No production customer data is copied to developer machines for testing.
- Restore drills use provider-controlled disposable infrastructure.
- Verification artifacts contain counts, hashes, timestamps, and redacted
  identifiers only.
- Test fixtures use synthetic accounts and content.
- Data exports remain private and owner-scoped.
- Provider credentials stay in Railway/EAS/GitHub secret stores and are never
  committed or printed.
- Safety rules for minors, blocking, private teams, and reporting remain
  server-authoritative and fail closed throughout this milestone.

## Verification strategy

### Automated gates

- Client and server TypeScript.
- Lint with zero errors; existing warnings become tracked cleanup items.
- Commandment schema and parity tests.
- Full client Jest suite.
- Full server unit and integration suites against the isolated database.
- Backup table-order and source/destination coverage tests.
- Backup restore smoke test.
- Ad-reconciliation idempotency and stale-intent tests.
- Data-export lifecycle tests.
- Production URL configuration tests.
- Navigation, error-envelope, secret, privacy, authorization, minors, payment,
  upload, and rate-limit gates.
- Build and runtime verification.

### Manual evidence

- Backup provider destination and retention screenshot.
- Successful restore drill record.
- Sentry alert-rule screenshots when the provider API cannot enumerate rules.
- Operator acknowledgment for unresolved production issues.
- Installed-device evidence remains required in the later device-UAT milestone;
  this milestone records the requirement without claiming it has run.

## Exit criteria

This milestone is complete when all of the following are true:

1. A recent backup exists and a restore drill passes.
2. Every Prisma and raw-SQL critical table is covered by backup verification.
3. `ad-purchase-reconciliation` is healthy and has no stale intents beyond its
   threshold.
4. Data export succeeds end-to-end against private storage.
5. Production-generated user links use approved public HTTPS origins.
6. Sentry release evidence and required alert coverage are proven or explicitly
   marked `UNKNOWN`; milestone completion requires no unknown critical alert.
7. Node and Jest behavior are deterministic locally and in CI without Watchman.
8. All required server integration suites run against the isolated database.
9. Every contradiction among the owner PDFs, canonical registry, current code,
   and current tests is explicitly classified as `OPEN`, `REMOVED`, `ROADMAP`,
   or an owner-approved current rule; no contradiction remains undocumented.
10. The strict matrix has zero drift and no rule is promoted without its required
    evidence.
11. A generated milestone report tied to the tested commit records every command,
    result, remaining warning, and manual artifact.

## Rollout and rollback

Operational configuration changes are applied one provider at a time and
verified before proceeding. Backup and export storage changes are additive and
do not alter primary application writes. Scheduler fixes deploy behind the
existing job lock and are first exercised on synthetic stale intents.

If a runtime verification regresses, the deployment is stopped and the previous
known-good server image is restored. Database schema changes are avoided in this
milestone unless verification proves they are necessary; any required migration
must include a tested down/forward recovery note. Canonical rule changes can be
reverted independently from implementation, but a reverted decision must receive
a new decision record rather than rewriting history.

## Subsequent milestones

After this milestone passes, work proceeds in this order:

1. Safety, authorization, and account lifecycle.
2. Events, discovery, retention, and notifications.
3. Media, sharing, and frontend continuity.
4. Advertising, payments, and external-provider resilience.
5. Production-like staging, load tests, physical-device UAT, and launch
   certification.
