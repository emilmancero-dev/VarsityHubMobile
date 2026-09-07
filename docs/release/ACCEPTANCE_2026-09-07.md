# Production acceptance — September 7, 2026

## Backup

Railway API deployment `b0ed87da-e1d3-44c6-a3df-03015162fd5c` was online. Production API health returned `status: ok` at 16:30:07 UTC.

The initial isolated restore matched all 63 tables / 4,370 rows, then correctly failed schema parity: only `TransactionStatus` enum labels differed. The backup lacked the primary's newly added `RECEIVED` label.

Rehearsed `server/prisma/migrations/20260907000000_add_received_transaction_status/migration.sql` on a newly created database in a disposable PostgreSQL 17 instance with `varsity.restore_isolated=on`. Full object parity, migration startup, purchase recovery tests, write/unique/FK constraints and cleanup passed.

Applied only that additive enum change to Railway's `Postgres` backup after checking API primary/backup service identities, verifying the sole difference was the appended label, and rechecking schema metadata inside the transaction. The transaction locked TransactionLog and used a 5-second lock timeout. Full schema parity passed before and after commit. No primary schema mutation was performed. The larger September 6 repair was also rehearsed successfully on a disposable restore, but was not applied to the real backup because current drift did not require it.

Ran the existing atomic `syncDatabaseBackup`: passed, 63 tables / 4,397 rows including migration history. Final repair-free restore passed at 16:32:13 UTC: 63 tables / 4,397 rows matched; full schema parity, migration startup, purchase recovery and application constraints passed. The disposable target was cleaned up. The backup repair and local restore gate are complete.

Rollback: retain the additive enum value if application code rolls back; removing it would require rebuilding the enum and risks stored values. Startup backup schema mutations remain disabled. The repair was not added to automatic startup.

The initial GitHub HTTP 404 came from targeting the old upstream `xsantcastx/VarsityHubMobile`. The active workflow is in `emilmancero-dev/VarsityHubMobile`, with both restore URL secrets configured and a daily 07:23 UTC schedule. Its September 7 scheduled run failed before the repair with the same `TransactionStatus` enum mismatch (63 tables / 4,370 rows matched). Dispatched [run 34143971215](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34143971215) on main after the repair: **passed**. Downloaded its aggregate report: 63 tables / 4,397 rows, content matched, migration startup, purchase recovery and application constraints passed, cleanup complete at 16:36:49 UTC. Daily scheduling is active; this successful verification was manually dispatched, and the next cron-triggered result has not yet occurred. No workflow code change was required.

## Sentry

A clearly labeled synthetic operator-workstation event exercised the existing production new-error alert configuration; no customer operation was failed to create it. Event `7ab07884c72d48f39ce811a452763383` was retrieved through the Sentry API, HTTP 200, received at 16:28:16.436123 UTC. [Test issue](https://lime-productions.sentry.io/issues/7717475025/).

Diagnostic: `vh-alert-acceptance-2026-09-07T16:28:16.300Z`. Recipient inbox receipt remains pending. This proves ingestion of the routing test, not deployed exception-path telemetry or successful email delivery. No existing issue was resolved or suppressed.

## Native acceptance

Paired iPhone 14 Pro reports VarsityHub 1.0.5 build 59 installed. Requested a physical-device journey: cold launch, authentication, feed, map filter/pan/leave/reopen, media, background/resume, with timestamps and pass/fail evidence. Initial operator launch failed because iOS reported the device locked. After the owner unlocked it, `devicectl` successfully launched the installed app at 16:36:39 UTC. Awaiting journey result; successful launch alone is not acceptance. A subsequent process listing confirmed VarsityHub remained running (PID 25876).

Read-only Sentry review: map issue VARSITYHUB-3T latest occurrence 2026-09-06 06:41:24 UTC, build 56, native nil-child insertion stack in AIRMap. Startup issue VARSITYHUB-49 latest occurrence 2026-09-06 15:40:49 UTC, build 56, JSI WeakObject/Pointer destruction stack. Neither historical stack nor a quiet interval proves build 59 fixed.

## Provider acceptance

No MiLB/MLS/Sportradar/SportsData provider credential keys appeared in the production configuration name check. Current adapter resolution supports ESPN and explicitly normalized JSON; a newly licensed provider still needs integration and validation. Credentials alone cannot be treated as activation.

The catalog identifies MLS NEXT Pro (`mls_next_pro`); confirm whether the request instead means MLS NEXT youth competition before buying coverage. Obtain provider/account owner, exact MiLB levels and soccer competition, licensed display/use scope, current schedule sample, stable fixture/team identifiers, reschedule/cancellation semantics, venue coverage, refresh limits and activation date. Store credentials through the normal secret-management channel, not in this report.

Provider activation requires tested ingestion and real event discovery results. Unsupported feeds remain unavailable. No provider was contacted and no contract was purchased in this pass.

## Evidence

Aggregate reports: [acceptance evidence](evidence/2026-09-07-acceptance/). No customer rows, archives, credentials or raw event breadcrumbs retained in these files. The initial operational pass changed no product source. During device acceptance, the owner requested a three-day default Live map window to reduce crowding. Implemented server-side through the shared discovery policy; feed and explicit calendar browsing retain their 14-day horizon. Client and server typechecks passed; all 22 focused discovery tests passed, with the pagination suite rerun after adding explicit calendar boundary coverage. This map change is local and not yet deployed; its device acceptance remains pending publication.
