import escapeHtml from 'escape-html';
import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  AD_GEOFENCE_RADIUS_KM,
  AD_GEOFENCE_RADIUS_MILES,
  getAdBoundingBoxDegrees,
} from '../lib/adGeofencing.js';
import { releaseExpiredPendingApprovalReservationsForAd } from '../lib/adReservationLifecycle.js';
import { APP_REVIEW_EMAIL } from '../lib/appReviewFixture.js';
import {
  approveAd as approveAdService,
  rejectAd as rejectAdService,
} from '../lib/approvalService.js';
import { sendAdPendingReviewEmail } from '../lib/email.js';
import { getZipCoordinates, haversineDistance } from '../lib/geoUtils.js';
import { geocodeLocation } from '../lib/geocoding.js';
import { logAdminActivity } from '../lib/adminActivityLogger.js';
import { prisma } from '../lib/prisma.js';
import {
  consumeReviewToken,
  getReviewTokenReplayState,
  verifyReviewToken,
  type ReviewTokenPayload,
} from '../lib/reviewTokens.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { addBreadcrumb } from '../lib/sentry.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  adCreationLimiter,
  adEngagementLimiter,
  adModerationLimiter,
  alternativeZipsLimiter,
} from '../middleware/rateLimiters.js';
import { getIsAdmin, requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { debugLog } from '../lib/debugLog.js';

async function isAppReviewDemoUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return (
    String(user?.email || '')
      .trim()
      .toLowerCase() === APP_REVIEW_EMAIL.toLowerCase()
  );
}

const adCreateSchema = z.object({
  contact_name: z.string().min(1).max(200),
  contact_email: z.string().email().max(320),
  business_name: z.string().min(1).max(200),
  banner_url: z.string().url().max(2048).nullish(),
  banner_fit_mode: z.enum(['cover', 'contain', 'fill']).nullish(),
  target_url: z
    .string()
    .url()
    .max(2048)
    .refine(url => /^https:\/\//i.test(url), { message: 'target_url must use https protocol' })
    .nullish(),
  cta_text: z.string().max(50).nullish(),
  target_zip_code: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\s\-]{0,10}[A-Za-z0-9]$/, 'Must be a valid postal code'),
  radius: z.number().optional(),
  description: z.string().max(1000).nullish(),
});

const adUpdateSchema = z.object({
  contact_name: z.string().min(1).max(200).optional(),
  contact_email: z.string().email().max(320).optional(),
  business_name: z.string().min(1).max(200).optional(),
  banner_url: z.string().url().max(2048).nullish(),
  banner_fit_mode: z.enum(['cover', 'contain', 'fill']).nullish(),
  target_url: z
    .string()
    .url()
    .max(2048)
    .refine(url => /^https:\/\//i.test(url), { message: 'target_url must use https protocol' })
    .nullish(),
  cta_text: z.string().max(50).nullish(),
  target_zip_code: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\s\-]{0,10}[A-Za-z0-9]$/, 'Must be a valid postal code')
    .optional(),
  radius: z.number().optional(),
  description: z.string().max(1000).nullish(),
  // status intentionally excluded — owners cannot set status directly.
  // Status transitions: banner change → 'pending' (auto), admin approve → 'active', admin reject → 'rejected'.
});

/**
 * Get coordinates for a ZIP code with fallback to Google Geocoding API
 * First tries the static lookup table, then falls back to API if not found
 */
async function getZipCoordinatesWithFallback(
  zipCode: string
): Promise<{ lat: number; lon: number } | null> {
  // Try static lookup first (faster, no API call)
  const staticResult = getZipCoordinates(zipCode);
  if (staticResult) {
    return staticResult;
  }

  // Fall back to Google Geocoding API for ZIP codes not in static table
  debugLog('[ads] ZIP code not in static table, trying Google Geocoding:', zipCode);
  const geocodeResult = await geocodeLocation(zipCode);
  if (geocodeResult) {
    return { lat: geocodeResult.latitude, lon: geocodeResult.longitude };
  }

  return null;
}

export const adsRouter = Router();
registerIdValidation(adsRouter);

async function normalizePendingApprovalAdsForResponse<
  T extends { id: string; status?: string | null; payment_status?: string | null },
>(list: T[]): Promise<T[]> {
  const candidates = list.filter(ad => ad.payment_status === 'pending_approval');
  if (candidates.length === 0) return list;

  const cleanupById = new Map(
    (
      await Promise.all(
        candidates.map(
          async ad =>
            [ad.id, await releaseExpiredPendingApprovalReservationsForAd(prisma, ad.id)] as const
        )
      )
    ).map(([id, result]) => [id, result])
  );

  return list.map(ad => {
    const cleanup = cleanupById.get(ad.id);
    if (!cleanup || !cleanup.changed) return ad;
    return {
      ...ad,
      status: cleanup.status,
      payment_status: cleanup.paymentStatus,
    };
  });
}

async function loadAdImageModeration() {
  return import('../lib/adImageModeration.js');
}

// One-time backfill: populate target_lat/target_lng for existing ads that predate the column.
// Safe to repeat (skips ads already populated). Kept explicit so importing the
// router never mutates data during tests or verification.
export async function runAdsStartupBackfill(): Promise<void> {
  try {
    const unresolved = await prisma.ad.findMany({
      where: { target_zip_code: { not: null }, target_lat: null },
      select: { id: true, target_zip_code: true },
      take: 500,
    });
    if (unresolved.length === 0) return;
    debugLog(`[ads] backfill: resolving coords for ${unresolved.length} ads`);
    // Deduplicate by zip code — fetch coords once per unique zip, then batch update
    const uniqueZips = [...new Set(unresolved.map(a => a.target_zip_code!))];
    const coordsByZip = new Map<string, { lat: number; lon: number }>();
    for (const zip of uniqueZips) {
      const coords = await getZipCoordinatesWithFallback(zip);
      if (coords) coordsByZip.set(zip, coords);
    }
    // Group ads by zip and batch-update in chunks of 100
    const BATCH = 100;
    const updates = unresolved.filter(a => coordsByZip.has(a.target_zip_code!));
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      await prisma.$transaction(
        chunk.map(ad => {
          const c = coordsByZip.get(ad.target_zip_code!)!;
          return prisma.ad.update({
            where: { id: ad.id },
            data: { target_lat: c.lat, target_lng: c.lon },
          });
        })
      );
    }
    debugLog('[ads] backfill: done');
  } catch (err) {
    console.warn('[ads] backfill failed (non-fatal):', (err as any)?.message || err);
  }
}

// Create an ad draft — authenticated users may book ads without onboarding or plan gates.
adsRouter.post(
  '/',
  requireAuth as any,
  adCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { payment_status: _ps, status: _st, ...safeBody } = req.body || {};
    const parsed = adCreateSchema.safeParse(safeBody);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const {
      contact_name,
      contact_email,
      business_name,
      banner_url,
      banner_fit_mode,
      target_url,
      cta_text,
      target_zip_code,
      description,
    } = parsed.data;

    const safeContactName = stripHtml(contact_name);
    const safeBusinessName = stripHtml(business_name);
    const safeCtaText = cta_text != null ? stripHtml(cta_text) : cta_text;
    const safeDescription = description != null ? stripHtml(description) : description;

    const zipCoords = await getZipCoordinatesWithFallback(target_zip_code);
    const bypassApproval = await isAppReviewDemoUser(req.user?.id);
    const ad = await prisma.ad.create({
      data: {
        user_id: req.user?.id,
        contact_name: safeContactName,
        contact_email,
        business_name: safeBusinessName,
        banner_url: banner_url ?? null,
        banner_fit_mode: banner_fit_mode ?? null,
        target_url: target_url ?? null,
        cta_text: safeCtaText ?? null,
        target_zip_code,
        target_lat: zipCoords?.lat ?? null,
        target_lng: zipCoords?.lon ?? null,
        radius: AD_GEOFENCE_RADIUS_KM, // Fixed 9 km radius for all ads
        description: safeDescription ?? null,
        status: bypassApproval ? 'approved' : 'draft',
        payment_status: 'unpaid',
        ...(bypassApproval
          ? {
              admin_note:
                'Auto-approved for App Review demo account to keep review checkout unblocked.',
            }
          : {}),
      },
    });
    return res.status(201).json(ad);
  })
);

