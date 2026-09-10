# VarsityHub security & architecture audit

Human review attestations — automated checks are reported separately.

Checklist: 1.0.0 · Exported: 2026-09-07T19:26:48.989Z

Passed: 0/54 · Failed: 0 · In progress: 0 · Unchecked: 54

## password-hashing — Are passwords protected by adaptive hashing?

**UNRESOLVED: unchecked** · Critical · auth · Engineering Standards

Verification: Inspect every bcrypt.hash call in registration, reset, change-password and OAuth bootstrap; test correct and incorrect passwords.

Affected files: server/src/routes/auth.ts

Reviewer: Not recorded

Notes: No evidence recorded

## session-lifecycle — Are token expiry, rotation and revocation enforced?

**UNRESOLVED: unchecked** · Critical · auth · Release Gates

Verification: Run npm --prefix server run test:invariants; exercise expired, revoked and replayed refresh credentials.

Affected files: server/src/lib/jwt.ts, server/src/middleware/auth.ts, apiclient/auth.ts

Reviewer: Not recorded

Notes: No evidence recorded

## login-rate-limit — Are login and recovery attempts rate-limited across replicas?

**UNRESOLVED: unchecked** · High · auth · Audit Steps

Verification: Send repeated invalid logins and resets against two replicas; record rejection thresholds and Redis outage behavior.

Affected files: server/src/middleware/rateLimiters.ts, server/src/lib/redisRateLimit.ts, server/src/routes/auth.ts

Reviewer: Not recorded

Notes: No evidence recorded

## auth-bypass — Does every protected operation deny unauthenticated requests?

**UNRESOLVED: unchecked** · Critical · auth · Release Gates

Verification: Run middleware-coverage and requireOnboarded-bypass server tests; call changed routes with missing and malformed credentials.

Affected files: server/src/middleware/auth.ts, server/src/middleware/requireAuth.ts, server/src/routes/\*\*

Reviewer: Not recorded

Notes: No evidence recorded

## privilege-escalation — Are role, ownership and plan checks enforced by the server?

**UNRESOLVED: unchecked** · Critical · auth · Business Rules

Verification: Attempt each changed privileged action as fan, unrelated coach and non-owner; assert denial and no write.

Affected files: server/src/middleware/requireAdmin.ts, server/src/middleware/subscription.ts, server/src/routes/organizations.ts, server/src/routes/teams.ts

Reviewer: Not recorded

Notes: No evidence recorded

## sensitive-reauth — Do sensitive operations require appropriate reauthentication?

**UNRESOLVED: unchecked** · High · auth · Audit Steps

Verification: Exercise stale sessions on sensitive actions; attach evidence of reauthentication or an explicit reviewed gap.

Affected files: server/src/routes/auth.ts, server/src/routes/admin.ts

Reviewer: Not recorded

Notes: No evidence recorded

## oauth-linking — Is third-party identity verified before account linking?

**UNRESOLVED: unchecked** · Critical · auth · Business Rules

Verification: Run npm --prefix server run test:invariants and negative tests for wrong audience, issuer and existing linked accounts.

Affected files: server/src/lib/oauthVerification.ts, server/src/lib/oauthAccountLinking.ts

Reviewer: Not recorded

Notes: No evidence recorded

## validation-drift — Do frontend and backend validation contracts agree?

**UNRESOLVED: unchecked** · High · validation · Engineering Standards

Verification: Compare apiclient schemas and changed forms against server schemas; run validation-consistency and validation-parity tests.

Affected files: apiclient/schemas/**, server/src/routes/**, **tests**/validation-consistency.test.ts, server/src/**tests**/validation-parity.test.ts

Reviewer: Not recorded

Notes: No evidence recorded

## server-inputs — Are all external inputs validated server-side?

**UNRESOLVED: unchecked** · High · validation · Release Gates

Verification: Submit missing, wrong-type, oversized and unknown fields to changed endpoints; assert safe rejection.

Affected files: server/src/middleware/validateParams.ts, server/src/routes/\*\*

Reviewer: Not recorded

Notes: No evidence recorded

## critical-state — Can only trusted server logic set critical state?

**UNRESOLVED: unchecked** · Critical · validation · Business Rules

