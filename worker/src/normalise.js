import { UserError } from './errors.js';
import { formatInTz, isValidTimezone, parseTime } from './tz.js';

export const MAX_DURATION_MS = 4 * 3600 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Breaks, meals and registration, whatever the source. Leading emoji and punctuation are ignored
// ("☕ Coffee Break", "🍲 Lunch"), and so is a qualifier after "|" or "(" ("Lunch | On Own",
// "Lunch (provided)"). Otherwise the whole title must be the service name, so "Breaking Changes in
// Kubernetes", "Lunch & Learn: eBPF" or "Registration: OIDC Flows" are kept.
const SERVICE_TITLE = /^(?:(?:morning|afternoon|coffee|tea|snack)\s+)?(?:break|lunch|breakfast|registration|badge pick-?up)(?:\s*(?:break|&\s*networking))?(?:\s*[|(].*)?$/i;

/**
 * @param {string} title
 * @returns {boolean} true for a break, meal or registration slot
 */
export function isServiceTitle(title) {
  return SERVICE_TITLE.test(String(title ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
}

/**
 * @typedef {object} Talk The shape of a `talks` row, before embedding.
 * @property {string} id
 * @property {string} title
 * @property {string} [abstract]
 * @property {string} [url]
 * @property {string} start ISO 8601 with the conference's offset at that instant
 * @property {string} end
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} speakers
 * @property {string} [track]
 * @property {string} [level]
 * @property {string[]} tags
 */

/**
 * Turn raw adapter output into Talks: skip service sessions, anything over 4 hours, unusable ids and
 * times, and duplicate ids. Times without an offset are wall-clock times in `timezone`.
 * @param {import('./adapters/sessionize.js').RawSession[]} raw
 * @param {{timezone?: string, hint?: string}} tzInfo `timezone` from the source, `hint` from the user
 * @returns {{talks: Talk[], timezone: string, skipped: Record<string, number>}}
 */
export function normalise(raw, { timezone, hint } = {}) {
  const tz = timezone ?? hint;
  if (!tz) {
    throw new UserError("This schedule doesn't say which timezone it uses. Enter the conference's timezone (for example America/Denver) and try again.");
  }
  if (!isValidTimezone(tz)) throw new UserError(`"${tz}" isn't a timezone name. Use a name like America/Denver.`);

  const skipped = { service: 0, tooLong: 0, badId: 0, badTime: 0, duplicate: 0 };
  const seen = new Set();
  const talks = [];
  for (const r of raw) {
    if (r.isService || isServiceTitle(r.title)) { skipped.service++; continue; }
    if (!ID.test(String(r.id ?? ''))) { skipped.badId++; continue; }
    if (seen.has(r.id)) { skipped.duplicate++; continue; }
    let start;
    let end;
    try {
      start = parseTime(r.start, tz);
      end = parseTime(r.end, tz);
    } catch {
      skipped.badTime++;
      continue;
    }
    if (!(end >= start)) { skipped.badTime++; continue; }
    if (end - start > MAX_DURATION_MS) { skipped.tooLong++; continue; }
    seen.add(r.id);
    const talk = {
      id: r.id,
      title: r.title,
      abstract: r.abstract || undefined,
      url: r.url || undefined,
      start: formatInTz(start, tz),
      end: formatInTz(end, tz),
      room: r.room || undefined,
      venue: r.venue || undefined,
      speakers: r.speakers ?? [],
      track: r.track || undefined,
      level: r.level || undefined,
      tags: r.tags ?? [],
    };
    for (const k of Object.keys(talk)) if (talk[k] === undefined) delete talk[k];
    talks.push(talk);
  }
  talks.sort((a, b) => (Date.parse(a.start) - Date.parse(b.start)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { talks, timezone: tz, skipped };
}
