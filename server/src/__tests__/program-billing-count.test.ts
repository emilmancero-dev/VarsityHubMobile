// server/src/__tests__/program-billing-count.test.ts
import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../lib/prisma.js';
import { countBillableProgramsForContext } from '../lib/teamCreate.js';

const ts = Date.now();
let orgId = '';
let ownerId = '';

describe('countBillableProgramsForContext (org context)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `pbc-${ts}@t.co`,
        password_hash: 'x',
        username: `pbc${ts}`,
        plan: 'rookie',
        onboarding_completed: true,
      },
    });
    ownerId = owner.id;
    const org = await prisma.organization.create({
      data: { name: `PBC Org ${ts}`, league_owner_id: ownerId, updated_at: new Date() },
    });
    orgId = org.id;
    // Two sports = two programs; basketball has an active team, baseball only archived.
    const bball = await prisma.sportProgram.create({
      data: { organization_id: orgId, sport: 'basketball' },
    });
    const bball2 = await prisma.sportProgram.create({
      data: { organization_id: orgId, sport: 'baseball' },
    });
    await prisma.team.create({
      data: {
        name: `V ${ts}`,
        organization_id: orgId,
        program_id: bball.id,
        level: 'varsity',
        status: 'active',
      },
    });
    await prisma.team.create({
      data: {
        name: `JV ${ts}`,
        organization_id: orgId,
        program_id: bball.id,
        level: 'jv',
        status: 'active',
      },
    });
    await prisma.team.create({
      data: {
        name: `Arch ${ts}`,
        organization_id: orgId,
        program_id: bball2.id,
        level: 'varsity',
        status: 'archived',
      },
    });
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { organization_id: orgId } });
    await prisma.sportProgram.deleteMany({ where: { organization_id: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('counts programs with an active team, not level teams and not archived-only programs', async () => {
    const n = await countBillableProgramsForContext(prisma, ownerId, {
      effectivePlan: 'rookie',
      effectiveSubscriptionId: undefined,
      teamCountSource: 'org',
      orgIdForTeamCount: orgId,
    } as any);
    expect(n).toBe(1); // basketball only (2 level teams share it); baseball archived-only excluded
  });

  it('counts ungrouped (null-program) active teams as their own billable units (org context)', async () => {
    // Regression guard: before the fix the org branch counted only programs,
    // so a paid_by_owner coach could create unlimited program_id-less teams free.
    await prisma.team.create({
      data: { name: `Ungrouped 1 ${ts}`, organization_id: orgId, status: 'active' },
    });
    await prisma.team.create({
      data: { name: `Ungrouped 2 ${ts}`, organization_id: orgId, status: 'active' },
    });
    const n = await countBillableProgramsForContext(prisma, ownerId, {
      effectivePlan: 'rookie',
      effectiveSubscriptionId: undefined,
      teamCountSource: 'org',
      orgIdForTeamCount: orgId,
    } as any);
    expect(n).toBe(3); // 1 basketball program + 2 ungrouped active teams
  });
});
