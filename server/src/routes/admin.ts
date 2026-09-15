import express from 'express';
import { z } from 'zod';
import { logAdminActivity, logAdminActivityFromReq } from '../lib/adminActivityLogger.js';
import { approveCoach, rejectCoach } from '../lib/approvalService.js';
import { renderReviewPage, renderResultPage } from '../lib/reviewPage.js';
import { sendAccountModerationEmail } from '../lib/email.js';
import { getFounderMetricsReport } from '../lib/founderMetrics.js';
import {
  checkReportSpike,
  getUserModerationHistory,
  issueWarning,
  suspendUser,
} from '../lib/moderation.js';
import { prisma } from '../lib/prisma.js';
import {
  consumeReviewToken,
  getReviewTokenReplayState,
  verifyReviewToken,
} from '../lib/reviewTokens.js';
import {
  getAdRevenueReport,
  getAllTransactions,
  getTransactionBySession,
  getTransactionSummary,
} from '../lib/transactionLogger.js';
import { invalidateMeCacheForUser, updateUserAndInvalidate } from '../lib/userCache.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminLimiter } from '../middleware/rateLimiters.js';
import {
  isEmailAdmin,
  requireAdmin as requireAdminMiddleware,
} from '../middleware/requireAdmin.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';

const adminRouter = express.Router();
registerIdValidation(adminRouter);
adminRouter.use(adminLimiter);

// SECURITY BACKSTOP (2026-07-12): the admin router is mounted with only `noStore`,
// so historically every route had to remember its own `requireAdminMiddleware`. A
// single forgotten guard would silently expose an admin write path. This blanket
// middleware makes that fail closed — any route not explicitly allowlisted below
// must clear `requireAdminMiddleware` before its handler runs.
//
// Allowlisted past the backstop:
//  1. The dual-mode review routes (`/coaches/:id/(approve|reject)`) authenticate by
//     a signed, single-use email-review token OR a verified admin session *inside*
//     `handleCoachReview`, so they cannot sit behind the middleware.
//  2. The `/reports` subtree belongs to a *separate* router (adminReportsRouter) that
//     guards its own routes. Depending on mount order (testApp mounts `/admin` before
//     `/admin/reports`) a `/admin/reports/*` request can pass through this router's
//     stack first, so this backstop must never answer for it. Anchored to the
//     `/reports` path segment so it never matches the real `/report-spike` route.
// Matching is anchored so it is robust to mount-relative vs absolute `req.path`.
// Per-route `requireAdminMiddleware` guards are intentionally kept as belt-and-
// suspenders; the duplicate lookup is negligible on low-traffic admin routes.
const ADMIN_BACKSTOP_ALLOWLIST: RegExp[] = [
  /\/coaches\/[^/]+\/(approve|reject)$/,
  /(?:^|\/)reports(?:\/|$)/,
];
adminRouter.use((req, res, next) => {
  if (ADMIN_BACKSTOP_ALLOWLIST.some(re => re.test(req.path))) return next();
  return (requireAdminMiddleware as any)(req, res, next);
});

function renderCoachReviewPage(action: 'approve' | 'reject', coachName: string, token: string) {
  return renderReviewPage({ action, entityLabel: 'Coach', entityName: coachName, token });
}

function renderCoachResultPage(title: string, message: string, success: boolean) {
  return renderResultPage(title, message, success);
}

// Mirror of the abuse-report handler's replay pre-check (adminReports.ts): reject a
// coach-review email link that has already been consumed, before performing the
// mutation, instead of relying only on the post-mutation `consumeReviewToken` +
// the `approval_status !== 'PENDING'` state guard.
async function isReplayTokenAlreadyUsed(
  token: string,
  payload: { jti?: string; exp?: number; iat?: number }
) {
  const replayState = await getReviewTokenReplayState(token, payload);
  return replayState === 'already_used';
}

