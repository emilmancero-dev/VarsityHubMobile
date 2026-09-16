# Isolated release staging — September 16, 2026

## Status

Database/cache infrastructure is running and verified. **The candidate API has not been deployed; no app migrations, fixtures, provider acceptance, or production release have run.** Infrastructure evidence is not a passed staging or launch gate.

The owner authorized isolated staging work after the hosting-cost question. Three new services were created inside Railway `testing` to preserve its unrelated old API branch, database, and unknown SMTP configuration. Two services run with persistent storage and incur hosting costs; the API has no deployment. Production services/configuration were not changed.

Application source remains `a3f60014ef240171b9ba2cd3d5a9fd05c3ed75e1`; this handoff adds no application/dependency changes. The owner explicitly chose **wait for an official node-forge fix**. No backport, security exception, or scanner bypass is authorized.

## Resource inventory

- Project: `22899614-5ae1-47e9-bdd6-7f6d5ce5619e` (`capable-trust`).
- Testing environment: `e74c16a8-5569-4285-b9d0-0d2d33ae92fd`.
- Production environment, excluded from mutations: `0d35cf4e-ac81-4a62-85a9-1bceee5096af`.

| New service        | Service ID                             | Evidence                                                                                         |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `release-postgres` | `3d6aee90-e61f-40a0-aa74-46d967749485` | Deployment `5847e2aa-722c-488c-8a7f-0b96c9aa7797` SUCCESS; PostgreSQL 17.11                      |
| `release-redis`    | `666da074-6aca-4935-96a2-514c520c1170` | Deployment `7a12a6bf-2fcd-4fc5-a175-7625745e66ed` SUCCESS; authenticated PONG and empty keyspace |
| `release-api`      | `a098b014-b72f-4971-9445-b2314198161f` | No repository source, deployment trigger, or deployment connected                                |

Postgres volume `c54b7f09-20d6-4e88-a947-182419ebefb0` mounts `/var/lib/postgresql/data`; Redis volume `1b0273de-d468-449a-83b4-c758063dccad` mounts `/data`. Both use one replica in `us-west2`. Images are pinned to exact digests observed on production, but all data and credentials are fresh.

Allocated API domain: `https://release-api-testing.up.railway.app`, port 4000. **An allocated domain is not a healthy application.** No staging web origin exists. The existing candidate Vercel preview calls production API and is not this staging environment.

## Observed verification

- Every new service has only a testing instance. Resolved API database/cache URLs match the new services and differ from production; JWT/health secrets are independent. Values were compared in memory, never exposed.
- Database `varsityhub_release_test` reports **0 public tables** after the final restart. TLS is active. A transaction created a temporary table, inserted/read one synthetic row, then rolled back. No permanent application data was created.
- The image-wrapper role mismatch was repaired by mapping `PGUSER`, `PGDATABASE`, and `PGPASSWORD` to corresponding `POSTGRES_*` variables. Final logs show successful collation checks without the earlier missing-role error. Automatic WAL recovery occurred before readiness; this is not backup/restore acceptance.
- Redis requires its fresh password, uses append-only persistence, returned `PONG`, and reported no keys. No public DB/cache TCP proxy exists. These checks do not prove cross-process locking or load capacity.
- API configuration omits production provider credentials, `DATABASE_BACKUP_URL`, and imported jobs/data. No production records were downloaded.
- Last observed production API remains `7c5a9d55-f4ea-473b-acb6-c34bf01af603`. The old testing services were preserved.

## Containment and missing configuration

The API has independent DB/cache/JWT/health settings, `NODE_ENV=production`, `VARSITYHUB_ENV_PATH=/dev/null`, `EMAIL_PROVIDER=test`, `EMAIL_ENABLE_QUEUE=false`, `PRO_SPORTS_BOOTSTRAP=0`, `PRO_SCHEDULE_ROLLING_ENABLED=0`, `ROLLING_APPLY=0`, `POST_PAGE_CURSOR_V2_WRITE_ENABLED=false`, and `UPLOADS_PUBLIC=0`. Optional provider/schedule keys are omitted. API public URL fields use its allocated domain. The existing `APPLE_BUNDLE_ID` is configuration, not IAP evidence.

Repository-root context, `server/Dockerfile`, `/health`, port 4000 and one replica are configured. Actual build execution remains unverified: Railway rejected the legacy config-file setting as deprecated in favor of Infrastructure as Code. No broad configuration migration or API deployment was attempted.

Before connecting source/deploying, configure **Railway → testing → release-api** with:

1. A separate Cloudinary test cloud and valid credentials. Startup uploads a probe; production-mode folder naming alone does not isolate production assets.
2. Separate SendGrid test configuration and valid required template IDs. Read the current `TEMPLATE_IDS` and `REQUIRED_TEMPLATE_KEYS` in `server/src/lib/email.ts`, not a copied catalog. Keep `EMAIL_PROVIDER=test` for initial no-send smoke; it does not prove delivery. `EMAIL_OVERRIDE_TO` does not contain production-mode mail.
3. A separate Stripe test-endpoint webhook secret, required at boot. Full payment acceptance additionally needs test-mode keys/prices and genuine sandbox transactions. Omit optional payment keys for narrower auth/feed smoke.
4. Exact staging web `APP_BASE_URL`, `WEB_URL`, and `ALLOWED_ORIGINS` once that origin exists. No production write destinations or wildcard origins. The current server adds `ALLOWED_ORIGINS` to built-in production origins; it is not a staging-only allowlist or an access barrier. Isolation depends on separate resources, independent credentials and normal server authorization.

Enter secrets directly in Railway, never in chat or Git. Do not substitute fake credentials, `NODE_ENV=test`, age/admin bypasses, or disabled rate limits for valid setup.

## Continuation checklist

- [ ] Recheck resolved isolation before migrations/fixtures. Never run destructive suites on standing staging or import production records.
- [ ] Connect the reviewed maintained-repository candidate, verify the Docker build path, and record SHA/deployment ID. Preserve the old testing branch.
- [ ] Verify migrations and required raw SQL tables explicitly. Startup continues after migration failure; its placeholder returns HTTP 200 with `status:starting`. Require final app `status:ok` and schema evidence.
- [ ] Use synthetic users with notifications disabled, no push tokens/receipt IDs, and no imported purchases. There is no global scheduler/push kill switch; preserve normal safety gates.
- [ ] Run auth lifecycle, privacy/age/block checks, pagination and isolated Redis cross-process locking. Unauthenticated errors do not prove protected features work.
- [ ] Verify provider delivery, media/moderation, sandbox purchases, restore/load/rollback, monitoring and canonical signoffs separately. Missing integrations remain unverified.
- [ ] Before device writes, verify the installed bundle's resolved API URL and provider configuration target only isolated test resources. `app.config.js`/`config/env.ts` default to production; the existing `eas.json` staging profile omits an explicit API URL and shares telemetry/OAuth settings. A profile name is not isolation. Use a reviewed isolated test delivery/channel, never production OTA for staging tests; keep production installations intact.
- [ ] Capture installed-device acceptance for runtimes 1.0.5 and 1.0.6 through the approved test delivery path; none has passed yet.
- [ ] Wait for the official node-forge release, install/retest the supported fix, and require fresh candidate CI before production.

No production API/web promotion, EAS OTA publication, native submission or main merge occurred. Follow the [production plan](../superpowers/plans/2026-09-16-production-completion.md) and [release workflow](RELEASE_WORKFLOW.md) for rollout and rollback.
