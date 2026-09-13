# Serious notes production release — 2026-09-10

Released at approximately 05:39 UTC with explicit user authorization.

- Server/source commit: `14c0385660ed47bf348437ed2e891b59f0015193`, pushed to `fork/release/serious-notes-20260910`.
- Railway production API deployment: `80d46012-5c2c-4b03-b5ef-2a6fe91d0aee`, SUCCESS. Deployed directly from the clean release tree; upstream `origin/main` was not overwritten.
- Previous server deployment: `ad737bb9-6cb9-4174-8958-b427f5e8cae5` (rollback reference).
- OTA 1.0.6, iOS + Android: `63340388-f4f5-4bbc-8fb4-5c9ac7e4b04d`, commit `14c03856`.
- OTA 1.0.5, iOS + Android: `04080ed3-4952-466f-8f38-02e699b00a45`, commit `077010808062ac53e9386a17b48b6273c11f4745`, pushed to `fork/release/serious-notes-runtime-105`.
- EAS channel `production` is unpaused and maps to branch `production`.

## Verification

Full local release gate, build readiness gate and production runtime gate passed. Targeted client suites passed for both runtimes (88 tests per tree); targeted server suites passed (42 tests). Client/server typechecks and commit/push hooks passed. Existing non-blocking lint/build warnings remain; no claim of warning-free status.

The running server's post/story route files, discovery library and search-ranking helper match the release tree SHA-256 hashes. Before deploy, schema and backup-related source hashes matched the running baseline. This release adds no migrations.

Live read-only smoke checks: health 200; 20 discovery cards carry boolean `has_posts`; the selected past date returned no empty pages (zero results, so positive content visibility is covered by the local database integration test); game and event name search each returned five time-ordered results; invalid discovery input returned a safe 400 response. Runtime email configuration checks passed; no test emails were sent.

Recent logs included slow-query warnings and an external geocoding fetch failure that skipped two NCAA fixtures without coordinates. Those observations do not establish complete schedule coverage. No physical-device UAT was performed.

The first parallel 1.0.5 export failed while clearing Metro's shared cache. Retried successfully with a dedicated temporary cache; only the successful export was published.

## Scope and recovery

Includes description-based permission-bypass removal, private-safe post flags and past map filtering, nearest-date search, map presentation, inline video fill, and direct event hrefs. The open minor-league provider, combat-label and special-account policy decisions remain open; this release does not implement them.

For a server regression, restore the previous Railway deployment. For an OTA regression, republish the previous compatible update group: 1.0.5 `c0b4c55b-33d6-4bea-9ff9-7d5f3ab17914`; 1.0.6 `4d610a2b-5ccf-4b4b-9803-5524330267d9`. Rollback would restore old behavior, including the fixed permission/discovery defects, so scope recovery to the affected component.

Installed apps need to download/apply their compatible update. Publication does not prove that a particular phone has applied it. No new native build or App Store submission was made for this release.
