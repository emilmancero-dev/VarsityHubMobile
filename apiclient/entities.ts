// Local REST client wrappers. Swaps out Base44 for a self-hosted API.
import auth, { invalidateMeCache } from './auth';
import {
  httpDelete,
  httpGet,
  httpPatch,
  httpPost,
  httpPostLongTimeout,
  httpPostWithOptions,
  httpPut,
} from './http';
import { validateAuthenticatedUser, validateOnboardingCompletion } from './schemas/auth';
import {
  validateEvent,
  validateEventArray,
  validateEventRsvpArray,
  validateEventSummaryArray,
} from './schemas/event';
import {
  validateOrganization,
  validateOrganizationAdminSummary,
  validateOrganizationArray,
  validateOrganizationReviewSummaryArray,
} from './schemas/organization';
import { validateProgramScreenSummary } from './schemas/program';
import {
  validateFollowedTeamArray,
  validateTeam,
  validateTeamAdminSummary,
  validateTeamArray,
  validateTeamScreenSummary,
} from './schemas/team';
import type {
  CompleteOnboardingPayload,
  CreateAdPayload,
  CreateEventPayload,
  CreateGamePayload,
  CreatePostPayload,
  UpdateAdPayload,
  UpdateEventPayload,
  UpdateGamePayload,
  UpdateMePayload,
  UpdatePostPayload,
  UpdatePreferencesPayload,
} from './types';

export type SportsLeagueScheduleStatus = 'provider_backed' | 'event_seeded' | 'catalog_only';

export type SportsLeagueSummary = {
  id: string;
  slug: string;
  name: string;
  sport_slug: string;
  level: string;
  gender: string;
  country_code: string | null;
  provider: string | null;
  provider_league_id: string | null;
  schedule_status: SportsLeagueScheduleStatus;
  has_current_events: boolean;
  current_event_count: number;
};

export const User = {
  me: (options?: { force?: boolean }) => auth.me(options),
  refresh: () => auth.me({ force: true }),
  register: (email: string, password: string, display_name?: string) =>
    auth.register(email, password, display_name),
  loginViaEmailPassword: (email: string, password: string) => auth.login(email, password),
  loginViaGoogle: (idToken: string) => auth.loginWithGoogle(idToken),
  loginViaApple: (identityToken: string) => auth.loginWithApple(identityToken),
  linkGoogleProvider: (idToken: string) => auth.linkGoogle(idToken),
  linkAppleProvider: (identityToken: string) => auth.linkApple(identityToken),
  logout: () => auth.logout(),
  updateMe: (data: UpdateMePayload) => {
    invalidateMeCache();
    return httpPut('/auth/me', data).then(response =>
      validateAuthenticatedUser('auth.updateMe', response)
    );
  },
  patchMe: (data: UpdateMePayload) => {
    invalidateMeCache();
    return httpPatch('/me', data).then(response =>
      validateAuthenticatedUser('auth.patchMe', response)
    );
  },
  updatePreferences: (patch: UpdatePreferencesPayload) => {
    invalidateMeCache();
    return httpPatch('/me/preferences', patch);
  },
  completeOnboarding: (data: CompleteOnboardingPayload) => {
    invalidateMeCache();
    return httpPost('/me/complete-onboarding', data).then(response =>
      validateOnboardingCompletion('auth.completeOnboarding', response)
    );
  },
  requestVerification: () => auth.requestEmailVerification(),
  verifyEmail: (code: string) => auth.verifyEmail(code),
  usernameAvailable: (username: string) =>
    httpGet('/users/username-available?username=' + encodeURIComponent(username)),
  lookupByEmail: (email: string) => httpGet('/users/lookup?email=' + encodeURIComponent(email)),
  listAll: async (q?: string, limit: number = 100, banned?: boolean) => {
    const qq: string[] = [];
    if (q) qq.push('q=' + encodeURIComponent(q));
    if (banned) qq.push('banned=1');
    qq.push('limit=' + String(limit));
    return httpGet('/users' + (qq.length ? '?' + qq.join('&') : ''));
  },
  /** @deprecated Use listAll() — identical endpoint and parameters */
  listAllAdmin: (q?: string, limit: number = 100, banned?: boolean) =>
    User.listAll(q, limit, banned),
  ban: (id: string, reason?: string) => {
    if (!id || id === 'undefined' || id === 'null') throw new Error('[User.ban] Invalid user ID');
    return httpPost('/admin/users/' + encodeURIComponent(id) + '/ban', {
      reason: reason || undefined,
    });
  },
  unban: (id: string) => {
    if (!id || id === 'undefined' || id === 'null') throw new Error('[User.unban] Invalid user ID');
    return httpPost('/admin/users/' + encodeURIComponent(id) + '/unban', {});
  },
  getFull: (id: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.getFull] Invalid user ID');
    return httpGet('/users/' + encodeURIComponent(id) + '/full');
  },
  followers: (id: string, cursor?: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.followers] Invalid user ID');
    return httpGet(
      `/users/${encodeURIComponent(id)}/followers` +
        (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
    );
  },
  following: (id: string, cursor?: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.following] Invalid user ID');
    return httpGet(
      `/users/${encodeURIComponent(id)}/following` +
        (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
    );
  },
  follow: (id: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.follow] Invalid user ID');
    return httpPost(`/users/${encodeURIComponent(id)}/follow`, {});
  },
  unfollow: (id: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.unfollow] Invalid user ID');
    return httpDelete(`/users/${encodeURIComponent(id)}/follow`);
  },
  postsForProfile: (
    id: string,
    opts: {
      cursor?: string | null;
      limit?: number;
      sort?: 'newest' | 'most_upvoted' | 'most_commented';
    } = {}
  ) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.postsForProfile] Invalid user ID');
    const q: string[] = [];
    if (typeof opts.limit === 'number') q.push('limit=' + String(opts.limit));
    if (opts.cursor) q.push('cursor=' + encodeURIComponent(opts.cursor));
    if (opts.sort) q.push('sort=' + encodeURIComponent(opts.sort));
    const qs = q.length ? '?' + q.join('&') : '';
    return httpGet(`/users/${encodeURIComponent(id)}/posts` + qs);
  },
  interactionsForProfile: (
    id: string,
    opts: {
      type?: 'all' | 'like' | 'comment' | 'repost' | 'save';
      cursor?: string | null;
      limit?: number;
      sort?: 'newest' | 'most_upvoted' | 'most_commented';
    } = {}
  ) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.interactionsForProfile] Invalid user ID');
    const q: string[] = [];
    if (opts.type) q.push('type=' + encodeURIComponent(opts.type));
    if (typeof opts.limit === 'number') q.push('limit=' + String(opts.limit));
    if (opts.cursor) q.push('cursor=' + encodeURIComponent(opts.cursor));
    if (opts.sort) q.push('sort=' + encodeURIComponent(opts.sort));
    const qs = q.length ? '?' + q.join('&') : '';
    return httpGet(`/users/${encodeURIComponent(id)}/interactions` + qs);
  },
  eventPagesForProfile: (id: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.eventPagesForProfile] Invalid user ID');
    return httpGet(`/users/${encodeURIComponent(id)}/event-pages`);
  },
  // Password reset helpers (delegates to auth)
  requestPasswordReset: (email: string) => auth.requestPasswordReset(email),
  resetPassword: (email: string, code: string, password: string) =>
    auth.resetPassword(email, code, password),
  // Public profile fetch
  getPublic: (id: string) => {
    if (!id || id === 'undefined' || id === 'null')
      throw new Error('[User.getPublic] Invalid user ID');
    return httpGet('/users/' + encodeURIComponent(id));
  },
  teams: (id: string) => httpGet('/users/' + encodeURIComponent(id) + '/teams'),
  // Search users for mentions
  searchForMentions: (query: string, limit: number = 10) =>
    httpGet('/users/search/mentions?q=' + encodeURIComponent(query) + '&limit=' + String(limit)),
  // Lookup user by username
  lookupByUsername: (username: string) =>
    httpGet('/users/lookup?username=' + encodeURIComponent(username)),
  // Block/unblock users
  block: (id: string) => httpPost('/users/' + encodeURIComponent(id) + '/block', {}),
  unblock: (id: string) => httpDelete('/users/' + encodeURIComponent(id) + '/block'),
  blockedUsers: () => httpGet('/users/blocked'),
  upgradeToCoach: async (plan: 'rookie' | 'veteran' | 'legend') => {
    invalidateMeCache();
    const response = await httpPost('/auth/upgrade-to-coach', { plan });
    invalidateMeCache();
    return response;
  },
  downgradeToFan: async () => {
    invalidateMeCache();
    const response = await httpPost('/auth/downgrade-to-fan', {});
    invalidateMeCache();
    return response;
  },
  // v1.0.2: rejected coaches can re-apply after 48hr cooldown
  reapplyCoach: () => httpPost('/auth/coach/reapply', {}),
  // v1.0.2: escape paywall loop by downgrading to free rookie plan
  skipPayment: () => httpPost('/auth/skip-payment', {}),
  deleteAccount: (payload?: { password?: string; delete_confirmation?: string }) =>
    auth.deleteAccount(payload),
  acceptFollow: (userId: string) =>
    httpPost(`/users/${encodeURIComponent(userId)}/accept-follow`, {}),
  rejectFollow: (userId: string) =>
    httpPost(`/users/${encodeURIComponent(userId)}/reject-follow`, {}),
  suggested: (limit?: number) => httpGet(`/users/me/suggested${limit ? `?limit=${limit}` : ''}`),
};

