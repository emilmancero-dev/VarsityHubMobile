import React from 'react';
const { renderToString } = require('react-dom/server') as {
  renderToString: (element: React.ReactElement) => string;
};
import { ThemeProvider, useCustomColorScheme } from '../useCustomColorScheme';

let mockSystemTheme = 'light';
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  useColorScheme: () => mockSystemTheme,
}));
jest.mock('expo-secure-store', () => ({}));
jest.mock('@/context/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

function ThemeLabel() {
  return <span>{useCustomColorScheme()}</span>;
}

test.each([true, false])('server theme is stable with provider=%s', withProvider => {
  const element = withProvider ? (
    <ThemeProvider>
      <ThemeLabel />
    </ThemeProvider>
  ) : (
    <ThemeLabel />
  );
  mockSystemTheme = 'light';
  const serverMarkup = renderToString(element);
  mockSystemTheme = 'dark';
  expect(renderToString(element)).toBe(serverMarkup);
});
