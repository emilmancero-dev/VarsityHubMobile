import { toUserMessage } from '@/utils/toUserMessage';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';

export interface DeviceLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: number;
}

export interface UseDeviceLocationResult {
  location: DeviceLocation | null;
  loading: boolean;
  error: string | null;
  permissionGranted: boolean | null;
  accuracyMeters: number | null;
  isPrecise: boolean;
  needsPreciseAccuracy: boolean;
  requestPermission: () => Promise<boolean>;
  openSettings: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Hook to manage device location with permission handling and caching.
 * Caches the location for 10 minutes to avoid excessive GPS requests.
 * Handles permission denial gracefully.
 */
export function useDeviceLocation(): UseDeviceLocationResult {
  const [location, setLocation] = useState<DeviceLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [lastFetchTime, setLastFetchTime] = useState(0);
  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);

  const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
  const PRECISION_THRESHOLD = 200; // meters; >200 == approximate on Android

  // Use refs for cache values to avoid stale closures without triggering re-renders
  const locationRef = useRef(location);
  locationRef.current = location;
  const lastFetchTimeRef = useRef(lastFetchTime);
  lastFetchTimeRef.current = lastFetchTime;

  const assignLocation = useCallback(
    (coords: Location.LocationObjectCoords, timestamp?: number) => {
      const loc: DeviceLocation = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? undefined,
        timestamp,
      };
      setLocation(loc);
      setAccuracyMeters(typeof coords.accuracy === 'number' ? coords.accuracy : null);
    },
    []
  );

  const fetchLocation = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Check cache first
      const now = Date.now();
      if (locationRef.current && now - lastFetchTimeRef.current < CACHE_DURATION_MS) {
        setLoading(false);
        return;
      }

      // Try last known position first (faster, may be stale)
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown?.coords && now - (lastKnown.timestamp || 0) < 30 * 60 * 1000) {
        assignLocation(lastKnown.coords, lastKnown.timestamp);
        setLastFetchTime(now);
        setLoading(false);
        return;
      }

      // Get fresh position with balanced accuracy
      const fresh = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      if (fresh?.coords) {
        assignLocation(fresh.coords, fresh.timestamp);
        setLastFetchTime(now);
        setError(null);
      }
    } catch (e: any) {
      const errMsg = toUserMessage(e, 'Failed to fetch location');
      if (__DEV__) console.warn('[location] Fetch failed:', errMsg);
      setError(errMsg);
    } finally {
      setLoading(false);
    }
  }, [assignLocation, CACHE_DURATION_MS]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setPermissionGranted(granted);

      if (!granted) {
        setError('Location permission denied');
        setLoading(false);
        setAccuracyMeters(null);
        return false;
      }

      setError(null);
      setAccuracyMeters(null);
      await fetchLocation();
      return true;
    } catch (e: any) {
      const errMsg = toUserMessage(e, 'Failed to request location permission');
      setError(errMsg);
      setPermissionGranted(false);
      setLoading(false);
      setAccuracyMeters(null);
      return false;
    }
  }, [fetchLocation]);

  // Re-read the current OS permission and sync local state. Extracted so both
  // the mount check AND the foreground listener below can call it.
  const syncPermission = useCallback(async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      const granted = status === 'granted';
      setPermissionGranted(granted);

      if (granted) {
        setAccuracyMeters(null);
        void fetchLocation();
      } else {
        setLoading(false);
      }
    } catch {
      setError('Failed to check location permissions');
      setLoading(false);
    }
  }, [fetchLocation]);

  // Check permissions on mount.
  useEffect(() => {
    void syncPermission();
  }, [syncPermission]);

  // Recover after the user enables location in the OS Settings app and returns.
  // Without this, `permissionGranted` stayed stale `false` on foreground, so a
  // user who tapped "Open Settings", granted access, and came back would keep
  // hitting the same "Location Required" prompt in a loop. Re-checking on
  // AppState 'active' picks up the newly-granted permission and fetches coords.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') void syncPermission();
    });
    return () => sub.remove();
  }, [syncPermission]);

  const openSettings = async () => {
    if (typeof Linking.openSettings !== 'function') return;
    try {
      await Linking.openSettings();
    } catch (err) {
      if (__DEV__) console.warn('[location] Unable to open settings', err);
    }
  };

  const refresh = useCallback(async () => {
    setLastFetchTime(0); // Clear cache
    lastFetchTimeRef.current = 0;
    await fetchLocation();
  }, [fetchLocation]);

  const isPrecise = accuracyMeters == null ? true : accuracyMeters <= PRECISION_THRESHOLD;
  const needsPreciseAccuracy =
    Platform.OS === 'android' && permissionGranted === true && !isPrecise;

  return {
    location,
    loading,
    error,
    permissionGranted,
    accuracyMeters,
    isPrecise,
    needsPreciseAccuracy,
    requestPermission,
    openSettings,
    refresh,
  };
}

export default useDeviceLocation;
