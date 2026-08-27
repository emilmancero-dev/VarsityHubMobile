# VarsityHub — Agent Usage Guide

## Codex Context Model

- In Codex, spawned agents start isolated unless the caller explicitly forks context or includes the needed background in the task prompt.
- `AGENTS.md` is instruction input for the session, not a Claude-style lazy-loaded memory system. Do not assume nested `CLAUDE.md`-style composition by directory.
- If a subagent needs prior audit state, scope boundaries, or decisions already made in the main thread, pass that context directly instead of assuming inheritance.
- Put repo-wide workflow rules here. Put task-specific role instructions in the spawned agent prompt.

## Instruction Ownership

- `AGENTS.md` is the authoritative repo instruction file for Codex and Codex-spawned agents.
- `CLAUDE.md` is maintained for Claude Code and Claude-managed worktrees. It is not the live instruction source for Codex.
- Shared product facts that affect both tools must stay aligned across both files: stack, payments, navigation, server-side invariants, and deploy rules.
- If `AGENTS.md` and `CLAUDE.md` ever disagree, update both files rather than relying on one tool to infer intent from the other.

## Claude Worktree Hygiene

- `.claude/worktrees/` are local Claude worktrees and must never be pushed.
- Treat files under `.claude/` inside a linked worktree as Claude-local tooling unless they are intentionally tracked repo assets.
- Generated local artifacts such as `.snyk-cache/`, `metro.pid`, and Claude-local report output must not be treated as product changes.
- Before concluding a branch is dirty, distinguish tracked source changes from Claude-local worktree noise.

## System Architecture — one way to do each thing

Full verified reference: **`docs/ARCHITECTURE.md`** (kept in sync with `CLAUDE.md`).
VarsityHub is a **modular monolith on PostgreSQL + Redis + Railway** (Cloudinary
media, Sentry observability) — NOT microservices/Kubernetes, by design. Do NOT
introduce K8s, Kafka, RabbitMQ, DynamoDB, Elasticsearch, sharding, partitioning,
sidecars, or SFTP — they are correctly absent at this scale.

New code composes with these single patterns; never stack a parallel mechanism:

- **Outbound third-party calls → `runWithBreaker(name, fn)`** (`server/src/lib/circuitBreaker.ts`) for SendGrid / Cloudinary / Google Play / Apple. Stripe is the exception: SDK `timeout` + `maxNetworkRetries` (all 5 client constructions), not a breaker. No ad-hoc external-call retry loops.
- **Screen data → react-query via the single `lib/queryClient.ts`**; spinner on `isPending`, never `isFetching`. No second QueryClient / parallel fetch cache. `PostCacheContext` = cross-screen post sharing, not a fetch cache.
- **Realtime → the single `server/src/realtime/socketServer.ts`** (JWT handshake, per-conversation room auth, Redis adapter, websocket-only). Polling stays as fallback.
- **Startup-once work → `runClusterOnce`** (`distributedLock.ts`); scheduler worker runs on all replicas. No new leader election.
- **Cross-replica state lives in Redis** (rate limit DB 1, BullMQ DB 0, cache DB 2, locks, socket adapter). No in-process shared state — it breaks under `numReplicas>1` (`railway.toml`).
- **RLS is enabled-not-forced** (dormant). NEVER `FORCE` without a non-owner DB role + `SET LOCAL app.current_user_id` middleware; `start.sh` auto-applies migrations to prod on every deploy.
- **Sport-program layer (2026-07, Phase 0+1, ships dark; re-keyed 2026-07-10)**: `SportProgram` groups a team's siblings by `(organization_id, sport)` — unique constraint, so an org has at most one program per sport, full stop. `Team.gender` (`boys`/`girls`/`coed`) and `Team.level` (`varsity`/`jv`/`freshman`/`middle_school`/`unified`/`other`) are both nullable team attributes — a program's boys' and girls' teams are sibling level teams inside the same program, not separate programs. `Team.program_id` is nullable and additive — existing teams are unaffected until backfilled. Canonical sports live in `shared/sports-taxonomy.json`, loaded server-side by `server/src/lib/sportsTaxonomy.ts` (`normalizeSportToSlug`) and client-side by `constants/sports.ts`, which feeds the create-team sport picker. `server/scripts/backfill-sport-programs.ts` is the one-time migration path — dry-run by default, reports unresolved teams, never guesses a program. Program endpoints: `POST /organizations/:id/programs` is gated to the org owner or an active org member; `GET /organizations/:id/programs` is any authenticated user (public read). Billing still counts teams, not programs — the per-sport billing re-unit is Phase 4 and not yet built, and now counts one unit per SPORT (not per sport-gender pair), which lowers the expected unit count for schools running both boys' and girls' teams in a sport.
- **Sport-program public page (2026-07, Phase 3)**: `app/program-page.tsx` is a thin redirect shim (Phase 2, owner July-28: ONE sport page = team-page) — it fetches the program summary and redirects to the level/gender-first sub-team's team-page (Boys Varsity first), carrying from=program; a program with no visible sub-teams shows a graceful empty state. It has NO rendering surface of its own. Historically it WAS the canonical public surface for a sport program — one page per sport (re-shaped 2026-07-12): a sub-team picker — one tappable button per sub-team (Boys Varsity, Girls JV, …), ordered by level then gender — where tapping a sub-team shows just THAT sub-team's upcoming events (owner model, July 28: the whole sport is ONE page, sub-teams live inside it, no separate per-sub-team public pages), plus a follow button and the standard four states. Controls render only when they disambiguate. A sport that resolves to exactly ONE (visible) team is not shown as a program at all — program-page redirects to that team's team-page (with from=program to stop the reverse redirect), and the org links every sport straight to team-page (Phase 2), so a one-team sport never renders both a program wrapper and a team page (owner no-duplicates rule, 2026-07-27). The display logic is the pure `buildProgramSubTeams` helper in `constants/programs.ts` (pinned by `__tests__/program-labels.test.ts` + `app/__tests__/program-page.smoke.test.tsx`). There is NO public link to level-team pages: `app/team-page.tsx` is the canonical sport page (owner July-28): when a team has a `program_id`, its Events tab renders the sub-team picker (`buildProgramSubTeams`) for the whole sport — tap a sub-team to see its games — and it no longer redirects to program-page (Phase 1; the org/program-page routing flip to make it the SOLE page is Phase 2). Staff/admin surfaces (manage-teams, create-team, admin-teams, team-invites) pass `from=program` to open a level team deliberately — a contract in `__tests__/navigation-history-contracts.test.ts` enforces this. Three new endpoints: `GET /programs/:id/screen-summary` (program + `levels[]`, each with its serialized team and that level's games, plus counts — `server/src/routes/programs.ts`), `POST /programs/:id/follow` and `DELETE /programs/:id/follow`, and `GET /programs/:id` (branded share-landing page, `server/src/routes/shareLanding.ts`, falls back to a generic landing for unknown ids). Screen-summary privacy-filters level teams via `isTeamHiddenFromViewer` — hidden teams drop out of both `levels` and the `counts`, and an all-hidden program still returns 200 with `levels: []`. **Follow is a `ProgramFollow` intent ledger (`@@id([user_id, program_id])`) layered on top of the existing `TeamFollow` fan-out — feed clauses (`feed.ts`, `posts.ts`) are unchanged and still read `TeamFollow` only.** `is_following`/`followers_count` are intent-based: a `ProgramFollow` row means the viewer follows the program, and `followers_count` is a `ProgramFollow` count — this fixes the old union-read bug where following one level team made the whole program read as followed. `POST /follow` writes the `ProgramFollow` ledger row and fans out a `TeamFollow` row for every current active level team, stamped `via_program_id` (createMany + skipDuplicates, idempotent). `DELETE /follow` is lossless: it removes the `ProgramFollow` row plus only the `TeamFollow` rows stamped with _this_ program's id, so a pre-existing direct follow of a level team (unstamped) survives the unfollow. A level team added to a program later is reconciled exactly, not left stale: `fanOutProgramFollowersToTeam` (`server/src/lib/programFollowFanout.ts`) stamps a `TeamFollow` for every existing `ProgramFollow` user, awaited but wrapped so it can never fail the create/PUT request on team create and team PUT; it caps at 5000 followers per call and logs+captures when truncated, with a reconcile-script backstop for the overflow case still a documented follow-up (not yet built). This fan-out runs regardless of the newly-added team's privacy — a coach adding a private team to a program deliberately reaches existing followers; surfacing that to the coach before they add the team is a deferred UX follow-up. No `TEAM_FOLLOWED` notification fan-out on program follow (would spam staff once per follower). Group chats stay per level team — there is no program-level group chat. Deep links: `/programs` is in `SHAREABLE_PATHS` and the iOS `IOS_PATHS` AASA list, `AppLinks.program()`, and `program`/`programs` both map to `/program-page` in `utils/deepLinks.ts`. The Android `/programs` intent filter added to `app.json` is **native config — it ships only via `eas build`, never via `eas update` OTA.**

