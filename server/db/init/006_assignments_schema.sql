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
