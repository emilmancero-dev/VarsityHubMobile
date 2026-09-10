# Acceptance with current Sentry capacity — September 7, 2026

The owner confirmed that additional Sentry capacity has not been enabled. No billing settings were changed.

## Monitoring

Authenticated readback at 17:43 UTC confirms one active business-job cron monitor, `varsityhub-ad-purchase-reconciliation`, with an `ok` production check-in at 17:40 UTC. Nineteen business-job definitions remain disabled. The separate timeout-acceptance monitor is disabled intentionally.

Configured and retrieved issue alert `17439009`, **Production scheduler job failures**, using the same member recipient as the existing production error rule. It matches production error events tagged `vh_context` with `scheduler_job_failed`, `scheduler_worker_failed`, or `scheduler_fallback_job_failed`. Conditions admit a new issue or more than zero occurrences in one hour; notification cooldown is 60 minutes. This uses ordinary issue alerts, with no added cron monitor seats. Configuration readback passed; delivery of this particular new rule has not been tested. The earlier general test email receipt is recorded in SCHEDULER_MONITORING_ACCEPTANCE_2026-09-07.md.

Current coverage: job failures that reach the existing exception pipeline, one payment-recovery missed-run monitor, and independent GitHub uptime and isolated backup-restore checks. Failure-event alerts cannot detect a job that never starts. No aggregate success heartbeat is used to claim all jobs are healthy.

## Build 59 native issue

Read-only Sentry query found VARSITYHUB-4G, event `cf2d92c9e045485a859181d5dc5fd4be`, dated 2026-09-07 03:37:58.704 UTC. Release `com.varsithub.varsityhub-ios@1.0.5+59`, OTA `9156dc10-027e-438f-bb3a-b83da9802df8`, production, physical iPhone15,2. Type: `WatchdogTermination`. App context says foreground.

The retrieved exception has no native frames. Device context reports total/usable device memory, not app peak memory. The diagnostic's suggestion of RAM overuse is not proof of memory exhaustion. No causal code change is justified from this event alone. A native termination report or measured reproduction remains necessary. The later owner report that the app works is useful journey feedback but does not resolve this earlier termination automatically.

## Sports decision

Owner clarification: use the same event-page process as pro sports; these are one-off event pages now, and some teams may be claimed later. Team claiming is not a prerequisite for creating these pages. Existing `server/scripts/one-off/create-one-off-events.ts` supports optional league metadata and teamless matchups; no new team-ownership system is needed.

The current catalog is MLS NEXT Pro (`mls_next_pro`); the owner's wording did not explicitly distinguish youth competition. Preserve the existing catalog interpretation until specified otherwise. No fixture dates or teams were invented or inserted.

ESPN core API catalogs were checked read-only: baseball reports 12 leagues and soccer reports 218. The checked catalog responses did not identify the requested MiLB/MLS NEXT schedule source. Search results alone are not feed activation evidence. Current adapter source restriction is ESPN/Yahoo; no third-party fallback was introduced. Obtaining verified fixtures from an approved source remains open. Do not label a commercial provider contract inherently required just to use the existing one-off event-page path.

No product source was edited in this pass. Concurrent scheduler shutdown changes in the workspace were left untouched.
