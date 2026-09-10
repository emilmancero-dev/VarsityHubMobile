/**
 * Test endpoints for push notifications and geofencing
 * Remove this file in production or protect with admin auth
 */

import { Router } from 'express';
import {
  calculateDistance,
  isWithinGeofence,
  verifyEventPostingPermission,
} from '../lib/geofencing.js';
import {
  notifyNewFollower,
  notifyNewMessage,
  notifyPostInteraction,
  sendPushNotification,
} from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { logAdminActivityFromReq } from '../lib/adminActivityLogger.js';

export const testNotificationsRouter = Router();

// Test: Send a basic push notification to yourself
testNotificationsRouter.post(
  '/test/push',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      await sendPushNotification(
        req.user!.id,
        'Test Notification 🎉',
        'If you see this, push notifications are working!',
        { type: 'test', timestamp: new Date().toISOString() }
      );

      await logAdminActivityFromReq(
        req,
        'TEST_PUSH_NOTIFICATION',
        'notification',
        req.user!.id,
        'Sent admin-triggered test push notification',
        { target_user_id: req.user!.id }
      );

      res.json({
        success: true,
        message: 'Test notification sent! Check your device.',
      });
    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to send notification',
      });
    }
  })
);

// Test: Check if user has a valid push token
testNotificationsRouter.get(
  '/test/check-token',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          email: true,
          display_name: true,
          preferences: true,
        },
      });

      const prefs = user?.preferences as any;
      const token = prefs?.push_token;
      const notificationsEnabled = prefs?.notifications_enabled !== false;

      res.json({
        has_token: !!token,
        token_preview: token ? `${token.substring(0, 20)}...` : null,
        notifications_enabled: notificationsEnabled,
        status: token ? '✅ Ready to receive notifications' : '❌ No push token registered',
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Test: Simulate different notification types
testNotificationsRouter.post(
  '/test/simulate/:type',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { type } = req.params;
    const userId = req.user!.id;

    try {
      switch (type) {
        case 'message':
          await notifyNewMessage(userId, userId, 'Test User', 'This is a test direct message!');
          break;

        case 'like':
          await notifyPostInteraction(userId, 'like', userId, 'Test User', 'post_test_123');
          break;

        case 'comment':
          await notifyPostInteraction(userId, 'comment', userId, 'Test User', 'post_test_123');
          break;

        case 'follow':
          await notifyNewFollower(userId, userId, 'Test User');
          break;

        default:
          return res
            .status(400)
            .json({ error: 'Invalid type. Use: message, like, comment, or follow' });
      }

      await logAdminActivityFromReq(
        req,
        'TEST_SIMULATED_NOTIFICATION',
        'notification',
        userId,
        `Sent simulated ${type} notification`,
        { type, target_user_id: userId }
      );

      res.json({
        success: true,
        message: `Sent ${type} notification! Check your device.`,
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Test: Check geofencing for an event
testNotificationsRouter.post(
  '/test/geofence',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { event_id, lat, lng } = req.body;

    if (!event_id || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({
        error: 'Provide event_id, lat, and lng',
        example: {
          event_id: 'evt_123',
          lat: 34.0522,
          lng: -118.2437,
        },
      });
    }

    try {
      const result = await verifyEventPostingPermission(event_id, req.user!.id, lat, lng);

      // Get event details for context
      const event = await prisma.event.findUnique({
        where: { id: event_id },
        select: { title: true, location: true, latitude: true, longitude: true, date: true },
      });

      await logAdminActivityFromReq(
        req,
        'TEST_GEOFENCE_CHECK',
        'event',
        String(event_id),
        'Ran admin geofence test',
        { event_id, lat, lng, allowed: result.allowed, reason: result.reason }
      );

      res.json({
        allowed: result.allowed,
        reason: result.reason,
        distance_miles: result.distance,
        event: {
          title: event?.title,
          location: event?.location,
          event_coords: { lat: event?.latitude, lng: event?.longitude },
          your_coords: { lat, lng },
        },
        posting_window_open: event?.date
          ? new Date() >= new Date(new Date(event.date).getTime() - 24 * 60 * 60 * 1000)
          : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Test: Calculate distance between two points
testNotificationsRouter.post('/test/distance', requireAdmin as any, (req, res) => {
  const { lat1, lng1, lat2, lng2 } = req.body;

  if (
    typeof lat1 !== 'number' ||
    typeof lng1 !== 'number' ||
    typeof lat2 !== 'number' ||
    typeof lng2 !== 'number'
  ) {
    return res.status(400).json({
      error: 'Provide lat1, lng1, lat2, lng2 as numbers',
      example: {
        lat1: 34.0522,
        lng1: -118.2437,
        lat2: 34.0622,
        lng2: -118.2537,
      },
    });
  }

  const distanceMiles = calculateDistance(lat1, lng1, lat2, lng2, 'miles');
  const distanceKm = calculateDistance(lat1, lng1, lat2, lng2, 'km');
  const withinHalfMile = isWithinGeofence(lat1, lng1, lat2, lng2, 0.5);

  void logAdminActivityFromReq(
    req,
    'TEST_DISTANCE_CHECK',
    'geofence',
    'distance',
    'Ran admin distance calculation test',
    { lat1, lng1, lat2, lng2, withinHalfMile }
  );

  res.json({
    distance_miles: distanceMiles.toFixed(2),
    distance_km: distanceKm.toFixed(2),
    within_geofence: withinHalfMile,
    geofence_radius: '0.5 miles',
  });
});

// Test: Get all upcoming games that would trigger notifications
testNotificationsRouter.get(
  '/test/upcoming-games',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const now = new Date();
      const twelveHoursFromNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);
      const oneHourFromNow = new Date(now.getTime() + 1 * 60 * 60 * 1000);

      const [games12h, games1h] = await Promise.all([
        // audit-allow unbounded: bounded by 10-minute date window plus single-user RSVP filter
        prisma.event.findMany({
          where: {
            date: {
              gte: new Date(twelveHoursFromNow.getTime() - 5 * 60 * 1000),
              lte: new Date(twelveHoursFromNow.getTime() + 5 * 60 * 1000),
            },
            status: 'approved',
            rsvps: {
              some: {
                user_id: req.user!.id,
              },
            },
          },
          select: {
            id: true,
            title: true,
            date: true,
            location: true,
          },
          take: 100,
        }),
        // audit-allow unbounded: bounded by 10-minute date window plus single-user RSVP filter
        prisma.event.findMany({
          where: {
            date: {
              gte: new Date(oneHourFromNow.getTime() - 5 * 60 * 1000),
              lte: new Date(oneHourFromNow.getTime() + 5 * 60 * 1000),
            },
            status: 'approved',
            rsvps: {
              some: {
                user_id: req.user!.id,
              },
            },
          },
          select: {
            id: true,
            title: true,
            date: true,
            location: true,
          },
          take: 100,
        }),
      ]);

      await logAdminActivityFromReq(
        req,
        'TEST_UPCOMING_GAMES_CHECK',
        'notification',
        req.user!.id,
        'Checked upcoming reminder-eligible games',
        { games_in_12_hours: games12h.length, games_in_1_hour: games1h.length }
      );

      res.json({
        current_time: now.toISOString(),
        games_in_12_hours: games12h.length,
        games_in_1_hour: games1h.length,
        would_receive_12h_reminder: games12h,
        would_receive_1h_reminder: games1h,
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);
