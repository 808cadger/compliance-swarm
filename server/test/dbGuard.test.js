// Regression test for the test-database safety guard itself. Nothing else in the suite
// would catch this check being deleted or inverted -- every other DB-backed test happens to
// run against a *_test database, so they pass either way. Needs no database connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTestDatabaseName } from './helpers/db.js';

test('assertTestDatabaseName rejects the production database name', () => {
  assert.throws(
    () => assertTestDatabaseName('compliance_swarm'),
    /does not end in "_test"/,
  );
});

test('assertTestDatabaseName accepts the dedicated test database name', () => {
  assert.doesNotThrow(() => assertTestDatabaseName('compliance_swarm_test'));
});
