import type { ErrorBoundaryProps } from 'expo-router';
import { Button, Text, View } from 'react-native';
import auth from '@/api/auth';
import { captureException } from '@/utils/sentry';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestOtaReload } from '@/utils/runtimeReload';

const RESETTABLE_STORAGE_KEYS = [
  '@onboarding_completed_once',
  '@onboarding_completed_user_id',
  '@last_onboarding_user_id',
  'onboarding_state',
  'onboarding_progress',
  'onboarding_reducer_state',
];

export default function GlobalError({ error, retry }: ErrorBoundaryProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  // Capture global errors to Sentry
  if (error) {
    captureException(error, {
      tags: { component: 'GlobalError', errorBoundary: 'root' },
      extra: { errorType: typeof error, hasMessage: !!error?.message },
    });
  }

  const handleSignOutAndRestart = async () => {
    try {
      await auth.clearTokensOnly();
      await AsyncStorage.multiRemove(RESETTABLE_STORAGE_KEYS);
      if (!(await requestOtaReload())) void retry();
    } catch {
      // If Updates.reloadAsync fails (e.g. in dev), retry as fallback
      void retry();
    }
  };

  return (
    <View
      style={{
        flex: 1,
        padding: 16,
        justifyContent: 'center',
        gap: 12,
        backgroundColor: colors.background,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text }}>
        Something went wrong
      </Text>
      {__DEV__ ? (
        <Text selectable style={{ color: colors.mutedText }}>
          {String(error?.message ?? error)}
        </Text>
      ) : null}
      <Text style={{ color: colors.mutedText }}>Please restart the app or try again.</Text>
      <Button title="Try Again" onPress={retry} />
      <Button
        title="Sign Out & Restart"
        onPress={handleSignOutAndRestart}
        color={colors.destructive}
      />
    </View>
  );
}