// Submit ad draft for admin review — authenticated users may continue without onboarding or plan gates.
async function handleAdSubmitForApproval(req: AuthedRequest, res: Response) {
  try {
    const id = String(req.params.id).trim();
    if (!id || id.length < 10 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid ad ID' });
    }
    const ad = await prisma.ad.findUnique({ where: { id } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.user_id !== req.user!.id) return res.status(403).json({ error: 'Not authorized' });
    const bypassApproval = await isAppReviewDemoUser(req.user?.id);
    if (ad.status !== 'draft') {
      if (!bypassApproval) {
        return res
          .status(400)
          .json({ error: `Ad status is '${ad.status}'. Submit for approval only from draft.` });
      }
    }

    // Review is now content-only. Dates belong to booking/checkout after the
    // media has been approved, so clear any legacy reservations here instead of
    // carrying stale dates through the moderation workflow.
    if (bypassApproval) {
      await prisma.ad.update({
        where: { id },
        data: {
          status: 'approved',
          payment_status: ad.payment_status === 'pending_approval' ? 'unpaid' : ad.payment_status,
          admin_note:
            'Auto-approved for App Review demo account to keep review checkout unblocked.',
        },
      });
    } else {
      await prisma.$transaction(
        async tx => {
          await tx.ad.update({
            where: { id },
            data: { status: 'pending', payment_status: 'pending_approval' },
          });
          await tx.adReservation.deleteMany({ where: { ad_id: id } });
        },
        { isolationLevel: 'Serializable' as any }
      );
    }

    let updated = await prisma.ad.findUnique({ where: { id }, include: { reservations: true } });
    if (updated?.banner_url) {
      const { moderateAndStoreAdBanner } = await loadAdImageModeration();
      await moderateAndStoreAdBanner(updated.id, updated.banner_url);
      updated = await prisma.ad.findUnique({ where: { id }, include: { reservations: true } });
    }

    if (!bypassApproval) {
      const { getApprovalNotificationEmails } = await import('../lib/adminEmails.js');
      const adminEmails = getApprovalNotificationEmails();
      void Promise.all(
        adminEmails.map(to =>
          sendAdPendingReviewEmail({
            to,
            businessName: updated?.business_name || ad.business_name || undefined,
            contactName: updated?.contact_name || ad.contact_name || undefined,
            contactEmail: updated?.contact_email || ad.contact_email || undefined,
            zipCode: updated?.target_zip_code || ad.target_zip_code || undefined,
            bannerUrl: updated?.banner_url || ad.banner_url || undefined,
            adId: id,
          }).then(sent => {
            if (!sent) {
              console.error(
                '[ads] submit-for-approval email returned false — email NOT delivered for ad',
                { adId: id, to }
              );
            }
          })
        )
      ).catch(err =>
        console.error('[ads] submit-for-approval email failed:', (err as any)?.message || err)
      );
    }

    return res.status(200).json(updated);
  } catch (err) {
    console.error('[ads] POST /:id/submit-for-approval error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

adsRouter.post('/:id/submit-for-approval', requireAuth as any, handleAdSubmitForApproval);

// List Ads. If mine=1, returns ads for the authenticated user. If contact_email is provided, returns by email.
adsRouter.get(
  '/',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const mine = String(req.query.mine || '') === '1';
    const contactEmail = req.query.contact_email ? String(req.query.contact_email) : undefined;
    const all = String(req.query.all || '') === '1';
    const where: any = {};

    debugLog('[ads] GET / query params:', {
      mine,
      contactEmail,
      all,
      userId: req.user?.id,
      queryMine: req.query.mine,
    });

    if (mine) {
      if (!req.user?.id) {
        console.warn('[ads] GET / mine=1 but no user authenticated');
        return res.status(401).json({ error: 'Auth required' });
      }
      where.user_id = req.user.id;
      debugLog('[ads] GET / filtering by user_id:', req.user.id);
    } else if (contactEmail) {
      // SECURITY: Only allow querying by contact_email if the user is an admin
      // or if the email belongs to the authenticated user. This prevents IDOR
      // where any user could enumerate ads by guessing email addresses.
      const isAdmin = await getIsAdmin(req as any);
      if (!isAdmin) {
        // Non-admins can only see their own ads (by user_id), not query by arbitrary email
        if (!req.user?.id) return res.status(401).json({ error: 'Auth required' });
        where.user_id = req.user.id;
        where.contact_email = contactEmail;
      } else {
        where.contact_email = contactEmail;
      }
    } else if (all) {
      const isAdmin = await getIsAdmin(req as any);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      // return all ads
      const list = await prisma.ad.findMany({ orderBy: { created_at: 'desc' }, take: 200 });
      const normalizedList = await normalizePendingApprovalAdsForResponse(list);
      debugLog('[ads] GET / admin all ads count:', list.length);
      return res.json(normalizedList);
    } else {
      // SECURITY: Default to requiring authentication and returning user's ads only
      debugLog('[ads] GET / no filter provided, defaulting to user ads only');
      if (!req.user?.id) {
        console.warn('[ads] GET / no filter and no user authenticated, returning empty');
        return res.json([]);
      }
      // Default to showing only the authenticated user's ads
      where.user_id = req.user.id;
    }

    const list = await prisma.ad.findMany({ where, orderBy: { created_at: 'desc' }, take: 100 });
    const normalizedList = await normalizePendingApprovalAdsForResponse(list);
    debugLog('[ads] GET / returning ads:', {
      count: normalizedList.length,
      where,
      adIds: normalizedList.map(a => a.id),
      userIds: normalizedList.map(a => a.user_id),
    });
    return res.json(normalizedList);
  })
);

// Ads for feed: return ads with a reservation for a specific date (default: today), filtered by location radius.
// PUBLIC (optional auth): guests / logged-out web visitors must see active ads
// too (owner requirement — an ad may be shown to someone on the web app without
// an account). authMiddleware still populates req.user for token-bearers, so the
// minor gate below applies to signed-in minors; anonymous visitors are treated
// as general public and are filtered by location only.
adsRouter.get(
  '/for-feed',
  asyncHandler(async (req: AuthedRequest, res) => {
    // Age gate — under-18 SIGNED-IN users never see ads. Reads the canonical DOB
    // column with fallback to preferences.dob for users whose backfill hasn't run.
    // Guarded on req.user?.id so anonymous visitors skip it (age unknowable).
    let viewerPrefs: Record<string, unknown> | null = null;
    if (req.user?.id) {
      const me = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { date_of_birth: true, preferences: true },
      });
      if (me) {
        viewerPrefs =
          me.preferences && typeof me.preferences === 'object'
            ? (me.preferences as Record<string, unknown>)
            : null;
        const { isMinor } = await import('../lib/userAge.js');
        if (isMinor(me)) {
          return res.json({ date: new Date().toISOString().slice(0, 10), ads: [] });
        }
      }
    }

    const dateParam = req.query.date ? String(req.query.date) : undefined; // yyyy-MM-dd
    const zip = req.query.zip ? String(req.query.zip) : undefined;
    const lat = req.query.lat ? Number(req.query.lat) : undefined;
    const lng = req.query.lng ? Number(req.query.lng) : undefined;
    const limit = Math.max(1, Math.min(Number(req.query.limit || 1) || 1, 5));
    // Build date range [start, next)
    const dateISO = dateParam || new Date().toISOString().slice(0, 10);
    const start = new Date(dateISO + 'T00:00:00.000Z');
    const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    debugLog('[ads] for-feed query:', { dateParam, dateISO, zip, lat, lng, limit, start, next });

    // Validate zip format if provided (supports international postal codes)
    if (zip && !/^[A-Za-z0-9][A-Za-z0-9\s\-]{0,10}[A-Za-z0-9]$/.test(zip)) {
      return res.status(400).json({ error: 'Invalid postal code format' });
    }

    // Resolve user coordinates from zip or lat/lng
    let userCoords: { lat: number; lon: number } | null = null;
    if (zip) {
      userCoords = await getZipCoordinatesWithFallback(zip);
    } else if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
      userCoords = { lat, lon: lng };
    }

    // Fallback to the authenticated viewer's saved zip when the client sent no
    // usable location — mirrors /feed/bundle so older app builds that never
    // forward location still see their local ads. Anonymous visitors have no
    // profile zip (viewerPrefs is null), so they must supply a location via
    // query; otherwise the empty-location guard below returns no ads.
    if (!userCoords) {
      const profileZip =
        viewerPrefs && typeof viewerPrefs.zip_code === 'string' ? viewerPrefs.zip_code.trim() : '';
      if (profileZip) {
        userCoords = await getZipCoordinatesWithFallback(profileZip);
      }
    }

    debugLog('[ads] for-feed user coordinates:', userCoords);

    // If no user location, return empty — no untargeted/national ads
    if (!userCoords) {
      return res.json({ date: dateISO, ads: [] });
    }

    // DB-level bounding box: a padded prefilter around the viewer location using the shared 9 km radius.
    // This dramatically reduces rows fetched before the precise Haversine JS filter below.
    // Ads created before this column was added (target_lat IS NULL) fall back to JS-only filtering.
    const { lat: BBOX_LAT, lng: BBOX_LNG } = getAdBoundingBoxDegrees(userCoords.lat);
    const whereAd: any = {
      payment_status: 'paid',
      status: 'active',
      target_zip_code: { not: null },
      OR: [
        {
          target_lat: { gte: userCoords.lat - BBOX_LAT, lte: userCoords.lat + BBOX_LAT },
          target_lng: { gte: userCoords.lon - BBOX_LNG, lte: userCoords.lon + BBOX_LNG },
        },
        { target_lat: null }, // legacy ads without pre-computed coords
      ],
    };

    debugLog('[ads] for-feed where clause for ads:', whereAd);

    // Reservations are used only in `where: { reservations: { some: ... } }`
    // to filter ads with at least one matching booking. We do NOT include the
    // full reservation rows: with up to 56 days of reservations per ad and 20
    // ads returned, that was ~1100 row Cartesian product on every feed load.
    // The for-feed response shape (below) does not surface reservations to
    // clients; the per-ad detail endpoint hydrates them on demand.
    const ads = await prisma.ad.findMany({
      where: {
        ...whereAd,
        reservations: {
          some: { date: { gte: start, lt: next } },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        business_name: true,
        banner_url: true,
        banner_fit_mode: true,
        target_url: true,
        cta_text: true,
        target_zip_code: true,
        target_lat: true,
        target_lng: true,
        radius: true,
        description: true,
        status: true,
        payment_status: true,
        created_at: true,
      },
    });

    // Precise Haversine filter on the smaller bounding-box result set.
    // Modern ads have target_lat/target_lng pre-computed at create time and
    // do NOT need a geocoding lookup. Only legacy ads (target_lat IS NULL)
    // require an on-the-fly ZIP lookup. Filtering the unique-zip set to
    // those legacy rows means the geocoding loop is a no-op in the common
    // case (everything backfilled), instead of N requests per feed mount.
    const adZipCoords = new Map<string, { lat: number; lon: number }>();
    const legacyZips = [
      ...new Set(
        ads
          .filter(a => a.target_zip_code && (a.target_lat == null || a.target_lng == null))
          .map(a => a.target_zip_code!)
      ),
    ];
    if (legacyZips.length > 0) {
      await Promise.all(
        legacyZips.map(async zip => {
          const coords = await getZipCoordinatesWithFallback(zip);
          if (coords) adZipCoords.set(zip, coords);
        })
      );
    }

    const filtered = ads.filter(ad => {
      if (!ad.target_zip_code) return false;
      // Prefer stored coords; fall back to ZIP lookup for legacy ads
      const adCoords =
        ad.target_lat != null && ad.target_lng != null
          ? { lat: ad.target_lat, lon: ad.target_lng }
          : adZipCoords.get(ad.target_zip_code);
      if (!adCoords) return false;
      const dist = haversineDistance(userCoords!.lat, userCoords!.lon, adCoords.lat, adCoords.lon);
      return dist <= AD_GEOFENCE_RADIUS_MILES;
    });

    const result = filtered.slice(0, limit);

    debugLog('[ads] for-feed found ads:', {
      totalFetched: ads.length,
      afterFilter: filtered.length,
      returned: result.length,
      ads: result.map(ad => ({
        id: ad.id,
        payment_status: ad.payment_status,
        banner_url: !!ad.banner_url,
        target_zip_code: ad.target_zip_code,
        radius: ad.radius,
      })),
    });

    return res.json({
      date: dateISO,
      ads: result.map(ad => ({
        id: ad.id,
        business_name: ad.business_name,
        banner_url: ad.banner_url,
        banner_fit_mode: ad.banner_fit_mode,
        target_url: ad.target_url,
        target_zip_code: ad.target_zip_code,
        radius: ad.radius,
        description: ad.description,
        status: ad.status,
        payment_status: ad.payment_status,
        created_at: ad.created_at,
      })),
    });
  })
);

