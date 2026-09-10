import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// Runtime renderer is installed without its optional declaration package.
const { act, create } = require('react-test-renderer') as {
  act: typeof React.act;
  create: (element: React.ReactElement) => {
    update: (element: React.ReactElement) => void;
    unmount: () => void;
    root: {
      findAllByType: (type: string) => unknown[];
      findByProps: (props: Record<string, unknown>) => { props: Record<string, any> };
    };
  };
};

// Execute the real root/font gate with real React lifecycle. Native providers
// and startup integrations are isolated so no SDK, network, or device is used.
const source = readFileSync(resolve(__dirname, '../_layout.tsx'), 'utf8');
const gateStart = source.indexOf('function FontLoadAttempt(');
const start = gateStart >= 0 ? gateStart : source.indexOf('function RootLayout()');
const code = ts.transpileModule(source.slice(start, source.indexOf('export default RootLayout;')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const hookSource = readFileSync(
  resolve(__dirname, '../../node_modules/expo-font/src/FontHooks.ts'),
  'utf8'
);
const hookCode = ts.transpileModule(
  hookSource.slice(
    hookSource.indexOf('function isMapLoaded'),
    hookSource.indexOf('function useStaticFonts')
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

function fixture() {
  let fonts: [boolean, Error | null] = [false, null];
  const load = jest.fn(() =>
    fonts[0] ? Promise.resolve() : fonts[1] ? Promise.reject(fonts[1]) : new Promise<void>(() => {})
  );
  const useFonts = new Function(
    'useEffect',
    'useState',
    'loadAsync',
    'isLoaded',
    `${hookCode}\nreturn useRuntimeFonts;`
  )(React.useEffect, React.useState, load, () => false);
  const capture = jest.fn();
  const unsubscribe = jest.fn();
  const listen = jest.fn(() => unsubscribe);
  const context: Record<string, any> = {
    React,
    useEffect: React.useEffect,
    useColorScheme: () => 'light',
    useRouter: () => ({}),
    useFonts,
    require: () => 1,
    MaterialIcons: { font: {} },
    Ionicons: { font: {} },
    useUpdates: () => ({ isUpdatePending: false }),
    Updates: { isEnabled: false },
    __DEV__: true,
    isExpoGo: true,
    Platform: { OS: 'ios' },
    Notifications: null,
    AppState: { currentState: 'active', addEventListener: () => ({ remove: jest.fn() }) },
    captureException: capture,
    devLog: jest.fn(),
    getConfig: () => ({ stripePublishableKey: '' }),
    LogBox: { ignoreLogs: jest.fn() },
    handleInitialDeepLink: jest.fn(async () => {}),
    handleDeepLinkAuthAware: jest.fn(),
    setupDeepLinkListener: listen,
    Colors: { light: { background: '#fff', text: '#111', tint: '#125' } },
    queryClient: {},
    asyncStoragePersister: {},
    CACHE_BUSTER: 'test',
    shouldPersistQuery: () => true,
  };
  for (const name of [
    'View',
    'Text',
    'Pressable',
    'ActivityIndicator',
    'SafeAreaProvider',
    'ErrorBoundary',
    'GestureHandlerRootView',
    'StripeProvider',
    'PersistQueryClientProvider',
    'PostCacheProvider',
    'NavigationHistoryProvider',
    'NavReadyAuthProvider',
    'ThemeProvider',
    'AppShell',
  ])
    context[name] = name;
  const Root = new Function(...Object.keys(context), `${code}\nreturn RootLayout;`)(
    ...Object.values(context)
  );
  let tree!: ReturnType<typeof create>;
  const render = () =>
    act(async () => {
      if (tree) tree.update(<Root />);
      else tree = create(<Root />);
    });
  return {
    render,
    tree: () => tree,
    fonts: (value: typeof fonts) => {
      fonts = value;
    },
    capture,
    listen,
    unsubscribe,
    load,
  };
}

describe('root font startup recovery', () => {
  it('keeps the loading state while fonts are pending', async () => {
    const f = fixture();
    await f.render();
    expect(f.tree().root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(f.tree().root.findAllByType('AppShell')).toHaveLength(0);
    expect(f.capture).not.toHaveBeenCalled();
    act(() => f.tree().unmount());
  });

  it('replaces a font failure with accessible retry, then enters the app without repeating startup effects', async () => {
    const f = fixture();
    f.fonts([false, new Error('private font asset URL')]);
    await f.render();
    try {
      expect(f.tree().root.findAllByType('ActivityIndicator')).toHaveLength(0);
      expect(f.tree().root.findAllByType('AppShell')).toHaveLength(0);
      const retry = f.tree().root.findByProps({ accessibilityRole: 'button' });
      expect(retry.props.accessibilityLabel).toBe('Try again');
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.capture.mock.calls[0][0].message).not.toContain('private font asset URL');
      await f.render();
      expect(f.capture).toHaveBeenCalledTimes(1);
      f.fonts([true, null]);
      await act(async () => retry.props.onPress());
      expect(f.load).toHaveBeenCalledTimes(2);
      expect(f.tree().root.findAllByType('AppShell')).toHaveLength(1);
      expect(f.listen).toHaveBeenCalledTimes(1);
      expect(f.unsubscribe).not.toHaveBeenCalled();
    } finally {
      act(() => f.tree().unmount());
    }
  });

  it('keeps retry usable when error reporting throws', async () => {
    const f = fixture();
    f.fonts([false, new Error('font load failed')]);
    f.capture.mockImplementation(() => {
      throw new Error('telemetry unavailable');
    });
    await f.render(); // A thrown reporting error would fail this render/act.
    try {
      expect(f.tree().root.findByProps({ accessibilityRole: 'button' })).toBeDefined();
    } finally {
      act(() => f.tree().unmount());
    }
  });
});
