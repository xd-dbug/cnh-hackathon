import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { isAllowed, rulesFor } from '../src/robots.js';
import { assertPublicAddress, resolvePublic, safeFetch } from '../src/safe-fetch.js';

/** A fake transport: `routes` maps "host/path" to {status, headers, body}. Records every request made. */
function fakeNet(routes, dnsTable = {}) {
  const requests = [];
  const resolve = async (host) => {
    if (dnsTable[host]) return dnsTable[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const request = (url, options, cb) => {
    requests.push({ url: url.href, options });
    const route = routes[`${url.host}${url.pathname}`] ?? { status: 404, body: 'nope' };
    const res = Readable.from([Buffer.from(route.body ?? '')]);
    res.statusCode = route.status ?? 200;
    res.headers = route.headers ?? {};
    const handlers = {};
    return {
      on(ev, fn) { handlers[ev] = fn; return this; },
      end() { setImmediate(() => cb(res)); },
    };
  };
  return { deps: { resolve, request }, requests };
}

describe('assertPublicAddress', () => {
  for (const bad of ['127.0.0.1', '127.1.2.3', '169.254.169.254', '::1', '10.0.0.1', '172.16.5.5', '192.168.1.1',
    '0.0.0.0', '100.64.0.1', 'fe80::1', 'fd00:ec2::254', '[::ffff:127.0.0.1]', '::ffff:10.0.0.1', '224.0.0.1']) {
    it(`rejects ${bad}`, () => assert.throws(() => assertPublicAddress(bad), /private or internal/));
  }
  for (const good of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    it(`accepts ${good}`, () => assert.doesNotThrow(() => assertPublicAddress(good)));
  }
});

describe('resolvePublic', () => {
  it('rejects localhost by name', async () => {
    await assert.rejects(resolvePublic('localhost'), /private or internal/);
    await assert.rejects(resolvePublic('app.localhost'), /private or internal/);
  });
  it('rejects a name that resolves to a private address', async () => {
    await assert.rejects(resolvePublic('evil.test', async () => [{ address: '10.1.2.3', family: 4 }]), /private or internal/);
  });
  it('rejects mixed answers when any address is private', async () => {
    await assert.rejects(
      resolvePublic('mixed.test', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]),
      /private or internal/,
    );
  });
  it('accepts a public name', async () => {
    const r = await resolvePublic('ok.test', async () => [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(r[0].address, '93.184.216.34');
  });
});

describe('safeFetch SSRF', () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/',
    'http://[::ffff:127.0.0.1]/', 'http://localhost:3001/']) {
    it(`refuses ${url} without sending a request`, async () => {
      const { deps, requests } = fakeNet({});
      await assert.rejects(safeFetch(url, { deps }), /private or internal/);
      assert.equal(requests.length, 0);
    });
  }

  it('refuses a public-looking name that resolves to the metadata address', async () => {
    const { deps, requests } = fakeNet({}, { 'rebind.test': ['169.254.169.254'] });
    await assert.rejects(safeFetch('http://rebind.test/', { deps }), /private or internal/);
    assert.equal(requests.length, 0);
  });

  it('refuses a redirect to a private IP', async () => {
    const { deps, requests } = fakeNet({
      'good.test/robots.txt': { status: 404 },
      'good.test/schedule': { status: 302, headers: { location: 'http://10.0.0.1/admin' } },
    });
    await assert.rejects(safeFetch('http://good.test/schedule', { deps }), /private or internal/);
    assert.ok(!requests.some((r) => r.url.includes('10.0.0.1')), 'the private target is never requested');
  });

  it('refuses a redirect to a host that resolves to a private IP', async () => {
    const { deps } = fakeNet({
      'good.test/robots.txt': { status: 404 },
      'good.test/schedule': { status: 301, headers: { location: 'https://internal.test/x' } },
    }, { 'internal.test': ['192.168.0.9'] });
    await assert.rejects(safeFetch('http://good.test/schedule', { deps }), /private or internal/);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const { deps } = fakeNet({
      'good.test/robots.txt': { status: 404 },
      'good.test/schedule': { status: 302, headers: { location: 'file:///etc/passwd' } },
    });
    await assert.rejects(safeFetch('http://good.test/schedule', { deps }), /Only http and https/);
  });

  it('stops after 5 redirects', async () => {
    const routes = { 'good.test/robots.txt': { status: 404 } };
    for (let i = 0; i < 10; i++) routes[`good.test/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
    const { deps } = fakeNet(routes);
    await assert.rejects(safeFetch('http://good.test/r0', { deps }), /too many times/);
  });

  it('follows a safe redirect and returns the final body', async () => {
    const { deps } = fakeNet({
      'good.test/robots.txt': { status: 404 },
      'good.test/a': { status: 302, headers: { location: '/b' } },
      'good.test/b': { status: 200, body: 'hello' },
    });
    const res = await safeFetch('http://good.test/a', { deps });
    assert.equal(res.body, 'hello');
    assert.equal(res.url, 'http://good.test/b');
  });

  it('sends a generic user agent', async () => {
    const { deps, requests } = fakeNet({ 'good.test/robots.txt': { status: 404 }, 'good.test/': { body: 'x' } });
    await safeFetch('http://good.test/', { deps });
    assert.equal(requests.at(-1).options.headers['User-Agent'], 'ConferenceClashResolver/0.1');
  });

  it('refuses ftp: and credentials in the URL', async () => {
    const { deps } = fakeNet({});
    await assert.rejects(safeFetch('ftp://good.test/x', { deps }), /Only http and https/);
    await assert.rejects(safeFetch('http://user:pw@good.test/x', { deps }), /username or password/);
  });

  it('enforces the size cap', async () => {
    const { deps } = fakeNet({
      'good.test/robots.txt': { status: 404 },
      'good.test/big': { body: 'x'.repeat(2000) },
    });
    await assert.rejects(safeFetch('http://good.test/big', { deps, maxBytes: 1000 }), /too large/);
  });
});

describe('robots.txt', () => {
  it('parses groups and picks the longest match', () => {
    const rules = rulesFor('User-agent: *\nDisallow: /private\nAllow: /private/open\n', 'ConferenceClashResolver');
    assert.equal(isAllowed(rules, '/schedule'), true);
    assert.equal(isAllowed(rules, '/private/x'), false);
    assert.equal(isAllowed(rules, '/private/open/x'), true);
  });
  it('prefers a group naming us over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: ConferenceClashResolver\nAllow: /\n';
    assert.equal(isAllowed(rulesFor(txt, 'ConferenceClashResolver'), '/x'), true);
  });
  it('supports wildcards and $', () => {
    const rules = rulesFor('User-agent: *\nDisallow: /*.json$\n', 'x');
    assert.equal(isAllowed(rules, '/a/b.json'), false);
    assert.equal(isAllowed(rules, '/a/b.json?x=1'), true);
  });

  it('safeFetch refuses a page that robots.txt disallows', async () => {
    const { deps, requests } = fakeNet({
      'good.test/robots.txt': { body: 'User-agent: *\nDisallow: /schedule\n' },
      'good.test/schedule': { body: 'secret' },
    });
    await assert.rejects(safeFetch('http://good.test/schedule', { deps }), /robots\.txt/);
    assert.ok(!requests.some((r) => r.url.endsWith('/schedule')));
  });
  it('safeFetch treats a missing robots.txt as allowed', async () => {
    const { deps } = fakeNet({ 'good.test/schedule': { body: 'ok' } });
    assert.equal((await safeFetch('http://good.test/schedule', { deps })).body, 'ok');
  });
});