async function recordAdEngagement(id: string, type: 'impression' | 'click') {
  const now = new Date();
  const update =
    type === 'impression'
      ? {
          impression_count: { increment: 1 },
          last_impression_at: now,
        }
      : {
          click_count: { increment: 1 },
          last_click_at: now,
        };

  const updated = await prisma.ad.updateMany({
    where: {
      id,
      status: 'active',
      payment_status: 'paid',
    },
    data: update,
  });

  if (updated.count === 0) return null;

  return prisma.ad.findUnique({
    where: { id },
    select: {
      id: true,
      impression_count: true,
      click_count: true,
    },
  });
}

adsRouter.post(
  '/:id/impression',
  requireAuth as any,
  adEngagementLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const ad = await recordAdEngagement(String(req.params.id), 'impression');
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    return res.json({ ok: true, type: 'impression', ...ad });
  })
);

adsRouter.post(
  '/:id/click',
  requireAuth as any,
  adEngagementLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const ad = await recordAdEngagement(String(req.params.id), 'click');
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    return res.json({ ok: true, type: 'click', ...ad });
  })
);

// Get a single Ad with its reservations (dates)
adsRouter.get(
  '/:id([a-z0-9]{15,50})',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    let ad = await prisma.ad.findUnique({ where: { id } });
    if (!ad) return res.status(404).json({ error: 'Not found' });
    const isAdmin = await getIsAdmin(req);
    const isOwner = !!ad.user_id && ad.user_id === req.user!.id;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const bypassApproval = isOwner && (await isAppReviewDemoUser(req.user?.id));
    if (
      bypassApproval &&
      (ad.status === 'draft' || ad.status === 'pending' || ad.payment_status === 'pending_approval')
    ) {
      ad = await prisma.ad.update({
        where: { id },
        data: {
          status: 'approved',
          payment_status: ad.payment_status === 'pending_approval' ? 'unpaid' : ad.payment_status,
          admin_note:
            'Auto-approved for App Review demo account to keep review checkout unblocked.',
        },
      });
    }
    if (ad.payment_status === 'pending_approval') {
      const cleanup = await releaseExpiredPendingApprovalReservationsForAd(prisma, id);
      if (cleanup.changed) {
        ad = await prisma.ad.findUnique({ where: { id } });
        if (!ad) return res.status(404).json({ error: 'Not found' });
      }
    }
    const dates = await prisma.adReservation.findMany({
      where: { ad_id: id },
      orderBy: { date: 'asc' },
      take: 1000,
    });
    return res.json({ ...ad, dates: dates.map(r => r.date.toISOString().slice(0, 10)) });
  })
);

