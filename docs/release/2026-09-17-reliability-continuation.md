# Reliability continuation — September 17, 2026

This phase is not a claim that every commandment is verified on installed 1.0.5 and 1.0.6. Current production remains the preceding ff538468 release until a publication record below says otherwise.

## Implementation and review history

- `2915280f`: post/comment continuation survives deletion of its delivered boundary. Ordinary and bundled feeds use timestamp/ID tokens, and team feeds preserve pinned-first ordering. Existing ID inputs remain accepted; trending token syntax is unchanged. Privacy and scope are reapplied on every request. Four pagination/privacy suites passed 36 tests; independent review found no blocking issues.
- `67267df1`: Discover games load independently of optional data. Post, people and calendar sections expose loading/empty/error/retry states; stale successful data remains visible after refresh failure. One viewer-scoped suggestion query replaces duplicate requests. The supported compatibility fallback no longer swallows failures. Focused tests passed 13, broader Discover/navigation/auth selection passed 139; full frontend passed 229 suites/1,643 tests before polling changes.
- `141ee14d`: initial activity-polling repair passed focused verification (six suites/16 tests and client TypeScript), but was **not release-approved**. Independent review found queued-return and feed-reload paths that could duplicate activity refreshes. The combined frontend run failed three lifecycle tests (228 suites passed; 1,644 tests passed, three failed). Focused success alone did not establish release readiness.
- `f6bf8003`: corrects both duplicate-return paths and stabilizes the lifecycle test scheduler without longer timeouts or weaker assertions. Fresh Node 20 verification passed eight startup tests, six focused suites/18 tests, client TypeScript, and the full frontend (229 suites/1,649 tests). Scoped re-review confirmed those fixes but found that unchanged-ID enrichment during a slow initial request could queue a duplicate. Fix round 2 must compare active IDs together with viewer/screen ownership before coalescing. The original failing run is retained as diagnostic evidence, not the final result.
- `cc7d7f2a`: coalesces only requests with matching eligible IDs, canonical viewer identity and active screen ownership. New regression cases retain requests for changed IDs or a new viewer. Node 20 startup verification passed 11 tests; the focused set passed six suites/21 tests; full frontend passed 229 suites/1,652 tests; TypeScript and commit hooks passed. Scoped re-review approved all findings as addressed with no new blocking issue.

## Verification so far

- Server and client TypeScript passed.
- Suggested-user/minor safety recheck passed two suites/nine tests.
- Secret, conflict and error-envelope checks passed.
- Canonical local release gate passed against isolated PostgreSQL at port 55439 and local test API port 55440, with environment-file loading disabled. No production fixture writes were performed.
- Build readiness passed with no blocking errors. Warnings cover lint, unfinished tracked work at check time and store-submission account/key setup. No new native build was requested or submitted.
- Matrix reconciliation removes stale Discover fallback/control references and registers new retry actions without upgrading missing coverage to verified. Automated tests are not device evidence.
- Final frontend evidence after fix round 1: `/private/tmp/varsityhub-task4-round1-full.log` and `/private/tmp/varsityhub-task4-round1-full.json`. Earlier `artifacts/matrix-audit/reliability-client-final.json` is the failed pre-review attempt despite its historical filename.
- Latest frontend evidence after fix round 2: `/private/tmp/varsityhub-task4-round2-full.log` and `/private/tmp/varsityhub-task4-round2-full.json` (zero failures).

## Pending before this patch can be published

- Final combined code review and regression checks.
- Commit/push release evidence, deploy server, publish compatible OTA updates, verify the actual release/update identifiers.

## Still not certified or implemented

Installed 1.0.5/1.0.6 journeys, including uploads and purchase → verification → activation, have not been exercised in this phase. No simulator was booted when checked. Do not infer an installed-device pass from component/API tests.

Standings/brackets and collage creation remain deferred; see [scope decisions](2026-09-17-dormant-feature-scope.md). Photo cropping, mixed-media selection, broader league ingestion, original 800-character versus current 4,000-character policy, and production auto-deploy source continuity remain outside this reliability patch.

The maintained remote is `fork` (`emilmancero-dev/VarsityHubMobile`), with this work on `codex/surgical-gap-repairs`. At the pre-publication check, `fork/main` was still `0c3bd3d7`, while the repair branch's remote tip was `ff538468`. Repository CI and automatic OTA/web workflows run on main/develop/PR triggers, not this repair-branch push. Local gate evidence must not be labeled successful remote CI. No main merge, workflow dispatch, or deployment-source reconfiguration is implied by publishing this explicitly verified patch.

## Rollback and compatibility

No dependency, schema or native capability change is intended. Previous production API deployment: `23e93869-58c3-4f88-829b-90a3e9e79341`. Previous OTA groups: 1.0.6 `d4dedbe4-2687-446d-b868-65a34a608544`, 1.0.5 `fe461274-d427-44e8-821b-d05ebee901c9`.

Block publication if a repaired path fails its regression or introduces privacy/data-isolation failure. After publication, stop rollout and correct forward or roll back for failed health checks, elevated server failures or broken sign-in/feed/Discover behavior. Prefer correcting forward for server pagination: rolling back to ID-only parsing can invalidate in-flight new tokens; a feed refresh restarts pagination.

The earlier broad launch-readiness blocker for installed-app ad-purchase evidence is not waived by this document. The user's preceding production-publication request allowed a patch to be made available for verification, not a declaration of complete real-world readiness.
