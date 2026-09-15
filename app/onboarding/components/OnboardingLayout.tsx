import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { ReactNode, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { screenHeaderSharedStyles } from '@/components/ScreenHeaderShared';
import { Colors } from '@/constants/Colors';
import { useOnboarding } from '@/context/OnboardingContext';
import { safeGoBack } from '@/utils/navigation';

interface OnboardingLayoutProps {
  step: number;
  totalSteps?: number;
  title: string;
  subtitle?: string;
  aboveTitle?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  onBackPress?: () => void;
  showBackButton?: boolean;
  emailVerified?: boolean;
  onVerifyEmail?: () => void;
  onContinue?: () => void;
  continueDisabled?: boolean;
  loading?: boolean;
}

export default function OnboardingLayout({
  step,
  totalSteps = 3,
  title,
  subtitle,
  aboveTitle,
  children,
  onBack,
  onBackPress,
  showBackButton = true,
  emailVerified,
  onVerifyEmail,
  onContinue,
  continueDisabled,
  loading,
}: OnboardingLayoutProps) {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { state: ob } = useOnboarding();

  // Track keyboard so the footer's home-indicator padding collapses when the
  // keyboard is open. Without this, the ~34px bottom safe-area inset showed as
  // a visible white strip between the Continue button and the keyboard top
  // (the "white tab above the keyboard" complaint).
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Fans have 2 steps (role + basic info), coaches have 3 (+ league)
  const isFan = ob.role !== 'coach';
  const effectiveTotalSteps = totalSteps ?? (isFan ? 2 : 3);

  const previousStepRoute: Record<number, string> = isFan
    ? {
        2: '/onboarding/step-1-role',
      }
    : {
        2: '/onboarding/step-1-role',
        3: '/onboarding/step-2-basic',
      };

  const handleBack = () => {
    if (onBackPress) {
      onBackPress();
    } else if (onBack) {
      onBack();
    } else if (previousStepRoute[step]) {
      safeGoBack(router, previousStepRoute[step] as any);
    } else {
      safeGoBack(router);
    }
  };

  const colors = {
    background: isDark ? '#121212' : '#FFFFFF',
    text: Colors[colorScheme].text,
    textMuted: isDark ? '#9CA3AF' : '#6B7280',
    border: isDark ? '#3A3A3C' : '#D1D5DB',
    headerBg: isDark ? '#121212' : '#FFFFFF',
    primary: isDark ? '#60A5FA' : '#2563EB',
    primaryMuted: isDark ? '#1E40AF' : '#D1E0FF',
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={['top', 'left', 'right']}
    >
      <View
        style={[
          styles.header,
          { backgroundColor: colors.headerBg, borderBottomColor: colors.border },
        ]}
      >
        {showBackButton ? (
          <Pressable
            onPress={handleBack}
            style={styles.backButton}
            hitSlop={8}
            accessibilityLabel="Go back"
            accessibilityRole="button"
            accessibilityHint="Returns to previous onboarding step"
          >
            <MaterialIcons name="chevron-left" size={24} color={colors.text} />
          </Pressable>
        ) : (
          <View style={styles.backButton} />
        )}

        <Text style={[styles.stepIndicator, { color: colors.textMuted }]}>
          Step {step}/{effectiveTotalSteps}
        </Text>

        {emailVerified === false && onVerifyEmail ? (
          <Pressable
            onPress={onVerifyEmail}
            style={styles.verifyButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Verify email"
            accessibilityHint="Send verification email"
          >
            <MaterialIcons name="mail-outline" size={18} color="#EF4444" />
            <Text style={styles.verifyButtonText}>Verify</Text>
          </Pressable>
        ) : (
          <View style={styles.backButton} />
        )}
      </View>

      <View
        style={[styles.progressBarContainer, { backgroundColor: isDark ? '#374151' : '#F3F4F6' }]}
      >
        <View
          style={[
            styles.progressBar,
            {
              width: `${(step / effectiveTotalSteps) * 100}%`,
              backgroundColor: colors.primary,
            },
          ]}
        />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          style={{ flex: 1 }}
        >
          <View style={styles.titleSection}>
            {aboveTitle}
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {subtitle && (
              <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
            )}
          </View>

          {children}

          {onContinue && (
            <View
              style={[
                styles.footer,
                {
                  borderTopColor: colors.border,
                  backgroundColor: colors.background,
                  // Collapse the home-indicator safe-area padding while the keyboard
                  // is open — KeyboardAvoidingView already pushes the footer up to
                  // meet the keyboard, so the extra 34px would show as a white strip.
                  paddingBottom: keyboardOpen ? 12 : insets.bottom > 0 ? insets.bottom : 16,
                },
              ]}
            >
              <Pressable
                onPress={onContinue}
                disabled={continueDisabled || loading}
                style={[
                  styles.continueButton,
                  {
                    backgroundColor:
                      continueDisabled || loading ? colors.primaryMuted : colors.primary,
                  },
                ]}
                accessibilityLabel="Continue"
                accessibilityRole="button"
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.continueButtonText}>Continue</Text>
                )}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: screenHeaderSharedStyles.container,
  header: screenHeaderSharedStyles.header,
  backButton: screenHeaderSharedStyles.backButtonLeading,
  verifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  verifyButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#EF4444',
  },
  stepIndicator: {
    fontSize: 14,
    fontWeight: '600',
  },
  progressBarContainer: {
    height: 4,
    width: '100%',
  },
  progressBar: {
    height: '100%',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  titleSection: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    backgroundColor: 'transparent',
  },
  continueButton: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
