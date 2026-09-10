import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CloudinaryUpstreamError,
  getCloudinaryCredentials,
  getCloudinaryFolder,
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../lib/cloudinary.js';
import { createR2UploadTicket, isR2Configured } from '../lib/r2.js';
import { debugLog } from '../lib/debugLog.js';
import { sendError } from '../lib/http/sendError.js';
import { signMediaPath } from '../lib/mediaAccess.js';
import { prisma } from '../lib/prisma.js';
import { addBreadcrumb, captureException } from '../lib/sentry.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { uploadLimiter, uploadStatusLimiter } from '../middleware/rateLimiters.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { completeVideoUpload, openVideoUpload } from '../lib/mediaUploadSession.js';

// Magic byte signatures for file type validation (prevents MIME spoofing)
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF header; WEBP at offset 8
  { mime: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp at offset 4
  { mime: 'video/quicktime', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // same ftyp box
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // EBML header
  { mime: 'video/x-m4v', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // same ftyp box
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

function validateMagicBytes(buffer: Buffer, claimedMime: string): boolean {
  if (!buffer || buffer.length < 12) return false;
  const candidates = MAGIC_BYTES.filter(m => m.mime === claimedMime);
  if (candidates.length === 0) return false; // Unknown type — reject
  return candidates.some(({ bytes, offset = 0 }) =>
    bytes.every((b, i) => buffer[offset + i] === b)
  );
}

// HEIC/HEIF uses ftyp box (same as mp4) with brand 'heic', 'heix', 'mif1'
function isHeicBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const brand = buffer.toString('ascii', 8, 12);
  return ['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand);
}

// File size limits by type (in bytes)
const FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024, // 10MB for images
  video: 100 * 1024 * 1024, // 100MB for videos
  pdf: 25 * 1024 * 1024, // 25MB for PDFs
  document: 25 * 1024 * 1024, // 25MB for general documents
  avatar: 5 * 1024 * 1024, // 5MB for avatars
};

/**
 * Validate file size based on MIME type
 * @returns error string if size exceeds limit, null if valid
 */
function validateFileSizeByType(file: Express.Multer.File): string | null {
  const mime = file.mimetype;
  let limit = FILE_SIZE_LIMITS.document; // default

  if (mime.startsWith('image/')) {
    limit = FILE_SIZE_LIMITS.image;
  } else if (mime.startsWith('video/')) {
    limit = FILE_SIZE_LIMITS.video;
  } else if (mime.includes('pdf')) {
    limit = FILE_SIZE_LIMITS.pdf;
  }

  if (file.size > limit) {
    const limitMB = Math.round(limit / (1024 * 1024));
    const actualMB = Math.round(file.size / (1024 * 1024));
    return `File size (${actualMB}MB) exceeds limit of ${limitMB}MB for this file type`;
  }

  return null;
}

// Force Cloudinary in production, otherwise uploads will be lost on deploy
if (process.env.NODE_ENV === 'production' && !isCloudinaryConfigured()) {
  const errorMessage =
    'CRITICAL: Cloudinary is not configured for production. File uploads will fail. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Railway.';
  console.error(errorMessage);
  throw new Error(errorMessage);
}

// Extend Request type to include multer file
interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

// Save under server/uploads regardless of where the process is started
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Check if Cloudinary is configured
const useCloudinary = isCloudinaryConfigured();

function isAdBannerUploadRequest(req: Request) {
  return (
    String(req.query?.purpose || '')
      .trim()
      .toLowerCase() === 'ad_banner'
  );
}

function getAdBannerUploadId(req: Request) {
  return String(req.query?.ad_id || '').trim();
}

const MUTABLE_AD_UPLOAD_STATUSES = ['draft', 'pending', 'approved', 'active'] as const;

const requireVerifiedUnlessScopedAdBannerUpload = asyncHandler(
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    // Cloudinary signature + direct media upload routes bypass email verification.
    // This mirrors the original requireVerifiedUnlessAdBannerUpload behavior so
    // profile photos, post media, and onboarding uploads work before the user
    // verifies their email. Non-upload routes (e.g. /sign, /files) still require
    // verification via the else branch below.
    const isUploadRoute =
      (req.method === 'GET' &&
        (req.path === '/cloudinary-signature' || req.path === '/r2-presign')) ||
      (req.method === 'POST' &&
        (req.path === '/' ||
          req.path === '/video-sessions' ||
          /^\/video-sessions\/[a-f0-9]{64}\/complete$/.test(req.path)));

    if (!isUploadRoute) {
      return requireVerified(req as any, res, next);
    }

    // For ad-banner uploads, additionally enforce that the caller owns the ad.
    // This prevents unverified users from uploading arbitrary media under an ad ID.
    if (isAdBannerUploadRequest(req)) {
      const adId = getAdBannerUploadId(req);
      if (!adId) {
        return requireVerified(req as any, res, next);
      }
      if (!/^[a-zA-Z0-9_-]{10,50}$/.test(adId)) {
        return res.status(400).json({ error: 'Invalid ad_id' });
      }

      const ad = await prisma.ad.findFirst({
        where: {
          id: adId,
          user_id: req.user?.id,
          status: { in: [...MUTABLE_AD_UPLOAD_STATUSES] },
        },
        select: { id: true },
      });
      if (!ad) {
        return res.status(403).json({ error: 'Ad banner upload requires an ad you own' });
      }
    }

    return next();
  }
);

if (useCloudinary) {
  debugLog('✅ Cloudinary configured - using cloud storage');
} else {
  debugLog('⚠️  Cloudinary not configured - using local disk storage (ephemeral on Railway!)');
}

// Local disk storage (fallback)
const diskStorage = multer.diskStorage({
  destination: (
    _req: Request,
    _file: Express.Multer.File,
    cb: (error: Error | null, destination: string) => void
  ) => cb(null, UPLOAD_DIR),
  filename: (
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, filename: string) => void
  ) => {
    const ext = path.extname(file.originalname) || '';
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

// Choose storage based on configuration. In production, we MUST use memoryStorage for Cloudinary.
const storage = useCloudinary ? multer.memoryStorage() : diskStorage;

// Image/video whitelist — block SVG (image/svg+xml) to prevent XSS; require extension cross-check (M7)
// Include HEIC/HEIF — iPhone default format; create-post.tsx explicitly supports it
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif']);
const IMAGE_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const VIDEO_MIMETYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']);

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit — memory storage, concurrent uploads can OOM at higher limits
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (IMAGE_MIMETYPES.has(file.mimetype) && IMAGE_EXTENSIONS.has(ext)) {
      return cb(null, true);
    }
    if (VIDEO_MIMETYPES.has(file.mimetype) && VIDEO_EXTENSIONS.has(ext)) {
      return cb(null, true);
    }
    return cb(
      new Error(
        'Only image (jpg, png, gif, webp, heic) or video (mp4, mov, webm, m4v) files are allowed'
      )
    );
  },
});

