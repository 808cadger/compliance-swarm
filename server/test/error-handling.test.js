import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp, errorHandler } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const LIVE_PORT = 4299;
const LOG_LEAK_PORT = 4298;

// Stands in for a real password in the malformed-body tests below. Deliberately long enough
// that a partial leak is still recognisable: V8 truncates the fragment it quotes in a JSON
// parse error to the first ten characters, so a naive logger leaks "MARKER_SEC" rather than
// the whole string, and an assertion looking only for the full value would pass.
const PASSWORD_MARKER = 'MARKER_SECRET_VALUE_zx91q';

// Malformed bodies chosen so the marker sits in a different place relative to the parse
// failure each time: after it, at it, before it, and as the entire body (the shape where V8
// quotes the bytes back in err.message).
const MALFORMED_LOGIN_BODIES = [
  `{"email":"u@test.co","password":"${PASSWORD_MARKER}"`,
  `{"email":"u@test.co","password":"${PASSWORD_MARKER}", oops}`,
  `{"password": ${PASSWORD_MARKER}}`,
  `{ bad: 1, "password":"${PASSWORD_MARKER}"}`,
  `["${PASSWORD_MARKER}",`,
  PASSWORD_MARKER,
];

// Any contiguous run of the marker appearing in the log is a leak, whether or not the whole
// value survived. Five characters is short enough to catch V8's truncated quote and long
// enough that it cannot collide with ordinary log text.
function assertNoFragmentOf(output, secret, minLen = 5) {
  for (let i = 0; i + minLen <= secret.length; i++) {
    const fragment = secret.slice(i, i + minLen);
    assert.ok(
      !output.includes(fragment),
      `log leaked "${fragment}" from the password. Captured output:\n${output}`,
    );
  }
}

// Records everything the process writes anywhere: console.error is what the error handler
// calls today, but hooking the underlying stream writes too means a future logger that
// bypasses console still can't sneak the body out past this test.
async function captureAllOutput(fn) {
  const chunks = [];
  const record = (...args) => { chunks.push(args.map(String).join(' ')); };
  const original = {
    error: console.error, log: console.log, warn: console.warn,
    stdout: process.stdout.write, stderr: process.stderr.write,
  };
  console.error = record;
  console.log = record;
  console.warn = record;
  process.stdout.write = function (chunk, ...rest) { chunks.push(String(chunk)); return original.stdout.call(this, chunk, ...rest); };
  process.stderr.write = function (chunk, ...rest) { chunks.push(String(chunk)); return original.stderr.call(this, chunk, ...rest); };
  try {
    return { result: await fn(), output: chunks.join('\n') };
  } finally {
    console.error = original.error;
    console.log = original.log;
    console.warn = original.warn;
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
  }
}

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedOwnerCookie() {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'owner@test.co', $2, 'owner_admin', 'Owner') RETURNING id`,
    [tenant.id, hash],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
}

test('GET / redirects to /login', async () => {
  const res = await request(createApp()).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('an unknown path returns the JSON error envelope, not Express HTML', async () => {
  const res = await request(createApp()).get('/no/such/path');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

// res.sendFile's ENOENT carries the container's absolute filesystem path in err.message and
// sets expose: false specifically to mark that as unsafe to show a client. This builds a tiny
// standalone app around the real errorHandler (not a copy of it) and points res.sendFile at a
// path that can't exist, so the ENOENT is genuine — without touching any real file under
// server/src/public that production also depends on.
test('a res.sendFile ENOENT does not leak the filesystem path to the client', async () => {
  const app = express();
  app.get('/missing-asset', (req, res, next) => {
    res.sendFile(path.join(__dirname, 'this-file-does-not-exist-anywhere.html'), (err) => {
      if (err) next(err);
    });
  });
  app.use(errorHandler);

  const res = await request(app).get('/missing-asset');

  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
  assert.equal(res.body.error.message, 'Not found');
  assert.doesNotMatch(JSON.stringify(res.body), /this-file-does-not-exist-anywhere|ENOENT|\/home\/|\/app\//);
});

test('a duplicate email returns a clean 500 JSON envelope instead of an unhandled rejection', async () => {
  const cookie = await seedOwnerCookie();
  const app = createApp();
  const body = { email: 'dup@test.co', displayName: 'Dup', role: 'supervisor', tempPassword: 'temp12345678' };

  const first = await request(app).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(first.status, 201);

  // Second insert violates UNIQUE (tenant_id, email) -> Postgres 23505 rejects the query
  // inside the async handler. Before asyncRoute this was an unhandled rejection.
  const second = await request(app).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(second.status, 500);
  assert.equal(second.body.error.code, 'internal');
  assert.equal(second.body.error.message, 'Something went wrong');
  // NODE_ENV is not 'production' under test, so config.nodeEnv gates the detail on.
  assert.match(second.body.error.detail, /duplicate key value/);
});

// express.json() rejects a malformed body with a SyntaxError carrying status 400. The login
// page POSTs JSON, so flattening that to 500 would both mislead the caller and mask a plain
// client mistake as a server fault.
test('a malformed JSON body returns 400, not 500', async () => {
  const res = await request(createApp())
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"secretToken": "abcdef123456", "password": garbage');

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad_request');
  assert.ok(res.body.error.message, 'the response should say what was wrong');
  // body-parser's SyntaxError sets expose: true, but its message still quotes a fragment of
  // the raw request body (V8's JSON.parse error). The client gets a fixed message instead —
  // never the raw bytes the request sent, even though nothing here is cross-user (this is
  // same-client reflection), it's needless exposure of server-internal detail either way.
  assert.equal(res.body.error.message, 'Bad request');
  assert.doesNotMatch(JSON.stringify(res.body), /secretToken|abcdef123456|garbage/);
});

// The client-facing half of this is covered above; this is the log-facing half. body-parser
// hangs the entire unparsed body off err.body, and V8's own SyntaxError message quotes a
// fragment of the offending bytes — so console.error(err) (util.inspect walks into err.body),
// console.error(err.message) and console.error(err.stack) all write the submitted password
// into the server log. /api/auth/login is exactly the route that receives one.
test('a malformed login body never writes the password to the log', async () => {
  for (const body of MALFORMED_LOGIN_BODIES) {
    const { result: res, output } = await captureAllOutput(() => request(createApp())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(body));

    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be rejected as malformed`);
    // Proves the test isn't vacuous: the error handler really did run and log this rejection,
    // so the absence of the marker below is the redaction working, not a missing log line.
    assert.match(output, /entity\.parse\.failed/, `nothing was logged for body ${JSON.stringify(body)}`);
    assertNoFragmentOf(output, PASSWORD_MARKER);
  }
});

