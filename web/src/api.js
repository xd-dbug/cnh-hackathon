// Data layer. VITE_USE_MOCKS=true serves contract/examples and computes clashes in the browser.
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * @typedef {Object} Talk
 * @property {string} id
 * @property {string} title
 * @property {string} [abstract]
 * @property {string} start ISO 8601 with the conference's UTC offset at that instant
 * @property {string} end ISO 8601 with the conference's UTC offset at that instant
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} speakers
 * @property {string} [track]
 * @property {string} [level] may be absent
 * @property {string[]} tags
 * @property {string} [url] official talk page, when the source has one
 * @property {number} [score] ranking only, not for display
 */

/**
 * @typedef {Object} Conference
 * @property {string} id
 * @property {string} sourceUrl
 * @property {string} [platform]
 * @property {string} [name] always present when ready
 * @property {string} [timezone] IANA name, always present when ready
 * @property {'queued'|'fetching'|'parsing'|'embedding'|'ready'|'failed'} status
 * @property {string} [error] a sentence a user can read, only when failed
 * @property {number} [talkCount] always present when ready
 * @property {string[]} days YYYY-MM-DD in the conference's timezone; [] until ready
 * @property {string[]} levels sorted; [] until ready
 * @property {string} createdAt
 * @property {string} [scrapedAt]
 */

/** @returns {Promise<Talk[]>} */
async function mockTalks() {
  return (await import('../../contract/examples/talks.json')).default.talks;
}

/** @returns {Promise<Conference[]>} */
async function mockConferences() {
  return (await import('../../contract/examples/conferences.json')).default.conferences;
}

/** @returns {Promise<Conference>} */
async function mockQueuedConference() {
  return (await import('../../contract/examples/conference-queued.json')).default;
}

/** @returns {Promise<Conference>} */
async function mockFailedConference() {
  return (await import('../../contract/examples/conference-failed.json')).default;
}

/** Every example conference: ready, queued and failed. @returns {Promise<Conference[]>} */
async function allMockConferences() {
  const ready = await mockConferences();
  const queued = await mockQueuedConference();
  const failed = await mockFailedConference();
  return [...ready, queued, failed];
}

async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* keep default message */
    }
    throw new Error(msg);
  }
  return res.json();
}

/**
 * GET /conferences/:cid/talks
 * @param {string} cid conference id
 * @param {{day?: string, q?: string}} p day is YYYY-MM-DD; omitted when searching (all days)
 * @returns {Promise<Talk[]>}
 */
export async function fetchTalks(cid, { day, q }) {
  if (USE_MOCKS) {
    const needle = (q || '').trim().toLowerCase();
    return (await mockTalks())
      .filter((t) => needle || t.start.startsWith(day))
      .filter((t) => !needle || `${t.title} ${t.abstract || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  }
  const params = new URLSearchParams();
  if (q && q.trim()) params.set('q', q.trim());
  else params.set('day', day);
  return (await getJSON(`${BASE}/conferences/${encodeURIComponent(cid)}/talks?${params}`)).talks;
}

/** Contract overlap rule. */
function overlaps(a, b) {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
}

/** Contract ordering: a starts first (id breaks ties). */
function before(a, b) {
  const d = new Date(a.start) - new Date(b.start);
  return d !== 0 ? d < 0 : a.id < b.id;
}

/**
 * GET /conferences (ready conferences only)
 * @returns {Promise<Conference[]>}
 */
export async function fetchConferences() {
  if (USE_MOCKS) return mockConferences();
  return (await getJSON(`${BASE}/conferences`)).conferences;
}

/**
 * GET /conferences/:cid (any status; the status view polls this)
 * @param {string} cid conference id
 * @returns {Promise<Conference>}
 */
export async function fetchConference(cid) {
  if (USE_MOCKS) {
    const f = (await allMockConferences()).find((c) => c.id === cid);
    if (!f) throw new Error('Conference not found');
    return f;
  }
  return getJSON(`${BASE}/conferences/${encodeURIComponent(cid)}`);
}

/**
 * POST /conferences (202 when queued, 200 when the URL is already known; both return a Conference)
 * @param {{url: string, timezone?: string}} p timezone is an IANA name, used only when the source has none
 * @returns {Promise<Conference>}
 */
export async function submitConference({ url, timezone }) {
  const payload = { url: url.trim() };
  if (timezone && timezone.trim()) payload.timezone = timezone.trim();

  if (USE_MOCKS) {
    const f = (await allMockConferences()).find(c => c.sourceUrl === url.trim());
    if (!f) return mockQueuedConference();
    return f;
  }

  return getJSON(`${BASE}/conferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * POST /conferences/:cid/clashes
 * @param {string} cid conference id
 * @param {string[]} starred
 * @returns {Promise<{a: Talk, b: Talk}[]>}
 */
export async function fetchClashes(cid, starred) {
  if (!starred.length) return [];
  if (USE_MOCKS) {
    const ids = new Set(starred);
    const talks = (await mockTalks()).filter((t) => ids.has(t.id));
    const pairs = [];
    for (let i = 0; i < talks.length; i++) {
      for (let j = i + 1; j < talks.length; j++) {
        if (!overlaps(talks[i], talks[j])) continue;
        const [a, b] = before(talks[i], talks[j]) ? [talks[i], talks[j]] : [talks[j], talks[i]];
        pairs.push({ a, b });
      }
    }
    return pairs.sort(
      (x, y) =>
        new Date(x.a.start) - new Date(y.a.start) ||
        x.a.id.localeCompare(y.a.id) ||
        x.b.id.localeCompare(y.b.id),
    );
  }
  const body = await getJSON(`${BASE}/conferences/${encodeURIComponent(cid)}/clashes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starred }),
  });
  return body.clashes;
}

/**
 * GET /conferences/:cid/alternatives
 * @param {string} cid conference id
 * @param {{talk: string, starred: string[], level?: string}} p
 * @returns {Promise<Talk[]>}
 */
export async function fetchAlternatives(cid, { talk, starred, level }) {
  if (USE_MOCKS) {
    // The example answers one request; narrow it so it stays honest after swaps.
    const all = await mockTalks();
    const others = all.filter((t) => starred.includes(t.id) && t.id !== talk);
    const { alternatives } = (await import('../../contract/examples/alternatives.json')).default;
    return alternatives.filter(
      (t) =>
        !starred.includes(t.id) &&
        !others.some((o) => overlaps(o, t)) &&
        (!level || t.level === level),
    );
  }
  const params = new URLSearchParams({ talk, starred: starred.join(',') });
  if (level) params.set('level', level);
  return (await getJSON(`${BASE}/conferences/${encodeURIComponent(cid)}/alternatives?${params}`)).alternatives;
}