Verification: Submit protected fields through create, update and onboarding routes; compare persisted state before and after.

Affected files: server/src/routes/users.ts, server/src/routes/ads.ts, server/src/routes/payments.ts, server/src/routes/organizations.ts

Reviewer: Not recorded

Notes: No evidence recorded

## injection — Are database and command operations injection-safe?

**UNRESOLVED: unchecked** · Critical · validation · Audit Steps

Verification: Review raw SQL and subprocess call sites; probe attacker-controlled strings and identifier allowlists.

Affected files: server/src/routes/**, server/src/lib/**, server/prisma/schema.prisma

Reviewer: Not recorded

Notes: No evidence recorded

## output-encoding — Is untrusted content safely rendered?

**UNRESOLVED: unchecked** · High · validation · Engineering Standards

Verification: Insert HTML payloads in rendered fields; inspect public route responses and production CSP without executing untrusted scripts.

Affected files: server/src/routes/shareLanding.ts, server/src/routes/publicSite.ts, server/src/routes/og.ts

Reviewer: Not recorded

Notes: No evidence recorded

## upload-validation — Are uploads checked before they become accessible?

**UNRESOLVED: unchecked** · High · validation · Business Rules

Verification: Upload disallowed, oversized and mismatched-content fixtures; confirm denial and inaccessible rejected objects.

Affected files: server/src/routes/uploads.ts, apiclient/upload.ts

Reviewer: Not recorded

Notes: No evidence recorded

## payload-limits — Are request size and collection limits bounded?

**UNRESOLVED: unchecked** · High · validation · Engineering Standards

Verification: Inspect server parser limits and submit oversized JSON, uploads and pagination values; record safe failures.

Affected files: server/src/index.ts, server/src/routes/\*\*

Reviewer: Not recorded

Notes: No evidence recorded

## minor-privacy — Do privacy, blocking and minor-safety rules fail closed?

**UNRESOLVED: unchecked** · Critical · validation · Business Rules

Verification: Exercise adult/minor, blocked-user and private-team combinations; verify denied messages and no hidden data in responses.

Affected files: server/src/lib/userAge.ts, server/src/lib/privacyUtils.ts, server/src/routes/messages.ts, server/src/routes/follows.ts

Reviewer: Not recorded

Notes: No evidence recorded

## secret-exposure — Are secrets absent from client bundles and logs?

**UNRESOLVED: unchecked** · Critical · crypto · Release Gates

Verification: Run the secret-scan workflow; inspect production bundle/config and redacted logs using synthetic secrets.

Affected files: .github/workflows/secret-scan.yml, app.config.js, server/src/lib/logRedaction.ts

Reviewer: Not recorded

Notes: No evidence recorded

## secret-rotation — Are keys and credentials rotated with an owner?

**UNRESOLVED: unchecked** · High · crypto · Audit Steps

Verification: Attach redacted rotation records, owner and next due date; exercise old-key rejection in a safe environment.

Affected files: server/src/lib/jwt.ts, docs/PRE_RELEASE_CONFIG_VERIFICATION.md

Reviewer: Not recorded

Notes: No evidence recorded

## transport-security — Is transport encrypted across every trust boundary?

**UNRESOLVED: unchecked** · High · crypto · Release Gates

Verification: Inspect deployed redirects, TLS and connection settings; confirm cleartext requests cannot transmit credentials.

Affected files: apiclient/http.ts, server/src/index.ts, server/src/lib/prisma.ts

Reviewer: Not recorded

Notes: No evidence recorded

## at-rest — Is sensitive persisted data encrypted and access-restricted?

**UNRESOLVED: unchecked** · High · crypto · Audit Steps

Verification: Attach redacted provider encryption settings and access review; verify backup encryption configuration.

Affected files: server/prisma/schema.prisma, docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## secure-token-storage — Are session credentials stored safely on each platform?

**UNRESOLVED: unchecked** · High · crypto · Engineering Standards

Verification: Inspect native and web branches in auth storage and test storage failure and reinstall recovery.

Affected files: apiclient/auth.ts, apiclient/http.ts, apiclient/**tests**/auth-storage-recovery.test.ts

Reviewer: Not recorded

Notes: No evidence recorded

