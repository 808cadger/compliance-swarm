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

// Fail closed on a malformed or insecure WEBAUTHN_ORIGIN/WEBAUTHN_RP_ID rather than letting
// every real ceremony silently reject at runtime (the failure mode before this check existed —
// see docs/PROCESSPASS_PRODUCTION_ASSURANCE.md for the incident this guards against). Not
// gated on NODE_ENV: this app's dev and production Docker builds both run
// NODE_ENV=production (same reason the DEMO_MODE guard above isn't NODE_ENV-gated either), so
// that can't distinguish "real production" from "the correctly-configured dev stack," which
// legitimately uses http://localhost:4211. Instead this validates the origin value itself:
// localhost/127.0.0.1 may stay on http in any environment (the recognized secure-context
// exception this app's own local dev already relies on); anything else must be https. A
// value that was never explicitly set (the 'localhost' fallback above) is always safe by
// construction and never reaches this far under a false pretense — the checks below apply to
// whatever value is actually in effect, defaulted or explicit alike, since the two are
// otherwise indistinguishable here and both must be safe to actually run.
function validateWebauthnConfig({ rpId, origin }) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`WEBAUTHN_ORIGIN is not a valid URL: "${origin}"`);
  }
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error(`WEBAUTHN_ORIGIN must be http or https: "${origin}"`);
  }
  const isLoopback = parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1';
  if (!isLoopback && parsedOrigin.protocol !== 'https:') {
    throw new Error(
      `WEBAUTHN_ORIGIN must be https for any host other than localhost/127.0.0.1: "${origin}"`
    );
  }
  if (parsedOrigin.pathname !== '/' && parsedOrigin.pathname !== '') {
    throw new Error(`WEBAUTHN_ORIGIN must not contain a path: "${origin}"`);
  }
  if (parsedOrigin.search || parsedOrigin.hash) {
    throw new Error(`WEBAUTHN_ORIGIN must not contain a query string or fragment: "${origin}"`);
  }

  // A WebAuthn RP ID is a bare registrable domain: no scheme, port, path, query, or fragment.
  // This also structurally forbids embedding credentials or userinfo, which the regex's
  // character class already excludes.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(rpId)) {
    throw new Error(`WEBAUTHN_RP_ID must be a bare hostname, no scheme/port/path: "${rpId}"`);
  }

  // WebAuthn's real rule allows RP ID to be a registrable-domain suffix of the origin, not
  // only an exact match — but this app is a deliberate single-domain deployment (one origin,
  // one RP ID, enforced by config alone, not hardcoded), so exact match is the correct and
  // simpler rule here; a mismatch of any kind is a misconfiguration, not a valid subdomain
  // delegation this app is set up to use.
  if (parsedOrigin.hostname !== rpId) {
    throw new Error(`WEBAUTHN_RP_ID ("${rpId}") must equal WEBAUTHN_ORIGIN's hostname ("${parsedOrigin.hostname}")`);
  }
}

validateWebauthnConfig({ rpId: config.webauthnRpId, origin: config.webauthnOrigin });
