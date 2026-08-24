import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const LIVE_PORT = 4299;

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