## signed-callbacks — Are provider signatures verified before effects?

**UNRESOLVED: unchecked** · Critical · crypto · Release Gates

Verification: Submit missing, invalid and wrong-provider signatures; verify zero writes and inspect raw-body handling.

Affected files: server/src/routes/payments.ts, server/src/routes/sendgrid-webhook.ts, server/src/services/payments/googlePlayVerifier.ts

Reviewer: Not recorded

Notes: No evidence recorded

## cors — Is cross-origin access limited to intended clients?

**UNRESOLVED: unchecked** · High · api · Engineering Standards

Verification: Test allowed and untrusted Origin headers, including preflight and credentialed requests.

Affected files: server/src/index.ts

Reviewer: Not recorded

Notes: No evidence recorded

## idor — Does resource access check actor-to-object authorization?

**UNRESOLVED: unchecked** · Critical · api · Release Gates

Verification: Swap resource IDs between two unrelated accounts for read, write, delete and export; assert denied access.

Affected files: server/src/routes/users.ts, server/src/routes/messages.ts, server/src/routes/dataExport.ts, server/src/routes/teams.ts

Reviewer: Not recorded

Notes: No evidence recorded

## webhook-replay — Are retries and webhook replays duplicate-safe?

**UNRESOLVED: unchecked** · Critical · api · Release Gates

Verification: Run npm --prefix server run test:payments:confidence; replay the same event concurrently and assert one entitlement/write.

Affected files: server/src/routes/payments.ts, server/prisma/schema.prisma

Reviewer: Not recorded

Notes: No evidence recorded

## payment-spoofing — Is paid state confirmed independently by the server?

**UNRESOLVED: unchecked** · Critical · api · Business Rules

Verification: Forge success/deep-link parameters and receipt payloads; verify no paid state until provider verification succeeds.

Affected files: server/src/routes/payments.ts, server/src/services/payments/googlePlayVerifier.ts, utils/stripe.tsx

Reviewer: Not recorded

Notes: No evidence recorded

## safe-errors — Are error responses sanitized and actionable?

**UNRESOLVED: unchecked** · Medium · api · Engineering Standards

Verification: Trigger validation, authorization and server errors; inspect responses and correlated redacted logs.

Affected files: server/src/middleware/errorHandler.ts, apiclient/http.ts

Reviewer: Not recorded

Notes: No evidence recorded

## api-contract — Are API contract changes compatible with supported clients?

**UNRESOLVED: unchecked** · Medium · api · Engineering Standards

Verification: Compare changed schemas to previous supported clients and run contract fixtures; record compatibility window.

Affected files: apiclient/schemas/**, server/src/routes/**

Reviewer: Not recorded

Notes: No evidence recorded

## thin-routes — Do routes delegate shared policy and networking?

**UNRESOLVED: unchecked** · Medium · api · Engineering Standards

Verification: Review changed app wrappers and raw fetch calls; document approved transport exceptions with reasons.

Affected files: app/**, apiclient/http.ts, server/src/lib/**

Reviewer: Not recorded

Notes: No evidence recorded

## deep-link-abuse — Do deep links resolve safely with validated parameters?

**UNRESOLVED: unchecked** · High · frontend · Release Gates

Verification: Run deepLinks-navigation and route-integrity tests; open missing, malformed and unauthorized parameters.

Affected files: utils/deepLinks.ts, utils/publicRoutes.ts, app/\*\*, utils/**tests**/deepLinks-navigation.test.ts

Reviewer: Not recorded

Notes: No evidence recorded

## dependencies — Are dependency vulnerabilities reviewed before release?

**UNRESOLVED: unchecked** · High · frontend · Release Gates

Verification: Run npm audit in each package and inspect security workflow results; record unresolved advisories.

Affected files: package-lock.json, server/package-lock.json, .github/workflows/npm-audit.yml

Reviewer: Not recorded

Notes: No evidence recorded

## production-build — Are production bundles built and inspected?

**UNRESOLVED: unchecked** · Medium · frontend · Release Gates

Verification: Build the intended release target; inspect resulting config, minification and source-map access.

Affected files: package.json, app.config.js, eas.json

Reviewer: Not recorded

Notes: No evidence recorded

