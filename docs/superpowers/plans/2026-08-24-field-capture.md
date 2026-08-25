# Field Capture & Media Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mobile walkthrough capture flow — sites, walkthroughs, secure validated media upload/storage/retrieval, an in-app reminder banner — on top of the already-deployed backend foundation, and ship it to production.

**Architecture:** New Express routes and three new Postgres tables, reusing the existing `authenticate`/`requireRole`/`writeAudit`/`asyncRoute` machinery unchanged. Media files live on a new Docker volume, outside any publicly-servable path, retrievable only through an authenticated streaming endpoint.

**Tech Stack:** Same as the backend foundation (Node 20+, Express 4, `pg`, Postgres 16) plus two new dependencies: `multer` (multipart upload handling) and `file-type` (magic-byte file verification).

**Spec:** `docs/superpowers/specs/2026-08-24-field-capture-design.md`

## Global Constraints

- Every route requires an explicit role allow-list; Accounting has zero access to any route in this plan (spec: Roles and API surface).
- `tenant_id` for every query comes only from `req.user.tenantId` (server-side session), never client input — same discipline as the backend foundation.
- Uploaded files are verified by actual content (magic bytes via `file-type`), never by trusting the client's claimed MIME type or file extension (spec: Architecture).
- Storage filenames are always server-generated random values, never derived from client input (spec: Architecture).
- Media is retrievable only through an authenticated, role- and ownership-checked endpoint — never under `express.static` or any publicly-servable path.
- **Production's Postgres volume already has real data (Jeff's account, existing audit history) — `docker-entrypoint-initdb.d` scripts under `server/db/init/` only run on a fresh, empty volume and will NOT automatically apply to production on redeploy.** New schema in this plan must be written as idempotent SQL (`CREATE TABLE IF NOT EXISTS`, a guarded `DO` block for new types) so the *same* file can be picked up automatically by a future fresh volume AND manually re-applied via `docker exec ... psql -f` against the already-initialized dev, test, and production databases. This pattern is new as of this plan (the backend foundation never needed it, since production didn't exist yet when its schema was written) and every future sub-project that adds schema will need to follow it too.
- Dev/test Postgres runs via `cd server && docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres` (port 5433) — production is on `127.0.0.1:5432`, never touch it except through the explicit migration/deploy tasks at the end of this plan.

---

## File Structure

```
server/
  db/
    init/
      004_field_capture_schema.sql   (new — idempotent, sites/walkthroughs/media)
      005_field_capture_grants.sh    (new — idempotent, mirrors 002's pattern)
  src/
    storage.js                       (new — MEDIA_DIR, generateStorageKey, resolveMediaPath)
    routes/
      sites.js                       (new)
      walkthroughs.js                (new)
      media.js                       (new)
    public/
      dashboard/supervisor.html      (rewritten — was a bare placeholder)
  docker-compose.yml                 (modified — adds media_data volume + mount)
  docker-compose.dev.yml             (modified — dev media volume, separate from prod)
  package.json                       (modified — adds multer, file-type)
  test/
    sites.test.js                    (new)
    walkthroughs.test.js             (new)
    media.test.js                    (new)
    fixtures/
      sample.jpg                     (new — a genuine small JPEG for upload tests)
      disguised.jpg                  (new — a .txt file's bytes, named .jpg, for the rejection test)
```

---

### Task 1: Database schema, grants, and storage volume

**Files:**
- Create: `server/db/init/004_field_capture_schema.sql`
- Create: `server/db/init/005_field_capture_grants.sh`
- Modify: `server/docker-compose.yml`
- Modify: `server/docker-compose.dev.yml`

**Interfaces:**
- Produces: tables `sites`, `walkthroughs` (`walkthrough_slot` enum: `morning`, `afternoon`), `media` (`media_kind` enum: `photo`, `video`) — exact columns per the spec's Data model section.
- Produces: `compliance_swarm_app` granted full DML on all three new tables (no restriction like `audit_log`'s insert-only — these aren't an immutable audit trail).
- Produces: a new named volume `media_data` mounted at `/data/media` in the `app` service (production compose) and a separately-named dev equivalent in the dev override, never shared with production.

- [ ] **Step 1: Create `server/db/init/004_field_capture_schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'walkthrough_slot') THEN
    CREATE TYPE walkthrough_slot AS ENUM ('morning', 'afternoon');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS walkthroughs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  site_id        uuid NOT NULL REFERENCES sites(id),
  supervisor_id  uuid NOT NULL REFERENCES users(id),
  slot           walkthrough_slot NOT NULL,
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_kind') THEN
    CREATE TYPE media_kind AS ENUM ('photo', 'video');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id  uuid NOT NULL REFERENCES walkthroughs(id),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  storage_key     text NOT NULL UNIQUE,
  kind            media_kind NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Create `server/db/init/005_field_capture_grants.sh`**

```sh
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON sites, walkthroughs, media TO compliance_swarm_app;
EOSQL
```

Make it executable: `chmod +x server/db/init/005_field_capture_grants.sh`.

- [ ] **Step 3: Add the media volume to `server/docker-compose.yml`**

In the `app` service, add a `volumes:` entry (alongside the existing `environment:`/`ports:`), and add `media_data` to the top-level `volumes:` block:

```yaml
  app:
    build: .
    container_name: compliance-swarm-app
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      PORT: ${PORT}
      TZ: ${TZ}
      DATABASE_URL: ${DATABASE_URL}
      COOKIE_SECRET: ${COOKIE_SECRET}
    ports:
      - "127.0.0.1:${PORT}:${PORT}"
    volumes:
      - media_data:/data/media
    networks:
      - compliance_swarm
```

Add `media_data:` under the file's top-level `volumes:` key, alongside the existing `postgres_data:`.

- [ ] **Step 4: Add a separate dev media volume to `server/docker-compose.dev.yml`**

Add an `app` override alongside the existing `postgres` override, giving dev its own volume so it's never confused with production's:

```yaml
  app:
    volumes:
      - media_data_dev:/data/media
```

Add `media_data_dev:` to a top-level `volumes:` key in this file (create the key if the file doesn't already have one).

- [ ] **Step 5: Bring up the dev stack and verify**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
sleep 3
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm -c "\dt"
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test -c "\dt"
```
Expected: `compliance_swarm` lists the four original tables plus `sites`, `walkthroughs`, `media`. `compliance_swarm_test` still only lists the four original tables — Step 6 fixes that.

- [ ] **Step 6: Manually apply the new schema to `compliance_swarm_test`**

`003_test_db.sh` (from an earlier plan) only ran the schema/grants that existed at the time it last executed — it doesn't retroactively pick up `004`/`005`. Apply them directly, the same way this plan's later production-migration task will:

```bash
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test < db/init/004_field_capture_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm_test compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/005_field_capture_grants.sh
```
Verify: `docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test -c "\dt"` now lists all seven tables.

- [ ] **Step 7: Verify the media volume is writable inside the container**

```bash
docker exec compliance-swarm-app-dev sh -c "touch /data/media/test-write && rm /data/media/test-write && echo OK"
```
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add server/db/init/004_field_capture_schema.sql server/db/init/005_field_capture_grants.sh server/docker-compose.yml server/docker-compose.dev.yml
git commit -m "Add sites/walkthroughs/media schema, grants, and storage volume"
```

---

### Task 2: Storage helper module and new dependencies

**Files:**
- Modify: `server/package.json`
- Create: `server/src/storage.js`
- Test: `server/test/storage.test.js`

**Interfaces:**
- Produces: `MEDIA_DIR` (string constant — `process.env.MEDIA_DIR` if set, else `/data/media`; the container always uses the default via its volume mount, tests running on the host override it with `MEDIA_DIR` pointed at a local scratch directory — see Task 5), `generateStorageKey(extension) -> string` (a random hex filename plus the given extension, e.g. `a1b2c3....jpg`), `resolveMediaPath(storageKey) -> string` (joins `MEDIA_DIR` with `storageKey`, rejecting any key containing a path separator or `..` as a defensive boundary check even though callers only ever pass server-generated keys).

- [ ] **Step 1: Add dependencies to `server/package.json`**

Add to `dependencies`:
```json
    "file-type": "^19.6.0",
    "multer": "^1.4.5-lts.1",
```
(Keep the existing `argon2`, `cookie-parser`, `express`, `pg` entries alphabetically ordered alongside these two.)

- [ ] **Step 2: Install and regenerate the lockfile**

```bash
cd server
npm install
```
This updates `package-lock.json` in place — the Stage 4 lockfile discipline (`npm ci` in the Dockerfile) means this must be committed alongside `package.json` in this task's commit, not left stale.

- [ ] **Step 3: Create `server/src/storage.js`**

```js
import crypto from 'node:crypto';
import path from 'node:path';

export const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';

export function generateStorageKey(extension) {
  const clean = extension.replace(/^\./, '').toLowerCase();
  return `${crypto.randomBytes(16).toString('hex')}.${clean}`;
}

export function resolveMediaPath(storageKey) {
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(storageKey)) {
    throw new Error(`Refusing to resolve an unexpected storage key: ${storageKey}`);
  }
  return path.join(MEDIA_DIR, storageKey);
}
```

- [ ] **Step 4: Write `server/test/storage.test.js` and run it**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageKey, resolveMediaPath, MEDIA_DIR } from '../src/storage.js';

test('generateStorageKey produces a 32-hex-char name with the given extension', () => {
  const key = generateStorageKey('.JPG');
  assert.match(key, /^[a-f0-9]{32}\.jpg$/);
});

test('generateStorageKey calls are unique', () => {
  const a = generateStorageKey('mp4');
  const b = generateStorageKey('mp4');
  assert.notEqual(a, b);
});

test('resolveMediaPath joins a valid key under MEDIA_DIR', () => {
  const key = generateStorageKey('jpg');
  assert.equal(resolveMediaPath(key), `${MEDIA_DIR}/${key}`);
});

test('resolveMediaPath rejects a key containing a path separator', () => {
  assert.throws(() => resolveMediaPath('../../etc/passwd'));
});

test('resolveMediaPath rejects a key that is not the expected shape', () => {
  assert.throws(() => resolveMediaPath('not-a-real-key'));
});
```

