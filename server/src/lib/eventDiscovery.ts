import {
  DISCOVERY_UPCOMING_MS,
  DISCOVERY_MAP_LIVE_MS,
  DISCOVERY_LIVE_LOOKBACK_MS,
  matchesDiscoveryLevel,
} from '@varsityhub/shared/runtime/discoveryPolicy';
import { decodeDiscoveryCursor, encodeDiscoveryCursor, discoveryAfter } from './discoveryCursor.js';
import type { PrismaClient } from '@prisma/client';
import { serializeGameCard, serializeEventCard, type SerializeCtx } from './eventCardSerializer.js';
import { getViewerTeamScopeDetails } from './viewerTeamScope.js';
import { normalizeSportToSlug } from './sportsTaxonomy.js';
import { EVENT_POSTING_UNLOCK_DURATION_MS } from './geofencing.js';

type Db = PrismaClient;
type DiscoverySurface = 'feed' | 'map' | 'all';
type DiscoveryScope = 'public' | 'following';

export type EventDiscoveryParams = {
  surface?: DiscoverySurface;
  scope?: DiscoveryScope;
  sport?: string | null;
  type?: 'game' | 'event';
  from?: Date | null;
  to?: Date | null;
  limit?: number;
  viewerId?: string | null;
  now?: Date;
  paginated?: boolean;
  cursor?: string | null;
  level?: 'major' | 'minor' | 'college' | 'other' | null;
};

const MAP_LOOKAHEAD_MS = DISCOVERY_UPCOMING_MS;
const FEED_PAST_LOOKBACK_MS = DISCOVERY_LIVE_LOOKBACK_MS;
const MAX_DISCOVERY_RANGE_MS = MAP_LOOKAHEAD_MS + DISCOVERY_LIVE_LOOKBACK_MS;
// Following scope is a personal calendar of the viewer's teams — future-only and
// effectively unbounded, NOT the public discovery clamp.
const FOLLOWING_LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

function defaultWindow(surface: DiscoverySurface, now: Date) {
  if (surface === 'feed') {
    return {
      from: new Date(now.getTime() - FEED_PAST_LOOKBACK_MS),
      to: new Date(now.getTime() + MAP_LOOKAHEAD_MS),
    };
  }
  return {
    from: now,
    to: new Date(now.getTime() + (surface === 'map' ? DISCOVERY_MAP_LIVE_MS : MAP_LOOKAHEAD_MS)),
  };
}

function clampWindow(surface: DiscoverySurface, requestedFrom: Date, requestedTo: Date, now: Date) {
  // The map's date-picker can reach arbitrarily far back (past event pages, since
  // VarsityHub's start), so the map surface has no past floor. Feed keeps its short
  // lookback; everything else is now-forward. The forward edge and the max range
  // are unchanged — a single request still can't span more than the shared discovery policy.
  const earliest =
    surface === 'map'
      ? new Date(0)
      : surface === 'feed'
        ? new Date(now.getTime() - FEED_PAST_LOOKBACK_MS)
        : now;
  const latest = new Date(now.getTime() + MAP_LOOKAHEAD_MS);
  const from = new Date(Math.max(requestedFrom.getTime(), earliest.getTime()));
  const to = new Date(Math.min(requestedTo.getTime(), latest.getTime()));
  if (to.getTime() - from.getTime() > MAX_DISCOVERY_RANGE_MS) {
    return { from, to: new Date(from.getTime() + MAX_DISCOVERY_RANGE_MS) };
  }
  return { from, to };
}

