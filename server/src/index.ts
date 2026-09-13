import { createServer as createHttpServer } from 'node:http';
import { app } from './app.js';
import { initRealtime } from './realtime/socketServer.js';
import { captureException, captureMessage } from './lib/sentry.js';
import { debugLog } from './lib/debugLog.js';
import { initEmailService } from './lib/email.js';
import { initializeQueues, shutdownQueues } from './jobs/queues.js';
import { setupScheduler, startSchedulerWorker, stopSchedulerWorker } from './jobs/scheduler.js';
import { env } from './lib/env.js';
import { APP_REVIEW_EMAIL } from './lib/appReviewFixture.js';
import { ADMIN_EMAILS, ADMIN_NOTIFICATION_EMAILS } from './lib/adminEmails.js';
import { runRouteStartupBackfills } from './startup/routeBackfills.js';
import { runProSportsBootstrap } from './startup/proSportsBootstrap.js';
import { runClusterOnce } from './lib/distributedLock.js';
import {
  getSendGridApiKeyFingerprint,
  isPlaceholderSendGridApiKey,
  isValidSendGridApiKey,
} from './lib/sendgridConfig.js';
const isPlaywrightE2E = process.env.PLAYWRIGHT_E2E === '1';

// Initialize SendGrid email service
await initEmailService();

// v1.0.2: surface admin-email config issues at startup so silent-failures are obvious in logs
{
  const configuredAdminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const adminNotificationEmails = ADMIN_NOTIFICATION_EMAILS;
  if (configuredAdminEmails.length === 0) {
    const msg = `[startup] ⚠️  ADMIN_EMAILS env var is empty — only the App Review demo account (${APP_REVIEW_EMAIL}) will have admin dashboard access`;
    console.warn(msg);
    captureMessage(msg, 'warning');
  } else {
    console.log(
      `[startup] ADMIN_EMAILS configured: ${configuredAdminEmails.length} env recipient(s) + App Review demo access`
    );
  }
  if (ADMIN_EMAILS.length === 0) {
    const msg = '[startup] ⚠️  effective admin access list is empty';
    console.warn(msg);
    captureMessage(msg, 'warning');
  }
  if (adminNotificationEmails.length === 0) {
    const msg =
      '[startup] ⚠️  ADMIN_NOTIFICATION_EMAILS/ADMIN_EMAILS env vars are empty — coach, ad, and league approval notifications will NOT be delivered';
    console.warn(msg);
    captureMessage(msg, 'warning');
  } else {
    console.log(
      `[startup] ADMIN_NOTIFICATION_EMAILS configured: ${adminNotificationEmails.length} recipient(s)`
    );
  }
  if (!env.SENDGRID_API_KEY) {
    const msg =
      '[startup] ⚠️  SENDGRID_API_KEY is missing — all outbound email (verification, invites, admin notifications) will fail silently';
    console.warn(msg);
    captureMessage(msg, 'warning');
  } else {
    const fingerprint = getSendGridApiKeyFingerprint(env.SENDGRID_API_KEY);
    const keyState = isPlaceholderSendGridApiKey(env.SENDGRID_API_KEY)
      ? 'placeholder'
      : isValidSendGridApiKey(env.SENDGRID_API_KEY)
        ? 'valid-looking'
        : 'invalid-looking';
    console.log(`[startup] SENDGRID_API_KEY loaded (${keyState}): ${fingerprint}`);
  }
}

// Log the current coach agreement version so every deploy makes the active value visible.
{
  const agreementVersion = Number(process.env.REQUIRED_COACH_AGREEMENT_VERSION ?? 1);
  console.log(`[startup] REQUIRED_COACH_AGREEMENT_VERSION: ${agreementVersion}`);
}

