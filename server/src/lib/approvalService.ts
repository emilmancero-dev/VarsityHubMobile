/**
 * Unified Approval Service
 *
 * Centralises the approve/reject logic for organizations, coaches, ads, and events.
 * Each function:
 *   1. Validates current state (idempotent — won't re-approve)
 *   2. Runs DB mutations inside a transaction
 *   3. Dispatches notifications (email + push + in-app) with error isolation
 *      so a notification failure never blocks the approval write.
 */

import type { PrismaClient } from '@prisma/client';
import {
  sendLeagueApprovedEmail,
  sendLeagueRejectedEmail,
  sendCoachApprovedEmail,
  sendCoachRejectedEmail,
  sendAdApprovedEmail,
  sendAdRejectedEmail,
  sendEventApprovedEmail,
  sendEventDeniedEmail,
  sendAdminActionConfirmationEmail,
} from './email.js';
import { sendPushNotification } from './pushNotifications.js';
import { invalidateMeCacheForUser } from './userCache.js';
import { addBreadcrumb, captureException } from './sentry.js';
import {
  buildAuthStateColumns,
  getCanonicalOrganizationId,
  getPreferencesObject,
  mergeAuthStateIntoPreferences,
} from './userAuthState.js';
import { buildBillingStateColumns } from './userBillingState.js';
import { isAdminEmail } from './adminEmails.js';
import { getLatestCoachApplication } from './coachApplications.js';
import { getOrganizationJoinRequestStateForUser } from './organizationWorkflowState.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Standard error reporter for fire-and-forget approval-notification emails.
 * Emails in this file are intentionally fire-and-forget so a notification
 * failure does not block the approval write — but we still need the
 * operator to see the failure in Sentry, otherwise a user is silently
 * never notified that they were approved/rejected.
 */
function reportEmailFailure(
  emailType: string,
  err: unknown,
  extra?: Record<string, unknown>
): void {
  console.warn(`[approvalService] ${emailType} email failed:`, (err as any)?.message || err);
  captureException(err instanceof Error ? err : new Error(String(err)), {
    context: 'approval_service_email_failed',
    email_type: emailType,
    ...(extra || {}),
  });
}

/**
 * Standard error reporter for best-effort approval push notifications.
 * Push failures must never block the approval write, but they do need
 * Sentry visibility so delivery regressions are visible before users report
 * them manually.
 */
function reportPushFailure(
  notificationType: string,
  err: unknown,
  extra?: Record<string, unknown>
): void {
  console.warn(`[approvalService] ${notificationType} push failed:`, (err as any)?.message || err);
  captureException(err instanceof Error ? err : new Error(String(err)), {
    context: 'approval_service_push_failed',
    notification_type: notificationType,
    ...(extra || {}),
  });
}

async function loadPendingEventForReview(
  eventId: string,
  adminId: string | null,
  prisma: PrismaClient,
  action: 'approve' | 'reject'
) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return { ok: false as const, error: 'Event not found', status: 404 as const };
  if (event.approval_status === 'approved') {
    return { ok: false as const, error: 'Event already approved', status: 400 as const };
  }
  if (event.approval_status === 'rejected') {
    return { ok: false as const, error: 'Event already rejected', status: 400 as const };
  }
  if (event.approval_status !== 'pending') {
    return { ok: false as const, error: 'Invalid state', status: 400 as const };
  }
  if (adminId && event.creator_id === adminId) {
    return {
      ok: false as const,
      error: `You cannot ${action} your own event`,
      status: 403 as const,
    };
  }
  return { ok: true as const, event };
}

async function buildEventReviewRaceResponse(
  eventId: string,
  prisma: PrismaClient,
  action: 'approve' | 'reject'
) {
  addBreadcrumb(
    `Event ${action === 'approve' ? 'approval' : 'rejection'} lost race`,
    'approval.event',
    'warning',
    {
      action,
      event_id: eventId,
    }
  );
  const current = await prisma.event.findUnique({
    where: { id: eventId },
    select: { approval_status: true },
  });
  return {
    ok: false as const,
    error: `Event state changed during review (now ${current?.approval_status ?? 'unknown'}). Refresh and try again.`,
    status: 409,
  };
}

type EventReviewResult =
  | {
      ok: true;
      event: any;
      error?: undefined;
      status?: undefined;
    }
  | {
      ok?: false;
      error: string;
      status: number;
      event?: undefined;
    };

/**
 * Check whether an organization is admin-approved.
 * Use this before team creation, coach approval, etc.
 */
export async function isOrganizationApproved(
  orgId: string,
  prisma: PrismaClient
): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { admin_approved: true },
  });
  return org?.admin_approved === true;
}

async function notifyAllAdminsOfLeagueAction(params: {
  action: 'league_approved' | 'league_rejected';
  leagueName: string;
  ownerName?: string;
  ownerEmail?: string;
  reason?: string;
}) {
  // Must guarantee the super admin: the approve/reject confirmation trail has to
  // reach customerservice@varsityhub.app even when ADMIN_NOTIFICATION_EMAILS is
  // set without it — mirrors the request-email recipient list.
  const { getApprovalNotificationEmails } = await import('./adminEmails.js');
  const adminEmails = getApprovalNotificationEmails();

  await Promise.all(
    adminEmails.map(to =>
      sendAdminActionConfirmationEmail({
        to,
        action: params.action,
        leagueName: params.leagueName,
        ownerName: params.ownerName,
        ownerEmail: params.ownerEmail,
        reason: params.reason,
      }).catch(err => {
        console.error(
          `[approvalService] Admin confirmation email failed (${params.action}) for ${to}:`,
          (err as any)?.message || err
        );
      })
    )
  );
}

async function notifyAllAdminsOfAdAction(params: {
  action: 'ad_approved' | 'ad_rejected';
  adName: string;
  reason?: string;
}) {
  // Banner-ad moderation must also always reach the super admin (see leagues).
  const { getApprovalNotificationEmails } = await import('./adminEmails.js');
  const adminEmails = getApprovalNotificationEmails();

  await Promise.all(
    adminEmails.map(to =>
      sendAdminActionConfirmationEmail({
        to,
        action: params.action,
        // Reuse the template contract field for the reviewed item name so
        // ad moderation gets the same admin confirmation fan-out as leagues.
        leagueName: params.adName,
        reason: params.reason,
      }).catch(err => {
        console.error(
          `[approvalService] Admin confirmation email failed (${params.action}) for ${to}:`,
          (err as any)?.message || err
        );
      })
    )
  );
}

