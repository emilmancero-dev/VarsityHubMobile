import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useThemePreference } from '@/hooks/useCustomColorScheme';
import type { ComponentProps } from 'react';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

// Below this width the fixed top-right card overlaps the centered 600px
// content column, so the toggle is wide-desktop only; narrower browsers
// follow the system theme. Keep in sync with WebInstallCta.
const MIN_FLOATING_WIDTH = 1200;

type ThemeOption = 'light' | 'dark';
const DISMISS_KEY = 'vh:web-theme-toggle:dismissed';

const OPTIONS: Array<{
  value: ThemeOption;
  label: string;
  icon: ComponentProps<typeof MaterialIcons>['name'];
}> = [
  { value: 'light', label: 'Light', icon: 'light-mode' },
  { value: 'dark', label: 'Dark', icon: 'dark-mode' },
];

export function WebThemeToggle() {
  const colorScheme = useColorScheme() ?? 'light';
  const { themePreference, setThemePreference } = useThemePreference();
  const { width } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setMounted(true);
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === 'true');
  }, []);

  if (Platform.OS !== 'web') return null;

  // The static export has no viewport. Match its first render, then choose
  // browser-only chrome after hydration rather than rebuilding the app tree.
  if (!mounted || dismissed || width < MIN_FLOATING_WIDTH) return null;

  const palette = Colors[colorScheme];
  const selectedTheme = themePreference === 'system' ? colorScheme : themePreference;

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
        { pointerEvents: 'box-none' },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hide theme controls"
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
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse theme controls' : 'Expand theme controls'}
        onPress={() => setExpanded(current => !current)}
        style={[
          styles.trigger,
          {
            backgroundColor: colorScheme === 'dark' ? '#0B1120' : '#F3F4F6',
            borderColor: palette.border,
          },
        ]}
      >
        <View style={styles.triggerContent}>
          <MaterialIcons
            name={selectedTheme === 'dark' ? 'dark-mode' : 'light-mode'}
            size={16}
            color={palette.text}
          />
          <Text style={[styles.triggerText, { color: palette.text }]}>
            {selectedTheme === 'dark' ? 'Dark' : 'Light'}
          </Text>
        </View>
        <MaterialIcons
          name={expanded ? 'expand-less' : 'expand-more'}
          size={18}
          color={palette.mutedText}
        />
      </Pressable>
      {expanded && (
        <>
          <Text style={[styles.label, { color: palette.mutedText }]}>Theme</Text>
          <View
            style={[
              styles.segmented,
              {
                backgroundColor: colorScheme === 'dark' ? '#0B1120' : '#F3F4F6',
                borderColor: palette.border,
              },
            ]}
          >
            {OPTIONS.map(option => {
              const selected = selectedTheme === option.value;

              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    void setThemePreference(option.value);
                    setExpanded(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={`Switch to ${option.label.toLowerCase()} mode`}
                  accessibilityState={{ checked: selected }}
                  style={[
                    styles.option,
                    selected && {
                      backgroundColor: palette.background,
                      borderColor: palette.border,
                    },
                  ]}
                >
                  <MaterialIcons
                    name={option.icon}
                    size={16}
                    color={selected ? palette.text : palette.mutedText}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      { color: selected ? palette.text : palette.mutedText },
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // react-native's ViewStyle type omits 'fixed'; it is valid on web via
    // react-native-web, and this component renders only on web. Cast keeps the
    // runtime value 'fixed' while satisfying the stock RN type in clean CI.
    position: 'fixed' as any,
    top: 16,
    right: 16,
    zIndex: 10000,
    borderWidth: 1,
    borderRadius: 16,
    padding: 8,
    gap: 6,
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
  trigger: {
    minWidth: 122,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  triggerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  triggerText: {
    fontSize: 14,
    fontWeight: '700',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 4,
    gap: 4,
  },
  option: {
    minWidth: 88,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  optionText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
