import { UnsupportedSiteError } from '../errors.js';
import { sessionize } from './sessionize.js';

/**
 * Tried in this order. PR 6 adds pretalx, frab, sched, ical, jsonld.
 * @type {Array<{name: string, detect: Function, extract: Function, meta?: Function}>}
 */
export const adapters = [sessionize];

/**
 * @param {string|undefined} url
 * @param {string} html
 * @param {typeof adapters} [list]
 * @returns {typeof adapters[number]} the first adapter whose detect() says yes
 * @throws {UnsupportedSiteError} when none do
 */
export function pickAdapter(url, html, list = adapters) {
  for (const a of list) if (a.detect(url, html)) return a;
  throw new UnsupportedSiteError();
}
