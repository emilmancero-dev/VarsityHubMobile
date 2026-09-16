import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Platform, useColorScheme as useSystemColorScheme } from 'react-native';
import { useAuth } from '@/context/AuthProvider';

type ColorScheme = 'light' | 'dark' | 'system';
type ActualColorScheme = 'light' | 'dark';

interface ThemeContextType {
  colorScheme: ActualColorScheme;
  themePreference: ColorScheme;
  setThemePreference: (theme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'vh_theme_preference';

const subscribeToHydration = () => () => {};
const clientIsHydrated = () => true;
const serverIsHydrated = () => false;

function useHydratedSystemColorScheme() {
  const systemColorScheme = useSystemColorScheme();
  const hydrated = useSyncExternalStore(subscribeToHydration, clientIsHydrated, serverIsHydrated);
  // Static HTML cannot know the browser's media preference. React uses the
  // server snapshot on hydration, then applies the real preference immediately.
  return Platform.OS === 'web' && !hydrated ? 'light' : systemColorScheme;
}

function storageKeyForUser(userId?: string | null) {
  if (!userId) return THEME_STORAGE_KEY + '_global';
  return `${THEME_STORAGE_KEY}_${userId}`;
}

async function getStoredTheme(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function setStoredTheme(key: string, theme: ColorScheme): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(key, theme);
    } catch {
      // Best effort only on web.
    }
    return;
  }
  await SecureStore.setItemAsync(key, theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useHydratedSystemColorScheme();
  const { user } = useAuth();
  const [themePreference, setThemePreferenceState] = useState<ColorScheme>('system');
  const currentStorageKey = useRef<string>(storageKeyForUser(null));

  // Scope theme preference to the active auth identity instead of resolving
  // a parallel /me snapshot here. AuthProvider already owns current-user state.
  useEffect(() => {
    let mounted = true;
    const loadTheme = async () => {
      try {
        const key = storageKeyForUser(user?.id ?? null);
        currentStorageKey.current = key;
        const savedTheme = await getStoredTheme(key);
        if (mounted && savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
          setThemePreferenceState(savedTheme as ColorScheme);
        }
      } catch (error) {
        if (__DEV__) console.warn('Failed to load theme preference:', error);
      }
    };
    void loadTheme();
    return () => {
      mounted = false;
    };
  }, [user?.id]);

  // Calculate actual color scheme based on preference
  const colorScheme: ActualColorScheme =
    themePreference === 'system' ? (systemColorScheme ?? 'light') : themePreference;

  // Save theme preference to storage when changed
  const setThemePreference = useCallback(async (theme: ColorScheme) => {
    try {
      // Save to the scoped key (per-user when possible)
      const key = currentStorageKey.current || storageKeyForUser(null);
      await setStoredTheme(key, theme);
      setThemePreferenceState(theme);
    } catch (error) {
      if (__DEV__) console.warn('Failed to save theme preference:', error);
      // Still update state even if storage fails
      setThemePreferenceState(theme);
    }
  }, []);

  const value = useMemo(
    () => ({
      colorScheme,
      themePreference,
      setThemePreference,
    }),
    [colorScheme, themePreference, setThemePreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useCustomColorScheme(): ActualColorScheme {
  const systemColorScheme = useHydratedSystemColorScheme();
  const context = useContext(ThemeContext);
  if (context === undefined) {
    // Fallback if used outside provider
    return systemColorScheme ?? 'light';
  }
  return context.colorScheme;
}

// Backward-compatible alias for screens that still import `useColorScheme`
// from this module after the hook was renamed.
export const useColorScheme = useCustomColorScheme;

export function useThemePreference() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    // Return default values if used outside provider instead of throwing
    if (__DEV__) console.warn('useThemePreference used outside ThemeProvider, returning defaults');
    return {
      themePreference: 'system' as ColorScheme,
      setThemePreference: () => {},
    };
  }
  return {
    themePreference: context.themePreference,
    setThemePreference: context.setThemePreference,
  };
}
