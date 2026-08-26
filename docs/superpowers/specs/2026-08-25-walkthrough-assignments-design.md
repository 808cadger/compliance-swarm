# Owner-Assigned Walkthrough Routines — Design

Date: 2026-08-25
Status: Approved

## Summary

Adds a one-off assignment capability to the field-capture pilot: an Owner/Admin
picks a supervisor, site, slot, and date, and the supervisor sees it as an
informational reminder on their dashboard. This is purely additive — it does
not change how a walkthrough is created, completed, or counted as "done"
(`today-status`), and does not restrict what a supervisor can do.

**Out of scope for this round** (explicitly deferred, not forgotten):
recurring/rolling rosters (e.g. "Supervisor Y always covers Site X mornings")
— this round is one-off, single-date assignments only; a recurring scheduling
concept is a natural follow-on but a separate feature with its own design.
Restricting supervisors to only their assigned site/slot — assignments are
informational only, never gating; a supervisor can still freely start any
walkthrough exactly as before. Any update/delete API — reassignment is done by
posting a new assignment for the same site+slot+date (see Data model).
Cross-site double-booking validation for a single supervisor — not checked,
harmless since assignments don't block anything.

## Why a separate table, not extending `walkthroughs`

`today-status` (`server/src/routes/walkthroughs.js`) currently defines "done"
purely as "a `walkthroughs` row exists for this supervisor+slot today" — there
is no separate assigned/completed state. If an owner's assignment pre-created
a `walkthroughs` row, the supervisor's dashboard would show that slot as done
before any capture happened. Keeping "expected" (`assignments`) and "actually
performed" (`walkthroughs`) as two separate tables avoids touching that
already-shipped done-logic at all.

## Data model

New migration `server/db/init/006_assignments_schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  supervisor_id   uuid NOT NULL REFERENCES users(id),
  slot            walkthrough_slot NOT NULL,   -- reuses the enum type created in 004_field_capture_schema.sql
  assigned_date   date NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, slot, assigned_date)
);
CREATE INDEX IF NOT EXISTS assignments_supervisor_today_idx ON assignments (tenant_id, supervisor_id, assigned_date);
```

The `UNIQUE` constraint means one assignment per site+slot+day — a new `POST`
for the same combination is the reassignment path (see API), not a conflict
to reject. This resolves a real gap found during design review: without it, a
superseded assignment would keep showing on the original supervisor's
reminder list as if still valid.

`tenant_id` is denormalized onto the row, matching every other table in this
schema — one indexed lookup for authorization, no join required.

New `server/db/init/007_assignments_grants.sh` (this project grants
per-table explicitly — confirmed by reading `005_field_capture_grants.sh`,
there is no default-privilege mechanism relied on here):

```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON assignments TO compliance_swarm_app;
EOSQL
```

## API (`server/src/routes/assignments.js`, new file, mounted alongside the
other route modules the same way `sites.js`/`walkthroughs.js` are)

```
POST /api/assignments        (owner_admin only)
  body: { supervisorId, siteId, slot, assignedDate? }   // assignedDate defaults to CURRENT_DATE if omitted
  validates:
    - siteId is an active site in the caller's tenant (same check walkthroughs.js already does)
    - supervisorId references a user in the same tenant with role='supervisor' and disabled_at IS NULL
    - slot is 'morning' or 'afternoon'
    - assignedDate, if given, is a well-formed YYYY-MM-DD date — no range check (past dates allowed,
      for backfill; future dates allowed, for advance scheduling)
  UPSERTs on (tenant_id, site_id, slot, assigned_date): INSERT ... ON CONFLICT (tenant_id, site_id, slot,
  assigned_date) DO UPDATE SET supervisor_id, created_by, created_at. A second POST for the same
  site+slot+day replaces the prior assignment's supervisor — this is the only reassign/cancel-and-replace
  path; there is no separate PATCH or DELETE route.
  → 200 { id, siteId, supervisorId, slot, assignedDate, createdAt } — always 200, whether this was a
    fresh insert or a replacement of an existing row. This endpoint's semantic is "set the assignment for
    this slot," not "create a resource," so the two cases aren't meaningfully different to the caller;
    avoids needing Postgres insert-vs-update detection (e.g. `xmax = 0`) for a distinction with no
    consumer.
  → 400 bad_request if siteId/supervisorId/slot/assignedDate is invalid

GET /api/assignments?date=YYYY-MM-DD&siteId=...   (owner_admin only; both filters optional,
                                                     date defaults to today)
  → [{ id, siteId, siteName, supervisorId, supervisorName, slot, assignedDate }]
  Tenant-scoped via req.user.tenantId, same pattern as GET /api/walkthroughs.

GET /api/assignments/today   (supervisor only)
  → the caller's own assignments where assigned_date = CURRENT_DATE:
    [{ siteId, siteName, slot }]
```

