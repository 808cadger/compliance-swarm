# Accounting Receipt/Invoice Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Accounting its first real feature — capture a photo of a receipt or invoice and have it filed, with Owner/Admin able to view (but not add or delete) everything filed tenant-wide.

**Architecture:** A new `receipts` table, deliberately separate from `media` (same reasoning that kept `assignments` separate from `walkthroughs`: `media`'s retrieval route builds its authorization entirely around joining through `walkthroughs`, and a receipt has no walkthrough to belong to). Reuses `storage.js`'s existing, generic storage primitives. Along the way, fixes a real pre-existing gap in `media.js`'s HEIC/HEIF detection found during design.

**Tech Stack:** Node.js/Express, `node:test` + `supertest`, PostgreSQL (raw `pg`), `multer` + `file-type` for upload verification, vanilla HTML/JS — matching the rest of this server.

**Spec:** `docs/superpowers/specs/2026-08-29-receipts-capture-design.md`

## Global Constraints

- Every route requires an explicit `requireRole(...)` allow-list — a route with none is unreachable, not open.
- **Permissions, stated explicitly per the spec (a documentation gap the spec itself was revised to close):** Accounting gets full CRUD (create, view, delete) on receipts. Owner/Admin gets view only (list + retrieve) — no create, no delete. Supervisor gets 403 on **every** verb, including reads — not just writes.
- `tenant_id` is denormalized onto the `receipts` table for one-indexed-lookup authorization, matching every existing table.
- Cross-tenant access is always 404, never 403, matching every existing route's discipline.
- A DB `INSERT` failure after successful file-type verification must unlink the already-written file before propagating the error — otherwise a verified file sits on disk with no DB row ever pointing at it.
- A DB `DELETE` must remove the file from disk after the row is deleted (not before) — if the unlink itself fails for an unrelated reason, the result is a harmless orphaned file, never an orphaned DB row pointing at an inaccessible file.
- Grants are per-table, explicit, in a numbered `NNN_*_grants.sh` script — no default-privilege mechanism is used in this project.
- Migration files are numbered `008_receipts_schema.sql` / `009_receipts_grants.sh` — re-verify via `ls server/db/init/` immediately before creating them in case other work has claimed those numbers since this plan was written (confirmed free as of this writing).
- The `receipts` table has **no** `walkthrough_id` and is never joined against `walkthroughs` — do not retrofit that relationship.

---

### Task 1: Database schema, grants, and `resetDb` fix

**Files:**
- Create: `server/db/init/008_receipts_schema.sql`
- Create: `server/db/init/009_receipts_grants.sh`
- Modify: `server/test/helpers/db.js`

**Interfaces:**
- Produces: table `receipts` (columns: `id, tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes, created_at`; reuses the existing `receipt_kind` — no wait, this is a **new** enum type `receipt_kind` with values `'receipt', 'invoice'`).
- Produces: `compliance_swarm_app` granted `SELECT, INSERT, UPDATE, DELETE` on `receipts`.
- Produces: `resetDb` deletes from `receipts` before `sites`/`users`/`tenants` (child-to-parent FK order) — Task 3's tests depend on this or every test after one that inserts a receipt will fail with a foreign-key violation, the same class of bug already hit and fixed twice before in this repo's history (field-capture's Task 3, walkthrough-assignments' Task 1).

- [ ] **Step 1: Re-check migration numbering**

```bash
ls server/db/init/
```
Expected: `001_schema.sql 002_grants.sh 003_test_db.sh 004_field_capture_schema.sql 005_field_capture_grants.sh 006_assignments_schema.sql 007_assignments_grants.sh` and nothing numbered `008` or higher. If a `008` already exists, stop and pick the next free number instead (renumber this task's two new files accordingly, keeping schema before grants).

- [ ] **Step 2: Create `server/db/init/008_receipts_schema.sql`**

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'receipt_kind') THEN
    CREATE TYPE receipt_kind AS ENUM ('receipt', 'invoice');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  storage_key   text NOT NULL UNIQUE,
  kind          receipt_kind NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 3: Create `server/db/init/009_receipts_grants.sh`**

```bash
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON receipts TO compliance_swarm_app;
EOSQL
```

Make it executable: `chmod +x server/db/init/009_receipts_grants.sh`.

- [ ] **Step 4: Fix `resetDb` in `server/test/helpers/db.js`**

Add one line before the existing `DELETE FROM assignments` (child-to-parent order — `receipts` references `users`/`tenants`, so it must be deleted before them; its position relative to `assignments`/`media`/`walkthroughs`/`sites` doesn't matter since there's no FK relationship between them):

```js
    await client.query('BEGIN');
    await client.query('DELETE FROM receipts');
    await client.query('DELETE FROM assignments');
```

(Only the new `DELETE FROM receipts` line is added; everything else in `resetDb` stays as-is.)

- [ ] **Step 5: Apply the new files to both dev databases**

The dev Postgres container must already be running (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` from `server/` — bring it up if it isn't). `server/db/init` is a live bind mount into the container, so new files are visible without a rebuild; `003_test_db.sh` only runs the schema/grants that existed the first time the container's data volume was initialized, so `004`+ files must always be applied manually to both databases:

```bash
cd server
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm < db/init/008_receipts_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/009_receipts_grants.sh

docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test < db/init/008_receipts_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm_test compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/009_receipts_grants.sh
```

- [ ] **Step 6: Verify**

```bash
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm -c "\dt"
docker exec compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm_test -c "\dt"
```
Expected: both list `receipts` alongside the eight existing tables (nine total).

- [ ] **Step 7: Commit**

```bash
git add server/db/init/008_receipts_schema.sql server/db/init/009_receipts_grants.sh server/test/helpers/db.js
git commit -m "Add receipts schema, grants, and resetDb fix"
```

---

### Task 2: Fix `media.js`'s incomplete HEIC/HEIF detection

**Files:**
- Modify: `server/src/routes/media.js:15-22` (the `ALLOWED` map)
- Test: `server/test/media.test.js` (add one new test)

**Interfaces:**
- No new interfaces — this only widens which MIME types `media.js`'s existing upload route accepts.

**Background:** `file-type`'s actual detection logic (`node_modules/file-type/core.js`) distinguishes HEIC-family files into four MIME types by their internal brand marker, not two: `mif1` brand → `image/heif`, `heic`/`heix` brand → `image/heic` (a normal single Apple photo), `msf1` brand → `image/heif-sequence`, `hevc`/`hevx` brand → `image/heic-sequence` (an Apple Live Photo — default-on for most iPhones). `media.js`'s `ALLOWED` map only accepts the first two.

- [ ] **Step 1: Widen `media.js`'s `ALLOWED` map**

In `server/src/routes/media.js`, change:

```js
const ALLOWED = new Map([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/heic', 'photo'],
  ['image/heif', 'photo'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
]);
```

to:

```js
const ALLOWED = new Map([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/heic', 'photo'],
  ['image/heif', 'photo'],
  ['image/heic-sequence', 'photo'],
  ['image/heif-sequence', 'photo'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
]);
```

- [ ] **Step 2: Add a test proving the fix, using a synthetic buffer (no new binary fixture needed)**

This exact 20-byte ISO-BMFF `ftyp` box construction was verified directly against the installed `file-type` version to produce the four brand/MIME pairs named above — add this test to `server/test/media.test.js`, after the existing `'a genuine JPEG uploads successfully'` test:

```js
test('an iPhone Live Photo (HEIC-sequence brand) is accepted, not rejected', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();

  // Minimal ISO-BMFF ftyp box with the 'hevc' major brand — the brand Apple's HEIC container
  // format uses for Live Photos specifically (a still bundled with a short motion clip).
  // Verified directly against the installed file-type version to produce
  // { ext: 'heic', mime: 'image/heic-sequence' }.
  const livePhotoBuffer = Buffer.alloc(20);
  livePhotoBuffer.writeUInt32BE(20, 0);
  livePhotoBuffer.write('ftyp', 4, 'ascii');
  livePhotoBuffer.write('hevc', 8, 'ascii');
  livePhotoBuffer.writeUInt32BE(0, 12);
  livePhotoBuffer.write('hevc', 16, 'ascii');

  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', livePhotoBuffer, 'live-photo.heic');

  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'photo');
  assert.equal(res.body.mimeType, 'image/heic-sequence');
});
```

- [ ] **Step 3: Run the test file**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/media.test.js
```
Expected: PASS, 10 tests total in this file (9 pre-existing + 1 new).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/media.js server/test/media.test.js
git commit -m "Accept HEIC/HEIF -sequence variants (iPhone Live Photos) in media uploads"
```

---

### Task 3: Receipts API routes

**Files:**
- Create: `server/src/routes/receipts.js`
- Modify: `server/src/app.js` (add the import and mount line)
- Test: `server/test/receipts.test.js`

**Interfaces:**
- Consumes: `receipts` table from Task 1; `authenticate(pool)`/`requireRole(...)` from `server/src/middleware/`; `asyncRoute` from `server/src/asyncRoute.js`; `storage.js`'s `MEDIA_DIR`/`generateStorageKey`/`resolveMediaPath` — imported as a **namespace** (`import * as storage from '../storage.js'`), not named imports. This is deliberate, not a style choice: a later best-effort test needs something to attach a mock to, and named imports (destructured bindings) can't be intercepted the way a namespace object's properties can — even though the specific mock this plan attempted (`t.mock.method`) turned out not to work either (see Task 3's testing notes), the namespace-import form is kept for consistency with how it was verified/explored, and because it costs nothing.
- Produces: `POST /api/receipts`, `GET /api/receipts`, `GET /api/receipts/:id`, `DELETE /api/receipts/:id` — response shapes exactly as below. Task 4 and Task 5's frontend code call these by these exact paths/shapes.

- [ ] **Step 1: Create `server/src/routes/receipts.js`**

```js
import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs/promises';
import path from 'node:path';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import * as storage from '../storage.js';

const VALID_KINDS = ['receipt', 'invoice'];

// Same four HEIC-family MIME types Task 2 added to media.js's ALLOWED map, for the same
// reason (an iPhone Live Photo must not be silently rejected). No video, no raw PDF upload —
// this route is for camera-captured photos only, per the design spec.
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

// Overridable so tests can exercise the 413 path without uploading a real 500MB file — same
// convention as media.js's own MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 500 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: storage.MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, storage.generateStorageKey(ext));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export default function receiptRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post(
    '/',
    requireRole('accounting'),
    upload.single('file'),
    // Same MulterError-translation precedent as media.js: a size-limit rejection carries no
    // .status/.statusCode, so left unhandled it would fall through to a generic 500.
    (err, req, res, next) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: { code: 'file_too_large', message: `File exceeds the ${MAX_UPLOAD_BYTES} byte limit` } });
      }
      next(err);
    },
    asyncRoute(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: { code: 'bad_request', message: 'file is required' } });
      }
      const kind = req.body?.kind;
      if (!VALID_KINDS.includes(kind)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: { code: 'bad_request', message: 'kind must be receipt or invoice' } });
      }

      const detected = await fileTypeFromFile(req.file.path);
      if (!detected || !ALLOWED.has(detected.mime)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: { code: 'invalid_file_type', message: 'File content does not match an accepted image type' } });
      }

      let receipt;
      try {
        ({ rows: [receipt] } = await pool.query(
          `INSERT INTO receipts (tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, kind, mime_type AS "mimeType", size_bytes AS "sizeBytes", created_at AS "createdAt"`,
          [req.user.tenantId, req.user.id, path.basename(req.file.path), kind, detected.mime, req.file.size],
        ));
      } catch (err) {
        // A verified file must never sit on disk with no DB row pointing at it — same
        // discipline as the reject-and-delete path just above, triggered by a different
        // failure point (a DB error after verification already passed, e.g. a connection
        // blip or constraint violation).
        await fs.unlink(req.file.path).catch(() => {});
        throw err;
      }

      res.status(201).json(receipt);
    }),
  );

  router.get('/', requireRole('accounting', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.kind, r.mime_type AS "mimeType", r.size_bytes AS "sizeBytes",
              r.uploaded_by AS "uploadedBy", u.display_name AS "uploadedByName",
              r.created_at AS "createdAt"
       FROM receipts r
       JOIN users u ON u.id = r.uploaded_by
       WHERE r.tenant_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  router.get('/:id', requireRole('accounting', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT storage_key, mime_type FROM receipts WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'receipt not found' } });
    }
    res.type(rows[0].mime_type);
    res.sendFile(storage.resolveMediaPath(rows[0].storage_key));
  }));

  router.delete('/:id', requireRole('accounting'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM receipts WHERE id = $1 AND tenant_id = $2 RETURNING storage_key`,
      [req.params.id, req.user.tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'receipt not found' } });
    }
    try {
      await fs.unlink(storage.resolveMediaPath(rows[0].storage_key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    res.status(204).end();
  }));

  return router;
}
```

- [ ] **Step 2: Mount the new route in `server/src/app.js`**

Add the import alongside the other route imports:

```js
import receiptRoutes from './routes/receipts.js';
```

Add the mount line alongside the other `/api/*` mounts, anywhere before `app.use('/api', mediaRoutes({ pool }))` (mount order among distinct, non-overlapping prefixes doesn't affect correctness — Express falls through non-matching routers to the next one — but grouping it near the other single-purpose feature routes keeps the file readable):

```js
  app.use('/api/receipts', receiptRoutes({ pool }));
```

- [ ] **Step 3: Write `server/test/receipts.test.js`**

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
import * as storage from '../src/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_JPG = path.join(__dirname, 'fixtures', 'sample.jpg');
const DISGUISED_JPG = path.join(__dirname, 'fixtures', 'disguised.jpg');

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

test('accounting can file a receipt', async () => {
  const acct = await seedUserWithCookie('accounting');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'receipt');
  assert.equal(res.body.mimeType, 'image/jpeg');
});

test('owner_admin cannot file a receipt', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [owner.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('supervisor cannot file a receipt', async () => {
  const sup = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [sup.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('an invalid kind value is rejected', async () => {
  const acct = await seedUserWithCookie('accounting');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'bogus').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 400);
});

test('a text file renamed to .jpg is rejected by content verification, not left on disk', async () => {
  const acct = await seedUserWithCookie('accounting');
  const filesBefore = await fs.readdir(storage.MEDIA_DIR);

  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', DISGUISED_JPG);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_file_type');

  const { rows } = await pool.query(`SELECT count(*) FROM receipts`);
  assert.equal(rows[0].count, '0');

  const filesAfter = await fs.readdir(storage.MEDIA_DIR);
  assert.equal(filesAfter.length, filesBefore.length);
});

test('accounting can delete their own receipt, and it is actually gone', async () => {
  const acct = await seedUserWithCookie('accounting');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'invoice').attach('file', SAMPLE_JPG);

  const del = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [acct.cookie]);
  assert.equal(del.status, 204);

  const refetch = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [acct.cookie]);
  assert.equal(refetch.status, 404);
});

test('owner_admin cannot delete a receipt', async () => {
  const acct = await seedUserWithCookie('accounting');
  const owner = await seedUserWithCookie('owner_admin', acct.tenantId, 'owner@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const res = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [owner.cookie]);
  assert.equal(res.status, 403);
});

test('cross-tenant retrieval, list, and delete all behave correctly (404, never 403)', async () => {
  const acct = await seedUserWithCookie('accounting');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const otherAcct = await seedUserWithCookie('accounting');

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [otherAcct.cookie]);
  assert.equal(getRes.status, 404);

  const delRes = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [otherAcct.cookie]);
  assert.equal(delRes.status, 404);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [otherAcct.cookie]);
  assert.deepEqual(listRes.body, []);
});

