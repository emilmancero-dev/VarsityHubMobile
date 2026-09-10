/**
 * Banner Spec Upload Component
 *
 * Handles banner/logo upload for advertisements with preview and fit options
 * Supports fill transformation with pan/zoom
 */

import { uploadFile } from '@/api/upload';
import { Colors } from '@/constants/Colors';
import { MAX_IMAGE_SIZE_BYTES } from '@/constants/video';
import { useColorScheme } from '@/hooks/useColorScheme';
import { ensureUploadableUri } from '@/utils/ensureUploadableUri';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { pickerMediaTypesProp } from '@/utils/picker';
import { captureBreadcrumb } from '@/utils/sentry';
import { showUploadErrorAlert } from '@/utils/uploadErrorAlert';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type BannerFitMode = 'fill' | 'stretch';
type BannerFitValue = BannerFitMode;

type BannerPosition = { x: number; y: number }; // percent 0-100

interface BannerUploadProps {
  value?: string; // Current banner URL
  onChange: (uri: string, fitMode: BannerFitValue, position?: BannerPosition) => void;
  aspectRatio?: number; // Target aspect ratio (width/height), e.g., 16/9
  maxWidth?: number; // Max width for preview
  required?: boolean;
  onScrollLock?: (locked: boolean) => void;
  uploadFormFields?: Record<string, string | number | boolean | null | undefined>;
}

