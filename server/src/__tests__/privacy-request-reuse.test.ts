import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const follows = jest.fn<(...args: any[]) => Promise<any[]>>();
const teamFollows = jest.fn<(...args: any[]) => Promise<any[]>>();
const memberships = jest.fn<(...args: any[]) => Promise<any[]>>();
const orgMemberships = jest.fn<(...args: any[]) => Promise<any[]>>();
jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    follows: { findMany: follows },
    teamFollow: { findMany: teamFollows },
    teamMembership: { findMany: memberships },
    organizationMembership: { findMany: orgMemberships },
  },
}));
// Warm shared candidate inventories; authorization must still be per viewer/request.
jest.unstable_mockModule('../lib/cache.js', () => ({
  cacheGet: jest.fn(async (key: string) =>
    key === 'privacy:private_ids'
      ? ['hidden-author']
      : [{ id: 'hidden-team', organization_id: 'org' }]
  ),
  cacheSet: jest.fn(async () => {}),
  cacheDel: jest.fn(async () => {}),
}));
const { getExcludedPrivateAuthorIds, getExcludedPrivateTeamIds, getRequestBlockedCache } =
  await import('../lib/privacyUtils.js');
beforeEach(() => {
  for (const mock of [follows, teamFollows, memberships, orgMemberships])
    mock.mockReset().mockResolvedValue([]);
});
const check = async (viewer: string, cache: ReturnType<typeof getRequestBlockedCache>) =>
  Promise.all([
    getExcludedPrivateAuthorIds(viewer, cache),
    getExcludedPrivateTeamIds(viewer, cache),
  ]);
describe('request-scoped private visibility reuse', () => {
  it('three concurrent feed consumers make four authorization queries, not twelve', async () => {
    const cache = getRequestBlockedCache({});
    const results = await Promise.all([
      check('viewer', cache),
      check('viewer', cache),
      check('viewer', cache),
    ]);
    expect(results).toEqual(Array(3).fill([['hidden-author'], ['hidden-team']]));
    for (const mock of [follows, teamFollows, memberships, orgMemberships])
      expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not carry viewer decisions across requests or viewers', async () => {
    const cache = getRequestBlockedCache({});
    expect(await check('viewer', cache)).toEqual([['hidden-author'], ['hidden-team']]);
    follows.mockResolvedValue([{ following_id: 'hidden-author' }]);
    teamFollows.mockResolvedValue([{ team_id: 'hidden-team' }]);
    expect(await check('viewer', getRequestBlockedCache({}))).toEqual([[], []]);
    expect(await check('other-viewer', cache)).toEqual([[], []]);
    expect(await check('viewer', cache)).toEqual([['hidden-author'], ['hidden-team']]);
    expect(follows).toHaveBeenCalledTimes(3);
  });
  it('shares rejection without turning a failed authorization check into permission', async () => {
    follows.mockRejectedValue(new Error('database unavailable'));
    const cache = getRequestBlockedCache({});
    const results = await Promise.allSettled([check('viewer', cache), check('viewer', cache)]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(follows).toHaveBeenCalledTimes(1);
    follows.mockResolvedValue([]);
    expect(await check('viewer', getRequestBlockedCache({}))).toEqual([
      ['hidden-author'],
      ['hidden-team'],
    ]);
  });
});
