import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Alert, AppState } from 'react-native';
// @ts-ignore
import { Notification as NotificationApi, User } from '@/api/entities';
import { getPostAuthRouteDecision } from '@/utils/appRouteDecisions';
import { GUEST_HOME_ROUTE } from '@/utils/publicRoutes';
import { toUserMessage } from '@/utils/toUserMessage';

const COACH_REAPPLY_COOLDOWN_MS = 48 * 60 * 60 * 1000;

export type ApprovalTrigger = 'initial' | 'interval' | 'focus' | 'foreground';

type UsePendingApprovalPollingOptions = {
  onCheck: (trigger: ApprovalTrigger) => Promise<void>;
  setChecking: (value: boolean) => void;
  setTimedOut: (value: boolean) => void;
  skipLifecycleChecks?: boolean;
};

type UsePendingApprovalActionsOptions = {
  replaceRoute: (route: any) => void;
  signOut: () => Promise<void>;
  checkAuth: () => Promise<any>;
  stopPolling: () => void;
  logPrefix: string;
  proceedingAsFanRef?: MutableRefObject<boolean>;
  persistProceedAsFan?: () => Promise<void>;
  formatProceedAsFanError?: (error: any) => { title: string; message: string };
  onProceedAsFanError?: (error: any) => void;
};

export async function getPendingApprovalAuthSnapshot(
  checkAuth: () => Promise<any>,
  fallbackUser?: any | null
) {
  const user = (await checkAuth().catch(() => null)) ?? fallbackUser ?? null;
  return {
    user,
    decision: getPostAuthRouteDecision(user),
  };
}

export function usePendingApprovalPolling({
  onCheck,
  setChecking,
  setTimedOut,
  skipLifecycleChecks = false,
}: UsePendingApprovalPollingOptions) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalCheckInFlightRef = useRef(false);
  const lastLifecycleCheckRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const runCheck = useCallback(
    async (trigger: ApprovalTrigger) => {
      if (approvalCheckInFlightRef.current) return;
      if (skipLifecycleChecks && (trigger === 'focus' || trigger === 'foreground')) return;
      if (trigger === 'focus' || trigger === 'foreground') {
        const now = Date.now();
        if (now - lastLifecycleCheckRef.current < 2000) return;
        lastLifecycleCheckRef.current = now;
      }

      try {
        approvalCheckInFlightRef.current = true;
        setChecking(true);
        await onCheck(trigger);
      } finally {
        approvalCheckInFlightRef.current = false;
        setChecking(false);
      }
    },
    [onCheck, setChecking, skipLifecycleChecks]
  );

  useEffect(() => {
    void runCheck('initial');
    intervalRef.current = setInterval(() => {
      void runCheck('interval');
    }, 30000);
    timeoutRef.current = setTimeout(
      () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setTimedOut(true);
      },
      30 * 60 * 1000
    );

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [runCheck, setTimedOut]);

  useFocusEffect(
    useCallback(() => {
      void runCheck('focus');
    }, [runCheck])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void runCheck('foreground');
      }
    });
    return () => {
      subscription.remove();
    };
  }, [runCheck]);

  return { stopPolling };
}