async function createApprovalNotification(
  prisma: PrismaClient,
  params: {
    data: any;
    errorMessage: string;
    sentryContext: string;
    extra?: Record<string, any>;
  }
) {
  try {
    await prisma.notification.create({ data: params.data });
  } catch (err) {
    console.error(`[approvalService] ${params.errorMessage}:`, (err as any)?.message || err);
    captureException(err as Error, {
      context: params.sentryContext,
      notification_type: params.data?.type ?? 'unknown',
      userId: params.data?.user_id ?? null,
      actorId: params.data?.actor_id ?? null,
      ...params.extra,
    });
  }
}

async function resolveOrganizationOwner(
  prisma: PrismaClient,
  orgId: string,
  fallbackOwner?: {
    id?: string | null;
    display_name?: string | null;
    email?: string | null;
    preferences?: unknown;
  } | null
) {
  const ownerMembership = await prisma.organizationMembership.findFirst({
    where: { organization_id: orgId, role: 'owner', status: 'active' },
    select: { user_id: true },
  });
  const ownerId = ownerMembership?.user_id || fallbackOwner?.id || null;
  if (!ownerId) return null;
  if (fallbackOwner?.id === ownerId) return fallbackOwner;
  return prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, display_name: true, email: true, preferences: true },
  });
}

function buildOrganizationOwnerApprovedPreferences(
  currentPrefs: unknown,
  organization: { id: string; name: string }
) {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(currentPrefs), {
    role: 'coach',
    organization_id: organization.id,
    proceeding_as_fan: false,
  });
  next.organization_name = organization.name;
  return next;
}

function buildCoachApprovedPreferences(currentPrefs: unknown) {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(currentPrefs), {
    role: 'coach',
    proceeding_as_fan: false,
  }) as Record<string, any>;
  Object.assign(next, {
    join_request_pending: false,
  });
  delete next.pending_plan;
  delete next.payment_pending;
  delete next.payment_approved;
  return next;
}

function buildCoachRejectedPreferences(currentPrefs: unknown) {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(currentPrefs), {
    role: 'coach',
  }) as Record<string, any>;
  Object.assign(next, {
    join_request_pending: false,
  });
  delete next.team_id;
  delete next.team_name;
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// Organization approval
// ────────────────────────────────────────────────────────────────────────────

export async function approveOrganization(
  orgId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { note?: string }
) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      status: true,
      admin_approved: true,
      league_owner_id: true,
      leagueOwner: {
        select: { id: true, display_name: true, email: true, preferences: true },
      },
    },
  });
  if (!org) return { error: 'Organization not found', status: 404 };
  if (org.status === 'rejected')
    return {
      error: 'Organization already rejected',
      status: 409 as const,
      finalState: 'rejected' as const,
    };
  if (org.admin_approved) return { already: true };
  const owner = await resolveOrganizationOwner(prisma, orgId, org.leagueOwner);

  // Fail closed on an ownerless org: approving one would put it live with
  // league_owner_id=null and no owner to administer it (or receive the approval
  // notification). This shouldn't happen — create/transfer always write an owner
  // — so alarm to Sentry and refuse rather than silently publish a headless org.
  if (!owner?.id && !org.league_owner_id) {
    captureException(new Error('approveOrganization called on an ownerless organization'), {
      context: 'approve_organization_ownerless',
      organization_id: orgId,
    });
    return { error: 'Organization has no owner and cannot be approved', status: 409 as const };
  }

  // Atomic approval: org + owner approval_status
  const txOps: any[] = [
    prisma.organization.updateMany({
      where: { id: orgId, admin_approved: false, status: { not: 'rejected' } },
      data: {
        admin_approved: true,
        approved_by: adminId || 'email-token',
        approved_at: new Date(),
        league_owner_id: owner?.id || org.league_owner_id || null,
      },
    }),
  ];

  // Set owner's approval_status
  const ownerId = owner?.id ?? undefined;
  if (ownerId) {
    txOps.push(
      prisma.user.update({
        where: { id: ownerId },
        data: {
          approval_status: 'APPROVED',
          rejected_at: null,
          rejection_reason: null,
          preferences: buildOrganizationOwnerApprovedPreferences(owner?.preferences, {
            id: orgId,
            name: org.name,
          }),
          ...buildAuthStateColumns({
            role: 'coach',
            organization_id: orgId,
            proceeding_as_fan: false,
            coach_agreement_accepted_at: new Date(),
            coach_agreement_version: Number(process.env.REQUIRED_COACH_AGREEMENT_VERSION ?? 1),
          }),
        },
      })
    );
  }
  const [updated] = await prisma.$transaction(txOps);
  if (ownerId) {
    await invalidateMeCacheForUser(ownerId);
  }

  // Race-condition guard: another admin already approved
  if (updated.count === 0) {
    const current = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { admin_approved: true, status: true },
    });
    if (current?.status === 'rejected') {
      return {
        error: 'Organization already rejected',
        status: 409 as const,
        finalState: 'rejected' as const,
      };
    }
    return { already: true };
  }

  // ── Fire-and-forget notifications ──
  if (owner?.email) {
    sendLeagueApprovedEmail({
      to: owner.email,
      ownerName: owner.display_name || 'League Owner',
      leagueName: org.name,
      note: opts?.note,
    }).catch(err =>
      reportEmailFailure('league_approved', err, { user_id: owner?.id, org_id: org.id })
    );
  }

  if (owner?.id) {
    await createApprovalNotification(prisma, {
      data: {
        user_id: owner.id,
        type: 'ORG_APPROVED' as any,
        meta: { organization_id: orgId, organization_name: org.name },
      },
      errorMessage: 'org approved in-app notification failed',
      sentryContext: 'organization_approval_notification_failed',
      extra: { orgId, adminId: adminId || 'email-token' },
    });

    sendPushNotification(
      owner.id,
      'Organization Approved!',
      `Your organization "${org.name}" has been approved on VarsityHub.`,
      { type: 'org_approved', organization_id: orgId }
    ).catch(err => reportPushFailure('org_approved', err, { user_id: owner?.id, org_id: orgId }));
  }

  await notifyAllAdminsOfLeagueAction({
    action: 'league_approved',
    leagueName: org.name,
    ownerName: owner?.display_name || undefined,
    ownerEmail: owner?.email || undefined,
  });

  return { ok: true, org };
}

