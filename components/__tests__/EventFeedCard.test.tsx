import { render, screen } from '@testing-library/react-native';

jest.mock('expo-image', () => require('@/test-utils/screenMocks').expoImageMock());
jest.mock('expo-linear-gradient', () =>
  require('@/test-utils/screenMocks').expoLinearGradientMock()
);

import { EventFeedCard } from '../ui/EventFeedCard';

describe('EventFeedCard', () => {
  it('renders a compact sport title without a post-count badge', () => {
    render(
      <EventFeedCard
        item={{
          id: 'cowboys-giants',
          title: 'Cowboys at Giants',
          date: '2026-09-14T00:20:00.000Z',
          location: 'MetLife Stadium, East Rutherford',
          event_type: 'game',
          source_type: 'event',
          pro_league: 'nfl',
          pro_home_color: '#0B2265',
          pro_away_color: '#041E42',
        }}
        colorScheme="dark"
      />
    );

    expect(screen.getByText('Cowboys at Giants')).toBeTruthy();
    expect(screen.getByText(/MetLife Stadium/)).toBeTruthy();
    expect(screen.queryByText('📝')).toBeNull();
  });
});
