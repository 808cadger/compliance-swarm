import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { LoginRateLimiter } from './rateLimit.js';
import authRoutes from './routes/auth.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  const rateLimiter = new LoginRateLimiter();

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes({ pool, rateLimiter }));

  return app;
}
