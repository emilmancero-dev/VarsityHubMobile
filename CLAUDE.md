# VarsityHub Mobile — Claude Instructions

## Instruction Ownership

- `CLAUDE.md` is the authoritative instruction file for Claude Code in this repo.
- `AGENTS.md` is maintained for Codex and Codex-spawned agents. Do not assume Codex reads `CLAUDE.md` as its primary repo instruction source.
- Shared product facts must stay aligned across both files: stack, payments, navigation, deployment risk, and server-enforced invariants.
- If a rule changes for both tools, update both `CLAUDE.md` and `AGENTS.md` in the same pass.

## Stack

- React Native / Expo SDK 54 with Expo Router (file-based routing)
- Backend: Express + Prisma + PostgreSQL on Railway (project: `capable-trust`, service: `api`)
- State: React Context — `AuthProvider`, `PostCacheContext`, `OnboardingContext`, `NavigationHistoryContext`
- API: `api/entities.ts` is the typed API client and defines the domain calls directly; request/response schemas live in `api/schemas/*` and shared types in `api/types.ts`. (The old per-domain `api/teams.ts` / `api/games.ts` / `api/posts.ts` / `api/misc.ts` modules were consolidated into `api/entities.ts` — they no longer exist.)
- EAS Build for iOS/Android. OTA updates via Expo Updates.
- Payments (two distinct flows — do not conflate):
  - **Subscriptions**: Apple IAP (iOS), Google Play Billing via `react-native-iap` (Android, server-verified at `POST /payments/google/verify-purchase`), Stripe PaymentSheet (web fallback only)
  - **Ads**: Apple IAP (iOS), Stripe PaymentSheet (Android + web)
  - No Stripe links/redirects on any iOS path (Apple guideline). Android subscription checkout MUST stay on Play Billing — never route it to Stripe (Play policy).
- Uploads: Direct-to-Cloudinary (signed) with server-proxy fallback
- Push notifications: Expo Server SDK (`sendPushNotification` in `server/src/lib/notifications.ts`)
- Error tracking: Sentry with source maps

## System Architecture — one way to do each thing

Full verified reference: **`docs/ARCHITECTURE.md`** (keep it in sync if these change).
This is a **modular monolith on PostgreSQL + Redis + Railway** — NOT microservices/
Kubernetes, by design. Do not add K8s, Kafka, RabbitMQ, DynamoDB, Elasticsearch,
sharding, partitioning, sidecars, or SFTP — they are correctly absent at this scale.

Features must compose with these single patterns, never stack a parallel mechanism:

- **Outbound third-party calls → `runWithBreaker(name, fn)`** (`server/src/lib/circuitBreaker.ts`) for SendGrid / Cloudinary / Google Play / Apple. Stripe is the lone exception: SDK `timeout` + `maxNetworkRetries` (all 5 client constructions) — do not also breaker-wrap Stripe. No ad-hoc retry loops around external calls.
- **Screen data → react-query, the single `lib/queryClient.ts`.** Gate spinners on `isPending`, never `isFetching`. Never add a second QueryClient or parallel fetch cache. `PostCacheContext` is cross-screen post sharing, NOT a fetch cache — don't duplicate roles.
- **Realtime → the single `server/src/realtime/socketServer.ts`** (JWT handshake, per-conversation room auth, Redis adapter, websocket-only). Polling stays as the fallback, not removed.
- **Startup-once work → `runClusterOnce`** (`distributedLock.ts`) so it runs on one replica only; the scheduler worker still runs on all. Don't invent new leader election.
- **Everything cross-replica coordinates via Redis** (rate limit DB 1, BullMQ DB 0, cache DB 2, locks, socket adapter). No in-process shared state — it breaks under `numReplicas>1` (`railway.toml`).
- **RLS is enabled-not-forced** (dormant defense-in-depth). NEVER `FORCE` without a non-owner DB role + `SET LOCAL app.current_user_id` middleware — and remember `start.sh` runs `prisma migrate deploy` on every deploy, so any committed migration auto-applies to prod.
- **Sport-program layer (2026-07, Phase 0+1, ships dark; re-keyed 2026-07-10)**: `SportProgram` groups a team's siblings by `(organization_id, sport)` — unique constraint, so an org has at most one program per sport, full stop. `Team.gender` (`boys`/`girls`/`coed`) and `Team.level` (`varsity`/`jv`/`freshman`/`middle_school`/`unified`/`other`) are both nullable team attributes — a program's boys' and girls' teams are sibling level teams inside the same program, not separate programs. `Team.program_id` is nullable and additive — existing teams are unaffected until backfilled. Canonical sports live in `shared/sports-taxonomy.json`, loaded server-side by `server/src/lib/sportsTaxonomy.ts` (`normalizeSportToSlug`) and client-side by `constants/sports.ts`, which feeds the create-team sport picker. `server/scripts/backfill-sport-programs.ts` is the one-time migration path — dry-run by default, reports unresolved teams, never guesses a program. Program endpoints: `POST /organizations/:id/programs` is gated to the org owner or an active org member; `GET /organizations/:id/programs` is any authenticated user (public read). Billing still counts teams, not programs — the per-sport billing re-unit is Phase 4 and not yet built, and now counts one unit per SPORT (not per sport-gender pair), which lowers the expected unit count for schools running both boys' and girls' teams in a sport.
- **Sport-program public page (2026-07, Phase 3)**: `app/program-page.tsx` is a thin redirect shim (Phase 2, owner July-28: ONE sport page = team-page) — it fetches the program summary and redirects to the level/gender-first sub-team's team-page (Boys Varsity first), carrying from=program; a program with no visible sub-teams shows a graceful empty state. It has NO rendering surface of its own. Historically it WAS the canonical public surface for a sport program — one page per sport (re-shaped 2026-07-12): a sub-team picker — one tappable button per sub-team (Boys Varsity, Girls JV, …), ordered by level then gender — where tapping a sub-team shows just THAT sub-team's upcoming events (owner model, July 28: the whole sport is ONE page, sub-teams live inside it, no separate per-sub-team public pages), plus a follow button and the standard four states. Controls render only when they disambiguate. A sport that resolves to exactly ONE (visible) team is not shown as a program at all — program-page redirects to that team's team-page (with from=program to stop the reverse redirect), and the org links every sport straight to team-page (Phase 2), so a one-team sport never renders both a program wrapper and a team page (owner no-duplicates rule, 2026-07-27). The display logic is the pure `buildProgramSubTeams` helper in `constants/programs.ts` (pinned by `__tests__/program-labels.test.ts` + `app/__tests__/program-page.smoke.test.tsx`). There is NO public link to level-team pages: `app/team-page.tsx` is the canonical sport page (owner July-28): when a team has a `program_id`, its Events tab renders the sub-team picker (`buildProgramSubTeams`) for the whole sport — tap a sub-team to see its games — and it no longer redirects to program-page (Phase 1; the org/program-page routing flip to make it the SOLE page is Phase 2). Staff/admin surfaces (manage-teams, create-team, admin-teams, team-invites) pass `from=program` to open a level team deliberately — a contract in `__tests__/navigation-history-contracts.test.ts` enforces this. Three new endpoints: `GET /programs/:id/screen-summary` (program + `levels[]`, each with its serialized team and that level's games, plus counts — `server/src/routes/programs.ts`), `POST /programs/:id/follow` and `DELETE /programs/:id/follow`, and `GET /programs/:id` (branded share-landing page, `server/src/routes/shareLanding.ts`, falls back to a generic landing for unknown ids). Screen-summary privacy-filters level teams via `isTeamHiddenFromViewer` — hidden teams drop out of both `levels` and the `counts`, and an all-hidden program still returns 200 with `levels: []`. **Follow is a `ProgramFollow` intent ledger (`@@id([user_id, program_id])`) layered on top of the existing `TeamFollow` fan-out — feed clauses (`feed.ts`, `posts.ts`) are unchanged and still read `TeamFollow` only.** `is_following`/`followers_count` are intent-based: a `ProgramFollow` row means the viewer follows the program, and `followers_count` is a `ProgramFollow` count — this fixes the old union-read bug where following one level team made the whole program read as followed. `POST /follow` writes the `ProgramFollow` ledger row and fans out a `TeamFollow` row for every current active level team, stamped `via_program_id` (createMany + skipDuplicates, idempotent). `DELETE /follow` is lossless: it removes the `ProgramFollow` row plus only the `TeamFollow` rows stamped with _this_ program's id, so a pre-existing direct follow of a level team (unstamped) survives the unfollow. A level team added to a program later is reconciled exactly, not left stale: `fanOutProgramFollowersToTeam` (`server/src/lib/programFollowFanout.ts`) stamps a `TeamFollow` for every existing `ProgramFollow` user, awaited but wrapped so it can never fail the create/PUT request on team create and team PUT; it caps at 5000 followers per call and logs+captures when truncated, with a reconcile-script backstop for the overflow case still a documented follow-up (not yet built). This fan-out runs regardless of the newly-added team's privacy — a coach adding a private team to a program deliberately reaches existing followers; surfacing that to the coach before they add the team is a deferred UX follow-up. No `TEAM_FOLLOWED` notification fan-out on program follow (would spam staff once per follower). Group chats stay per level team — there is no program-level group chat. Deep links: `/programs` is in `SHAREABLE_PATHS` and the iOS `IOS_PATHS` AASA list, `AppLinks.program()`, and `program`/`programs` both map to `/program-page` in `utils/deepLinks.ts`. The Android `/programs` intent filter added to `app.json` is **native config — it ships only via `eas build`, never via `eas update` OTA.**

