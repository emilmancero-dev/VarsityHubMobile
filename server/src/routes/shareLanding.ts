/**
 * Share-landing router — HTML fallback for universal-link URLs.
 *
 * Why
 * ---
 * Shared URLs like `https://varsityhub.app/posts/abc123` are universal
 * links: the OS opens the app if installed (AASA + assetlinks already
 * wired). When the app is NOT installed, the URL falls through to the
 * browser. Without this router, the browser hits the Express API at
 * `/posts/:id` and gets a JSON 404/401 — a dead end for anyone clicking
 * a shared link from web, email, or a social-app webview.
 *
 * What
 * ----
 * For each shareable resource path, this middleware:
 *   1. Detects whether the request wants HTML (`Accept: text/html`).
 *      JSON clients fall through to the existing API route — no change
 *      to mobile or web-app fetches.
 *   2. Pulls minimal OG metadata from the DB (title, image, description)
 *      so iMessage / X / Discord / Facebook generate previews instead of
 *      raw URL strings.
 *   3. Renders a tiny HTML landing page that:
 *      - tries to deep-link the same URL (which iOS/Android will
 *        intercept if the app is installed)
 *      - shows App Store / Play Store fallback buttons
 *
 * Mount BEFORE the API routers in app.ts so the landing-detect runs
 * first; otherwise Express matches the API GET /:id and returns JSON.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { isAuthorHiddenFromViewer } from '../lib/privacyUtils.js';
import { isGamePubliclyVisible } from '../lib/gameApproval.js';

const APP_STORE_URL =
  process.env.IOS_APP_STORE_URL || 'https://apps.apple.com/us/app/varsityhub/id6758405187';
const PLAY_STORE_URL =
  process.env.ANDROID_PLAY_STORE_URL ||
  'https://play.google.com/store/apps/details?id=com.varsityhub.varsityhub';

/** Routes the OS may try to deep-link via universal links. Mirrors the
 *  AASA `paths` and Android `intentFilters` pathPrefixes. Anything else
 *  on a shareable host falls through unhandled. */
const SHAREABLE_PATHS = [
  '/posts',
  '/games',
  '/teams',
  '/users',
  '/events',
  '/programs',
  '/organizations',
  '/join',
  '/share',
] as const;

// Crawlers / link-preview bots that set Accept: */* (or even nothing) but
// do want OG tags. Match against User-Agent so we don't false-positive on
// supertest, fetch defaults, or random integrations that also send */*.
const SOCIAL_CRAWLER_UA =
  /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|LinkedInBot|TelegramBot|Pinterestbot|WhatsApp|SkypeUriPreview|iMessagePreview|GoogleBot|Bingbot/i;

function wantsHtml(req: Request): boolean {
  const accepts = String(req.headers.accept || '');
  // Explicit JSON clients (mobile app, fetch, integrations) skip the landing.
  if (accepts.includes('application/json')) return false;
  // Browsers always include `text/html` in their Accept list (often as the
  // first or second entry). Match strictly on this rather than on `*/*`
  // alone — `*/*` is what supertest, axios, and fetch send by default,
  // and we don't want the landing to intercept legitimate API clients.
  if (accepts.includes('text/html')) return true;
  // Social crawlers (FB, Twitter, Slack, Discord, etc.) need OG tags but
  // sometimes send only `*/*`. Detect them by User-Agent so we still
  // serve previews without false-positiving on JSON clients.
  const ua = String(req.headers['user-agent'] || '');
  if (SOCIAL_CRAWLER_UA.test(ua)) return true;
  return false;
}

const shareLandingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 60 : 100000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `ip:${req.ip || 'unknown'}`,
  skip: req => !wantsHtml(req),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please slow down and try again later',
      retryAfter: 60,
    });
  },
});

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

interface LandingMeta {
  title: string;
  description?: string;
  imageUrl?: string;
  url: string;
}