Run: `cd server && node --test test/storage.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/storage.js server/test/storage.test.js
git commit -m "Add storage helper module and multer/file-type dependencies"
```

---

### Task 3: Sites routes

**Files:**
- Create: `server/src/routes/sites.js`
- Modify: `server/src/app.js`
- Test: `server/test/sites.test.js`

**Interfaces:**
- Consumes: `authenticate(pool)`/`requireRole(...roles)` (backend foundation), `asyncRoute` (backend foundation).
- Produces: `POST /api/sites` (Owner/Admin only) → `201 { id, name, active }`. `GET /api/sites` (Supervisor, Owner/Admin) → `200 [{ id, name }]`, active-only, tenant-scoped, ordered by name.

- [ ] **Step 1: Create `server/src/routes/sites.js`**

```js
import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

export default function siteRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'name is required' } });
    }
    const { rows: [site] } = await pool.query(
      `INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id, name, active`,
      [req.user.tenantId, name.trim()],
    );
    res.status(201).json(site);
  }));

  router.get('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name FROM sites WHERE tenant_id = $1 AND active = true ORDER BY name`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  return router;
}
```

- [ ] **Step 2: Mount in `server/src/app.js`**

Add `import siteRoutes from './routes/sites.js';` and, after the existing `/api/users` mount:

```js
  app.use('/api/sites', siteRoutes({ pool }));
