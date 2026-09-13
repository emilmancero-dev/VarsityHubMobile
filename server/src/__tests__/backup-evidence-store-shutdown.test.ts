import { afterAll, describe, expect, it, jest } from '@jest/globals';

let constructed = 0;
let quit = false;
let release!: () => void;
let entered!: () => void;
const started = new Promise<void>(resolve => {
  entered = resolve;
});
const gate = new Promise<void>(resolve => {
  release = resolve;
});
jest.unstable_mockModule('ioredis', () => ({
  default: class {
    constructor() {
      constructed++;
    }
    connect = async () => {};
    eval = async () => {
      entered();
      await gate;
      return 1;
    };
    quit = async () => {
      quit = true;
    };
  },
}));
const { transitionBackupEvidenceRecord, readBackupEvidenceRecord, closeHeartbeatStore } =
  await import('../lib/schedulerHeartbeat.js');
const originalRedis = process.env.REDIS_URL;
afterAll(() => {
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});

describe('strict backup evidence shares the managed store drain', () => {
  it('drains an active transition and rejects post-close reads/writes without reconnecting', async () => {
    process.env.REDIS_URL = 'redis://isolated-test';
    const transition = transitionBackupEvidenceRecord(
      'key',
      'script',
      'run',
      'begin',
      'fingerprint'
    );
    await started;
    const closing = closeHeartbeatStore();
    expect(quit).toBe(false);
    release();
    await Promise.all([transition, closing]);
    expect(quit).toBe(true);
    await expect(readBackupEvidenceRecord('key')).rejects.toThrow(
      'Backup sync evidence store unavailable'
    );
    await expect(
      transitionBackupEvidenceRecord('key', 'script', 'run', 'succeeded', 'fingerprint')
    ).rejects.toThrow('Backup sync evidence store unavailable');
    expect(constructed).toBe(1);
  });
});
