# Surgical Gap Repairs Implementation Plan

> For execution: use the executing-plans workflow, work task by task, and review each patch before proceeding. This document authorizes no production transaction or credential rotation.

**Goal:** Close the confirmed safety, pagination, Discover, and polling defects with small independently verifiable changes, then resolve dormant-feature scope and complete release evidence.

**Architecture:** Preserve the modular monolith, existing API contracts, shared React Query client, privacy helpers, and upload pipeline. Keep each repair in its existing subsystem; extract a helper only when it prevents duplicated policy or makes a lifecycle independently testable.

**Tech Stack:** React Native/Expo, TypeScript, React Query, Express, Prisma/PostgreSQL, Jest.

**Evidence:** `docs/release/2026-09-17-matrix-continuity.md`, current source, and the latest user request. Earlier audit prose is historical evidence, not proof that a finding still exists.

## Global constraints

- Preserve the current uncommitted PDF repairs and unrelated local artifacts. Inventory the diff before editing; stage only reviewed paths.
- All authorization, age, visibility, and payment decisions remain server-authoritative. Unknown age remains restricted.
- Test database work uses the isolated local database with environment-file loading disabled. Never use production data for test fixtures.
- No new dependencies or schema migrations are expected for Tasks 1–4.
- Each repair has a focused regression, relevant existing checks, and its own commit. Never bypass hooks.
- A passing code test does not mark an installed 1.0.5/1.0.6 journey or production deployment verified.

## Scope correction

`app/manage-season.tsx` fixes `selectedTab` to `schedule` and never calls its setter. Its standings/playoffs placeholders therefore appear dormant, not reachable broken user journeys. `Post.createCollage` has a client declaration but no current app/component caller found; its backend intentionally returns 501. Treat these as separate feature work, not tiny bug fixes.

## Task 1 — Restrict suggested-user candidates with unknown age

**Modify:** `server/src/routes/users.ts` (`GET /users/me/suggested`).
**Inspect/reuse:** `server/src/lib/userAge.ts`, `server/src/lib/privacyUtils.ts`.
**Create test:** `server/src/__tests__/suggested-users-age.test.ts`.
**Interface:** Existing suggestion response shape and limit remain unchanged.

- [ ] Create an adult viewer plus eligible adult, minor, unknown-DOB, blocked, private, deleted, and banned candidates in isolated PostgreSQL. Explicitly mark test accounts onboarded and configure actual follow/privacy relationships.
- [ ] Call the real endpoint; prove the unknown-DOB fixture appears before the fix. Assertions must check the eligible adult is returned as well as restricted candidates being absent.

```ts
const response = await request(app)
  .get('/users/me/suggested')
  .set('Authorization', `Bearer ${adultToken}`)
  .expect(200);
const rows = Array.isArray(response.body) ? response.body : response.body.items;
const ids = rows.map((row: { id: string }) => row.id);
expect(ids).toContain(eligibleAdult.id);
for (const candidate of [minor, unknownDob, blocked, privateUser, deleted, banned]) {
  expect(ids).not.toContain(candidate.id);
}
```

- [ ] Replace the candidate query's explicit null-DOB alternative with the canonical adult-only predicate. Inspect age-cutoff/timezone behavior against `userAge.ts`; reuse or narrowly expose its cutoff logic if required. Retain all block/private/deleted/banned filters.
- [ ] Cover the eighteenth-birthday boundary and both adult/minor viewer cases. Candidate restriction must not grant messaging permission; existing accepted-follow checks remain authoritative.
- [ ] Run the new suite, `privacy-surfaces.test.ts`, `minors-foundation.test.ts`, and server TypeScript. Review returned public fields for accidental DOB disclosure.
- [ ] Commit this safety repair separately. Rollback must preserve the restrictive age predicate; correct forward if an unrelated suggestion regression occurs.

## Task 2 — Complete post/comment pagination without omissions

