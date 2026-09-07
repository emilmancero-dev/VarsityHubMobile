import React from 'react';
import { act, create } from 'react-test-renderer';
import GlobalError from '../_error';
import { requestOtaReload } from '@/utils/runtimeReload';
import * as Updates from 'expo-updates';

jest.mock('react-native', () => ({ Button: 'Button', Text: 'Text', View: 'View' }));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('@/api/auth', () => ({ clearTokensOnly: jest.fn(async () => undefined) }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  multiRemove: jest.fn(async () => undefined),
}));
jest.mock('@/utils/sentry', () => ({ captureException: jest.fn(), captureBreadcrumb: jest.fn() }));
jest.mock('expo-updates', () => ({ reloadAsync: jest.fn() }));

it('does not overlap an update reload with error-screen restart requests', async () => {
  let complete!: () => void;
  jest.mocked(Updates.reloadAsync).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        complete = resolve;
      })
  );
  const updateReload = requestOtaReload();
  let tree: any;
  await act(async () => {
    tree = create(<GlobalError error={new Error('render failure')} retry={jest.fn()} />);
  });
  const restart = tree.root
    .findAllByType('Button')
    .find((button: any) => button.props.title === 'Sign Out & Restart');
  let recovery: Promise<void>;
  await act(async () => {
    recovery = restart.props.onPress();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  const calls = jest.mocked(Updates.reloadAsync).mock.calls.length;
  complete();
  await act(async () => tree.unmount());
  expect(calls).toBe(1);
  await expect(updateReload).resolves.toBe(true);
  await recovery!;
});
