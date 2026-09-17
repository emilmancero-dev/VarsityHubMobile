# Matrix continuity audit rerun

Test target: working tree based on `0c9f851f`, including the three pre-existing media-picker edits. Audit started September 15, 2026, America/New_York; generated machine timestamps use UTC. This is an audit result, not a repaired or deployed release.

## Readiness result

**NO-GO / incomplete.** The canonical matrix runner finished with 17 passing gates and one failed gate: strict workflow readiness. `FLOW-AD-PURCHASE` is blocked because the installed-app purchase journey has not been recorded. Automated pricing/signature checks do not prove purchase, verification, activation, and device behavior end to end.

Inventory drift is zero. There are 2,684 surfaces with missing/partial coverage classifications. This is an evidence backlog, not 2,684 proven bugs. The registry labels six of seven workflows verified; those labels and source-test references must not be interpreted as complete runtime certification.

## Fresh verification

| Check                                               | Result                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Canonical client matrix                             | 11 suites, 24 tests passed                                                     |
| Full frontend suite                                 | 223 suites passed, one failed; 1,619 tests passed, two failed; 178.293 seconds |
| Backend access matrix                               | 77 passed                                                                      |
| Backend role-barrier authorization                  | 8 passed                                                                       |
| Backend role-tier enforcement                       | 45 passed                                                                      |
| Backend plan limits                                 | 70 passed                                                                      |
| Backend privacy surfaces                            | 14 passed                                                                      |
| Backend minors foundation                           | 7 passed                                                                       |
| Backend self-approval protections                   | 6 passed                                                                       |
| Backend game-write approval parity                  | 4 passed                                                                       |
| Backend Stripe signature checks                     | 3 passed                                                                       |
| Additional profile event-history tests              | 1 passed                                                                       |
| Additional unposted-event retention tests           | 5 passed                                                                       |
| Additional posting reminders                        | 3 passed                                                                       |
| Additional upload-signing limits                    | 6 passed                                                                       |
| Additional IAP/pricing configuration invariants     | 13 passed                                                                      |
| Additional feed-bundle API tests                    | 5 passed                                                                       |
| Commandment source/document parity                  | 29 passed                                                                      |
| Client TypeScript                                   | Passed                                                                         |
| Server TypeScript                                   | Passed                                                                         |
| Navigation, error-envelope, secret, conflict checks | Passed                                                                         |
| Matrix inventory tests                              | Passed                                                                         |
| Additional audit-runner/document guard tests        | 5 passed                                                                       |
| Installed-device journeys                           | Not run                                                                        |

Backend matrix total: **234 tests passed across nine suites**. Additional server evidence: **62 tests passed across seven suites**. These include a mix of source assertions, mocked unit tests, and database-backed API tests; not all are end-to-end integrations. Frontend matrix tests are a subset of the full frontend run, not extra unique coverage.

Database-backed checks used a new isolated PostgreSQL 17 database at localhost port 55439 with synthetic accounts. All 155 repository migrations applied successfully. Tests ran under Node 20.19.6 with environment-file loading disabled for the test processes. The Prisma migration CLI reported loading its `.env`, but its database target was explicitly overridden and verified as the disposable local database. Production databases were not targeted. The temporary server was stopped after the backend checks; its synthetic data remains in `/private/tmp/varsityhub-matrix-db.G7bnKt` for recoverability.

## Defects and drift remain open

The two full-frontend failures are in [the historical live-window tests](/Users/varsityhub/Code/VarsityHubMobile/__tests__/live-window.test.ts:65): one expects unlimited early posting, and the other expects a three-hour fallback. Current helpers and canonical source-parity checks use a two-hour opening window and six hours after start. Classify these failures as stale expectation/rule reconciliation, not proof that those current boundaries are broken. Update the assertions only after confirming the governing decision; do not weaken production gates to satisfy old tests.

The read-only reproduction harness was rerun and again demonstrated:

1. Two feed loads a millisecond apart create two query-cache entries and two fetches despite a 30-second stale time. This affects loads that execute, such as remounts; the screen's separate silent-load cooldown still exists.
2. A seven-post pagination fixture returns posts 1, 2, 4, 5, 7, dropping posts 3 and 6.
3. Three feed consumers perform 12 viewer-specific privacy lookups with warm global caches, versus four lookups if that request shares the results under the same fixture.
4. An event is LIVE in the feed but `active` in details under the same time/bounds. Product-label intent must be resolved before changing the two clocks.
5. A 3 MB JPEG invokes two preparation encodes through composer and uploader.
6. A 3 MB GIF invokes JPEG conversion while retaining GIF MIME metadata.
7. Failed Discover post and people requests resolve to a successful empty result after three post-method calls and one suggestions call.

These are isolated executions of current source with synthetic dependencies, not measured production response times. Passing matrix suites do not close these findings: the suites do not cover the failing combinations.

## Why loading and media can be slow

Confirmed unnecessary work includes duplicate image encoding, unstable feed query keys, duplicate suggestions requests, optional personalization blocking Discover's main skeleton, whole-bundle recomputation for single-section pagination, and repeated viewer privacy work. Feed activity polling is also mount-scoped rather than focus-scoped.

Video candidates remain to be measured on a physical device: inactive mounted cards initialize player sources, compression lacks a cancellation signal, and publication waits for server-prepared video/poster readiness. The upload pipeline already caches prepared videos, resumes chunks, and serves adaptive native playback for prepared assets; those mechanisms should be preserved.

The evidence supports specific causes of wasted work. It does not yet identify the dominant source of the user's observed delay or quantify a speedup. Repository line count is not a runtime-performance measurement.

## Next repair order

1. Consolidate photo preparation and correct format metadata.
2. Stabilize feed cache identity; decouple Discover's primary content from optional suggestions and preserve failure state.
3. Correct page cursors and prove complete traversal.
4. Limit pagination to the requested data and share privacy computations within each request without removing checks.
5. Stop network polling on inactive screens; profile video preparation/transfer/processing and playback separately.
6. Reconcile stale live-window assertions and event-label rules, then rerun affected checks.
7. Record real installed-app purchase/media journeys before release approval.

## Evidence files

- [Canonical execution results](/Users/varsityhub/Code/VarsityHubMobile/artifacts/matrix-audit/execution.json)
- [Matrix inventory](/Users/varsityhub/Code/VarsityHubMobile/artifacts/matrix-audit/inventory.md)
- [Full frontend results](/Users/varsityhub/Code/VarsityHubMobile/artifacts/matrix-audit/client-full-results.json)
- [Reproduction harness](/Users/varsityhub/Code/VarsityHubMobile/artifacts/performance-audit/2026-09-15/reproduce.cjs)
- [Detailed performance findings and source links](/Users/varsityhub/Code/VarsityHubMobile/docs/release/2026-09-15-performance-logic-audit.md)

No application fixes, production configuration changes, purchase transactions, or deployment occurred in this audit. Source mapping and automated passes are not proof that all advertised features work.
