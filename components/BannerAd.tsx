/**
 * Clickable Banner Ad Component
 *
 * Displays a banner ad with proper fit mode and handles clicks to open target URL
 */

import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { Advertisement } from '@/api/entities';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';

interface BannerAdProps {
  adId?: string | null;
  bannerUrl?: string | null;
  targetUrl?: string | null;
  ctaText?: string | null;
  businessName?: string;
  description?: string;
  fitMode?: 'cover' | 'contain' | 'fill' | 'rotate' | 'stretch' | 'letterbox' | `rotate:${number}`;
  aspectRatio?: number;
  onPress?: () => void; // Optional override for click behavior
}

export function BannerAd({
  adId,
  bannerUrl,
  targetUrl,
  ctaText,
  businessName,
  description,
  // Default to 'contain' so an ad image is never distorted — it shows at its
  // true proportions (letterboxed if needed) rather than being stretched to
  // fill. Advertisers who pick an explicit fit at checkout still override this.
  fitMode = 'contain',
  aspectRatio = 16 / 9,
  onPress,
}: BannerAdProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const hasTrackedImpressionRef = useRef(false);

  useEffect(() => {
    if (!adId || hasTrackedImpressionRef.current) return;
    hasTrackedImpressionRef.current = true;
    void Advertisement.trackImpression(String(adId)).catch(() => {});
  }, [adId]);

  const handlePress = async () => {
    // Use custom onPress if provided
    if (onPress) {
      onPress();
      return;
    }

    // If no target URL, show message
    if (!targetUrl) {
      Alert.alert('No Link', 'This ad does not have a website link.');
      return;
    }

    // SECURITY: Allow only web schemes, then enforce HTTPS before opening.
    const trimmed = targetUrl.trim().toLowerCase();
    const hasProtocol = trimmed.match(/^[a-z]+:/);
    if (hasProtocol && !trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
      Alert.alert('Invalid Link', 'This link cannot be opened for security reasons.');
      return;
    }

    // Normalize to HTTPS: add protocol when missing and upgrade http:// links.
    let normalizedUrl = targetUrl.trim();
    if (normalizedUrl.match(/^http:\/\//i)) {
      normalizedUrl = normalizedUrl.replace(/^http:\/\//i, 'https://');
    } else if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    if (!normalizedUrl.match(/^https:\/\//i)) {
      Alert.alert('Invalid Link', 'Only secure (HTTPS) links are allowed.');
      return;
    }

    // Show confirmation dialog before opening external link
    Alert.alert(
      'Open Website',
      `Do you want to visit ${businessName || 'this website'}?\n\n${normalizedUrl}`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Open',
          onPress: async () => {
            try {
              const canOpen = await Linking.canOpenURL(normalizedUrl);
              if (canOpen) {
                if (adId) {
                  await Advertisement.trackClick(String(adId)).catch(() => {});
                }
                await Linking.openURL(normalizedUrl);
              } else {
                Alert.alert(
                  'Invalid Link',
                  'Unable to open this link. Please check the URL format.'
                );
              }
            } catch (error) {
              if (__DEV__) console.error('Error opening ad link:', error);
              Alert.alert('Error', 'Failed to open link. Please try again.');
            }
          },
        },
      ]
    );
  };

  const parseRotate = (mode?: string | null) => {
    if (!mode) return { base: 'fill', rotation: 0 };
    if (mode.startsWith('rotate:')) {
      const parts = mode.split(':');
      const raw = parts.length > 1 ? Number(parts[1]) : 0;
      return { base: 'rotate', rotation: Number.isFinite(raw) ? raw : 0 };
    }
    return { base: mode, rotation: 0 };
  };

  const { base, rotation } = parseRotate(fitMode || 'fill');

  const getContentFit = (): 'contain' | 'cover' | 'fill' => {
    switch (base) {
      case 'contain':
        return 'contain';
      case 'cover':
        return 'cover';
      case 'fill':
        return 'fill';
      case 'rotate':
      case 'letterbox':
        return 'contain'; // Legacy: fits entire image
      case 'stretch':
        return 'fill'; // Legacy: stretches to fill
      default:
        return 'cover';
    }
  };

  const getRotateFitScale = (angleDeg: number, width: number, height: number) => {
    if (!width || !height) return 1;
    const rad = (Math.abs(angleDeg) % 360) * (Math.PI / 180);
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const rotatedWidth = width * cos + height * sin;
    const rotatedHeight = width * sin + height * cos;
    const scaleX = width / rotatedWidth;
    const scaleY = height / rotatedHeight;
    return Math.min(scaleX, scaleY, 1);
  };

  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const rotateScale = useMemo(() => {
    if (base !== 'rotate' || !rotation) return 1;
    return getRotateFitScale(rotation, layout.width, layout.height);
  }, [base, rotation, layout.width, layout.height]);

  // Measured aspect ratio of the loaded image. For the default 'contain' fit we
  // size the box to the image's OWN ratio so there are no letterbox bars — a
  // fixed extreme box (e.g. 3.5:1) made a normal banner sit in a sea of empty
  // space. Clamped to a sane band so an unusually tall/wide creative can't
  // dominate the feed or render as a sliver. Explicit non-contain fits
  // (cover/fill/rotate, chosen by the advertiser) keep the caller's aspectRatio.
  const [intrinsicRatio, setIntrinsicRatio] = useState<number | null>(null);
  const effectiveAspectRatio = base === 'contain' && intrinsicRatio ? intrinsicRatio : aspectRatio;

  // If no banner URL, show placeholder
  if (!bannerUrl) {
    return (
      <View
        style={[
          styles.container,
          {
            aspectRatio,
            backgroundColor: Colors[colorScheme].surface,
            borderColor: Colors[colorScheme].border,
          },
        ]}
      >
        <View style={styles.placeholder}>
          <MaterialIcons name="image" size={48} color={Colors[colorScheme].mutedText} />
          {businessName && (
            <Text style={[styles.placeholderText, { color: Colors[colorScheme].text }]}>
              {businessName}
            </Text>
          )}
          {description && (
            <Text style={[styles.placeholderDesc, { color: Colors[colorScheme].mutedText }]}>
              {description}
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        {
          aspectRatio: effectiveAspectRatio,
          backgroundColor: Colors[colorScheme].surface,
          borderColor: Colors[colorScheme].border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width && height && (layout.width !== width || layout.height !== height)) {
          setLayout({ width, height });
        }
      }}
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel="Sponsored advertisement"
      android_ripple={{ color: 'rgba(0, 0, 0, 0.1)' }}
    >
      <Image
        source={{ uri: optimizeImageUrl(bannerUrl, 1200) }}
        style={[
          styles.image,
          base === 'rotate' &&
            rotation !== 0 && {
              transform: [{ scale: rotateScale }, { rotate: `${rotation}deg` }],
            },
        ]}
        contentFit={getContentFit()}
        onLoad={e => {
          const w = e?.source?.width;
          const h = e?.source?.height;
          if (w && h) {
            // Clamp to [0.8, 2.5] — squares and standard banners pass through;
            // extreme creatives are bounded so one ad can't own the viewport.
            setIntrinsicRatio(Math.min(Math.max(w / h, 0.8), 2.5));
          }
        }}
      />

      {/* Advertiser-chosen CTA overlay — top-left (PDF: "Banner must include
          business name + CTA button"). Falls back to a generic label when the
          advertiser didn't set one — never crashes on missing data. */}
      {targetUrl && (
        <View style={styles.linkIndicator}>
          <Text style={styles.linkIndicatorText}>{ctaText?.trim() || 'Learn More'}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  placeholderText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  placeholderDesc: {
    fontSize: 13,
    textAlign: 'center',
  },
  linkIndicator: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  linkIndicatorText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
});
