import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ROLE_PATH = { owner_admin: 'owner', supervisor: 'supervisor', accounting: 'accounting' };

export default function dashboardRoutes({ pool }) {
  const router = Router();

  // The bare domain is what a business owner hits first; without this it 404s.
  router.get('/', (req, res) => {
    res.redirect('/login');
  });

  router.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  router.get('/dashboard', authenticate(pool), (req, res) => {
    res.redirect(`/dashboard/${ROLE_PATH[req.user.role]}`);
  });

  router.get('/dashboard/owner', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'owner.html'));
  });
  router.get('/dashboard/supervisor', authenticate(pool), requireRole('supervisor'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'supervisor.html'));
  });
  router.get('/dashboard/accounting', authenticate(pool), requireRole('accounting'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'accounting.html'));
  });

  return router;
}
