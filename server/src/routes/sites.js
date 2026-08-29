import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

export default function siteRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'name is required' } });
    }
    const { rows: [site] } = await pool.query(
      `INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id, name, active`,
      [req.user.tenantId, name.trim()],
    );
    res.status(201).json(site);
  }));

  router.get('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name FROM sites WHERE tenant_id = $1 AND active = true ORDER BY name`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  return router;
}
