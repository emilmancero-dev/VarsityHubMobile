# VarsityHub performance and logic audit

Audit target: working tree based on `0c9f851f`, September 15, 2026. User priority: Feed/Discover loading and scrolling, plus media upload/playback. Platform was not specified.

## Conclusion

There is evidence of redundant runtime work and conflicting logic. This is more actionable than the total file count. Local reproductions confirmed ineffective feed cache reuse, skipped pagination records, repeated privacy lookups, duplicate image encoding, image-format mismatch, inconsistent event state, and swallowed Discover failures.

This was source analysis and isolated execution of current functions with synthetic dependencies. It was not a native-device profile, production query benchmark, network trace, or full security audit. No measured production latency reduction is claimed. Application source, production configuration, and existing media-picker edits were not changed. No separate Astra tool integration was available; the audit used the exposed repository and test tools.

## Confirmed findings and surgical repairs

### F1 — Photo preparation runs twice and can mislabel the result — high priority

Sources: [composer preparation](</Users/varsityhub/Code/VarsityHubMobile/app/(tabs)/create-post.tsx:114>), [retained original MIME](</Users/varsityhub/Code/VarsityHubMobile/app/(tabs)/create-post.tsx:642>), [upload boundary](/Users/varsityhub/Code/VarsityHubMobile/apiclient/upload.ts:246), [shared preparation](/Users/varsityhub/Code/VarsityHubMobile/utils/ensureUploadableUri.ts:25).

The composer converts every selected image over 2 MB to JPEG at width 1280. The common uploader then invokes its own JPEG preparation. The composer retains the input MIME type after conversion. That also defeats the common uploader's intentional PNG/GIF/WebP preservation.

Reproduction using the actual two preparation functions and a recording encoder mock:

- A 3 MB JPEG causes two JPEG encode calls.
- A 3 MB GIF causes a JPEG encode, but the uploader receives/returns `image/gif` for the generated `.jpg` URI. PNG follows the same composer conversion path.

Consequences: extra decoding/encoding work, potential quality loss, flattened animation/transparency, and incorrect upload metadata. Native milliseconds and actual codec output were not measured; encoder invocations and arguments were verified.

Repair: keep image encoding in the shared uploader, remove the overlapping composer conversion, and carry MIME/filename from the prepared result. Verify picker-to-uploader behavior for JPEG, HEIC, PNG with alpha, animated GIF, portrait images, five-photo batches, and retries. Preserve the file cap and durable draft handling.

### F2 — Fresh timestamps defeat feed query reuse — high priority

Sources: [load/query keys](/Users/varsityhub/Code/VarsityHubMobile/app/feed.tsx:638), [query planner](/Users/varsityhub/Code/VarsityHubMobile/utils/feedGameQueries.ts:95), [cache configuration](/Users/varsityhub/Code/VarsityHubMobile/lib/queryClient.ts:24).

Each load computes millisecond-precise date bounds. Those values enter the game and enrichment query keys. A remount therefore creates new cache entries rather than reusing fresh entries. Coordinates also enter game cache keys while the planner call omits them and requests `showAll: true`, creating distinct keys for the same scope.

Reproduction: the real planner and installed QueryClient fetched twice and stored two entries for loads one millisecond apart despite a 30-second stale time. The screen's separate cooldown still suppresses some silent reloads; this finding concerns loads that actually execute, especially remounts.

Repair: key by stable semantic scope, retain consistent bounds for a cached page/cursor chain, and refresh the range intentionally when stale or explicitly refreshed. Include relevant viewer scope. Verify a warm remount makes zero replacement game requests within the stale period, while explicit refresh and account changes remain correct.

### F3 — Discover blocks primary content on optional work and hides failure — high priority

