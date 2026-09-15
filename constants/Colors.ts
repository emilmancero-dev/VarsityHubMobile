/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

const tintColorLight = '#0a7ea4';
const tintColorDark = '#60a5fa';
const darkBackground = '#121212';
const darkSurface = '#1C1C1E';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#FFFFFF',
    card: '#FFFFFF',
    surface: '#F3F4F6',
    border: '#D1D5DB',
    mutedText: '#6B7280',
    elevated: '#FFFFFF',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
    destructive: '#DC2626',
  },
  dark: {
    text: '#F5F5F5',
    background: '#121212', // True neutral dark grey (no blue/purple tint)
    card: '#1E1E1E', // Slightly lighter neutral grey
    surface: '#232326',
    border: '#3A3A3C', // Neutral grey separator
    mutedText: '#A1A1AA', // Neutral grey (no blue tint)
    elevated: '#242426',
    tint: tintColorDark,
    icon: '#D1D1D6', // Neutral light grey
    tabIconDefault: '#A1A1AA',
    tabIconSelected: tintColorDark,
    destructive: '#EF4444',
  },
};
