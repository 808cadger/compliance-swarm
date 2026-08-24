import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { LoginRateLimiter } from './rateLimit.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import dashboardRoutes from './routes/dashboard.js';

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
  app.use(dashboardRoutes({ pool }));

  // Everything below must stay LAST, after every route mount: Express dispatches middleware
  // in registration order, and identifies the error handler by its arity (4 params).
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use((err, req, res, next) => {
    // A failure part-way through a streamed response (res.sendFile on the dashboard routes)
    // arrives here with the headers already flushed; setting them again throws a second error.
    // Express's own final handler is the only thing that can still do anything useful: destroy
    // the socket.
    if (res.headersSent) return next(err);

    console.error(err);
    // Express and its middleware attach a status to errors that are the *client's* fault:
    // express.json() throws SyntaxError with status 400 on a malformed body and 413 over the
    // size limit, res.sendFile forwards ENOENT as 404. Flattening those to 500 both lies to
    // the caller and hides real 4xx behaviour behind a generic server-error envelope.
    const status = err.status ?? err.statusCode ?? 500;
    if (status < 500) {
      return res.status(status).json({
        error: {
          code: status === 404 ? 'not_found' : 'bad_request',
          message: err.message,
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
  });

  return app;
}
