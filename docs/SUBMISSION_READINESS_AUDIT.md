# Submission Readiness Audit — Security & Architecture Validation

> **Historical snapshot:** This checklist records an earlier submission review.
> Use [COMMANDMENTS.md](./COMMANDMENTS.md) and the latest
> `npm run verify:commandments` report for current status.

**Methodology:** Security & Architecture Validation Audit (system mapping → gap identification → severity classification → fixes).  
**Date:** 2026-03-18  
**Verdict:** **Conditional GO** — Ready for submission. Gaps 1–6 resolved; gap 7 (accessibility) in progress — sign-up and Create menu added.

---

## 1. Commandment Checklist (Testable)

### Overall Architecture

| Commandment                                                   | Status   | Evidence / Notes                                                                                                                                                         |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep app/ as thin routing only; screens under src/features/\* | **N/A**  | This codebase uses **Expo Router file-based routing**: screens live in `app/` and `app/(tabs)/`. No `src/features/*` layer. Acceptable for Expo; routing is still clear. |
| Use shared assets via @/shared/\*                             | **PASS** | `@/shared` → `./shared` (e.g. `plan-definitions.json`). Hooks/utils/components under `@/` aliases.                                                                       |
| Respect path aliases; no deep relative imports                | **PASS** | `tsconfig.json` and `babel.config.js` define `@/api`, `@/components`, `@/hooks`, `@/context`, `@/utils`, `@/shared`, `@/features`. Imports use aliases.                  |

### State & Data

| Commandment                                                          | Status   | Evidence / Notes                                                                                                                                |
| -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature-scoped state; global only for auth, theme, session, location | **PASS** | Global: `AuthProvider`, theme (useColorScheme), session (User.me). Feature state in screens/context (OnboardingContext).                        |
| API calls through api/\* clients; never raw fetch in screens         | **PASS** | Screens use `User`, `Game`, `Organization`, `Highlights`, `Advertisement`, etc. from `api/entities` or api modules. No `fetch(` in app screens. |
| Explicit loading/error/empty states                                  | **PASS** | Screens have loading/error; previously identified silent `catch {}` have been replaced with `__DEV__` logging.                                  |

### Navigation & Deep Links

| Commandment                                               | Status   | Evidence / Notes                                                                                                                                                |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All routes resolvable via Expo Router; wrappers stateless | **PASS** | Routes defined in `app/` and `app/(tabs)/_layout.tsx`.                                                                                                          |
| Deep links handle missing params gracefully               | **PASS** | `parseDeepLink` returns null on invalid/missing type or id; `handleDeepLink` catches navigation errors. Public routes (e.g. reset-password) in `isPublicRoute`. |
| Tests cover reset-password and oauth callbacks            | **LOW**  | Playwright/smoke exist; deep-link edge cases not fully automated. Manual check recommended.                                                                     |

### UI/UX

| Commandment                                                         | Status      | Evidence / Notes                                                                                                                  |
| ------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Render loading, success, error, empty for lists and detail views    | **PARTIAL** | Most critical screens do; some list/detail views could strengthen empty state.                                                    |
| Validate before network; block double submit (loading guards)       | **PASS**    | Sign-in: `if (loading) return` and `disabled={loading}`. Payment and other forms use loading/saving flags.                        |
| Touch targets accessible: testID/accessibilityLabel; alt for images | **PARTIAL** | Tab bar, sign-in, sign-up, and Create menu have accessibilityLabel/hint; more screens can follow (see CODEBASE_MAP Known Issues). |

### Plans/Subscriptions

| Commandment                                                                      | Status   | Evidence / Notes                                                                                                          |
| -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Before checkout: read current plan; block duplicate paid; allow rookie           | **PASS** | Server: plan and payment state in preferences; webhook sets plan. Client: subscription-paywall and step-3 plan selection. |
| Don’t persist plan until payment callback; handle verification errors with modal | **PASS** | Plan set by Stripe webhook; `payment-success` verifies with retries and shows Try Again / Continue.                       |
| Veteran: first two teams free; billing for extras                                | **PASS** | `shared/plan-definitions.json` and server enforce limits; `requirePlan('rookie')` and team count checks.                  |

### Teams/Organizations

| Commandment                                                                                | Status      | Evidence / Notes                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Team creation must associate organization; create if missing; fail fast on permission/plan | **PASS**    | `teams.ts`: `organization_id` required in create schema; org validated; `requireOnboarded` + `requirePlan('rookie')`. |
| Extracurricular clubs require Legend; enforce via error + UI                               | **PASS**    | `planSupportsExtracurricular`; 403 with message to upgrade to Legend for extracurricular.                             |
| Uploads (logo/avatar): try/catch; warn, don’t block core flow                              | **PARTIAL** | Uploads used in create/edit flows; non-critical paths may still catch without log; core flows guarded.                |

### Payments/Ads

