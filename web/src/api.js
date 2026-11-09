// Data layer. VITE_USE_MOCKS=true serves contract/examples and computes clashes in the browser.
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * @typedef {Object} Talk
 * @property {string} id
 * @property {string} title
 * @property {string} [abstract]
 * @property {string} start ISO with -07:00
 * @property {string} end ISO with -07:00
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} speakers
 * @property {string} [track]
 * @property {string} [level] may be absent
 * @property {string[]} tags
 * @property {number} [score] ranking only, not for display
 */

/** @returns {Promise<Talk[]>} */
async function mockTalks() {
  return (await import('../../contract/examples/talks.json')).default.talks;
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
 * GET /talks
 * @param {{day: string, q?: string}} p day is YYYY-MM-DD
 * @returns {Promise<Talk[]>}
 */
export async function fetchTalks({ day, q }) {
  if (USE_MOCKS) {
    const needle = (q || '').trim().toLowerCase();
    return (await mockTalks())
      .filter((t) => t.start.startsWith(day))
      .filter((t) => !needle || `${t.title} ${t.abstract || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  }
  const params = new URLSearchParams({ day });
  if (q && q.trim()) params.set('q', q.trim());
  return (await getJSON(`${BASE}/talks?${params}`)).talks;
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
 * POST /clashes
 * @param {string[]} starred
 * @returns {Promise<{a: Talk, b: Talk}[]>}
 */
export async function fetchClashes(starred) {
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
  const body = await getJSON(`${BASE}/clashes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starred }),
  });
  return body.clashes;
}

/**
 * GET /alternatives
 * @param {{talk: string, starred: string[], level?: string, accessible?: boolean}} p
 * @returns {Promise<Talk[]>}
 */
export async function fetchAlternatives({ talk, starred, level, accessible }) {
  if (USE_MOCKS) {
    // The example answers one request; narrow it so it stays honest after swaps.
    const all = await mockTalks();
    const others = all.filter((t) => starred.includes(t.id) && t.id !== talk);
    const { alternatives } = (await import('../../contract/examples/alternatives.json')).default;
    return alternatives.filter(
      (t) =>
        !starred.includes(t.id) &&
        !others.some((o) => overlaps(o, t)) &&
        (!level || t.level === level) &&
        (!accessible || t.track === 'Inclusion + Accessibility'),
    );
  }
  const params = new URLSearchParams({ talk, starred: starred.join(',') });
  if (level) params.set('level', level);
  if (accessible) params.set('accessible', 'true');
  return (await getJSON(`${BASE}/alternatives?${params}`)).alternatives;
}
