import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const authProviderSource = readFileSync(
  join(process.cwd(), '..', 'context', 'AuthProvider.tsx'),
  'utf8'
);
const gameDetailsSource = readFileSync(
  join(process.cwd(), '..', 'app', 'game-details', 'GameDetailsScreen.tsx'),
  'utf8'
);

describe('session expiry UI guards', () => {
  it('suppresses session-expired toast when already on auth entry screens', () => {
    expect(authProviderSource).toMatch(/const isAuthEntryScreen =/);
    expect(authProviderSource).toMatch(/currentPath === 'sign-in'/);
    expect(authProviderSource).toMatch(/currentPath === 'sign-up'/);
    expect(authProviderSource).toMatch(/if \(userBeforeExpiry && !isAuthEntryScreen\)/);
  });

  it('routes story-upload auth failures through the shared upload-error handler', () => {
    expect(gameDetailsSource).toContain(
      "import { showUploadErrorAlert } from '@/utils/uploadErrorAlert';"
    );
    expect(gameDetailsSource).toContain("showStoryUploadError(err, 'story.upload.photo')");
    expect(gameDetailsSource).toContain("showStoryUploadError(err, 'story.upload.video')");
    const storyErrorHelper = gameDetailsSource.slice(
      gameDetailsSource.indexOf('const showStoryUploadError ='),
      gameDetailsSource.indexOf('const GameDetailsScreen =')
    );
    expect(storyErrorHelper).toMatch(/showUploadErrorAlert\(err,\s*\{[^}]*\blogTag\s*,/);
    expect(gameDetailsSource).not.toContain(
      "Alert.alert('Session expired', 'Please sign in again to upload stories.'"
    );
  });
});
