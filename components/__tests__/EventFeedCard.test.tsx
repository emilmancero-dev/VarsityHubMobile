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
    // No emoji in the title itself.
    expect(screen.queryByText(/^🏈\s/)).toBeNull();
  });

  it('shows the sport emoji centered as a placeholder when there is no picture', () => {
    render(
      <EventFeedCard
        item={{
          id: 'no-photo',
          title: 'Ohio State at Union',
          date: '2026-09-14T00:20:00.000Z',
          location: 'Nowhere Field 9000',
          sport: 'football',
          source_type: 'event',
        }}
        colorScheme="dark"
      />
    );
    // Decorative (hidden from a11y — the card's Pressable carries the label).
    expect(screen.getByText('🏈', { includeHiddenElements: true })).toBeTruthy();
  });

  it('does not show the emoji placeholder when a cover image exists', () => {
    render(
      <EventFeedCard
        item={{
          id: 'has-photo',
          title: 'Ohio State at Union',
          date: '2026-09-14T00:20:00.000Z',
          location: 'Nowhere Field 9000',
          sport: 'football',
          source_type: 'event',
          cover_image_url: 'https://example.com/photo.jpg',
        }}
        colorScheme="dark"
      />
    );
    expect(screen.queryByText('🏈', { includeHiddenElements: true })).toBeNull();
  });
});