// v1.0.3: validate SendGrid template ID formats on boot to catch bad GUIDs early.
{
  const templateVars = [
    'SENDGRID_VERIFICATION_TEMPLATE_ID',
    'SENDGRID_USER_CONFIRMATION_TEMPLATE_ID',
    'SENDGRID_PASSWORD_RESET_TEMPLATE_ID',
    'SENDGRID_TEAM_INVITE_TEMPLATE_ID',
    'SENDGRID_ORG_INVITE_TEMPLATE_ID',
    'SENDGRID_JOIN_REQUEST_ADMIN_TEMPLATE_ID',
    'SENDGRID_LEAGUE_PENDING_APPROVAL_TEMPLATE_ID',
    'SENDGRID_JOIN_REQUEST_APPROVED_TEMPLATE_ID',
    'SENDGRID_JOIN_REQUEST_DENIED_TEMPLATE_ID',
    'SENDGRID_EVENT_APPROVED_TEMPLATE_ID',
    'SENDGRID_EVENT_DENIED_TEMPLATE_ID',
    'SENDGRID_EVENT_CANCELED_TEMPLATE_ID',
    'SENDGRID_EVENT_CANCELLATION_TEMPLATE_ID',
    'SENDGRID_PAYMENT_FAILED_TEMPLATE_ID',
    'SENDGRID_AD_PENDING_REVIEW_TEMPLATE_ID',
    'SENDGRID_AD_APPROVED_TEMPLATE_ID',
    'SENDGRID_AD_REJECTED_TEMPLATE_ID',
    'SENDGRID_AD_PAYMENT_CONFIRMED_TEMPLATE_ID',
    'SENDGRID_AD_TAKEN_DOWN_PENDING_REVIEW_TEMPLATE_ID',
    'SENDGRID_ORG_APPROVAL_TEMPLATE_ID',
    'SENDGRID_ORG_DENIAL_TEMPLATE_ID',
    'SENDGRID_ADMIN_ACTION_CONFIRMATION_TEMPLATE_ID',
    'SENDGRID_PARENTAL_CONSENT_REQUEST_TEMPLATE_ID',
  ];
  // SendGrid accepts both compact (d-{32 hex}) and hyphenated (d-{uuid}) forms.
  // The compact form is 34 chars total; hyphenated is 38. Earlier versions of
  // this validator only accepted the hyphenated form, which false-flagged
  // every correctly-configured env value in Railway.
  const compactFormat = /^d-[0-9a-f]{32}$/i;
  const hyphenatedFormat = /^d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const templateIdPattern = {
    test: (v: string) => compactFormat.test(v) || hyphenatedFormat.test(v),
  };
  const invalid: Array<{
    key: string;
    length: number;
    prefix: string;
    startsWithD: boolean;
    hyphens: number;
    issue: string;
  }> = [];

  for (const key of templateVars) {
    const raw = process.env[key];
    if (!raw) continue;
    const value = raw.trim();
    if (templateIdPattern.test(value)) continue;

    // Diagnostic fingerprint — safe to log, doesn't expose the full secret.
    let issue = 'does not match d-{uuid} format (expected d-{32 hex} or d-{8-4-4-4-12 hex})';
    if (!value.startsWith('d-'))
      issue = 'missing d- prefix (legacy V2 template? regenerate as dynamic in SendGrid)';
    else if (value.length !== 34 && value.length !== 38)
      issue = `wrong length (${value.length}, expected 34 compact or 38 hyphenated)`;
    else if (value !== raw) issue = 'contains leading/trailing whitespace in the env value';
    else if (/[^0-9a-f-]/i.test(value.slice(2))) issue = 'contains non-hex characters';

    invalid.push({
      key,
      length: raw.length,
      prefix: raw.slice(0, 4),
      startsWithD: raw.trim().startsWith('d-'),
      hyphens: (raw.match(/-/g) || []).length,
      issue,
    });
  }

  // v1.0.3: log fingerprint of EVERY configured template, not just invalid
  // ones. Lets ops cross-reference each key's prefix with the Railway UI
  // without exposing secrets. Unset vars are listed explicitly so missing
  // config is visible too.
  console.log(`[startup] SendGrid template IDs from Railway env (${templateVars.length} total):`);
  for (const key of templateVars) {
    const raw = process.env[key];
    if (!raw) {
      console.log(`  ⚪ ${key}: not set`);
      continue;
    }
    const trimmed = raw.trim();
    const ok = templateIdPattern.test(trimmed);
    const hasWhitespace = trimmed !== raw;
    const icon = ok && !hasWhitespace ? '✅' : ok && hasWhitespace ? '🟡' : '⚠️';
    const wsNote = hasWhitespace ? ' (paste has whitespace — auto-trimmed by email.ts)' : '';
    console.log(`  ${icon} ${key}: prefix="${trimmed.slice(0, 4)}" len=${trimmed.length}${wsNote}`);
  }

  if (invalid.length > 0) {
    console.warn(
      `[startup] ⚠️  ${invalid.length} of ${templateVars.length} SendGrid template ID(s) failed format check:`
    );
    for (const entry of invalid) {
      console.warn(`    ${entry.key}: ${entry.issue}`);
    }
    captureMessage(
      `Invalid SendGrid template ID format: ${invalid.map(i => i.key).join(', ')}`,
      'warning',
      {
        context: 'sendgrid_template_validation',
        tags: {
          provider: 'sendgrid',
          job: 'startup',
        },
        invalidTemplateKeys: invalid.map(i => i.key),
      }
    );
  } else {
    console.log(`[startup] ✅ All configured SendGrid template IDs pass format check`);
  }
}

