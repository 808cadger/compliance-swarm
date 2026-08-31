export const config = {
  port: Number(process.env.PORT ?? 4210),
  databaseUrl: process.env.DATABASE_URL,
  cookieSecret: process.env.COOKIE_SECRET,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Gates every ProcessPass demo-identity route (see routes/processpass.js): with this unset
  // or not exactly 'true', the simulated "Identify Me" flow is not reachable at all — a real
  // deployment never exposes a password-free way into an account. Explicit opt-in, not a
  // NODE_ENV check, so a demo can still be run against a production-shaped config for
  // rehearsal without accidentally flipping on with NODE_ENV=production elsewhere.
  demoMode: process.env.DEMO_MODE === 'true',
  // Where the repo's static Process prototypes (agents/, shared/, config/, templates/ —
  // siblings of server/, not under it) live on disk. Unset in the plain Docker image (those
  // directories aren't in its build context yet), so OfficeSnap/FieldSnap's "Start Process"
  // links 404 there until it's set — see docker-compose.dev.yml for the dev wiring. Defaults
  // to the real repo root for every non-Docker run (npm start, npm test), two directories up
  // from this file's own `server/src`.
  processStaticRoot: process.env.PROCESS_STATIC_ROOT ?? null,
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.cookieSecret) throw new Error('COOKIE_SECRET is required');
