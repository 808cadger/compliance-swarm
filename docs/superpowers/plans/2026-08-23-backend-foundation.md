# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a real, deployed backend for the Compliance Swarm pilot — login, tenant isolation, three-role RBAC, and an audit log — reachable live at `https://compliance.808techserviceshi.cc`, with minimal role-landing pages that make the separation demonstrable to Jeff.

**Architecture:** Node.js (ESM) + Express API backed by Postgres 16, server-side sessions (opaque signed cookie, hashed token stored in DB), argon2id password hashing. Ships in its own Docker Compose project (`/opt/compliance-swarm/`), reachable only via the existing Cloudflare Tunnel — no ports published to the host or LAN beyond `127.0.0.1`.

**Tech Stack:** Node.js 20+, Express 4, `pg`, `argon2`, `cookie-parser`, `supertest` + Node's built-in `node:test` runner, Postgres 16, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-23-backend-foundation-design.md`

## Global Constraints

- No database port published to host or LAN — Postgres reachable only inside the project's private Docker network (spec: Architecture).
- The app's Docker Compose port publish spec is `127.0.0.1:<PORT>:<PORT>`, never `<PORT>:<PORT>` — that host-side restriction, not the process's own bind address, keeps the port off the LAN (spec: Deployment contract).
- Every route requires explicit role allow-list; a route with none is unreachable, not open (spec: Authorization).
- `tenant_id` and `role` for a request come only from the server-side session, never from client-submitted body/query (spec: Auth flow step 3).
- Login failures return one generic message regardless of cause; audit log gets the real reason (spec: Auth flow step 2, Error handling).
- `audit_log` is insert/select only for the app's DB role — no UPDATE/DELETE grant (spec: Data model).
- Secrets live in `/opt/compliance-swarm/.env`, `chmod 600`, never committed (spec: Context).
- **Any step that edits `~/.cloudflared/config.yml`, runs `cloudflared tunnel route dns`, or restarts the `cloudflared` process touches live production infra also serving `808techserviceshi.cc`. Show the exact diff/command to the user and get explicit go-ahead before running it — do not run it as part of unattended task execution.**

---

## File Structure

```
server/
  package.json
  .env.example
  Dockerfile
  docker-compose.yml
  src/
    config.js
    db.js
    app.js
    index.js
    audit.js
    rateLimit.js
    auth/
      hash.js
      session.js
    middleware/
      authenticate.js
      requireRole.js
    routes/
      auth.js
      users.js
    public/
      login.html
      dashboard/owner.html
      dashboard/supervisor.html
      dashboard/accounting.html
  db/
    init/
      001_schema.sql
      002_grants.sh
  scripts/
    seed-tenant.js
  test/
    helpers/
      db.js
      app.js
    hash.test.js
    session.test.js
    audit.test.js
    rateLimit.test.js
    authenticate.test.js
    auth-routes.test.js
    user-routes.test.js
    dashboard-routes.test.js
```

---

### Task 1: Project scaffold and health check

**Files:**
- Create: `server/package.json`
- Create: `server/.env.example`
- Create: `server/src/config.js`
- Create: `server/src/app.js`
- Create: `server/src/index.js`
- Test: `server/test/helpers/app.js`

**Interfaces:**
- Produces: `config.js` exports `{ port, databaseUrl, cookieSecret, nodeEnv }` (read from `process.env`, `PORT` defaults to `4210`).
- Produces: `app.js` exports default `createApp()` returning an Express app with `GET /api/health` → `200 { status: 'ok' }`, and JSON body parsing (`express.json()`) already wired.
- Produces: `test/helpers/app.js` exports `buildTestApp()` for use by every later route test.

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "compliance-swarm-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "argon2": "^0.41.1",
    "cookie-parser": "^1.4.6",
    "express": "^4.19.2",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "cookie-signature": "^1.2.1",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create `server/.env.example`**

```
NODE_ENV=production
PORT=4210
POSTGRES_USER=compliance_swarm
POSTGRES_PASSWORD=changeme
POSTGRES_DB=compliance_swarm
DATABASE_URL=postgres://compliance_swarm:changeme@postgres:5432/compliance_swarm
COOKIE_SECRET=changeme-to-a-long-random-string
TZ=America/New_York
```

- [ ] **Step 3: Create `server/src/config.js`**

```js
export const config = {
  port: Number(process.env.PORT ?? 4210),
  databaseUrl: process.env.DATABASE_URL,
  cookieSecret: process.env.COOKIE_SECRET,
  nodeEnv: process.env.NODE_ENV ?? 'development',
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.cookieSecret) throw new Error('COOKIE_SECRET is required');
```

- [ ] **Step 4: Create `server/src/app.js`**

```js
import express from 'express';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
```

- [ ] **Step 5: Create `server/src/index.js`**

```js
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`compliance-swarm-server listening on port ${config.port}`);
});
```

- [ ] **Step 6: Create `server/test/helpers/app.js`**

