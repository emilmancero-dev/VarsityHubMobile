import { toUserMessage } from '@/utils/toUserMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Stack, useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { Alert, ScrollView, StyleSheet, Text, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import { User } from '@/api/entities';
import { useAuth } from '@/context/AuthProvider';
import { Colors } from '@/constants/Colors';
import { validateUsername } from '@/utils/formUtils';
import { safeGoBack } from '@/utils/navigation';

export default function EditUsernameScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const { user, loading: authLoading, checkAuth } = useAuth();
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user?.username) {
      setUsername(user.username);
    }
  }, [user?.username]);

  const onSave = async () => {
    const v = username.trim().toLowerCase(); // Usernames must be lowercase
    if (!v) {
      Alert.alert('Enter a username');
      return;
    }
    // Check if username hasn't changed
    if (user?.username && v === user.username.toLowerCase()) {
      Alert.alert('No changes', 'Username is the same as current');
      return;
    }
    const usernameCheck = validateUsername(v);
    if (!usernameCheck.valid) {
      Alert.alert('Invalid username', usernameCheck.error);
      return;
    }
    setSaving(true);
    try {
      await User.updateMe({ username: v });
      await checkAuth().catch(e => {
        if (__DEV__) console.warn('[edit-username] Auth refresh failed:', e);
      }); // VAL-2
      Alert.alert('Success', 'Username updated successfully');
      safeGoBack(router);
    } catch (e: any) {
      const errorMessage = toUserMessage(e, 'Could not save username. Please try again.');
      Alert.alert('Save failed', errorMessage);
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
        options={{
          title: 'Edit Username',
          headerBackTitle: 'Back',
          headerShown: true,
        }}
      />
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={[styles.label, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
          Username
        </Text>
        <Text style={[styles.hint, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
          This is your @ handle (e.g., @rwerwqer). Lowercase letters, numbers, dots, and underscores
          only.
        </Text>
        {authLoading ? (
          <Text style={[styles.hint, { color: Colors[colorScheme ?? 'light'].mutedText }]}>
            Loading...
          </Text>
        ) : (
          <Input
            value={username}
            onChangeText={text => setUsername(text.toLowerCase())}
            placeholder={user?.username || 'username'}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ marginBottom: 24 }}
          />
        )}
        <Button onPress={onSave} disabled={saving || authLoading}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingTop: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  hint: {
    fontSize: 12,
    marginBottom: 8,
  },
});
