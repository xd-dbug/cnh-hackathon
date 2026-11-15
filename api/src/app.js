import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from './errors.js';
import { toTalk, findClashes, rrf, cmpId } from './talks.js';
import {
  validCid, validId, validDay, validTimezone, validateIds, parseStarredParam, validateSourceUrl, newConferenceId,
} from './validate.js';

export const SEARCH_SIZE = 50;
export const BROWSE_SIZE = 2000;
/**
 * Cosine similarity below which a vector hit is noise. Calibrated on the real KubeCon data, see the
 * table in the PR that introduced it.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.6;

const TALK_COLS = 't.id, t.title, t.abstract, t.url, t.start_at, t.end_at, t.room, t.venue, t.speakers, t.track, t.level, t.tags';

/**
 * @typedef {Object} Conference
 * @property {string} id
 * @property {string} sourceUrl
 * @property {string} [platform]
 * @property {string} [name]
 * @property {string} [timezone]
 * @property {'queued'|'fetching'|'parsing'|'embedding'|'ready'|'failed'} status
 * @property {string} [error]
 * @property {number} [talkCount]
 * @property {string[]} days
 * @property {string[]} levels
 * @property {string} createdAt
 * @property {string} [scrapedAt]
 */

// days and levels only exist once the conference is ready.
const CONFERENCE_SELECT = `
  SELECT c.id, c.source_url, c.platform, c.name, c.timezone, c.status, c.error, c.talk_count, c.created_at, c.scraped_at,
    CASE WHEN c.status = 'ready' THEN (
      SELECT coalesce(array_agg(d ORDER BY d), '{}') FROM (
        SELECT DISTINCT to_char(t.start_at AT TIME ZONE c.timezone, 'YYYY-MM-DD') AS d
        FROM talks t WHERE t.conference_id = c.id) x
    ) END AS days,
    CASE WHEN c.status = 'ready' THEN (
      SELECT coalesce(array_agg(l ORDER BY l COLLATE "C"), '{}') FROM (
        SELECT DISTINCT t.level AS l FROM talks t WHERE t.conference_id = c.id AND t.level IS NOT NULL) y
    ) END AS levels
  FROM conferences c`;

/**
 * Turn a conferences row (see CONFERENCE_SELECT) into the contract Conference shape.
 * @param {Record<string, any>} r
 * @returns {Conference}
 */
export function toConference(r) {
  const c = { id: r.id, sourceUrl: r.source_url };
  if (r.platform) c.platform = r.platform;
  if (r.name) c.name = r.name;
  if (r.timezone) c.timezone = r.timezone;
  c.status = r.status;
  if (r.status === 'failed' && r.error) c.error = r.error;
  if (r.talk_count !== null && r.talk_count !== undefined) c.talkCount = r.talk_count;
  c.days = r.days ?? [];
  c.levels = r.levels ?? [];
  c.createdAt = new Date(r.created_at).toISOString();
  if (r.scraped_at) c.scrapedAt = new Date(r.scraped_at).toISOString();
  return c;
}

/**
 * @param {Object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {(conferenceId: string) => Promise<void>} deps.enqueue sends the pg-boss `scrape` job
 * @param {(text: string) => Promise<number[]>} deps.embedQuery
 * @param {{windowMs?: number, limit?: number}} [deps.rateLimit] for POST /conferences only
 * @param {number} [deps.minSimilarity]
 * @returns {import('express').Express}
 */
