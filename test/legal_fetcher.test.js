import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegalStore } from '../src/store/db.js';
import { findSourceForUrl, LEGAL_SOURCES } from '../src/sources/registry.js';
import { parseRobots } from '../src/sources/robots.js';
import { createPoliteFetcher } from '../src/sources/fetcher.js';

test('findSourceForUrl only accepts registered hosts and their subdomains over http(s)', () => {
  assert.equal(findSourceForUrl('https://main.sci.gov.in/judgments').id, 'sci');
  assert.equal(findSourceForUrl('https://www.sci.gov.in/').id, 'sci');
  assert.equal(findSourceForUrl('https://indiacode.gov.in/').id, 'india-code');
  assert.equal(findSourceForUrl('https://www.indiacode.nic.in/').id, 'india-code');
  assert.equal(findSourceForUrl('https://lddashboard.legislative.gov.in/coi.pdf').id, 'legislative');
  assert.equal(findSourceForUrl('https://notsci.gov.in/'), null);
  assert.equal(findSourceForUrl('https://sci.gov.in.evil.example/'), null);
  assert.equal(findSourceForUrl('ftp://sci.gov.in/file'), null);
  assert.equal(findSourceForUrl('not a url'), null);
  assert.ok(LEGAL_SOURCES.every((source) => [0, 1, 2].includes(source.tier)));
});

test('parseRobots applies the matching group, longest-match precedence, wildcards and crawl-delay', () => {
  const robots = parseRobots(
    [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: SomeOtherBot',
      'User-agent: lawbuddybot',
      'Disallow: /private/',
      'Allow: /private/public-judgments/',
      'Disallow: /*.php$',
      'Crawl-delay: 5 # seconds',
    ].join('\n'),
    'LawBuddyBot',
  );
  assert.equal(robots.isAllowed('/judgments/2023.pdf'), true);
  assert.equal(robots.isAllowed('/private/notes'), false);
  assert.equal(robots.isAllowed('/private/public-judgments/1.pdf'), true);
  assert.equal(robots.isAllowed('/search.php'), false);
  assert.equal(robots.isAllowed('/search.php?q=1'), true);
  assert.equal(robots.isAllowed('/robots.txt'), true);
  assert.equal(robots.crawlDelayMs, 5000);

  const generic = parseRobots('User-agent: *\nDisallow: /admin\nDisallow:', 'LawBuddyBot');
  assert.equal(generic.isAllowed('/admin/x'), false);
  assert.equal(generic.isAllowed('/judgments'), true);
  assert.equal(generic.crawlDelayMs, null);
  assert.equal(parseRobots('', 'LawBuddyBot').isAllowed('/anything'), true);
});

const startFixtureServer = async (robotsBody = 'User-agent: *\nDisallow: /private/\nCrawl-delay: 2') => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, userAgent: req.headers['user-agent'], ifNoneMatch: req.headers['if-none-match'] });
    if (req.url === '/robots.txt') {
      if (robotsBody === null) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(robotsBody);
      return;
    }
    if (req.url === '/judgment.pdf') {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', ETag: '"v1"' }).end('%PDF-1.7 judgment text');
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(4096, 1));
      return;
    }
    if (req.url === '/moved') {
      res.writeHead(301, { Location: '/judgment.pdf' }).end();
      return;
    }
    if (req.url === '/escape') {
      res.writeHead(302, { Location: 'https://evil.example/steal' }).end();
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.writeHead(200).end('late'), 500);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, hits, close: () => new Promise((resolve) => server.close(resolve)) };
};

const setup = async (options = {}) => {
  const fixture = await startFixtureServer(options.robotsBody);
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-vault-'));
  const store = openLegalStore(':memory:');
  const clock = { t: 1_000_000, waits: [] };
  const fetcher = createPoliteFetcher({
    store,
    sources: [{ id: 'fixture', name: 'Fixture Court', tier: 0, baseUrl: fixture.baseUrl, hosts: ['127.0.0.1'] }],
    vaultDir,
    userAgent: 'LawBuddyBot/0.1 (+test)',
    minIntervalMs: 1000,
    timeoutMs: options.timeoutMs ?? 2000,
    maxBytes: 1024,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.waits.push(ms);
      clock.t += ms;
    },
  });
  const teardown = async () => {
    store.close();
    await fixture.close();
    await rm(vaultDir, { recursive: true, force: true });
  };
  return { fixture, store, fetcher, clock, vaultDir, teardown };
};

