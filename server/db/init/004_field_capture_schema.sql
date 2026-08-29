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
