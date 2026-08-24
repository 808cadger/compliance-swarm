import { Router } from 'express';
import { verifyPassword } from '../auth/hash.js';
import { createSession, deleteSession, lookupSession } from '../auth/session.js';
import { writeAudit } from '../audit.js';
import { asyncRoute } from '../asyncRoute.js';

export default function authRoutes({ pool, rateLimiter }) {
  const router = Router();

  router.post('/login', asyncRoute(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Email and password required' } });
    }
    const key = `${req.ip}:${email}`;
    if (!rateLimiter.check(key)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
    }

    const { rows } = await pool.query(
      `SELECT id, tenant_id, password_hash, role, display_name, disabled_at FROM users WHERE email = $1`,
      [email],
    );
    const genericFailure = () => res.status(401).json({ error: { code: 'invalid_credentials', message: 'Invalid email or password' } });

    // Login is not tenant-scoped (single-tenant pilot; UNIQUE (tenant_id, email) permits the
    // same address in two tenants). Subdomain-based tenant resolution is out of scope, so
    // instead refuse to guess: if a second tenant is ever seeded with a colliding address,
    // the match is ambiguous and the login fails closed. The client sees the same generic
    // message as every other failure; the audit log records the real reason.
    const tenantIds = new Set(rows.map((r) => r.tenant_id));
    if (tenantIds.size > 1) {
      console.error(`Ambiguous login: email matched users in ${tenantIds.size} distinct tenants`);
      await writeAudit(pool, {
        tenantId: null,
        eventType: 'login_failed',
        metadata: { email, reason: 'ambiguous_tenant', tenantCount: tenantIds.size },
        ipAddress: req.ip,
      });
      return genericFailure();
    }

    const user = rows[0];

    if (!user || user.disabled_at) {
      await writeAudit(pool, { tenantId: user?.tenant_id ?? null, eventType: 'login_failed', metadata: { email, reason: user ? 'disabled' : 'unknown_email' } });
      return genericFailure();
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      await writeAudit(pool, { tenantId: user.tenant_id, eventType: 'login_failed', metadata: { email, reason: 'bad_password' } });
      return genericFailure();
    }

    rateLimiter.reset(key);
    const { token } = await createSession(pool, {
      userId: user.id, tenantId: user.tenant_id, ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    await writeAudit(pool, { tenantId: user.tenant_id, actorUserId: user.id, eventType: 'login_success', ipAddress: req.ip });

    res.cookie('session', token, {
      httpOnly: true, secure: true, sameSite: 'strict', signed: true, maxAge: 12 * 3600 * 1000,
    });
    res.json({ role: user.role, displayName: user.display_name });
  }));

  router.post('/logout', asyncRoute(async (req, res) => {
    const token = req.signedCookies?.session;
    if (token) {
      const session = await lookupSession(pool, token);
      await deleteSession(pool, token);
      if (session) {
        await writeAudit(pool, { tenantId: session.tenantId, actorUserId: session.userId, eventType: 'logout' });
      }
    }
    res.clearCookie('session');
    res.status(204).end();
  }));

  return router;
}
