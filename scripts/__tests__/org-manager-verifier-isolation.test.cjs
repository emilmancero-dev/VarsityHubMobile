const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

test(
  'org-manager verifier refuses an occupied port without contacting another API',
  { timeout: 30000 },
  async () => {
    const requests = [];
    const otherApi = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'test-only-token', user: { id: 'nonexistent-test-id' } })
      );
    });
    await new Promise(resolve => otherApi.listen(0, '127.0.0.1', resolve));
    const port = otherApi.address().port;
    try {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/verify-org-manager-access.ts'],
        {
          cwd: path.join(__dirname, '../../server'),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            EMAIL_PROVIDER: 'test',
            DOTENV_CONFIG_PATH: '/dev/null',
            VARSITYHUB_ENV_PATH: '/dev/null',
            DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unreachable_test',
            JWT_SECRET: 'isolation-test-secret-at-least-32-characters',
            BASE_URL: `http://127.0.0.1:${port}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20000,
        }
      );
      let output = '';
      child.stdout.on('data', data => {
        output += data;
      });
      child.stderr.on('data', data => {
        output += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on('close', resolve);
        child.on('error', reject);
      });
      assert.equal(code, 1, output);
      assert.deepEqual(requests, [], 'must not reuse or probe an unowned API');
      assert.match(output, /EADDRINUSE/);
    } finally {
      await new Promise(resolve => otherApi.close(resolve));
    }
  }
);
