import { Router } from 'express';
import {
  CloudinaryUpstreamError,
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../lib/cloudinary.js';
import {
  getEmailBaseUrlDiagnostics,
  getMissingEmailTemplates,
  getMissingRecommendedTemplates,
  isSendGridConfigured,
  sendVerificationEmail,
} from '../lib/email.js';
import { getAllPlanDefinitions } from '../lib/planLimits.js';
import { getCircuitStats } from '../lib/circuitBreaker.js';
import { getEmailService } from '../services/email/service.js';
import { isTwilioConfigured } from '../lib/twilio.js';
import { prisma } from '../lib/prisma.js';
import { runDatabaseHealthcheck } from '../lib/healthProbe.js';
import { runEgressProbe } from '../lib/egressProbe.js';
import { getObjectStorageAdapter } from '../lib/objectStorage.js';
import { resolveHealthCheckSecret } from '../lib/healthCheckSecret.js';
import { getSchedulerHeartbeatReport } from '../lib/schedulerHeartbeat.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const healthRouter = Router();
const isDatabaseHealthy = () => runDatabaseHealthcheck(() => prisma.$queryRaw`SELECT 1`);

healthRouter.head('/', (_req, res) => {
  res.status(200).end();
});

/**
 * Health check endpoint
 * GET /health
 *
 * Returns full integration status (booleans only, no secrets).
 * GET /health?include=payments - also returns payments config (fallback when /payments/config 404s)
 */
healthRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    // Only return detailed status if the caller provides the correct secret
    const secret = resolveHealthCheckSecret();
    const provided = String(req.headers['x-health-check-secret'] || '').trim();
    if (!secret || !provided || provided !== secret) {
      // Basic health: verify DB connectivity with a real query. Timestamp is
      // emitted unconditionally — it's non-sensitive and lets external probes
      // distinguish a stale cached 200 from a live response without needing
      // the HEALTH_CHECK_SECRET to do it.
      if (await isDatabaseHealthy()) {
        return res.json({ status: 'ok', timestamp: new Date().toISOString() });
      }
      return res.status(503).json({
        status: 'error',
        message: 'Service unavailable',
        timestamp: new Date().toISOString(),
      });
    }

    const missingEmailTemplates = getMissingEmailTemplates();
    const missingRecommendedTemplates = getMissingRecommendedTemplates();
    const emailBaseUrlDiagnostics = getEmailBaseUrlDiagnostics();
    const emailService = getEmailService();
    const emailServiceReady = emailService.isConfigured() && emailService.validateConfig().valid;
    const sendgridReady =
      isSendGridConfigured() && missingEmailTemplates.length === 0 && emailServiceReady;

    // Check Redis/Queue connectivity
    let redisConnected = false;
    try {
      const { initializeQueues } = await import('../jobs/queues.js');
      const queuesReady = await initializeQueues();
      redisConnected = queuesReady;
    } catch (error) {
      // Redis not available is not a critical error
      redisConnected = false;
    }

    // Data export storage adapter (R2 / S3-compatible). Surfaces whether the
    // four required env vars are present so ops can verify before smoke-testing
    // the GDPR export flow. Matches the `isConfigured()` contract on the adapter.
    const dataExportStorageReady = (() => {
      try {
        return getObjectStorageAdapter().isConfigured();
      } catch {
        return false;
      }
    })();

    const integrations = {
      database: await isDatabaseHealthy(),
      jwt: !!process.env.JWT_SECRET,
      cloudinary: isCloudinaryConfigured(),
      twilio: isTwilioConfigured(),
      stripe: !!process.env.STRIPE_SECRET_KEY,
      sendgrid: sendgridReady,
      googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_IDS,
      googleMaps: !!process.env.GOOGLE_MAPS_API_KEY,
      appleIAP: !!process.env.APPLE_BUNDLE_ID,
      appleIAPLegacyReceipt: !!process.env.APPLE_IAP_SHARED_SECRET,
      sentry: !!process.env.SENTRY_DSN,
      redis: redisConnected,
      dataExportStorage: dataExportStorageReady,
    };

    const allConfigured = Object.entries(integrations)
      .filter(([key]) => !['twilio', 'sentry', 'redis', 'dataExportStorage'].includes(key)) // Optional services
      .every(([, value]) => value);

    const stripePublishableKey =
      process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
    const includePayments = req.query.include === 'payments';
    const body: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      integrations,
      // Circuit breaker snapshot for the outbound upstreams (SendGrid, Cloudinary,
      // google-maps, apple-verify, google-play). An `open: true` entry means that
      // upstream is currently failing fast — surfaced here so external monitors and
      // dashboards can observe degradation without waiting for a Sentry alert.
      circuits: getCircuitStats(),
      ready: allConfigured,
      warnings: [
        ...(!integrations.twilio ? ['Twilio not configured - SMS disabled'] : []),
        ...(!sendgridReady
          ? [
              missingEmailTemplates.length
                ? `SendGrid critical templates missing: ${missingEmailTemplates.join(', ')}`
                : 'SendGrid API key missing - transactional email disabled',
            ]
          : []),
        ...(missingRecommendedTemplates.length
          ? [
              `SendGrid recommended templates missing (non-blocking): ${missingRecommendedTemplates.join(', ')}`,
            ]
          : []),
        ...(!integrations.appleIAP
          ? [
              'APPLE_BUNDLE_ID missing - Apple signed transaction verification will fail for App Review, TestFlight, and live iOS purchases',
            ]
          : []),
        ...(!integrations.appleIAPLegacyReceipt
          ? ['Apple IAP shared secret missing - legacy receipt fallback disabled']
          : []),
        ...(!integrations.sentry ? ['Sentry not configured - error tracking disabled'] : []),
        ...(!integrations.redis
          ? ['Redis not configured - background jobs will use fallback mode']
          : []),
        ...(!integrations.dataExportStorage
          ? [
              'Data export storage not configured - POST /me/data-export will return 503 (set DATA_EXPORT_S3_BUCKET, DATA_EXPORT_S3_REGION, DATA_EXPORT_S3_ACCESS_KEY_ID, DATA_EXPORT_S3_SECRET_ACCESS_KEY)',
            ]
          : []),
      ],
      metadata: {
        missingEmailTemplates,
        missingRecommendedTemplates,
        emailBaseUrlDiagnostics,
      },
    };
    if (includePayments) {
      body.payments_config = {
        stripe_publishable_key: stripePublishableKey,
        available_plans: getAllPlanDefinitions(),
        payments_enabled: true,
        stripe_configured: !!(stripePublishableKey && process.env.STRIPE_SECRET_KEY),
        has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      };
    }
    res.json(body);
  })
);

