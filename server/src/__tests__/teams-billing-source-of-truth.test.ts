import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const teamsRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'teams.ts'), 'utf8');
// The billing-context computation was extracted to lib/teamCreate.ts (thin
// routes). Its canonical-column reads are asserted there; the route is asserted
// to invoke it.
const teamCreateLib = readFileSync(join(process.cwd(), 'src', 'lib', 'teamCreate.ts'), 'utf8');

describe('teams billing source of truth', () => {
  it('POST /teams reads canonical billing columns before enforcing team limits', () => {
    expect(teamCreateLib).toMatch(/select:\s*\{[\s\S]{0,300}plan:\s*true/);
    expect(teamCreateLib).toMatch(/select:\s*\{[\s\S]{0,400}pending_plan:\s*true/);
    expect(teamCreateLib).toMatch(/select:\s*\{[\s\S]{0,500}payment_pending:\s*true/);
    expect(teamCreateLib).toMatch(/select:\s*\{[\s\S]{0,600}payment_approved:\s*true/);
    expect(teamCreateLib).toContain('let effectivePlan = getEffectiveEntitledPlan(me as any);');
    expect(teamsRoute).toContain(
      'const billingContext = await buildTeamCreateBillingContext(req.user!.id, user);'
    );
  });

  it('POST /teams no longer trusts mutable preferences.plan for entitlement checks', () => {
    expect(teamsRoute).not.toContain('const userPlan = userPrefs.plan ||');
  });
});
