# Owner-Assigned Walkthrough Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Owner/Admin assign a one-off walkthrough routine (site + slot + date) to a specific supervisor, surfaced as an informational reminder on that supervisor's dashboard — without touching how walkthroughs are created, completed, or counted as "done."

**Architecture:** A new `assignments` table, decoupled from `walkthroughs` (expected vs. actually-performed), with a case-insensitive-to-reassignment `UPSERT` on `(tenant_id, site_id, slot, assigned_date)`. Three new routes (`POST /api/assignments`, `GET /api/assignments`, `GET /api/assignments/today`) follow the exact `sites.js`/`walkthroughs.js` conventions already in this codebase. The Owner dashboard placeholder gets replaced with a real assign-form + today's-assignments table; the Supervisor dashboard gets one additive reminder section.

**Tech Stack:** Node.js/Express, `node:test` + `supertest`, PostgreSQL (raw `pg`, no ORM), vanilla HTML/JS (no build step) — matching the rest of `compliance-swarm`'s server.

**Spec:** `docs/superpowers/specs/2026-08-25-walkthrough-assignments-design.md`

## Global Constraints

- Every route requires an explicit `requireRole(...)` allow-list — a route with none is unreachable, not open (existing project-wide rule, unchanged here).
- Grants are applied per-table, explicitly, in a numbered `NNN_*_grants.sh` script under `server/db/init/` — this project relies on no default-privilege mechanism (confirmed by reading `005_field_capture_grants.sh`).
- `tenant_id` is denormalized onto every new row for one-indexed-lookup authorization checks, matching every existing table.
- Assignments are informational only — they must never restrict, gate, or validate against what a supervisor can otherwise do (no change to `walkthroughs.js`, no change to `today-status`).
- `created_at`/`created_by` on `assignments` are immutable (set once, excluded from any `UPDATE`/`ON CONFLICT SET`); `updated_at`/`updated_by` track the most recent reassignment. Do not collapse these back into two columns.
- `POST /api/assignments` always returns `200`, never `201` — this endpoint's semantic is "set the assignment," not "create a resource" (see spec).
- Production database is `compliance_swarm` on container `compliance-swarm-postgres`; the test database is `compliance_swarm_test` on `compliance-swarm-postgres-dev` (port 5433, via `docker-compose.dev.yml`). Never point `resetDb` or any test run at the non-`_test`-suffixed database — `resetDb`'s own `assertTestDatabaseName` guard already enforces this; do not weaken it.
- Migration files are numbered `006_assignments_schema.sql` / `007_assignments_grants.sh` — re-check `ls server/db/init/` immediately before creating them in Task 1 in case other work has claimed `006` since this plan was written.

---

### Task 1: Database schema, grants, and `resetDb` fix

**Files:**
- Create: `server/db/init/006_assignments_schema.sql`
- Create: `server/db/init/007_assignments_grants.sh`
- Modify: `server/test/helpers/db.js`

**Interfaces:**
- Produces: table `assignments` (columns: `id, tenant_id, site_id, supervisor_id, slot, assigned_date, created_by, created_at, updated_by, updated_at`; `UNIQUE (tenant_id, site_id, slot, assigned_date)`; index `assignments_supervisor_today_idx`). Reuses the `walkthrough_slot` enum type already created by `004_field_capture_schema.sql` — do not redefine it.
- Produces: `compliance_swarm_app` granted `SELECT, INSERT, UPDATE, DELETE` on `assignments`.
- Produces: `resetDb` deletes from `assignments` before `sites`/`users`/`tenants` (child-to-parent FK order) — Task 2's tests depend on this or every test after one that inserts an assignment will fail with a foreign-key violation (this exact class of bug was already hit once and fixed in the field-capture plan's Task 3, for `walkthroughs`/`media`/`sites`).

- [ ] **Step 1: Re-check migration numbering**

