# Local verification — 2026-09-07

These are captured results from the isolated `feat/audit-framework` checkout, based on `d0033fbc` with this audit-tool change applied. They are local evidence, not a deployed-app health report or a live GitHub Actions result.

- `unit-tests.txt`: 15 passed, zero failed. Runner fixtures include compliant/violating/missing inputs, unsupported dynamic validation, severity exit codes, CLI output, and browser-state merge/export rules.
- `browser-tests.txt`: 5 passed in Playwright using installed Chrome. Exercises 54 questions, filters, status/notes, JSON/Markdown downloads, reload persistence, deep links, keyboard, mobile overflow, cross-tab sync, denied storage, old versions and untrusted CI import handling.
- `build.txt`: TypeScript and Vite production build passed. Main assets total approximately 114 KB gzip, below 3 MB.
- `audit-report.json` / `audit-report.md`: actual repository source audit: 2 passed, 1 High failed, 3 needs-review. Exit 1 is expected because the existing direct-fetch architecture gate finds three calls. No existing application behavior was changed to suppress findings.
- `docs/AUDIT_COMMANDMENTS.pdf`: 1 page, 76,743 bytes when generated. Regenerate with `AUDIT_BROWSER_CHANNEL=chrome npm --prefix tools/audit run artifacts`, or omit the environment override after installing Playwright Chromium.

The browser workflow and tests are wired into `.github/workflows/audit.yml`; remote execution and branch-protection configuration have not occurred in this checkout. Security replay, admin-log coverage and payment ownership remain human/integration-test verification work.
