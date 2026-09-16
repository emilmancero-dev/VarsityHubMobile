# Security Backlog

**Created:** 2026-03-16
**Context:** Historical March 16 audit, not a current security sign-off. Only
items #9, #12 and #18 were rechecked on September 16 against candidate source
`f90accb9`; the other entries below require fresh verification. Do not infer that
all high-severity issues are fixed or that every entry can wait until after launch.

**Current release priorities:** Apple notification trust validation and failure/retry
handling remain open after the focused review. These require separate behavioral
regressions and repair before release; merely having a webhook does not close them.
The separate node-forge dependency gate remains blocked pending an official fix.

---

## P1 — First Post-Launch Sprint

### #9 Web refresh tokens remain readable by page JavaScript

- **Risk:** HIGH
- **September 16 status:** Original localStorage wording is stale; normal web writes use sessionStorage and remove the legacy persistent copy (`apiclient/auth.ts`, `saveRefreshToken`). Native storage remains SecureStore.
- **Residual:** Session storage is still readable by same-origin JavaScript. This review did not establish an XSS entry point. The configured rolling refresh lifetime is 365 days, not seven; rotation, fingerprints, expiry and revocation also affect reuse (`server/src/lib/jwt.ts`).
- **Next design:** Review an HttpOnly-cookie web-session boundary, including cross-origin deployment, CSRF, refresh rotation and native compatibility. Do not replace the storage mechanism as an unreviewed one-line change.

### #12 Logout revocation exists; outage behavior needs hardening

- **Risk:** MEDIUM
- **September 16 status:** The missing-feature claim is stale. `server/src/routes/auth.ts` verifies/deletes the presented refresh token; `server/src/lib/accessTokenRevocation.ts` denylists access-token JTIs and auth middleware checks them. Client logout calls the server before local cleanup.
- **Residual:** Redis cache failures are treated as misses/no-ops, production disables the in-memory fallback, and logout can acknowledge success despite refresh-store failure. Normal-path tests do not prove revocation during an outage or every concurrent refresh/logout case.
- **Evidence/next check:** `server/src/__tests__/auth-security-hardening.test.ts` covers immediate denial and forged-refresh rejection. Add controlled database/Redis failure and concurrency regressions before selecting the smallest honest failure-handling repair; do not add a second competing blacklist.

---

## P2 — Next Quarter

### #8 Admin access via hardcoded email list

- **Risk:** HIGH (impact) / LOW (exploitability)
- **Why deferred:** Works for single-admin setup. Only one admin (support@varsityhub.app).
- **Issue:** No granular roles (all-or-nothing admin). Adding admins requires env var change + redeploy. No audit trail for admin actions.
- **Fix:** Add `role` column to User model (`user`, `moderator`, `admin`, `superadmin`). Migrate `ADMIN_EMAILS` check to DB lookup. Add `AdminAction` audit logging.

### #10 Refresh token not rotated on all auth endpoints

- **Risk:** HIGH
- **Why deferred:** Rotation happens on `/auth/refresh` which is the primary token renewal path. Login/register/OAuth issue new tokens (not reuse old ones).
- **Issue:** If a refresh token is intercepted, it can be reused for 7 days without triggering rotation.
- **Fix:** Implement sliding-window rotation: every successful `/auth/refresh` invalidates the old token and issues a new one. Store previous token briefly to handle race conditions.

### #11 Org join requests use preference-based role check

- **Risk:** HIGH
- **Why deferred:** Preferences can't be directly modified via API (no raw PATCH /preferences endpoint for role). Server re-checks permissions on every action.
- **Issue:** If a user could somehow modify `preferences.role` to `coach`, they could submit join requests as a coach.
- **Fix:** Refactor all role checks to use database-stored memberships exclusively. Never use `preferences.role` for authorization — only for UI display.

---

## P3 — Backlog

### #13 No login anomaly detection

- **Risk:** MEDIUM
- **Why deferred:** Standard for early-stage apps. Device info is already tracked on login (fire-and-forget).
- **Fix:** Alert users on login from new device/location. Require email confirmation for suspicious logins (new country, multiple failed attempts from different IPs).

### #14 Org creation auto-approved to creator before super-admin review

- **Risk:** MEDIUM
- **Why deferred:** By design — creator needs to use the org immediately. Super-admin approval gate exists (`admin_approved` field).
- **Fix:** Document the flow. Consider blocking public visibility until `admin_approved = true`.

### #15 Missing empty/error states on some screens

- **Risk:** MEDIUM (UX, not security)
- **Why deferred:** Core flows have proper states. Edge cases on less-used screens.
- **Fix:** Audit all screens for loading/empty/error state coverage. Add `SkeletonCard` to remaining list screens.

### #16 Accessibility — 5.5% label coverage

- **Risk:** MEDIUM (compliance)
- **Why deferred:** Not a security issue. Important for inclusivity and App Store compliance.
- **Fix:** Start with high-impact elements: main CTAs, form inputs, navigation buttons. Target 50%+ coverage in first pass.

### #17 Fire-and-forget API calls without user feedback

- **Risk:** LOW
- **Why deferred:** Non-critical operations (notification channel setup, Sentry init, deep link handling).
- **Fix:** Add error toasts for user-facing operations. Use `ErrorToast` component (exists but unused).

### #18 Apple renewal webhook exists; verification and retry defects remain

- **September 16 status:** The missing-webhook claim is stale. Both Apple notification paths in `server/src/routes/payments.ts` handle renewal, renewal failure, expiry and refund/revocation events.
- **Release-blocking residuals:** Local behavioral verification found insufficient certificate trust validation in both signed-payload verification paths. Source tracing also identified a deduplication/transaction ordering defect that can suppress retries after processing fails. No live notification or real entitlement mutation was attempted.
- **Next repair:** Verify actual trusted certificate chains for outer and inner payloads; prove untrusted-chain rejection and valid-chain acceptance. Make receipt handling and entitlement updates retry-safe, with a fault-injection regression. Provider delivery configuration, real sandbox notifications and deployed behavior remain unverified.
- **Evidence limits:** Existing `apple-notification-dedup.test.ts` and `payments-invariants.test.ts` passed 51 checks in the focused review; helper/structural coverage did not detect the behavioral trust defect. Passing those suites is not release approval.
