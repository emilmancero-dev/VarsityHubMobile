// Team-create org-resolution and billing-context helpers, extracted from the
// teams route (thin routes, logic one layer down). Pure computation + reads:
// no Express, no response shaping. The security-critical create transaction
// (createTeamWithGuardrails) still lives in the route for now.
import { prisma } from './prisma.js';
import { getOrganizationMembership } from './organizationAuthorization.js';
import { getOrganizationState } from './organizationState.js';
import { getVeteranTotalTeamAllowance, resolveOwnerBillingOrgId } from './paymentInternals.js';
import { getEffectiveEntitledPlan } from './userBillingState.js';
import { buildTeamCreateOrganizationError } from './teamRouteHelpers.js';

export async function resolveOrganizationIdForTeamCreate(input: {
  organization_id?: string;
  organization_name?: string;
}) {
  const explicitOrganizationId =
    typeof input.organization_id === 'string' ? input.organization_id.trim() : '';
  if (explicitOrganizationId) {
    return { organizationId: explicitOrganizationId };
  }

  const requestedOrganizationName =
    typeof input.organization_name === 'string' ? input.organization_name.trim() : '';
  if (requestedOrganizationName) {
    const existingOrganization = await prisma.organization.findFirst({
      where: {
        name: { equals: requestedOrganizationName, mode: 'insensitive' },
        status: 'active',
      },
      select: { id: true },
    });
    if (existingOrganization) {
      return { organizationId: existingOrganization.id };
    }
  }

  return buildTeamCreateOrganizationError(
    400,
    'ORGANIZATION_REQUIRED',
    'Select an existing organization before creating a team.'
  );
}

export async function validateTeamCreateOrganizationAccess(
  userId: string,
  organizationId: string,
  _onboardingComplete: boolean
) {
  const organization = await getOrganizationState(organizationId);
  if (!organization || organization.status !== 'active') {
    return buildTeamCreateOrganizationError(
      404,
      'ORGANIZATION_NOT_FOUND',
      'The specified organization does not exist or is not active.'
    );
  }

  const orgMembership = await getOrganizationMembership(userId, organizationId);
  if (!orgMembership || orgMembership.status !== 'active') {
    return buildTeamCreateOrganizationError(
      403,
      'ORGANIZATION_MEMBERSHIP_REQUIRED',
      'You must be an active member of this organization to create a team under it.'
    );
  }

  return { ok: true as const };
}

export type TeamCreatePayload = {
  name: string;
  description?: string;
  sport?: string;
  club_type?: 'sport' | 'extracurricular';
  extracurricular_category?: string;
  season?: string;
  primary_color?: string;
  season_start?: string;
  season_end?: string;
  organization_id?: string;
  organization_name?: string;
  logo_url?: string;
  city?: string;
  state?: string;
  league?: string;
  venue_place_id?: string;
  venue_lat?: number;
  venue_lng?: number;
  venue_address?: string;
  level?: 'varsity' | 'jv' | 'freshman' | 'middle_school' | 'unified' | 'other';
  gender?: 'boys' | 'girls' | 'coed';
  program_id?: string;
  authorized_users?: Array<{
    email?: string;
    user_id?: string;
    role?: string;
    assign_team?: string;
  }>;
  onboarding?: boolean;
};

export type TeamCreateBillingContext = {
  effectivePlan: string | null | undefined;
  effectiveSubscriptionId?: string;
  teamCountSource: 'user' | 'org';
  orgIdForTeamCount?: string;
  /**
   * Whether the CALLER is the org owner whose plan is being enforced. Drives
   * limit-error copy: a non-owner cannot upgrade the plan they were gated by,
   * so telling them to "upgrade your plan" is a dead end — point at the owner.
   */
  callerIsOrgOwner: boolean;
};

const BILLING_USER_SELECT = {
  preferences: true,
  plan: true,
  pending_plan: true,
  payment_pending: true,
  payment_approved: true,
} as const;

/**
 * The user whose plan governs an organization: its active owner membership,
 * falling back to the legacy `league_owner_id` column for orgs created before
 * membership rows existed. Returns null for an ownerless org.
 */
export async function resolveOrganizationOwnerId(organizationId: string): Promise<string | null> {
  const ownerMembership = await prisma.organizationMembership.findFirst({
    where: { organization_id: organizationId, role: 'owner', status: 'active' },
    select: { user_id: true },
  });
  if (ownerMembership?.user_id) return ownerMembership.user_id;
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { league_owner_id: true },
  });
  return organization?.league_owner_id ?? null;
}

