import { lookupSession, refreshSession } from '../auth/session.js';
import { asyncRoute } from '../asyncRoute.js';

export default function authenticate(pool) {
  return asyncRoute(async function authenticateMiddleware(req, res, next) {
    const token = req.signedCookies?.session;
    if (!token) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    const session = await lookupSession(pool, token);
    if (!session) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    req.user = { id: session.userId, tenantId: session.tenantId, role: session.role };
    await refreshSession(pool, token);
    next();
  });
}
