import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Apple notification receipt status migration', () => {
  it('adds the RECEIVED enum value before the dedup writer can use it', async () => {
    const migration = await readFile(
      join(
        process.cwd(),
        'prisma/migrations/20260907000000_add_received_transaction_status/migration.sql'
      ),
      'utf8'
    );

    expect(migration).toMatch(/ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'RECEIVED'/);
  });
});
