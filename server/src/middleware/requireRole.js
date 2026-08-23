export default function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not permitted' } });
    }
    next();
  };
}
