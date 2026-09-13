import { createHash, randomUUID } from 'node:crypto';
import { readBackupEvidenceRecord, transitionBackupEvidenceRecord } from './schedulerHeartbeat.js';

export interface BackupSyncEvidence {
  status: 'missing' | 'running' | 'failed' | 'succeeded';
  lastSuccessfulSyncAt: number | null;
  lastSuccessfulSyncStartedAt: number | null;
  successfulRunId: string | null;
}

// One atomic transition for a normalized backup endpoint, including writers
// with different source databases or rotated credentials. No expiring lease: a
// crashed attempt remains active, so a later copy cannot erase evidence of a
// possibly still-running writer. An operator must investigate/reset an orphan
// only after stopping all writers. This records helper-reported completion,
// not byte equality, schema parity, or a successful restore drill.
const TRANSITION = `
local raw = redis.call('GET', KEYS[1])
local state
if raw then
  state = cjson.decode(raw)
  assert(state.version == 1 and type(state.active) == 'table', 'invalid evidence')
  assert(type(state.overlap) == 'boolean' and type(state.failed) == 'boolean', 'invalid evidence')
else
  assert(ARGV[2] == 'begin', 'missing attempt')
  state = {version=1, active={}, overlap=false, failed=false,
    status='running', lastSuccessfulSyncAt=cjson.null,
    lastSuccessfulSyncStartedAt=cjson.null, successfulRunId=cjson.null,
    lastSuccessfulConfigFingerprint=cjson.null}
end
local count = 0
for id, attempt in pairs(state.active) do
  assert(type(id) == 'string' and type(attempt) == 'table', 'invalid active attempt')
  assert(type(attempt.startedAt) == 'number' and type(attempt.configFingerprint) == 'string', 'invalid active attempt')
  count = count + 1
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if ARGV[2] == 'begin' then
  assert(state.active[ARGV[1]] == nil, 'duplicate attempt')
  if count == 0 then
    state.overlap = false
    state.failed = false
  else
    state.overlap = true
  end
  state.active[ARGV[1]] = {startedAt=now, configFingerprint=ARGV[3]}
  state.status = 'running'
else
  local attempt = state.active[ARGV[1]]
  assert(attempt ~= nil and attempt.configFingerprint == ARGV[3], 'unknown attempt')
  state.active[ARGV[1]] = nil
  if ARGV[2] ~= 'succeeded' then state.failed = true end
  if count > 1 then
    state.status = 'running'
  elseif state.overlap or state.failed then
    state.status = 'failed'
  else
    state.status = 'succeeded'
    state.lastSuccessfulSyncAt = now
    state.lastSuccessfulSyncStartedAt = attempt.startedAt
    state.successfulRunId = ARGV[1]
    state.lastSuccessfulConfigFingerprint = attempt.configFingerprint
  end
end
redis.call('SET', KEYS[1], cjson.encode(state))
return 1
`;

function targetIdentity(
  primaryUrl: string,
  backupUrl: string
): { key: string; configFingerprint: string } {
  const endpoint = (value: string): string => {
    try {
      const url = new URL(value);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname ||
        !url.pathname.slice(1)
      ) {
        throw new Error('invalid target');
      }
      return JSON.stringify([
        url.hostname.toLowerCase(),
        url.port || '5432',
        decodeURIComponent(url.pathname),
      ]);
    } catch {
      throw new Error('Backup sync evidence requires valid database targets');
    }
  };
  const backupEndpoint = endpoint(backupUrl);
  if (endpoint(primaryUrl) === backupEndpoint) {
    throw new Error('Backup sync evidence requires separate database targets');
  }
  const configFingerprint = createHash('sha256')
    .update(JSON.stringify([primaryUrl, backupUrl]))
    .digest('hex');
  const endpointFingerprint = createHash('sha256').update(backupEndpoint).digest('hex');
  return { key: `backup:sync-evidence:v1:${endpointFingerprint}`, configFingerprint };
}