```

- [ ] **Step 3: Write `server/test/sites.test.js` and run it**

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

async function seedUserWithCookie(role, tenantName = 'Test Co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: tenant.id };
}

test('owner_admin can create a site', async () => {
  const { cookie } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).post('/api/sites').set('Cookie', [cookie]).send({ name: 'Main Shop' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Main Shop');
  assert.equal(res.body.active, true);
});

test('supervisor cannot create a site', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).post('/api/sites').set('Cookie', [cookie]).send({ name: 'Main Shop' });
  assert.equal(res.status, 403);
});

test('accounting cannot list sites', async () => {
  const { cookie } = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('supervisor can list active sites, sorted, tenant-scoped', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('supervisor');
  await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Zeta Site'), ($1, 'Alpha Site')`, [tenantId]);
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Other Tenant Site')`, [otherTenant.id]);

  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map(s => s.name), ['Alpha Site', 'Zeta Site']);
});

test('inactive sites are excluded from the list', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('owner_admin');
  await pool.query(`INSERT INTO sites (tenant_id, name, active) VALUES ($1, 'Retired Site', false)`, [tenantId]);
  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/sites.test.js`
Expected: PASS (5 tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/sites.js server/src/app.js server/test/sites.test.js
git commit -m "Add site management routes"
```

---

### Task 4: Walkthroughs routes

**Files:**
- Create: `server/src/routes/walkthroughs.js`
- Modify: `server/src/app.js`
- Test: `server/test/walkthroughs.test.js`

**Interfaces:**
- Consumes: `authenticate`/`requireRole`/`asyncRoute` (as above).
- Produces: `POST /api/walkthroughs` (Supervisor, Owner/Admin) → `201 { id, siteId, slot, notes, createdAt }`. `GET /api/walkthroughs` (Supervisor, Owner/Admin) → `200 [{ id, siteId, siteName, slot, notes, createdAt }]` (Supervisor sees only their own; Owner/Admin sees all in tenant). `GET /api/walkthroughs/today-status` (Supervisor) → `200 { morningDone, afternoonDone }`.

- [ ] **Step 1: Create `server/src/routes/walkthroughs.js`**

```js
import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

const VALID_SLOTS = ['morning', 'afternoon'];

export default function walkthroughRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const { siteId, slot, notes } = req.body ?? {};
    if (!siteId || !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'siteId and a valid slot are required' } });
    }
    const { rows: siteRows } = await pool.query(
      `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [siteId, req.user.tenantId],
    );
    if (siteRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown siteId' } });
    }
    const { rows: [walkthrough] } = await pool.query(
      `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, site_id AS "siteId", slot, notes, created_at AS "createdAt"`,
      [req.user.tenantId, siteId, req.user.id, slot, notes ?? ''],
    );
    res.status(201).json(walkthrough);
  }));

  router.get('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const scopedToSelf = req.user.role === 'supervisor';
    const { rows } = await pool.query(
      `SELECT w.id, w.site_id AS "siteId", s.name AS "siteName", w.slot, w.notes, w.created_at AS "createdAt"
       FROM walkthroughs w
       JOIN sites s ON s.id = w.site_id
       WHERE w.tenant_id = $1 AND ($2 = false OR w.supervisor_id = $3)
       ORDER BY w.created_at DESC`,
      [req.user.tenantId, scopedToSelf, req.user.id],
    );
    res.json(rows);
  }));

  router.get('/today-status', requireRole('supervisor'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT slot FROM walkthroughs
       WHERE tenant_id = $1 AND supervisor_id = $2
         AND created_at >= date_trunc('day', now())
         AND created_at < date_trunc('day', now()) + interval '1 day'`,
      [req.user.tenantId, req.user.id],
    );
    const slots = new Set(rows.map(r => r.slot));
    res.json({ morningDone: slots.has('morning'), afternoonDone: slots.has('afternoon') });
  }));

  return router;
}
```

- [ ] **Step 2: Mount in `server/src/app.js`**

Add `import walkthroughRoutes from './routes/walkthroughs.js';` and, after the `/api/sites` mount:

```js
  app.use('/api/walkthroughs', walkthroughRoutes({ pool }));
```

- [ ] **Step 3: Write `server/test/walkthroughs.test.js` and run it**

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

async function seedUserWithCookie(role, email = 'u@test.co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [tenant.id, email, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: tenant.id, userId: user.id };
}

async function seedSite(tenantId, name = 'Main Shop') {
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  return site.id;
}

test('supervisor can create a walkthrough for an active site in their tenant', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId, slot: 'morning', notes: 'all clear' });
  assert.equal(res.status, 201);
  assert.equal(res.body.slot, 'morning');
});

