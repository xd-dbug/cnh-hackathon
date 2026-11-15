// Dev CLI: run the pipeline once, without the queue.
//   npm run scrape -- <url|file> [--timezone=America/Denver] [--url=<source url>]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool, findOrCreateConference } from './src/db.js';
import { runScrape } from './src/pipeline.js';
import { fileSourceUrl, normaliseUrl } from './src/url.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { timezone: { type: 'string' }, url: { type: 'string' } },
});
const [input] = positionals;
if (!input) {
  console.error('Usage: npm run scrape -- <url|file> [--timezone=America/Denver] [--url=<source url>]');
  process.exit(2);
}

// npm runs workspace scripts from worker/, so resolve paths from where the user typed the command.
const candidate = resolve(process.env.INIT_CWD ?? process.cwd(), input);
const file = !/^https?:\/\//i.test(input) && existsSync(candidate) ? candidate : undefined;
const sourceUrl = normaliseUrl(file ? (values.url ?? fileSourceUrl(file)) : input);

const pool = createPool();
let exitCode = 0;
try {
  const { id, created } = await findOrCreateConference(pool, sourceUrl);
  console.log(`Conference ${id} (${created ? 'created' : 'reused'}) for ${sourceUrl}`);
  const result = await runScrape(pool, id, { file, timezone: values.timezone });

  const { rows: [count] } = await pool.query('SELECT count(*)::int AS n FROM talks WHERE conference_id = $1', [id]);
  console.log(`\nTalks in database: ${count.n}`);
  const { rows: days } = await pool.query(
    `SELECT to_char(start_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM talks WHERE conference_id = $1 GROUP BY 1 ORDER BY 1`,
    [id, result.timezone],
  );
  console.log('Per day:');
  for (const d of days) console.log(`  ${d.day}: ${d.n}`);
  const { rows: [sample] } = await pool.query(
    `SELECT id, title, left(abstract, 80) AS abstract, url, start_at, end_at, room, venue, speakers, track, level, tags,
            embedding IS NOT NULL AS has_embedding, vector_dims(embedding) AS embedding_dims,
            left(embedding::text, 60) || '...' AS embedding_head
       FROM talks WHERE conference_id = $1 ORDER BY start_at, id OFFSET 5 LIMIT 1`,
    [id],
  );
  console.log('Sample row:');
  console.log(JSON.stringify(sample, null, 2));
} catch (e) {
  console.error(`Scrape failed: ${e.message}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