test('owner_admin can list and retrieve receipts in their tenant (read-only role actually works)', async () => {
  const acct = await seedUserWithCookie('accounting');
  const owner = await seedUserWithCookie('owner_admin', acct.tenantId, 'owner@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [owner.cookie]);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].uploadedByName, 'U');

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [owner.cookie]);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers['content-type'], 'image/jpeg');
});

test('supervisor gets 403 on every receipts read, not just writes', async () => {
  const acct = await seedUserWithCookie('accounting');
  const sup = await seedUserWithCookie('supervisor', acct.tenantId, 'sup@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [sup.cookie]);
  assert.equal(listRes.status, 403);

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [sup.cookie]);
  assert.equal(getRes.status, 403);
});
```

**Note on the insert-path unlink-on-failure logic (no automated test for it — an accepted,
documented gap, not a silent one):** the design spec called for a best-effort test forcing a
real DB `INSERT` failure after verification passes (a `storage_key` collision), to prove the
file gets unlinked rather than orphaned. This was investigated at design time: `node:test`'s
`t.mock.method` cannot intercept a namespace-imported function at all (ES module namespace
properties are non-configurable/non-writable per spec — confirmed by actually running it,
not just reasoning about it: it throws `TypeError` at `defineProperty`). The only API that
can (`t.mock.module`) requires adding `--experimental-test-module-mocks` to the shared
`npm test` invocation project-wide — confirmed working under both Node 20 and 22, but ruled
out as too big a project-wide trade-off (an experimental Node feature, a warning printed on
every test run) for one niche test. Do not attempt either approach — this was already tried
and the outcome decided. The `try`/`catch`/`unlink` block in the route above stands on its
own as simple, code-review-verifiable logic mirroring the already-shipped `media.js`
rejection-cleanup pattern.

- [ ] **Step 4: Run the new test file**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/receipts.test.js
```
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: PASS. Baseline before this task is 98 (per the current suite) + 1 from Task 2 = 99, + 10 from this task = 109 total, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/receipts.js server/src/app.js server/test/receipts.test.js
git commit -m "Add accounting receipt/invoice capture API"
```

---

### Task 4: Accounting dashboard — real content

**Files:**
- Modify: `server/src/public/dashboard/accounting.html` (replace the placeholder entirely)
- Test: `server/test/dashboard-routes.test.js` (add one assertion — the page now has real content)

**Interfaces:**
- Consumes: `POST /api/receipts`, `GET /api/receipts`, `DELETE /api/receipts/:id` (Task 3).

- [ ] **Step 1: Replace `server/src/public/dashboard/accounting.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accounting — Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 1rem; }
  fieldset { border: 1px solid #ccc; border-radius: 6px; margin-bottom: 1rem; }
  label { display: block; margin-top: 0.6rem; font-size: 0.9rem; }
  input, select { width: 100%; padding: 0.5rem; margin-top: 0.25rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: 0.6rem 1rem; margin-top: 0.75rem; font-size: 1rem; }
  #receiptList { list-style: none; padding: 0; margin-top: 0.75rem; }
  #receiptList li { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  #receiptList img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; }
  #receiptList button { margin-left: auto; padding: 0.3rem 0.6rem; font-size: 0.85rem; }
  .msg { padding: 0.5rem 0.75rem; border-radius: 6px; margin-top: 0.75rem; font-size: 0.9rem; }
  .msg.ok { background: #e6f4ea; color: #1e4620; }
  .msg.err { background: #fdecea; color: #7a271a; }
</style>
</head>
<body>
  <h1>Accounting</h1>

  <fieldset>
    <legend>File a Receipt or Invoice</legend>
    <form id="capture-form">
      <label>Type
        <select name="kind" id="kindSelect" required>
          <option value="receipt">Receipt</option>
          <option value="invoice">Invoice</option>
        </select>
      </label>
      <label>Photo
        <input type="file" accept="image/*" capture="environment" id="fileInput" required>
      </label>
      <button type="submit">File it</button>
    </form>
    <div id="captureMsg"></div>
  </fieldset>

  <fieldset>
    <legend>Filed Receipts &amp; Invoices</legend>
    <ul id="receiptList"></ul>
  </fieldset>

  <form onsubmit="event.preventDefault(); fetch('/api/auth/logout', {method:'POST'}).then(() => location.href='/login');">
    <button type="submit">Log out</button>
  </form>

  <script>
    async function loadReceipts() {
      const res = await fetch('/api/receipts');
      if (!res.ok) return;
      const rows = await res.json();
      const list = document.getElementById('receiptList');
      list.innerHTML = '';
      for (const r of rows) {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.src = `/api/receipts/${r.id}`;
        img.alt = r.kind;
        const label = document.createElement('span');
        label.textContent = `${r.kind} — ${r.uploadedByName}`;
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          await fetch(`/api/receipts/${r.id}`, { method: 'DELETE' });
          loadReceipts();
        });
        li.append(img, label, del);
        list.appendChild(li);
      }
    }

    loadReceipts();

    document.getElementById('capture-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = document.getElementById('kindSelect').value;
      const file = document.getElementById('fileInput').files[0];
      const msg = document.getElementById('captureMsg');
      if (!file) return;

      const body = new FormData();
      body.append('kind', kind);
      body.append('file', file);
      const res = await fetch('/api/receipts', { method: 'POST', body });
      if (res.ok) {
        msg.textContent = 'Filed.';
        msg.className = 'msg ok';
        document.getElementById('fileInput').value = '';
        loadReceipts();
      } else {
        msg.textContent = 'Could not file it — check the file.';
        msg.className = 'msg err';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Add one assertion to `server/test/dashboard-routes.test.js`**

Add a new test mirroring the existing `'owner_admin hitting their own dashboard gets 200 with real content'` test (the current accounting test only checks for a bare 200 — this adds the content check on top of it as a separate assertion in a new test, rather than editing the existing `'accounting hitting their own dashboard gets 200'` test, to keep each test's single assertion focused):

```js
test('accounting hitting their own dashboard gets 200 with real content', async () => {
  const cookie = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /land here in a later build/);
});
```

Run: `cd server && MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret node --test test/dashboard-routes.test.js`
Expected: PASS (7 tests total in this file — 6 pre-existing + 1 new).

- [ ] **Step 3: Commit**

```bash
git add server/src/public/dashboard/accounting.html server/test/dashboard-routes.test.js
git commit -m "Build the real Accounting receipt/invoice capture screen"
```

---

### Task 5: Owner dashboard — read-only receipts view

**Files:**
- Modify: `server/src/public/dashboard/owner.html` (additive only — do not touch the existing assign-a-walkthrough form or today's-assignments table)

**Interfaces:**
- Consumes: `GET /api/receipts` (Task 3).

No automated test for this step, matching the precedent already set for the Supervisor
dashboard's additive assignment-reminder section: this codebase doesn't unit-test frontend JS
behavior anywhere, and `GET /api/receipts`'s data-shape correctness is already fully covered
by Task 3's `receipts.test.js`.

- [ ] **Step 1: Add a new read-only receipts section to `server/src/public/dashboard/owner.html`**

Add this new `<fieldset>` right after the existing "Today's Assignments" `<fieldset>` and
before the logout `<form>`:

```html
  <fieldset>
    <legend>Filed Receipts &amp; Invoices</legend>
    <table>
      <thead><tr><th>Type</th><th>Filed By</th><th>Date</th></tr></thead>
      <tbody id="receiptsBody"></tbody>
    </table>
  </fieldset>
```

- [ ] **Step 2: Add a `loadReceipts()` function and call it alongside the existing init calls**

Add this function anywhere among the existing function declarations in the `<script>` block:

```js
    async function loadReceipts() {
      const res = await fetch('/api/receipts');
      if (!res.ok) return;
      const rows = await res.json();
      const tbody = document.getElementById('receiptsBody');
      tbody.innerHTML = '';
      for (const r of rows) {
        const tr = document.createElement('tr');
        const kindTd = document.createElement('td');
        kindTd.textContent = r.kind;
        const byTd = document.createElement('td');
        byTd.textContent = r.uploadedByName;
        const dateTd = document.createElement('td');
        dateTd.textContent = new Date(r.createdAt).toLocaleDateString();
        tr.append(kindTd, byTd, dateTd);
        tbody.appendChild(tr);
      }
    }
```

Change the existing call site to also call it:

```js
    document.getElementById('dateInput').value = todayLocalDate();
    loadSupervisors();
    loadSites();
    loadTodaysAssignments();
    loadReceipts();
```

- [ ] **Step 3: Manually verify against the running dev stack**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Log in as a seeded Owner/Admin, confirm the new "Filed Receipts & Invoices" table renders
empty when nothing's been filed, then file a receipt via the Accounting dashboard (Task 4)
and reload the Owner dashboard to confirm it appears with the correct type/filer/date and no
delete control.

- [ ] **Step 4: Run the full suite to confirm no regressions**

```bash
cd server
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: PASS, same count as after Task 4 (this task adds no new automated tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/public/dashboard/owner.html
git commit -m "Show filed receipts and invoices as a read-only list on the Owner dashboard"
```

---

### Task 6: Full local verification, then apply the schema migration to production

**Files:** none (verification and a database migration only)

**This task touches live production's database. Do not run Step 3 without running Steps 1-2 first and reading their output. Steps 3-4 require explicit human authorization before running — the executing agent must stop and ask, not proceed automatically, even if Steps 1-2 are clean.**

- [ ] **Step 1: Run the full suite against the dev stack**

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
MEDIA_DIR=/tmp/compliance-swarm-test-media TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test COOKIE_SECRET=test-secret npm test
```
Expected: every test from every task in this plan passes, plus the full pre-existing suite (no regressions) — 109/109 (98 pre-existing + 1 from Task 2 + 10 from Task 3; Tasks 4-5 add no new automated tests).

- [ ] **Step 2: Confirm the schema file is idempotent by re-running it against dev**

```bash
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm < db/init/008_receipts_schema.sql
```
Expected: no errors (the `CREATE TYPE` guard and `CREATE TABLE IF NOT EXISTS` are no-ops the second time). This is the proof the same file is safe to run against production's already-initialized database next.

- [ ] **Step 3: Apply the schema and grants to production**

**Stop here and get explicit human confirmation before proceeding — this step writes to the live production database.**

```bash
docker exec -i compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm < server/db/init/008_receipts_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm compliance-swarm-postgres bash /docker-entrypoint-initdb.d/009_receipts_grants.sh
```
(The grants script needs to exist inside the running container to be invoked this way — if it isn't there yet because production's deployment directory predates this plan's code, `docker cp server/db/init/009_receipts_grants.sh compliance-swarm-postgres:/docker-entrypoint-initdb.d/009_receipts_grants.sh` first.)

- [ ] **Step 4: Verify against production**

```bash
docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "\dt"
```
Expected: `receipts` now appears alongside the eight original tables. Confirm existing data is untouched: `docker exec compliance-swarm-postgres psql -U compliance_swarm -d compliance_swarm -c "SELECT count(*) FROM users;"` still returns the same count as before this task.

---

### Task 7: Deploy application code to production and smoke test

**Files:** none (deployment and verification only)

- [ ] **Step 1: Copy changed files to `/opt/compliance-swarm/`**

Copy every file this plan created or modified — individually, not via a directory `cp` that
could nest incorrectly. Note the path mapping: this worktree's `server/X` maps to
`/opt/compliance-swarm/X` (no `server/` prefix), confirmed during the prior plan's deploy:

- `server/db/init/008_receipts_schema.sql` → `/opt/compliance-swarm/db/init/008_receipts_schema.sql`
- `server/db/init/009_receipts_grants.sh` → `/opt/compliance-swarm/db/init/009_receipts_grants.sh` (`chmod +x` after copying)
- `server/src/routes/media.js` → `/opt/compliance-swarm/src/routes/media.js`
- `server/src/routes/receipts.js` → `/opt/compliance-swarm/src/routes/receipts.js`
- `server/src/app.js` → `/opt/compliance-swarm/src/app.js`
- `server/src/public/dashboard/accounting.html` → `/opt/compliance-swarm/src/public/dashboard/accounting.html`
- `server/src/public/dashboard/owner.html` → `/opt/compliance-swarm/src/public/dashboard/owner.html`

Then:

```bash
cd /opt/compliance-swarm
docker compose up -d --build
```

- [ ] **Step 2: Smoke test the new routes live**

Using seeded Accounting and Owner/Admin credentials, confirm end-to-end: log in as
Accounting, confirm `https://compliance.808techserviceshi.cc/dashboard/accounting` shows the
real capture screen (not the old placeholder text), file a receipt through it, confirm it
appears in the list with a working thumbnail, delete it and confirm it disappears. Then log
in as Owner/Admin, confirm `https://compliance.808techserviceshi.cc/dashboard/owner` shows
the new read-only receipts table, file one more receipt as Accounting, and confirm it shows
up on the Owner's view without a delete control.

- [ ] **Step 3: Confirm no regressions**

```bash
curl -s https://compliance.808techserviceshi.cc/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://808techserviceshi.cc
```
Expected: `{"status":"ok"}` and `200` respectively — the existing app and the unrelated sites on the same host are both unaffected.