## Quick Start

```bash
npm run dev         # app (Expo dev client on :8081) + server concurrently
npm run dev:expo    # Expo dev client only
npm run dev:ios     # build/run iOS dev client on a connected device
npm run dev:server  # server only
npm run lint        # expo lint
npm test            # jest
```

## Hard Rules

**Never run `eas build` or `eas submit`.** These cost money. Provide the commands for the user to run themselves.

**Never use Expo Go.** Always use `npx expo run:ios` or `npx expo run:android` (dev client). Expo Go diverges from production behavior.

**Railway auto-deploys from `main`.** A bad push is an instant production outage. The app is live in the App Store.

**Do not change Railway env vars casually.** Sensitive vars like `JWT_SECRET`, OAuth keys, and Apple signing keys have production blast radius. Only rotate/change them when the task explicitly requires it, or when exposed-secret / provider-remediation work makes it necessary, and coordinate the impact first.

## Claude Worktrees

- `.claude/worktrees/` are Claude-local git worktrees for parallel investigation and implementation. They are operational tooling, not product deliverables.
- Never push `.claude/worktrees/` paths or treat Claude-local report output as app/server source changes.
- Generated local artifacts such as `.snyk-cache/`, `metro.pid`, and ad-hoc Claude reports should not be used as evidence that product code is dirty.
- When using a Claude worktree, pass the current task scope and decisions explicitly. Do not rely on another worktree's transient files as shared memory.

## Debugging Approach

Trace the real data flow: button tap → API call → middleware → handler → DB → response → client state. Don't do surface-level code review.

Check contract mismatches between client TypeScript types and server Zod schemas — they compile independently and can silently diverge. Test against the real API, not static analysis.

Check env vars, Railway logs, and build configs — not just source code.

## Production Must-Not-Break

- iOS bundle ID is `com.varsithub.varsityhub-ios` (typo, permanently registered in App Store Connect — cannot change)
- Apple Sign-In must stay visible whenever Google Sign-In is shown (Apple guideline)
- iOS payments must use Apple IAP only — no Stripe links/redirects on iOS
- Console logs are stripped in production (`babel-plugin-transform-remove-console` keeps error/warn)

## Security Constraints (Already Enforced Server-Side)

- Role escalation: owner role blocked on all generic membership/invite endpoints
- Ad booking horizon: 56-day max from today
- Checkout holds: fatal on failure — no partial bookings
- Team creation enforced inside `$transaction` (race-condition safe)
- Rate limiting requires `DISABLE_RATE_LIMITING=1` to disable (never set in Railway)
- Apple sim tokens require `ALLOW_APPLE_SIM_TOKENS=1` (dev only, never in Railway)
- Don't introduce client-trusted flags for things already enforced server-side

