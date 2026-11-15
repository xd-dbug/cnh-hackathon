// The queue consumer: `npm run dev:worker`. One pg-boss job per conference, data { conferenceId, timezone? }.
import { PgBoss } from 'pg-boss';
import { createPool } from './src/db.js';
import { runScrape } from './src/pipeline.js';

export const QUEUE = 'scrape';

const pool = createPool();
const boss = new PgBoss(process.env.DATABASE_URL);
boss.on('error', (e) => console.error('pg-boss error:', e));

await boss.start();
// The API (which only sends) may start first, so both sides create the queue. No retries: a failed
// scrape is recorded on the conference, and the user re-submits.
await boss.createQueue(QUEUE, { retryLimit: 0 });

await boss.work(QUEUE, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
  const { conferenceId, timezone } = job.data ?? {};
  if (typeof conferenceId !== 'string') {
    console.error(`job ${job.id}: no conferenceId, dropping it`);
    return;
  }
  console.log(`job ${job.id}: scraping ${conferenceId}`);
  try {
    await runScrape(pool, conferenceId, { timezone });
  } catch (e) {
    // runScrape already recorded the failure on the conference. Don't make pg-boss retry it.
    console.error(`job ${job.id}: ${conferenceId} failed: ${e.message}`);
  }
});
console.log(`Worker listening on queue "${QUEUE}"`);

async function stop() {
  console.log('Shutting down...');
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
