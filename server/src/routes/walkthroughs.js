import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

const VALID_SLOTS = ['morning', 'afternoon'];

export default function walkthroughRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const { siteId, slot, notes } = req.body ?? {};
    if (!siteId || !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'siteId and a valid slot are required' } });
    }
    const { rows: siteRows } = await pool.query(
      `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [siteId, req.user.tenantId],
    );
    if (siteRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown siteId' } });
    }
    const { rows: [walkthrough] } = await pool.query(
      `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, site_id AS "siteId", slot, notes, created_at AS "createdAt"`,
      [req.user.tenantId, siteId, req.user.id, slot, notes ?? ''],
    );
    res.status(201).json(walkthrough);
  }));

  router.get('/', requireRole('supervisor', 'owner_admin'), asyncRoute(async (req, res) => {
    const scopedToSelf = req.user.role === 'supervisor';
    const { rows } = await pool.query(
      `SELECT w.id, w.site_id AS "siteId", s.name AS "siteName", w.slot, w.notes, w.created_at AS "createdAt"
       FROM walkthroughs w
       JOIN sites s ON s.id = w.site_id
       WHERE w.tenant_id = $1 AND ($2 = false OR w.supervisor_id = $3)
       ORDER BY w.created_at DESC`,
      [req.user.tenantId, scopedToSelf, req.user.id],
    );
    res.json(rows);
  }));

  router.get('/today-status', requireRole('supervisor'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT slot FROM walkthroughs
       WHERE tenant_id = $1 AND supervisor_id = $2
         AND created_at >= date_trunc('day', now())
         AND created_at < date_trunc('day', now()) + interval '1 day'`,
      [req.user.tenantId, req.user.id],
    );
    const slots = new Set(rows.map(r => r.slot));
    res.json({ morningDone: slots.has('morning'), afternoonDone: slots.has('afternoon') });
  }));

  return router;
}