async function handleCoachReview(
  req: AuthedRequest,
  res: express.Response,
  action: 'approve' | 'reject'
) {
  const { id } = req.params;
  const token = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const payload = token ? verifyReviewToken<{ coachId: string; action: string }>(token) : null;
  const expectedAction = action === 'approve' ? 'approve_coach' : 'reject_coach';
  const tokenValid = !!(
    token &&
    payload &&
    payload.coachId === id &&
    payload.action === expectedAction
  );

  // Two callers: (1) email-link clicks render HTML; (2) admin dashboard sends JSON.
  // Allow signed-in admins through without a token; keep email-link semantics otherwise.
  let signedInAdmin = false;
  let signedInAdminSession: { id: string; email: string | null } | null = null;
  if (!tokenValid && !token && req.user) {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, email_verified: true },
    });
    signedInAdmin = !!(me?.email_verified && isEmailAdmin(me.email));
    signedInAdminSession = signedInAdmin && me ? { id: me.id, email: me.email } : null;
  } else if (tokenValid && req.user) {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, email_verified: true },
    });
    if (me?.email_verified && isEmailAdmin(me.email)) {
      signedInAdminSession = { id: me.id, email: me.email };
    }
  }

  if (!tokenValid && !signedInAdmin) {
    if (token) {
      return res
        .status(401)
        .send(
          renderCoachResultPage(
            'Invalid Link',
            `This ${action} link is invalid or has expired.`,
            false
          )
        );
    }
    return res.status(401).json({ error: 'Admin login required.' });
  }

  const coach = await prisma.user.findUnique({
    where: { id },
    select: { display_name: true, username: true, email: true, approval_status: true },
  });
  if (!coach) {
    if (signedInAdmin) return res.status(404).json({ error: 'Coach not found' });
    return res.status(404).send(renderCoachResultPage('Not Found', 'Coach not found.', false));
  }

  const coachName = coach.display_name || coach.username || coach.email || 'Unknown Coach';
  if (coach.approval_status === 'APPROVED') {
    if (signedInAdmin) {
      return res.json({
        ok: true,
        already_final: true,
        message: `Coach ${coachName} already approved`,
      });
    }
    return res.send(
      renderCoachResultPage('Already Approved', `${coachName} was already approved.`, true)
    );
  }
  if (coach.approval_status === 'REJECTED') {
    if (signedInAdmin) {
      return res.json({
        ok: true,
        already_final: true,
        message: `Coach ${coachName} already rejected`,
      });
    }
    return res.send(
      renderCoachResultPage('Already Rejected', `${coachName} was already rejected.`, true)
    );
  }

  // tokenValid implies the email-link flow (signedInAdmin is only set on the
  // no-token branch), so a consumed token renders the HTML "already used" page.
  if (req.method === 'POST' && tokenValid && (await isReplayTokenAlreadyUsed(token!, payload!))) {
    return res
      .status(409)
      .send(
        renderCoachResultPage(
          'Link Already Used',
          `This ${action} link was already used. Open the latest email if you need a fresh review link.`,
          false
        )
      );
  }

  if (req.method === 'GET') {
    if (!tokenValid) return res.status(405).json({ error: 'Method not allowed' });
    return res.send(renderCoachReviewPage(action, coachName, token!));
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
  const reviewerUserId = signedInAdminSession?.id ?? null;
  let reviewerEmail = 'email-token';
  if (signedInAdminSession?.email) {
    reviewerEmail = signedInAdminSession.email;
  }
  const result =
    action === 'approve'
      ? await approveCoach(id, reviewerUserId, prisma, { note })
      : await rejectCoach(id, reviewerUserId, prisma, { reason: note });
  if (result.error) {
    if (signedInAdmin) return res.status(result.status || 500).json({ error: result.error });
    return res
      .status(result.status || 500)
      .send(renderCoachResultPage('Error', result.error, false));
  }

  if (tokenValid) {
    const consumeResult = await consumeReviewToken(token!, payload!);
    if (consumeResult !== 'consumed') {
      console.warn('[admin] coach review token could not be marked consumed after success:', {
        coach_id: id,
        action,
        consumeResult,
      });
    }
  }

  await logAdminActivity(
    reviewerUserId || 'email-token',
    reviewerEmail,
    action === 'approve' ? 'APPROVE_COACH' : 'REJECT_COACH',
    'user',
    id,
    `${action === 'approve' ? 'Approved' : 'Rejected'} coach: ${coachName}${note ? ` — ${note}` : ''}`
  );

  if (signedInAdmin) {
    return res.json({
      ok: true,
      message: `Coach ${coachName} ${action === 'approve' ? 'approved' : 'rejected'}`,
    });
  }
  return res.send(
    renderCoachResultPage(
      action === 'approve' ? 'Coach Approved' : 'Coach Rejected',
      `${coachName} has been ${action === 'approve' ? 'approved' : 'rejected'}.`,
      true
    )
  );
}

