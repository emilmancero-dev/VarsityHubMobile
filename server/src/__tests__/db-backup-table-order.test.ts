import { readFileSync } from 'fs';
import path from 'path';
import {
  TABLES_IN_ORDER,
  DEFERRED_FK_COLUMNS,
  BACKUP_EXCLUDED_TABLES,
} from '../lib/dbBackupTables.js';

/**
 * Guards the DB backup sync's table order against prisma/schema.prisma.
 *
 * The nightly "DB backup sync partially failed" Sentry issue (7373289769) was
 * caused by TABLES_IN_ORDER listing Post before Game/Event: the per-table
 * `TRUNCATE "Game" CASCADE` wiped the already-synced Post table, so every
 * Post child (Comment, PostUpvote, PostBookmark, Notification) failed with FK
 * violation 23503. Five models (CoachApplication, TeamJoinRequest,
 * ParentalConsentAudit, DataExport, AppleTransactionClaim) were also missing
 * from the list entirely, so the backup never contained them.
 *
 * This test parses the schema so any new model or FK immediately fails CI
 * unless TABLES_IN_ORDER (and, for cycles, DEFERRED_FK_COLUMNS) is updated.
 */

type FkEdge = {
  child: string;
  parent: string;
  columns: string[];
  optional: boolean;
};

function parseSchema(): { models: string[]; edges: FkEdge[] } {
  // jest for the server package runs with cwd = <repo>/server (ESM test
  // context — no __dirname available; same approach as validation-parity).
  const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
  const schema = readFileSync(schemaPath, 'utf8');

  const models: string[] = [];
  const edges: FkEdge[] = [];

  const modelBlocks = schema.match(/^model\s+\w+\s+\{[\s\S]*?^\}/gm) ?? [];
  for (const block of modelBlocks) {
    const modelName = /^model\s+(\w+)\s+\{/.exec(block)![1];
    models.push(modelName);

    for (const line of block.split('\n')) {
      // e.g. `game Game? @relation("name", fields: [game_id], references: [id], ...)`
      const rel = /^\s*\w+\s+(\w+)(\?)?\s+.*@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(line);
      if (!rel) continue;
      edges.push({
        child: modelName,
        parent: rel[1],
        columns: rel[3].split(',').map(c => c.trim()),
        optional: rel[2] === '?',
      });
    }
  }
  return { models, edges };
}

const { models, edges } = parseSchema();

describe('db-backup TABLES_IN_ORDER vs prisma/schema.prisma', () => {
  it('parses the schema (sanity: models and FK edges found)', () => {
    expect(models.length).toBeGreaterThan(30);
    expect(edges.length).toBeGreaterThan(50);
    // Known edges that must be present for the ordering assertions to mean anything
    expect(edges).toContainEqual({
      child: 'Post',
      parent: 'Game',
      columns: ['game_id'],
      optional: true,
    });
    expect(edges).toContainEqual({
      child: 'Comment',
      parent: 'Comment',
      columns: ['parent_id'],
      optional: true,
    });
  });

  it('contains every Prisma model exactly once (a missing model is silently absent from the backup)', () => {
    const missing = models.filter(m => !TABLES_IN_ORDER.includes(m));
    expect(missing).toEqual([]);

    const unknown = TABLES_IN_ORDER.filter(t => !models.includes(t));
    expect(unknown).toEqual([]);

    expect(new Set(TABLES_IN_ORDER).size).toBe(TABLES_IN_ORDER.length);
  });

  it('lists every FK parent strictly before its children (or defers the column)', () => {
    const violations: string[] = [];
    for (const edge of edges) {
      const deferred = DEFERRED_FK_COLUMNS[edge.child] ?? [];
      if (edge.columns.every(c => deferred.includes(c))) continue;

      const childIdx = TABLES_IN_ORDER.indexOf(edge.child);
      const parentIdx = TABLES_IN_ORDER.indexOf(edge.parent);
      if (childIdx === -1 || parentIdx === -1) continue; // covered by the completeness test
      if (parentIdx >= childIdx) {
        violations.push(
          `${edge.child}.${edge.columns.join('+')} -> ${edge.parent}: parent at index ${parentIdx} does not precede child at index ${childIdx}`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('defers only real, nullable FK columns (the main pass inserts NULL for them)', () => {
    for (const [table, cols] of Object.entries(DEFERRED_FK_COLUMNS)) {
      for (const col of cols) {
        const edge = edges.find(e => e.child === table && e.columns.includes(col));
        expect(edge).toBeDefined();
        expect(edge!.optional).toBe(true);
      }
    }
  });

  it('defers the FK shapes that no insert order can satisfy (User<->Organization cycle, Comment self-FK)', () => {
    expect(DEFERRED_FK_COLUMNS['User']).toContain('organization_id');
    expect(DEFERRED_FK_COLUMNS['Comment']).toContain('parent_id');
  });

  it('intentionally-excluded tables are never also in the backup order (no contradiction)', () => {
    // A table must not be both "back this up" and "deliberately skip" — that would
    // be self-contradictory and hide the drift alarm. PushTicket is the ephemeral,
    // non-Prisma push-receipt table the runtime alarm flagged (2026-07-09).
    expect([...BACKUP_EXCLUDED_TABLES]).toContain('PushTicket');
    for (const excluded of BACKUP_EXCLUDED_TABLES) {
      expect(TABLES_IN_ORDER).not.toContain(excluded);
    }

    // The newer ad-purchase flow's raw-SQL tables are excluded on purpose:
    // verified 2026-09-14 as empty on primary and absent from the backup
    // replica, so syncing them would fail every INSERT. They are NOT Prisma
    // models (hence not in TABLES_IN_ORDER). See dbBackupTables.ts for the
    // "create on backup + replicate before the flow ships" follow-up.
    for (const t of [
      'AdPurchaseIntent',
      'AdPurchaseIntentItem',
      'AdPurchaseIntentRevision',
      'AdPurchaseReceipt',
      'AdSlotHold',
    ]) {
      expect([...BACKUP_EXCLUDED_TABLES]).toContain(t);
      expect(models).not.toContain(t);
    }
  });
});
