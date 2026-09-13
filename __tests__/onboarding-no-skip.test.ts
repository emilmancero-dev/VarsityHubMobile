/**
 * Onboarding flow — "no screens can be skipped" invariants
 *
 * These tests scan client source code for patterns that guarantee every
 * onboarding screen enforces its prerequisites. If somebody adds a new
 * shortcut that lets a user leapfrog past step-1, step-2, coach-agreement,
 * or the pending-approval waiting screen, one of these tests fails.
 *
 * Static source scans — no React renderer needed. ~5ms per test.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd());
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const step1 = read('app/onboarding/step-1-role.tsx');
const step2 = read('app/onboarding/step-2-basic.tsx');
const step3 = read('app/onboarding/step-3-league.tsx');
const coachAgreement = read('app/onboarding/coach-agreement.tsx');
const pendingApproval = read('app/onboarding/pending-approval.tsx');
const leaguePendingApproval = read('app/onboarding/league-pending-approval.tsx');
const pendingApprovalFlowHook = read('hooks/usePendingApprovalFlow.ts');
const onboardingLayout = read('app/onboarding/_layout.tsx');
const onboardingIndex = read('app/onboarding/index.tsx');
const rootIndex = read('app/index.tsx');
const rootLayout = read('app/_layout.tsx');
const authProvider = read('context/AuthProvider.tsx');

describe('onboarding flow — no screens can be skipped', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Entry gate — onboarding layer only loads for authenticated + verified
  // ──────────────────────────────────────────────────────────────────────

  describe('onboarding layout gates entry', () => {
    it('_layout redirects unauthenticated users away from onboarding', () => {
      expect(onboardingLayout).toMatch(/!user|user\s*==\s*null|user\s*===\s*null/);
    });

    it('_layout enforces email_verified before entering onboarding', () => {
      // The layout check was added specifically so deep-link attacks or
      // bootstrap races cannot land an unverified user on step-1.
      expect(onboardingLayout).toMatch(/email_verified/);
    });

    it('onboarding/index.tsx routes to the correct step based on state', () => {
      // Must use the centralized route-decision helper so it can send users
      // to the right incomplete step or server-directed recovery screen
      // instead of hardcoding inline redirects in the screen.
      expect(onboardingIndex).toMatch(/getOnboardingIndexRouteDecision/);
      expect(onboardingIndex).toMatch(/decision\.route/);
      expect(onboardingIndex).toMatch(/buildServerHydrationPatch\(user\)/);
      expect(onboardingIndex).not.toMatch(/User\.me\(/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Step-by-step prerequisites — each screen verifies the one before it
  // ──────────────────────────────────────────────────────────────────────

  describe('step ordering — each step requires the prior to be complete', () => {
    it('step-2 redirects to step-1 if role is not set (prevents role skip)', () => {
      // Guard at top of Step2Basic — if ob.role is falsy, redirect back.
      // Without this guard, a deep link to /onboarding/step-2-basic could land
      // a user there with no role in context, leaving them stuck after save.
      expect(step2).toMatch(/if\s*\(\s*!ob\.role\s*\)/);
      expect(step2).toMatch(/router\.replace\(['"]\/onboarding\/step-1-role/);
    });

    it('step-1-role keeps fresh coach selection local until later onboarding steps provide DOB', () => {
      // Brand-new coach applicants cannot be blocked at step-1 by the server's
      // DOB_REQUIRED guard. Step-1 should short-circuit server persistence for
      // incomplete onboarding, then step-2/step-3 commit the canonical coach state.
      expect(step1).toMatch(/if\s*\(!onboardingCompleted\)\s*\{\s*return;\s*\}/);
      expect(step1).toMatch(/upgradeToCoach\(\s*['"]rookie['"]\s*\)/);
      expect(step1).toMatch(/step-2\/step-3 commit the canonical/);
    });

    it('step-1-role resumes coach recovery routes instead of dead-ending on role lock', () => {
      expect(step1).toMatch(/getPostAuthRouteDecision/);
      expect(step1).toMatch(/router\.replace\(recoveryRoute/);
    });

    it('step-1-role uses canonical auth state instead of refetching role bootstrap snapshots', () => {
      expect(step1).toMatch(/const \{ user, signOut, checkAuth \} = useAuth\(\)/);
      expect(step1).toMatch(/isOnboardingCompleteSnapshot/);
      expect(step1).not.toMatch(/User\.me\(\)/);
      expect(step1).not.toMatch(/User\.refresh\(\)/);
      expect(step1).not.toMatch(/useFocusEffect/);
    });

    it('step-1-role retries transient network errors before giving up', () => {
      expect(step1).toMatch(/persistRole/);
      expect(step1).toMatch(/attempt\s*<\s*2/);
    });

    it('step-2 submit persists DOB + username + zip BEFORE moving to step-3 or tabs', () => {
      // Both User.patchMe (username) and User.updatePreferences (prefs) must
      // fire before router.replace. If either throws, the screen shows an
      // error and does NOT navigate — preventing partial-state skipping.
      expect(step2).toMatch(/User\.patchMe/);
      expect(step2).toMatch(/User\.updatePreferences/);
      expect(step2).toMatch(/ob\.role === ['"]coach['"] \? \{ role: ['"]coach['"] \} : \{\}/);
    });

    it('step-2 bootstraps from canonical auth state instead of refetching User.me on focus', () => {
      expect(step2).toMatch(
        /const \{ user, markOnboardingCompleteLocally, registerPushToken \} = useAuth\(\)/
      );
      expect(step2).not.toMatch(/User\.me\(\)/);
      expect(step2).not.toMatch(/useFocusEffect/);
    });

    it('step-3 enforces supporting document for create-new-org path', () => {
      // Coaches creating a new org must attach a supporting document —
      // this is a soft "no skip" gate enforced client-side AND server-side.
      expect(step3).toMatch(/supporting_document|supportingDocument/);
    });

    it('step-3 mode switches clear stale local completion markers', () => {
      expect(step3).toMatch(/join_request_pending:\s*false,[\s\S]*step_3_visited:\s*false/);
      expect(step3).toMatch(/organization_id:\s*undefined,[\s\S]*step_3_visited:\s*false/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Pending approval — cannot be reached without submitting something
  // ──────────────────────────────────────────────────────────────────────

  describe('pending approval screens gate on actual pending state', () => {
    it('pending approval screens poll through the shared canonical auth snapshot helper', () => {
      expect(pendingApproval).toMatch(/getPendingApprovalAuthSnapshot/);
      expect(leaguePendingApproval).toMatch(/getPendingApprovalAuthSnapshot/);
      expect(pendingApprovalFlowHook).toMatch(
        /export async function getPendingApprovalAuthSnapshot/
      );
      expect(pendingApproval).not.toMatch(/User\.me\(\)/);
      expect(leaguePendingApproval).not.toMatch(/User\.refresh\(\)/);
    });

    it('league-pending-approval requires an orgId to start polling', () => {
      // If orgId is missing, don't start the interval — prevents a user from
      // loading the waiting screen without having actually submitted an org.
      expect(leaguePendingApproval).toMatch(/if\s*\(\s*!orgId\s*\)/);
    });

    it('pending-approval has a "continue as fan" escape hatch (not a trap)', () => {
      // Users who can't wait must have a way out. Without this, a user whose
      // admin is slow could be stuck on this screen indefinitely.
      expect(pendingApproval).toMatch(/proceeding_as_fan|proceedAsFan|role:\s*['"]fan['"]/i);
    });

    it('pending approval screens re-check immediately on screen focus', () => {
      // Poll-only waiting screens create a 0-30s stale window after the user
      // returns from background or navigates back from another screen.
      expect(pendingApprovalFlowHook).toMatch(/useFocusEffect/);
      expect(pendingApprovalFlowHook).toMatch(/runCheck\('focus'\)/);
    });

    it('pending approval screens re-check immediately when the app becomes active', () => {
      // Admin approvals frequently happen while the coach has the app in the
      // background. Active-state refresh closes the stale timer gap.
      expect(pendingApprovalFlowHook).toMatch(/AppState\.addEventListener\('change'/);
      expect(pendingApprovalFlowHook).toMatch(/runCheck\('foreground'\)/);
    });

    it('lifecycle-triggered approval checks are guarded against duplicate storms', () => {
      expect(pendingApprovalFlowHook).toMatch(/approvalCheckInFlightRef/);
      expect(pendingApprovalFlowHook).toMatch(/lastLifecycleCheckRef/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Coach agreement — accepted state is still recorded, but it is no longer
  // a hard post-approval access gate
  // ──────────────────────────────────────────────────────────────────────

  describe('coach agreement behavior', () => {
    it('coach-agreement screen writes coach_agreement_accepted_at on accept', () => {
      expect(coachAgreement).toMatch(/coach_agreement_accepted_at/);
      expect(coachAgreement).toMatch(/updatePreferences/);
    });

    it('coach-agreement routes from the canonical auth refresh helper instead of refetching /me', () => {
      expect(coachAgreement).toMatch(/getFreshAuthSnapshot\(checkAuth, user\)/);
      expect(coachAgreement).not.toMatch(/await checkAuth\(\);[\s\S]{0,120}User\.me\(\)/);
    });

    it('AuthProvider keeps coach-agreement as an optional screen, not a hard approved-coach gate', () => {
      expect(authProvider).not.toMatch(/redirectWithTelemetry\('\/onboarding\/coach-agreement'/);
      expect(authProvider).toMatch(/coach_agreement_accepted_at/);
    });

    it('AuthProvider no longer checks agreement state before routing approved coaches to tabs', () => {
      expect(authProvider).not.toMatch(/hasCurrentCoachAgreement\(/);
    });

    it('AuthProvider only keeps coach-agreement mounted while acceptance is still missing', () => {
      expect(authProvider).toMatch(
        /const needsCoachAgreementAcceptance =[\s\S]*!hasAcceptedCoachAgreement\(user as any\)/
      );
      expect(authProvider).toMatch(/!needsCoachAgreementAcceptance/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Root routing — covers every state transition with no gaps
  // ──────────────────────────────────────────────────────────────────────

  describe('root index + AuthProvider cover every state', () => {
    // app/index.tsx now acts as a root-screen failsafe: AuthProvider remains
    // the primary router, but index must be able to escape the startup wheel
    // if centralized routing misses on a cold start.

    it('AuthProvider routes unauthenticated users → /sign-in', () => {
      expect(authProvider).toMatch(/\/sign-in/);
      expect(authProvider).toMatch(/!user|user\s*==\s*null|user\s*===\s*null/);
    });

    it('AuthProvider routes unverified users → /verify (no skip)', () => {
      expect(authProvider).toMatch(/email_verified/);
      expect(authProvider).toMatch(/['"]\/verify['"]/);
    });

    it('AuthProvider routes users with incomplete onboarding → /onboarding/step-1-role', () => {
      expect(authProvider).toMatch(/onboarding_completed|isOnboardingComplete/);
      expect(authProvider).toMatch(/generic_onboarding_required|onboarding_required/);
      expect(authProvider).toMatch(/getPostAuthRouteDecision/);
    });

    it('AuthProvider routes fully-verified + completed users → (tabs)', () => {
      expect(authProvider).toMatch(/\(tabs\)/);
    });

    it('AuthProvider still routes unauthenticated users to sign-in when backend health is down', () => {
      expect(authProvider).toMatch(/unauthenticated_backend_unhealthy/);
      expect(authProvider).toMatch(
        /Do not strand unauthenticated users on the passive root spinner/
      );
    });

    it('app/index.tsx stays passive while AuthProvider owns the root-splash redirect', () => {
      expect(rootIndex).toMatch(/Passive splash screen/);
      expect(rootIndex).toMatch(/navigation is handled centrally by _layout\.tsx/);
      expect(rootIndex).not.toMatch(/router\.replace\('/);
      expect(rootIndex).not.toMatch(/getPostAuthRouteDecision/);
      expect(authProvider).toMatch(/root_index_authenticated/);
      expect(authProvider).toMatch(/root_index_guest/);
    });

    it('root layout does not hard-block auth bootstrap on navState.key', () => {
      expect(rootLayout).toMatch(/const navReady = Boolean\(navState\?\.key\)/);
      // navReady flows into AuthProvider through the memoized wrapper so the
      // provider tree no longer re-renders on every navigation state change.
      expect(rootLayout).toMatch(/<MemoizedAuthProvider navReady=\{navReady\}>/);
      expect(rootLayout).toMatch(/React\.memo\(AuthProvider\)/);
    });

    it('AuthProvider bootstraps auth independently of nav readiness', () => {
      expect(authProvider).toMatch(/Starting auth bootstrap/);
      expect(authProvider).not.toMatch(/Navigation readiness timeout - continuing auth bootstrap/);
    });

    it('AuthProvider bootstraps auth at most once even if nav readiness flips later', () => {
      expect(authProvider).toMatch(/bootstrapStartedRef/);
      expect(authProvider).toMatch(/if \(bootstrapStartedRef\.current\) return;/);
    });

    it('AuthProvider has a routing-readiness timeout fallback', () => {
      expect(authProvider).toMatch(/Navigation readiness timeout - allowing routing fallback/);
      expect(authProvider).toMatch(/const \[routingReady, setRoutingReady\]/);
    });

    it('AuthProvider resets redirect suppression when the current path changes', () => {
      expect(authProvider).toMatch(/lastRedirectRef\.current = null/);
      expect(authProvider).toMatch(/currentPath === normalizedTarget/);
      expect(authProvider).toMatch(/currentPath,\s*segments/);
    });

    it('AuthProvider has a pending-coach redirect path (not just implicit)', () => {
      // Coaches with approval_status PENDING/REJECTED must land on the
      // pending-approval screen, not on (tabs) where they'd hit 403s.
      expect(authProvider).toMatch(/approval_status|isPendingCoach|isRejectedCoach/);
    });

    it('AuthProvider exempts admins from the pending-coach block', () => {
      // Admins with dirty coach state should not get trapped on pending
      // recovery routes during bootstrap or while sitting on onboarding paths.
      expect(authProvider).toMatch(/user\?\.is_admin !== true/);
    });

    it('AuthProvider has a payment-required redirect for paid-plan coaches', () => {
      // Approved coach with a paid plan selected must go through checkout
      // before accessing coach tools — not into tabs with payment_pending.
      expect(authProvider).toMatch(
        /subscription-paywall|manage-subscription|coach_checkout|payment_pending/
      );
    });

    it('AuthProvider has a server-is-truth guard against AsyncStorage onboarding flag', () => {
      // Prevents a stale local flag from letting a user skip the server's
      // onboarding_completed check. The server is the source of truth.
      expect(authProvider).toMatch(/SERVER IS SOURCE OF TRUTH|isOnboardingComplete\(user\)/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Step-3 submission — no bypass shortcuts
  // ──────────────────────────────────────────────────────────────────────

  describe('step-3 league — submission paths', () => {
    it('create-new-org path sends a supporting document URL to the server', () => {
      expect(step3).toMatch(/supporting_document_url|supportingDocumentUrl/);
    });

    it('join-existing-org path persists join_request_pending to server preferences', () => {
      // Regression: without this, a force-close after the Alert loses the
      // pending state and the user can re-submit a duplicate join request
      // on next launch.
      expect(step3).toMatch(/join_request_pending:\s*true/);
    });

    it('onContinue calls User.completeOnboarding with the canonical role', () => {
      expect(step3).toMatch(/completeOnboarding/);
      expect(step3).toMatch(/role:\s*['"]coach['"]|role:\s*['"]fan['"]/);
    });

    it('existing-org continue path routes from fresh canonical auth state before completing onboarding', () => {
      expect(step3).toMatch(/getPostAuthRouteDecision/);
      expect(step3).toMatch(
        /const authUser = \(await checkAuth\(\)\.catch\(\(\) => null\)\) \?\? user/
      );
      expect(step3).toMatch(/routeFromDecision\(nextDecision\.route/);
    });

    it('step-3 builds completion payloads from canonical auth and draft state instead of refetching /me', () => {
      expect(step3).toMatch(/const buildCoachCompletionPayload = useCallback/);
      expect(step3).not.toMatch(/User\.me\(\)/);
      expect(step3).not.toMatch(/User\.refresh\(\)/);
    });

    it('final coach setup refreshes auth and routes agreement-first when required', () => {
      expect(step3).toMatch(/getFreshPostAuthState/);
      expect(step3).toMatch(/decision\.route === ['"]\/onboarding\/coach-agreement['"]/);
      expect(step3).toMatch(/redirect:\s*['"]create-team['"]/);
    });

    it('AuthProvider has a redirect-family loop breaker', () => {
      expect(authProvider).toMatch(/routing_loop_detected/);
      expect(authProvider).toMatch(/recentRedirectsRef/);
      expect(authProvider).toMatch(/getRouteFamily/);
    });

    it('loop breaker exempts BOTH terminal redirects (session_expired AND sign_out)', () => {
      // Regression for VARSITYHUB-3A: sign-out redirects to the unauthenticated
      // entry route were being swallowed by the loop guard when the `tabs` bucket
      // was already hot, leaving the user stuck. Both terminal reasons must be
      // exempt so the redirect (and the unmount that makes the http.ts hang safe)
      // always fires.
      const exemption = authProvider.match(/const isTerminalSessionRedirect =[\s\S]*?;/);
      expect(exemption).not.toBeNull();
      expect(exemption![0]).toMatch(/session_expired/);
      expect(exemption![0]).toMatch(/sign_out/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Verify step — email verification cannot be bypassed for password users
  // ──────────────────────────────────────────────────────────────────────

  describe('/verify screen — the one path past unverified email', () => {
    const verify = read('app/verify.tsx');

    it('verify screen actually calls the verification API', () => {
      expect(verify).toMatch(/verifyEmail|verify\/confirm|User\.verifyEmail|confirmCode/);
    });

    it('verify screen has an escape hatch (sign-out / back to login)', () => {
      // User must have a path out when they realize they signed up with
      // the wrong email — without this they're trapped on /verify forever.
      expect(verify).toMatch(/signOut|Sign out|Wrong account/i);
    });

    it('verify screen auto-advances when email_verified is already true', () => {
      // Returning users who landed here from a stale route should not be
      // forced to re-enter a code. The effect should route them out.
      expect(verify).toMatch(/email_verified.*true|checkAuth/);
    });
  });
});
