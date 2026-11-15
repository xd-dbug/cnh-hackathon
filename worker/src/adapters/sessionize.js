import { cleanAbstract, nameFromTitle } from '../clean.js';
import { UserError } from '../errors.js';

/**
 * @typedef {object} RawSession What every adapter produces, before normalisation.
 * @property {string} id source's own id
 * @property {string} title
 * @property {string} [abstract] plain text
 * @property {string} [url] the talk's official page
 * @property {string} start ISO 8601; with an offset it is exact, without one it is wall-clock time
 * @property {string} end same rules as `start`
 * @property {string} [room]
 * @property {string} [venue]
 * @property {string[]} [speakers]
 * @property {string} [track]
 * @property {string} [level]
 * @property {string[]} [tags]
 * @property {boolean} [isService] break, lunch, registration
 */

/**
 * @typedef {object} AdapterContext
 * @property {string} [url] where the content came from (may be absent for a local file)
 * @property {string} html the fetched body (HTML, JSON, XML or iCal text)
 */

const API_URL = /^https?:\/\/(?:www\.)?sessionize\.com\/api\/v2\/[^/]+\/view\//i;
const SCHED_DATA = /<script[^>]*class=["'][^"']*\bsched-data\b[^"']*["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Parse the Sessionize-format data: the embedded `script.sched-data` JSON, or a bare Sessionize API
 * response (`view/All`).
 * @param {string} body
 * @returns {object} an object with sessions, speakers, rooms and categories arrays
 */
export function readSchedule(body) {
  const m = SCHED_DATA.exec(body);
  let data;
  try {
    data = JSON.parse(m ? m[1] : body);
  } catch {
    throw new UserError("The schedule data on that page couldn't be read.");
  }
  const all = data?.all ?? data;
  if (!all || !Array.isArray(all.sessions)) throw new UserError('That Sessionize address has no list of sessions.');
  return all;
}

const LEVEL_TITLE = /\b(level|audience|difficulty|expertise|experience)\b/i;
const TRACK_EXACT = /^(all sessions|tracks?)$/i;
const TRACK_LOOSE = /track/i;
const TRACK_FALLBACK = /^(topics?|themes?|streams?|categor(y|ies))$/i;
const TAG_TITLE = /tag|topic|project|keyword|subject|technolog/i;

/**
 * Category titles differ by event, so pick the category that holds track, level and tags by its title.
 * KubeCon: "All Sessions" is the track, "Audience Level" the level, "SubTopic" and "CNCF Projects" the tags.
 * Sessionize defaults: "Track", "Level", "Tags".
 * @param {{title: string}[]} categories
 * @returns {{track?: string, level?: string, tags: string[]}} category titles
 */
export function classifyCategories(categories) {
  const titles = categories.map((c) => String(c.title ?? ''));
  const level = titles.find((t) => LEVEL_TITLE.test(t) && !TRACK_EXACT.test(t));
  const track = titles.find((t) => TRACK_EXACT.test(t))
    ?? titles.find((t) => TRACK_LOOSE.test(t) && t !== level)
    ?? titles.find((t) => TRACK_FALLBACK.test(t) && t !== level);
  const tags = titles.filter((t) => t !== track && t !== level && TAG_TITLE.test(t));
  return { track, level, tags };
}

/**
 * Map Sessionize data to raw sessions. Lookups that come back empty just leave the field out.
 * @param {object} all result of readSchedule
 * @param {{sourceUrl?: string, withUrls?: boolean}} [opts] `withUrls`: the page links each talk as `?id=<id>`
 * @returns {RawSession[]}
 */
export function buildTalks(all, { sourceUrl, withUrls = false } = {}) {
  const rooms = new Map((all.rooms ?? []).map((r) => [r.id, r.name]));
  const speakers = new Map((all.speakers ?? []).map((s) => [
    s.id, (s.fullName ?? `${s.firstName ?? ''} ${s.lastName ?? ''}`).trim(),
  ]));
  const cats = new Map();
  for (const c of all.categories ?? []) cats.set(c.title, new Map((c.items ?? []).map((i) => [i.id, i.name])));
  const names = (s, title) => (title ? (s.categoryItems ?? []).map((id) => cats.get(title)?.get(id)).filter(Boolean) : []);
  const { track, level, tags } = classifyCategories(all.categories ?? []);

  let base;
  if (withUrls && sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.search = '';
        u.hash = '';
        base = u.href;
      }
    } catch { /* no URL */ }
  }

  const out = [];
  for (const s of all.sessions) {
    if (!s.startsAt || !s.endsAt || !s.title) continue; // unscheduled
    const room = rooms.get(s.roomId);
    const raw = {
      id: String(s.id),
      title: String(s.title).trim(),
      abstract: cleanAbstract(s.description),
      url: base ? `${base}?id=${encodeURIComponent(s.id)}` : undefined,
      start: s.startsAt,
      end: s.endsAt,
      room,
      venue: room ? room.split(' | ')[0] : undefined,
      speakers: (s.speakers ?? []).map((id) => speakers.get(id)).filter(Boolean),
      track: names(s, track)[0],
      level: names(s, level)[0],
      tags: [...new Set(tags.flatMap((t) => names(s, t)))],
      isService: Boolean(s.isServiceSession),
    };
    for (const k of Object.keys(raw)) if (raw[k] === undefined || raw[k] === '') delete raw[k];
    out.push(raw);
  }
  return out;
}

/** @type {{name: string, detect: (url: string|undefined, html: string) => boolean,
 *   extract: (ctx: AdapterContext) => RawSession[], meta: (ctx: AdapterContext) => {name?: string, timezone?: string}}} */
export const sessionize = {
  name: 'sessionize',

  detect(url, html) {
    return API_URL.test(url ?? '') || SCHED_DATA.test(html ?? '');
  },

  extract({ url, html }) {
    return buildTalks(readSchedule(html), { sourceUrl: url, withUrls: !API_URL.test(url ?? '') });
  },

  meta({ url, html }) {
    if (API_URL.test(url ?? '')) {
      const id = /\/api\/v2\/([^/]+)\//.exec(url)[1];
      return { name: `Sessionize event ${id}` };
    }
    // Sessionize data carries no timezone, so none here: the user's hint decides.
    return { name: nameFromTitle(html) };
  },
};
