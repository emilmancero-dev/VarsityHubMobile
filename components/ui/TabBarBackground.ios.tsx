import { useColorScheme } from '@/hooks/useColorScheme';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { StyleSheet, View } from 'react-native';

export default function BlurTabBarBackground() {
  const colorScheme = useColorScheme();

  // Use solid opaque backgrounds - BlurView causes sawtooth/zigzag artifact at bottom edge on iOS
  const backgroundColor = colorScheme === 'dark' ? '#121212' : '#FFFFFF';
  return <View style={[StyleSheet.absoluteFill, { backgroundColor, overflow: 'hidden' }]} />;
}

export function useBottomTabOverflow() {
  return useBottomTabBarHeight();
}
