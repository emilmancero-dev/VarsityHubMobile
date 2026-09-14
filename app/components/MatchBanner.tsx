import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { optimizeImageUrl } from '@/utils/imageUrl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  Image,
  ImageBackground,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MatchBannerLottie from './MatchBannerLottie';
import MatchBannerOverlayLayer from './MatchBannerOverlayLayer';

type Props = {
  leftImage?: string | null;
  rightImage?: string | null;
  leftName?: string;
  rightName?: string;
  leftScore?: number | null;
  rightScore?: number | null;
  height?: number;
  variant?: 'full' | 'compact';
  leftColor?: string;
  rightColor?: string;
  appearance?: 'classic' | 'sparkle' | 'sporty';
  hero?: boolean;
  onVsPress?: () => void;
  onLeftPress?: () => void;
  onRightPress?: () => void;
  onGoingPress?: () => void;
  goingCount?: number | null;
  onPress?: () => void;
  // headerFade will be an Animated node (0..1) coming from parent header opacity to drive entrance animation
  headerFade?: any;
};

const SCREEN_WIDTH = Dimensions.get('window').width;

export default React.memo(function MatchBanner({
  leftImage,
  rightImage,
  leftName = '',
  rightName = '',
  leftScore,
  rightScore,
  height = 260,
  variant = 'full',
  leftColor,
  rightColor,
  appearance = 'classic',
  hero = false,
  onVsPress,
  onLeftPress,
  onRightPress,
  onGoingPress,
  goingCount,
  headerFade,
  onPress,
}: Props) {
  const halfStyle = { width: SCREEN_WIDTH / 2 };
  const colorScheme = useColorScheme() ?? 'light';
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);
  const vsAnimRef = useRef(new Animated.Value(0));
  const vsAnim = vsAnimRef.current;
  const sparkleAnimRef = useRef(new Animated.Value(0));
  const sparkleAnim = sparkleAnimRef.current;
  const [lottieLoaded, setLottieLoaded] = useState(false);
  const handleLottieLoaded = useCallback((v: boolean) => {
    setLottieLoaded(v);
  }, []);
  const rightAnimRef = useRef(new Animated.Value(0));
  const rightAnim = rightAnimRef.current;
  useEffect(() => {
    let mounted = true;

    const update = (enabled: boolean | undefined) => {
      setReduceMotionEnabled(Boolean(enabled));
    };

    const fetch = async () => {
      try {
        const enabled = await AccessibilityInfo.isReduceMotionEnabled();
        if (mounted) update(enabled);
      } catch (err) {
        if (__DEV__)
          console.warn('[MatchBanner] reduceMotion check failed:', (err as Error)?.message);
      }
    };

    void fetch();
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', enabled =>
      update(enabled)
    );
    return () => {
      mounted = false;
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      } else if (subscription) {
        try {
          (subscription as any)();
        } catch (err) {
          if (__DEV__) console.warn('[MatchBanner] remove subscription:', (err as Error)?.message);
        }
      }
    };
  }, []);
  useEffect(() => {
    if (reduceMotionEnabled) {
      vsAnim.stopAnimation();
      sparkleAnim.stopAnimation();
      rightAnim.stopAnimation();
      vsAnim.setValue(0);
      sparkleAnim.setValue(0);
      rightAnim.setValue(0);
      return;
    }

    // If this is a hero banner we keep things very lightweight: don't start looping animations
    // as they can be expensive on lower-end devices. Most decorative animations are disabled
    // and overlays suppressed when `hero` is true.
    if (hero) {
      vsAnim.stopAnimation();
      sparkleAnim.stopAnimation();
      rightAnim.stopAnimation();
      vsAnim.setValue(0);
      sparkleAnim.setValue(0);
      rightAnim.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(vsAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(vsAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const sparkleLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(sparkleAnim, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(sparkleAnim, { toValue: 0, duration: 1100, useNativeDriver: true }),
      ])
    );

    const rLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(rightAnim, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(rightAnim, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();
    sparkleLoop.start();
    rLoop.start();
    return () => {
      loop.stop();
      sparkleLoop.stop();
      rLoop.stop();
    };
  }, [hero, reduceMotionEnabled, vsAnim, sparkleAnim, rightAnim]);

  const scale = reduceMotionEnabled
    ? 1
    : vsAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [hero ? 0.96 : 0.98, hero ? 1.12 : 1.06],
      });
  const glow = reduceMotionEnabled
    ? 1
    : vsAnim.interpolate({ inputRange: [0, 1], outputRange: [hero ? 0.7 : 0.6, 1] });

  const compact = variant === 'compact';
  const shouldAnimate = !reduceMotionEnabled;
  const containerBackground = colorScheme === 'dark' ? '#020617' : '#e2e8f0';

  // adaptive font sizes for long names
  const leftFontSize = compact ? (leftName.length > 18 ? 16 : 20) : leftName.length > 20 ? 28 : 34;
  const rightFontSize = compact
    ? rightName.length > 18
      ? 14
      : 16
    : rightName.length > 20
      ? 22
      : 28;

  // Combine headerFade (if provided) with local vs scale/glow for entrance
  const rootOpacity = headerFade ? headerFade : 1;
  const paletteInput = useMemo(
    () => ({
      home: leftName
        ? { id: leftName.toLowerCase(), name: leftName, primaryColor: leftColor ?? null }
        : undefined,
      away: rightName
        ? { id: rightName.toLowerCase(), name: rightName, primaryColor: rightColor ?? null }
        : undefined,
      appearance,
      theme: colorScheme,
      variant,
      overrides: {
        leftColor: leftColor ?? null,
        rightColor: rightColor ?? null,
      },
    }),
    [appearance, colorScheme, leftColor, leftName, rightColor, rightName, variant]
  );

  const bannerContent = (
    <Animated.View
      style={[
        styles.root,
        {
          height: compact ? Math.min(140, height) : height,
          opacity: rootOpacity,
          backgroundColor: containerBackground,
        } as any,
      ]}
    >
      {/* Top bar removed - team names now shown in VS overlay only */}

      {/* Left half */}
      <Pressable
        onPress={onLeftPress || onPress}
        accessibilityRole="button"
        accessibilityLabel={leftName ? `${leftName} team` : 'Left team'}
        style={({ pressed }) => [{ width: SCREEN_WIDTH / 2, opacity: pressed ? 0.9 : 1 }]}
        android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
      >
        <ImageBackground
          source={leftImage ? { uri: leftImage } : undefined}
          style={[styles.half, halfStyle] as any}
          imageStyle={styles.imageCover as any}
        >
          {!leftImage && <View style={[styles.fallback, { backgroundColor: '#9b1c1c' }] as any} />}
          {/* if this is a hero banner (real logos) we intentionally skip inner gradient overlays to keep images clean */}
          {!hero && (
            <View
              style={[
                styles.innerGradientLeft as any,
                compact ? (styles.innerGradientCompact as any) : null,
              ]}
            />
          )}
        </ImageBackground>
      </Pressable>

      {/* Right half */}
      <Pressable
        onPress={onRightPress || onPress}
        accessibilityRole="button"
        accessibilityLabel={rightName ? `${rightName} team` : 'Right team'}
        style={({ pressed }) => [{ width: SCREEN_WIDTH / 2, opacity: pressed ? 0.9 : 1 }]}
        android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
      >
        <ImageBackground
          source={rightImage ? { uri: rightImage } : undefined}
          style={[styles.half, halfStyle, styles.rightHalf] as any}
          imageStyle={styles.imageCover as any}
        >
          {!rightImage && <View style={[styles.fallback, { backgroundColor: '#0b558d' }] as any} />}
          {!hero && (
            <View
              style={[
                styles.innerGradientRight as any,
                compact ? (styles.innerGradientCompact as any) : null,
              ]}
            />
          )}
        </ImageBackground>
      </Pressable>

      {/* If hero is true we want a clean look: fully suppress decorative overlays */}
      <MatchBannerOverlayLayer
        input={paletteInput}
        reduceMotion={reduceMotionEnabled}
        variant={variant}
        suppressBackground={!!hero}
        suppressAllOverlays={!!hero}
      />

      {/* Animated VS overlay - stacked: Left name above VS, Right name below VS */}
      <Animated.View
        style={[
          styles.vsWrapper as any,
          { transform: [{ scale }], opacity: glow, pointerEvents: 'box-none' },
        ]}
      >
        <Animated.View
          style={[styles.titlesColumn as any, { opacity: glow, pointerEvents: 'box-none' }]}
        >
          <Pressable
            style={styles.topTitleWrap as any}
            onPress={onLeftPress}
            disabled={!onLeftPress}
            accessibilityRole={onLeftPress ? 'button' : undefined}
            accessibilityLabel={onLeftPress ? `View ${leftName} team page` : undefined}
          >
            {leftImage ? (
              <Image
                source={{ uri: optimizeImageUrl(leftImage, 160) }}
                style={styles.smallLogo as any}
              />
            ) : null}
            <View style={styles.sideTitleBg as any}>
              <Text
                style={[
                  styles.sideTitle as any,
                  { fontSize: leftFontSize, color: leftColor || Colors[colorScheme].text } as any,
                ]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {leftName}
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={onVsPress || onPress}
            accessibilityRole="button"
            accessibilityLabel="View matchup details"
            style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.98 : 1 }] } as any]}
            android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
          >
            <View style={[styles.vsBadge as any, hero ? styles.vsBadgeHero : null]}>
              {leftScore != null && rightScore != null ? (
                <Text
                  style={[styles.vsText as any, hero ? styles.vsTextHero : null]}
                >{`${leftScore} - ${rightScore}`}</Text>
              ) : (
                <Text style={[styles.vsText as any, hero ? styles.vsTextHero : null]}>{'VS'}</Text>
              )}
            </View>
          </Pressable>

          <Pressable
            style={styles.bottomTitleWrap as any}
            onPress={onRightPress}
            disabled={!onRightPress}
            accessibilityRole={onRightPress ? 'button' : undefined}
            accessibilityLabel={onRightPress ? `View ${rightName} team page` : undefined}
          >
            {rightImage ? (
              <Image
                source={{ uri: optimizeImageUrl(rightImage, 160) }}
                style={styles.smallLogo as any}
              />
            ) : null}
            <View style={styles.sideTitleBg as any}>
              <Text
                style={[
                  styles.sideTitle as any,
                  { fontSize: rightFontSize, color: rightColor || Colors[colorScheme].text } as any,
                ]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {rightName}
              </Text>
            </View>
          </Pressable>
        </Animated.View>

        {/* Lightweight decorative sparkles (Animated fallback) */}
        {!lottieLoaded && shouldAnimate && (
          <>
            <Animated.View
              style={[
                styles.sparkle as any,
                {
                  opacity: sparkleAnim.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0, 1, 0],
                  }) as any,
                  transform: [
                    {
                      translateY: sparkleAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-6, 6],
                      }) as any,
                    },
                    {
                      scale: sparkleAnim.interpolate({
                        inputRange: [0, 0.5, 1],
                        outputRange: [0.6, 1, 0.6],
                      }) as any,
                    },
                  ],
                },
              ]}
            />

            <Animated.View
              style={[
                styles.sparkle2 as any,
                {
                  opacity: sparkleAnim.interpolate({
                    inputRange: [0, 0.3, 0.7, 1],
                    outputRange: [0, 0.8, 0.4, 0],
                  }) as any,
                  transform: [
                    {
                      translateY: sparkleAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [8, -8],
                      }) as any,
                    },
                    {
                      rotate: sparkleAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0deg', '45deg'],
                      }) as any,
                    },
                  ],
                },
              ]}
            />
          </>
        )}
      </Animated.View>
      {/* Lottie micro-animation (optional, loaded dynamically) */}
      {appearance && (
        <MatchBannerLottie
          preset={appearance}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            marginLeft: hero ? -56 : -40,
            marginTop: hero ? -56 : -40,
            zIndex: 35,
          }}
          size={hero ? 112 : 80}
          tintColor={undefined}
          onLoaded={handleLottieLoaded}
          disabled={!shouldAnimate}
        />
      )}
    </Animated.View>
  );

  const rsvpBadge =
    typeof goingCount === 'number' ? (
      <Pressable
        onPress={onGoingPress}
        accessibilityRole={onGoingPress ? 'button' : undefined}
        accessibilityLabel="View who's watching"
        style={styles.goingBadge as any}
      >
        <Text style={styles.goingBadgeText as any}>📺 {Math.max(0, goingCount!)} watching</Text>
      </Pressable>
    ) : null;

  return (
    <View style={{ position: 'relative' }}>
      {onPress ? (
        <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.95 : 1 }]}>
          {bannerContent}
        </Pressable>
      ) : (
        bannerContent
      )}
      {rsvpBadge}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    width: '100%',
    flexDirection: 'row',
    backgroundColor: 'transparent',
    overflow: 'hidden',
    position: 'relative',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 44,
    // background handled by BlurView for a professional translucent effect
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    zIndex: 50,
  },
  teamName: {
    color: '#fff', // Always white on banner images
    fontWeight: '800',
    fontSize: 18,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 2px rgba(0, 0, 0, 0.8)' }
      : {
          textShadowColor: 'rgba(0,0,0,0.8)', // Shadow needed for readability on images
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 2,
        }),
    maxWidth: '48%',
  },
  teamNameLeft: {
    textAlign: 'left',
  },
  teamNameRight: {
    textAlign: 'right',
  },
  half: {
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rightHalf: {
    transform: [{ scaleX: 1 }],
  },
  imageCover: {
    resizeMode: 'cover',
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.08,
  },
  vsWrapper: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: [{ translateX: -SCREEN_WIDTH * 0.5 + 0 }, { translateY: -40 }],
    zIndex: 30,
    width: SCREEN_WIDTH,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vsText: {
    color: '#fff',
    fontSize: 44,
    fontWeight: '900',
    textAlign: 'center',
    // simple shadow for Android as well
    ...Platform.select({
      ios: {
        textShadowColor: 'rgba(0,0,0,0.9)',
        textShadowOffset: { width: 0, height: 2 },
        textShadowRadius: 4,
      },
      android: { elevation: 6 },
    }),
  },
  vsTextHero: {
    fontSize: 56,
  },
  topBarCompact: {
    height: 36,
    paddingHorizontal: 8,
  },
  teamNameCompact: {
    fontSize: 14,
    fontWeight: '800',
  },
  innerGradientLeft: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  innerGradientRight: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  innerGradientCompact: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  vsBadge: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  vsBadgeHero: {
    width: 112,
    height: 112,
    borderRadius: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  // removed vsBadgeContainer - centering handled by titlesRow
  titlesRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 42,
    paddingHorizontal: 16,
  },
  titlesColumn: {
    width: '100%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 42,
  },
  topTitleWrap: {
    alignItems: 'center',
    marginBottom: 6,
    width: '100%',
  },
  bottomTitleWrap: {
    alignItems: 'center',
    marginTop: 6,
    width: '100%',
  },
  smallLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  sideTitleWrap: { flex: 1, paddingHorizontal: 6 },
  sideTitleBg: {
    backgroundColor: 'rgba(0,0,0,0.28)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  sideTitle: {
    color: '#fff',
    fontWeight: '900',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 2px 6px rgba(0, 0, 0, 0.8)' }
      : {
          textShadowColor: 'rgba(0,0,0,0.8)',
          textShadowOffset: { width: 0, height: 2 },
          textShadowRadius: 6,
        }),
    maxWidth: 100,
  },
  vsTouchArea: {
    position: 'absolute',
    left: -40,
    top: -40,
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  vsTouchShim: {
    width: '100%',
    height: '100%',
    opacity: 0,
  },
  leftNameWrapper: {
    width: '40%',
    zIndex: 60,
    justifyContent: 'center',
  },
  rightNameWrapper: {
    width: '40%',
    zIndex: 60,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  aggressiveLeft: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 1,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 2px 6px rgba(0, 0, 0, 0.85)' }
      : {
          textShadowColor: 'rgba(0,0,0,0.85)',
          textShadowOffset: { width: 0, height: 2 },
          textShadowRadius: 6,
        }),
  },
  aggressiveLeftCompact: {
    fontSize: 20,
  },
  aggressiveRight: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 2px 6px rgba(0, 0, 0, 0.85)' }
      : {
          textShadowColor: 'rgba(0,0,0,0.85)',
          textShadowOffset: { width: 0, height: 2 },
          textShadowRadius: 6,
        }),
  },
  aggressiveRightCompact: {
    fontSize: 16,
  },
  sparkle: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.9)',
    top: -10,
    left: 12,
    zIndex: 40,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 0px 6px rgba(255, 255, 255, 0.6)' }
      : {
          shadowColor: '#fff',
          shadowOpacity: 0.6,
          shadowRadius: 6,
        }),
  },
  sparkle2: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 2,
    backgroundColor: 'rgba(255,235,200,0.95)',
    top: 18,
    right: 10,
    zIndex: 40,
    opacity: 0.9,
  },
  goingBadge: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    backgroundColor: 'rgba(0,0,0,0.58)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  goingBadgeText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  measureHidden: {
    position: 'absolute',
    left: -9999,
    top: -9999,
    height: 0,
    width: 0,
    opacity: 0,
  },
});
