import React from 'react';
import { View, type ViewProps } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';

/**
 * Wraps children with an edge-swipe-to-go-back gesture recognizer.
 * Use this on screens inside a Tabs navigator that need iOS-style
 * swipe-from-left-edge back navigation.
 */
export default function SwipeBackContainer({
  children,
  style,
  enabled = true,
  ...rest
}: ViewProps & { children: React.ReactNode; enabled?: boolean }) {
  const { edgeSwipeGesture } = useEdgeSwipeBack({ enabled });

  return (
    <GestureDetector gesture={edgeSwipeGesture}>
      <View style={[{ flex: 1 }, style]} {...rest}>
        {children}
      </View>
    </GestureDetector>
  );
}