// Update an Ad (owner-only if authenticated)
adsRouter.put(
  '/:id([a-z0-9]{15,50})',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const ad = await prisma.ad.findUnique({ where: { id } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.user_id !== req.user!.id) return res.status(403).json({ error: 'Not authorized' });
    const bypassApproval = await isAppReviewDemoUser(req.user?.id);
    const { payment_status, status: _status, ...safeBody } = req.body || {};
    const parsed = adUpdateSchema.safeParse(safeBody);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    // Only include fields that were explicitly provided in the request
    const data: Record<string, any> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (k in safeBody) data[k] = v;
    }

    // Sanitize user-visible text fields to prevent stored XSS
    if (typeof data.contact_name === 'string') data.contact_name = stripHtml(data.contact_name);
    if (typeof data.business_name === 'string') data.business_name = stripHtml(data.business_name);
    if (typeof data.cta_text === 'string') data.cta_text = stripHtml(data.cta_text);
    if (typeof data.description === 'string') data.description = stripHtml(data.description);

    const businessNameChanged = 'business_name' in data && data.business_name !== ad.business_name;
    const descriptionChanged = 'description' in data && data.description !== ad.description;
    const textChanged = businessNameChanged || descriptionChanged;

    // (Content filtering removed — admin approval is the moderation gate.)
    void textChanged;

    // Populate lat/lng when zip code changes
    if ('target_zip_code' in data && data.target_zip_code) {
      const zipCoords = await getZipCoordinatesWithFallback(data.target_zip_code);
      data.target_lat = zipCoords?.lat ?? null;
      data.target_lng = zipCoords?.lon ?? null;
    }

    // Approved/live ads must go back through review when any user-visible content changes.
    const bannerChanged = 'banner_url' in data && data.banner_url !== ad.banner_url;
    const targetUrlChanged = 'target_url' in data && data.target_url !== ad.target_url;
    if (bannerChanged) {
      const { clearBannerModerationFields } = await loadAdImageModeration();
      Object.assign(data, clearBannerModerationFields());
    }
    const requiresReapproval =
      !bypassApproval &&
      ad.status !== 'draft' &&
      ((bannerChanged && data.banner_url) || targetUrlChanged || textChanged);
    if (requiresReapproval) {
      data.status = 'pending';
      data.admin_note =
        `[Auto] Content changed${ad.payment_status === 'paid' ? ' after payment' : ''}` +
        ` — business_name: ${businessNameChanged}, description: ${descriptionChanged},` +
        ` banner: ${bannerChanged}, target_url: ${targetUrlChanged}.` +
        ' Ad removed from feed pending re-approval.';
    }

    let updated = await prisma.ad.update({ where: { id }, data });
    const shouldModerateBannerNow = bannerChanged && !!updated.banner_url && requiresReapproval;
    if (shouldModerateBannerNow) {
      const { moderateAndStoreAdBanner } = await loadAdImageModeration();
      const remoderated = await moderateAndStoreAdBanner(updated.id, updated.banner_url);
      if (remoderated) updated = remoderated;
    }

    // Notify admin when content changes require another moderation pass.
    if (requiresReapproval) {
      const { getApprovalNotificationEmails } = await import('../lib/adminEmails.js');
      const adminEmails = getApprovalNotificationEmails();
      void Promise.all(
        adminEmails.map(to =>
          sendAdPendingReviewEmail({
            to,
            businessName: updated.business_name || undefined,
            contactName: updated.contact_name || undefined,
            contactEmail: updated.contact_email || undefined,
            zipCode: updated.target_zip_code || undefined,
            bannerUrl: updated.banner_url ?? undefined,
            adId: updated.id,
          }).then(sent => {
            if (!sent) {
              console.error('[ads] review email returned false — email NOT delivered for ad', {
                adId: updated.id,
                to,
              });
            }
          })
        )
      ).catch(err =>
        console.error('[ads] Failed to send review email:', (err as any)?.message || err)
      );
    }

    return res.json(updated);
  })
);

// Delete an ad (owner-only if authenticated). Owners should not be trapped by onboarding state.
adsRouter.delete(
  '/:id([a-z0-9]{15,50})',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    debugLog('[ads] DELETE /:id request', { id, userId: req.user?.id });

    const existing = await prisma.ad.findUnique({ where: { id } });
    if (!existing) {
      console.warn('[ads] DELETE /:id - Ad not found', { id });
      return res.status(404).json({ error: 'Not found' });
    }

    const isAdmin = await getIsAdmin(req);
    const isOwner = existing.user_id === req.user?.id;

    // Only the owner (or an admin) can delete. Ads without owner can no longer be deleted by any authenticated user.
    if (!isOwner && !isAdmin) {
      console.warn('[ads] DELETE /:id - Forbidden (user does not own ad)', {
        id,
        adUserId: existing.user_id,
        requestUserId: req.user?.id,
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Capture ad details for audit before deletion
    const auditData = {
      ad_id: id,
      business_name: existing.business_name,
      status: existing.status,
      payment_status: existing.payment_status,
      target_zip_code: existing.target_zip_code,
      deleted_by: req.user?.id,
      deleted_by_admin: isAdmin && !isOwner,
    };

    // Capture banner URL before deletion so we can destroy the Cloudinary
    // asset after the DB state is committed. Deleted ads that leave their
    // banner live on Cloudinary are both a cost drip and a privacy issue
    // (the URL is still publicly retrievable).
    const bannerUrl = existing.banner_url || null;

    // Delete reservations and ad in transaction, create audit log
    await prisma.$transaction([
      prisma.adReservation.deleteMany({ where: { ad_id: id } }),
      prisma.ad.delete({ where: { id } }),
      prisma.transactionLog.create({
        data: {
          transaction_type: 'AD_DELETED',
          status: 'COMPLETED',
          user_id: req.user?.id || null,
          order_id: `ad_delete_${id}`,
          metadata: auditData,
        },
      }),
    ]);
    debugLog('[ads] DELETE /:id - Ad deleted with audit trail', { id });

    // Fire-and-forget Cloudinary cleanup. Failure here must NOT rollback the
    // user's successful delete — the DB is the source of truth and the asset
    // just becomes an orphan that a future cleanup job can sweep.
    if (bannerUrl) {
      void (async () => {
        try {
          const { extractCloudinaryPublicId, destroyCloudinaryAsset } =
            await import('../lib/cloudinary.js');
          const parsed = extractCloudinaryPublicId(bannerUrl);
          if (!parsed) return;
          const result = await destroyCloudinaryAsset(parsed.publicId, parsed.resourceType);
          if (!result.ok) {
            console.warn(
              '[ads] Cloudinary destroy failed for deleted ad',
              id,
              parsed.publicId,
              result.error
            );
          }
        } catch (err) {
          console.warn('[ads] Cloudinary destroy threw for deleted ad', id, err);
        }
      })();
    }

    return res.json({ ok: true, message: 'Ad deleted successfully' });
  })
);

// List reserved dates. Supports optional range and/or specific ad_id.
adsRouter.get(
  '/reservations',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const adId = req.query.ad_id ? String(req.query.ad_id) : undefined;

    // IDOR fix: when ad_id provided, verify ownership (or admin)
    if (adId) {
      const ad = await prisma.ad.findUnique({
        where: { id: adId },
        select: { user_id: true, payment_status: true },
      });
      if (!ad) return res.status(404).json({ error: 'Ad not found' });
      const isAdmin = await getIsAdmin(req as any);
      if (ad.user_id !== req.user?.id && !isAdmin) {
        return res.status(403).json({ error: 'You can only view reservations for your own ads' });
      }
      if (ad.payment_status === 'pending_approval') {
        await releaseExpiredPendingApprovalReservationsForAd(prisma, adId);
      }
    }

    const where: any = {};
    if (from || to) where.date = {};
    if (from) where.date.gte = from;
    if (to) where.date.lte = to;
    if (adId) {
      where.ad_id = adId;
    } else {
      // No ad_id: scope to the requesting user's own ads only
      const isAdmin = await getIsAdmin(req as any);
      if (!isAdmin) {
        where.ad = { user_id: req.user!.id };
      }
    }

    debugLog('[ads] GET /reservations query:', { from, to, adId, where });

    const list = await prisma.adReservation.findMany({
      where,
      orderBy: { date: 'asc' },
      take: 1000,
    });
    const dates = list.map(r => r.date.toISOString().slice(0, 10));

    debugLog('[ads] Found reservations:', {
      adId,
      count: list.length,
      rawDates: list.map(r => ({ id: r.id, date: r.date, dateISO: r.date.toISOString() })),
      formattedDates: dates,
    });

    if (adId) return res.json({ ad_id: adId, dates });
    return res.json({ dates });
  })
);

