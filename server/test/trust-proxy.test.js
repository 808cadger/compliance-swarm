import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

const PASSWORD = 'correct-horse-battery';

async function seedUser() {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, 'owner_admin', 'U')`,
    [tenant.id, hash],
  );
}

// In production the app runs inside a container on the `compliance_swarm` Docker bridge, so the
// peer address it sees is the bridge gateway (RFC1918), not 127.0.0.1 — the topology the
// `trust proxy` setting has to cope with. supertest always connects over loopback, so shadow the
// accepted socket's remoteAddress to stand in for the NAT hop. Everything above that (Express's
// req.ip resolution, proxy-addr, the real routes) is the production code path.
function serverWithPeer(peerAddress) {
  const server = http.createServer(createApp());
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: peerAddress, configurable: true });
  });
  return server;
}

// req.ip is not exposed by any route, but it is what login persists as the audit row's
// ip_address — so a successful login is the honest way to observe what Express resolved.
async function loginAndReadAuditedIp(server, forwardedFor) {
  const res = await request(server)
    .post('/api/auth/login')
    .set('X-Forwarded-For', forwardedFor)
    .send({ email: 'u@test.co', password: PASSWORD });
  assert.equal(res.status, 200);
  const { rows } = await pool.query(`SELECT ip_address FROM audit_log WHERE event_type = 'login_success'`);
  assert.equal(rows.length, 1);
  return rows[0].ip_address;
}

test('X-Forwarded-For from the Docker bridge gateway is trusted, so req.ip is the real client', async (t) => {
  await seedUser();
  const server = serverWithPeer('172.19.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(await loginAndReadAuditedIp(server, '203.0.113.7'), '203.0.113.7');
});

test('X-Forwarded-For from an untrusted public peer is ignored, so req.ip stays the peer', async (t) => {
  await seedUser();
  // Not loopback, not link-local, not RFC1918: a hop we do not control, whose forwarding
  // claims must not be believed. This is the security property of the trust list.
  const server = serverWithPeer('198.51.100.23');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(await loginAndReadAuditedIp(server, '203.0.113.7'), '198.51.100.23');
});

test('a direct loopback peer (host-network / non-containerised run) is still trusted', async (t) => {
  await seedUser();
  const server = serverWithPeer('127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(await loginAndReadAuditedIp(server, '203.0.113.7'), '203.0.113.7');
});