## Navigation Architecture

- Root `_layout.tsx` uses a single `<Stack>` with Expo Router file-based auto-registration — only `+not-found` is declared explicitly; every file under `app/` becomes a route automatically
- Screens shared between root Stack and `(tabs)` use one-line bridge re-exports (one real implementation, the other side re-exports it; direction varies)
- `safeGoBack` is the standard back helper (~180 uses)
- All three goBack implementations (`safeGoBack`, `NavigationHistoryContext.safeGoBack`, `useEdgeSwipeBack`) now use `getNavigationFallback()` from context — no more hardcoded `/(tabs)/feed` fallbacks
- `useEdgeSwipeBack` is disabled on screens with horizontal FlatLists
- Every screen implements its own back button (`headerShown: false` globally)

### Navigation Primitive Taxonomy

| Primitive                      | When to use                                                                                                                                                                                 | Dead-end risk                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `safeGoBack(router, fallback)` | **Default** for all back/dismiss/cancel actions. Returns the user to where they came from.                                                                                                  | None — fallback is only used when there's no history             |
| `router.push(route)`           | Forward navigation that the user should be able to back out of.                                                                                                                             | None                                                             |
| `router.replace(route)`        | **Auth gates** (unauthenticated redirect), **onboarding linear steps** (back would break the flow), **sequential purchase flows** (payment → confirmation). Stack is cleared intentionally. | High if misused — use `// nav-safe: <reason>` to document intent |
| `router.replace('/(tabs)')`    | **Banned.** Drops all history and lands on the tab root with no back stack. Use `safeGoBack(router, '/(tabs)/feed')` instead.                                                               | Always — pre-commit guardrail blocks this                        |

**When in doubt:** use `safeGoBack`. If the destination must be deterministic regardless of history (auth gate, purchase confirmation), use `router.replace` with a `// nav-safe: <reason>` comment so `npm run audit:navigation` classifies it correctly.

## Plans (Billing)

- Rookie: free, 4 teams, 50 roster, 6 authorized users/team
- Veteran: $0.99/mo/team (teams over 4), 100 roster, 5 authorized users/team
- Legend: $19.99/yr, unlimited teams + clubs + authorized users

## OTA Updates

- `runtimeVersion` uses `{ "policy": "appVersion" }` — auto-derived from `version` field, never hardcode a string
- OTA only delivers JS bundle changes. New native modules (ios/android native code) require a new binary via `eas build` + App Store submission
- Any native module added after the current App Store binary MUST be dynamically imported with try-catch (see `OfflineBanner.tsx` pattern for `@react-native-community/netinfo`)
- `fallbackToCacheTimeout: 0` means updates download in background, apply on next cold start — users need two app opens to see changes
- Always verify the App Store binary's runtime version matches what `eas update` is publishing
- **A code fix is NOT live until `eas update` is run.** Committing and pushing to main deploys the server (Railway auto-deploys) but does NOT update the client app. Every client-side fix requires an explicit `eas update --branch production` to reach users. Always remind the user to run this after any client fix.

## Post-mapper Consistency Rule

Three LIVE post mapper functions exist and MUST stay in sync:

- `mapHighlightToFeedPost` in `app/game-details/GameVerticalFeedScreen.tsx` — used for highlights API data (the parity reference)
- `toFeedPost` in `app/profile.tsx` — used for profile post data (the `/profile` + `/(tabs)/profile` route)
- `toFeedPost` in `app/team-page.tsx` — used for the team-page post viewer

**When fixing a field mapping in one, always check and fix the other two.** Caption/content/title fallback chains, `preview_url`, `has_upvoted`, `has_bookmarked`, `author` shape (`id`/`username`/`display_name`/`avatar_url` fallbacks) — if they diverge, bugs appear in one context but not the others. Enforced by `app/game-details/__tests__/post-mapper-consistency.test.ts` (full-chain parity across all three live mappers, not just a shared-prefix substring check) and `app/game-details/__tests__/GameVerticalFeedScreen.caption.test.ts` (caption chain). NOTE: a fourth copy formerly lived in `app/features/navigation/screens/ProfileScreen.tsx`; that screen was orphaned dead code and has been deleted.

## Quick Checks

```bash
# TypeScript errors (server)
npx tsc --noEmit --project server/tsconfig.json 2>&1 | tail -20

# Server test suite — MUST run via npm test (wraps jest with
# node --experimental-vm-modules for ESM). Bare `npx jest` on the full suite
# fails ~100 suites with "Cannot use 'import.meta' outside a module".
cd server && npm test

# Dark mode violations (text colors) — excludes shadowColor (not text) and
# lines tagged `// audit:` (reviewed-intentional contrast colors).
grep -rn "'#000\|'#333\|'#374151\|'#111\|black" app/ --include="*.tsx" | grep -vE "backgroundColor|shadowColor|audit:"

# Unbounded queries — Jest checks 50-line context windows; grep misses multi-line take: clauses
cd server && npx jest --testPathPattern="unbounded-queries" --no-coverage 2>&1 | tail -5

# Direct sgMail usage outside provider implementations
rg -n "sgMail.send" server/src --glob "*.ts" -g '!server/src/services/email/providers/**'

# Routes using req.user — ADVISORY ONLY (over-reports). requireAuth is applied
# at the router level, not on the same line, so this grep can't confirm coverage.
# Eyeball NEW hits in your diff; the REAL gate is the middleware test suite:
#   cd server && npm test -- --testPathPattern="middleware-coverage|requireOnboarded-bypass"
grep -rn "req.user" server/src/routes/ --include="*.ts" | grep -v requireAuth