// And the same thing against the real entrypoint, reading its actual stderr — the in-process
// version above can only see what passes through this process's console, and console.error in
// a spawned server writes straight to a file descriptor the test runner never touches.
test('the real server process does not print the password on a malformed login', async (t) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(LOG_LEAK_PORT),
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      COOKIE_SECRET: process.env.COOKIE_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const base = `http://127.0.0.1:${LOG_LEAK_PORT}`;
  await waitForHealth(base, child, () => exited);

  for (const body of MALFORMED_LOGIN_BODIES) {
    const res = await request(base).post('/api/auth/login').set('Content-Type', 'application/json').send(body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be rejected as malformed`);
  }

  // stdio is piped, so give the child's writes a moment to arrive before reading them.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.match(output, /entity\.parse\.failed/, 'the server should have logged the rejections');
  assertNoFragmentOf(output, PASSWORD_MARKER);
  assert.equal(exited, null, `server process exited: ${JSON.stringify(exited)}`);
});

// The in-process assertions above can't prove the process survives: supertest runs the app
// inside the test runner, which installs its own rejection handling. This spawns the real
// entrypoint (src/index.js) as its own Node process, provokes the same 23505 violation, and
// then checks the process is still up and still serving.
test('the real server process survives a duplicate-email error and keeps serving', async (t) => {
  const cookie = await seedOwnerCookie();

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(LIVE_PORT),
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      COOKIE_SECRET: process.env.COOKIE_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  const base = `http://127.0.0.1:${LIVE_PORT}`;
  await waitForHealth(base, child, () => exited);

  const body = { email: 'dup@test.co', displayName: 'Dup', role: 'supervisor', tempPassword: 'temp12345678' };
  const first = await request(base).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(first.status, 201);

  const second = await request(base).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(second.status, 500, 'duplicate insert must answer, not hang or drop the connection');
  assert.equal(second.body.error.code, 'internal');

  // The whole point: the process is still alive and still answering after that error.
  assert.equal(exited, null, `server process exited: ${JSON.stringify(exited)}`);
  const health = await request(base).get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });

  // And a subsequent well-formed request still works.
  const ok = await request(base)
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ ...body, email: 'after@test.co' });
  assert.equal(ok.status, 201);
});

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
