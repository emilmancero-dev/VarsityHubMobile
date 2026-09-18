import { toUserMessage } from '@/utils/toUserMessage';
import { persistPreparedMedia } from '@/utils/mediaDraftFiles';
import { cleanupConfirmedVideoDraft } from '@/utils/compressVideo';
import { launchMediaLibraryAsync, launchMediaCameraAsync } from '@/utils/pickMedia';
import {
  PostRecovery,
  recoveryForOwner,
  reusableUpload,
  newPostRequestId,
  assertCreatedPost,
  recoveryAfterPostRejection,
} from '@/utils/postRecovery';
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
import { Event, Game, Post } from '@/api/entities';
import settings from '@/api/settings';
import { uploadFile } from '@/api/upload';
import KeyboardAwareScreen from '@/components/KeyboardAwareScreen';
import { PromptPresets } from '@/components/RotatingPrompts';
import { MentionInput } from '@/components/ui/MentionInput';

import SwipeBackContainer from '@/components/SwipeBackContainer';
import VideoPlayer from '@/components/VideoPlayer';
import VideoTrimmer from '@/components/VideoTrimmer';
import { Colors } from '@/constants/Colors';
import { METALLIC_GRADIENTS } from '@/constants/metallic';
import { LinearGradient } from 'expo-linear-gradient';
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
import { removePrimaryPhoto, selectPhotoForPreview } from '@/utils/mediaSelection';
import { pickerAllMediaTypesProp, pickerMediaTypeFor } from '@/utils/picker';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
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
import { styles } from '@/styles/tabs/create-post.styles';

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
  const params = useLocalSearchParams<{ eventId?: string; gameId?: string; type?: string }>();
  const gameId = params?.gameId ? String(params.gameId) : undefined;
  const eventId = params?.eventId ? String(params.eventId) : undefined;
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
  // Additional images beyond the primary `picked` item (PDF commandments: "up
  // to 5 items per post" — batch-select from the photo library). Images only:
  // `picked` stays the single source of truth for video (its recovery/trim/
  // compress pipeline is unchanged). Max 4 extras + 1 primary = 5 total.
  const [extraPicked, setExtraPicked] = useState<Array<{ uri: string; mime: string }>>([]);
  const [mediaDimensions, setMediaDimensions] = useState<{ width: number; height: number } | null>(
    null
  );
  const [selectedGameId, setSelectedGameId] = useState<string | undefined>(
    postType === 'highlight' ? gameId : undefined
  );
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(
    postType === 'highlight' ? eventId : undefined
  );
  const [suggestedGame, setSuggestedGame] = useState<any>(null);
  const [nearbyGames, setNearbyGames] = useState<any[]>([]);
  const [rotatingPromptIndex, setRotatingPromptIndex] = useState(0);
  const [eventSelectorVisible, setEventSelectorVisible] = useState(false);
  const [hasAutoSuggested, setHasAutoSuggested] = useState(
    postType === 'highlight' && (!!gameId || !!eventId)
  ); // If an event/game param exists for highlights, don't auto-suggest
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
  // Snapshot of what was just posted, captured before the form resets, so the
  // success confirmation can show the media preview + the event it attached to
  // (owner note, Sep 2026: "confirmation page with a check mark… shows post
  // preview and the event it's attached to").
  const [successInfo, setSuccessInfo] = useState<{
    mediaUri?: string;
    mediaType?: 'image' | 'video';
    eventLabel?: string;
  } | null>(null);
  const [trimmedUri, setTrimmedUri] = useState<string | null>(null);
  const showPrecisionWarning =
    Platform.OS === 'android' &&
    permissionGranted &&
    needsPreciseAccuracy &&
    !precisionBannerDismissed;
  const locationReady =
    typeof location?.latitude === 'number' && typeof location?.longitude === 'number';
  const canTrimVideo = isNativeVideoTrimSupported(Platform.OS);

  // Dismiss the success confirmation: clear the just-posted snapshot, reset the
  // composer, and return to the feed. Shared by the confirmation's Done button
  // and the auto-dismiss fallback.
  const finishSuccess = useCallback(() => {
    setPostSuccess(false);
    setSuccessInfo(null);
    setContent('');
    setPicked(null);
    setExtraPicked([]);
    setError(null);
    safeGoBack(router, '/(tabs)/feed');
  }, [router]);

  const [draftReady, setDraftReady] = useState(false);
  const [contentConsent, setContentConsent] = useState(false);
  const recoveryRef = useRef<PostRecovery | null>(null);
  const submittingRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [savingPost, setSavingPost] = useState(false);
  useEffect(() => () => uploadAbortRef.current?.abort(), []);
  const currentOwnerRef = useRef(user?.id);
  currentOwnerRef.current = user?.id;
  const draftLoadedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/create');
      return;
    }
    if (!(user as any)?.email_verified) {
      // nav-safe: auth gate -> email verification
      router.replace('/verify-identity?method=email');
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
        setExtraPicked([]);
        setError(null);
        setSubmitting(false);
        setPreviewVisible(false);
        setSuggestedGame(null);
        setSelectedGameId(postType === 'highlight' ? gameId : undefined);
        setSelectedEventId(postType === 'highlight' ? eventId : undefined);
        setContentConsent(false);
        draftLoadedRef.current = false;
      }
    }, [postSuccess, eventId, gameId, postType])
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!user?.id || draftLoadedRef.current) return;
      const draft = await settings.getJson<any>(settings.SETTINGS_KEYS.POST_DRAFT, null);
      if (!active) return;
      draftLoadedRef.current = true;
      if (!draft || draft.ownerId !== user.id || (!draft.content && !draft?.picked?.uri)) {
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
            recoveryRef.current = recoveryForOwner(draft.recovery, user.id);
            setTrimmedUri(draft.trimmedUri || null);
            if (draft.picked?.uri) {
              setPicked({
                uri: String(draft.picked.uri),
                type: draft.picked.type === 'video' ? 'video' : 'image',
                mime: draft.picked.mime,
                width: draft.picked.width,
                height: draft.picked.height,
                durationS: draft.picked.durationS,
              });
            }
            if (draft.selectedGameId) {
              setSelectedGameId(String(draft.selectedGameId));
              setHasAutoSuggested(true);
            }
            if (draft.selectedEventId) {
              setSelectedEventId(String(draft.selectedEventId));
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
  }, [postType, user?.id]);

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
    if (!draftReady || postSuccess) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(async () => {
      if (submitting) return;
      const hasContent = Boolean(content.trim() || picked?.uri);
      if (!hasContent) {
        await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, null);
        return;
      }
      const draft = {
        ownerId: user?.id,
        recovery: recoveryForOwner(recoveryRef.current, user?.id),
        trimmedUri,
        content: content,
        picked,
        selectedGameId: selectedGameId || null,
        selectedEventId: selectedEventId || null,
        postType,
        updated_at: new Date().toISOString(),
      };
      await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, draft);
    }, 600);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [
    content,
    picked,
    selectedGameId,
    selectedEventId,
    postType,
    submitting,
    draftReady,
    postSuccess,
    trimmedUri,
    user?.id,
  ]);

  // Request location permission before event uploads. Event-page posts require
  // device-origin GPS server-side; asking only after media selection can waste
  // an upload and make the final create step look broken.
  useEffect(() => {
    const shouldRequestForSelectedEvent = Boolean(gameId) || Boolean(eventId);
    const shouldRequestForSuggestions = !hasAutoSuggested && !gameId && !eventId;
    if (
      permissionGranted === false &&
      (shouldRequestForSelectedEvent || shouldRequestForSuggestions)
    ) {
      requestPermission().catch(() => {
        setLocationError(
          "Unable to access device location. You can still post, but event suggestions won't be available."
        );
      });
    }
  }, [permissionGranted, hasAutoSuggested, eventId, gameId, postType, requestPermission]);

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
          setSelectedEventId(game.event_id ? String(game.event_id) : eventId);
          setError(null); // Clear any previous errors
        }
      } catch (error) {
        if (__DEV__) console.warn('Failed to load game from params:', error);
        // If game not found (404), clear the selectedGameId so user can still post
        if ((error as any)?.status === 404) {
          setSelectedGameId(undefined);
          setSelectedEventId(eventId);
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
  }, [eventId, gameId]);

  // Load event details if eventId is provided without a gameId (standalone event page)
  useEffect(() => {
    if (__DEV__) console.warn('[CreatePost] useEffect eventId:', eventId);
    if (!eventId || gameId) return;

    void (async () => {
      try {
        const event = await Event.get(eventId);
        if (event) {
          setSuggestedGame(event);
          setSelectedEventId(String(event.id));
          setSelectedGameId(event.game_id ? String(event.game_id) : undefined);
          setError(null);
        }
      } catch (error) {
        if (__DEV__) console.warn('Failed to load event from params:', error);
        if ((error as any)?.status === 404) {
          setSelectedEventId(undefined);
          setSuggestedGame(null);
        } else {
          setSelectedEventId(eventId);
        }
      }
    })();
  }, [eventId, gameId]);

  // Auto-suggest nearest event ONLY for highlights. Regular posts attach to an
  // event only when launched from an event page or when the user explicitly
  // chooses one.
  useEffect(() => {
    if (postType !== 'highlight') return;
    if (selectedGameId || selectedEventId || hasAutoSuggested) return;

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
          setSelectedEventId(top.event_id ? String(top.event_id) : undefined);
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
    selectedEventId,
    hasAutoSuggested,
    location?.latitude,
    location?.longitude,
  ]);

  const pickFromLibraryRaw = async (media: 'image' | 'video') => {
    try {
      // Request photo-library access before launching. The camera path and
      // edit-profile already do this; this picker did not, so a device with
      // denied/limited Photos access failed with the generic "Failed to select
      // media" error instead of a clear prompt. ('limited' reports granted.)
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(
          'Photos permission needed',
          'Allow VarsityHub access to your photos in Settings to add media to your post.'
        );
        return;
      }
      if (media === 'video') setPickPreparing('Preparing video…');
      const r = await launchMediaLibraryAsync({
        ...pickerMediaTypeFor(media),
        allowsEditing: false, // Don't crop - preserve original photo
        quality: media === 'image' ? 1 : undefined,
        exif: false,
        videoExportPreset: VIDEO_CAPTURE_PRESET,
        // Batch photo selection (PDF commandments: "up to 5 items per post" —
        // "allow them to select multiple when they are in the photo library").
        // Video stays single-select — its trim/compress/recovery pipeline is
        // built around exactly one item.
        ...(media === 'image' ? { allowsMultipleSelection: true, selectionLimit: 5 } : {}),
      } as any);
      if (!r.canceled && r.assets && r.assets[0]) {
        const rawAssets = media === 'image' ? r.assets.slice(0, 5) : [r.assets[0]];
        const prepared: Array<{ uri: string; mime: string; durationS?: number }> = [];
        for (const rawAsset of rawAssets) {
          const a = {
            ...rawAsset,
            uri: await persistPreparedMedia(await materializeICloudAssetIfNeeded(rawAsset.uri)),
          };

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

          // The upload boundary prepares photos once and owns the resulting
          // MIME metadata. Keep original bytes here for previews and editing.
          const uri = a.uri;
          prepared.push({
            uri,
            mime: mimeType,
            durationS: typeof a.duration === 'number' ? a.duration / 1000 : undefined,
          });
        }

        const [primary, ...extras] = prepared;
        setPicked({
          uri: primary.uri,
          type: media,
          mime: primary.mime,
          durationS: primary.durationS,
        });
        setExtraPicked(extras.map(e => ({ uri: e.uri, mime: e.mime })));
      }
    } catch (error: any) {
      if (__DEV__) console.error('[CreatePost] Image picker error:', error);
      // v1.0.2 audit fix: use shared iCloud detection (matches BannerUpload patterns)
      if (isICloudError(error)) {
        Alert.alert(ICLOUD_ERROR_TITLE, ICLOUD_ERROR_MESSAGE);
      } else if (error?.code === 'MEDIA_PICKER_UPDATE_REQUIRED') {
        // Video selection needs the VarsityMediaPicker native module, which only
        // ships in a new binary (not OTA). An older installed build hits this —
        // tell the user to update rather than showing a generic failure.
        Alert.alert(
          'Update required',
          'Video selection requires the latest app build. Please update VarsityHub and try again.'
        );
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
      const r = await launchMediaCameraAsync({
        ...pickerAllMediaTypesProp(),
        allowsEditing: false,
        quality: 1,
        exif: false,
        videoExportPreset: VIDEO_CAPTURE_PRESET,
        // Stops video recording at the cap; ignored for photos.
        videoMaxDuration: POST_MAX_DURATION_S,
        legacy: false,
      } as any);
      if (!r.canceled && r.assets && r.assets[0]) {
        const a = {
          ...r.assets[0],
          uri: await persistPreparedMedia(await materializeICloudAssetIfNeeded(r.assets[0].uri)),
        };

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

        const uri = a.uri;
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
  const selectedEventIds = useMemo(
    () => [selectedEventId, suggestedGame?.event_id, selectedGameId].filter(Boolean) as string[],
    [selectedEventId, suggestedGame?.event_id, selectedGameId]
  );
  const hasSelectedEvent = selectedEventIds.length > 0;

  // First-post-unlocks-7-days (owner rule 2026-07-15): once this user posted
  // to the selected event page, the client preflight must not re-block them —
  // the server admits unlocked users without location. UX-only; server is law.
  const [hasPostingUnlock, setHasPostingUnlock] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (selectedEventIds.length === 0) {
      setHasPostingUnlock(false);
      return;
    }
    void hasLocalEventPostingUnlock(selectedEventIds).then(unlocked => {
      if (!cancelled) setHasPostingUnlock(unlocked);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEventIds]);

  // Proactive geofence + time window check when a game is selected
  const geofenceWarning = useMemo(() => {
    if (!suggestedGame || !hasSelectedEvent) return null;
    // Seeded demo matchups (Duke v UNC, Cavs v Warriors) skip the client
    // warning — server's [DEMO_MATCHUP] carve-out already bypasses geofence
    // and posting-window checks for these Game rows only.
    if (isDemoMatchupGame) return null;
    // Already posted here within the last week — the server won't re-geofence,
    // so don't warn.
    if (hasPostingUnlock) return null;
    // Posting window (server rule in server/src/lib/geofencing.ts): the
    // standard shape is 2h before start, 4h during, 2h after (owner rule
    // 2026-09-14). The server ships the computed bounds on the payload
    // (starts_at/live_from/live_until).
    const bounds = getLiveBounds(suggestedGame);
    if (!bounds) return null;

    const now = Date.now();
    if (now > bounds.liveUntil) {
      return 'This event has ended. If you posted here while it was live you can keep posting for a week from anywhere.';
    }
    if (now < bounds.liveFrom) {
      return 'Posting for this event opens 2 hours before it starts.';
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
    hasSelectedEvent,
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
    if (!(user as any)?.email_verified) {
      // nav-safe: auth gate -> email verification
      router.replace('/verify-identity?method=email');
      return;
    }

    if (recoveryForOwner(recoveryRef.current, user?.id)?.pendingPayload) {
      void doConfirmPost();
      return;
    }
    if (__DEV__) console.warn('[CreatePost] confirmPost called');
    if (__DEV__)
      console.warn(
        '[CreatePost] State - selectedGameId:',
        selectedGameId,
        '| selectedEventId:',
        selectedEventId,
        '| suggestedGame:',
        suggestedGame?.id
      );

    // Proactive geofence check: if posting to a real event and location is not available, prompt first.
    // Seeded demo matchups bypass the location gate — server carve-out accepts uploads without coords.
    const isRealGame = hasSelectedEvent;
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
    if (submittingRef.current) return;
    const hadPendingPayload = Boolean(
      recoveryForOwner(recoveryRef.current, user?.id)?.pendingPayload
    );
    // 90s highlight cap: an over-limit pick must go through the trimmer (which
    // clamps its window to the cap) before it can post. Trimmed output is
    // capped by construction, so only the untrimmed original needs checking.
    if (
      !recoveryForOwner(recoveryRef.current, user?.id)?.pendingPayload &&
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
    submittingRef.current = true;
    const uploadController = new AbortController();
    uploadAbortRef.current = uploadController;
    setSavingPost(false);
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
      const ownerId = user!.id;
      const source = picked?.type === 'video' && trimmedUri ? trimmedUri : picked?.uri;
      const savedUpload = source ? reusableUpload(recoveryRef.current, ownerId, source) : null;
      const persistRecovery = async (recovery: PostRecovery) => {
        if (currentOwnerRef.current !== ownerId)
          throw new Error('Your account changed. Please reopen the composer.');
        await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, {
          ownerId,
          content,
          picked,
          trimmedUri,
          selectedGameId,
          selectedEventId,
          postType,
          recovery,
        });
        const persisted = await settings.getJson<any>(settings.SETTINGS_KEYS.POST_DRAFT, null);
        if (currentOwnerRef.current !== ownerId)
          throw new Error('Your account changed. Please reopen the composer.');
        if (
          persisted?.ownerId !== ownerId ||
          JSON.stringify(persisted?.recovery) !== JSON.stringify(recovery)
        ) {
          throw new Error(
            'Could not save upload recovery. Free some device storage and try again.'
          );
        }
        recoveryRef.current = recovery;
      };
      await persistRecovery(recoveryForOwner(recoveryRef.current, ownerId) || { ownerId });
      if (savedUpload) {
        finalMediaUrl = savedUpload.url;
        finalPosterUrl = savedUpload.posterUrl || '';
        Object.assign(mediaMeta, savedUpload.meta);
      }
      if (
        picked?.uri &&
        !savedUpload &&
        !recoveryForOwner(recoveryRef.current, ownerId)?.pendingPayload
      ) {
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
          signal: uploadController.signal,
          onPhase: phase => {
            if (phase === 'processing') setMediaPhase('finalizing');
          },
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
        finalPosterUrl = (res as any)?.poster_url || '';
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
        await persistRecovery({
          ownerId,
          sourceUri: source,
          upload: { url: finalMediaUrl, posterUrl: finalPosterUrl, meta: mediaMeta },
        });
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
                const posterRes = await uploadFile(base, thumb.uri, 'poster.jpg', 'image/jpeg', {
                  signal: uploadController.signal,
                });
                finalPosterUrl = posterRes?.url || '';
                if (__DEV__) console.warn('[CreatePost] Poster uploaded:', finalPosterUrl);
              }
            }
          } catch (posterErr: any) {
            if (__DEV__) console.warn('[CreatePost] Poster generation failed:', posterErr?.message);
          }
        }
        await persistRecovery({
          ownerId,
          sourceUri: source,
          upload: { url: finalMediaUrl, posterUrl: finalPosterUrl, meta: mediaMeta },
        });
      }

      // Batch photos (PDF commandments: "up to 5 items per post"). These are
      // NOT part of the resumable-recovery state above — a rare crash/retry
      // mid-submit re-uses the recovered primary item but not extras, which
      // is an acceptable corner case (the primary succeeded; extras are cheap
      // to re-pick). All-or-nothing: any failed extra fails the whole submit,
      // matching how a failed primary upload behaves.
      const extraMediaUrls: string[] = [];
      if (extraPicked.length > 0 && finalMediaUrl) {
        const { getApiBaseUrl } = await import('@/api/http');
        const base = getApiBaseUrl();
        for (const extra of extraPicked) {
          const extraRes = await uploadFile(base, extra.uri, 'image.jpg', extra.mime, {
            signal: uploadController.signal,
          });
          if (!extraRes?.url) {
            throw new Error('One of the additional photos failed to upload. Please try again.');
          }
          extraMediaUrls.push(extraRes.url);
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
        ...(extraMediaUrls.length ? { media_urls: [finalMediaUrl, ...extraMediaUrls] } : {}),
        type: postType,
        location: locationPayload,
      };

      if (selectedGameId) {
        payload.game_id = selectedGameId;
      }
      if (selectedEventId) {
        payload.event_id = selectedEventId;
      }

      if (__DEV__)
        console.warn('[CreatePost] Final payload keys:', Object.keys(payload).join(', '));

      // Require event link for highlight posts to ensure they surface on the event page
      if (
        !recoveryForOwner(recoveryRef.current, ownerId)?.pendingPayload &&
        postType === 'highlight' &&
        !payload.game_id &&
        !payload.event_id
      ) {
        throw new Error('Please attach an event to share a highlight.');
      }

      if (__DEV__) console.warn('[CreatePost] Calling Post.create...');
      if (uploadController.signal.aborted)
        throw new Error('Upload paused. Your draft is saved; retry when ready.');
      setSavingPost(true);
      const pendingPayload = recoveryForOwner(recoveryRef.current, ownerId)?.pendingPayload || {
        ...payload,
        client_request_id: newPostRequestId(),
      };
      await persistRecovery({
        ...recoveryForOwner(recoveryRef.current, ownerId),
        ownerId,
        pendingPayload,
      });
      if (currentOwnerRef.current !== ownerId)
        throw new Error('Your account changed. Please reopen the composer.');
      try {
        assertCreatedPost(await Post.create(pendingPayload));
      } catch (error) {
        const editableRecovery =
          currentOwnerRef.current === ownerId
            ? recoveryAfterPostRejection(
                recoveryForOwner(recoveryRef.current, ownerId),
                error,
                !hadPendingPayload
              )
            : null;
        if (editableRecovery) await persistRecovery(editableRecovery);
        throw error;
      }
      for (const source of [picked?.uri, trimmedUri]) {
        if (source)
          void cleanupConfirmedVideoDraft(source).catch(error => {
            if (__DEV__) console.warn('[CreatePost] Confirmed media cleanup failed:', error);
          });
      }
      recoveryRef.current = null;
      clearPostCache();
      if (__DEV__) console.warn('[CreatePost] Post created successfully!');
      if (selectedEventIds.length > 0) {
        // Mirror the server's posting unlock locally so preflight prompts
        // don't re-block this user on their next upload to this event page.
        void recordEventPostingUnlock(selectedEventIds);
      }
      analytics.track(ANALYTICS_EVENTS.POST_CREATED, { type: picked?.type || 'text' });
      try {
        await settings.setJson(settings.SETTINGS_KEYS.POST_DRAFT, null);
      } catch (error) {
        // Non-critical: draft clearing failed, but post was created successfully
        if (__DEV__) console.warn('[CreatePost] Failed to clear draft:', error);
      }

      setPreviewVisible(false);

      // Capture what was just posted BEFORE the form resets, so the success
      // confirmation can show the media preview and the attached event.
      const postedEventLabel = suggestedGame
        ? suggestedGame.title ||
          [suggestedGame.home_team, suggestedGame.away_team].filter(Boolean).join(' vs ')
        : undefined;
      setSuccessInfo({
        mediaUri: trimmedUri ?? picked?.uri,
        mediaType: picked?.type,
        eventLabel: postedEventLabel || undefined,
      });
      setPostSuccess(true);

      // Safety net so the confirmation is never a dead end — the user can also
      // dismiss it immediately with Done.
      setTimeout(finishSuccess, 3500);

      // Owner rule (2026-07-16): remind attendees to keep event posts on-topic,
      // but only on their FIRST post to a given event page. The server already
      // proved they were there — it accepted the post — so this is a reminder,
      // not a gate. Seen-state is per (user, event); a fan posting thirteen
      // times reads it once. Shown over the confirmation; dismissing it leaves
      // the confirmation visible.
      const showNotice =
        selectedEventIds.length > 0 &&
        (await shouldShowEventPostingNotice(user?.id, selectedEventIds));

      if (showNotice) {
        void markEventPostingNoticeSeen(user?.id, selectedEventIds);
        Alert.alert(
          '🏟️ Keep it to the game',
          'Please only post photos and videos from the game. Anything unrelated may result in your post being taken down.',
          [{ text: 'Got it' }]
        );
      }
    } catch (e: any) {
      if (uploadController.signal.aborted && !recoveryRef.current?.pendingPayload) {
        setError('Upload paused. Your draft is saved; retry when ready.');
        return;
      }
      if (__DEV__)
        console.error('[CreatePost] Error creating post:', {
          message: e?.message,
          status: e?.status,
          data: e?.data,
          selectedGameId,
          selectedEventId,
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
        setError('Please check your post and try again.');
      } else {
        // Provide more helpful error messages
        if (e?.status === 404 && hasSelectedEvent) {
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
            const msg = toUserMessage(e, 'Posting is not open for this event.');
            Alert.alert('Posting Closed', msg);
            setError(msg);
          } else if (code === 'TOO_FAR_FROM_VENUE') {
            const dist = e?.data?.distance;
            const msg = toUserMessage(e, 'You must be within 3 km of the venue to post.');
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
            const msg = toUserMessage(e, 'You do not have permission to post to this event.');
            Alert.alert('Cannot Post', msg);
            setError(msg);
          }
        } else {
          setError(
            e?.status === 429
              ? 'You have hit the hourly upload limit. Wait a few minutes and try again.'
              : toUserMessage(e, 'Failed to create post. Please try again.')
          );
        }
      }
    } finally {
      submittingRef.current = false;
      uploadAbortRef.current = null;
      setSavingPost(false);
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

  // Hard guard: never render the composer until auth is known. The useEffect
  // above redirects guests/unverified users, but it runs after render; showing
  // a real state here avoids a blank upload page during that handoff.
  if (authLoading || !user || !(user as any)?.email_verified) {
    const message = authLoading
      ? 'Loading upload...'
      : !user
        ? 'Opening sign in...'
        : 'Opening verification...';
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.authGateState}>
          <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
          <Text style={[styles.authGateText, { color: Colors[colorScheme].mutedText }]}>
            {message}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Disable the left-edge swipe-back while a trimmable video is loaded: the
  // trimmer's left handle sits inside the 40px edge zone, so an edge-swipe would
  // hijack the trim drag and navigate back instead (owner note, Sep 2026).
  const trimmerActive = picked?.type === 'video' && canTrimVideo;

  return (
    <SwipeBackContainer enabled={!trimmerActive}>
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen options={{ headerShown: false }} />

        {/* Success confirmation — check mark, a preview of what was posted, and
            the event it attached to (owner note, Sep 2026). */}
        {postSuccess && successInfo && (
          <View
            style={[styles.successOverlay, { backgroundColor: Colors[colorScheme].background }]}
          >
            <View style={styles.successCheckCircle}>
              <Ionicons name="checkmark" size={44} color="#FFFFFF" />
            </View>
            <Text style={[styles.successTitle, { color: Colors[colorScheme].text }]}>
              {postType === 'highlight' ? 'Highlight shared!' : 'Posted!'}
            </Text>
            {successInfo.mediaUri ? (
              successInfo.mediaType === 'video' ? (
                <View style={[styles.successPreview, styles.successVideoPreview]}>
                  <Ionicons name="videocam" size={32} color="#FFFFFF" />
                </View>
              ) : (
                <RNImage
                  source={{ uri: successInfo.mediaUri }}
                  style={styles.successPreview}
                  resizeMode="cover"
                />
              )
            ) : null}
            {successInfo.eventLabel ? (
              <View style={styles.successEventRow}>
                <Ionicons name="calendar-outline" size={16} color={Colors[colorScheme].mutedText} />
                <Text
                  style={[styles.successEventText, { color: Colors[colorScheme].mutedText }]}
                  numberOfLines={1}
                >
                  {successInfo.eventLabel}
                </Text>
              </View>
            ) : null}
            <Pressable
              testID="create-post-success-done"
              onPress={finishSuccess}
              style={[styles.successDoneButton, { backgroundColor: Colors[colorScheme].tint }]}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={styles.successDoneText}>Done</Text>
            </Pressable>
          </View>
        )}

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
            {content.length > 800 ? (
              <Text
                testID="create-post-long-content-warning"
                style={[styles.helper, { color: '#B8860B' }]}
              >
                {content.length}/4000 — posts over 800 characters may be truncated in some views.
              </Text>
            ) : null}
          </View>

          {/* Media Actions */}
          <View style={styles.mediaSection}>
            <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
              Add Media
            </Text>
            <View style={styles.tilesRow}>
              <Pressable
                testID="create-post-photo-picker"
                style={styles.tileShadowWrap}
                onPress={() => pickFromLibrary('image')}
                accessibilityLabel="Photo Gallery"
              >
                <LinearGradient
                  colors={METALLIC_GRADIENTS.bronze.colors}
                  locations={METALLIC_GRADIENTS.bronze.locations}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={styles.tileGradient}
                >
                  <Ionicons name="image-outline" size={24} color="#FFFFFF" />
                  <Text style={[styles.tileLabel, styles.lightTileLabel]}>Photo</Text>
                </LinearGradient>
              </Pressable>
              <Pressable
                testID="create-post-camera-picker"
                style={styles.tileShadowWrap}
                onPress={() => captureWithCamera()}
                accessibilityLabel="Camera"
              >
                <LinearGradient
                  colors={METALLIC_GRADIENTS.silver.colors}
                  locations={METALLIC_GRADIENTS.silver.locations}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={styles.tileGradient}
                >
                  <Ionicons name="camera-outline" size={24} color="#1B2430" />
                  <Text style={[styles.tileLabel, styles.darkTileLabel]}>Camera</Text>
                </LinearGradient>
              </Pressable>
              <Pressable
                testID="create-post-video-picker"
                style={styles.tileShadowWrap}
                onPress={() => pickFromLibrary('video')}
                accessibilityLabel="Video Gallery"
              >
                <LinearGradient
                  colors={METALLIC_GRADIENTS.gold.colors}
                  locations={METALLIC_GRADIENTS.gold.locations}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={styles.tileGradient}
                >
                  <Ionicons name="videocam-outline" size={24} color="#1B2430" />
                  <Text style={[styles.tileLabel, styles.darkTileLabel]}>Video</Text>
                </LinearGradient>
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
                        onTrimComplete={u => {
                          void persistPreparedMedia(u)
                            .then(setTrimmedUri)
                            .catch(error => {
                              Alert.alert(
                                'Could not save trim',
                                toUserMessage(error, 'Please trim the video again.')
                              );
                            });
                        }}
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
                  onPress={() => {
                    if (picked.type === 'image') {
                      const next = removePrimaryPhoto(picked, extraPicked);
                      setPicked(next.primary);
                      setExtraPicked(next.extras);
                    } else {
                      setPicked(null);
                      setExtraPicked([]);
                    }
                  }}
                  accessibilityLabel="Remove media"
                >
                  <Ionicons name="close" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
              {/* Batch photo strip (PDF commandments: "up to 5 items per post") —
                  images only; primary item above is item 1 of up to 5. */}
              {picked.type === 'image' && extraPicked.length > 0 ? (
                <View style={styles.extraPhotoStrip} testID="create-post-extra-photo-strip">
                  {extraPicked.map((item, index) => (
                    <Pressable
                      key={item.uri}
                      style={styles.extraPhotoThumbWrap}
                      accessibilityLabel={`Preview photo ${index + 2}`}
                      onPress={() => {
                        const next = selectPhotoForPreview(picked, extraPicked, index);
                        setPicked(next.primary);
                        setExtraPicked(next.extras);
                      }}
                    >
                      <RNImage source={{ uri: item.uri }} style={styles.extraPhotoThumb} />
                      <Pressable
                        style={styles.extraPhotoRemove}
                        accessibilityLabel={`Remove photo ${index + 2}`}
                        onPress={() => setExtraPicked(prev => prev.filter((_, i) => i !== index))}
                      >
                        <Ionicons name="close" size={12} color="#FFFFFF" />
                      </Pressable>
                    </Pressable>
                  ))}
                </View>
              ) : null}
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
                    setSelectedEventId(game.event_id ? String(game.event_id) : undefined);
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
          {suggestedGame && hasSelectedEvent && (
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
                  setSelectedEventId(undefined);
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
                        setSelectedEventId(game.event_id ? String(game.event_id) : undefined);
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
                        setExtraPicked([]);
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
                {previewData?.game && hasSelectedEvent && (
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
                    {previewData?.game && hasSelectedEvent
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

              {submitting && !savingPost && (
                <Pressable
                  onPress={() => uploadAbortRef.current?.abort()}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel upload"
                  style={{ padding: 12, alignItems: 'center' }}
                >
                  <Text style={{ color: Colors[colorScheme].text }}>Cancel upload</Text>
                </Pressable>
              )}
              {submitting && savingPost && (
                <Text style={{ color: Colors[colorScheme].mutedText, textAlign: 'center' }}>
                  Saving your post. If the connection drops, retry to recover it.
                </Text>
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
                  disabled={submitting}
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

export default CreatePostScreen;