```bash
ls server/db/init/
```
Expected: `001_schema.sql 002_grants.sh 003_test_db.sh 004_field_capture_schema.sql 005_field_capture_grants.sh` and nothing numbered `006` or higher. If a `006` already exists, stop and pick the next free number instead of the one below (renumber this task's two new files accordingly, keeping schema before grants).

- [ ] **Step 2: Create `server/db/init/006_assignments_schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  supervisor_id   uuid NOT NULL REFERENCES users(id),
  slot            walkthrough_slot NOT NULL,
  assigned_date   date NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, slot, assigned_date)
);
CREATE INDEX IF NOT EXISTS assignments_supervisor_today_idx ON assignments (tenant_id, supervisor_id, assigned_date);
```

- [ ] **Step 3: Create `server/db/init/007_assignments_grants.sh`**

```bash
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON assignments TO compliance_swarm_app;
EOSQL
```

Make it executable: `chmod +x server/db/init/007_assignments_grants.sh`.

- [ ] **Step 4: Fix `resetDb` in `server/test/helpers/db.js`**

Add one line before the existing `DELETE FROM sites` (child-to-parent order — `assignments` references `sites`/`users`/`tenants`, so it must be deleted first):

```js
    await client.query('BEGIN');
    await client.query('DELETE FROM assignments');
    await client.query('DELETE FROM media');
```

(Only the new `DELETE FROM assignments` line is added; everything else in `resetDb` stays as-is.)

- [ ] **Step 5: Apply the new files to both dev databases**

The dev Postgres container must already be running (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` from an earlier task — bring it up if it isn't). `server/db/init` is a live bind mount into the container (confirmed: `docker-compose.yml` mounts `./db/init:/docker-entrypoint-initdb.d:ro,Z`), so new files are visible without a rebuild; `003_test_db.sh` only runs schema/grants that existed the first time the container's data volume was initialized, so `004`+ files must always be applied manually to both databases, same as the field-capture plan's Task 1 did:

```bash
cd server
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm < db/init/006_assignments_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/007_assignments_grants.sh

docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test < db/init/006_assignments_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm_test compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/007_assignments_grants.sh
```

- [ ] **Step 6: Verify**

```bash
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm -c "\dt"
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test -c "\dt"
```
Expected: both list `assignments` alongside the seven existing tables (eight total).

- [ ] **Step 7: Commit**

```bash
git add server/db/init/006_assignments_schema.sql server/db/init/007_assignments_grants.sh server/test/helpers/db.js
git commit -m "Add assignments schema, grants, and resetDb fix"
```

---

### Task 2: Assignments API routes

**Files:**
- Create: `server/src/routes/assignments.js`
- Modify: `server/src/app.js:9-11,118` (add the import and mount line)
- Test: `server/test/assignments.test.js`

**Interfaces:**
- Consumes: `assignments` table from Task 1; `authenticate(pool)` and `requireRole(...)` from `server/src/middleware/`; `asyncRoute` from `server/src/asyncRoute.js` — same imports every other route file uses.
- Produces: `POST /api/assignments`, `GET /api/assignments`, `GET /api/assignments/today` — response shapes exactly as below. Task 3 and Task 4's frontend code call these by these exact paths/shapes.

- [ ] **Step 1: Create `server/src/routes/assignments.js`**

```js
import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

const VALID_SLOTS = ['morning', 'afternoon'];

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export default function assignmentRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { supervisorId, siteId, slot, assignedDate } = req.body ?? {};
    if (!supervisorId || !siteId || !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'supervisorId, siteId, and a valid slot are required' } });
    }
    if (assignedDate !== undefined && assignedDate !== null && !isValidDateString(assignedDate)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'assignedDate must be a valid YYYY-MM-DD date' } });
    }
    const { rows: siteRows } = await pool.query(
      `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [siteId, req.user.tenantId],
    );
    if (siteRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown siteId' } });
    }
    const { rows: supervisorRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role = 'supervisor' AND disabled_at IS NULL`,
      [supervisorId, req.user.tenantId],
    );
    if (supervisorRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown or ineligible supervisorId' } });
    }
    const { rows: [assignment] } = await pool.query(
      `INSERT INTO assignments (tenant_id, site_id, supervisor_id, slot, assigned_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $6)
       ON CONFLICT (tenant_id, site_id, slot, assigned_date)
       DO UPDATE SET supervisor_id = EXCLUDED.supervisor_id, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, site_id AS "siteId", supervisor_id AS "supervisorId", slot,
                 assigned_date AS "assignedDate", created_at AS "createdAt", created_by AS "createdBy",
                 updated_at AS "updatedAt", updated_by AS "updatedBy"`,
      [req.user.tenantId, siteId, supervisorId, slot, assignedDate ?? null, req.user.id],
    );
    res.status(200).json(assignment);
  }));

  router.get('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { date, siteId } = req.query;
    if (date !== undefined && !isValidDateString(date)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'date must be a valid YYYY-MM-DD date' } });
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.site_id AS "siteId", s.name AS "siteName", a.supervisor_id AS "supervisorId",
              u.display_name AS "supervisorName", a.slot, a.assigned_date AS "assignedDate"
       FROM assignments a
       JOIN sites s ON s.id = a.site_id
       JOIN users u ON u.id = a.supervisor_id
       WHERE a.tenant_id = $1
         AND a.assigned_date = COALESCE($2::date, CURRENT_DATE)
         AND ($3::uuid IS NULL OR a.site_id = $3)
       ORDER BY s.name, a.slot`,
      [req.user.tenantId, date ?? null, siteId ?? null],
    );
    res.json(rows);
  }));

  router.get('/today', requireRole('supervisor'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.site_id AS "siteId", s.name AS "siteName", a.slot
       FROM assignments a
       JOIN sites s ON s.id = a.site_id
       WHERE a.tenant_id = $1 AND a.supervisor_id = $2 AND a.assigned_date = CURRENT_DATE
       ORDER BY a.slot`,
      [req.user.tenantId, req.user.id],
    );
    res.json(rows);
  }));

  return router;
}
```

- [ ] **Step 2: Mount the new route in `server/src/app.js`**

Add the import alongside the other route imports (near line 9):

```js
import assignmentRoutes from './routes/assignments.js';
```

Add the mount line alongside the other `/api/*` mounts (near line 118, right after the `siteRoutes` line — note `GET /today` must be reachable at `/api/assignments/today`, which this mount path already gives it since Express matches `/today` as a sub-path, not a query string):

```js
  app.use('/api/assignments', assignmentRoutes({ pool }));
```

- [ ] **Step 3: Write `server/test/assignments.test.js`**

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

async function seedUserWithCookie(role, tenantId, email) {
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
    resolvedTenantId = tenant.id;
  }
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [resolvedTenantId, email ?? `${role}@test.co`, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: resolvedTenantId });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: resolvedTenantId, userId: user.id };
}

async function seedSite(tenantId, name = 'Main Shop') {
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  return site.id;
}

test('owner_admin can assign a walkthrough to a supervisor', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.supervisorId, sup.userId);
  assert.equal(res.body.assignedDate, '2026-09-01');
});

test('accounting cannot create an assignment', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const accounting = await seedUserWithCookie('accounting', owner.tenantId, 'acct@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [accounting.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('supervisor cannot create an assignment', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [sup.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('assigning to an unknown siteId is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId: '00000000-0000-0000-0000-000000000000', slot: 'morning' });
  assert.equal(res.status, 400);
});

test('assigning to a non-supervisor user is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const siteId = await seedSite(owner.tenantId);
  const accounting = await seedUserWithCookie('accounting', owner.tenantId, 'acct@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: accounting.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('assigning to a disabled supervisor is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [sup.userId]);
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('a malformed assignedDate is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-02-30' });
  assert.equal(res.status, 400);
});

test('reassigning the same site+slot+date replaces the row: 200 both times, immutable created fields, mutable updated fields', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const supA = await seedUserWithCookie('supervisor', owner.tenantId, 'a@test.co');
  const supB = await seedUserWithCookie('supervisor', owner.tenantId, 'b@test.co');
  const siteId = await seedSite(owner.tenantId);

  const first = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supA.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(first.status, 200);

  const second = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supB.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.supervisorId, supB.userId);
  assert.equal(second.body.createdAt, first.body.createdAt);
  assert.equal(second.body.createdBy, first.body.createdBy);
  assert.notEqual(second.body.updatedAt, first.body.updatedAt);
  assert.equal(second.body.updatedBy, owner.userId);

  const listRes = await request(createApp()).get('/api/assignments?date=2026-09-01').set('Cookie', [owner.cookie]);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].supervisorId, supB.userId);
});

test('GET /api/assignments is tenant-scoped and supports siteId/date filters', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId, 'Site A');
  const otherSiteId = await seedSite(owner.tenantId, 'Site B');
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId: otherSiteId, slot: 'afternoon', assignedDate: '2026-09-01' });

  const otherOwner = await seedUserWithCookie('owner_admin', undefined, 'otherowner@test.co');
  const otherSup = await seedUserWithCookie('supervisor', otherOwner.tenantId, 'othersup@test.co');
  const foreignSiteId = await seedSite(otherOwner.tenantId);
  await request(createApp()).post('/api/assignments').set('Cookie', [otherOwner.cookie])
    .send({ supervisorId: otherSup.userId, siteId: foreignSiteId, slot: 'morning', assignedDate: '2026-09-01' });

  const all = await request(createApp()).get('/api/assignments?date=2026-09-01').set('Cookie', [owner.cookie]);
  assert.equal(all.body.length, 2);

  const filtered = await request(createApp()).get(`/api/assignments?date=2026-09-01&siteId=${siteId}`).set('Cookie', [owner.cookie]);
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].siteName, 'Site A');
});

test('GET /api/assignments/today returns only the caller\'s own assignments for today', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const supA = await seedUserWithCookie('supervisor', owner.tenantId, 'a@test.co');
  const supB = await seedUserWithCookie('supervisor', owner.tenantId, 'b@test.co');
  const siteId = await seedSite(owner.tenantId);
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supA.userId, siteId, slot: 'morning' });
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supB.userId, siteId, slot: 'afternoon' });

  const resA = await request(createApp()).get('/api/assignments/today').set('Cookie', [supA.cookie]);
  assert.equal(resA.body.length, 1);
  assert.equal(resA.body[0].slot, 'morning');

  const resB = await request(createApp()).get('/api/assignments/today').set('Cookie', [supB.cookie]);
  assert.equal(resB.body.length, 1);
  assert.equal(resB.body[0].slot, 'afternoon');
});

test('GET /api/assignments/today returns an empty array when nothing is assigned', async () => {
  const sup = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/api/assignments/today').set('Cookie', [sup.cookie]);
  assert.deepEqual(res.body, []);
});
```

- [ ] **Step 4: Run the new test file**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/assignments.test.js
```
Expected: PASS, all 11 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: PASS, 84 pre-existing + 11 new = 95 total, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/assignments.js server/src/app.js server/test/assignments.test.js
git commit -m "Add owner-assigned walkthrough routine API"
```

---

### Task 3: Owner dashboard — real content

**Files:**
- Modify: `server/src/public/dashboard/owner.html` (replace the placeholder entirely)
- Test: `server/test/dashboard-routes.test.js` (add one assertion — the page now has real content)

**Interfaces:**
- Consumes: `GET /api/users`, `GET /api/sites`, `POST /api/assignments`, `GET /api/assignments` (Task 2 and pre-existing routes).

- [ ] **Step 1: Replace `server/src/public/dashboard/owner.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner — Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 1rem; }
  fieldset { border: 1px solid #ccc; border-radius: 6px; margin-bottom: 1rem; }
  label { display: block; margin-top: 0.6rem; font-size: 0.9rem; }
  input, select { width: 100%; padding: 0.5rem; margin-top: 0.25rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: 0.6rem 1rem; margin-top: 0.75rem; font-size: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
  th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  .msg { padding: 0.5rem 0.75rem; border-radius: 6px; margin-top: 0.75rem; font-size: 0.9rem; }
  .msg.ok { background: #e6f4ea; color: #1e4620; }
  .msg.err { background: #fdecea; color: #7a271a; }
</style>
</head>
<body>
  <h1>Owner / Admin</h1>

  <fieldset>
    <legend>Assign a Walkthrough</legend>
    <form id="assign-form">
      <label>Supervisor
        <select name="supervisorId" id="supervisorSelect" required></select>
      </label>
      <label>Site
        <select name="siteId" id="siteSelect" required></select>
      </label>
      <label>Slot
        <select name="slot" id="slotSelect" required>
          <option value="morning">Morning</option>
          <option value="afternoon">Afternoon</option>
        </select>
      </label>
      <label>Date
        <input type="date" name="assignedDate" id="dateInput" required>
      </label>
      <button type="submit">Assign</button>
    </form>
    <div id="assignMsg"></div>
  </fieldset>

  <fieldset>
    <legend>Today's Assignments</legend>
    <table>
      <thead><tr><th>Site</th><th>Supervisor</th><th>Slot</th></tr></thead>
      <tbody id="assignmentsBody"></tbody>
    </table>
  </fieldset>

  <form onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>

  <script>
    function todayLocalDate() {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async function loadSupervisors() {
      const res = await fetch('/api/users');
      if (!res.ok) return;
      const users = await res.json();
      const select = document.getElementById('supervisorSelect');
      select.innerHTML = '';
      for (const user of users) {
        if (user.role !== 'supervisor' || user.disabledAt) continue;
        const opt = document.createElement('option');
        opt.value = user.id;
        opt.textContent = user.displayName;
        select.appendChild(opt);
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

    async function loadTodaysAssignments() {
      const res = await fetch('/api/assignments');
      if (!res.ok) return;
      const rows = await res.json();
      const tbody = document.getElementById('assignmentsBody');
      tbody.innerHTML = '';
      for (const a of rows) {
        const tr = document.createElement('tr');
        const siteTd = document.createElement('td');
        siteTd.textContent = a.siteName;
        const supTd = document.createElement('td');
        supTd.textContent = a.supervisorName;
        const slotTd = document.createElement('td');
        slotTd.textContent = a.slot;
        tr.append(siteTd, supTd, slotTd);
        tbody.appendChild(tr);
      }
    }

    document.getElementById('dateInput').value = todayLocalDate();
    loadSupervisors();
    loadSites();
    loadTodaysAssignments();

    document.getElementById('assign-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const res = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supervisorId: form.get('supervisorId'),
          siteId: form.get('siteId'),
          slot: form.get('slot'),
          assignedDate: form.get('assignedDate'),
        }),
      });
      const msg = document.getElementById('assignMsg');
      if (res.ok) {
        msg.textContent = 'Assigned.';
        msg.className = 'msg ok';
        loadTodaysAssignments();
      } else {
        msg.textContent = 'Could not assign — check the fields.';
        msg.className = 'msg err';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Add one assertion to `server/test/dashboard-routes.test.js`**

Find the existing `'accounting hitting their own dashboard gets 200'` test's sibling for the owner role — there is currently no direct `GET /dashboard/owner` 200 test (only the placeholder page exists today, untested for content). Add a new test mirroring the pattern used for supervisor in the same file:

```js
test('owner_admin hitting their own dashboard gets 200 with real content', async () => {
  const cookie = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).get('/dashboard/owner').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /land here in a later build/);
});
```

Run: `cd server && MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/dashboard-routes.test.js`
Expected: PASS (6 tests total in this file — 5 pre-existing + 1 new).

- [ ] **Step 3: Commit**

```bash
git add server/src/public/dashboard/owner.html server/test/dashboard-routes.test.js
git commit -m "Build the real Owner/Admin walkthrough-assignment screen"
```

---

### Task 4: Supervisor dashboard — assignment reminder

**Files:**
- Modify: `server/src/public/dashboard/supervisor.html` (additive only — do not touch the existing start-walkthrough/capture flow)

**Interfaces:**
- Consumes: `GET /api/assignments/today` (Task 2).

No automated test for this step: this codebase doesn't unit-test frontend JS behavior anywhere (Tasks 3/4/7's own test additions only assert page-level content via server-rendered HTML text, which doesn't apply here since nothing is being removed — this section is purely additive markup). `GET /api/assignments/today`'s data-shape correctness is already fully covered by Task 2's `assignments.test.js`.

- [ ] **Step 1: Add a reminders container to `server/src/public/dashboard/supervisor.html`**

Add one line right after the existing `<div id="banners"></div>`:

```html
  <div id="banners"></div>
  <div id="assignmentReminders"></div>
```

- [ ] **Step 2: Add the reminder styling to the existing `<style>` block**

Add this rule alongside the existing `.banner.pending`/`.banner.done` rules:

```css
  .banner.reminder { background: #e8f0fe; color: #1a3a6b; }
```

- [ ] **Step 3: Add a `loadAssignments()` function and call it alongside `loadBanners()`/`loadSites()`**

```js
    async function loadAssignments() {
      const res = await fetch('/api/assignments/today');
      if (!res.ok) return;
      const rows = await res.json();
      const el = document.getElementById('assignmentReminders');
      el.innerHTML = '';
      for (const a of rows) {
        const div = document.createElement('div');
        div.className = 'banner reminder';
        div.textContent = `Assigned to you today: ${a.siteName} (${a.slot === 'morning' ? 'Morning' : 'Afternoon'})`;
        el.appendChild(div);
      }
    }
```

Change the existing call site:

```js
    document.getElementById('slotSelect').value = nowSlotDefault();
    loadBanners();
    loadSites();
    loadAssignments();
```

- [ ] **Step 4: Manually verify against the running dev stack**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```
Log in as a seeded supervisor (or create one via the owner dashboard's user-management screen, if seeded test data exists), confirm the reminders section renders nothing when no assignment exists for today, then create an assignment for that supervisor via the owner dashboard (Task 3) and reload the supervisor dashboard to confirm the reminder line appears and is styled distinctly from the pending/done banners.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: PASS, same count as after Task 3 (this task adds no new automated tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/public/dashboard/supervisor.html
git commit -m "Show today's owner-assigned walkthroughs as a reminder on the supervisor dashboard"
```

---

### Task 5: Full local verification, then apply the schema migration to production

**Files:** none (verification and a database migration only)

**This task touches live production's database. Do not run Step 3 without running Steps 1-2 first and reading their output. Steps 3-4 require explicit human authorization before running — the executing agent must stop and ask, not proceed automatically, even if Steps 1-2 are clean.**

- [ ] **Step 1: Run the full suite against the dev stack**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: every test from every task in this plan passes, plus the full pre-existing suite (no regressions) — 96/96 (84 pre-existing + 11 from Task 2 + 1 from Task 3; Task 4 adds no automated tests).

- [ ] **Step 2: Confirm the schema file is idempotent by re-running it against dev**

```bash
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm < db/init/006_assignments_schema.sql
```
Expected: no errors (the `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are no-ops the second time). This is the proof the same file is safe to run against production's already-initialized database next.

- [ ] **Step 3: Apply the schema and grants to production**

**Stop here and get explicit human confirmation before proceeding — this step writes to the live production database.**

```bash
docker exec -i compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm < server/db/init/006_assignments_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm compliance-swarm-postgres bash /docker-entrypoint-initdb.d/007_assignments_grants.sh
```
(The grants script needs to exist inside the running container to be invoked this way — if it isn't there yet because production's deployment directory predates this plan's code, `docker cp server/db/init/007_assignments_grants.sh compliance-swarm-postgres:/docker-entrypoint-initdb.d/007_assignments_grants.sh` first.)

- [ ] **Step 4: Verify against production**

```bash
docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "\dt"
```
Expected: `assignments` now appears alongside the seven original tables. Confirm existing data is untouched: `docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "SELECT count(*) FROM users;"` still returns the same count as before this task.

---

### Task 6: Deploy application code to production and smoke test

**Files:** none (deployment and verification only)

- [ ] **Step 1: Copy changed files to `/opt/compliance-swarm/`**

Copy every file this plan created or modified under `server/` to the corresponding path under `/opt/compliance-swarm/` — individually, not via a directory `cp` that could nest incorrectly: `server/db/init/006_assignments_schema.sql`, `server/db/init/007_assignments_grants.sh`, `server/test/helpers/db.js`, `server/src/routes/assignments.js`, `server/src/app.js`, `server/test/assignments.test.js`, `server/src/public/dashboard/owner.html`, `server/test/dashboard-routes.test.js`, `server/src/public/dashboard/supervisor.html`. Then:

```bash
cd /opt/compliance-swarm
docker compose up -d --build
```

- [ ] **Step 2: Smoke test the new routes live**

Using the seeded Owner/Admin credentials, confirm end-to-end: log in, assign a walkthrough to a real supervisor via the Owner dashboard's new form, confirm `https://compliance.808techserviceshi.cc/dashboard/owner` shows the real assign screen (not the old placeholder text) and lists the new assignment in the table, then log in as that supervisor and confirm `https://compliance.808techserviceshi.cc/dashboard/supervisor` shows the "Assigned to you today" reminder.

- [ ] **Step 3: Confirm no regressions**

```bash
curl -s https://compliance.808techserviceshi.cc/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://808techserviceshi.cc
```
Expected: `{"status":"ok"}` and `200` respectively — the existing app and the unrelated sites on the same host are both unaffected.
