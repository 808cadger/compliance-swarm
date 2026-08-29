# Accounting Receipt/Invoice Capture — Design

Date: 2026-08-29
Status: Approved

## Summary

Gives the Accounting role its first real feature (today it only has the backend-foundation
placeholder dashboard): capture a photo of a receipt or invoice and have it filed, with
Owner/Admin able to view (but not add or delete) everything filed tenant-wide.

This is the first of a larger, explicitly staged piece of work the user described in one
breath — receipt/invoice capture, a Supervisor-to-Accountant paperwork handoff, an
Owner "send anything to anyone" routing capability, and a supply-request-and-approval
workflow. Those three are deliberately **out of scope for this spec** and will each get their
own design once this lands:

- **Supervisor-to-Accountant handoff** — the natural next sub-project once this exists;
  Supervisor has no access to receipts at all in this round (not even read), since exactly
  what access they need is part of that next design, not this one.
- **Owner's general "send anything to anyone"** — a much broader capability than receipts
  alone; not scoped here.
- **Supply-request-and-approval workflow** — a distinct business process (a Supervisor
  requests to buy something, Owner approves before purchase), not a receipt-filing concern.

## Why a separate table, not extending `media`

`media` rows are NOT NULL-tied to a `walkthrough_id`, and `media.js`'s retrieval route builds
its entire ownership-scoping authorization around joining through `walkthroughs`. A receipt
has no walkthrough to belong to. Making `walkthrough_id` nullable to accommodate receipts
would force conditional branching into that already-shipped, already-reviewed, live-in-production
authorization logic for an unrelated feature — the same reasoning that kept the `assignments`
table separate from `walkthroughs` rather than retrofitting it. A new `receipts` table costs a
little duplication (a second small storage-metadata table, reusing the same underlying
`storage.js` primitives) but touches nothing already live.

## Permissions (settled after discussion — the one part of this design that changed shape)

- **Accounting**: full CRUD — create (capture), view (list + retrieve), delete.
- **Owner/Admin**: view only (list + retrieve) — cannot capture or delete.
- **Supervisor**: no access at all in this round. (Not insert-only like `audit_log` either —
  delete is a real, wanted capability for Accounting, not deferred.)

## Data model

New migration `server/db/init/008_receipts_schema.sql` (number to be re-verified
collision-free against `ls server/db/init/` at implementation time, per this project's
established practice):

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

No `walkthrough_id`. Reuses `storage.js`'s `MEDIA_DIR`/`generateStorageKey`/`resolveMediaPath`
as-is — those are already generic, not walkthrough-specific.

New `server/db/init/009_receipts_grants.sh`:

```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON receipts TO compliance_swarm_app;
EOSQL
```

Full DML (not insert-only like `audit_log`) — Accounting's delete capability is real, per the
settled permissions above.

## A pre-existing bug this design surfaces, fixed alongside it

Tracing `file-type`'s actual HEIC/HEIF detection (`node_modules/file-type/core.js`) found it
distinguishes four MIME types by the file's internal brand marker, not two:

- `mif1` brand → `image/heif`
- `heic`/`heix` brand → `image/heic` (a normal single Apple photo)
- `msf1` brand → `image/heif-sequence`
- `hevc`/`hevx` brand → `image/heic-sequence` (an Apple **Live Photo** — default-on for most
  iPhones — a still bundled with a short motion clip)

`media.js`'s existing `ALLOWED` map only accepts the first two — already live in production,
already a real (if perhaps low-probability, since the in-browser `capture="environment"` flow
may not surface Live Photo data at all — genuinely unverified without a real device) gap. Fixed
in both places as part of this work: `media.js`'s `ALLOWED` map gets the two `-sequence`
variants added, and the new receipts route's `ALLOWED` map is built correct from the start
with all four.

## API (`server/src/routes/receipts.js`, new file, mounted the same way every other route
module is)

