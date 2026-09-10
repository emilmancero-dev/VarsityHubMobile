import { toUserMessage } from '@/utils/toUserMessage';
import auth from '@/api/auth';
import PasswordInput from '@/components/PasswordInput';
import { Button } from '@/components/ui/button';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/context/AuthProvider';
import { Colors } from '@/constants/Colors';
import { getLinkedProvidersSnapshot } from '@/utils/authState';
import { validatePassword } from '@/utils/formUtils';

export default function ResetPasswordScreen() {
  const colorScheme = useColorScheme();
  const { user, checkAuth } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  // Check if user signed up via OAuth (Apple/Google) — password change not applicable
  const userRecord = user as {
    auth_provider?: string;
    preferences?: { auth_provider?: string };
    apple_id?: string;
    google_id?: string;
    linked_providers?: { password?: boolean; google?: boolean; apple?: boolean };
  } | null;
  const linked = getLinkedProvidersSnapshot(userRecord);
  const hasPassword = linked.password;
  const hasApple = linked.apple;
  const hasGoogle = linked.google;
  let authProvider = userRecord?.auth_provider || userRecord?.preferences?.auth_provider;
  if (!authProvider && userRecord) {
    authProvider =
      hasApple && hasGoogle
        ? 'apple,google'
        : hasApple
          ? 'apple'
          : hasGoogle
            ? 'google'
            : undefined;
  }
  const isOAuthOnly = !hasPassword && (hasApple || hasGoogle);

  const onSave = async () => {
    const currentValue = current.trim();
    const p = password.trim();
    if (!currentValue.length) {
      Alert.alert('Enter your current password.');
      return;
    }
    const passwordCheck = validatePassword(p, 8, true);
    if (!passwordCheck.valid) {
      Alert.alert('Invalid password', passwordCheck.error || 'Use at least 8 characters.');
      return;
    }
    if (p !== confirm.trim()) {
      Alert.alert('Passwords do not match');
      return;
    }
    setSaving(true);
    try {
      await auth.changePassword(currentValue, p);
      await checkAuth().catch(e => {
        if (__DEV__) console.warn('[reset-password] Auth refresh failed:', e);
      }); // VAL-2
      Alert.alert(
        'Password updated',
        'Your password has been changed. A confirmation email has been sent to your account.'
      );
      setCurrent('');
      setPassword('');
      setConfirm('');
    } catch (err: any) {
      const message = toUserMessage(err, 'Unable to update password.');
      Alert.alert('Unable to update password', message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme ?? 'light'].background }]}
      edges={['bottom']}
    >
      <Stack.Screen
        options={{ title: 'Change Password', headerBackTitle: 'Back', headerShown: true }}
      />
      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        {isOAuthOnly ? (
          <View style={{ alignItems: 'center', paddingTop: 32 }}>
            <Text
              style={[
                styles.label,
                {
                  color: Colors[colorScheme ?? 'light'].text,
                  fontSize: 16,
                  textAlign: 'center',
                  marginBottom: 12,
                },
              ]}
            >
              Password change is not available
            </Text>
            <Text
              style={[
                {
                  color: Colors[colorScheme ?? 'light'].mutedText,
                  textAlign: 'center',
                  lineHeight: 22,
                },
              ]}
            >
              {authProvider === 'apple,google'
                ? 'Your account can be signed in with Apple or Google. To change your password, manage it through your Apple ID or Google Account settings.'
                : `Your account was created with ${authProvider === 'apple' ? 'Apple' : 'Google'} Sign-In. To change your password, manage it through your ${authProvider === 'apple' ? 'Apple ID' : 'Google Account'} settings.`}
            </Text>
          </View>
        ) : (
          <>
            <Text style={[styles.label, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
              Current Password
            </Text>
            <PasswordInput
              placeholder="Enter current password"
              value={current}
              onChangeText={setCurrent}
              style={{ marginBottom: 16 }}
            />
            <Text style={[styles.label, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
              New Password
            </Text>
            <PasswordInput
              placeholder="At least 8 characters"
              value={password}
              onChangeText={setPassword}
              style={{ marginBottom: 16 }}
            />
            <Text style={[styles.label, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
              Confirm Password
            </Text>
            <PasswordInput
              placeholder="Re-enter your password"
              value={confirm}
              onChangeText={setConfirm}
              style={{ marginBottom: 24 }}
            />
            <Button onPress={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Update Password'}
            </Button>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingTop: 24 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
});
