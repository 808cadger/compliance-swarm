import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { config } from '../src/config.js';

// Usage: DEMO_MODE=true node scripts/seed-demo.js [--reset]
//
// Seeds a single, clearly-marked demo tenant for the ProcessPass / Jeff Ludwig demo — never
// mixed into real tenant data (a fresh tenant row, a fixed name, and every user flagged
// is_demo_persona = true, which is also what DemoIdentityProvider requires before it will
// authenticate anyone through the "Identify Me" flow). Requires DEMO_MODE=true so this can
// never be run by accident against a real deployment: seeding fixed-password demo accounts
// into a production tenant would be a real credential-hygiene problem, not a hypothetical one.

const DEMO_TENANT_NAME = 'Aloha Build Co. (ProcessPass Demo)';
// Fixed and printed to stdout on purpose — this is the "secure sign-in instead" fallback
// password for the demo tenant only, documented in docs/JEFF_LUDWIG_DEMO.md. It is never
// used by the ProcessPass card-selection flow itself (see DemoIdentityProvider), and it
// grants access to nothing but seeded demo data.
const DEMO_PASSWORD = 'ProcessPassDemo2026!';

const reset = process.argv.includes('--reset');

if (!config.demoMode) {
  console.error('Refusing to seed demo data: DEMO_MODE is not "true". Set DEMO_MODE=true and re-run.');
  process.exit(1);
}

async function findDemoTenantId() {
  const { rows } = await pool.query(`SELECT id FROM tenants WHERE name = $1`, [DEMO_TENANT_NAME]);
  return rows[0]?.id ?? null;
}

async function wipeDemoTenant(tenantId) {
  await pool.query(`DELETE FROM receipts WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM media WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM walkthroughs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM user_site_assignments WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM assignments WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM sites WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM sessions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
  // Deliberately NOT deleting audit_log rows or the tenant row itself: this script runs with
  // the same restricted compliance_swarm_app role the app uses, which only ever has
  // SELECT/INSERT on audit_log — DELETE was withheld on purpose so an audit trail can't be
  // erased by anything short of a superuser (see 002_grants.sh) — the demo tenant's audit
  // history is no exception. A --reset reuses the same tenant row and just accumulates audit
  // history across resets instead.
}

async function seedUser(tenantId, { email, displayName, role }) {
  const hash = await hashPassword(DEMO_PASSWORD);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, is_demo_persona)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, email, hash, role, displayName],
  );
  await pool.query(
    // Separate placeholders for the same value ($2, $4), not one reused across actor_user_id
    // (uuid) and target_id (text) — Postgres deduces a single type per parameter number across
    // the whole statement, so reusing one number between a uuid and a text column errors
    // ("inconsistent types deduced"), cast or not.
    `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, target_type, target_id, metadata)
     VALUES ($1, $2, 'user_created', 'user', $4, $3)`,
    [tenantId, user.id, JSON.stringify({ role, seeded: true, demo: true }), user.id],
  );
  return user.id;
}

async function main() {
  let tenantId = await findDemoTenantId();

  if (tenantId && reset) {
    console.log(`Resetting existing demo tenant ${tenantId}...`);
    await wipeDemoTenant(tenantId);
  } else if (tenantId) {
    console.log(`Demo tenant already seeded (${tenantId}). Re-run with --reset to start clean.`);
    await pool.end();
    return;
  } else {
    const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [DEMO_TENANT_NAME]);
    tenantId = tenant.id;
  }

  await seedUser(tenantId, { email: 'jeff.ludwig@demo.processpass.local', displayName: 'Jeff Ludwig', role: 'owner_admin' });
  const foremanId = await seedUser(tenantId, { email: 'foreman.demo@demo.processpass.local', displayName: 'Foreman Demo User', role: 'supervisor' });
  const fieldWorkerId = await seedUser(tenantId, { email: 'fieldworker.demo@demo.processpass.local', displayName: 'Field Worker Demo User', role: 'field_worker' });
  await seedUser(tenantId, { email: 'accounting.demo@demo.processpass.local', displayName: 'Accounting Demo User', role: 'accounting' });

  const { rows: [siteA] } = await pool.query(
    `INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, 'Kapolei Warehouse Build'],
  );
  // A second site exists purely so the demo tenant doesn't look suspiciously minimal in the
  // Owner dashboard's site list; nothing is assigned to it.
  await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2)`, [tenantId, 'Barbers Point Harbor Site']);

  // Grounds "assigned job sites" for the Field Worker persona in something real: FieldSnap
  // is denied to a field worker with zero site assignments (see services/processAccess.js),
  // so the demo needs at least one to show the "allow" path, not just the "deny" path.
  await pool.query(
    `INSERT INTO user_site_assignments (tenant_id, user_id, site_id) VALUES ($1, $2, $3)`,
    [tenantId, fieldWorkerId, siteA.id],
  );

  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO assignments (tenant_id, site_id, supervisor_id, slot, assigned_date, created_by, updated_by)
     VALUES ($1, $2, $3, 'morning', $4, $3, $3)
     ON CONFLICT (tenant_id, site_id, slot, assigned_date) DO NOTHING`,
    [tenantId, siteA.id, foremanId, today],
  );

  console.log('Seeded ProcessPass demo tenant.');
  console.log(`  Tenant: ${DEMO_TENANT_NAME} (${tenantId})`);
  console.log('  Jeff Ludwig (owner_admin):       jeff.ludwig@demo.processpass.local');
  console.log('  Foreman Demo User (supervisor):  foreman.demo@demo.processpass.local');
  console.log('  Field Worker Demo User:          fieldworker.demo@demo.processpass.local');
  console.log('  Accounting Demo User:            accounting.demo@demo.processpass.local');
  console.log(`  Secure sign-in fallback password (all demo users; not used by the ProcessPass card flow): ${DEMO_PASSWORD}`);
  console.log('  Unknown Visitor has no account by design — selecting it in the demo selector never touches the database.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
