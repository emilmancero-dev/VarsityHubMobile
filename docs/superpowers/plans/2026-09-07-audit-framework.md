# Security & architecture audit workbench

Goal: integrate a developer-only audit workbench, versioned review framework, and evidence-based pull-request checks into VarsityHub.

Architecture: standalone React/TypeScript/Vite tool in tools/audit, outside the Expo app. One JSON checklist supplies 54 questions across eight topics and four rule types. Browser state is schema-validated and stored locally; manual reviewer attestations never represent automated proof. CI emits a separate report with explicit passed, failed, and needs-review outcomes.

1. Define versioned checklist and review/report contracts; write behavioral tests for exports, validation, stale storage, and merge conflicts.
2. Independently build checklist/docs and static CI runner with fixtures; integrate through stable JSON contracts.
3. Build responsive three-column reviewer UI, statuses, notes, persistence, filters, deep links, downloads, and printable layout.
4. Wire root commands and PR workflow with least-privilege reporting; generate sample evidence and one-page poster.
5. Run type checks, unit/fixture tests, production build, and browser acceptance checks. Record actual results and limits. Do not claim live production or monitoring verification from static checks.

State conflicts use per-entry update timestamps and deterministic tie-breaking. Different checklist versions are never silently reused. Failed items require notes before export. Storage failures retain in-memory work and show an actionable banner. CI imports are user-provided artifacts, never a live CI status assertion.