# Navigation dead ends — classify every router.replace; flag any REVIEW items
npm run audit:navigation
```

## Release Workflow

- Canonical release path: `docs/release/RELEASE_WORKFLOW.md`
- Phase 1 local gate: `npm run release:verify:local`
- Phase 2 build gate: `npm run release:verify:build`
- Phase 3 runtime gate: `BASE_URL="https://your-api" npm run release:verify:runtime`
- Final sign-off: `docs/release/LAUNCH_READINESS_GATE.md`

## Git Workflow

**Never run `git stash apply` directly** — use `npm run stash:apply` instead. This applies the stash and immediately scans for unresolved conflict markers, listing every affected file with block counts.

**Before committing**, run `npm run check:conflicts` to ensure no `<<<<<<<` markers are present in source files. The pre-commit hook (`scripts/verify-guardrails.sh`) also enforces this automatically.

**Format before commit**: `npm run format` runs prettier across all source directories. The pre-commit hook (lint-staged) auto-formats staged files, but running it manually first avoids surprises.

**Quick checks before pushing to main**:

```bash
npm run check:conflicts         # no merge/stash markers
npm run format:check            # all files prettier-clean
npx tsc --noEmit --project server/tsconfig.json  # server TypeScript
npm run verify:error-envelope   # no raw res.status().json()
npm run audit:navigation        # classify all router.replace calls; flag REVIEW items
```

**NEVER bypass the commit guardrails.** Do not run `git commit --no-verify` (or `-n`), and do not disable the pre-commit / pre-push hooks. Those hooks run tsc-files, eslint, prettier, conflict-marker and secret scans on staged files — bypassing them has shipped un-typechecked, unformatted, and secret-leaking commits. If a hook blocks you, fix the cause; never skip it. `main` has no server-side branch protection, so the local hooks are the only gate before Railway deploys to prod.

**NEVER claim verification you did not run.** "TypeScript passes" means you ran BOTH `npx tsc --noEmit` (client) AND `npx tsc --noEmit --project server/tsconfig.json` (server) in a tree that HAS `node_modules`, and saw 0 errors — not one, not "skipped due to tooling," not assumed. A git worktree created without `node_modules` cannot typecheck the client; install deps or verify in a tree that can. The same rule holds for tests, lint, and "route reachable" claims: state what you actually ran and what it output, or don't claim it.

## Known Quirks

- Local `server/.env` has placeholder Cloudinary creds — uploads only work in production
- Sub-screens appear in both root Stack AND as `hiddenTab` in `(tabs)/_layout.tsx` — this is intentional Expo Router behavior
- Email template coverage has grown substantially; do not rely on hardcoded counts in docs. Check `TEMPLATE_IDS`, `REQUIRED_TEMPLATE_KEYS`, and `RECOMMENDED_TEMPLATE_KEYS` directly in `server/src/lib/email.ts`
- `service-account-key.json` in project root is gitignored — needed for Android Play Store submissions
- `@react-native-community/netinfo` is dynamically imported via try-catch in `OfflineBanner.tsx` — safe for OTA to binaries built before it was added
- Server geocoding depends on Railway `GOOGLE_MAPS_API_KEY`; mobile map rendering depends on EAS `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`
- Poll voting now hits the API for all events including those without a linked `gameId` (uses `eventId` as fallback). Previously event-only pages silently discarded votes.
- Signup email send is fire-and-forget — `POST /register` does not await SendGrid before responding.

## Code Rules

- Text colors MUST use `useColorScheme()` or theme constants — never hardcode `#000`, `#111827`, `#374151`, `black`
- Back navigation: use `safeGoBack(router, fallback)` — never `router.replace('/(tabs)')` (drops navigation history and lands users on the tab root with no back stack)
- Emails MUST go through `EmailService`/`sendTemplateEmail`; only provider implementations may call `sgMail.send()` directly
- Database: ALL `findMany` MUST have a `take` limit — no unbounded queries
- Auth: ALL routes accessing `req.user` MUST have `requireAuth` middleware
- Posts: users must pass `requireOnboarded` middleware to create posts
- Teams MUST have `organization_id` — no orphaned teams
- Run `npx tsc --noEmit --project server/tsconfig.json` after backend changes
- Test scripts go in `server/scripts/` — never in `src/`

## Team Role-Barrier Model (2026-07-06)

Team/org authorization is split into two tiers by `server/src/lib/teamAuthorization.ts`:

- **Full administration** — `canAdministerTeam()` (team owner/coach, or org owner): team settings edit, invite create/cancel, roster member add/remove/role-change, ownership transfer, moving a team to another org. `canArchiveTeam` is an alias.
- **Authorized user** — `canManageTeam()`/`canManageAnyTeam()` (team owner/manager/coach/assistant_coach, or org owner/manager): event/game create + approve/deny. This is the ONLY power managers/assistant_coaches have — they must never pass `canAdministerTeam`. (Athlete self-service team join requests were removed 2026-07-09 — rosters are coach-invite/direct-add only; the `TeamJoinRequest` table remains in the DB but nothing writes to it.)
- **Teams hold STAFF ONLY (2026-07-09)** — the `player`/`parent`/`member` team roles are retired: assignable roles are `manager`/`coach`/`assistant_coach`/`equipment`/`health_wellness` only (4 server whitelists + client pickers). Athletes connect to teams by FOLLOWING, never by membership. The `TeamRole` enum keeps the retired values (no migration); pre-existing athlete rows are archived by `server/scripts/archive-athlete-team-memberships.ts`, and the invite-accept endpoint 410s legacy retired-role invites. Plan "roster size" limits (50/100) are now vestigial — staff caps are the effective bound.
- **Organization management is owner-only** — `isOrgOwner()` gates org edit and org invite create/revoke; org managers have zero admin power at the org level (see Security Invariants below).
- Athletes/parents/members have no admin functions at all.

New team/org mutation endpoints must pick the correct tier explicitly — don't default to the older undifferentiated `canManageTeam` for anything beyond event/game approvals.

## Security Invariants (Do Not Break)

