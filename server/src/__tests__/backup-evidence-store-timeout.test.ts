import { afterAll, describe, expect, it, jest } from '@jest/globals';

let connectStarted!: () => void;
let releaseConnect!: () => void;
let releaseQuit!: () => void;
const started = new Promise<void>(resolve => {
  connectStarted = resolve;
});
const connectGate = new Promise<void>(resolve => {
  releaseConnect = resolve;
});
const quitGate = new Promise<void>(resolve => {
  releaseQuit = resolve;
});
const evalCommand = jest.fn<() => Promise<number>>().mockResolvedValue(1);
jest.unstable_mockModule('ioredis', () => ({
  default: class {
    connect = async () => {
      connectStarted();
      await connectGate;
    };
    eval = evalCommand;
    quit = async () => quitGate;
  },
}));
const { transitionBackupEvidenceRecord, closeHeartbeatStore } =
  await import('../lib/schedulerHeartbeat.js');
const originalRedis = process.env.REDIS_URL;
afterAll(() => {
  jest.useRealTimers();
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});

describe('backup evidence deadline and shutdown', () => {
  it('does not dispatch a timed-out begin when readiness resolves during close', async () => {
    jest.useFakeTimers();
    process.env.REDIS_URL = 'redis://isolated-test';
    const operation = transitionBackupEvidenceRecord(
      'key',
      'script',
      'run',
      'begin',
      'fingerprint'
    );
    const rejected = expect(operation).rejects.toThrow('Backup sync evidence store unavailable');
    await started;
    await jest.advanceTimersByTimeAsync(5000);
    await rejected;
    const closing = closeHeartbeatStore();
    releaseConnect();
    await jest.advanceTimersByTimeAsync(0);
    releaseQuit();
    await closing;
    expect(evalCommand).not.toHaveBeenCalled();
  });
});
