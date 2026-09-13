# Map league filter release — September 10, 2026

Published with explicit user authorization, with UTC deployment checks on September 11 (September 10 in New York).

- Source fix: `f829da84cafd09b3b36a17bdf3a6da1d2a03ae0a`.
- Server and runtime 1.0.6 release: `83df8f45` on `fork/release/serious-notes-20260910`.
- Runtime 1.0.5 client-only backport: `8ca7f381` on `fork/release/serious-notes-runtime-105`.
- Railway API deployment: `eb650667-46b3-42bd-83c7-07e8b0492978`, SUCCESS.

## Verification

The full local release gate passed in the 1.0.6/server release tree. Both runtime trees passed their 23 focused client tests and build-readiness gates. The server release passed 11 focused tests, including a real local database regression that places a minor-league fixture beyond the unfiltered result limit. Client/server typechecks and commit/push hooks passed in both trees. Existing non-blocking warnings remain.

Production runtime verification passed. The three live discovery source files match local SHA-256 hashes. Before deployment, an invalid league was ignored (200); after deployment it returns a safe 400. The live major and college queries each returned 20 correctly classified cards with boolean content flags. Minor and Other returned zero cards: these are empty-response checks, not proof of positive fixture coverage. No fixtures were invented or inserted for production testing. Recent server logs show slow-query warnings and a skipped NCAA fixture without venue coordinates; these remain coverage/latency observations.

No native configuration, package dependencies, database schema, or migrations changed relative to the previously deployed release. The 1.0.5 backport includes only the five client map/helper/test files and preserves that runtime's native compatibility.

## Scope and rollback

League selection is applied before database query limits; linked-game cards carry league metadata. The map uses the existing React Query provider, caches by viewer/date/league, retains a mounted map, rejects stale response overwrites, and displays generic request errors. Sport filtering still applies within returned league results.

This release does not resolve founder-only account policy, the interpretation of “combat p,” verified minor-league schedule sources, or empty-event database retention. Physical-device navigation, media, and location review remains with the user.

If the new query causes API failures, restore Railway deployment `80d46012-5c2c-4b03-b5ef-2a6fe91d0aee`. If the map client regresses, republish the previous compatible OTA group: 1.0.5 `04080ed3-4952-466f-8f38-02e699b00a45`; 1.0.6 `63340388-f4f5-4bbc-8fb4-5c9ac7e4b04d`. Coordinate a server rollback with client rollback because the previous server ignores the new filter. These previous versions retain the earlier error-disclosure/PDF fixes.

Publication confirms update availability, not that a particular phone has applied it. No EAS native build or App Store submission was needed.

## Published updates

- Runtime 1.0.5, iOS and Android: `dd8cf745-3a7d-42d6-9060-358fdf7baac5`, commit `8ca7f381baf2eb70962c8d6ab6503a22244258b3`.
- Runtime 1.0.6, iOS and Android: `15a29e33-088a-415d-a912-bcc6463c1e7f`, commit `83df8f456c625088a36174540076fc66b722b3bb`.

EAS readback confirms both groups, exact source commits, and runtime/platform targets. The production channel is unpaused and maps to the production branch. Direct update-protocol requests for all four runtime/platform combinations returned the newly published update IDs. The initial Python HTTP client received 403; curl requests succeeded and supplied the manifests used for these assertions. Both EAS publishing commands exited successfully.
