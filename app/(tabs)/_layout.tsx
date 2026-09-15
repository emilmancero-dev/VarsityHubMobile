import { Tabs } from 'expo-router';
import React, { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Platform, Text } from 'react-native';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HapticTab } from '@/components/HapticTab';
import CenterTabButton from '@/components/ui/CenterTabButton';
import { IconSymbol } from '@/components/ui/IconSymbol';
import TabBarBackground from '@/components/ui/TabBarBackground';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === 'web';
  const hiddenTabScreenNames = [
    'index',
    'notifications/index',
    'messages/index',
    'feed/game/[id]',
    'feed/game/index',
    'discover/mobile-community',
    'discover/game/index',
    'discover/game/[id]',
    'admin-ads',
    'admin-messages',
    'admin-teams',
    'admin-users',
    'admin-user-detail',
    'ad-calendar',
    'edit-ad',
    'my-ads',
    'submit-ad',
    'game-detail',
    'game-photos',
    'game-highlights',
    'game-reviews',
    'create-post',
    'team-profile',
    'team-hub',
    'team-contacts',
    'edit-profile',
    'create-team',
    'edit-team',
    'manage-teams',
    'my-team',
    'followers',
    'following',
    'organization',
    'event-detail',
    'edit-event',
    'edit-organization',
    'event-approvals',
    'approvals',
    'verify-email',
    'team-page',
  ] as const;

  const hiddenTab = useMemo(
    () =>
      ({
        href: null,
      }) as const,
    []
  );

  const renderTabLabel = React.useCallback(
    ({ color, title }: { color: string; title: string }) => (
      <Text
        style={{
          color,
          fontSize: 12,
          lineHeight: isWeb ? 18 : 16,
          minHeight: isWeb ? 18 : undefined,
          paddingBottom: isWeb ? 2 : 1,
          textAlign: 'center',
          overflow: 'visible',
        }}
      >
        {title}
      </Text>
    ),
    [isWeb]
  );

  const screenOptions = useMemo(() => {
    const palette = Colors[colorScheme ?? 'light'];

    return {
      tabBarActiveTintColor: palette.tint,
      tabBarInactiveTintColor: colorScheme === 'dark' ? '#D1D5DB' : palette.tabIconDefault,
      headerShown: false,
      tabBarHideOnKeyboard: true,
      tabBarShowLabel: true,
      tabBarLabelStyle: {
        fontSize: 12,
        lineHeight: isWeb ? 18 : 14,
        paddingBottom: isWeb ? 2 : 0,
      },
      tabBarItemStyle: isWeb
        ? {
            minHeight: 52,
            paddingBottom: 6,
            paddingTop: 2,
          }
        : undefined,
      tabBarBackground: () => <TabBarBackground />,
      tabBarStyle: {
        height: Math.max(isWeb ? 78 : 64, (isWeb ? 66 : 56) + insets.bottom),
        paddingBottom: Math.max(isWeb ? 14 : 10, insets.bottom),
        paddingTop: isWeb ? 10 : 6,
        backgroundColor: colorScheme === 'dark' ? '#121212' : palette.card,
        overflow: 'visible' as const,
        ...(isWeb ? { boxShadow: 'none' } : { shadowOpacity: 0, shadowRadius: 0 }),
        elevation: 0,
        borderTopWidth: 0,
      },
    };
  }, [colorScheme, insets.bottom, isWeb]);

  return (
    <ErrorBoundary>
      <Tabs backBehavior="history" screenOptions={screenOptions}>
        <Tabs.Screen
          name="feed/index"
          options={{
            title: 'Feed',
            tabBarLabel: ({ color }) => renderTabLabel({ color, title: 'Feed' }),
            tabBarButton: HapticTab,
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="square.grid.2x2.fill" color={color} />
            ),
            tabBarAccessibilityLabel: 'Feed',
            // Feed renders its own LinearGradient header with the outline
            // notifications bell on the left and chat bubble on the right.
            // Do not show the stack header above it — the extra header was
            // rendering a second (filled) bell that didn't belong.
          }}
        />
        <Tabs.Screen
          name="highlights/index"
          options={{
            title: 'Highlights',
            tabBarLabel: ({ color }) => renderTabLabel({ color, title: 'Highlights' }),
            tabBarButton: HapticTab,
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="video.fill" color={color} />,
            tabBarAccessibilityLabel: 'Highlights',
          }}
        />
        <Tabs.Screen
          name="create"
          options={{
            title: '',
            tabBarLabel: '',
            tabBarButton: CenterTabButton,
            tabBarAccessibilityLabel: 'Create',
          }}
        />
        <Tabs.Screen
          name="discover/index"
          options={{
            title: 'Discover',
            tabBarLabel: ({ color }) => renderTabLabel({ color, title: 'Discover' }),
            tabBarButton: HapticTab,
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="magnifyingglass" color={color} />
            ),
            tabBarAccessibilityLabel: 'Discover',
          }}
        />
        {hiddenTabScreenNames.map(name => (
          <Tabs.Screen key={name} name={name} options={hiddenTab} />
        ))}
        <Tabs.Screen
          name="profile/index"
          options={{
            title: 'Profile',
            tabBarLabel: ({ color }) => renderTabLabel({ color, title: 'Profile' }),
            tabBarButton: HapticTab,
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="person.crop.circle" color={color} />
            ),
            tabBarAccessibilityLabel: 'Profile',
          }}
        />
      </Tabs>
    </ErrorBoundary>
  );
}
