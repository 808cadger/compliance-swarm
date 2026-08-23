# Compliance Swarm Pilot — Backend Foundation Design

Date: 2026-08-23
Status: Approved

## Purpose

Compliance Swarm today (`agents/*.html`, `shared/*.js`) is a 100% client-side, local-first
static site — no build step, no server, no database, no accounts. This spec covers the first
of six sub-projects needed to turn it into a private pilot deployment for Jeff Ludwig's
company: a real backend providing **login, tenant isolation, role-based authorization, and an
audit log**. Nothing else in the pilot (media upload, AI draft review, reporting, PWA,
deployment) can be built correctly until this exists, since every later piece needs to know
*who is asking* and *what they're allowed to touch*.

Out of scope for this spec (each gets its own design later): media capture/upload storage,
the AI draft-observation review workflow, daily reporting/export, the PWA shell, and the
Docker/reverse-proxy deployment of the finished app. This spec defines the **data model and
API contract** those later pieces build on, and stands up a minimal but real, testable service.

## Context: where this runs

Confirmed directly on the target server (Fedora Linux 44, `/home/cadger`):

- Public exposure is a **Cloudflare Tunnel** (`cloudflared`, config at
  `~/.cloudflared/config.yml`) — no inbound ports are opened on the host at all. Adding this
  app means adding one more `ingress` hostname entry pointing at a `localhost` port; that's
  covered in the later deployment sub-project, not here.
- Existing Docker convention on this box (`/opt/site-ops-agent/compose.yml`): one project per
  directory under `/opt/`, `.env` file `chmod 600` and never committed, container ports bound
  to `127.0.0.1` only (never `0.0.0.0`), one dedicated bridge network per project, named
  volumes for persistent data, `restart: unless-stopped`. This service follows the same
  pattern, in its own `/opt/compliance-swarm/` directory with its own Postgres — **not**
  shared with `siteops-postgres` or any other existing container, per the requirement to keep
  this app's data, secrets, and backups fully separate from existing services.
- The live site `808techserviceshi.cc` (Next.js, port 3000) is a separate, in-use property and
  is not touched by this work.

## Architecture

- **Runtime:** Node.js + Express. Chosen over Python/FastAPI or a Next.js full-stack rewrite
  because it keeps the existing static HTML/ES-module frontend pattern mostly intact (pages
  call a JSON API via `fetch`, same shape as the existing `fetch('../config/...')` calls
  already used for the chart-of-accounts/clause-library templates), and it containerizes
  identically to the box's existing Docker pattern.
- **Database:** Postgres 16, one dedicated container, no published port — reachable only from
  the app container over the project's private Docker network.
- **Sessions:** server-side sessions stored in Postgres (a `sessions` table), referenced by an
  opaque random token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie. No JWTs — a pilot
  this small has no need for stateless tokens, and server-side sessions are trivially revocable
  (delete the row) which matters for an audit-sensitive app.
- **Passwords:** argon2id hashing. Minimum 12-character passwords, no complexity theater
  (character-class rules) beyond length. No self-service password reset in the pilot — Admin
  resets a user's password by issuing a new temporary one (kept simple deliberately; email
  delivery infra is not part of this pilot).

## Data model

