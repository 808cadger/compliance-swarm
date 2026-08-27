import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// "Today" (walkthroughs' today-status, assignments' /today) must roll over at this pilot
// tenant's local midnight, not the database server's own clock (Etc/UTC) — otherwise it
// flips mid-workday for this Hawaii-based deployment. Every pooled connection gets this
// session-level timezone so now()/CURRENT_DATE/date_trunc('day', now()) all agree with the
// client's actual day. Set synchronously (not awaited) so it's queued on this client ahead
// of any query the caller submits once pool.connect()/pool.query() hands the client back.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Pacific/Honolulu'");
});
