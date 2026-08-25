#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compliance_swarm_app') THEN
      CREATE ROLE compliance_swarm_app LOGIN PASSWORD '$POSTGRES_APP_PASSWORD';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE $POSTGRES_DB TO compliance_swarm_app;
  GRANT USAGE ON SCHEMA public TO compliance_swarm_app;

  GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, sessions TO compliance_swarm_app;
  GRANT SELECT, INSERT ON audit_log TO compliance_swarm_app;
  GRANT USAGE ON SEQUENCE audit_log_id_seq TO compliance_swarm_app;
EOSQL
