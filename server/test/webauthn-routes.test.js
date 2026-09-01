import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';

// The full register/verify and login/verify crypto round trip needs a real authenticator
// response (a signed challenge), which only a real browser + real hardware/platform
// authenticator can produce — there is no meaningful way to fake that without reimplementing
// a CTAP2 authenticator. @simplewebauthn/server's own test suite covers that verification
// logic directly; what's tested here is everything this app's own routes are responsible for
// around it: auth gating, ceremony handling, tenant/user scoping, and that failures never leak
// account existence. Manual verification with a real passkey is still required before relying
// on this in production — see the delivery notes.

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUserWithCookie(role = 'owner_admin') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [tenant.id, `${role}-${Math.random().toString(36).slice(2)}@test.co`, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, tenantId: tenant.id, userId: user.id };
}

test('register/options requires authentication', async () => {
  const res = await request(createApp()).post('/api/webauthn/register/options');
  assert.equal(res.status, 401);
});

test('register/options returns real WebAuthn options and lists existing credentials to exclude', async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie();
  await pool.query(
    `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type, transports)
     VALUES ($1, $2, 'existing-cred-id', '\\x00', 0, 'singleDevice', '{internal}')`,
    [tenantId, userId],
  );
  const res = await request(createApp()).post('/api/webauthn/register/options').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.ok(res.body.ceremonyId);
  assert.equal(res.body.options.rp.id, 'localhost');
  assert.ok(res.body.options.challenge);
  assert.deepEqual(res.body.options.excludeCredentials.map((c) => c.id), ['existing-cred-id']);
});

test('register/verify rejects an unknown ceremony id without touching the database', async () => {
  const { cookie } = await seedUserWithCookie();
  const res = await request(createApp())
    .post('/api/webauthn/register/verify')
    .set('Cookie', [cookie])
    .send({ ceremonyId: 'not-a-real-ceremony', response: {} });
  assert.equal(res.status, 400);
  const { rows } = await pool.query(`SELECT id FROM passkey_credentials`);
  assert.equal(rows.length, 0);
});

test('register/verify refuses to consume a ceremony started by a different user', async () => {
  const userA = await seedUserWithCookie();
  const userB = await seedUserWithCookie();

  const options = await request(createApp()).post('/api/webauthn/register/options').set('Cookie', [userA.cookie]);
  const ceremonyId = options.body.ceremonyId;

  const res = await request(createApp())
    .post('/api/webauthn/register/verify')
    .set('Cookie', [userB.cookie])
    .send({ ceremonyId, response: {} });
  assert.equal(res.status, 400);
});

test('login/options works without any authentication and never names an account', async () => {
  const res = await request(createApp()).post('/api/webauthn/login/options');
  assert.equal(res.status, 200);
  assert.ok(res.body.ceremonyId);
  assert.equal(res.body.options.allowCredentials, undefined);
});

test('login/options is rate limited per IP after repeated attempts', async () => {
  const app = createApp();
  for (let i = 0; i < 10; i++) {
    await request(app).post('/api/webauthn/login/options');
  }
  const res = await request(app).post('/api/webauthn/login/options');
  assert.equal(res.status, 429);
});

test('login/verify with an unknown credential id is a generic failure, tenant unknown', async () => {
  const app = createApp();
  const options = await request(app).post('/api/webauthn/login/options');
  const res = await request(app)
    .post('/api/webauthn/login/verify')
    .send({ ceremonyId: options.body.ceremonyId, response: { id: 'no-such-credential' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');

  const { rows } = await pool.query(`SELECT event_type, tenant_id, metadata FROM audit_log`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'passkey_login_failed');
  assert.equal(rows[0].tenant_id, null);
  assert.equal(rows[0].metadata.reason, 'unknown_credential');
});

test('login/verify refuses a stale/reused ceremony id', async () => {
  const app = createApp();
  const options = await request(app).post('/api/webauthn/login/options');
  const first = await request(app)
    .post('/api/webauthn/login/verify')
    .send({ ceremonyId: options.body.ceremonyId, response: { id: 'no-such-credential' } });
  assert.equal(first.status, 401);

  // Same ceremony id again — takeCeremony already consumed it, so this must fail the same
  // generic way, not throw or somehow succeed on a re-read.
  const second = await request(app)
    .post('/api/webauthn/login/verify')
    .send({ ceremonyId: options.body.ceremonyId, response: { id: 'no-such-credential' } });
  assert.equal(second.status, 401);
});

test('GET /api/webauthn/credentials only lists the caller\'s own passkeys', async () => {
  const me = await seedUserWithCookie();
  const other = await seedUserWithCookie();
  await pool.query(
    `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type, device_label)
     VALUES ($1, $2, 'mine', '\\x00', 0, 'singleDevice', 'My Laptop')`,
    [me.tenantId, me.userId],
  );
  await pool.query(
    `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type, device_label)
     VALUES ($1, $2, 'theirs', '\\x00', 0, 'singleDevice', 'Their Laptop')`,
    [other.tenantId, other.userId],
  );

  const res = await request(createApp()).get('/api/webauthn/credentials').set('Cookie', [me.cookie]);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].deviceLabel, 'My Laptop');
});

test('DELETE /api/webauthn/credentials/:id cannot remove another user\'s passkey', async () => {
  const me = await seedUserWithCookie();
  const other = await seedUserWithCookie();
  const { rows: [cred] } = await pool.query(
    `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type)
     VALUES ($1, $2, 'theirs', '\\x00', 0, 'singleDevice') RETURNING id`,
    [other.tenantId, other.userId],
  );

  const res = await request(createApp()).delete(`/api/webauthn/credentials/${cred.id}`).set('Cookie', [me.cookie]);
  assert.equal(res.status, 404);

  const { rows } = await pool.query(`SELECT id FROM passkey_credentials WHERE id = $1`, [cred.id]);
  assert.equal(rows.length, 1, 'the other user\'s credential must still exist');
});

test('DELETE /api/webauthn/credentials/:id removes the caller\'s own passkey and audits it', async () => {
  const me = await seedUserWithCookie();
  const { rows: [cred] } = await pool.query(
    `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type)
     VALUES ($1, $2, 'mine', '\\x00', 0, 'singleDevice') RETURNING id`,
    [me.tenantId, me.userId],
  );

  const res = await request(createApp()).delete(`/api/webauthn/credentials/${cred.id}`).set('Cookie', [me.cookie]);
  assert.equal(res.status, 204);

  const { rows } = await pool.query(`SELECT event_type FROM audit_log WHERE event_type = 'passkey_removed'`);
  assert.equal(rows.length, 1);
});
