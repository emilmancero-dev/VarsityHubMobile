# Open items plan — 2026-09-17

Scoping for the "Why are these still not fixed" notes that are **not** a simple
OTA. The OTA-fixable items shipped Sep 17 (see `docs/COMMANDMENTS.md` →
"2026-09-17 audit"). This file covers the rest, sized so they can be
prioritized.

## Phase 1 (OTA) — status

- ✅ **#1c centered sport-emoji placeholder** (feed card + event-detail banner) —
  DONE this pass, tested. Ships on the next `eas update`.
- ⏳ **#11 crop** — moved to Phase 2 below (not a flag flip; see why).

## Phase 2 — client feature work (OTA-shippable, but real UI)

### #11 — crop in multi-photo upload

- **Why not done inline:** `create-post.tsx` uses `allowsEditing:false` because
  expo-image-picker's native crop only works with **single** selection. Turning
  it on would break the multi-select (up to 5) the owner explicitly wants.
- **Plan:** add a lightweight crop step in the preview strip using
  `expo-image-manipulator` (already OTA-safe): tap a thumbnail → crop modal →
  write cropped uri back into `picked`/`extraPicked`. ~1 modal component +
  wiring. Est: S–M.
- **Verify:** unit-test the crop-result plumbing; manual pass on device.

## Phase 2b — native build (NOT OTA — needs `eas build` + App Store submit)

### #9 — video picker / iCloud videos

- Native module `modules/varsity-media-picker` (VarsityMediaPicker) already
  exists (commit `be9c4f04`). The OTA fallback already opens Photos (not Files).
- **Plan:** confirm whether the live App Store binary (1.0.6) actually bundles
  the module; if not, cut an `eas build` + submit. Est: S (verify) or M (build).

### #10 — in-app camera modes (panorama, slo-mo, "and such")

- Current app uses `ImagePicker.launchCameraAsync` = stock still/video only.
  Native camera **modes** are not exposed by expo-image-picker.
- **Plan:** build a custom camera screen (`react-native-vision-camera` or
  `expo-camera`) to expose slo-mo (high-fps) + panorama + lens/zoom + flash +
  flip. This is a real feature, native, needs a build. Est: L.
- **Decision needed:** panorama in particular has no first-class RN API — confirm
  scope (may be "modes we can support" rather than literal panorama).

## Phase 3 — data / ingest (server)

### #3b — minor-league games (G-League, MLS Next, USL, XFL, …)

- No ingest source today; ESPN adapter covers pro + 5 NCAA D1 leagues only.
- **Plan:** add sources per league (ESPN has G-League/some; others need their
  own feeds) with `league_level = 'minor'`. Each league is its own adapter unit.
  Est: M per league; L for "every notable minor league."

### #4 — "Other" over-collects

- Filter logic is correct (test-pinned). Root cause: most events have
  `league_level = null` → fall into Other.
- **Plan:** classify `league_level` at ingest / on the `SportsLeague` link so
  tiered events leave Other. Est: M.

### NCAA D2/D3 (commandments)

- Roadmap per `docs/COMMANDMENTS.md` (CMD-INGEST-002). Not a bug. Est: L.

## Phase 4 — infra / perf (#5 event page slow, #6 feed slow)

- Perceived-speed code work already in place (prefetch, memoized cards, silent
  refresh, cursor pagination). Root cause is cross-region latency: API in
  us-west2, Postgres/Redis in us-east4 (~65 ms/query) — plus the commandments'
  own asks (geo-spatial index, read replicas).
- **Plan / decision needed (owner + infra):** co-locate API with DB region, add
  read replicas for feed/map, add a geo-spatial index on event coords. Est: M–L,
  infra change (not an OTA/code-only fix).

## Recommended order

1. Phase 1 OTA (ship the #1c placeholder + already-verified fixes) — immediate.
2. #11 crop (Phase 2, OTA) — small, closes a screenshot item.
3. #9 verify binary / #4 tier classification — both small, high clarity.
4. #10 camera + #3b minor leagues — larger features, need scope confirmation.
5. Phase 4 infra — owner + infra decision.