// Allowed file types for general upload (whitelist)
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.m4v',
  '.pdf',
]);
const ALLOWED_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'application/pdf',
]);

const fileUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — memory storage, concurrent uploads can OOM at higher limits
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIMETYPES.has(file.mimetype)) {
      return cb(
        new Error('File type not allowed. Accepted: jpg, png, gif, webp, mp4, mov, webm, m4v, pdf')
      );
    }
    cb(null, true);
  },
});

export const uploadsRouter = Router();

uploadsRouter.post(
  '/video-sessions',
  requireAuth as any,
  requireVerifiedUnlessScopedAdBannerUpload as any,
  uploadLimiter as any,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.json(await openVideoUpload(req.user!.id, req.body || {}));
    } catch (error: any) {
      const status = [400, 409, 410].includes(error?.status) ? error.status : 503;
      if (status === 503) captureException(error, { context: 'media_upload_session' });
      return sendError(
        res,
        status,
        status === 503
          ? 'Upload service unavailable. Please retry.'
          : 'Unable to start this upload. Please select the video again.'
      );
    }
  })
);

uploadsRouter.post(
  '/video-sessions/:id/complete',
  requireAuth as any,
  requireVerifiedUnlessScopedAdBannerUpload as any,
  uploadStatusLimiter as any,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.params.id);
    if (!/^[a-f0-9]{64}$/.test(id)) return sendError(res, 400, 'Invalid upload session');
    try {
      return res.json(await completeVideoUpload(req.user!.id, id));
    } catch (error: any) {
      const status = [404, 409, 410, 422].includes(error?.status) ? error.status : 503;
      if (status === 503) captureException(error, { context: 'media_upload_completion' });
      return sendError(
        res,
        status,
        status === 503
          ? 'Video processing is temporarily unavailable. Please retry.'
          : 'Unable to complete this upload. Please select the video again.'
      );
    }
  })
);