```
POST /api/receipts        (accounting only)
  multipart: file field 'file', form field 'kind' ('receipt' | 'invoice')
  - multer disk storage, server-generated filename (never the client's — same discipline as
    media.js)
  - magic-byte verification via file-type against the corrected 4-entry image ALLOWED map
    (jpeg/png/heic/heif, all four HEIC-family MIME types — no video, no raw PDF in this phase,
    matches "snap pictures")
  - reject + delete the uploaded file immediately on failed verification or invalid kind
  - on a DB INSERT failure after successful verification (connection blip, constraint
    violation): unlink the already-written file before propagating the error — mirrors the
    existing reject-and-delete pattern media.js already uses for failed verification, just
    triggered by a different failure point. Without this, a verified file would sit on disk
    with no DB row ever pointing at it.
  → 201 { id, kind, mimeType, sizeBytes, createdAt }
  → 400 on invalid kind or failed type verification

GET /api/receipts          (accounting + owner_admin)
  tenant-scoped list, newest first
  → [{ id, kind, mimeType, sizeBytes, uploadedBy, uploadedByName, createdAt }]

GET /api/receipts/:id      (accounting + owner_admin)
  tenant-scoped retrieval, streams the file with correct Content-Type (res.type() before
  res.sendFile(), same discipline as media.js so type-sniffing can't override the
  server-verified MIME)
  → 404 for cross-tenant or nonexistent — never 403, same discipline as every other route

DELETE /api/receipts/:id   (accounting only — owner_admin gets 403, per the settled
                            read-only permission)
  DELETE FROM receipts WHERE id=$1 AND tenant_id=$2 RETURNING storage_key — tenant-scoped in
  the same query as the delete itself, so a cross-tenant id can't even be probed for existence.
  If a row was deleted: unlink the file from disk (ignore ENOENT — already gone is fine, not
  an error), return 204. If no row matched: 404.
  DB delete happens before the file unlink, not after — if the unlink itself fails for some
  other reason, the result is a harmless orphaned file on disk, never an orphaned DB row
  pointing at an inaccessible file.
```

**Known, accepted, deferred gap:** nothing sweeps the case where the process dies between the
DB delete committing and the unlink call actually running — disk usage could silently drift
from the DB's view of what should exist. Not fixed here; if it ever matters in practice, the
fix is a periodic reconciliation job (list files in `MEDIA_DIR`, diff against every
`storage_key` in `media` + `receipts`), out of scope for this sub-project.

## Frontend

**Accounting dashboard** (`server/src/public/dashboard/accounting.html`, replacing the current
placeholder): a capture form (file input, `capture="environment"`, `accept="image/*"`, plus a
receipt/invoice kind selector), per-file upload progress mirroring `supervisor.html`'s
`uploadFile()` pattern, and a list of filed receipts — thumbnail via
`<img src="/api/receipts/:id">` (confirmed safe: this app's auth is a signed session cookie,
never a bearer token, so a bare `<img>` tag correctly carries credentials with no JS needed),
plus kind/date/uploader, each row with a delete control (Accounting-only).

**Owner dashboard** (`owner.html`, additive only — does not touch the existing
assign-a-walkthrough form or table): a new read-only section listing all filed receipts
tenant-wide, same list shape as Accounting's, no delete control, no upload form.

## Testing

New `server/test/receipts.test.js`, mirroring `media.test.js`'s conventions:

- accounting uploads a valid receipt/invoice → 201; owner_admin and supervisor get 403 on POST
- an invalid `kind` value → 400
- a `.txt` renamed to `.jpg` is rejected (the same magic-byte-proves-itself test `media.test.js`
  already has)
- accounting deletes their tenant's receipt → 204, and a re-fetch confirms it's gone;
  owner_admin gets 403 on DELETE
- cross-tenant retrieval/list/delete all behave correctly (404, not 403, and never visible in
  another tenant's list)
- owner_admin can list and retrieve (confirming the read-only role actually works) but cannot
  upload or delete
- supervisor gets 403 on GET /api/receipts and GET /api/receipts/:id (not just POST/DELETE —
  this role has no access at all in this round)
- **Best-effort**: a DB-insert failure after successful verification correctly unlinks the
  file. Plan: pre-insert a receipt row with a known `storage_key`, then use `node:test`'s
  built-in `t.mock.method` to force `generateStorageKey()` to reproduce that exact value on
  the next call, so the real `INSERT`'s `UNIQUE` constraint genuinely fails. This requires
  `receipts.js` to import `storage.js` as a namespace (`import * as storage from '../storage.js'`)
  rather than named imports, specifically so the mock has something to attach to — untested
  whether Node's mock API can actually intercept an ES-module namespace binding in practice.
  If it can't: drop this one test rather than inventing bespoke dependency-injection
  machinery just for it. The unlink-on-failure logic itself is a simple, code-review-verifiable
  try/catch mirroring the already-shipped `media.js` rejection-cleanup pattern, so going
  without a dedicated test for it is an acceptable, explicitly-accepted gap, not a silent one.

One assertion added to `server/test/dashboard-routes.test.js`, mirroring the pattern used for
every other dashboard: confirm `accounting.html`'s placeholder content is gone.
