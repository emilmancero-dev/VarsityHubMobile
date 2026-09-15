import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import Notifications from '@/utils/notifications';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Fan-only permissions screen — the final step of fan onboarding.
// Coaches never land here; they proceed through coach-application → step-3.
// This screen must only be reachable from the fan onboarding path.
export default function FanPermissions() {
  const colorScheme = useColorScheme() ?? 'light';
  const isDark = colorScheme === 'dark';
  const palette = Colors[colorScheme];
  const router = useRouter();
  const { user, registerPushToken, checkAuth } = useAuth();
  const [loading, setLoading] = useState(false);
  // Set when server-side onboarding completion succeeded (it already did, in
  // step-2) but we couldn't refresh the local `user` after several retries —
  // surfaces a retry affordance instead of silently bouncing back to step-1.
  const [stuck, setStuck] = useState(false);
  // Toggles let the user confirm which permissions to grant instead of firing
  // both system dialogs unconditionally. Default ON — this screen is opt-out.
  const [pushEnabled, setPushEnabled] = useState(true);
  const [locationEnabled, setLocationEnabled] = useState(true);
  const didMount = useRef(false);

  // Guard: only fans who have completed onboarding should be on this screen.
  // If a coach somehow lands here (deep link, stale cache), redirect them.
  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;
    if (!user) {
      router.replace('/sign-in');
      return;
    }
    const role = user?.role ?? (user as any)?.preferences?.role ?? 'fan';
    if (role === 'coach') {
      router.replace('/onboarding/coach-application' as any);
    }
  }, [user, router]);

  const colors = {
    background: isDark ? '#121212' : '#FFFFFF',
    card: isDark ? '#1E1E1E' : '#F8FAFF',
    cardBorder: isDark ? '#3A3A3C' : '#DBEAFE',
    text: palette.text,
    textMuted: isDark ? '#9CA3AF' : '#6B7280',
    primary: isDark ? '#60A5FA' : '#2563EB',
    primaryMuted: isDark ? '#1E3A5F' : '#EFF6FF',
    skip: isDark ? '#6B7280' : '#9CA3AF',
  };

  // Refresh the in-memory auth user, then enter the app. This is the fix for
  // the onboarding loop: step-2 already called completeOnboarding on the server,
  // but the client `user` object is never refreshed, so it still reads
  // onboarding_completed=false. The AuthProvider routing gate keys off that
  // stale object (not the local hasCompletedOnboarding flag) — so leaving this
  // screen for /(tabs)/feed made the gate think the fan still needs onboarding
  // and bounced them back to step-1. checkAuth() re-syncs the user first so the
  // gate sees the completed state. Mirrors the coach step-3 flow.
  //
  // On a congested venue network a single /me refresh can fail transiently.
  // checkAuth() only THROWS on a genuine 401 (real, non-transient auth
  // failure) — anything else (timeouts, transport errors) is swallowed and
  // returns null. So: retry with backoff on a null/falsy result, and if it's
  // still not refreshed after retries, don't push to /(tabs)/feed at all —
  // the routing gate would immediately read the stale onboarding_completed
  // flag and bounce the user back to step-1, recreating the loop. Surface a
  // retry affordance instead. The server completion already succeeded, so a
  // later retry (or the app's own foreground/health-triggered checkAuth)
  // will carry the user through without ever weakening the real auth gate.
  const REFRESH_RETRY_DELAYS_MS = [800, 1600, 2400];
  const finishOnboarding = async () => {
    setStuck(false);
    let refreshed = false;
    let authFailure = false;
    for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await checkAuth({ forceRefresh: true });
        if (result) {
          refreshed = true;
          break;
        }
      } catch {
        // Genuine 401 — the session really is invalid. Don't retry and don't
        // force a navigation; AuthProvider has already cleared local state
        // and its own routing gate will send the user to sign-in.
        authFailure = true;
        break;
      }
      if (attempt < REFRESH_RETRY_DELAYS_MS.length) {
        await new Promise(resolve => setTimeout(resolve, REFRESH_RETRY_DELAYS_MS[attempt]));
      }
    }

    setLoading(false);

    if (authFailure) {
      return;
    }

    if (!refreshed) {
      setStuck(true);
      return;
    }

    // nav-safe: onboarding completion — linear flow; going BACK from here
    // returns to the step-2 form and re-runs completeOnboarding (signup
    // loop). The stack must be cleared into the app.
    router.replace('/(tabs)/feed');
  };

  const requestAndContinue = async () => {
    setLoading(true);
    // Notifications — only if the user left the toggle on
    if (pushEnabled) {
      try {
        const { status: pushStatus } = await Notifications.getPermissionsAsync();
        if (pushStatus !== 'granted') {
          await Notifications.requestPermissionsAsync();
        }
      } catch {
        // Non-fatal — never block navigation on permission failure
      }
      // Register push token now that permission has been (potentially) granted
      registerPushToken().catch(() => {});
    }
    // Location — only if the user left the toggle on
    if (locationEnabled) {
      try {
        const { status: locStatus } = await Location.getForegroundPermissionsAsync();
        if (locStatus !== 'granted') {
          await Location.requestForegroundPermissionsAsync();
        }
      } catch {
        // Non-fatal
      }
    }
    await finishOnboarding();
  };

  const skip = () => {
    setLoading(true);
    void finishOnboarding();
  };

  const retryFinish = () => {
    setLoading(true);
    void finishOnboarding();
  };

  if (stuck) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.inner, { alignItems: 'center' }]}>
          <View style={styles.hero}>
            <Ionicons
              name="cloud-offline-outline"
              size={48}
              color={colors.textMuted}
              style={{ marginBottom: 16 }}
            />
            <Text style={[styles.title, { color: colors.text }]}>Almost there</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              We're finishing setting up your account. This is taking longer than usual — probably a
              slow connection. Tap below to try again.
            </Text>
          </View>
          <Pressable
            onPress={retryFinish}
            disabled={loading}
            style={[
              styles.primaryBtn,
              {
                backgroundColor: loading ? colors.primaryMuted : colors.primary,
                alignSelf: 'stretch',
              },
            ]}
            accessibilityLabel="Retry finishing account setup"
            accessibilityRole="button"
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryBtnText}>Tap to retry</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.inner}>
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={[styles.emoji]}>🏟️</Text>
          <Text style={[styles.title, { color: colors.text }]}>Stay in the game</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            Allow VarsityHub to send you timely updates so you never miss a moment.
          </Text>
        </View>

        {/* Permission cards */}
        <View style={styles.cards}>
          <PermissionCard
            icon="notifications"
            iconColor="#2563EB"
            bgColor={colors.primaryMuted}
            borderColor={colors.cardBorder}
            cardBg={colors.card}
            title="Game & Team Notifications"
            description="Get real-time alerts for scores, roster updates, event reminders, and coach announcements."
            textColor={colors.text}
            mutedColor={colors.textMuted}
            isDark={isDark}
            toggleValue={pushEnabled}
            onToggle={setPushEnabled}
            toggleTestID="fan-permissions-push-toggle"
            toggleLabel="Enable game and team notifications"
            primaryColor={colors.primary}
          />
          <PermissionCard
            icon="location"
            iconColor="#16A34A"
            bgColor={isDark ? '#052E16' : '#F0FDF4'}
            borderColor={isDark ? '#166534' : '#BBF7D0'}
            cardBg={colors.card}
            title="Nearby Games & Events"
            description="Discover local games, tryouts, and events happening near you."
            textColor={colors.text}
            mutedColor={colors.textMuted}
            isDark={isDark}
            toggleValue={locationEnabled}
            onToggle={setLocationEnabled}
            toggleTestID="fan-permissions-location-toggle"
            toggleLabel="Enable nearby games and events"
            primaryColor={colors.primary}
          />
        </View>

        {/* Welcome note */}
        <View
          style={[
            styles.fanNote,
            {
              backgroundColor: isDark ? '#1E1E1E' : '#F1F5F9',
              borderColor: isDark ? '#3A3A3C' : '#E2E8F0',
            },
          ]}
        >
          <Ionicons name="sparkles" size={16} color={colors.primary} />
          <Text style={[styles.fanNoteText, { color: isDark ? '#CBD5E1' : '#475569' }]}>
            Welcome to VarsityHub — check out highlights and games in your area.
          </Text>
        </View>
      </View>

      {/* Footer actions */}
      <View style={[styles.footer, { borderTopColor: isDark ? '#3A3A3C' : '#E5E7EB' }]}>
        <Pressable
          onPress={requestAndContinue}
          disabled={loading}
          style={[
            styles.primaryBtn,
            { backgroundColor: loading ? colors.primaryMuted : colors.primary },
          ]}
          accessibilityLabel="Enable notifications and location"
          accessibilityRole="button"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
              <Text style={styles.primaryBtnText}>Enable &amp; Continue</Text>
            </>
          )}
        </Pressable>

        <Pressable
          onPress={skip}
          style={styles.skipBtn}
          accessibilityLabel="Skip permissions for now"
          accessibilityRole="button"
        >
          <Text style={[styles.skipBtnText, { color: colors.skip }]}>Skip for now</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function PermissionCard({
  icon,
  iconColor,
  bgColor,
  borderColor,
  cardBg,
  title,
  description,
  textColor,
  mutedColor,
  isDark,
  toggleValue,
  onToggle,
  toggleTestID,
  toggleLabel,
  primaryColor,
}: {
  icon: string;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  cardBg: string;
  title: string;
  description: string;
  textColor: string;
  mutedColor: string;
  isDark: boolean;
  toggleValue: boolean;
  onToggle: (next: boolean) => void;
  toggleTestID: string;
  toggleLabel: string;
  primaryColor: string;
}) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: cardBg,
          borderColor,
          ...(Platform.OS === 'web'
            ? { boxShadow: '0px 1px 4px rgba(0,0,0,0.06)' }
            : {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: isDark ? 0.3 : 0.06,
                shadowRadius: 4,
                elevation: 2,
              }),
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: bgColor }]}>
        <Ionicons name={icon as any} size={24} color={iconColor} />
      </View>
      <View style={styles.cardBody}>
        <Text style={[styles.cardTitle, { color: textColor }]}>{title}</Text>
        <Text style={[styles.cardDesc, { color: mutedColor }]}>{description}</Text>
      </View>
      <Switch
        testID={toggleTestID}
        value={toggleValue}
        onValueChange={onToggle}
        accessibilityLabel={toggleLabel}
        trackColor={{ false: isDark ? '#374151' : '#D1D5DB', true: primaryColor }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={isDark ? '#374151' : '#D1D5DB'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    marginBottom: 32,
  },
  emoji: {
    fontSize: 56,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  cards: {
    gap: 12,
    marginBottom: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    gap: 14,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 13,
    lineHeight: 19,
  },
  fanNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  fanNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 8 : 20,
    borderTopWidth: 1,
    gap: 12,
  },
  primaryBtn: {
    height: 52,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  skipBtnText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