test('accounting cannot create a walkthrough', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('accounting');
  const siteId = await seedSite(tenantId);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('creating a walkthrough for a site in another tenant is rejected', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  const foreignSiteId = await seedSite(otherTenant.id);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId: foreignSiteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('supervisor sees only their own walkthroughs; owner_admin sees all', async () => {
  const supA = await seedUserWithCookie('supervisor', 'a@test.co');
  const siteId = await seedSite(supA.tenantId);
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning')`, [supA.tenantId, siteId, supA.userId]);

  const hash = await hashPassword('x');
  const { rows: [supB] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'b@test.co', $2, 'supervisor', 'B') RETURNING id`,
    [supA.tenantId, hash],
  );
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'afternoon')`, [supA.tenantId, siteId, supB.id]);

  const resA = await request(createApp()).get('/api/walkthroughs').set('Cookie', [supA.cookie]);
  assert.equal(resA.body.length, 1);
  assert.equal(resA.body[0].slot, 'morning');

  const { rows: [ownerRow] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'owner@test.co', $2, 'owner_admin', 'Owner') RETURNING id`,
    [supA.tenantId, hash],
  );
  const { token } = await createSession(pool, { userId: ownerRow.id, tenantId: supA.tenantId });
  const ownerCookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  const resOwner = await request(createApp()).get('/api/walkthroughs').set('Cookie', [ownerCookie]);
  assert.equal(resOwner.body.length, 2);
});

test('today-status reports morning and afternoon independently', async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning')`, [tenantId, siteId, userId]);

  const res = await request(createApp()).get('/api/walkthroughs/today-status').set('Cookie', [cookie]);
  assert.deepEqual(res.body, { morningDone: true, afternoonDone: false });
});