/**
 * /health/egress — active outbound-connectivity probe.
 *
 * Returns 503 when the server cannot reach ANY third-party host (total egress
 * loss), 200 otherwise. This is the signal an EXTERNAL monitor (UptimeRobot,
 * etc.) should alert on: it calls in over inbound networking (healthy during an
 * egress outage) and pages from its own infra, so it does NOT share the failure
 * mode of Sentry/cron alerts, which ship over the very egress that's down.
 *
 * The 200/503 status + reachable/total summary is public (no secret) so a
 * monitor can watch it with zero secret management; per-target detail (which
 * reveals provider hosts) requires HEALTH_CHECK_SECRET. Targets are hardcoded,
 * so there is no SSRF surface; the /health router is already rate-limited.
 *
 * Usage (monitor): GET /health/egress  → alert when status code is 503
 * Usage (debug):   curl -H "x-health-check-secret: $S" .../health/egress
 */
healthRouter.get(
  '/egress',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { reachable, total, results } = await runEgressProbe();
    const egressDown = reachable === 0;
    const degraded = reachable < total;

    const secret = resolveHealthCheckSecret();
    const provided = String(req.headers['x-health-check-secret'] || '').trim();
    const authorized = !!secret && !!provided && provided === secret;

    res.status(egressDown ? 503 : 200).json({
      status: egressDown ? 'egress_down' : degraded ? 'degraded' : 'ok',
      reachable,
      total,
      // Per-target detail only when authorized — avoids leaking provider/Sentry hosts.
      ...(authorized ? { results } : {}),
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * /health/scheduler — aggregate "did every scheduled job run this cycle" signal.
 *
 * Detects a job that silently STOPS being scheduled — which Sentry failure
 * alerts cannot see (they only fire when a job runs and throws). Each monitored
 * run stamps a per-job lastRunAt; this reports 503 when any enabled job is
 * overdue relative to its own cron cadence, or when the heartbeat store is
 * configured but unreachable (fail-closed). Needs no paid Sentry cron seats.
 *
 * Mirrors /health/egress: the 200/503 status + overdue/total counts are public
 * (a monitor watches the status code with zero secret management); per-job
 * detail requires HEALTH_CHECK_SECRET.
 *
 * Usage (monitor): GET /health/scheduler  → alert when status code is 503
 * Usage (debug):   curl -H "x-health-check-secret: $S" .../health/scheduler
 */
healthRouter.get(
  '/scheduler',
  asyncHandler(async (req: AuthedRequest, res) => {
    const report = await getSchedulerHeartbeatReport();
    const secret = resolveHealthCheckSecret();
    const provided = String(req.headers['x-health-check-secret'] || '').trim();
    const authorized = !!secret && !!provided && provided === secret;

    const storeUnreachable = report.reason?.startsWith('heartbeat store');
    res.status(report.ok ? 200 : 503).json({
      status: report.ok ? 'ok' : storeUnreachable ? 'unverified' : 'stale',
      overdue: report.overdueCount,
      total: report.total,
      // Per-job detail (reveals job names) only when authorized.
      ...(authorized ? { jobs: report.jobs, stale: report.stale, reason: report.reason } : {}),
      timestamp: report.generatedAt,
    });
  })
);

/**
 * v1.0.2 audit addition: /health/email
 * Focused email-system smoke test. Requires HEALTH_CHECK_SECRET to avoid exposing template IDs.
 * Returns 200 if SendGrid is wired up + critical templates present; 503 otherwise.
 * Use for external monitoring (UptimeRobot, etc.) and quick CI checks post-deploy.
 */
healthRouter.get(
  '/email',
  asyncHandler(async (req: AuthedRequest, res) => {
    const secret = resolveHealthCheckSecret();
    const provided = String(req.headers['x-health-check-secret'] || '').trim();
    if (!secret || !provided || provided !== secret) {
      return res.status(401).json({ status: 'unauthorized' });
    }
    const missingEmailTemplates = getMissingEmailTemplates();
    const missingRecommended = getMissingRecommendedTemplates();
    const emailBaseUrlDiagnostics = getEmailBaseUrlDiagnostics();
    const emailService = getEmailService();
    const serviceReady = emailService.isConfigured() && emailService.validateConfig().valid;
    const sendgridOk = isSendGridConfigured();
    const ready = sendgridOk && serviceReady && missingEmailTemplates.length === 0;
    // If ?probe=<email> is provided, send a real verification-style email
    // to test end-to-end deliverability (not just config).
    const probeAddress = req.query.probe as string | undefined;
    if (probeAddress) {
      if (!ready) {
        return res.status(503).json({
          status: 'not_ready',
          message: 'Email service not configured — cannot send probe',
          sendgrid_configured: sendgridOk,
          service_ready: serviceReady,
          missing_critical_templates: missingEmailTemplates,
        });
      }

      // Basic email format check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(probeAddress)) {
        return res.status(400).json({ status: 'invalid_email', probe: probeAddress });
      }

      const probeCode = '000000';
      const startMs = Date.now();
      try {
        const sent = await sendVerificationEmail(probeAddress, probeCode, 'VarsityHub Probe');
        const durationMs = Date.now() - startMs;
        return res.status(sent ? 200 : 502).json({
          status: sent ? 'delivered' : 'rejected',
          probe: probeAddress,
          duration_ms: durationMs,
          message: sent
            ? 'SendGrid accepted the email — check inbox/spam for delivery confirmation'
            : 'sendVerificationEmail returned false — check Railway logs for EMAIL_AUDIT and SendGridProvider errors',
        });
      } catch (error: any) {
        const durationMs = Date.now() - startMs;
        return res.status(502).json({
          status: 'error',
          probe: probeAddress,
          duration_ms: durationMs,
          error: 'Email delivery check failed',
        });
      }
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      sendgrid_configured: sendgridOk,
      service_ready: serviceReady,
      missing_critical_templates: missingEmailTemplates,
      missing_recommended_templates: missingRecommended,
      email_base_urls: emailBaseUrlDiagnostics,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * v1.0.3: /health/cloudinary
 *
 * Verifies Cloudinary signed upload auth end-to-end without requiring a user
 * to trigger an upload. Sends a 1-byte test image through
 * `uploadBufferToCloudinary` — if the signature is valid AND Cloudinary
 * accepts the credentials, it returns 200 with the uploaded URL. If
 * Cloudinary rejects ("Invalid Signature" / "Unknown API key"), it returns
 * 502 with a safe failure summary. Credentials, signatures, and raw provider
 * errors must never be included in a response, even on authenticated probes.
 *
 * Requires HEALTH_CHECK_SECRET. Safe to call from CI or a curl prompt.
 *
 * Usage:
 *   curl -H "x-health-check-secret: $S" \
 *     "https://api-production-xxx.up.railway.app/health/cloudinary"
 */
healthRouter.get(
  '/cloudinary',
  asyncHandler(async (req: AuthedRequest, res) => {
    const secret = resolveHealthCheckSecret();
    const provided = String(req.headers['x-health-check-secret'] || '').trim();
    if (!secret || !provided || provided !== secret) {
      return res.status(401).json({ status: 'unauthorized' });
    }
    if (!isCloudinaryConfigured()) {
      return res.status(503).json({ status: 'not_configured' });
    }

    // A 1x1 red PNG — smallest valid image bytes we can upload to verify
    // the signed-upload pipeline end-to-end.
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );
    const startMs = Date.now();
    try {
      const result = await uploadBufferToCloudinary(
        {
          buffer: tinyPng,
          originalname: 'health-probe.png',
          mimetype: 'image/png',
          size: tinyPng.length,
        } as Express.Multer.File,
        { resourceType: 'image' }
      );
      const durationMs = Date.now() - startMs;
      return res.status(200).json({
        status: 'ok',
        duration_ms: durationMs,
        uploaded_url: result.secure_url || result.url,
        public_id: result.public_id,
      });
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const isUpstream = err instanceof CloudinaryUpstreamError;
      return res.status(502).json({
        status: isUpstream ? 'upstream_rejected' : 'error',
        duration_ms: durationMs,
        error: 'Upload health check failed. Check private server diagnostics.',
      });
    }
  })
);
