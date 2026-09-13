import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { readBackupSyncEvidence, withBackupSyncEvidence } from '../lib/backupSyncEvidence.js';
import { closeHeartbeatStore } from '../lib/schedulerHeartbeat.js';

// Exercise the real atomic Redis transitions, on a disposable Unix socket with
// no TCP listener and no persistence. Never use REDIS_URL from the environment.
const hasRedisServer = spawnSync('redis-server', ['--version']).status === 0;
const originalRedis = process.env.REDIS_URL;
let directory: string;
let server: ChildProcess;
let redis: InstanceType<typeof Redis>;
const primary = 'postgresql://secret-primary@primary.invalid/database';
let nextTarget = 0;
const backup = () => `postgresql://secret-backup@backup.invalid/db${++nextTarget}`;

describe('backup sync evidence (isolated Redis; requires redis-server)', () => {
  beforeAll(async () => {
    if (!hasRedisServer) throw new Error('These integration tests require redis-server on PATH');
    directory = await mkdtemp(join(tmpdir(), 'vh-backup-'));
    const socket = join(directory, 'redis.sock');
    server = spawn('redis-server', [
      '--port',
      '0',
      '--unixsocket',
      socket,
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Test Redis exited: ${code}`)));
      server.stdout!.on('data', chunk => {
        if (String(chunk).toLowerCase().includes('ready to accept connections')) resolve();
      });
    });
    process.env.REDIS_URL = socket;
    redis = new Redis(socket);
    await redis.ping();
  }, 10000);

  afterAll(async () => {
    await closeHeartbeatStore();
    await redis?.quit();
    if (server && server.exitCode === null) {
      const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    if (originalRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedis;
  });

  it('requires durable evidence; equal row counts alone cannot create it', async () => {
    expect(await readBackupSyncEvidence(primary, backup())).toEqual({
      status: 'missing',
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncStartedAt: null,
      successfulRunId: null,
    });
  });

  it('marks running before copy and succeeds only after copy resolves', async () => {
    const target = backup();
    const result = { success: true, rows: 10 };
    const before = Date.now();
    await expect(
      withBackupSyncEvidence(primary, target, async () => {
        expect(await readBackupSyncEvidence(primary, target)).toEqual({
          status: 'running',
          lastSuccessfulSyncAt: null,
          lastSuccessfulSyncStartedAt: null,
          successfulRunId: null,
        });
        return result;
      })
    ).resolves.toBe(result);
    const evidence = await readBackupSyncEvidence(primary, target);
    expect(evidence.status).toBe('succeeded');
    expect(evidence.lastSuccessfulSyncAt).toBeGreaterThanOrEqual(before);
    expect(evidence.lastSuccessfulSyncAt).toBeLessThanOrEqual(Date.now());
    expect(evidence.lastSuccessfulSyncStartedAt).toBeGreaterThanOrEqual(before);
    expect(evidence.lastSuccessfulSyncStartedAt).toBeLessThanOrEqual(
      evidence.lastSuccessfulSyncAt!
    );
    expect(evidence.successfulRunId).toEqual(expect.any(String));
  });

  it.each(['returned failure', 'thrown error'] as const)(
    '%s invalidates a previous success without advancing its time',
    async outcome => {
      const target = backup();
      await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
      const previous = await readBackupSyncEvidence(primary, target);
      const failure = new Error('copy failed');
      const result = { success: false, error: 'partial copy' };
      const run = withBackupSyncEvidence(primary, target, async () => {
        if (outcome === 'thrown error') throw failure;
        return result;
      });
      if (outcome === 'thrown error') await expect(run).rejects.toBe(failure);
      else await expect(run).resolves.toBe(result);
      expect(await readBackupSyncEvidence(primary, target)).toMatchObject({
        status: 'failed',
        lastSuccessfulSyncAt: previous.lastSuccessfulSyncAt,
      });
      await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
      expect((await readBackupSyncEvidence(primary, target)).status).toBe('succeeded');
    }
  );

  it('never calls an overlapping pair healthy, but permits a subsequent clean run', async () => {
    const target = backup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = withBackupSyncEvidence(primary, target, async () => {
      entered();
      await gate;
      return { success: true };
    });
    await started;
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    expect((await readBackupSyncEvidence(primary, target)).status).toBe('running');
    release();
    await first;
    expect(await readBackupSyncEvidence(primary, target)).toEqual({
      status: 'failed',
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncStartedAt: null,
      successfulRunId: null,
    });
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    expect((await readBackupSyncEvidence(primary, target)).status).toBe('succeeded');
  });

  it.each(['credentials', 'primary'] as const)(
    'detects overlapping writers to the same backup after %s changes',
    async changed => {
      const target = backup();
      const nextPrimary = changed === 'primary' ? `${primary}-other` : primary;
      const nextBackup =
        changed === 'credentials' ? target.replace('secret-backup', 'rotated-secret') : target;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const first = withBackupSyncEvidence(primary, target, async () => {
        entered();
        await gate;
        return { success: true };
      });
      await started;
      try {
        await withBackupSyncEvidence(nextPrimary, nextBackup, async () => ({ success: true }));
        expect((await readBackupSyncEvidence(nextPrimary, nextBackup)).status).toBe('running');
      } finally {
        release();
        await first;
      }
      expect((await readBackupSyncEvidence(nextPrimary, nextBackup)).status).toBe('failed');
      await withBackupSyncEvidence(nextPrimary, nextBackup, async () => ({ success: true }));
      expect((await readBackupSyncEvidence(nextPrimary, nextBackup)).status).toBe('succeeded');
      expect((await readBackupSyncEvidence(primary, target)).status).toBe('missing');
    }
  );

  it('does not reuse success when either target changes or expose credentials in keys', async () => {
    const target = backup();
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    expect((await readBackupSyncEvidence(`${primary}-changed`, target)).status).toBe('missing');
    expect((await readBackupSyncEvidence(primary, `${target}-changed`)).status).toBe('missing');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(key => /^backup:sync-evidence:v1:[a-f0-9]{64}$/.test(key))).toBe(true);
    for (const key of keys) expect(await redis.get(key)).not.toMatch(/postgresql|secret-/);
  });

  it('fails closed on malformed stored evidence', async () => {
    const target = backup();
    const before = new Set(await redis.keys('*'));
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    const key = (await redis.keys('*')).find(key => !before.has(key))!;
    await redis.set(key, '{"status":"succeeded","lastSuccessfulSyncAt":"yesterday"}');
    await expect(readBackupSyncEvidence(primary, target)).rejects.toThrow('Backup sync evidence');
  });

  it('does not copy or trust memory when Redis configuration is missing', async () => {
    const target = backup();
    const socket = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    let copied = false;
    try {
      await expect(
        withBackupSyncEvidence(primary, target, async () => {
          copied = true;
          return { success: true };
        })
      ).rejects.toThrow('Backup sync evidence');
      await expect(readBackupSyncEvidence(primary, target)).rejects.toThrow('Backup sync evidence');
      expect(copied).toBe(false);
    } finally {
      process.env.REDIS_URL = socket;
    }
  });

  it.each([
    ['', 'postgresql://backup.invalid/test'],
    [
      'postgresql://user@same.invalid/test',
      'postgres://other@SAME.invalid:5432/test?sslmode=require',
    ],
  ])('rejects missing or same database targets before copying', async (source, target) => {
    let copied = false;
    await expect(
      withBackupSyncEvidence(source, target, async () => {
        copied = true;
        return { success: true };
      })
    ).rejects.toThrow('Backup sync evidence requires');
    expect(copied).toBe(false);
  });

  it('fails closed on read storage errors without exposing connection details', async () => {
    await redis.call('ACL', 'SETUSER', 'default', '-get');
    try {
      await expect(readBackupSyncEvidence(primary, backup())).rejects.toThrow(
        /^Backup sync evidence store unavailable$/
      );
    } finally {
      await redis.call('ACL', 'SETUSER', 'default', '+get');
    }
  });

  it('bounds a stalled Redis read instead of waiting indefinitely', async () => {
    await redis.call('CLIENT', 'PAUSE', '6000', 'ALL');
    try {
      await expect(readBackupSyncEvidence(primary, backup())).rejects.toThrow(
        /^Backup sync evidence store unavailable$/
      );
    } finally {
      await redis.call('CLIENT', 'UNPAUSE');
    }
  }, 15000);

  it('does not begin copying when its initial evidence write fails', async () => {
    await redis.call('ACL', 'SETUSER', 'default', '-eval');
    let copied = false;
    try {
      await expect(
        withBackupSyncEvidence(primary, backup(), async () => {
          copied = true;
          return { success: true };
        })
      ).rejects.toThrow(/^Backup sync evidence store unavailable$/);
      expect(copied).toBe(false);
    } finally {
      await redis.call('ACL', 'SETUSER', 'default', '+eval');
    }
  });

  it('leaves an orphan nonhealthy when success recording fails, including on later runs', async () => {
    const target = backup();
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    const previous = await readBackupSyncEvidence(primary, target);
    try {
      await expect(
        withBackupSyncEvidence(primary, target, async () => {
          await redis.call('ACL', 'SETUSER', 'default', '-eval');
          return { success: true };
        })
      ).rejects.toThrow(/^Backup sync evidence store unavailable$/);
    } finally {
      await redis.call('ACL', 'SETUSER', 'default', '+eval');
    }
    expect(await readBackupSyncEvidence(primary, target)).toEqual({
      ...previous,
      status: 'running',
    });
    await withBackupSyncEvidence(primary, target, async () => ({ success: true }));
    expect(await readBackupSyncEvidence(primary, target)).toEqual({
      ...previous,
      status: 'running',
    });
  });

  it('preserves a copy exception even when recording failure also fails', async () => {
    const target = backup();
    const original = new Error('original copy error');
    try {
      await expect(
        withBackupSyncEvidence(primary, target, async () => {
          await redis.call('ACL', 'SETUSER', 'default', '-eval');
          throw original;
        })
      ).rejects.toBe(original);
    } finally {
      await redis.call('ACL', 'SETUSER', 'default', '+eval');
    }
    expect((await readBackupSyncEvidence(primary, target)).status).toBe('running');
  });
});