test("today-status does not count yesterday's walkthrough", async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  await pool.query(
    `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot, created_at)
     VALUES ($1, $2, $3, 'morning', now() - interval '1 day')`,
    [tenantId, siteId, userId],
  );
  const res = await request(createApp()).get('/api/walkthroughs/today-status').set('Cookie', [cookie]);
  assert.deepEqual(res.body, { morningDone: false, afternoonDone: false });
});
```

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/walkthroughs.test.js`
Expected: PASS (6 tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/walkthroughs.js server/src/app.js server/test/walkthroughs.test.js
git commit -m "Add walkthrough creation, listing, and today-status routes"
```

---

### Task 5: Media upload route

**Files:**
- Create: `server/src/routes/media.js` (upload handler only — Task 6 adds the retrieval handler to this same file)
- Modify: `server/src/app.js`
- Create: `server/test/fixtures/sample.jpg`
- Create: `server/test/fixtures/disguised.jpg`
- Test: `server/test/media.test.js`

**Interfaces:**
- Consumes: `MEDIA_DIR`/`generateStorageKey` (Task 2), `writeAudit` (backend foundation).
- Produces: `POST /api/walkthroughs/:id/media` (the walkthrough's own Supervisor, or Owner/Admin) → `201 { id, kind, mimeType, sizeBytes }` on success; `400 { error: { code: 'invalid_file_type', ... } }` on a magic-byte mismatch; `413` on oversized upload (multer's built-in limit, caught by the existing terminal error handler).

- [ ] **Step 1: Create the two test fixtures**

```bash
mkdir -p server/test/fixtures
# A minimal genuine 1x1 JPEG (valid magic bytes: FF D8 FF):
printf '\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xFF\xDB\x00\x43\x00' > server/test/fixtures/sample.jpg
head -c 200 /dev/urandom >> server/test/fixtures/sample.jpg
printf '\xFF\xD9' >> server/test/fixtures/sample.jpg
# A plain text file's bytes, named .jpg -- must be REJECTED by content verification:
printf 'this is not actually an image, just text with a .jpg name\n' > server/test/fixtures/disguised.jpg
```

- [ ] **Step 2: Create `server/src/routes/media.js` with the upload handler**

```js
import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs/promises';
import path from 'node:path';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';
import { MEDIA_DIR, generateStorageKey } from '../storage.js';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const ALLOWED = new Map([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/heic', 'photo'],
  ['image/heif', 'photo'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, generateStorageKey(ext));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

async function loadWalkthroughForCaller(pool, walkthroughId, user) {
  const scopedToSelf = user.role === 'supervisor';
  const { rows } = await pool.query(
    `SELECT id FROM walkthroughs WHERE id = $1 AND tenant_id = $2 AND ($3 = false OR supervisor_id = $4)`,
    [walkthroughId, user.tenantId, scopedToSelf, user.id],
  );
  return rows[0] ?? null;
}

export default function mediaRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/walkthroughs/:id/media', requireRole('supervisor', 'owner_admin'), upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'file is required' } });
    }
    const walkthrough = await loadWalkthroughForCaller(pool, req.params.id, req.user);
    if (!walkthrough) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ error: { code: 'not_found', message: 'walkthrough not found' } });
    }

    const detected = await fileTypeFromFile(req.file.path);
    const kind = detected && ALLOWED.get(detected.mime);
    if (!kind) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: { code: 'invalid_file_type', message: 'File content does not match an accepted photo or video type' } });
    }

    const tags = Array.isArray(req.body?.tags) ? req.body.tags : (req.body?.tags ? [req.body.tags] : []);
    const capturedAt = req.body?.capturedAt ? new Date(req.body.capturedAt) : null;

    const { rows: [media] } = await pool.query(
      `INSERT INTO media (walkthrough_id, tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes, tags, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, kind, mime_type AS "mimeType", size_bytes AS "sizeBytes"`,
      [walkthrough.id, req.user.tenantId, req.user.id, path.basename(req.file.path), kind, detected.mime, req.file.size, tags, capturedAt],
    );

    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'upload',
      targetType: 'media', targetId: media.id, metadata: { walkthroughId: walkthrough.id, kind },
    });

    res.status(201).json(media);
  }));

  return router;
}
```

- [ ] **Step 3: Mount in `server/src/app.js`**

Add `import mediaRoutes from './routes/media.js';` and, after the `/api/walkthroughs` mount:

```js
  app.use('/api', mediaRoutes({ pool }));
```

(Mounted at `/api`, not `/api/media`, because the upload route's own path already starts with `/walkthroughs/:id/media` — Task 6 adds a `/media/:id` route to this same router, which will correctly resolve to `/api/media/:id`.)

- [ ] **Step 4: Write `server/test/media.test.js` and run it**

```js
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';
import { MEDIA_DIR } from '../src/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_JPG = path.join(__dirname, 'fixtures', 'sample.jpg');
const DISGUISED_JPG = path.join(__dirname, 'fixtures', 'disguised.jpg');

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedWalkthrough(role = 'supervisor') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Shop') RETURNING id`, [tenant.id]);
  const { rows: [walkthrough] } = await pool.query(
    `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning') RETURNING id`,
    [tenant.id, site.id, user.id],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, walkthroughId: walkthrough.id, tenantId: tenant.id };
}