## Available Agent Types

### Explore

**When to use:** Finding files by pattern, searching code for keywords, answering "how does X work" questions.
**Example tasks:**

- "Where are all the places we call `sendPushNotification`?"
- "How does the refresh token flow work end to end?"
- "Find all screens that use `useLocalSearchParams`"

### Plan

**When to use:** Before any non-trivial feature or refactor. Use this to design the approach before touching code.
**Example tasks:**

- "Plan how to add a game scheduling feature"
- "How should I restructure the onboarding flow to support a new role type?"
- "What's the safest way to migrate the ad booking logic?"

### general-purpose (default)

**When to use:** Multi-step tasks that involve reading, editing, and running commands together.
**Example tasks:**

- "Fix the coach approval flow end to end"
- "Debug why push notifications aren't arriving"
- "Audit the admin dashboard for security gaps"

### claude-code-guide

**When to use:** Questions about Claude Code itself — hooks, slash commands, MCP servers, plugins, settings.

---

## VarsityHub-Specific Agent Patterns

### Debugging a server issue

1. Start with Explore to find the relevant route (`server/src/routes/`)
2. Trace the full data flow: client call → middleware → handler → Prisma → response
3. Check Railway logs for the relevant log prefix (`[org-get]`, `[notif]`, etc.)
4. Test with a real API payload — don't rely on static analysis

### Adding a new screen

1. Use Plan agent first to decide: tab screen or sub-screen? root Stack or hiddenTab?
2. Register in `app/_layout.tsx` (root Stack) AND `app/(tabs)/_layout.tsx` (hiddenTab) if it's a sub-screen
3. Use `safeGoBack` for back navigation, never raw `router.back()`
4. Add `headerShown: false` and implement your own back button

### Touching the server (Express routes)

- Server is at `server/src/routes/`
- Middleware: `authMiddleware` (JWT + DB lookup), `requireAuth`, `requireVerified`, `requireOnboarded`
- Business rules are enforced server-side — don't bypass with client flags
- Railway auto-deploys from `main` — test locally first with `railway run npm run dev`

### Touching the email system

- Do not rely on hardcoded template-count summaries in docs; check `TEMPLATE_IDS`, `REQUIRED_TEMPLATE_KEYS`, and `RECOMMENDED_TEMPLATE_KEYS` in `server/src/lib/email.ts`
- All other templates degrade silently — always add a plain-text fallback
- Email functions are in `server/src/lib/email.ts`
- BullMQ queue with concurrency 5, max 20/sec

### Touching release/readiness flow

- Canonical release path is `docs/release/RELEASE_WORKFLOW.md`
- Use `npm run release:verify:local` for code, regression, approval, and local gates
- Use `npm run release:verify:build` for EAS/build-readiness gates
- Use `BASE_URL="https://your-api" npm run release:verify:runtime` after Railway/provider changes
- Final launch sign-off lives in `docs/release/LAUNCH_READINESS_GATE.md`

### Payment changes

- iOS: Apple IAP only — never add Stripe links on iOS paths
- Android subscriptions: Google Play Billing via `react-native-iap`, server-verified at `POST /payments/google/verify-purchase` — never route Android subscription checkout to Stripe (Play policy)
- Android ads: Stripe PaymentSheet (ads use Stripe on Android + web; only subscriptions use Play Billing)
- Web: Stripe PaymentSheet for both subscriptions and ads
- Server enforces plan limits inside `$transaction` — race-condition safe
- Ad booking horizon is 56 days max — enforced server-side

### Push notification changes

- `sendPushNotification(userId, title, body, data)` in `server/src/lib/notifications.ts`
- Always `.catch(() => {})` — push failure must never block the main response
- Check `[notif]` log prefix in Railway for delivery confirmation

---

## Anti-Patterns (Don't Do These)

- Don't use Expo Go — always `npx expo run:ios` / `npx expo run:android`
- Don't run `eas build` or `eas submit` — costs credits, let the user run those
- Don't add client-side workarounds that bypass server-enforced rules
- Don't push to `main` without testing — Railway auto-deploys immediately
- Don't change Railway env vars casually. Sensitive vars like `JWT_SECRET`, OAuth keys, and Apple signing keys have production blast radius; rotate/change them only when the task explicitly requires it and after understanding impact.
- **Don't run `git stash apply` directly** — use `npm run stash:apply`. A bare stash apply leaves conflict markers silently; the script scans and reports them immediately.
- **Don't `git add -A` when the working tree has unresolved conflicts** — always stage files explicitly by path after verifying each one.
- **Don't assume a code fix is live.** Pushing to `main` deploys the server only (Railway). Client-side fixes require `eas update --branch production` to reach installed apps. Always remind the user to run this after any client fix.

