import React from 'react';
const { renderToString } = require('react-dom/server') as {
  renderToString: (element: React.ReactElement) => string;
};
const { act, create } = require('react-test-renderer') as {
  act: typeof React.act;
  create: (element: React.ReactElement) => {
    root: { findAllByType: (type: string) => unknown[] };
    unmount: () => void;
  };
};
import { WebThemeToggle } from '../WebThemeToggle';
import { WebInstallCta } from '../WebInstallCta';

let mockWidth = 0;
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  useWindowDimensions: () => ({ width: mockWidth }),
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  Pressable: ({ children }: any) => <button>{children}</button>,
}));
jest.mock('@expo/vector-icons/MaterialIcons', () => () => null);
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('@/hooks/useCustomColorScheme', () => ({
  useThemePreference: () => ({ themePreference: 'system', setThemePreference: jest.fn() }),
}));

test.each([WebThemeToggle, WebInstallCta])(
  '%p keeps its initial markup independent of server/browser viewport',
  Component => {
    mockWidth = 0;
    const serverMarkup = renderToString(<Component />);
    mockWidth = 1440;
    expect(renderToString(<Component />)).toBe(serverMarkup);
  }
);

test.each([WebThemeToggle, WebInstallCta])('%p appears after mounting on desktop', Component => {
  mockWidth = 1440;
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: () => null } },
  });
  let tree: ReturnType<typeof create>;
  try {
    act(() => {
      tree = create(<Component />);
    });
    expect(tree!.root.findAllByType('button').length).toBeGreaterThan(0);
    act(() => tree!.unmount());
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});