```js
import { createApp } from '../../src/app.js';

export function buildTestApp() {
  return createApp();
}
```

- [ ] **Step 7: Write and run the health check test**

Create `server/test/health.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildTestApp } from './helpers/app.js';

test('GET /api/health returns ok', async () => {
  const app = buildTestApp();
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});
```

Run: `cd server && npm install && DATABASE_URL=postgres://x COOKIE_SECRET=x npm test`
Expected: PASS (1 test)

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/.env.example server/src/config.js server/src/app.js server/src/index.js server/test/helpers/app.js server/test/health.test.js
git commit -m "Scaffold Express server with health check"
```

---

### Task 2: Database schema and dev Docker Compose

**Files:**
- Create: `server/db/init/001_schema.sql`
- Create: `server/db/init/002_grants.sh`
- Create: `server/docker-compose.yml`

**Interfaces:**
- Produces: tables `tenants`, `users` (`user_role` enum: `owner_admin`, `supervisor`, `accounting`), `sessions`, `audit_log` — exact columns as in the spec's Data model section.
- Produces: a restricted Postgres role `compliance_swarm_app` (used by `DATABASE_URL`) with `INSERT, SELECT` only on `audit_log`, full DML on the other three tables.
- Produces: `docker-compose.yml` with services `postgres` (no published port) and `app` (bound `127.0.0.1:${PORT}`), a private `compliance_swarm` network, named volume `postgres_data`.

- [ ] **Step 1: Create `server/db/init/001_schema.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner_admin', 'supervisor', 'accounting');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  email          citext NOT NULL,
  password_hash  text NOT NULL,
  role           user_role NOT NULL,
  display_name   text NOT NULL,
  disabled_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES users(id),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  ip_address     inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id),
  actor_user_id  uuid REFERENCES users(id),
  event_type     text NOT NULL,
  target_type    text,
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Create `server/db/init/002_grants.sh`**

The Postgres image's `docker-entrypoint-initdb.d` runner executes `.sh` files (not just `.sql`), sourcing them with `POSTGRES_USER`/`POSTGRES_DB` already exported — that's how `POSTGRES_APP_PASSWORD` gets into the `CREATE ROLE` statement below without ever being written to a committed file:

```sh
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compliance_swarm_app') THEN
      CREATE ROLE compliance_swarm_app LOGIN PASSWORD '$POSTGRES_APP_PASSWORD';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE $POSTGRES_DB TO compliance_swarm_app;
  GRANT USAGE ON SCHEMA public TO compliance_swarm_app;

  GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, sessions TO compliance_swarm_app;
  GRANT SELECT, INSERT ON audit_log TO compliance_swarm_app;
  GRANT USAGE ON SEQUENCE audit_log_id_seq TO compliance_swarm_app;
EOSQL
```

Make it executable: `chmod +x server/db/init/002_grants.sh` (the init runner skips non-executable `.sh` files).

- [ ] **Step 3: Create `server/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    container_name: compliance-swarm-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_APP_PASSWORD: ${POSTGRES_APP_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro
    networks:
      - compliance_swarm

  app:
    build: .
    container_name: compliance-swarm-app
    restart: unless-stopped
    depends_on:
      - postgres
    env_file: .env
    ports:
      - "127.0.0.1:${PORT}:${PORT}"
    networks:
      - compliance_swarm

networks:
  compliance_swarm:
    driver: bridge

volumes:
  postgres_data:
```

Replace `server/.env.example` (created in Task 1) with:

```
NODE_ENV=production
PORT=4210
POSTGRES_USER=compliance_swarm
POSTGRES_PASSWORD=changeme
POSTGRES_DB=compliance_swarm
POSTGRES_APP_PASSWORD=changeme-app
DATABASE_URL=postgres://compliance_swarm_app:changeme-app@postgres:5432/compliance_swarm
COOKIE_SECRET=changeme-to-a-long-random-string
TZ=America/New_York
```

- [ ] **Step 4: Verify locally**

Run:
```bash
cd server
cp .env.example .env
docker compose up -d postgres
sleep 3
docker exec -it compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "\dt"
```
Expected: lists `tenants`, `users`, `sessions`, `audit_log`.

- [ ] **Step 5: Commit**

```bash
git add server/db server/docker-compose.yml server/.env.example
git commit -m "Add Postgres schema, grants, and dev Docker Compose"
```

---

### Task 3: Password hashing and session token utilities

**Files:**
- Create: `server/src/auth/hash.js`
- Create: `server/src/auth/session.js`
- Create: `server/test/helpers/db.js`
- Test: `server/test/hash.test.js`
- Test: `server/test/session.test.js`

