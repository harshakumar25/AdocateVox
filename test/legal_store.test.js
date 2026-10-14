import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegalStore, toFtsQuery } from '../src/store/db.js';

const seedConstitution = (store) => {
  const actId = store.upsertAct({ shortTitle: 'Constitution of India', year: 1950, ministry: 'Law and Justice' });
  const art21 = store.upsertProvision({ actId, label: 'Art.21', heading: 'Protection of life and personal liberty' });
  store.addProvisionVersion({
    provisionId: art21,
    text: 'No person shall be deprived of his life or personal liberty except according to procedure established by law.',
    validFrom: '1950-01-26',
  });
  return { actId, art21 };
};

test('toFtsQuery quotes every word so punctuation can never become FTS5 syntax', () => {
  assert.equal(toFtsQuery('Art. 21 "life"'), '"Art" "21" "life"');
  assert.equal(toFtsQuery('NEAR(OR) -* :'), '"NEAR"');
  assert.equal(toFtsQuery('what is the right to education?'), '"right" "education"');
  assert.equal(toFtsQuery('what is the right to education?', 'any'), '"right" OR "education"');
  assert.equal(toFtsQuery('what is it'), '"what" "is" "it"', 'only question words: keep them');
  assert.equal(toFtsQuery(''), '');
  assert.equal(toFtsQuery(null), '');
  assert.equal(toFtsQuery('अनुच्छेद 21'), '"अनुच्छेद" "21"');
});

test('migrations apply once and the store reopens an existing file without re-running them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-store-'));
  const file = path.join(dir, 'nested', 'lawbuddy.db');
  try {
    const first = openLegalStore(file);
    seedConstitution(first);
    first.close();

    const second = openLegalStore(file);
    const hits = second.searchProvisions('personal liberty');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, 'Art.21');
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchProvisions ranks with BM25, returns a snippet, and tolerates hostile input', () => {
  const store = openLegalStore(':memory:');
  try {
    const { actId } = seedConstitution(store);
    const art14 = store.upsertProvision({ actId, label: 'Art.14', heading: 'Equality before law' });
    store.addProvisionVersion({
      provisionId: art14,
      text: 'The State shall not deny to any person equality before the law or the equal protection of the laws within the territory of India.',
      validFrom: '1950-01-26',
    });

    const hindi = store.upsertProvision({ actId, label: 'Art.21-hi', heading: 'प्राण और दैहिक स्वतंत्रता का संरक्षण' });
    store.addProvisionVersion({
      provisionId: hindi,
      text: 'किसी व्यक्ति को उसके प्राण या दैहिक स्वतंत्रता से विधि द्वारा स्थापित प्रक्रिया के अनुसार ही वंचित किया जाएगा, अन्यथा नहीं।',
      validFrom: '1950-01-26',
    });
    assert.equal(store.searchProvisions('स्वतंत्रता')[0].label, 'Art.21-hi');
    assert.deepEqual(store.searchProvisions('स'), [], 'a lone consonant must not match inside Hindi words');

    const hits = store.searchProvisions('equality law');
    assert.equal(hits[0].label, 'Art.14');
    assert.equal(hits[0].short_title, 'Constitution of India');
    assert.match(hits[0].snippet, /\[equality\]/i);

    assert.equal(store.searchProvisions('deprived')[0].label, 'Art.21');
    assert.equal(store.searchProvisions('deprive', { match: 'any' })[0].label, 'Art.21', 'stemming: "deprive" finds "deprived"');
    assert.deepEqual(store.searchProvisions('"); DROP TABLE act; --'), []);
    assert.deepEqual(store.searchProvisions('   '), []);
  } finally {
    store.close();
  }
});

test('provision versions are point-in-time: an amendment closes the old text and both stay queryable', () => {
  const store = openLegalStore(':memory:');
  try {
    const actId = store.upsertAct({ shortTitle: 'Test Act', year: 2000 });
    const s5 = store.upsertProvision({ actId, label: 's.5', heading: 'Penalty' });
    store.addProvisionVersion({ provisionId: s5, text: 'Fine up to one thousand rupees.', validFrom: '2000-04-01' });
    store.addProvisionVersion({
      provisionId: s5,
      text: 'Fine up to ten thousand rupees.',
      validFrom: '2024-07-01',
      amendedByRef: 'Test (Amendment) Act, 2024',
    });

    assert.equal(store.getProvisionAsOf({ actId, label: 's.5', date: '2024-06-30' }).text, 'Fine up to one thousand rupees.');
    const current = store.getProvisionAsOf({ actId, label: 's.5', date: '2024-07-01' });
    assert.equal(current.text, 'Fine up to ten thousand rupees.');
    assert.equal(current.amended_by_ref, 'Test (Amendment) Act, 2024');
    assert.equal(store.getProvisionAsOf({ actId, label: 's.5', date: '1999-12-31' }), null);

    assert.equal(store.searchProvisions('thousand rupees')[0].snippet.includes('ten'), true);
    assert.equal(store.searchProvisions('thousand rupees', { asOf: '2010-01-01' })[0].snippet.includes('one'), true);
    assert.equal(store.searchProvisions('thousand rupees').length, 1, 'superseded text is excluded from current search');
  } finally {
    store.close();
  }
});

