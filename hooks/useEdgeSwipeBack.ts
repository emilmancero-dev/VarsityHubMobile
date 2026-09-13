import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useContext } from 'react';
import {
  NavigationHistoryContext,
  getNavigationFallback,
} from '@/context/NavigationHistoryContext';

const EDGE_WIDTH = 40; // Left edge zone in px
const SWIPE_THRESHOLD = 60; // Min horizontal distance to trigger back

/**
 * Edge-swipe-to-go-back gesture for tab screens that lack native back navigation.
 * Uses manual activation so only touches starting in the left edge zone activate,
 * letting ScrollViews handle all other touches normally.
 */
export function useEdgeSwipeBack(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const router = useRouter();
  const navHistory = useContext(NavigationHistoryContext);
  const startedAtEdge = useSharedValue(false);

  const goBack = () => {
    if (navHistory?.safeGoBack) {
      navHistory.safeGoBack();
      return;
    }

    if (router.canGoBack()) {
      router.back();
      return;
    }

    // Use context history if available, then global getter, then tabs root
    const fallback = navHistory?.getFallbackRoute?.() ?? getNavigationFallback();
    router.replace(fallback as any);
  };

  const edgeSwipeGesture = Gesture.Pan()
    // When disabled (e.g. while the video trimmer is active — its left handle
    // sits inside the 40px edge zone and would otherwise trigger a back-swipe),
    // the recognizer never activates.
    .enabled(enabled)
    .manualActivation(true)
    .onTouchesDown((e, stateManager) => {
      'worklet';
      const touch = e.allTouches[0];
      if (!touch || touch.x > EDGE_WIDTH) {
        // Fail immediately for non-edge touches so Pressables respond on first tap
        stateManager.fail();
        startedAtEdge.value = false;
      } else {
        startedAtEdge.value = true;
      }
    })
    .onTouchesMove((e, stateManager) => {
      'worklet';
      if (!startedAtEdge.value) {
        stateManager.fail();
        return;
      }
      // Activate once we see enough horizontal movement
      const touch = e.allTouches[0];
      if (touch && touch.x > EDGE_WIDTH + 15) {
        stateManager.activate();
      }
    })
    .onEnd(e => {
      'worklet';
      if (
        startedAtEdge.value &&
        e.translationX > SWIPE_THRESHOLD &&
        Math.abs(e.translationY) < e.translationX
      ) {
        runOnJS(goBack)();
      }
    });

  // Allow native scroll gestures to work simultaneously
  const nativeGesture = Gesture.Native();
  const composedGesture = Gesture.Simultaneous(edgeSwipeGesture, nativeGesture);

  return { edgeSwipeGesture: composedGesture };
}
