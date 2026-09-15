/**
 * Unit Tests for Geofencing Utilities
 *
 * Tests for geofencing.ts (distance calculations and geofencing)
 */

import { describe, expect, it, jest } from '@jest/globals';
import {
  calculateDistance,
  isWithinGeofence,
  isPostingWindowOpen,
  deriveEventLiveStatus,
} from '../lib/geofencing.js';

describe('Geofencing Utilities', () => {
  describe('calculateDistance', () => {
    it('should calculate distance in miles by default', () => {
      // NYC to Philadelphia (approximately 80-95 miles depending on route)
      const nycLat = 40.7128;
      const nycLon = -74.006;
      const phillyLat = 39.9526;
      const phillyLon = -75.1652;

      const distance = calculateDistance(nycLat, nycLon, phillyLat, phillyLon);

      // Allow wider range for different calculation methods
      expect(distance).toBeGreaterThan(75);
      expect(distance).toBeLessThan(100);
    });

    it('should calculate distance in kilometers when specified', () => {
      // NYC to Philadelphia
      const nycLat = 40.7128;
      const nycLon = -74.006;
      const phillyLat = 39.9526;
      const phillyLon = -75.1652;

      const distanceKm = calculateDistance(nycLat, nycLon, phillyLat, phillyLon, 'km');
      const distanceMiles = calculateDistance(nycLat, nycLon, phillyLat, phillyLon, 'miles');

      // 1 mile ≈ 1.609 km
      expect(distanceKm).toBeGreaterThan(distanceMiles * 1.5);
      expect(distanceKm).toBeLessThan(distanceMiles * 1.7);
    });

    it('should return 0 for same point', () => {
      const lat = 40.7128;
      const lon = -74.006;

      const distance = calculateDistance(lat, lon, lat, lon);

      expect(distance).toBe(0);
    });

    it('should handle very small distances', () => {
      // Two points very close together (about 0.1 miles)
      const lat1 = 40.7128;
      const lon1 = -74.006;
      const lat2 = 40.713;
      const lon2 = -74.006;

      const distance = calculateDistance(lat1, lon1, lat2, lon2);

      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(1);
    });
  });

  describe('isWithinGeofence', () => {
    const pointNorthByKm = (
      startLat: number,
      startLon: number,
      targetKm: number,
      delta = 0.000001
    ) => {
      let low = startLat;
      let high = startLat + 0.1;
      while (calculateDistance(startLat, startLon, high, startLon, 'km') < targetKm) {
        high += 0.1;
      }
      for (let i = 0; i < 40; i += 1) {
        const mid = (low + high) / 2;
        const distance = calculateDistance(startLat, startLon, mid, startLon, 'km');
        if (distance < targetKm) {
          low = mid;
        } else {
          high = mid;
        }
      }
      return {
        atEdgeLat: low,
        justOutsideLat: high + delta,
      };
    };

    it('should return true when user is within default radius (0.5 miles)', () => {
      // User at venue (same location)
      const userLat = 40.7128;
      const userLon = -74.006;
      const eventLat = 40.7128;
      const eventLon = -74.006;

      const within = isWithinGeofence(userLat, userLon, eventLat, eventLon);

      expect(within).toBe(true);
    });

    it('should return false when user is outside default radius', () => {
      // User far away (NYC to Philadelphia is ~95 miles)
      const userLat = 39.9526; // Philadelphia
      const userLon = -75.1652;
      const eventLat = 40.7128; // NYC
      const eventLon = -74.006;

      const within = isWithinGeofence(userLat, userLon, eventLat, eventLon);

      expect(within).toBe(false);
    });

    it('should respect custom radius', () => {
      // User about 0.3 miles away (within 2 mile radius)
      const userLat = 40.715;
      const userLon = -74.006;
      const eventLat = 40.7128;
      const eventLon = -74.006;

      const within = isWithinGeofence(userLat, userLon, eventLat, eventLon, 2);

      expect(within).toBe(true);
    });

    it('should return true when exactly at radius boundary (same location)', () => {
      // User at exact same location as event
      const userLat = 40.7128;
      const userLon = -74.006;
      const eventLat = 40.7128;
      const eventLon = -74.006;

      const within = isWithinGeofence(userLat, userLon, eventLat, eventLon, 0.5);

      expect(within).toBe(true);
    });

    it('should allow a point exactly at the 1 km boundary and reject just beyond it', () => {
      const eventLat = 40.7128;
      const eventLon = -74.006;
      const { atEdgeLat, justOutsideLat } = pointNorthByKm(eventLat, eventLon, 1);

      expect(isWithinGeofence(atEdgeLat, eventLon, eventLat, eventLon, 1)).toBe(true);
      expect(isWithinGeofence(justOutsideLat, eventLon, eventLat, eventLon, 1)).toBe(false);
    });

    it('should allow a point exactly at the 3 km boundary and reject just beyond it', () => {
      const eventLat = 40.7128;
      const eventLon = -74.006;
      const { atEdgeLat, justOutsideLat } = pointNorthByKm(eventLat, eventLon, 3);

      expect(isWithinGeofence(atEdgeLat, eventLon, eventLat, eventLon, 3)).toBe(true);
      expect(isWithinGeofence(justOutsideLat, eventLon, eventLat, eventLon, 3)).toBe(false);
    });
  });

  describe('isPostingWindowOpen', () => {
    // Logic: windowOpenTime = eventTime - 24 hours
    // Returns: now >= windowOpenTime
    // So if event is 25 hours away: windowOpenTime = now + 1h, now >= now+1h = false
    // If event is 23 hours away: windowOpenTime = now - 1h, now >= now-1h = true

    it('should return false when event is more than 24 hours away', () => {
      const now = new Date();
      const eventDate = new Date(now.getTime() + 25 * 60 * 60 * 1000); // 25 hours from now

      const isOpen = isPostingWindowOpen(eventDate);

      // Window opens exactly 24 hours before, so 25 hours before is still closed
      expect(isOpen).toBe(false);
    });

    it('should return true when event is less than 24 hours away', () => {
      const now = new Date();
      const eventDate = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours from now

      const isOpen = isPostingWindowOpen(eventDate);

      // Window opened 12 hours ago (24h - 12h = 12h before now), so posting is open
      expect(isOpen).toBe(true);
    });

    it('should return true when event is in the past', () => {
      const now = new Date();
      const eventDate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago

      const isOpen = isPostingWindowOpen(eventDate);

      // Past events: windowOpenTime was in the past, so now >= past = true
      expect(isOpen).toBe(true);
    });
  });

  describe('deriveEventLiveStatus', () => {
    it('returns null for a missing or invalid date', () => {
      expect(deriveEventLiveStatus(null)).toBeNull();
      expect(deriveEventLiveStatus('not-a-date')).toBeNull();
    });

    it('returns scheduled before the live window opens', () => {
      const eventDate = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h out, window opens at 2h
      expect(deriveEventLiveStatus(eventDate)).toBe('scheduled');
    });

    it('returns in_progress inside the live window', () => {
      const eventDate = new Date(Date.now() - 1 * 60 * 60 * 1000); // started 1h ago
      expect(deriveEventLiveStatus(eventDate)).toBe('in_progress');
    });

    it('returns finished once the live window (and grace) has closed', () => {
      const eventDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // a month ago
      expect(deriveEventLiveStatus(eventDate)).toBe('finished');
    });

    it('respects a per-event live_window_hours_after_start override', () => {
      // 10h after start, default window would already be closed (6h after start)
      // but an 18h override (e.g. an all-day coach event) keeps it in_progress.
      const eventDate = new Date(Date.now() - 10 * 60 * 60 * 1000);
      expect(deriveEventLiveStatus(eventDate, 6)).toBe('finished');
      expect(deriveEventLiveStatus(eventDate, 18)).toBe('in_progress');
    });
  });
});
