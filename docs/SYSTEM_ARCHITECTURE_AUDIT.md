# Comprehensive System Architecture Audit

> **Historical snapshot:** This report records its 2026-03-18 review and is not
> a current compliance certificate. Use [COMMANDMENTS.md](./COMMANDMENTS.md) and
> the latest `npm run verify:commandments` report for current status.

**Audit Type:** Security & Architecture Validation  
**Date:** 2026-03-18  
**Methodology:** System mapping → Gap identification → Severity classification → Fix implementation

---

## 1. Commandments Compliance Summary

| Commandment Area            | Status      | Notes                                                                                                                                                                                                                                                                |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overall Architecture**    | ⚠️ Partial  | No `src/features/*`; screens live in `app/` and `app/(tabs)/`. Path aliases `@/features/*` → `app/features/*`, `@/shared/*` → `shared/*` exist but `app/features/` is empty; `shared/` has only `plan-definitions.json`. App is routing + screen logic in same tree. |
| **State & Data**            | ✅          | API calls go through `api/*`; no raw `fetch` to API in screens (only `httpGet`/`httpPost`/`getApiBaseUrl` from `@/api/http`). Feature-scoped state; global context for auth/session (AuthProvider).                                                                  |
| **Navigation & Deep Links** | ✅          | Expo Router; deep links handled (reset-password, OAuth).                                                                                                                                                                                                             |
| **UI/UX**                   | ✅          | Loading/error/empty and submit guards used across create-team, onboarding, edit-profile, submit-ad. Accessibility: feed, sign-in, sign-up, Create menu, profile (team chips, modals), onboarding (Back, Verify, affiliation, Continue) have labels/hints.            |
| **Plans/Subscriptions**     | ✅          | Payment-success verifies with retries and finalize-session; plan not persisted until webhook/callback. Veteran team count enforced server-side; free first two teams, then billing.                                                                                  |
| **Teams/Organizations**     | ✅          | Team creation associates org (server creates org from `organization_name` if needed). Extracurricular clubs require Legend (server: `planSupportsExtracurricular`, 403 + `LEGEND_TIER_REQUIRED`). Uploads wrapped in try/catch; don’t block core create.             |
| **Payments/Ads**            | ✅          | Payment-success: retries, “Try Again”/“Continue”, missing/invalid session handled. Ad confirmation shows banner, dates, amount; defaults for missing params.                                                                                                         |
| **Testing & Quality**       | ✅          | typecheck green; jest-expo; Playwright/smoke referenced in commandments.                                                                                                                                                                                             |
| **Security & Errors**       | ✅ Improved | Silent catches in posts (geocode fallback) replaced with `debugLog`; role/plan gates (requireAuth, requireVerified, requireOnboarded) applied on server.                                                                                                             |

---

## 2. System Mapping & Data Flow

### 2.1 Auth / Session (System 1)

| Layer        | Components                                                                                            | Validation / Gates                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend** | `app/sign-in.tsx`, `sign-up.tsx`, `app/settings/reset-password.tsx`, `context/AuthProvider.tsx`       | Token in SecureStore; `auth.clearTokensOnly()` before OAuth.                                                                                                                             |
| **API**      | `api/auth.ts`, `api/user.ts`                                                                          | `me()` → GET `/me`; refresh; login/register/OAuth.                                                                                                                                       |
| **Server**   | `server/src/routes/auth.ts`, `middleware/requireAuth.ts`, `requireVerified.ts`, `requireOnboarded.ts` | JWT verify; email_verified for requireVerified; onboarding_completed + coach approval for requireOnboarded. Role change blocked after onboarding; coach upgrade via `/upgrade-to-coach`. |
| **DB**       | User, preferences (role, plan, onboarding_completed, approval_status)                                 | —                                                                                                                                                                                        |

**Permission hierarchy:** Unauthenticated → requireAuth → requireVerified → requireOnboarded → requireAdmin (where used). No bypass found.

### 2.2 Payments / Subscriptions / Plans (System 2)

| Layer        | Components                                                                                               | Validation / Gates                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend** | `app/payment-success.tsx`, `subscription-paywall.tsx`, `billing.tsx`, `settings/manage-subscription.tsx` | Session id validation (`cs_`/`sess_`); retries and finalize-session; poll for plan before showing success.                                                  |
| **API**      | `api/payments.ts`, `hooks/useIAP.ts`, `useAdIAP.ts`                                                      | Config, checkout, finalize-session, IAP verify-receipt endpoints.                                                                                           |
| **Server**   | `server/src/routes/payments.ts`                                                                          | Webhook raw body; requireVerified on finalize-session; plan set only after payment confirmation. Team limits and Veteran quantity enforced in teams router. |
| **DB**       | User.preferences (plan, payment_pending, pending_plan), Stripe subscription                              | —                                                                                                                                                           |

**Gaps:** None critical. Plan persisted only after webhook/finalize.

### 2.3 Teams / Organizations (System 3)

| Layer        | Components                                                                                             | Validation / Gates                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend** | `app/(tabs)/create-team.tsx`, `edit-team.tsx`, `event-approvals.tsx`, `organization-join-requests.tsx` | Coach-only create; org search and selection; Legend prompt for extracurricular; team limits from GET `/teams/limits`.                                                                                         |
| **API**      | `api/entities.ts` (+ `api/schemas/*`, `api/types.ts`)                                                  | Team.create (organization_id or organization_name), TeamMemberships, Organization.\*.                                                                                                                         |
| **Server**   | `server/src/routes/teams.ts`, `organizations.ts`                                                       | requireVerified + requireOnboarded on create; org created/found from name if needed; Legend required for extracurricular (`planSupportsExtracurricular`); rookie 2-team limit; veteran subscription quantity. |
| **DB**       | Team, Organization, TeamMembership, OrganizationMembership                                             | —                                                                                                                                                                                                             |