adminRouter.get(
  '/coaches/:id/approve',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => handleCoachReview(req, res, 'approve'))
);
adminRouter.post(
  '/coaches/:id/approve',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => handleCoachReview(req, res, 'approve'))
);
adminRouter.get(
  '/coaches/:id/reject',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => handleCoachReview(req, res, 'reject'))
);
adminRouter.post(
  '/coaches/:id/reject',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => handleCoachReview(req, res, 'reject'))
);

/**
 * GET /admin/dashboard
 * Get platform statistics for admin dashboard
 */
adminRouter.get(
  '/dashboard',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const [
      totalUsers,
      verifiedUsers,
      bannedUsers,
      totalTeams,
      totalAds,
      pendingAds,
      totalPosts,
      totalMessages,
      recentActivity,
      pendingLeagues,
      eventsWithoutCoordinates,
      pendingCoaches,
    ] = await Promise.all([
      // Total users
      prisma.user.count(),

      // Verified users (email verified)
      prisma.user.count({ where: { email_verified: true } }),

      // Banned users
      prisma.user.count({ where: { banned: true } }),

      // Total teams
      prisma.team.count(),

      // Total ads
      prisma.ad.count(),

      // Pending ads (status = pending)
      prisma.ad.count({ where: { status: 'pending' } }),

      // Total posts
      prisma.post.count({ where: { deleted_at: null } }),

      // Total messages
      prisma.message.count(),

      // Recent activity (last 5 admin actions)
      prisma.adminActivityLog
        .findMany({
          orderBy: { timestamp: 'desc' },
          take: 5,
          select: {
            id: true,
            admin_email: true,
            action: true,
            target_type: true,
            description: true,
            timestamp: true,
          },
        })
        .catch(err => {
          console.error('[admin] Failed to fetch recent activity:', err);
          return [] as Array<{
            id: string;
            admin_email: string;
            action: string;
            target_type: string;
            description: string;
            timestamp: Date;
          }>;
        }),

      // Pending leagues (not yet approved by admin)
      prisma.organization
        .findMany({
          where: { admin_approved: false, status: { not: 'rejected' } },
          orderBy: { created_at: 'desc' },
          take: 200,
          select: {
            id: true,
            name: true,
            sport: true,
            description: true,
            created_at: true,
            logo_url: true,
            supporting_document_url: true,
            leagueOwner: { select: { id: true, display_name: true, email: true } },
            _count: { select: { teams: true, memberships: true } },
          },
        })
        .catch(err => {
          console.error('[admin] Failed to fetch pending leagues:', err);
          return [];
        }),

      // Events/games with a location string but no lat/lng coordinates
      prisma.game
        .count({
          where: {
            location: { not: null },
            latitude: null,
            longitude: null,
          },
        })
        .catch(err => {
          console.error('[admin] Failed to count events without coords:', err);
          return 0;
        }),

      // Pending coaches (users with approval_status = 'PENDING' and coach preferences)
      prisma.user
        .findMany({
          where: {
            approval_status: 'PENDING',
            OR: [{ role: 'coach' as any }, { preferences: { path: ['role'], equals: 'coach' } }],
          },
          orderBy: { created_at: 'desc' },
          take: 200,
          select: {
            id: true,
            display_name: true,
            email: true,
            username: true,
            avatar_url: true,
            created_at: true,
            preferences: true,
            coachApplications: {
              where: { status: { in: ['submitted', 'approved', 'rejected'] } },
              orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                status: true,
                organization_name: true,
                org_type: true,
                location: true,
                zip_code: true,
                place_id: true,
                supporting_document_url: true,
                background_url: true,
                payload: true,
                submitted_at: true,
                reviewed_at: true,
                reviewed_by: true,
                review_note: true,
                created_at: true,
                updated_at: true,
              },
            },
          },
        })
        .catch(err => {
          console.error('[admin] Failed to fetch pending coaches:', err);
          return [];
        }),
    ]);

    const normalizedPendingCoaches = (pendingCoaches || []).map((coach: any) => ({
      ...coach,
      coach_application: Array.isArray(coach.coachApplications)
        ? coach.coachApplications[0] || null
        : null,
      coachApplications: undefined,
    }));

    return res.json({
      ok: true,
      totalUsers,
      verifiedUsers,
      bannedUsers,
      totalTeams,
      totalAds,
      pendingAds,
      pendingLeagues: pendingLeagues || [],
      pendingCoaches: normalizedPendingCoaches,
      totalPosts,
      totalMessages,
      recentActivity: recentActivity || [],
      eventsWithoutCoordinates: eventsWithoutCoordinates || 0,
    });
  })
);

