import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const upload = jest.fn<any>();
class UpstreamError extends Error {}
const modules: Record<string, Record<string, unknown>> = {
  '../lib/cloudinary.js': {
    CloudinaryUpstreamError: UpstreamError,
    isCloudinaryConfigured: () => true,
    uploadBufferToCloudinary: upload,
  },
  '../lib/email.js': {
    getEmailBaseUrlDiagnostics: () => ({}),
    getMissingEmailTemplates: () => [],
    getMissingRecommendedTemplates: () => [],
    isSendGridConfigured: () => true,
    sendVerificationEmail: jest.fn(),
  },
  '../lib/planLimits.js': { getAllPlanDefinitions: () => ({}) },
  '../lib/circuitBreaker.js': { getCircuitStats: () => ({}) },
  '../services/email/service.js': { getEmailService: () => ({}) },
  '../lib/twilio.js': { isTwilioConfigured: () => false },
  '../lib/prisma.js': { prisma: {} },
  '../lib/healthProbe.js': { runDatabaseHealthcheck: async () => true },
  '../lib/egressProbe.js': { runEgressProbe: jest.fn() },
  '../lib/objectStorage.js': { getObjectStorageAdapter: () => ({}) },
  '../lib/healthCheckSecret.js': { resolveHealthCheckSecret: () => 'test-health-secret' },
  '../lib/schedulerHeartbeat.js': { getSchedulerHeartbeatReport: jest.fn() },
};
for (const [name, exports] of Object.entries(modules))
  jest.unstable_mockModule(name, () => exports);
const { healthRouter } = await import('../routes/health.js');
const app = express().use('/health', healthRouter);

describe('health probe disclosure boundary', () => {
  beforeEach(() => upload.mockReset());
  it('requires the health secret before probing', async () => {
    await request(app).get('/health/cloudinary').expect(401);
    expect(upload).not.toHaveBeenCalled();
  });
  it('never returns raw provider details or signing diagnostics on failure', async () => {
    upload.mockRejectedValue(new Error('Invalid signature private-value'));
    const response = await request(app)
      .get('/health/cloudinary')
      .set('x-health-check-secret', 'test-health-secret')
      .expect(502);
    expect(response.body).toEqual({
      status: 'error',
      duration_ms: expect.any(Number),
      error: 'Upload health check failed. Check private server diagnostics.',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-value|secret_fingerprint|sample_signature|api_key/
    );
  });
  it('does not return credential fragments on success', async () => {
    upload.mockResolvedValue({ secure_url: 'https://example.com/probe.png', public_id: 'probe' });
    const response = await request(app)
      .get('/health/cloudinary')
      .set('x-health-check-secret', 'test-health-secret')
      .expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body).not.toHaveProperty('secret_fingerprint');
    expect(response.body).not.toHaveProperty('api_key_prefix');
  });
});
