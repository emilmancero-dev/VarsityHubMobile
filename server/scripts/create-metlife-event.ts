/**
 * Create a one-off event: NY & NJ Sports & Entertainment Career Expo at MetLife Stadium.
 *
 * A standalone (non-game) promotional event happening today at 2:00 PM. Mirrors the
 * approach in create-sample-event.ts — inserts an approved Event so it appears in the
 * feed and gets a full event page (stories, polls, RSVP).
 *
 * Usage:
 *   npx tsx scripts/create-metlife-event.ts
 *
 * Requires DATABASE_URL in environment (or .env file).
 * Safe to re-run — skips creation if the event already exists.
 *
 * Banner image: defaults to a MetLife Stadium photo. Override with your own
 * hosted image (e.g. a Cloudinary URL) via the METLIFE_BANNER_URL env var:
 *   METLIFE_BANNER_URL="https://res.cloudinary.com/.../metlife.jpg" \
 *     npx tsx scripts/create-metlife-event.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

// MetLife Stadium banner. Filename-based Wikimedia redirect resolves without a
// hash-prefixed path; swap in your own Cloudinary-hosted asset for production
// reliability via METLIFE_BANNER_URL.
const BANNER_URL =
  process.env.METLIFE_BANNER_URL ||
  'https://commons.wikimedia.org/wiki/Special:FilePath/MetLife_Stadium_(Aug_2014).jpg';

const EVENT = {
  title: 'NY & NJ Sports & Entertainment Career Expo',
  description:
    'Hosted by the NY Jets at MetLife Stadium. Your Upper Level Game Ticket + Career Expo ' +
    'gets you access to employers across sports and entertainment — then stay for the game. ' +
    'Doors and expo floor open at 2:00 PM.',
  event_type: 'other',
  location: 'MetLife Stadium - 1 MetLife Stadium Dr - East Rutherford, NJ 07073',
  hour: 14, // 2:00 PM
  minute: 0,
};

async function main() {
  try {
    // Use the demo account as creator, falling back to the earliest user.
    let creator = await prisma.user.findFirst({
      where: { email: 'demo@varsityhub.app' },
    });
    if (!creator) {
      creator = await prisma.user.findFirst({ orderBy: { created_at: 'asc' } });
    }
    if (!creator) {
      console.error('No users found in database. Run create-demo-account.ts first.');
      process.exit(1);
    }

    console.log(`Using creator: ${creator.email} (${creator.id})\n`);

    // Today at 2:00 PM.
    const eventDate = new Date();
    eventDate.setHours(EVENT.hour, EVENT.minute, 0, 0);

    // Guard against duplicates when re-run: match on title + calendar day.
    const dayStart = new Date(eventDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(eventDate);
    dayEnd.setHours(23, 59, 59, 999);

    const existing = await prisma.event.findFirst({
      where: {
        title: EVENT.title,
        date: { gte: dayStart, lte: dayEnd },
      },
    });
    if (existing) {
      console.log(`Event already exists (ID: ${existing.id}) — nothing to do.`);
      return;
    }

    const event = await prisma.event.create({
      data: {
        title: EVENT.title,
        description: EVENT.description,
        date: eventDate,
        location: EVENT.location,
        event_type: EVENT.event_type,
        banner_url: BANNER_URL,
        creator_id: creator.id,
        approval_status: 'approved',
        status: 'approved',
        approved_at: new Date(),
        creator_role: 'organizer',
      },
    });

    console.log(`✅ Event created: "${EVENT.title}"`);
    console.log(`   Event ID: ${event.id}`);
    console.log(`   Where: ${EVENT.location}`);
    console.log(`   Banner: ${BANNER_URL}`);
    console.log(`   Date: ${eventDate.toLocaleDateString()} at ${eventDate.toLocaleTimeString()}\n`);
    console.log('Done! The event is live and will appear in the feed.');
  } catch (err) {
    console.error('Failed to create MetLife event:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
