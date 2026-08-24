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

  // The app is only ever reached through the Cloudflare Tunnel, which connects to it from
  // localhost. Without this, req.ip is always 127.0.0.1 — the audit log's ip_address column
  // is useless and the login rate limiter's `${req.ip}:${email}` key degenerates to
  // per-email-globally. 'loopback' trusts only 127.0.0.1/::1 as a proxy, so a spoofed
  // X-Forwarded-For from a non-loopback client is ignored.
  app.set('trust proxy', 'loopback');

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
  app.use((err, req, res, _next) => {
    console.error(err);
    const includeDetail = config.nodeEnv !== 'production';
    res.status(500).json({
      error: {
        code: 'internal',
        message: 'Something went wrong',
        ...(includeDetail ? { detail: err.message } : {}),
      },
    });
  });

  return app;
}