```sql
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
  token_hash     text NOT NULL UNIQUE,   -- sha256 of the cookie token; raw token never stored
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
  actor_user_id  uuid REFERENCES users(id),   -- null for failed logins with unresolved user
  event_type     text NOT NULL,   -- login_success | login_failed | logout | upload | edit |
                                   -- finalize | export | role_change | user_created | user_disabled
  target_type    text,            -- 'user' | 'record' | 'media' | 'report' | ...
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

`tenant_id` is denormalized onto `sessions` and `audit_log` so every authorization check and
every audit write is a single indexed lookup, never a join back through `users`.

**Defense in depth on the audit log:** the application's Postgres role gets `INSERT, SELECT`
on `audit_log` only — no `UPDATE`, no `DELETE`, enforced at the database grant level, not just
in application code. A compromised app process should not be able to rewrite its own history.

## Auth flow

1. **User creation** (Owner/Admin only, no public signup): `POST /api/users` — creates a user
   with a temporary password, `role` explicitly set. Writes `audit_log` `user_created`.
2. **Login:** `POST /api/auth/login { email, password }` — looks up the user within the
   caller's tenant (tenant is resolved from the subdomain/deployment, not sent by the client),
   verifies with argon2. On success: inserts a `sessions` row, sets the cookie, writes
   `login_success`. On failure: writes `login_failed`, returns a **generic** "invalid
   credentials" message in both the wrong-password and unknown-email cases, so the endpoint
   can't be used to enumerate registered emails. Login is rate-limited per IP+email (10
   attempts / 15 minutes) to blunt brute force.
3. **Every authenticated request:** middleware reads the session cookie, hashes it, looks up
   the `sessions` row, checks `expires_at`, and attaches `req.user = { id, tenant_id, role }`
   to the request. **This is the only source of `tenant_id` and `role` for the rest of the
   request** — a client-submitted `tenant_id` or `role` anywhere in a request body or query
   string is always ignored. Session `expires_at` is refreshed (sliding 12-hour idle timeout,
   7-day absolute cap) on each authenticated request.
4. **Logout:** `POST /api/auth/logout` deletes the session row and clears the cookie, writes
   `logout`.

## Authorization (RBAC)

- Every route is registered with an explicit list of allowed roles, e.g.
  `router.post('/api/users', requireRole('owner_admin'), handler)`.
- **Default deny:** a route with no explicit role list is unreachable, not open. The
  `requireRole` middleware and the session-auth middleware both run before any handler; there
  is no route that skips them except `POST /api/auth/login`.
- Every handler that reads or writes tenant-scoped data filters by `req.user.tenant_id`,
  never by a tenant id supplied in the request.

## Error handling

- JSON error envelope: `{ "error": { "code": "...", "message": "..." } }`.
- Auth failures never reveal *why* (bad password vs. unknown email vs. disabled account) to
  the client — only to the audit log.
- No retries/fallbacks for conditions that can't occur (e.g. a session row referencing a
  deleted user) — foreign keys prevent it; this is not defensively coded around.

## Testing

- Integration tests run against a real Postgres (via Docker Compose, same image as
  production: `postgres:16`) — not mocked. The entire point of this sub-project is
  query-level tenant/role scoping; a mocked DB would hide exactly the bugs these tests exist
  to catch.
- Required cases: Supervisor request to an accounting-only route → 403. Accounting request to
  a field-operations write route → 403. Disabled user cannot log in or use an existing
  session. Expired session is rejected. Login failure (bad password, unknown email, disabled
  user) all return the same generic error and all write `login_failed` to the audit log.
  Every one of login/logout/upload/edit/finalize/export/role-change has a test asserting the
  corresponding `audit_log` row is written (upload/edit/finalize/export routes are stubbed in
  this sub-project — real handlers land in later sub-projects — but the audit-write contract
  is established and tested now).

## Deployment contract (for the later infra sub-project)

- Service listens on `127.0.0.1:<port>` inside its container only; never `0.0.0.0` on the
  host.
- Config via environment variables, supplied by `/opt/compliance-swarm/.env` (`chmod 600`,
  not committed): `DATABASE_URL`, `COOKIE_SECRET`, `NODE_ENV`, `PORT`, `TZ`.
- No database port is published to the host or the network.

## Explicitly deferred (not forgotten)

- Multi-tenant self-service (tenant creation UI) — pilot has exactly one tenant, seeded
  manually.
- Self-service password reset / email delivery.
- Fine-grained per-record permission overrides beyond the three roles.
- Anything involving media, AI draft observations, reporting, PWA, or deployment — each has
  its own upcoming spec.
