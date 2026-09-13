import type { Prisma, PrismaClient } from '@prisma/client';
import { serializeGameCard, serializeEventCard, type SerializeCtx } from './eventCardSerializer.js';
import { getViewerTeamScopeDetails } from './viewerTeamScope.js';
import { normalizeSportToSlug } from './sportsTaxonomy.js';

type Db = PrismaClient;
type DiscoverySurface = 'feed' | 'map' | 'all';
type DiscoveryScope = 'public' | 'following';

export type EventDiscoveryParams = {
  surface?: DiscoverySurface;
  scope?: DiscoveryScope;
  sport?: string | null;
  level?: 'major' | 'minor' | 'college' | 'other' | null;
  type?: 'game' | 'event';
  from?: Date | null;
  to?: Date | null;
  limit?: number;
  viewerId?: string | null;
  now?: Date;
  /** Precomputed using the shared post visibility filters; absent means no visible posts. */
  visiblePostWhere?: Prisma.PostWhereInput;
};

const MAP_LOOKAHEAD_MS = 5 * 24 * 60 * 60 * 1000;
// Feed reaches further forward than the map. Normal games/events show ~2 weeks
// out (FEED_NORMAL_LOOKAHEAD_MS); pro/league fixtures form a marquee rail that
// reaches ~6 weeks (FEED_LOOKAHEAD_MS) so a far-off pro game still surfaces. The
// past recap looks back 4 days so a multi-day series stays referenceable from
// its final day. These windows are FEED-surface only — the map keeps its tight
// 5-day forward window untouched. Mirrors the windows the client used to assemble
// on its own via utils/feedGameQueries (now composed here instead).
const FEED_PAST_LOOKBACK_MS = 4 * 24 * 60 * 60 * 1000;
const FEED_LOOKAHEAD_MS = 45 * 24 * 60 * 60 * 1000;
const FEED_NORMAL_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DISCOVERY_RANGE_MS = MAP_LOOKAHEAD_MS;
// Following scope is a personal calendar of the viewer's teams — future-only and
// effectively unbounded, NOT the public 5-day map/feed clamp.
const FOLLOWING_LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000;
// The default live map view has no explicit date range (from=now), so a fixture
// whose kickoff has already passed drops out of the `date >= from` DB floor even
// while it is still in progress (e.g. an NFL game is still live ~3h after
// kickoff). This is a fetch-only safety margin — generous enough to cover the
// longest live_window_hours_after_start override (Fanatics Fest day events run
// 18h) — not the visibility gate itself. The precise per-item check that
// actually decides whether a still-fetched row survives lives in the map filter
// below, keyed off each item's own serialized `live_window.live_until`.
const MAP_LIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

function defaultWindow(surface: DiscoverySurface, now: Date) {
  if (surface === 'feed') {
    return {
      from: new Date(now.getTime() - FEED_PAST_LOOKBACK_MS),
      to: new Date(now.getTime() + FEED_LOOKAHEAD_MS),
    };
  }
  return { from: now, to: new Date(now.getTime() + MAP_LOOKAHEAD_MS) };
}

function clampWindow(surface: DiscoverySurface, requestedFrom: Date, requestedTo: Date, now: Date) {
  // The map's date-picker can reach arbitrarily far back (past event pages, since
  // VarsityHub's start), so the map surface has no past floor. Feed keeps its 4-day
  // lookback; everything else is now-forward. The forward edge and the max range are
  // surface-aware: the feed reaches 45 days out (its marquee rail), the map stays at
  // the 5-day policy.
  const earliest =
    surface === 'map'
      ? new Date(0)
      : surface === 'feed'
        ? new Date(now.getTime() - FEED_PAST_LOOKBACK_MS)
        : now;
  const forwardMs = surface === 'feed' ? FEED_LOOKAHEAD_MS : MAP_LOOKAHEAD_MS;
  const maxRangeMs =
    surface === 'feed' ? FEED_LOOKAHEAD_MS + FEED_PAST_LOOKBACK_MS : MAX_DISCOVERY_RANGE_MS;
  const latest = new Date(now.getTime() + forwardMs);
  const from = new Date(Math.max(requestedFrom.getTime(), earliest.getTime()));
  const to = new Date(Math.min(requestedTo.getTime(), latest.getTime()));
  if (to.getTime() - from.getTime() > maxRangeMs) {
    return { from, to: new Date(from.getTime() + maxRangeMs) };
  }
  return { from, to };
}