export const DataExport = {
  request: () => httpPost('/me/data-export', {}),
  list: () => httpGet('/me/data-exports'),
  get: (id: string) => httpGet(`/me/data-export/${encodeURIComponent(id)}`),
  download: (id: string) => httpGet(`/me/data-export/${encodeURIComponent(id)}/download`),
  delete: (id: string) => httpDelete(`/me/data-export/${encodeURIComponent(id)}`),
};

export const Game = {
  list: (
    sort?: string,
    options?: {
      cursor?: string | null;
      limit?: number;
      lat?: number;
      lng?: number;
      distance?: number;
      dateFrom?: string;
      dateTo?: string;
      approvalStatus?: 'pending' | 'approved' | 'rejected';
      showPending?: boolean;
      teamId?: string;
      organizationId?: string;
      mapView?: boolean; // v1.0.2: restricts server-side to games this week only
      teamless?: boolean; // curated/marquee events with no real team matchup
      following?: boolean; // Discover calendar: scope to viewer's followed teams
      showAll?: boolean; // Bypass device/profile-zip proximity for global surfaces
    }
  ) => {
    const params: string[] = [];
    if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
    if (options?.cursor) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
    if (typeof options?.limit === 'number')
      params.push(`limit=${encodeURIComponent(String(options.limit))}`);
    if (typeof options?.lat === 'number')
      params.push(`lat=${encodeURIComponent(String(options.lat))}`);
    if (typeof options?.lng === 'number')
      params.push(`lng=${encodeURIComponent(String(options.lng))}`);
    if (typeof options?.distance === 'number')
      params.push(`distance=${encodeURIComponent(String(options.distance))}`);
    if (options?.dateFrom) params.push(`from=${encodeURIComponent(options.dateFrom)}`);
    if (options?.dateTo) params.push(`to=${encodeURIComponent(options.dateTo)}`);
    if (options?.approvalStatus)
      params.push(`approval_status=${encodeURIComponent(options.approvalStatus)}`);
    if (options?.showPending) params.push('show_pending=true');
    if (options?.teamId) params.push(`team_id=${encodeURIComponent(options.teamId)}`);
    if (options?.organizationId)
      params.push(`organization_id=${encodeURIComponent(options.organizationId)}`);
    if (options?.mapView) params.push('map_view=true');
    if (options?.teamless) params.push('teamless=true');
    if (options?.following) params.push('following=true');
    if (options?.showAll) params.push('show_all=true');
    const qs = params.length ? `?${params.join('&')}` : '';
    return httpGet('/games' + qs, {}, 15000, 2);
  },
  // Lightweight record fetch used as fallback when summary is unavailable.
  get: (id: string) => httpGet('/games/' + encodeURIComponent(id), {}, 15000, 1),
  // Summary drives the game-details screen critical path.
  // Keep it bounded; caller can fall back to Game.get when unavailable.
  summary: (id: string) => httpGet('/games/' + encodeURIComponent(id) + '/summary', {}, 15000, 1),
  create: (data: CreateGamePayload | Record<string, unknown>) => httpPost('/games', data),
  // v1.0.2: atomic bulk create for season scheduling (all-or-nothing tx on server)
  bulkCreate: (games: Array<Record<string, unknown>>) => httpPost('/games/bulk', { games }),
  delete: (id: string) => httpDelete('/games/' + encodeURIComponent(id)),
  posts: (id: string, options: { limit?: number; cursor?: string } = {}) => {
    const q: string[] = [];
    if (typeof options.limit === 'number')
      q.push('limit=' + encodeURIComponent(String(options.limit)));
    if (options.cursor) q.push('cursor=' + encodeURIComponent(options.cursor));
    const qs = q.length ? '?' + q.join('&') : '';
    return httpGet(`/games/${encodeURIComponent(id)}/posts` + qs);
  },
  // Media is non-critical for first render; keep this bounded.
  // include_expired=1: when authenticated, also returns creator's expired stories (for greyed-out + delete UI)
  media: (id: string, opts?: { include_expired?: boolean }) => {
    const q = opts?.include_expired ? '?include_expired=1' : '';
    return httpGet(`/games/${encodeURIComponent(id)}/media` + q, {}, 15000, 1);
  },
  deleteMedia: (gameId: string, mediaId: string) =>
    httpDelete(`/games/${encodeURIComponent(gameId)}/media/${encodeURIComponent(mediaId)}`),
  votesSummary: (id: string) => httpGet(`/games/${encodeURIComponent(id)}/votes/summary`),
  votesSummaryBatch: (ids: string[]) => {
    if (ids.length === 0) return Promise.resolve({});
    const qs = '?ids=' + ids.map(id => encodeURIComponent(id)).join(',');
    return httpGet('/games/votes-summary' + qs);
  },
  // Post counts per event/game id (0 when a page has no posts). A count of 0 is
  // falsy, so callers that only need "has any posts" can still read it as a
  // boolean.
  postsSummaryBatch: (ids: string[]): Promise<Record<string, number>> => {
    if (ids.length === 0) return Promise.resolve({});
    const qs = '?ids=' + ids.map(id => encodeURIComponent(id)).join(',');
    return httpGet('/games/posts-summary' + qs) as Promise<Record<string, number>>;
  },
  castVote: (id: string, team: 'A' | 'B') =>
    httpPost(`/games/${encodeURIComponent(id)}/votes`, { team }),
  clearVote: (id: string) => httpDelete(`/games/${encodeURIComponent(id)}/votes`),
  update: (id: string, data: UpdateGamePayload) =>
    httpPut('/games/' + encodeURIComponent(id), data),
  setResult: (
    id: string,
    data: { home_score?: number; away_score?: number; winner?: 'home' | 'away' | 'tie' | null }
  ) => httpPatch(`/games/${encodeURIComponent(id)}/result`, data),
  setApprovalStatus: (id: string, approval: 'approved' | 'rejected', reason?: string) =>
    httpPut(
      `/games/${encodeURIComponent(id)}/approve`,
      reason ? { approval_status: approval, reason } : { approval_status: approval }
    ),
  // Opponent-approval workflow: games awaiting a decision from a team the
  // caller manages, and the accept/decline action itself.
  opponentPending: () => httpGet('/games/opponent-pending', {}, 15000, 1),
  decideOpponentApproval: (id: string, decision: 'approve' | 'decline', reason?: string) =>
    httpPost(
      `/games/${encodeURIComponent(id)}/opponent-approval`,
      reason ? { decision, reason } : { decision }
    ),
  stories: (id: string) => httpGet(`/games/${encodeURIComponent(id)}/stories`, {}, 15000, 1),
  // Story creation can be slower under server load; allow a longer timeout but avoid retries to prevent duplicates.
  addStory: (
    id: string,
    data: {
      media_url: string;
      /** First-frame poster for an R2-hosted video (see storySchema in server/src/routes/games.ts). */
      poster_url?: string;
      caption?: string;
      location?: { lat: number; lng: number; source?: 'device' | 'places' | 'zip' | 'derived' };
    }
  ) => httpPostWithOptions(`/games/${encodeURIComponent(id)}/stories`, data, 45000, 0),
};