// Add error logging middleware
uploadsRouter.use((req, res, next) => {
  // Log only the request shape — never the full headers map. The headers
  // include Authorization (Bearer token) and Cookie, which would land in
  // logs/Sentry if anyone enables ENABLE_SERVER_DEBUG_LOGS=true in
  // production. content-type alone is enough to debug upload-shape issues.
  debugLog('[uploads] Incoming request:', {
    method: req.method,
    path: req.path,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
  });
  addBreadcrumb('Upload route hit', 'uploads.request', 'info', {
    method: req.method,
    path: req.path,
    content_type: req.headers['content-type'],
  });
  next();
});

// -----------------------------------------------
// GET /uploads/cloudinary-signature
// Returns a signed payload for direct client-to-Cloudinary upload.
// The file never touches this server — goes straight from phone to CDN.
// -----------------------------------------------
uploadsRouter.get(
  '/cloudinary-signature',
  requireAuth as any,
  requireVerifiedUnlessScopedAdBannerUpload as any,
  uploadLimiter as any,
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!useCloudinary) {
      addBreadcrumb('Cloudinary signature unavailable', 'uploads.signature', 'warning', {
        configured: false,
      });
      return sendError(res, 503, 'Uploads are temporarily unavailable. Please try again later.');
    }

    try {
      const { cloudName, apiKey, apiSecret } = getCloudinaryCredentials();
      const folder = getCloudinaryFolder();
      const timestamp = Math.floor(Date.now() / 1000);

      // v1.0.2 audit fix: constrain what Cloudinary accepts on direct-upload. Without these,
      // a signed request lets the client upload any file type (executable, script, etc.).
      // The signature ties these constraints into the request so clients can't weaken them.
      const allowedFormats = 'jpg,jpeg,png,gif,webp,heic,heif,mp4,mov,webm,m4v';
      const maxBytes = '157286400'; // 150 MB — must equal client MAX_VIDEO_SIZE_BYTES (constants/video.ts)
      // IMPORTANT: `max_bytes` is NOT a recognized Cloudinary upload parameter, so
      // Cloudinary strips it from its own signature string. Including it here made
      // our SHA1 diverge from Cloudinary's, producing "Invalid Signature" → HTTP 401
      // on EVERY signed direct upload (videos have no proxy fallback, so the whole
      // video system broke). Verified against prod: signing without max_bytes → 200.
      // Keep `allowed_formats` (a real, signed param that enforces file types) and
      // still RETURN max_bytes below so the client contract is unchanged; just never
      // sign it. Do not re-add max_bytes to this signed set.
      const params: Record<string, string> = {
        folder,
        timestamp: String(timestamp),
        allowed_formats: allowedFormats,
      };
      // Cloudinary requires alphabetically-sorted params for signature
      const toSign = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
      const signature = crypto.createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');

      // Diagnostic: log key fingerprint once per deploy so Railway logs confirm the right credentials are in use
      // Format: first 4 chars of api_key + secret length — safe to log, not reversible
      debugLog(
        `[uploads] Cloudinary signature issued — cloud=${cloudName} key=${apiKey.slice(0, 4)}… secret=[${apiSecret.length}ch]`
      );
      addBreadcrumb('Cloudinary signature issued', 'uploads.signature', 'info', {
        configured: true,
        folder,
      });
      return res.json({
        cloudName,
        apiKey, // Public identifier (not a secret) — required by Cloudinary signed upload SDK
        signature,
        timestamp,
        folder,
        allowed_formats: allowedFormats,
        max_bytes: maxBytes,
      });
    } catch (error: any) {
      console.error('[uploads] Failed to generate Cloudinary signature:', error);
      addBreadcrumb('Cloudinary signature generation failed', 'uploads.signature', 'error');
      captureException(error instanceof Error ? error : new Error(String(error)), {
        context: 'cloudinary_signature_generation_failed',
        provider: 'cloudinary',
        path: _req.path,
      });
      return res.status(500).json({ error: 'Failed to generate upload signature' });
    }
  })
);