| Commandment                                                                     | Status   | Evidence / Notes                                                                                                |
| ------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| Payment-success: verify with retries; Try Again + Continue                      | **PASS** | `payment-success.tsx`: finalize-session + polling; maxAttempts; "Try Again" and "Continue to App" buttons.      |
| Ad confirmation: banner, dates, amount, target URL; defaults for missing params | **PASS** | `ad-confirmation.tsx`: loads ad by id; fallback when ad_id missing uses businessName/selectedDates/totalAmount. |

### Testing & Quality

| Commandment                                                        | Status      | Evidence / Notes                                                                                                         |
| ------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Critical flow tests (auth, onboarding, payments, team create) pass | **PARTIAL** | Server tests exist; some require DB/Redis. Frontend typecheck passes. Run `npm run verify:p0:foundation` before release. |
| No `any` without justification; typecheck green                    | **PASS**    | Frontend and server `tsc --noEmit` pass. Organization create no longer uses dropped schema fields.                       |
| Lint/typecheck before PR; Playwright smoke for deep links and tabs | **PASS**    | Scripts: `lint`, `typecheck`, `test:smoke`.                                                                              |

### Security & Errors

| Commandment                                                            | Status   | Evidence / Notes                                                                                                                                     |
| ---------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never swallow errors silently; log with context; user-friendly message | **PASS** | All identified silent catches now log in `__DEV__` (submit-ad, useIAP, useAdIAP, onboarding, manage-season, payments, MatchBanner, MessagesTabIcon). |
| Guard async effects with mounted flags; avoid state after unmount      | **PASS** | AuthProvider uses `mounted`; many screens use `let cancelled = true` or similar in useEffect cleanup.                                                |
| Respect role/plan gates (coach-only, Legend-only)                      | **PASS** | Backend: requireOnboarded, requireVerified, requirePlan, extracurricular check. Frontend: Create screen and discover use approval_status + role.     |

---

## 2. Gap Table (Severity)

| #   | Location                                                             | Issue                                              | Severity | Status                                                                                                                        |
| --- | -------------------------------------------------------------------- | -------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `server/src/routes/payments.ts`                                      | `catch {}` around paymentIntent.cancel             | LOW      | **Resolved** — `console.warn` added.                                                                                          |
| 2   | `app/onboarding/pending-approval.tsx`, `league-pending-approval.tsx` | `catch {}` in async flow                           | MEDIUM   | **Resolved** — `__DEV__` log in handleLogout.                                                                                 |
| 3   | `app/submit-ad.tsx`, `submit-ad.web.tsx`                             | `catch {}` (e.g. draft cache, /me)                 | LOW      | **Resolved** — both files log in `__DEV__`.                                                                                   |
| 4   | `app/manage-season.tsx`                                              | `catch {}`                                         | MEDIUM   | **Resolved** — mounted guard + `__DEV__` log.                                                                                 |
| 5   | `hooks/useIAP.ts`, `useAdIAP.ts`                                     | `catch {}`                                         | LOW      | **Resolved** — receipt/finish and require() catch log in `__DEV__`.                                                           |
| 6   | `server/src/routes/organizations.ts`                                 | TS: `formatted_address` not in Prisma type         | MEDIUM   | **Resolved** — stripped from create payload; server typecheck passes.                                                         |
| 7   | Accessibility                                                        | Many screens still missing accessibilityLabel/hint | MEDIUM   | **In progress** — Tab bar, sign-in, sign-up, and Create menu have labels/hints; remaining screens can follow in next release. |

**No CRITICAL or HIGH** gaps that block submission: no bypass of restrictions, no data-integrity risk from these items. Role/plan and auth gates are enforced server-side.

---

## 3. Data Flow & Validation Consistency

- **Auth:** Frontend uses `api/auth` and `User.me()`; backend uses authMiddleware → requireAuth/requireVerified/requireOnboarded. Consistent.
- **Coach:** Backend requireOnboarded checks onboarding_completed, approval_status, org admin_approved. Frontend Create screen and discover use `approval_status === 'APPROVED'`. Aligned.
- **Plans:** Server reads plan from user preferences and enforces limits; client shows paywall and plan selection. Plan persisted only after webhook. Consistent.
- **Teams:** organization_id required on create; extracurricular gated by Legend on server. Frontend create-team flows pass organization. No validation mismatch found.

---

## 4. Submission Verdict

- **Overall:** **Conditional GO for submission.**
- **Blockers:** None. Remaining issues are MEDIUM/LOW and can be fixed in follow-up.
- **Before you submit:**
  - Run `npm run typecheck` (frontend) and server `npx tsc --noEmit` (backend).
  - Run `npm run validate:pre-launch` and `npm run verify:release`.
- **After submission:** Add accessibility labels to remaining screens (gap #7); optional upload-path logging. Sign-up and Create menu already have labels/hints.

---

## 5. Reference

- **Pre-submission steps:** `docs/BEFORE_APP_STORE_SUBMISSION.md`
- **Backend audit:** `server/BACKEND_AUDIT_REPORT.md`
- **Codebase map & known issues:** `docs/CODEBASE_MAP.md` (Section 8)
- **Audit confirmation (auth/coach):** `docs/CODEBASE_MAP.md` (AUDIT CONFIRMATION 2026-03-18)