function renderLanding(meta: LandingMeta, legalBaseUrl: string): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(
    meta.description || 'Join VarsityHub to follow your team, your players, and your community.'
  );
  const imageUrl = meta.imageUrl ? escapeHtml(meta.imageUrl) : '';
  const url = escapeHtml(meta.url);
  const safeLegalBaseUrl = escapeHtml(legalBaseUrl.replace(/\/$/, ''));
  const cardType = imageUrl ? 'summary_large_image' : 'summary';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — VarsityHub</title>
  <meta name="description" content="${description}" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#0a7ea4" />

  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${url}" />
  <meta property="og:site_name" content="VarsityHub" />
  ${imageUrl ? `<meta property="og:image" content="${imageUrl}" />` : ''}

  <meta name="twitter:card" content="${cardType}" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${imageUrl ? `<meta name="twitter:image" content="${imageUrl}" />` : ''}

  <link rel="canonical" href="${url}" />

  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 480px;
      margin: 0 auto;
      padding: 32px 20px;
      color: #11181C;
      background: #FFFFFF;
      line-height: 1.5;
    }
    .logo { font-size: 28px; font-weight: 700; color: #0a7ea4; text-align: center; margin-bottom: 4px; }
    .tagline { color: #6B7280; text-align: center; font-size: 14px; margin-bottom: 32px; }
    .card { background: #F3F4F6; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .card img { width: 100%; max-height: 320px; object-fit: cover; border-radius: 8px; margin-bottom: 16px; display: block; }
    .card .title { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .card .desc { color: #6B7280; font-size: 14px; }
    a.btn {
      display: block;
      padding: 14px 24px;
      border-radius: 10px;
      text-decoration: none;
      font-weight: 600;
      text-align: center;
      margin-bottom: 12px;
      transition: opacity 0.15s;
    }
    a.btn:hover { opacity: 0.9; }
    a.btn-primary { background: #0a7ea4; color: white; }
    a.btn-secondary { background: white; color: #11181C; border: 1px solid #D1D5DB; }
    .stores { display: flex; gap: 12px; margin-top: 8px; }
    .stores a { flex: 1; }
    .footer { text-align: center; color: #9CA3AF; font-size: 12px; margin-top: 32px; }
    .footer a { color: #6B7280; text-decoration: none; }
  </style>
</head>
<body>
  <div class="logo">VarsityHub</div>
  <div class="tagline">Sports community for teams, fans, and players</div>

  <div class="card">
    ${imageUrl ? `<img src="${imageUrl}" alt="" loading="lazy" />` : ''}
    <div class="title">${title}</div>
    ${meta.description ? `<div class="desc">${description}</div>` : ''}
  </div>

  <a class="btn btn-primary" href="${url}">Open in VarsityHub</a>

  <div class="stores">
    <a class="btn btn-secondary" href="${escapeHtml(APP_STORE_URL)}">App Store</a>
    <a class="btn btn-secondary" href="${escapeHtml(PLAY_STORE_URL)}">Google Play</a>
  </div>

  <div class="footer">
    <a href="${safeLegalBaseUrl}/privacy-policy">Privacy</a>
  </div>
</body>
</html>`;
}

function fullUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

function requestOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}`;
}

function genericLanding(req: Request): LandingMeta {
  return {
    title: 'VarsityHub',
    description: 'Join your team on VarsityHub.',
    url: fullUrl(req),
  };
}

// ─── Per-resource handlers ────────────────────────────────────────────────

async function postLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const post = await prisma.post
    .findUnique({
      where: { id },
      select: {
        content: true,
        media_url: true,
        deleted_at: true,
        author_id: true,
        author: { select: { display_name: true, username: true } },
      },
    })
    .catch(() => null);

  // Don't leak deleted posts, or content from private accounts, through the
  // public share door. Anonymous viewer → a private author is always hidden.
  const authorHidden = post?.author_id
    ? await isAuthorHiddenFromViewer(post.author_id, null).catch(() => true)
    : false;
  const visiblePost = post && !post.deleted_at && !authorHidden ? post : null;

  const authorLabel =
    visiblePost?.author?.display_name || visiblePost?.author?.username || 'A VarsityHub member';
  const meta: LandingMeta = visiblePost
    ? {
        title: `${authorLabel} on VarsityHub`,
        description: visiblePost.content?.slice(0, 200) || undefined,
        imageUrl: visiblePost.media_url || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

async function gameLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const game = await prisma.game
    .findUnique({
      where: { id },
      select: {
        title: true,
        location: true,
        date: true,
        approval_status: true,
        opponent_approval_status: true,
      },
    })
    .catch(() => null);

  // Do not leak pending/rejected games — nor upcoming games whose opponent
  // hasn't consented (or declined) — through this public side door. Mirrors
  // og.ts / GET /games via the shared isGamePubliclyVisible rule.
  const visibleGame = game && isGamePubliclyVisible(game) ? game : null;

  const meta: LandingMeta = visibleGame
    ? {
        title: visibleGame.title || 'VarsityHub Game',
        description:
          [
            visibleGame.location && `at ${visibleGame.location}`,
            visibleGame.date &&
              new Date(visibleGame.date).toLocaleDateString(undefined, { dateStyle: 'long' }),
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

async function teamLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const team = await prisma.team
    .findUnique({
      where: { id },
      select: { name: true, description: true, logo_url: true, is_private: true, status: true },
    })
    .catch(() => null);

  // Private or archived teams must not expose their profile through the public
  // share door (Team.is_private restricts the profile to members/followers/org
  // admins — this anonymous surface has none of those).
  const visibleTeam = team && !team.is_private && team.status === 'active' ? team : null;

  const meta: LandingMeta = visibleTeam
    ? {
        title: visibleTeam.name || 'VarsityHub Team',
        description: visibleTeam.description || undefined,
        imageUrl: visibleTeam.logo_url || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

// Sport program label — deliberately NOT importing the client sports
// taxonomy (constants/sports.ts) to keep this server route dependency-free.
// Trade-off: this title-cases the raw slug ("track_field" -> "Track Field")
// instead of using the taxonomy's exact display names, which is close
// enough for a share-link preview and avoids a client/server coupling.
function sportProgramLabel(program: { sport: string; name: string | null }): string {
  if (program.name) return program.name;
  return String(program.sport || '')
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function programLandingTitle(program: {
  sport: string;
  name: string | null;
  organization?: { name: string } | null;
}): string {
  const label = sportProgramLabel(program);
  const orgName = program.organization?.name;
  return orgName ? `${orgName} — ${label}` : label;
}

async function programLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const program = await prisma.sportProgram
    .findUnique({
      where: { id },
      select: {
        sport: true,
        name: true,
        logo_url: true,
        organization: { select: { name: true, admin_approved: true } },
        teams: {
          where: { status: 'active', is_private: false },
          select: { id: true },
          take: 1,
        },
      },
    })
    .catch(() => null);

  // Mirror the public program-page boundary: only approved-org programs with at
  // least one public active level team may render branded metadata here.
  const visibleProgram =
    program && program.organization?.admin_approved === true && program.teams.length > 0
      ? program
      : null;

  const meta: LandingMeta = visibleProgram
    ? {
        title: programLandingTitle(visibleProgram),
        imageUrl: visibleProgram.logo_url || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

async function userLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const user = await prisma.user
    .findUnique({
      where: { id },
      select: {
        display_name: true,
        username: true,
        bio: true,
        avatar_url: true,
        deleted_at: true,
        preferences: true,
      },
    })
    .catch(() => null);

  // Mirror the public profile gate exactly: deleted/anonymized accounts AND
  // private profiles for anonymous viewers fall back to the generic landing.
  const hiddenFromAnonymous = user
    ? await isAuthorHiddenFromViewer(id, null).catch(() => true)
    : true;
  const visibleUser = user && !user.deleted_at && !hiddenFromAnonymous ? user : null;
  const handle = visibleUser?.username
    ? `@${visibleUser.username}`
    : visibleUser?.display_name || 'A VarsityHub member';
  const meta: LandingMeta = visibleUser
    ? {
        title: handle,
        description: visibleUser.bio || undefined,
        imageUrl: visibleUser.avatar_url || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

async function eventLanding(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  const id = String(req.params.id || '').trim();
  if (!id) return next();

  const event = await prisma.event
    .findUnique({
      where: { id },
      select: {
        title: true,
        location: true,
        date: true,
        banner_url: true,
        description: true,
        approval_status: true,
        status: true,
        game: {
          select: {
            approval_status: true,
            opponent_approval_status: true,
            date: true,
          },
        },
      },
    })
    .catch(() => null);

  // Only approved, non-cancelled events are public. Pending/rejected/cancelled
  // event details must not leak through the share door. A game-backed event also
  // inherits the game's opponent-consent gate (upcoming unconfirmed/declined
  // fixtures stay private).
  const eventPublic =
    !!event && event.approval_status === 'approved' && event.status !== 'cancelled';
  const gamePublic = !event?.game || isGamePubliclyVisible(event.game);
  const visibleEvent = eventPublic && gamePublic ? event : null;

  const meta: LandingMeta = visibleEvent
    ? {
        title: visibleEvent.title || 'VarsityHub Event',
        description:
          visibleEvent.description?.slice(0, 200) ||
          [
            visibleEvent.location && `at ${visibleEvent.location}`,
            visibleEvent.date &&
              new Date(visibleEvent.date).toLocaleDateString(undefined, { dateStyle: 'long' }),
          ]
            .filter(Boolean)
            .join(' · ') ||
          undefined,
        imageUrl: visibleEvent.banner_url || undefined,
        url: fullUrl(req),
      }
    : genericLanding(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(meta, requestOrigin(req)));
}

function genericLandingHandler(req: Request, res: Response, next: NextFunction) {
  if (!wantsHtml(req)) return next();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(renderLanding(genericLanding(req), requestOrigin(req)));
}

// The app's share sheet emits query-style links (/share?type=post&id=…). Route
// them to the matching entity landing so crawlers get a real og:image + title
// instead of the generic card (owner note, Sep 2026: shared links show no
// preview image). Path-style links (/posts/:id …) already hit their handlers
// directly; this only rescues the query form. Falls back to the generic landing
// when type/id are missing or unknown, and reuses each handler's existing
// privacy/visibility gates.
function shareQueryHandler(req: Request, res: Response, next: NextFunction) {
  const type = typeof req.query.type === 'string' ? req.query.type : null;
  const id = typeof req.query.id === 'string' ? req.query.id : null;
  if (!type || !id) return genericLandingHandler(req, res, next);
  req.params = { ...req.params, id };
  switch (type) {
    case 'post':
      return postLanding(req, res, next);
    case 'game':
      return gameLanding(req, res, next);
    case 'event':
      return eventLanding(req, res, next);
    case 'team':
      return teamLanding(req, res, next);
    case 'program':
      return programLanding(req, res, next);
    case 'profile':
      return userLanding(req, res, next);
    default:
      return genericLandingHandler(req, res, next);
  }
}

export const shareLandingRouter = Router();
shareLandingRouter.use(shareLandingLimiter);
shareLandingRouter.get('/posts/:id', postLanding);
shareLandingRouter.get('/games/:id', gameLanding);
shareLandingRouter.get('/teams/:id', teamLanding);
shareLandingRouter.get('/programs/:id', programLanding);
shareLandingRouter.get('/users/:id', userLanding);
shareLandingRouter.get('/events/:id', eventLanding);
// Invite/share routes get the generic landing — no DB lookup needed since
// they're transactional, not content surfaces.
shareLandingRouter.get('/join/:code', genericLandingHandler);
shareLandingRouter.get('/join/team/:code', genericLandingHandler);
shareLandingRouter.get('/join/org/:code', genericLandingHandler);
shareLandingRouter.get('/share', shareQueryHandler);

export { SHAREABLE_PATHS, renderLanding };
