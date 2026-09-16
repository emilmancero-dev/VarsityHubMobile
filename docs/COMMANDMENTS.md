# VarsityHub Commandments — Code-Verified Edition

> **Status:** This is the canonical, reconciled version of the owner's
> `VARSITYHUB COMMANDMENTS` spec. Each claim is classified below. `CURRENT`
> means the described behavior exists now; it does not mean every interaction
> has full end-to-end coverage. Load-bearing constants and the event-card claims
> are pinned by `server/src/__tests__/commandments-invariants.test.ts`.
>
> Sections marked **ROADMAP** are intended future behavior, not current claims.
> Sections marked **UI TODO** are open product asks (from the spec screenshots),
> tracked separately, not asserted here.

## Claim registry

Stable IDs make review comments, tests, and historical audits refer to the same
claim. `POLICY` records an intentional choice that differs from the original
spec. `OPEN` is a known unresolved difference. `ROADMAP` is future scope.

| ID              | Status  | Claim                                                                                    |
| --------------- | ------- | ---------------------------------------------------------------------------------------- |
| CMD-EVENT-001   | CURRENT | Standard, all-day, and extended live windows are 8h, 12h, and 18h.                       |
| CMD-EVENT-002   | POLICY  | Posts and stories use the same flat 3 km geofence.                                       |
| CMD-EVENT-003   | CURRENT | Eligible event posters receive a seven-day post grace period.                            |
| CMD-EVENT-004   | CURRENT | A post accepts at most five media items and 4,000 text characters.                       |
| CMD-EVENT-005   | CURRENT | Watching is a future-event action; live and past cards show the event-page post count.   |
| CMD-EVENT-006   | CURRENT | The profile Events tab is SHIPPED attendance history backed by verified posting unlocks. |
| CMD-EVENT-007   | CURRENT | Event pages with zero posts are purged after their live window closes.                   |
| CMD-FEED-001    | CURRENT | Event activity controls gold map pins and live-card borders.                             |
| CMD-ADS-001     | CURRENT | Weekday and weekend ad blocks cost $4.99 and $7.99.                                      |
| CMD-ADS-002     | POLICY  | Ads can be booked up to 56 days ahead.                                                   |
| CMD-INGEST-001  | POLICY  | Schedule ingest uses ESPN and the implemented league list.                               |
| CMD-INGEST-002  | ROADMAP | NCAA expansion beyond the five Division I ESPN leagues.                                  |
| CMD-MEDIA-001   | POLICY  | Uploaded photo/video media has a 150 MB hard cap.                                        |
| CMD-CONTENT-001 | OPEN    | The original 800-character post limit remains 4,000 in current code.                     |

---

## Event Pages — core rules

An Event Page is a **geo-fenced, time-windowed** content hub for a single event.
Anyone at the right place during the live window can post photos / videos / text.
Competitive games also carry a poll and two teams; standard events (formals,
fundraisers, team outings) work the same way without a poll.

### Live window (the "8-hour standard")

Modeled as a fixed window around the event **start** time, not derived from the
event's end time.

| Window         | Opens             | Closes         | Total   | Code                                                                |
| -------------- | ----------------- | -------------- | ------- | ------------------------------------------------------------------- |
| Standard       | 2h before start   | 6h after start | **8h**  | `DEFAULT_LIVE_WINDOW_HOURS_BEFORE_START = 2`, `..._AFTER_START = 6` |
| Coach all-day  | 2h before start   | —              | **12h** | `COACH_ALL_DAY_LIVE_WINDOW_HOURS = 12`                              |
| Coach extended | (one-time unlock) | —              | **18h** | `COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS = 18`                     |

