# Matrix audit pass — 2026-09-11

**Result: executed checks passed; coverage remains incomplete.** No product deployment or device journey was performed.

## Evidence

- Access matrix: **77/77** after tightening fixture, owner/non-owner, pending-game persistence, anonymous, verification, onboarding and HTTP classification assertions.
- Eight additional server suites: **157/157**, covering selected role barriers, role tiers, plan limits, privacy surfaces, minor protection, self-approval, game approval parity and webhook signatures. Exact files are in `config/matrix-suites.json`.
- Eleven client suites: **24/24** component/navigation tests. React `act` warnings occurred; these tests do not prove complete device workflows.
- Inventory scanner: **3/3** tests.
- Client and server TypeScript checks: both exit 0.
- Navigation fail gate, error-envelope check, secret check, conflict scan, diff whitespace check and formatting check: passed.
- Inventory drift/evidence gate: passed. Strict coverage gate and aggregate audit: exit 1 because coverage is incomplete.

The aggregate run completed all configured checks. A subsequent targeted access-matrix rerun added classification assertions and passed 77 tests; the final execution artifact records that rerun separately.

## Findings

1. **Audit defect corrected:** missing fixture guards silently passed without requests. Fixtures now assert creation and required IDs.
2. **Audit defect corrected:** 400/409 responses were reported as granted. They now report invalid request/conflict.
3. **Audit defect corrected:** pending-game creation only checked for crashes. It now requires 201 and checks Game approval plus linked Event approval/status in the database.
4. **Audit defect corrected:** coach roster/admin/search tools omitted outsider denial assertions. Fan and unrelated veteran must receive 403.
5. **Stale claim corrected:** search was labeled auth-required. `server/src/routes/search.ts` explicitly supports optional auth; the public-search test now checks 200 and result-group arrays.
6. **Open coverage gap:** no full installed-app journeys were run. Partial smoke evidence cannot close all states, actions or role variants.

## Inventory baseline

| Source surface                | Count |
| ----------------------------- | ----: |
| Screen candidates             |   176 |
| Layouts                       |     4 |
| Screen registrations          |    22 |
| UI callbacks/actions          | 1,233 |
| Navigation calls/links        |   353 |
| Client API calls              |   443 |
| Server endpoint registrations |   353 |
| Server mount registrations    |    79 |
| Total                         | 2,663 |

55 endpoint entries and 9 screen entries have partial test mappings. The other 2,599 entries await evidence mapping. None are certified fully covered. These counts include aliases, shared controls and indirect/dynamic source expressions; they are not distinct feature counts or bug counts. Existing tests elsewhere may cover missing entries, but that evidence has not yet been reconciled.

Use `npm run audit:matrix` to reproduce the pass. Full generated inventories, exact commands and logs are in `artifacts/matrix-audit/`. Review `docs/testing/MATRIX_AUDIT.md` for completion criteria and limitations.