test('a genuine JPEG uploads successfully', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'photo');
  assert.equal(res.body.mimeType, 'image/jpeg');

  const { rows } = await pool.query(`SELECT storage_key FROM media WHERE id = $1`, [res.body.id]);
  const stat = await fs.stat(path.join(MEDIA_DIR, rows[0].storage_key));
  assert.ok(stat.isFile());
});

test('a text file renamed to .jpg is rejected by content verification, not left on disk', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();
  const filesBefore = await fs.readdir(MEDIA_DIR);

  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', DISGUISED_JPG);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_file_type');

  const { rows } = await pool.query(`SELECT count(*) FROM media`);
  assert.equal(rows[0].count, '0');

  const filesAfter = await fs.readdir(MEDIA_DIR);
  assert.equal(filesAfter.length, filesBefore.length);
});

test('accounting cannot upload media', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough('accounting');
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('uploading to a walkthrough in another tenant returns 404, not 403', async () => {
  const { walkthroughId } = await seedWalkthrough();
  const other = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [other.cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 404);
});

test('a successful upload writes an upload row to audit_log', async () => {
  const { cookie, walkthroughId, tenantId } = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);

  const { rows } = await pool.query(
    `SELECT event_type, target_type, target_id FROM audit_log WHERE tenant_id = $1 AND event_type = 'upload'`,
    [tenantId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_type, 'media');
  assert.equal(rows[0].target_id, res.body.id);
});
```

These tests write real files, and `MEDIA_DIR`'s default (`/data/media`) only exists inside the app container's filesystem via the Docker volume mount from Task 1 — it does not exist on the host, where every test in this plan actually runs (`node --test` directly, connecting to Postgres over the published port). Create a host-local scratch directory and point `MEDIA_DIR` at it for every test run from here on:

```bash
mkdir -p /tmp/compliance-swarm-test-media
```

Run: `cd server && MEDIA_DIR=/tmp/compliance-swarm-test-media DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/media.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/media.js server/src/app.js server/test/fixtures server/test/media.test.js
git commit -m "Add media upload route with magic-byte file-type verification"
```

---

### Task 6: Media retrieval route

**Files:**
- Modify: `server/src/routes/media.js` (add the retrieval handler to the same router)
- Test: `server/test/media.test.js` (add retrieval tests to the existing file)

**Interfaces:**
- Produces: `GET /api/media/:id` (the walkthrough's own Supervisor, or Owner/Admin) → streams the file with the correct `Content-Type` header; `404` for a nonexistent or cross-tenant/cross-supervisor id (never distinguished from "doesn't exist").

- [ ] **Step 1: Add the retrieval handler to `server/src/routes/media.js`**

First, update the `storage.js` import at the top of the file to also bring in `resolveMediaPath`:

```js
import { MEDIA_DIR, generateStorageKey, resolveMediaPath } from '../storage.js';
```

Then add this route inside the existing `mediaRoutes` function, after the upload route and before `return router;`:

```js
  router.get('/media/:id', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const scopedToSelf = req.user.role === 'supervisor';
    const { rows } = await pool.query(
      `SELECT m.storage_key, m.mime_type
       FROM media m
       JOIN walkthroughs w ON w.id = m.walkthrough_id
       WHERE m.id = $1 AND m.tenant_id = $2 AND ($3 = false OR w.supervisor_id = $4)`,
      [req.params.id, req.user.tenantId, scopedToSelf, req.user.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'media not found' } });
    }
    res.type(rows[0].mime_type);
    res.sendFile(resolveMediaPath(rows[0].storage_key));
  }));
```

- [ ] **Step 2: Add retrieval tests to `server/test/media.test.js`**

Append these tests to the file:

```js
test('the uploader can retrieve their own uploaded media with the correct content type', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();
  const upload = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);

  const res = await request(createApp()).get(`/api/media/${upload.body.id}`).set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.ok(res.body.length > 0 || res.text.length > 0);
});

test("a different supervisor cannot retrieve another supervisor's media", async () => {
  const owner = await seedWalkthrough('supervisor');
  const upload = await request(createApp())
    .post(`/api/walkthroughs/${owner.walkthroughId}/media`)
    .set('Cookie', [owner.cookie])
    .attach('file', SAMPLE_JPG);

  const stranger = await seedWalkthrough('supervisor');
  const res = await request(createApp()).get(`/api/media/${upload.body.id}`).set('Cookie', [stranger.cookie]);
  assert.equal(res.status, 404);
});