/**
 * GET /ads/availability?zip=12345&from=2025-01-15&to=2025-01-31
 *
 * Returns availability status for each date in the range.
 * Each date can have up to 2 ads (slots). If 2 ads already exist, date is full.
 */
adsRouter.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const zipCode = req.query.zip
      ? String(req.query.zip)
      : req.query.zip_code
        ? String(req.query.zip_code)
        : undefined;
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    const excludeAdId = req.query.exclude_ad_id ? String(req.query.exclude_ad_id) : undefined;

    if (!zipCode || !from || !to) {
      return res.status(400).json({ error: 'zip, from, and to are required' });
    }

    const MAX_ADS_PER_DATE = 2; // Maximum ad slots per date

    // Parse date range
    const fromDate = new Date(from + 'T00:00:00.000Z');
    const toDate = new Date(to + 'T00:00:00.000Z');

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Get all ads for this zip code (paid, hold, pending_approval all hold slots)
    // Optionally exclude a specific ad (so editing an ad doesn't block its own dates)
    const adsInZip = await prisma.ad.findMany({
      where: {
        target_zip_code: zipCode,
        payment_status: { in: ['paid', 'hold', 'pending_approval'] },
        ...(excludeAdId ? { id: { not: excludeAdId } } : {}),
      },
      select: { id: true },
      take: 500,
    });

    const adIds = adsInZip.map(a => a.id);

    // Get all reservations for these ads in the date range
    const reservations = await prisma.adReservation.findMany({
      where: {
        ad_id: { in: adIds },
        date: {
          gte: fromDate,
          lte: toDate,
        },
      },
      select: {
        date: true,
        ad_id: true,
      },
      take: Math.max(
        adIds.length *
          (Math.floor((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) + 1),
        1
      ),
    });

    // Count ads per date
    const adCountByDate: Record<string, number> = {};

    reservations.forEach(r => {
      const dateISO = r.date.toISOString().slice(0, 10);
      adCountByDate[dateISO] = (adCountByDate[dateISO] || 0) + 1;
    });

    // Generate all dates in range and check availability
    const availability: Record<
      string,
      { available: boolean; slotsUsed: number; slotsRemaining: number }
    > = {};

    let currentDate = new Date(fromDate);
    while (currentDate <= toDate) {
      const dateISO = currentDate.toISOString().slice(0, 10);
      const slotsUsed = adCountByDate[dateISO] || 0;
      const slotsRemaining = MAX_ADS_PER_DATE - slotsUsed;

      availability[dateISO] = {
        available: slotsRemaining > 0,
        slotsUsed,
        slotsRemaining: Math.max(0, slotsRemaining),
      };

      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return res.json({
      zip: zipCode,
      from,
      to,
      maxSlotsPerDate: MAX_ADS_PER_DATE,
      availability,
    });
  })
);

// Create reservation for a set of dates (yyyy-MM-dd strings)
// SECURITY: Reservations must be created via payment flow (checkout/webhook). This endpoint
// previously allowed adding free dates to paid ads. Use 403 (not 410) so clients don't cache
// a permanent "gone" — endpoint may be repurposed; test-email-queue.sh previously used it.
adsRouter.post(
  '/reservations',
  requireVerified as any,
  asyncHandler(async (_req: AuthedRequest, res) => {
    return res.status(403).json({
      error: 'RESERVATIONS_VIA_CHECKOUT_ONLY',
      message:
        'Ad reservations must be created through the payment checkout flow. Use the Ad Calendar to select dates and pay.',
    });
  })
);

/**
 * GET /ads/alternative-zips?zip=12345&dates=2025-01-15,2025-01-16
 *
 * Find alternative zip codes within 50 miles when the requested zip is fully booked.
 * Returns nearby zips with availability for the requested dates, sorted by distance.
 */
adsRouter.get(
  '/alternative-zips',
  requireAuth as any,
  alternativeZipsLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { zip, dates } = req.query;

    if (!zip || !dates) {
      return res.status(400).json({ error: 'Missing required params: zip, dates' });
    }

    const zipCode = String(zip);
    const dateList = String(dates)
      .split(',')
      .map(d => d.trim());

    // Get coordinates for the requested zip (with Google Geocoding fallback)
    const originCoords = await getZipCoordinatesWithFallback(zipCode);
    if (!originCoords) {
      return res.status(400).json({
        error: 'Could not find coordinates for ZIP code. Please verify the ZIP code is valid.',
      });
    }

    const MAX_ADS_PER_DATE = 2;

    // Gather candidate zips from ads that currently hold capacity. Status cannot
    // be the filter here because pending/approved ads also reserve dates.
    const allAds = await prisma.ad.findMany({
      where: {
        payment_status: { in: ['paid', 'hold', 'pending_approval'] },
        target_zip_code: { not: null },
      },
      select: {
        id: true,
        target_zip_code: true,
      },
      take: 500,
    });

    // Calculate distances and group by zip code
    const zipDistances: Map<string, number> = new Map();

    // Pre-resolve unique ad ZIP coordinates (with Google fallback)
    const uniqueZips = [...new Set(allAds.map(a => a.target_zip_code).filter(Boolean))] as string[];
    const adZipMap = new Map<string, { lat: number; lon: number }>();
    await Promise.all(
      uniqueZips.map(async z => {
        const coords = await getZipCoordinatesWithFallback(z);
        if (coords) adZipMap.set(z, coords);
      })
    );

    for (const ad of allAds) {
      if (!ad.target_zip_code) continue;
      if (ad.target_zip_code === zipCode) continue;
      if (zipDistances.has(ad.target_zip_code)) continue;

      const adCoords = adZipMap.get(ad.target_zip_code);
      if (!adCoords) continue;

      const distance = haversineDistance(
        originCoords.lat,
        originCoords.lon,
        adCoords.lat,
        adCoords.lon
      );

      // Only consider zips within the ad visibility radius.
      if (distance <= AD_GEOFENCE_RADIUS_MILES) {
        zipDistances.set(ad.target_zip_code, distance);
      }
    }

    // Batch query: fetch all ads in nearby zips in a single query (avoids N+1)
    const nearbyZips = Array.from(zipDistances.keys());
    const allNearbyAds =
      nearbyZips.length > 0
        ? await prisma.ad.findMany({
            where: {
              target_zip_code: { in: nearbyZips },
              payment_status: { in: ['paid', 'hold', 'pending_approval'] },
            },
            select: {
              id: true,
              target_zip_code: true,
            },
            take: 200,
          })
        : [];

    const nearbyAdIds = allNearbyAds.map(ad => ad.id);
    const requestedDateObjects = dateList.map(date => new Date(`${date}T00:00:00.000Z`));
    const reservations =
      nearbyAdIds.length > 0
        ? await prisma.adReservation.findMany({
            where: {
              ad_id: { in: nearbyAdIds },
              date: { in: requestedDateObjects },
            },
            select: {
              ad_id: true,
              date: true,
            },
            take: Math.max(nearbyAdIds.length * requestedDateObjects.length, 1),
          })
        : [];

    const zipByAdId = new Map(allNearbyAds.map(ad => [ad.id, ad.target_zip_code || '']));
    const reservationCountsByZipDate = new Map<string, number>();

    for (const reservation of reservations) {
      const zip = zipByAdId.get(reservation.ad_id);
      if (!zip) continue;
      const dateIso = reservation.date.toISOString().slice(0, 10);
      const key = `${zip}:${dateIso}`;
      reservationCountsByZipDate.set(key, (reservationCountsByZipDate.get(key) || 0) + 1);
    }

    // Check availability for each nearby zip
    const alternatives: Array<{ zip: string; distance: number; available: boolean }> = [];

    for (const [nearbyZip, distance] of zipDistances.entries()) {
      const hasAvailability = dateList.every(date => {
        const key = `${nearbyZip}:${date}`;
        return (reservationCountsByZipDate.get(key) || 0) < MAX_ADS_PER_DATE;
      });

      alternatives.push({
        zip: nearbyZip,
        distance: Math.round(distance * 10) / 10,
        available: hasAvailability,
      });
    }

    // Sort by distance and filter to available only
    const availableAlternatives = alternatives
      .filter(a => a.available)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5); // Return top 5 closest alternatives

    return res.json({
      requested_zip: zipCode,
      alternatives: availableAlternatives,
    });
  })
);