function mapPastMediaGate(now: Date, viewerId: string | null | undefined) {
  const mediaPost = { posts: { some: { media_url: { not: null }, deleted_at: null } } };
  const activeUnlock = viewerId
    ? {
        user_id: viewerId,
        unlocked_at: { gte: new Date(now.getTime() - EVENT_POSTING_UNLOCK_DURATION_MS) },
      }
    : null;
  const viewerCanUploadToEvent = viewerId
    ? {
        OR: [
          { exclusive_poster_id: viewerId },
          {
            AND: [
              { designatedPosters: { some: { user_id: viewerId } } },
              { postingUnlocks: { some: activeUnlock } },
            ],
          },
        ],
      }
    : null;

  return {
    OR: [
      { date: { gte: now } },
      mediaPost,
      ...(viewerCanUploadToEvent ? [viewerCanUploadToEvent] : []),
    ],
  };
}

function mapPastGameMediaGate(now: Date, viewerId: string | null | undefined) {
  const activeUnlock = viewerId
    ? {
        user_id: viewerId,
        unlocked_at: { gte: new Date(now.getTime() - EVENT_POSTING_UNLOCK_DURATION_MS) },
      }
    : null;
  const viewerCanUploadToLinkedEvent = viewerId
    ? {
        events: {
          some: {
            OR: [
              { exclusive_poster_id: viewerId },
              {
                AND: [
                  { designatedPosters: { some: { user_id: viewerId } } },
                  { postingUnlocks: { some: activeUnlock } },
                ],
              },
            ],
          },
        },
      }
    : null;

  return {
    OR: [
      { date: { gte: now } },
      { posts: { some: { media_url: { not: null }, deleted_at: null } } },
      { events: { some: { posts: { some: { media_url: { not: null }, deleted_at: null } } } } },
      ...(viewerCanUploadToLinkedEvent ? [viewerCanUploadToLinkedEvent] : []),
    ],
  };
}

async function loadViewerState(
  db: Db,
  viewerId: string | null | undefined,
  eventIds: string[],
  now: Date
) {
  if (!viewerId || eventIds.length === 0) {
    return {
      viewerId,
      designatedEventIds: new Set<string>(),
      unlocks: new Map<string, Date>(),
      now,
    };
  }
  const [designatedRows, unlockRows] = await Promise.all([
    db.eventDesignatedPoster.findMany({
      where: { user_id: viewerId, event_id: { in: eventIds } },
      select: { event_id: true },
      take: eventIds.length,
    }),
    db.eventPostingUnlock.findMany({
      where: { user_id: viewerId, event_id: { in: eventIds } },
      select: { event_id: true, unlocked_at: true },
      take: eventIds.length,
    }),
  ]);
  return {
    viewerId,
    designatedEventIds: new Set(designatedRows.map(row => row.event_id)),
    unlocks: new Map(unlockRows.map(row => [row.event_id, row.unlocked_at])),
    now,
  };
}

async function loadExcludedPrivateTeamIds(
  db: any,
  viewerId: string | null | undefined,
  candidateTeamIds: string[]
): Promise<Set<string>> {
  if (!db.team?.findMany) return new Set();
  const uniqueCandidateTeamIds = [...new Set(candidateTeamIds.filter(Boolean))];
  if (uniqueCandidateTeamIds.length === 0) return new Set();

  const privateTeams: Array<{ id: string; organization_id: string | null }> =
    await db.team.findMany({
      where: { id: { in: uniqueCandidateTeamIds }, is_private: true, status: 'active' },
      select: { id: true, organization_id: true },
      take: uniqueCandidateTeamIds.length,
    });
  if (privateTeams.length === 0) return new Set();
  const privateTeamIds = privateTeams.map(team => team.id);
  if (!viewerId) return new Set(privateTeamIds);

  const organizationIds = [
    ...new Set(privateTeams.map(team => team.organization_id).filter(Boolean)),
  ];
  const [follows, memberships, orgMemberships] = await Promise.all([
    db.teamFollow.findMany({
      where: { user_id: viewerId, team_id: { in: privateTeamIds } },
      select: { team_id: true },
      take: Math.min(privateTeamIds.length, 50000),
    }),
    db.teamMembership.findMany({
      where: {
        user_id: viewerId,
        team_id: { in: privateTeamIds },
        status: 'active',
      },
      select: { team_id: true },
      take: Math.min(privateTeamIds.length, 50000),
    }),
    organizationIds.length > 0
      ? db.organizationMembership.findMany({
          where: {
            user_id: viewerId,
            organization_id: { in: organizationIds },
            role: { in: ['owner', 'manager'] },
            status: 'active',
          },
          select: { organization_id: true },
          take: Math.min(organizationIds.length, 50000),
        })
      : Promise.resolve([]),
  ]);

  const allowedTeamIds = new Set<string>([
    ...follows.map((row: any) => row.team_id),
    ...memberships.map((row: any) => row.team_id),
  ]);
  const allowedOrgIds = new Set(orgMemberships.map((row: any) => row.organization_id));
  for (const team of privateTeams) {
    if (team.organization_id && allowedOrgIds.has(team.organization_id)) {
      allowedTeamIds.add(team.id);
    }
  }
  return new Set(privateTeamIds.filter(teamId => !allowedTeamIds.has(teamId)));
}

