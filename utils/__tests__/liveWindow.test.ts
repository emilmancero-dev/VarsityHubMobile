import { getLiveBounds, isGameLive, isGameOver, isPostingWindowOpen } from '@/utils/liveWindow';

describe('liveWindow', () => {
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