**Interfaces:**
- Consumes: `pg` `Pool` from Task 2's schema (real DB required for session tests).
- Produces: `hash.js` exports `hashPassword(plain) -> Promise<string>`, `verifyPassword(hash, plain) -> Promise<boolean>`.
- Produces: `session.js` exports `createSession(pool, { userId, tenantId, ipAddress, userAgent }) -> Promise<{ token, expiresAt }>`, `lookupSession(pool, token) -> Promise<{ userId, tenantId, role, expiresAt } | null>`, `deleteSession(pool, token) -> Promise<void>`, `refreshSession(pool, token) -> Promise<void>`.
- Produces: `test/helpers/db.js` exports `getTestPool()` and `resetDb(pool)` (truncates all four tables), used by every DB-backed test from here on.

- [ ] **Step 1: Create `server/src/db.js`**

```js
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
```

- [ ] **Step 2: Create `server/test/helpers/db.js`**

```js
import pg from 'pg';

export function getTestPool() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  return new pg.Pool({ connectionString });
}

export async function resetDb(pool) {
  await pool.query('TRUNCATE audit_log, sessions, users, tenants RESTART IDENTITY CASCADE');
}
```

- [ ] **Step 3: Create `server/src/auth/hash.js`**

```js
import argon2 from 'argon2';

export async function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write `server/test/hash.test.js` and run it**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/hash.js';

test('hashPassword produces a hash verifyPassword accepts', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'correct-horse-battery-staple'), true);
});

test('verifyPassword rejects wrong password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'wrong-password'), false);
});
```

Run: `cd server && node --test test/hash.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Create `server/src/auth/session.js`**

```js
import crypto from 'node:crypto';

const SESSION_IDLE_HOURS = 12;
const SESSION_ABSOLUTE_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(pool, { userId, tenantId, ipAddress, userAgent }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_HOURS * 3600 * 1000);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), userId, tenantId, ipAddress ?? null, userAgent ?? null, expiresAt],
  );
  return { token, expiresAt };
}

export async function lookupSession(pool, token) {
  const { rows } = await pool.query(
    `SELECT s.user_id, s.tenant_id, s.expires_at, s.created_at, u.role, u.disabled_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.disabled_at) return null;
  const absoluteExpiry = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_DAYS * 86400 * 1000;
  if (Date.now() > absoluteExpiry) return null;
  if (Date.now() > new Date(row.expires_at).getTime()) return null;
  return { userId: row.user_id, tenantId: row.tenant_id, role: row.role };
}

export async function refreshSession(pool, token) {
  const expiresAt = new Date(Date.now() + SESSION_IDLE_HOURS * 3600 * 1000);
  await pool.query(
    `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1`,
    [hashToken(token), expiresAt],
  );
}

export async function deleteSession(pool, token) {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}
```

- [ ] **Step 6: Write `server/test/session.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { createSession, lookupSession, deleteSession } from '../src/auth/session.js';

const pool = getTestPool();

beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUser() {
  const { rows: [tenant] } = await pool.query(
    `INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`,
  );
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'owner@test.co', 'x', 'owner_admin', 'Owner')
     RETURNING id`,
    [tenant.id],
  );
  return { tenantId: tenant.id, userId: user.id };
}

test('createSession then lookupSession returns the session', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  const result = await lookupSession(pool, token);
  assert.deepEqual(result, { userId, tenantId, role: 'owner_admin' });
});

test('lookupSession returns null for unknown token', async () => {
  const result = await lookupSession(pool, 'not-a-real-token');
  assert.equal(result, null);
});

test('deleteSession invalidates the session', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  await deleteSession(pool, token);
  assert.equal(await lookupSession(pool, token), null);
});

test('lookupSession returns null for a disabled user', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [userId]);
  assert.equal(await lookupSession(pool, token), null);
});
```

Run: `cd server && docker compose up -d postgres && DATABASE_URL=postgres://compliance_swarm:changeme@localhost:5432/compliance_swarm node --test test/session.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/db.js server/src/auth server/test/helpers/db.js server/test/hash.test.js server/test/session.test.js
git commit -m "Add password hashing and session token utilities"
```

---

### Task 4: Audit log writer

**Files:**
- Create: `server/src/audit.js`
- Test: `server/test/audit.test.js`

**Interfaces:**
- Consumes: `pg` pool/client (same connection used by the request's transaction, if any).
- Produces: `audit.js` exports `writeAudit(client, { tenantId, actorUserId = null, eventType, targetType = null, targetId = null, metadata = {}, ipAddress = null }) -> Promise<void>`.

- [ ] **Step 1: Create `server/src/audit.js`**

```js
export async function writeAudit(client, {
  tenantId, actorUserId = null, eventType, targetType = null, targetId = null, metadata = {}, ipAddress = null,
}) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, target_type, target_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, actorUserId, eventType, targetType, targetId, JSON.stringify(metadata), ipAddress],
  );
}
```

- [ ] **Step 2: Write `server/test/audit.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { writeAudit } from '../src/audit.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

