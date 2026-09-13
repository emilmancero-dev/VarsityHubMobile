import { Colors } from '@/constants/Colors';
import PasswordInput from '@/components/PasswordInput';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useRouter } from 'expo-router';
import { useCustomColorScheme, useThemePreference } from '@/hooks/useCustomColorScheme';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import { User } from '@/api/entities';
import { httpGet } from '@/api/http';
import { useAuth } from '@/context/AuthProvider';
import { useOnboardingOptional } from '@/context/OnboardingContext';
import { getPostAuthRouteDecision } from '@/utils/appRouteDecisions';
import {
  getAuthSnapshot,
  getFreshAuthSnapshot,
  getLinkedProvidersSnapshot,
} from '@/utils/authState';
import { getCanonicalBillingState } from '@/utils/billingState';
import { getCoachUpgradeCta, type CoachUpgradeCta } from '@/utils/coachUpgradeCta';
import { safeGoBack } from '@/utils/navigation';
import { GUEST_HOME_ROUTE } from '@/utils/publicRoutes';
import { getCanonicalCoachRole } from '@/utils/roleChecks';
import { captureException } from '@/utils/sentry';
import { toUserMessage } from '@/utils/toUserMessage';

interface UserMeResponse {
  email?: string;
  username?: string;
  role?: string;
  approval_status?: string;
  account_state?: string | null;
  next_step?: string | null;
  display_name?: string;
  affiliation?: string;
  dob?: string | null;
  zip_code?: string;
  avatar_url?: string | null;
  bio?: string;
  preferences?: Record<string, unknown>;
  google_id?: string | null;
  apple_id?: string | null;
  has_password?: boolean;
  linked_providers?: {
    password?: boolean;
    google?: boolean;
    apple?: boolean;
  };
}

type CommentPermission = 'everyone' | 'following' | 'none';

interface Preferences {
  notifications: {
    game_event_reminders: boolean;
    team_updates: boolean;
    comments_upvotes: boolean;
    follows_notifications: boolean;
    messages_notifications: boolean;
  };
  is_parent: boolean;
  zip_code: string | null;
  profile_private: boolean;
  comment_permission: CommentPermission;
}

interface PushDiagnostics {
  push_token?: {
    present?: boolean;
    valid_format?: boolean;
    preview?: string | null;
  };
  preferences?: {
    notifications_enabled?: boolean;
  };
  delivery_ready?: boolean;
}

type LinkedProviders = {
  password: boolean;
  google: boolean;
  apple: boolean;
};

const STATUS_COLORS = {
  success: '#16A34A',
  warning: '#D97706',
};

// Inline components for settings
function SectionCard({
  title,
  initiallyOpen = false,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  initiallyOpen?: boolean;
  open?: boolean;
  onOpenChange?: (nextOpen: boolean) => void;
  children: React.ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(initiallyOpen);
  const cs = useCustomColorScheme();
  const palette = Colors[cs ?? 'light'];
  const isControlled = typeof open === 'boolean';
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  return (
    <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.card }]}>
      <Pressable
        style={styles.cardHeader}
        onPress={() => setOpen(!isOpen)}
        accessibilityRole="button"
        accessibilityLabel={`${title} section`}
        accessibilityState={{ expanded: isOpen }}
      >
        <Text style={[styles.cardTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.chev, { color: palette.icon }, isOpen && styles.chevOpen]}>›</Text>
      </Pressable>
      {isOpen && <View style={styles.cardBody}>{children}</View>}
    </View>
  );
}

