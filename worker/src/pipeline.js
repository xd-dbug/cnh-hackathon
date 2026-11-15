import { readFile } from 'node:fs/promises';
import { pickAdapter } from './adapters/index.js';
import { setFailed, setStatus, replaceTalks } from './db.js';
import { embedTexts, embeddingText } from './embed.js';
import { UserError } from './errors.js';
import { normalise } from './normalise.js';
import { safeFetch } from './safe-fetch.js';

const GENERIC_FAILURE = 'Something went wrong while reading that schedule. Please try again later.';

/**
 * Parse and normalise a fetched source. No network and no database, so it is unit-testable.
 * @param {{url?: string, body: string}} source
 * @param {{timezone?: string}} [opts] `timezone`: the user's hint, used only when the source has none
 * @returns {{adapter: string, name: string, timezone: string, talks: import('./normalise.js').Talk[],
 *   skipped: Record<string, number>}}
 */
export function parseSource({ url, body }, { timezone } = {}) {
  const adapter = pickAdapter(url, body);
  const ctx = { url, html: body };
  const raw = adapter.extract(ctx);
  const meta = adapter.meta?.(ctx) ?? {};
  const result = normalise(raw, { timezone: meta.timezone, hint: timezone });
  if (!result.talks.length) throw new UserError('No talks were found in that schedule.');
  return {
    adapter: adapter.name,
    name: meta.name || (url ? new URL(url).hostname : 'Conference'),
    ...result,
  };
}

/**
 * Run the whole scrape for one conference: fetching, parsing, embedding, ready. Updates
 * `conferences.status` at each stage. On failure it sets status 'failed' with a readable `error`,
 * then rethrows.
 * @param {import('pg').Pool} pool
 * @param {string} conferenceId
 * @param {{timezone?: string, file?: string, log?: (m: string) => void}} [opts]
 *   `file`: read this local file instead of fetching the conference's source_url
 * @returns {Promise<{adapter: string, name: string, timezone: string, talkCount: number,
 *   talks: Array<import('./normalise.js').Talk & {embedding: number[]}>}>}
 */
export async function runScrape(pool, conferenceId, { timezone, file, log = console.log } = {}) {
  try {
    const { rows } = await pool.query('SELECT source_url, timezone FROM conferences WHERE id = $1', [conferenceId]);
    if (!rows[0]) throw new Error(`Unknown conference ${conferenceId}`);
    const sourceUrl = rows[0].source_url;
    const hint = timezone ?? rows[0].timezone ?? undefined;

    await setStatus(pool, conferenceId, 'fetching');
    let body;
    if (file) {
      log(`Reading ${file}`);
      body = await readFile(file, 'utf8');
    } else {
      log(`Fetching ${sourceUrl}`);
      body = (await safeFetch(sourceUrl)).body;
    }

    await setStatus(pool, conferenceId, 'parsing');
    const parsed = parseSource({ url: sourceUrl, body }, { timezone: hint });
    log(`Parsed ${parsed.talks.length} talks with the ${parsed.adapter} adapter (${JSON.stringify(parsed.skipped)} skipped)`);

    await setStatus(pool, conferenceId, 'embedding');
    const vectors = await embedTexts(parsed.talks.map(embeddingText), { log });
    const talks = parsed.talks.map((t, i) => ({ ...t, embedding: vectors[i] }));

    await replaceTalks(pool, conferenceId, {
      name: parsed.name, platform: parsed.adapter, timezone: parsed.timezone, talks,
    });
    log(`Stored ${talks.length} talks; conference ${conferenceId} is ready`);
    return { adapter: parsed.adapter, name: parsed.name, timezone: parsed.timezone, talkCount: talks.length, talks };
  } catch (e) {
    const message = e instanceof UserError ? e.message : GENERIC_FAILURE;
    if (!(e instanceof UserError)) console.error(`scrape ${conferenceId} failed:`, e);
    await setFailed(pool, conferenceId, message).catch((err) => console.error('could not record failure:', err));
    throw e;
  }
}