test('writeAudit inserts a row with the given fields', async () => {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  await writeAudit(pool, {
    tenantId: tenant.id,
    eventType: 'login_failed',
    metadata: { reason: 'bad_password' },
  });
  const { rows } = await pool.query('SELECT * FROM audit_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'login_failed');
  assert.equal(rows[0].actor_user_id, null);
  assert.deepEqual(rows[0].metadata, { reason: 'bad_password' });
});

test('audit_log rejects UPDATE from the app role', async () => {
  const appPool = getTestPool();
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  await writeAudit(pool, { tenantId: tenant.id, eventType: 'login_success' });
  const { rows: [row] } = await pool.query('SELECT id FROM audit_log LIMIT 1');
  await assert.rejects(
    () => appPool.query('UPDATE audit_log SET event_type = $1 WHERE id = $2', ['tampered', row.id]),
  );
  await appPool.end();
});
```

Note: the second test only proves the grant if `TEST_DATABASE_URL`/`DATABASE_URL` connects as `compliance_swarm_app` (the restricted role from Task 2), not the Postgres superuser — run tests with that connection string, not `POSTGRES_USER`.

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm node --test test/audit.test.js`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add server/src/audit.js server/test/audit.test.js
git commit -m "Add audit log writer with insert-only grant test"
```

---

### Task 5: Login rate limiter

**Files:**
- Create: `server/src/rateLimit.js`
- Test: `server/test/rateLimit.test.js`

**Interfaces:**
- Produces: `rateLimit.js` exports `class LoginRateLimiter` with `constructor({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {})`, method `check(key) -> boolean` (records an attempt, returns `false` if the key is over the limit for the current window), method `reset(key) -> void`.

- [ ] **Step 1: Create `server/src/rateLimit.js`**

```js
export class LoginRateLimiter {
  constructor({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  check(key) {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.attempts.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.maxAttempts;
  }

  reset(key) {
    this.attempts.delete(key);
  }
}
```

- [ ] **Step 2: Write `server/test/rateLimit.test.js` and run it**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../src/rateLimit.js';

test('allows up to maxAttempts within the window', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 60000 });
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), false);
});

test('different keys are tracked independently', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 60000 });
  assert.equal(limiter.check('a'), true);
  assert.equal(limiter.check('b'), true);
});

test('reset clears a key', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 60000 });
  limiter.check('k');
  limiter.reset('k');
  assert.equal(limiter.check('k'), true);
});
```

Run: `cd server && node --test test/rateLimit.test.js`
Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add server/src/rateLimit.js server/test/rateLimit.test.js
git commit -m "Add in-memory login rate limiter"
```

---

### Task 6: Authentication and role middleware

**Files:**
- Create: `server/src/middleware/authenticate.js`
- Create: `server/src/middleware/requireRole.js`
- Test: `server/test/authenticate.test.js`

**Interfaces:**
- Consumes: `lookupSession` from Task 3 (`src/auth/session.js`).
- Produces: `authenticate.js` exports default `authenticate(pool)` returning Express middleware. Reads `req.signedCookies.session`, on valid session sets `req.user = { id: userId, tenantId, role }`, else responds `401 { error: { code: 'unauthenticated', message: 'Login required' } }`.
- Produces: `requireRole.js` exports default `requireRole(...roles)` returning Express middleware. If `req.user` missing → `401`; if `req.user.role` not in `roles` → `403 { error: { code: 'forbidden', message: 'Not permitted' } }`.

- [ ] **Step 1: Create `server/src/middleware/authenticate.js`**

```js
import { lookupSession, refreshSession } from '../auth/session.js';

export default function authenticate(pool) {
  return async function authenticateMiddleware(req, res, next) {
    const token = req.signedCookies?.session;
    if (!token) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    const session = await lookupSession(pool, token);
    if (!session) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    req.user = { id: session.userId, tenantId: session.tenantId, role: session.role };
    await refreshSession(pool, token);
    next();
  };
}
```

- [ ] **Step 2: Create `server/src/middleware/requireRole.js`**

```js
export default function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not permitted' } });
    }
    next();
  };
}
```

- [ ] **Step 3: Write `server/test/authenticate.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { createSession } from '../src/auth/session.js';
import authenticate from '../src/middleware/authenticate.js';
import requireRole from '../src/middleware/requireRole.js';

const pool = getTestPool();
const COOKIE_SECRET = 'test-secret';

beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

function buildApp() {
  const app = express();
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/protected', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.json({ role: req.user.role });
  });
  return app;
}

async function seedUserAndCookie(role = 'owner_admin') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', 'x', $2, 'U') RETURNING id`,
    [tenant.id, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return `session=s:${sign.sign(token, COOKIE_SECRET)}`;
}

test('no cookie -> 401', async () => {
  const res = await request(buildApp()).get('/protected');
  assert.equal(res.status, 401);
});