**Modify:** `server/src/routes/posts.ts` (ordinary, trending, comments).
**Reference:** Already repaired `server/src/routes/feed.ts` and `server/src/__tests__/api-feed-bundle.test.ts`.
**Create test:** `server/src/__tests__/post-pagination-continuity.test.ts`.
**Interface:** Keep existing ID cursors and `t:score|timestamp|id` trending cursors.

- [ ] Add real API traversal fixtures for ordinary posts, trending posts, and comments. Use seven or eight eligible records, page size two, and equal timestamps with deterministic ID tie-breaking.
- [ ] Assert the complete expected set, no duplicates, and eventual null cursor. Demonstrate the existing failures first.

```ts
expect(delivered.length).toBe(new Set(delivered).size);
expect([...delivered].sort()).toEqual([...expectedIds].sort());
expect(finalCursor).toBeNull();
```

- [ ] For ordinary posts/comments with `skip: 1`, choose the last returned row as continuation, using the extra row only to establish that more exist:

```ts
const items = rows.slice(0, limit);
const nextCursor = rows.length > limit ? items[items.length - 1].id : null;
```

- [ ] Correct trending too: its strict comparison currently excludes the first unreturned row encoded as cursor. Encode the final delivered ranked row when there is a look-ahead row; retain ranking tie-breakers and existing token syntax.
- [ ] Handle the ordinary route's post-query distance filter explicitly. Do not claim completeness from the simple cursor change: an all-filtered batch can otherwise falsely end traversal. Scan bounded raw batches until the page fills or the source is exhausted; retain the last scanned cursor if a scan budget is reached. Never advance past an eligible unreturned row. Keep each DB fetch bounded and document any empty-page continuation contract for clients.
- [ ] Test nearby/distant interleaving, a whole filtered batch, blocked/private records, exact-limit termination, and deletion between pages. If a deleted cursor cannot resume with the existing protocol, document that limitation and design a backward-compatible continuation before closing that case.
- [ ] Run pagination integrations, feed-bundle integrations, privacy tests, and server TypeScript. Commit separately.

## Task 3 — Make Discover load independently and report real failures

**Modify:** `app/(tabs)/discover/mobile-community.tsx`.
**Extend tests:** `app/__tests__/mobile-community.smoke.test.tsx`.
**Optional narrow helper:** `utils/discoverData.ts` only if needed to share normalization; no second client/cache.
**Interface:** Existing API response shapes; viewer-scoped query keys; distinct section loading/error states.

- [ ] Add deferred-request component tests: games resolve while suggestions stay pending; all post methods fail; stale successful data exists during a failed refresh; viewer changes during requests.
- [ ] Let ready games render independently of personalization. Each optional section owns its loading, empty, error, and retry state; keep successful cached content visible on refresh failure.
- [ ] Replace the three-step post fallback chain with the current supported endpoint. Permit a compatibility fallback only for an explicitly recognized unsupported-endpoint response, not authentication, network, rate-limit, or server errors.

```ts
// Let React Query retain the rejection and expose the error state.
const page = await Post.trendingPage(undefined, 20);
return Array.isArray(page.items) ? page.items : [];
```

- [ ] Consolidate the two suggested-user requests into one existing React Query entry for the viewer. Derive the 10-item and 20-item displays locally. Preserve privacy filtering from the API, follow-state updates, and account-change isolation.
- [ ] Include the followed-calendar query in pull-to-refresh; refresh only sections appropriate to the active surface, while retaining explicit retry for a failed optional section.
- [ ] Verify a slow optional request never hides ready games, failures show retry UI, a true empty response shows empty UI, and one viewer produces only one suggestions request per load. Run Discover/navigation/auth regression tests and client TypeScript. Commit separately.

## Task 4 — Stop activity polling off-screen and in the background

**Modify:** `app/feed.tsx` activity polling block.
**Extend test:** `__tests__/feed.startup.test.tsx`, or create `__tests__/feed-activity-lifecycle.test.tsx` if setup becomes unwieldy.
**Interface:** Existing `preloadPostsActivity`, 30-second activity interval, existing event-ID limit and privacy checks.

