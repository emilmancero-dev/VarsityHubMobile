import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const IOS_APP_ID = 'B5H8F69RW5.com.varsithub.varsityhub-ios';
const ANDROID_PACKAGE_NAME = 'com.varsityhub.varsityhub';
const IOS_PATHS = [
  '/posts/*',
  '/games/*',
  '/teams/*',
  '/programs/*',
  '/users/*',
  '/events/*',
  '/organizations/*',
  '/join/*',
  '/share',
  '/verify',
  '/verify-email',
  '/reset-password',
  '/settings/manage-subscription',
  '/admin-dashboard',
  '/admin-ads',
  '/event-approvals',
  '/organization',
  '/approvals',
  '/organization-join-requests',
  '/team-hub',
  '/create-fan-event',
  '/event-detail',
  '/payment-success',
  '/payment-cancel',
] as const;
function buildAasaPayload(): string {
  return JSON.stringify({
    applinks: {
      apps: [],
      details: [
        {
          appID: IOS_APP_ID,
          paths: [...IOS_PATHS],
        },
      ],
    },
    webcredentials: {
      apps: [IOS_APP_ID],
    },
  });
}

const FALLBACK_AASA = buildAasaPayload();
const FALLBACK_ASSET_LINKS = JSON.stringify([
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE_NAME,
      sha256_cert_fingerprints: [
        '3bdce8b7d434451b39ff032e9ae938fb1a213cae69e76e0aac1186ccf5194ab4',
      ],
    },
  },
]);

export function resolveWellKnownDir(baseCwd = process.cwd()): string | null {
  const candidates = [
    path.join(baseCwd, 'well-known'),
    path.join(baseCwd, 'server', 'well-known'),
    path.join(baseCwd, 'docs', 'well-known'),
    path.resolve(moduleDir, '..', '..', 'well-known'),
    path.resolve(moduleDir, '..', '..', '..', 'docs', 'well-known'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'apple-app-site-association'))) {
      return candidate;
    }
  }

  return null;
}

export function getWellKnownPayload(
  filename: 'apple-app-site-association' | 'assetlinks.json',
  baseCwd = process.cwd()
): string {
  // AASA is generated from the canonical IOS_PATHS list so stale checked-in
  // copies can never shadow the real universal-link contract in production.
  if (filename === 'apple-app-site-association') {
    return buildAasaPayload();
  }

  const dir = resolveWellKnownDir(baseCwd);
  if (!dir) {
    return FALLBACK_ASSET_LINKS;
  }

  const filePath = path.join(dir, filename);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return FALLBACK_ASSET_LINKS;
  }
}

export const wellKnownRouter = Router();

/**
 * GET /.well-known/apple-app-site-association
 * Serves the AASA file for iOS universal links.
 * Must be application/json, no .json extension in URL.
 */
wellKnownRouter.get('/apple-app-site-association', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(getWellKnownPayload('apple-app-site-association'));
});

/**
 * GET /.well-known/assetlinks.json
 * Serves the asset links file for Android App Links.
 */
wellKnownRouter.get('/assetlinks.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(getWellKnownPayload('assetlinks.json'));
});
