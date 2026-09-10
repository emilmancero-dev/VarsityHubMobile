const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
test('native media acquisition does not bridge localized diagnostic text', () => {
  const source = readFileSync(
    'modules/varsity-media-picker/ios/VarsityMediaPickerModule.swift',
    'utf8'
  );
  assert.doesNotMatch(source, /promise\.reject\([^\n]*localizedDescription/);
});
