/**
 * End-to-end verification of the db-backup sync against two REAL local
 * Postgres databases. Seeds the primary with every FK shape that used to
 * break the sync (Sentry 7373289769), runs syncDatabaseBackup() twice, and
 * asserts the backup is complete and the deferred FK columns are back-filled.
 *
 * Usage:
 *   Start a disposable local Redis instance first (or use its Unix socket).
 *   Set VERIFY_REDIS_URL explicitly; ambient REDIS_URL is never used by this drill.
 *   createdb vh_dbbackup_verify_primary
 *   createdb vh_dbbackup_verify_backup
 *   DATABASE_URL="postgresql://$(whoami)@localhost:5432/vh_dbbackup_verify_primary" npx prisma db push --skip-generate
 *   DATABASE_URL="postgresql://$(whoami)@localhost:5432/vh_dbbackup_verify_backup" npx prisma db push --skip-generate
 *   VERIFY_PRIMARY_URL="postgresql://$(whoami)@localhost:5432/vh_dbbackup_verify_primary" \
 *   VERIFY_BACKUP_URL="postgresql://$(whoami)@localhost:5432/vh_dbbackup_verify_backup" \
 *   VERIFY_REDIS_URL="redis://127.0.0.1:6379" \
 *     npx tsx scripts/verify-db-backup-sync.ts
 *
 * DESTRUCTIVE on both databases (seeds the primary, truncates the backup) —
 * refuses to run against anything but localhost.
 */
import { PrismaClient } from '@prisma/client';
import { closeHeartbeatStore } from '../src/lib/schedulerHeartbeat.js';

const PRIMARY = process.env.VERIFY_PRIMARY_URL;
const BACKUP = process.env.VERIFY_BACKUP_URL;
const VERIFY_REDIS = process.env.VERIFY_REDIS_URL;

// The drill now records durable evidence. Require an explicitly selected local
// store before any seed/copy, so an ambient production REDIS_URL is never used.
let localRedis = false;
if (VERIFY_REDIS?.startsWith('/')) {
  localRedis = true; // absolute Unix socket path
} else if (VERIFY_REDIS) {
  try {
    const url = new URL(VERIFY_REDIS);
    localRedis =
      ['redis:', 'rediss:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    // Invalid input receives the same sanitized configuration message below.
  }
}
if (!localRedis || !VERIFY_REDIS) {
  console.error(
    'Set VERIFY_REDIS_URL to an explicit local Redis URL or absolute Unix socket path.'
  );
  process.exit(1);
}
process.env.REDIS_URL = VERIFY_REDIS;

if (!PRIMARY || !BACKUP) {
  console.error('Set VERIFY_PRIMARY_URL and VERIFY_BACKUP_URL (see header comment).');
  process.exit(1);
}
for (const url of [PRIMARY, BACKUP]) {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error(
      `Refusing to run against non-local host "${host}" — this script seeds/truncates.`
    );
    process.exit(1);
  }
}

process.env.DATABASE_URL = PRIMARY;
process.env.DATABASE_BACKUP_URL = BACKUP;

async function seed() {
  const p = new PrismaClient({ datasourceUrl: PRIMARY });
  try {
    // Re-runnable: wipe prior seed data (CASCADE clears every dependent table)
    await p.$executeRawUnsafe('TRUNCATE TABLE "User", "Organization" CASCADE');

    // User <-> Organization cycle: u1.organization_id -> org1, org1.league_owner_id -> u1
    const u1 = await p.user.create({ data: { email: 'u1@test.local', username: 'u1test' } });
    const u2 = await p.user.create({ data: { email: 'u2@test.local', username: 'u2test' } });
    const org1 = await p.organization.create({
      data: { name: 'Verify Org', league_owner_id: u1.id },
    });
    await p.user.update({ where: { id: u1.id }, data: { organization_id: org1.id } });

    const t1 = await p.team.create({
      data: { name: 'Verify Team', organization_id: org1.id },
    });
    // Post -> Game/Event: the exact ordering bug (old list had Post before Game/Event)
    const g1 = await p.game.create({
      data: { title: 'Verify Game', date: new Date(), home_team_id: t1.id },
    });
    const e1 = await p.event.create({
      data: { title: 'Verify Event', date: new Date(), game_id: g1.id, team_id: t1.id },
    });
    const post = await p.post.create({
      data: {
        author_id: u1.id,
        content: 'verify post',
        game_id: g1.id,
        event_id: e1.id,
        team_id: t1.id,
      },
    });
    // Comment self-FK: c2 is a reply to c1
    const c1 = await p.comment.create({
      data: { post_id: post.id, content: 'parent comment', author_id: u1.id },
    });
    const c2 = await p.comment.create({
      data: { post_id: post.id, content: 'reply comment', author_id: u2.id, parent_id: c1.id },
    });
    // The three other tables from the Sentry issue
    await p.postUpvote.create({ data: { post_id: post.id, user_id: u2.id } });
    await p.postBookmark.create({ data: { post_id: post.id, user_id: u2.id } });
    const m1 = await p.message.create({
      data: { sender_id: u1.id, recipient_id: u2.id, content: 'verify message' },
    });
    // Notification -> Post + Comment + Message (old list had Notification before Message)
    await p.notification.create({
      data: {
        user_id: u1.id,
        actor_id: u2.id,
        type: 'COMMENT',
        post_id: post.id,
        comment_id: c2.id,
        message_id: m1.id,
      },
    });
    console.log('[seed] primary seeded');
  } finally {
    await p.$disconnect();
  }
}

async function assertBackup(label: string) {
  const b = new PrismaClient({ datasourceUrl: BACKUP });
  const pr = new PrismaClient({ datasourceUrl: PRIMARY });
  try {
    const failures: string[] = [];
    for (const table of [
      'User',
      'Organization',
      'Team',
      'Game',
      'Event',
      'Post',
      'Comment',
      'PostUpvote',
      'PostBookmark',
      'Message',
      'Notification',
    ]) {
      const [{ count: pc }] = await pr.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) AS count FROM "${table}"`
      );
      const [{ count: bc }] = await b.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) AS count FROM "${table}"`
      );
      if (pc !== bc) failures.push(`${table}: primary=${pc} backup=${bc}`);
    }

    // Deferred columns must be back-filled, not left NULL
    const [reply] = await b.$queryRawUnsafe<Array<{ parent_id: string | null }>>(
      `SELECT parent_id FROM "Comment" WHERE content = 'reply comment'`
    );
    if (!reply?.parent_id) failures.push('Comment.parent_id not back-filled');
    const [user] = await b.$queryRawUnsafe<Array<{ organization_id: string | null }>>(
      `SELECT organization_id FROM "User" WHERE email = 'u1@test.local'`
    );
    if (!user?.organization_id) failures.push('User.organization_id not back-filled');

    if (failures.length > 0) {
      console.error(`[assert:${label}] FAILED:\n  ${failures.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`[assert:${label}] all row counts match; deferred FK columns back-filled`);
    }
  } finally {
    await b.$disconnect();
    await pr.$disconnect();
  }
}

async function main() {
  const { syncDatabaseBackup } = await import('../src/lib/dbBackupSync.js');

  await seed();

  const run1 = await syncDatabaseBackup();
  console.log('[run1]', JSON.stringify(run1));
  if (!run1.success) process.exitCode = 1;
  await assertBackup('run1');

  // Second run: must be idempotent (truncate + full reload) and still complete
  const run2 = await syncDatabaseBackup();
  console.log('[run2]', JSON.stringify(run2));
  if (!run2.success) process.exitCode = 1;
  await assertBackup('run2');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeHeartbeatStore());