**Gaps:** None. Server enforces org association, plan limits, and Legend for clubs.

---

## 3. Gap Identification & Severity

### 3.1 Validation Mismatches (Frontend vs Backend)

| Item      | Frontend                                            | Backend                                                     | Severity                                                                     |
| --------- | --------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Username  | `edit-username.tsx`: `/^[a-z0-9_.]+$/`, length 3–20 | auth.ts: `z.string().min(3).max(20).regex(/^[a-z0-9_.]+$/)` | ✅ Match                                                                     |
| Zip code  | Used in forms                                       | auth: `z.string().regex(/^\d{5}$/)` for US zip              | ℹ️ Frontend may allow non-5-digit in some flows; server rejects. Acceptable. |
| Role/plan | UI gates (coach-only, Legend prompt)                | requireOnboarded, teams create schema, planLimits           | ✅ Enforced server-side                                                      |

No **CRITICAL** or **HIGH** validation bypass found.

### 3.2 Authorization

- **requireAuth / requireVerified / requireOnboarded** used consistently on sensitive routes (teams, events, payments, posts, etc.).
- Admin routes use **requireAdmin** or equivalent.
- No orphaned or unprotected endpoints identified for the three systems.

### 3.3 Silent Errors / Swallowed Exceptions

| Location                        | Before                                                                                       | After                                                                 | Severity       |
| ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------- |
| `server/src/routes/posts.ts`    | `catch (_error) {}` for reverseGeocode and geocodeZip                                        | `catch` with `debugLog('[posts] … failed, using fallback:', message)` | MEDIUM → Fixed |
| `server/src/routes/payments.ts` | Inline `try { window.location = … } catch (e) {}` in redirect script                         | Left as-is (client-side redirect; low impact)                         | LOW            |
| Frontend                        | Various `.catch(() => null)` or `.catch(() => {})` for optional data (e.g. Organization.get) | Acceptable for optional UX fallback                                   | LOW            |

### 3.4 Predictable / Generated Values

- No predictable IDs or tokens found in auth or payment flows.
- Session IDs from Stripe; JWT from server.

### 3.5 Data Persistence (Webhooks / Async)

- Stripe webhook: raw body preserved for signature verification; finalize-session and plan updates consistent.
- IAP: receipt verification and plan update on server before acknowledging to store.

### 3.6 Architectural Inconsistencies

| Issue                                                           | Severity | Notes                                                                      |
| --------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| No `src/features/*` structure; screens in `app/`                | MEDIUM   | Design choice; refactor would be large. Path aliases exist for future use. |
| `shared/` minimal (plan-definitions only)                       | LOW      | No duplication of shared assets flagged.                                   |
| Direct `httpGet`/`httpPost` in some screens vs `api/*` entities | LOW      | Still via central http layer; acceptable.                                  |

---

## 4. Severity Summary

| Severity            | Count     | Items                                                                            |
| ------------------- | --------- | -------------------------------------------------------------------------------- |
| **CRITICAL**        | 0         | —                                                                                |
| **HIGH**            | 0         | —                                                                                |
| **MEDIUM**          | 1 (fixed) | Posts geocode silent catch → now logged with debugLog.                           |
| **MEDIUM** (design) | 1         | Architecture does not use `app/` as thin routing + `src/features/*`; documented. |
| **LOW**             | 2         | Payments redirect catch; optional frontend .catch for optional data.             |

---

## 5. Fixes Implemented

1. **server/src/routes/posts.ts**
   - Replaced silent `catch (_error) {}` for `reverseGeocode` and `geocodeZip` with `catch (err)` and `debugLog('[posts] … failed, using fallback:', (err as Error)?.message ?? err)` so geo failures are visible in dev and not swallowed.

2. **Profile screen (app/profile.tsx)**
   - Team chips: added `accessibilityRole="button"` and `accessibilityLabel` (team name + role).
   - Avatar viewer: overlay and close button now have `accessibilityLabel` ("Close profile picture viewer", "Close").
   - Report modal overlay: added `accessibilityRole="button"` and `accessibilityLabel="Dismiss report menu"`.

3. **Onboarding (app/onboarding/)**
   - OnboardingLayout: back button has `accessibilityHint="Returns to previous onboarding step"`; Verify email button has `accessibilityRole`, `accessibilityLabel`, and `accessibilityHint`.
   - Step-2-basic: affiliation buttons given `accessibilityHint="Double tap to select"`.

---

## 6. Recommendations

1. **Architecture (optional):** Gradually move screen logic into `app/features/*` (or keep current structure and document as intentional).
2. **Accessibility:** Profile and onboarding improvements applied. Remaining screens can follow the same pattern (see SUBMISSION_READINESS_AUDIT gap #7).
3. **Run before release:** `npm run typecheck`, `cd server && npx tsc --noEmit`, and Snyk/security scan if configured.
4. **Smoke:** Wiring smoke already covers GET `/me`, GET `/events/pending`, GET `/payments/config` (see FRONT_BACKEND_WIRING_AUDIT).

---

## 7. Conclusion

- **Security:** No critical or high gaps. Permission hierarchy and validation are consistent; plan/team limits and Legend for extracurricular are enforced server-side.
- **Validation:** Username and core flows aligned between frontend and backend.
- **Errors:** Remaining silent catch in posts (geocode fallback) fixed with debugLog.
- **Architecture:** Current structure diverges from “app thin + src/features” commandment; documented as MEDIUM design variance with no immediate security impact.

Audit passes with one MEDIUM fix applied and one MEDIUM design note documented.
