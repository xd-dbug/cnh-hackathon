import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { UserError } from './errors.js';
import { isAllowed, rulesFor } from './robots.js';

export const USER_AGENT = 'ConferenceClashResolver/0.1';
export const AGENT_TOKEN = 'ConferenceClashResolver';
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 10 * 1024 * 1024;

const PRIVATE_MESSAGE = "That address points to a private or internal network, so it can't be fetched.";

/**
 * Throw unless `address` is a public unicast address. Rejects loopback, private, link-local (which
 * includes the 169.254.169.254 metadata address), unique-local, CGNAT, multicast, reserved and
 * unspecified ranges, and unwraps IPv4-mapped IPv6 (::ffff:127.0.0.1) first.
 * @param {string} address
 */
export function assertPublicAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.process(address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  } catch {
    throw new UserError(PRIVATE_MESSAGE);
  }
  if (parsed.range() !== 'unicast') throw new UserError(PRIVATE_MESSAGE);
}

const defaultResolve = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a hostname and require every address to be public. IP literals are checked directly.
 * @param {string} hostname as in URL.hostname (IPv6 literals keep their brackets)
 * @param {(h: string) => Promise<{address: string, family: number}[]>} [resolve]
 * @returns {Promise<{address: string, family: number}[]>}
 */
export async function resolvePublic(hostname, resolve = defaultResolve) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(bare)) {
    assertPublicAddress(bare);
    return [{ address: bare, family: bare.includes(':') ? 6 : 4 }];
  }
  const lower = bare.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) throw new UserError(PRIVATE_MESSAGE);
  let addrs;
  try {
    addrs = await resolve(bare);
  } catch {
    throw new UserError(`Couldn't find the site "${bare}". Check the address.`);
  }
  if (!addrs.length) throw new UserError(`Couldn't find the site "${bare}". Check the address.`);
  for (const a of addrs) assertPublicAddress(a.address); // all of them, so no mixed answers
  return addrs;
}

/** Default transport: node:http(s), connecting to the address we already validated. */
function defaultRequest(url, options, cb) {
  return (url.protocol === 'https:' ? https : http).request(url, options, cb);
}

/**
 * @typedef {object} FetchDeps
 * @property {(h: string) => Promise<{address: string, family: number}[]>} [resolve] DNS, for tests
 * @property {typeof defaultRequest} [request] transport, for tests
 */

/** One request, no redirects. Connects to the validated IP so DNS can't change between check and use. */
function fetchHop(url, addrs, { signal, maxBytes, deps }) {
  return new Promise((resolve, reject) => {
    const pinned = addrs[0];
    const lookup = (_host, opts, cb) => {
      if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
      else cb(null, pinned.address, pinned.family);
    };
    const req = (deps.request ?? defaultRequest)(url, {
      method: 'GET',
      lookup,
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,application/xml,text/calendar,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const headers = res.headers;
      if (status >= 300 && status < 400 && headers.location) {
        res.resume();
        resolve({ status, headers, body: '' });
        return;
      }
      const declared = Number(headers['content-length']);
      if (declared > maxBytes) {
        res.destroy();
        reject(new UserError('That page is too large (over 10 MB).'));
        return;
      }
      let stream = res;
      const enc = String(headers['content-encoding'] ?? '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length; // counted after decompression, so a zip bomb is capped too
        if (size > maxBytes) {
          res.destroy();
          stream.destroy();
          reject(new UserError('That page is too large (over 10 MB).'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function robotsAllows(url, state) {
  const origin = url.origin;
  if (!state.robots.has(origin)) {
    const robotsUrl = new URL('/robots.txt', origin);
    let rules = [];
    try {
      const res = await safeFetch(robotsUrl.href, { ...state.opts, robots: false, maxBytes: 512 * 1024, allowErrorStatus: true });
      if (res.status >= 500) throw new Error(`robots.txt returned ${res.status}`);
      if (res.status < 400) rules = rulesFor(res.body, AGENT_TOKEN);
    } catch (e) {
      if (e instanceof UserError && e.message === PRIVATE_MESSAGE) throw e;
      throw new UserError(`Couldn't read ${origin}/robots.txt, so the site wasn't fetched.`);
    }
    state.robots.set(origin, rules);
  }
  return isAllowed(state.robots.get(origin), url.pathname + url.search);
}

/**
 * Fetch a URL safely: http/https only; DNS resolved and every address checked (also for each
 * redirect, followed manually, 5 at most); 15 s overall timeout; 10 MB cap; robots.txt honoured.
 * @param {string} input
 * @param {{maxRedirects?: number, timeoutMs?: number, maxBytes?: number, robots?: boolean,
 *   allowErrorStatus?: boolean, deps?: FetchDeps, _state?: object}} [opts]
 * @returns {Promise<{url: string, status: number, headers: object, body: string}>}
 */
export async function safeFetch(input, opts = {}) {
  const { maxRedirects = MAX_REDIRECTS, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, robots = true, allowErrorStatus = false } = opts;
  const deps = opts.deps ?? {};
  const state = opts._state ?? { robots: new Map(), opts: { ...opts, _state: undefined } };
  const signal = AbortSignal.timeout(timeoutMs);

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new UserError("That doesn't look like a valid web address.");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UserError('Only http and https addresses can be fetched.');
    }
    if (url.username || url.password) throw new UserError('Addresses with a username or password are not supported.');
    const addrs = await resolvePublic(url.hostname, deps.resolve);
    if (robots && !(await robotsAllows(url, state))) {
      throw new UserError(`${url.origin} asks automated clients not to fetch this page (robots.txt).`);
    }
    let res;
    try {
      res = await fetchHop(url, addrs, { signal, maxBytes, deps });
    } catch (e) {
      if (e instanceof UserError) throw e;
      if (signal.aborted) throw new UserError('The site took too long to respond (over 15 seconds).');
      throw new UserError(`Couldn't reach ${url.hostname}: ${e.code ?? e.message}.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw new UserError('The site redirected too many times.');
      try {
        url = new URL(res.headers.location, url);
      } catch {
        throw new UserError('The site sent an invalid redirect.');
      }
      continue; // the next loop turn re-validates protocol, DNS and robots for the new target
    }
    if (!allowErrorStatus && (res.status < 200 || res.status >= 300)) {
      throw new UserError(`The site returned HTTP ${res.status} for that address.`);
    }
    return { url: url.href, status: res.status, headers: res.headers, body: res.body };
  }
}
