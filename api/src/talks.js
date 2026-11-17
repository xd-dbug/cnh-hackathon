const FIELDS = ['id', 'title', 'abstract', 'start', 'end', 'room', 'venue', 'speakers', 'track', 'level', 'tags', 'url'];

/**
 * @typedef {Object} Talk
 * @property {string} id
 * @property {string} title
 * @property {string} [abstract]
 * @property {string} start  YYYY-MM-DDTHH:mm:ss±HH:MM, in the conference's timezone
 * @property {string} end
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} speakers
 * @property {string} [track]
 * @property {string} [level]
 * @property {string[]} tags
 * @property {string} [url]
 */

const formatters = new Map();

/** @param {string} tz @returns {Intl.DateTimeFormat} */
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'longOffset',
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Format an instant as ISO 8601 in a zone, with the zone's UTC offset at that instant.
 * @param {Date | string | number} instant
 * @param {string} tz IANA zone name
 * @returns {string} YYYY-MM-DDTHH:mm:ss±HH:MM
 */
export function formatInZone(instant, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(instant))) p[type] = value;
  // longOffset gives "GMT-07:00", or plain "GMT" for UTC.
  const off = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '').replace('−', '-');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/**
 * Turn a talks row into the contract Talk shape: missing strings omitted, missing arrays [].
 * @param {Record<string, any>} row columns of `talks`, with start_at/end_at as Date or string
 * @param {string} tz the conference's timezone
 * @returns {Talk}
 */
export function toTalk(row, tz) {
  const src = { ...row, start: formatInZone(row.start_at, tz), end: formatInZone(row.end_at, tz) };
  const talk = {};
  for (const f of FIELDS) {
    if (f === 'speakers' || f === 'tags') talk[f] = Array.isArray(src[f]) ? src[f] : [];
    else if (typeof src[f] === 'string' && src[f] !== '') talk[f] = src[f];
  }
  return talk;
}

/** Plain string comparison, as the contract's "sort by id" says. */
export const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every pair of overlapping talks (a.start < b.end && b.start < a.end), once each, with `a` the one
 * that starts first (id breaks ties), sorted by a.start, a.id, b.id.
 * @param {Talk[]} talks
 * @returns {{a: Talk, b: Talk}[]}
 */
export function findClashes(talks) {
  const t = (s) => Date.parse(s);
  const clashes = [];
  for (const x of talks) {
    for (const y of talks) {
      if (x === y) continue;
      const xFirst = t(x.start) < t(y.start) || (t(x.start) === t(y.start) && cmpId(x.id, y.id) < 0);
      if (xFirst && t(x.start) < t(y.end) && t(y.start) < t(x.end)) clashes.push({ a: x, b: y });
    }
  }
  clashes.sort((p, q) => t(p.a.start) - t(q.a.start) || cmpId(p.a.id, q.a.id) || cmpId(p.b.id, q.b.id));
  return clashes;
}

/**
 * Reciprocal rank fusion. Each list is ordered best first.
 * @param {string[][]} lists ids per ranking
 * @param {number} [k]
 * @returns {string[]} ids by fused score descending, id ascending on ties
 */
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || cmpId(a[0], b[0])).map(([id]) => id);
}
