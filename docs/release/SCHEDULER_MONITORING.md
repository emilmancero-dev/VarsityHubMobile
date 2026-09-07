# Scheduler monitoring

The BullMQ worker and node-cron fallback share `runMonitoredJob`. Production
Sentry check-ins use the job registry's cron expression and explicit UTC.
Check-ins pair `in_progress` with `ok` or `error`. Reporting exceptions cannot
change the business operation's result. A hung operation sends no completion;
Sentry's maximum runtime raises an incident without pretending to cancel work.

Default budgets: five-minute start margin, thirty-minute maximum runtime;
database backup sync allows 120 minutes. Tune these against actual durations.
These monitors prove execution and thrown-failure status. Reconciliation counts
and domain anomalies still require their existing Sentry error reports; a
completed reconciliation does not prove every business item was repaired.
The backup freshness probe rejects stale results explicitly.

Before deploying, provision every enabled job so a job that never starts is
detectable. Use production configuration and an authenticated Sentry token with
monitor-write access. The command is read-only unless `--provision` is supplied:

```sh
railway run --service api --environment production node server/node_modules/tsx/dist/cli.mjs server/scripts/verify-scheduler-monitors.ts --provision
railway run --service api --environment production node server/node_modules/tsx/dist/cli.mjs server/scripts/verify-scheduler-monitors.ts
```

Nonzero means missing configuration, an unhealthy monitor, or no successful
production check-in. Provisioning alone is not a successful execution. Daily
jobs need their actual scheduled run before full verification. Missing backup
configuration disables backup monitoring; rerun provisioning when changing it
so remote monitor state matches. Never send fake successful startup check-ins.

Verify actual alert destination receipt separately. An SDK check-in ID proves
queueing, not delivery. Independent GitHub hourly uptime checks remain necessary
because cron monitoring does not establish API availability or user journeys.

Rollback: redeploy the previous server artifact and disable these
`varsityhub-<job-name>` monitors in Sentry to avoid missed-run alerts from code
that no longer emits check-ins. There are no schema changes or new job retries.
