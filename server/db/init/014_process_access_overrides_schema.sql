-- Per-tenant adjustments layered on top of the global role_process_access catalog
-- (db/init/010_processpass_schema.sql). Deliberately an *adjustment* layer, not a
-- freestanding grant table: a row here can only affect a (role, process_key) pair that
-- already exists in role_process_access (enforced in routes/processAccessAdmin.js, not by a
-- DB constraint, since "does this combination exist" is a business rule the route already has
-- to check before writing anyway). That keeps a tenant owner from ever granting their own
-- role a Process nobody designed it to have — they can only turn an existing eligibility off,
-- or tighten/loosen its site-assignment requirement (the "per-site scoping for foreman
-- oversight" use case this table exists for).
--
-- NULL in either column means "no override — inherit the global default", not "false"; that's
-- what lets a row set only one of the two fields without silently resetting the other.
CREATE TABLE IF NOT EXISTS tenant_process_overrides (
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  role                      user_role NOT NULL,
  process_key               text NOT NULL REFERENCES processes(process_key),
  enabled                   boolean,
  requires_site_assignment  boolean,
  updated_by                uuid NOT NULL REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, process_key)
);
