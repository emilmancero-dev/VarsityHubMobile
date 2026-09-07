import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';

import { getWellKnownPayload, resolveWellKnownDir } from '../routes/well-known.js';

const repoRoot = path.resolve(process.cwd(), '..');

describe('resolveWellKnownDir', () => {
  it('finds well-known files when the process cwd is the server directory', () => {
    expect(resolveWellKnownDir(process.cwd())).toBe(path.join(process.cwd(), 'well-known'));
  });

  it('finds well-known files when the process cwd is the repo root', () => {
    expect(resolveWellKnownDir(repoRoot)).toBe(path.join(repoRoot, 'server', 'well-known'));
  });

  it('serves built-in fallback payloads when no well-known files exist on disk', () => {
    const emptyDir = path.join(process.cwd(), '__missing_well_known_fixture__');
    const aasa = JSON.parse(getWellKnownPayload('apple-app-site-association', emptyDir));
    const assetLinks = JSON.parse(getWellKnownPayload('assetlinks.json', emptyDir));

    expect(aasa.applinks.details[0].appID).toBe('B5H8F69RW5.com.varsithub.varsityhub-ios');
    expect(aasa.applinks.details[0].paths).toContain('/verify');
    expect(aasa.applinks.details[0].paths).toContain('/verify-email');
    expect(aasa.applinks.details[0].paths).toContain('/reset-password');
    expect(assetLinks[0].target.package_name).toBe('com.varsityhub.varsityhub');
  });

  it('keeps the fallback Android package aligned with the native app config', () => {
    const appConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
    const assetLinks = JSON.parse(getWellKnownPayload('assetlinks.json', '__missing__'));

    expect(assetLinks[0].target.package_name).toBe(appConfig.expo.android.package);
  });

  it('serves the checked-in Android contract aligned with the native app config', () => {
    const appConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
    const assetLinks = JSON.parse(getWellKnownPayload('assetlinks.json'));

    expect(assetLinks[0].target.package_name).toBe(appConfig.expo.android.package);
  });

  it('serves canonical AASA paths even when a stale on-disk file exists', () => {
    const fixtureDir = path.join(process.cwd(), '__stale_well_known_fixture__');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, 'apple-app-site-association'),
      JSON.stringify({
        applinks: { apps: [], details: [{ appID: 'stale', paths: ['/posts/*'] }] },
        webcredentials: { apps: [] },
      })
    );

    const aasa = JSON.parse(getWellKnownPayload('apple-app-site-association', fixtureDir));
    expect(aasa.applinks.details[0].appID).toBe('B5H8F69RW5.com.varsithub.varsityhub-ios');
    expect(aasa.applinks.details[0].paths).toContain('/programs/*');
    expect(aasa.applinks.details[0].paths).toContain('/organizations/*');
    expect(aasa.applinks.details[0].paths).toContain('/verify-email');

    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
});