export async function listEventDiscoveryItems(db: Db, params: EventDiscoveryParams) {
  const now = params.now ?? new Date();
  const surface = params.surface ?? 'all';
  const scope = params.scope ?? 'public';
  const limit = Math.max(
    params.paginated ? 2 : 1,
    Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  );
  const fingerprint = JSON.stringify([
    surface,
    scope,
    params.viewerId ?? null,
    params.from?.toISOString(),
    params.to?.toISOString(),
    params.sport ?? null,
    params.type ?? null,
    params.level ?? null,
  ]);
  const cursor = params.cursor ? decodeDiscoveryCursor(params.cursor, fingerprint, now) : null;
  const anchor = cursor ? new Date(cursor.anchor) : now;
  const explicitWindow = params.from != null || params.to != null;

  let from: Date;
  let to: Date;
  if (scope === 'following') {
    from = anchor;
    to = new Date(anchor.getTime() + FOLLOWING_LOOKAHEAD_MS);
  } else {
    const defaults = params.paginated
      ? {
          from: new Date(anchor.getTime() - DISCOVERY_LIVE_LOOKBACK_MS),
          to: new Date(
            anchor.getTime() +
              (surface === 'map' && !explicitWindow ? DISCOVERY_MAP_LIVE_MS : MAP_LOOKAHEAD_MS)
          ),
        }
      : defaultWindow(surface, anchor);
    ({ from, to } = clampWindow(
      params.paginated ? 'map' : surface,
      params.from ?? defaults.from,
      params.to ?? defaults.to,
      anchor
    ));
  }

  // Following scope: the viewer's followed/managed teams only. Resolve the set
  // up front; an empty set (or no viewer) means there is nothing to show.
  const viewerTeamScope =
    scope === 'following' ? await getViewerTeamScopeDetails(db, params.viewerId) : null;
  const followingTeamIds = viewerTeamScope?.allTeamIds ?? null;
  const managedTeamIds = viewerTeamScope?.managedTeamIds ?? null;
  if (scope === 'following' && (!followingTeamIds || followingTeamIds.size === 0)) {
    return {
      items: [],
      next_cursor: null,
      meta: {
        surface,
        from: from.toISOString(),
        to: to.toISOString(),
        limit,
        sources: { games: 0, events: 0 },
        filtered: { private_team_items: 0 },
      },
    };
  }

  if (from > to) {
    return {
      items: [],
      next_cursor: null,
      meta: {
        surface,
        from: from.toISOString(),
        to: from.toISOString(),
        limit,
        out_of_window: true,
        sources: { games: 0, events: 0 },
        filtered: { private_team_items: 0 },
      },
    };
  }
  const dateWhere = { gte: from, lte: to };
  const queryLimit = Math.min(limit * 2, MAX_LIMIT);
  const usePastGate =
    (surface === 'map' || params.paginated) && (explicitWindow || !params.paginated);
  const mapPastGate = usePastGate ? mapPastMediaGate(now, params.viewerId) : null;
  const mapPastGameGate = usePastGate ? mapPastGameMediaGate(now, params.viewerId) : null;
  const followingTeamIdList = followingTeamIds ? [...followingTeamIds] : [];
  const managedTeamIdList = managedTeamIds ? [...managedTeamIds] : [];
  const followingGameTeamScope =
    scope === 'following'
      ? {
          OR: [
            { home_team_id: { in: followingTeamIdList } },
            { away_team_id: { in: followingTeamIdList } },
          ],
        }
      : null;
  const managedGameScope =
    scope === 'following' && managedTeamIdList.length > 0
      ? {
          approval_status: { in: ['approved', 'pending'] },
          OR: [
            { home_team_id: { in: managedTeamIdList } },
            { away_team_id: { in: managedTeamIdList } },
          ],
        }
      : null;
  const gameWhere =
    scope === 'following'
      ? {
          date: dateWhere,
          AND: [
            followingGameTeamScope,
            {
              OR: [
                {
                  approval_status: 'approved',
                  opponent_approval_status: { in: ['not_required', 'approved'] },
                },
                ...(managedGameScope ? [managedGameScope] : []),
              ],
            },
          ],
        }
      : {
          approval_status: 'approved',
          opponent_approval_status: { in: ['not_required', 'approved'] },
          date: dateWhere,
          ...(mapPastGameGate ? mapPastGameGate : {}),
        };

  const gameBudget = params.paginated ? Math.ceil(limit / 2) : queryLimit;
  const eventBudget = params.paginated ? Math.floor(limit / 2) : queryLimit;
  const [gameCandidates, eventCandidates] = await Promise.all([
    db.game.findMany({
      where: cursor?.games ? { AND: [gameWhere, discoveryAfter(cursor.games)] } : gameWhere,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      take: gameBudget + (params.paginated ? 1 : 0),
      include: {
        events: {
          orderBy: { date: 'asc' },
          take: 1,
          include: {
            sportsLeague: {
              select: {
                id: true,
                slug: true,
                name: true,
                sport_slug: true,
                level: true,
                gender: true,
              },
            },
            proHomeTeam: { select: { league: true, primary_color: true } },
            proAwayTeam: { select: { league: true, primary_color: true } },
          },
        },
        homeTeam: { select: { sport: true } },
        awayTeam: { select: { sport: true } },
      },
    } as any),
    db.event.findMany({
      where: {
        approval_status: 'approved',
        status: { not: 'cancelled' },
        game_id: null,
        date: dateWhere,
        ...(scope === 'following' ? { team_id: { in: followingTeamIdList } } : {}),
        // On the map, old event pages only earn pins when they have media.
        // A specific viewer with active upload access still sees their empty
        // past event so they can add the first post/story.
        ...(mapPastGate ? mapPastGate : {}),
        AND: [discoveryAfter(cursor?.events)],
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      take: eventBudget + (params.paginated ? 1 : 0),
      include: {
        team: { select: { sport: true } },
        sportsLeague: {
          select: { id: true, slug: true, name: true, sport_slug: true, level: true, gender: true },
        },
        proHomeTeam: { select: { league: true, primary_color: true } },
        proAwayTeam: { select: { league: true, primary_color: true } },
      },
    } as any),
  ]);
  const games = gameCandidates.slice(0, gameBudget);
  const events = eventCandidates.slice(0, eventBudget);
  const hasMore =
    params.paginated &&
    (gameCandidates.length > gameBudget || eventCandidates.length > eventBudget);
  const position = (rows: any[], previous: any) =>
    rows.length
      ? { id: rows[rows.length - 1].id, date: new Date(rows[rows.length - 1].date).toISOString() }
      : (previous ?? null);
  const nextCursor = hasMore
    ? encodeDiscoveryCursor({
        version: 1,
        anchor: anchor.toISOString(),
        fingerprint,
        games: position(games, cursor?.games),
        events: position(events, cursor?.events),
      })
    : null;
  const candidateTeamIds = [
    ...games.flatMap((game: any) => [game.home_team_id, game.away_team_id]),
    ...events.map((event: any) => event.team_id),
  ].filter((teamId): teamId is string => typeof teamId === 'string' && teamId.length > 0);
  const excludedPrivateTeamIds = await loadExcludedPrivateTeamIds(
    db,
    params.viewerId,
    candidateTeamIds
  );
  const teamIsHidden = (teamId: string | null | undefined) =>
    !!teamId && excludedPrivateTeamIds.has(teamId);
  const visibleGames = games.filter(
    (game: any) => !teamIsHidden(game.home_team_id) && !teamIsHidden(game.away_team_id)
  );
  const visibleEvents = events.filter((event: any) => !teamIsHidden(event.team_id));

  // Following scope narrows to games/events belonging to the viewer's teams.
  const inFollowScope = (teamId: string | null | undefined) =>
    !followingTeamIds || (!!teamId && followingTeamIds.has(teamId));
  const isManagedTeam = (teamId: string | null | undefined) =>
    !!managedTeamIds && !!teamId && managedTeamIds.has(teamId);
  const isPublicApprovedGame = (game: any) =>
    game.approval_status === 'approved' &&
    ['not_required', 'approved'].includes(String(game.opponent_approval_status ?? ''));
  const isManagedCalendarGame = (game: any) =>
    ['approved', 'pending'].includes(String(game.approval_status ?? '')) &&
    (isManagedTeam(game.home_team_id) || isManagedTeam(game.away_team_id));
  const scopedGames = followingTeamIds
    ? visibleGames.filter(
        (game: any) =>
          (inFollowScope(game.home_team_id) || inFollowScope(game.away_team_id)) &&
          (isPublicApprovedGame(game) || isManagedCalendarGame(game))
      )
    : visibleGames;
  const scopedEvents = followingTeamIds
    ? visibleEvents.filter((event: any) => inFollowScope(event.team_id))
    : visibleEvents;

  const eventIds = [
    ...scopedGames.map((game: any) => game.events?.[0]?.id).filter(Boolean),
    ...scopedEvents.map((event: any) => event.id),
  ] as string[];
  const viewerState = await loadViewerState(db, params.viewerId, eventIds, now);

  const ctx: SerializeCtx = { now, from, to, viewerState };
  const gameItems = scopedGames.map((game: any) => serializeGameCard(game, ctx));
  const eventItems = scopedEvents.map((event: any) => serializeEventCard(event, ctx));

  const merged = [...gameItems, ...eventItems].sort((a, b) => {
    if (a.feed_priority !== b.feed_priority) return a.feed_priority - b.feed_priority;
    const at = a.date ? new Date(a.date).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.date ? new Date(b.date).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  // Candidate cursors advance even over hidden/nonmatching records. Empty
  // pages are not exhaustion; the client must follow next_cursor.
  const wantSport = params.sport ? normalizeSportToSlug(params.sport) : null;
  const filtered = merged.filter(item => {
    if (params.type && item.source_type !== params.type) return false;
    if (wantSport && normalizeSportToSlug(item.sport) !== wantSport) return false;
    if (!matchesDiscoveryLevel(item.league_level, params.level)) return false;
    if (params.paginated && scope === 'public' && !explicitWindow) {
      const until = item.live_window.live_until;
      if (item.date && new Date(item.date) < now && (!until || new Date(until) < now)) return false;
    }
    return true;
  });

  return {
    next_cursor: nextCursor,
    items:
      surface === 'map'
        ? filtered.filter(item => item.map_visibility.visible).slice(0, limit)
        : filtered.slice(0, limit),
    meta: {
      surface,
      from: from.toISOString(),
      to: to.toISOString(),
      limit,
      sources: { games: games.length, events: events.length },
      filtered: {
        private_team_items:
          games.length + events.length - visibleGames.length - visibleEvents.length,
      },
    },
  };
}