Sources: [personalization and fallbacks](</Users/varsityhub/Code/VarsityHubMobile/app/(tabs)/discover/mobile-community.tsx:570>), [second suggestions query](</Users/varsityhub/Code/VarsityHubMobile/app/(tabs)/discover/mobile-community.tsx:674>), [full-screen loading gate](</Users/varsityhub/Code/VarsityHubMobile/app/(tabs)/discover/mobile-community.tsx:696>), [HTTP retry budgets](/Users/varsityhub/Code/VarsityHubMobile/apiclient/http.ts:758).

The screen waits for games AND personalization before dismissing its main skeleton. Personalization waits for posts and people. Suggested people are requested twice with limits 20 and 10, so URL-based request deduplication does not combine them. Post fallbacks are serial, and each underlying HTTP call can retry.

Reproduction: executing the current personalization function with all providers rejecting produced three sequential post-method calls and one people call, then resolved successfully with empty arrays. React Query therefore cannot set the intended error state for this failure.

Repair: render loaded primary sections independently; use one shared suggestions result; replace serial fallback chains with an explicit compatibility path; preserve real errors or explicit partial-failure metadata. Verify delayed suggestions do not hide ready games and offline responses show an error instead of a true empty state. Measure retries and full-screen blocking time before changing budgets.

Additional continuity gap: `refreshAll` does not refresh the separate followed-calendar query declared at line 549. Include that query in the appropriate refresh/invalidation path.

### F4 — Post and comment pagination skips records — high priority

Sources: [bundle cursor](/Users/varsityhub/Code/VarsityHubMobile/server/src/routes/feed.ts:204), [post cursor](/Users/varsityhub/Code/VarsityHubMobile/server/src/routes/posts.ts:596), [comment cursor](/Users/varsityhub/Code/VarsityHubMobile/server/src/routes/posts.ts:1563).

The response selects the first unreturned row as `nextCursor`, then the next request uses `skip: 1`. That row is never delivered.

Reproduction: executing the actual bundle page function over seven synthetic rows with page size two delivered posts 1, 2, 4, 5, 7; posts 3 and 6 were omitted. The other two handlers contain the same cursor/skip combination; they were source-confirmed, not individually executed against PostgreSQL.

Repair: pair an exclusive cursor with the last returned item, or an inclusive cursor with the first unreturned item, consistently. Add all-pages traversal tests proving exact once-only coverage, including equal timestamps, location filtering, and deletions. This is a correctness defect, not a measured speed cause.

### F5 — One page request repeats whole-bundle and privacy work — medium priority

Sources: [client pagination](/Users/varsityhub/Code/VarsityHubMobile/app/feed.tsx:1070), [six bundle slices](/Users/varsityhub/Code/VarsityHubMobile/server/src/routes/feed.ts:517), [author privacy](/Users/varsityhub/Code/VarsityHubMobile/server/src/lib/privacyUtils.ts:36), [team privacy](/Users/varsityhub/Code/VarsityHubMobile/server/src/lib/privacyUtils.ts:89).

Loading more people OR team posts calls the complete bundle. It recomputes the other post section, highlights, ads, and counters. Setting `highlights_limit: 1` does not avoid the highlight candidate queries, including the 150-row pool.

The two post sections and highlights independently calculate private authors/teams. Global ID lists are cached, but viewer-specific authorization queries are not shared across these calls. With cached private users and an organization-owned private team, the actual helpers issued 12 synthetic DB calls across three consumers: three each for follows, team follows, team memberships, and organization memberships. One request-scoped shared result would require four under that fixture. Actual database duration was not measured. Blocked-user results already have promise deduplication and should retain it.

Repair: add backward-compatible section selection to the existing bundle, or reuse a suitable existing section endpoint after parity checks. Share viewer privacy promises within one request; retain every privacy predicate and failure behavior. Verify per-request query counts and blocked/private-content exclusion before considering cross-request caches.

### F6 — Feed activity polling outlives screen focus — medium priority

Source: [activity interval](/Users/varsityhub/Code/VarsityHubMobile/app/feed.tsx:1161).