- **No client-controlled security-critical state** — payment status, approval state, role, and plan are always server-authoritative
- **Backend validation is law** — frontend validation is UX only; never rely on client-side checks for security
- **One source of truth per domain object** — plan from `getCanonicalPlan()`, membership from DB, approval from `AdminActivityLog`
- **Every protected route must check**: authentication → role → plan → ownership (server-side, not client)
- **IDOR guard on self-action**: users must never approve/reject/modify their own pending requests
- **Deep link params use allowlist** — `buildRouteParams()` in `utils/deepLinks.ts` enforces per-route key allowlists; do not bypass
- **Webhook lock failures return 503** (not 500) so Stripe retries instead of marking failed
- **Apple IAP cert chain must pin to `CN=Apple Root CA - G3`** exactly — loose substring match is not acceptable
- **Org invite creation is owner-only** (role-barrier model, 2026-07-06): only the organization owner may create or revoke org invites — org managers have no invite power at all (superseded the older "managers may invite at member level" rule)
- **Payment-success inner catch must surface non-auth errors on final retry** — no silent swallowing

### Audit-derived invariants (2026-07-14 · lands with stacked PRs #168 → #169 → #170 → #171)

Each rule below was a real, verified vulnerability (several live-confirmed against a running server). The fixes and their exploit-first regression tests live on the PR stack — until it merges to `main`, the named helpers/tests exist only on those branches. Do not reintroduce these patterns in new code, on any branch.

- **Game approval is always derived, never hardcoded** — every game write path (single, bulk, PUT) computes `approval_status` via `deriveGameApproval` (`server/src/lib/gameApproval.ts`). Hardcoding `approval_status: 'approved'` is banned; batch endpoints authorize **per row**, never `.some()` across all ids. Pin: `game-write-approval-parity.test.ts`.
- **Shared two-team resources: the creator side authorizes; both sides get notified** — game delete / result / edit gate on `creatorSideTeamIds()` (excludes the opponent). Opponent staff must never delete a shared game or overwrite the other team's reported score. Reassigning a game's team ids re-triggers opponent consent; coach edits are field-locked to `GAME_COACH_EDITABLE_FIELDS` (mirror of events). Pin: `authz-matrix-fixes.test.ts`.
- **Subscription webhooks must match the subscription id** — `shouldApplyStripeSubscriptionEvent` (`lib/stripeSubscriptionGuard.ts`): an event for an old Stripe sub must never downgrade a user now on a newer or other-rail (Apple/Google) sub. Google Play expiry is persisted **and** refreshed by the `google-play-reconciliation` job — read-side enforcement without the refresh job wrongly downgrades renewing users; they ship together. Pin: `stripe-subscription-guard.test.ts`.
- **Post `type` is a server-enforced whitelist** — `admin_broadcast` reaches every user's feed, so non-admin submissions are coerced to `post` server-side. Never accept feed-scope-changing types from the client. Pin: `fan-security.test.ts`.
- **Block filters merge, never clobber** — combining `getBlockedUserIds` `notIn` with an author scope must use `{ equals }` merge semantics; a block relationship must never widen a scoped query to a global one. Every content read (posts, DM history, game posts, profiles) applies block filtering. Pin: `fan-security.test.ts`, `blocked-cache-dedup.test.ts`.
- **Minor-protection gates fail closed** — adult↔minor DM requires an **accepted** follow (`status: 'accepted'` — a pending row grants nothing) and uses `isMinor()`/`isVerifiedAdult()` from `lib/userAge.ts` (null DOB = blocked). Never gate on `getUserAge() !== null`.
- **Post media hosts are allowlisted** — `media_url`/`poster_url` pass `isAllowedPostMediaUrl` (platform hosts + R2 + data:/relative); off-platform URLs are rejected (moderation bypass + tracking-pixel exfil vector).
- **Approval self-review IDOR guard covers games AND events** — the creator of a pending game/event can never approve or reject it (mirrors the coach-approval guard).
- **Coach auto-expire is keyed on application submit time** (`CoachApplication.submitted_at`), never on `User.created_at` — account age is not application age (this was the root cause of the admin-guard rejection loop).
- **Plan caps count pending invites** — the authorized-user cap is enforced at invite create AND accept time; a cap that only checks current members is a double-spend.
- **No ownerless resources** — `assertCanSelfDeleteUser` blocks account self-deletion by a sole team owner or sole org authority; org member remove/demote endpoints exist and team-membership removal/archive syncs group-chat membership (`removeUserFromTeamGroupChats`) so ex-staff lose chat access.
- **Share landings mirror the og.ts gates** — `shareLanding.ts` serves approved/non-cancelled/non-private/non-deleted resources only; private profiles never leak bio/avatar; program landings require an approved org with ≥1 public team.
- **Private teams are excluded from every public surface** — `getExcludedPrivateTeamIds` / `isTeamHiddenFromViewer` on highlights, posts, feed-bundle, `?team_id=`, and org serialization (org team lists: `status: 'active'`, `is_private: false`, bounded `take`).

The recurring failure pattern behind almost all of these: **a sibling write path bypassing a solid single-path pipeline without re-implementing its checks** (bulk vs single create, PUT vs POST, one webhook rail vs another). When adding a parallel path to anything, reuse the existing helper — never re-derive its authorization or state logic.

## PR Checklist (Run Before Each PR)

The enforcement gate derived from the **Security & Architecture Audit Standard** below. A PR passes only when every box is checked; the tags map each item back to the standard. Run the automated block first, then confirm the human-judgment items in the PR description. Every command here is a real, wired npm script or a grep that runs against this tree today.