- [ ] Use fake timers, focus callbacks, AppState events, and a deferred activity request to prove the current off-screen polling behavior.
- [ ] Move the activity timer under `useFocusEffect`; run only when AppState is active. Stop the timer and remove the AppState listener on blur/unmount; pause on background/inactive.
- [ ] Use an in-flight guard and current event IDs so a slow request cannot overlap another tick. Retain the initial badge preload; avoid adding a second entry-time request. Ignore stale responses after identity/screen ownership changes.
- [ ] Assert zero new calls while blurred/backgrounded, one refresh on return, no overlapping requests, and no updates from a stale session. Keep unrelated notification and ad behavior outside this patch.
- [ ] Run feed startup/component tests and client TypeScript. Commit separately.

## Task 5 — Resolve dormant feature scope before implementing it

**Inspect:** `app/manage-season.tsx`, `apiclient/entities.ts`, `server/src/routes/posts.ts`, actual season models/routes and source-of-truth game results.

- [ ] Confirm standings/playoff controls and collage calls are absent from reachable routes, menus, deep links, and shipped marketing claims. Record the paths checked.
- [ ] Keep dormant features explicitly classified as deferred until implemented and tested. Do not convert 501 into a success response or display fabricated standings/brackets.
- [ ] For real standings/playoff delivery, define scoring rules per supported sport, tie-breaking, result authority, seeding, bracket progression, byes, corrections, and staff permissions. Draft separate implementation specs after inspecting existing season data. These choices affect outcomes and cannot be inferred from a placeholder.
- [ ] For real collage delivery, define layout/output rules and whether existing multi-photo posts satisfy the desired user journey. If a renderer is needed, reuse signed, owner-bound media inputs, existing upload caps/moderation, and normal post creation. Never fetch arbitrary user-supplied remote URLs.
- [ ] Make scope choices concrete before requesting user direction; feature implementation stays separate from the four defect commits.

## Task 6 — Reconcile evidence and release the verified patch set

**Update:** `config/matrix-coverage.json`, `config/commandment-workflows.json`, `docs/release/2026-09-17-matrix-continuity.md` and a new dated release result.

- [ ] Review the entire local diff, including prior PDF changes; do not accidentally publish partially reviewed work merely because it predates this plan.
- [ ] Reconcile only references affected by the changes. Missing device evidence stays missing; do not relabel it as automated coverage.
- [ ] Run focused tests while implementing; at the release checkpoint run the canonical matrix, full frontend suite, both TypeScript checks, navigation/error/secret/conflict gates, and the local/build checks in `docs/release/RELEASE_WORKFLOW.md`.
- [ ] Record installed 1.0.5 and 1.0.6 behavior separately for sign-in, suggestions, scrolling through posts/comments, Discover offline/retry, background/resume, and media. Record update IDs/native builds used.
- [ ] Complete store sandbox advertisement purchase → verification → activation evidence. Any paid transaction requires the relevant existing authorization; no real purchase is implied by this plan.
- [ ] Confirm runtime compatibility from installed binaries and update manifests before publishing. Use a compatible legacy OTA only where every required native capability exists or its fallback is tested. Publish native-required features through a new build.
- [ ] Deploy reviewed server changes, verify deployment health, then publish compatible client updates and verify each received version. Preserve previous server release and update identifiers for rollback.
- [ ] Close an item only with its test and deployment/device evidence. League coverage, photo cropping, mixed media, original text-limit policy, and other earlier product gaps remain separate work until completed.

## Acceptance and ordering

Execute Tasks 1 → 2 → 3 → 4. Task 5 can be investigated without blocking those repairs but is not a hidden feature expansion. Task 6 follows verification of the patch set. Completion means each repaired behavior has regression evidence and a verified release destination; it does not mean every historical roadmap feature exists.

No product code was changed while writing this plan.
