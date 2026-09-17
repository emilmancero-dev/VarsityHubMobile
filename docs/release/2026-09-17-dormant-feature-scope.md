# Dormant feature scope

Standings, playoff generation, and collage creation remain deferred feature work, not completed release items. This check does not certify externally published store listings.

## Existing surfaces checked

- `app/manage-season.tsx`: `selectedTab` starts as `schedule`; its setter is unused. Standings and playoff branches cannot be selected through this screen. No route parameter selects them.
- Root/tab layouts and app/component/hook references: no standalone standings or bracket route or navigation caller found. `GameCard` recognizes playoff event styling; that is not bracket generation.
- `app/season-stats.tsx` is reachable from manage-season and computes single-team summaries from completed game results. It is not league standings and must not be advertised as such.
- `server/prisma/schema.prisma`: Game carries home/away scores, winner and team references. `PATCH /games/:id/result` permits the creator, creating-side team managers and verified admins, with a 48-hour correction window for already-scored games (admin override). There is no inferred league ranking policy in this audit.
- `Post.createCollage` exists in `apiclient/entities.ts` but has no app/component/hook caller. `POST /posts/collage` intentionally returns 501 after verification/onboarding guards.
- Existing collage rendering/saving in `GameVerticalFeedScreen` and `CollageView` does not implement creation. Retain it; no dead-code deletion is authorized here.
- `docs/app-store-reviewer-notes.md` and repository marketing assets contain no matching standings/playoff/collage feature claim. Live store metadata was not inspected. `CODEBASE_MAP.md` and `SMOKE_CHECKLIST.md` previously listed collage without its disabled status; corrected separately.

## Decisions required for separate implementation

Standings/brackets need a governing league and sport scope, points for each outcome, tie-break order, authoritative final-result criteria, participating teams/season boundaries, seeding, byes, single/double elimination, advancement and correction behavior, and delegated staff permissions. Reuse server result authorization; do not let a client fabricate official rankings or results. Existing single-team statistics are not enough to decide these rules.

Collage creation needs a concrete output: a multi-photo post with separate originals (existing composer path), or one flattened composition with chosen layouts/crops. If a renderer is required, use only signed owner-bound uploads with existing upload limits and moderation; never fetch arbitrary supplied URLs. Existing display-only templates do not settle the desired creation workflow.

No scoring policy, bracket model, remote renderer, schema change, or paid transaction was introduced by this phase. Device verification, media cropping/mixed-media support and broader league ingestion remain separate open work.
