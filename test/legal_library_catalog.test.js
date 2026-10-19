import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { PRACTICE_ACTS, cataloguedActs } from '../src/ingest/libraryCatalog.js';
import { searchCatalog, searchLaw } from '../src/service.js';
import { getActProvision } from '../src/service.js';
import { createLawRetriever, createLegalStoreLoader, detectLegalReferences, retrieveLegalEvidence } from '../src/retrieval/legalRetriever.js';

test('catalogue keeps cross-topic Acts canonical and distinguishes source identity from indexed text', () => {
  const store = openLegalStore(':memory:');
  try {
    const contract = PRACTICE_ACTS.filter((item) => item.id === 'ICA1872');
    assert.equal(contract.length, 1);
    assert.deepEqual(contract[0].topics, ['corporate', 'civil']);
    const civil = cataloguedActs(store, { topic: 'civil' });
    assert.equal(civil.filter((item) => item.id === 'ICA1872').length, 1);
    assert.equal(civil.find((item) => item.id === 'ICA1872').status, 'source-identified');
    assert.equal(searchCatalog(store, { query: 'Companies Act 2006' }).foreignNotice.includes('UK law'), true);
    assert.equal(searchCatalog(store, { query: 'Companies Act 2006', includeForeign: true }).items[0].jurisdiction, 'UK');
    assert.equal(searchLaw(store, 'director duties', { act: 'CA2013' }).reason, 'not-indexed');
    assert.equal(searchLaw(store, 'director duties', { act: 'UKCA2006' }).status, 400);
    assert.equal(searchCatalog(store, { asOf: '2026-02-30' }).status, 400);
    assert.equal(searchLaw(store, 'director duties', { asOf: '2026-02-30' }).status, 400);
  } finally { store.close(); }
});

test('cyber index separates Acts, rules, directions and technical standards', () => {
  const store = openLegalStore(':memory:');
  try {
    const ids = new Set(cataloguedActs(store, { topic: 'cyber' }).map((item) => item.id));
    for (const id of ['BNS2023', 'BNSS2023', 'BSA2023', 'IT2000', 'DPDP2023', 'DPDPR2025', 'ITINTERMEDIARY2021', 'ITINTERMEDIARYAMEND2026', 'ITSPDI2011', 'CERTINRULES2013', 'ITBLOCK2009', 'TELECOM2023', 'ECOM2020']) assert.ok(ids.has(id), id);
    for (const id of ['CERTINRULES2013', 'ITBLOCK2009']) {
      const item = cataloguedActs(store, { query: id })[0];
      assert.equal(item.instrumentType, 'rules');
      assert.equal(item.parentId, 'IT2000');
      assert.equal(item.status, 'source-identified');
    }
    const rules = cataloguedActs(store, { query: 'dpdp rules' })[0];
    assert.equal(rules.instrumentType, 'rules');
    assert.equal(rules.parentId, 'DPDP2023');
    assert.equal(rules.status, 'source-identified');
    const standard = cataloguedActs(store, { query: 'cyber security standards' })[0];
    assert.equal(standard.id, 'BIS27001');
    assert.equal(standard.instrumentType, 'standard');
    assert.equal(searchLaw(store, 'security management', { act: 'BIS27001' }).status, 400);
    assert.equal(searchLaw(store, 'consent', { act: 'DPDP2023' }).reason, 'not-indexed');
    assert.equal(cataloguedActs(store, { query: 'spdi rules' })[0].status, 'source-identified');
    assert.equal(cataloguedActs(store, { query: 'deepfake rules 2026' })[0].parentId, 'ITINTERMEDIARY2021');
  } finally { store.close(); }
});

