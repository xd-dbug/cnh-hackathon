import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { createApp } from './src/app.js';
import { embedQuery } from './src/embed.js';

const PORT = process.env.PORT || 3001;
const QUEUE = 'scrape';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (e) => console.error('pg pool error:', e));

// The queue client starts on the first submit, so read-only use never touches the pgboss schema.
// The worker runs the supervisor and schedules, so this instance only sends.
let bossReady;
function boss() {
  bossReady ??= (async () => {
    const b = new PgBoss({ connectionString: process.env.DATABASE_URL, supervise: false, schedule: false });
    b.on('error', (e) => console.error('pg-boss error:', e));
    await b.start();
    await b.createQueue(QUEUE, { retryLimit: 0 }); // same options as the worker; idempotent
    return b;
  })().catch((e) => {
    bossReady = undefined;
    throw e;
  });
  return bossReady;
}

/** @param {string} conferenceId */
async function enqueue(conferenceId) {
  await (await boss()).send(QUEUE, { conferenceId });
}

const app = createApp({ pool, enqueue, embedQuery });
const server = app.listen(PORT, () => console.log(`API listening on ${PORT}`));

async function shutdown() {
  server.close();
  if (bossReady) await (await bossReady).stop({ graceful: false }).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
