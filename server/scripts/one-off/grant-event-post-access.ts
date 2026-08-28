/**
 * Grant a user posting access to an event page — and optionally upload photos to
 * it on their behalf — by inserting a backdated "qualifying live" post.
 *
 * WHY THIS EXISTS
 * ---------------
 * Posting to a game/event feed is gated by verifyEventPostingPermission
 * (server/src/lib/geofencing.ts). A normal user may post only:
 *   - LIVE  (kickoff → kickoff + 2h): physically within 3km of the venue, OR
 *   - GRACE (kickoff + 2h → kickoff + 48h): ONLY if they already have a
 *     qualifying live post — a Post with game_id = event.game_id created
 *     between kickoff and kickoff+2h.
 *   - After 48h the window is CLOSED for everyone (non-admin).
 *
 * So "make it look like this user attended and posted, and let them keep
 * posting" reduces to a single DB insert: a backdated Post with
 *   author_id = <user>, game_id = <event.game_id>, created_at ∈ [kickoff, kickoff+2h].
 *
 * That one row:
 *   (a) puts their photo on the event page attributed to them as if they were
 *       there live, and
 *   (b) satisfies the grace-window check, unlocking self-posting in the app —
 *       BUT only while the event is still inside the 48h grace window. If the
 *       window is already CLOSED, the row still appears on the page, but the
 *       app will not let them post new photos themselves; re-run this script
 *       per batch of marketing photos instead.
 *
 * This is the canonical template for "a user couldn't post to an event page at
 * the time and we need to seed their attendance/photos after the fact."
 *
 * USAGE
 * -----
 *   # Dry run — resolve + print the plan, write nothing (ALWAYS do this first):
 *   DATABASE_URL=... npx tsx scripts/one-off/grant-event-post-access.ts \
 *     --user <userId> --event <eventId> --dry-run
 *
 *   # Grant access only (one content-less marker post unlocks posting):
 *   DATABASE_URL=... npx tsx scripts/one-off/grant-event-post-access.ts \
 *     --user <userId> --event <eventId> --yes
 *
 *   # Upload photos on their behalf (repeat --media; --caption zips by index):
 *   DATABASE_URL=... npx tsx scripts/one-off/grant-event-post-access.ts \
 *     --user <userId> --event <eventId> \
 *     --media https://res.cloudinary.com/.../a.jpg --caption "What a match!" \
 *     --media https://res.cloudinary.com/.../b.jpg \
 *     --yes
 *
 * For production, pass the Railway DB URL explicitly:
 *   DATABASE_URL="$(railway variables --json | jq -r .DATABASE_PUBLIC_URL)" \
 *     npx tsx scripts/one-off/grant-event-post-access.ts --user ... --event ... --dry-run
 *
 * FLAGS
 *   --user <id>        target user id (author of the seeded posts)
 *   --username <name>  resolve the user by username/display_name instead of --user
 *                      (case-insensitive; aborts and lists matches if ambiguous)
 *   --event <id>       event id; its linked game_id is the post key
 *   --event-title <s>  resolve the event by title substring instead of --event
 *                      (case-insensitive; aborts and lists matches if ambiguous)
 *   (provide either --user or --username, and either --event or --event-title)
 *   --media <url>      (repeatable) photo/video URL to post; omit to seed a
 *                      single marker post that only grants access
 *   --caption <text>   (repeatable) caption, zipped to --media by position;
 *                      a lone --caption with no --media captions the marker post
 *   --type <t>         post type (default: "post")
 *   --country <CC>     ISO country code to stamp (needed for country-filtered
 *                      highlights visibility; the game/event feed does not need it)
 *   --admin1 <region>  admin1/region to stamp alongside --country
 *   --at <ISO8601>     override created_at; must land in [kickoff, kickoff+2h];
 *                      default = kickoff + 30 min
 *   --dry-run          resolve + print the plan, write nothing
 *   --yes              required to actually write (guard against accidental prod writes)
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // matches REGULAR_POST_LIVE_WINDOW_MS
const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000; // matches REGULAR_POST_GRACE_WINDOW_MS

function parseArgs() {
  const argv = process.argv.slice(2);
  let user: string | undefined;
  let username: string | undefined;
  let event: string | undefined;
  let eventTitle: string | undefined;
  let type = 'post';
  let country: string | undefined;
  let admin1: string | undefined;
  let at: string | undefined;
  const media: string[] = [];
  const captions: string[] = [];
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Missing value for ${a}`);
        process.exit(1);
      }
      return v;
    };
    switch (a) {
      case '--user':
        user = next();
        break;
      case '--username':
        username = next();
        break;
      case '--event':
        event = next();
        break;
      case '--event-title':
        eventTitle = next();
        break;
      case '--media':
        media.push(next());
        break;
      case '--caption':
        captions.push(next());
        break;
      case '--type':
        type = next();
        break;
      case '--country':
        country = next();
        break;
      case '--admin1':
        admin1 = next();
        break;
      case '--at':
        at = next();
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--yes':
        yes = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }

  if (!user && !username) {
    console.error('Required: --user <userId> or --username <name>');
    process.exit(1);
  }
  if (!event && !eventTitle) {
    console.error('Required: --event <eventId> or --event-title <substring>');
    process.exit(1);
  }
  return {
    user,
    username,
    event,
    eventTitle,
    type,
    country,
    admin1,
    at,
    media,
    captions,
    dryRun,
    yes,
  };
}

function windowState(kickoff: Date, now: Date): 'live' | 'grace' | 'closed' {
  // No early cutoff (owner rule 2026-08-28): posting is open any time up to the
  // live cutoff, so there is no 'before_open' state — an early arrival is live.
  const t = kickoff.getTime();
  if (now.getTime() <= t + LIVE_WINDOW_MS) return 'live';
  if (now.getTime() <= t + GRACE_WINDOW_MS) return 'grace';
  return 'closed';
}

async function main() {
  const args = parseArgs();

  // ── Resolve event ─────────────────────────────────────────────────────────
  const eventSelect = {
    id: true,
    title: true,
    date: true,
    game_id: true,
    latitude: true,
    longitude: true,
    location: true,
  } as const;

  let event;
  if (args.event) {
    event = await prisma.event.findUnique({ where: { id: args.event }, select: eventSelect });
    if (!event) {
      console.error(`❌ Event not found: ${args.event}`);
      process.exit(1);
    }
  } else {
    const matches = await prisma.event.findMany({
      where: { title: { contains: args.eventTitle!, mode: 'insensitive' } },
      select: eventSelect,
      orderBy: { date: 'desc' },
      take: 25,
    });
    if (matches.length === 0) {
      console.error(`❌ No event matched title containing "${args.eventTitle}"`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(
        `❌ Ambiguous --event-title "${args.eventTitle}" — ${matches.length} matches. Re-run with --event <id>:`
      );
      for (const m of matches) {
        console.error(
          `   • ${m.id}  ${new Date(m.date).toISOString()}  "${m.title}"  game_id=${m.game_id ?? 'null'}`
        );
      }
      process.exit(1);
    }
    event = matches[0];
  }
  if (!event.game_id) {
    console.error(
      `❌ Event ${event.id} has no linked game_id. Posting access is keyed on game_id ` +
        `(geofencing.ts + the game/event feed). Link a game to this event first.`
    );
    process.exit(1);
  }

  // ── Resolve user ──────────────────────────────────────────────────────────
  const userSelect = { id: true, display_name: true, username: true, email: true } as const;

  let user;
  if (args.user) {
    user = await prisma.user.findUnique({ where: { id: args.user }, select: userSelect });
    if (!user) {
      console.error(`❌ User not found: ${args.user}`);
      process.exit(1);
    }
  } else {
    const matches = await prisma.user.findMany({
      where: {
        OR: [
          { username: { equals: args.username!, mode: 'insensitive' } },
          { display_name: { equals: args.username!, mode: 'insensitive' } },
        ],
      },
      select: userSelect,
      take: 25,
    });
    if (matches.length === 0) {
      console.error(`❌ No user matched username/display_name "${args.username}"`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(
        `❌ Ambiguous --username "${args.username}" — ${matches.length} matches. Re-run with --user <id>:`
      );
      for (const m of matches) {
        console.error(
          `   • ${m.id}  @${m.username ?? '—'}  "${m.display_name ?? '—'}"  ${m.email ?? ''}`
        );
      }
      process.exit(1);
    }
    user = matches[0];
  }

  // ── Compute the backdated "live" timestamp ────────────────────────────────
  const kickoff = new Date(event.date);
  const liveCutoff = new Date(kickoff.getTime() + LIVE_WINDOW_MS);
  const createdAt = args.at ? new Date(args.at) : new Date(kickoff.getTime() + 30 * 60 * 1000);
  if (Number.isNaN(createdAt.getTime())) {
    console.error(`❌ Invalid --at value: ${args.at}`);
    process.exit(1);
  }
  if (createdAt < kickoff || createdAt > liveCutoff) {
    console.error(
      `❌ created_at ${createdAt.toISOString()} is outside the live window ` +
        `[${kickoff.toISOString()} .. ${liveCutoff.toISOString()}]. ` +
        `A qualifying post MUST be inside the 2h live window or it won't unlock the grace check.`
    );
    process.exit(1);
  }

  const state = windowState(kickoff, new Date());

  // ── Build the post plan ───────────────────────────────────────────────────
  // With media: one post per --media (the photos). Without: a single marker
  // post whose only job is to grant access.
  const plan =
    args.media.length > 0
      ? args.media.map((media_url, i) => ({
          media_url,
          content: args.captions[i] ?? null,
        }))
      : [{ media_url: null as string | null, content: args.captions[0] ?? null }];

  console.log('────────────────────────────────────────────────────────────────');
  console.log('Grant event post access');
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`User    : ${user.display_name ?? user.username ?? user.id} (${user.id})`);
  console.log(`          @${user.username ?? '—'}  ${user.email ?? ''}`);
  console.log(`Event   : ${event.title} (${event.id})`);
  console.log(`Game id : ${event.game_id}`);
  console.log(
    `Venue   : ${event.location ?? '—'}  [${event.latitude ?? '—'}, ${event.longitude ?? '—'}]`
  );
  console.log(`Kickoff : ${kickoff.toISOString()}`);
  console.log(`Backdate: ${createdAt.toISOString()} (inside live window)`);
  console.log(`Window  : currently ${state.toUpperCase()}`);
  if (state === 'closed') {
    console.log(
      '          ⚠️  Window is CLOSED (>48h past kickoff). Seeded posts will show on the\n' +
        '          page, but the app will NOT let this user post NEW photos themselves.\n' +
        '          Re-run this script per batch of marketing photos.'
    );
  } else if (state === 'live' || state === 'grace') {
    console.log(
      '          ✅ After this, the user can post to the page from the app (grace window).'
    );
  }
  console.log(
    `Posts   : ${plan.length} (${args.media.length > 0 ? 'photo upload' : 'access marker'})`
  );
  for (const p of plan) {
    console.log(
      `          • ${p.media_url ?? '(no media — marker)'}${p.content ? `  “${p.content}”` : ''}`
    );
  }
  console.log('────────────────────────────────────────────────────────────────');

  if (args.dryRun || !args.yes) {
    console.log(
      args.dryRun
        ? '[dry-run] No rows written. Re-run with --yes (and without --dry-run) to apply.'
        : '⚠️  Refusing to write without --yes. Re-run with --yes to apply.'
    );
    await prisma.$disconnect();
    return;
  }

  // ── Write (idempotent) ────────────────────────────────────────────────────
  let created = 0;
  let skipped = 0;
  for (const p of plan) {
    // Idempotency: for a photo, key on (author, game, media_url). For the
    // marker, key on any existing qualifying live post for this user+game.
    const existing = p.media_url
      ? await prisma.post.findFirst({
          where: {
            author_id: user.id,
            game_id: event.game_id,
            media_url: p.media_url,
            deleted_at: null,
          },
          select: { id: true },
        })
      : await prisma.post.findFirst({
          where: {
            author_id: user.id,
            game_id: event.game_id,
            deleted_at: null,
            created_at: { gte: kickoff, lte: liveCutoff },
          },
          select: { id: true },
        });

    if (existing) {
      console.log(
        `⏭️  Skip (already present): ${p.media_url ?? 'qualifying marker'} → ${existing.id}`
      );
      skipped++;
      continue;
    }

    const post = await prisma.post.create({
      data: {
        author_id: user.id,
        game_id: event.game_id,
        media_url: p.media_url ?? undefined,
        content: p.content ?? undefined,
        type: args.type,
        created_at: createdAt,
        lat: typeof event.latitude === 'number' ? event.latitude : undefined,
        lng: typeof event.longitude === 'number' ? event.longitude : undefined,
        country_code: args.country ?? undefined,
        admin1: args.admin1 ?? undefined,
      },
      select: { id: true },
    });
    console.log(
      `✅ Created post ${post.id}${p.media_url ? `  ${p.media_url}` : '  (access marker)'}`
    );
    created++;
  }

  console.log('────────────────────────────────────────────────────────────────');
  console.log(`Done. Created ${created}, skipped ${skipped}.`);
  if (state !== 'closed') {
    console.log(`User can now post to "${event.title}" from the app until the 48h window closes.`);
  } else {
    console.log(
      `Posts are live on "${event.title}". App self-posting stays closed (window expired).`
    );
  }
  await prisma.$disconnect();
}

main().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
