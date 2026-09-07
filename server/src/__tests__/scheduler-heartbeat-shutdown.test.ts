/**
 * Regression: the heartbeat store must not lose the shutdown-race.
 *
 * recordHeartbeat() is called fire-and-forget in runMonitoredJob's finally. If a
 * write lands during/after drain, getRedis() must NOT open a fresh connection
 * (which nothing would close — reintroducing the process-hang the graceful
 * shutdown fix removed). closeHeartbeatStore() must also let in-flight writes
 * settle before quitting.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

let ctorCount = 0;
let quitCalled = false;
let hsetGate: Promise<void> | null = null;

jest.unstable_mockModule('ioredis', () => ({
  default: class {
    constructor() {
      ctorCount++;
    }
    connect = async () => {};
    hset = async () => {
      if (hsetGate) await hsetGate;
    };
    quit = async () => {
      quitCalled = true;
    };
    disconnect = () => {};
  },
}));

const { recordHeartbeat, closeHeartbeatStore } = await import('../lib/schedulerHeartbeat.js');

const originalRedis = process.env.REDIS_URL;
beforeAll(() => {
  process.env.REDIS_URL = 'redis://isolated-test';
});
afterAll(() => {
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});

describe('heartbeat store shutdown-race', () => {
  it('drains in-flight writes, quits once, and never reopens after close', async () => {
    // 1) a normal record opens exactly one connection
    await recordHeartbeat('a', 'ok');
    expect(ctorCount).toBe(1);

    // 2) an in-flight write that hangs until released
    let release!: () => void;
    hsetGate = new Promise<void>(r => {
      release = r;
    });
    const inflight = recordHeartbeat('b', 'ok');

    // close must AWAIT the in-flight write before quitting
    const closed = closeHeartbeatStore();
    expect(quitCalled).toBe(false); // still draining, not quit yet

    release();
    hsetGate = null;
    await Promise.all([inflight, closed]);
    expect(quitCalled).toBe(true); // quit only after the drain

    // 3) THE FIX: a write after close must NOT open a new connection
    await recordHeartbeat('c', 'ok');
    expect(ctorCount).toBe(1); // still 1 — no shutdown-race reopen
  });
});
