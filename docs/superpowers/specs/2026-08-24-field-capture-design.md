# Compliance Swarm Pilot — Field Capture & Media Storage Design

Date: 2026-08-24
Status: Approved

## Purpose

Sub-project 2 of 6 for the Endgrain pilot (backend foundation — auth, tenancy, RBAC,
audit log — is complete, merged, and live). This builds the mobile-first walkthrough
capture flow: a Supervisor picks a job site, starts a walkthrough, captures or uploads
photos/video from their phone, adds notes, and everything lands in secure, validated,
metadata-tagged storage. Includes a lightweight in-app reminder banner ("morning
walkthrough not done yet") on the Supervisor dashboard.

**Explicitly out of scope, deferred to later sub-projects:** AI-assisted classification
of captured media and the human draft-review workflow around it (sub-project 3), the
daily report view and export (sub-project 4), push/SMS notifications (no infrastructure
for it yet — the in-app banner is the whole of "reminders" for this pilot), offline
queued/retry uploads (the original pilot spec explicitly warns against promising this
without reliable retry behavior — not building it), and site management beyond
create/list (no edit/deactivate UI yet — a pilot with a handful of fixed sites doesn't
need it).

## Context

Confirmed against the current codebase: `authenticate`/`requireRole` middleware,
`writeAudit`, and the tenant-scoping pattern (every query filtered by
`req.user.tenantId`, never client input) are already established and this sub-project
reuses them unchanged. The existing `server/src/public/dashboard/supervisor.html` is
currently a bare placeholder — this sub-project gives it real content for the first
time.

## Architecture

- **New tables:** `sites`, `walkthroughs`, `media` — see Data model below.
- **New routes:** site create/list, walkthrough create/list, media upload, media
  retrieval, and a "today status" endpoint for the reminder banner.
- **Storage:** a new Docker named volume (matching the existing `postgres_data`
  pattern), mounted into the app container at `/data/media`, **never** under
  `express.static` or any publicly-servable path. The only way to retrieve a file is
  through an authenticated, role- and ownership-checked endpoint that streams it —
  media is private by construction, not "unguessable URL" private.
- **Upload mechanism:** `multer` with disk storage, writing directly to `/data/media`
  under a server-generated random filename (never the client's original filename or
  anything derived from client input) — same "server decides the name" discipline the
  spec already required for session tokens.
- **File-type verification:** the `file-type` npm package (reads actual file magic
  bytes) confirms the uploaded content really is what it claims to be, run *after* the
  file lands on disk but *before* the DB row is written or the upload is acknowledged
  as successful. A mismatch (e.g. a `.txt` renamed to `.jpg`) is rejected with a 400
  and the rejected file is deleted immediately — nothing unverified is ever left on
  disk. This satisfies the pilot spec's explicit requirement to verify actual file
  type rather than trusting the client's claimed MIME type.
- **Size limit:** a single configurable constant, `MAX_UPLOAD_BYTES` (default 500 MB,
  generous enough for a few minutes of phone video, small enough to bound disk usage
  for a pilot), enforced by `multer`'s built-in limit (rejected uploads never fully
  land on disk).
- **Authoritative timestamp:** `media.created_at` (server clock, at successful upload)
  is the compliance-relevant timestamp — a client-reported capture time is accepted as
  supplementary metadata (`captured_at`) but is never trusted for anything the audit
  trail depends on, since client clocks aren't controlled.
- **Audit integration:** every successful upload writes an `upload` row to
  `audit_log` (`targetType: 'media'`, `targetId` the new media row's id,
  `metadata: { walkthroughId, kind }`) — the event type the original pilot spec names
  explicitly and that the backend foundation's audit table already supports without
  any schema change.

## Data model