export async function rejectOrganization(
  orgId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { reason?: string }
) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      status: true,
      admin_approved: true,
      league_owner_id: true,
      leagueOwner: {
        select: { id: true, display_name: true, email: true, preferences: true },
      },
    },
  });
  if (!org) return { error: 'Organization not found', status: 404 };
  if (org.status === 'rejected') return { already: true };
  if (org.admin_approved)
    return {
      error: 'Organization already approved',
      status: 409 as const,
      finalState: 'approved' as const,
    };
  const owner = await resolveOrganizationOwner(prisma, orgId, org.leagueOwner);

  const reason = opts?.reason || null;

  // Cascade: reject org, unlink teams, revoke memberships, reject owner
  const didReject = await prisma.$transaction(async tx => {
    const updated = await tx.organization.updateMany({
      where: { id: orgId, status: { not: 'rejected' }, admin_approved: false },
      data: {
        status: 'rejected',
        admin_approved: false,
        // v1.0.2: track rejection for 48hr cooldown
        rejected_at: new Date(),
        rejection_reason: reason,
        league_owner_id: owner?.id || org.league_owner_id || null,
      },
    });
    if (updated.count === 0) return false;
    // organization_id is non-nullable — soft-delete teams by archiving them.
    await tx.team.updateMany({
      where: { organization_id: orgId },
      data: { status: 'archived' },
    });
    await tx.organizationMembership.deleteMany({
      where: { organization_id: orgId },
    });
    // Reject the org, but never cascade REJECTED onto a platform-admin owner
    // (would trigger the pending-approval routing loop). isAdminEmail() returns
    // false for a null email, so non-admin owners reject as before.
    if (owner?.id && !isAdminEmail(owner.email)) {
      await tx.user.update({
        where: { id: owner.id },
        data: {
          approval_status: 'REJECTED',
          paid_by_owner: false,
          // v1.0.2: mirror org cooldown onto owner so their re-apply path is gated too
          rejected_at: new Date(),
          rejection_reason: reason,
          preferences: {
            ...buildCoachRejectedPreferences(owner.preferences),
            organization_id: orgId,
            organization_name: org.name,
          },
        },
      });
    }
    return true;
  });
  if (!didReject) {
    const current = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { admin_approved: true, status: true },
    });
    if (current?.admin_approved) {
      return {
        error: 'Organization already approved',
        status: 409 as const,
        finalState: 'approved' as const,
      };
    }
    return { already: true };
  }
  if (owner?.id) {
    await invalidateMeCacheForUser(owner.id);
  }

  // ── Fire-and-forget notifications ──
  // v1.0.2: `reason` is declared above (line 146) as `string | null`. Use || undefined
  // where downstream signatures expect `string | undefined`.
  if (owner?.id) {
    await createApprovalNotification(prisma, {
      data: {
        user_id: owner.id,
        type: 'ORG_REJECTED',
        meta: { organization_id: orgId, organization_name: org.name, reason: reason || undefined },
      },
      errorMessage: 'org rejected in-app notification failed',
      sentryContext: 'organization_rejection_notification_failed',
      extra: { orgId, adminId: adminId || 'email-token', reason: reason || null },
    });

    sendPushNotification(
      owner.id,
      'League Not Approved',
      `Your league "${org.name}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
      { type: 'org_rejected', organization_id: orgId }
    ).catch(err =>
      reportPushFailure('org_rejected', err, {
        user_id: owner?.id,
        org_id: orgId,
        reason: reason || null,
      })
    );
  }

  if (owner?.email) {
    sendLeagueRejectedEmail({
      to: owner.email,
      ownerName: owner.display_name || 'League Owner',
      leagueName: org.name,
      reason: reason || undefined,
    }).catch(err =>
      reportEmailFailure('league_rejected', err, { user_id: owner?.id, org_id: org.id })
    );
  }

  await notifyAllAdminsOfLeagueAction({
    action: 'league_rejected',
    leagueName: org.name,
    ownerName: owner?.display_name || undefined,
    ownerEmail: owner?.email || undefined,
    reason: reason || undefined,
  });

  return { ok: true, org };
}

// ────────────────────────────────────────────────────────────────────────────
// Coach approval (admin path)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Admin coach approval — used from /admin/coaches/:id/approve.
 * BUG FIX: now sets paid_by_owner: true (was missing before).
 * Also checks org approval prerequisite when the coach has an org.
 */
export async function approveCoach(
  userId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { note?: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      display_name: true,
      username: true,
      approval_status: true,
      preferences: true,
    },
  });
  if (!user) return { error: 'User not found', status: 404 };
  // IDOR guard: an admin must never approve their own pending coach request.
  // Parity with approveAd/approveEvent and the org-owner join-request paths.
  if (adminId && adminId === userId) {
    return { error: 'You cannot approve your own coach request', status: 403 as const };
  }
  if (user.approval_status !== 'PENDING')
    return { error: 'User is not pending approval', status: 400 };

  // Check org prerequisite: if coach has an org, it must be admin_approved
  const prefs =
    user.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
  const orgId = getCanonicalOrganizationId(user as any);
  if (orgId) {
    const orgApproved = await isOrganizationApproved(orgId, prisma);
    if (!orgApproved) {
      return {
        error: 'Organization must be approved by VarsityHub before approving coaches.',
        status: 403,
      };
    }
  }

  // BUG FIX: set paid_by_owner: true so the coach inherits the org owner's plan.
  // When the coach came through a league join request (has organization_id in prefs),
  // also create org/team memberships — otherwise the coach is "approved" but not
  // actually attached to the league they requested to join.
  const teamId = prefs?.team_id as string | undefined;
  const latestApplication = await getLatestCoachApplication(prisma as any, userId);

  // If the coach has an org with a pending join request, we approve it in the
  // same transaction. Read it up front (read-only) so the tx body stays a pure
  // set of writes.
  const pendingJoinRequest = orgId
    ? await getOrganizationJoinRequestStateForUser(orgId, userId)
    : null;

  // Guarded interactive transaction: the leading updateMany only fires while the
  // user is still PENDING, and count===0 means a concurrent approve/reject won
  // the race — abort the whole tx and report 409 (parity with
  // approveOrganization/approveAd/approveJoinRequest). A plain user.update here
  // would let two concurrent approvals both commit and double-notify the coach.
  const raced = await prisma.$transaction(async tx => {
    const transition = await tx.user.updateMany({
      where: { id: userId, approval_status: 'PENDING' },
      data: {
        approval_status: 'APPROVED',
        paid_by_owner: true,
        rejected_at: null,
        rejection_reason: null,
        preferences: buildCoachApprovedPreferences(user.preferences),
        ...buildAuthStateColumns({
          role: 'coach',
          organization_id: orgId ?? null,
          proceeding_as_fan: false,
          coach_agreement_accepted_at: new Date(),
          coach_agreement_version: Number(process.env.REQUIRED_COACH_AGREEMENT_VERSION ?? 1),
        }),
        ...buildBillingStateColumns({
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        }),
      },
    });
    if (transition.count === 0) return true;

    if (latestApplication?.status === 'submitted') {
      await tx.coachApplication.update({
        where: { id: latestApplication.id },
        data: {
          status: 'approved',
          reviewed_at: new Date(),
          reviewed_by: adminId,
          review_note: opts?.note || null,
        },
      });
    }

    // Create org membership if the coach has an organization
    if (orgId) {
      await tx.organizationMembership.upsert({
        where: { organization_id_user_id: { organization_id: orgId, user_id: userId } as any },
        update: { role: 'coach', status: 'active' },
        create: { organization_id: orgId, user_id: userId, role: 'coach', status: 'active' },
        select: { id: true },
      });

      // If there's a pending join request, mark it approved
      if (pendingJoinRequest?.status === 'pending') {
        await tx.organizationJoinRequest.updateMany({
          where: { id: pendingJoinRequest.id, status: 'pending' },
          data: { status: 'approved', reviewed_at: new Date(), reviewed_by: adminId },
        });
      }
    }

    // Create team membership if the coach was assigned to a specific team
    if (teamId) {
      await tx.teamMembership.upsert({
        where: { team_id_user_id: { team_id: teamId, user_id: userId } as any },
        update: { role: 'coach', status: 'active' },
        create: { team_id: teamId, user_id: userId, role: 'coach', status: 'active' },
      });
    }

    return false;
  });

  if (raced) {
    return {
      error: 'User approval status changed before this action completed',
      status: 409 as const,
    };
  }

  await invalidateMeCacheForUser(userId);
  addBreadcrumb('Coach approval committed', 'approval.coach', 'info', {
    action: 'approve',
    user_id: userId,
    organization_id: orgId || null,
  });

  const note = opts?.note;

  // ── Fire-and-forget notifications ──
  if (user.email) {
    const orgName = prefs?.organization_name || 'VarsityHub';
    sendCoachApprovedEmail({
      to: user.email,
      coachName: user.display_name || user.username || 'Coach',
      leagueName: orgName,
      note: note || undefined,
      destination: orgId ? 'organization' : 'coach_agreement',
    }).catch(err => reportEmailFailure('coach_approved', err, { user_id: user.id }));
  }

  await createApprovalNotification(prisma, {
    data: {
      user_id: userId,
      type: 'JOIN_REQUEST_APPROVED',
      meta: { approved_by: 'admin', note: note || undefined },
    },
    errorMessage: 'coach approved in-app notification failed',
    sentryContext: 'coach_approval_notification_failed',
    extra: { userId, adminId, note: note || null },
  });

  sendPushNotification(
    userId,
    'Congratulations!',
    `Congratulations on being accepted as a coach! Tap to complete your setup.${note ? ` Note: ${note}` : ''}`,
    { type: 'coach_approved', screen: 'onboarding' }
  ).catch(err => reportPushFailure('coach_approved', err, { user_id: userId, admin_id: adminId }));

  return { ok: true, user };
}

/**
 * Admin coach rejection — used from /admin/coaches/:id/reject.
 */
export async function rejectCoach(
  userId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { reason?: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      display_name: true,
      username: true,
      approval_status: true,
      preferences: true,
    },
  });
  if (!user) return { error: 'User not found', status: 404 };
  // Platform admins must never be pushed into coach REJECTED — it triggers the
  // pending-approval routing loop with no self-service recovery (the emancero
  // incident). Refuse regardless of caller: admin dashboard, email token, or the
  // auto-expire cron. isAdminEmail() safely returns false for a null email.
  if (isAdminEmail(user.email)) {
    captureException(new Error('[rejectCoach] refused: target is a platform admin'), {
      tags: { area: 'coach-approval' },
      extra: { userId, adminId },
    });
    return { error: 'Cannot reject a platform admin', status: 403 };
  }
  if (user.approval_status !== 'PENDING')
    return { error: 'User is not pending approval', status: 400 };

  const reason = opts?.reason;
  const rejectedAt = new Date();
  const latestApplication = await getLatestCoachApplication(prisma as any, userId);

  // v1.0.2: persist rejected_at + reason so requireOnboarded / auth handlers
  // can enforce 48hr cooldown on re-apply (see REJECTION_COOLDOWN_MS below).
  await prisma.$transaction(async tx => {
    await tx.user.update({
      where: { id: userId },
      data: {
        approval_status: 'REJECTED',
        paid_by_owner: false,
        rejected_at: rejectedAt,
        rejection_reason: reason || null,
        preferences: buildCoachRejectedPreferences(user.preferences),
        ...buildAuthStateColumns({
          role: 'coach',
          organization_id: getCanonicalOrganizationId(user as any),
        }),
      },
    });
    if (latestApplication?.status === 'submitted') {
      await tx.coachApplication.update({
        where: { id: latestApplication.id },
        data: {
          status: 'rejected',
          reviewed_at: rejectedAt,
          reviewed_by: adminId,
          review_note: reason || null,
        },
      });
    }
  });
  await invalidateMeCacheForUser(userId);

  // In-app notification is the guaranteed channel — the pending-approval screen
  // reads the rejection reason from here. Await it so a DB write failure surfaces
  // to Sentry instead of dying as an unhandled rejection.
  await createApprovalNotification(prisma, {
    data: {
      user_id: userId,
      type: 'COACH_REJECTED',
      meta: { rejected_by: 'admin', reason: reason || null },
    },
    errorMessage: 'coach rejected in-app notification failed',
    sentryContext: 'coach_rejection_notification_failed',
    extra: { userId, adminId, reason: reason || null },
  });

  // Email and push are best-effort — in-app above is the canonical record.
  if (user.email) {
    const prefs =
      user.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
    const orgName = prefs?.organization_name || 'VarsityHub';
    sendCoachRejectedEmail({
      to: user.email,
      coachName: user.display_name || user.username || 'Coach',
      leagueName: orgName,
      reason: reason || undefined,
    }).catch(err => {
      console.error('[approvalService] coach rejected email failed:', err);
      captureException(err as Error, { context: 'coach_rejection_email_failed', userId });
    });
  }

  sendPushNotification(
    userId,
    'Application Update',
    `Your coach application was not approved.${reason ? ` Reason: ${reason}` : ''}`,
    { type: 'coach_rejected', screen: 'onboarding' }
  ).catch(err =>
    reportPushFailure('coach_rejected', err, {
      user_id: userId,
      admin_id: adminId,
      reason: reason || null,
    })
  );

  return { ok: true, user };
}

// ────────────────────────────────────────────────────────────────────────────
// Ad approval
// ────────────────────────────────────────────────────────────────────────────

export async function approveAd(
  adId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: {
    note?: string;
    /**
     * Required when `banner_moderation_status === 'flagged'`. The reason is
     * persisted in `admin_note` alongside the top moderation labels so the
     * decision is auditable after the fact.
     */
    bannerOverride?: { reason: string };
  }
) {
  const ad = await prisma.ad.findUnique({ where: { id: adId } });
  if (!ad) return { error: 'Ad not found', status: 404 };
  if (ad.status !== 'pending')
    return { error: `Ad status is '${ad.status}', not 'pending'`, status: 400 };
  // IDOR guard: an admin must not approve an ad they personally own.
  if (adminId && ad.user_id === adminId) {
    return { error: 'You cannot approve your own ad', status: 403 as const };
  }
  // Identity-less (email-token) path hardening: without an authenticated admin
  // the self-approval guard above can't run, so an ad OWNED BY A PLATFORM ADMIN
  // must be actioned from the signed-in dashboard where identity is known.
  // Non-admin-owned ads can't reach this path — moderation tokens are emailed
  // only to admins, never to the ad owner — so this closes the sole self-approve
  // vector (an admin clicking the email link for their own ad while logged out).
  if (!adminId && ad.user_id) {
    const owner = await prisma.user.findUnique({
      where: { id: ad.user_id },
      select: { email: true },
    });
    if (owner?.email && isAdminEmail(owner.email)) {
      return {
        error: 'Admin-owned ads must be approved from the signed-in dashboard',
        status: 403 as const,
      };
    }
  }

  // Banner moderation gate. A flagged banner requires an explicit override +
  // reason so a flagged image can never silently reach production. Moderation
  // errors (could-not-scan) are allowed through but annotated automatically so
  // support can tell the difference between "scanned clean" and "scan failed".
  const moderationStatus = (ad as any).banner_moderation_status as
    | 'clean'
    | 'flagged'
    | 'error'
    | null;
  const rawLabels = (ad as any).banner_moderation_labels;
  const moderationLabels: Array<{ name: string; confidence: number }> = Array.isArray(rawLabels)
    ? (rawLabels as any[]).filter(l => l && typeof l === 'object' && typeof l.name === 'string')
    : [];
  const moderationScore = (ad as any).banner_moderation_score as number | null;
  const moderationError = (ad as any).banner_moderation_error as string | null;

  let derivedAdminNote: string | null = opts?.note?.trim() || null;

  if (moderationStatus === 'flagged') {
    const reason = opts?.bannerOverride?.reason?.trim() || '';
    if (reason.length < 10 || reason.length > 2000) {
      return {
        error: 'banner_moderation_flag_requires_override',
        status: 409 as const,
        moderation: {
          status: moderationStatus,
          score: moderationScore,
          labels: moderationLabels.slice(0, 5),
        },
      };
    }
    const topLabels = moderationLabels
      .slice(0, 3)
      .map(l => `${l.name} (${Math.round(l.confidence)}%)`)
      .join(', ');
    const overrideLine = `[moderation override] reason: ${reason} | top labels: ${topLabels || 'none captured'} | admin: ${adminId || 'unknown'}`;
    derivedAdminNote = derivedAdminNote ? `${overrideLine}\n${derivedAdminNote}` : overrideLine;
    console.warn(
      `[approvalService] Ad ${adId} approved over moderation flag by ${adminId || 'unknown'}. Reason: ${reason}. Labels: ${topLabels}`
    );
  } else if (moderationStatus === 'error') {
    const note = `[moderation] Approved without successful scan: ${(moderationError || 'unknown').slice(0, 200)}`;
    derivedAdminNote = derivedAdminNote ? `${note}\n${derivedAdminNote}` : note;
    console.warn(
      `[approvalService] Ad ${adId} approved despite moderation error: ${moderationError || 'unknown'}`
    );
  }

  const guard = await prisma.ad.updateMany({
    where: { id: adId, status: 'pending' },
    data: {
      // A paid ad that was bounced back to `pending` (e.g. edited after going
      // live) must return to `active` on re-approval so it re-enters the feed —
      // `/for-feed` requires status:'active' AND payment_status:'paid', and no
      // other path restores `active` for an already-paid ad. Approval alone
      // never activates an UNPAID ad; that still waits for payment.
      status: ad.payment_status === 'paid' ? 'active' : 'approved',
      payment_status: ad.payment_status === 'paid' ? 'paid' : 'unpaid',
      ...(derivedAdminNote ? { admin_note: derivedAdminNote } : {}),
    },
  });
  if (guard.count === 0) {
    addBreadcrumb('Ad approval lost race', 'approval.ad', 'warning', {
      action: 'approve',
      ad_id: adId,
    });
    return { error: 'Ad approval status changed before approval could be applied', status: 409 };
  }
  const updated = await prisma.ad.findUnique({ where: { id: adId } });

  // ── Fire-and-forget notifications ──
  if (ad.contact_email) {
    sendAdApprovedEmail({
      to: ad.contact_email,
      businessName: ad.business_name || undefined,
      note: opts?.note || undefined,
    }).catch(err => reportEmailFailure('ad_approved', err, { ad_id: adId, user_id: ad.user_id }));
  }
  if (ad.user_id) {
    await createApprovalNotification(prisma, {
      data: {
        user_id: ad.user_id,
        type: 'AD_APPROVED' as any,
        meta: { ad_id: adId, business_name: ad.business_name },
      },
      errorMessage: 'ad approved in-app notification failed',
      sentryContext: 'ad_approval_notification_failed',
      extra: { adId, adminId: adminId || null },
    });

    sendPushNotification(
      ad.user_id,
      'Ad Approved!',
      `Your ad for "${ad.business_name || 'your business'}" has been approved. Tap to complete payment.`,
      { type: 'ad_approved', ad_id: adId }
    ).catch(err =>
      reportPushFailure('ad_approved', err, { ad_id: adId, user_id: ad.user_id, admin_id: adminId })
    );
  }

  await notifyAllAdminsOfAdAction({
    action: 'ad_approved',
    adName: ad.business_name || 'Untitled Ad',
  });

  return { ad: updated };
}

/**
 * Issue a Stripe refund for a paid, rejected ad — IDEMPOTENTLY. A stable
 * idempotency key (`ad-refund-<adId>`) means Stripe returns the existing refund
 * instead of double-refunding, so both the reject path AND the reconciliation
 * sweep can call this safely. On success the AD_PURCHASE tx is marked REFUNDED.
 * Returns { ok:false, error } for the caller to alarm on — a failed refund must
 * never be silent (it strands a real charge in payment_status:'refund_pending').
 */
async function issueAdRefund(
  prisma: PrismaClient,
  ad: { id: string; user_id: string | null }
): Promise<{ ok: boolean; amount?: number; refund_id?: string; error?: string }> {
  if (!ad.user_id) return { ok: false, error: 'no_user' };
  const tx = await prisma.transactionLog.findFirst({
    where: {
      user_id: ad.user_id,
      order_id: ad.id,
      transaction_type: 'AD_PURCHASE',
      status: 'COMPLETED',
    },
    orderBy: { created_at: 'desc' },
  });
  if (!tx?.stripe_payment_intent_id) {
    // An Apple-IAP-paid ad has no Stripe payment intent — the server cannot issue
    // an Apple refund. Signal a distinct terminal state (manual review) so reject
    // doesn't strand it in refund_pending where the reconcile re-alarms hourly.
    if (tx?.apple_transaction_id) {
      return { ok: false, error: 'apple_iap_manual_review' };
    }
    // The refund may already have been issued on a prior partial run (the tx was
    // flipped to REFUNDED) while the ad row failed to reach `refunded` — the money
    // is already back with the customer. Detect that so the reconcile sweep can
    // drain the stuck ad state instead of re-alarming hourly on a phantom
    // "unrecovered refund" (there is no COMPLETED tx left to re-refund).
    const alreadyRefunded = await prisma.transactionLog.findFirst({
      where: {
        user_id: ad.user_id,
        order_id: ad.id,
        transaction_type: 'AD_PURCHASE',
        status: 'REFUNDED' as any,
      },
      select: { id: true },
    });
    if (alreadyRefunded) {
      return { ok: false, error: 'already_refunded' };
    }
    return { ok: false, error: 'no_payment_intent_found' };
  }
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-06-20' as any,
    timeout: 20000,
    maxNetworkRetries: 2,
  });
  // Metadata is kept stable (no per-caller fields) so the idempotency key never
  // conflicts between the reject path and the sweep. Attribution lives in
  // AdminActivityLog, not here.
  const refund = await stripe.refunds.create(
    {
      payment_intent: tx.stripe_payment_intent_id,
      reason: 'requested_by_customer',
      metadata: { reason: 'admin_rejected_ad', ad_id: ad.id },
    },
    { idempotencyKey: `ad-refund-${ad.id}` }
  );
  await prisma.transactionLog
    .update({
      where: { id: tx.id },
      data: {
        status: 'REFUNDED' as any,
        metadata: {
          ...((tx.metadata as any) || {}),
          refund_reason: 'admin_rejected_ad',
          stripe_refund_id: refund.id,
          refunded_amount_cents: refund.amount ?? tx.total_cents,
          refunded_at: new Date().toISOString(),
        },
      },
    })
    .catch((e: any) => console.error('[approvalService] failed to update tx log on ad refund:', e));
  return { ok: true, amount: refund.amount ?? tx.total_cents ?? undefined, refund_id: refund.id };
}

export async function rejectAd(
  adId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { reason?: string }
) {
  const ad = await prisma.ad.findUnique({ where: { id: adId } });
  if (!ad) return { error: 'Ad not found', status: 404 };
  if (ad.status !== 'pending')
    return { error: `Ad status is '${ad.status}', not 'pending'`, status: 400 };
  // IDOR guard: an admin must not reject an ad they personally own.
  if (adminId && ad.user_id === adminId) {
    return { error: 'You cannot reject your own ad', status: 403 as const };
  }
  // Identity-less (email-token) path hardening — see approveAd for the rationale.
  if (!adminId && ad.user_id) {
    const owner = await prisma.user.findUnique({
      where: { id: ad.user_id },
      select: { email: true },
    });
    if (owner?.email && isAdminEmail(owner.email)) {
      return {
        error: 'Admin-owned ads must be rejected from the signed-in dashboard',
        status: 403 as const,
      };
    }
  }

  const guard = await prisma.$transaction(async tx => {
    const transition = await tx.ad.updateMany({
      where: { id: adId, status: 'pending' },
      data: {
        status: 'draft',
        payment_status: ad.payment_status === 'paid' ? 'refund_pending' : 'unpaid',
        ...(opts?.reason ? { admin_note: opts.reason } : {}),
      },
    });
    if (transition.count === 0) return { count: 0 };
    await tx.adReservation.deleteMany({ where: { ad_id: adId } });
    return { count: transition.count };
  });
  if (guard.count === 0) {
    addBreadcrumb('Ad rejection lost race', 'approval.ad', 'warning', {
      action: 'reject',
      ad_id: adId,
    });
    return { error: 'Ad approval status changed before rejection could be applied', status: 409 };
  }

  // Refund only after the pending row has been claimed, so concurrent
  // moderator actions cannot issue a refund for an ad that another admin approved.
  let refundResult: { ok: boolean; amount?: number; refund_id?: string; error?: string } | null =
    null;
  if (ad.payment_status === 'paid' && ad.user_id) {
    try {
      refundResult = await issueAdRefund(prisma, ad);
    } catch (refundErr: any) {
      refundResult = { ok: false, error: refundErr?.message || 'refund_api_failed' };
    }
    if (refundResult.ok) {
      await prisma.ad.update({ where: { id: adId }, data: { payment_status: 'refunded' } });
    } else if (refundResult.error === 'apple_iap_manual_review') {
      // Apple IAP: the server can't refund. Move to a TERMINAL manual-review state
      // so the hourly reconcile stops re-attempting/re-alarming; alert once so ops
      // can process the Apple-side refund out of band.
      await prisma.ad.update({
        where: { id: adId },
        data: { payment_status: 'manual_refund_review' },
      });
      captureException(new Error('Ad reject: Apple IAP refund needs manual review'), {
        context: 'ad_reject_apple_iap_manual_review',
        adId,
        userId: ad.user_id,
      });
    } else {
      // A failed Stripe refund leaves the ad in payment_status:'refund_pending' with
      // a real charge outstanding. This MUST be loud — alarm to Sentry so ops see
      // it, and the ad-refund-reconcile sweep re-attempts it hourly (idempotent).
      console.error(
        '[approvalService] CRITICAL: ad reject refund not completed — left in refund_pending',
        { adId, error: refundResult.error }
      );
      captureException(new Error(`Ad reject refund failed: ${refundResult.error}`), {
        context: 'ad_reject_refund_failed',
        adId,
        userId: ad.user_id,
        error: refundResult.error,
      });
    }
  }

  // ── Fire-and-forget notifications ──
  const reason = opts?.reason;
  if (ad.contact_email) {
    sendAdRejectedEmail({
      to: ad.contact_email,
      businessName: ad.business_name || undefined,
      reason: reason || undefined,
    }).catch(err => reportEmailFailure('ad_rejected', err, { ad_id: adId, user_id: ad.user_id }));
  }
  if (ad.user_id) {
    await createApprovalNotification(prisma, {
      data: {
        user_id: ad.user_id,
        type: 'AD_REJECTED' as any,
        meta: { ad_id: adId, business_name: ad.business_name, reason: reason || null },
      },
      errorMessage: 'ad rejected in-app notification failed',
      sentryContext: 'ad_rejection_notification_failed',
      extra: { adId, adminId: adminId || null, reason: reason || null },
    });

    sendPushNotification(
      ad.user_id,
      'Ad Needs Changes',
      `Your ad for "${ad.business_name || 'your business'}" was not approved.${reason ? ` Reason: ${reason}` : ' Please review and resubmit.'}`,
      { type: 'ad_rejected', ad_id: adId }
    ).catch(err =>
      reportPushFailure('ad_rejected', err, {
        ad_id: adId,
        user_id: ad.user_id,
        admin_id: adminId,
        reason: reason || null,
      })
    );
  }

  await notifyAllAdminsOfAdAction({
    action: 'ad_rejected',
    adName: ad.business_name || 'Untitled Ad',
    reason: reason || undefined,
  });

  const updated = await prisma.ad.findUnique({ where: { id: adId } });
  return { ad: updated };
}

// ────────────────────────────────────────────────────────────────────────────
// Event approval
// ────────────────────────────────────────────────────────────────────────────

export async function approveEvent(
  eventId: string,
  adminId: string | null,
  prisma: PrismaClient
): Promise<EventReviewResult> {
  const review = await loadPendingEventForReview(eventId, adminId, prisma, 'approve');
  if (!review.ok) return review;

  const guard = await prisma.event.updateMany({
    where: { id: eventId, approval_status: 'pending' },
    data: {
      approval_status: 'approved',
      status: 'approved',
      approved_by: adminId,
      approved_at: new Date(),
    },
  });
  if (guard.count === 0) {
    return buildEventReviewRaceResponse(eventId, prisma, 'approve');
  }

  const updated = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    include: {
      creator: { select: { id: true, display_name: true, email: true } },
    },
  });

  // ── Fire-and-forget notifications ──
  if (updated.creator_id) {
    sendPushNotification(
      updated.creator_id,
      'Event Approved',
      `Your event "${updated.title}" has been approved and is now visible to everyone!`,
      { type: 'event_approved', event_id: eventId, screen: 'event-detail', event_id_param: eventId }
    ).catch(err =>
      reportPushFailure('event_approved', err, {
        event_id: eventId,
        user_id: updated.creator_id,
        admin_id: adminId,
      })
    );

    await createApprovalNotification(prisma, {
      data: {
        user_id: updated.creator_id,
        type: 'EVENT_APPROVED',
        meta: { event_id: eventId, event_title: updated.title },
      },
      errorMessage: 'event approved in-app notification failed',
      sentryContext: 'event_approval_notification_failed',
      extra: { eventId, userId: updated.creator_id, adminId },
    });

    // Email
    const creator = (updated as any).creator;
    if (creator?.email) {
      const eventDate = updated.date ? new Date(updated.date) : new Date();
      sendEventApprovedEmail({
        to: creator.email,
        recipientName: creator.display_name || 'Fan',
        eventTitle: updated.title,
        eventDate: eventDate.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
        eventTime: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        eventLocation: updated.location || '',
        eventId,
      }).catch(err =>
        reportEmailFailure('event_approved', err, { event_id: eventId, user_id: creator?.id })
      );
    }
  }

  return { ok: true, event: updated };
}

export async function rejectEvent(
  eventId: string,
  adminId: string | null,
  prisma: PrismaClient,
  opts?: { reason?: string }
): Promise<EventReviewResult> {
  const review = await loadPendingEventForReview(eventId, adminId, prisma, 'reject');
  if (!review.ok) return review;

  const reason = opts?.reason;

  const guard = await prisma.event.updateMany({
    where: { id: eventId, approval_status: 'pending' },
    data: {
      approval_status: 'rejected',
      status: 'rejected',
      rejected_reason: reason,
      approved_by: null,
      approved_at: null,
    },
  });
  if (guard.count === 0) {
    return buildEventReviewRaceResponse(eventId, prisma, 'reject');
  }

  const updated = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    include: {
      creator: { select: { id: true, display_name: true, email: true } },
    },
  });

  // ── Fire-and-forget notifications ──
  if (updated.creator_id) {
    const reasonText = reason ? ` Reason: ${reason}` : '';
    sendPushNotification(
      updated.creator_id,
      'Event Not Approved',
      `Your event "${updated.title}" was not approved.${reasonText}`,
      {
        type: 'event_rejected',
        event_id: eventId,
        reason: reason || null,
        screen: 'event-detail',
        event_id_param: eventId,
      }
    ).catch(err =>
      reportPushFailure('event_rejected', err, {
        event_id: eventId,
        user_id: updated.creator_id,
        admin_id: adminId,
        reason: reason || null,
      })
    );

    await createApprovalNotification(prisma, {
      data: {
        user_id: updated.creator_id,
        type: 'EVENT_REJECTED',
        meta: { event_id: eventId, event_title: updated.title, reason: reason || null },
      },
      errorMessage: 'event rejected in-app notification failed',
      sentryContext: 'event_rejection_notification_failed',
      extra: { eventId, userId: updated.creator_id, adminId, reason: reason || null },
    });

    const creator = (updated as any).creator;
    if (creator?.email) {
      sendEventDeniedEmail({
        to: creator.email,
        recipientName: creator.display_name || 'User',
        eventTitle: updated.title,
        reason: reason || undefined,
      }).catch(err =>
        reportEmailFailure('event_denied', err, { event_id: eventId, user_id: creator?.id })
      );
    }
  }

  return { ok: true, event: updated };
}

// ────────────────────────────────────────────────────────────────────────────
// Scheduled auto-expiration helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Send reminder to admins about coaches pending > 7 days.
 * Called by scheduler daily.
 */
export async function remindPendingCoachApprovals(prisma: PrismaClient): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Key off APPLICATION submission, not User.created_at — an established user
  // who upgrades to coach today must not count as "pending 7 days" because
  // their account is old.
  const staleApplications = await prisma.coachApplication.findMany({
    where: {
      status: 'submitted',
      submitted_at: { lt: sevenDaysAgo },
      user: { approval_status: 'PENDING' },
    },
    select: { id: true, user_id: true },
    take: 50,
  });

  if (staleApplications.length === 0) return 0;

  console.log(`[approval-reminder] ${staleApplications.length} coach(es) pending > 7 days`);

  return staleApplications.length;
}

/**
 * Auto-reject coaches pending > 30 days with no admin action.
 * Called by scheduler daily. Sends rejection email with reason.
 */
export async function autoExpirePendingCoaches(prisma: PrismaClient): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Expire based on how long the APPLICATION has been awaiting review, not the
  // age of the user account. Keying off User.created_at wrongly auto-rejected
  // established users the moment they upgraded to coach (2026-07-14 audit).
  const staleApplications = await prisma.coachApplication.findMany({
    where: {
      status: 'submitted',
      submitted_at: { lt: thirtyDaysAgo },
      user: { approval_status: 'PENDING' },
    },
    select: { user_id: true },
    take: 50,
  });

  const { logAdminActivity } = await import('./adminActivityLogger.js');

  for (const app of staleApplications) {
    try {
      const result = await rejectCoach(app.user_id, 'system', prisma, {
        reason: 'Application expired after 30 days without admin review. Please re-apply.',
      });
      // Emit the audit-log row here: rejectCoach itself doesn't log (the trail is
      // normally written by the route handler), so a cron-driven auto-expire —
      // an automated, destructive state change — would otherwise leave NO
      // AdminActivityLog entry. logAdminActivity swallows its own errors.
      if (result && !('error' in result)) {
        await logAdminActivity(
          'system',
          'system',
          'REJECT_COACH',
          'user',
          app.user_id,
          'Coach application auto-expired after 30 days without admin review',
          { reason: 'auto_expire', threshold_days: 30 }
        );
      }
    } catch (err) {
      console.error(`[auto-expire] Failed to expire coach ${app.user_id}:`, err);
    }
  }

  if (staleApplications.length > 0) {
    console.log(`[auto-expire] Expired ${staleApplications.length} coach application(s)`);
  }

  return staleApplications.length;
}

/**
 * Auto-reject pending events past their event date.
 * Called by scheduler daily.
 */
export async function autoExpireStaleEvents(prisma: PrismaClient): Promise<number> {
  const now = new Date();

  const result = await prisma.event.updateMany({
    where: {
      approval_status: 'pending',
      date: { lt: now },
    },
    data: {
      approval_status: 'rejected',
      rejected_reason: 'Auto-expired: event date has passed',
    },
  });

  if (result.count > 0) {
    console.log(`[auto-expire] Expired ${result.count} past-date pending event(s)`);
  }

  return result.count;
}

/**
 * Owner "commandments" rule (2026-09-14): "If an event page doesn't get post
 * after the 8 hours, it can be removed from the database. But should still
 * be live window on feed and map until the 8 hours expire." Once an
 * event's geofenced live window (server/src/lib/geofencing.ts — the same
 * bounds that drive the feed LIVE badge and map pin, so it stays visible for
 * the full window before this ever runs) has closed with zero posts and
 * zero stories, the page never became a "real" event page and is purged.
 *
 * Scoped to standalone event pages only (game_id: null) — a linked Game
 * carries its own historical value (final score, stats) independent of
 * whether anyone posted, so competitive games are never touched here.
 * Cascades (EventRsvp, EventPostingUnlock, EventDesignatedPoster, poll
 * votes, stories) clean up automatically; Post.event_id is SET NULL, moot
 * here since the query already requires zero posts.
 */
export async function purgeUnpostedEventPages(prisma: PrismaClient): Promise<number> {
  const { getPostPostingWindowBounds } = await import('./geofencing.js');
  const now = new Date();

  const candidates = await prisma.event.findMany({
    where: {
      game_id: null,
      approval_status: 'approved',
      // Cheap DB-level floor: an event that hasn't even started yet can never
      // have a closed window. The exact per-event cutoff (which varies with
      // live_window_hours_after_start) is checked precisely below.
      date: { lt: now },
      posts: { none: {} },
      stories: { none: {} },
    },
    select: { id: true, date: true, live_window_hours_after_start: true },
    take: 200,
  });

  const toDelete = candidates.filter(event => {
    const { liveCutoff } = getPostPostingWindowBounds(
      event.date,
      event.live_window_hours_after_start
    );
    return now > liveCutoff;
  });

  if (toDelete.length === 0) return 0;

  const result = await prisma.event.deleteMany({
    where: { id: { in: toDelete.map(e => e.id) } },
  });

  if (result.count > 0) {
    console.log(`[purge-unposted-events] Removed ${result.count} unposted event page(s)`);
  }

  return result.count;
}

/**
 * Reconcile ads stranded in payment_status:'refund_pending' — a rejected paid
 * ad whose refund didn't confirm (Stripe error, missing payment_intent, or a DB
 * write that failed after Stripe succeeded). Re-issues the refund idempotently
 * (safe: `ad-refund-<id>` key means Stripe returns any existing refund rather
 * than double-refunding), marks 'refunded' on success, and ALARMS to Sentry on
 * anything still stuck so a real charge can never be silently stranded.
 * Called by the scheduler. Returns the number recovered.
 */
export async function reconcileStuckAdRefunds(prisma: PrismaClient): Promise<number> {
  // Give the immediate reject-path attempt time to land before sweeping.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const stuck = await prisma.ad.findMany({
    where: { payment_status: 'refund_pending', updated_at: { lt: cutoff } },
    select: { id: true, user_id: true },
    take: 50,
  });

  let recovered = 0;
  for (const ad of stuck) {
    try {
      const res = await issueAdRefund(prisma, ad);
      if (res.ok) {
        await prisma.ad.update({ where: { id: ad.id }, data: { payment_status: 'refunded' } });
        recovered++;
      } else if (res.error === 'apple_iap_manual_review') {
        // Apple IAP can't be server-refunded — drain to the terminal manual state
        // so we stop re-alarming on it every hour. Counts as resolved.
        await prisma.ad.update({
          where: { id: ad.id },
          data: { payment_status: 'manual_refund_review' },
        });
        recovered++;
      } else if (res.error === 'already_refunded') {
        // Refund already issued on a prior partial run — the ad row just never
        // flipped. Drain it to `refunded` and stop the phantom hourly alarm.
        await prisma.ad.update({
          where: { id: ad.id },
          data: { payment_status: 'refunded' },
        });
        recovered++;
      } else {
        captureException(new Error(`Stuck ad refund unrecovered: ${res.error}`), {
          context: 'ad_refund_reconcile_stuck',
          adId: ad.id,
          userId: ad.user_id,
          error: res.error,
        });
      }
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), {
        context: 'ad_refund_reconcile_error',
        adId: ad.id,
      });
    }
  }

  if (stuck.length > 0) {
    console.log(`[ad-refund-reconcile] ${stuck.length} stuck, ${recovered} recovered`);
  }
  return recovered;
}
