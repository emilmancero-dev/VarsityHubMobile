# Phase 4 changes — pagination and backend work

Implemented locally on `codex/phased-performance-repairs`, isolated from the user's original checkout. No push, merge, deployment, provider change or schema migration.

## What changed

- **Posts and comments no longer skip the next unseen record.** Ordinary posts, pinned team posts, comments, and both followed Feed lists use deterministic date/ID ordering and an exclusive last-delivered position.
- **Deleted page anchors do not end new paging sequences.** Versioned `p2` markers contain the timestamp and ID; continuation does not depend on that row still existing. Legacy raw-ID markers remain inclusive because the prior server issued the first unseen ID. Missing legacy anchors produce a refresh error instead of silently restarting.
- **Trending continuation is consistent.** New `t2` markers keep the scoring clock fixed across pages and compare scores exactly as ranking does. Older `t:` markers resume at their first-unseen anchor in the visible ranked pool or require refresh when it is unavailable.
- **Nearby results remain reachable through sparse batches.** Location filtering scans at most ten bounded batches. If the budget is exhausted, even an empty page retains a progressing raw cursor. A 95-distant-row fixture verifies eventual traversal to all seven nearby records.
- **Feed pagination computes only what it needs.** Optional validated `sections` selects people posts, team posts, highlights, ads or either unread count. Omitting it retains the legacy full bundle. Unrequested sections are omitted, not replaced with empty values.
- **Repeated privacy decisions are reused only within one request.** The existing request-attached map stores viewer-keyed promises for private authors and teams. Concurrent consumers share the result, including rejection. No new cross-request permissions cache was added; existing block checks remain intact.
- **The app requests only the section being paginated.** Both people and team paging preserve other sections, accept legacy full responses, and retain posts and page markers for retry if the requested section fails or is missing.

## Evidence and limits

- Test-first reproductions caught skipped records, timestamp-tie duplicates, prematurely exhausted nearby results, time-decay repeats, and nearly equal trending scores being incorrectly treated as ties. These failures were observed before their respective fixes.
- **22 real-database pagination regressions passed.** The combined run passed **177/177 tests across nine backend suites**, including Feed, posts, private teams, minors, access boundaries and request-cache isolation.
- In the warm-private-inventory fixture, three consumers now issue **four authorization queries instead of twelve**. This measures the helper's database calls, not overall app speed.
- A real Feed route test observes **one post-list query and no ad/unread-count queries** for a people-only request; the legacy full-response tests still pass.
- Focused client checks passed **14/14 assertions**: API encoding, people/team paging with selective and legacy responses, retry preservation, and existing cache/lifecycle regressions.
- Independent Astra reviews approved both repair groups after two additional trending findings were reproduced and repaired. No unresolved critical/important findings in that scope.
- Explicit lint checks returned zero errors; existing warnings remain (14 in posts.ts in the pagination run, 33 across API-client/normalization/privacy files in the optimization run). Hooks and structural duplicate checks passed. Local gitleaks is unavailable; CI secret scanning was not run here.
- Runtime: Node 20.19.6. Database tests used only the disposable local PostgreSQL audit database on port 55439 with production environment loading disabled. The database was stopped after testing; files were retained.
- Final complete client run on `41970a96`: **228/228 suites and 1,665/1,665 tests passed**, with zero failures or skipped tests. Both full client and server TypeScript checks also passed on that commit. Jest's configured force-exit advisory remains; this is not a device-performance measurement.

## Design and rollout cautions

- The plan's proposed `skip: 1` cursor was replaced by an equivalent exclusive timestamp/ID boundary because a deleted anchor would make Prisma ID-based continuation unreliable. No authorization predicate was removed; the boundary only narrows the existing visible-record query.
- These are live lists, not immutable historical snapshots. New posts, changes to votes/pins, and privacy changes may change membership/order between requests. Trending retains its existing 200-record candidate pool; this repair does not promise traversal outside that pool.
- Sparse location pages can be empty **with a next cursor**. Consumers must follow that cursor rather than infer exhaustion from item count alone. Each request remains capped at ten batches (up to 150 rows per batch).
- Existing installed clients already pass opaque cursors back unchanged. New clients also accept an older server's full bundle when it ignores `sections`. Server support is committed separately and must be released before dependent app updates.
- **Old API servers do not understand newly issued `p2`/`t2` cursors.** Production rollout must avoid routing new markers back to old replicas; backend rollback requires clients to refresh their lists. This mixed-server rollout behavior has not been exercised on production infrastructure.
- Legacy ordering had undefined timestamp ties; a page begun before rollout cannot recover a perfect historical order for tied rows. Refresh starts a deterministic new sequence.
- No device speed percentage is claimed. Video profiling/cancellation, installed iOS/Android journeys, strict matrix/payment evidence and operational launch gates remain open.

## Commits and rollback

- `49a374af` — pagination correctness and regressions.
- `ed20d1b6` — selective backend bundle and request-local privacy reuse.
- `41970a96` — selective app pagination and failed-cursor preservation.

No persistent schema changes. For an unreleased branch, omit/revert the repair commits. For a released candidate, coordinate backend/client rollback and list refresh as described above; do not assume an older backend can consume the newer cursors. A client release requires its own approved delivery step (OTA only where compatible); nothing is live from these local commits.
