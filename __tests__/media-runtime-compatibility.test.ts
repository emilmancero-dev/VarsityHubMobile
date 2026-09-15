const configure = require('../app.config.js');
const version = require('../package.json').version;
const originalApp = process.env.APP_VERSION_OVERRIDE;
const originalRuntime = process.env.RUNTIME_VERSION_OVERRIDE;
const originalLegacyAck = process.env.ALLOW_LEGACY_RUNTIME_OTA;
afterEach(() => {
  if (originalApp === undefined) delete process.env.APP_VERSION_OVERRIDE;
  else process.env.APP_VERSION_OVERRIDE = originalApp;
  if (originalRuntime === undefined) delete process.env.RUNTIME_VERSION_OVERRIDE;
  else process.env.RUNTIME_VERSION_OVERRIDE = originalRuntime;
  if (originalLegacyAck === undefined) delete process.env.ALLOW_LEGACY_RUNTIME_OTA;
  else process.env.ALLOW_LEGACY_RUNTIME_OTA = originalLegacyAck;
});
it('uses the new native runtime by default', () => {
  delete process.env.APP_VERSION_OVERRIDE;
  delete process.env.RUNTIME_VERSION_OVERRIDE;
  expect(configure({ config: {} })).toMatchObject({ version, runtimeVersion: version });
});
it('refuses an accidental runtime override without acknowledgement', () => {
  delete process.env.APP_VERSION_OVERRIDE;
  delete process.env.ALLOW_LEGACY_RUNTIME_OTA;
  process.env.RUNTIME_VERSION_OVERRIDE = '1.0.5';
  expect(() => configure({ config: {} })).toThrow('ALLOW_LEGACY_RUNTIME_OTA=1');
});
it('allows an acknowledged legacy-runtime OTA (video falls back gracefully)', () => {
  delete process.env.APP_VERSION_OVERRIDE;
  process.env.RUNTIME_VERSION_OVERRIDE = '1.0.5';
  process.env.ALLOW_LEGACY_RUNTIME_OTA = '1';
  expect(configure({ config: {} })).toMatchObject({ runtimeVersion: '1.0.5' });
});
