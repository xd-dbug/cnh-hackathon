import pg from 'pg';
import { newConferenceId } from './url.js';

/** @returns {pg.Pool} a pool on DATABASE_URL */
export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (it comes from the .env file).');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
}

/**
 * Move a conference to a new status (clears any old error).
 * @param {pg.Pool} pool
 * @param {string} id
 * @param {'queued'|'fetching'|'parsing'|'embedding'} status
 */
export async function setStatus(pool, id, status) {
  await pool.query('UPDATE conferences SET status = $2, error = NULL WHERE id = $1', [id, status]);
}

/**
 * @param {pg.Pool} pool
 * @param {string} id
 * @param {string} message a sentence a user can read
 */
export async function setFailed(pool, id, message) {
  await pool.query("UPDATE conferences SET status = 'failed', error = $2 WHERE id = $1", [id, message]);
}

/**
 * Find the conference for a normalised source URL, or create it (status queued).
 * @param {pg.Pool} pool
 * @param {string} sourceUrl already normalised
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function findOrCreateConference(pool, sourceUrl) {
  const existing = await pool.query('SELECT id FROM conferences WHERE source_url = $1', [sourceUrl]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newConferenceId();
    const res = await pool.query(
      'INSERT INTO conferences (id, source_url) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [id, sourceUrl],
    );
    if (res.rows[0]) return { id, created: true };
    const again = await pool.query('SELECT id FROM conferences WHERE source_url = $1', [sourceUrl]);
    if (again.rows[0]) return { id: again.rows[0].id, created: false }; // lost a race
  }
  throw new Error('Could not create a conference row.');
}

/**
 * Replace a conference's talks and mark it ready, in ONE transaction.
 * @param {pg.Pool} pool
 * @param {string} id conference id
 * @param {{name: string, platform: string, timezone: string,
 *   talks: Array<import('./normalise.js').Talk & {embedding: number[]}>}} data
 */
export async function replaceTalks(pool, id, { name, platform, timezone, talks }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM talks WHERE conference_id = $1', [id]);
    const COLS = 13;
    for (let i = 0; i < talks.length; i += 200) {
      const chunk = talks.slice(i, i + 200);
      const params = [];
      const rows = chunk.map((t, r) => {
        params.push(id, t.id, t.title, t.abstract ?? null, t.url ?? null, t.start, t.end, t.room ?? null,
          t.venue ?? null, t.speakers, t.track ?? null, t.level ?? null, t.tags);
        const p = Array.from({ length: COLS }, (_, c) => `$${r * (COLS + 1) + c + 1}`);
        params.push(t.embedding ? JSON.stringify(t.embedding) : null);
        return `(${p.join(', ')}, $${r * (COLS + 1) + COLS + 1}::vector)`;
      });
      await client.query(
        `INSERT INTO talks (conference_id, id, title, abstract, url, start_at, end_at, room, venue,
                            speakers, track, level, tags, embedding)
         VALUES ${rows.join(', ')}`,
        params,
      );
    }
    await client.query(
      `UPDATE conferences
          SET name = $2, platform = $3, timezone = $4, talk_count = $5, scraped_at = now(),
              status = 'ready', error = NULL
        WHERE id = $1`,
      [id, name, platform, timezone, talks.length],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
