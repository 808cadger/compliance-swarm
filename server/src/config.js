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
  // siblings of server/, not under it) live on disk. Defaults to the real repo root, which is
  // correct both for a plain checkout (two directories up from this file's own `server/src`)
  // and for the Docker image (server/Dockerfile bakes all four in at the matching path) — this
  // only needs setting for a deployment layout that isn't either of those.
  processStaticRoot: process.env.PROCESS_STATIC_ROOT ?? null,
  // WebAuthn (passkeys) is origin-bound by design: a credential registered against one
  // rpID/origin pair will not verify against another. 'localhost'/http://localhost:<port> are
  // correct for local dev (browsers treat localhost as a secure context without TLS) and wrong
  // for anything else — a real deployment behind the Cloudflare Tunnel (see app.js's trust
  // proxy comment) MUST set both to the real public hostname, e.g. rpID
  // "compliance-swarm.example.com" and origin "https://compliance-swarm.example.com", or every
  // passkey ceremony will fail verification.
  webauthnRpId: process.env.WEBAUTHN_RP_ID || 'localhost',
  webauthnOrigin: process.env.WEBAUTHN_ORIGIN || `http://localhost:${Number(process.env.PORT ?? 4210)}`,
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.cookieSecret) throw new Error('COOKIE_SECRET is required');

// DEMO_MODE opens a password-free way into any account flagged is_demo_persona (see
// routes/processpass.js). NODE_ENV can't be used to tell a real deployment apart from a
// rehearsal here — both this app's dev and production Docker builds run NODE_ENV=production;
// only the surrounding compose file/ports/container names differ, invisibly to this process
// (see docker-compose.dev.yml's own comment on why). So instead of trying to detect
// "production" and getting it wrong, DEMO_MODE always requires a second, differently-named
// flag no matter the environment — the exact failure mode this guards against is a stray
// DEMO_MODE=true surviving an .env copy-paste (e.g. cloning a dev .env onto the production
// host), and a second flag under a different name is much less likely to travel along with it
// by accident. Refusing to even start is the same "loud config error over silent
// misbehavior" posture the rest of this repo's tripwires use.
if (config.demoMode && process.env.CONFIRM_DEMO_MODE !== 'true') {
  throw new Error(
    'DEMO_MODE=true refused to start without CONFIRM_DEMO_MODE=true also set: this would open a ' +
    'password-free login path. Set both explicitly if a demo/rehearsal environment is really ' +
    'what you mean to run — see docs/JEFF_LUDWIG_DEMO.md.'
  );
}
