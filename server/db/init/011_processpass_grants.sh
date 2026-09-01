#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Read-only: the app never writes to the Process catalog or its role mapping at runtime,
  -- the same way it never writes to the user_role enum.
  GRANT SELECT ON processes, role_process_access TO compliance_swarm_app;
  GRANT SELECT, INSERT, DELETE ON user_site_assignments TO compliance_swarm_app;
EOSQL