/**
 * PATCH /admin/users/:id/parental-consent
 * Admin override for parental consent state. Lets support correct mistakes —
 * e.g., a parent accidentally clicked Deny, or a legitimate minor's guardian
 * never received the email and support wants to approve manually. The change
 * is recorded in the admin activity log and (on approve) unbans the user.
 */
const consentOverrideSchema = z.object({
  status: z.enum(['approved', 'denied', 'pending']),
  reason: z.string().max(500).optional(),
});
adminRouter.patch(
  '/users/:id/parental-consent',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = String(req.params.id);
    const parsed = consentOverrideSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }
    const { status, reason } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        display_name: true,
        parent_email: true,
        parental_consent_status: true,
      } as any,
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const fromState = (user as any).parental_consent_status as
      | 'not_required'
      | 'pending'
      | 'approved'
      | 'denied';

    const now = new Date();
    const updateData: Record<string, unknown> = {
      parental_consent_status: status,
      parental_consent_at: status === 'pending' ? null : now,
    };
    if (status === 'pending') {
      // Support is re-opening the flow, so discard any stale resolved token
      // before issuing a fresh link below.
      updateData.parental_consent_token_hash = null;
    }
    if (status === 'approved') {
      // Unban the user if they were denied and are now approved.
      updateData.banned = false;
      updateData.banned_until = null;
      updateData.ban_reason = null;
    } else if (status === 'denied') {
      updateData.banned = true;
      updateData.banned_until = null;
      updateData.ban_reason = reason?.trim() || 'Parental consent denied by admin';
    } else if (status === 'pending') {
      // Pending consent should be enforced by the consent firewall rather than
      // the hard ban flags so the user can reach the resend surface.
      updateData.banned = false;
      updateData.banned_until = null;
      updateData.ban_reason = null;
    }

    // Atomically: update user + write COPPA-grade audit row. The dedicated
    // ParentalConsentAudit table is append-only and survives any purge of the
    // generic admin activity log, satisfying COPPA recordkeeping requirements.
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: updateData as any }),
      (prisma as any).parentalConsentAudit.create({
        data: {
          user_id: userId,
          actor_admin_id: req.user!.id,
          from_state: fromState,
          to_state: status,
          reason: reason?.trim() || `Admin override: ${fromState} → ${status}`,
        },
      }),
    ]);

    await logAdminActivityFromReq(
      req,
      'OVERRIDE_PARENTAL_CONSENT',
      'user',
      userId,
      `Set parental_consent_status=${status}${reason ? ` — ${reason}` : ''}`
    );

    await invalidateMeCacheForUser(userId);

    if (status === 'pending' && (user as any).parent_email) {
      try {
        const { issueConsentToken } = await import('../lib/parentalConsent.js');
        const { sendParentalConsentRequestEmail } = await import('../lib/email.js');
        const rawToken = await issueConsentToken(userId);
        await sendParentalConsentRequestEmail({
          to: (user as any).parent_email,
          minorDisplayName: (user as any).display_name || undefined,
          minorEmail: (user as any).email || undefined,
          consentToken: rawToken,
          expiresInDays: 14,
        });
      } catch (err) {
        console.warn(
          '[admin] Failed to re-issue parental consent email after pending override:',
          (err as any)?.message || err
        );
      }
    }

    return res.json({ ok: true, status, from_state: fromState });
  })
);

