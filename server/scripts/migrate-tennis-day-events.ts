/**
 * Collapse windowed tennis events into ONE event per league per tournament-day.
 *
 * Background: the ESPN tennis adapter used to bucket each day into AM/PM 12-hour
 * windows and bake the date + "12 PM-12 AM" label into the Event title, keyed by
 * pro_external_ref `atp:<id>:<date>:h{0|12}`. Owner decision 2026-09-12: one event
 * per league per day, title "US Open ATP" (no date/time — the client shows the
 * date chip). The adapter change is forward-only; this migrates EXISTING rows.
 *
 * What it does per day-group (rows sharing the base ref, i.e. ref without :hNN):
 *   - picks a KEEPER = the row with the most attached content (designated-poster
 *     grants / unlocks / posts / stories / rsvps / votes), tie-break the later
 *     window (h12 over h0). This guarantees a row carrying @superfan grants keeps
 *     its id (grants + posts survive).
 *   - moves any content off the other rows onto the keeper, then deletes them
 *     (in practice the losers are empty AM/PM duplicates on grant-free days).
 *   - retitles the keeper to drop the trailing "<date> 12 AM/PM-12 AM/PM", and
 *     rewrites its pro_external_ref to the base (drops :hNN).
 *
 * Idempotent: rows already at the base ref with a clean title are left alone.
 * Dry-run by default; pass --apply to write. Node 20 + tsx, DATABASE_URL set.
 */
import { prisma } from '../src/lib/prisma.js';

const WINDOW_TITLE_RE = /\s+\d{4}-\d{2}-\d{2}\s+12 (?:AM|PM)-12 (?:AM|PM)\s*$/;
const apply = process.argv.includes('--apply');

type Row = { id: string; title: string | null; pro_external_ref: string | null };

async function contentTotal(eventId: string): Promise<number> {
  const [dp, ul, po, st, rs, vo] = await Promise.all([
    prisma.eventDesignatedPoster.count({ where: { event_id: eventId } }),
    prisma.eventPostingUnlock.count({ where: { event_id: eventId } }),
    prisma.post.count({ where: { event_id: eventId } }),
    prisma.story.count({ where: { event_id: eventId } }),
    prisma.eventRsvp.count({ where: { event_id: eventId } }),
    prisma.eventVote.count({ where: { event_id: eventId } }),
  ]);
  return dp + ul + po + st + rs + vo;
}

/** Move every event-scoped record off `fromId` onto `toId`, then the caller deletes fromId. */
async function reassignContent(tx: typeof prisma, fromId: string, toId: string) {
  await tx.post.updateMany({ where: { event_id: fromId }, data: { event_id: toId } });
  await tx.story.updateMany({ where: { event_id: fromId }, data: { event_id: toId } });
  for (const r of await tx.eventDesignatedPoster.findMany({ where: { event_id: fromId } })) {
    await tx.eventDesignatedPoster.upsert({
      where: { event_id_user_id: { event_id: toId, user_id: r.user_id } },
      create: { event_id: toId, user_id: r.user_id, created_by: r.created_by },
      update: {},
    });
  }
  await tx.eventDesignatedPoster.deleteMany({ where: { event_id: fromId } });
  for (const r of await tx.eventPostingUnlock.findMany({ where: { event_id: fromId } })) {
    await tx.eventPostingUnlock.upsert({
      where: { user_id_event_id: { user_id: r.user_id, event_id: toId } },
      create: { user_id: r.user_id, event_id: toId, unlocked_at: r.unlocked_at },
      update: {},
    });
  }
  await tx.eventPostingUnlock.deleteMany({ where: { event_id: fromId } });
  for (const r of await tx.eventRsvp.findMany({ where: { event_id: fromId } })) {
    await tx.eventRsvp.upsert({
      where: { event_id_user_id: { event_id: toId, user_id: r.user_id } },
      create: { event_id: toId, user_id: r.user_id, status: r.status },
      update: {},
    });
  }
  await tx.eventRsvp.deleteMany({ where: { event_id: fromId } });
  for (const r of await tx.eventVote.findMany({ where: { event_id: fromId } })) {
    await tx.eventVote.upsert({
      where: { event_id_user_id: { event_id: toId, user_id: r.user_id } },
      create: { event_id: toId, user_id: r.user_id, team: r.team },
      update: {},
    });
  }
  await tx.eventVote.deleteMany({ where: { event_id: fromId } });
}

async function main() {
  const rows = (await prisma.event.findMany({
    where: {
      OR: [
        { pro_external_ref: { startsWith: 'atp:' } },
        { pro_external_ref: { startsWith: 'wta:' } },
      ],
    },
    select: { id: true, title: true, pro_external_ref: true },
    take: 2000,
  })) as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const base = r.pro_external_ref!.replace(/:h\d+$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(r);
  }

  let converted = 0;
  let deleted = 0;
  let skipped = 0;

  for (const [base, group] of groups) {
    // Rank each row by attached content; keeper = most content, tie-break later window.
    const windowHour = (r: Row) => {
      const m = /:h(\d+)$/.exec(r.pro_external_ref ?? '');
      return m ? Number(m[1]) : -1; // base-ref rows (already migrated) sort last as -1
    };
    const enriched = await Promise.all(
      group.map(async r => ({ r, content: await contentTotal(r.id) }))
    );
    enriched.sort((a, b) => b.content - a.content || windowHour(b.r) - windowHour(a.r));
    const keeper = enriched[0].r;
    const losers = enriched.slice(1).map(e => e.r);

    const newTitle = (keeper.title ?? '').replace(WINDOW_TITLE_RE, '');
    const titleChanges = newTitle !== (keeper.title ?? '');
    const refChanges = keeper.pro_external_ref !== base;

    if (!titleChanges && !refChanges && losers.length === 0) {
      skipped++;
      continue;
    }

    console.log(`\n${base}  (${group.length} row${group.length > 1 ? 's' : ''})`);
    console.log(`  KEEP  ${keeper.id}  ref ${keeper.pro_external_ref} -> ${base}`);
    console.log(`        title "${keeper.title}" -> "${newTitle}"`);
    for (const l of losers) {
      const c = enriched.find(e => e.r.id === l.id)!.content;
      console.log(
        `  MERGE+DELETE ${l.id}  ref ${l.pro_external_ref}  (content=${c}${c > 0 ? ' — will be reassigned to keeper' : ''})`
      );
    }

    if (!apply) continue;

    // Sequential (not one interactive transaction): the remote public-proxy DB is
    // slow enough to blow Prisma's 5s interactive-tx cap, and this is idempotent —
    // reassign-before-delete means a re-run of an interrupted group still finishes
    // safely (an already-emptied loser is simply deleted). Losers are empty in
    // practice, so no content actually moves.
    for (const l of losers) {
      await reassignContent(prisma, l.id, keeper.id);
      await prisma.event.delete({ where: { id: l.id } });
      deleted++;
    }
    if (titleChanges || refChanges) {
      await prisma.event.update({
        where: { id: keeper.id },
        data: { pro_external_ref: base, title: newTitle },
      });
    }
    converted++;
  }

  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN'}: day-groups=${groups.size}  keepers-converted=${converted}  losers-deleted=${deleted}  already-clean(skipped)=${skipped}`
  );
  if (!apply) console.log('Re-run with --apply to commit.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
