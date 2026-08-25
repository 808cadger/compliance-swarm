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
import { asyncRoute } from '../src/asyncRoute.js';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const LIVE_PORT = 4299;
const LOG_LEAK_PORT = 4298;

// A NUL byte is rejected by Postgres itself (SQLSTATE 22021, "invalid byte sequence for
// encoding UTF8") before any constraint is consulted, so it is a genuine, uncaught,
// *non*-23505 database error raised from inside a real asyncRoute-wrapped handler. JSON
// escapes it as a \u0000 sequence over the wire, so it reaches the route as an ordinary string.
const NUL = String.fromCharCode(0);
const NUL_EMAIL = `nul${NUL}byte@test.co`;

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

// Postgres 23505 (unique_violation) on the (tenant_id, email) constraint is caught explicitly
// inside the route handler and answered as a clean 409, so it never reaches the terminal
// error handler at all — which also means it can no longer prove anything about crash
// protection or about the 500 branch. It proves exactly one thing now: the 409 path works
// end to end through the real app. The crash-protection and 500-branch proofs live in the
// two tests below (and, for the real OS process, in the spawned-process test further down).
test('a duplicate email returns 409 from the route, without reaching the error handler', async () => {
  const cookie = await seedOwnerCookie();
  const app = createApp();
  const body = { email: 'dup@test.co', displayName: 'Dup', role: 'supervisor', tempPassword: 'temp12345678' };

  const first = await request(app).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(first.status, 201);

  const second = await request(app).post('/api/users').set('Cookie', [cookie]).send(body);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'conflict');
});

// The mechanism-level proof that asyncRoute still works. Express 4 does not await handlers,
// so without asyncRoute's .catch(next) the rejection below is an unhandled rejection: the
// request never gets an answer at all (and, outside the test runner, Node's default
// --unhandled-rejections=throw kills the process). Replacing asyncRoute with a pass-through
// therefore fails this test with failureType 'unhandledRejection' rather than passing quietly
// — verified by doing exactly that; the whole file passed unchanged before this test existed.
//
// It also covers errorHandler's 500 branch, which nothing else reaches any more, including
// the config.nodeEnv gate on err.message. That gate is an information-disclosure control, so
// both of its sides are asserted: the handler reads config.nodeEnv per request, so flipping
// the field (and restoring it) exercises the production side without a second process. A
// plain Error is used deliberately — no .status, no .code, nothing errorHandler could use to
// classify it as anything but a server fault.
//
// The deadlines matter: an unanswered request is the exact failure mode a broken asyncRoute
// produces, and node:test only attributes an unhandled rejection to a test once that test
// finishes — so with no deadline a regression here hangs the whole run instead of failing it.
// The per-request .timeout() is what makes the failure *clean*: it aborts the socket so
// supertest closes its ephemeral server, letting the run exit rather than idling on a live
// handle after the test-level timeout fires. Both are far above the ~1s these actually take
// (argon2 hashing dominates). Same for the database-error test below.
test('an uncaught rejection inside an asyncRoute handler becomes a 500, not an unanswered request', { timeout: 20_000 }, async (t) => {
  const app = express();
  app.get('/boom', asyncRoute(async () => { throw new Error('something broke'); }));
  app.use(errorHandler);

  const originalNodeEnv = config.nodeEnv;
  t.after(() => { config.nodeEnv = originalNodeEnv; });

  config.nodeEnv = 'development';
  const { result: dev, output } = await captureAllOutput(() => request(app).get('/boom').timeout(10_000));
  assert.equal(dev.status, 500);
  assert.equal(dev.body.error.code, 'internal');
  assert.equal(dev.body.error.message, 'Something went wrong');
  assert.equal(dev.body.error.detail, 'something broke');
  // Proves the terminal handler is what answered, rather than something else producing a 500.
  assert.match(output, /GET \/boom ->/);
  assert.match(output, /something broke/);

  config.nodeEnv = 'production';
  const { result: prod } = await captureAllOutput(() => request(app).get('/boom').timeout(10_000));
  assert.equal(prod.status, 500);
  assert.equal(prod.body.error.code, 'internal');
  assert.equal(prod.body.error.message, 'Something went wrong');
  assert.ok(!('detail' in prod.body.error), 'production must not disclose err.message to the client');
  assert.doesNotMatch(JSON.stringify(prod.body), /something broke/);
});