export async function buildTeamCreateBillingContext(
  userId: string,
  me: any,
  targetOrganizationId?: string | null
): Promise<TeamCreateBillingContext> {
  // A team is created INSIDE an organization and consumes that organization's
  // program allowance, so the ORG OWNER's plan is the authority — regardless of
  // who creates it or how they joined. Resolving the allowance from the CALLER
  // instead meant every invited member arrived with a private copy of the free
  // allowance (`paid_by_owner` is only stamped by join-request approval, never
  // by invite-accept), so N members = N x the cap inside one org.
  const targetOrgId = typeof targetOrganizationId === 'string' ? targetOrganizationId.trim() : '';
  if (targetOrgId) {
    const ownerId = await resolveOrganizationOwnerId(targetOrgId);
    if (ownerId) {
      const owner =
        ownerId === userId
          ? me
          : await prisma.user.findUnique({
              where: { id: ownerId },
              select: BILLING_USER_SELECT,
            });
      const ownerPrefs =
        owner?.preferences && typeof owner.preferences === 'object'
          ? (owner.preferences as any)
          : {};
      return {
        effectivePlan: getEffectiveEntitledPlan(owner as any),
        effectiveSubscriptionId: ownerPrefs.subscription_id,
        teamCountSource: 'org',
        orgIdForTeamCount: targetOrgId,
        callerIsOrgOwner: ownerId === userId,
      };
    }
  }

  // Ownerless org, or no resolvable target: fall back to the caller's own
  // context so a create is never left with no allowance check at all.
  const prefs =
    me?.preferences && typeof me.preferences === 'object' ? (me.preferences as any) : {};
  let effectivePlan = getEffectiveEntitledPlan(me as any);
  let effectiveSubscriptionId = prefs.subscription_id;
  let teamCountSource: 'user' | 'org' = 'user';
  let orgIdForTeamCount: string | undefined;

  if (me?.paid_by_owner) {
    const orgMembership = await prisma.organizationMembership.findFirst({
      where: { user_id: userId, status: 'active' },
      select: { organization: { select: { id: true, league_owner_id: true } } },
    });
    const ownerId = orgMembership?.organization?.league_owner_id;
    if (ownerId) {
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });
      const ownerPrefs =
        owner?.preferences && typeof owner.preferences === 'object'
          ? (owner.preferences as any)
          : {};
      effectivePlan = getEffectiveEntitledPlan(owner as any);
      effectiveSubscriptionId = ownerPrefs.subscription_id;
      teamCountSource = 'org';
      orgIdForTeamCount = orgMembership?.organization?.id;
    }
  } else {
    // Org owner (pays for their own org): scope Veteran billing to the org they
    // own so the create-gate counts the whole org's programs — matching the
    // org-wide checkout snapshot. Without this the owner's gate counted only
    // personally-owned teams, letting them create programs for their coaches
    // past the paid allowance without ever tripping the limit gate. Returns null
    // for non-owners (stays personal) and for ambiguous multi-org owners with no
    // explicit target org.
    const ownerOrgId = await resolveOwnerBillingOrgId(userId, targetOrganizationId);
    if (ownerOrgId) {
      teamCountSource = 'org';
      orgIdForTeamCount = ownerOrgId;
    }
  }

  return {
    effectivePlan,
    effectiveSubscriptionId,
    teamCountSource,
    orgIdForTeamCount,
    // Personal/ownerless fallback: the caller is being gated by their own plan
    // unless they are a coach covered by an owner's subscription.
    callerIsOrgOwner: !me?.paid_by_owner,
  };
}

// Phase 4 billing unit: distinct active sport programs. A program counts once it
// has ≥1 active team; level teams share a program; archived-only programs and
// null-program active teams are handled explicitly so no team escapes billing.
export async function countBillableProgramsForContext(
  db: any,
  userId: string,
  context: TeamCreateBillingContext
): Promise<number> {
  if (context.teamCountSource === 'org' && context.orgIdForTeamCount) {
    // Programs with an active team, PLUS ungrouped (null-program) active teams —
    // each ungrouped team is its own billable unit (matches the personal branch
    // below). Omitting the ungrouped count let a paid_by_owner coach create
    // unlimited program_id-less teams without ever tripping the billing gate.
    const [programs, ungrouped] = await Promise.all([
      db.sportProgram.count({
        where: {
          organization_id: context.orgIdForTeamCount,
          teams: { some: { status: 'active' } },
        },
      }),
      db.team.count({
        where: {
          organization_id: context.orgIdForTeamCount,
          status: 'active',
          program_id: null,
        },
      }),
    ]);
    return programs + ungrouped;
  }

  // Personal context: distinct programs across the user's active owned teams,
  // plus each ungrouped (null-program) active owned team as its own unit.
  const owned = await db.teamMembership.findMany({
    where: { user_id: userId, role: 'owner', status: 'active', team: { status: 'active' } },
    select: { team: { select: { program_id: true } } },
    take: 5000,
  });
  const programIds = new Set<string>();
  let ungrouped = 0;
  for (const row of owned) {
    const pid = row.team?.program_id;
    if (pid) programIds.add(pid);
    else ungrouped += 1;
  }
  return programIds.size + ungrouped;
}

export async function getVeteranSubscriptionAllowance(subscriptionId: string) {
  const stripeLib = await import('stripe');
  const stripeClient = new stripeLib.default(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-06-20',
  });
  const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
  const billableQuantity = subscription.items.data[0]?.quantity || 0;
  const active = subscription.status === 'active' || subscription.status === 'trialing';

  return {
    active,
    billableQuantity,
    totalTeamAllowance: getVeteranTotalTeamAllowance(billableQuantity),
  };
}
