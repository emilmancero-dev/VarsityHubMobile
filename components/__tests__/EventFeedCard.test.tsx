import { render, screen } from '@testing-library/react-native';

jest.mock('expo-image', () => require('@/test-utils/screenMocks').expoImageMock());
jest.mock('expo-linear-gradient', () =>
  require('@/test-utils/screenMocks').expoLinearGradientMock()
);

import { EventFeedCard, EventPostCountBadge } from '../ui/EventFeedCard';

describe('EventFeedCard', () => {
  it('renders a compact sport title and a post count', () => {
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
        badge={<EventPostCountBadge count={2} testID="post-count" />}
      />
    );

    expect(screen.getByText('🏈 Cowboys at Giants')).toBeTruthy();
    expect(screen.getByText(/MetLife Stadium/)).toBeTruthy();
    expect(screen.getByTestId('post-count')).toBeTruthy();
    expect(screen.getByLabelText('2 posts')).toBeTruthy();
  });

  it('normalizes invalid post counts to zero', () => {
    render(<EventPostCountBadge count={Number.NaN} />);
    expect(screen.getByLabelText('0 posts')).toBeTruthy();
  });
});