// v1.0.3: Cloudinary auth smoke test on boot. Runs a 1x1 PNG probe against
// Cloudinary signed upload, logs the exact outcome to Railway stdout so any
// signature/credential drift is visible within the first 10 seconds of a
// deploy (instead of surfacing only when a user tries an upload).
void (async () => {
  try {
    const {
      isCloudinaryConfigured,
      getCloudinaryCredentials,
      getCloudinaryFolder,
      uploadBufferToCloudinary,
      CloudinaryUpstreamError,
    } = await import('./lib/cloudinary.js');
    if (!isCloudinaryConfigured()) {
      console.warn('[startup] Cloudinary not configured — uploads will fail');
      return;
    }
    const { cloudName, apiKey, apiSecret } = getCloudinaryCredentials();
    const folder = getCloudinaryFolder();
    console.log(
      `[startup] Cloudinary config: cloud=${cloudName} key_prefix=${apiKey.slice(0, 4)}… secret_fingerprint=${apiSecret.slice(0, 3)}…[${apiSecret.length}ch] folder=${folder}`
    );
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );
    await uploadBufferToCloudinary(
      {
        buffer: tinyPng,
        originalname: 'startup-probe.png',
        mimetype: 'image/png',
        size: tinyPng.length,
      } as any,
      { resourceType: 'image' }
    );
    console.log('[startup] ✅ Cloudinary auth probe: OK — signed upload accepted');
  } catch (err: any) {
    const isUpstream = err?.name === 'CloudinaryUpstreamError';
    const kind = isUpstream ? err.kind : 'unknown';
    const httpCode = isUpstream ? err.http_code : undefined;
    const message = err?.message || String(err);
    console.error(
      `[startup] ❌ Cloudinary auth probe FAILED — kind=${kind} http=${httpCode} message="${message}"`
    );
    if (kind === 'invalid_signature') {
      console.error(
        '[startup] HINT: CLOUDINARY_API_SECRET on Railway does not match Cloudinary dashboard. Open Cloudinary → Settings → API Keys → copy API Secret → paste into Railway CLOUDINARY_API_SECRET → save → redeploy.'
      );
    } else if (kind === 'unauthorized') {
      console.error(
        '[startup] HINT: CLOUDINARY_API_KEY on Railway does not match Cloudinary dashboard. Verify it in Cloudinary → Settings → API Keys.'
      );
    }
    captureMessage(`Cloudinary boot probe failed: ${message}`, 'error', {
      context: 'cloudinary_boot_probe',
      tags: {
        provider: 'cloudinary',
        job: 'startup',
      },
      kind,
      httpCode,
    });
  }
})();

// Initialize job queues (async, non-blocking)
initializeQueues().catch(error => {
  console.error('[startup] Failed to initialize queues:', error);
  captureException(error, { context: 'queue_initialization' });
});

// Start scheduler (BullMQ with Redis, falls back to setInterval without it).
// Reconfiguring the repeatable jobs is a remove-all-then-re-add sequence, so it
// must run on only ONE replica (runClusterOnce). Every replica still starts the
// scheduler WORKER so jobs are processed cluster-wide.
void (async () => {
  try {
    await runClusterOnce('scheduler-setup', async () => {
      await setupScheduler();
    });
  } catch (error) {
    console.error('[startup] Scheduler setup failed:', error);
    captureException(error instanceof Error ? error : new Error(String(error)), {
      context: 'scheduler_startup',
    });
  }
  try {
    await startSchedulerWorker();
  } catch (error) {
    console.error('[startup] Scheduler worker failed to start:', error);
    captureException(error instanceof Error ? error : new Error(String(error)), {
      context: 'scheduler_worker_startup',
    });
  }
})();

// Backfills mutate data, so run them on a single replica to avoid concurrent
// double-writes across the cluster.
runClusterOnce('route-startup-backfills', async () => {
  await runRouteStartupBackfills();
}).catch(error => {
  console.error('[startup] Route startup backfills failed:', error);
  captureException(error, { context: 'route_startup_backfills' });
});

// One-time pro-sports data rollout (seed teams + WWE schedule). Self-guarded by
// PRO_SPORTS_BOOTSTRAP=1 and idempotent; single replica to avoid double-writes.
runClusterOnce('pro-sports-bootstrap', async () => {
  await runProSportsBootstrap();
}).catch(error => {
  console.error('[startup] Pro-sports bootstrap failed:', error);
  captureException(error, { context: 'pro_sports_bootstrap' });
});