// The same crash-protection proof, but through the real createApp() and a real database
// error, which additionally pins the discrimination the 23505 catch in routes/users.js
// introduced: that catch must answer 409 for a unique violation *only*, and re-throw every
// other SQLSTATE so it still lands on the terminal handler as a 500. A NUL byte in the email
// makes Postgres reject the INSERT with 22021 before any constraint is evaluated, so this is
// a genuine uncaught pg rejection out of an asyncRoute-wrapped handler — not a synthetic one.
test('a non-23505 database error still reaches the terminal handler as a 500, not a 409', { timeout: 20_000 }, async () => {
  const cookie = await seedOwnerCookie();
  const app = createApp();
  const body = { displayName: 'Nul', role: 'supervisor', tempPassword: 'temp12345678' };

  const { result: res, output } = await captureAllOutput(() => request(app)
    .post('/api/users')
    .set('Cookie', [cookie])
    .timeout(10_000)
    .send({ ...body, email: NUL_EMAIL }));

  assert.equal(res.status, 500, 'a non-unique-violation pg error must not be answered as a 409');
  assert.equal(res.body.error.code, 'internal');
  assert.notEqual(res.body.error.code, 'conflict');
  // The pg error really was the 22021 one this test meant to provoke, and it really did pass
  // through the terminal handler's log line rather than being swallowed by the route.
  assert.match(output, /POST \/api\/users ->/);
  assert.match(output, /invalid byte sequence/);

  // And the same route, same catch block, still answers 409 for the error code it does own.
  const ok = await request(app).post('/api/users').set('Cookie', [cookie]).send({ ...body, email: 'dup@test.co' });
  assert.equal(ok.status, 201);
  const dup = await request(app).post('/api/users').set('Cookie', [cookie]).send({ ...body, email: 'dup@test.co' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'conflict');
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

// A malformed Content-Encoding header (claiming gzip on bytes that aren't) produces a zlib
// error with neither `.type` nor `.body` — the two properties describeErrorForLog originally
// keyed its redaction on. Its message is a fixed string from zlib's own constant table
// ("incorrect header check"), so this was safe in practice, but not structurally guaranteed
// the way the type/body checks are. This proves the widened `expose === true && status < 500`
// check now catches this error family too, rather than falling through to the raw-stack log.
test('a malformed Content-Encoding request is logged without its raw stack, by identity only', async () => {
  const { result: res, output } = await captureAllOutput(() => request(createApp())
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .send('not actually gzip data'));

  assert.equal(res.status, 400);
  assert.match(output, /detail withheld/);
  // The raw stack's first line would otherwise be "Error: incorrect header check ...".
  assert.doesNotMatch(output, /incorrect header check/);
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

// The in-process assertions above can't prove the real process survives: supertest runs the
// app inside the test runner, which installs its own rejection handling, so an unhandled
// rejection there fails a test instead of killing a server. This spawns the real entrypoint
// (src/index.js) as its own Node process — where Node's default --unhandled-rejections=throw
// is what actually applies — and provokes a genuine uncaught pg rejection (the 22021 NUL-byte
// insert) from inside an asyncRoute-wrapped handler, then checks the process is still up and
// still serving. The duplicate-email requests around it are no longer the crash provocation:
// 23505 is caught in the route and answered as a 409 without ever unwinding to asyncRoute.
// They stay because this is the only end-to-end check that both branches behave correctly
// against a real listening server.
test('the real server process survives an uncaught handler error and keeps serving', { timeout: 60_000 }, async (t) => {
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
  assert.equal(second.status, 409, 'duplicate insert must answer, not hang or drop the connection');
  assert.equal(second.body.error.code, 'conflict');

  // The actual crash provocation: a pg error nothing in the route catches, so it unwinds out
  // of the async handler and can only be contained by asyncRoute. Without that containment
  // this request goes unanswered (the index.js unhandledRejection backstop keeps the process
  // itself alive, so `exited` alone can't tell them apart — the 500-not-a-timeout assertion
  // below is what actually discriminates asyncRoute's containment).
  const uncaught = await request(base)
    .post('/api/users')
    .set('Cookie', [cookie])
    .timeout(10_000)
    .send({ ...body, email: NUL_EMAIL });
  assert.equal(uncaught.status, 500, 'an uncaught handler error must still answer the request');
  assert.equal(uncaught.body.error.code, 'internal');

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
