import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openLegalStore } from '../src/store/db.js';
import { storeInVault } from '../src/sources/vault.js';
import { createSameTextCheck, createTextFingerprinter, normalizeForFingerprint } from '../src/compare/textFingerprint.js';
import { drainChangeEvents, BYTES_ONLY, SIGNAL_ONLY } from '../src/watch/events.js';
import { buildPdf } from './helpers/pdf.js';

const pagesOf = (...texts) => texts.map((text, index) => ({ page: index + 1, lines: text.split('\n').map((line) => ({ text: line })) }));

test('normalizeForFingerprint forgives only whitespace and Unicode form; words, punctuation and case still count', () => {
  const a = normalizeForFingerprint(pagesOf('Every person who is\narrested shall be proﬁled;', 'next  page'));
  assert.equal(a, 'Every person who is arrested shall be profiled; next page');
  assert.notEqual(normalizeForFingerprint(pagesOf('shall be produced;')), normalizeForFingerprint(pagesOf('shall be produced,')));
  assert.notEqual(normalizeForFingerprint(pagesOf('the State')), normalizeForFingerprint(pagesOf('the state')));
});

const setup = () => {
  const store = openLegalStore(':memory:');
  store.registerSource({ id: 'mirror', name: 'Mirror', tier: 2, baseUrl: 'https://mirror.example' });
  const texts = { old: 'Section 106. (1) Whoever causes death by negligence…', resaved: 'Section 106. (1) Whoever causes death by negligence…', amended: 'Section 106. (1) Whoever causes death by rash or negligent act…' };
  const calls = [];
  const fingerprint = createTextFingerprinter({
    store,
    vaultDir: '/vault',
    extract: async (rawPath) => {
      calls.push(rawPath);
      const sha = path.basename(rawPath);
      if (sha === 'broken') throw new Error('pdf_extract failed: PDFSyntaxError');
      return pagesOf(texts[sha]);
    },
  });
  return { store, calls, fingerprint, sameText: createSameTextCheck(fingerprint) };
};

const changed = (oldSha, newSha, extra = {}) => ({
  kind: 'changed', url: 'https://mirror.example/bare-acts/bns.pdf', old_sha256: oldSha, new_sha256: newSha,
  detail: JSON.stringify({ contentType: 'application/pdf' }), ...extra,
});

test('a re-saved PDF with identical text is a bytes-only change; an amended one is not; fingerprints are cached', async () => {
  const { store, calls, fingerprint, sameText } = setup();
  try {
    assert.equal(await sameText(changed('old', 'resaved')), true);
    assert.equal(await sameText(changed('old', 'amended')), false);
    assert.deepEqual(calls, ['/vault/ol/old', '/vault/re/resaved', '/vault/am/amended'], 'each body is extracted once, from the vault');
    assert.equal(await fingerprint('old'), store.getTextFingerprint('old').text_sha256);
    assert.equal(calls.length, 3, 'the cached fingerprint is reused');
  } finally {
    store.close();
  }
});

test('only changed PDFs with both versions are compared, and an extraction failure counts as a real change', async () => {
  const { store, calls, sameText } = setup();
  try {
    assert.equal(await sameText(changed('old', 'broken')), false);
    assert.equal(await sameText({ ...changed('old', 'resaved'), kind: 'discovered' }), false);
    assert.equal(await sameText(changed(null, 'resaved')), false);
    assert.equal(await sameText(changed('old', 'resaved', {
      url: 'https://mirror.example/bare-acts/', detail: JSON.stringify({ contentType: 'text/html' }),
    })), false);
    assert.ok(!calls.includes('/vault/re/resaved'), 'nothing is extracted for events that cannot be bytes-only');
  } finally {
    store.close();
  }
});

test('the router closes a bytes-only change before any copy check or ingestor runs', async () => {
  const { store, sameText } = setup();
  try {
    const targetId = store.upsertWatchTarget({
      url: 'https://mirror.example/bare-acts/bns.pdf', sourceId: 'mirror', watchlist: 'mirror-acts', kind: 'document',
      minIntervalMs: 1000, maxIntervalMs: 2000, nextCheckAt: '2026-10-12T00:00:00Z',
    });
    store.recordChangeEvent({ targetId, kind: 'changed', oldSha256: 'old', newSha256: 'resaved', detail: { contentType: 'application/pdf' } });
    store.recordChangeEvent({ targetId, kind: 'changed', oldSha256: 'resaved', newSha256: 'amended', detail: { contentType: 'application/pdf' } });

    let checked = 0;
    const checkers = { 'mirror-acts': async () => { checked += 1; return 'copy check: outdated'; } };
    const { processed } = await drainChangeEvents({ store, checkers, sameText });
    assert.deepEqual(processed.map((event) => event.outcome), [BYTES_ONLY, `${SIGNAL_ONLY}; copy check: outdated`]);
    assert.equal(checked, 1, 'only the real change was checked');
  } finally {
    store.close();
  }
});

const workerInstalled = existsSync(config.LEGAL_PYTHON);

test('real PDFs: a re-laid-out file with the same words matches, one changed word does not', {
  skip: workerInstalled ? false : 'PDF worker venv not installed',
}, async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-fp-'));
  const store = openLegalStore(':memory:');
  try {
    const page = (x, word) => [[
      { text: 'Section 106. Causing death by negligence.', x, y: 760, size: 11, bold: true },
      { text: `Whoever causes death by doing any ${word} act.`, x, y: 740, size: 10 },
    ]];
    const original = await storeInVault(vaultDir, buildPdf(page(72, 'negligent')));
    const relaidOut = await storeInVault(vaultDir, buildPdf(page(90, 'negligent')));
    const amended = await storeInVault(vaultDir, buildPdf(page(72, 'rash or negligent')));
    assert.notEqual(original.sha256, relaidOut.sha256, 'different bytes');

    const fingerprint = createTextFingerprinter({ store, vaultDir });
    assert.equal(await fingerprint(original.sha256), await fingerprint(relaidOut.sha256));
    assert.notEqual(await fingerprint(original.sha256), await fingerprint(amended.sha256));
  } finally {
    store.close();
    await rm(vaultDir, { recursive: true, force: true });
  }
});
