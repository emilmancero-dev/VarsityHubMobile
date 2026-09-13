#!/usr/bin/env node
/**
 * Post-export step for the web (Vercel) build.
 *
 * Expo's web export writes several runtime assets — most importantly the
 * @expo/vector-icons fonts — under `dist/assets/node_modules/...`. Vercel's
 * uploader silently DROPS any file whose path contains a `node_modules`
 * segment, so those fonts 404 in production and every icon renders blank
 * (owner note, Sep 2026: "icons on web app still don't work").
 *
 * This moves `dist/assets/node_modules/` → `dist/assets/vendor/` and rewrites
 * the references in the exported bundle. It mirrors the relocation already done
 * by scripts/deploy-web-static.sh so the git-integration auto-deploy (which runs
 * this via vercel.json `buildCommand`) produces the same working bundle as a
 * manual deploy. Idempotent and a no-op when there is nothing to move.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const nodeModulesAssets = path.join(dist, 'assets', 'node_modules');
const vendorAssets = path.join(dist, 'assets', 'vendor');

// Text bundles whose asset references must be rewritten. Matches the file types
// scripts/deploy-web-static.sh rewrites.
const REWRITE_EXTS = new Set(['.html', '.js', '.css', '.map']);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  if (!(await exists(nodeModulesAssets))) {
    console.log('[relocate-web-vendor-assets] no dist/assets/node_modules — nothing to do');
    return;
  }

  // Move assets/node_modules -> assets/vendor.
  await fs.cp(nodeModulesAssets, vendorAssets, { recursive: true });
  await fs.rm(nodeModulesAssets, { recursive: true, force: true });

  // Rewrite every `assets/node_modules/` reference (with or without a leading
  // slash) to `assets/vendor/` across the exported text bundles.
  const files = await walk(dist);
  let rewritten = 0;
  for (const file of files) {
    if (!REWRITE_EXTS.has(path.extname(file))) continue;
    const before = await fs.readFile(file, 'utf8');
    if (!before.includes('assets/node_modules/')) continue;
    const after = before.split('assets/node_modules/').join('assets/vendor/');
    if (after !== before) {
      await fs.writeFile(file, after);
      rewritten += 1;
    }
  }

  console.log(
    `[relocate-web-vendor-assets] moved assets/node_modules -> assets/vendor; rewrote ${rewritten} file(s)`
  );
}

main().catch(err => {
  console.error('[relocate-web-vendor-assets] failed:', err);
  process.exit(1);
});