export async function readBackupSyncEvidence(
  primaryUrl: string,
  backupUrl: string
): Promise<BackupSyncEvidence> {
  const { key, configFingerprint } = targetIdentity(primaryUrl, backupUrl);
  const raw = await readBackupEvidenceRecord(key);
  if (raw === null)
    return {
      status: 'missing',
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncStartedAt: null,
      successfulRunId: null,
    };
  try {
    const state = JSON.parse(raw);
    const { status, lastSuccessfulSyncAt, lastSuccessfulSyncStartedAt, successfulRunId } = state;
    const validTime = (value: unknown) =>
      value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
    const validFingerprint = (value: unknown) =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (
      state.version !== 1 ||
      !['running', 'failed', 'succeeded'].includes(status) ||
      !validTime(lastSuccessfulSyncAt) ||
      !validTime(lastSuccessfulSyncStartedAt) ||
      !(
        successfulRunId === null ||
        (typeof successfulRunId === 'string' && successfulRunId.length > 0)
      ) ||
      !state.active ||
      Array.isArray(state.active) ||
      typeof state.active !== 'object' ||
      typeof state.overlap !== 'boolean' ||
      typeof state.failed !== 'boolean'
    )
      throw new Error('invalid');
    const active = Object.values(state.active) as Array<{
      startedAt: unknown;
      configFingerprint: unknown;
    }>;
    if (
      active.some(
        value =>
          !value ||
          !validTime(value.startedAt) ||
          value.startedAt === null ||
          !validFingerprint(value.configFingerprint)
      ) ||
      (status === 'running') !== active.length > 0 ||
      (lastSuccessfulSyncAt === null) !== (lastSuccessfulSyncStartedAt === null) ||
      (lastSuccessfulSyncAt === null) !== (successfulRunId === null) ||
      (lastSuccessfulSyncAt === null
        ? state.lastSuccessfulConfigFingerprint !== null
        : !validFingerprint(state.lastSuccessfulConfigFingerprint)) ||
      (lastSuccessfulSyncAt !== null && lastSuccessfulSyncStartedAt > lastSuccessfulSyncAt) ||
      (status === 'succeeded' && (lastSuccessfulSyncAt === null || state.overlap || state.failed))
    )
      throw new Error('invalid');
    if (state.lastSuccessfulConfigFingerprint !== configFingerprint) {
      return {
        status: status === 'succeeded' ? 'missing' : status,
        lastSuccessfulSyncAt: null,
        lastSuccessfulSyncStartedAt: null,
        successfulRunId: null,
      };
    }
    return { status, lastSuccessfulSyncAt, lastSuccessfulSyncStartedAt, successfulRunId };
  } catch {
    throw new Error('Backup sync evidence is malformed');
  }
}

export async function withBackupSyncEvidence<T extends { success: boolean }>(
  primaryUrl: string,
  backupUrl: string,
  copy: () => Promise<T>
): Promise<T> {
  const { key, configFingerprint } = targetIdentity(primaryUrl, backupUrl);
  const runId = randomUUID();
  await transitionBackupEvidenceRecord(key, TRANSITION, runId, 'begin', configFingerprint);
  let result: T;
  try {
    result = await copy();
  } catch (error) {
    // Preserve the copy error if failure reporting also fails; the durable
    // running state remains nonhealthy and cannot be overwritten by a later run.
    await transitionBackupEvidenceRecord(key, TRANSITION, runId, 'failed', configFingerprint).catch(
      () => {}
    );
    throw error;
  }
  if (!result.success) {
    await transitionBackupEvidenceRecord(key, TRANSITION, runId, 'failed', configFingerprint).catch(
      () => {}
    );
    return result;
  }
  await transitionBackupEvidenceRecord(key, TRANSITION, runId, 'succeeded', configFingerprint);
  return result;
}
