import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth/hash.js';

const [companyName, email, tempPassword] = process.argv.slice(2);
if (!companyName || !email || !tempPassword) {
  console.error('Usage: node scripts/seed-tenant.js "<Company Name>" <owner-email> <owner-temp-password>');
  process.exit(1);
}

const { rows: [tenant] } = await pool.query(
  `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
  [companyName],
);
const hash = await hashPassword(tempPassword);
const { rows: [user] } = await pool.query(
  `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
   VALUES ($1, $2, $3, 'owner_admin', $4) RETURNING id`,
  [tenant.id, email, hash, companyName + ' Owner'],
);
await pool.query(
  `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, target_type, target_id, metadata)
   VALUES ($1, $2, 'user_created', 'user', $3, $4)`,
  [tenant.id, user.id, user.id, JSON.stringify({ role: 'owner_admin', seeded: true })],
);

console.log(`Created tenant ${tenant.id} and owner_admin user ${user.id} (${email})`);
await pool.end();
