import { BlockList, isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import { HttpError } from './errors.js';

export const MAX_STARRED = 100;
export const MAX_URL_LENGTH = 2048;

const CID_RE = /^[a-z0-9]{10}$/;
const TALK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} id @returns {boolean} a well-formed conference id */
export const validCid = (id) => typeof id === 'string' && CID_RE.test(id);

/** @param {unknown} id @returns {boolean} a well-formed (opaque string) talk id */
export const validId = (id) => typeof id === 'string' && TALK_ID_RE.test(id);

/**
 * @param {unknown} ids starred ids from a request body
 * @returns {string[]} de-duplicated, validated ids
 */
export function validateIds(ids) {
  if (!Array.isArray(ids) || ids.some((i) => !validId(i))) throw new HttpError(400, 'Invalid starred ids');
  if (ids.length > MAX_STARRED) throw new HttpError(400, 'Too many starred ids');
  return [...new Set(ids)];
}

/**
 * Parse and validate a comma separated id list.
 * @param {unknown} raw the `starred` query parameter
 * @returns {string[]}
 */
export function parseStarredParam(raw) {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string') throw new HttpError(400, 'Invalid starred ids');
  return validateIds(raw.split(',').filter((s) => s !== ''));
}

/** @param {unknown} day @returns {boolean} a real calendar date, YYYY-MM-DD */
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/**
 * An IANA zone name such as America/Denver. Intl does the real check; the regex stops
 * Intl's acceptance of offsets like "+01:00", which Postgres would read differently.
 * @param {unknown} tz
 * @returns {boolean}
 */
export function validTimezone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

/**
 * @param {string} hostname as in URL.hostname (IPv6 keeps its brackets)
 * @returns {boolean} true for localhost and private, loopback or link-local IP literals
 */
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const kind = isIP(host);
  if (kind === 0) return false;
  return PRIVATE.check(host, kind === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Normalise a source URL for dedupe (contract/README.md). Must stay identical to the worker's
 * `normaliseUrl` (worker/src/url.js); api/test/worker-parity.test.js enforces it.
 * @param {string} input
 * @returns {string}
 */
export function normaliseUrl(input) {
  const u = new URL(input); // lowercases scheme and host, drops default ports
  u.hash = '';
  return u.href;
}

/**
 * Validate a submitted URL and return its normalised form.
 * @param {unknown} input the `url` field of POST /conferences
 * @returns {string}
 * @throws {HttpError} 400 when not an http(s) URL, too long, or pointing at a private host
 */
export function validateSourceUrl(input) {
  if (typeof input !== 'string' || input.length === 0) throw new HttpError(400, 'url is required');
  if (input.length > MAX_URL_LENGTH) throw new HttpError(400, `url must be at most ${MAX_URL_LENGTH} characters`);
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new HttpError(400, 'url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'url must be http or https');
  if (isPrivateHost(u.hostname)) throw new HttpError(400, 'url must not point at a private or local host');
  const out = normaliseUrl(input);
  if (out.length > MAX_URL_LENGTH) throw new HttpError(400, `url must be at most ${MAX_URL_LENGTH} characters`);
  return out;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** @returns {string} a conference id matching ^[a-z0-9]{10}$ (same scheme as worker/src/url.js) */
export function newConferenceId() {
  let id = '';
  for (let i = 0; i < 10; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}
