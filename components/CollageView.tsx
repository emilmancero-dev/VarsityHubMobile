import { Image } from 'expo-image';
import React, { memo, useCallback, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { optimizeImageUrl } from '@/utils/imageUrl';

export type CollageMedia = {
  url: string;
  type: 'image' | 'video';
  scale: number;
  translateX: number;
  translateY: number;
  rotation: number; // deg
  filter?: 'soft' | 'warm' | 'cool' | 'fade' | null;
};

export type CollageFrame = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number; // normalized 0..1
  media: CollageMedia;
};

export type CollageData = {
  bg_color: string;
  gutter: number; // px
  radius: number; // px
  template:
    | '2up'
    | '3triptych'
    | '4grid'
    | 'asym3'
    | 'asym4'
    | 'organic2'
    | 'organic3'
    | 'organic4'
    | 'random';
  frames: CollageFrame[];
};

type Props = {
  collage: CollageData;
  // Container style: square in grid (aspectRatio: 1), full-bleed in detail
  style?: any;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Generate organic layouts with random aspect ratios
const generateOrganicLayout = (
  template: string,
  frameCount: number
): Omit<CollageFrame, 'media'>[] => {
  const layouts: { [key: string]: Omit<CollageFrame, 'media'>[] } = {
    organic2: [
      { id: '1', x: 0, y: 0, w: 0.68, h: 0.75 },
      { id: '2', x: 0.72, y: 0.1, w: 0.28, h: 0.6 },
    ],
    organic3: [
      { id: '1', x: 0, y: 0, w: 0.55, h: 0.65 },
      { id: '2', x: 0.6, y: 0, w: 0.4, h: 0.4 },
      { id: '3', x: 0.6, y: 0.45, w: 0.4, h: 0.55 },
    ],
    organic4: [
      { id: '1', x: 0, y: 0, w: 0.48, h: 0.6 },
      { id: '2', x: 0.52, y: 0, w: 0.48, h: 0.35 },
      { id: '3', x: 0, y: 0.65, w: 0.48, h: 0.35 },
      { id: '4', x: 0.52, y: 0.4, w: 0.48, h: 0.6 },
    ],
    random: generateRandomLayout(frameCount),
  };

  return layouts[template] || layouts.organic2;
};

// Generate completely random organic layout
const generateRandomLayout = (count: number): Omit<CollageFrame, 'media'>[] => {
  const frames: Omit<CollageFrame, 'media'>[] = [];
  const minSize = 0.25;
  const maxSize = 0.7;

  for (let i = 0; i < count; i++) {
    const w = minSize + Math.random() * (maxSize - minSize);
    const h = minSize + Math.random() * (maxSize - minSize);
    const maxX = Math.max(0, 1 - w);
    const maxY = Math.max(0, 1 - h);
    const x = Math.random() * maxX;
    const y = Math.random() * maxY;

    frames.push({
      id: (i + 1).toString(),
      x,
      y,
      w,
      h,
    });
  }

  return frames;
};

const CollageView: React.FC<Props> = memo(({ collage, style }) => {
  const bg = collage.bg_color || '#FFFFFF';
  const g = clamp(collage.gutter ?? 8, 0, 12);
  const r = clamp(collage.radius ?? 8, 0, 16);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      if (width !== size.w || height !== size.h) setSize({ w: width, h: height });
    },
    [size.w, size.h]
  );

  const frames = useMemo(() => {
    if (!Array.isArray(collage.frames) || collage.frames.length === 0) {
      return [];
    }

    // Use organic layouts for specific templates
    if (['organic2', 'organic3', 'organic4', 'random'].includes(collage.template)) {
      const organicFrames = generateOrganicLayout(collage.template, collage.frames.length);
      return collage.frames.map((frame, index) => ({
        ...frame,
        ...(organicFrames[index] || organicFrames[0]), // fallback to first frame if not enough layouts
      }));
    }

    return collage.frames;
  }, [collage.frames, collage.template]);

  return (
    <View
      onLayout={onLayout}
      style={[styles.container, { backgroundColor: bg, borderRadius: r, padding: g / 2 }, style]}
    >
      {size.w > 0 && size.h > 0
        ? frames.map(f => {
            const left = f.x * size.w;
            const top = f.y * size.h;
            const width = f.w * size.w;
            const height = f.h * size.h;

            // Add slight randomization to rotation for organic feel
            const organicRotation = ['organic2', 'organic3', 'organic4', 'random'].includes(
              collage.template
            )
              ? (Math.random() - 0.5) * 4 // Random rotation between -2 and +2 degrees
              : 0;

            return (
              <View
                key={f.id}
                style={{ position: 'absolute', left, top, width, height, padding: g / 2 }}
              >
                <View
                  style={[
                    styles.frame,
                    {
                      borderRadius: Math.max(0, r - g / 2),
                      transform: [{ rotate: `${organicRotation}deg` }],
                    },
                  ]}
                >
                  {!!f.media?.url && (
                    <View style={StyleSheet.absoluteFill}>
                      <Image
                        source={{
                          uri:
                            optimizeImageUrl(f.media.url, Math.max(240, Math.round(width * 1.5))) ||
                            f.media.url,
                        }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory-disk"
                      />
                      <View
                        style={{
                          ...StyleSheet.absoluteFillObject,
                          pointerEvents: 'none',
                          transform: [
                            { scale: clamp(f.media?.scale ?? 1, 0.1, 8) },
                            { translateX: f.media?.translateX ?? 0 },
                            { translateY: f.media?.translateY ?? 0 },
                            { rotate: `${(f.media?.rotation ?? 0) + organicRotation}deg` },
                          ],
                        }}
                      />
                    </View>
                  )}
                </View>
              </View>
            );
          })
        : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  frame: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#121212',
  },
});

export default CollageView;
