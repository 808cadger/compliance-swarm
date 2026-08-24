#!/bin/bash
set -e

# Dedicated test database, structurally separate from the app database so that
# resetDb can never touch real data. Named "<db>_test" because test/helpers/db.js
# refuses to delete rows from any database whose name does not end in "_test".
TEST_DB="${POSTGRES_DB}_test"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"$TEST_DB\""

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TEST_DB" \
  -f /docker-entrypoint-initdb.d/001_schema.sql

# Reuse 002's role creation + grants verbatim rather than restating them; the
# role creation there is already guarded by IF NOT EXISTS, so re-running is safe.
POSTGRES_DB="$TEST_DB" bash /docker-entrypoint-initdb.d/002_grants.sh