test('owner_admin can retrieve any media in their tenant', async () => {
  const sup = await seedWalkthrough('supervisor');
  const upload = await request(createApp())
    .post(`/api/walkthroughs/${sup.walkthroughId}/media`)
    .set('Cookie', [sup.cookie])
    .attach('file', SAMPLE_JPG);

  const hash = await hashPassword('x');
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'owner@test.co', $2, 'owner_admin', 'Owner')`,
    [sup.tenantId, hash],
  );
  const { rows: [ownerUser] } = await pool.query(`SELECT id FROM users WHERE email = 'owner@test.co'`);
  const { token } = await createSession(pool, { userId: ownerUser.id, tenantId: sup.tenantId });
  const ownerCookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;

  const res = await request(createApp()).get(`/api/media/${upload.body.id}`).set('Cookie', [ownerCookie]);
  assert.equal(res.status, 200);
});
```

Run: `cd server && MEDIA_DIR=/tmp/compliance-swarm-test-media DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/media.test.js`
Expected: PASS (8 tests total in this file)

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/media.js server/test/media.test.js
git commit -m "Add media retrieval route, authenticated and ownership-scoped"
```

---

### Task 7: Supervisor dashboard — real content

**Files:**
- Modify: `server/src/public/dashboard/supervisor.html` (replace the placeholder entirely)
- Test: `server/test/dashboard-routes.test.js` (add one assertion — the page now has real content)

**Interfaces:**
- Consumes: `GET /api/sites`, `GET /api/walkthroughs/today-status`, `POST /api/walkthroughs`, `POST /api/walkthroughs/:id/media` (all from prior tasks in this plan).

- [ ] **Step 1: Replace `server/src/public/dashboard/supervisor.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supervisor — Walkthrough</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 1rem; }
  .banner { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.95rem; }
  .banner.pending { background: #fdecea; color: #7a271a; }
  .banner.done { background: #e6f4ea; color: #1e4620; }
  fieldset { border: 1px solid #ccc; border-radius: 6px; margin-bottom: 1rem; }
  label { display: block; margin-top: 0.6rem; font-size: 0.9rem; }
  input, select, textarea { width: 100%; padding: 0.5rem; margin-top: 0.25rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: 0.6rem 1rem; margin-top: 0.75rem; font-size: 1rem; }
  #captureList { list-style: none; padding: 0; margin-top: 0.75rem; }
  #captureList li { padding: 0.4rem 0; border-bottom: 1px solid #eee; font-size: 0.9rem; display: flex; justify-content: space-between; }
  .ok { color: #1e4620; }
  .err { color: #7a271a; }
</style>
</head>
<body>
  <h1>Supervisor</h1>

  <div id="banners"></div>

  <fieldset>
    <legend>Start Walkthrough</legend>
    <form id="start-form">
      <label>Site
        <select name="siteId" id="siteSelect" required></select>
      </label>
      <label>Slot
        <select name="slot" id="slotSelect" required>
          <option value="morning">Morning</option>
          <option value="afternoon">Afternoon</option>
        </select>
      </label>
      <label>Notes
        <textarea name="notes" rows="2"></textarea>
      </label>
      <button type="submit">Start</button>
    </form>
  </fieldset>

  <fieldset id="captureSection" hidden>
    <legend>Capture</legend>
    <label>Add photo
      <input type="file" accept="image/*" capture="environment" id="photoInput">
    </label>
    <label>Add video
      <input type="file" accept="video/*" capture="environment" id="videoInput">
    </label>
    <ul id="captureList"></ul>
  </fieldset>

  <form onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>

  <script>
    let currentWalkthroughId = null;

    function nowSlotDefault() {
      return new Date().getHours() < 12 ? 'morning' : 'afternoon';
    }

    async function loadBanners() {
      const res = await fetch('/api/walkthroughs/today-status');
      if (!res.ok) return;
      const { morningDone, afternoonDone } = await res.json();
      const el = document.getElementById('banners');
      el.innerHTML = '';
      for (const [label, done] of [['Morning walkthrough', morningDone], ['Afternoon walkthrough', afternoonDone]]) {
        const div = document.createElement('div');
        div.className = 'banner ' + (done ? 'done' : 'pending');
        div.textContent = done ? `${label}: done ✓` : `${label}: not done yet`;
        el.appendChild(div);
      }
    }

    async function loadSites() {
      const res = await fetch('/api/sites');
      if (!res.ok) return;
      const sites = await res.json();
      const select = document.getElementById('siteSelect');
      select.innerHTML = '';
      for (const site of sites) {
        const opt = document.createElement('option');
        opt.value = site.id;
        opt.textContent = site.name;
        select.appendChild(opt);
      }
    }

    document.getElementById('slotSelect').value = nowSlotDefault();
    loadBanners();
    loadSites();

    document.getElementById('start-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const res = await fetch('/api/walkthroughs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: form.get('siteId'), slot: form.get('slot'), notes: form.get('notes') }),
      });
      if (res.ok) {
        const walkthrough = await res.json();
        currentWalkthroughId = walkthrough.id;
        document.getElementById('captureSection').hidden = false;
      }
    });

    async function uploadFile(file) {
      const li = document.createElement('li');
      li.textContent = file.name + ' — uploading…';
      document.getElementById('captureList').prepend(li);

      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/walkthroughs/${currentWalkthroughId}/media`, { method: 'POST', body });
      if (res.ok) {
        li.textContent = file.name + ' — uploaded ✓';
        li.className = 'ok';
      } else {
        li.textContent = file.name + ' — failed';
        li.className = 'err';
      }
    }

    document.getElementById('photoInput').addEventListener('change', (e) => {
      if (e.target.files[0]) uploadFile(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('videoInput').addEventListener('change', (e) => {
      if (e.target.files[0]) uploadFile(e.target.files[0]);
      e.target.value = '';
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Add one assertion to `server/test/dashboard-routes.test.js`**

Find the existing test asserting `200` for `GET /dashboard/supervisor` and extend its assertion to confirm the placeholder text is gone:

```js
  assert.doesNotMatch(res.text, /land here in a later build/);
```

Add this line to that existing test (do not create a new test — the route-level 200/403/401 coverage already exists from the backend foundation; this just confirms the content actually changed).

Run: `cd server && DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/dashboard-routes.test.js`
Expected: PASS (unchanged count, all green)

- [ ] **Step 3: Commit**

```bash
git add server/src/public/dashboard/supervisor.html server/test/dashboard-routes.test.js
git commit -m "Build the real Supervisor walkthrough capture screen"
```

---

### Task 8: Full local verification, then apply the schema migration to production

**Files:** none (verification and a database migration only)

**This task touches live production's database. Do not run Step 3 without running Steps 1-2 first and reading their output.**

- [ ] **Step 1: Run the full suite against the dev stack**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
mkdir -p /tmp/compliance-swarm-test-media
MEDIA_DIR=/tmp/compliance-swarm-test-media DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: every test from every task in this plan passes, plus the full pre-existing suite (no regressions).

- [ ] **Step 2: Confirm the schema files are idempotent by re-running them against dev**

```bash
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm < db/init/004_field_capture_schema.sql
```
Expected: no errors (every `CREATE TABLE IF NOT EXISTS` / guarded `DO` block is a no-op the second time). This is the proof the same file is safe to run against production's already-initialized database next.

- [ ] **Step 3: Apply the schema and grants to production**

```bash
docker exec -i compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm < server/db/init/004_field_capture_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm compliance-swarm-postgres bash /docker-entrypoint-initdb.d/005_field_capture_grants.sh
```
(The grants script needs to exist inside the running container to be invoked this way — if it isn't there yet because the container predates this plan's code, `docker cp server/db/init/005_field_capture_grants.sh compliance-swarm-postgres:/docker-entrypoint-initdb.d/005_field_capture_grants.sh` first.)

- [ ] **Step 4: Verify against production**

```bash
docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "\dt"
```
Expected: `sites`, `walkthroughs`, `media` now appear alongside the four original tables. Confirm existing data is untouched: `docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "SELECT count(*) FROM users;"` still returns the same count as before this task.

---

### Task 9: Deploy application code to production and smoke test

**Files:** none (deployment and verification only)

- [ ] **Step 1: Copy changed files to `/opt/compliance-swarm/` and add the media volume**

Copy every file this plan created or modified under `server/` (except `docker-compose.dev.yml`, which is dev-only) to the corresponding path under `/opt/compliance-swarm/` — individually, not via a directory `cp` that could nest incorrectly. Then:

```bash
cd /opt/compliance-swarm
docker compose up -d --build
```

- [ ] **Step 2: Verify the media volume exists and is writable**

```bash
docker exec compliance-swarm-app sh -c "touch /data/media/test-write && rm /data/media/test-write && echo OK"
```

- [ ] **Step 3: Smoke test the new routes live**

Using the seeded Endgrain owner credentials, confirm end-to-end: log in, create a site via `POST /api/sites`, start a walkthrough via `POST /api/walkthroughs`, upload a small real photo via `POST /api/walkthroughs/:id/media`, retrieve it via `GET /api/media/:id`, and confirm `https://compliance.808techserviceshi.cc/dashboard/supervisor` (if the seeded user's role allows, or a freshly-created Supervisor test account) shows the real capture screen, not the old placeholder text.

- [ ] **Step 4: Confirm no regressions**

```bash
curl -s https://compliance.808techserviceshi.cc/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://808techserviceshi.cc
```
Expected: `{"status":"ok"}` and `200` respectively — the existing app and the unrelated sites on the same host are both unaffected.
