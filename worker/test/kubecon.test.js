import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { pickAdapter } from '../src/adapters/index.js';
import { classifyCategories, readSchedule } from '../src/adapters/sessionize.js';
import { cleanAbstract } from '../src/clean.js';
import { UNSUPPORTED_SITE_MESSAGE, UnsupportedSiteError } from '../src/errors.js';
import { isServiceTitle, normalise } from '../src/normalise.js';
import { parseSource } from '../src/pipeline.js';

const URL_ = 'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/';
const html = readFileSync(new URL('./fixtures/kubecon-schedule.html', import.meta.url), 'utf8');

// The KubeCon allowlist and 90-minute limit are properties of this fixture test, not of the app.
const TRACKS = new Set([
  'AI Inference + Agentic', 'Application Development + Delivery', 'Cloud Native Experience',
  'Cloud Native Novice', 'Connectivity', 'Data Processing + Storage', 'Emerging + Advanced',
  'Observability', 'Operations + Performance', 'Platform Engineering', 'Security',
  'Maintainer Track', '⚡ Lightning Talks', '📚 Tutorials', 'Inclusion + Accessibility',
  'Project Lightning Talks',
]);
const MAX_MS = 90 * 60 * 1000;

describe('KubeCon fixture (Sessionize embedded data)', () => {
  const parsed = parseSource({ url: URL_, body: html }, { timezone: 'America/Denver' });
  const kept = parsed.talks.filter((t) => TRACKS.has(t.track) && Date.parse(t.end) - Date.parse(t.start) <= MAX_MS);

  it('is detected as sessionize', () => {
    assert.equal(parsed.adapter, 'sessionize');
    assert.equal(parsed.name, 'KubeCon + CloudNativeCon North America');
    assert.equal(parsed.timezone, 'America/Denver');
  });

  it('gives 325 talks after the allowlist and 90-minute limit', () => {
    assert.equal(kept.length, 325);
  });

  it('gives Mon 48, Tue 100, Wed 101, Thu 76', () => {
    const perDay = {};
    for (const t of kept) perDay[t.start.slice(0, 10)] = (perDay[t.start.slice(0, 10)] ?? 0) + 1;
    assert.deepEqual(perDay, { '2026-11-09': 48, '2026-11-10': 100, '2026-11-11': 101, '2026-11-12': 76 });
  });

  it('writes -07:00 on every time', () => {
    for (const t of kept) {
      assert.match(t.start, /-07:00$/);
      assert.match(t.end, /-07:00$/);
    }
  });

  it('maps the fields the way CLAUDE.md describes', () => {
    const t = kept.find((x) => x.id === '1246200') ?? kept[0];
    assert.match(t.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(t.title);
    assert.ok(TRACKS.has(t.track));
    assert.ok(['Beginner', 'Any Level', 'Advanced'].includes(t.level));
    assert.ok(Array.isArray(t.speakers) && Array.isArray(t.tags));
    assert.equal(t.url, `${URL_}?id=${t.id}`);
    assert.ok(t.venue === 'Salt Palace' || t.venue === 'Hyatt Regency' || t.venue === undefined);
    assert.ok(!/<[a-z]+/i.test(t.abstract ?? ''), 'abstract has no HTML tags');
    assert.ok(!/&#?\w+;/.test(t.abstract ?? ''), 'abstract has no entities');
  });

  it('is sorted by start then id', () => {
    for (let i = 1; i < parsed.talks.length; i++) {
      const a = parsed.talks[i - 1];
      const b = parsed.talks[i];
      assert.ok(Date.parse(a.start) < Date.parse(b.start) || (a.start === b.start && a.id <= b.id));
    }
  });

  it('classifies KubeCon category titles', () => {
    const { track, level, tags } = classifyCategories(readSchedule(html).categories);
    assert.equal(track, 'All Sessions');
    assert.equal(level, 'Audience Level');
    assert.deepEqual(tags, ['SubTopic', 'CNCF Projects']);
  });
});

describe('category heuristics', () => {
  it('handles Sessionize defaults', () => {
    const c = classifyCategories([{ title: 'Session format' }, { title: 'Track' }, { title: 'Level' }, { title: 'Tags' }]);
    assert.deepEqual(c, { track: 'Track', level: 'Level', tags: ['Tags'] });
  });
  it('returns nothing for unrecognised titles', () => {
    assert.deepEqual(classifyCategories([{ title: 'Misc' }]), { track: undefined, level: undefined, tags: [] });
  });
});

describe('Sessionize API shape', () => {
  const body = JSON.stringify({
    sessions: [{ id: '9', title: 'Hi', description: '<p>It&#039;s</p>', startsAt: '2026-03-08T09:00:00', endsAt: '2026-03-08T09:30:00',
      speakers: ['s1'], categoryItems: [1], roomId: 5 }],
    speakers: [{ id: 's1', fullName: 'Ada Lovelace' }],
    rooms: [{ id: 5, name: 'Main' }],
    categories: [{ title: 'Track', items: [{ id: 1, name: 'Web' }] }],
  });
  it('is detected from the URL and has no per-talk URL', () => {
    const url = 'https://sessionize.com/api/v2/abc123/view/All';
    const r = parseSource({ url, body }, { timezone: 'America/Denver' });
    assert.equal(r.adapter, 'sessionize');
    assert.equal(r.talks[0].abstract, "It's");
    assert.equal(r.talks[0].speakers[0], 'Ada Lovelace');
    assert.equal(r.talks[0].track, 'Web');
    assert.equal(r.talks[0].url, undefined);
    assert.equal(r.talks[0].start, '2026-03-08T09:00:00-06:00'); // after the spring-forward change
  });
});

describe('registry and normalise', () => {
  it('fails with the exact Unsupported site message', () => {
    assert.throws(() => pickAdapter('https://example.com/agenda', '<html><body>hi</body></html>'), UnsupportedSiteError);
    try { pickAdapter('https://example.com/agenda', '<p>x</p>'); } catch (e) {
      assert.equal(e.message, UNSUPPORTED_SITE_MESSAGE);
    }
  });
  it('fails readably without a timezone', () => {
    assert.throws(() => parseSource({ url: URL_, body: html }), /which timezone/);
  });
  it('rejects a bad timezone name', () => {
    assert.throws(() => normalise([], { hint: 'Mars/Base' }), /isn't a timezone/);
  });
  it('skips service sessions and anything over 4 hours', () => {
    const base = { start: '2026-11-10T09:00:00', end: '2026-11-10T09:30:00' };
    const { talks, skipped } = normalise([
      { id: 'a', title: 'Talk', ...base },
      { id: 'b', title: 'Lunch', isService: true, ...base },
      { id: 'c', title: 'Workshop', start: '2026-11-10T09:00:00', end: '2026-11-10T13:01:00' },
      { id: 'd e', title: 'Bad id', ...base },
      { id: 'a', title: 'Dup', ...base },
    ], { hint: 'America/Denver' });
    assert.deepEqual(talks.map((t) => t.id), ['a']);
    assert.deepEqual(skipped, { service: 1, tooLong: 1, badId: 1, badTime: 0, duplicate: 1 });
  });
  it('cleans abstracts', () => {
    assert.equal(cleanAbstract('<p>Tom &amp; Jerry&#039;s</p><p>Second<br>line</p>'), "Tom & Jerry's\n\nSecond\nline");
  });
});

describe('isServiceTitle', () => {
  it('skips breaks and meals, with or without emoji', () => {
    for (const t of ['☕ Coffee Break', '🍲 Lunch', 'Lunch Break', 'Morning Break', 'Registration', 'Badge Pick-up', 'Breakfast', '🍲 Lunch | On Own', 'Lunch (provided)'])
      assert.equal(isServiceTitle(t), true, t);
  });
  it('keeps talks that merely mention them', () => {
    for (const t of ['Breaking Changes in Kubernetes', 'Lunch & Learn: eBPF', 'Registration Flows with OIDC', 'Take a Break from YAML', 'Registration: OIDC Flows', 'Lunch & Learn | eBPF'])
      assert.equal(isServiceTitle(t), false, t);
  });
});
