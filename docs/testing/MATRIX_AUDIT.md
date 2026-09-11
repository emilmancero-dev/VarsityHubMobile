# Matrix audit

The matrix combines a source inventory, explicit coverage records, an API integration matrix, and selected client/security regression suites. A passing suite does not certify every discovered feature.

## Run

- `npm run audit:matrix`: run the inventory, navigation audit, client component suites, server access/security suites, both typechecks, error-envelope and secret checks. Continue after failures and retain individual logs. Exit nonzero for any failed check **or open coverage gap**.
- `npm run audit:matrix:inventory`: fail on unmapped/stale source entries or invalid evidence. Existing documented gaps remain visible, but do not fail this CI drift gate.
- `npm run audit:matrix:strict`: fail on any coverage gap, including documented gaps.
- `node scripts/audit-matrix.cjs --refresh`: register new discoveries as **missing**. Never promotes coverage or removes stale records. Review changes before committing.

Artifacts live in `artifacts/matrix-audit/`: `inventory.md`, `inventory.json`, `execution.json`, and individual command logs. These are generated and ignored by Git. Commands run against the configured test environment; check that the database is local/disposable before running integration tests. Never aim this at production.

## Source inventory and limitations

`config/matrix-coverage.json` accounts for discovered source entries. Discovery uses the TypeScript parser to inventory default-export app screen candidates/layouts, screen registrations, navigation calls/links, interactive JSX callbacks, API calls through imported entities, Express route registrations, and mounts. IDs include normalized expressions, so changed actions require renewed review. New untracked source files are included unless ignored by Git.

These are **source surfaces**, not distinct user features. Aliases, shared components, redirects, nested mounts, dynamic menu arrays and indirect handlers need manual tracing. A screen candidate can be a helper rather than a live Expo route. Discovery does not prove production middleware parity or resolve all dynamic code. Use route-integrity tests and review root/tab layouts and deep-link allowlists alongside it.

No automatic inference from a filename or test count can mark a feature covered. Baseline missing entries mean **not yet mapped and verified by this audit**, not necessarily no tests anywhere in the repository.

For each reviewed entry, record:

- Feature/entry point and applicable endpoint(s), including mount prefix.
- Applicable dimensions: authentication, verification, onboarding, role, ownership/membership, subscription, approval state, privacy, blocking, age, platform.
- `status`: `missing`, `partial`, `covered`, or `excluded`.
- `reason` for partial/missing/excluded entries; exclusions need a concrete source-backed rationale.
- `evidence`: existing test file paths, `cases`: named test cases, and `dimensions` for covered entries. References establish traceability; `execution.json` separately establishes what actually ran.

## Initial feature/workflow map

| Entry point            | Actions to trace                                                    | Current evidence / outstanding work                                                                                                     |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Feed tab               | Load, paginate, refresh, post viewer, bookmark/upvote, report/block | Feed component smoke + API matrix; complete device journey and four states remain open                                                  |
| Highlights tab         | Browse, play, open game/post, interact                              | Highlights component smoke; playback/device and all controls remain open                                                                |
| Create center tab      | Role-dependent create menu, posts, events, teams, uploads           | API create probes; complete menu, picker, upload and failure-recovery journeys remain open                                              |
| Discover tab           | Search, date/sport/league filters, map/list, open result            | Search/game API probes; UI filter/map journeys remain open                                                                              |
| Profile tab            | Load/edit, followers, posts, settings                               | Profile component smoke + API probes; full settings and account lifecycle remain open                                                   |
| Coach tools            | Team management, roster, invites, approvals, organization, program  | Team/admin/org/program component suites; role-tier, owner/non-owner and plan suites; per-control mapping remains open                   |
| Messages/notifications | List/thread, unread, read, group chat, deep-link tap                | Message components + reachability probes; conversation membership, age/block and notification journeys need explicit per-action mapping |
| Payments/ads/admin     | Purchase, restore, ads, moderation, admin tools                     | Selected webhook signature/plan suites only; full platform-specific workflows remain open                                               |

## Threat model and assertion requirements

Review auth bypass, privilege escalation, payment spoofing, IDOR, webhook replay, stale-cache abuse and deep-link injection before closing coverage. Judge actual findings by exploitability, blast radius and recoverability; attach request/response or test proof and expected behavior. A missing test is a coverage gap, not proof of an exploitable product bug.

Keep dimensions independent: an unrelated veteran denied access to a rookie's team is an ownership check, not a subscription check. Test owner and non-owner of the same role, restricted staff tiers, anonymous/unverified/unonboarded users, and relevant privacy/age/block cases. Reuse the server's canonical rules; do not weaken guards to make tests pass.

Successful writes require exact status, IDs and persisted state. Denials require exact status, a useful error and unchanged data. Reads need both inclusion and exclusion assertions. Fixture creation must fail loudly. A 400/409 establishes an invalid request/conflict, not granted access. Every collected flag must fail the matrix. The game-create probe checks both Game approval and linked Event status; coach-tool probes explicitly require outsider denial.

## UI completion criteria

For every live tab and tool, exercise the actual entry point, allowed/disallowed user variants, correct API/action result, back navigation, and valid/invalid deep links. Async screens must demonstrate loading, error/retry, empty, and success. Test permission-denied, offline/upload failure, and reduced access where applicable. Component smoke tests provide partial evidence; they do not replace installed iOS/Android journeys, gestures, media playback or store purchase/restore tests.

The initial automated pass does not launch a device or claim these journeys are complete. Report them as unverified until executable journey evidence exists and runs successfully.