**"Today" clock note:** `CURRENT_DATE`/`now()` here use the database server's
timezone (confirmed `Etc/UTC` on this deployment), same as the existing
`today-status` endpoint. For a Hawaii-based tenant (UTC-10) this means the day
boundary rolls over at 2pm local time, not midnight. This is a pre-existing
condition shared with Task 4's `today-status` — not introduced by this
feature — and is explicitly deferred rather than fixed here; a real fix would
need a tenant-level timezone concept touching both endpoints together, which
is out of scope for this task.

**Existing dependency, confirmed not assumed:** `GET /api/users`
(`server/src/routes/users.js:46`) already exists, is `requireRole('owner_admin')`,
tenant-scoped, and returns `{id, email, role, displayName, disabledAt}` —
exactly what the supervisor dropdown needs (filter client-side to
`role === 'supervisor' && !disabledAt`). No new user-listing route is needed;
this was verified against the current route file before writing this spec,
specifically because a hidden new-route dependency inside a "just replace the
dashboard placeholder" task would be a scope surprise the way Task 6's brief
had one.

Same-supervisor double-booked across two different sites/slots on one day:
not validated — informational only, so harmless if it happens.

## Frontend

**Owner dashboard** (`server/src/public/dashboard/owner.html`, replacing the
current placeholder — same treatment Task 7 gave `supervisor.html`):
- "Assign a walkthrough" form: supervisor dropdown (`GET /api/users`, filtered
  client-side as above), site dropdown (`GET /api/sites` — already
  active-only, confirmed at `server/src/routes/sites.js:22-28`, so the form
  can never offer a site the `POST` would reject), slot dropdown, date input
  (`type=date`). The date input's default value is set from the browser's
  local `new Date()` — this can disagree by a day with the server's
  `CURRENT_DATE` default (used by `GET /api/assignments` when no `date` param
  is given) if the owner's device clock/timezone diverges from the server.
  Same deferred-TZ tradeoff as above; low risk for a single-tenant deployment,
  noted rather than silently left to be discovered.
- Below the form, a table of today's assignments tenant-wide (`GET
  /api/assignments`, default date=today): site, supervisor, slot columns.
- Existing logout form unchanged.

**Supervisor dashboard** (`server/src/public/dashboard/supervisor.html`,
additive only — does not touch the existing start-walkthrough/capture flow):
one new section that fetches `GET /api/assignments/today` and renders
"Assigned to you today: Site X (Morning)" per row, styled distinctly from the
existing pending/done banners (it's a reminder, not a status). Renders
nothing when the list is empty.

## Testing

New `server/test/assignments.test.js`, mirroring the patterns already used in
`sites.test.js`/`walkthroughs.test.js`:
- owner_admin creates a valid assignment → 200; accounting → 403; supervisor
  → 403 (create is owner_admin-only)
- invalid `siteId` → 400; `supervisorId` pointing at a non-supervisor role or
  a disabled user → 400; malformed `assignedDate` → 400
- upsert behavior: POSTing the same `(site, slot, date)` twice with a
  different `supervisorId` both returns 200 (not 201 the first time and 200
  the second — always 200) and replaces the row, verified by re-fetching via
  `GET /api/assignments`, not by trusting the absence of an error
- `GET /api/assignments` respects tenant scoping (another tenant's assignment
  never appears) and the `siteId`/`date` filters
- `GET /api/assignments/today` (supervisor) returns only the caller's own
  assignments, empty array when none, never another supervisor's or another
  tenant's

One assertion added to `server/test/dashboard-routes.test.js`, mirroring
Task 7: confirm `owner.html`'s placeholder text ("land here in a later
build") is gone.