function NavRow({
  title,
  subtitle,
  onPress,
  destructive,
  isLast,
}: {
  title: string;
  subtitle?: string;
  onPress: () => void;
  destructive?: boolean;
  isLast?: boolean;
}) {
  const cs = useCustomColorScheme();
  const palette = Colors[cs ?? 'light'];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      style={[
        styles.rowBetween,
        !isLast && { borderBottomWidth: 1, borderBottomColor: palette.border },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text
          style={[styles.rowTitle, { color: destructive ? palette.destructive : palette.text }]}
        >
          {title}
        </Text>
        {subtitle && (
          <Text style={[styles.mutedSmall, { color: palette.mutedText }]}>{subtitle}</Text>
        )}
      </View>
      <Text style={[styles.chev, { color: palette.icon }]}>›</Text>
    </Pressable>
  );
}

function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  isLast,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  isLast?: boolean;
}) {
  const cs = useCustomColorScheme();
  const palette = Colors[cs ?? 'light'];
  return (
    <View
      style={[
        styles.rowBetween,
        !isLast && { borderBottomWidth: 1, borderBottomColor: palette.border },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: palette.text }]}>{title}</Text>
        {subtitle && (
          <Text style={[styles.mutedSmall, { color: palette.mutedText }]}>{subtitle}</Text>
        )}
      </View>
      <Switch value={value} onValueChange={onValueChange} accessibilityLabel={title} />
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const colorScheme = useCustomColorScheme();
  const { themePreference, setThemePreference } = useThemePreference();
  const { user, checkAuth, markOnboardingIncompleteLocally, signOut, isAdmin } = useAuth();
  const obCtx = useOnboardingOptional();
  const setOB = obCtx?.setState;
  const initialLinkedProviders = getLinkedProvidersSnapshot(user);
  // Password is only required for deletion if the account has a password AND
  // no OAuth provider — OAuth users can delete without knowing their password.
  const computeDeleteRequiresPassword = useCallback(
    (p: typeof initialLinkedProviders) => p.password && !p.google && !p.apple,
    []
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_email, setEmail] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Preferences>({
    notifications: {
      game_event_reminders: false,
      team_updates: false,
      comments_upvotes: false,
      follows_notifications: true,
      messages_notifications: true,
    },
    is_parent: false,
    zip_code: null,
    profile_private: false,
    comment_permission: 'everyone',
  });
  const [plan, setPlan] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [showCoachBilling, setShowCoachBilling] = useState(false);
  const [coachUpgradeCta, setCoachUpgradeCta] = useState<CoachUpgradeCta | null>(null);
  const [deleteWarningVisible, setDeleteWarningVisible] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteRequiresPassword, setDeleteRequiresPassword] = useState(
    computeDeleteRequiresPassword(initialLinkedProviders)
  );
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [linkedProviders, setLinkedProviders] = useState<LinkedProviders>(initialLinkedProviders);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [upgradingToCoach, setUpgradingToCoach] = useState(false);
  const [downgradingToFan, setDowngradingToFan] = useState(false);
  const [pushDiagnostics, setPushDiagnostics] = useState<PushDiagnostics | null>(null);
  const [pushDiagnosticsError, setPushDiagnosticsError] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const getSettingsSnapshot = useCallback(
    async (options?: { forceRefresh?: boolean; fallback?: UserMeResponse | null }) => {
      const fallback = (options?.fallback ?? user ?? null) as UserMeResponse | null;
      return (
        options?.forceRefresh
          ? await getFreshAuthSnapshot(checkAuth, fallback)
          : await getAuthSnapshot(checkAuth, fallback)
      ) as UserMeResponse | null;
    },
    [checkAuth, user]
  );

  const loadPushDiagnostics = useCallback(async () => {
    try {
      const diagnostics = (await httpGet('/notifications/push-diagnostics')) as PushDiagnostics;
      setPushDiagnostics(diagnostics);
      setPushDiagnosticsError(null);
    } catch (e: any) {
      if (__DEV__) console.warn('[settings] Failed to load push diagnostics:', e);
      setPushDiagnostics(null);
      setPushDiagnosticsError(toUserMessage(e, 'Push status unavailable'));
    }
  }, []);

  // Clear all debounce timers on unmount to prevent memory leaks
  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      Object.values(activeTimers).forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const snapshot = getLinkedProvidersSnapshot(user);
    setDeleteRequiresPassword(computeDeleteRequiresPassword(snapshot));
    setLinkedProviders(snapshot);
  }, [computeDeleteRequiresPassword, user]);

  // Debounced PATCH updater for preferences
  // Only sends the specific fields being changed to avoid overwriting other preferences (e.g. role)
  type PrefsPatch = Omit<Partial<Preferences>, 'notifications'> & {
    notifications?: Partial<Preferences['notifications']>;
  };
  // Single debounce timer to batch all preference changes together
  const pendingPatch = useRef<PrefsPatch>({});
  const patchPrefs = (patch: PrefsPatch) => {
    // Clear any existing timer — we'll send one merged patch
    if (timers.current['__prefs__']) clearTimeout(timers.current['__prefs__']);

    // Accumulate patches
    pendingPatch.current = {
      ...pendingPatch.current,
      ...patch,
      notifications: {
        ...(pendingPatch.current.notifications || {}),
        ...(patch.notifications || {}),
      },
    };

    // Use functional update to get the latest state
    setPrefs(cur => {
      const prevPrefs = cur; // capture snapshot for revert on server error
      const newPrefs = {
        ...cur,
        ...patch,
        notifications: {
          ...cur.notifications,
          ...(patch.notifications || {}),
        },
      };

      // Debounce: send the accumulated patch after 300ms of inactivity
      const merged = pendingPatch.current;
      timers.current['__prefs__'] = setTimeout(async () => {
        const patchToSend = merged.notifications
          ? { ...merged, notifications: { ...newPrefs.notifications } }
          : { ...merged };
        // Clear accumulated patch
        pendingPatch.current = {};
        try {
          await User.updatePreferences(patchToSend);
        } catch (e: any) {
          if (__DEV__) console.error('[settings] Failed to update preferences:', e);
          Alert.alert('Update failed', 'Could not save your preference. Please try again.');
          setPrefs(prevPrefs); // revert optimistic update
        }
      }, 300);

      return newPrefs;
    });
  };

  const applyMeSnapshot = useCallback(
    (me: UserMeResponse, mounted: boolean) => {
      if (!mounted) return;
      setEmail(me?.email || null);
      const serverPrefs = ((me && me.preferences) || {}) as Record<string, any>;
      setPrefs({
        notifications: {
          game_event_reminders: !!serverPrefs?.notifications?.game_event_reminders,
          team_updates: !!serverPrefs?.notifications?.team_updates,
          comments_upvotes: !!serverPrefs?.notifications?.comments_upvotes,
          follows_notifications: serverPrefs?.notifications?.follows_notifications !== false,
          messages_notifications: serverPrefs?.notifications?.messages_notifications !== false,
        },
        is_parent: !!serverPrefs?.is_parent,
        zip_code: serverPrefs?.zip_code ?? null,
        profile_private: !!serverPrefs?.profile_private,
        comment_permission:
          serverPrefs?.comment_permission === 'following' ||
          serverPrefs?.comment_permission === 'none'
            ? serverPrefs.comment_permission
            : 'everyone',
      });
      const billingState = getCanonicalBillingState(me as any);
      setPlan(billingState.selected_plan);
      const effectiveRole = getCanonicalCoachRole(me as any);
      setRole(effectiveRole);
      const coachAccess = {
        isApprovedCoach: effectiveRole === 'coach' && me?.approval_status === 'APPROVED',
      };
      const nextCoachUpgradeCta = getCoachUpgradeCta(me as any);
      setCoachUpgradeCta(nextCoachUpgradeCta);
      const linkedProviders = getLinkedProvidersSnapshot(me);
      setDeleteRequiresPassword(computeDeleteRequiresPassword(linkedProviders));
      setLinkedProviders(linkedProviders);
      setShowCoachBilling(
        coachAccess.isApprovedCoach ||
          billingState.selected_plan !== 'rookie' ||
          !!nextCoachUpgradeCta
      );
    },
    [computeDeleteRequiresPassword]
  );

  const showPasswordSettings = linkedProviders.password;
  const showGoogleStatus = linkedProviders.google;
  const showAppleStatus = linkedProviders.apple;
  const visibleProviderStatuses = [
    showGoogleStatus ? 'google' : null,
    showAppleStatus ? 'apple' : null,
  ].filter(Boolean) as Array<'google' | 'apple'>;
  const canDowngradeCoach =
    String(role || '')
      .trim()
      .toLowerCase() === 'coach';
  const _restartOnboarding = async () => {
    try {
      const me = await getSettingsSnapshot();
      const prefsFromServer = (me?.preferences || {}) as Record<string, unknown>;
      const preload: Record<string, unknown> = {
        role: getCanonicalCoachRole(me as any) || 'fan',
        display_name: prefsFromServer.display_name ?? me?.display_name ?? '',
        affiliation: prefsFromServer.affiliation ?? me?.affiliation ?? '',
        dob: prefsFromServer.dob ?? me?.dob ?? null,
        zip_code: prefsFromServer.zip_code ?? me?.zip_code ?? '',
        plan: prefsFromServer.plan ?? null,
        avatar_url: me?.avatar_url ?? prefsFromServer.avatar_url ?? null,
        bio: me?.bio ?? prefsFromServer.bio ?? '',
        sports_interests: prefsFromServer.sports_interests ?? prefsFromServer.sports ?? [],
        primary_intents: prefsFromServer.primary_intents ?? [],
      };

      // Previously we attempted to record onboarding history here, but the context no longer exposes that API.
      try {
        void (await User.updatePreferences({ onboarding_completed: false }));
        // Also clear local AsyncStorage flag so next launch doesn't skip onboarding
        await markOnboardingIncompleteLocally();
      } catch (error: any) {
        if (__DEV__) console.warn('[settings] Failed to reset onboarding_completed flag:', error);
        // Continue anyway - user will be redirected to onboarding
      }
      if (setOB) void setOB(preload);
      router.replace('/onboarding/step-1-role');
    } catch (e: any) {
      // Error in onboarding restart - try fallback
      if (__DEV__) console.error('[settings] Failed to restart onboarding:', e);
      try {
        void (await User.updatePreferences({ onboarding_completed: false }));
        await markOnboardingIncompleteLocally();
      } catch (error: any) {
        if (__DEV__) console.warn('[settings] Failed to reset onboarding status:', error);
        // Continue anyway - user will be redirected to onboarding
      }
      router.replace('/onboarding');
    }
  };

  const performSignOut = async () => {
    try {
      void obCtx?.clearOnboarding?.();
    } catch (error: any) {
      if (__DEV__) console.warn('[settings] Failed to clear onboarding:', error);
    }

    try {
      await signOut();
    } catch (error: any) {
      if (__DEV__) console.warn('[settings] Sign out via AuthProvider failed:', error);
      router.replace(GUEST_HOME_ROUTE);
    }
  };

  const performDeleteAccount = async () => {
    if (deletingAccount) return;
    const confirmation = deleteConfirmation.trim().toUpperCase();
    const pwd = deletePassword.trim();
    if (confirmation !== 'DELETE') {
      Alert.alert('Confirmation required', 'Type DELETE to confirm account deletion.');
      return;
    }
    if (deleteRequiresPassword && !pwd) {
      Alert.alert('Password required', 'Enter your password to confirm account deletion.');
      return;
    }
    setDeletingAccount(true);
    try {
      await User.deleteAccount({
        delete_confirmation: confirmation,
        ...(deleteRequiresPassword ? { password: pwd } : {}),
      });
    } catch (error: any) {
      if (__DEV__) console.error('[settings] Account deletion failed:', error);
      const msg = toUserMessage(error, 'Could not delete your account.');
      Alert.alert('Delete failed', msg);
      setDeletingAccount(false);
      return;
    }

    setDeleteModalVisible(false);
    setDeleteConfirmation('');
    setDeletePassword('');
    setDeletingAccount(false);
    await performSignOut();
  };

  const confirmDeleteAccount = () => {
    setDeleteWarningVisible(true);
  };

  const proceedToDeleteConfirm = () => {
    setDeleteWarningVisible(false);
    setDeleteConfirmation('');
    setDeletePassword('');
    setDeleteModalVisible(true);
  };

  // Move the async logic into useEffect
  useEffect(() => {
    let mounted = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const me = await getSettingsSnapshot();
        if (!me) {
          return;
        }
        if (!mounted) return;
        applyMeSnapshot(me, mounted);
        void loadPushDiagnostics();
      } catch (e: any) {
        if (!mounted) return;
        // Handle authentication errors gracefully - don't show "Unauthorized" to user
        // AuthProvider will handle redirecting to sign-in
        const isAuthError =
          e?.status === 401 ||
          e?.status === 403 ||
          (typeof e?.message === 'string' &&
            (e.message.toLowerCase().includes('unauthorized') ||
              e.message.toLowerCase().includes('forbidden')));
        if (isAuthError) {
          if (__DEV__) console.warn('[settings] Authentication error - refreshing auth state');
          // Trigger auth check to let AuthProvider handle redirect
          try {
            await checkAuth();
          } catch (authErr) {
            if (__DEV__) console.warn('[settings] Auth check failed:', authErr);
          }
          // Don't set error - let AuthProvider redirect to sign-in
          // The error state will be cleared when user is redirected
          return;
        }
        // Only show non-auth errors to the user
        setError(toUserMessage(e, 'Failed to load settings'));
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [applyMeSnapshot, checkAuth, getSettingsSnapshot, loadPushDiagnostics]);

  const pushStatus = pushDiagnostics?.delivery_ready
    ? {
        icon: 'checkmark-circle' as const,
        title: 'Push Delivery Ready',
        subtitle: pushDiagnostics.push_token?.preview
          ? `Registered token ${pushDiagnostics.push_token.preview}`
          : 'Registered token',
        color: STATUS_COLORS.success,
      }
    : pushDiagnostics?.preferences?.notifications_enabled === false
      ? {
          icon: 'notifications-off-circle' as const,
          title: 'Push Delivery Off',
          subtitle: 'Notifications are disabled for this account',
          color: STATUS_COLORS.warning,
        }
      : pushDiagnostics?.push_token?.present === false
        ? {
            icon: 'alert-circle' as const,
            title: 'Device Token Missing',
            subtitle: 'This device has not registered for push delivery',
            color: STATUS_COLORS.warning,
          }
        : pushDiagnostics?.push_token?.valid_format === false
          ? {
              icon: 'alert-circle' as const,
              title: 'Device Token Invalid',
              subtitle: 'The stored push token cannot be used',
              color: Colors[colorScheme ?? 'light'].destructive,
            }
          : pushDiagnosticsError
            ? {
                icon: 'alert-circle' as const,
                title: 'Push Status Unavailable',
                subtitle: pushDiagnosticsError,
                color: Colors[colorScheme ?? 'light'].mutedText,
              }
            : {
                icon: 'ellipse' as const,
                title: 'Checking Push Delivery',
                subtitle: 'Checking registration status',
                color: Colors[colorScheme ?? 'light'].mutedText,
              };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerShown: true,
          headerBackTitle: 'Back',
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              hitSlop={12}
              style={{ marginRight: 8 }}
            >
              <Ionicons name="chevron-back" size={28} color={Colors[colorScheme ?? 'light'].tint} />
            </Pressable>
          ),
        }}
      />
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme ?? 'light'].background }]}
        edges={['bottom']}
      >
        {loading && (
          <View style={styles.statusRow} accessibilityRole="progressbar">
            <ActivityIndicator size="small" color={Colors[colorScheme ?? 'light'].tint} />
            <Text style={[styles.statusText, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
              Loading settings...
            </Text>
          </View>
        )}

        {!!error && (
          <View
            style={[
              styles.errorBanner,
              {
                backgroundColor: Colors[colorScheme ?? 'light'].surface,
                borderColor: Colors[colorScheme ?? 'light'].destructive,
              },
            ]}
          >
            <Ionicons
              name="alert-circle"
              size={18}
              color={Colors[colorScheme ?? 'light'].destructive}
            />
            <Text style={[styles.errorBannerText, { color: Colors[colorScheme ?? 'light'].text }]}>
              {error}
            </Text>
          </View>
        )}

        <ScrollView>
          {/* Account */}
          <SectionCard title="Account" initiallyOpen>
            <NavRow
              title="Edit Username"
              onPress={() => void router.push('/settings/edit-username')}
            />
            {showPasswordSettings && (
              <NavRow
                title="Reset Password"
                onPress={() => void router.push('/settings/reset-password')}
              />
            )}
            <NavRow
              title="RSVP History"
              onPress={() => void router.push('/settings/rsvp-history')}
            />
            <NavRow
              title="Followed Teams"
              onPress={() => void router.push('/settings/followed-teams')}
            />
            {visibleProviderStatuses.map((provider, index) => (
              <NavRow
                key={provider}
                title={provider === 'google' ? 'Google Sign-In' : 'Apple Sign-In'}
                subtitle={`Connected to ${provider === 'google' ? 'Google' : 'Apple'} Sign-In`}
                isLast={index === visibleProviderStatuses.length - 1}
                onPress={() => {}}
              />
            ))}
            <NavRow
              title="Delete Account"
              subtitle="Permanently delete your account and data"
              destructive
              isLast
              onPress={confirmDeleteAccount}
            />
          </SectionCard>

          <SectionCard title="Appearance" open={appearanceOpen} onOpenChange={setAppearanceOpen}>
            <View style={styles.themeOptions}>
              {[
                { value: 'system', label: 'System', subtitle: 'Follow browser or device setting' },
                { value: 'light', label: 'Light', subtitle: 'Always use the light theme' },
                { value: 'dark', label: 'Dark', subtitle: 'Always use the dark theme' },
              ].map(option => {
                const selected = themePreference === option.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => {
                      void setThemePreference(option.value as 'light' | 'dark' | 'system');
                      setAppearanceOpen(false);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    style={[
                      styles.themeOption,
                      {
                        borderColor: Colors[colorScheme ?? 'light'].border,
                        backgroundColor: selected
                          ? Colors[colorScheme ?? 'light'].surface
                          : 'transparent',
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.themeOptionIndicator,
                        { borderColor: Colors[colorScheme ?? 'light'].border },
                        selected && [
                          styles.themeOptionIndicatorSelected,
                          {
                            borderColor: Colors[colorScheme ?? 'light'].tint,
                            backgroundColor: Colors[colorScheme ?? 'light'].tint,
                          },
                        ],
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.themeOptionText,
                          { color: Colors[colorScheme ?? 'light'].text },
                          selected && [
                            styles.themeOptionTextSelected,
                            { color: Colors[colorScheme ?? 'light'].tint },
                          ],
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text
                        style={[
                          styles.themeOptionSubtext,
                          { color: Colors[colorScheme ?? 'light'].mutedText, marginLeft: 0 },
                        ]}
                      >
                        {option.subtitle}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          {/* Notifications */}
          <SectionCard title="Notifications" initiallyOpen>
            {/* Push-delivery diagnostics (registered token, delivery state) are a
                developer tool only — they must never surface to end users in
                production. Owner note (Sep 2026): "Remove push deliver ready.
                That shouldn't be shown on front end." Gated to __DEV__. */}
            {__DEV__ && (
              <View
                style={[
                  styles.notificationStatusRow,
                  {
                    borderBottomWidth: 1,
                    borderBottomColor: Colors[colorScheme ?? 'light'].border,
                  },
                ]}
              >
                <Ionicons name={pushStatus.icon} size={20} color={pushStatus.color} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: Colors[colorScheme ?? 'light'].text }]}>
                    {pushStatus.title}
                  </Text>
                  <Text
                    style={[styles.mutedSmall, { color: Colors[colorScheme ?? 'light'].mutedText }]}
                  >
                    {pushStatus.subtitle}
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    void loadPushDiagnostics();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh push delivery status"
                  hitSlop={10}
                  style={styles.iconButton}
                >
                  <Ionicons name="refresh" size={18} color={Colors[colorScheme ?? 'light'].tint} />
                </Pressable>
              </View>
            )}
            <SwitchRow
              title="Game/Event Reminders"
              value={!!prefs.notifications.game_event_reminders}
              onValueChange={v => patchPrefs({ notifications: { game_event_reminders: v } })}
            />
            <SwitchRow
              title="Team Updates"
              value={!!prefs.notifications.team_updates}
              onValueChange={v => patchPrefs({ notifications: { team_updates: v } })}
            />
            <SwitchRow
              title="Comments & Upvotes"
              value={!!prefs.notifications.comments_upvotes}
              onValueChange={v => patchPrefs({ notifications: { comments_upvotes: v } })}
            />
            <SwitchRow
              title="New Followers"
              subtitle="When someone follows you"
              value={!!prefs.notifications.follows_notifications}
              onValueChange={v => patchPrefs({ notifications: { follows_notifications: v } })}
            />
            <SwitchRow
              title="Direct Messages"
              subtitle="When someone sends you a DM"
              value={!!prefs.notifications.messages_notifications}
              onValueChange={v => patchPrefs({ notifications: { messages_notifications: v } })}
              isLast
            />
          </SectionCard>

          {/* Privacy */}
          <SectionCard title="Privacy">
            <SwitchRow
              title="Private Profile"
              subtitle="Only followers can see your posts, bio, and follower counts"
              value={!!prefs.profile_private}
              onValueChange={v => patchPrefs({ profile_private: v })}
            />
            <View
              style={[
                styles.rowBetween,
                { borderBottomWidth: 1, borderBottomColor: Colors[colorScheme ?? 'light'].border },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: Colors[colorScheme ?? 'light'].text }]}>
                  Comment Permissions
                </Text>
                <Text
                  style={[styles.mutedSmall, { color: Colors[colorScheme ?? 'light'].mutedText }]}
                >
                  {prefs.comment_permission === 'everyone'
                    ? 'Everyone'
                    : prefs.comment_permission === 'following'
                      ? 'People I Follow'
                      : 'Nobody'}
                </Text>
              </View>
              <Pressable
                style={[styles.commentPermRow]}
                onPress={() => {
                  Alert.alert('Who can comment on your posts?', undefined, [
                    {
                      text: 'Everyone',
                      onPress: () => {
                        setPrefs(p => ({ ...p, comment_permission: 'everyone' }));
                        User.updatePreferences({ comment_permission: 'everyone' }).catch(() => {
                          setPrefs(p => ({ ...p, comment_permission: prefs.comment_permission }));
                          Alert.alert('Error', 'Failed to save preference. Please try again.');
                        });
                      },
                    },
                    {
                      text: 'People I Follow',
                      onPress: () => {
                        setPrefs(p => ({ ...p, comment_permission: 'following' }));
                        User.updatePreferences({ comment_permission: 'following' }).catch(() => {
                          setPrefs(p => ({ ...p, comment_permission: prefs.comment_permission }));
                          Alert.alert('Error', 'Failed to save preference. Please try again.');
                        });
                      },
                    },
                    {
                      text: 'Nobody',
                      onPress: () => {
                        setPrefs(p => ({ ...p, comment_permission: 'none' }));
                        User.updatePreferences({ comment_permission: 'none' }).catch(() => {
                          setPrefs(p => ({ ...p, comment_permission: prefs.comment_permission }));
                          Alert.alert('Error', 'Failed to save preference. Please try again.');
                        });
                      },
                    },
                    { text: 'Cancel', style: 'cancel' },
                  ]);
                }}
                accessibilityLabel="Comment permissions"
                accessibilityRole="button"
              >
                <Text style={[styles.chev, { color: Colors[colorScheme ?? 'light'].icon }]}>›</Text>
              </Pressable>
            </View>
            <NavRow
              title="Manage Blocked Users"
              onPress={() => void router.push('/settings/blocked-users')}
            />
            <SwitchRow
              title="I am a parent"
              subtitle="Disclose your parent status to coaches."
              value={!!prefs.is_parent}
              onValueChange={v => patchPrefs({ is_parent: v })}
              isLast
            />
          </SectionCard>

          {/* My Content */}
          <SectionCard title="My Content">
            <NavRow
              title="View Favorites"
              subtitle="Posts you've saved"
              onPress={() => void router.push('/settings/favorites')}
            />
            {user?.email_verified ? (
              <>
                <NavRow
                  title="Reserve Ad Space"
                  subtitle="Promote your program, fundraiser, or business"
                  onPress={() => void router.navigate('/submit-ad')}
                />
                <NavRow
                  title="My Ads"
                  subtitle="Manage your advertisements"
                  isLast
                  onPress={() => void router.navigate('/my-ads')}
                />
              </>
            ) : (
              <NavRow
                title="My Ads"
                subtitle="Verify your email to book and manage ads"
                isLast
                onPress={() => void router.navigate('/my-ads')}
              />
            )}
          </SectionCard>

          {/* Billing (coaches only) */}
          {showCoachBilling && (
            <SectionCard title="Billing">
              <NavRow
                title="Manage Subscription"
                isLast
                subtitle={
                  plan
                    ? `Plan: ${String(plan).charAt(0).toUpperCase() + String(plan).slice(1)}`
                    : 'No subscription'
                }
                onPress={() => void router.push('/settings/manage-subscription')}
              />
            </SectionCard>
          )}

          {/* Contact VarsityHub */}
          <SectionCard title="Contact VarsityHub Team">
            <NavRow title="Leave Feedback" onPress={() => void router.push('/settings/feedback')} />
            <NavRow
              title="Report Abuse"
              isLast
              onPress={() => void router.navigate('/report-abuse')}
            />
          </SectionCard>

          <SectionCard title="Privacy">
            <NavRow
              title="Download My Data"
              subtitle="Request and download a privacy export archive"
              onPress={() => void router.push('/settings/data-export')}
            />
            <NavRow
              title="Privacy Policy"
              onPress={() => void router.push('/settings/privacy-policy')}
            />
            <NavRow
              title="Terms of Service"
              onPress={() => void router.push('/settings/terms-of-service')}
            />
            <NavRow
              title="Copyright & DMCA"
              isLast
              onPress={() => void router.push('/settings/dmca')}
            />
          </SectionCard>

          {/* Admin Panel - Only visible to admins */}
          {isAdmin && (
            <SectionCard title="🛡️ Admin Panel" initiallyOpen>
              <NavRow
                title="Admin Dashboard"
                subtitle="Overview and analytics"
                onPress={() => void router.navigate('/admin-dashboard')}
              />
              <NavRow
                title="Activity Log"
                subtitle="Track all admin actions"
                onPress={() => void router.navigate('/admin-activity-log')}
              />
              <NavRow
                title="Manage Users"
                subtitle="View all users, ban/unban"
                onPress={() => void router.navigate('/admin-users')}
              />
              <NavRow
                title="Manage Teams"
                subtitle="View and moderate all teams"
                onPress={() => void router.navigate('/admin-teams')}
              />
              <NavRow
                title="Manage Ads"
                subtitle="Review and moderate advertisements"
                onPress={() => void router.navigate('/admin-ads')}
              />
              <NavRow
                title="View Messages"
                subtitle="Content moderation"
                onPress={() => void router.navigate('/admin-messages')}
              />
              <NavRow
                title="Transactions"
                subtitle="Payment history and analytics"
                onPress={() => void router.navigate('/admin-transactions' as any)}
              />
              <NavRow
                title="Platform Metrics"
                subtitle="Growth trends and analytics"
                onPress={() => void router.navigate('/admin-metrics' as any)}
              />
              <NavRow
                title="Reports"
                subtitle="Review abuse reports"
                onPress={() => void router.navigate('/admin-reports' as any)}
              />
              <NavRow
                title="Create Event"
                subtitle="Create platform-wide events"
                isLast
                onPress={() => void router.navigate('/admin-create-event' as any)}
              />
            </SectionCard>
          )}

          <SectionCard title="Events">
            <NavRow
              title="Request to Host Event"
              subtitle="Submit a community event for review"
              isLast
              onPress={() => void router.push('/settings/request-host-event')}
            />
          </SectionCard>

          {/* Session */}
          <SectionCard title="Session">
            <NavRow
              title="Log Out"
              destructive
              onPress={() => {
                Alert.alert('Log out', 'Are you sure you want to log out?', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Log Out',
                    style: 'destructive',
                    onPress: () => {
                      void performSignOut();
                    },
                  },
                ]);
              }}
            />
            <NavRow
              title="Delete Account"
              destructive
              isLast={!coachUpgradeCta && !canDowngradeCoach && !downgradingToFan}
              onPress={confirmDeleteAccount}
            />
            {canDowngradeCoach && (
              <NavRow
                title="Downgrade to Fan Account"
                subtitle="Transfer any team or organization ownership first"
                isLast={!coachUpgradeCta && !downgradingToFan}
                onPress={() => {
                  Alert.alert(
                    'Downgrade to Fan Account',
                    'This changes your account back to fan access. You must transfer any organization ownership and leave team staff roles before continuing.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Continue',
                        style: 'destructive',
                        onPress: async () => {
                          try {
                            setDowngradingToFan(true);
                            await User.downgradeToFan();
                            const fresh = await getSettingsSnapshot({ forceRefresh: true });
                            if (fresh) {
                              applyMeSnapshot(fresh, true);
                            } else {
                              setRole('fan');
                              setPlan('rookie');
                            }

                            Alert.alert('Account updated', 'Your account is now a fan account.');
                          } catch (e: any) {
                            const code = e?.data?.code;
                            const msg = toUserMessage(e, 'Failed to downgrade account.');
                            if (code === 'SUBSCRIPTION_DOWNGRADE_REQUIRED') {
                              Alert.alert(
                                'Downgrade subscription first',
                                'Move your subscription back to the free Rookie plan before downgrading this account.'
                              );
                            } else if (code === 'ORG_OWNERSHIP_TRANSFER_REQUIRED') {
                              Alert.alert(
                                'Transfer organization ownership first',
                                'You still own an organization. Transfer ownership before downgrading to fan.'
                              );
                            } else if (code === 'ORG_ROLE_TRANSFER_REQUIRED') {
                              Alert.alert(
                                'Leave organization leadership roles',
                                'You still have active organization owner or manager roles. Reassign or leave those roles first.'
                              );
                            } else if (code === 'TEAM_ROLE_TRANSFER_REQUIRED') {
                              Alert.alert(
                                'Leave team staff roles',
                                'You still have active team owner, manager, coach, or assistant coach roles. Reassign or leave those roles first.'
                              );
                            } else {
                              Alert.alert('Error', msg);
                            }
                          } finally {
                            setDowngradingToFan(false);
                          }
                        },
                      },
                    ]
                  );
                }}
              />
            )}
            {coachUpgradeCta && (
              <NavRow
                title={coachUpgradeCta.title}
                subtitle={coachUpgradeCta.subtitle}
                isLast
                onPress={() => {
                  if (coachUpgradeCta.kind === 'resume') {
                    router.replace(coachUpgradeCta.route as any);
                    return;
                  }
                  Alert.alert('Upgrade to Coach Account', coachUpgradeCta.subtitle, [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Continue',
                      onPress: async () => {
                        const routeCoachOnboarding = async (
                          freshUser?: UserMeResponse | null,
                          preferredRoute?: string | null
                        ) => {
                          try {
                            if (preferredRoute && preferredRoute !== '/(tabs)') {
                              router.replace(preferredRoute as any);
                              return;
                            }
                            const fresh = freshUser;
                            const prefs = (fresh?.preferences || {}) as Record<string, any>;
                            const hasUsername = !!(
                              fresh?.username && String(fresh.username).trim()
                            );
                            const dob = prefs.dob || prefs.date_of_birth || fresh?.dob;
                            const zip = prefs.zip_code || prefs.zip || fresh?.zip_code;
                            const hasDob = !!dob && String(dob).trim().length > 0;
                            const hasZip = !!zip && String(zip).trim().length > 0;
                            const hasCompletedBasicStep = hasUsername && hasDob && hasZip;
                            const nextRoute =
                              preferredRoute && preferredRoute !== '/(tabs)'
                                ? preferredRoute
                                : fresh
                                  ? getPostAuthRouteDecision(fresh as any).route
                                  : null;
                            if (setOB) {
                              setOB(prev => ({
                                ...prev,
                                role: 'coach',
                                plan: (prefs.plan as any) || 'rookie',
                                username: fresh?.username ?? prev?.username,
                                dob: (dob as string | undefined) ?? prev?.dob,
                                zip: (zip as string | undefined) ?? prev?.zip,
                                zip_code: (zip as string | undefined) ?? prev?.zip_code ?? null,
                                step_2_visited: hasCompletedBasicStep,
                                step_3_visited: false,
                              }));
                            }
                            setPlan((prefs.plan as string | null) ?? 'rookie');
                            if (nextRoute && nextRoute !== '/(tabs)') {
                              // nav-safe: settings → resume server-directed onboarding step
                              router.replace(nextRoute as any);
                              return;
                            }
                            const resumeRoute = hasCompletedBasicStep
                              ? '/onboarding/coach-application'
                              : '/onboarding/step-2-basic';
                            router.replace(resumeRoute as any); // nav-safe: settings → resume coach onboarding flow
                          } catch (routeErr) {
                            captureException(
                              routeErr instanceof Error ? routeErr : new Error(String(routeErr)),
                              { context: 'routeCoachOnboarding' }
                            );
                            router.replace('/onboarding/step-2-basic');
                          }
                        };
                        try {
                          setUpgradingToCoach(true);
                          await User.upgradeToCoach('rookie');
                          setRole('coach');
                          setPlan('rookie');
                          await markOnboardingIncompleteLocally();
                          const fresh = await getSettingsSnapshot({ forceRefresh: true });
                          if (fresh) {
                            applyMeSnapshot(fresh, true);
                          }
                          await routeCoachOnboarding(fresh);
                        } catch (e: any) {
                          const msg = toUserMessage(e, '');
                          const code = e?.data?.code;
                          if (
                            code === 'COACH_UPGRADE_IN_PROGRESS' ||
                            code === 'COACH_REAPPLICATION_REQUIRED' ||
                            code === 'COACH_ALREADY_APPROVED' ||
                            msg.toLowerCase().includes('already a coach')
                          ) {
                            const fresh = await getSettingsSnapshot({ forceRefresh: true });
                            const nextCta = getCoachUpgradeCta({
                              ...fresh,
                              role:
                                (fresh?.preferences as Record<string, any> | undefined)?.role ||
                                fresh?.role ||
                                null,
                              preferences: fresh?.preferences || {},
                            });
                            if (fresh) {
                              applyMeSnapshot(fresh, true);
                            }
                            await routeCoachOnboarding(
                              fresh,
                              e?.data?.next_step || nextCta?.route || null
                            );
                            return;
                          }
                          // v1.0.3: surface the specific server error codes that
                          // block upgrade so users know exactly what to do.
                          if (code === 'REJECTION_COOLDOWN') {
                            const retryAt = e?.data?.retry_at;
                            const hrs = Number(e?.data?.retry_after_hours);
                            let msgText = 'You can try again once the cooldown expires.';
                            if (typeof retryAt === 'string') {
                              const when = new Date(retryAt);
                              if (!isNaN(when.getTime())) {
                                msgText = `You can try again on ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
                              }
                            } else if (Number.isFinite(hrs) && hrs > 0) {
                              msgText = `You can try again in about ${hrs} hour${hrs === 1 ? '' : 's'}.`;
                            }
                            Alert.alert('Please wait', msgText);
                          } else if (code === 'DOB_REQUIRED') {
                            Alert.alert(
                              'Date of birth required',
                              'We need your date of birth on file before you can upgrade to a coach account. Tap Edit Profile to add it.'
                            );
                          } else if (code === 'AGE_REQUIREMENT') {
                            Alert.alert(
                              'Age requirement',
                              'Coach accounts require users to be at least 18 years old.'
                            );
                          } else {
                            Alert.alert('Error', msg || 'Failed to upgrade. Please try again.');
                          }
                        } finally {
                          setUpgradingToCoach(false);
                        }
                      },
                    },
                  ]);
                }}
              />
            )}
            {upgradingToCoach && (
              <View style={[styles.rowBetween, { opacity: 0.75 }]}>
                <Text
                  style={[styles.mutedSmall, { color: Colors[colorScheme ?? 'light'].mutedText }]}
                >
                  Upgrading your account...
                </Text>
              </View>
            )}
            {downgradingToFan && (
              <View style={[styles.rowBetween, { opacity: 0.75 }]}>
                <Text
                  style={[styles.mutedSmall, { color: Colors[colorScheme ?? 'light'].mutedText }]}
                >
                  Downgrading your account...
                </Text>
              </View>
            )}
          </SectionCard>

          {/* Copyright Footer */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 24, alignItems: 'center' }}>
            <Text
              style={{
                fontSize: 12,
                color: Colors[colorScheme ?? 'light'].mutedText,
                textAlign: 'center',
              }}
            >
              © 2025 LIME PRODUCTIONS. All rights reserved.
            </Text>
          </View>
        </ScrollView>
        <Modal
          visible={deleteWarningVisible}
          animationType="slide"
          onRequestClose={() => setDeleteWarningVisible(false)}
        >
          <View
            style={[
              styles.deleteWarningPage,
              { backgroundColor: Colors[colorScheme ?? 'light'].background },
            ]}
          >
            <View style={styles.deleteWarningContent}>
              <Text
                style={[styles.deleteWarningTitle, { color: Colors[colorScheme ?? 'light'].text }]}
              >
                Are you sure?
              </Text>
              <Text
                style={[
                  styles.deleteWarningBody,
                  { color: Colors[colorScheme ?? 'light'].mutedText },
                ]}
              >
                This will permanently delete your account and all your posts and media.
              </Text>
            </View>
            <View style={styles.deleteWarningActions}>
              <Pressable
                style={[
                  styles.deleteWarningBtn,
                  { backgroundColor: Colors[colorScheme ?? 'light'].border },
                ]}
                onPress={() => setDeleteWarningVisible(false)}
              >
                <Text
                  style={[
                    styles.deleteWarningBtnText,
                    { color: Colors[colorScheme ?? 'light'].text },
                  ]}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                style={[styles.deleteWarningBtn, { backgroundColor: '#DC2626' }]}
                onPress={proceedToDeleteConfirm}
              >
                <Text style={[styles.deleteWarningBtnText, { color: '#FFFFFF' }]}>Continue</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <Modal
          visible={deleteModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!deletingAccount) setDeleteModalVisible(false);
          }}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={0}
          >
            <View style={styles.deleteModalBackdrop}>
              <View
                style={[
                  styles.deleteModalCard,
                  {
                    backgroundColor: Colors[colorScheme ?? 'light'].card,
                    borderColor: Colors[colorScheme ?? 'light'].border,
                  },
                ]}
              >
                <Text
                  style={[styles.deleteModalTitle, { color: Colors[colorScheme ?? 'light'].text }]}
                >
                  Delete Account
                </Text>
                <Text
                  style={[
                    styles.deleteModalBody,
                    { color: Colors[colorScheme ?? 'light'].mutedText },
                  ]}
                >
                  {deleteRequiresPassword
                    ? 'This permanently deletes your account. Enter your password to confirm.'
                    : 'This permanently deletes your account. No password is required for Apple/Google-only accounts.'}
                </Text>
                <TextInput
                  value={deleteConfirmation}
                  onChangeText={setDeleteConfirmation}
                  editable={!deletingAccount}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="Type DELETE"
                  placeholderTextColor={Colors[colorScheme ?? 'light'].mutedText}
                  style={[
                    styles.deleteInput,
                    {
                      color: Colors[colorScheme ?? 'light'].text,
                      borderColor: Colors[colorScheme ?? 'light'].border,
                      marginTop: 8,
                    },
                  ]}
                />
                {deleteRequiresPassword && (
                  <PasswordInput
                    value={deletePassword}
                    onChangeText={setDeletePassword}
                    editable={!deletingAccount}
                    placeholder="Password"
                    placeholderTextColor={Colors[colorScheme ?? 'light'].mutedText}
                    style={[
                      styles.deleteInput,
                      {
                        color: Colors[colorScheme ?? 'light'].text,
                        borderColor: Colors[colorScheme ?? 'light'].border,
                        marginTop: 8,
                      },
                    ]}
                  />
                )}
                <View style={styles.deleteModalActions}>
                  <Pressable
                    style={[styles.deleteActionBtn, styles.deleteCancelBtn]}
                    onPress={() => {
                      if (!deletingAccount) setDeleteModalVisible(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.deleteActionText,
                        { color: Colors[colorScheme ?? 'light'].text },
                      ]}
                    >
                      Cancel
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.deleteActionBtn,
                      styles.deleteConfirmBtn,
                      (deleteConfirmation.trim().toUpperCase() !== 'DELETE' ||
                        (deleteRequiresPassword && !deletePassword.trim()) ||
                        deletingAccount) &&
                        styles.deleteConfirmBtnDisabled,
                    ]}
                    disabled={
                      deleteConfirmation.trim().toUpperCase() !== 'DELETE' ||
                      (deleteRequiresPassword && !deletePassword.trim()) ||
                      deletingAccount
                    }
                    onPress={() => {
                      void performDeleteAccount();
                    }}
                  >
                    <Text style={styles.deleteConfirmText}>
                      {deletingAccount ? 'Deleting…' : 'Delete'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8, paddingHorizontal: 16 },
  error: { marginHorizontal: 16, marginBottom: 8 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  card: { marginHorizontal: 16, marginBottom: 6, borderRadius: 12, borderWidth: 1 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  cardBody: { paddingHorizontal: 12, paddingBottom: 4 },
  cardTitle: { fontWeight: '800', fontSize: 16 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  rowTitle: { fontWeight: '600' },
  mutedSmall: { fontSize: 12 },
  notificationStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chev: { fontSize: 20, transform: [{ rotate: '0deg' }] },
  chevOpen: { transform: [{ rotate: '90deg' }] },
  commentPermRow: { padding: 8 },
  destructive: { color: '#DC2626' },
  selectedValue: { fontSize: 14 },
  themeOptions: { marginTop: 8, gap: 8 },
  themeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  themeOptionSelected: {
    backgroundColor: '#f3f4f6',
  },
  themeOptionIndicator: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    marginRight: 12,
    backgroundColor: 'transparent',
  },
  themeOptionIndicatorSelected: {
    borderColor: '#0a7ea4',
    backgroundColor: '#0a7ea4',
  },
  themeOptionText: {
    fontSize: 16,
    fontWeight: '500',
    flex: 1,
  },
  themeOptionTextSelected: {
    color: '#0a7ea4',
    fontWeight: '600',
  },
  themeOptionSubtext: {
    fontSize: 12,
    marginLeft: 'auto',
  },
  deleteWarningPage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  deleteWarningContent: {
    alignItems: 'center',
    marginBottom: 40,
  },
  deleteWarningTitle: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  deleteWarningBody: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  deleteWarningActions: {
    width: '100%',
    gap: 12,
  },
  deleteWarningBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  deleteWarningBtnText: {
    fontSize: 17,
    fontWeight: '700',
  },
  deleteModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  deleteModalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  deleteModalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  deleteModalBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  deleteInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    letterSpacing: 0.8,
  },
  deleteModalActions: {
    marginTop: 4,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  deleteActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  deleteCancelBtn: {
    backgroundColor: '#D1D5DB',
  },
  deleteConfirmBtn: {
    backgroundColor: '#DC2626',
  },
  deleteConfirmBtnDisabled: {
    opacity: 0.5,
  },
  deleteActionText: {
    fontWeight: '600',
  },
  deleteConfirmText: {
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
