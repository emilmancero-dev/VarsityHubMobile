const configure = require('../app.config.js');
const version = require('../package.json').version;
const originalApp = process.env.APP_VERSION_OVERRIDE;
const originalRuntime = process.env.RUNTIME_VERSION_OVERRIDE;
afterEach(() => {
  if (originalApp === undefined) delete process.env.APP_VERSION_OVERRIDE;
  else process.env.APP_VERSION_OVERRIDE = originalApp;
  if (originalRuntime === undefined) delete process.env.RUNTIME_VERSION_OVERRIDE;
  else process.env.RUNTIME_VERSION_OVERRIDE = originalRuntime;
});
it('uses the new native runtime by default', () => {
  delete process.env.APP_VERSION_OVERRIDE;
  delete process.env.RUNTIME_VERSION_OVERRIDE;
  expect(configure({ config: {} })).toMatchObject({ version, runtimeVersion: version });
});
it('refuses to publish the native-picker bundle to the previous runtime', () => {
  delete process.env.APP_VERSION_OVERRIDE;
  process.env.RUNTIME_VERSION_OVERRIDE = '1.0.5';
  expect(() => configure({ config: {} })).toThrow('native media releases require a matching build');
});