## Post-mapper Consistency Rule

Three LIVE post mapper functions exist and MUST stay in sync:

- `mapHighlightToFeedPost` in `app/game-details/GameVerticalFeedScreen.tsx` — used for highlights API data (the parity reference)
- `toFeedPost` in `app/profile.tsx` — used for profile post data (the `/profile` + `/(tabs)/profile` route)
- `toFeedPost` in `app/team-page.tsx` — used for the team-page post viewer

When fixing a field mapping in one, always check and fix the other two. Caption/content/title fallback chains, `preview_url`, `has_upvoted`, `has_bookmarked`, `author` shape (`id`/`username`/`display_name`/`avatar_url` fallbacks) — if they diverge, bugs appear in one context but not the others. Enforced by `app/game-details/__tests__/post-mapper-consistency.test.ts` (full-chain parity across all three live mappers) and `app/game-details/__tests__/GameVerticalFeedScreen.caption.test.ts` (caption chain). NOTE: a fourth copy formerly lived in `app/features/navigation/screens/ProfileScreen.tsx`; that screen was orphaned dead code and has been deleted.

## Git Workflow

```bash
# Apply a stash safely (scans for conflict markers after apply)
npm run stash:apply

# Check for unresolved conflict markers across all source files
npm run check:conflicts

# Format all source files with prettier
npm run format

# Pre-push checklist
npm run check:conflicts
npm run format:check
npx tsc --noEmit --project server/tsconfig.json
npm run verify:error-envelope
```

**NEVER bypass the commit guardrails.** Do not use `git commit --no-verify` / `-n` or disable the pre-commit / pre-push hooks. They run tsc-files, eslint, prettier, conflict-marker and secret scans on staged files — skipping them has shipped un-typechecked, unformatted, secret-leaking commits. If a hook blocks you, fix the cause. `main` has no server-side branch protection, so these local hooks are the only gate before Railway auto-deploys to prod.

**NEVER claim verification you did not run.** "TypeScript passes" requires running BOTH the client (`npx tsc --noEmit`) AND server (`npx tsc --noEmit --project server/tsconfig.json`) typechecks in a tree that HAS `node_modules`, with 0 errors — not "skipped," not assumed. A worktree created without `node_modules` cannot typecheck the client; install deps or verify elsewhere. Same for tests/lint/route-reachability: report what you actually ran, or don't claim it.

## Team Role-Barrier Model (2026-07-06)

`server/src/lib/teamAuthorization.ts` splits team/org authorization into two tiers: `canAdministerTeam()` (team owner/coach, or org owner — settings, invites, roster add/remove/role-change, ownership transfer) vs `canManageTeam()`/`canManageAnyTeam()` (also admits team manager/assistant_coach and org manager — event/game create + approve/deny ONLY). Organization management (`isOrgOwner()`) is owner-only — org managers have zero admin power. Athletes/parents/members have no admin functions. New mutation endpoints must pick the correct tier explicitly. Athlete self-service team join requests were removed 2026-07-09 (rosters are coach-invite/direct-add only; the `TeamJoinRequest` table remains in the DB but nothing writes to it). Also 2026-07-09: teams hold STAFF ONLY — the `player`/`parent`/`member` team roles are retired (assignable: manager/coach/assistant_coach/equipment/health_wellness); athletes connect by following. `TeamRole` enum keeps retired values (no migration); legacy athlete rows are archived via `server/scripts/archive-athlete-team-memberships.ts`; invite-accept 410s retired-role invites.

## Security Invariants (Do Not Break)

- **No client-controlled security-critical state** — payment status, approval state, role, and plan are always server-authoritative
- **Backend validation is law** — frontend validation is UX only
- **IDOR guard on self-action** — users must never approve/reject their own pending requests
- **Deep link params use allowlist** — `buildRouteParams()` in `utils/deepLinks.ts` enforces per-route key allowlists
- **Webhook lock failures return 503** (not 500) so Stripe retries
- **Apple IAP cert chain pins to `CN=Apple Root CA - G3`** exactly
- **Org invite creation is owner-only** — only the organization owner creates/revokes org invites; org managers have no invite power
- **Payment-success non-auth errors surface on final retry** — no silent swallowing

