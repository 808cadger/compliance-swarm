import { Router } from 'express';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/hash.js';
import { writeAudit } from '../audit.js';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

export default function userRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { email, displayName, role, tempPassword } = req.body ?? {};
    if (!email || !displayName || !role || !tempPassword) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'email, displayName, role, tempPassword required' } });
    }
    if (!['owner_admin', 'supervisor', 'accounting'].includes(role)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'invalid role' } });
    }
    if (tempPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: { code: 'bad_request', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` } });
    }
    const hash = await hashPassword(tempPassword);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role`,
      [req.user.tenantId, email, hash, role, displayName],
    );
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'user_created',
      targetType: 'user', targetId: user.id, metadata: { role },
    });
    res.status(201).json(user);
  }));

  router.get('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, email, role, display_name AS "displayName", disabled_at AS "disabledAt"
       FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  return router;
}