// ── Shared helpers for ad moderation (used by POST, GET, and /review routes) ──

/**
 * Emit an AdminActivityLog row for an ad-moderation decision. Best-effort
 * (logAdminActivity swallows its own errors). The email-link review path has no
 * authenticated admin, so a null adminId is recorded under an 'email-token'
 * sentinel rather than being dropped — the trail stays complete either way.
 */
async function logAdModerationActivity(
  action: 'AD_APPROVE' | 'AD_REJECT',
  description: string,
  adId: string,
  adminId: string | null,
  note: string | null
) {
  let adminEmail = 'email-token';
  if (adminId) {
    const admin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { email: true },
    });
    adminEmail = admin?.email || 'unknown';
  }
  await logAdminActivity(
    adminId ?? 'email-token',
    adminEmail,
    action,
    'ad',
    adId,
    description,
    note ? { note } : undefined
  );
}

async function approveAd(
  id: string,
  note?: string | null,
  adminId?: string | null,
  bannerOverride?: { reason: string }
) {
  const result = await approveAdService(id, adminId || null, prisma, {
    note: note || undefined,
    bannerOverride,
  });
  // Only log a real decision — the service returns { error, status } on failure.
  if (!(result as any)?.error) {
    await logAdModerationActivity('AD_APPROVE', 'Approved ad', id, adminId || null, note || null);
  }
  return result;
}

async function rejectAd(id: string, reason?: string | null, adminId?: string | null) {
  // Thread the acting admin through so the service's self-reject IDOR guard is
  // live and the actor is recorded on refunds/notifications (was hardcoded null).
  const result = await rejectAdService(id, adminId || null, prisma, {
    reason: reason || undefined,
  });
  if (!(result as any)?.error) {
    await logAdModerationActivity('AD_REJECT', 'Rejected ad', id, adminId || null, reason || null);
  }
  return result;
}

/** Coerce a loose "true-ish" value into a boolean. Form checkboxes, JSON booleans,
 *  and hidden fields all flow through the same body, so accept the common shapes. */
function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  }
  return false;
}

/** Verify a signed moderation token and check it matches the ad + action */
function verifyModerationToken(token: string, adId: string, expectedAction: string) {
  const payload = verifyReviewToken<{ adId: string; action: string }>(token);
  if (!payload || payload.adId !== adId || payload.action !== expectedAction) {
    return null;
  }
  return payload;
}

/** Simple HTML result page — title and message must be pre-escaped via escapeHtml() before calling */
function confirmationPage(safeTitle: string, safeMessage: string, success: boolean) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;">
<h2 style="color:${success ? '#16A34A' : '#DC2626'};">${safeTitle}</h2>
<p style="color:#374151;">${safeMessage}</p>
<p style="margin-top:24px;"><a href="${process.env.APP_BASE_URL || 'https://varsityhub.app'}" style="color:#1B3A6B;">Return to VarsityHub</a></p>
</body></html>`;
}

function buildNativeAdReviewUrl(id: string, action?: 'approve' | 'reject'): string {
  const appScheme = (process.env.APP_SCHEME || 'varsityhubmobile').replace(/:.*$/, '');
  const url = new URL(`${appScheme}://admin-ads`);
  url.searchParams.set('ad_id', id);
  if (action) {
    url.searchParams.set('action', action);
  }
  return url.toString();
}

function adReviewHandoffPage(id: string, action?: 'approve' | 'reject') {
  const safeAction = action === 'approve' || action === 'reject' ? action : '';
  const nativeUrl = buildNativeAdReviewUrl(id, safeAction || undefined);
  const safeNativeUrl = escapeHtml(nativeUrl);
  const safeHeadline =
    safeAction === 'approve'
      ? 'Open VarsityHub to approve this ad'
      : safeAction === 'reject'
        ? 'Open VarsityHub to reject this ad'
        : 'Open VarsityHub to review this ad';
  const safeSubcopy =
    safeAction === 'approve' || safeAction === 'reject'
      ? `You'll be taken to the admin ad review screen with the ${safeAction} action preselected.`
      : "You'll be taken to the admin ad review screen.";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeHeadline}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:540px;margin:60px auto;padding:20px;text-align:center;background:#F9FAFB;color:#111827;">
<div style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:16px;padding:28px 24px;box-shadow:0 12px 32px rgba(15,23,42,0.08);">
<h2 style="margin:0 0 12px;color:#1B3A6B;">${safeHeadline}</h2>
<p style="margin:0 0 20px;color:#4B5563;line-height:1.5;">${safeSubcopy} Sign in with an admin account if prompted.</p>
<p style="margin:0 0 20px;"><a href="${safeNativeUrl}" style="display:inline-block;background:#1B3A6B;color:#FFFFFF;text-decoration:none;padding:14px 20px;border-radius:10px;font-weight:600;">Open in VarsityHub</a></p>
<p style="margin:0;color:#6B7280;font-size:13px;line-height:1.5;">If the app does not open automatically, tap the button again from this page.</p>
</div>
<script>
window.setTimeout(function () {
  window.location.replace(${JSON.stringify(nativeUrl)});
}, 75);
</script>
</body></html>`;
}

/** HTML confirmation form — safeName must be pre-escaped via escapeHtml() before calling.
 *  When the ad's banner has been flagged by moderation, the form surfaces the flag and
 *  requires a typed override reason before the approval POST is sent. Submission uses
 *  fetch+JSON so the server's existing JSON body parser handles the payload (no
 *  urlencoded middleware change needed). */
function confirmationForm(
  action: string,
  adId: string,
  token: string,
  safeName: string,
  moderation?: {
    status: 'clean' | 'flagged' | 'error' | null;
    score: number | null;
    labels: Array<{ name: string; confidence: number }>;
    error?: string | null;
  } | null,
  errorBanner?: string
) {
  const color = action === 'approve' ? '#16A34A' : '#DC2626';
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  const isApprove = action === 'approve';
  const isFlagged = isApprove && moderation?.status === 'flagged';
  const isScanError = isApprove && moderation?.status === 'error';

  const flaggedHtml = isFlagged
    ? `<div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 16px;margin:16px 0;text-align:left;">
  <p style="margin:0 0 8px;color:#991B1B;font-weight:600;">⚠️ Banner flagged by automated review</p>
  ${
    moderation!.labels.length > 0
      ? `<p style="margin:0;color:#7F1D1D;font-size:13px;">${moderation!.labels
          .slice(0, 5)
          .map(l => `${escapeHtml(l.name)} (${Math.round(l.confidence)}%)`)
          .join(', ')}</p>`
      : `<p style="margin:0;color:#7F1D1D;font-size:13px;">No label detail captured.</p>`
  }
  <p style="margin:8px 0 0;color:#7F1D1D;font-size:12px;">Approving this ad requires a written override reason.</p>