test('indexed search is Act-scoped, dated and carries the source of the matching version', () => {
  const store = openLegalStore(':memory:');
  try {
    const contract = store.upsertAct({ shortTitle: 'Indian Contract Act, 1872', year: 1872 });
    const company = store.upsertAct({ shortTitle: 'Companies Act, 2013', year: 2013 });
    const contractProvision = store.upsertProvision({ actId: contract, label: 's.10', heading: 'Contracts' });
    const companyProvision = store.upsertProvision({ actId: company, label: 's.10', heading: 'Contracts' });
    store.addProvisionVersion({ provisionId: contractProvision, text: 'Agreement becomes a contract on the stated conditions.', validFrom: '2020-01-01', sourceUrl: 'https://www.indiacode.nic.in/contract-old.pdf', sourceSha256: 'old' });
    store.addProvisionVersion({ provisionId: contractProvision, text: 'A changed agreement becomes a contract.', validFrom: '2030-01-01', sourceUrl: 'https://www.indiacode.nic.in/contract-future.pdf', sourceSha256: 'future' });
    store.addProvisionVersion({ provisionId: companyProvision, text: 'Company contracts require separate review.', validFrom: '2020-01-01', sourceUrl: 'https://www.indiacode.nic.in/company.pdf', sourceSha256: 'company' });

    const past = searchLaw(store, 'contract', { act: 'ICA1872', asOf: '2026-10-18' });
    assert.equal(past.hits.length, 1);
    assert.equal(past.hits[0].act, 'Indian Contract Act, 1872');
    assert.equal(past.hits[0].source.url, 'https://www.indiacode.nic.in/contract-old.pdf');
    assert.equal(store.searchProvisions('changed', { asOf: '2026-10-18' }).length, 0);
    const catalog = cataloguedActs(store, { query: 'contract act', asOf: '2026-10-18' });
    assert.equal(catalog[0].indexedSections, 1);
    assert.equal(catalog[0].indexedSourceUrl, 'https://www.indiacode.nic.in/contract-old.pdf');
    assert.equal(searchLaw(store, 'changed', { act: 'ICA1872', asOf: '2030-01-01' }).hits.length, 1);
  } finally { store.close(); }
});

test('named cyber provisions resolve only to the correct official-source instrument and historical version', async () => {
  const store = openLegalStore(':memory:');
  try {
    const it = store.upsertAct({ shortTitle: 'Information Technology Act, 2000', year: 2000 });
    const section = store.upsertProvision({ actId: it, label: 's.43', heading: 'Damage to computer, computer system, etc.' });
    store.addProvisionVersion({ provisionId: section, text: 'Legacytoken access to a computer.', validFrom: '2001-01-01', sourceUrl: 'https://www.indiacode.nic.in/official-it-old.pdf', sourceSha256: 'old' });
    store.addProvisionVersion({ provisionId: section, text: 'Newtoken damage to a computer.', validFrom: '2030-01-01', sourceUrl: 'https://www.indiacode.nic.in/official-it-new.pdf', sourceSha256: 'new' });

    assert.deepEqual(detectLegalReferences('IT Act section 43').sections, [{ act: 'IT2000', label: 's.43' }]);
    assert.deepEqual(detectLegalReferences('rule 4 of DPDP Rules').sections, [{ act: 'DPDPR2025', label: 'r.4' }]);
    assert.deepEqual(detectLegalReferences('rule 3 of Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021').sections, [{ act: 'ITINTERMEDIARY2021', label: 'r.3' }]);
    assert.deepEqual(detectLegalReferences('rule 5 of IT Blocking Rules').sections, [{ act: 'ITBLOCK2009', label: 'r.5' }]);
    assert.deepEqual(detectLegalReferences('section 10 of Companies Act, 2013').sections, [{ act: 'CA2013', label: 's.10' }]);
    assert.deepEqual(detectLegalReferences('BNS s. 103').sections, [{ act: 'BNS', label: 's.103' }]);
    const [evidence] = retrieveLegalEvidence({ store, references: detectLegalReferences('section 43 of Information Technology Act, 2000'), asOf: '2026-10-19' });
    assert.match(evidence.content, /Information Technology Act, 2000, section 43/);
    assert.match(evidence.content, /Legacytoken/);
    assert.doesNotMatch(evidence.content, /Newtoken/);
    assert.equal(getActProvision(store, 'IT2000', '43', '2026-10-19').source.sha256, 'old');
    assert.equal(getActProvision(store, 'IT2000', '43', '2030-01-01').source.sha256, 'new');
    const oldRetriever = createLawRetriever({ loader: createLegalStoreLoader({ store }), asOf: '2026-10-19' });
    const nextRetriever = createLawRetriever({ loader: createLegalStoreLoader({ store }), asOf: '2030-01-01' });
    assert.equal((await oldRetriever({ text: 'Legacytoken' }))[0].label, 's.43');
    assert.equal((await nextRetriever({ text: 'Legacytoken' })).length, 0);
  } finally { store.close(); }
});