/**
 * GET /admin/metrics
 * Founder metrics (new users, reports, messages) over a time range
 */
adminRouter.get(
  '/metrics',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const daysParam = Number.parseInt(String(req.query.days || '7'), 10);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 30) : 7;
    const report = await getFounderMetricsReport(days);
    return res.json({ ok: true, report });
  })
);

/**
 * GET /admin/activity-log
 * Get admin activity audit trail
 * Query params:
 * - type: filter by target_type (e.g., 'user', 'team', 'ad', 'post')
 * - q: search query for action, description, or admin_email
 * - page: page number (default 1)
 * - limit: items per page (default 50, max 100)
 */
adminRouter.get(
  '/activity-log',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { type, q, page = '1', limit = '50' } = req.query;

    const pageNum = parseInt(String(page), 10);
    const limitNum = Math.max(1, Math.min(parseInt(String(limit), 10), 100)); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = {};

    // Filter by type
    if (type && type !== 'all') {
      where.target_type = String(type);
    }

    // Search query
    if (q && typeof q === 'string' && q.trim()) {
      where.OR = [
        { action: { contains: String(q), mode: 'insensitive' } },
        { description: { contains: String(q), mode: 'insensitive' } },
        { admin_email: { contains: String(q), mode: 'insensitive' } },
      ];
    }

    // Check if AdminActivityLog table exists, if not return empty results
    try {
      const [activities, total] = await Promise.all([
        prisma.adminActivityLog.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { timestamp: 'desc' },
          select: {
            id: true,
            admin_id: true,
            admin_email: true,
            action: true,
            target_type: true,
            target_id: true,
            description: true,
            metadata: true,
            timestamp: true,
          },
        }),
        prisma.adminActivityLog.count({ where }),
      ]);

      return res.json({
        ok: true,
        activities,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      // Table doesn't exist yet, return empty results
      return res.json({
        ok: true,
        activities: [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: 0,
          pages: 0,
        },
      });
    }
  })
);

// Type for authenticated request
type AuthedRequest = express.Request & { user?: { id: string } };

/**
 * GET /admin/transactions
 * Get all transactions with optional filters
 * Query params:
 * - type: filter by transaction type (e.g., 'AD_PURCHASE', 'SUBSCRIPTION_PURCHASE')
 * - status: filter by status (e.g., 'COMPLETED', 'PENDING', 'FAILED')
 * - userId: filter by user ID
 * - startDate: filter transactions after this date (ISO string)
 * - endDate: filter transactions before this date (ISO string)
 * - limit: number of results (default 50)
 * - offset: pagination offset (default 0)
 */
adminRouter.get(
  '/transactions',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { type, status, userId, startDate, endDate, limit = '50', offset = '0' } = req.query;

    const dateParam = z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value) return undefined;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid ISO date',
          });
          return z.NEVER;
        }
        return parsed;
      });

    const dateParsed = z
      .object({
        startDate: dateParam,
        endDate: dateParam,
      })
      .safeParse({ startDate, endDate });
    if (!dateParsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid date format. Use ISO date strings for startDate and endDate.' });
    }

    const filters: any = {};
    if (type) filters.transactionType = String(type);
    if (status) filters.status = String(status);
    if (userId) filters.userId = String(userId);
    if (dateParsed.data.startDate) filters.startDate = dateParsed.data.startDate;
    if (dateParsed.data.endDate) filters.endDate = dateParsed.data.endDate;

    const transactions = await getAllTransactions(
      filters,
      parseInt(String(limit)),
      parseInt(String(offset))
    );

    return res.json({
      ok: true,
      transactions,
      filters,
      limit: parseInt(String(limit)),
      offset: parseInt(String(offset)),
    });
  })
);

