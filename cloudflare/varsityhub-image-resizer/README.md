# VarsityHub image resizer (Cloudflare Worker)

Fixes slow media viewing. Today the app serves R2 media at full resolution
(measured: a highlight thumbnail is **1.35 MB**), because `optimizeImageUrl`
only resizes Cloudinary URLs and the raw `pub-*.r2.dev` domain has no image
resizing (`/cdn-cgi/image` 404s there). This Worker fronts the R2 bucket and
returns resized WebP on the fly. A 1.35 MB image becomes ~40–80 KB.

## What it does

`GET https://<worker-domain>/<object-key>?w=<width>&q=<quality>`

- Looks the object up in the R2 bucket (same key the app already stores).
- If it's a raster image (`jpeg/png/webp/avif`) and `w` is given, transforms it
  with the Cloudflare **Images binding** to WebP at that width, edge-cached
  immutably.
- Everything else (video, gif, svg) streams through untouched.

## Prerequisites

- **Workers Paid plan** (the Images binding transformations are billed via
  Cloudflare Images; there's a free monthly transformation allotment).
- The R2 bucket that holds the media. Prod object keys look like
  `varsityhub/production/<hash>.jpg`, so the bucket is whatever `R2_BUCKET`
  points at on the server — confirm the exact name in the R2 dashboard.

## Deploy

```bash
cd cloudflare/varsityhub-image-resizer
npm install
# 1) set the real bucket name in wrangler.jsonc (bucket_name: "REPLACE_...")
npm run typecheck
wrangler deploy
```

Then attach a custom domain so the app can point at it:

- Dashboard → Workers & Pages → `varsityhub-image-resizer` → Settings →
  Domains & Routes → **Add Custom Domain** → `media.varsityhub.app`
  (the app's media-host allowlist already permits `*.varsityhub.app`).

Verify:

```bash
# original (full-res) vs resized (should be ~20x smaller)
curl -s -o /dev/null -w "orig=%{size_download}\n" \
  "https://pub-61f12b49067c403ca5f56fa57105b3ed.r2.dev/varsityhub/production/<hash>.jpg"
curl -s -o /dev/null -w "resized=%{size_download} type=%{content_type}\n" \
  "https://media.varsityhub.app/varsityhub/production/<hash>.jpg?w=600"
```

## Turn it on in the app (one line + OTA)

Once the custom domain resolves, set the base in `utils/imageUrl.ts`:

```ts
const R2_IMAGE_RESIZE_BASE = 'https://media.varsityhub.app';
```

Then `eas update --branch production` for both runtimes. `optimizeImageUrl`
already passes a width at every call site (feed cards use 400, banners 1200,
etc.), so every R2 image starts loading resized immediately — no re-upload, no
DB migration (existing `pub-*.r2.dev` URLs are host-rewritten client-side).

Leaving `R2_IMAGE_RESIZE_BASE` empty keeps the app on the current pass-through
behavior, so the client change is safe to ship before this Worker exists.
