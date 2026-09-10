declare module 'react-native-view-shot' {
  import { Ref } from 'react';
  import { View } from 'react-native';
  export function captureRef(
    viewRef: Ref<View> | number | View | null,
    options?: any
  ): Promise<string>;
}
