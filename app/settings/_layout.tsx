import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="edit-username"
        options={{
          title: 'Edit Username',
        }}
      />
      <Stack.Screen
        name="reset-password"
        options={{
          title: 'Reset Password',
        }}
      />
      <Stack.Screen
        name="rsvp-history"
        options={{
          title: '📺 Watching History',
        }}
      />
      <Stack.Screen
        name="manage-subscription"
        options={{
          title: 'Subscription',
        }}
      />
      <Stack.Screen
        name="billing-history"
        options={{
          // v1.0.2: screen renders its own custom header with safeGoBack
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="blocked-users"
        options={{
          title: 'Blocked Users',
        }}
      />
      <Stack.Screen
        name="zip-code"
        options={{
          title: 'Location',
        }}
      />
      <Stack.Screen
        name="favorites"
        options={{
          title: 'Favorites',
        }}
      />
      <Stack.Screen
        name="data-export"
        options={{
          title: 'Data Export',
        }}
      />
      <Stack.Screen
        name="followed-teams"
        options={{
          title: 'Followed Teams',
        }}
      />
      <Stack.Screen
        name="feedback"
        options={{
          title: 'Send Feedback',
        }}
      />
      <Stack.Screen
        name="contact"
        options={{
          title: 'Contact Us',
        }}
      />
      <Stack.Screen
        name="privacy-policy"
        options={{
          title: 'Privacy Policy',
        }}
      />
      <Stack.Screen
        name="request-host-event"
        options={{
          title: 'Request to Host Event',
        }}
      />
    </Stack>
  );
}
