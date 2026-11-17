import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInZone, toTalk, findClashes, rrf, cmpId } from '../src/talks.js';
import {
  validId, validCid, validDay, validTimezone, validateIds, parseStarredParam, validateSourceUrl, newConferenceId,
} from '../src/validate.js';
import { HttpError } from '../src/errors.js';

const talk = (id, start, end) => ({ id, title: id, start, end, speakers: [], tags: [] });
const status = (fn) => { try { fn(); } catch (e) { return e instanceof HttpError ? e.status : e; } return undefined; };

test('clashes: strict overlap, touching talks do not clash', () => {
  const a = talk('a', '2026-11-10T09:00:00-07:00', '2026-11-10T10:00:00-07:00');
  const b = talk('b', '2026-11-10T10:00:00-07:00', '2026-11-10T11:00:00-07:00');
  const c = talk('c', '2026-11-10T09:30:00-07:00', '2026-11-10T10:30:00-07:00');
  const ids = findClashes([a, b, c]).map(({ a: x, b: y }) => `${x.id}-${y.id}`);
  assert.deepEqual(ids, ['a-c', 'c-b']);
});

test('clashes: a is the earlier start, id breaks ties, pairs sorted by a.start, a.id, b.id', () => {
  const s = '2026-11-10T09:00:00-07:00';
  const e = '2026-11-10T10:00:00-07:00';
  const late = talk('0', '2026-11-10T09:30:00-07:00', '2026-11-10T10:30:00-07:00');
  const out = findClashes([talk('b', s, e), talk('a', s, e), talk('c', s, e), late]);
  assert.deepEqual(out.map(({ a, b }) => `${a.id}-${b.id}`), ['a-0', 'a-b', 'a-c', 'b-0', 'b-c', 'c-0']);
});

test('clashes: compare across different UTC offsets', () => {
  const a = talk('a', '2026-11-01T01:30:00-06:00', '2026-11-01T02:30:00-06:00'); // 07:30Z-08:30Z
  const b = talk('b', '2026-11-01T01:30:00-07:00', '2026-11-01T02:00:00-07:00'); // 08:30Z-09:00Z
  assert.deepEqual(findClashes([a, b]), []);
});

test('ids sort as plain strings, not numbers', () => {
  assert.deepEqual(['10', '9', 'B', 'a', '1'].sort(cmpId), ['1', '10', '9', 'B', 'a']);
  const s = '2026-11-10T09:00:00-07:00';
  const e = '2026-11-10T10:00:00-07:00';
  const [{ a, b }] = findClashes([talk('9', s, e), talk('10', s, e)]);
  assert.equal(a.id, '10'); // '10' < '9' as strings
  assert.equal(b.id, '9');
});

test('id validation', () => {
  for (const ok of ['1233585', 'abc-DEF_9', 'x', 'a'.repeat(64)]) assert.equal(validId(ok), true, ok);
  for (const bad of ['', 'a'.repeat(65), 'a b', 'a/b', 'a,b', '1.5', 5, null, undefined, ['a']]) assert.equal(validId(bad), false, String(bad));
  assert.equal(validCid('d3o0paa9ti'), true);
  for (const bad of ['D3o0paa9ti', 'short', 'd3o0paa9tii', 'd3o0paa9t-', undefined]) assert.equal(validCid(bad), false, String(bad));
  assert.match(newConferenceId(), /^[a-z0-9]{10}$/);
});

test('validateIds and parseStarredParam', () => {
  assert.deepEqual(validateIds(['a', 'b', 'a']), ['a', 'b']);
  assert.equal(status(() => validateIds('a')), 400);
  assert.equal(status(() => validateIds(['a b'])), 400);
  assert.equal(status(() => validateIds(Array.from({ length: 101 }, (_, i) => `t${i}`))), 400);
  assert.equal(validateIds(Array.from({ length: 100 }, (_, i) => `t${i}`)).length, 100);
  assert.deepEqual(parseStarredParam(undefined), []);
  assert.deepEqual(parseStarredParam(''), []);
  assert.deepEqual(parseStarredParam('a,b,,a'), ['a', 'b']);
  assert.equal(status(() => parseStarredParam('a,b c')), 400);
  assert.equal(status(() => parseStarredParam(['a', 'b'])), 400);
});

test('day and level-independent validators', () => {
  assert.equal(validDay('2026-11-10'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '26-11-10', '2026-11-1', '2026/11/10', '', undefined, ['2026-11-10']]) {
    assert.equal(validDay(bad), false, String(bad));
  }
});

