import express from 'express';
import cors from 'cors';
import { Client } from '@elastic/elasticsearch';

const INDEX = process.env.TALKS_INDEX || 'talks';
const PORT = process.env.PORT || 3001;
const SEARCH_SIZE = 50;
// Calibrated on the real index: real queries score 8-20 on their best talk, nonsense <= 5.
const SEMANTIC_MIN_SCORE = 6;
const LEVELS = ['Beginner', 'Any Level', 'Advanced'];
const ACCESSIBLE_TRACK = 'Inclusion + Accessibility';
const FIELDS = ['id', 'title', 'abstract', 'start', 'end', 'room', 'venue', 'speakers', 'track', 'level', 'tags'];
const MAX_STARRED = 100;

const es = new Client({ node: process.env.ES_URL, auth: { apiKey: process.env.ES_API_KEY } });

/**
 * @typedef {Object} Talk
 * @property {string} id
 * @property {string} title
 * @property {string} [abstract]
 * @property {string} start  YYYY-MM-DDTHH:mm:ss-07:00
 * @property {string} end
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} speakers
 * @property {string} [track]
 * @property {string} [level]
 * @property {string[]} tags
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Normalise an ES _source into the contract Talk shape: missing strings omitted, missing arrays [].
 * @param {Record<string, any>} src
 * @returns {Talk}
 */
function toTalk(src) {
  const talk = {};
  for (const f of FIELDS) {
    if (f === 'speakers' || f === 'tags') talk[f] = Array.isArray(src[f]) ? src[f] : [];
    else if (typeof src[f] === 'string' && src[f] !== '') talk[f] = src[f];
  }
  return talk;
}

/** @param {unknown} id */
const validId = (id) => typeof id === 'string' && /^\d+$/.test(id);

/** Compare two digit-string ids numerically. */
const cmpId = (x, y) => {
  const a = BigInt(x);
  const b = BigInt(y);
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Fetch talks by id (unknown ids are silently absent).
 * @param {string[]} ids
 * @returns {Promise<Talk[]>}
 */
async function fetchTalks(ids) {
  if (ids.length === 0) return [];
  const res = await es.search({
    index: INDEX,
    size: ids.length,
    query: { terms: { id: ids } },
  });
  return res.hits.hits.map((h) => toTalk(h._source));
}

/**
 * @param {unknown} ids
 * @returns {string[]} de-duplicated, validated ids
 */
function validateIds(ids) {
  if (!Array.isArray(ids) || ids.some((i) => !validId(i))) throw new HttpError(400, 'Invalid starred ids');
  if (ids.length > MAX_STARRED) throw new HttpError(400, 'Too many starred ids');
  return [...new Set(ids)];
}

/**
 * Parse and validate a comma separated id list.
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseStarredParam(raw) {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string') throw new HttpError(400, 'Invalid starred ids');
  return validateIds(raw.split(',').filter((s) => s !== ''));
}

/** @param {string} day YYYY-MM-DD @returns {string} the next day, YYYY-MM-DD */
function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** @param {unknown} day */
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/** GET /talks?q=&day= -> { talks: Talk[] } */
app.get('/talks', wrap(async (req, res) => {
  const { q, day } = req.query;
  if (q !== undefined && typeof q !== 'string') throw new HttpError(400, 'Invalid q');
  if (day !== undefined && !validDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  const term = (q || '').trim();
  const filter = day
    ? [{ range: { start: { gte: `${day}T00:00:00-07:00`, lt: `${nextDay(day)}T00:00:00-07:00` } } }]
    : [];

  const body = term
    ? {
        size: SEARCH_SIZE,
        retriever: {
          rrf: {
            rank_window_size: SEARCH_SIZE,
            retrievers: [
              {
                standard: {
                  query: {
                    multi_match: { query: term, fields: ['title^3', 'speakers^2', 'tags'], minimum_should_match: '2<75%' },
                  },
                  filter,
                },
              },
              {
                standard: {
                  query: { semantic: { field: 'abstract', query: term } },
                  filter,
                  // ELSER scores every doc a little; below this the match is noise.
                  min_score: SEMANTIC_MIN_SCORE,
                },
              },
            ],
          },
        },
      }
    : {
        size: 400,
        query: { bool: { filter } },
        sort: [{ start: 'asc' }, { id: 'asc' }],
      };
  const r = await es.search({ index: INDEX, ...body });
  res.json({ talks: r.hits.hits.map((h) => toTalk(h._source)) });
}));

/** POST /clashes {starred: string[]} -> { clashes: {a: Talk, b: Talk}[] } */
app.post('/clashes', wrap(async (req, res) => {
  const raw = req.body?.starred;
  const ids = raw === undefined || raw === null ? [] : validateIds(raw);
  const talks = await fetchTalks(ids);
  const t = (s) => Date.parse(s);
  const clashes = [];
  for (const x of talks) {
    for (const y of talks) {
      if (x === y) continue;
      // a is the one that starts first (id breaks ties); emit each pair once
      const xFirst = t(x.start) < t(y.start) || (t(x.start) === t(y.start) && cmpId(x.id, y.id) < 0);
      if (xFirst && t(x.start) < t(y.end) && t(y.start) < t(x.end)) clashes.push({ a: x, b: y });
    }
  }
  clashes.sort((p, q) => t(p.a.start) - t(q.a.start) || cmpId(p.a.id, q.a.id) || cmpId(p.b.id, q.b.id));
  res.json({ clashes });
}));

/** GET /alternatives?talk=&starred=&level=&accessible= -> { alternatives: (Talk & {score:number})[] } */
app.get('/alternatives', wrap(async (req, res) => {
  const { talk: talkId, level, accessible } = req.query;
  if (!validId(talkId)) throw new HttpError(400, 'Invalid talk id');
  const starred = parseStarredParam(req.query.starred);
  if (level !== undefined && !LEVELS.includes(level)) throw new HttpError(400, 'Invalid level');

  const [talk] = await fetchTalks([talkId]);
  if (!talk) throw new HttpError(404, 'Unknown talk id');
  if (!talk.abstract) return res.json({ alternatives: [] });

  // Every starred talk other than the one being replaced; unknown ids are ignored.
  const others = await fetchTalks(starred.filter((id) => id !== talkId));
  const excludeIds = [...new Set([talkId, ...starred])];

  const r = await es.search({
    index: INDEX,
    size: 5,
    query: {
      bool: {
        must: [{ semantic: { field: 'abstract', query: talk.abstract } }],
        filter: level ? [{ term: { level } }] : [],
        should: accessible === 'true' ? [{ term: { track: { value: ACCESSIBLE_TRACK, boost: 2 } } }] : [],
        must_not: [
          { terms: { id: excludeIds } },
          ...others.map((o) => ({
            bool: { filter: [{ range: { start: { lt: o.end } } }, { range: { end: { gt: o.start } } }] },
          })),
        ],
      },
    },
  });
  res.json({
    alternatives: r.hits.hits.map((h) => ({ ...toTalk(h._source), score: h._score })),
  });
}));

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => console.log(`API listening on ${PORT}`));