## async-ui — Do asynchronous screens show loading, empty, success and error states?

**UNRESOLVED: unchecked** · Medium · frontend · Engineering Standards

Verification: Exercise slow, failed and empty responses, double submissions and navigation during requests.

Affected files: app/**, components/**, apiclient/http.ts

Reviewer: Not recorded

Notes: No evidence recorded

## accessible-controls — Are critical controls usable with keyboard and assistive technology?

**UNRESOLVED: unchecked** · Medium · frontend · Engineering Standards

Verification: Use keyboard and screen reader on login, payments and audit flows; inspect focus and announced statuses.

Affected files: app/**, components/**, tools/audit/src/\*\*

Reviewer: Not recorded

Notes: No evidence recorded

## local-state — Is persisted client state limited and isolated by identity?

**UNRESOLVED: unchecked** · High · frontend · Engineering Standards

Verification: Switch accounts and corrupt or exhaust storage; verify reset, validation and a visible recovery path.

Affected files: apiclient/auth.ts, context/**, tools/audit/src/**

Reviewer: Not recorded

Notes: No evidence recorded

## ci-permissions — Does CI use least-privilege credentials and permissions?

**UNRESOLVED: unchecked** · High · infra · Release Gates

Verification: Review workflow triggers, permissions, pinned actions and fork behavior; attach the relevant run URL.

Affected files: .github/workflows/\*\*

Reviewer: Not recorded

Notes: No evidence recorded

## database-credentials — Are database credentials restricted and externally managed?

**UNRESOLVED: unchecked** · Critical · infra · Engineering Standards

Verification: Inspect redacted deployment bindings and database role grants; verify repository secret scan.

Affected files: server/src/lib/prisma.ts, server/prisma/schema.prisma, .github/workflows/secret-scan.yml

Reviewer: Not recorded

Notes: No evidence recorded

## network-controls — Are public and internal network surfaces restricted?

**UNRESOLVED: unchecked** · High · infra · Audit Steps

Verification: Attach firewall/edge policy evidence and test denied access to internal services from an external network.

Affected files: docs/PRE_RELEASE_CONFIG_VERIFICATION.md

Reviewer: Not recorded

Notes: No evidence recorded

## restore-tested — Can encrypted backups be restored successfully?

**UNRESOLVED: unchecked** · High · infra · Release Gates

Verification: Review a recent backup-restore-drill run and record restore duration, integrity checks and recovery objectives.

Affected files: .github/workflows/backup-restore-drill.yml, docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## deployment-config — Is deployment configuration versioned and reviewed?

**UNRESOLVED: unchecked** · Medium · infra · Engineering Standards

Verification: Compare deployed settings to versioned configuration; record any provider-only settings and owner.

Affected files: eas.json, .github/workflows/deploy-guard.yml, docs/PRE_RELEASE_CONFIG_VERIFICATION.md

Reviewer: Not recorded

Notes: No evidence recorded

## reversible-release — Are migrations and rollout changes reversible?

**UNRESOLVED: unchecked** · High · infra · Release Gates

Verification: Exercise migration and rollback in staging; attach migration status and a tested recovery procedure.

Affected files: server/prisma/migrations/\*\*, docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## replica-coordination — Is cross-replica coordination durable?

**UNRESOLVED: unchecked** · High · infra · Engineering Standards

Verification: Run concurrent operations on two replicas and simulate shared-store loss; assert no duplicate critical effects.

Affected files: server/src/lib/redisRateLimit.ts, server/src/lib/cache.ts, server/src/routes/payments.ts

Reviewer: Not recorded

Notes: No evidence recorded

## security-events — Are security-relevant failures observable?

**UNRESOLVED: unchecked** · High · observability · Engineering Standards

Verification: Trigger synthetic failures and find their timestamp, action and correlation ID in collected logs.

Affected files: server/src/middleware/auth.ts, server/src/middleware/logging.ts

Reviewer: Not recorded

Notes: No evidence recorded

## admin-audit — Do sensitive admin actions leave authoritative audit evidence?

**UNRESOLVED: unchecked** · High · observability · Release Gates

Verification: Trace each changed admin mutation and confirm a durable audit record for success and meaningful failure paths.

Affected files: server/src/routes/admin.ts, server/src/routes/adminReports.ts, server/prisma/schema.prisma

Reviewer: Not recorded

Notes: No evidence recorded

## pii-redaction — Are logs and error telemetry scrubbed of sensitive data?

**UNRESOLVED: unchecked** · High · observability · Release Gates

Verification: Send synthetic canary secrets through error paths and inspect logs and Sentry payloads for redaction.

Affected files: server/src/lib/logRedaction.ts, server/src/lib/sentry.ts, server/src/middleware/logging.ts

Reviewer: Not recorded

Notes: No evidence recorded

## actionable-alerts — Do anomaly alerts reach an accountable responder?

**UNRESOLVED: unchecked** · High · observability · Audit Steps

Verification: Trigger a safe test alert and record receipt, owner and linked response procedure.

Affected files: server/src/cron/\*\*, docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## incident-runbook — Is the incident response procedure executable?

**UNRESOLVED: unchecked** · Medium · observability · Release Gates

Verification: Run a tabletop auth or payment incident and document missing access, steps and follow-up owners.

Affected files: docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## log-retention — Is security-log retention defined and verified?

**UNRESOLVED: unchecked** · Medium · observability · Audit Steps

Verification: Attach configured retention evidence and an old-event retrieval test; record approved deviations explicitly.

Affected files: server/src/middleware/logging.ts, docs/BUSINESS_CONTINUITY.md

Reviewer: Not recorded

Notes: No evidence recorded

## proof-and-verification — Does every finding and pass have reproducible evidence?

**UNRESOLVED: unchecked** · High · observability · Release Gates

Verification: Attach commit, environment, command/test, result and timestamp for every passed item; require proof and notes for failures.

Affected files: templates/AUDIT_REPORT.md, tools/audit/src/features/audit/checklist.json

Reviewer: Not recorded

Notes: No evidence recorded

## query-monitoring — Are slow database operations measured?

**UNRESOLVED: unchecked** · Medium · performance · Audit Steps

Verification: Capture staging query timing and endpoint percentiles under representative load; compare to stated budgets.

Affected files: server/src/lib/prisma.ts, server/src/routes/feed.ts, server/src/routes/games.ts

Reviewer: Not recorded

Notes: No evidence recorded

## stale-cache — Do cache invalidations preserve privacy and current authority?

**UNRESOLVED: unchecked** · High · performance · Business Rules

Verification: Run games-cache-invalidation, users-follow-cache-invalidation and auth-me-cache-invalidation server tests; verify changed flows.

Affected files: server/src/lib/cache.ts, apiclient/auth.ts, server/src/**tests**/auth-me-cache-invalidation.test.ts