test('timezone validation', () => {
  for (const ok of ['America/Denver', 'Europe/Berlin', 'UTC', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires']) assert.equal(validTimezone(ok), true, ok);
  for (const bad of ['Mars/Olympus', '', '+01:00', 'America/', 'America Denver', 5, null]) assert.equal(validTimezone(bad), false, String(bad));
});

test('source url validation and normalisation', () => {
  assert.equal(validateSourceUrl('https://x.com'), 'https://x.com/');
  assert.equal(validateSourceUrl('HTTPS://X.com:443/Path/?q=A#frag'), 'https://x.com/Path/?q=A');
  assert.equal(validateSourceUrl('http://x.com:80/a'), 'http://x.com/a');
  assert.equal(validateSourceUrl('http://x.com:8080/a#b'), 'http://x.com:8080/a');
  assert.equal(validateSourceUrl('https://pretalx.com/example-conf-2026/schedule/'), 'https://pretalx.com/example-conf-2026/schedule/');
  const bad = [
    undefined, '', 5, 'not a url', 'ftp://x.com/a', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://localhost/x', 'http://LOCALHOST:3000', 'http://foo.localhost/', 'http://localhost./',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fe80::1]/',
    'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
    `https://x.com/${'a'.repeat(2048)}`,
  ];
  for (const b of bad) assert.equal(status(() => validateSourceUrl(b)), 400, String(b).slice(0, 60));
  assert.equal(validateSourceUrl('http://8.8.8.8/'), 'http://8.8.8.8/');
  assert.equal(validateSourceUrl('http://172.32.0.1/'), 'http://172.32.0.1/');
});

test('time formatting: offset at that instant, including across the 2026-11-01 DST change in Denver', () => {
  const tz = 'America/Denver';
  assert.equal(formatInZone('2026-10-31T16:00:00Z', tz), '2026-10-31T10:00:00-06:00');
  assert.equal(formatInZone('2026-11-01T07:30:00Z', tz), '2026-11-01T01:30:00-06:00'); // MDT
  assert.equal(formatInZone('2026-11-01T08:30:00Z', tz), '2026-11-01T01:30:00-07:00'); // MST, same wall clock
  assert.equal(formatInZone('2026-11-10T18:30:00Z', tz), '2026-11-10T11:30:00-07:00');
  assert.equal(formatInZone(new Date('2026-03-08T08:59:59Z'), tz), '2026-03-08T01:59:59-07:00');
  assert.equal(formatInZone(new Date('2026-03-08T09:00:00Z'), tz), '2026-03-08T03:00:00-06:00'); // spring forward: 02:00 MST becomes 03:00 MDT
});

test('time formatting: UTC, half-hour offsets, midnight is 00 not 24', () => {
  assert.equal(formatInZone('2026-11-10T00:00:00Z', 'UTC'), '2026-11-10T00:00:00+00:00');
  assert.equal(formatInZone('2026-11-10T00:00:00Z', 'Asia/Kolkata'), '2026-11-10T05:30:00+05:30');
  assert.equal(formatInZone('2026-11-10T07:00:00Z', 'America/Denver'), '2026-11-10T00:00:00-07:00');
  assert.equal(formatInZone('2026-02-01T00:00:00Z', 'Europe/Berlin'), '2026-02-01T01:00:00+01:00');
});

test('toTalk: missing strings omitted, missing arrays []', () => {
  const t = toTalk({
    id: '1335605', title: 'X', abstract: null, url: null, start_at: new Date('2026-11-10T18:30:00Z'),
    end_at: '2026-11-10T19:00:00Z', room: '', venue: null, speakers: null, track: null, level: null, tags: null,
  }, 'America/Denver');
  assert.deepEqual(t, {
    id: '1335605', title: 'X', start: '2026-11-10T11:30:00-07:00', end: '2026-11-10T12:00:00-07:00', speakers: [], tags: [],
  });
});

test('rrf fuses rankings; ties broken by id', () => {
  assert.deepEqual(rrf([['a', 'b', 'c'], ['b', 'a', 'd']]), ['a', 'b', 'c', 'd']); // a,b tie; id order
  assert.deepEqual(rrf([['a', 'b'], ['c', 'b']]), ['b', 'a', 'c']);
  assert.deepEqual(rrf([[], ['x']]), ['x']);
  assert.deepEqual(rrf([[], []]), []);
});
