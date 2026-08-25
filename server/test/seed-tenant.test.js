import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-tenant.js');

// The script is a CLI, so it gets driven as one. DATABASE_URL is pinned to the test database:
// the script's own guard must reject the password before it ever opens a connection, and if it
// regresses the damage lands in compliance_swarm_test, never production.
function runSeed(args) {
  return execFileAsync(process.execPath, [SEED_SCRIPT, ...args], {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}

test('seed-tenant refuses an owner password under the 12-character minimum', async () => {
  const err = await runSeed(['Test Co', 'owner@test.co', 'elevencharx']).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, 'the script must exit non-zero instead of seeding a weak owner password');
  assert.equal(err.code, 1);
  assert.match(err.stderr, /at least 12 characters/);
});

test('seed-tenant refuses missing arguments', async () => {
  const err = await runSeed(['Test Co']).then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.code, 1);
  assert.match(err.stderr, /Usage: node scripts\/seed-tenant\.js/);
});