</div>
<label for="override_reason" style="display:block;text-align:left;margin:12px 0 4px;font-size:14px;color:#374151;">Override reason (required, 10–2000 chars)</label>
<textarea id="override_reason" name="override_reason" rows="4" required minlength="10" maxlength="2000" style="width:100%;padding:8px;border:1px solid #D1D5DB;border-radius:6px;font-family:inherit;font-size:14px;" placeholder="Why is this banner acceptable despite the automated flag?"></textarea>`
    : '';

  const scanErrorHtml = isScanError
    ? `<div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:12px 16px;margin:16px 0;text-align:left;">
  <p style="margin:0;color:#92400E;font-weight:600;font-size:14px;">Banner could not be scanned</p>
  <p style="margin:4px 0 0;color:#78350F;font-size:12px;">${escapeHtml((moderation?.error || 'Unknown scan error').slice(0, 200))}</p>
</div>`
    : '';

  const topErrorHtml = errorBanner
    ? `<div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:8px 12px;margin:8px 0;text-align:left;color:#991B1B;font-size:13px;">${escapeHtml(errorBanner)}</div>`
    : '';

  // Native HTML form POST — no JavaScript. The app-wide Helmet CSP
  // (script-src 'self' + hash allowlist, script-src-attr 'none') blocks inline
  // scripts and on* attributes on this server-rendered page, so a JS submit
  // handler never runs in email in-app browsers. A method="POST" form with the
  // token preserved in the action query string works under any CSP; the
  // urlencoded body parser populates override_* on the server.
  const safeFormAction = escapeHtml(`?token=${encodeURIComponent(token)}`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${verb} Ad</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:540px;margin:60px auto;padding:20px;text-align:center;">
<h2>${verb} this ad?</h2>
<p style="color:#374151;">Ad: <strong>${safeName}</strong></p>
${topErrorHtml}
${flaggedHtml}
${scanErrorHtml}
<form id="moderation-form" method="POST" action="${safeFormAction}">
  ${isFlagged ? '<input type="hidden" name="override_banner_flag" value="1">' : ''}
  <button type="submit" style="background:${color};color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:16px;">${verb} Ad</button>
</form>
<p style="margin-top:24px;color:#9CA3AF;font-size:12px;">Click the button to confirm.</p>
</body></html>`;
}

// Admin: Approve a pending ad
// GET with token → shows confirmation form (safe from email scanners)
// POST (admin auth required) → performs the approval.
//   - Token, when present, is validated as a binding (ad_id + action) so a
//     forwarded/leaked email link still can't be replayed by a non-admin.
/** Fetch the moderation fields needed to render the confirmation form when the
 *  banner has been flagged or could not be scanned. Returns null when the ad
 *  does not exist (caller should 404). */
async function loadAdModerationSummary(id: string) {
  const ad = await prisma.ad.findUnique({
    where: { id },
    select: {
      business_name: true,
      status: true,
      banner_moderation_status: true,
      banner_moderation_labels: true,
      banner_moderation_score: true,
      banner_moderation_error: true,
    },
  });
  if (!ad) return null;
  const rawLabels = ad.banner_moderation_labels as any;
  const labels: Array<{ name: string; confidence: number }> = Array.isArray(rawLabels)
    ? rawLabels
        .filter((l: any) => l && typeof l.name === 'string')
        .map((l: any) => ({
          name: String(l.name),
          confidence: Number(l.confidence) || 0,
        }))
    : [];
  return {
    businessName: ad.business_name || 'Unknown',
    status: ad.status,
    moderation: {
      status: (ad.banner_moderation_status as 'clean' | 'flagged' | 'error' | null) || null,
      score: ad.banner_moderation_score,
      labels,
      error: ad.banner_moderation_error,
    },
  };
}

function describeAdModerationState(
  status: string | null | undefined,
  action: 'approve' | 'reject'
) {
  if (status === 'approved' || status === 'active') {
    return {
      title: 'Already Approved',
      message: 'This ad was already approved.',
      success: action === 'approve',
      already_final: true,
    };
  }
  if (status === 'rejected' || status === 'archived') {
    return {
      title: 'Already Rejected',
      message: 'This ad was already rejected.',
      success: action === 'reject',
      already_final: true,
    };
  }
  return null;
}

async function guardAdModerationReplayToken(
  res: Response,
  token: string,
  tokenPayload: ReviewTokenPayload
) {
  const replayState = await getReviewTokenReplayState(token, tokenPayload);
  if (replayState === 'already_used') {
    res
      .status(409)
      .send(
        confirmationPage('Link Already Used', 'This review link has already been used.', false)
      );
    return false;
  }
  if (replayState === 'store_unavailable') {
    res
      .status(503)
      .send(
        confirmationPage(
          'Temporarily Unavailable',
          'This review link cannot be completed right now. Please use the admin dashboard instead.',
          false
        )
      );
    return false;
  }
  return true;
}

async function handleAdApprove(req: AuthedRequest, res: Response) {
  try {
    const id = String(req.params.id);
    const token = (req.query?.token as string) || undefined;
    const tokenPayload = token ? verifyModerationToken(token, id, 'approve_ad') : null;

    // GET path = confirmation form served from email link. Token-only, read-only.
    if (req.method === 'GET') {
      if (!token || !tokenPayload) {
        // Diagnose WHY the token failed — helps debug email client URL rewriting
        if (token) {
          try {
            const { verifyReviewToken } = await import('../lib/reviewTokens.js');
            const raw = verifyReviewToken<{ adId?: string; action?: string }>(token);
            if (!raw) {
              console.warn(
                '[ads] approve token failed JWT verification — likely expired or secret mismatch',
                { ad_id: id }
              );
            } else if (raw.adId !== id) {
              console.warn('[ads] approve token adId mismatch', {
                token_adId: raw.adId,
                url_id: id,
              });
            } else if (raw.action !== 'approve_ad') {
              console.warn('[ads] approve token action mismatch', {
                token_action: raw.action,
                expected: 'approve_ad',
              });
            }
          } catch {
            console.warn('[ads] approve token diagnostic check threw', { ad_id: id });
          }
        } else {
          console.warn('[ads] approve link clicked with no token', { ad_id: id });
        }
        addBreadcrumb('Ad approval token validation failed', 'approval.ad_route', 'warning', {
          action: 'approve',
          ad_id: id,
          method: req.method,
        });
        return res.status(200).send(adReviewHandoffPage(id, 'approve'));
      }
      addBreadcrumb('Ad approval confirmation page rendered', 'approval.ad_route', 'info', {
        action: 'approve',
        ad_id: id,
      });
      const summary = await loadAdModerationSummary(id);
      if (!summary) {
        return res.status(404).send(confirmationPage('Not Found', 'Ad not found.', false));
      }
      const currentState = describeAdModerationState(summary.status, 'approve');
      if (currentState) {
        return res.send(
          confirmationPage(currentState.title, currentState.message, currentState.success)
        );
      }
      return res.send(
        confirmationForm(
          'approve',
          id,
          token,
          escapeHtml(summary.businessName || 'Unknown'),
          summary.moderation
        )
      );
    }

    if (token) {
      if (!tokenPayload) {
        addBreadcrumb('Ad approval token validation failed', 'approval.ad_route', 'warning', {
          action: 'approve',
          ad_id: id,
          method: req.method,
        });
        return res
          .status(401)
          .send(
            confirmationPage('Invalid Link', 'This approval link is invalid or has expired.', false)
          );
      }
      if (!(await guardAdModerationReplayToken(res, token, tokenPayload))) {
        return;
      }
    } else {
      const isAdmin = await getIsAdmin(req);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    }

    const body = req.body || {};
    const note = typeof body.note === 'string' ? body.note.trim() : null;
    const overrideRequested = isTruthyFlag(body.override_banner_flag);
    const overrideReasonRaw =
      typeof body.override_reason === 'string' ? body.override_reason.trim() : '';
    const bannerOverride =
      overrideRequested && overrideReasonRaw ? { reason: overrideReasonRaw } : undefined;

    const result = await approveAd(id, note, req.user?.id || null, bannerOverride);
    if (result.error) {
      // Special case: flagged-banner 409 from the token-POST path re-renders the
      // confirmation form with the override UI so the admin can supply a reason
      // inline instead of hitting a dead-end error page.
      if (
        result.error === 'banner_moderation_flag_requires_override' &&
        req.method === 'POST' &&
        token
      ) {
        const summary = await loadAdModerationSummary(id);
        return res
          .status(409)
          .send(
            confirmationForm(
              'approve',
              id,
              token,
              escapeHtml(summary?.businessName || 'Unknown'),
              (result as any).moderation,
              'This banner was flagged. Provide an override reason to approve.'
            )
          );
      }
      const summary = await loadAdModerationSummary(id);
      if (summary) {
        const currentState = describeAdModerationState(summary.status, 'approve');
        if (currentState) {
          return req.method === 'POST' && token
            ? res.send(
                confirmationPage(currentState.title, currentState.message, currentState.success)
              )
            : res.status(result.status!).json({
                error: result.error,
                already_final: true,
              });
        }
      }
      return req.method === 'POST' && token
        ? res
            .status(result.status!)
            .send(confirmationPage('Error', escapeHtml(result.error), false))
        : res.status(result.status!).json({
            error: result.error,
            ...((result as any).moderation ? { moderation: (result as any).moderation } : {}),
          });
    }

    if (token && tokenPayload) {
      const consumeResult = await consumeReviewToken(token, tokenPayload);
      if (consumeResult !== 'consumed') {
        console.warn('[ads] review token could not be marked consumed after approval:', {
          ad_id: id,
          action: 'approve',
          consumeResult,
        });
      }
    }

    return req.method === 'POST' && token
      ? res.send(
          confirmationPage(
            'Ad Approved',
            'The ad has been approved. The advertiser has been notified.',
            true
          )
        )
      : res.json(result.ad);
  } catch (err) {
    console.error('[ads] approve error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

adsRouter.get('/:id([a-z0-9]{15,50})/approve', adModerationLimiter as any, handleAdApprove as any);
adsRouter.post('/:id([a-z0-9]{15,50})/approve', adModerationLimiter as any, handleAdApprove as any);

// Admin: Reject a pending ad (same confirmation-form pattern as approve).
// See handleAdApprove for the full security rationale — POST always requires
// admin auth; token (when present) binds the action to the specific ad_id.
async function handleAdReject(req: AuthedRequest, res: Response) {
  try {
    const id = String(req.params.id);
    const token = (req.query?.token as string) || undefined;
    const tokenPayload = token ? verifyModerationToken(token, id, 'reject_ad') : null;

    // GET path = confirmation form served from email link. Token-only, read-only.
    if (req.method === 'GET') {
      if (!token || !tokenPayload) {
        if (token) {
          try {
            const { verifyReviewToken } = await import('../lib/reviewTokens.js');
            const raw = verifyReviewToken<{ adId?: string; action?: string }>(token);
            if (!raw) {
              console.warn(
                '[ads] reject token failed JWT verification — likely expired or secret mismatch',
                { ad_id: id }
              );
            } else if (raw.adId !== id) {
              console.warn('[ads] reject token adId mismatch', {
                token_adId: raw.adId,
                url_id: id,
              });
            } else if (raw.action !== 'reject_ad') {
              console.warn('[ads] reject token action mismatch', {
                token_action: raw.action,
                expected: 'reject_ad',
              });
            }
          } catch {
            console.warn('[ads] reject token diagnostic check threw', { ad_id: id });
          }
        } else {
          console.warn('[ads] reject link clicked with no token', { ad_id: id });
        }
        addBreadcrumb('Ad rejection token validation failed', 'approval.ad_route', 'warning', {
          action: 'reject',
          ad_id: id,
          method: req.method,
        });
        return res.status(200).send(adReviewHandoffPage(id, 'reject'));
      }
      addBreadcrumb('Ad rejection confirmation page rendered', 'approval.ad_route', 'info', {
        action: 'reject',
        ad_id: id,
      });
      const summary = await loadAdModerationSummary(id);
      if (!summary) {
        return res.status(404).send(confirmationPage('Not Found', 'Ad not found.', false));
      }
      const currentState = describeAdModerationState(summary.status, 'reject');
      if (currentState) {
        return res.send(
          confirmationPage(currentState.title, currentState.message, currentState.success)
        );
      }
      return res.send(
        confirmationForm('reject', id, token, escapeHtml(summary.businessName || 'Unknown'))
      );
    }

    if (token) {
      if (!tokenPayload) {
        addBreadcrumb('Ad rejection token validation failed', 'approval.ad_route', 'warning', {
          action: 'reject',
          ad_id: id,
          method: req.method,
        });
        return res
          .status(401)
          .send(
            confirmationPage(
              'Invalid Link',
              'This rejection link is invalid or has expired.',
              false
            )
          );
      }
      if (!(await guardAdModerationReplayToken(res, token, tokenPayload))) {
        return;
      }
    } else {
      const isAdmin = await getIsAdmin(req);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    }

    const result = await rejectAd(
      id,
      req.body?.reason || (req.query?.reason as string) || null,
      req.user?.id || null
    );
    if (result.error) {
      const summary = await loadAdModerationSummary(id);
      if (summary) {
        const currentState = describeAdModerationState(summary.status, 'reject');
        if (currentState) {
          return req.method === 'POST' && token
            ? res.send(
                confirmationPage(currentState.title, currentState.message, currentState.success)
              )
            : res.status(result.status!).json({
                error: result.error,
                already_final: true,
              });
        }
      }
      return req.method === 'POST' && token
        ? res
            .status(result.status!)
            .send(confirmationPage('Error', escapeHtml(result.error), false))
        : res.status(result.status!).json({ error: result.error });
    }

    if (token && tokenPayload) {
      const consumeResult = await consumeReviewToken(token, tokenPayload);
      if (consumeResult !== 'consumed') {
        console.warn('[ads] review token could not be marked consumed after rejection:', {
          ad_id: id,
          action: 'reject',
          consumeResult,
        });
      }
    }

    return req.method === 'POST' && token
      ? res.send(
          confirmationPage(
            'Ad Rejected',
            'The ad has been rejected and the advertiser has been notified.',
            true
          )
        )
      : res.json(result.ad);
  } catch (err) {
    console.error('[ads] reject error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

adsRouter.get('/:id([a-z0-9]{15,50})/reject', adModerationLimiter as any, handleAdReject as any);
adsRouter.post('/:id([a-z0-9]{15,50})/reject', adModerationLimiter as any, handleAdReject as any);

// Admin: Review an ad (approve or reject) — used by admin-ads screen.
adsRouter.get(
  '/:id([a-z0-9]{15,50})/review',
  adModerationLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const action =
      req.query?.action === 'approve' || req.query?.action === 'reject'
        ? req.query.action
        : undefined;

    res.type('html');
    return res.status(200).send(adReviewHandoffPage(id, action));
  })
);

// Admin: Review an ad (approve or reject) — used by admin-ads screen.
// Auth chain mirrors the token-link moderation routes so the dashboard
// path can't be used by an unverified admin when the email-link path can't.
adsRouter.post(
  '/:id([a-z0-9]{15,50})/review',
  requireAuth as any,
  requireVerified as any,
  requireAdmin as any,
  adModerationLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const reviewSchema = z.object({
      action: z.enum(['approve', 'reject']),
      note: z.string().max(2000).optional(),
      override_banner_flag: z.boolean().optional(),
      override_reason: z.string().max(2000).optional(),
    });
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { action, note: rawNote, override_banner_flag, override_reason } = parsed.data;
    const note = rawNote?.trim() || null;

    if (action === 'approve') {
      const overrideReasonTrim = override_reason?.trim() || '';
      const bannerOverride =
        override_banner_flag && overrideReasonTrim ? { reason: overrideReasonTrim } : undefined;
      const result = await approveAd(id, note, req.user?.id || null, bannerOverride);
      if (result.error) {
        return res.status(result.status!).json({
          error: result.error,
          ...((result as any).moderation ? { moderation: (result as any).moderation } : {}),
        });
      }
      return res.json(result.ad);
    } else {
      const result = await rejectAd(id, note, req.user?.id || null);
      if (result.error) return res.status(result.status!).json({ error: result.error });
      return res.json(result.ad);
    }
  })
);
