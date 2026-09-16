const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');

function productionUpdateCommand(runtime, sha) {
  if (!['1.0.5', '1.0.6'].includes(runtime)) throw new Error('Unsupported production runtime');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full committed Git SHA is required');
  // Apply these AFTER EAS loads its environment. Remote environment values
  // must not silently retarget a release that was reviewed for another binary.
  return `RUNTIME_VERSION_OVERRIDE=${runtime} ALLOW_LEGACY_RUNTIME_OTA=${runtime === '1.0.5' ? '1' : '0'} SENTRY_DISABLE_AUTO_UPLOAD= eas update --branch production --non-interactive --message "Release ${sha} runtime ${runtime}" && node node_modules/@sentry/react-native/scripts/expo-upload-sourcemaps dist`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--runtime')) {
    console.error('Usage: npm run update:production -- --runtime 1.0.5|1.0.6');
    process.exit(1);
  }
  const runtime = args[1] || require('../package.json').version;
  const guard = spawnSync(process.execPath, [path.join(__dirname, 'guard-ota-clean-tree.js')], {
    stdio: 'inherit',
  });
  if (guard.status !== 0) process.exit(guard.status || 1);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const command = productionUpdateCommand(runtime, sha);
  const result = spawnSync('eas', ['env:exec', 'production', command, '--non-interactive'], {
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

module.exports = { productionUpdateCommand };
