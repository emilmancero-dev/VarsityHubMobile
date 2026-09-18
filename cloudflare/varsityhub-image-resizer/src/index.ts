/**
 * VarsityHub image-resizing Worker.
 *
 * Fronts the R2 media bucket and returns on-the-fly resized/re-encoded images,
 * so the app stops downloading full-resolution (~1.3 MB) originals into small
 * cards. Non-image objects (video, gif, svg) pass through untouched.
 *
 * Request shape (served from the Worker's custom domain, e.g. media.varsityhub.app):
 *   GET /<object-key>?w=<width>&q=<quality>
 *   e.g. /varsityhub/production/<hash>.jpg?w=600
 *
 * The object key is the SAME path R2 already uses, so existing DB URLs only need
 * their host swapped (done client-side in utils/imageUrl.ts). No re-upload, no
 * DB migration.
 */

interface Env {
  // R2 bucket binding (set bucket_name in wrangler.jsonc to the real bucket).
  BUCKET: R2Bucket;
  // Cloudflare Images binding — transforms without needing a public URL.
  IMAGES: ImagesBinding;
}

const MAX_WIDTH = 2000;
const MIN_WIDTH = 16;
const DEFAULT_QUALITY = 80;
// Only raster formats are worth (and safe) to transcode. Everything else
// (svg, gif, video/*) is streamed back as-is.
const TRANSFORMABLE = /^image\/(jpeg|png|webp|avif)$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    // Edge cache: keyed on the full URL (key + params), so each size is cached.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!key) return new Response('Not found', { status: 404 });

    const object = await env.BUCKET.get(key);
    if (!object || !object.body) return new Response('Not found', { status: 404 });

    const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
    const widthParam = Number.parseInt(url.searchParams.get('w') ?? '', 10);
    const width = Number.isFinite(widthParam)
      ? Math.min(Math.max(widthParam, MIN_WIDTH), MAX_WIDTH)
      : null;
    const shouldTransform = width !== null && TRANSFORMABLE.test(contentType);

    let response: Response;
    if (shouldTransform) {
      const qParam = Number.parseInt(url.searchParams.get('q') ?? '', 10);
      const quality = Number.isFinite(qParam)
        ? Math.min(Math.max(qParam, 1), 100)
        : DEFAULT_QUALITY;
      const result = await env.IMAGES.input(object.body)
        .transform({ width: width! })
        .output({ format: 'image/webp', quality });
      const imgResp = result.response();
      response = new Response(imgResp.body, imgResp);
      response.headers.set('Content-Type', 'image/webp');
    } else {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      response = new Response(object.body, { headers });
    }

    // Immutable: object keys are content-hashed, so a given key never changes.
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    response.headers.set('Access-Control-Allow-Origin', '*');
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
