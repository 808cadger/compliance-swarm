export const config = {
  port: Number(process.env.PORT ?? 4210),
  databaseUrl: process.env.DATABASE_URL,
  cookieSecret: process.env.COOKIE_SECRET,
  nodeEnv: process.env.NODE_ENV ?? 'development',
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.cookieSecret) throw new Error('COOKIE_SECRET is required');
