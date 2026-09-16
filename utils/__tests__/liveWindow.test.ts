import { getLiveBounds, isGameLive, isGameOver, isPostingWindowOpen } from '@/utils/liveWindow';

describe('liveWindow', () => {
  it.each([
    ['2026-09-15T22:00:00.000Z', '2026-09-16T10:00:00.000Z'],
    ['2026-09-15T22:00:00.000Z', '2026-09-16T16:00:00.000Z'],
  ])('honors all-day/extended bounds through the exact cutoff %s / %s', (start, end) => {
    const event = { starts_at: start, live_from: '2026-09-15T20:00:00Z', live_until: end };
    expect(isPostingWindowOpen(event, Date.parse(end))).toBe(true);
    expect(isPostingWindowOpen(event, Date.parse(end) + 1)).toBe(false);
    expect(isGameOver(event, Date.parse(end) + 1)).toBe(true);
  });

  it('uses absolute timestamps across a daylight-saving offset change', () => {
    const event = {
      starts_at: '2026-11-01T01:30:00-04:00',
      live_from: '2026-10-31T23:30:00-04:00',
      live_until: '2026-11-01T06:30:00-05:00',
    };
    expect(isPostingWindowOpen(event, Date.parse('2026-11-01T11:30:00Z'))).toBe(true);
    expect(isPostingWindowOpen(event, Date.parse('2026-11-01T11:30:00.001Z'))).toBe(false);
  });

  it('uses the bounded fallback for missing or invalid serialized fields', () => {
    const event = { date: '2026-07-16T17:00:00Z', starts_at: 'invalid', live_until: 'invalid' };
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T14:59:59Z'))).toBe(false);
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T23:00:00.001Z'))).toBe(false);
    expect(isPostingWindowOpen({ starts_at: 'invalid', live_until: 'invalid' })).toBe(false);
    expect(
      isPostingWindowOpen(
        { ...event, starts_at: event.date, live_until: '2026-07-16T23:00:00Z', live_from: null },
        Date.parse('2026-07-16T14:59:59Z')
      )
    ).toBe(false);
  });
  it('closes posting before live_from — the standard 2h-before window has not opened yet', () => {
    const event = {
      starts_at: '2026-07-16T17:00:00.000Z',
      live_from: '2026-07-16T15:00:00.000Z',
      live_until: '2026-07-17T11:00:00.000Z',
    };
    const earlyArrival = Date.parse('2026-07-16T05:00:00.000Z');
    const insideWindow = Date.parse('2026-07-16T16:00:00.000Z');

    expect(isPostingWindowOpen(event, earlyArrival)).toBe(false);
    expect(isPostingWindowOpen(event, insideWindow)).toBe(true);
    expect(isGameLive(event, earlyArrival)).toBe(false);
    expect(isGameOver(event, earlyArrival)).toBe(false);
  });

  it('respects live_from as the lower bound and live_until as the upper bound', () => {
    const event = {
      starts_at: '2026-07-16T17:00:00.000Z',
      live_from: '2026-07-16T15:00:00.000Z',
      live_until: '2026-07-16T20:00:00.000Z',
    };

    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T14:00:00.000Z'))).toBe(false);
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T15:00:00.000Z'))).toBe(true);
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T20:00:01.000Z'))).toBe(false);
  });

  it('falls back to the server default 2h-before/6h-after window for old payloads', () => {
    const event = { date: '2026-07-16T17:00:00.000Z' };

    expect(getLiveBounds(event)).toEqual({
      startsAt: Date.parse('2026-07-16T17:00:00.000Z'),
      liveFrom: Date.parse('2026-07-16T15:00:00.000Z'),
      liveUntil: Date.parse('2026-07-16T23:00:00.000Z'),
    });
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T05:00:00.000Z'))).toBe(false);
    expect(isPostingWindowOpen(event, Date.parse('2026-07-16T16:00:00.000Z'))).toBe(true);
  });
});
