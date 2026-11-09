import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@elastic/elasticsearch';
import he from 'he';

const SCHEDULE = fileURLToPath(new URL('../schedule.html', import.meta.url));
const MAPPING = fileURLToPath(new URL('../contract/mapping.json', import.meta.url));
const INDEX = 'talks';
const BATCH = 50;
const MAX_MS = 90 * 60 * 1000;
const TRACKS = new Set([
  'AI Inference + Agentic', 'Application Development + Delivery', 'Cloud Native Experience',
  'Cloud Native Novice', 'Connectivity', 'Data Processing + Storage', 'Emerging + Advanced',
  'Observability', 'Operations + Performance', 'Platform Engineering', 'Security',
  'Maintainer Track', '⚡ Lightning Talks', '📚 Tutorials', 'Inclusion + Accessibility',
  'Project Lightning Talks',
]);

/**
 * Extract and parse the embedded Sessionize JSON from schedule.html.
 * @returns {object} data.all (sessions, speakers, rooms, categories)
 */
function readSchedule() {
  const html = readFileSync(SCHEDULE, 'utf8');
  const m = html.match(/<script[^>]*class="sched-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('sched-data script not found in schedule.html');
  const data = JSON.parse(m[1]);
  return data.all ?? data;
}

/**
 * Strip HTML, decode entities, keep paragraph breaks as \n\n.
 * @param {string} [html]
 * @returns {string}
 */
function cleanAbstract(html = '') {
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return he.decode(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Map Sessionize data to Talk documents (contract shape), applying the track allowlist and 90 minute limit.
 * @param {object} all data.all
 * @returns {Array<object>} Talk documents
 */
function buildTalks(all) {
  const rooms = new Map((all.rooms ?? []).map((r) => [r.id, r.name]));
  const speakers = new Map((all.speakers ?? []).map((s) => [s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()]));
  const cats = new Map();
  for (const c of all.categories ?? []) cats.set(c.title, new Map((c.items ?? []).map((i) => [i.id, i.name])));
  const names = (s, title) => (s.categoryItems ?? []).map((id) => cats.get(title)?.get(id)).filter(Boolean);

  const talks = [];
  for (const s of all.sessions ?? []) {
    if (!s.startsAt || !s.endsAt) continue;
    const start = `${s.startsAt}-07:00`;
    const end = `${s.endsAt}-07:00`;
    const dur = new Date(end) - new Date(start);
    const track = names(s, 'All Sessions')[0];
    if (!TRACKS.has(track) || !(dur <= MAX_MS)) continue;
    const room = rooms.get(s.roomId);
    const doc = {
      id: String(s.id),
      title: s.title,
      abstract: cleanAbstract(s.description),
      start,
      end,
      room,
      venue: room ? room.split(' | ')[0] : undefined,
      speakers: (s.speakers ?? []).map((id) => speakers.get(id)).filter(Boolean),
      track,
      level: names(s, 'Audience Level')[0],
      tags: [...names(s, 'SubTopic'), ...names(s, 'CNCF Projects')],
    };
    for (const k of Object.keys(doc)) if (doc[k] === undefined || doc[k] === '') delete doc[k];
    talks.push(doc);
  }
  return talks.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

async function main() {
  if (!process.env.ES_URL || !process.env.ES_API_KEY) throw new Error('ES_URL and ES_API_KEY must be set (via ../.env)');
  const client = new Client({ node: process.env.ES_URL, auth: { apiKey: process.env.ES_API_KEY } });

  const talks = buildTalks(readSchedule());
  const perDay = {};
  for (const t of talks) perDay[t.start.slice(0, 10)] = (perDay[t.start.slice(0, 10)] ?? 0) + 1;

  const mapping = JSON.parse(readFileSync(MAPPING, 'utf8'));
  await client.indices.delete({ index: INDEX }, { ignore: [404] });
  try {
    await client.indices.create({ index: INDEX, ...mapping });
  } catch (e) {
    if (JSON.stringify(e.meta?.body ?? e.message).includes('inference')) {
      console.error('Inference endpoint .elser-2-elastic appears to be missing. Stopping.');
    }
    throw e;
  }

  for (let i = 0; i < talks.length; i += BATCH) {
    const batch = talks.slice(i, i + BATCH);
    const operations = batch.flatMap((t) => [{ index: { _index: INDEX, _id: t.id } }, t]);
    const res = await client.bulk({ operations });
    if (res.errors) {
      const bad = res.items.filter((it) => it.index?.error).slice(0, 3).map((it) => JSON.stringify(it.index.error));
      throw new Error(`Bulk errors: ${bad.join('; ')}`);
    }
    console.log(`Loaded ${Math.min(i + BATCH, talks.length)}/${talks.length}`);
  }
  await client.indices.refresh({ index: INDEX });

  const { count } = await client.count({ index: INDEX });
  console.log(`\nTalks in index: ${count}`);
  console.log('Per day:');
  for (const [d, n] of Object.entries(perDay).sort()) console.log(`  ${d}: ${n}`);
  const sample = await client.get({ index: INDEX, id: '1289913' }).catch(() => null);
  console.log('Sample document:');
  console.log(JSON.stringify(sample?._source ?? talks[0], null, 2));
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
