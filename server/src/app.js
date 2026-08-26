import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { LoginRateLimiter } from './rateLimit.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import siteRoutes from './routes/sites.js';
import walkthroughRoutes from './routes/walkthroughs.js';
import dashboardRoutes from './routes/dashboard.js';

// Errors raised while parsing the request itself carry the request's own bytes, and
// /api/auth/login POSTs {email, password}: a malformed login body means the plaintext
// password is inside the error object. body-parser attaches the entire unparsed body as
// err.body, and — less obviously — V8's JSON SyntaxError message quotes a fragment of the
// offending bytes ("Unexpected token 'M', \"MARKER_SEC\"... is not valid JSON"), which
// err.stack's first line then repeats. So neither console.error(err) (util.inspect walks into
// err.body) nor err.message nor err.stack is safe for this class of error.
//
// Nothing is lost by withholding them: err.type plus the status identify a body-parser
// failure exactly, and its message is boilerplate. Any error carrying a body-parser `type`
// (or a `body`) is therefore logged by identity alone; everything else — our own bugs, pg
// errors, res.sendFile ENOENT — still logs its full stack, since those messages are built
// from server-side values, not from raw request bytes.
export function describeErrorForLog(err) {
  if (!(err instanceof Error)) return `non-Error thrown (${typeof err})`;
  const status = err.status ?? err.statusCode ?? 500;
  // The `type`/`body` checks catch body-parser's own error family (malformed JSON, oversized
  // payload) by shape. A malformed Content-Encoding header (e.g. claiming gzip on non-gzip
  // bytes) produces a zlib error with neither property, so it fell through to the raw-stack
  // branch below. That's safe today (zlib's messages are fixed strings from a constant table
  // and never interpolate request bytes), but not structurally guaranteed the way the
  // `type`/`body` checks are. `expose: true` + a 4xx status is Express/connect's own signal
  // that an error's message is meant to be client-safe and boilerplate, which covers this
  // family (and any future one shaped the same way) without hardcoding zlib specifics.
  const isExposedClientError = err.expose === true && status < 500;
  if (typeof err.type === 'string' || err.body !== undefined || isExposedClientError) {
    return `request rejected: ${err.name} type=${err.type ?? 'unknown'} status=${status} (detail withheld: may contain request body)`;
  }
  return err.stack ?? `${err.name}: ${err.message}`;
}

// Exported (rather than inlined in createApp) so tests can exercise it directly against a
// real res.sendFile ENOENT without needing a route that reads one of the real dashboard
// HTML files out from under production.
export function errorHandler(err, req, res, next) {
  // A failure part-way through a streamed response (res.sendFile on the dashboard routes)
  // arrives here with the headers already flushed; setting them again throws a second error.
  // Express's own final handler is the only thing that can still do anything useful: destroy
  // the socket.
  if (res.headersSent) return next(err);

  console.error(`${req.method} ${req.path} ->`, describeErrorForLog(err));
  // Express and its middleware attach a status to errors that are the *client's* fault:
  // express.json() throws SyntaxError with status 400 on a malformed body and 413 over the
  // size limit, res.sendFile forwards ENOENT as 404. Flattening those to 500 both lies to
  // the caller and hides real 4xx behaviour behind a generic server-error envelope.
  //
  // err.message is never safe to hand back verbatim, though. res.sendFile's ENOENT carries
  // the container's absolute filesystem path (and sets expose: false to say so), but
  // body-parser's malformed-JSON SyntaxError sets expose: true and *still* embeds a raw
  // fragment of the request body in its message (V8 quotes the bytes around the parse
  // failure) — so expose can't be trusted as the sole guard here. No route in this app
  // relies on a custom message surfacing through this handler: code that wants to tell the
  // client something specific replies directly instead of throwing. So every 4xx gets a
  // fixed, status-appropriate message instead; the log line above identifies which error it
  // was (by type, for the body-parser family whose detail is withheld there too).
  const status = err.status ?? err.statusCode ?? 500;
  if (status < 500) {
    const message = status === 404
      ? 'Not found'
      : status === 413
        ? 'Payload too large'
        : 'Bad request';
    return res.status(status).json({
      error: {
        code: status === 404 ? 'not_found' : 'bad_request',
        message,
      },
    });
  }

  const includeDetail = config.nodeEnv !== 'production';
  res.status(status).json({
    error: {
      code: 'internal',
      message: 'Something went wrong',
      ...(includeDetail ? { detail: err.message } : {}),
    },
  });
}

export function createApp() {
  const app = express();

  // The app is only ever reached through the Cloudflare Tunnel, which connects to the host's
  // 127.0.0.1:4210 — but this process runs inside a container on the `compliance_swarm` Docker
  // bridge network, so Docker NATs that connection and the peer address the app actually sees
  // is the bridge gateway (172.x.y.1, in RFC1918 space), never 127.0.0.1. Without a matching
  // trust setting req.ip is pinned to that one gateway address: the audit log's ip_address
  // column is useless and the login rate limiter's `${req.ip}:${email}` key degenerates to
  // per-email-globally. These three built-in presets cover loopback (direct/host-network runs),
  // link-local, and all RFC1918/ULA ranges (which is where every Docker bridge subnet lives),
  // so the setting survives the bridge subnet changing when containers are recreated. A hop
  // arriving from a public address is still untrusted: its X-Forwarded-For is ignored.
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  const rateLimiter = new LoginRateLimiter();

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes({ pool, rateLimiter }));
  app.use('/api/users', userRoutes({ pool }));
  app.use('/api/sites', siteRoutes({ pool }));
  app.use('/api/walkthroughs', walkthroughRoutes({ pool }));
  app.use(dashboardRoutes({ pool }));

  // Everything below must stay LAST, after every route mount: Express dispatches middleware
  // in registration order, and identifies the error handler by its arity (4 params).
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use(errorHandler);

  return app;
}