test('valid session, wrong role -> 403', async () => {
  const cookie = await seedUserAndCookie('supervisor');
  const res = await request(buildApp())
    .get('/protected')
    .set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('valid session, correct role -> 200', async () => {
  const cookie = await seedUserAndCookie('owner_admin');
  const res = await request(buildApp())
    .get('/protected')
    .set('Cookie', [cookie]);
  assert.equal(res.status, 200);
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm node --test test/authenticate.test.js`
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/middleware server/test/authenticate.test.js
git commit -m "Add session authentication and role-enforcement middleware"
```

---

### Task 7: Login and logout routes

**Files:**
- Modify: `server/src/app.js`
- Create: `server/src/routes/auth.js`
- Test: `server/test/auth-routes.test.js`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` (Task 3), `createSession`/`deleteSession` (Task 3), `writeAudit` (Task 4), `LoginRateLimiter` (Task 5), `authenticate` (Task 6).
- Produces: `POST /api/auth/login { email, password }` → `200 { role, displayName }` + sets signed `session` cookie, or `401 { error: { code: 'invalid_credentials', message: 'Invalid email or password' } }`. `POST /api/auth/logout` (authenticated) → `204`.

- [ ] **Step 1: Create `server/src/routes/auth.js`**

```js
import { Router } from 'express';
import { verifyPassword } from '../auth/hash.js';
import { createSession, deleteSession, lookupSession } from '../auth/session.js';
import { writeAudit } from '../audit.js';

export default function authRoutes({ pool, rateLimiter }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Email and password required' } });
    }
    const key = `${req.ip}:${email}`;
    if (!rateLimiter.check(key)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
    }

    const { rows } = await pool.query(
      `SELECT id, tenant_id, password_hash, role, display_name, disabled_at FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    const genericFailure = () => res.status(401).json({ error: { code: 'invalid_credentials', message: 'Invalid email or password' } });

    if (!user || user.disabled_at) {
      await writeAudit(pool, { tenantId: user?.tenant_id ?? null, eventType: 'login_failed', metadata: { email, reason: user ? 'disabled' : 'unknown_email' } });
      return genericFailure();
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      await writeAudit(pool, { tenantId: user.tenant_id, eventType: 'login_failed', metadata: { email, reason: 'bad_password' } });
      return genericFailure();
    }

    rateLimiter.reset(key);
    const { token } = await createSession(pool, {
      userId: user.id, tenantId: user.tenant_id, ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    await writeAudit(pool, { tenantId: user.tenant_id, actorUserId: user.id, eventType: 'login_success', ipAddress: req.ip });

    res.cookie('session', token, {
      httpOnly: true, secure: true, sameSite: 'strict', signed: true, maxAge: 12 * 3600 * 1000,
    });
    res.json({ role: user.role, displayName: user.display_name });
  });

  router.post('/logout', async (req, res) => {
    const token = req.signedCookies?.session;
    if (token) {
      const session = await lookupSession(pool, token);
      await deleteSession(pool, token);
      if (session) {
        await writeAudit(pool, { tenantId: session.tenantId, actorUserId: session.userId, eventType: 'logout' });
      }
    }
    res.clearCookie('session');
    res.status(204).end();
  });

  return router;
}
```

- [ ] **Step 2: Wire routes into `server/src/app.js`**

Replace the file with:

```js
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { LoginRateLimiter } from './rateLimit.js';
import authRoutes from './routes/auth.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  const rateLimiter = new LoginRateLimiter();

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes({ pool, rateLimiter }));

  return app;
}
```

- [ ] **Step 3: Write `server/test/auth-routes.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUser({ role = 'owner_admin', password = 'correct-horse-battery', disabled = false } = {}) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, disabled_at)
     VALUES ($1, 'u@test.co', $2, $3, 'U', $4)`,
    [tenant.id, hash, role, disabled ? new Date() : null],
  );
}

test('login with correct password sets cookie and returns role', async () => {
  await seedUser();
  const app = createApp();
  const res = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'correct-horse-battery' });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'owner_admin');
  assert.ok(res.headers['set-cookie']?.[0].includes('session='));
  const { rows } = await pool.query(`SELECT event_type FROM audit_log`);
  assert.deepEqual(rows.map(r => r.event_type), ['login_success']);
});

test('login with wrong password returns generic error and audits login_failed', async () => {
  await seedUser();
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
  const { rows } = await pool.query(`SELECT event_type FROM audit_log`);
  assert.deepEqual(rows.map(r => r.event_type), ['login_failed']);
});

test('login with unknown email returns the same generic error', async () => {
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'nobody@test.co', password: 'x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
});

test('login for a disabled user is rejected', async () => {
  await seedUser({ disabled: true });
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'u@test.co', password: 'correct-horse-battery' });
  assert.equal(res.status, 401);
});