uploadsRouter.get(
  '/sign',
  requireAuth as any,
  uploadLimiter as any,
  asyncHandler(async (req: MulterRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawPath = String((req.query as any).path || '').trim();
    if (!rawPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!rawPath.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'path must start with /uploads/' });
    }
    if (rawPath.includes('..')) {
      return res.status(400).json({ error: 'invalid path' });
    }

    try {
      const signed = signMediaPath(rawPath);
      const base = `${req.protocol}://${req.get('host')}`;
      const signedUrl = `${base}${signed.path}?token=${signed.token}&exp=${signed.exp}`;
      addBreadcrumb('Media URL signed', 'uploads.sign', 'info', {
        path: rawPath,
      });
      return res.json({ ...signed, signed_url: signedUrl });
    } catch (error: any) {
      console.error('[uploads] Failed to sign media path:', error);
      addBreadcrumb('Media URL signing failed', 'uploads.sign', 'error', {
        path: rawPath,
      });
      return res.status(500).json({ error: 'Failed to sign media URL' });
    }
  })
);

// -----------------------------------------------
// GET /uploads/r2-presign
// Returns a short-lived presigned PUT URL for a direct-to-R2 upload, mirroring
// the Cloudinary signature flow. DORMANT until R2 env vars are set: without
// them isR2Configured() is false and this returns 503, so the client keeps
// using the Cloudinary path. When live, the client PUTs bytes to `uploadUrl`
// then posts `publicUrl` as the post's media_url.
// -----------------------------------------------
uploadsRouter.get(
  '/r2-presign',
  requireAuth as any,
  requireVerifiedUnlessScopedAdBannerUpload as any,
  uploadLimiter as any,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isR2Configured()) {
      return sendError(res, 503, 'Uploads are temporarily unavailable. Please try again later.');
    }
    const contentType = String((req.query as any).content_type || '')
      .trim()
      .toLowerCase();
    if (!contentType) {
      return res.status(400).json({ error: 'content_type is required' });
    }
    const contentLengthRaw = String((req.query as any).content_length || '').trim();
    const contentLength = Number(contentLengthRaw);
    if (!contentLengthRaw) {
      return sendError(res, 400, 'content_length is required');
    }
    try {
      const ticket = await createR2UploadTicket({ contentType, contentLength });
      if (!ticket) {
        return sendError(res, 503, 'Uploads are temporarily unavailable. Please try again later.');
      }
      addBreadcrumb('R2 presign issued', 'uploads.r2Presign', 'info', { key: ticket.key });
      return res.json(ticket);
    } catch (error: any) {
      // Unsupported content type is a client error; anything else is upstream.
      if (
        /Unsupported content type|content_length|File size exceeds/i.test(String(error?.message))
      ) {
        return sendError(res, 400, 'Invalid file type or size. Please select a supported file.');
      }
      console.error('[uploads] Failed to presign R2 upload:', error);
      captureException(error instanceof Error ? error : new Error(String(error)), {
        context: 'r2_presign_failed',
        provider: 'r2',
      });
      return res.status(500).json({ error: 'Failed to presign upload' });
    }
  })
);