- All constants live in `server/src/lib/geofencing.ts` (which cites "the
  commandments standard" directly).
- The spec's "2h before + 4h during + 2h after" phrasing only equals 8h for a
  4-hour event. The implementation uses the fixed 8h/12h/18h windows above.

### Posting & persistence

- **Post** to an event: must be inside the geofence **and** inside the live
  window.
- **Stories:** live window + geofence **only** — no grace period.
- **7-day grace:** a user who posted during the live window can add/edit posts
  for **7 days** after the event (`REGULAR_POST_GRACE_WINDOW_MS = 7 days`).
  Viewing a past event page is permanent; only _posting_ is capped at 7 days.
- After 7 days the event stays viewable via the calendar/map database.
- **Media cap: up to 5 items per post** (`posts.ts` `media_urls .max(5)`, comment
  cites this doc). Photos and videos can be mixed.
- **Post text cap:** currently **4000 chars** server-side (`posts.ts`
  `content .max(4000)`). _The original spec said 800 — see "Open reconciliations"._
- Anyone can interact (like / comment / vote) regardless of location.
- Polls: competitive games only; any VarsityHub user can vote.
- **Watching ("TV") button:** before an event starts, users can tap the TV emoji
  to add or remove themselves from the watching count. Once the event is live,
  and for all past events, the card replaces Watching with the event page's post
  count.
- **Profile attendance history:** the profile Events tab shows event pages where
  the user passed the geofence and posted a post or story. It uses the same
  `EventFeedCard` presentation as the feed and remains tied to the attendance
  ledger even if that user's content is later deleted.

### Push reminders (users who posted)

Day 1 (24h after), Day 4 (3 days left), Day 7 (last day) — scheduled via
`scheduleEventPostingGraceReminders` in `server/src/lib/notifications.ts`. Coach
game reminders also fire 12h and 1h before start.

### Events without posts

If an event's live window closes with zero posts, it is removed from the
database; it stays visible on feed/map until the window expires.

---

## Feed & Map

1. **Feed and map are in sync** — same events, same status.
2. Active time windows are identical across both surfaces.
3. **Sport filter** on top of the feed controls what appears.
4. **Search** filters by team name, school, or venue (most-recent-date scoped).
5. All users can see all events on the map.

### Pin color / tier system

Colored by league **tier** (`components/EventMap.tsx`):

| Pin        | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| **Red**    | Major (top-tier / pro leagues)                            |
| **Blue**   | Minor (development / minor leagues)                       |
| **Silver** | NCAA (see ingest scope below)                             |
| **Green**  | Other (intramural, pickup, camp, clinic, youth, HS, JUCO) |
| **Gold**   | Any tier **with at least one post**                       |

**Gold transformation:** the first post during the live window turns the map pin
gold and flips the feed card border red → gold, in real time.

### Ads on feed/map

- Banner ad between event cards (roughly every 3 events), geo-targeted to the
  viewer's zip.
- **Max 2 businesses per zip**, no touching adjacent zip radiuses (buffer zone).
- No overlay ads on the map; no ads on event pages.

---

## Advertising

- **Pricing:** Mon–Thu block **$4.99**, Fri–Sun block **$7.99**
  (`server/src/utils/adPricing.ts`; the spec's "$5 / $8" is the rounded form).
- One fee covers all selected days in that weekday/weekend block that week.
- **All sales final** — no refunds, no prorating.
- **Payment rails:** Apple IAP on iOS; Stripe PaymentSheet on Android + web.
  (Ads never use Play Billing; that's subscriptions only.)
- Every ad carries a "Sponsored" label, business name + CTA button.
- Moderation (automated image/content scan) runs **before** the ad goes live;
  the founder can take any ad down.
- Advertisers get click/visit tracking (impressions + clicks).
- **Booking horizon: 56 days** from today (deliberate safety cap — pinned by
  `iap-config-invariants.test.ts`). _The spec's "12 months in advance" is not
  implemented — see "Open reconciliations"._

---

## Game ingest pipeline

> **CORRECTION:** The spec named **SeatGeek** as the data source. There is **no
> SeatGeek integration** in the codebase. Ingest runs on **ESPN**.

- **Source:** ESPN (`server/src/lib/proSchedule/espnAdapter.ts`), composed via
  `compositeAdapter.ts`, plus a dedicated **WWE** adapter. Manual entry by
  coaches is the secondary path.
- **Cadence:** daily ingest (8am), documented in the scheduler.
- **Leagues currently ingested** (`ESPN_PATH`): NFL, NBA, WNBA, MLB, ATP, WTA,
  and NCAA **football, men's basketball, women's basketball, baseball, men's
  hockey**.
- **NCAA scope:** Division I only, the five leagues above — **not** "D1–D3, all
  sports." Broader division/sport coverage is **ROADMAP**, not a current claim.
- Geo-fence for posting is a flat **3.0 km** radius (`geofencing.ts`, posts and
  stories) **by design** (owner decision 2026-09-15). Rationale: one radius keeps
  every event page consistent; 3km fully covers any arena/stadium footprint
  including parking/tailgate (largest venues span ~1–1.5km); and, critically, it
  absorbs indoor GPS drift (arena bowls/roofs degrade GPS by 50–200m+) so real
  attendees inside the building are never falsely blocked. The tradeoff — some
  non-attendees within ~1.9mi in dense metros can post — is accepted and matches
  the "fans in the vicinity" intent. _Capacity-scaled radius tiers were
  considered and **rejected** (they'd shrink small venues, where drift bites
  hardest)._

### NCAA events without a stadium image

Show the sport emoji centered where the venue photo would be, over a gradient of
the home team's colors. Ad visibility does not suppress the emoji.

---

## Media & validation

- **Video/photo size:** hard cap **150 MB** (`constants/video.ts`,
  `mediaUploadSession.ts`). _The spec's "compress >500MB video / >50MB photo"
  thresholds are not the enforced numbers — see "Open reconciliations"._
- Media count: >5 items per post is rejected (see cap above).
- Content policy: posts violating terms are flagged for moderation, not
  published. Ads run the same screening before going live.

---

## Open reconciliations (spec ≠ code, deliberately)

These are the four places the spec and code disagree. Direction chosen by the
owner on 2026-09-15:

| Claim in original spec           | Reality in code         | Resolution                                                                              |
| -------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Data source = SeatGeek           | ESPN (no SeatGeek code) | **Doc corrected to ESPN** ✅                                                            |
| NCAA D1–D3, all sports           | D1, 5 ESPN leagues      | **Doc narrowed; expansion is roadmap** ✅                                               |
| Post text ≤ 800 chars            | 4000 chars              | Cheap code change — pending owner go-ahead                                              |
| Capacity-scaled geo-fence radius | Flat 3.0 km             | **Kept flat 3km by design** ✅ (consistency + absorbs indoor GPS drift; tiers rejected) |
| Ad horizon 12 months             | 56 days                 | **Kept 56-day cap; doc corrected** ✅                                                   |
| Media 500MB video / 50MB photo   | 150 MB                  | **Kept 150 MB; doc corrected** ✅                                                       |

Internal spec contradictions resolved here: ingest window is a rolling horizon
(the spec said both "30 days" and ">90 days"); the DB-schema section in the spec
is illustrative — the real backend is Prisma with 58 models (`Ad`, `Story`,
`ProTeam`, …), not the `advertisements` / `posts.is_story` / `seatgeek_id`
shapes shown there.

---

## UI TODO (from spec screenshots — not accuracy claims)

Tracked separately, not asserted by tests: true dark-mode (grey, not purple),
scroll-trap fix, blank upload tab, highlights tab positioning, event-page load
flicker, remove "You're here" / "Multiple" from the map legend, metallic
bronze/silver/gold buttons, cross-dissolving sport-emoji loader, and full-screen
post swipe.

The profile Events tab is SHIPPED and documented by `CMD-EVENT-006`. Several
dark-mode, gradient, and gold-border items also shipped in the 2026-09-14/15
passes.
