// Runs against TEST_DATABASE_URL (skipped when unset), in a schema of its own that is created from
// contract/schema.sql and dropped at the end. It never touches any other schema.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'TEST_DATABASE_URL is not set';

const SCHEMA = `api_test_${randomBytes(4).toString('hex')}`;
let admin;
let pool;
let server;
let base;
let enqueued;
let failEnqueue = false;

const DIM = 384;
/** A vector whose cosine similarity to e0 = [1,0,...] is `cos`. */
const vec = (cos) => {
  const v = new Array(DIM).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(1 - cos * cos);
  return `[${v.join(',')}]`;
};
const queryVec = (cos) => JSON.parse(vec(cos));

const READY = 'rdy0000001';
const BUSY = 'bsy0000001';
const FAILED = 'fld0000001';
const UTC_CONF = 'utc0000001';

async function insertTalk(cid, id, start, end, { title = id, abstract = null, level = null, embedding = null, tags = [] } = {}) {
  await pool.query(
    `INSERT INTO talks (conference_id, id, title, abstract, start_at, end_at, level, tags, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [cid, id, title, abstract, start, end, level, tags, embedding],
  );
}

async function api(path, init) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json() };
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: URL_ });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  pool = new pg.Pool({ connectionString: URL_, options: `-c search_path=${SCHEMA},public` });
  await pool.query(await readFile(new URL('../../contract/schema.sql', import.meta.url), 'utf8'));

  for (const [id, url, status] of [[BUSY, 'https://busy.example/s', 'parsing']]) {
    await pool.query('INSERT INTO conferences (id, source_url, status) VALUES ($1, $2, $3)', [id, url, status]);
  }
  await pool.query(
    `INSERT INTO conferences (id, source_url, status, error) VALUES ($1, 'https://failed.example/s', 'failed', 'Unsupported site')`,
    [FAILED],
  );
  await pool.query(
    `INSERT INTO conferences (id, source_url, status, name, timezone, talk_count, platform, scraped_at)
     VALUES ($1, 'https://ready.example/s', 'ready', 'Ready Conf', 'America/Denver', 8, 'sessionize', now()),
            ($2, 'https://utc.example/s', 'ready', 'Utc Conf', 'UTC', 1, 'pretalx', now())`,
    [READY, UTC_CONF],
  );

  // The DST change in Denver: 2026-11-01 02:00 MDT becomes 01:00 MST (08:00Z).
  await insertTalk(READY, 'dst1', '2026-11-01T07:30:00Z', '2026-11-01T08:15:00Z', { title: 'Late night MDT' });
  await insertTalk(READY, 'dst2', '2026-11-01T08:30:00Z', '2026-11-01T09:00:00Z', { title: 'Late night MST' });
  // 2026-11-10 (MST, -07:00), the contract's demo day.
  await insertTalk(READY, 'B-1', '2026-11-10T18:30:00Z', '2026-11-10T19:00:00Z', {
    title: 'Backing up volumes with Velero', abstract: 'Snapshots and restores of persistent volumes', level: 'Advanced', embedding: vec(1),
  });
  await insertTalk(READY, 'B-2', '2026-11-10T18:30:00Z', '2026-11-10T19:00:00Z', { title: 'Overlaps B-1 exactly', level: 'Beginner', embedding: vec(0.95) });
  // Starts the moment B-1 ends: touching, so no clash.
  await insertTalk(READY, 'B-3', '2026-11-10T19:00:00Z', '2026-11-10T19:30:00Z', {
    title: 'Touching talk', level: 'Advanced', embedding: vec(0.9), abstract: 'Kubernetes storage',
  });
  await insertTalk(READY, 'B-4', '2026-11-10T20:00:00Z', '2026-11-10T20:30:00Z', { title: 'Far later', level: 'Advanced', embedding: vec(0.8) });
  await insertTalk(READY, 'B-5', '2026-11-10T18:45:00Z', '2026-11-10T19:15:00Z', { title: 'Overlaps B-1 partially', level: 'Advanced', embedding: vec(0.99) });
  await insertTalk(READY, 'noemb', '2026-11-11T16:00:00Z', '2026-11-11T16:30:00Z', { title: 'No embedding here' });
  await insertTalk(UTC_CONF, 'u1', '2026-11-10T23:30:00Z', '2026-11-11T00:30:00Z', { title: 'UTC talk' });

  const app = createApp({
    pool,
    enqueue: async (id) => {
      if (failEnqueue) throw new Error('queue down');
      enqueued.push(id);
    },
    // Deterministic: every query embeds to "cos 1 with B-1".
    embedQuery: async (text) => (text.includes('zzz') ? queryVec(0) : queryVec(1)),
    rateLimit: { limit: 1000 },
    minSimilarity: 0.65,
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  enqueued = [];
});

after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await admin.end();
});

test('POST /conferences: 202 for a new URL, 200 for the same URL with a fragment', { skip }, async () => {
  const a = await post('/conferences', { url: 'https://New.Example.com:443/Sched#top', timezone: 'Europe/Berlin' });
  assert.equal(a.status, 202);
  assert.match(a.body.id, /^[a-z0-9]{10}$/);
  assert.equal(a.body.sourceUrl, 'https://new.example.com/Sched');
  assert.equal(a.body.status, 'queued');
  assert.equal(a.body.timezone, 'Europe/Berlin');
  assert.deepEqual([a.body.days, a.body.levels], [[], []]);
  assert.deepEqual(enqueued, [a.body.id]);

  const b = await post('/conferences', { url: 'https://new.example.com/Sched#other' });
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.deepEqual(enqueued, [a.body.id]); // nothing new queued
  const { rows } = await pool.query('SELECT count(*)::int n FROM conferences WHERE source_url = $1', ['https://new.example.com/Sched']);
  assert.equal(rows[0].n, 1);
});

test('POST /conferences: a bare host gets the same trailing slash the worker produces', { skip }, async () => {
  const a = await post('/conferences', { url: 'https://bare.example.com' });
  assert.equal(a.status, 202);
  assert.equal(a.body.sourceUrl, 'https://bare.example.com/');
});

test('POST /conferences: a failed conference is re-queued, with timezone updated and error cleared', { skip }, async () => {
  enqueued.length = 0;
  const r = await post('/conferences', { url: 'https://failed.example/s', timezone: 'Asia/Tokyo' });
  assert.equal(r.status, 202);
  assert.equal(r.body.id, FAILED);
  assert.equal(r.body.status, 'queued');
  assert.equal(r.body.error, undefined);
  assert.equal(r.body.timezone, 'Asia/Tokyo');
  assert.deepEqual(enqueued, [FAILED]);
  const { rows } = await pool.query('SELECT error FROM conferences WHERE id = $1', [FAILED]);
  assert.equal(rows[0].error, null);
  // Now queued, so a resubmit is a plain 200.
  const again = await post('/conferences', { url: 'https://failed.example/s' });
  assert.equal(again.status, 200);
  assert.deepEqual(enqueued, [FAILED]);
});

test('POST /conferences: a queue failure leaves the conference failed and resubmittable', { skip }, async () => {
  failEnqueue = true;
  const r = await post('/conferences', { url: 'https://qdown.example/s' });
  failEnqueue = false;
  assert.equal(r.status, 503);
  const { rows } = await pool.query("SELECT id, status FROM conferences WHERE source_url = 'https://qdown.example/s'");
  assert.equal(rows[0].status, 'failed');
  enqueued.length = 0;
  const again = await post('/conferences', { url: 'https://qdown.example/s' });
  assert.equal(again.status, 202);
  assert.deepEqual(enqueued, [rows[0].id]);
});

test('POST /conferences: 400s', { skip }, async () => {
  for (const body of [
    {}, { url: 5 }, { url: 'nope' }, { url: 'ftp://x.com/a' }, { url: 'http://localhost/a' }, { url: 'http://10.0.0.1/' },
    { url: 'https://ok.example/s', timezone: 'Mars/Base' }, { url: 'https://ok.example/s', timezone: 5 }, [],
  ]) {
    const r = await post('/conferences', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
  }
  const bad = await api('/conferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('POST /conferences: 429 after the limit, and only on this route', { skip }, async () => {
  const limited = createApp({ pool, enqueue: async () => {}, embedQuery: async () => [], rateLimit: { limit: 2, windowMs: 60_000 } });
  const s = await new Promise((r) => { const x = limited.listen(0, () => r(x)); });
  const b = `http://127.0.0.1:${s.address().port}`;
  const send = () => fetch(`${b}/conferences`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"x"}' });
  try {
    assert.equal((await send()).status, 400);
    assert.equal((await send()).status, 400);
    const third = await send();
    assert.equal(third.status, 429);
    assert.equal(typeof (await third.json()).error, 'string');
    assert.equal((await fetch(`${b}/conferences`)).status, 200);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('GET /conferences lists only ready ones, by first day descending then id', { skip }, async () => {
  const r = await api('/conferences');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.conferences.map((c) => c.id), [UTC_CONF, READY]);
  const ready = r.body.conferences.find((c) => c.id === READY);
  assert.deepEqual(ready.days, ['2026-11-01', '2026-11-10', '2026-11-11']);
  assert.deepEqual(ready.levels, ['Advanced', 'Beginner']);
  assert.equal(ready.talkCount, 8);
  assert.equal(ready.platform, 'sessionize');
  assert.match(ready.scrapedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
});

test('GET /conferences/:cid: ready, in progress, failed, 404, 400', { skip }, async () => {
  const ready = await api(`/conferences/${READY}`);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.name, 'Ready Conf');
  assert.equal(ready.body.timezone, 'America/Denver');
  const busy = await api(`/conferences/${BUSY}`);
  assert.deepEqual(Object.keys(busy.body), ['id', 'sourceUrl', 'status', 'days', 'levels', 'createdAt']);
  assert.equal(busy.body.status, 'parsing');
  const failed = await api(`/conferences/${FAILED}`);
  assert.equal(failed.body.status, 'queued'); // re-queued by the earlier test
  assert.equal((await api('/conferences/zzzzzzzzzz')).status, 404);
  assert.equal((await api('/conferences/BAD')).status, 400);
});

test('talks: browse sorted by start then id, with the conference offset at each instant', { skip }, async () => {
  const r = await api(`/conferences/${READY}/talks`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.talks.map((t) => t.id), ['dst1', 'dst2', 'B-1', 'B-2', 'B-5', 'B-3', 'B-4', 'noemb']);
  const [dst1, dst2, b1] = r.body.talks;
  assert.equal(dst1.start, '2026-11-01T01:30:00-06:00');
  assert.equal(dst2.start, '2026-11-01T01:30:00-07:00');
  assert.equal(b1.start, '2026-11-10T11:30:00-07:00');
  assert.deepEqual(dst1.speakers, []);
  assert.equal(dst1.abstract, undefined);
});

test('talks: day filter is the calendar day in the conference timezone, across the DST change', { skip }, async () => {
  const day = async (d, cid = READY) => (await api(`/conferences/${cid}/talks?day=${d}`)).body.talks.map((t) => t.id);
  assert.deepEqual(await day('2026-11-01'), ['dst1', 'dst2']);
  assert.deepEqual(await day('2026-10-31'), []);
  assert.deepEqual(await day('2026-11-10'), ['B-1', 'B-2', 'B-5', 'B-3', 'B-4']);
  // 23:30Z on Nov 10 is Nov 10 in UTC, and 16:30 the same day in Denver.
  assert.deepEqual(await day('2026-11-10', UTC_CONF), ['u1']);
  assert.deepEqual(await day('2026-11-11', UTC_CONF), []);
});

test('talks: 400 for a bad day, 404, 409', { skip }, async () => {
  assert.equal((await api(`/conferences/${READY}/talks?day=2026-1-1`)).status, 400);
  assert.equal((await api(`/conferences/${READY}/talks?day=2026-02-30`)).status, 400);
  assert.equal((await api('/conferences/zzzzzzzzzz/talks')).status, 404);
  const busy = await api(`/conferences/${BUSY}/talks`);
  assert.equal(busy.status, 409);
  assert.equal(typeof busy.body.error, 'string');
});

test('talks: hybrid search fuses full text and vectors, and the similarity floor drops noise', { skip }, async () => {
  const hit = await api(`/conferences/${READY}/talks?q=velero`);
  assert.equal(hit.status, 200);
  // B-1 matches both rankings. Vector hits at cos >= 0.65 follow: 0.99, 0.95, 0.9, 0.8.
  assert.deepEqual(hit.body.talks.map((t) => t.id), ['B-1', 'B-5', 'B-2', 'B-3', 'B-4']);
  const none = await api(`/conferences/${READY}/talks?q=zzz`);
  assert.deepEqual(none.body.talks, []);
  const day = await api(`/conferences/${READY}/talks?q=velero&day=2026-11-11`);
  assert.deepEqual(day.body.talks, []);
});

test('clashes: pairs, ordering, unknown ids ignored, validation, 404, 409', { skip }, async () => {
  const r = await post(`/conferences/${READY}/clashes`, { starred: ['B-5', 'B-1', 'B-3', 'B-2', 'nope', 'B-1'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clashes.map((c) => `${c.a.id}-${c.b.id}`), ['B-1-B-2', 'B-1-B-5', 'B-2-B-5', 'B-5-B-3']);
  assert.equal(r.body.clashes[0].a.start, '2026-11-10T11:30:00-07:00');
  assert.deepEqual((await post(`/conferences/${READY}/clashes`, {})).body, { clashes: [] });
  assert.deepEqual((await post(`/conferences/${READY}/clashes`, { starred: [] })).body, { clashes: [] });
  assert.equal((await post(`/conferences/${READY}/clashes`, { starred: 'x' })).status, 400);
  assert.equal((await post(`/conferences/${READY}/clashes`, { starred: ['a b'] })).status, 400);
  assert.equal((await post(`/conferences/${READY}/clashes`, { starred: Array.from({ length: 101 }, (_, i) => `t${i}`) })).status, 400);
  assert.equal((await post('/conferences/zzzzzzzzzz/clashes', { starred: [] })).status, 404);
  assert.equal((await post(`/conferences/${BUSY}/clashes`, { starred: [] })).status, 409);
});

test('alternatives: nothing overlaps a starred talk other than the one being replaced', { skip }, async () => {
  // Replace B-1 while B-4 stays starred: B-4 (20:00Z-20:30Z) rules itself out, B-2 and B-5 overlap B-1 but B-1 is replaced.
  const r = await api(`/conferences/${READY}/alternatives?talk=B-1&starred=B-1,B-4`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alternatives.map((a) => a.id), ['B-5', 'B-2', 'B-3']);
  assert.deepEqual(r.body.alternatives.map((a) => a.score), [0.99, 0.95, 0.9]);
  assert.ok(r.body.alternatives.every((a) => a.score <= 1));
  // Starring B-3 as well removes B-5 (overlaps B-3 18:45-19:15 vs 19:00-19:30), but not B-2 (touching is fine).
  const r2 = await api(`/conferences/${READY}/alternatives?talk=B-1&starred=B-1,B-3`);
  assert.deepEqual(r2.body.alternatives.map((a) => a.id), ['B-2', 'B-4']);
  // Touching talks do not clash: starring B-3 keeps nothing that ends after 19:00Z... check B-2 vs B-3.
  const r3 = await api(`/conferences/${READY}/alternatives?talk=B-3&starred=B-3,B-1`);
  assert.ok(!r3.body.alternatives.some((a) => ['B-1', 'B-2', 'B-5'].includes(a.id)), 'B-2 and B-5 overlap starred B-1');
});

test('alternatives: level filter, no embedding, 400, 404, 409', { skip }, async () => {
  const lvl = await api(`/conferences/${READY}/alternatives?talk=B-1&level=Beginner`);
  assert.deepEqual(lvl.body.alternatives.map((a) => a.id), ['B-2']);
  assert.equal((await api(`/conferences/${READY}/alternatives?talk=B-1&level=Expert`)).status, 400);
  assert.deepEqual((await api(`/conferences/${READY}/alternatives?talk=noemb`)).body, { alternatives: [] });
  assert.equal((await api(`/conferences/${READY}/alternatives`)).status, 400);
  assert.equal((await api(`/conferences/${READY}/alternatives?talk=a%20b`)).status, 400);
  assert.equal((await api(`/conferences/${READY}/alternatives?talk=B-1&starred=a%20b`)).status, 400);
  const unknown = await api(`/conferences/${READY}/alternatives?talk=nope`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'Unknown talk id' });
  assert.equal((await api('/conferences/zzzzzzzzzz/alternatives?talk=B-1')).status, 404);
  assert.equal((await api(`/conferences/${BUSY}/alternatives?talk=B-1`)).status, 409);
});