// Original media upload endpoint (images only — video must use direct Cloudinary path).
uploadsRouter.post(
  '/',
  requireAuth as any,
  requireVerifiedUnlessScopedAdBannerUpload as any,
  uploadLimiter as any,
  upload.single('file'),
  asyncHandler(async (req: MulterRequest, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Reject video uploads at the proxy: videos must use direct-to-Cloudinary
    // (GET /uploads/cloudinary-signature + POST directly to Cloudinary CDN).
    // Buffering a video in Railway RAM doubles network cost and puts memory pressure
    // on the server — the signature direct-upload path is always faster.
    if (req.file.mimetype.startsWith('video/')) {
      console.warn(
        `[uploads] Video rejected at proxy — client should use direct Cloudinary path (${req.file.size} bytes, ${req.file.mimetype})`
      );
      addBreadcrumb('Video upload rejected at proxy', 'uploads.media', 'warning', {
        mime: req.file.mimetype,
        size_bytes: req.file.size,
      });
      return res.status(415).json({
        error:
          'Video uploads must use the direct Cloudinary upload path. Fetch a signature from GET /uploads/cloudinary-signature and upload directly to Cloudinary.',
        code: 'USE_DIRECT_UPLOAD',
      });
    }

    addBreadcrumb('Media upload started', 'uploads.media', 'info', {
      mime: req.file.mimetype,
      size_bytes: req.file.size,
    });

    // Validate file size for media uploads
    const sizeError = validateFileSizeByType(req.file);
    if (sizeError) {
      return res.status(413).json({ error: sizeError });
    }

    // Magic byte validation — verify file content matches claimed MIME type
    const fileBuffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
    if (fileBuffer) {
      const mime = req.file.mimetype;
      const isHeic = mime === 'image/heic' || mime === 'image/heif';
      const magicValid = isHeic ? isHeicBuffer(fileBuffer) : validateMagicBytes(fileBuffer, mime);
      if (!magicValid) {
        console.warn(`[uploads] Magic byte mismatch: claimed ${mime}, file rejected`);
        addBreadcrumb('Media upload rejected for magic-byte mismatch', 'uploads.media', 'warning', {
          mime,
        });
        return res
          .status(400)
          .json({ error: 'File content does not match declared type. Upload rejected.' });
      }
    }

    // Enforce Cloudinary in production
    if (process.env.NODE_ENV === 'production' && !useCloudinary) {
      const error = new Error('Server is not configured for file uploads in production.');
      captureException(error);
      return res.status(500).json({ error: 'File upload service is unavailable.' });
    }

    try {
      // Cloudinary response has different structure
      let url: string;
      let type: string;
      let signedUrl: string | undefined;

      if (useCloudinary) {
        const cloudResult = await uploadBufferToCloudinary(req.file, {
          resourceType: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
        });
        url = cloudResult.secure_url || cloudResult.url || '';
        type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

        debugLog('[uploads] Cloudinary upload:', {
          originalname: req.file.originalname,
          cloudinary_url: url,
          mimetype: req.file.mimetype,
          size: req.file.size,
        });
      } else {
        // Local disk file
        const rel = `/uploads/${req.file.filename}`;
        const base = `${req.protocol}://${req.get('host')}`;
        url = `${base}${rel}`;
        type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
        try {
          const signed = signMediaPath(rel);
          signedUrl = `${base}${signed.path}?token=${signed.token}&exp=${signed.exp}`;
        } catch (error) {
          // Without Sentry capture, signing failures sit in stdout invisible
          // to the alerts pipeline. Client falls back to the unsigned `url`,
          // which then 401s on access.
          console.warn('[uploads] Unable to sign media URL:', (error as any)?.message || error);
          captureException(error instanceof Error ? error : new Error(String(error)), {
            context: 'media_url_signing_failed',
            path: req.path,
          });
        }

        if (process.env.NODE_ENV !== 'production') {
          debugLog('[uploads] Local disk upload:', {
            originalname: req.file.originalname,
            filename: req.file.filename,
            mimetype: req.file.mimetype,
            size: req.file.size,
            url,
          });
        }
      }

      addBreadcrumb('Media upload succeeded', 'uploads.media', 'info', {
        storage: useCloudinary ? 'cloudinary' : 'local',
        type,
        mime: req.file.mimetype,
      });
      res.status(201).json({
        url,
        signed_url: signedUrl || undefined,
        type,
        mime: req.file.mimetype,
        size: req.file.size,
        storage: useCloudinary ? 'cloudinary' : 'local',
      });
    } catch (error) {
      addBreadcrumb('Media upload failed', 'uploads.media', 'error', {
        mime: req.file.mimetype,
      });
      captureException(error as Error, { context: 'media_upload_error', path: req.path });
      next(error);
    }
  })
);