export function BannerUpload({
  value,
  onChange,
  aspectRatio = 16 / 9, // Default 16:9 banner
  maxWidth = 400,
  required = false,
  onScrollLock,
  uploadFormFields,
}: BannerUploadProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [fitMode, setFitMode] = useState<BannerFitMode>('fill');
  const [uploading, setUploading] = useState(false);
  const [position, setPosition] = useState<BannerPosition>({ x: 50, y: 50 });
  const [scale, setScale] = useState(1);
  const containerSize = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const panStart = useRef<BannerPosition>({ x: 50, y: 50 });
  const initialDistance = useRef(0);
  const initialScale = useRef(1);
  const [showHint, setShowHint] = useState(false);
  const hintOpacity = useRef(new Animated.Value(0)).current;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const getFitValue = (mode: BannerFitMode): BannerFitValue => mode;
  const extensionForMime = (mime: string) => {
    if (mime === 'image/png') return 'png';
    return 'jpg';
  };

  const handlePickImage = async () => {
    setUploading(true);
    try {
      // Request permissions
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'Please grant photo library access to upload banner images.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        );
        setUploading(false);
        return;
      }

      // Launch picker
      // v1.0.2: allowsMultipleSelection:false + exif:false encourages iOS to
      // hand us a proper local file (not a ph:// cloud reference). On iCloud-optimized
      // devices the first read may still fail — the catch below handles that gracefully.
      const result = await ImagePicker.launchImageLibraryAsync({
        ...pickerMediaTypesProp(),
        allowsEditing: false, // Allow full image without cropping
        allowsMultipleSelection: false,
        quality: 1,
        exif: false,
        base64: false,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];

        const assetMimeType =
          typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/')
            ? asset.mimeType
            : null;

        // Detect if original is PNG to preserve transparency
        const originalName = (asset.fileName || asset.uri || '').toLowerCase();
        const isPng = assetMimeType === 'image/png' || originalName.endsWith('.png');
        const saveFormat = isPng
          ? ImageManipulator.SaveFormat.PNG
          : ImageManipulator.SaveFormat.JPEG;

        // v1.0.2: force iCloud download if ph:// URI before any manipulation
        const materializedUri = await materializeICloudAssetIfNeeded(asset.uri);

        // Resize/compress image before size validation
        let processedUri = materializedUri;
        try {
          const manipulated = await ImageManipulator.manipulateAsync(
            materializedUri,
            [{ resize: { width: 1920 } }],
            { compress: isPng ? 1 : 0.8, format: saveFormat }
          );
          processedUri = manipulated.uri;
          captureBreadcrumb('ImageManipulator.manipulateAsync:ok', 'BannerUpload');
        } catch (error: any) {
          if (__DEV__)
            console.warn(
              '[BannerUpload] Image manipulation failed, using original:',
              error?.message || error
            );
          captureBreadcrumb('ImageManipulator.manipulateAsync:fallback', 'BannerUpload', {
            reason: String(error?.message || error),
          });
          // Continue with original URI if manipulation fails
        }

        // Validate image size (max 10MB)
        let fileSize: number | undefined =
          typeof (asset as any).fileSize === 'number' ? (asset as any).fileSize : undefined;
        captureBreadcrumb('blobSize:start', 'BannerUpload');
        try {
          if (!fileSize) {
            const response = await fetch(processedUri);
            const blob = await response.blob();
            fileSize = blob.size;
            captureBreadcrumb('blobSize:ok', 'BannerUpload', { fileSize });
          }
        } catch (e: any) {
          captureBreadcrumb('blobSize:fallback', 'BannerUpload', {
            reason: String(e?.message || e),
          });
          // Continue upload without size validation
        }

        if (fileSize && fileSize > MAX_IMAGE_SIZE_BYTES) {
          Alert.alert(
            'File Too Large',
            'Banner images must be under 10MB. Accepted formats: JPEG, PNG.'
          );
          setUploading(false);
          return;
        }

        // Reset scale when new image is selected
        setScale(1);
        setPosition({ x: 50, y: 50 });

        const mimeType = isPng ? 'image/png' : assetMimeType || 'image/jpeg';
        const ext = extensionForMime(mimeType);
        const rawBaseName = (asset.fileName || asset.uri.split('/').pop() || `banner_${Date.now()}`)
          .replace(/\.[^.]+$/, '')
          .replace(/[^\w.-]+/g, '_');
        const fileName = `${rawBaseName}.${ext}`;
        captureBreadcrumb('ensureUploadableUri:start', 'BannerUpload', {
          mimeType,
          platform: Platform.OS,
        });
        const uploadSource =
          Platform.OS === 'web'
            ? { uri: processedUri, mimeType }
            : await ensureUploadableUri(processedUri, mimeType);
        captureBreadcrumb('ensureUploadableUri:ok', 'BannerUpload');

        let uploaded;
        captureBreadcrumb('uploadFile:start', 'BannerUpload', {
          mimeType: uploadSource.mimeType,
          filename: fileName,
        });
        try {
          uploaded = await uploadFile(null, uploadSource.uri, fileName, uploadSource.mimeType, {
            formFields: uploadFormFields,
          });
        } catch (uploadError: any) {
          // v1.0.3: re-throw the original error (preserves status, isSessionExpired,
          // etc.) so showUploadErrorAlert can classify it correctly. Previously we
          // wrapped it in a new Error, which stripped the flags and fell through to
          // the useless "Image Error — Something went wrong" fallback.
          throw uploadError;
        }
        const uploadedUrl = uploaded?.url || uploaded?.signed_url || uploaded?.path;
        if (!uploadedUrl) {
          throw new Error('Upload succeeded but no URL was returned.');
        }
        captureBreadcrumb('uploadFile:ok', 'BannerUpload');

        onChange(String(uploadedUrl), getFitValue(fitMode), { x: 50, y: 50 });
      }
    } catch (error: any) {
      showUploadErrorAlert(error, {
        fallbackTitle: 'Image Error',
        fallbackMessage:
          'Something went wrong loading this image. Please try a different photo or take a new one.',
        logTag: 'BannerUpload',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = () => {
    Alert.alert('Remove Banner', 'Are you sure you want to remove this banner?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => onChange('', getFitValue(fitMode), position),
      },
    ]);
  };

  const _handleFitModeChange = (newMode: BannerFitMode) => {
    setFitMode(newMode);
    if (value) {
      onChange(value, getFitValue(newMode), newMode === 'fill' ? position : { x: 50, y: 50 });
    }
  };

  const getContentFit = (): 'contain' | 'cover' => {
    return 'cover'; // Fills container, may crop
  };

  // Quick, minimal hint when Fill or Rotate mode is active
  useEffect(() => {
    if (value && fitMode === 'fill') {
      setShowHint(true);
      hintOpacity.setValue(0);
      Animated.sequence([
        Animated.timing(hintOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1200),
        Animated.timing(hintOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(() => setShowHint(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, fitMode]);

  useEffect(() => {
    return () => {
      onScrollLock?.(false);
    };
  }, [onScrollLock]);

  // Calculate distance between two touches for pinch gesture
  const getDistance = (touch1: any, touch2: any): number => {
    if (!touch1 || !touch2) return 0;
    const dx = touch2.locationX - touch1.locationX;
    const dy = touch2.locationY - touch1.locationY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  return (
    <View style={styles.container}>
      {/* Upload/Preview Area */}
      <View
        style={[
          styles.previewContainer,
          {
            aspectRatio,
            maxWidth,
            backgroundColor: Colors[colorScheme].surface,
            borderColor: Colors[colorScheme].border,
          },
        ]}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          containerSize.current = { width, height };
        }}
      >
        {value ? (
          <>
            <Image
              source={{ uri: optimizeImageUrl(value, 1200) }}
              style={[
                styles.previewImage,
                fitMode === 'fill' && {
                  transform: [{ scale }],
                },
              ]}
              contentFit={getContentFit()}
              contentPosition={
                fitMode === 'fill'
                  ? { left: `${Math.round(position.x)}%`, top: `${Math.round(position.y)}%` }
                  : 'center'
              }
            />
            {/* Visual nudge hint */}
            {showHint && (
              <Animated.View
                style={[styles.hintPill, { opacity: hintOpacity, pointerEvents: 'none' }]}
              >
                <MaterialIcons name="aspect-ratio" size={16} color={theme.text} />
                <Text style={[styles.hintText, { color: theme.text }]}>Pinch to crop</Text>
              </Animated.View>
            )}
            {/* Gesture overlay for Fill mode */}
            {fitMode === 'fill' && (
              <View
                style={StyleSheet.absoluteFill}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={e => {
                  onScrollLock?.(true);
                  panStart.current = { ...position };
                  initialScale.current = scale;
                  const touches = Array.from(e.nativeEvent.touches);
                  if (touches.length >= 2) {
                    initialDistance.current = getDistance(touches[0], touches[1]);
                  }
                  // Store initial touch position for delta-based panning
                  if (touches.length === 1) {
                    (panStart.current as any)._startX = touches[0].locationX;
                    (panStart.current as any)._startY = touches[0].locationY;
                  }
                }}
                onResponderMove={e => {
                  const touches = Array.from(e.nativeEvent.touches);
                  const { width, height } = containerSize.current;

                  if (touches.length >= 2) {
                    const currentDistance = getDistance(touches[0], touches[1]);

                    if (initialDistance.current === 0) {
                      initialDistance.current = currentDistance;
                      initialScale.current = scale;
                    }

                    const rawRatio = currentDistance / initialDistance.current;
                    const dampenedRatio = 1 + (rawRatio - 1) * 0.4;
                    const newScale = clamp(dampenedRatio * initialScale.current, 1, 3);
                    setScale(newScale);
                  } else if (touches.length === 1) {
                    if (initialDistance.current !== 0) {
                      initialDistance.current = 0;
                    }
                    if (fitMode === 'fill') {
                      // Delta-based panning — less sensitive than absolute positioning
                      const { locationX, locationY } = touches[0];
                      if (!width || !height) return;
                      const startX = (panStart.current as any)._startX ?? locationX;
                      const startY = (panStart.current as any)._startY ?? locationY;
                      const deltaXPct = ((locationX - startX) / width) * 50; // dampened by 0.5x
                      const deltaYPct = ((locationY - startY) / height) * 50;
                      const xPct = clamp(panStart.current.x + deltaXPct, 0, 100);
                      const yPct = clamp(panStart.current.y + deltaYPct, 0, 100);
                      setPosition({ x: xPct, y: yPct });
                    }
                  }
                }}
                onResponderRelease={() => {
                  // Reset pinch state so next gesture initializes fresh
                  initialDistance.current = 0;
                  onScrollLock?.(false);
                  if (!value) return;
                  if (fitMode === 'fill') {
                    onChange(value, getFitValue(fitMode), position);
                  } else {
                    onChange(value, getFitValue(fitMode), { x: 50, y: 50 });
                  }
                }}
                onResponderTerminate={() => {
                  initialDistance.current = 0;
                  onScrollLock?.(false);
                }}
              />
            )}
            <Pressable style={styles.removeButton} onPress={handleRemove}>
              <MaterialIcons name="cancel" size={28} color="#FFFFFF" />
            </Pressable>
          </>
        ) : (
          <Pressable style={styles.uploadPrompt} onPress={handlePickImage}>
            <MaterialIcons name="cloud-upload" size={48} color={Colors[colorScheme].mutedText} />
            <Text style={[styles.uploadText, { color: Colors[colorScheme].text }]}>
              Tap to upload banner
            </Text>
            <Text style={[styles.uploadHint, { color: Colors[colorScheme].mutedText }]}>
              Recommended: 1920x1080 (16:9)
            </Text>
            <Text style={[styles.uploadHint, { color: Colors[colorScheme].mutedText }]}>
              JPEG or PNG, max 10MB
            </Text>
          </Pressable>
        )}
      </View>

      {/* Fit mode is always 'fill' — no selector needed */}

      {/* Upload button (alternative to tap-to-upload) */}
      {!value && (
        <Pressable
          style={[styles.uploadButton, { backgroundColor: Colors[colorScheme].tint }]}
          onPress={handlePickImage}
        >
          <MaterialIcons name="image" size={20} color="#FFFFFF" />
          <Text style={styles.uploadButtonText}>
            {required ? 'Upload Banner (Required)' : 'Upload Banner'}
          </Text>
        </Pressable>
      )}

      {uploading && (
        <View style={styles.uploadingOverlay}>
          <ActivityIndicator color="#FFFFFF" size="large" />
          <Text style={styles.uploadingText}>Uploading...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 16,
  },
  previewContainer: {
    width: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderStyle: 'dashed',
    position: 'relative',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  uploadPrompt: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  uploadText: {
    fontSize: 16,
    fontWeight: '600',
  },
  uploadHint: {
    fontSize: 13,
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 14,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 8,
  },
  uploadButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderRadius: 12,
  },
  uploadingText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  hintPill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 8,
    alignSelf: 'center',
    marginHorizontal: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
  },
  hintText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
