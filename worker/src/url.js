import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Normalise a source URL for dedupe (contract/README.md): lowercase scheme and host, drop the default
 * port and the fragment; path and query are kept as given.
 * @param {string} input
 * @returns {string}
 */
export function normaliseUrl(input) {
  const u = new URL(input); // lowercases scheme and host, drops default ports
  u.hash = '';
  return u.href;
}

/** @param {string} file @returns {string} a file:// URL, used as source_url when none is given */
export function fileSourceUrl(file) {
  return pathToFileURL(file).href;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** @returns {string} a conference id matching ^[a-z0-9]{10}$ */
export function newConferenceId() {
  let id = '';
  for (let i = 0; i < 10; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}