export type PostPage<T = any> = {
  items: T[];
  nextCursor: string | null;
  followed_feed_meta?: { following_count: number };
  followed_teams_feed_meta?: { followed_teams_count: number };
};

const parsePostPage = (input: unknown): PostPage => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('[Post] Invalid paginated response shape');
  }

  const response = input as Record<string, any>;
  return {
    items: Array.isArray(response.items) ? response.items : [],
    nextCursor: typeof response.nextCursor === 'string' ? response.nextCursor : null,
    followed_feed_meta: response.followed_feed_meta ?? undefined,
    followed_teams_feed_meta: response.followed_teams_feed_meta ?? undefined,
  };
};

export const Post = {
  list: async (sort?: string, limit: number = 20) => {
    const q: string[] = [];
    if (sort) q.push('sort=' + encodeURIComponent(sort));
    if (limit) q.push('limit=' + String(limit));
    // Non-critical content; avoid long retry storms on weak networks.
    const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''), {}, 15000, 1);
    return parsePostPage(res).items;
  },
  create: (data: CreatePostPayload) => httpPostLongTimeout('/posts', data),
  filter: async (
    where: {
      game_id?: string;
      team_id?: string;
      program_id?: string;
      type?: string;
      user_id?: string;
    } = {},
    sort?: string,
    limit: number = 20
  ) => {
    const q: string[] = [];
    if (sort) q.push('sort=' + encodeURIComponent(sort));
    if (limit) q.push('limit=' + String(limit));
    if (where.game_id) q.push('game_id=' + encodeURIComponent(where.game_id));
    if (where.team_id) q.push('team_id=' + encodeURIComponent(where.team_id));
    // program_id = the whole sport's posts, shared across every sub-team (owner
    // July-28: ONE sport page). Mutually exclusive with team_id in practice.
    if (where.program_id) q.push('program_id=' + encodeURIComponent(where.program_id));
    if (where.type) q.push('type=' + encodeURIComponent(where.type));
    if (where.user_id) q.push('user_id=' + encodeURIComponent(where.user_id));
    const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''));
    return parsePostPage(res).items;
  },
  count: (where: { game_id?: string; type?: string } = {}) => {
    const q: string[] = [];
    if (where.game_id) q.push('game_id=' + encodeURIComponent(where.game_id));
    if (where.type) q.push('type=' + encodeURIComponent(where.type));
    return httpGet('/posts/count' + (q.length ? '?' + q.join('&') : ''));
  },
  listPage: async (cursor?: string | null, limit: number = 10, sort: string = '-created_date') => {
    const q: string[] = [];
    if (sort) q.push('sort=' + encodeURIComponent(sort));
    if (limit) q.push('limit=' + String(limit));
    if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
    const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''));
    return parsePostPage(res);
  },
  filterPage: async (
    where: {
      game_id?: string;
      team_id?: string;
      type?: string;
      user_id?: string;
      followed_only?: boolean;
      followed_teams?: boolean;
    } = {},
    cursor?: string | null,
    limit: number = 20,
    sort: string = '-created_date'
  ) => {
    const q: string[] = [];
    if (sort) q.push('sort=' + encodeURIComponent(sort));
    if (limit) q.push('limit=' + String(limit));
    if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
    if (where.game_id) q.push('game_id=' + encodeURIComponent(where.game_id));
    if (where.team_id) q.push('team_id=' + encodeURIComponent(where.team_id));
    if (where.type) q.push('type=' + encodeURIComponent(where.type));
    if (where.user_id) q.push('user_id=' + encodeURIComponent(where.user_id));
    if (where.followed_only) q.push('followed_only=true');
    if (where.followed_teams) q.push('followed_teams=true');
    const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''));
    return parsePostPage(res);
  },
  feedForGame: async (
    gameId: string,
    options: { cursor?: string | null; limit?: number; sort?: string } = {}
  ) => {
    const q: string[] = [];
    q.push('game_id=' + encodeURIComponent(gameId));
    const sortValue = options.sort || 'trending';
    if (sortValue) q.push('sort=' + encodeURIComponent(sortValue));
    const limitValue = typeof options.limit === 'number' ? options.limit : 10;
    if (limitValue) q.push('limit=' + String(limitValue));
    if (options.cursor) q.push('cursor=' + encodeURIComponent(options.cursor));
    const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''), {}, 15000, 1);
    return parsePostPage(res);
  },
  // Additional helpers used in UI
  trendingPage: async (cursor?: string | null, limit: number = 20) => {
    try {
      const q: string[] = [];
      if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
      if (limit) q.push('limit=' + String(limit));
      const res = await httpGet(
        '/posts/trending' + (q.length ? '?' + q.join('&') : ''),
        {},
        12000,
        0
      );
      // normalize to page shape
      return parsePostPage(res);
    } catch (error: any) {
      // Only fall back when trending is absent (404/410). Other errors should surface
      // so we do not silently show chronological feed as if it were trending.
      const status = error?.status;
      if (status !== 404 && status !== 410) {
        throw error;
      }
      if (__DEV__)
        console.log('[Post.trendingPage] Trending route missing, falling back to recent posts');
      const q: string[] = [];
      if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
      if (limit) q.push('limit=' + String(limit));
      q.push('sort=-created_at'); // Sort by most recent
      try {
        const res = await httpGet('/posts' + (q.length ? '?' + q.join('&') : ''), {}, 12000, 0);
        return parsePostPage(res);
      } catch (_fallbackError) {
        return { items: [], nextCursor: null };
      }
    }
  },
  createCollage: (data: CreatePostPayload) => httpPost('/posts/collage', data),
  get: (id: string) => httpGet('/posts/' + encodeURIComponent(id)),
  comments: (id: string, options: { limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));
    if (options.cursor) params.append('cursor', options.cursor);
    const qs = params.toString();
    return httpGet(`/posts/${encodeURIComponent(id)}/comments${qs ? '?' + qs : ''}`);
  },
  addComment: (id: string, content: string, parentId?: string) =>
    httpPost(`/posts/${encodeURIComponent(id)}/comments`, {
      content,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  deleteComment: (postId: string, commentId: string) =>
    httpDelete(`/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`),
  updateComment: (postId: string, commentId: string, content: string) =>
    httpPatch(`/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`, {
      content,
    }),
  delete: (id: string) => httpDelete('/posts/' + encodeURIComponent(id)),
  restore: (id: string) => httpPost(`/posts/${encodeURIComponent(id)}/restore`, {}),
  update: (id: string, data: UpdatePostPayload) =>
    httpPatch('/posts/' + encodeURIComponent(id), data),
  toggleUpvote: (id: string) => httpPost(`/posts/${encodeURIComponent(id)}/upvote`, {}),
  toggleBookmark: (id: string) => httpPost(`/posts/${encodeURIComponent(id)}/bookmark`, {}),
  share: (id: string) => httpPost(`/posts/${encodeURIComponent(id)}/share`, {}),
  getByEvent: async (eventId: string) =>
    parsePostPage(await httpGet(`/posts?event_id=${encodeURIComponent(eventId)}`)),
  createPoll: (id: string, data: { options: string[]; expires_at?: string }) =>
    httpPost(`/posts/${encodeURIComponent(id)}/poll`, data),
  voteOnPoll: (id: string, optionId: string) =>
    httpPost(`/posts/${encodeURIComponent(id)}/poll/vote`, { option_id: optionId }),
};

export const Event = {
  create: (data: CreateEventPayload) => httpPost('/events', data),
  sportsLeagues: (
    where: { sport?: string; level?: string; gender?: string; q?: string; limit?: number } = {}
  ): Promise<{ items: SportsLeagueSummary[] }> => {
    const q: string[] = [];
    if (where.sport) q.push('sport=' + encodeURIComponent(where.sport));
    if (where.level) q.push('level=' + encodeURIComponent(where.level));
    if (where.gender) q.push('gender=' + encodeURIComponent(where.gender));
    if (where.q) q.push('q=' + encodeURIComponent(where.q));
    if (typeof where.limit === 'number') q.push('limit=' + String(where.limit));
    return httpGet('/events/sports-leagues' + (q.length ? '?' + q.join('&') : ''));
  },
  mine: () =>
    httpGet('/events/my-events').then(data => validateEventSummaryArray('events.mine', data)),
  pending: () =>
    httpGet('/events/pending').then(data => validateEventArray('events.pending', data)),
  filter: (
    where: {
      status?: string;
      approval_status?: string;
      event_type?: string;
      q?: string;
      include_cancelled?: boolean;
      team_id?: string;
      team_ids?: string[];
      following?: boolean;
      pro_only?: boolean;
      pro_league?: string;
      sports_league_id?: string;
      league_slug?: string;
      sport?: string;
      level?: string;
      gender?: string;
      event_only?: boolean;
      from?: string;
      to?: string;
    } = {},
    sort?: string,
    limit?: number
  ) => {
    const q: string[] = [];
    if (where.following) q.push('following=true');
    if (where.pro_only) q.push('pro_only=true');
    if (where.pro_league) q.push('pro_league=' + encodeURIComponent(where.pro_league));
    if (where.sports_league_id)
      q.push('sports_league_id=' + encodeURIComponent(where.sports_league_id));
    if (where.league_slug) q.push('league_slug=' + encodeURIComponent(where.league_slug));
    if (where.sport) q.push('sport=' + encodeURIComponent(where.sport));
    if (where.level) q.push('level=' + encodeURIComponent(where.level));
    if (where.gender) q.push('gender=' + encodeURIComponent(where.gender));
    if (where.event_only) q.push('event_only=true');
    if (where.status) q.push('status=' + encodeURIComponent(where.status));
    if (where.approval_status)
      q.push('approval_status=' + encodeURIComponent(where.approval_status));
    if (where.event_type) q.push('event_type=' + encodeURIComponent(where.event_type));
    if (where.include_cancelled) q.push('include_cancelled=true');
    if (where.q) q.push('q=' + encodeURIComponent(where.q));
    if (where.from) q.push('from=' + encodeURIComponent(where.from));
    if (where.to) q.push('to=' + encodeURIComponent(where.to));
    if (where.team_id) q.push('team_id=' + encodeURIComponent(where.team_id));
    if (Array.isArray(where.team_ids) && where.team_ids.length > 0) {
      q.push('team_ids=' + where.team_ids.map(teamId => encodeURIComponent(teamId)).join(','));
    }
    if (sort) q.push('sort=' + encodeURIComponent(sort));
    if (typeof limit === 'number') q.push('limit=' + String(limit));
    return httpGet('/events' + (q.length ? '?' + q.join('&') : '')).then(data =>
      validateEventArray('events.filter', data)
    );
  },
  get: (id: string) =>
    httpGet('/events/' + encodeURIComponent(id)).then(data => validateEvent('events.get', data)),
  votesSummary: (id: string) => httpGet(`/events/${encodeURIComponent(id)}/votes/summary`),
  castVote: (id: string, team: 'A' | 'B') =>
    httpPost(`/events/${encodeURIComponent(id)}/votes`, { team }),
  clearVote: (id: string) => httpDelete(`/events/${encodeURIComponent(id)}/votes`),
  update: (id: string, data: UpdateEventPayload) =>
    httpPatch('/events/' + encodeURIComponent(id), data),
  approve: (id: string) => httpPut(`/events/${encodeURIComponent(id)}/approve`, {}),
  reject: (id: string, reason?: string) =>
    httpPut(`/events/${encodeURIComponent(id)}/reject`, reason ? { reason } : {}),
  cancel: (id: string) => httpPatch('/events/' + encodeURIComponent(id) + '/cancel'),
  extendWindow: (id: string) => httpPost(`/events/${encodeURIComponent(id)}/extend-window`, {}),
  rsvpStatus: (id: string) => httpGet(`/events/${encodeURIComponent(id)}/rsvp`),
  rsvpSummaryBatch: (ids: string[]): Promise<Record<string, { going: boolean; count: number }>> => {
    if (ids.length === 0) return Promise.resolve({});
    const qs = '?ids=' + ids.map(id => encodeURIComponent(id)).join(',');
    return httpGet('/events/rsvp-summary' + qs);
  },
  rsvp: (id: string, going?: boolean) =>
    httpPost(`/events/${encodeURIComponent(id)}/rsvp`, typeof going === 'boolean' ? { going } : {}),
  myRsvps: () =>
    httpGet('/events/my-rsvps').then(data => validateEventRsvpArray('events.myRsvps', data)),
  // Stories for a game-less event page (pro fixtures, etc.). Same shape and
  // server contract as Game.stories / Game.addStory — see server/src/routes/events.ts.
  stories: (id: string) => httpGet(`/events/${encodeURIComponent(id)}/stories`, {}, 15000, 1),
  addStory: (
    id: string,
    data: {
      media_url: string;
      poster_url?: string;
      caption?: string;
      location?: { lat: number; lng: number; source?: 'device' | 'places' | 'zip' | 'derived' };
    }
  ) => httpPostWithOptions(`/events/${encodeURIComponent(id)}/stories`, data, 45000, 0),
};

export const Message = {
  list: (sort: string = '-created_at', limit: number = 50) => {
    const q = [`sort=${encodeURIComponent(sort)}`, `limit=${limit}`];
    const options = {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'If-None-Match': '',
      },
    };
    return httpGet('/messages?' + q.join('&'), options);
  },
  listAll: (limit: number = 200) => httpGet('/messages?all=1&limit=' + String(limit)),
  filter: (_where: any = {}, sort: string = '-created_at') => {
    const options = {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'If-None-Match': '',
      },
    };
    return httpGet('/messages?sort=' + encodeURIComponent(sort), options);
  },
  threadByConversation: (conversationId: string, limit: number = 100) => {
    const q = [
      `conversation_id=${encodeURIComponent(conversationId)}`,
      `sort=${encodeURIComponent('-created_at')}`,
      `limit=${limit}`,
    ];
    return httpGet('/messages?' + q.join('&'));
  },
  threadWith: (email: string, limit: number = 100) => {
    const q = [
      `with=${encodeURIComponent(email)}`,
      `sort=${encodeURIComponent('-created_at')}`,
      `limit=${limit}`,
    ];
    return httpGet('/messages?' + q.join('&'));
  },
  send: (data: {
    content: string;
    conversation_id?: string;
    recipient_id?: string;
    recipient_email?: string;
  }) => httpPost('/messages', data),
  markReadByConversation: (conversationId: string) =>
    httpPost('/messages/mark-read', { conversation_id: conversationId }),
  markReadWith: (email: string) => httpPost('/messages/mark-read', { with: email }),
  unreadCount: () => httpGet('/messages/unread-count'),
};

