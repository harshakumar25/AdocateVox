import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegalStore } from '../src/store/db.js';
import { createPoliteFetcher } from '../src/sources/fetcher.js';
import { extractLinks } from '../src/watch/links.js';
import { nextInterval, withJitter } from '../src/watch/cadence.js';
import { createWatcher, REMOVED_FROM_LISTING } from '../src/watch/watcher.js';
import { drainChangeEvents, SIGNAL_ONLY } from '../src/watch/events.js';
import { runWatchLoop } from '../src/watch/scheduler.js';
import { handleLawBuddyApiRoute } from '../src/routes.js';
import { WATCHLISTS } from '../src/watch/watchlists.js';
import { findSourceForUrl } from '../src/sources/registry.js';

test('extractLinks resolves relative links, tolerates sloppy markup and drops non-web links', () => {
  const html = `
    <!-- <a href="/commented.pdf">hidden</a> -->
    <a href="/bare-acts/bns.pdf" target="_blank">  Bharatiya Nyaya   Sanhita, 2023 </a>
    <a href="/bare-acts/crpc.pdf"target="_blank"> CRPC<b>Bare</b> Act, 1973</a>
    <a class="x" href='relative/ipc.pdf#page=3'>IPC &amp; more</a>
    <a href=/bare-acts/unquoted.pdf>Unquoted</a>
    <a href="/bare-acts/bns.pdf">duplicate</a>
    <a href="mailto:contact@example.org">mail</a>
    <a href="javascript:void(0)">menu</a>
    <a name="anchor-only">no href</a>
    <script>document.write('<a href="/script.pdf">x</a>')</script>`;

  assert.deepEqual(extractLinks(html, 'https://example.org/acts/index.html'), [
    { url: 'https://example.org/bare-acts/bns.pdf', text: 'Bharatiya Nyaya Sanhita, 2023' },
    { url: 'https://example.org/bare-acts/crpc.pdf', text: 'CRPC Bare Act, 1973' },
    { url: 'https://example.org/acts/relative/ipc.pdf', text: 'IPC & more' },
    { url: 'https://example.org/bare-acts/unquoted.pdf', text: 'Unquoted' },
  ]);
  assert.deepEqual(extractLinks('', 'https://example.org/'), []);
});

test('nextInterval resets on change, backs off on stability and harder on failure, within bounds', () => {
  const bounds = { minIntervalMs: 1000, maxIntervalMs: 10_000 };
  assert.equal(nextInterval({ ...bounds, intervalMs: 8000, outcome: 'changed' }), 1000);
  assert.equal(nextInterval({ ...bounds, intervalMs: 2000, outcome: 'unchanged' }), 3000);
  assert.equal(nextInterval({ ...bounds, intervalMs: 2000, outcome: 'failed' }), 4000);
  assert.equal(nextInterval({ ...bounds, intervalMs: 9000, outcome: 'unchanged' }), 10_000);
  assert.equal(nextInterval({ ...bounds, intervalMs: 500, outcome: 'unchanged' }), 1000);
  assert.throws(() => nextInterval({ ...bounds, intervalMs: 1000, outcome: 'weird' }), /unknown check outcome/);

  assert.equal(withJitter(1000, () => 0.5), 1000);
  assert.equal(withJitter(1000, () => 0), 900);
  assert.equal(withJitter(1000, () => 1), 1100);
});

test('the shipped watchlists target registered sources and match their real document links', () => {
  for (const list of WATCHLISTS) {
    assert.equal(findSourceForUrl(list.listingUrl)?.id, list.sourceId, `${list.id} listing is on its source`);
    assert.ok(list.listing.minIntervalMs <= list.listing.maxIntervalMs);
    assert.ok(list.documents.minIntervalMs <= list.documents.maxIntervalMs);
  }
  const bareActs = WATCHLISTS.find((list) => list.id === 'yourlordships-bare-acts');
  assert.match('/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/the-bharatiya-nyaya-sanhita-2023.pdf', bareActs.documentPattern);
  assert.doesNotMatch('/images/LLC/LawMore/yourlordships/img/pdf/yl-prospectus.pdf', bareActs.documentPattern);
  assert.equal(bareActs.cleanLabel('Contract Act PDF Download'), 'Contract Act');
  assert.equal(bareActs.cleanLabel('CRPCBare Act, 1973 PDF  Download'), 'CRPCBare Act, 1973');
  assert.equal(findSourceForUrl('https://yourlordships.in/bare-acts/').tier, 2, 'coaching-site copies are signal-only');
});