export function usePendingApprovalActions({
  replaceRoute,
  signOut,
  checkAuth,
  stopPolling,
  logPrefix,
  proceedingAsFanRef: externalProceedingAsFanRef,
  persistProceedAsFan,
  formatProceedAsFanError,
  onProceedAsFanError,
}: UsePendingApprovalActionsOptions) {
  const mountedRef = useRef(true);
  const internalProceedingAsFanRef = useRef(false);
  const isNavigatingRef = useRef(false);
  const [navigationTarget, setNavigationTarget] = useState<'organization' | 'create-team' | null>(
    null
  );
  const proceedingAsFanRef = externalProceedingAsFanRef ?? internalProceedingAsFanRef;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
    } catch (err) {
      if (__DEV__) console.warn(`[${logPrefix}] Logout failed:`, (err as Error)?.message ?? err);
    }
    replaceRoute(GUEST_HOME_ROUTE);
  }, [logPrefix, replaceRoute, signOut]);

  const handleProceedAsFan = useCallback(async () => {
    try {
      proceedingAsFanRef.current = true;
      stopPolling();
      if (persistProceedAsFan) await persistProceedAsFan();
      else await User.updatePreferences({ proceeding_as_fan: true });
      const { decision } = await getPendingApprovalAuthSnapshot(checkAuth);
      replaceRoute(decision.route as any);
    } catch (err: any) {
      proceedingAsFanRef.current = false;
      if (__DEV__) console.warn(`[${logPrefix}] Failed to proceed as fan:`, err);
      onProceedAsFanError?.(err);
      const fallback = formatProceedAsFanError
        ? formatProceedAsFanError(err)
        : {
            title: 'Failed',
            message: toUserMessage(err, 'Could not complete setup. Please try again.'),
          };
      Alert.alert(fallback.title, fallback.message);
    }
  }, [
    checkAuth,
    formatProceedAsFanError,
    logPrefix,
    onProceedAsFanError,
    persistProceedAsFan,
    replaceRoute,
    stopPolling,
  ]);

  const handleApprovedNavigation = useCallback(
    async (redirect: 'organization' | 'create-team') => {
      if (isNavigatingRef.current) return;
      isNavigatingRef.current = true;
      setNavigationTarget(redirect);
      try {
        const { decision } = await getPendingApprovalAuthSnapshot(checkAuth);
        if (decision.route === '/onboarding/coach-agreement') {
          replaceRoute({ pathname: decision.route, params: { redirect } } as any);
        } else {
          replaceRoute(decision.route as any);
        }
      } catch {
        Alert.alert(
          'Connection Error',
          'Could not verify your account status. Please check your connection and try again.'
        );
      } finally {
        isNavigatingRef.current = false;
        if (mountedRef.current) setNavigationTarget(null);
      }
    },
    [checkAuth, replaceRoute]
  );

  return {
    navigationTarget,
    proceedingAsFanRef,
    handleLogout,
    handleProceedAsFan,
    handleApprovedNavigation,
  };
}

export async function fetchRejectionReason(types: string[]) {
  try {
    const page = await NotificationApi.listPage(null, 20, false);
    const rejectionNotif = Array.isArray(page?.items)
      ? page.items.find(
          (notification: any) => types.includes(notification.type) && notification.meta?.reason
        )
      : null;
    return rejectionNotif?.meta?.reason ?? null;
  } catch {
    return null;
  }
}

export function getCoachReapplyCooldownState(
  rejectedAt: Date | string | null | undefined,
  nowMs: number = Date.now()
) {
  const parsed =
    rejectedAt instanceof Date
      ? rejectedAt
      : typeof rejectedAt === 'string' && rejectedAt.trim()
        ? new Date(rejectedAt)
        : null;

  if (!parsed || Number.isNaN(parsed.getTime())) {
    return {
      isActive: false,
      remainingMs: 0,
      retryAt: null as Date | null,
    };
  }

  const retryAtMs = parsed.getTime() + COACH_REAPPLY_COOLDOWN_MS;
  const remainingMs = Math.max(0, retryAtMs - nowMs);

  return {
    isActive: remainingMs > 0,
    remainingMs,
    retryAt: new Date(retryAtMs),
  };
}

export function formatCoachReapplyCooldown(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

export async function reapplyCoachApplication({
  setChecking,
  setRejected,
  setRejectionReason,
  onSuccess,
}: {
  setChecking: (value: boolean) => void;
  setRejected: (value: boolean) => void;
  setRejectionReason: (value: string | null) => void;
  onSuccess: () => void;
}) {
  try {
    setChecking(true);
    await User.reapplyCoach();
    setRejected(false);
    setRejectionReason(null);
    Alert.alert('Application Resubmitted', 'Your coach application is pending review again.');
    onSuccess();
  } catch (error: any) {
    showReapplyCoachError(error);
  } finally {
    setChecking(false);
  }
}

export function showReapplyCoachError(error: any) {
  const message = toUserMessage(error, 'Failed to re-apply.');
  const code = error?.data?.code;
  const retryAfterHours = Number(error?.data?.retry_after_hours);
  const retryAt = error?.data?.retry_at;

  if (code === 'REJECTION_COOLDOWN') {
    let cooldownMessage = 'You can try again once the cooldown expires.';
    if (typeof retryAt === 'string') {
      const when = new Date(retryAt);
      if (!isNaN(when.getTime())) {
        cooldownMessage = `You can try again on ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
      }
    } else if (Number.isFinite(retryAfterHours) && retryAfterHours > 0) {
      cooldownMessage = `You can try again in about ${retryAfterHours} hour${retryAfterHours === 1 ? '' : 's'}.`;
    }
    Alert.alert('Please wait', cooldownMessage);
    return;
  }

  Alert.alert('Failed', message);
}
