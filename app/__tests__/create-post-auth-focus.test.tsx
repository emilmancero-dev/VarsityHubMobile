import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const { act, create } = require('react-test-renderer') as {
  act: typeof React.act;
  create: (element: React.ReactElement) => {
    update: (element: React.ReactElement) => void;
    unmount: () => void;
  };
};
const source = readFileSync(resolve(__dirname, '../(tabs)/create-post.tsx'), 'utf8');
const start = source.lastIndexOf('\n  use', source.indexOf('if (authLoading) return;'));
const code = ts.transpileModule(source.slice(start, source.indexOf('// Reset trim state', start)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test.each([null, { email_verified: false }])(
  'only the focused composer may redirect user=%p',
  user => {
    let focused = false;
    let authLoading = false;
    const router = { replace: jest.fn() };
    const guard = new Function(
      'useEffect',
      'useFocusEffect',
      'useCallback',
      'authLoading',
      'router',
      'user',
      code
    );
    function Host() {
      guard(
        React.useEffect,
        (callback: () => void) => {
          React.useEffect(() => {
            if (focused) return callback();
          }, [callback, focused]);
        },
        React.useCallback,
        authLoading,
        router,
        user
      );
      return null;
    }
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<Host />);
    });
    expect(router.replace).not.toHaveBeenCalled();
    focused = true;
    act(() => tree!.update(<Host />));
    expect(router.replace).toHaveBeenCalledWith(user ? '/verify-identity?method=email' : '/create');
    focused = false;
    authLoading = true;
    router.replace.mockClear();
    act(() => tree!.update(<Host />));
    authLoading = false;
    act(() => tree!.update(<Host />));
    expect(router.replace).not.toHaveBeenCalled();
    focused = true;
    act(() => tree!.update(<Host />));
    expect(router.replace).toHaveBeenCalledTimes(1);
    act(() => tree!.unmount());
  }
);

test('location prompts require an active, authenticated, verified composer', () => {
  const begin = source.indexOf('\n  use', source.indexOf('// Request location permission'));
  const end = source.indexOf('\n\n  useEffect(', begin + 1);
  const permissionCode = ts.transpileModule(source.slice(begin, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const permissionEffect = new Function(
    'useEffect',
    'useFocusEffect',
    'useCallback',
    'authLoading',
    'user',
    'permissionGranted',
    'hasAutoSuggested',
    'eventId',
    'gameId',
    'postType',
    'requestPermission',
    'setLocationError',
    permissionCode
  );
  let focused = true;
  let authLoading = false;
  let user: { email_verified: boolean } | null = null;
  const requestPermission = jest.fn().mockResolvedValue(true);
  function Host() {
    permissionEffect(
      React.useEffect,
      (callback: () => void) =>
        React.useEffect(() => {
          if (focused) return callback();
        }, [callback, focused]),
      React.useCallback,
      authLoading,
      user,
      false,
      false,
      undefined,
      undefined,
      'post',
      requestPermission,
      jest.fn()
    );
    return null;
  }
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<Host />);
  });
  expect(requestPermission).not.toHaveBeenCalled();
  user = { email_verified: false };
  act(() => tree!.update(<Host />));
  expect(requestPermission).not.toHaveBeenCalled();
  user = { email_verified: true };
  focused = false;
  act(() => tree!.update(<Host />));
  expect(requestPermission).not.toHaveBeenCalled();
  focused = true;
  authLoading = true;
  act(() => tree!.update(<Host />));
  expect(requestPermission).not.toHaveBeenCalled();
  authLoading = false;
  act(() => tree!.update(<Host />));
  expect(requestPermission).toHaveBeenCalledTimes(1);
  act(() => tree!.unmount());
});