// A map marker renders far less than a feed card. Rather than ship the full
// ~1KB serialized card per pin, the `map` surface projects each card down to the
// fields the client map actually reads (components/EventMap.types.ts EventMapData
// + utils/mapDiscovery.toMapEvents). Feed/all surfaces keep the full card — this
// only narrows the map. Backward-compatible: the client eventCard schema is
// lenient (only id + source_type are required, everything else optional/unknown-
// tolerant), so an older app build parses the trimmed payload without breaking.
// Pinned by event-discovery-contract.test.ts.
const MAP_MARKER_FIELDS = [
  'id',
  'source_type',
  'event_id',
  'game_id',
  'has_posts',
  'title',
  'date',
  'location',
  'latitude',
  'longitude',
  'sport',
  'league_slug',
  'league_name',
  'league_level',
  'league_gender',
  'pro_home_color',
  'pro_away_color',
  'upload_access',
] as const;

function toMapMarker(card: Record<string, any>): Record<string, any> {
  const marker: Record<string, any> = {};
  for (const key of MAP_MARKER_FIELDS) {
    if (card[key] !== undefined) marker[key] = card[key];
  }
  return marker;
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
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const visiblePostWhere = params.visiblePostWhere ?? { id: { in: [] } };
  const postCount = { select: { posts: { where: visiblePostWhere } } };

  let from: Date;
  let to: Date;
  if (scope === 'following') {
    from = now;
    to = new Date(now.getTime() + FOLLOWING_LOOKAHEAD_MS);
  } else {
    const defaults = defaultWindow(surface, now);
    ({ from, to } = clampWindow(
      surface,
      params.from ?? defaults.from,
      params.to ?? defaults.to,
      now
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

  // A selected day that contains now is still today's schedule, including
  // fixtures that have already started. Only a wholly past selection needs posts.
  const pastCutoff = from <= now && to >= now ? from : now;
  // Only the true default live-map request (no explicit from, public scope)
  // gets the widened DB floor — an explicit date-picker range keeps its exact
  // requested bounds untouched.
  const isDefaultLiveMapWindow = surface === 'map' && params.from == null && scope !== 'following';
  const dateWhere = isDefaultLiveMapWindow
    ? { gte: new Date(Math.max(0, from.getTime() - MAP_LIVE_LOOKBACK_MS)), lte: to }
    : { gte: from, lte: to };
  const queryLimit = Math.min(limit * 2, MAX_LIMIT);
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
        };

  const leagueWhere: Prisma.EventWhereInput =
    params.level === 'other'
      ? {
          OR: [
            { sportsLeague: { is: null } },
            { sportsLeague: { is: { level: { notIn: ['major', 'minor', 'college'] } } } },
          ],
        }
      : params.level
        ? { sportsLeague: { is: { level: params.level } } }
        : {};
  const gameLevelScope = !params.level
    ? []
    : params.level === 'other'
      ? [{ OR: [{ events: { none: {} } }, { events: { some: leagueWhere } }] }]
      : [{ events: { some: leagueWhere } }];

  const [games, events] = await Promise.all([
    db.game.findMany({
      where: {
        ...gameWhere,
        AND: [
          ...((gameWhere as any).AND ?? []),
          ...gameLevelScope,
          ...(surface === 'map'
            ? [
                {
                  OR: [
                    { date: { gte: pastCutoff } },
                    { posts: { some: visiblePostWhere } },
                    { events: { some: { posts: { some: visiblePostWhere } } } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { date: 'asc' },
      take: queryLimit,
      include: {
        _count: postCount,
        events: {
          where: leagueWhere,
          orderBy: { date: 'asc' },
          take: 1,
          include: {
            _count: postCount,
            sportsLeague: {
              select: { slug: true, name: true, sport_slug: true, level: true, gender: true },
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
        ...(params.level === 'other' ? { AND: [leagueWhere] } : leagueWhere),
        ...(scope === 'following' ? { team_id: { in: followingTeamIdList } } : {}),
        // Selected past days follow the same rule: visible content earns the pin.
        ...(surface === 'map'
          ? { OR: [{ date: { gte: pastCutoff } }, { posts: { some: visiblePostWhere } }] }
          : {}),
      },
      orderBy: { date: 'asc' },
      take: queryLimit,
      include: {
        _count: postCount,
        team: { select: { sport: true } },
        sportsLeague: {
          select: { id: true, slug: true, name: true, sport_slug: true, level: true, gender: true },
        },
        proHomeTeam: { select: { league: true, primary_color: true } },
        proAwayTeam: { select: { league: true, primary_color: true } },
      },
    } as any),
  ]);
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
  // Feed game cards render final scores and derive the LIVE badge + printed start
  // from server-authoritative bounds (utils/liveWindow.getLiveBounds reads
  // starts_at/live_until). The map marker needs none of this, so these stay
  // feed-only enrichments layered over the shared serializer — the map surface is
  // untouched and still trims to toMapMarker below.
  const gameItems = scopedGames.map((game: any) => {
    const card = serializeGameCard(game, ctx);
    return {
      ...card,
      has_posts: (game._count?.posts ?? 0) > 0 || (game.events?.[0]?._count?.posts ?? 0) > 0,
      ...(surface === 'feed'
        ? {
            home_score: game.home_score ?? null,
            away_score: game.away_score ?? null,
            starts_at: (card as any).live_window?.starts_at ?? null,
            live_until: (card as any).live_window?.live_until ?? null,
          }
        : {}),
    };
  });
  const eventItems = scopedEvents.map((event: any) => {
    const card = serializeEventCard(event, ctx);
    return {
      ...card,
      has_posts: (event._count?.posts ?? 0) > 0,
      ...(surface === 'feed'
        ? {
            starts_at: (card as any).live_window?.starts_at ?? null,
            live_until: (card as any).live_window?.live_until ?? null,
          }
        : {}),
    };
  });

  const merged = [...gameItems, ...eventItems].sort((a, b) => {
    if (a.feed_priority !== b.feed_priority) return a.feed_priority - b.feed_priority;
    const at = a.date ? new Date(a.date).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.date ? new Date(b.date).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  // Optional card-level filters. Applied post-serialization on the card's own
  // fields (same basis the map filters on client-side). Note: filtering after
  // the queryLimit fetch means a very selective filter can return fewer than
  // `limit` even when more matches exist beyond the fetch window — acceptable
  // for a filter. When neither is supplied the result is unchanged.
  const wantType = params.type ?? null;
  const wantSport = params.sport ? normalizeSportToSlug(params.sport) : null;
  const filtered =
    wantType || wantSport
      ? merged.filter(item => {
          if (wantType && item.source_type !== wantType) return false;
          if (wantSport && normalizeSportToSlug(item.sport) !== wantSport) return false;
          return true;
        })
      : merged;

  // Feed window split: normal (non-pro/non-league) rows are capped at the 2-week
  // window; the pro/league marquee rail keeps its full ~6-week reach. This mirrors
  // the client's old two-window fetch (14-day games + 45-day pro_only) now that the
  // feed composes here. `pro_only` server-side = pro team linked OR a sports-league
  // fixture (routes/events.ts), which on the card is pro_league / league_slug.
  const normalCutoffMs = now.getTime() + FEED_NORMAL_LOOKAHEAD_MS;
  const isProOrLeague = (item: any) => item.pro_league != null || item.league_slug != null;
  const windowed =
    surface === 'feed'
      ? filtered.filter((item: any) => {
          if (!item.date) return true;
          const t = new Date(item.date).getTime();
          if (Number.isNaN(t)) return true;
          return t <= normalCutoffMs || isProOrLeague(item);
        })
      : filtered;

  return {
    items:
      surface === 'map'
        ? windowed
            .filter(
              item =>
                item.map_visibility.visible &&
                (item.has_posts ||
                  (item.date != null && new Date(item.date) >= pastCutoff) ||
                  // Still in progress right now, even though it started before
                  // pastCutoff: use the item's own computed live window rather
                  // than a second hardcoded duration guess.
                  (item.live_window?.live_until != null &&
                    new Date(item.live_window.live_until) >= now))
            )
            .slice(0, limit)
            .map(toMapMarker)
        : windowed.slice(0, limit),
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