The 30-second post-activity poll uses mount-scoped `useEffect`, although its comment says it runs while focused. Its callback checks neither navigation focus nor app activity. When a feed remains mounted behind another screen, it can continue requesting summaries and updating state. This path includes past events as well as live ones, capped at 50 IDs. Native lifecycle/network frequency was not measured.

Repair: tie polling to focus and app-active state, with an in-flight guard. Verify no calls after blur/background and a single refresh on return. Preserve local event-state updates that do not require a request.

### F7 — Two event clocks disagree — medium priority

Sources: [presentation helper](/Users/varsityhub/Code/VarsityHubMobile/utils/eventPresentation.ts:26), [details consumer](/Users/varsityhub/Code/VarsityHubMobile/app/game-details/GameDetailsScreen.tsx:507), [canonical live helper](/Users/varsityhub/Code/VarsityHubMobile/utils/liveWindow.ts:78).

Reproduction: a 16:00 event with a server live end of 22:00 is LIVE in the feed at 19:00 but `active` in details because presentation has an independent two-hour cutoff. This proves divergence; whether the two visual labels intentionally differ must be reconciled with the owner rule before changing behavior.

Repair: preserve the distinction between posting eligibility and labels, but derive approved labels from the same serialized bounds. Cover standard, extended, all-day, and timezone boundaries.

## Media performance candidates requiring device measurement

### M1 — Paused cards still initialize video sources

Sources: [card playback hook](/Users/varsityhub/Code/VarsityHubMobile/app/game-details/GameVerticalFeedScreen.tsx:334), [native player creation](/Users/varsityhub/Code/VarsityHubMobile/hooks/usePlaybackLifecycle.ts:35), [list window](/Users/varsityhub/Code/VarsityHubMobile/app/game-details/GameVerticalFeedScreen.tsx:1489).

Each mounted video card creates a player with a source even when inactive. Eligibility controls playing, not source attachment. This may be useful adjacent-item preloading, but there is no explicit source-loading budget; `windowSize={5}` also does not itself specify initial render count. Pausing does not prove that no loading/decoding work occurs.

Measure player count, network bytes, memory, frame time, and first-frame delay on a release build before limiting active/neighbor sources. Keep existing pause/resume continuity. Do not remove all preloading blindly.

### M2 — Upload cancellation does not cancel preparation

Sources: [preparation options](/Users/varsityhub/Code/VarsityHubMobile/utils/compressVideo.ts:134), [serialized preparation](/Users/varsityhub/Code/VarsityHubMobile/utils/compressVideo.ts:323), [uploader boundary](/Users/varsityhub/Code/VarsityHubMobile/apiclient/videoUpload.ts:51).

Compression accepts progress but no abort signal. The upload checks cancellation after preparation completes. A canceled encode can continue consuming resources and hold the preparation queue ahead of a subsequent selection. This is a source-confirmed cancellation gap; actual post-cancel device cost was not measured.

Repair after a native reproduction: connect the encoder's supported cancellation mechanism and queue cleanup to the existing signal, while retaining one memory-bounded encoder/transfer and recovery state. Test cancel during encoding, immediate retry, and unmount.

### M3 — Transfer complete is not publish-ready

Sources: [processing polling](/Users/varsityhub/Code/VarsityHubMobile/apiclient/videoUpload.ts:205), [server readiness](/Users/varsityhub/Code/VarsityHubMobile/server/src/lib/mediaUploadSession.ts:199).

The server waits for prepared MP4, HLS, and poster readiness. With an expected webhook, it defers fallback CDN probes for 60 seconds. A delayed/missing callback can therefore produce visible post-transfer waiting. This is an intentional reliability tradeoff, not evidence that encoding is broken.

Measure acquisition, local preparation, transfer, provider processing, and post-create separately; verify callback delivery. Preserve server verification. Existing prepared-video caching avoids routine double video compression, chunk checkpoints avoid full retransmission, and native prepared URLs already use HLS. These are useful mechanisms to keep.

