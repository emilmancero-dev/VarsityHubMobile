# Scheduler monitoring acceptance — September 7, 2026

## Deployed and verified

- Runtime source: `e81aa7a6`; operator-script correction: `92d8fb61`.
- Railway production API deployment: `d2e13267-4f5e-4a14-ac5b-139ec6cde46e`, status `SUCCESS`, message `Deploy verified scheduler monitoring e81aa7a6`.
- At 17:25:23–24 UTC, `/health` returned HTTP 200 / `ok`; `/health/egress` returned HTTP 200 / 4 of 4 reachable.
- Deployment logs confirm all 20 scheduled jobs registered and the worker started.
- Sentry monitor `varsityhub-ad-purchase-reconciliation` is active. The deployed job's production check-in `19d75c16-1814-4c2a-8a29-f645354e9e9c` has status `ok`, dated 17:25:00 UTC. Its monitor environment is `ok`, next run 17:30 UTC, latest allowed start 17:35 UTC.
- A separate operator acceptance monitor received an SDK start check-in `802de430-2147-449e-9bd6-d10d6c483645`. Sentry subsequently classified it `timeout`, proving provider-side detection of an unfinished run. This test monitor is now disabled. No business job was deliberately stalled.
- The user confirmed receipt of the earlier Sentry test email. This proves that earlier alert's destination receipt; it is not evidence of a cron-specific email.
- GitHub's independent hourly Railway Health Check had three successful recent runs at 15:06, 16:07 and 17:06 UTC. Latest run: https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34146188732. Its source SHA differs from the CLI-deployed server; it proves external uptime probing, not deployed-source regression coverage.

## Checks run

- `npm run release:verify:local` exited 0.
- Client and server TypeScript checks passed after the monitoring edits.
- Four targeted suites / 29 tests passed: scheduler monitoring, failure propagation, backup failure propagation, fallback parity.
- `npm run release:verify:runtime` exited 0. Its public production health probe was live; email configuration checks use the command's local configuration and do not establish production inbox delivery.
- Commit and push hooks passed, including typechecks, bounded-query guard and navigation classification.

## Remaining blockers and limits

Sentry created the 20 job definitions disabled. Explicit activation succeeded for payment recovery. Activating another monitor returns HTTP 400:

> You don't have enough pay-as-you-go available to create a new seat

There is **one active business-job monitor and 19 disabled definitions**. Billing was not changed. Full missed-run coverage is not active. Enable sufficient Sentry capacity, rerun the documented provisioning command, then verify actual runs and cron-specific alert delivery. Daily jobs need their scheduled execution before being certified. A never-started run and recovery were not independently exercised against the provider in this session; the live acceptance proof covers timeout only.

PostHog's public ingestion key exists in production Railway configuration and local `.env`. No authenticated PostHog read credential or callable connector was available. Stored-event freshness, dashboards and journey alert delivery remain unverified. User expectation that configuration is correct does not substitute for an authenticated event query.

Read-only monitor verification must return nonzero while definitions are disabled or have no successful production check-in. Do not describe this rollout as fully green.
