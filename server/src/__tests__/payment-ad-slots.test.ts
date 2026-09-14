import { describe, expect, it, jest } from '@jest/globals';

import { getFullAdSlotDates } from '../lib/paymentInternals.js';

describe('getFullAdSlotDates', () => {
  it('returns dates that have reached the shared ad slot cap', async () => {
    const db = {
      ad: {
        findMany: jest.fn(async () => [{ id: 'ad-2' }, { id: 'ad-3' }]),
      },
      adReservation: {
        groupBy: jest.fn(async () => [
          { date: new Date('2026-07-01T00:00:00.000Z'), _count: { date: 2 } },
          { date: new Date('2026-07-02T00:00:00.000Z'), _count: { date: 1 } },
        ]),
      },
    } as any;

    await expect(
      getFullAdSlotDates(db, {
        adId: 'ad-1',
        targetZipCode: '10001',
        isoDates: ['2026-07-01', '2026-07-02'],
      })
    ).resolves.toEqual(['2026-07-01']);

    expect(db.ad.findMany).toHaveBeenCalledWith({
      where: {
        target_zip_code: '10001',
        payment_status: { in: ['paid', 'hold', 'pending_approval'] },
        NOT: { id: 'ad-1' },
      },
      select: { id: true },
      take: 100,
    });
  });

  it('counts a booking in a touching NEIGHBORING zip toward the same 2-slot cap (owner "commandments" fairness rule, 2026-09-14)', async () => {
    // 10001 and 10002 are both Manhattan zips — well within the 9km ad radius
    // of each other, so their circles overlap ("touching").
    const db = {
      ad: {
        findMany: jest.fn(async (args: any) => {
          if (args.where.target_zip_code === '10001') {
            // Exact-zip query: no same-zip competitors.
            return [];
          }
          // Bounding-box "nearby zip" query: one ad booked in the touching
          // neighbor 10002.
          return [{ id: 'ad-neighbor', target_lat: 40.7128, target_lng: -73.9972 }];
        }),
      },
      adReservation: {
        groupBy: jest.fn(async () => [
          { date: new Date('2026-07-01T00:00:00.000Z'), _count: { date: 1 } },
        ]),
      },
    } as any;

    const full = await getFullAdSlotDates(db, {
      adId: 'ad-1',
      targetZipCode: '10001',
      isoDates: ['2026-07-01'],
    });

    // 1 slot already taken by the neighboring zip is not yet "full" (cap is
    // 2) — this asserts the neighbor's reservation was actually counted at
    // all, i.e. adReservation.groupBy was queried with the neighbor's ad id.
    expect(full).toEqual([]);
    expect(db.adReservation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ad_id: { in: expect.arrayContaining(['ad-neighbor']) } }),
      })
    );
  });

  it('does NOT count a booking in a far-away zip toward the cap', async () => {
    // 10001 (NYC) vs 90001 (LA) — thousands of miles apart, radii never touch.
    const db = {
      ad: {
        findMany: jest.fn(async (args: any) => {
          if (args.where.target_zip_code === '10001') return [];
          return [{ id: 'ad-far', target_lat: 34.05, target_lng: -118.25 }];
        }),
      },
      adReservation: { groupBy: jest.fn() },
    } as any;

    const full = await getFullAdSlotDates(db, {
      adId: 'ad-1',
      targetZipCode: '10001',
      isoDates: ['2026-07-01'],
    });

    expect(full).toEqual([]);
    // No competing ads at all (same-zip empty, far-zip filtered out) — the
    // function short-circuits before ever querying reservations.
    expect(db.adReservation.groupBy).not.toHaveBeenCalled();
  });

  it('skips reservation lookup when there is no target zip or no competition', async () => {
    const db = {
      ad: { findMany: jest.fn(async () => []) },
      adReservation: { groupBy: jest.fn() },
    } as any;

    await expect(
      getFullAdSlotDates(db, { adId: 'ad-1', targetZipCode: null, isoDates: ['2026-07-01'] })
    ).resolves.toEqual([]);
    expect(db.ad.findMany).not.toHaveBeenCalled();

    await expect(
      getFullAdSlotDates(db, { adId: 'ad-1', targetZipCode: '10001', isoDates: ['2026-07-01'] })
    ).resolves.toEqual([]);
    expect(db.adReservation.groupBy).not.toHaveBeenCalled();
  });
});
