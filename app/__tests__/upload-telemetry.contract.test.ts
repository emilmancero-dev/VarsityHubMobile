/**
 * Production video uploads go phone → Cloudinary directly, so the server never
 * sees the failure and client console logs are stripped. Without Sentry in
 * apiclient/upload.ts, video-upload outages are invisible (this is how the max_bytes
 * "Invalid Signature" 401 outage went undiagnosed). These assertions pin the
 * telemetry in place.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const uploadSrc = readFileSync(join(process.cwd(), 'apiclient', 'upload.ts'), 'utf8');
const videoSrc = readFileSync(join(process.cwd(), 'apiclient', 'videoUpload.ts'), 'utf8');

describe('client upload telemetry contract', () => {
  it('apiclient/upload.ts imports captureException from the shared sentry util', () => {
    expect(uploadSrc).toMatch(/import \{ captureException \} from '@\/utils\/sentry'/);
  });

  it('video direct-upload hard failures are reported with context tags', () => {
    // Both public entry points now share one video transport and one error boundary.
    expect(videoSrc).toContain('captureException(');
    expect(videoSrc).toContain("context: 'video_upload'");
    expect(videoSrc).toContain("stage: 'session_transfer_or_processing'");
  });
});
