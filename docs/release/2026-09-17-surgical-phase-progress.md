# Surgical repair checkpoint — September 17, 2026

Status: local implementation on `codex/surgical-gap-repairs`; not committed, pushed, or deployed. Existing unrelated and earlier PDF repair changes remain preserved.

## Implemented and exercised

- Suggested-user candidates now require a known adult DOB. Existing private, blocked, deleted, banned, and onboarding filters remain. Canonical UTC birthday/leap-day cutoff has regression coverage; public responses do not expose DOB.
- Ordinary posts have a deterministic ID tie-breaker. Ordinary, trending, and comment cursors now identify the final delivered item rather than the look-ahead item.
- Location-filtered posts scan up to ten bounded batches. An empty page can still carry a continuation cursor: consumers must use `nextCursor`, not item count, to decide whether the source is exhausted.

## Verification

- New real-endpoint regressions reproduced unknown-age exposure and ordinary/trending/comment traversal failures before fixes.
- Latest combined run: suggested-users-age, post-pagination-continuity, adult-birth-date-cutoff — 3 suites, 9 tests passed.
- Existing privacy-surfaces, minors-foundation, api-feed-bundle — 27 tests passed.
- Client TypeScript passed. Server TypeScript passed during implementation; final repeat recorded in task output.
- One earlier location test run returned an HTTP parser error; two subsequent runs passed, including the combined suite. Cause not established; do not treat that intermittent failure as diagnosed.
- Database tests used isolated localhost PostgreSQL, not production records.

## Still open before closing Task 2 / releasing

- Explicit pagination cases for blocked/private records, exact-limit pages, interleaved locations, and deletion of the cursor row between requests.
- Audit all client consumers for empty-page continuation. Current ID-only cursor depends on the anchor row remaining in the database; design a backward-compatible continuation if hard-deletion resilience is required.
- Trending ranking can change between requests; this patch does not introduce snapshot pagination or expand its bounded candidate pool.
- Separate reviewed commits, full release gates, production deployment, and installed 1.0.5/1.0.6 verification remain outstanding.
- Plan Tasks 3 and 4 (Discover failure/loading states and off-screen polling) are not implemented at this checkpoint.

This checkpoint is not a claim that every commandment is satisfied or live.
