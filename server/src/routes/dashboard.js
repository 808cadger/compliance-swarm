import { Router, static as expressStatic } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import requireStepUp from '../middleware/requireStepUp.js';
import { asyncRoute } from '../asyncRoute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// field_worker has no /dashboard/* page of its own — its one Process (FieldSnap) is the
// static prototype under /agents/, opened via ProcessPass's "Start Process" rather than a
// role-gated dashboard. /dashboard for that role goes to My Processes instead of a 404.
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

  // Shared static assets referenced by login.html and any dashboard page (currently just the
  // WebAuthn/passkey glue) — namespaced the same way /processpass/assets is, rather than a
  // blanket static mount over all of server/src/public, so a new file dropped in that
  // directory has to be deliberately placed under assets/ to become web-reachable.
  router.use('/assets', expressStatic(path.join(PUBLIC_DIR, 'assets')));

  router.get('/dashboard', authenticate(pool), (req, res) => {
    const rolePath = ROLE_PATH[req.user.role];
    res.redirect(rolePath ? `/dashboard/${rolePath}` : '/processpass/decision');
  });

  // ForemanSnap and AccountingSnap oversight: owner_admin is deliberately added alongside
  // each process's own role, not swapped in for it — a Foreman/Accounting user's access is
  // unchanged, this only widens who else may view the same page. The APIs these pages call
  // (GET /api/walkthroughs, GET /api/receipts) already allow owner_admin for the same reason;
  // this just lets the owner actually reach the page that calls them.
  router.get('/dashboard/owner', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'owner.html'));
  });
  router.get('/dashboard/supervisor', authenticate(pool), requireRole('supervisor', 'owner_admin'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'supervisor.html'));
  });
  // AccountingSnap is marked risk_level 'high' in the Process catalog (financial/sensitive
  // records — the spec's own example of a high-risk category), so it carries the same
  // step-up gate as the audit trail below: a no-op for a real password-authenticated user,
  // required once for a ProcessPass demo session. Gating the route itself (not just the
  // ProcessPass "Start Process" click) is what makes that true even if the URL is opened
  // directly, skipping ProcessPass's own UI.
  router.get(
    '/dashboard/accounting',
    authenticate(pool),
    requireRole('accounting', 'owner_admin'),
    requireStepUp(pool, 'view_accounting_snap'),
    (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'accounting.html'));
    },
  );

  // Read-only audit trail. Marked risk_level 'high' in the Process catalog
  // (db/init/010_processpass_schema.sql), so a ProcessPass demo session must complete a
  // step-up before viewing it; a real password-authenticated owner_admin is unaffected
  // (requireStepUp is a no-op outside assuranceLevel === 'demo').
  router.get(
    '/dashboard/audit',
    authenticate(pool),
    requireRole('owner_admin'),
    requireStepUp(pool, 'view_audit_trail'),
    asyncRoute(async (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'audit.html'));
    }),
  );

  // Any signed-in role — a passkey is a property of the user's own account, not gated by
  // Process/role permissions the way the dashboards above are.
  router.get('/dashboard/passkeys', authenticate(pool), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'passkeys.html'));
  });

  router.get('/dashboard/process-access', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'process-access.html'));
  });

  // --- ProcessPass screens. Pre-authentication (kiosk/verify) are open by design — that's
  // the whole point of a kiosk landing screen. decision.html reads its data from
  // GET /api/processpass/processes, which *is* authenticated, so it renders nothing
  // meaningful without a real session regardless of who can load the HTML shell.
  //
  // Every prior page under server/src/public/ was fully self-contained (inline <style>/
  // <script>), so nothing here ever needed to serve a static asset file — these are the
  // first pages that reference an external .css/.js, hence this mount. Deliberately at
  // /processpass/assets, not bare /processpass, so it can never intercept (or trigger a
  // directory-index redirect against) the exact-path routes below.
  router.use('/processpass/assets', expressStatic(path.join(PUBLIC_DIR, 'processpass')));

  router.get('/processpass', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'processpass', 'kiosk.html'));
  });
  router.get('/processpass/verify', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'processpass', 'verify.html'));
  });
  router.get('/processpass/decision', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'processpass', 'decision.html'));
  });

  return router;
}
