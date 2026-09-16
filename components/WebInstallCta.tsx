import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/varsityhub/id6758405187';
const DISMISS_KEY = 'vh:web-install-cta:dismissed';

// Below this width the fixed top-right card overlaps content, so phones and
// tablets get a slim in-flow banner that pushes content down instead of
// covering it. Content is centered in a 600px column (MAX_CONTENT_WIDTH), so
// the floating card needs ~(600 + 2×300)px before the gutter can hold it —
// at 768–1200 the "desktop" card sat on top of the column.
const MIN_FLOATING_WIDTH = 1200;

export function WebInstallCta() {
  const colorScheme = useColorScheme() ?? 'light';
  const { width } = useWindowDimensions();
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setMounted(true);
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === 'true');
  }, []);

  if (Platform.OS !== 'web') return null;

  // Server and initial browser markup must agree before reading viewport.
  if (!mounted || dismissed) return null;

  const palette = Colors[colorScheme];

  if (width < MIN_FLOATING_WIDTH) {
    return (
      <View style={[styles.banner, { backgroundColor: palette.tint }]}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Download VarsityHub on the App Store"
          onPress={() => {
            window.location.href = IOS_APP_STORE_URL;
          }}
          style={styles.bannerLink}
        >
          <MaterialIcons name="download" size={16} color="#FFFFFF" />
          <Text style={styles.text} numberOfLines={1}>
            Get VarsityHub on the App Store
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide App Store download banner"
          onPress={() => {
            window.localStorage.setItem(DISMISS_KEY, 'true');
            setDismissed(true);
          }}
          style={styles.bannerDismiss}
          hitSlop={8}
        >
          <MaterialIcons name="close" size={16} color="#FFFFFF" />
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor:
            colorScheme === 'dark' ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.92)',
          borderColor:
            colorScheme === 'dark' ? 'rgba(148, 163, 184, 0.28)' : 'rgba(15, 23, 42, 0.08)',
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hide App Store download button"
        onPress={() => {
          window.localStorage.setItem(DISMISS_KEY, 'true');
          setDismissed(true);
        }}
        style={[
          styles.dismissButton,
          {
            backgroundColor: colorScheme === 'dark' ? '#0B1120' : '#F8FAFC',
            borderColor: palette.border,
          },
        ]}
      >
        <MaterialIcons name="close" size={14} color={palette.mutedText} />
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Download VarsityHub on the App Store"
        onPress={() => {
          window.location.href = IOS_APP_STORE_URL;
        }}
        style={[
          styles.button,
          {
            backgroundColor: palette.tint,
            borderColor: palette.tint,
          },
        ]}
      >
        <MaterialIcons name="download" size={16} color="#FFFFFF" />
        <Text style={styles.text}>Download on the App Store</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 12,
    gap: 8,
  },
  bannerLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    paddingVertical: 8,
  },
  bannerDismiss: {
    padding: 4,
  },
  container: {
    // react-native's ViewStyle type omits 'fixed'; it is valid on web via
    // react-native-web, and this component renders only on web. Cast keeps the
    // runtime value 'fixed' while satisfying the stock RN type in clean CI.
    position: 'fixed' as any,
    top: 88,
    right: 16,
    zIndex: 9999,
    borderWidth: 1,
    borderRadius: 16,
    padding: 8,
    boxShadow: '0px 12px 28px rgba(15, 23, 42, 0.18)',
  },
  dismissButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  button: {
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    boxShadow: '0px 12px 28px rgba(15, 23, 42, 0.18)',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
