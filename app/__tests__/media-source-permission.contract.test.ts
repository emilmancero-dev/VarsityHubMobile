import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const story = readFileSync(join(process.cwd(), 'app/game-details/GameDetailsScreen.tsx'), 'utf8');
const chat = readFileSync(join(process.cwd(), 'app/(tabs)/team-contacts.tsx'), 'utf8');

test('story Photos selection does not require broad library or camera permission', () => {
  const captureStart = story.indexOf('const captureStory =');
  const sourceStart = story.indexOf('let result: ImagePicker.ImagePickerResult', captureStart);
  const capture = story.slice(captureStart, sourceStart);
  expect(capture).toContain('requestCameraPermissionsAsync');
  expect(capture).toContain('return launchMediaCameraAsync(pickerOptions)');
  expect(story).not.toContain('requestMediaLibraryPermissionsAsync');
  const source = story.slice(
    sourceStart,
    story.indexOf('const asset = result.assets[0]', sourceStart)
  );
  expect(source).toMatch(/if \(skipGeofence\)/);
  expect(source).toMatch(
    /source === 'library'\s*\? await launchMediaLibraryAsync\(pickerOptions\)\s*: await captureStory\(\)/
  );
});

test('chat video retry retains selection when upload fails', () => {
  const confirmation = chat.slice(
    chat.indexOf('const confirmVideoSend ='),
    chat.indexOf('const getFileColor =')
  );
  expect(confirmation).toMatch(/const sent = await sendFileMessage/);
  expect(confirmation).toMatch(
    /if \(sent\) \{\s*setVideoToTrim\(null\);\s*setVideoTrimmedUri\(null\);/
  );
  expect(confirmation.slice(confirmation.indexOf('} finally {'))).not.toContain('setVideoToTrim');
  const upload = chat.slice(
    chat.indexOf('const sendFileMessage ='),
    chat.indexOf('// Document picking functions')
  );
  expect(upload.slice(upload.indexOf('} catch (error)'))).toContain('return false;');
});
