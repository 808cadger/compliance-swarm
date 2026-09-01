import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

// config.js's DEMO_MODE double-opt-in tripwire runs at import time, before the app or pool is
// ever built, so it can only be observed by actually spawning a real process — an in-process
// import would throw inside this test file's own module graph instead. Same spawn/wait
// pattern as error-handling.test.js's "real server process" tests.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const GUARD_REFUSED_PORT = 4297;
const GUARD_ALLOWED_PORT = 4296;

function spawnServer(port, extraEnv) {
  return spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      COOKIE_SECRET: process.env.COOKIE_SECRET,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('process did not exit in time')); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function waitForHealth(base, child, getExited, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (getExited()) throw new Error(`server exited before becoming ready: ${JSON.stringify(getExited())}`);
    try {
      const res = await request(base).get('/api/health');
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not become healthy in time');
}

test('DEMO_MODE=true refuses to start without CONFIRM_DEMO_MODE also set, in any environment', async () => {
  // Explicit '' (not omitted): the test runner's own process has CONFIRM_DEMO_MODE=true from
  // setup-env.js, and spawnServer spreads ...process.env, so it must be overridden here or
  // the child inherits it and the guard never fires.
  const child = spawnServer(GUARD_REFUSED_PORT, { DEMO_MODE: 'true', NODE_ENV: 'production', CONFIRM_DEMO_MODE: '' });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const { code } = await waitForExit(child);
  assert.notEqual(code, 0, 'server must not exit 0 when the demo-mode double-opt-in guard should fire');
  assert.match(stderr, /DEMO_MODE=true refused to start without CONFIRM_DEMO_MODE=true/);
});

test('DEMO_MODE=true starts when CONFIRM_DEMO_MODE is also set', async (t) => {
  const child = spawnServer(GUARD_ALLOWED_PORT, {
    DEMO_MODE: 'true', NODE_ENV: 'production', CONFIRM_DEMO_MODE: 'true',
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  await waitForHealth(`http://127.0.0.1:${GUARD_ALLOWED_PORT}`, child, () => exited);
  assert.equal(exited, null, 'server should still be running, not have exited, once healthy');
});

// --- WebAuthn origin/RP ID fail-closed validation ---------------------------------------

const WEBAUTHN_CASES = [
  {
    name: 'http origin on a non-localhost host is refused',
    env: { WEBAUTHN_RP_ID: 'compliance.example.com', WEBAUTHN_ORIGIN: 'http://compliance.example.com' },
    match: /must be https for any host other than localhost/,
  },
  {
    name: 'an origin with a path is refused',
    env: { WEBAUTHN_RP_ID: 'compliance.example.com', WEBAUTHN_ORIGIN: 'https://compliance.example.com/app' },
    match: /must not contain a path/,
  },
  {
    name: 'an origin with a query string is refused',
    env: { WEBAUTHN_RP_ID: 'compliance.example.com', WEBAUTHN_ORIGIN: 'https://compliance.example.com/?x=1' },
    match: /must not contain a path|must not contain a query/,
  },
  {
    name: 'a malformed origin URL is refused',
    env: { WEBAUTHN_RP_ID: 'compliance.example.com', WEBAUTHN_ORIGIN: 'not a url' },
    match: /not a valid URL/,
  },
  {
    name: 'an RP ID containing a scheme is refused',
    env: { WEBAUTHN_RP_ID: 'https://compliance.example.com', WEBAUTHN_ORIGIN: 'https://compliance.example.com' },
    match: /must be a bare hostname/,
  },
  {
    name: 'an RP ID containing a port is refused',
    env: { WEBAUTHN_RP_ID: 'compliance.example.com:4210', WEBAUTHN_ORIGIN: 'https://compliance.example.com' },
    match: /must be a bare hostname/,
  },
  {
    name: 'RP ID / origin hostname mismatch is refused',
    env: { WEBAUTHN_RP_ID: 'other.example.com', WEBAUTHN_ORIGIN: 'https://compliance.example.com' },
    match: /must equal WEBAUTHN_ORIGIN's hostname/,
  },
];

let webauthnCasePort = 4290;
for (const { name, env, match } of WEBAUTHN_CASES) {
  test(`WebAuthn config: ${name}`, async () => {
    const port = webauthnCasePort++;
    const child = spawnServer(port, env);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const { code } = await waitForExit(child);
    assert.notEqual(code, 0, 'server must refuse to start on invalid WebAuthn config');
    assert.match(stderr, match);
  });
}

test('WebAuthn config: a valid https production-shaped config starts normally', async (t) => {
  const port = webauthnCasePort++;
  const child = spawnServer(port, { WEBAUTHN_RP_ID: 'compliance.example.com', WEBAUTHN_ORIGIN: 'https://compliance.example.com' });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  await waitForHealth(`http://127.0.0.1:${port}`, child, () => exited);
  assert.equal(exited, null);
});

test('WebAuthn config: explicit http://localhost stays valid (the dev-stack shape)', async (t) => {
  const port = webauthnCasePort++;
  const child = spawnServer(port, { WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: `http://localhost:${port}` });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  await waitForHealth(`http://127.0.0.1:${port}`, child, () => exited);
  assert.equal(exited, null);
});

test('WebAuthn config: omitting both entirely still starts (safe localhost fallback)', async (t) => {
  const port = webauthnCasePort++;
  const child = spawnServer(port, { WEBAUTHN_RP_ID: '', WEBAUTHN_ORIGIN: '' });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  await waitForHealth(`http://127.0.0.1:${port}`, child, () => exited);
  assert.equal(exited, null);
});
