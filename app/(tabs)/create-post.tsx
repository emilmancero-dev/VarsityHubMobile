import { safeGoBack } from '@/utils/navigation';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  Image as RNImage,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Game, Post } from '@/api/entities';
import settings from '@/api/settings';
import { uploadFile } from '@/api/upload';
import KeyboardAwareScreen from '@/components/KeyboardAwareScreen';
import { PromptPresets } from '@/components/RotatingPrompts';
import { MentionInput } from '@/components/ui/MentionInput';

import SwipeBackContainer from '@/components/SwipeBackContainer';
import VideoPlayer from '@/components/VideoPlayer';
import VideoTrimmer from '@/components/VideoTrimmer';
import { Colors } from '@/constants/Colors';
import {
  isNativeVideoTrimSupported,
  MAX_IMAGE_SIZE_BYTES,
  MAX_PICKED_VIDEO_SIZE_BYTES,
  MAX_PICKED_VIDEO_SIZE_MB,
  POST_MAX_DURATION_S,
  VIDEO_CAPTURE_PRESET,
} from '@/constants/video';
import { useAuth } from '@/context/AuthProvider';
import { usePostCache } from '@/context/PostCacheContext';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import {
  markEventPostingNoticeSeen,
  shouldShowEventPostingNotice,
} from '@/utils/eventPostingNotice';
import { hasLocalEventPostingUnlock, recordEventPostingUnlock } from '@/utils/eventPostingUnlock';
import { getLiveBounds, isGameOver } from '@/utils/liveWindow';
import { prepareVideoForUpload, uploadTimeoutMsForSize } from '@/utils/compressVideo';
import {
  COMPRESS_PROGRESS_SHARE,
  mediaUploadLabel,
  mediaUploadPercent,
  type MediaUploadPhase,
} from '@/utils/uploadProgress';
import { sanitizeText } from '@/utils/formUtils';
import { ICLOUD_ERROR_MESSAGE, ICLOUD_ERROR_TITLE, isICloudError } from '@/utils/isICloudError';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { pickerAllMediaTypesProp, pickerMediaTypeFor } from '@/utils/picker';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

// Media validation constants
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic', // ✅ iPhone format
  'image/heif', // ✅ iPhone format
  'image/heic-sequence',
  'image/heif-sequence',
];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
const MAX_IMAGE_SIZE = MAX_IMAGE_SIZE_BYTES;

// Validation helpers
const validateMediaType = (mimeType: string | undefined, mediaType: 'image' | 'video'): boolean => {
  if (!mimeType) return false;
  const allowedTypes = mediaType === 'image' ? ALLOWED_IMAGE_TYPES : ALLOWED_VIDEO_TYPES;
  return allowedTypes.some(type => mimeType.toLowerCase().includes(type.toLowerCase()));
};

import * as LegacyFileSystem from 'expo-file-system/legacy';

const getFileSizeFromUri = async (uri: string): Promise<number> => {
  try {
    const info = await LegacyFileSystem.getInfoAsync(uri, { size: true } as any);
    if (info && info.exists && typeof (info as any).size === 'number') return (info as any).size;
    return 0;
  } catch (error) {
    if (__DEV__) console.warn('Could not determine file size:', error);
    return 0;
  }
};

function CreatePostScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { clear: clearPostCache } = usePostCache();
  const colorScheme = useColorScheme() ?? 'light';
  const params = useLocalSearchParams<{ gameId?: string; type?: string }>();
  const gameId = params?.gameId ? String(params.gameId) : undefined;
  const postType = params?.type === 'highlight' ? 'highlight' : 'post';
  const {
    location,
    loading: _locLoading,
    error: _locError,
    permissionGranted,
    requestPermission,
    needsPreciseAccuracy,
    openSettings,
  } = useDeviceLocation();

  const [content, setContent] = useState('');
  const [picked, setPicked] = useState<{
    uri: string;
    type: 'image' | 'video';
    mime?: string;
    width?: number;
    height?: number;
    /** Picked-asset duration in seconds (ImagePicker reports ms) — drives the 90s cap. */
    durationS?: number;
  } | null>(null);
  const [mediaDimensions, setMediaDimensions] = useState<{ width: number; height: number } | null>(
    null
  );
  const [selectedGameId, setSelectedGameId] = useState<string | undefined>(
    postType === 'highlight' ? gameId : undefined
  );
  const [suggestedGame, setSuggestedGame] = useState<any>(null);
  const [nearbyGames, setNearbyGames] = useState<any[]>([]);
  const [rotatingPromptIndex, setRotatingPromptIndex] = useState(0);
  const [eventSelectorVisible, setEventSelectorVisible] = useState(false);
  const [hasAutoSuggested, setHasAutoSuggested] = useState(postType === 'highlight' && !!gameId); // If gameId from params for highlights, don't auto-suggest
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [precisionBannerDismissed, setPrecisionBannerDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Phase + the progress of THAT phase. `mediaUploadPercent` folds the two into
  // the single forward-only bar the user sees (utils/uploadProgress.ts).
  const [mediaPhase, setMediaPhase] = useState<MediaUploadPhase>('uploading');
  const [phaseProgress, setPhaseProgress] = useState(0);
  // The picker's own video export blocks inside launchImageLibraryAsync /
  // launchCameraAsync with no progress signal of any kind (expo-image-picker's
  // iOS transcodeVideoAsync just awaits exportSession.export()). The picker's
  // modal dismisses the moment the user taps Choose, so those seconds render as
  // a frozen, silent composer. We can't measure it — but we can stop it being
  // silent: this holds the overlay's label and is set on tap, so the overlay is
  // already mounted behind the picker and is what the user lands on when the
  // modal goes away. It is an honest spinner, never a fabricated percentage.
  const [pickPreparing, setPickPreparing] = useState<string | null>(null);
  const [postSuccess, setPostSuccess] = useState(false);
  const [trimmedUri, setTrimmedUri] = useState<string | null>(null);
  const showPrecisionWarning =
    Platform.OS === 'android' &&
    permissionGranted &&
    needsPreciseAccuracy &&
    !precisionBannerDismissed;
  const locationReady =
    typeof location?.latitude === 'number' && typeof location?.longitude === 'number';
  const canTrimVideo = isNativeVideoTrimSupported(Platform.OS);
  const [draftReady, setDraftReady] = useState(false);
  const [contentConsent, setContentConsent] = useState(false);
  const draftLoadedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/create');
    }
  }, [authLoading, router, user]);

  // Reset trim state and content consent when media changes
  useEffect(() => {
    setTrimmedUri(null);
    setContentConsent(false);
  }, [picked?.uri]);

  // Reset form state when returning to this tab (handles stuck postSuccess)
  useFocusEffect(
    useCallback(() => {
      if (postSuccess) {
        setPostSuccess(false);
        setContent('');
        setPicked(null);
        setError(null);
        setSubmitting(false);
        setPreviewVisible(false);
        setSuggestedGame(null);
        setSelectedGameId(postType === 'highlight' ? gameId : undefined);
        setContentConsent(false);
        draftLoadedRef.current = false;
      }
    }, [postSuccess, gameId, postType])
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      if (draftLoadedRef.current) return;
      const draft = await settings.getJson<any>(settings.SETTINGS_KEYS.POST_DRAFT, null);
      if (!active) return;
      draftLoadedRef.current = true;
      if (!draft || (!draft.content && !draft?.picked?.uri)) {
        setDraftReady(true);
        return;
      }
      if (draft.postType && draft.postType !== postType) {
        setDraftReady(true);
        return;
      }
      Alert.alert('Restore draft?', 'You have an unsent post draft. Do you want to restore it?', [
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, null);
            setDraftReady(true);
          },
        },
        {
          text: 'Restore',
          onPress: () => {
            setContent(String(draft.content || ''));
            if (draft.picked?.uri) {
              setPicked({
                uri: String(draft.picked.uri),
                type: draft.picked.type === 'video' ? 'video' : 'image',
                mime: draft.picked.mime,
                width: draft.picked.width,
                height: draft.picked.height,
              });
            }
            if (draft.selectedGameId) {
              setSelectedGameId(String(draft.selectedGameId));
              setHasAutoSuggested(true);
            }
            setDraftReady(true);
          },
        },
      ]);
    })();
    return () => {
      active = false;
    };
  }, [postType]);

  // Get media dimensions when picked (for aspect ratio in preview)
  useEffect(() => {
    if (!picked || picked.type !== 'image') {
      setMediaDimensions(null);
      return;
    }

    void (async () => {
      try {
        const { Image: RNImageModule } = require('react-native');
        RNImageModule.getSize(
          picked.uri,
          (width: number, height: number) => {
            setMediaDimensions({ width, height });
          },
          () => {
            // Fallback if getSize fails
            setMediaDimensions({ width: 16, height: 9 });
          }
        );
      } catch (e) {
        if (__DEV__) console.warn('Failed to get image dimensions:', e);
        setMediaDimensions(null);
      }
    })();
  }, [picked]);

  // Rotate placeholder prompts
  useEffect(() => {
    const prompts = PromptPresets.posting;
    const timer = setInterval(() => {
      setRotatingPromptIndex(prev => (prev + 1) % prompts.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(async () => {
      if (submitting) return;
      const hasContent = Boolean(content.trim() || picked?.uri);
      if (!hasContent) {
        await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, null);
        return;
      }
      const draft = {
        content: content,
        picked,
        selectedGameId: selectedGameId || null,
        postType,
        updated_at: new Date().toISOString(),
      };
      await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, draft);
    }, 600);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [content, picked, selectedGameId, postType, submitting, draftReady]);

  // Request location permission on mount
  useEffect(() => {
    if (!permissionGranted && !hasAutoSuggested && !gameId) {
      requestPermission().catch(() => {
        setLocationError(
          "Unable to access device location. You can still post, but event suggestions won't be available."
        );
      });
    }
  }, [permissionGranted, hasAutoSuggested, gameId, requestPermission]);

  useEffect(() => {
    if (_locError) {
      setLocationError(_locError);
    }
  }, [_locError]);

  // Load game details if gameId is provided via params (from event page)
  useEffect(() => {
    if (__DEV__) console.warn('[CreatePost] useEffect gameId:', gameId);
    if (!gameId) return;

    void (async () => {
      try {
        const game = await Game.get(gameId);
        if (game) {
          setSuggestedGame(game);
          setSelectedGameId(String(game.id));
          setError(null); // Clear any previous errors
        }
      } catch (error) {
        if (__DEV__) console.warn('Failed to load game from params:', error);
        // If game not found (404), clear the selectedGameId so user can still post
        if ((error as any)?.status === 404) {
          setSelectedGameId(undefined);
          setSuggestedGame(null);
          // Don't set error - allow user to post without event
        } else {
          // For other errors (network, etc.), keep the gameId and let backend validate
          // User can still try to post - backend will handle validation
          if (__DEV__)
            console.warn('Game load failed but keeping gameId for backend validation:', error);
        }
      }
    })();
  }, [gameId]);

  // Auto-suggest nearest event ONLY for highlights — regular posts appear on profile only
  // Regular posts: no default event; user must explicitly tap "Attach to event" if desired
  useEffect(() => {
    if (postType !== 'highlight') return;
    if (selectedGameId || hasAutoSuggested) return;

    // If we have permission but no coordinates yet, wait before attempting auto-suggest
    if (permissionGranted && !locationReady) return;

    void (async () => {
      try {
        const now = new Date();
        const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Backend-driven filtering: let API handle distance/date filters
        // Only include location if we have precise coordinates
        const options: Record<string, any> = {
          limit: 10,
          dateFrom: now.toISOString(),
          dateTo: sevenDaysLater.toISOString(),
        };
        if (locationReady && location?.latitude && location?.longitude) {
          options.lat = location.latitude;
          options.lng = location.longitude;
          options.distance = 50;
        }

        const games = await Game.list('-date', options);
        const gamesArray = Array.isArray(games) ? games : games?.games || games?.items || [];
        if (!gamesArray.length) return;

        // Backend already provides distance; minimal client-side work
        const gamesWithDistance = gamesArray.map((g: any) => ({
          ...g,
          latitude:
            typeof g.latitude === 'number' ? g.latitude : typeof g.lat === 'number' ? g.lat : null,
          longitude:
            typeof g.longitude === 'number'
              ? g.longitude
              : typeof g.lng === 'number'
                ? g.lng
                : null,
          distance: typeof g.distance === 'number' ? g.distance : null,
        }));

        // Already sorted by distance on backend if location provided
        setNearbyGames(gamesWithDistance.slice(0, 5));
        const top = gamesWithDistance[0];
        if (top) {
          setSuggestedGame(top);
          setSelectedGameId(String(top.id));
        }
      } catch (error) {
        if (__DEV__) console.warn('Failed to fetch nearby games:', error);
      } finally {
        setHasAutoSuggested(true);
      }
    })();
  }, [
    postType,
    locationReady,
    permissionGranted,
    selectedGameId,
    hasAutoSuggested,
    location?.latitude,
    location?.longitude,
  ]);

  const pickFromLibraryRaw = async (media: 'image' | 'video') => {
    try {
      if (media === 'video') setPickPreparing('Preparing video…');
      const r = await ImagePicker.launchImageLibraryAsync({
        ...pickerMediaTypeFor(media),
        allowsEditing: false, // Don't crop - preserve original photo
        quality: media === 'image' ? 0.85 : undefined,
        exif: false,
        videoExportPreset: VIDEO_CAPTURE_PRESET,
      } as any);
      if (!r.canceled && r.assets && r.assets[0]) {
        const a = { ...r.assets[0], uri: await materializeICloudAssetIfNeeded(r.assets[0].uri) };

        // Validate file type
        const mimeType = a.mimeType || (media === 'image' ? 'image/jpeg' : 'video/mp4');
        if (!validateMediaType(mimeType, media)) {
          Alert.alert(
            'Invalid File Type',
            media === 'image'
              ? 'Please select a valid image file (JPG, PNG, GIF, WebP, or HEIC).'
              : 'Please select a valid video file (MP4, MOV, or WebM).'
          );
          return;
        }

        // Validate file size. Videos are gated against the pick-time SANITY
        // ceiling, not the 150MB upload cap — the picked file is pre-compression
        // bytes and the cap applies to post-compression bytes. Gating the pick
        // on MAX_VIDEO_SIZE_BYTES rejected 90s highlights (a 1080p export runs
        // ~14-16 Mbps → ~160-180MB) that compress to ~68MB and upload fine.
        // prepareVideoForUpload re-checks the real cap on the real bytes.
        const fileSize = await getFileSizeFromUri(a.uri);
        const maxSize = media === 'image' ? MAX_IMAGE_SIZE : MAX_PICKED_VIDEO_SIZE_BYTES;
        const maxSizeMB = media === 'image' ? 10 : MAX_PICKED_VIDEO_SIZE_MB;

        if (fileSize > maxSize) {
          Alert.alert(
            'File Too Large',
            media === 'video'
              ? `This video is ${Math.round(fileSize / (1024 * 1024))}MB, which is too big to process on your phone. Trim it shorter or record at a lower resolution and try again.`
              : `The selected ${media} is too large. Maximum size is ${maxSizeMB}MB.`
          );
          return;
        }

        let uri = a.uri;
        if (media === 'image') {
          // Skip resize for small images (under 2MB) — already fast enough
          if (fileSize > 2 * 1024 * 1024) {
            try {
              const result = await ImageManipulator.manipulateAsync(
                a.uri,
                [{ resize: { width: 1280 } }],
                { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
              );
              uri = result.uri;
            } catch (error: any) {
              if (__DEV__)
                console.warn(
                  '[CreatePost] Image manipulation failed, using original:',
                  error?.message || error
                );
            }
          }
        }
        setPicked({
          uri,
          type: media,
          mime: mimeType,
          durationS: typeof a.duration === 'number' ? a.duration / 1000 : undefined,
        });
      }
    } catch (error: any) {
      if (__DEV__) console.error('[CreatePost] Image picker error:', error);
      // v1.0.2 audit fix: use shared iCloud detection (matches BannerUpload patterns)
      if (isICloudError(error)) {
        Alert.alert(ICLOUD_ERROR_TITLE, ICLOUD_ERROR_MESSAGE);
      } else {
        Alert.alert('Error', 'Failed to select media. Please try again.');
      }
    } finally {
      setPickPreparing(null);
    }
  };

  const pickFromLibrary = (media: 'image' | 'video') => {
    void pickFromLibraryRaw(media);
  };

  const captureWithCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission required', 'Camera permission is needed to capture media.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      // The camera can return either a photo or a video and we don't know which
      // until the promise resolves — after the export has already run. Keep the
      // label media-neutral rather than guessing.
      setPickPreparing('Preparing media…');
      const r = await ImagePicker.launchCameraAsync({
        ...pickerAllMediaTypesProp(),
        allowsEditing: false,
        quality: 0.85,
        exif: false,
        videoExportPreset: VIDEO_CAPTURE_PRESET,
        // Stops video recording at the cap; ignored for photos.
        videoMaxDuration: POST_MAX_DURATION_S,
        legacy: false,
      } as any);
      if (!r.canceled && r.assets && r.assets[0]) {
        const a = { ...r.assets[0], uri: await materializeICloudAssetIfNeeded(r.assets[0].uri) };

        // Auto-detect media type from asset
        const mimeType = a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const isVideo = a.type === 'video' || mimeType.startsWith('video/');
        const media: 'image' | 'video' = isVideo ? 'video' : 'image';

        // Validate file type
        if (!validateMediaType(mimeType, media)) {
          Alert.alert(
            'Invalid File Type',
            media === 'image'
              ? 'Please capture a valid image format.'
              : 'Please capture a valid video format.'
          );
          return;
        }

        // Validate file size — videos against the pick-time sanity ceiling, not
        // the post-compression upload cap (see pickFromLibraryRaw).
        const fileSize = await getFileSizeFromUri(a.uri);
        const maxSize = media === 'image' ? MAX_IMAGE_SIZE : MAX_PICKED_VIDEO_SIZE_BYTES;
        const maxSizeMB = media === 'image' ? 10 : MAX_PICKED_VIDEO_SIZE_MB;

        if (fileSize > maxSize) {
          Alert.alert(
            'File Too Large',
            `The captured ${media} is too large (${Math.round(fileSize / (1024 * 1024))}MB, limit ${maxSizeMB}MB). Try reducing quality or duration.`
          );
          return;
        }

        let uri = a.uri;
        if (media === 'image') {
          // Skip resize for small images (under 2MB) — already fast enough
          if (fileSize > 2 * 1024 * 1024) {
            try {
              const result = await ImageManipulator.manipulateAsync(
                a.uri,
                [{ resize: { width: 1280 } }],
                { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
              );
              uri = result.uri;
            } catch (error: any) {
              if (__DEV__)
                console.warn(
                  '[CreatePost] Image manipulation failed, using original:',
                  error?.message || error
                );
            }
          }
        }
        setPicked({
          uri,
          type: media,
          mime: mimeType,
          durationS: typeof a.duration === 'number' ? a.duration / 1000 : undefined,
        });
      }
    } catch (error: any) {
      if (__DEV__) console.error('[CreatePost] Camera error:', error);
      Alert.alert('Error', 'Failed to capture media. Please try again.');
    } finally {
      setPickPreparing(null);
    }
  };

  const [error, setError] = useState<string | null>(null);

  // Images have no observable compression phase of their own, so the whole bar
  // belongs to the upload.
  const mediaCompressShare = picked?.type === 'video' ? COMPRESS_PROGRESS_SHARE : 0;
  const overallMediaPercent = mediaUploadPercent(mediaPhase, phaseProgress, mediaCompressShare);

  // Kept in sync with server/scripts/seed-demo-matchups.ts DEMO_TAG and the
  // [DEMO_MATCHUP] carve-out in server/src/routes/posts.ts — renaming this
  // silently breaks the client bypass for seeded promo matchups.
  const DEMO_MATCHUP_TAG = '[DEMO_MATCHUP]';
  const isDemoMatchupGame =
    typeof suggestedGame?.description === 'string' &&
    suggestedGame.description.includes(DEMO_MATCHUP_TAG);

  // First-post-unlocks-7-days (owner rule 2026-07-15): once this user posted
  // to the selected event page, the client preflight must not re-block them —
  // the server admits unlocked users without location. UX-only; server is law.
  const [hasPostingUnlock, setHasPostingUnlock] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!selectedGameId) {
      setHasPostingUnlock(false);
      return;
    }
    hasLocalEventPostingUnlock([selectedGameId]).then(unlocked => {
      if (!cancelled) setHasPostingUnlock(unlocked);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedGameId]);

  // Proactive geofence + time window check when a game is selected
  const geofenceWarning = useMemo(() => {
    if (!suggestedGame || !selectedGameId) return null;
    // Seeded demo matchups (Duke v UNC, Cavs v Warriors) skip the client
    // warning — server's [DEMO_MATCHUP] carve-out already bypasses geofence
    // and posting-window checks for these Game rows only.
    if (isDemoMatchupGame) return null;
    // Already posted here within the last week — the server won't re-geofence,
    // so don't warn.
    if (hasPostingUnlock) return null;
    // Posting window (server rule in server/src/lib/geofencing.ts): there is NO
    // early cutoff (owner rule 2026-08-28) — posting is open any time up to the
    // live cutoff, so an early arrival is never warned off. The only time-based
    // block left is AFTER the cutoff. The server ships the computed bounds on the
    // payload (`live_from` is always null now).
    const bounds = getLiveBounds(suggestedGame);
    if (!bounds) return null;

    const now = Date.now();
    if (now > bounds.liveUntil) {
      return 'This event has ended. If you posted here while it was live you can keep posting for a week from anywhere.';
    }

    // Check distance (3km = ~1.86 miles) if both user and venue coords are available
    const venueLat = suggestedGame.latitude ?? suggestedGame.venue_lat;
    const venueLng = suggestedGame.longitude ?? suggestedGame.venue_lng;
    if (
      locationReady &&
      location?.latitude &&
      location?.longitude &&
      typeof venueLat === 'number' &&
      typeof venueLng === 'number'
    ) {
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(venueLat - location.latitude);
      const dLon = toRad(venueLng - location.longitude);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(location.latitude)) * Math.cos(toRad(venueLat)) * Math.sin(dLon / 2) ** 2;
      const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (distKm > 3) {
        const distMi = (distKm * 0.621371).toFixed(1);
        return `You're ${distMi} mi from the venue. Your first post to an event needs to be from within 3 km of the venue.`;
      }
    }
    return null;
  }, [
    suggestedGame,
    selectedGameId,
    isDemoMatchupGame,
    hasPostingUnlock,
    locationReady,
    location?.latitude,
    location?.longitude,
  ]);

  const onSubmit = async () => {
    // First, show preview
    const trimmedContent = content.trim();
    if (!trimmedContent && !picked?.uri) {
      setError('Add content or select a media file');
      return;
    }

    // Prepare preview data
    setPreviewData({
      content: trimmedContent,
      media: picked,
      game: suggestedGame,
      type: postType,
    });
    setPreviewVisible(true);
  };

  const confirmPost = async () => {
    if (__DEV__) console.warn('[CreatePost] confirmPost called');
    if (__DEV__)
      console.warn(
        '[CreatePost] State - selectedGameId:',
        selectedGameId,
        '| suggestedGame:',
        suggestedGame?.id
      );

    // Proactive geofence check: if posting to a real event and location is not available, prompt first.
    // Seeded demo matchups bypass the location gate — server carve-out accepts uploads without coords.
    const isRealGame = Boolean(selectedGameId);
    const gameHasCoords =
      typeof suggestedGame?.latitude === 'number' || typeof suggestedGame?.venue_lat === 'number';
    // H3 (2026-07-14): past the live cutoff the server may still allow posting
    // — unlocked users post from anywhere. Don't hard-block on location then —
    // defer to the server, which returns a clear reason if they don't qualify.
    // Same for users holding a local posting unlock (owner rule 2026-07-15:
    // first post geofenced, then a week without re-passing). The cutoff comes
    // from the server's computed bounds; it used to be a hardcoded +3h, which
    // dropped the location gate 15 hours early on an 18h fest event.
    const isPostEventGrace = isGameOver(suggestedGame);
    if (
      isRealGame &&
      gameHasCoords &&
      !locationReady &&
      !isDemoMatchupGame &&
      !isPostEventGrace &&
      !hasPostingUnlock
    ) {
      if (!permissionGranted) {
        // Try the in-app OS prompt first. If location was never requested
        // (e.g. the user tapped "Skip" in onboarding), requestPermission()
        // shows the system "Allow" dialog — one tap, no detour. If it was
        // already denied, it resolves false immediately (the OS won't re-ask),
        // and only then do we route to Settings. This stops first-time users
        // from being bounced to Settings for a permission they were never asked.
        const granted = await requestPermission();
        if (!granted) {
          Alert.alert(
            'Location Required',
            'This event requires you to be within 3 km of the venue. Enable location access to continue.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => openSettings() },
            ]
          );
        }
        return;
      }
      // Permission granted but coords not yet acquired — block submit and prompt retry
      Alert.alert(
        'Location Not Ready',
        'Your location is still loading. Please wait a moment and try again.',
        [{ text: 'OK' }]
      );
      return;
    }

    void doConfirmPost();
  };

  const doConfirmPost = async () => {
    // 90s highlight cap: an over-limit pick must go through the trimmer (which
    // clamps its window to the cap) before it can post. Trimmed output is
    // capped by construction, so only the untrimmed original needs checking.
    if (
      picked?.type === 'video' &&
      !trimmedUri &&
      typeof picked.durationS === 'number' &&
      picked.durationS > POST_MAX_DURATION_S + 0.25
    ) {
      Alert.alert(
        'Video Too Long',
        `Highlights are limited to ${POST_MAX_DURATION_S} seconds. Use the trimmer to pick your best ${POST_MAX_DURATION_S} seconds, or choose a shorter clip.`
      );
      return;
    }
    setSubmitting(true);
    setMediaPhase(picked?.type === 'video' ? 'compressing' : 'uploading');
    setPhaseProgress(0);
    setError(null);

    try {
      let finalMediaUrl = '';
      let finalPosterUrl = '';
      const mediaMeta: {
        media_width?: number;
        media_height?: number;
        media_bytes?: number;
        media_duration_s?: number;
      } = {};
      if (picked?.uri) {
        if (__DEV__) console.warn('[CreatePost] Uploading media...');
        const { getApiBaseUrl } = await import('@/api/http');
        const base = getApiBaseUrl();
        const name = picked.type === 'image' ? 'image.jpg' : 'video.mp4';
        const mime = picked.mime || (picked.type === 'image' ? 'image/jpeg' : 'video/mp4');
        const sourceUri = picked.type === 'video' && trimmedUri ? trimmedUri : picked.uri;
        // Compression is the single longest step of a video post (~14s for a 90s
        // 1080p clip) and used to run with the bar pinned at 0%, which read as a
        // hang. The compressor has always emitted progress — now we forward it.
        const prepared =
          picked.type === 'video'
            ? await prepareVideoForUpload(sourceUri, {
                onCompressProgress: fraction => setPhaseProgress(fraction * 100),
              })
            : null;
        const uploadUri = prepared ? prepared.uri : sourceUri;
        setMediaPhase('uploading');
        setPhaseProgress(0);
        // Video previews are derived client-side from the Cloudinary media URL,
        // so we upload a single canonical video asset instead of a second
        // thumbnail file and extra signature/upload call.
        const mainUpload = uploadFile(base, uploadUri, name, mime, {
          onProgress: pct => setPhaseProgress(pct),
          ...(prepared ? { timeoutMs: uploadTimeoutMsForSize(prepared.finalSizeBytes) } : {}),
        }).catch((uploadErr: any) => {
          const msg: string = uploadErr?.message || '';
          console.error('[CreatePost] Media upload failed:', msg);
          if (msg.includes('timeout') || msg.includes('Timeout')) {
            const timeoutErr: any = new Error(
              'Upload timed out. Please check your connection and try again.'
            );
            timeoutErr.status = uploadErr?.status;
            throw timeoutErr;
          }
          // Surface the actual underlying error so it's debuggable
          const rewrapped: any = new Error(msg || 'Media upload failed. Please try again.');
          rewrapped.status = uploadErr?.status;
          throw rewrapped;
        });
        const res = await mainUpload;
        finalMediaUrl = res?.url || '';
        if (!finalMediaUrl) {
          throw new Error('Media upload succeeded but returned no URL. Please try again.');
        }
        // Capture media dimensions/size the uploader surfaced (aspect-ratio
        // hints + storage-migration tooling). Undefined on the server-proxy
        // fallback path, which is fine — the columns are nullable.
        if (typeof res?.width === 'number') mediaMeta.media_width = res.width;
        if (typeof res?.height === 'number') mediaMeta.media_height = res.height;
        if (typeof res?.bytes === 'number') mediaMeta.media_bytes = res.bytes;
        if (typeof res?.duration === 'number') mediaMeta.media_duration_s = res.duration;
        // The bytes are in. The poster upload + the create call are what's left,
        // and neither is worth its own bar segment.
        setMediaPhase('finalizing');
        if (__DEV__) console.warn('[CreatePost] Upload complete:', finalMediaUrl);
        // R2 stores bytes verbatim — no server-side poster derivation exists
        // (Cloudinary posts get theirs derived by the serializer). Generate a
        // first-frame poster on-device and upload it alongside the video so
        // feeds and share previews have an image. Best-effort: a video post
        // without a poster still works.
        if ((res as any)?.provider === 'r2' && picked.type === 'video') {
          try {
            // Dynamic require, same OTA-safety pattern as highlights.tsx —
            // never crash a binary built before the module existed.
            let VideoThumbnails: any = null;
            try {
              VideoThumbnails = require('expo-video-thumbnails');
            } catch {
              /* module unavailable in this binary */
            }
            if (VideoThumbnails?.getThumbnailAsync) {
              const thumb = await VideoThumbnails.getThumbnailAsync(uploadUri, {
                time: 0,
                quality: 0.7,
              });
              if (thumb?.uri) {
                if (typeof thumb.width === 'number') mediaMeta.media_width = thumb.width;
                if (typeof thumb.height === 'number') mediaMeta.media_height = thumb.height;
                const posterRes = await uploadFile(base, thumb.uri, 'poster.jpg', 'image/jpeg');
                finalPosterUrl = posterRes?.url || '';
                if (__DEV__) console.warn('[CreatePost] Poster uploaded:', finalPosterUrl);
              }
            }
          } catch (posterErr: any) {
            if (__DEV__) console.warn('[CreatePost] Poster generation failed:', posterErr?.message);
          }
        }
        // Clean up temp trimmed files after successful upload
        try {
          const filesToClean = [trimmedUri].filter(
            (f): f is string => !!f && f.startsWith(LegacyFileSystem.cacheDirectory || '')
          );
          for (const f of filesToClean) {
            LegacyFileSystem.deleteAsync(f, { idempotent: true }).catch(() => {});
          }
        } catch {
          /* non-critical cleanup */
        }
      }
      const trimmedContent = sanitizeText(content);

      const locationPayload =
        location?.latitude && location?.longitude
          ? { lat: location.latitude, lng: location.longitude, source: 'device' as const }
          : {};
      const payload: Record<string, any> = {
        content: trimmedContent,
        media_url: finalMediaUrl || undefined,
        ...(finalMediaUrl ? mediaMeta : {}),
        ...(finalMediaUrl && finalPosterUrl ? { poster_url: finalPosterUrl } : {}),
        type: postType,
        location: locationPayload,
      };

      if (selectedGameId) {
        payload.game_id = selectedGameId;
      }

      if (__DEV__)
        console.warn('[CreatePost] Final payload keys:', Object.keys(payload).join(', '));

      // Require event link for highlight posts to ensure they surface on the event page
      if (postType === 'highlight' && !payload.game_id) {
        throw new Error('Please attach an event to share a highlight.');
      }

      if (__DEV__) console.warn('[CreatePost] Calling Post.create...');
      await Post.create(payload);
      clearPostCache();
      if (__DEV__) console.warn('[CreatePost] Post created successfully!');
      if (selectedGameId) {
        // Mirror the server's posting unlock locally so preflight prompts
        // don't re-block this user on their next upload to this event page.
        void recordEventPostingUnlock([selectedGameId]);
      }
      analytics.track(ANALYTICS_EVENTS.POST_CREATED, { type: picked?.type || 'text' });
      try {
        await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, null);
      } catch (error) {
        // Non-critical: draft clearing failed, but post was created successfully
        if (__DEV__) console.warn('[CreatePost] Failed to clear draft:', error);
      }

      setPreviewVisible(false);
      setPostSuccess(true);

      const finish = () => {
        setPostSuccess(false);
        setContent('');
        setPicked(null);
        setError(null);
        safeGoBack(router, '/(tabs)/feed');
      };

      // Owner rule (2026-07-16): remind attendees to keep event posts on-topic,
      // but only on their FIRST post to a given event page. The server already
      // proved they were there — it accepted the post — so this is a reminder,
      // not a gate. Seen-state is per (user, event); a fan posting thirteen
      // times reads it once.
      const showNotice =
        !!selectedGameId &&
        (await shouldShowEventPostingNotice(user?.id, [selectedGameId, suggestedGame?.event_id]));

      if (showNotice) {
        void markEventPostingNoticeSeen(user?.id, [selectedGameId, suggestedGame?.event_id]);
        Alert.alert(
          '🏟️ Keep it to the game',
          'Please only post photos and videos from the game. Anything unrelated may result in your post being taken down.',
          [{ text: 'Got it', onPress: finish }],
          { onDismiss: finish }
        );
        return;
      }

      // Keep checkmark state briefly, then navigate — no full-screen popup
      setTimeout(finish, 800);
    } catch (e: any) {
      if (__DEV__)
        console.error('[CreatePost] Error creating post:', {
          message: e?.message,
          status: e?.status,
          data: e?.data,
          selectedGameId,
        });
      const issues = (e?.data?.issues || []) as { message: string }[];
      if (e?.status === 409 && e?.data?.code === 'DUPLICATE_POST') {
        // Post was already submitted — navigate away as if successful.
        // This handles double-tap and retry-after-timeout without showing
        // a confusing error to the user.
        setPostSuccess(true);
        setTimeout(() => safeGoBack(router, '/(tabs)/feed'), 800);
        return;
      } else if (issues.length) {
        setError(issues.map(i => i.message).join('\n'));
      } else {
        // Provide more helpful error messages
        if (e?.status === 404 && selectedGameId) {
          setError(
            'Event not found. Please remove the event attachment and try again, or select a different event.'
          );
        } else if (e?.status === 403) {
          const code = e?.data?.error;
          if (code === 'Email verification required') {
            setError('You need to verify your email before posting.');
            Alert.alert('Verify Your Email', 'You need to verify your email before posting.', [
              { text: 'Later', style: 'cancel' },
              { text: 'Verify Now', onPress: () => router.push('/verify' as any) },
            ]);
          } else if (code === 'POSTING_WINDOW_CLOSED') {
            // One code, two meanings: the event hasn't opened yet, or it's over
            // and this user never posted from the venue (owner rule 2026-07-16
            // — "you didn't post while there so do not have access to post
            // afterwards"). The server writes the right sentence for each; the
            // rule stays server-side, so just show it. Title is deliberately
            // neutral — the old 'Not Yet' read as "come back later" on a
            // finished event, where there is no later.
            const msg = e?.data?.message || 'Posting is not open for this event.';
            Alert.alert('Posting Closed', msg);
            setError(msg);
          } else if (code === 'TOO_FAR_FROM_VENUE') {
            const dist = e?.data?.distance;
            const msg = e?.data?.message || 'You must be within 3 km of the venue to post.';
            analytics.track(ANALYTICS_EVENTS.GEOFENCE_BLOCKED, { distance: dist });
            Alert.alert(
              'Not at the Venue',
              `${msg}${dist ? `\n\nYou are ${dist.toFixed(1)} km away.` : ''}`
            );
            setError(msg);
          } else if (code === 'LOCATION_REQUIRED') {
            Alert.alert(
              'Location Required',
              "Enable location access so we can verify you're at the venue.",
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => openSettings() },
              ]
            );
            setError('Location access is required to post to this event.');
          } else if (code === 'NO_EVENT_LOCATION') {
            Alert.alert(
              'Cannot Verify Location',
              'This game has no event location set yet, so posting is disabled until the venue is configured.'
            );
            setError('Posting is disabled until this event has venue coordinates.');
          } else {
            // Every other server-side posting rule (EXCLUSIVE_POSTER_ONLY,
            // EVENT_NOT_FOUND, …). The server ships a written reason for each;
            // surface it rather than re-deriving the rule here. Prefer
            // `message` over `error`: on this envelope `error` is the CODE, so
            // the old order showed users raw strings like
            // "EXCLUSIVE_POSTER_ONLY" whenever a code had no branch above.
            const msg =
              e?.data?.message ||
              (typeof e?.data?.error === 'string' && !/^[A-Z][A-Z0-9_]{2,}$/.test(e.data.error)
                ? e.data.error
                : null) ||
              'You do not have permission to post to this event.';
            Alert.alert('Cannot Post', msg);
            setError(msg);
          }
        } else {
          setError(
            e?.status === 429
              ? 'You have hit the hourly upload limit. Wait a few minutes and try again.'
              : e?.message || 'Failed to create post. Please try again.'
          );
        }
      }
    } finally {
      setSubmitting(false);
      setPhaseProgress(0);
      if (!postSuccess) setPreviewVisible(false);
    }
  };

  const canPost = useMemo(() => !!content.trim() || !!picked?.uri, [content, picked]);
  const buttonLabel = submitting
    ? postType === 'highlight'
      ? 'Posting highlight...'
      : 'Posting...'
    : postType === 'highlight'
      ? 'Share Highlight'
      : 'Post';

  // Hard guard: never render the composer for a signed-out user. The useEffect
  // above redirects guests to /create, but that runs AFTER the first render —
  // without this a guest reaching create-post directly (e.g. an event page's
  // "Create Post" button) briefly sees the composer and can attempt a post,
  // hitting a raw "Unauthorized". Owner ask (2026-07-14): don't even let a
  // signed-out user reach the upload screen.
  if (!authLoading && !user) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen options={{ headerShown: false }} />
      </SafeAreaView>
    );
  }

  return (
    <SwipeBackContainer>
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen options={{ headerShown: false }} />

        {/* Header */}
        <View
          style={[
            styles.header,
            {
              backgroundColor: Colors[colorScheme].background,
              borderBottomColor: Colors[colorScheme].border,
            },
          ]}
        >
          <Pressable
            testID="create-post-close-button"
            onPress={() => safeGoBack(router)}
            accessibilityLabel="Close"
            style={styles.iconBtn}
          >
            <Ionicons name="close" size={22} color={Colors[colorScheme].text} />
          </Pressable>
          <View style={styles.headerSpacer} />
          <View style={styles.postButtonContainer}>
            <Pressable
              testID="create-post-submit-button"
              onPress={onSubmit}
              disabled={!canPost || submitting || postSuccess}
              style={[
                styles.headerPostBtn,
                submitting && { backgroundColor: '#1B3A6B', opacity: 1 },
                (!canPost || postSuccess) && !submitting && { opacity: 0.45 },
              ]}
              accessibilityLabel={buttonLabel}
            >
              {submitting ? (
                <Text style={styles.headerPostBtnText}>Posting...</Text>
              ) : (
                <>
                  <Ionicons name="send" size={16} color="#FFFFFF" />
                  <Text style={styles.headerPostBtnText}>
                    {postType === 'highlight' ? 'Share' : 'Post'}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        <KeyboardAwareScreen contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
          {/* Composer Section with Rotating Tips */}
          <View style={styles.composerSection}>
            <MentionInput
              value={content}
              onChangeText={setContent}
              placeholder={PromptPresets.posting[rotatingPromptIndex].text}
              placeholderTextColor={Colors[colorScheme].mutedText}
              multiline
              style={[
                styles.textarea,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              maxLength={4000}
            />
            <Text style={[styles.helper, { color: Colors[colorScheme].mutedText }]}>
              Use # to tag teams and @ to mention players
            </Text>
          </View>

          {/* Media Actions */}
          <View style={styles.mediaSection}>
            <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
              Add Media
            </Text>
            <View style={styles.tilesRow}>
              <Pressable
                testID="create-post-photo-picker"
                style={[styles.tile, styles.primaryTile]}
                onPress={() => pickFromLibrary('image')}
                accessibilityLabel="Photo Gallery"
              >
                <Ionicons name="image-outline" size={24} color="#FFFFFF" />
                <Text style={[styles.tileLabel, styles.primaryTileLabel]}>Photo</Text>
              </Pressable>
              <Pressable
                testID="create-post-camera-picker"
                style={[styles.tile, styles.primaryTile]}
                onPress={() => captureWithCamera()}
                accessibilityLabel="Camera"
              >
                <Ionicons name="camera-outline" size={24} color="#FFFFFF" />
                <Text style={[styles.tileLabel, styles.primaryTileLabel]}>Camera</Text>
              </Pressable>
              <Pressable
                testID="create-post-video-picker"
                style={[styles.tile, styles.primaryTile]}
                onPress={() => pickFromLibrary('video')}
                accessibilityLabel="Video Gallery"
              >
                <Ionicons name="videocam-outline" size={24} color="#FFFFFF" />
                <Text style={[styles.tileLabel, styles.primaryTileLabel]}>Video</Text>
              </Pressable>
            </View>
          </View>

          {/* Media Preview */}
          {picked?.uri ? (
            <View style={styles.previewSection}>
              <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                Preview
              </Text>
              <View style={styles.previewContainer}>
                {picked.type === 'image' ? (
                  <RNImage
                    source={{ uri: picked.uri }}
                    style={[styles.previewMedia, { backgroundColor: Colors[colorScheme].surface }]}
                  />
                ) : (
                  <>
                    {/* Composer preview: the user is authoring, not watching.
                        Autoplay here means full-volume sound through the
                        hardware silent switch the moment they pick a clip. */}
                    <VideoPlayer
                      uri={trimmedUri ?? picked.uri}
                      style={styles.previewMedia}
                      autoPlay={false}
                    />
                    {canTrimVideo ? (
                      <VideoTrimmer
                        uri={picked.uri}
                        maxDurationS={POST_MAX_DURATION_S}
                        onTrimComplete={u => setTrimmedUri(u)}
                        onTrimReset={() => setTrimmedUri(null)}
                      />
                    ) : null}
                    <Text style={[styles.cropHint, { color: Colors[colorScheme].mutedText }]}>
                      {canTrimVideo
                        ? 'Trim your video using the handles above.'
                        : 'Web uploads the selected video as-is. Trimming is available in the iOS and Android app.'}
                    </Text>
                  </>
                )}
                <Pressable
                  testID="create-post-remove-media-button"
                  style={styles.removeButton}
                  onPress={() => setPicked(null)}
                  accessibilityLabel="Remove media"
                >
                  <Ionicons name="close" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Nearby Games/Events Prompt */}
          {nearbyGames.length > 0 && !suggestedGame && (
            <View style={styles.gameSection}>
              <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                📍 Nearby games you can tag:
              </Text>
              <Text style={[styles.nearbyGamesHint, { color: Colors[colorScheme].mutedText }]}>
                Select a game to attach your post to
              </Text>
              {nearbyGames.slice(0, 3).map(game => (
                <Pressable
                  testID={`create-post-game-card-${game.id}`}
                  key={game.id}
                  style={[
                    styles.nearbyGameCard,
                    {
                      backgroundColor: Colors[colorScheme].card,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                  onPress={() => {
                    setSuggestedGame(game);
                    setSelectedGameId(String(game.id));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Tag game: ${game.title || `${game.home_team} vs ${game.away_team}`}`}
                >
                  <View style={styles.gameIconContainer}>
                    <Ionicons name="location" size={18} color={Colors[colorScheme].tint} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.gameTitle, { color: Colors[colorScheme].text }]}>
                      {game.title || `${game.home_team} vs ${game.away_team}`}
                    </Text>
                    <View style={styles.gameMetaRow}>
                      {game.distance !== null && game.distance !== undefined && (
                        <Text style={[styles.gameDistance, { color: Colors[colorScheme].tint }]}>
                          {game.distance < 1
                            ? `${Math.round(game.distance * 1000)}m away`
                            : `${game.distance.toFixed(1)}km away`}
                        </Text>
                      )}
                      {game.date && (
                        <Text style={[styles.gameDate, { color: Colors[colorScheme].mutedText }]}>
                          {game.distance !== null && game.distance !== undefined && ' • '}
                          {new Date(game.date).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color={Colors[colorScheme].mutedText}
                  />
                </Pressable>
              ))}
              {nearbyGames.length > 3 && (
                <Pressable
                  testID="create-post-view-all-games"
                  style={[styles.viewMoreButton, { backgroundColor: Colors[colorScheme].surface }]}
                  onPress={() => setEventSelectorVisible(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`View all ${nearbyGames.length} nearby games`}
                >
                  <Text style={[styles.viewMoreText, { color: Colors[colorScheme].tint }]}>
                    View all {nearbyGames.length} nearby games
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* Selected Game/Event */}
          {suggestedGame && selectedGameId && (
            <View style={styles.gameSection}>
              <Pressable
                testID="create-post-tagged-game-button"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: '#000000',
                  borderColor: '#A0A0A0',
                  borderWidth: 1.5,
                  borderRadius: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                }}
                onPress={() => (nearbyGames.length > 1 ? setEventSelectorVisible(true) : null)}
                accessibilityRole="button"
                accessibilityLabel={`Tagged game: ${suggestedGame.title || `${suggestedGame.home_team} vs ${suggestedGame.away_team}`}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
                    {suggestedGame.title ||
                      `${suggestedGame.home_team} vs ${suggestedGame.away_team}`}
                  </Text>
                  {suggestedGame.date && (
                    <Text style={{ color: '#A0A0A0', fontSize: 13, marginTop: 2 }}>
                      {new Date(suggestedGame.date).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                      })}{' '}
                      •{' '}
                      {new Date(suggestedGame.date).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  )}
                </View>
                <Ionicons name="checkmark-circle" size={22} color="#A0A0A0" />
              </Pressable>

              <Pressable
                testID="create-post-remove-tagged-game-button"
                style={{ alignSelf: 'flex-end', marginTop: 8, paddingVertical: 4 }}
                onPress={() => {
                  setSuggestedGame(null);
                  setSelectedGameId(undefined);
                }}
                accessibilityRole="button"
                accessibilityLabel="Remove tagged game"
              >
                <Text style={{ color: Colors[colorScheme].mutedText, fontSize: 13 }}>Remove</Text>
              </Pressable>
            </View>
          )}

          {/* Geofence / Time Window Warning */}
          {geofenceWarning && (
            <View
              style={[
                styles.warningBanner,
                {
                  backgroundColor: colorScheme === 'dark' ? Colors[colorScheme].surface : '#1B3A6B',
                  borderColor: colorScheme === 'dark' ? Colors[colorScheme].border : '#1B3A6B',
                  marginBottom: 12,
                },
              ]}
            >
              <Ionicons
                name="warning-outline"
                size={16}
                color={colorScheme === 'dark' ? '#FBBF24' : '#FFFFFF'}
              />
              <Text
                style={[
                  styles.warningText,
                  {
                    color: colorScheme === 'dark' ? '#FBBF24' : '#FFFFFF',
                  },
                ]}
              >
                {geofenceWarning}
              </Text>
            </View>
          )}

          {/* Footer */}
          <View style={styles.footerSection}>
            <Text style={[styles.footerLink, { color: Colors[colorScheme].tint }]}>
              Respect all the players on the field.
            </Text>
            {showPrecisionWarning ? (
              <View
                style={[
                  styles.warningBanner,
                  {
                    backgroundColor:
                      colorScheme === 'dark' ? Colors[colorScheme].surface : '#1B3A6B',
                    borderColor: colorScheme === 'dark' ? Colors[colorScheme].border : '#1B3A6B',
                    marginTop: 12,
                  },
                ]}
              >
                <Ionicons
                  name="navigate-outline"
                  size={16}
                  color={colorScheme === 'dark' ? Colors[colorScheme].tint : '#FFFFFF'}
                />
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.warningText,
                      {
                        color: colorScheme === 'dark' ? Colors[colorScheme].text : '#FFFFFF',
                        marginBottom: 4,
                      },
                    ]}
                  >
                    Precise location is off. Nearby event suggestions may be less accurate on
                    Android.
                  </Text>
                  <View style={styles.warningActionsRow}>
                    <Pressable
                      onPress={() => setPrecisionBannerDismissed(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Dismiss precision location warning"
                    >
                      <Text
                        style={[
                          styles.warningActionLink,
                          {
                            color: colorScheme === 'dark' ? Colors[colorScheme].tint : '#FFFFFF',
                          },
                        ]}
                      >
                        Maybe later
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setPrecisionBannerDismissed(true);
                        void openSettings();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Open location settings"
                    >
                      <Text
                        style={[
                          styles.warningActionLink,
                          { color: Colors[colorScheme].tint, fontWeight: '700' },
                        ]}
                      >
                        Open settings
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}
            {locationError && (
              <View
                style={[
                  styles.warningBanner,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor:
                      colorScheme === 'dark' ? Colors[colorScheme].destructive + '80' : '#FCA5A5',
                  },
                ]}
              >
                <Ionicons name="alert-circle" size={16} color={Colors[colorScheme].destructive} />
                <Text style={[styles.warningText, { color: Colors[colorScheme].destructive }]}>
                  {locationError}
                </Text>
              </View>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        </KeyboardAwareScreen>

        {/* Event Selector Modal */}
        <Modal
          visible={eventSelectorVisible}
          animationType="slide"
          onRequestClose={() => setEventSelectorVisible(false)}
          presentationStyle="pageSheet"
        >
          <SafeAreaView
            style={[styles.modalContainer, { backgroundColor: Colors[colorScheme].background }]}
          >
            <View
              style={[
                styles.modalHeader,
                {
                  backgroundColor: Colors[colorScheme].background,
                  borderBottomColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.modalTitle, { color: Colors[colorScheme].text }]}>
                Select Event
              </Text>
              <Pressable
                onPress={() => setEventSelectorVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close event selector"
              >
                <Ionicons name="close" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.modalBody}>
              {nearbyGames.length > 0 ? (
                <>
                  {nearbyGames.map((game, index) => (
                    <Pressable
                      key={game.id}
                      style={[
                        styles.eventOptionCard,
                        {
                          backgroundColor: Colors[colorScheme].card,
                          borderColor: Colors[colorScheme].border,
                        },
                        selectedGameId === String(game.id) && {
                          borderColor: '#059669',
                          borderWidth: 2,
                        },
                      ]}
                      onPress={() => {
                        setSuggestedGame(game);
                        setSelectedGameId(String(game.id));
                        setEventSelectorVisible(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Select ${game.title || `${game.home_team} vs ${game.away_team}`}`}
                    >
                      <View
                        style={[
                          styles.eventOptionIcon,
                          { backgroundColor: Colors[colorScheme].surface },
                        ]}
                      >
                        <Ionicons
                          name={index === 0 ? 'star' : 'trophy'}
                          size={20}
                          color={index === 0 ? '#F59E0B' : '#059669'}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        {index === 0 && game.distance !== null && game.distance !== undefined && (
                          <Text style={[styles.eventOptionBadge, { color: '#F59E0B' }]}>
                            Nearest Event
                          </Text>
                        )}
                        <Text
                          style={[styles.eventOptionTitle, { color: Colors[colorScheme].text }]}
                        >
                          {game.title || `${game.home_team} vs ${game.away_team}`}
                        </Text>
                        {game.distance !== null && game.distance !== undefined && (
                          <Text style={[styles.gameDistance, { color: '#3B82F6', marginTop: 4 }]}>
                            📍{' '}
                            {game.distance < 1
                              ? `${Math.round(game.distance * 1000)}m away`
                              : `${game.distance.toFixed(1)}km away`}
                          </Text>
                        )}
                        {game.date && (
                          <Text
                            style={[
                              styles.eventOptionDate,
                              { color: Colors[colorScheme].mutedText },
                            ]}
                          >
                            {new Date(game.date).toLocaleDateString()} at{' '}
                            {new Date(game.date).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </Text>
                        )}
                        {game.location && (
                          <Text
                            style={[
                              styles.eventOptionLocation,
                              { color: Colors[colorScheme].mutedText },
                            ]}
                          >
                            📍 {game.location}
                          </Text>
                        )}
                      </View>
                      {selectedGameId === String(game.id) && (
                        <Ionicons name="checkmark-circle" size={24} color="#059669" />
                      )}
                    </Pressable>
                  ))}
                </>
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="calendar-outline"
                    size={48}
                    color={Colors[colorScheme].mutedText}
                  />
                  <Text style={[styles.emptyStateTitle, { color: Colors[colorScheme].text }]}>
                    No Events Found
                  </Text>
                  <Text style={[styles.emptyStateText, { color: Colors[colorScheme].mutedText }]}>
                    There are no upcoming events in the next 7 days.
                  </Text>
                </View>
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* Post Preview Modal */}
        <Modal
          visible={previewVisible}
          animationType="slide"
          onRequestClose={() => setPreviewVisible(false)}
          presentationStyle="pageSheet"
        >
          <SafeAreaView
            style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
          >
            <View
              style={[
                styles.modalHeader,
                {
                  backgroundColor: Colors[colorScheme].background,
                  borderBottomColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.modalTitle, { color: Colors[colorScheme].text }]}>
                Preview Post
              </Text>
              <Pressable
                onPress={() => setPreviewVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close preview"
              >
                <Ionicons name="close" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{
                padding: 16,
                flexGrow: 1,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {/* Preview Card - Shows how post will look in feed */}
              <View
                style={[
                  styles.previewCard,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                    width: '100%',
                    maxWidth: 500,
                  },
                ]}
              >
                <Text style={[styles.previewLabel, { color: Colors[colorScheme].mutedText }]}>
                  This is how your post will appear in the feed:
                </Text>

                {/* Post Content */}
                {previewData?.content && (
                  <Text style={[styles.previewContent, { color: Colors[colorScheme].text }]}>
                    {previewData.content}
                  </Text>
                )}

                {/* Media Preview */}
                {previewData?.media && (
                  <View
                    style={[
                      styles.previewMediaContainer,
                      { backgroundColor: Colors[colorScheme].surface },
                    ]}
                  >
                    {previewData.media.type === 'image' ? (
                      <RNImage
                        source={{ uri: previewData.media.uri }}
                        style={[
                          styles.previewMediaFull,
                          mediaDimensions
                            ? { aspectRatio: mediaDimensions.width / mediaDimensions.height }
                            : undefined,
                        ]}
                        resizeMode="contain"
                      />
                    ) : (
                      <VideoPlayer
                        uri={previewData.media.uri}
                        style={[
                          styles.previewMediaFull,
                          mediaDimensions
                            ? { aspectRatio: mediaDimensions.width / mediaDimensions.height }
                            : undefined,
                        ]}
                        autoPlay={false}
                      />
                    )}
                    {/* Retake/Replace Media Button */}
                    <Pressable
                      style={[
                        styles.retakeButton,
                        { backgroundColor: Colors[colorScheme].background },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Retake or replace media"
                      onPress={() => {
                        setPreviewVisible(false);
                        setPicked(null);
                        Alert.alert('Replace Media', 'Choose how you want to replace your media:', [
                          { text: 'Camera', onPress: () => captureWithCamera() },
                          {
                            text: 'Gallery',
                            onPress: () => pickFromLibrary(previewData.media.type),
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ]);
                      }}
                    >
                      <Ionicons name="camera" size={18} color={Colors[colorScheme].tint} />
                      <Text style={[styles.retakeButtonText, { color: Colors[colorScheme].tint }]}>
                        Retake / Replace
                      </Text>
                    </Pressable>
                  </View>
                )}

                {/* Event Badge */}
                {previewData?.game && selectedGameId && (
                  <View style={styles.previewEventBadge}>
                    <Ionicons name="trophy" size={16} color={Colors[colorScheme].tint} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={[styles.previewEventText, { color: Colors[colorScheme].text }]}>
                        {previewData.game.title ||
                          `${previewData.game.home_team} vs ${previewData.game.away_team}`}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Destination Info */}
                <View
                  style={[
                    styles.previewDestination,
                    { backgroundColor: Colors[colorScheme].surface },
                  ]}
                >
                  <Ionicons
                    name={previewData?.game ? 'trophy' : 'person'}
                    size={16}
                    color={Colors[colorScheme].mutedText}
                  />
                  <Text
                    style={[
                      styles.previewDestinationText,
                      { color: Colors[colorScheme].mutedText },
                    ]}
                  >
                    {previewData?.game && selectedGameId
                      ? 'This post will appear on the event page'
                      : 'This post will appear on your profile'}
                  </Text>
                </View>

                {/* Post Actions Preview */}
                <View style={styles.previewPostActions}>
                  <View style={styles.previewActionButton}>
                    <Ionicons name="arrow-up-outline" size={18} color={Colors[colorScheme].tint} />
                    <Text style={[styles.previewActionText, { color: Colors[colorScheme].tint }]}>
                      0
                    </Text>
                  </View>
                  <View style={styles.previewActionButton}>
                    <Ionicons
                      name="chatbubble-ellipses-outline"
                      size={18}
                      color={Colors[colorScheme].mutedText}
                    />
                    <Text
                      style={[styles.previewActionText, { color: Colors[colorScheme].mutedText }]}
                    >
                      0
                    </Text>
                  </View>
                  <View style={styles.previewActionButton}>
                    <Ionicons
                      name="bookmark-outline"
                      size={18}
                      color={Colors[colorScheme].mutedText}
                    />
                    <Text
                      style={[styles.previewActionText, { color: Colors[colorScheme].mutedText }]}
                    >
                      0
                    </Text>
                  </View>
                </View>
              </View>

              {/* Content Consent (required for media uploads) */}
              {picked?.uri && (
                <Pressable
                  style={{
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    marginBottom: 16,
                    paddingHorizontal: 4,
                  }}
                  onPress={() => setContentConsent(!contentConsent)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: contentConsent }}
                  accessibilityLabel="I confirm I personally filmed or own this content"
                >
                  <Ionicons
                    name={contentConsent ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={
                      contentConsent ? Colors[colorScheme].tint : Colors[colorScheme].mutedText
                    }
                    style={{ marginRight: 10, marginTop: 2 }}
                  />
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 13,
                      lineHeight: 18,
                      color: Colors[colorScheme].mutedText,
                    }}
                  >
                    By uploading, you confirm you personally filmed or own this content. Broadcast
                    footage, TV clips, and copyrighted highlights are strictly prohibited.
                  </Text>
                </Pressable>
              )}

              {/* Media progress — ONE forward-only bar across compress → upload
                  → finalize, driven by the real signal of whichever phase is
                  running (utils/uploadProgress.ts). */}
              {submitting && picked && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                  <View
                    style={{
                      height: 4,
                      backgroundColor: '#E5E7EB',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        height: 4,
                        backgroundColor: '#16A34A',
                        borderRadius: 2,
                        width: `${overallMediaPercent ?? 0}%`,
                      }}
                    />
                  </View>
                  <Text
                    style={{
                      textAlign: 'center',
                      color: Colors.light.mutedText,
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    {mediaUploadLabel(mediaPhase, phaseProgress, mediaCompressShare)}
                  </Text>
                </View>
              )}

              {/* Action Buttons */}
              <View style={styles.previewActions}>
                <Pressable
                  style={[
                    styles.previewButton,
                    styles.editButton,
                    { backgroundColor: Colors[colorScheme].surface },
                  ]}
                  onPress={() => setPreviewVisible(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Edit post"
                >
                  <Ionicons name="create-outline" size={20} color={Colors[colorScheme].text} />
                  <Text style={[styles.previewButtonText, { color: Colors[colorScheme].text }]}>
                    Edit Post
                  </Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.previewButton,
                    styles.confirmButton,
                    { opacity: submitting || (picked?.uri && !contentConsent) ? 0.6 : 1 },
                  ]}
                  onPress={confirmPost}
                  disabled={submitting || (!!picked?.uri && !contentConsent)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    submitting ? 'Posting' : picked?.uri ? 'Confirm and upload' : 'Confirm and post'
                  }
                >
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.confirmButtonText}>
                    {submitting
                      ? 'Posting...'
                      : picked?.uri
                        ? 'Confirm & Upload'
                        : 'Confirm & Post'}
                  </Text>
                </Pressable>
              </View>

              {/* Helpful Tips */}
              <View style={[styles.previewTips, { backgroundColor: Colors[colorScheme].surface }]}>
                <Ionicons
                  name="information-circle-outline"
                  size={20}
                  color={Colors[colorScheme].mutedText}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.previewTipsTitle, { color: Colors[colorScheme].text }]}>
                    Before you post:
                  </Text>
                  <Text style={[styles.previewTipsText, { color: Colors[colorScheme].mutedText }]}>
                    • Double-check your media looks good{'\n'}• Make sure your caption is error-free
                    {'\n'}• Verify the event is correct (if attached)
                  </Text>
                </View>
              </View>
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* No popup — checkmark stays on Confirm button; brief success state then navigate */}

        {/* Pick-time "dead air" cover. The picker's video export runs inside the
            native module with NO progress signal available to JS, and its modal
            dismisses before the export finishes — so the composer sat frozen and
            silent for seconds. This overlay is mounted the moment the pick is
            requested (i.e. underneath the picker modal), so it is what the user
            lands on when the modal goes away. Honest spinner, NOT a fake bar:
            there is no percentage to show here, and inventing one would be worse.
            Plain absolutely-positioned View rather than a <Modal> so it can never
            collide with the native picker's own presentation on iOS. */}
        {pickPreparing && (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundColor: Colors[colorScheme].background,
                opacity: 0.96,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
              },
            ]}
            accessibilityRole="progressbar"
            accessibilityLabel={pickPreparing}
          >
            <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
            <Text style={{ color: Colors[colorScheme].text, fontSize: 15, fontWeight: '600' }}>
              {pickPreparing}
            </Text>
            <Text
              style={{
                color: Colors[colorScheme].mutedText,
                fontSize: 13,
                textAlign: 'center',
                paddingHorizontal: 32,
              }}
            >
              Your phone is getting the clip ready. This can take a few seconds for longer videos.
            </Text>
          </View>
        )}
      </SafeAreaView>
    </SwipeBackContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 20,
  },
  iconBtn: {
    padding: 8,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  headerSpacer: {
    flex: 1,
  },
  postButtonContainer: {
    minWidth: 80,
    alignItems: 'flex-end',
  },

  // Prompts Section
  promptsSection: {
    marginBottom: 20,
  },

  // Composer Section
  composerSection: {
    marginBottom: 24,
  },
  textarea: {
    height: 120,
    borderRadius: 12,
    borderWidth: 1,
    // borderColor: Uses dynamic color in JSX
    padding: 16,
    textAlignVertical: 'top',
    marginBottom: 8,
    fontSize: 16,
    lineHeight: 22,
    // backgroundColor & color: Uses dynamic colors in JSX
  },
  helper: {
    fontSize: 14,
    fontStyle: 'italic',
    // color: Uses dynamic color in JSX
  },

  // Swipe Section
  swipeSection: {
    marginBottom: 24,
    borderRadius: 20,
    borderWidth: 1.5,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  swipeSectionCamera: {
    backgroundColor: '#DBEAFE',
    borderColor: '#93C5FD',
  },
  swipeSectionReview: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
  },
  swipeIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  swipeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 120,
    borderWidth: 1.5,
  },
  swipeOptionInactive: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderColor: 'rgba(17,24,39,0.08)',
  },
  swipeOptionActiveCamera: {
    backgroundColor: '#1D4ED8',
    borderColor: '#1D4ED8',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(29, 78, 216, 0.18)' }
      : {
          shadowColor: '#1D4ED8',
          shadowOpacity: 0.18,
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: 8,
        }),
    elevation: 4,
  },
  swipeOptionActiveReview: {
    backgroundColor: '#DC2626',
    borderColor: '#DC2626',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(220, 38, 38, 0.18)' }
      : {
          shadowColor: '#DC2626',
          shadowOpacity: 0.18,
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: 8,
        }),
    elevation: 4,
  },
  swipeOptionLabel: {
    marginLeft: 8,
    fontSize: 15,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
  },
  swipeOptionLabelActiveCamera: {
    color: '#FFFFFF',
  },
  swipeOptionLabelActiveReview: {
    color: '#FFFFFF',
  },
  swipeDivider: {
    width: 1,
    height: 32,
    backgroundColor: 'rgba(17,24,39,0.08)',
  },
  swipeHint: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '600',
  },
  swipeHintCamera: {
    color: '#1D4ED8',
  },
  swipeHintReview: {
    color: '#DC2626',
  },

  // Media Section
  mediaSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
    marginBottom: 16,
    textAlign: 'center',
  },
  tilesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  tile: {
    width: 100,
    height: 100,
    borderRadius: 20,
    // backgroundColor & borderColor: Uses dynamic colors in JSX
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.08)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.08,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 3,
  },
  primaryTile: {
    backgroundColor: '#1B3A6B',
    borderColor: '#1B3A6B',
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
    marginTop: 6,
  },
  primaryTileLabel: {
    color: '#FFFFFF',
  },
  storyButtonContainer: {
    marginTop: 20,
    alignItems: 'center',
    gap: 8,
  },
  storyHint: {
    fontSize: 12,
    // color: Uses dynamic color in JSX
    fontStyle: 'italic',
    textAlign: 'center',
  },

  // Preview Section
  previewSection: {
    marginBottom: 24,
  },
  previewContainer: {
    position: 'relative',
    borderRadius: 16,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.1,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 4,
  },
  previewMedia: {
    width: '100%',
    height: 240,
    // backgroundColor: Uses dynamic color in JSX
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  cropHint: {
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 2,
  },
  // Game/Event Section
  gameSection: {
    marginBottom: 24,
  },
  gameSuggestionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#ECFDF5',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    gap: 12,
  },
  gameIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#D1FAE5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gameLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  gameTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#065F46',
    marginBottom: 2,
  },
  gameDate: {
    fontSize: 13,
    color: '#047857',
  },
  eventConfirmation: {
    fontSize: 12,
    fontWeight: '600',
  },
  gameHint: {
    fontSize: 12,
    color: Colors.light.mutedText,
    marginTop: 8,
    textAlign: 'center',
    fontStyle: 'italic',
  },

  // Settings Section
  settingsSection: {
    marginBottom: 24,
  },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    // backgroundColor: Uses dynamic color in JSX
    borderRadius: 12,
  },
  settingInfo: {
    flex: 1,
  },
  locLabel: {
    fontWeight: '600',
    fontSize: 16,
    // color: Uses dynamic color in JSX
  },
  settingDescription: {
    fontSize: 14,
    // color: Uses dynamic color in JSX
    marginTop: 2,
  },
  muted: {
    // color: Uses dynamic color in JSX
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
    fontStyle: 'italic',
  },

  // Footer Section
  footerSection: {
    alignItems: 'center',
    paddingTop: 12,
  },
  footerLink: {
    color: '#1B3A6B',
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  warningActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 16,
  },
  warningActionLink: {
    fontSize: 13,
  },
  error: {
    color: '#DC2626',
    marginTop: 12,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
  },

  // Review Modal
  reviewModalContainer: {
    flex: 1,
    // backgroundColor: Uses dynamic color in JSX
  },
  reviewModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    // borderBottomColor: Uses dynamic color in JSX
  },
  reviewModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  reviewModalBody: {
    padding: 20,
    gap: 20,
  },
  reviewMediaCard: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
  },
  reviewMedia: {
    width: '100%',
    height: 240,
  },
  reviewMediaLabel: {
    padding: 12,
    fontSize: 14,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
  },
  reviewTextCard: {
    borderRadius: 16,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    padding: 16,
  },
  reviewTextLabel: {
    fontSize: 13,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  reviewText: {
    fontSize: 15,
    // color: Uses dynamic color in JSX
    lineHeight: 22,
  },
  reviewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    gap: 12,
  },
  reviewEmptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  reviewEmptySubtitle: {
    fontSize: 14,
    // color: Uses dynamic color in JSX
    textAlign: 'center',
    lineHeight: 20,
  },

  // Event selection styles
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  changeEventButton: {
    color: '#1B3A6B',
    fontSize: 14,
    fontWeight: '600',
  },
  noEventCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    borderStyle: 'dashed',
  },
  noEventText: {
    // color: Uses dynamic color in JSX
    fontSize: 14,
    fontWeight: '500',
  },
  eventActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  removeEventButton: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
  },

  // Event selector modal
  modalContainer: {
    flex: 1,
    // backgroundColor: Uses dynamic color in JSX
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    // borderBottomColor: Uses dynamic color in JSX
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  modalBody: {
    padding: 16,
    gap: 12,
  },
  eventOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
  },
  eventOptionCardSelected: {
    borderColor: '#059669',
    backgroundColor: '#ECFDF5',
  },
  eventOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    // backgroundColor: Uses dynamic color in JSX
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventOptionBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F59E0B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  eventOptionTitle: {
    fontSize: 15,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
    marginBottom: 4,
  },
  eventOptionDate: {
    fontSize: 13,
    // color: Uses dynamic color in JSX
    marginBottom: 2,
  },
  eventOptionLocation: {
    fontSize: 12,
    // color: Uses dynamic color in JSX
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyStateTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.light.text,
  },
  emptyStateText: {
    fontSize: 14,
    color: Colors.light.mutedText,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Nearby games
  nearbyGamesHint: {
    fontSize: 13,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  nearbyGameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  gameMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  gameDistance: {
    fontSize: 12,
    fontWeight: '600',
  },
  viewMoreButton: {
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  viewMoreText: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Preview modal
  previewCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
  },
  previewLabel: {
    fontSize: 13,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  previewContent: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 12,
  },
  previewMediaContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 12,
    position: 'relative',
  },
  previewMediaFull: {
    width: '100%',
    minHeight: 300,
    backgroundColor: '#F3F4F6',
  },
  retakeButton: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 4,
  },
  retakeButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  previewEventBadge: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  previewEventText: {
    fontSize: 15,
    fontWeight: '600',
  },
  previewEventId: {
    fontSize: 13,
    marginTop: 4,
  },
  previewDestination: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 8,
  },
  previewDestinationText: {
    fontSize: 13,
    flex: 1,
  },
  previewPostActions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#D1D5DB',
  },
  previewActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  previewActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
  },
  previewButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    borderRadius: 12,
  },
  editButton: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  confirmButton: {
    backgroundColor: '#1B3A6B',
  },
  previewButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  previewTips: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
  },
  previewTipsTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
  },
  previewTipsText: {
    fontSize: 13,
    lineHeight: 20,
  },
  celebrationOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  celebrationContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  celebrationTitle: {
    color: '#FFD700',
    fontSize: 34,
    fontWeight: '900',
    marginTop: 20,
    letterSpacing: 1,
  },
  celebrationSubtitle: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 10,
  },
  confettiDot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  headerPostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1B3A6B',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 6px rgba(27, 58, 107, 0.3)' }
      : {
          shadowColor: '#1B3A6B',
          shadowOpacity: 0.3,
          shadowOffset: { width: 0, height: 2 },
          shadowRadius: 6,
        }),
    elevation: 4,
  },
  headerPostBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default CreatePostScreen;
