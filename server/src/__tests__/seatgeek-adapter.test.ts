import { parseSeatGeekEvents } from '../lib/proSchedule/seatGeekAdapter.js';

describe('SeatGeek schedule adapter', () => {
  const from = new Date('2026-09-01T00:00:00.000Z');
  const to = new Date('2026-09-30T23:59:59.999Z');

  it('normalizes NCAA and minor-league events with venue coordinates', () => {
    const fixtures = parseSeatGeekEvents(
      'ncaa',
      {
        events: [
          {
            id: 123,
            type: 'college_football',
            datetime_utc: '2026-09-12T19:00:00Z',
            title: 'State University vs. Tech University',
            venue: {
              name: 'Memorial Stadium',
              address: '1 Stadium Way',
              city: 'Columbus',
              state: 'OH',
              location: { lat: 39.969, lon: -83.011 },
            },
          },
        ],
      },
      from,
      to
    );

    expect(fixtures).toEqual([
      expect.objectContaining({
        external_ref: 'seatgeek:ncaa:123',
        league: 'ncaa',
        title: 'State University vs. Tech University',
        venue_lat: 39.969,
        venue_lng: -83.011,
        venue_is_neutral: true,
      }),
    ]);
  });

  it('drops events outside the window or without coordinates', () => {
    const fixtures = parseSeatGeekEvents(
      'minor',
      {
        events: [
          {
            id: 1,
            datetime_utc: '2026-10-01T19:00:00Z',
            title: 'Future game',
            venue: { location: { lat: 1, lon: 1 } },
          },
          {
            id: 2,
            datetime_utc: '2026-09-12T19:00:00Z',
            title: 'No venue coordinates',
            venue: { name: 'Unknown venue' },
          },
        ],
      },
      from,
      to
    );

    expect(fixtures).toEqual([]);
  });

  it('does not turn non-sports search results into map fixtures', () => {
    const fixtures = parseSeatGeekEvents(
      'other',
      {
        events: [
          {
            id: 3,
            type: 'concert',
            datetime_utc: '2026-09-12T19:00:00Z',
            title: 'A concert',
            venue: { location: { lat: 40, lon: -73 } },
          },
        ],
      },
      from,
      to
    );

    expect(fixtures).toEqual([]);
  });

  it('fails closed for untyped results in the broad other-sports feed', () => {
    const fixtures = parseSeatGeekEvents(
      'other',
      {
        events: [
          {
            id: 4,
            datetime_utc: '2026-09-12T19:00:00Z',
            title: 'Untyped result',
            venue: { location: { lat: 40, lon: -73 } },
          },
        ],
      },
      from,
      to
    );

    expect(fixtures).toEqual([]);
  });
});