Reviewer: Not recorded

Notes: No evidence recorded

## asset-caching — Are asset caches efficient and privacy-safe?

**UNRESOLVED: unchecked** · Medium · performance · Engineering Standards

Verification: Inspect CDN and API Cache-Control behavior for public assets and authenticated content after logout.

Affected files: server/src/routes/uploads.ts, server/src/routes/og.ts, apiclient/http.ts

Reviewer: Not recorded

Notes: No evidence recorded

## lazy-loading — Are expensive screens and assets loaded on demand?

**UNRESOLVED: unchecked** · Low · performance · Engineering Standards

Verification: Profile a production build on a representative device and inspect eager imports on primary routes.

Affected files: app/**, components/**

Reviewer: Not recorded

Notes: No evidence recorded

## bundle-budget — Is delivered bundle size within an explicit budget?

**UNRESOLVED: unchecked** · Medium · performance · Release Gates

Verification: Build tools/audit and measure total delivered compressed assets; compare app build artifacts to recorded budgets.

Affected files: tools/audit/package.json, package.json, eas.json

Reviewer: Not recorded

Notes: No evidence recorded

## n-plus-one — Are list endpoints bounded and free of avoidable N+1 queries?

**UNRESOLVED: unchecked** · Medium · performance · Audit Steps

Verification: Measure query counts at page sizes 1, 10 and the maximum; verify indexed filters and pagination.

Affected files: server/src/routes/feed.ts, server/src/routes/games.ts, server/prisma/schema.prisma

Reviewer: Not recorded

Notes: No evidence recorded
