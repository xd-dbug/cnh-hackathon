// The API copies a few worker behaviours (it may not import worker code at runtime). These tests
// import the worker's versions and fail if the copies drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseUrl as workerNormalise, newConferenceId as workerId } from '../../worker/src/url.js';
import * as workerEmbed from '../../worker/src/embed.js';
import { normaliseUrl, newConferenceId } from '../src/validate.js';
import * as apiEmbed from '../src/embed.js';

test('normaliseUrl matches the worker for a range of inputs', () => {
  const inputs = [
    'https://x.com', 'https://x.com/', 'HTTPS://X.COM/Path', 'https://x.com:443/a', 'http://x.com:80/a', 'http://x.com:8080/a',
    'https://x.com/a#frag', 'https://x.com/a?b=1&c=2#frag', 'https://x.com/a/?B=Z', 'https://user:pw@x.com/a',
    'https://exämple.com/ü', 'https://x.com/a b', 'https://x.com/a%20b', 'https://pretalx.com/example-conf-2026/schedule/',
    'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/',
  ];
  for (const i of inputs) assert.equal(normaliseUrl(i), workerNormalise(i), i);
});

test('newConferenceId has the same shape as the worker', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(newConferenceId(), /^[a-z0-9]{10}$/);
    assert.match(workerId(), /^[a-z0-9]{10}$/);
  }
});

test('query embedding settings match the worker', () => {
  assert.equal(apiEmbed.MODEL, workerEmbed.MODEL);
  assert.equal(apiEmbed.POOLING, workerEmbed.POOLING);
});

test('worker embeds with dtype fp32 and normalize: true; the API must too', async () => {
  // The worker keeps dtype and normalize inline rather than as constants, so check its source.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../worker/src/embed.js', import.meta.url), 'utf8');
  assert.match(src, /dtype:\s*'fp32'/);
  assert.match(src, /normalize:\s*true/);
  assert.equal(apiEmbed.DTYPE, 'fp32');
  const own = await readFile(new URL('../src/embed.js', import.meta.url), 'utf8');
  assert.match(own, /normalize:\s*true/);
});