export function createApp({ pool, enqueue, embedQuery, rateLimit: rl = {}, minSimilarity = SEMANTIC_MIN_SIMILARITY }) {
  const app = express();
  app.use(cors({ origin: 'http://localhost:5173' }));
  app.use(express.json());

  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  /** @param {string} cid @returns {Promise<Conference & {timezone?: string}>} or 404 */
  async function getConference(cid) {
    if (!validCid(cid)) throw new HttpError(400, 'Invalid conference id');
    const { rows } = await pool.query(`${CONFERENCE_SELECT} WHERE c.id = $1`, [cid]);
    if (!rows[0]) throw new HttpError(404, 'Unknown conference id');
    return toConference(rows[0]);
  }

  /** Like getConference, but 409 unless the scrape has finished. */
  async function getReadyConference(cid) {
    const conf = await getConference(cid);
    if (conf.status !== 'ready') throw new HttpError(409, `Conference is not ready (status: ${conf.status})`);
    return conf;
  }

  /**
   * Starred talks, in the conference's timezone. Unknown ids are silently absent.
   * @returns {Promise<import('./talks.js').Talk[]>}
   */
  async function fetchTalks(cid, tz, ids) {
    if (ids.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT ${TALK_COLS} FROM talks t WHERE t.conference_id = $1 AND t.id = ANY($2::text[])`,
      [cid, ids],
    );
    return rows.map((r) => toTalk(r, tz));
  }

  const submitLimiter = rateLimit({
    windowMs: rl.windowMs ?? 60_000,
    limit: rl.limit ?? 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many submissions, try again in a minute' }),
  });

  /** POST /conferences {url, timezone?} -> 202 | 200 Conference */
  app.post('/conferences', submitLimiter, wrap(async (req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
    const sourceUrl = validateSourceUrl(body.url);
    const tz = body.timezone;
    if (tz !== undefined && tz !== null && !validTimezone(tz)) throw new HttpError(400, 'timezone must be an IANA name such as America/Denver');
    const timezone = tz ?? null;

    const id = newConferenceId();
    const ins = await pool.query(
      `INSERT INTO conferences (id, source_url, timezone) VALUES ($1, $2, $3)
       ON CONFLICT (source_url) DO NOTHING RETURNING id`,
      [id, sourceUrl, timezone],
    );
    let cid = id;
    let queued = ins.rowCount === 1;
    if (!queued) {
      // Known URL. Only a failed conference is re-queued; the UPDATE is conditional so that two
      // simultaneous resubmits queue one job.
      const upd = await pool.query(
        `UPDATE conferences SET status = 'queued', error = NULL, timezone = coalesce($2, timezone)
         WHERE source_url = $1 AND status = 'failed' RETURNING id`,
        [sourceUrl, timezone],
      );
      queued = upd.rowCount === 1;
      cid = upd.rows[0]?.id;
      if (!cid) {
        const { rows } = await pool.query('SELECT id FROM conferences WHERE source_url = $1', [sourceUrl]);
        cid = rows[0].id;
      }
    }
    if (queued) {
      try {
        await enqueue(cid);
      } catch (e) {
        console.error('enqueue failed', e);
        // Leave the row resubmittable instead of stuck in `queued` with no job.
        await pool.query(
          `UPDATE conferences SET status = 'failed', error = $2 WHERE id = $1 AND status = 'queued'`,
          [cid, 'Could not queue the scrape. Please submit the URL again.'],
        );
        throw new HttpError(503, 'Could not queue the scrape, try again');
      }
    }
    res.status(queued ? 202 : 200).json(await getConference(cid));
  }));

  /** GET /conferences -> { conferences: Conference[] } ready ones, newest first day first */
  app.get('/conferences', wrap(async (_req, res) => {
    const { rows } = await pool.query(`${CONFERENCE_SELECT} WHERE c.status = 'ready'`);
    const conferences = rows.map(toConference).sort((a, b) =>
      (b.days[0] ?? '').localeCompare(a.days[0] ?? '') || cmpId(a.id, b.id));
    res.json({ conferences });
  }));

  /** GET /conferences/:cid -> Conference */
  app.get('/conferences/:cid', wrap(async (req, res) => {
    res.json(await getConference(req.params.cid));
  }));

  /** GET /conferences/:cid/talks?q=&day= -> { talks: Talk[] } */
  app.get('/conferences/:cid/talks', wrap(async (req, res) => {
    const { q, day } = req.query;
    if (!validCid(req.params.cid)) throw new HttpError(400, 'Invalid conference id');
    if (q !== undefined && typeof q !== 'string') throw new HttpError(400, 'Invalid q');
    if (day !== undefined && !validDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
    const conf = await getReadyConference(req.params.cid);
    const { id: cid, timezone: tz } = conf;
    const term = (q || '').trim();

    // $3 is the day, or NULL for every day.
    const dayFilter = `($3::text IS NULL OR (t.start_at >= ($3::date)::timestamp AT TIME ZONE $2
                        AND t.start_at < (($3::date + 1)::timestamp AT TIME ZONE $2)))`;
    const dayArg = day ?? null;

    if (!term) {
      const { rows } = await pool.query(
        `SELECT ${TALK_COLS} FROM talks t WHERE t.conference_id = $1 AND ${dayFilter}
         ORDER BY t.start_at, t.id LIMIT ${BROWSE_SIZE}`,
        [cid, tz, dayArg],
      );
      return res.json({ talks: rows.map((r) => toTalk(r, tz)) });
    }

    const qvec = `[${(await embedQuery(term)).join(',')}]`;
    const [text, vec] = await Promise.all([
      pool.query(
        `SELECT ${TALK_COLS} FROM talks t
         WHERE t.conference_id = $1 AND ${dayFilter} AND t.tsv @@ websearch_to_tsquery('english', $4)
         ORDER BY ts_rank_cd(t.tsv, websearch_to_tsquery('english', $4)) DESC, t.id LIMIT ${SEARCH_SIZE}`,
        [cid, tz, dayArg, term],
      ),
      searchVectors(pool, `SELECT ${TALK_COLS}, 1 - (t.embedding <=> $4::vector) AS similarity FROM talks t
         WHERE t.conference_id = $1 AND t.embedding IS NOT NULL AND ${dayFilter}
         ORDER BY t.embedding <=> $4::vector LIMIT ${SEARCH_SIZE}`, [cid, tz, dayArg, qvec]),
    ]);
    const byId = new Map();
    for (const r of [...text.rows, ...vec.rows]) if (!byId.has(r.id)) byId.set(r.id, r);
    const vecIds = vec.rows.filter((r) => r.similarity >= minSimilarity).map((r) => r.id);
    const fused = rrf([text.rows.map((r) => r.id), vecIds]).slice(0, SEARCH_SIZE);
    res.json({ talks: fused.map((id) => toTalk(byId.get(id), tz)) });
  }));

  /** POST /conferences/:cid/clashes {starred: string[]} -> { clashes: {a: Talk, b: Talk}[] } */
  app.post('/conferences/:cid/clashes', wrap(async (req, res) => {
    if (!validCid(req.params.cid)) throw new HttpError(400, 'Invalid conference id');
    const raw = req.body?.starred;
    const ids = raw === undefined || raw === null ? [] : validateIds(raw);
    const conf = await getReadyConference(req.params.cid);
    const talks = await fetchTalks(conf.id, conf.timezone, ids);
    res.json({ clashes: findClashes(talks) });
  }));

  /** GET /conferences/:cid/alternatives?talk=&starred=&level= -> { alternatives: (Talk & {score: number})[] } */
  app.get('/conferences/:cid/alternatives', wrap(async (req, res) => {
    const { talk: talkId, level } = req.query;
    if (!validCid(req.params.cid)) throw new HttpError(400, 'Invalid conference id');
    if (!validId(talkId)) throw new HttpError(400, 'Invalid talk id');
    const starred = parseStarredParam(req.query.starred);
    if (level !== undefined && typeof level !== 'string') throw new HttpError(400, 'Invalid level');
    const conf = await getReadyConference(req.params.cid);
    if (level !== undefined && !conf.levels.includes(level)) throw new HttpError(400, 'Invalid level');
    const { id: cid, timezone: tz } = conf;

    const known = await pool.query(
      'SELECT embedding IS NOT NULL AS has_embedding FROM talks WHERE conference_id = $1 AND id = $2',
      [cid, talkId],
    );
    if (known.rowCount === 0) throw new HttpError(404, 'Unknown talk id');
    if (!known.rows[0].has_embedding) return res.json({ alternatives: [] });

    // Every starred talk other than the one being replaced must not overlap a result (strict < rule).
    const others = starred.filter((id) => id !== talkId);
    const excluded = [...new Set([talkId, ...starred])];
    const { rows } = await pool.query(
      `SELECT ${TALK_COLS}, 1 - (t.embedding <=> me.embedding) AS score
       FROM talks t, (SELECT embedding FROM talks WHERE conference_id = $1 AND id = $2) me
       WHERE t.conference_id = $1 AND t.embedding IS NOT NULL
         AND t.id <> ALL($3::text[])
         AND ($4::text IS NULL OR t.level = $4)
         AND NOT EXISTS (
           SELECT 1 FROM talks s
           WHERE s.conference_id = $1 AND s.id = ANY($5::text[])
             AND t.start_at < s.end_at AND s.start_at < t.end_at)
       ORDER BY t.embedding <=> me.embedding LIMIT 5`,
      [cid, talkId, excluded, level ?? null, others],
    );
    res.json({
      alternatives: rows.map((r) => ({ ...toTalk(r, tz), score: Math.round(r.score * 10000) / 10000 })),
    });
  }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

/**
 * Run a vector query so that the HNSW index still returns enough rows once the conference filter
 * is applied (pgvector 0.8 iterative scan). Falls back to a plain query on older pgvector.
 * @param {import('pg').Pool} pool
 * @param {string} sql
 * @param {any[]} params
 */
async function searchVectors(pool, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    } catch {
      await client.query('ROLLBACK');
      await client.query('BEGIN');
    }
    // relaxed_order may return rows slightly out of order, so sort again.
    const res = await client.query(`SELECT * FROM (${sql}) v ORDER BY similarity DESC`, params);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