test('unregistered provision sources cannot promote a catalogue entry or reach legal evidence', () => {
  const store = openLegalStore(':memory:');
  try {
    const actId = store.upsertAct({ shortTitle: 'Digital Personal Data Protection Act, 2023', year: 2023 });
    const provisionId = store.upsertProvision({ actId, label: 's.5', heading: 'Notice' });
    store.addProvisionVersion({ provisionId, text: 'Unverified notice wording.', validFrom: '2025-11-13', sourceUrl: 'https://example.com/dpdp.pdf', sourceSha256: 'demo' });
    assert.equal(cataloguedActs(store, { query: 'dpdp' }).find((item) => item.id === 'DPDP2023').status, 'source-identified');
    assert.equal(searchLaw(store, 'notice', { act: 'DPDP2023' }).status, 404);
    assert.equal(getActProvision(store, 'DPDP2023', '5').reason, 'unverified-source');
    assert.deepEqual(retrieveLegalEvidence({ store, references: detectLegalReferences('section 5 of Digital Personal Data Protection Act, 2023') }), []);
  } finally { store.close(); }
});

test('unverified imports cannot inflate coverage or displace an official ranked hit', () => {
  const store = openLegalStore(':memory:');
  try {
    const actId = store.upsertAct({ shortTitle: 'Information Technology Act, 2000', year: 2000 });
    const official = store.upsertProvision({ actId, label: 's.43', heading: 'Computer access' });
    const unverified = store.upsertProvision({ actId, label: 's.999', heading: 'Zephyrterm' });
    store.addProvisionVersion({ provisionId: official, text: 'Zephyrterm computer access.', validFrom: '2020-01-01', sourceUrl: 'https://www.indiacode.nic.in/it.pdf', sourceSha256: 'official' });
    store.addProvisionVersion({ provisionId: unverified, text: 'Zephyrterm.', validFrom: '2020-01-01', sourceUrl: 'https://example.com/it.pdf', sourceSha256: 'unverified' });
    assert.equal(store.searchProvisions('Zephyrterm', { limit: 1 })[0].label, 's.999');
    assert.equal(store.searchProvisions('Zephyrterm', { limit: 1, officialOnly: true })[0].label, 's.43');
    const result = searchLaw(store, 'Zephyrterm', { act: 'IT2000', limit: 1 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].label, 's.43');
    const item = cataloguedActs(store, { query: 'Information Technology Act, 2000' })[0];
    assert.equal(item.status, 'indexed-as-of');
    assert.equal(item.indexedSections, 1);
    assert.equal(item.indexedSourceUrl, 'https://www.indiacode.nic.in/it.pdf');
  } finally { store.close(); }
});

test('the home summary identifies unofficial text alignments as research aids', () => {
  const store = openLegalStore(':memory:');
  try {
    store.replaceMappings({
      newAct: 'BNS', oldAct: 'IPC', sourceUrl: 'https://yourlordships.in/ipc.pdf', sourceSha256: 'copy',
      entries: [
        { kind: 'mapped', newLabel: 's.1', newTitle: 'Title', oldLabel: 's.1', oldTitle: 'Title', changed: false, chapter: 'text alignment: 90% shared' },
        { kind: 'new', newLabel: 's.2', newTitle: 'Definitions', oldLabel: null, oldTitle: null, changed: false, chapter: null },
      ],
    });
    assert.equal(store.librarySummary().correspondence[0].method, 'alignment');
  } finally { store.close(); }
});