test('11th login attempt within the window is rate limited', async () => {
  await seedUser();
  const app = createApp();
  for (let i = 0; i < 10; i++) {
    await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  }
  const res = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  assert.equal(res.status, 429);
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm COOKIE_SECRET=test-secret node --test test/auth-routes.test.js`
Expected: PASS (5 tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/app.js server/src/routes/auth.js server/test/auth-routes.test.js
git commit -m "Add login/logout routes with rate limiting and audit writes"
```

---

### Task 8: User management routes (Owner/Admin only)

**Files:**
- Create: `server/src/routes/users.js`
- Modify: `server/src/app.js`
- Test: `server/test/user-routes.test.js`

**Interfaces:**
- Consumes: `authenticate` + `requireRole` (Task 6), `hashPassword` (Task 3), `writeAudit` (Task 4).
- Produces: `POST /api/users { email, displayName, role, tempPassword }` (owner_admin only) → `201 { id, email, role }`, writes `user_created`. `GET /api/users` (owner_admin only) → `200 [{ id, email, role, displayName, disabledAt }]`, scoped to `req.user.tenantId`.

- [ ] **Step 1: Create `server/src/routes/users.js`**

```js
import { Router } from 'express';
import { hashPassword } from '../auth/hash.js';
import { writeAudit } from '../audit.js';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';

export default function userRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), async (req, res) => {
    const { email, displayName, role, tempPassword } = req.body ?? {};
    if (!email || !displayName || !role || !tempPassword) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'email, displayName, role, tempPassword required' } });
    }
    if (!['owner_admin', 'supervisor', 'accounting'].includes(role)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'invalid role' } });
    }
    const hash = await hashPassword(tempPassword);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role`,
      [req.user.tenantId, email, hash, role, displayName],
    );
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'user_created',
      targetType: 'user', targetId: user.id, metadata: { role },
    });
    res.status(201).json(user);
  });

  router.get('/', requireRole('owner_admin'), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, email, role, display_name AS "displayName", disabled_at AS "disabledAt"
       FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.user.tenantId],
    );
    res.json(rows);
  });

  return router;
}
```

- [ ] **Step 2: Mount in `server/src/app.js`**

Add imports `import userRoutes from './routes/users.js';` and, after the `/api/auth` mount, add:

```js
  app.use('/api/users', userRoutes({ pool }));
```

- [ ] **Step 3: Write `server/test/user-routes.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import sign from 'cookie-signature';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUserWithCookie(role) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, tenantId: tenant.id };
}

test('owner_admin can create a user', async () => {
  const { cookie } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'new@test.co', displayName: 'New', role: 'supervisor', tempPassword: 'temp12345678' });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'supervisor');
});

test('supervisor cannot create a user', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'new@test.co', displayName: 'New', role: 'supervisor', tempPassword: 'temp12345678' });
  assert.equal(res.status, 403);
});