/** A site whose listing and documents the test can change between watch passes. */
const startSite = async () => {
  const site = {
    links: [
      { href: '/bare-acts/bns.pdf', text: 'Bharatiya Nyaya Sanhita, 2023' },
      { href: 'bare-acts/ipc.pdf', text: 'IPC' },
    ],
    docs: new Map([
      ['/bare-acts/bns.pdf', { body: '%PDF bns v1', etag: '"bns-1"' }],
      // No validators at all: every check is a full download compared by sha256.
      ['/bare-acts/ipc.pdf', { body: '%PDF ipc v1', etag: null }],
    ]),
    status: new Map(),
    hits: [],
  };
  const server = http.createServer((req, res) => {
    site.hits.push({ url: req.url, ifNoneMatch: req.headers['if-none-match'] ?? null });
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow:');
      return;
    }
    if (req.url === '/') {
      const anchors = site.links.map(({ href, text }) => `<li><a href="${href}"target="_blank">${text}</a></li>`);
      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end(`<html><body><a href="/about/">About</a><ul>${anchors.join('')}</ul></body></html>`);
      return;
    }
    if (site.status.has(req.url)) {
      res.writeHead(site.status.get(req.url)).end();
      return;
    }
    const doc = site.docs.get(req.url);
    if (!doc) {
      res.writeHead(404).end();
      return;
    }
    if (doc.etag && req.headers['if-none-match'] === doc.etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', ...(doc.etag ? { ETag: doc.etag } : {}) }).end(doc.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.baseUrl = `http://127.0.0.1:${server.address().port}`;
  site.close = () => new Promise((resolve) => server.close(resolve));
  return site;
};

const setup = async ({ tier = 2 } = {}) => {
  const site = await startSite();
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-watch-'));
  const store = openLegalStore(':memory:');
  const clock = { t: Date.parse('2026-10-12T00:00:00Z') };
  const sources = [{ id: 'fixture', name: 'Fixture mirror', tier, baseUrl: site.baseUrl, hosts: ['127.0.0.1'] }];
  const fetcher = createPoliteFetcher({
    store,
    sources,
    vaultDir,
    userAgent: 'LawBuddyBot/0.1 (+test)',
    minIntervalMs: 10,
    timeoutMs: 2000,
    maxBytes: 4096,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  const watchlist = {
    id: 'fixture-acts',
    sourceId: 'fixture',
    listingUrl: `${site.baseUrl}/`,
    documentPattern: /\/bare-acts\/[^/]+\.pdf$/,
    listing: { minIntervalMs: 1000, maxIntervalMs: 10_000 },
    documents: { minIntervalMs: 2000, maxIntervalMs: 20_000 },
  };
  const watcher = createWatcher({
    store, fetcher, sources, watchlists: [watchlist], now: () => clock.t, random: () => 0.5,
  });
  const later = (ms = 60_000) => {
    clock.t += ms;
  };
  const target = (suffix) => store.watchSummary().targets.find((row) => row.url === `${site.baseUrl}${suffix}`);
  const teardown = async () => {
    store.close();
    await site.close();
    await rm(vaultDir, { recursive: true, force: true });
  };
  return { site, store, clock, watcher, later, target, teardown };
};

test('a watch pass discovers the listing documents, then revalidates them without re-downloading', async () => {
  const { site, store, watcher, later, target, teardown } = await setup();
  try {
    watcher.seed();
    const first = await watcher.runDue();
    assert.equal(first.checked, 3, 'the listing, then the two documents it revealed');
    assert.deepEqual(
      first.events.map((event) => [event.kind, event.url.replace(site.baseUrl, '')]),
      [['discovered', '/'], ['discovered', '/bare-acts/bns.pdf'], ['discovered', '/bare-acts/ipc.pdf']],
    );
    assert.equal(target('/bare-acts/bns.pdf').label, 'Bharatiya Nyaya Sanhita, 2023');
    assert.equal(target('/bare-acts/bns.pdf').interval_ms, 2000, 'a change resets to the minimum interval');
    assert.equal(store.watchSummary().targets.some((row) => row.url.endsWith('/about/')), false, 'non-matching links are ignored');

    const nothingDue = await watcher.runDue();
    assert.equal(nothingDue.checked, 0, 'nothing is checked before it is due');

    site.hits.length = 0;
    later();
    const second = await watcher.runDue();
    assert.equal(second.checked, 3);
    assert.deepEqual(second.events, [], 'unchanged everywhere');
    assert.deepEqual(second.outcomes, { unchanged: 3 });
    assert.equal(site.hits.find((hit) => hit.url === '/bare-acts/bns.pdf').ifNoneMatch, '"bns-1"', 'revalidated by ETag');
    assert.equal(target('/bare-acts/bns.pdf').interval_ms, 3000, 'stable documents back off ×1.5');
    assert.equal(target('/').interval_ms, 1500);
  } finally {
    await teardown();
  }
});

test('an updated PDF, a removed link and a returning link each become a change event', async () => {
  const { site, store, watcher, later, target, teardown } = await setup();
  try {
    watcher.seed();
    await watcher.runDue();
    const firstSha = target('/bare-acts/ipc.pdf') && store.getWatchTarget(target('/bare-acts/ipc.pdf').id).last_sha256;

    // The mirror re-uploads the IPC PDF with new content (and still sends no validators).
    site.docs.get('/bare-acts/ipc.pdf').body = '%PDF ipc v2 amended';
    later();
    const updated = await watcher.runDue();
    assert.deepEqual(updated.events.map((event) => event.kind), ['changed']);
    const changedEvent = store.pendingChangeEvents().find((event) => event.kind === 'changed');
    assert.equal(changedEvent.old_sha256, firstSha);
    assert.notEqual(changedEvent.new_sha256, firstSha);
    assert.equal(target('/bare-acts/ipc.pdf').interval_ms, 2000);

    // The BNS link disappears from the listing.
    site.links = site.links.filter((link) => link.href !== '/bare-acts/bns.pdf');
    later();
    const removed = await watcher.runDue();
    assert.deepEqual(removed.events.map((event) => [event.kind, event.url.replace(site.baseUrl, '')]),
      [['removed', '/bare-acts/bns.pdf'], ['changed', '/']]);
    assert.equal(target('/bare-acts/bns.pdf').state, 'gone');
    assert.equal(target('/bare-acts/bns.pdf').state_reason, REMOVED_FROM_LISTING);
    later();
    const whileGone = await watcher.runDue();
    assert.equal(whileGone.events.length, 0);
    assert.equal(site.hits.filter((hit) => hit.url === '/bare-acts/bns.pdf').length, 2, 'a gone document is not polled');

    // It comes back.
    site.links.push({ href: '/bare-acts/bns.pdf', text: 'BNS' });
    later();
    const restored = await watcher.runDue();
    assert.deepEqual(restored.events.map((event) => event.kind), ['restored', 'changed']);
    assert.equal(target('/bare-acts/bns.pdf').state, 'active');
  } finally {
    await teardown();
  }
});

test('a renamed link updates the document label without resetting its schedule or raising an event', async () => {
  const { site, watcher, later, target, teardown } = await setup();
  try {
    watcher.seed();
    await watcher.runDue();
    site.links[1].text = 'Indian Penal Code, 1860';
    later();
    const before = target('/bare-acts/ipc.pdf');
    await watcher.runDue({ kind: 'listing' });
    const after = target('/bare-acts/ipc.pdf');
    assert.equal(before.label, 'IPC');
    assert.equal(after.label, 'Indian Penal Code, 1860');
    assert.equal(after.next_check_at, before.next_check_at);
    assert.equal(after.interval_ms, before.interval_ms);
  } finally {
    await teardown();
  }
});

test('403 pauses a target for a person to decide; 404 three times in a row marks it gone', async () => {
  const { site, watcher, later, target, teardown } = await setup();
  try {
    watcher.seed();
    await watcher.runDue();

    site.status.set('/bare-acts/bns.pdf', 403);
    site.status.set('/bare-acts/ipc.pdf', 404);
    later();
    const blocked = await watcher.runDue();
    assert.deepEqual(blocked.events.map((event) => event.kind), ['paused']);
    assert.equal(target('/bare-acts/bns.pdf').state, 'paused');
    assert.match(target('/bare-acts/bns.pdf').state_reason, /HTTP 403/);
    assert.equal(target('/bare-acts/ipc.pdf').state, 'active');
    assert.equal(target('/bare-acts/ipc.pdf').failures, 1);
    assert.equal(target('/bare-acts/ipc.pdf').interval_ms, 4000, 'failures back off ×2');

    later();
    await watcher.runDue();
    later();
    const third = await watcher.runDue();
    assert.deepEqual(third.events.map((event) => event.kind), ['gone']);
    assert.equal(target('/bare-acts/ipc.pdf').state, 'gone');
    assert.equal(target('/bare-acts/ipc.pdf').failures, 3);

    later();
    assert.equal((await watcher.runDue()).checked, 1, 'only the listing is still active');
  } finally {
    await teardown();
  }
});

test('a listings-only pass discovers documents without downloading them', async () => {
  const { site, store, watcher, teardown } = await setup();
  try {
    watcher.seed();
    const result = await watcher.runDue({ kind: 'listing' });
    assert.equal(result.checked, 1);
    assert.equal(site.hits.some((hit) => hit.url.endsWith('.pdf')), false);
    assert.equal(store.watchSummary().targets.filter((row) => row.kind === 'document').length, 2);
  } finally {
    await teardown();
  }
});

test('change events from unofficial copies close as signals; official ones wait for their ingestor', async () => {
  const unofficial = await setup({ tier: 2 });
  try {
    unofficial.watcher.seed();
    await unofficial.watcher.runDue();
    const drained = await drainChangeEvents({ store: unofficial.store });
    assert.equal(drained.pending, 3);
    assert.deepEqual(drained.processed.map((event) => event.outcome),
      ['listing discovered', SIGNAL_ONLY, SIGNAL_ONLY]);
    assert.equal(unofficial.store.pendingChangeEvents().length, 0);
  } finally {
    await unofficial.teardown();
  }

  const official = await setup({ tier: 0 });
  try {
    official.watcher.seed();
    await official.watcher.runDue();
    const withoutIngestor = await drainChangeEvents({ store: official.store });
    assert.equal(withoutIngestor.processed.length, 1, 'only the listing event closes');
    assert.equal(official.store.pendingChangeEvents().length, 2, 'documents stay queued for a future ingestor');

    const ingested = [];
    const withIngestor = await drainChangeEvents({
      store: official.store,
      ingestors: { 'fixture-acts': async (event) => { ingested.push(event.raw_path); return 'ingested'; } },
    });
    assert.equal(withIngestor.processed.length, 2);
    assert.equal(ingested.length, 2);
    assert.ok(ingested.every(Boolean), 'the ingestor receives the stored copy');
  } finally {
    await official.teardown();
  }
});

test('leases keep two watchers from checking the same URL, and re-seeding keeps the schedule', async () => {
  const { store, watcher, clock, later, target, teardown } = await setup();
  try {
    watcher.seed();
    await watcher.runDue();
    later();
    const scheduleBefore = target('/').next_check_at;
    watcher.seed();
    assert.equal(target('/').next_check_at, scheduleBefore, 're-seeding does not reset a schedule');

    const now = new Date(clock.t).toISOString();
    const leaseUntil = new Date(clock.t + 60_000).toISOString();
    const a = store.claimDueWatchTargets({ now, leaseUntil, limit: 2 });
    const b = store.claimDueWatchTargets({ now, leaseUntil, limit: 10 });
    assert.equal(a.length, 2);
    assert.equal(a[0].kind, 'listing', 'listings are claimed first');
    assert.equal(b.length, 1);
    assert.equal(new Set([...a, ...b].map((row) => row.id)).size, 3, 'no target claimed twice');
    assert.equal(store.claimDueWatchTargets({ now, leaseUntil, limit: 10 }).length, 0);

    const afterExpiry = new Date(clock.t + 61_000).toISOString();
    assert.equal(store.claimDueWatchTargets({ now: afterExpiry, leaseUntil: afterExpiry, limit: 10 }).length, 3,
      'an expired lease (crashed watcher) is reclaimed');
  } finally {
    await teardown();
  }
});

test('runWatchLoop sleeps until the next target is due (clamped), survives a failed cycle and stops on abort', async () => {
  const controller = new AbortController();
  const sleeps = [];
  const errors = [];
  let cycles = 0;
  let clock = 0;
  const dueTimes = [5000, null, -10, 99_000_000];

  await runWatchLoop({
    cycle: async () => {
      cycles += 1;
      if (cycles === 2) throw new Error('network down');
      return { checked: cycles };
    },
    nextDueAt: () => {
      const due = dueTimes[cycles - 1];
      return due === null ? null : new Date(clock + due).toISOString();
    },
    signal: controller.signal,
    maxSleepMs: 60_000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (sleeps.length === 4) controller.abort();
    },
    onError: (error) => errors.push(error.message),
  });

  assert.equal(cycles, 4);
  assert.deepEqual(errors, ['network down']);
  assert.deepEqual(sleeps, [5000, 60_000, 1000, 60_000]);
});

test('GET /lawbuddy/api/sync reports watched URLs and recent changes', async () => {
  const { store, watcher, teardown } = await setup();
  try {
    watcher.seed();
    await watcher.runDue();
    let sent = null;
    const handled = await handleLawBuddyApiRoute({ method: 'GET' }, {}, {
      pathname: '/lawbuddy/api/sync',
      parsedUrl: new URL('http://localhost/lawbuddy/api/sync'),
      legalLibrary: { get: async () => store },
      sendJson: (res, status, body) => {
        sent = { status, body };
      },
    });
    assert.equal(handled, true);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.targets.length, 3);
    assert.equal(sent.body.pendingEvents, 3);
    assert.equal(sent.body.recentEvents[0].kind, 'discovered');
    assert.ok(sent.body.nextDueAt);
  } finally {
    await teardown();
  }
});