/**
 * GET /admin/transactions/summary
 * Get transaction summary/analytics
 * Query params:
 * - startDate: start of date range (ISO string, optional)
 * - endDate: end of date range (ISO string, optional)
 */
adminRouter.get(
  '/transactions/summary',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(String(startDate)) : undefined;
    const end = endDate ? new Date(String(endDate)) : undefined;

    const summary = await getTransactionSummary(start, end);

    return res.json({
      ok: true,
      summary,
      dateRange: {
        start: start?.toISOString(),
        end: end?.toISOString(),
      },
    });
  })
);

/**
 * GET /admin/ads/revenue-report
 * Ad revenue aggregate report — VARSITYHUB COMMANDMENTS: "Revenue tracking by:
 * zip code (revenue by area), time window (M-Th vs F-Su), business (total ad
 * spend per customer), impressions and clicks per ad."
 * Query params:
 * - startDate/endDate: optional ISO date range (defaults to all-time)
 */
adminRouter.get(
  '/ads/revenue-report',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { startDate, endDate } = req.query;

    const dateParam = z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value) return undefined;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid ISO date' });
          return z.NEVER;
        }
        return parsed;
      });
    const dateParsed = z
      .object({ startDate: dateParam, endDate: dateParam })
      .safeParse({ startDate, endDate });
    if (!dateParsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid date format. Use ISO date strings for startDate and endDate.' });
    }

    const report = await getAdRevenueReport(dateParsed.data.startDate, dateParsed.data.endDate);

    return res.json({
      ok: true,
      report,
      dateRange: {
        start: dateParsed.data.startDate?.toISOString(),
        end: dateParsed.data.endDate?.toISOString(),
      },
    });
  })
);

/**
 * GET /admin/transactions/:sessionId
 * Get a specific transaction by Stripe session ID
 */
adminRouter.get(
  '/transactions/:sessionId',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    const transaction = await getTransactionBySession(sessionId);

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.json({
      ok: true,
      transaction,
    });
  })
);

// ============================================
// Moderation Endpoints
// ============================================

/**
 * GET /admin/report-spike
 * Check if there's a report volume spike
 */
adminRouter.get(
  '/report-spike',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (_req: AuthedRequest, res) => {
    const spike = await checkReportSpike();
    return res.json(spike);
  })
);

/**
 * GET /admin/users/:id/moderation
 * Get moderation history for a user
 */
adminRouter.get(
  '/users/:id/moderation',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const history = await getUserModerationHistory(req.params.id);
    return res.json(history);
  })
);

/**
 * POST /admin/users/:id/warn
 * Issue a warning to a user
 */
const warnSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(500),
  severity: z.enum(['warning', 'strike', 'final_warning']).optional().default('warning'),
});

adminRouter.post(
  '/users/:id/warn',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = warnSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { reason, severity } = parsed.data;

    const result = await issueWarning({
      userId: req.params.id,
      reason,
      severity,
      issuedBy: req.user.id,
    });

    const warnedUser = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { email: true, display_name: true },
    });
    if (warnedUser?.email) {
      sendAccountModerationEmail({
        to: warnedUser.email,
        action: 'warning',
        reason,
        userName: warnedUser.display_name || undefined,
      }).catch(err =>
        console.warn('[admin] sendAccountModerationEmail (warning) failed:', err?.message ?? err)
      );
    }

    return res.json({ ok: true, ...result });
  })
);

/**
 * POST /admin/users/:id/suspend
 * Temporarily suspend a user
 */
const suspendSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(500),
  days: z.number().int().min(1).max(365).optional().default(7),
});

adminRouter.post(
  '/users/:id/suspend',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = suspendSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { days: suspendDays, reason } = parsed.data;

    await suspendUser({
      userId: req.params.id,
      days: suspendDays,
      reason,
      adminId: req.user.id,
    });
    return res.json({ ok: true, suspended_days: suspendDays });
  })
);

/**
 * POST /admin/users/:id/ban
 * Ban a user with reason
 */
const banSchema = z.object({
  reason: z.string().max(500).optional(),
});

adminRouter.post(
  '/users/:id/ban',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = banSchema.safeParse(req.body || {});
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { reason } = parsed.data;
    const bannedUserId = req.params.id;

    await updateUserAndInvalidate(prisma, {
      where: { id: bannedUserId },
      data: {
        banned: true,
        ban_reason: reason || 'Banned by admin for violating community guidelines.',
        // Bump session_epoch so existing access tokens fail the auth gate
        // immediately (auth middleware compares jwt.se to user.session_epoch).
        // Without this, a banned user keeps using their access token until
        // it naturally expires — refresh-token deletion below only stops
        // them from minting NEW tokens, not from using their current one.
        session_epoch: { increment: 1 },
      },
    });

    // Revoke all refresh tokens so banned user can't get new access tokens
    await prisma.refreshToken.deleteMany({ where: { user_id: bannedUserId } });

    // Audit log: who banned whom (for compliance and debugging)
    console.warn('[ADMIN_AUDIT] user_banned', {
      admin_id: req.user.id,
      banned_user_id: bannedUserId,
      reason: reason || 'Banned by admin',
      at: new Date().toISOString(),
    });

    await logAdminActivityFromReq(
      req,
      'BAN_USER',
      'user',
      bannedUserId,
      `Banned user ${bannedUserId}${reason ? ': ' + reason : ''}`
    );

    await issueWarning({
      userId: req.params.id,
      reason: reason || 'Banned by admin',
      severity: 'final_warning',
      issuedBy: req.user.id,
    });

    const bannedUser = await prisma.user.findUnique({
      where: { id: bannedUserId },
      select: { email: true, display_name: true },
    });
    if (bannedUser?.email) {
      sendAccountModerationEmail({
        to: bannedUser.email,
        action: 'permanent_ban',
        reason: reason || 'Banned by admin for violating community guidelines.',
        userName: bannedUser.display_name || undefined,
      }).catch(err =>
        console.warn('[admin] sendAccountModerationEmail (ban) failed:', err?.message ?? err)
      );
    }

    return res.json({ ok: true, banned: true });
  })
);

/**
 * POST /admin/users/:id/unban
 * Unban a user with audit trail
 */
adminRouter.post(
  '/users/:id/unban',
  requireVerified as any,
  requireAdminMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const unbannedUserId = req.params.id;

    await updateUserAndInvalidate(prisma, {
      where: { id: unbannedUserId },
      data: {
        banned: false,
        banned_until: null,
        ban_reason: null,
      },
    });

    // Audit log
    console.warn('[ADMIN_AUDIT] user_unbanned', {
      admin_id: req.user.id,
      unbanned_user_id: unbannedUserId,
      at: new Date().toISOString(),
    });

    await logAdminActivityFromReq(
      req,
      'UNBAN_USER',
      'user',
      unbannedUserId,
      `Unbanned user ${unbannedUserId}`
    );

    const unbannedUser = await prisma.user.findUnique({
      where: { id: unbannedUserId },
      select: { email: true, display_name: true },
    });
    if (unbannedUser?.email) {
      sendAccountModerationEmail({
        to: unbannedUser.email,
        action: 'recovery',
        userName: unbannedUser.display_name || undefined,
      }).catch(err =>
        console.warn('[admin] sendAccountModerationEmail (recovery) failed:', err?.message ?? err)
      );
    }

    return res.json({ ok: true, banned: false });
  })
);

export default adminRouter;
