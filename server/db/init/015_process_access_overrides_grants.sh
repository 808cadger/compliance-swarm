#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_process_overrides TO compliance_swarm_app;
EOSQL