// General file upload endpoint (all file types).
uploadsRouter.post(
  '/files',
  requireAuth as any,
  requireVerified as any,
  uploadLimiter as any,
  fileUpload.single('file'),
  asyncHandler(async (req: MulterRequest, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    addBreadcrumb('File upload started', 'uploads.file', 'info', {
      mime: req.file.mimetype,
      size_bytes: req.file.size,
    });

    // Validate file size for general uploads
    const sizeError = validateFileSizeByType(req.file);
    if (sizeError) {
      return res.status(413).json({ error: sizeError });
    }

    // Magic byte validation
    const fileBuf = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
    if (fileBuf) {
      const mime = req.file.mimetype;
      const isHeic = mime === 'image/heic' || mime === 'image/heif';
      const magicValid = isHeic ? isHeicBuffer(fileBuf) : validateMagicBytes(fileBuf, mime);
      if (!magicValid) {
        console.warn(`[uploads] Magic byte mismatch on /files: claimed ${mime}, file rejected`);
        addBreadcrumb('File upload rejected for magic-byte mismatch', 'uploads.file', 'warning', {
          mime,
        });
        return res
          .status(400)
          .json({ error: 'File content does not match declared type. Upload rejected.' });
      }
    }

    try {
      // Cloudinary response has different structure
      let url: string;
      let type: string;
      let signedUrl: string | undefined;

      if (useCloudinary) {
        const cloudResult = await uploadBufferToCloudinary(req.file, { resourceType: 'auto' });
        url = cloudResult.secure_url || cloudResult.url || '';

        // Determine file type based on MIME type
        if (req.file.mimetype.startsWith('image/')) type = 'image';
        else if (req.file.mimetype.startsWith('video/')) type = 'video';
        else if (req.file.mimetype.startsWith('audio/')) type = 'audio';
        else if (req.file.mimetype.includes('pdf')) type = 'pdf';
        else if (req.file.mimetype.includes('zip') || req.file.mimetype.includes('rar'))
          type = 'archive';
        else type = 'document';
      } else {
        // Local disk file
        const rel = `/uploads/${req.file.filename}`;
        const base = `${req.protocol}://${req.get('host')}`;
        url = `${base}${rel}`;
        try {
          const signed = signMediaPath(rel);
          signedUrl = `${base}${signed.path}?token=${signed.token}&exp=${signed.exp}`;
        } catch (error) {
          // Same reasoning as the media-URL signing site above — failure here
          // means client gets the unsigned URL and the access fails silently.
          console.warn('[uploads] Unable to sign file URL:', (error as any)?.message || error);
          captureException(error instanceof Error ? error : new Error(String(error)), {
            context: 'file_url_signing_failed',
            path: req.path,
          });
        }

        // Determine file type based on MIME type
        if (req.file.mimetype.startsWith('image/')) type = 'image';
        else if (req.file.mimetype.startsWith('video/')) type = 'video';
        else if (req.file.mimetype.startsWith('audio/')) type = 'audio';
        else if (req.file.mimetype.includes('pdf')) type = 'pdf';
        else if (req.file.mimetype.includes('zip') || req.file.mimetype.includes('rar'))
          type = 'archive';
        else type = 'document';
      }

      addBreadcrumb('File upload succeeded', 'uploads.file', 'info', {
        storage: useCloudinary ? 'cloudinary' : 'local',
        type,
        mime: req.file.mimetype,
      });
      res.status(201).json({
        url,
        signed_url: signedUrl || undefined,
        type,
        mime: req.file.mimetype,
        size: req.file.size,
        originalName: req.file.originalname,
        storage: useCloudinary ? 'cloudinary' : 'local',
      });
    } catch (error) {
      addBreadcrumb('File upload failed', 'uploads.file', 'error', {
        mime: req.file.mimetype,
      });
      captureException(error as Error, { context: 'file_upload_error', path: req.path });
      next(error);
    }
  })
);

