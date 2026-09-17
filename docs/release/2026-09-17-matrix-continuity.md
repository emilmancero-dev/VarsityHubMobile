# Matrix continuity audit and first repair phase

Result: **not approved for production release**. The canonical matrix completed
with 17 passing gates and one blocked gate (installed-app ad-purchase evidence).
This report covers the working tree based on `0c3bd3d7`, including the local
changes from the preceding PDF repair work. Nothing in this run was deployed.

## Fresh evidence

| Verification                              | Result                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Full frontend suite after repairs         | 227 suites, 1,629 tests passed                                                                                                       |
| Canonical backend matrix                  | Nine suites passed: access, role barriers, role tiers, plan limits, privacy, minors, self-approval, game approval, Stripe signatures |
| Attendance/contribution API integration   | One test passed against isolated PostgreSQL                                                                                          |
| Feed bundle API integration               | Six tests passed, including complete cursor traversal                                                                                |
| Commandment source/document checks        | 29 tests passed; source assertions are not device certification                                                                      |
| Audit runner/registry guards              | 11 tests passed                                                                                                                      |
| Client and server TypeScript              | Passed                                                                                                                               |
| Navigation, error envelopes, secret scan  | Passed                                                                                                                               |
| Conflict check                            | No conflict markers found                                                                                                            |
| Matrix reference drift                    | Zero after reviewed reconciliation                                                                                                   |
| Strict workflow readiness                 | Blocked: FLOW-AD-PURCHASE requires installed-app evidence                                                                            |
| 1.0.5 and 1.0.6 installed-device journeys | Not run                                                                                                                              |

The matrix client suites are a subset of the full frontend suite. Inventory
reports 2,681 missing/partial coverage classifications, not 2,681 proven bugs.
The workflow registry's six `verified` labels describe its recorded evidence;
they do not establish complete production compliance.

Database checks used only `varsityhub_matrix_test` on local port 55439 under
PostgreSQL 17, with synthetic records and Node 20.19.6. Test processes explicitly
disabled environment-file loading. The previous "database unavailable" blocker
is resolved. No production database was used.

## Repairs performed after the baseline audit

- **Closed — skipped feed posts:** reproduced through the actual feed API. The
  next cursor pointed at the undelivered look-ahead row even though the next
  query skips its cursor. It now points at the final delivered row. The new
  regression traverses all pages and asserts no omissions or duplicates.
- **Closed in source — feed overwrite race:** secondary game results now merge
  into current state, preserving event enrichment and seeded results that
  arrived first. Existing feed/component coverage passes; installed-device
  timing has not been measured.
- **Closed — unstable query identity:** feed query boundaries now use a
  30-second bucket. Closely spaced mounts share the cache identity; a test
  covers both same-bucket reuse and rollover.
- **Closed in source — duplicate photo conversion:** the composer keeps the
  original selected/captured bytes. The existing upload boundary owns image
  conversion and output MIME type, preserving GIF/PNG/WebP originals. Image
  preparation tests pass. On-device upload timing remains unmeasured.
- **Stale/deleted — eleven matrix references:** removed references to deleted
  controls and replaced changed call/control IDs. New mappings retain missing
  coverage status; no blanket coverage upgrade was made.
- **Stale — regression expectations:** title emoji and the removed post button
  still had tests asserting the retired behavior. Two older live-window
  expectations contradicted the current two-hour opening/six-hour fallback
  rules in the canonical document and server. Updated those expectations while
  retaining sign-in, story separation, and time-boundary checks.
- **Documentation drift:** corrected the live-card counter text, contribution
  history semantics, and the claim that mixed photo/video selection exists.

## Still open; passing automation does not close these

| Classification          | Item                                                                                           | Next required evidence/work                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Deferred feature        | G League, MLS NEXT and broader minor-league ingestion                                          | Verified provider adapters, team/venue mapping, fixture tests and live ingest evidence             |
| Deferred feature        | Per-photo crop/edit and mixed media selection                                                  | Complete composer workflow and test actual devices                                                 |
| Open bug                | Discover failures can resolve as an empty success                                              | Remove failure-swallowing fallback chain and verify error recovery                                 |
| Open performance issue  | Repeated request-level privacy lookups and redundant bundle work                               | Share computations within a request without weakening visibility checks                            |
| Open product difference | Original 800-character requirement versus current 4,000                                        | Resolve against the governing requirement, then align validation and tests                         |
| Unverified              | Immediate upvotes, map Other classification, camera capability parity, complete media previews | Exercise the precise reported scenarios on installed 1.0.5 and 1.0.6                               |
| Release blocker         | Advertisement purchase → verification → activation on device                                   | Record a sandbox/store-test journey; automated signature/pricing tests are insufficient            |
| Release blocker         | Production rollout of local fixes                                                              | Complete outstanding release checks, commit/push, verify server deployment and each runtime update |

The historical reproduction harness intentionally asserts the old defects.
Its successful baseline run proved those defects before these repairs. Do not
interpret a later assertion failure or missing removed helper in that harness
as a new application regression; use the maintained regression tests above.

## Evidence locations

- `artifacts/matrix-audit/execution.json` — final canonical gate results and log paths.
- `artifacts/matrix-audit/inventory.json` — current inventory and workflow blocker.
- `artifacts/matrix-audit/client-full-continuity-results.json` — baseline full-suite failures.
- `artifacts/matrix-audit/client-full-continuity-final.json` — full-suite passing rerun.
- `server/src/__tests__/api-feed-bundle.test.ts` — pagination API regression.
- `server/src/__tests__/users-event-pages.test.ts` — verified/contributed history integration.

Next phase: complete remaining product gaps and targeted device verification,
then follow `docs/release/RELEASE_WORKFLOW.md`. A runtime 1.0.6 update alone
does not certify or update runtime 1.0.5.