// Stubs for future entities
export const Organization = {
  list: (q?: string, limit: number = 50): Promise<any> => {
    const params: string[] = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (typeof limit === 'number') params.push('limit=' + encodeURIComponent(String(limit)));
    const qs = params.length ? '?' + params.join('&') : '';
    return httpGet('/organizations' + qs).then(data =>
      validateOrganizationArray('organizations.list', data)
    );
  },
  mine: (): Promise<any> =>
    httpGet('/organizations/mine').then(data =>
      validateOrganizationArray('organizations.mine', data)
    ),
  reviewSummaries: (): Promise<any> =>
    httpGet('/organizations/mine/review-summaries').then(data =>
      validateOrganizationReviewSummaryArray('organizations.reviewSummaries', data)
    ),
  get: (id: string): Promise<any> =>
    httpGet('/organizations/' + encodeURIComponent(id)).then(data =>
      validateOrganization('organizations.get', data)
    ),
  adminSummary: (id: string): Promise<any> =>
    httpGet(`/organizations/${encodeURIComponent(id)}/admin-summary`).then(data =>
      validateOrganizationAdminSummary('organizations.adminSummary', data)
    ),
  follow: (id: string) => httpPost(`/organizations/${encodeURIComponent(id)}/follow`, {}),
  unfollow: (id: string) => httpDelete(`/organizations/${encodeURIComponent(id)}/follow`),
  members: (id: string) => httpGet(`/organizations/${encodeURIComponent(id)}/members`),
  createOrganization: (data: {
    name: string;
    description?: string;
    sport?: string;
    season_start?: string;
    season_end?: string;
    org_type?: string;
    location?: string;
    formatted_address?: string;
    place_id?: string;
    zip_code?: string;
    background_url?: string;
    supporting_document_url?: string;
    latitude?: number;
    longitude?: number;
    onboarding?: boolean;
  }) => httpPost(data.onboarding === true ? '/organizations/create' : '/organizations', data),
  createWithTeams: (data: any) => httpPost('/organizations/create', data),
  invite: (organizationId: string, identifier: string, role?: string) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/invite`, {
      identifier,
      email: identifier,
      role,
    }),
  transferOwnership: (organizationId: string, newOwnerId: string) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/transfer-ownership`, {
      new_owner_id: newOwnerId,
    }),
  cancelInvite: (organizationId: string, inviteId: string) =>
    httpPost(
      `/organizations/${encodeURIComponent(organizationId)}/invites/${encodeURIComponent(inviteId)}/cancel`,
      {}
    ),
  removeMember: (organizationId: string, membershipId: string) =>
    httpDelete(
      `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`
    ),
  updateMemberRole: (organizationId: string, membershipId: string, role: 'manager' | 'member') =>
    httpPatch(
      `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`,
      { role }
    ),
  myInvites: () => httpGet('/organizations/invites/me'),
  acceptInvite: (inviteId: string) =>
    httpPost(`/organizations/invites/${encodeURIComponent(inviteId)}/accept`, {}),
  declineInvite: (inviteId: string) =>
    httpPost(`/organizations/invites/${encodeURIComponent(inviteId)}/decline`, {}),
  myJoinRequests: () => httpGet('/organizations/join-requests/me'),
  programs: (organizationId: string) =>
    httpGet(`/organizations/${encodeURIComponent(organizationId)}/programs`),
  createProgram: (organizationId: string, data: { sport: string; name?: string }) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/programs`, data),
  // Organization join requests (coach onboarding submits via httpPost directly;
  // these are the admin review workflows)
  getJoinRequests: (organizationId: string, status?: 'pending' | 'approved' | 'rejected') => {
    const params: string[] = [];
    if (status) params.push('status=' + encodeURIComponent(status));
    const qs = params.length ? '?' + params.join('&') : '';
    return httpGet(`/organizations/${encodeURIComponent(organizationId)}/join-requests` + qs);
  },
  approveJoinRequest: (requestId: string) =>
    httpPost(`/organizations/join-requests/${encodeURIComponent(requestId)}/approve`, {}),
  rejectJoinRequest: (requestId: string, reason?: string) =>
    httpPost(`/organizations/join-requests/${encodeURIComponent(requestId)}/deny`, { reason }),
  update: (id: string, data: Record<string, any>) =>
    httpPatch(`/organizations/${encodeURIComponent(id)}`, data),
  approveLeague: (organizationId: string, note?: string) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/approve`, { note }),
  rejectLeague: (organizationId: string, reason?: string) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/reject`, { reason }),
  resendApprovalEmail: (organizationId: string) =>
    httpPost(`/organizations/${encodeURIComponent(organizationId)}/resend-approval-email`, {}),
};

export const Team = {
  list: (
    q?: string,
    mine?: boolean,
    options?: {
      directory?: boolean;
      limit?: number;
      organization_id?: string;
      excludeDemoLeagues?: boolean;
    }
  ): Promise<any> => {
    const params: string[] = [];
    if (q) params.push(`q=${encodeURIComponent(q)}`);
    if (mine) params.push('mine=1');
    if (options?.directory) params.push('directory=1');
    if (typeof options?.limit === 'number') params.push(`limit=${String(options.limit)}`);
    if (options?.organization_id)
      params.push(`organization_id=${encodeURIComponent(options.organization_id)}`);
    if (options?.excludeDemoLeagues) params.push('exclude_demo_leagues=1');
    const qs = params.length ? '?' + params.join('&') : '';
    return httpGet('/teams' + qs).then(data => validateTeamArray('teams.list', data));
  },
  listAllAdmin: (q?: string, limit: number = 100): Promise<any> => {
    const params: string[] = ['all=1', 'limit=' + String(limit)];
    if (q) params.push('q=' + encodeURIComponent(q));
    return httpGet('/teams?' + params.join('&')).then(data =>
      validateTeamArray('teams.listAllAdmin', data)
    );
  },
  managed: (q?: string): Promise<any> => {
    const params: string[] = [];
    if (q) params.push(`q=${encodeURIComponent(q)}`);
    const qs = params.length ? '?' + params.join('&') : '';
    return httpGet('/teams/managed' + qs).then(data => validateTeamArray('teams.managed', data));
  },
  followed: (): Promise<any> =>
    httpGet('/follows/teams?user_id=me').then(data =>
      validateFollowedTeamArray('teams.followed', data)
    ),
  get: (id: string): Promise<any> =>
    httpGet('/teams/' + encodeURIComponent(id)).then(data => validateTeam('teams.get', data)),
  screenSummary: (id: string): Promise<any> =>
    httpGet('/teams/' + encodeURIComponent(id) + '/screen-summary').then(data =>
      validateTeamScreenSummary('teams.screenSummary', data)
    ),
  adminSummary: (id: string): Promise<any> =>
    httpGet('/teams/' + encodeURIComponent(id) + '/admin-summary').then(data =>
      validateTeamAdminSummary('teams.adminSummary', data)
    ),
  follow: (id: string) => httpPost(`/teams/${encodeURIComponent(id)}/follow`, {}),
  unfollow: (id: string) => httpDelete(`/teams/${encodeURIComponent(id)}/follow`),
  members: (id: string) => httpGet(`/teams/${encodeURIComponent(id)}/members`),
  allMembers: (q?: string) =>
    httpGet('/teams/members/all' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  create: (data: {
    name: string;
    description?: string;
    sport?: string;
    season?: string;
    season_start?: string;
    season_end?: string;
    organization_id?: string;
    organization_name?: string;
    logo_url?: string | null;
    authorized_users?: Array<{
      email?: string;
      user_id?: string;
      role?: string;
      assign_team?: string;
    }>;
  }) => {
    const payload: Record<string, any> = {};
    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined) return;
      if (key === 'logo_url') {
        if (typeof value === 'string' && value.length > 0) {
          payload.logo_url = value;
        }
        return;
      }
      payload[key] = value;
    });
    return httpPost('/teams/create', payload);
  },
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      sport?: string;
      season?: string;
      organization_id?: string | null;
      logo_url?: string | null;
    }
  ) => {
    const payload: Record<string, any> = {};
    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined) return;
      if (key === 'logo_url' && value === null) {
        payload[key] = '';
      } else {
        payload[key] = value;
      }
    });
    return httpPut('/teams/' + encodeURIComponent(id), payload);
  },
  // Accepts an email OR a @username. An identifier containing '@' that also
  // has a domain part is treated as email; otherwise it's sent as a username
  // for the server to resolve to the person's canonical account.
  invite: (teamId: string, identifier: string, role?: string) => {
    const value = identifier.trim().replace(/^@/, '');
    const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    const body = looksLikeEmail ? { email: value, role } : { username: value, role };
    return httpPost(`/teams/${encodeURIComponent(teamId)}/invite`, body);
  },
  cancelInvite: (teamId: string, inviteId: string) =>
    httpPost(
      `/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}/cancel`,
      {}
    ),
  myInvites: () => httpGet('/teams/invites/me'),
  acceptInvite: (inviteId: string) =>
    httpPost(`/teams/invites/${encodeURIComponent(inviteId)}/accept`, {}),
  declineInvite: (inviteId: string) =>
    httpPost(`/teams/invites/${encodeURIComponent(inviteId)}/decline`, {}),
  updateMember: (membershipId: string, data: { role?: string; custom_position?: string | null }) =>
    httpPatch(`/team-memberships/${encodeURIComponent(membershipId)}`, data),
  removeMember: (membershipId: string, reason?: string) =>
    httpDelete(
      `/team-memberships/${encodeURIComponent(membershipId)}`,
      reason ? { reason } : undefined
    ),
  delete: (id: string) => httpDelete('/teams/' + encodeURIComponent(id)),
  limits: () => httpGet('/teams/limits'),
  transferOwnership: (teamId: string, newOwnerId: string) =>
    httpPost(`/teams/${encodeURIComponent(teamId)}/transfer-ownership`, {
      new_owner_id: newOwnerId,
    }),
};

export const Program = {
  screenSummary: (id: string): Promise<any> =>
    httpGet(`/programs/${encodeURIComponent(id)}/screen-summary`).then(data =>
      validateProgramScreenSummary('program.screenSummary', data)
    ),
  follow: (id: string) => httpPost(`/programs/${encodeURIComponent(id)}/follow`, {}),
  unfollow: (id: string) => httpDelete(`/programs/${encodeURIComponent(id)}/follow`),
};

export const Support = {
  contact: (data: {
    name: string;
    email: string;
    subject: string;
    message: string;
    from_email?: string;
  }) => httpPost('/support/contact', data),
  feedback: (data: {
    user_id?: string;
    category: 'bug' | 'idea' | 'other';
    message: string;
    screenshot_url?: string;
  }) => httpPost('/support/feedback', data),
};

export const Report = {
  create: (data: { target_type: string; target_id: string; reason: string; details?: string }) =>
    httpPost('/reports', data),
};

async function getPaymentsConfig(): Promise<{
  stripe_publishable_key: string;
  available_plans: any[];
  payments_enabled: boolean;
  stripe_configured: boolean;
  has_webhook_secret: boolean;
}> {
  try {
    return await httpGet('/payments/config');
  } catch (err: any) {
    if (err?.status === 404) {
      try {
        const health = await httpGet('/health?include=payments');
        const cfg = (health as any)?.payments_config;
        if (cfg) return cfg;
      } catch {
        // Health may not support include=payments (old server) - fall through to throw original
      }
    }
    throw err;
  }
}

function finalizePaymentSession(sessionId: string) {
  invalidateMeCache();
  return httpPost('/payments/finalize-session', { session_id: sessionId });
}

function finalizeStripeSubscription(subscriptionId: string) {
  invalidateMeCache();
  return httpPost('/payments/finalize-subscription', { subscription_id: subscriptionId });
}

export const Payments = {
  configStatus: getPaymentsConfig,
  getConfig: getPaymentsConfig,
  createPaymentSheet: (payload: {
    plan?: string;
    promo_code?: string;
    ad_id?: string;
    dates?: string[];
  }) => httpPost('/payments/create-payment-sheet', payload),
  cancelIntent: (paymentIntentId: string) =>
    httpPost('/payments/cancel-intent', { payment_intent_id: paymentIntentId }),
  finalizeSession: finalizePaymentSession,
};

export const Subscriptions = {
  createCheckout: (plan: string, teamCount?: number) =>
    httpPost('/payments/checkout', { plan, team_count: teamCount }),
  finalizeSession: finalizePaymentSession,
  finalizeSubscription: finalizeStripeSubscription,
  cancel: () => {
    invalidateMeCache();
    return httpPost('/payments/subscription/cancel', {});
  },
  // v1.0.2: undo a cancel-at-period-end before the period actually ends
  resume: () => {
    invalidateMeCache();
    return httpPost('/payments/subscription/resume', {});
  },
  updateQuantity: (teamCount: number) => {
    invalidateMeCache();
    return httpPost('/payments/update-subscription-quantity', { team_count: teamCount });
  },
  getSummary: () => httpGet('/payments/subscription/summary'),
  // v1.0.2: billing history for current user
  history: (limit: number = 50) =>
    httpGet(`/payments/history?limit=${encodeURIComponent(String(limit))}`),
};

export const TeamMemberships = {
  create: (data: { team_id: string; user_id: string; role?: string }) =>
    httpPost('/team-memberships', data),
  update: (
    membershipId: string,
    data: { role?: string; custom_position?: string | null; status?: 'active' | 'archived' }
  ) => httpPatch(`/team-memberships/${encodeURIComponent(membershipId)}`, data),
  delete: (membershipId: string) =>
    httpDelete(`/team-memberships/${encodeURIComponent(membershipId)}`),
  searchUsers: (teamId: string, q: string) =>
    httpGet(
      `/team-memberships/search-users?teamId=${encodeURIComponent(teamId)}&q=${encodeURIComponent(q)}`
    ),
};

export const TeamInvites = {
  create: (data: { team_id: string; identifier?: string; email?: string; role?: string }) =>
    httpPost('/team-invites', {
      ...data,
      identifier: data.identifier || data.email,
    }),
};

export const Notification = {
  listPage: async (cursor?: string | null, limit: number = 20, unreadOnly: boolean = false) => {
    try {
      const params: string[] = [];
      params.push('limit=' + encodeURIComponent(String(limit)));
      if (cursor) params.push('cursor=' + encodeURIComponent(cursor));
      if (unreadOnly) params.push('unread=1');
      const qs = params.length ? '?' + params.join('&') : '';
      // Use shorter timeout for notification polling (10 seconds)
      const timeout = limit === 1 && unreadOnly ? 10000 : 30000;
      // Polling endpoint: do not retry aggressively.
      return await httpGet('/notifications' + qs, {}, timeout, 0);
    } catch (error: any) {
      // If unauthorized (not logged in), return empty page
      if (error?.message?.includes('Unauthorized') || error?.status === 401) {
        if (__DEV__)
          console.log('[Notification.listPage] Not authenticated, returning empty results');
        return { items: [], cursor: null, nextCursor: null };
      }
      // If timeout or network error, return empty page for polling requests
      if (
        limit === 1 &&
        unreadOnly &&
        (error?.message?.includes('timeout') || error?.message?.includes('Aborted'))
      ) {
        if (__DEV__) console.warn('[Notification.listPage] Poll timeout, returning empty results');
        return { items: [], cursor: null, nextCursor: null };
      }
      throw error;
    }
  },
  markRead: (id: string) => httpPost(`/notifications/${encodeURIComponent(id)}/read`, {}),
  markAllRead: () => httpPost('/notifications/mark-read-all', {}),
  unreadCount: () => httpGet('/notifications/unread-count'),
};

export const Advertisement = {
  reservedDates: (from?: string, to?: string) => {
    const q: string[] = [];
    if (from) q.push('from=' + encodeURIComponent(from));
    if (to) q.push('to=' + encodeURIComponent(to));
    return httpGet('/ads/reservations' + (q.length ? '?' + q.join('&') : ''));
  },
  reservationsForAd: (ad_id: string) =>
    httpGet('/ads/reservations?ad_id=' + encodeURIComponent(ad_id)),
  reserve: (ad_id: string, dates: string[]) => httpPost('/ads/reservations', { ad_id, dates }),
  create: (data: CreateAdPayload) => httpPostWithOptions('/ads', data, 15000, 0),
  listMine: () => httpGet('/ads?mine=1'),
  listAll: () => httpGet('/ads?all=1'),
  get: (id: string) => httpGet('/ads/' + encodeURIComponent(id)),
  update: (id: string, data: UpdateAdPayload) => httpPut('/ads/' + encodeURIComponent(id), data),
  delete: (id: string) => httpDelete('/ads/' + encodeURIComponent(id)),
  forFeed: (dateISO?: string, zip?: string, limit: number = 1, lat?: number, lng?: number) => {
    const q: string[] = [];
    if (dateISO) q.push('date=' + encodeURIComponent(dateISO));
    if (zip) q.push('zip=' + encodeURIComponent(zip));
    if (limit) q.push('limit=' + String(limit));
    if (lat != null) q.push('lat=' + String(lat));
    if (lng != null) q.push('lng=' + String(lng));
    return httpGet('/ads/for-feed' + (q.length ? '?' + q.join('&') : ''));
  },
  submitForApproval: (adId: string, dates?: string[]) =>
    httpPost(
      `/ads/${encodeURIComponent(adId)}/submit-for-approval`,
      dates?.length ? { dates } : {}
    ),
  trackImpression: (adId: string) => httpPost(`/ads/${encodeURIComponent(adId)}/impression`, {}),
  trackClick: (adId: string) => httpPost(`/ads/${encodeURIComponent(adId)}/click`, {}),
  review: (
    adId: string,
    action: 'approve' | 'reject',
    note?: string,
    overrideBannerFlag?: boolean,
    overrideReason?: string
  ) =>
    httpPost(`/ads/${encodeURIComponent(adId)}/review`, {
      action,
      note,
      ...(overrideBannerFlag
        ? { override_banner_flag: true, override_reason: overrideReason }
        : {}),
    }),
  report: (adId: string, reason: string, details?: string) =>
    httpPost('/reports', { target_type: 'ad', target_id: adId, reason, details }),
};

export const Search = {
  unified: (q: string, limit: number = 10, options?: { excludeDemoLeagues?: boolean }) => {
    const params = new URLSearchParams();
    params.set('q', q);
    if (limit) params.set('limit', String(limit));
    if (options?.excludeDemoLeagues) params.set('exclude_demo_leagues', '1');
    return httpGet('/search?' + params.toString());
  },
};

export const Highlights = {
  fetch: (
    params: {
      country?: string;
      lat?: number;
      lng?: number;
      limit?: number;
      sort?: 'trending' | 'recent' | 'top';
    } = {}
  ) => {
    const q: string[] = [];
    q.push('v2=1');
    if (params.country) q.push('country=' + encodeURIComponent(params.country));
    if (typeof params.lat === 'number') q.push('lat=' + encodeURIComponent(String(params.lat)));
    if (typeof params.lng === 'number') q.push('lng=' + encodeURIComponent(String(params.lng)));
    if (params.limit) q.push('limit=' + encodeURIComponent(String(params.limit)));
    if (params.sort) q.push('sort=' + encodeURIComponent(params.sort));
    return httpGet('/highlights' + (q.length ? '?' + q.join('&') : ''));
  },
};

export const Feed = {
  bundle: (
    params: {
      country?: string;
      date?: string;
      zip?: string;
      lat?: number;
      lng?: number;
      posts_limit?: number;
      highlights_limit?: number;
      ads_limit?: number;
      posts_cursor?: string;
      posts_followed_teams_cursor?: string;
    } = {}
  ) => {
    const q: string[] = [];
    if (params.country) q.push('country=' + encodeURIComponent(params.country));
    if (params.date) q.push('date=' + encodeURIComponent(params.date));
    if (params.zip) q.push('zip=' + encodeURIComponent(params.zip));
    if (typeof params.lat === 'number') q.push('lat=' + encodeURIComponent(String(params.lat)));
    if (typeof params.lng === 'number') q.push('lng=' + encodeURIComponent(String(params.lng)));
    if (params.posts_limit) q.push('posts_limit=' + encodeURIComponent(String(params.posts_limit)));
    if (params.highlights_limit)
      q.push('highlights_limit=' + encodeURIComponent(String(params.highlights_limit)));
    if (params.ads_limit) q.push('ads_limit=' + encodeURIComponent(String(params.ads_limit)));
    if (params.posts_cursor) q.push('posts_cursor=' + encodeURIComponent(params.posts_cursor));
    if (params.posts_followed_teams_cursor)
      q.push(
        'posts_followed_teams_cursor=' + encodeURIComponent(params.posts_followed_teams_cursor)
      );
    return httpGet('/feed/bundle' + (q.length ? '?' + q.join('&') : ''));
  },
};
