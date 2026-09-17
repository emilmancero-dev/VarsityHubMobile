import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('react-native-safe-area-context', () =>
  require('@/test-utils/screenMocks').safeAreaMock()
);
jest.mock('expo-router', () => ({
  ...require('@/test-utils/screenMocks').expoRouterOverrides(),
  Stack: { Screen: () => null },
}));
jest.mock('@/context/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'viewer' } }) }));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
const mockEventPages = jest.fn();
jest.mock('@/api/entities', () => ({ User: { eventPagesForProfile: () => mockEventPages() } }));
import RsvpHistoryScreen from '../rsvp-history';

it.each([true, false])('preserves Profile cache shape with cached=%s', async cached => {
  const payload = {
    items: [
      { id: 'event-1', title: 'Attended final', date: '2020-01-01T12:00:00Z', location: 'Gym' },
    ],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  if (cached) client.setQueryData(['profile-event-pages', 'viewer'], payload);
  mockEventPages.mockResolvedValue(payload);
  const view = render(
    <QueryClientProvider client={client}>
      <RsvpHistoryScreen />
    </QueryClientProvider>
  );
  await waitFor(() => expect(view.getByText('Attended final')).toBeTruthy());
  expect(client.getQueryData(['profile-event-pages', 'viewer'])).toEqual(payload);
  view.unmount();
  client.clear();
});