const PORT = Number(env.PORT || 4000);
// Bind to 0.0.0.0 so the API is reachable from other devices on the LAN (useful for Expo on a phone/emulator)
const HOST: string = env.HOST || '0.0.0.0';

// Graceful shutdown handlers
const shutdown = async (signal: string) => {
  debugLog(`\n[shutdown] Received ${signal}, shutting down gracefully...`);
  try {
    // Stop the scheduler worker before queues/DB close so any in-flight
    // scheduled job drains against a live connection instead of being killed.
    await stopSchedulerWorker();
    await shutdownQueues();
    debugLog('[shutdown] Queues closed');
    // Disconnect Prisma to release DB connection pool slots
    const { prisma } = await import('./lib/prisma.js');
    await prisma.$disconnect();
    debugLog('[shutdown] Database disconnected');
    process.exit(0);
  } catch (error) {
    console.error('[shutdown] Error during shutdown:', error);
    captureException(error as Error, { context: 'graceful_shutdown' });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', error => {
  console.error('[uncaughtException]', error);
  captureException(error, { context: 'uncaught_exception' });
  shutdown('uncaughtException').finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
  captureException(reason as Error, { context: 'unhandled_rejection', promise: String(promise) });
});

// Subscription-expiry reminder emails were intentionally removed; no cron runs for them.

async function runStartupChecks(): Promise<void> {
  const criticalVars: Array<{ key: string; label: string }> = [
    { key: 'REDIS_URL', label: 'REDIS_URL' },
    { key: 'SENDGRID_API_KEY', label: 'SENDGRID_API_KEY' },
    { key: 'STRIPE_WEBHOOK_SECRET', label: 'STRIPE_WEBHOOK_SECRET' },
    { key: 'DATABASE_URL', label: 'DATABASE_URL' },
  ];
  for (const { key, label } of criticalVars) {
    if (!process.env[key]) {
      if (isPlaywrightE2E && (key === 'REDIS_URL' || key === 'SENDGRID_API_KEY')) {
        continue;
      }
      console.error(`[startup] STARTUP: ${label} not configured`);
      captureMessage(`STARTUP: ${label} not configured`, 'error');
    }
  }
  if (!process.env.SENTRY_DSN && !isPlaywrightE2E) {
    console.error('[startup] STARTUP: SENTRY_DSN not configured — error tracking disabled');
  }

  // Ping the database
  try {
    const { prisma } = await import('./lib/prisma.js');
    await prisma.$queryRaw`SELECT 1`;
    debugLog('[startup] Database ping OK');
  } catch (dbErr) {
    console.error('[startup] STARTUP: Database ping failed:', dbErr);
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), {
      context: 'startup_db_ping_failed',
    });
  }

  // Ping Redis if configured (uses the BullMQ queue connection)
  if (process.env.REDIS_URL) {
    try {
      const { default: Redis } = await import('ioredis');
      const RedisCtor = Redis as unknown as new (url: string) => import('ioredis').default;
      const testConn = new RedisCtor(process.env.REDIS_URL);
      await testConn.ping();
      await testConn.quit();
      debugLog('[startup] Redis ping OK');
    } catch (redisErr) {
      console.error('[startup] STARTUP: Redis ping failed:', redisErr);
      captureException(redisErr instanceof Error ? redisErr : new Error(String(redisErr)), {
        context: 'startup_redis_ping_failed',
      });
    }
  }
}

runStartupChecks().catch(err => {
  console.error('[startup] runStartupChecks threw unexpectedly:', err);
});

if (process.env.DEMO_ACCOUNT_PASSWORD || process.env.DEMO_COACH_ACCOUNT_PASSWORD) {
  console.warn(
    '[startup] DEMO_ACCOUNT_PASSWORD / DEMO_COACH_ACCOUNT_PASSWORD are deprecated and ignored. Prepare the App Review account explicitly with `npm --prefix server run prepare:app-review`.'
  );
}

// Export app for testing or external usage
export { app };

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  // Wrap Express in an explicit HTTP server so socket.io (realtime messaging)
  // can attach to the same port. initRealtime is idempotent and no-ops on emit
  // if it was never started.
  const httpServer = createHttpServer(app);
  initRealtime(httpServer);
  httpServer.listen(PORT, HOST, () => {
    debugLog(`API listening on http://${HOST}:${PORT}`);
  });
}