// Avatar upload endpoint (images only, 5MB limit, stricter rate limiting)
const avatarMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const AVATAR_DIR = path.resolve(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// snyk:ignore - endpoint is protected by requireAuth + requireVerified + uploadLimiter middleware
uploadsRouter.post(
  '/avatar',
  requireAuth as any,
  requireVerified as any,
  uploadLimiter as any,
  avatarMemory.single('file'),
  asyncHandler(async (req: MulterRequest, res) => {
    if (!(req as any).user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'Missing file' });
    addBreadcrumb('Avatar upload started', 'uploads.avatar', 'info', {
      mime: req.file.mimetype,
      size_bytes: req.file.size,
    });

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!allowedMimes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Only images are allowed.' });
    }
    const isValidImageContent =
      req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif'
        ? isHeicBuffer(req.file.buffer)
        : validateMagicBytes(req.file.buffer, req.file.mimetype);
    if (!isValidImageContent) {
      return res.status(400).json({
        error: 'Invalid file type: file content does not match the declared image format.',
      });
    }

    try {
      if (useCloudinary) {
        const cloudResult = await uploadBufferToCloudinary(req.file, { resourceType: 'image' });
        const url = cloudResult.secure_url || cloudResult.url || '';
        res.set('Cache-Control', 'no-store, private');
        addBreadcrumb('Avatar upload succeeded', 'uploads.avatar', 'info', {
          storage: 'cloudinary',
        });
        return res.json({ url });
      }
      // Local disk fallback
      const ext = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
      const name = `${(req as any).user.id}_${Date.now()}${ext}`;
      const full = path.join(AVATAR_DIR, name);
      await fs.promises.writeFile(full, req.file.buffer);
      const base = `${req.protocol}://${req.get('host')}`;
      const url = `${base}/uploads/avatars/${name}`;
      res.set('Cache-Control', 'no-store, private');
      addBreadcrumb('Avatar upload succeeded', 'uploads.avatar', 'info', {
        storage: 'local',
      });
      return res.json({ url });
    } catch (e: any) {
      console.error('[uploads] POST /avatar error:', e);
      addBreadcrumb('Avatar upload failed', 'uploads.avatar', 'error');
      captureException(e instanceof Error ? e : new Error(String(e)), {
        context: 'avatar_upload_failed',
        provider: useCloudinary ? 'cloudinary' : 'local-disk',
        path: req.path,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Error handler for multer and other upload errors
uploadsRouter.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[uploads] Error:', {
    message: err.message,
    code: err.code,
    stack: err.stack,
    path: req.path,
  });

  // Capture in Sentry for non-client errors
  const isClientError =
    err.code === 'LIMIT_FILE_SIZE' ||
    err.message?.startsWith('Only image') ||
    err.message?.startsWith('File type not allowed');
  if (!isClientError) {
    captureException(err, { context: 'upload_middleware_error', path: req.path });
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error:
        'File too large. Images up to 25MB upload through the app; videos upload directly and support up to 150MB.',
    });
  }

  if (err.message?.startsWith('Only image') || err.message?.startsWith('File type not allowed')) {
    return sendError(res, 400, 'File type not allowed. Please select a supported image or video.');
  }

  // v1.0.3: Cloudinary (and any upstream provider) errors are infrastructure
  // failures, not the caller's auth problem. Translate an upstream 401 to a
  // 502 so the client never confuses a Cloudinary signature issue with a
  // session-expired state. Log the specific classification so the
  // "Invalid Signature" vs. "Unknown API key" distinction survives to Sentry
  // and the Railway logs.
  if (err instanceof CloudinaryUpstreamError || err?.isUpstreamFailure === true) {
    const kind = (err as CloudinaryUpstreamError).kind ?? 'other';
    console.error(
      `[uploads] Upstream provider failure (cloudinary/${kind}): http_code=${err.http_code} msg="${err.cloudinary_message || err.message}"`
    );
    addBreadcrumb('Upload upstream failure', 'uploads.upstream', 'error', {
      provider: 'cloudinary',
      kind,
      http_code: err.http_code,
    });
    const clientMessage =
      kind === 'invalid_signature' || kind === 'unauthorized'
        ? 'Upload service is misconfigured. Please try again in a minute or contact support.'
        : 'Upload service is temporarily unavailable. Please try again.';
    return res.status(502).json({
      error: clientMessage,
      code: `UPSTREAM_${kind.toUpperCase()}`,
    });
  }

  // Circuit breaker is OPEN — the Cloudinary upload breaker tripped and is failing
  // fast (a transient infra state, not the caller's fault). Without this case the
  // CircuitOpenError fell through to the generic 500 "Upload failed", so a breaker
  // trip during an upstream blip looked like a hard "Server Error" with no retry
  // guidance. Return 503 with the same "temporarily unavailable" wording the
  // client already classifies as retryable (showUploadErrorAlert → "Upload Unavailable").
  if (err?.isCircuitOpen === true || err?.code === 'EOPENBREAKER') {
    console.error(
      `[uploads] Upload breaker open (failing fast): circuit="${err?.circuit || 'cloudinary-upload'}"`
    );
    // Flat { error, code } shape parsed by the client (showUploadErrorAlert),
    // matching the sibling 502 branches above — not the standard sendError envelope.
    return res.status(503).json({
      // error-envelope-exempt
      error: 'Upload service is temporarily unavailable. Please try again in a minute.',
      code: 'UPLOAD_BREAKER_OPEN',
    });
  }

  // Legacy error shape from older call sites that still use plain http_code.
  // Treat a 401/403 from an upload path as upstream failure too — the user's
  // session was already checked by requireAuth before reaching here.
  if (err.http_code === 401 || err.http_code === 403) {
    console.error(
      `[uploads] Legacy upstream auth error: http_code=${err.http_code} msg="${err.message}"`
    );
    return res.status(502).json({
      error: 'Upload service is temporarily unavailable. Please try again.',
      code: 'UPSTREAM_UNAUTHORIZED',
    });
  }
  if (err.http_code) {
    return res.status(err.http_code).json({ error: 'Upload failed' });
  }

  // Generic error
  res.status(500).json({ error: 'Upload failed' });
});
