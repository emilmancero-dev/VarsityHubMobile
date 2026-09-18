import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC_DIR, rel), 'utf8');

const FILES = {
  organizations: read('routes/organizations.ts'),
  approvalService: read('lib/approvalService.ts'),
  organizationWorkflowState: read('lib/organizationWorkflowState.ts'),
  teams: read('routes/teams.ts'),
  payments: read('routes/payments.ts'),
  teamAuthorization: read('lib/teamAuthorization.ts'),
  // Team-create org-access validation was extracted here (thin routes).
  teamCreate: read('lib/teamCreate.ts'),
};

function snippets(source: string, pattern: RegExp): string[] {
  return Array.from(source.matchAll(pattern)).map(match => match[0]);
}

describe('organization data-access invariants', () => {
  it('high-value runtime files avoid OrganizationMembership.findUnique()', () => {
    for (const [name, source] of Object.entries(FILES)) {
      expect(source.includes('prisma.organizationMembership.findUnique(')).toBe(false);
      expect(source.includes('tx.organizationMembership.findUnique(')).toBe(false);
      expect(source.includes('prisma.organizationMembership.findFirst({')).toBe(
        name === 'teamAuthorization' ||
          name === 'teams' ||
          name === 'teamCreate' ||
          name === 'approvalService' ||
          name === 'organizations'
      );
    }
  });

  it('runtime ownership checks route through getOrganizationMembership()', () => {
    expect(FILES.organizations.includes('getOrganizationMembership(')).toBe(true);
    expect(FILES.teamCreate.includes('getOrganizationMembership(')).toBe(true);
    expect(FILES.payments.includes('getOrganizationMembership(')).toBe(true);
  });

  it('org workflow lifecycle reads route through the canonical raw helpers', () => {
    expect(FILES.organizations.includes('getOrganizationJoinRequestState(')).toBe(true);
    expect(FILES.organizations.includes('getOrganizationJoinRequestStateForUser(')).toBe(true);
    expect(FILES.organizations.includes('listOrganizationJoinRequestsForOrganization(')).toBe(true);
    expect(FILES.organizations.includes('listOrganizationJoinRequestsForUser(')).toBe(true);
    expect(FILES.organizations.includes('getOrganizationInviteState(')).toBe(true);
    expect(FILES.organizations.includes('listOrganizationInvitesForEmail(')).toBe(true);
    expect(FILES.approvalService.includes('getOrganizationJoinRequestStateForUser(')).toBe(true);

    expect(FILES.organizations.includes('prisma.organizationJoinRequest.findUnique(')).toBe(false);
    expect(FILES.organizations.includes('prisma.organizationJoinRequest.findFirst(')).toBe(false);
    expect(FILES.organizations.includes('prisma.organizationJoinRequest.findMany(')).toBe(false);
    expect(FILES.approvalService.includes('prisma.organizationJoinRequest.findFirst(')).toBe(false);
  });

  it('org join-request raw helpers cast enum status columns before comparing to text params', () => {
    expect(FILES.organizationWorkflowState.includes('jr.status::text = ${normalizedStatus}')).toBe(
      true
    );
    expect(FILES.organizationWorkflowState.includes('jr.status = ${normalizedStatus}')).toBe(false);
  });

  it('org workflow writes never rely on returning legacy lifecycle columns', () => {
    const runtimeFiles = [FILES.organizations, FILES.approvalService];

    const unsafeWriteCalls = runtimeFiles.flatMap(source =>
      snippets(
        source,
        /(prisma|tx)\.organization(?:JoinRequest|Invite)\.(?:create|update|updateMany|upsert)\(\{[\s\S]{0,800}?\}\)/g
      )
    );

    expect(unsafeWriteCalls.length).toBeGreaterThan(0);

    for (const call of unsafeWriteCalls) {
      const isUpdateMany = call.includes('.updateMany(');
      expect(isUpdateMany || call.includes('select:')).toBe(true);
    }
  });

  it('organization list/detail payloads use the shared safe projection helper', () => {
    expect(FILES.organizations.includes('buildOrganizationSerializeSelect')).toBe(true);
  });
});