test('accounting cannot list users', async () => {
  const { cookie } = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/api/users').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('GET /api/users only returns users in the caller\'s tenant', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('owner_admin');
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'other@other.co', 'x', 'owner_admin', 'Other')`,
    [otherTenant.id],
  );
  const res = await request(createApp()).get('/api/users').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.ok(res.body.every(u => u.email !== 'other@other.co'));
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm COOKIE_SECRET=test-secret node --test test/user-routes.test.js`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/users.js server/src/app.js server/test/user-routes.test.js
git commit -m "Add owner_admin-only user management routes with tenant scoping"
```

---

### Task 9: Role-scoped landing pages (the demo surface)

**Files:**
- Create: `server/src/public/login.html`
- Create: `server/src/public/dashboard/owner.html`
- Create: `server/src/public/dashboard/supervisor.html`
- Create: `server/src/public/dashboard/accounting.html`
- Create: `server/src/routes/dashboard.js`
- Modify: `server/src/app.js`
- Test: `server/test/dashboard-routes.test.js`

**Interfaces:**
- Consumes: `authenticate` (Task 6).
- Produces: `GET /login` → serves `login.html` (public). `GET /dashboard` (authenticated) → redirects to `/dashboard/owner`, `/dashboard/supervisor`, or `/dashboard/accounting` based on `req.user.role`. Each of those three paths is itself guarded by `requireRole` so a direct hit with the wrong role still 403s.

- [ ] **Step 1: Create `server/src/public/login.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compliance Swarm — Log In</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 360px; margin: 15vh auto; padding: 0 1rem; }
  input, button { width: 100%; padding: 0.6rem; margin-top: 0.5rem; font-size: 1rem; }
  button { background: #1a5f38; color: white; border: none; border-radius: 4px; }
  #error { color: #b00020; min-height: 1.2rem; margin-top: 0.5rem; }
</style>
</head>
<body>
  <h1>Compliance Swarm</h1>
  <form id="login-form">
    <input type="email" name="email" placeholder="Email" required autocomplete="username">
    <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
    <button type="submit">Log In</button>
    <div id="error"></div>
  </form>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (res.ok) {
        window.location.href = '/dashboard';
      } else {
        document.getElementById('error').textContent = 'Invalid email or password.';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Create the three dashboard pages**

`server/src/public/dashboard/owner.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Owner Dashboard</title></head>
<body>
  <h1>Owner / Admin Dashboard</h1>
  <p>You are logged in as an Owner/Admin. User management and company-wide rollups land here in a later build.</p>
  <form action="/api/auth/logout" method="post" onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>
</body></html>
```

`server/src/public/dashboard/supervisor.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Supervisor Dashboard</title></head>
<body>
  <h1>Supervisor Dashboard</h1>
  <p>You are logged in as a Supervisor. The daily walkthrough capture flow lands here in a later build.</p>
  <form onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>
</body></html>
```

`server/src/public/dashboard/accounting.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Accounting Dashboard</title></head>
<body>
  <h1>Accounting Dashboard</h1>
  <p>You are logged in as Accounting. Finalized daily reports land here in a later build.</p>
  <form onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>
</body></html>
```

- [ ] **Step 3: Create `server/src/routes/dashboard.js`**

```js
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ROLE_PATH = { owner_admin: 'owner', supervisor: 'supervisor', accounting: 'accounting' };

export default function dashboardRoutes({ pool }) {
  const router = Router();

  router.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  router.get('/dashboard', authenticate(pool), (req, res) => {
    res.redirect(`/dashboard/${ROLE_PATH[req.user.role]}`);
  });

  router.get('/dashboard/owner', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'owner.html'));
  });
  router.get('/dashboard/supervisor', authenticate(pool), requireRole('supervisor'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'supervisor.html'));
  });
  router.get('/dashboard/accounting', authenticate(pool), requireRole('accounting'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'accounting.html'));
  });

  return router;
}
```

- [ ] **Step 4: Mount in `server/src/app.js`**

Add `import dashboardRoutes from './routes/dashboard.js';` and, after the `/api/users` mount:

```js
  app.use(dashboardRoutes({ pool }));
```

- [ ] **Step 5: Write `server/test/dashboard-routes.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUserWithCookie(role) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
}

test('unauthenticated GET /dashboard redirects to 401 (no session)', async () => {
  const res = await request(createApp()).get('/dashboard');
  assert.equal(res.status, 401);
});

test('GET /dashboard redirects supervisor to /dashboard/supervisor', async () => {
  const cookie = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/dashboard').set('Cookie', [cookie]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard/supervisor');
});

test('supervisor hitting /dashboard/accounting directly gets 403', async () => {
  const cookie = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('accounting hitting their own dashboard gets 200', async () => {
  const cookie = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm COOKIE_SECRET=test-secret node --test test/dashboard-routes.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/public server/src/routes/dashboard.js server/src/app.js server/test/dashboard-routes.test.js
git commit -m "Add login page and role-guarded dashboard landing pages"
```

---

### Task 10: Seed script for Jeff's tenant

**Files:**
- Create: `server/scripts/seed-tenant.js`

**Interfaces:**
- Consumes: `hashPassword` (Task 3), `pool` (Task 3's `src/db.js`).
- Produces: a CLI script invoked as `node scripts/seed-tenant.js "<Company Name>" <owner-email> <owner-temp-password>` that inserts one tenant and one `owner_admin` user, prints the created user id, and exits.

- [ ] **Step 1: Create `server/scripts/seed-tenant.js`**

```js
import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth/hash.js';

const [companyName, email, tempPassword] = process.argv.slice(2);
if (!companyName || !email || !tempPassword) {
  console.error('Usage: node scripts/seed-tenant.js "<Company Name>" <owner-email> <owner-temp-password>');
  process.exit(1);
}

const { rows: [tenant] } = await pool.query(
  `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
  [companyName],
);
const hash = await hashPassword(tempPassword);
const { rows: [user] } = await pool.query(
  `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
   VALUES ($1, $2, $3, 'owner_admin', $4) RETURNING id`,
  [tenant.id, email, hash, companyName + ' Owner'],
);
await pool.query(
  `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, target_type, target_id, metadata)
   VALUES ($1, $2, 'user_created', 'user', $3, $4)`,
  [tenant.id, user.id, user.id, JSON.stringify({ role: 'owner_admin', seeded: true })],
);

console.log(`Created tenant ${tenant.id} and owner_admin user ${user.id} (${email})`);
await pool.end();
```

- [ ] **Step 2: Verify against the dev database**

Run:
```bash
cd server
DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm \
  node scripts/seed-tenant.js "Jeff Ludwig Test Co" jeff@example.com temp-password-123
```
Expected: prints a tenant id and user id, no errors.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/seed-tenant.js
git commit -m "Add tenant/owner seed script"
```

---

### Task 11: Dockerfile and production Compose finalization

**Files:**
- Create: `server/Dockerfile`
- Modify: `server/docker-compose.yml` (already created in Task 2 — no structural change, verify build context)
- Create: `server/.dockerignore`

**Interfaces:**
- Produces: a built `app` image runnable via `docker compose up -d`, serving `http://127.0.0.1:${PORT}/api/health`.

- [ ] **Step 1: Create `server/Dockerfile`**

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
EXPOSE 4210
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Create `server/.dockerignore`**

```
node_modules
test
.env
*.log
```

- [ ] **Step 3: Build and verify**

Run:
```bash
cd server
docker compose up -d --build
sleep 3
curl -s http://127.0.0.1:4210/api/health
```
Expected: `{"status":"ok"}`. Then confirm no unexpected public exposure:
```bash
ss -tlnp | grep 4210
```
Expected: only `127.0.0.1:4210`, never `0.0.0.0:4210`.

- [ ] **Step 4: Run the full test suite once more against the composed stack, then commit**

```bash
DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm npm test
git add server/Dockerfile server/.dockerignore
git commit -m "Add Dockerfile and finalize container build for compliance-swarm-server"
```

---

### Task 12: Move to production location and add Cloudflare Tunnel ingress — CONFIRM BEFORE APPLYING

**Files:**
- Modify (on the server, outside the repo): `~/.cloudflared/config.yml`
- Create (on the server, outside the repo): `/opt/compliance-swarm/` (deployed copy of `server/`)

**This task modifies live infrastructure serving `808techserviceshi.cc`. Do not run Steps 2–4 without showing the diff and getting explicit confirmation first.**

- [ ] **Step 1: Copy the built project to `/opt/compliance-swarm/`**

```bash
mkdir -p /opt/compliance-swarm
cp -r /home/cadger/compliance-swarm/server/* /opt/compliance-swarm/
cd /opt/compliance-swarm
cp .env.example .env
chmod 600 .env
```
Then edit `/opt/compliance-swarm/.env` to set real, unique values for `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, and `COOKIE_SECRET` (e.g. `openssl rand -hex 32` for each).

- [ ] **Step 2: STOP — show the intended diff to `~/.cloudflared/config.yml` before touching it**

Proposed addition to the existing `ingress` list (new entry added **before** the existing `service: http_status:404` catch-all, existing entries untouched):

```yaml
ingress:
  - hostname: 808techserviceshi.cc
    service: http://localhost:3000
  - hostname: www.808techserviceshi.cc
    service: http://localhost:3000
  - hostname: compliance.808techserviceshi.cc
    service: http://localhost:4210
  - service: http_status:404
```

Get explicit user confirmation before editing the file.

- [ ] **Step 3: After confirmation, apply the config edit and add the DNS record**

```bash
cloudflared tunnel route dns bd78c224-2fa4-400b-a915-d2c0e3bb6fc8 compliance.808techserviceshi.cc
```
This creates the CNAME in Cloudflare DNS pointing at the tunnel — no manual dashboard step needed. Then edit `~/.cloudflared/config.yml` to add the ingress line from Step 2.

- [ ] **Step 4: Restart the tunnel and verify both hostnames still work**

```bash
kill $(pgrep -f "cloudflared tunnel")
cloudflared tunnel --config ~/.cloudflared/config.yml run &
sleep 3
curl -s -o /dev/null -w "808techserviceshi.cc: %{http_code}\n" https://808techserviceshi.cc
curl -s -o /dev/null -w "compliance.808techserviceshi.cc: %{http_code}\n" https://compliance.808techserviceshi.cc/api/health
```
Expected: both return `200`. If `808techserviceshi.cc` breaks, restore the config from git/backup and restart the tunnel again immediately — do not leave the live site down while debugging the new hostname.

- [ ] **Step 5: Start the compliance-swarm stack under Compose and seed Jeff's tenant**

```bash
cd /opt/compliance-swarm
docker compose up -d
sleep 3
docker compose exec -T app node scripts/seed-tenant.js "Jeff's Company" jeff@example.com "<a-real-temp-password>"
```
Record the printed tenant/user id somewhere private — this is Jeff's first login.

---

### Task 13: End-to-end demo smoke test

**Files:** none (verification only)

- [ ] **Step 1: Verify login and role separation live**

From a browser (or `curl`), visit `https://compliance.808techserviceshi.cc/login`, log in as the seeded owner_admin, and confirm redirect to `/dashboard/owner`.

- [ ] **Step 2: Verify deny-by-default from outside**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://compliance.808techserviceshi.cc/dashboard
```
Expected: `401` (no session cookie).

- [ ] **Step 3: Verify the audit trail is accumulating**

```bash
docker compose -f /opt/compliance-swarm/docker-compose.yml exec -T postgres \
  psql -U compliance_swarm -d compliance_swarm -c "SELECT event_type, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5;"
```
Expected: at least a `login_success` row matching the login just performed.

- [ ] **Step 4: Confirm no unintended exposure**

```bash
ss -tlnp | grep -E ':4210|:5432'
```
Expected: `4210` bound to `127.0.0.1` only; `5432` not listed at all (Postgres has no published port).

This is the demo: a real login at a real HTTPS URL, three roles that genuinely can't see each other's routes, and an audit trail proving it — ready to walk Jeff through. Photo/video capture, AI draft review, and daily reports are the next three sub-projects, each getting its own spec before being built.