test('fetchDocument stores the body content-addressed, logs it, then revalidates with ETag', async () => {
  const { fixture, store, fetcher, teardown } = await setup();
  try {
    const url = `${fixture.baseUrl}/judgment.pdf`;
    const first = await fetcher.fetchDocument(url);
    assert.equal(first.ok, true);
    assert.equal(first.status, 200);
    assert.equal(first.changed, true);
    assert.equal(first.contentType, 'application/pdf');
    assert.equal(path.basename(first.rawPath), first.sha256);
    assert.equal(await readFile(first.rawPath, 'utf8'), '%PDF-1.7 judgment text');
    assert.equal(store.lastSuccessfulFetch(url).etag, '"v1"');

    const second = await fetcher.fetchDocument(url);
    assert.equal(second.status, 304);
    assert.equal(second.notModified, true);
    assert.equal(second.changed, false);
    assert.equal(second.sha256, first.sha256);

    const docHits = fixture.hits.filter((hit) => hit.url === '/judgment.pdf');
    assert.equal(docHits[1].ifNoneMatch, '"v1"');
    assert.ok(fixture.hits.every((hit) => hit.userAgent === 'LawBuddyBot/0.1 (+test)'));
    assert.equal(fixture.hits.filter((hit) => hit.url === '/robots.txt').length, 1, 'robots.txt is cached');
  } finally {
    await teardown();
  }
});

test('requests to one host are spaced by the larger of min interval and robots Crawl-delay', async () => {
  const { fixture, fetcher, clock, teardown } = await setup();
  try {
    await Promise.all([
      fetcher.fetchDocument(`${fixture.baseUrl}/judgment.pdf`),
      fetcher.fetchDocument(`${fixture.baseUrl}/missing-1`),
      fetcher.fetchDocument(`${fixture.baseUrl}/missing-2`),
    ]);
    // One shared robots.txt fetch, then every document request waits the 2s Crawl-delay
    // (larger than the 1s minimum), including the first one after robots.txt.
    assert.equal(fixture.hits.filter((hit) => hit.url === '/robots.txt').length, 1);
    assert.deepEqual(clock.waits, [2000, 2000, 2000]);
  } finally {
    await teardown();
  }
});

test('robots.txt disallow, unregistered redirects and oversized bodies fail safely and are logged', async () => {
  const { fixture, store, fetcher, teardown } = await setup();
  try {
    const blocked = await fetcher.fetchDocument(`${fixture.baseUrl}/private/secret.pdf`);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /disallowed by robots\.txt/);
    assert.equal(fixture.hits.some((hit) => hit.url.startsWith('/private')), false, 'never requested');

    const escaped = await fetcher.fetchDocument(`${fixture.baseUrl}/escape`);
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /unregistered host evil\.example/);

    const big = await fetcher.fetchDocument(`${fixture.baseUrl}/big`);
    assert.equal(big.ok, false);
    assert.match(big.error, /exceeds 1024 bytes/);

    const missing = await fetcher.fetchDocument(`${fixture.baseUrl}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(store.lastSuccessfulFetch(`${fixture.baseUrl}/nope`), null);

    await assert.rejects(fetcher.fetchDocument('https://example.com/x'), /not a registered legal source/);
  } finally {
    await teardown();
  }
});

test('same-host redirects are followed and logged against the requested URL', async () => {
  const { fixture, store, fetcher, teardown } = await setup();
  try {
    const result = await fetcher.fetchDocument(`${fixture.baseUrl}/moved`);
    assert.equal(result.ok, true);
    assert.equal(result.finalUrl, `${fixture.baseUrl}/judgment.pdf`);
    assert.equal(store.lastSuccessfulFetch(`${fixture.baseUrl}/moved`).sha256, result.sha256);
  } finally {
    await teardown();
  }
});

test('a robots.txt server error blocks fetching, and slow responses time out', async () => {
  const unavailable = await setup({ robotsBody: null });
  try {
    const result = await unavailable.fetcher.fetchDocument(`${unavailable.fixture.baseUrl}/judgment.pdf`);
    assert.equal(result.ok, false);
    assert.match(result.error, /disallowed by robots\.txt/);
  } finally {
    await unavailable.teardown();
  }

  const slow = await setup({ timeoutMs: 100 });
  try {
    const result = await slow.fetcher.fetchDocument(`${slow.fixture.baseUrl}/slow`);
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 100ms/);
  } finally {
    await slow.teardown();
  }
});
