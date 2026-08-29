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
