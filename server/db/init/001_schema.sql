CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

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
  token_hash     text NOT NULL UNIQUE,
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
  actor_user_id  uuid REFERENCES users(id),
  event_type     text NOT NULL,
  target_type    text,
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
