import pg from 'pg';
import { config } from './config.js';

// "Today" (walkthroughs' today-status, assignments' /today) must roll over at this pilot
// tenant's local midnight, not the database server's own clock (Etc/UTC) — otherwise it
// flips mid-workday for this Hawaii-based deployment. Set via the Postgres startup packet
// (libpq-style `options`) rather than a post-connect `SET TIME ZONE` query: the latter races
// with the caller's own first query on a freshly-opened connection (node-postgres warns
// "client.query() when the client is already executing a query" when the two interleave),
// where this way the timezone is active before the connection is usable at all.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  options: '-c TimeZone=Pacific/Honolulu',
});
