/** Read-only by default. --provision creates/updates monitors immediately before deployment. */
import { SCHEDULED_JOBS } from '../src/jobs/scheduler.js';
import {
  schedulerMonitorConfig,
  schedulerMonitorEnabled,
  schedulerMonitorSlug,
} from '../src/lib/schedulerMonitoring.js';

async function main() {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG || 'lime-productions';
  const project = process.env.SENTRY_PROJECT || 'varsityhub';
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is required for authenticated verification');
  const provision = process.argv.includes('--provision');
  const base = `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/monitors/`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`Sentry ${method} returned HTTP ${response.status}`);
    return response.json();
  }
  let unverified = 0;
  for (const job of SCHEDULED_JOBS) {
    const slug = schedulerMonitorSlug(job.name);
    const enabled = schedulerMonitorEnabled(job.name);
    const config = schedulerMonitorConfig(job);
    const remoteConfig = {
      schedule: config.schedule,
      timezone: config.timezone,
      checkin_margin: config.checkinMargin,
      max_runtime: config.maxRuntime,
      failure_issue_threshold: config.failure_issue_threshold,
      recovery_threshold: config.recovery_threshold,
    };
    let monitor = await request(`${slug}/`);
    if (provision && (enabled || monitor)) {
      const payload = {
        project,
        name: job.name,
        slug,
        status: enabled ? 'active' : 'disabled',
        config: remoteConfig,
      };
      monitor = await request(monitor ? `${slug}/` : '', monitor ? 'PUT' : 'POST', payload);
    }
    if (!enabled) {
      console.log(`${slug}: DISABLED (backup storage unconfigured)`);
      if (monitor && monitor.status !== 'disabled') unverified++;
      continue;
    }
    if (
      !monitor ||
      monitor.status !== 'active' ||
      (monitor.config?.schedule?.value ?? monitor.config?.schedule) !== job.cron ||
      monitor.config?.timezone !== 'UTC' ||
      monitor.config?.checkin_margin !== remoteConfig.checkin_margin ||
      monitor.config?.max_runtime !== remoteConfig.max_runtime
    ) {
      console.log(`${slug}: UNVERIFIED (missing, disabled, or schedule mismatch)`);
      unverified++;
      continue;
    }
    const checkIns = await request(`${slug}/checkins/?environment=production&per_page=1`);
    const last = Array.isArray(checkIns) ? checkIns[0] : undefined;
    const environment = monitor.environments?.find((entry: any) => entry.name === 'production');
    console.log(
      `${slug}: ${last?.status || 'NO CHECK-IN'} ${last?.date_added || last?.dateAdded || ''}; monitor=${environment?.status || 'UNKNOWN'}`
    );
    if (!last || last.status !== 'ok' || environment?.status !== 'ok') unverified++;
  }
  console.log(`Scheduler monitors: ${unverified} unverified/unhealthy; provisioning=${provision}`);
  return unverified ? 1 : 0;
}
// scheduler.ts owns a legacy interval; this one-shot operator command must exit.
main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'Monitor verification failed');
    process.exit(1);
  });
