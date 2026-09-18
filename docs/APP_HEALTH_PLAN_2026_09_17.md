# App health plan — faster, smarter, less code (2026-09-17)

Phased, evidence-based. Each phase is small and independently shippable. Status:
`[ ]` todo · `[~]` in progress · `[x]` done · `[blocked]` needs owner/infra.

## Faster (perf) — biggest wins first

- `[blocked]` **P-1 R2 image resizing.** Media is the #1 slowdown: R2 serves
  full-res originals (measured **1.35 MB** per thumbnail); `optimizeImageUrl`
  only resizes Cloudinary URLs. Worker + client rewrite are **built** (commit
  5e0853f4, `cloudflare/varsityhub-image-resizer/`). Needs the owner to deploy
  the Worker + custom domain (or authorize the Cloudflare connector); then a
  1-line enable + OTA. → ~1.35 MB drops to ~50 KB app-wide.
- `[blocked]` **P-2 DB region.** API is us-west2, Postgres/Redis us-east4
  (~65 ms/query, several queries/screen). Co-locate API to us-east4 or add read
  replicas. Infra decision — app-wide win, no code.
- `[ ]` **P-3 Video faststart.** Some sub-8 MB clips skip the faststart
  re-encode and buffer before playing. Server-side upload-pipeline fix.

## Less code (bloat) — it's file size, not duplication (jscpd 1.49%)

Five monster files: GameDetailsScreen 4788 · feed 3651 · team-contacts 3569 ·
create-post 3379 · mobile-community 3308. Reduce incrementally, each step
verified by tsc + existing tests (no behavior change).

- `[~]` **P-4 GameDetailsScreen slim-down.**
  - P-4a extract `createStyles` (~1,150 lines) → `GameDetailsScreen.styles.ts`.
    Pure function of colorScheme, zero behavior risk. **(this phase)**
  - P-4b extract the data fetch (`vmPayload` build + Game.get/summary) into a
    `useGameDetails` hook — also moves it toward the react-query pattern.
  - P-4c split banner / posts / stories sections into child components.
- `[ ]` **P-5 feed.tsx slim-down** — same treatment (styles, then sections).
- `[ ]` **P-6 create-post / team-contacts / mobile-community** — same.

## Smarter (architecture)

- `[ ]` **P-7 react-query for feed + GameDetails.** They fetch imperatively
  across 10–14 effects; the rest of the app uses `useQuery`. Folds into P-4b/P-5
  and removes redundant fetches.
- `[blocked]` **P-8 dual-route consolidation.** 37 screens registered at `/x`
  and `/(tabs)/x` via bridge re-exports (180 route files). Nav audit is green
  and there's no drift, so this is cleanup, not a bug — a careful incremental
  nav refactor behind the route-integrity/nav-audit guardrails. Sequence last.

## Not a bug (verified — don't "fix")

- Map **"Other" filter** works: ingest links pro/NCAA events to seeded
  `SportsLeague` rows (slugs match: nfl/ncaaf/… with major/college levels), and
  "Other" correctly holds only untiered user/HS/fan events. It looks large only
  because most map events are untiered — expected.
- **Navigation/routes**: audit green (210 safeGoBack, 105 classified replaces,
  0 REVIEW, 0 dead-ends; route-integrity passes). Sprawling, not broken.

## Sequencing

Owner unblocks P-1 (biggest, cheapest, already built) and decides P-2 in
parallel. Claude proceeds through P-4 (GameDetailsScreen) in small verified
steps, then P-5/P-6, then P-7, then P-8 last.