test('re-ingesting unchanged text is a no-op, and out-of-order or invalid versions are rejected', () => {
  const store = openLegalStore(':memory:');
  try {
    const { actId, art21 } = seedConstitution(store);
    const sameText = store.getProvisionAsOf({ actId, label: 'Art.21', date: '2026-01-01' }).text;
    const firstId = store.getProvisionAsOf({ actId, label: 'Art.21', date: '2026-01-01' }).id;

    assert.equal(store.addProvisionVersion({ provisionId: art21, text: sameText, validFrom: '2026-10-12' }), Number(firstId));
    assert.equal(store.searchProvisions('personal liberty').length, 1);

    assert.throws(
      () => store.addProvisionVersion({ provisionId: art21, text: 'Changed.', validFrom: '1949-11-26' }),
      RangeError,
    );
    assert.throws(() => store.addProvisionVersion({ provisionId: art21, text: 'Changed.', validFrom: '26/01/1950' }), TypeError);
    assert.throws(() => store.addProvisionVersion({ provisionId: art21, text: '  ', validFrom: '2030-01-01' }), TypeError);
    assert.equal(store.getProvisionAsOf({ actId, label: 'Art.21', date: '2026-01-01' }).text, sameText, 'failed writes roll back');
  } finally {
    store.close();
  }
});

test('a case resolves from any of its citation aliases, and a citation cannot belong to two cases', () => {
  const store = openLegalStore(':memory:');
  try {
    const caseId = store.addCase({
      court: 'SC',
      title: 'Maneka Gandhi v. Union of India',
      decidedOn: '1978-01-25',
      benchStrength: 7,
    });
    store.addCitationAlias(caseId, { scheme: 'SCC', normalized: '(1978) 1 SCC 248' });
    store.addCitationAlias(caseId, { scheme: 'AIR', normalized: 'AIR 1978 SC 597' });
    store.addCitationAlias(caseId, { scheme: 'AIR', normalized: 'AIR 1978 SC 597' });

    const found = store.findCaseByCitation({ scheme: 'AIR', normalized: 'AIR 1978 SC 597' });
    assert.equal(found.title, 'Maneka Gandhi v. Union of India');
    assert.equal(found.status, 'unknown');
    assert.deepEqual(found.aliases.map((a) => a.scheme), ['AIR', 'SCC']);

    assert.equal(store.findCaseByCitation({ scheme: 'SCC', normalized: '(1978) 1 SCC 249' }), null);

    const otherId = store.addCase({ court: 'SC', title: 'Some Other Case' });
    assert.throws(
      () => store.addCitationAlias(otherId, { scheme: 'SCC', normalized: '(1978) 1 SCC 248' }),
      /already belongs to case/,
    );
  } finally {
    store.close();
  }
});

test('fetch log keeps the latest successful fetch per URL and stamps source success', () => {
  const store = openLegalStore(':memory:');
  try {
    store.registerSource({ id: 'sci', name: 'Supreme Court of India', tier: 0, baseUrl: 'https://www.sci.gov.in' });
    const url = 'https://www.sci.gov.in/judgments';
    store.recordFetch({ sourceId: 'sci', url, httpStatus: 200, sha256: 'a', etag: '"v1"', rawPath: '/vault/a', fetchedAt: '2026-10-10T00:00:00Z' });
    store.recordFetch({ sourceId: 'sci', url, httpStatus: 503, error: 'unavailable', fetchedAt: '2026-10-11T00:00:00Z' });
    store.recordFetch({ sourceId: 'sci', url, httpStatus: 200, sha256: 'b', etag: '"v2"', rawPath: '/vault/b', fetchedAt: '2026-10-12T00:00:00Z' });
    // A streamed archive is logged without a stored body, so it can never answer a conditional GET.
    store.recordFetch({ sourceId: 'sci', url, httpStatus: 200, sha256: 'c', etag: '"v3"', fetchedAt: '2026-10-13T00:00:00Z' });

    const last = store.lastSuccessfulFetch(url);
    assert.equal(last.sha256, 'b');
    assert.equal(last.etag, '"v2"');
    assert.equal(store.lastSuccessfulFetch('https://www.sci.gov.in/other'), null);
    assert.throws(() => store.recordFetch({ sourceId: 'unregistered', url, httpStatus: 200 }), /FOREIGN KEY/);
  } finally {
    store.close();
  }
});