### Audit-derived invariants (2026-07-14 · land with stacked PRs #168 → #171; full versions with helper/test names in `CLAUDE.md`)

- **Game approval is derived, never hardcoded** — all game writes use `deriveGameApproval`; batch endpoints authorize per row, never `.some()` across ids
- **Shared two-team resources: creator side authorizes, both sides notified** — opponent staff never delete a shared game or overwrite the other team's score; team reassignment re-triggers opponent consent; coach edits are field-locked
- **Subscription webhooks must match the subscription id** — an old-sub event never downgrades a user on a newer/other-rail sub; Google Play expiry enforcement ships together with its reconciliation job
- **Post `type` is a server whitelist** — non-admin `admin_broadcast` is coerced to `post`
- **Block filters merge, never clobber** — a block relationship must never widen a scoped query to global; all content reads apply block filtering
- **Minor-protection gates fail closed** — adult↔minor DM needs an _accepted_ follow; null DOB = blocked (`isMinor`/`isVerifiedAdult`, never `getUserAge() !== null`)
- **Post media hosts are allowlisted** — off-platform `media_url`/`poster_url` rejected
- **Approval self-review IDOR guard covers games AND events**
- **Coach auto-expire keys on `CoachApplication.submitted_at`**, never account age
- **Plan caps count pending invites** (enforced at invite create and accept)
- **No ownerless resources** — sole team/org owner cannot self-delete; membership removal syncs group-chat access
- **Share landings mirror og.ts gates**; private profiles/programs never leak
- **Private teams excluded from every public surface** (`isTeamHiddenFromViewer` et al., bounded `take`)
- **Meta-rule:** almost every one of these was a sibling write path bypassing a single-path pipeline — when adding a parallel path, reuse the existing helper, never re-derive its checks

## Security & Architecture Audit Standard

> Canonical full version lives in `CLAUDE.md` (`## Security & Architecture Audit Standard`), including the per-rule `Verify:` clauses. This section mirrors it for Codex; keep the two aligned when either changes.

Every audit rule is one of four types — **[AUDIT]** what a reviewer checks, **[ENG]** how code must be structured, **[BIZ]** VarsityHub-specific logic, **[GATE]** objective pass/fail. Every rule must be testable (state how we know it passed). Run the threat-model phase first: auth bypass, privilege escalation, payment spoofing, IDOR, webhook replay, stale-cache abuse, and deep-link injection. Classify findings by **exploitability × blast radius × recoverability**, not bare severity. Every finding ships with proof (files, repro, expected vs actual, fix); every fix ships with verification (typecheck, test, before/after repro, release risk).

**Commandments:** Thin routes, logic one layer down · Backend validation is law, frontend is guidance · No client-controlled security-critical state · One source of truth per domain object · Every protected action checks auth/role/plan/ownership server-side · Every async flow is idempotent · No silent failures and no fallback that changes security posture · No duplicate logic across routes/features · Every screen handles loading/error/success/empty · Every deep link fails gracefully and safely · Every admin action is auditable · Forms block double-submit · Payment/auth flows carry a correlation id · Refunds and cancellations reverse exactly and idempotently · Coordinate cross-replica via Redis, never in-process · Sensitive responses return sanitized user objects (never a raw user row) · A hidden/disabled UI control is never a permission check (the server gate exists regardless) · Uploads are untrusted content (signed upload + `isAllowedPostMediaUrl` host allowlist) · Every release change is testable and reversible.

**PR gate (must all pass):** client + server `tsc` 0 new errors · no unbounded `findMany` · no `req.user` without `requireAuth` · no `sgMail.send` outside providers · no hardcoded dark text colors · screens don't call `fetch` directly · `npm run audit:navigation` shows 0 REVIEW · validation parity frontend↔Zod (or `// intent:` note) · four UI states on async screens · forms block double-submit (in-flight action disabled) · no silent `catch {}` in auth/payment flows · no fallback that changes security posture · webhooks/jobs idempotent (incl. refunds/cancellations, which reverse exactly) · payment/auth flows carry an `x-request-id` correlation id · admin actions emit `AdminActivityLog` · security fix has before/after repro · schema change has migration status + rollback note · responses return sanitized user objects (`sanitizeUser`, never a raw row) · uploaded `media_url`/`poster_url` pass the host allowlist (`isAllowedPostMediaUrl`) · release candidate passes real-device smoke (auth/payments/messaging/dark mode).
