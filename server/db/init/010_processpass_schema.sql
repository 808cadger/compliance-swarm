-- ProcessPass: consent-based visual identity access, and the "Process" vocabulary for
-- everything a user can open once identified. Additive only — no existing column is
-- altered or dropped, so every pre-existing query/behavior is unaffected.

-- New role for a persona ("Field Worker") the app has never modeled before. Added outside
-- any explicit transaction (this file has none, matching 001_schema.sql's convention), so
-- the new enum value commits before anything below references it.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'field_worker';

-- ProcessPass's demo "Identify Me" flow (DemoIdentityProvider) only ever authenticates a
-- user row explicitly flagged this way by the seed script. Without this flag, the demo
-- selector would be a password-free login into *any* real account by id — this column is
-- what keeps it scoped to seeded demo personas only, in every environment, not just ones
-- where DEMO_MODE happens to be off.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo_persona boolean NOT NULL DEFAULT false;

-- ProcessPass sessions are real rows in the existing `sessions` table (createSession is
-- reused as-is), just tagged with how the session started and how much it should be
-- trusted. Every column here defaults to the value a normal password login already
-- implies, so no existing row or query changes meaning.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'password';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assurance_level text NOT NULL DEFAULT 'standard';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_until timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_context jsonb NOT NULL DEFAULT '{}';

-- The Process catalog. This is shared reference data (like the user_role enum itself),
-- not per-tenant data: every tenant sees the same catalog, filtered by what their users'
-- roles are allowed to open. Seeded here rather than by a seed script so it exists
-- identically in every environment, the same way the enum values do.
CREATE TABLE IF NOT EXISTS processes (
  process_key   text PRIMARY KEY,
  name          text NOT NULL,
  purpose       text NOT NULL,
  start_url     text NOT NULL,
  risk_level    text NOT NULL DEFAULT 'standard' CHECK (risk_level IN ('standard', 'high')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Which roles may open which Processes. `requires_site_assignment` marks a Process where
-- role membership alone isn't enough — the caller also needs at least one row in
-- user_site_assignments (or, when a specific site is being requested, a row for that site).
CREATE TABLE IF NOT EXISTS role_process_access (
  role                      user_role NOT NULL,
  process_key               text NOT NULL REFERENCES processes(process_key),
  requires_site_assignment  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role, process_key)
);

-- A standing roster of which sites a user is assigned to, for roles that need "only your
-- assigned job sites" scoping (Field Worker today). Deliberately separate from
-- `assignments`: that table is date+slot scoped walkthrough coverage for supervisors, not a
-- general assignment roster, and overloading it would change its meaning for existing code.
CREATE TABLE IF NOT EXISTS user_site_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, site_id)
);

INSERT INTO processes (process_key, name, purpose, start_url, risk_level) VALUES
  ('owner_process', 'Owner Process', 'Organization overview, exceptions, approvals, and audit visibility.', '/dashboard/owner', 'standard'),
  ('foreman_snap', 'ForemanSnap', 'Daily logs, crew status, task approvals, and job-site coordination.', '/dashboard/supervisor', 'standard'),
  ('field_snap', 'FieldSnap', 'Capture job-site photos, progress evidence, safety observations, and equipment issues.', '/agents/field-capture-demo.html', 'standard'),
  ('accounting_snap', 'AccountingSnap', 'Receipt and invoice intake, review queues, and expense routing.', '/dashboard/accounting', 'high'),
  ('office_snap', 'OfficeSnap', 'Document intake, administrative review, routing, and approval queues.', '/agents/orchestrator.html', 'standard'),
  ('audit_view', 'Audit Trail', 'Read-only visibility into ProcessPass access events and account activity.', '/dashboard/audit', 'high')
ON CONFLICT (process_key) DO NOTHING;

INSERT INTO role_process_access (role, process_key, requires_site_assignment) VALUES
  ('owner_admin', 'owner_process', false),
  ('owner_admin', 'foreman_snap', false),
  ('owner_admin', 'accounting_snap', false),
  ('owner_admin', 'office_snap', false),
  ('owner_admin', 'audit_view', false),
  ('supervisor', 'foreman_snap', false),
  ('supervisor', 'field_snap', false),
  ('field_worker', 'field_snap', true),
  ('accounting', 'accounting_snap', false)
ON CONFLICT (role, process_key) DO NOTHING;