```bash
# ── [GATE] Type safety — client + server, 0 new errors ────────────────────────
npx tsc --noEmit 2>&1 | tail -5
npx tsc --noEmit --project server/tsconfig.json 2>&1 | tail -5

# ── [GATE] Unbounded queries — Jest checks 50-line windows; grep misses multi-line take:
# Single suite runs fine without the ESM wrapper; the FULL server suite needs `npm test`.
cd server && npm test -- --testPathPattern="unbounded-queries" --no-coverage 2>&1 | tail -5; cd ..

# ── [GATE] Regression battery — the curated client+server invariant suites ─────
npm run test:regressions

# ── [ENG] Routes using req.user — ADVISORY (over-reports; requireAuth is ───────
# applied at the router level, not same-line). Eyeball NEW diff hits; the real
# gate is: cd server && npm test -- --testPathPattern="middleware-coverage|requireOnboarded-bypass"
grep -rn "req.user" server/src/routes/ --include="*.ts" | grep -v requireAuth

# ── [ENG] Direct sgMail usage outside providers ───────────────────────────────
rg -n "sgMail.send" server/src --glob "*.ts" -g '!server/src/services/email/providers/**'

# ── [ENG] No raw error responses — must use the error envelope ────────────────
npm run verify:error-envelope        # no bare res.status().json() (diff-scoped)
npm run verify:async-handlers        # every async route wrapped in asyncHandler

# ── [ENG] No hardcoded secrets introduced ─────────────────────────────────────
npm run verify:secrets

# ── [BIZ] Cache invalidation on user-state mutations ──────────────────────────
npm run verify:user-cache

# ── [GATE] Hardcoded dark text colors — excludes shadowColor + `// audit:` ─────
grep -rn "'#000\|'#111\|'#222\|'#333\|'#374151\|'#111827\|'#1a1a\|black" app/ --include="*.tsx" | grep -vE "backgroundColor|shadowColor|audit:"

# ── [ENG] Screens must not call fetch directly — route through api/* ───────────
# \b excludes refetch(); the trailing filter excludes member calls like X.fetch().
grep -rnE "\bfetch\(" app/ --include="*.tsx" | grep -v "// allow-fetch" | grep -vE "\.fetch\("

# ── [AUDIT] Navigation dead ends — classify all router.replace; 0 REVIEW items ─
npm run audit:navigation:fail        # nonzero exit if any UNREVIEWED item

# ── [GATE] P0 foundation — dep CVEs + rate-limit coverage + payments confidence
npm run verify:p0:foundation
```

Touched payments / auth / webhooks? Also run the matching invariant suite from the **Per-System Audit Playbook** below (e.g. `cd server && npm test -- --testPathPattern="payments-invariants|stripe-webhook-signature"`).

Human-judgment gate (cannot be grepped — confirm explicitly in the PR description):

- [ ] **[BIZ]** No client-controlled payment/approval/role/plan field reaches a security decision (server is authoritative). Server is the only writer of these via `getCanonicalPlan()` / `AdminActivityLog` / DB membership.
- [ ] **[AUDIT]** Validation parity: frontend constraints match the backend Zod schema — username (3–20), email format, password (8+), team/org names — or carry an `// intent:` note explaining the deviation.
- [ ] **[ENG]** Every new async screen renders loading, error, success, and empty states (all four reachable).
- [ ] **[ENG]** No silent `catch {}` in auth/payment/user flows; errors logged with `[context]` prefix and surfaced to the user.
- [ ] **[AUDIT]** New webhooks/retries/jobs are idempotent — replaying the same input is a no-op (replay test or written rationale).
- [ ] **[AUDIT]** New admin/approval action emits an `AdminActivityLog` row (actor/target/action/timestamp) via `server/src/lib/adminActivityLogger.ts`.
- [ ] **[AUDIT]** No silent fallback that changes security posture (e.g. a `catch` that downgrades a failed check to "allowed", or a default that grants instead of denies).
- [ ] **[GATE]** Security fix includes a before/after exploit reproduction; schema change includes migration status, generated-client refresh, and rollback note (remember `start.sh` runs `prisma migrate deploy` on every prod deploy).

## Security & Architecture Audit Standard

The one-page standard. Every rule is **tagged by type** and **testable** — it states how we know it passed, and where the control actually lives in this tree. Do not add a rule here without a `Verify:` clause that points to a real command, file, or test. The four types:

- **[AUDIT]** Audit Step — what a reviewer must actively check during a security/architecture pass.
- **[ENG]** Engineering Standard — how code must be structured (enforced in review/CI).
- **[BIZ]** Business Rule — VarsityHub-specific logic that must hold true (enforced server-side).
- **[GATE]** Release Gate — objective pass/fail before merge/ship.

**Finding classification:** rank every finding by **exploitability × blast radius × recoverability**, mapped onto the P0–P3 rubric — not a bare severity label. Every finding ships with proof: affected files (`path:line`), exploit/repro path, expected vs actual behavior, fix strategy. Every fix ships with verification: typecheck, the relevant invariant test, before/after repro, release-risk note.

### Layering (this repo — there is no `src/features/*`) — [ENG]

The generic "feature folder" model does **not** apply here. The real shape:

- **Client:** `app/` = Expo Router route files, kept thin (no `fetch`, no business logic) → `api/*` typed clients → shared code in `components/`, `hooks/`, `utils/`, `context/`, `constants/`, `lib/`, `shared/`. (`app/features/` exists but is legacy; prefer the dirs above. The orphaned `app/features/navigation/screens` was deleted — don't resurrect that pattern.)
- **Server:** `server/src/routes/*` = thin Express handlers → business logic in `server/src/lib/*`, integrations in `server/src/services/*`, gates in `server/src/middleware/*`, async work in `server/src/workers/*` + `server/src/jobs/*`.

**Verify:** route files (client `app/` and server `server/src/routes`) contain no direct DB access, no `fetch`, and no multi-step business logic — that lives one layer down.

### Threat-Model Phase (run first) — [AUDIT]

Enumerate, per feature: auth bypass, privilege escalation, payment spoofing, IDOR, webhook replay, stale-cache abuse, deep-link parameter injection.
**Verify:** each threat has a named server-side control (file:line) or a written "N/A because…" note in the audit output.

### Trust Boundary Map — [AUDIT]

| Boundary                        | Trust Level              | Control (where it lives)                                                                                                                                                   | Verify                                                                                          |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Client → API                    | Untrusted                | JWT-verified in `middleware/requireAuth.ts`; identity from token, never body                                                                                               | `req.user` derives from token, not body (grep checklist item)                                   |
| Stripe webhook                  | Trusted after sig-verify | `stripe.webhooks.constructEvent` + `x-idempotency-key` (`routes/payments.ts`)                                                                                              | `stripe-webhook-signature.test.ts`; replay is a no-op                                           |
| Apple S2S / IAP                 | Trusted after sig-verify | Cert chain pinned to exact `CN=Apple Root CA - G3` (`routes/payments.ts:2928,3410`) + dedup                                                                                | `iap-config-invariants.test.ts`, `apple-notification-dedup.test.ts`                             |
| SendGrid webhook                | Trusted after sig-verify | Signature check in `routes/sendgrid-webhook.ts`                                                                                                                            | `sendgrid-webhook.test.ts`                                                                      |
| Third-party auth (Google/Apple) | Trusted token only       | Token re-verified server-side, not a client claim (`routes/auth.ts`)                                                                                                       | `oauth-account-linking.test.ts`, `require-verified-oauth.test.ts`                               |
| Deep links                      | Untrusted                | `buildRouteParams()` per-route allowlist (`utils/deepLinks.ts`)                                                                                                            | unlisted param is dropped (test)                                                                |
| Admin / approval actions        | Privileged               | Must emit `AdminActivityLog` via `lib/adminActivityLogger.ts`                                                                                                              | audit-log row asserted (e.g. `coach-approval.test.ts`)                                          |
| Outbound 3rd-party calls        | Untrusted dependency     | `runWithBreaker()` (`lib/circuitBreaker.ts`); Stripe uses SDK timeout/retries instead                                                                                      | `circuit-breaker.test.ts`                                                                       |
| Uploads / media storage         | Untrusted content        | Signed Cloudinary upload + magic-byte type check + `uploadLimiter` (`routes/uploads.ts`); stored `media_url`/`poster_url` pass `isAllowedPostMediaUrl` (`routes/posts.ts`) | `media-host-allowlist.test.ts`, `api-uploads.test.ts`, `requireOnboarded-upload-bypass.test.ts` |

### Source-of-Truth Rules — [BIZ]

One writer per domain object; the client only ever reads.

- **Plan status** — server DB only via `getCanonicalPlan()` (`server/src/lib/userBillingState.ts`). **Verify:** no plan/entitlement decision derived from client state, props, or query params; `payments-invariants.test.ts`.
- **Approval state** — server DB only, recorded in `AdminActivityLog` (`server/src/lib/adminActivityLogger.ts`). **Verify:** approval never read from component props; IDOR self-action blocked (`coach-approval.test.ts`, `*-approval-race.test.ts`).
- **Org/team membership & role** — server DB only; re-fetched on protected-screen nav. **Verify:** protected screen refetches, not a cached client flag; `team-membership-authorization.test.ts`, `organization-data-access-invariants.test.ts`.
- **Payment status** — Stripe/Apple webhook confirmed; the `payment-success` screen verifies via API, never trusts query params. **Verify:** success path calls the verify endpoint; `payments-finalization.test.ts`.
- **Refund / reject / cancellation preserve financial consistency** — a refund, a rejected ad/booking, or a cancelled subscription reverses exactly the charge it maps to, idempotently, and in one transaction: never an entitlement left without a matching payment, nor a charge whose effect isn't reversed. Refund/cancel handlers (`routes/payments.ts`, `routes/ads.ts`) are the sole writers of the reversal. **Verify:** replaying a refund/cancel is a no-op, and it updates entitlement + records the reversal atomically — covered by / added to `payments-invariants` and `ad-state-invariants`.

### Architecture & Validation Standards — [ENG]

- **Thin routes** — see Layering above. **Verify:** route files have no DB/`fetch`/business logic.
- **Screens never call `fetch` directly** — go through `api/*`; data fetching via the single `lib/queryClient.ts` (react-query), spinners gated on `isPending`. **Verify:** `grep -rn "fetch(" app/` returns only `// allow-fetch` hits.
- **No client-controlled security-critical fields** (payment/approval/role/plan). A hidden or disabled UI control is not a permission check — the server gate must exist regardless. **Verify:** server ignores these on the request body (schema test); owner role blocked on generic membership/invite endpoints.
- **Sensitive responses return sanitized user objects only** — an API response serializes users through `sanitizeUser()` (`server/src/routes/auth.ts`), never a raw Prisma row (no password hash, tokens, or internal-only fields leak). **Verify:** `audit-p1-trust-boundaries.test.ts`; any new endpoint returning a user goes through the serializer.
- **Validation parity** across frontend/backend Zod/DB; any intended deviation carries an `// intent:` note. **Verify:** frontend constraints match the Zod schema (diff in PR checklist).
- **Every async flow is idempotent** (webhooks/retries/jobs/BullMQ). **Verify:** running the handler twice with the same input yields one effect; replay test per webhook.
- **No silent failures** in user/payment/auth flows, and **no fallback that changes security posture** (a `catch` must never downgrade a failed gate to "allowed"). **Verify:** no `catch {}` swallow; logs use `[context]` prefix and surface a user message; payment-success inner catch surfaces non-auth errors on final retry.
- **Errors use the envelope** — no raw `res.status().json()`; async handlers wrapped in `asyncHandler`. **Verify:** `npm run verify:error-envelope`, `npm run verify:async-handlers`.
- **All `findMany` carry a `take`.** **Verify:** `unbounded-queries.test.ts`.
- **Every screen renders loading, error, success, and empty states.** **Verify:** each of the four is reachable in the component.
- **Forms block double-submit** — a submit / pay / create / destructive action disables its control (or guards on an in-flight flag) until the request settles, and exposes an actionable recovery state on failure; a second tap during flight must issue no second request. **Verify:** the primary action is `disabled` while `isLoading`/`isSubmitting`/`saving` (pattern: `app/report-abuse.tsx`, `app/feed.tsx`); a payment/create action can never fire twice from one screen.
- **Every deep link validates params** — fails closed for privileged actions, graceful for public nav. **Verify:** missing/malformed param test per route.
- **Every admin action is auditable** (actor/target/action/timestamp). **Verify:** `AdminActivityLog` row asserted in a test.

### Observability & Rollback — [ENG]

- **Structured logging:** user/payment/auth failures log with a `[context]` prefix; exceptions go to Sentry, never raw stacks into the DB (see `dataExportWorker.ts` error-category pattern). **Verify:** grep for the `[context]` prefix on new catch blocks.
- **Correlation IDs on payment/auth flows** — every request carries an `x-request-id` (honored from the client/Railway header or minted per request), threaded through the logs and echoed on the response, so a payment or auth failure is reconstructable end-to-end from one id (not just the `[context]` tag). **Verify:** `server/src/middleware/logging.ts` sets `req.requestId` + the `x-request-id` response header, and payment/auth log lines are prefixed `[${requestId}]`; a new payment/auth flow does not log under a bare context with no id.
- **Admin auditability:** every privileged mutation writes `AdminActivityLog`. **Verify:** asserted in a test.
- **Migrations auto-apply:** `start.sh` runs `prisma migrate deploy` on every Railway deploy — any committed migration hits prod automatically. **Verify:** schema change PRs include migration status + an explicit rollback note (forward-fix or down-migration).
- **Every change has a safe revert path** — a risky behavior change ships behind a feature flag (an env-var flag like `FEST_RECAP_PINNED`, flipped + OTA to revert) OR with a documented forward-fix / down-migration; never a change whose only undo is a new store binary. Flags default to the safe state. **Verify:** the PR names the revert path (which flag to flip, or which migration reverses it), and any new flag's default is the safer behavior.
- **No in-process shared state** — coordinate cross-replica via Redis (rate-limit DB 1, BullMQ DB 0, cache DB 2, locks, socket adapter); startup-once work via `runClusterOnce`. **Verify:** new shared state goes through Redis, not module globals (breaks at `numReplicas>1`).

### Per-System Audit Playbook — [AUDIT]

Apply the per-feature loop (map → trace data flow → enumerate gates → check drift → check idempotency → check silent failures) to each major system, and run its invariant suite.

| System                | Routes / source of truth                                                      | Run                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments & Subs       | `routes/payments.ts`; `getCanonicalPlan()`; Stripe/Apple webhooks             | `cd server && npm test -- --testPathPattern="payments-invariants\|stripe-webhook-signature\|payments-finalization\|iap-config-invariants"` + `npm run verify:p0:foundation` |
| Ads                   | `routes/ads.ts`; 56-day horizon; checkout holds fatal-on-failure              | `cd server && npm test -- --testPathPattern="ad-state-invariants\|ad-approval-race"` + `npm --prefix server run verify:ad-approval-flow`                                    |
| Teams & Orgs          | `routes/organizations.ts`, team routes; DB membership; org_id required        | `cd server && npm test -- --testPathPattern="team-membership-authorization\|team-transfer-authorization\|team-invite-race-guards\|organization-data-access-invariants"`     |
| Auth, Roles & Onboard | `routes/auth.ts`; `middleware/requireAuth\|requireVerified\|requireOnboarded` | `cd server && npm run test:invariants` + `npm test -- --testPathPattern="auth-security-hardening\|requireOnboarded-bypass\|oauth-account-linking"`                          |
| Approvals & Admin     | coach/event/game approval; `AdminActivityLog`; IDOR self-action guard         | `cd server && npm test -- --testPathPattern="coach-approval\|event-approval-race\|games-approval-race\|admin-reports-race-guards"`                                          |
| Feed / Post mappers   | `mapHighlightToFeedPost`, `toFeedPost` (see Post-mapper Consistency Rule)     | `npx jest app/game-details/__tests__/post-mapper-consistency.test.ts`                                                                                                       |
| Runtime (post-deploy) | live Railway API health + auth                                                | `cd server && BASE_URL=… HEALTH_CHECK_SECRET=… npm run verify:production-health` + `npm run verify:auth-canary`                                                             |

### Per-Feature Audit Steps — [AUDIT]

1. Map all components: routes, Zod schemas, Prisma models, frontend screens. **Verify:** component map in the audit note.
2. Trace data flow: client → `api/*` → route → middleware → `lib/*` → DB → response → client state. **Verify:** flow documented end-to-end.
3. Identify every permission check point; confirm it exists server-side (auth → role → plan → ownership). **Verify:** each gate has a server test.
4. Compare frontend vs backend Zod vs DB constraints for drift. **Verify:** drift table with `// intent:` notes for any deviation.
5. Check every async flow for idempotency. **Verify:** replay test per webhook/job.
6. Verify every `catch` — no silent swallowing and no security-posture downgrade in auth/payment/critical paths. **Verify:** grep + manual review.

### Release Gate — [GATE] (objective pass/fail)

- [ ] `npx tsc --noEmit` and `npx tsc --noEmit --project server/tsconfig.json` — 0 new errors
- [ ] `npm run lint` — 0 errors (warnings acceptable with justification)
- [ ] `npm run release:verify:local` — exits 0
- [ ] `npm run test:regressions` — passes
- [ ] No unbounded `findMany` without `take` (`unbounded-queries.test.ts`)
- [ ] No `req.user` access without `requireAuth` middleware
- [ ] No hardcoded dark text colors in tsx files
- [ ] `npm run audit:navigation:fail` — 0 REVIEW items
- [ ] Frontend length/format constraints match backend Zod schemas
- [ ] Prisma schema indexed columns have matching migration SQL
- [ ] Security fix includes before/after exploit reproduction
- [ ] Schema change includes migration status, client refresh, and rollback note
- [ ] Release candidate passes real-device smoke (not just simulator): auth sign-in, one payment/ad purchase, messaging send+receive, and light+dark mode

### Deck-friendly commandments (the short version)

Thin routes, logic one layer down · Backend validation is law, frontend is guidance · No client-controlled security-critical state · One source of truth per domain object · Every protected action checks auth/role/plan/ownership server-side · Every async flow is idempotent · No silent failures and no fallback that changes security posture · No duplicate logic across routes/features · Every screen handles loading/error/success/empty · Every deep link fails gracefully and safely · Every admin action is auditable · Forms block double-submit · Payment/auth flows carry a correlation id · Refunds and cancellations reverse exactly and idempotently · Coordinate cross-replica via Redis, never in-process · Every release change is testable and reversible.

## Working Style

- Be surgical — only change what's needed for the task
- Don't add abstractions, helpers, or error handling for scenarios that can't happen
- Don't refactor or clean up code beyond what was asked
- Fix real bugs, not theoretical issues
- When the fix is in one file, don't touch five
