import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendError } from '../lib/http/sendError.js';
import { Router } from 'express';
import { getCloudinaryCredentials } from '../lib/cloudinary.js';
import {
  applyMediaUploadNotification,
  verifyMediaWebhookSignature,
} from '../lib/mediaUploadWebhook.js';
import { captureException } from '../lib/sentry.js';

export const mediaUploadWebhookRouter = Router();
mediaUploadWebhookRouter.post(
  '/:sessionId',
  asyncHandler(async (req, res) => {
    const id = String(req.params.sessionId);
    if (!/^[a-f0-9]{64}$/.test(id) || !Buffer.isBuffer(req.body))
      return sendError(res, 400, 'Invalid webhook');
    try {
      const { apiSecret } = getCloudinaryCredentials();
      const secret = process.env.CLOUDINARY_WEBHOOK_API_SECRET?.trim() || apiSecret;
      if (
        !verifyMediaWebhookSignature(
          req.body,
          req.get('X-Cld-Timestamp') || '',
          req.get('X-Cld-Signature') || '',
          secret
        )
      ) {
        return sendError(res, 401, 'Invalid signature');
      }
      let data;
      try {
        data = JSON.parse(req.body.toString('utf8'));
      } catch {
        return sendError(res, 400, 'Invalid JSON');
      }
      await applyMediaUploadNotification(id, data);
      return res.status(200).json({ received: true });
    } catch (error) {
      captureException(error instanceof Error ? error : new Error(String(error)), {
        context: 'media_upload_webhook',
      });
      return sendError(res, 503, 'Webhook temporarily unavailable');
    }
  })
);