## Additional safety finding

[Suggested-users query](/Users/varsityhub/Code/VarsityHubMobile/server/src/routes/users.ts:1640) explicitly includes `date_of_birth: null` alongside adults. The repository safety rules treat unknown age as restricted and forbid adult discovery of minors by default. A public, onboarded, non-banned account with unknown age can satisfy this query. This is a high-priority source-confirmed fail-open selection concern; production population and end-to-end exposure were not tested. Add an adult-viewer/unknown-age candidate test and reuse the canonical age gate before expanding suggestions performance changes.

## Code-diet disposition

- **Refactor later:** `GameDetailsScreen.tsx` (4,807 lines), `feed.tsx` (3,491), create-post (3,382), Discover mobile community (3,255). These mix fetching, state, presentation, and compatibility paths. Extract boundaries while fixing demonstrated overlaps; file splitting alone is not a speed improvement.
- **Consolidate:** duplicated image preparation, separate event timing logic, repeated suggestion queries, and repeated request-local privacy computation.
- **Archive/consolidate candidate:** `scripts/overnight-db-performance.sh` is a source heuristic, not a benchmark. Its `SLOW_QUERIES` array is never populated; it checks pagination on the query's opening line and labels fields as missing indexes without reading schema/indexes. It is still invoked by `scripts/overnight-strength-organization.sh`, so update that dependency before retiring it.
- **Keep:** alias routes, safety gates, existing shared QueryClient, bounded/resumable uploads, prepared-video cache, HLS delivery, migrations, and release tests. The structural duplicate audit found no exact duplicate source files or duplicate router registrations.
- **Delete candidates:** none established by this audit. No deletion is justified merely by file length. The 276,557-line source scan includes tests; it is not a bundle-size measurement. The scanned project directories contained 2,129 files, including docs/scripts.
- **Owner decision:** intentional event-label semantics and any quality-versus-processing-time tradeoff. No approval is needed merely to preserve existing behavior while removing confirmed duplication during an authorized implementation pass.

## Repair order and acceptance evidence

1. Fix F1 photo preparation/format consistency; verify one encode for eligible JPEGs and unchanged alpha/animation formats.
2. Fix F2 cache keys and F3 loading/error handling; compare cold/warm request counts and time until usable content on the same device/network.
3. Fix F4 pagination; prove every fixture record is returned exactly once.
4. Fix F5 request amplification and F6 polling; measure DB calls per request and confirm no background-screen requests.
5. Resolve F7 label contract; add cross-surface boundary tests. Address the suggested-users safety finding independently with its own regression test.
6. Profile M1–M3 on physical devices, then change only the measured bottleneck. Run 10 repeated cold/warm journeys with the same fixture, record median and tail results, errors, frames, and bytes. Do not label a small sample a production percentile guarantee.

Keep each repair independently reviewable and revertible. Re-run focused regressions plus required client/server checks after changes. Do not replace the application architecture or remove safety checks to improve a timing number.

## Verification actually run

- Client and server TypeScript: both passed, exit 0.
- Five feed/cache/HTTP/event suites: 24 tests passed.
- Five media preparation/playback/upload suites: 67 tests passed.
- Seven isolated reproduction scenarios executed current source with mocked I/O; their assertions confirm the present defects/divergence, not repaired behavior.
- Structural duplicates, navigation classification, secret-literal scan, error-envelope scan, and conflict scan passed. These are scoped checks, not a whole-app correctness certificate.
- Feed startup tests emitted warnings because the mock lacks `Event.filter`; those tests therefore do not validate the real enrichment network path despite passing.
- No authenticated production load testing, live uploads, native frame/memory profiling, or full DB integration suite was run.

Reproduce the isolated findings from the repository root:

```sh
node artifacts/performance-audit/2026-09-15/reproduce.cjs
```

The harness performs no database access, environment-file loading, or HTTP requests. It imports/transpiles actual source, uses synthetic dependencies, and prints the observed results.
