const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const workflow = name =>
  YAML.parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows', name), 'utf8'));

test('production client publishers require explicit dispatch after backend verification', () => {
  for (const name of ['publish-ota-update.yml', 'publish-ota-1_0_4.yml', 'deploy-web.yml']) {
    const config = workflow(name);
    assert.ok(Object.hasOwn(config.on, 'workflow_dispatch'), name);
    assert.equal(Object.hasOwn(config.on, 'push'), false, `${name} must not race CI/backend`);
  }
});

test('server integration runner installs the Redis executable required by isolated tests', () => {
  const steps = workflow('ci.yml').jobs['server-tests'].steps;
  const install = steps.findIndex(step => /apt-get install[^\n]*redis-server/.test(step.run || ''));
  const run = steps.findIndex(step => step.name === 'Run server tests');
  assert.ok(install >= 0 && install < run);
});

test('OTA workflow uses the same production environment and clean-tree path as local release', () => {
  const config = workflow('publish-ota-update.yml');
  const steps = config.jobs.publish.steps;
  assert.equal(
    steps.find(step => step.name === 'Publish OTA update').run,
    'npm run update:production -- --runtime ${{ inputs.runtime }}'
  );
  assert.deepEqual(config.on.workflow_dispatch.inputs.runtime.options, ['1.0.6', '1.0.5']);
});

test('publishing reapplies explicit runtime after environment loading and supplies a noninteractive message', () => {
  const { productionUpdateCommand } = require('../publish-production-ota.cjs');
  const sha = 'a'.repeat(40);
  for (const runtime of ['1.0.5', '1.0.6']) {
    const command = productionUpdateCommand(runtime, sha);
    assert.ok(
      command.startsWith(
        `RUNTIME_VERSION_OVERRIDE=${runtime} ALLOW_LEGACY_RUNTIME_OTA=${runtime === '1.0.5' ? '1' : '0'} `
      )
    );
    assert.ok(command.includes(`--non-interactive --message "Release ${sha} runtime ${runtime}"`));
    assert.ok(
      command.includes(
        ' && node node_modules/@sentry/react-native/scripts/expo-upload-sourcemaps dist'
      )
    );
  }
  assert.throws(() => productionUpdateCommand('1.0.4', sha));
  assert.throws(() => productionUpdateCommand('1.0.6; exit 0', sha));
  assert.throws(() => productionUpdateCommand('1.0.6', 'uncommitted'));
});
