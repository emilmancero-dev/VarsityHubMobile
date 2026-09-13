import { captureSchedulerCheckIn } from './sentry.js';
import { recordHeartbeat } from './schedulerHeartbeat.js';

export interface MonitoredJob {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export function schedulerMonitorConfig(job: Pick<MonitoredJob, 'name' | 'cron'>) {
  return {
    schedule: { type: 'crontab' as const, value: job.cron },
    timezone: 'UTC',
    checkinMargin: 5,
    // An alert deadline, not cancellation: financial work must finish atomically.
    maxRuntime: job.name === 'db-backup-sync' ? 120 : 30,
    failure_issue_threshold: 1,
    recovery_threshold: 1,
  };
}

export function schedulerMonitorSlug(name: string) {
  return `varsityhub-${name}`;
}

export function schedulerMonitorEnabled(name: string): boolean {
  return (
    !['db-backup-sync', 'db-backup-freshness-check'].includes(name) ||
    Boolean(process.env.DATABASE_BACKUP_URL)
  );
}

export async function runMonitoredJob(job: MonitoredJob): Promise<void> {
  if (!schedulerMonitorEnabled(job.name)) {
    console.warn(`[Scheduler] ${job.name} monitoring disabled: backup storage not configured`);
    await job.handler();
    return;
  }
  const monitorSlug = schedulerMonitorSlug(job.name);
  const checkInId = captureSchedulerCheckIn(
    { monitorSlug, status: 'in_progress' },
    schedulerMonitorConfig(job)
  );
  const started = performance.now();
  let status: 'ok' | 'error' = 'error';
  try {
    await job.handler();
    status = 'ok';
  } finally {
    // Never invent a completion when the start could not be reported.
    if (checkInId) {
      captureSchedulerCheckIn({
        monitorSlug,
        checkInId,
        status,
        duration: Math.max(0, (performance.now() - started) / 1000),
      });
    }
    // Aggregate heartbeat — stamps that this job actually ran this cycle so
    // /health/scheduler can detect a job that silently stops being scheduled
    // (which failure alerts can't see). Best-effort; never fails the job.
    void recordHeartbeat(job.name, status).catch(() => {});
  }
}
