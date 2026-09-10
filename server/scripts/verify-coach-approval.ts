#!/usr/bin/env npx tsx
/**
 * verify-coach-approval.ts
 *
 * Static verification that coach approval logic is correctly wired.
 * Run: cd server && npx tsx scripts/verify-coach-approval.ts
 *
 * Does NOT require database. Exit 0 = all checks pass.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
let errors = 0;

function read(path: string): string {
  const full = join(ROOT, path);
  if (!existsSync(full)) return '';
  return readFileSync(full, 'utf-8');
}

function check(name: string, ok: boolean, msg?: string) {
  if (ok) {
    console.log(`✅ ${name}`);
  } else {
    console.error(`❌ ${name}${msg ? `: ${msg}` : ''}`);
    errors++;
  }
}

console.log('\n🔍 Coach Approval System Verification\n');

// 1. requireOnboarded blocks PENDING coaches
const onboarded = read('src/middleware/requireOnboarded.ts');
check(
  'requireOnboarded blocks PENDING coaches',
  // Middleware now uses canonical role helpers rather than reading prefs.role
  // directly; the approval gate still blocks any coach whose status is not
  // explicitly APPROVED.
  /role === 'coach' && u\?\.approval_status !== 'APPROVED'/.test(onboarded)
);

// 2. POST /organizations conditionally sets creator to PENDING when approval must be re-checked
const orgRoutes = read('src/routes/organizations.ts');
const approvalService = read('src/lib/approvalService.ts');
const organizationJoinRequests = read('src/lib/organizationJoinRequests.ts');
const conditionalPendingWrite =
  /\.\.\.\(shouldForcePendingApproval \? \{ approval_status: 'PENDING' \} : \{\}\)/;
check(
  'POST /organizations conditionally sets creator to PENDING',
  conditionalPendingWrite.test(orgRoutes)
);

// 3. Both routes delegate through the shared route/preflight/request pipeline.
// 78fbdd49 extracted the route handler; the approval decision deliberately lives
// before route registration now, so a regex scanning forward from /create is stale.
const sharedRouteStart = orgRoutes.indexOf('async function handleOrganizationCreateRoute(');
const sharedRouteEnd = orgRoutes.indexOf('// Create organization', sharedRouteStart);
const sharedRoute = orgRoutes.slice(sharedRouteStart, sharedRouteEnd);
const preflightStart = orgRoutes.indexOf('async function prepareOrganizationCreatePreflight(');
const preflightEnd = orgRoutes.indexOf(
  'async function handleOrganizationCreateRequest(',
  preflightStart
);
const preflight = orgRoutes.slice(preflightStart, preflightEnd);
const createRouteHasConditionalPending =
  /organizationsRouter\.post\(\s*['"]\/create['"][\s\S]*?return handleOrganizationCreateRoute\(req, res, ['"]\/create['"]\)/m.test(
    orgRoutes
  ) &&
  sharedRouteStart >= 0 &&
  sharedRouteEnd > sharedRouteStart &&
  sharedRoute.includes('await prepareOrganizationCreatePreflight({') &&
  sharedRoute.includes('if (!preflight) return;') &&
  sharedRoute.includes('return handleOrganizationCreateRequest(req, res, data, {') &&
  sharedRoute.includes('shouldForcePendingApproval: preflight.shouldForcePendingApproval') &&
  preflightStart >= 0 &&
  preflightEnd > preflightStart &&
  preflight.includes('await shouldForcePendingApprovalOnOrganizationCreate({') &&
  preflight.includes('return { authorizedInviteInputs, shouldForcePendingApproval }');
check(
  'POST /organizations/create uses shared conditional pending approval flow',
  createRouteHasConditionalPending
);

// 4. League approval sets league owner to APPROVED
check(
  'League approval sets league owner to APPROVED',
  orgRoutes.includes('/:id/approve') &&
    orgRoutes.includes('approveLeagueHandler') &&
    orgRoutes.includes('approveOrganization(orgId') &&
    approvalService.includes('league_owner_id') &&
    approvalService.includes("approval_status: 'APPROVED'")
);

// 5. Coach approval by league owner
check(
  'League owner can approve coaches (POST /join-requests/:requestId/approve)',
  orgRoutes.includes('/join-requests/:requestId/approve') &&
    orgRoutes.includes('Only the organization owner can approve coach requests') &&
    orgRoutes.includes('approveJoinRequest({') &&
    organizationJoinRequests.includes("approval_status: 'APPROVED'") &&
    organizationJoinRequests.includes('paid_by_owner: true')
);

// 6. Join request sets coach to PENDING
const joinRequestBlock =
  orgRoutes.includes('join-requests') &&
  (orgRoutes.includes('isCoachRole') || orgRoutes.includes("approval_status: 'PENDING'"));
check('Join request sets coach to PENDING when coach role', joinRequestBlock);

// 7. Team creation uses requireOnboarded
const teams = read('src/routes/teams.ts');
check(
  'Team creation uses requireOnboarded',
  teams.includes('requireOnboarded') && teams.includes('/create')
);

// 8. Event creation uses requireOnboarded
const events = read('src/routes/events.ts');
check('Event creation uses requireOnboarded', events.includes('requireOnboarded'));

// 9. Coach approval test exists
const testExists = existsSync(join(ROOT, 'src/__tests__/coach-approval.test.ts'));
check('Coach approval integration test exists', testExists);

console.log('');
if (errors > 0) {
  console.error(`${errors} check(s) failed.`);
  process.exit(1);
}
console.log('All coach approval checks passed.');
process.exit(0);
