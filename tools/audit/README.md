# VarsityHub audit workbench

A developer-only React/TypeScript/Vite tool. It is separate from the Expo consumer app and has no backend. Fifty-four questions span eight topics and four rule types. Counts in the original topic examples totalled 60; the final checklist follows the explicit 54-question acceptance criterion.

From repository root:

```sh
npm ci --prefix tools/audit
npm run audit:ui
# Open the printed local URL at /audit
npm run audit:test
npm --prefix tools/audit run build
npm run audit
```

`npm run audit` writes `/tmp/audit-report.json` and `/tmp/audit-report.md`, prints Markdown, and exits 1 for actual Critical/High failures. Missing/unsupported evidence is `needs-review`, never a pass. This runner is a limited source audit; it does not contact production, Sentry, PostHog, Railway, payment providers or a database. See [scope and verification](../../docs/AUDIT_FRAMEWORK.md). Current direct-fetch violations are intentionally reported rather than hidden by exceptions.

The browser's initial **Begin audit** starts a human review. Topic tabs, rule/severity filters and title/topic/file search narrow questions. Expand a question for instructions, status and evidence notes. The checkbox is a shortcut for reviewer-attested passed. Failed items require notes before JSON or Markdown export. Progress counts passed checks, not a security certification. Search spans all topics. Only the selected topic mounts by default (6–8 checks); All checks mounts all 54 small rows.

Reviewer names are stored on each edit, not authenticated. Local browser storage contains notes and timestamps: do not include secrets or personal data. Tabs merge individual entries by timestamp, with deterministic tie-breaking. Later edits to the same item win. A version mismatch preserves the previous stored state and offers a backup download before a fresh review. Storage failures keep the active review in memory with a banner; export before closing. Changes are local to this browser/origin, not shared with teammates.

Deep link example: `/audit?section=auth&item=password-hashing`. CI status defaults to unknown. Import a runner JSON artifact to inspect evidence; imported data is schema-checked but its origin is not authenticated. GitHub run links allow independent verification and no imported file is labelled as live CI status. Human review and automated reports stay separate.

[Typed Zod contracts](src/features/audit/types.ts) validate the [versioned source checklist](src/features/audit/checklist.json), storage and automated reports. [sample-report.json](public/sample-report.json) and [sample-report.md](public/sample-report.md) show a fresh, fully unresolved human review. [Report template](../../templates/AUDIT_REPORT.md) captures an actionable finding. [Commandments PDF](../../docs/AUDIT_COMMANDMENTS.pdf) is a one-page companion to the [full framework](../../docs/AUDIT_FRAMEWORK.md).

Browser acceptance checks:

```sh
cd tools/audit
npx playwright install chromium
npm run test:ui
```

The PR workflow runs unit tests, builds this tool, runs the source audit and uploads evidence even on failure. It comments only on same-repository PRs; fork PRs use artifacts/job summaries. No privileged `pull_request_target` execution. Making the workflow a required branch-protection check is a repository settings step after merging. Review the initial findings before adopting it as a release gate.

Local verification results are saved in [evidence](evidence/README.md). To use an installed Chrome for tests or PDF generation, set `AUDIT_BROWSER_CHANNEL=chrome`. `npm run artifacts` inside this directory regenerates the sample reports and PDF from current source. Additional CLI output paths passed through root `npm run audit` resolve from `tools/audit`; use absolute paths when needed.