```sql
CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TYPE walkthrough_slot AS ENUM ('morning', 'afternoon');

CREATE TABLE walkthroughs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  site_id        uuid NOT NULL REFERENCES sites(id),
  supervisor_id  uuid NOT NULL REFERENCES users(id),
  slot           walkthrough_slot NOT NULL,
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE media_kind AS ENUM ('photo', 'video');

CREATE TABLE media (
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

`tenant_id` is denormalized onto `walkthroughs` and `media` for the same reason as
`sessions`/`audit_log` in the backend foundation: every authorization check is one
indexed lookup, never a join back through `sites`/`walkthroughs`.

## Roles and API surface

Accounting has zero access to any route below, matching the "three isolated areas"
requirement — field media is not accounting's concern. Supervisor and Owner/Admin
share access (Owner/Admin is a superset, not a separate silo, since a small pilot may
have the same person wearing both hats):

- `POST /api/sites` (Owner/Admin only) — create a site.
- `GET /api/sites` (Supervisor, Owner/Admin) — list active sites, tenant-scoped, for
  the walkthrough picker.
- `POST /api/walkthroughs` (Supervisor, Owner/Admin) — `{ siteId, slot, notes }`,
  creates a walkthrough owned by the caller.
- `GET /api/walkthroughs` (Supervisor, Owner/Admin) — Supervisor sees only their own;
  Owner/Admin sees every walkthrough in the tenant.
- `POST /api/walkthroughs/:id/media` (the walkthrough's own Supervisor, or Owner/Admin)
  — one file per request (client makes one request per photo/video — no multi-file
  batching, keeps error handling per-file and simple), multipart form field `file`
  plus optional `tags`/`capturedAt` fields.
- `GET /api/media/:id` (the walkthrough's own Supervisor, or Owner/Admin) — streams the
  file with the correct `Content-Type`, after verifying tenant, role, and that the
  requester is either the uploader's own Supervisor or an Owner/Admin in the same
  tenant.
- `GET /api/walkthroughs/today-status` (Supervisor) — `{ morningDone, afternoonDone }`
  for the current calendar day, tenant- and caller-scoped, driving the reminder banner.

## Frontend

`server/src/public/dashboard/supervisor.html` gets real content for the first time:

- A reminder banner reading today's status from `/api/walkthroughs/today-status` on
  page load — "Morning walkthrough: not done yet" / "done ✓", same for afternoon.
- A "Start Walkthrough" form: site picker (`<select>` populated from `/api/sites`),
  slot (defaulted from time of day — before 12:00 in the server's configured `TZ` is
  `morning`, 12:00 or later is `afternoon`; the Supervisor can override the default),
  notes field.
- Capture inputs using plain `<input type="file" accept="image/*" capture="environment">`
  and `<input type="file" accept="video/*" capture="environment">` — the standard,
  zero-dependency way to reach a phone's camera from a web page. No custom
  `getUserMedia`/`MediaRecorder` capture UI for this pilot; the OS camera app is
  the capture surface, matching the "avoid promising offline video uploads unless
  reliably queued" caution by keeping the upload path as simple as a direct file
  POST per item.
- Each selected file uploads immediately as its own request with a visible
  per-file progress/success/error state, rather than batching everything into one
  upload at form submit — a failed 500MB video partway through doesn't lose the
  photos that already succeeded.

## Error handling

Reuses the backend foundation's `asyncRoute` wrapper and terminal error handler
unchanged. File-type mismatch → `400 { error: { code: 'invalid_file_type', message: '...' } }`,
rejected file deleted synchronously before responding. Oversized upload → `413` via
multer's built-in limit (also caught by the terminal handler, consistent JSON
envelope). A walkthrough or media row that doesn't belong to the requester's tenant is
never distinguished from "doesn't exist" in the response (`404`, not `403`) — this
matches the existing tenant-isolation discipline of not confirming cross-tenant
existence.

## Testing

Real Postgres and real file uploads (via supertest's `.attach()`), matching the
backend foundation's "no mocks for what the test exists to verify" discipline.
Required cases:

- A genuine JPEG uploads successfully and is retrievable with the correct
  `Content-Type`.
- **A `.txt` file renamed to `photo.jpg` is rejected** — this is the one test that
  actually proves magic-byte verification works, not just extension-checking; a test
  that only tries genuinely-valid files would pass even with file-type verification
  completely absent.
- An oversized upload is rejected with `413` and never appears in `/data/media` or
  the `media` table.
- Accounting gets `403` on every route in this spec.
- A Supervisor cannot list, create media under, or retrieve media from another
  Supervisor's walkthrough within the same tenant; Owner/Admin can see both.
- `GET /api/media/:id` for a media row's server-generated `storage_key` — confirm
  the response is the actual file bytes, not a redirect or a leaked filesystem path.
- The reminder banner's endpoint correctly reports `morningDone`/`afternoonDone`
  across a day boundary (a walkthrough created "yesterday" doesn't count as today's).

## Explicitly deferred (not forgotten)

- AI-assisted draft observations and the human review/edit/finalize workflow —
  sub-project 3.
- Daily report view, download, and email-ready export — sub-project 4.
- Push or SMS reminders — only the in-app banner exists for this pilot.
- Offline queued/retry uploads — a failed upload today just fails; the Supervisor
  retries manually.
- Site edit/deactivate UI — sites can be created and listed; changing or retiring one
  requires a direct database update for now.
- Video thumbnail generation or transcoding — original files are stored and served
  as-is; a browser can already play `mp4`/`mov` directly for later review.
