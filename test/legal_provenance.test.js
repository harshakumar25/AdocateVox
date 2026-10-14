import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openLegalStore } from '../src/store/db.js';
import { createProvenanceResolver, gazetteIdsIn, provenanceHook } from '../src/sources/gazette.js';
import { drainChangeEvents, SIGNAL_ONLY } from '../src/watch/events.js';

test('gazetteIdsIn reads Gazette IDs and maps them to e-Gazette URLs using digits only', () => {
  const masthead = 'REGISTERED NO. DL—(N)04/0007/2003—23 | CG-DL-E-25122023-250883 | EXTRAORDINARY | CG-DL-E-25122023-250883';
  assert.deepEqual(gazetteIdsIn(masthead), [
    { id: 'CG-DL-E-25122023-250883', date: '2023-12-25', url: 'https://egazette.gov.in/WriteReadData/2023/250883.pdf' },
  ]);
  assert.deepEqual(gazetteIdsIn('CG-DL-E-31022024-123456 (no such day)'), []);
  assert.deepEqual(gazetteIdsIn('CG-DL-E-25122023-250883/../../evil.example?x').map((g) => g.url),
    ['https://egazette.gov.in/WriteReadData/2023/250883.pdf'], 'hostile trailing text never reaches the URL');
  assert.deepEqual(gazetteIdsIn('no gazette here'), []);
});

const MIRROR = 'mirrorsha';
const pagesFor = (texts) => async (rawPath) => [{ page: 1, lines: [{ text: texts[path.basename(rawPath)] ?? '' }] }];

const setup = (officialResults, texts) => {
  const store = openLegalStore(':memory:');
  const fetched = [];
  const fetcher = {
    fetchDocument: async (url) => {
      fetched.push(url);
      return officialResults[url] ?? { ok: false, status: 404, error: 'HTTP 404' };
    },
  };
  const resolve = createProvenanceResolver({ store, fetcher, vaultDir: '/vault', extract: pagesFor(texts), now: () => Date.parse('2026-10-12T00:00:00Z') });
  return { store, fetched, resolve };
};

const BNS_URL = 'https://egazette.gov.in/WriteReadData/2023/250883.pdf';

test('a mirror identical to its official Gazette is recorded as identical; a different one as different', async () => {
  const texts = { [MIRROR]: 'CG-DL-E-25122023-250883 THE BHARATIYA NYAYA SANHITA', official: 'CG-DL-E-25122023-250883 official' };
  const identical = setup({ [BNS_URL]: { ok: true, sha256: MIRROR, rawPath: '/vault/of/official' } }, texts);
  try {
    assert.equal(await identical.resolve({ url: 'https://mirror.example/bns.pdf', sha256: MIRROR }),
      'byte-identical to the official Gazette CG-DL-E-25122023-250883');
    assert.deepEqual(identical.fetched, [BNS_URL]);
    const [row] = identical.store.provenanceFor('https://mirror.example/bns.pdf');
    assert.equal(row.relation, 'identical');
    assert.equal(row.official_sha256, MIRROR);
  } finally {
    identical.store.close();
  }

  const different = setup({ [BNS_URL]: { ok: true, sha256: 'officialsha', rawPath: '/vault/of/official' } }, texts);
  try {
    assert.match(await different.resolve({ url: 'https://mirror.example/bns.pdf', sha256: MIRROR }), /differs from the official Gazette/);
    assert.equal(different.store.provenanceFor('https://mirror.example/bns.pdf')[0].relation, 'different');
  } finally {
    different.store.close();
  }
});

test('nothing is linked when the official file does not name the ID, the fetch fails, or the copy has no ID', async () => {
  const wrongFile = setup(
    { [BNS_URL]: { ok: true, sha256: 'x', rawPath: '/vault/ot/other' } },
    { [MIRROR]: 'CG-DL-E-25122023-250883', other: 'CG-DL-E-01012024-999999 a different notification' },
  );
  try {
    assert.match(await wrongFile.resolve({ url: 'https://mirror.example/a.pdf', sha256: MIRROR }), /does not carry Gazette ID .*not linked/);
    assert.deepEqual(wrongFile.store.provenanceFor('https://mirror.example/a.pdf'), []);
  } finally {
    wrongFile.store.close();
  }

  const unreachable = setup({}, { [MIRROR]: 'CG-DL-E-25122023-250883' });
  try {
    assert.match(await unreachable.resolve({ url: 'https://mirror.example/a.pdf', sha256: MIRROR }), /could not be fetched \(HTTP 404\)/);
  } finally {
    unreachable.store.close();
  }

  const noId = setup({}, { [MIRROR]: 'THE LIMITATION ACT, 1963 (no masthead)' });
  try {
    assert.equal(await noId.resolve({ url: 'https://mirror.example/limitation.pdf', sha256: MIRROR }), null);
    assert.deepEqual(noId.fetched, []);
  } finally {
    noId.store.close();
  }
});

test('the provenance hook runs on new or changed PDFs and its note joins the copy check in the event outcome', async () => {
  const seen = [];
  const hook = provenanceHook(async (copy) => {
    seen.push(copy);
    return 'byte-identical to the official Gazette CG-DL-E-25122023-250883';
  });
  assert.equal(await hook({ kind: 'removed', url: 'https://m.example/a.pdf', new_sha256: 'x' }), null);
  assert.equal(await hook({ kind: 'changed', url: 'https://m.example/', new_sha256: 'x' }), null, 'not a PDF');
  const failing = provenanceHook(async () => { throw new Error('PDF worker crashed'); });
  assert.equal(await failing({ kind: 'changed', url: 'https://m.example/a.pdf', new_sha256: 'x' }), 'provenance not resolved: PDF worker crashed');

  const store = openLegalStore(':memory:');
  try {
    store.registerSource({ id: 'mirror', name: 'Mirror', tier: 2, baseUrl: 'https://m.example' });
    const targetId = store.upsertWatchTarget({
      url: 'https://m.example/bns.pdf', sourceId: 'mirror', watchlist: 'mirror-acts', kind: 'document',
      minIntervalMs: 1000, maxIntervalMs: 2000, nextCheckAt: '2026-10-12T00:00:00Z',
    });
    store.recordChangeEvent({ targetId, kind: 'discovered', newSha256: 'bnssha' });
    const { processed } = await drainChangeEvents({
      store, signalHooks: [hook], checkers: { 'mirror-acts': async () => 'copy check: current' },
    });
    assert.equal(processed[0].outcome,
      `${SIGNAL_ONLY}; byte-identical to the official Gazette CG-DL-E-25122023-250883; copy check: current`);
    assert.deepEqual(seen.at(-1), { url: 'https://m.example/bns.pdf', sha256: 'bnssha' });
  } finally {
    store.close();
  }
});
