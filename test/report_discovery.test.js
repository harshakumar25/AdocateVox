import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverReportCase } from '../src/reports/discovery.js';
import { identifyReportTask } from '../src/reports/task.js';
const row = { id: 7, title: 'Aster versus State of Example', court: 'SC', decided_on: '2017-04-11', case_no: 'TEST-17', aliases: ['[2017] 1 SCR 1'], pdf_url: 'https://example.test/judgment.pdf' };
const task = identifyReportTask('Aster v. State of Example (2017)');
const makeStore = (rows = [row]) => ({ reportCaseCandidates: () => rows, latestDocument: () => null });
const pages = [{ page: 1, lines: [{ text: '[2017] 1 SCR 1. Aster versus State of Example. April 11, 2017. The application was allowed.' }] }];
test('automatic case discovery retrieves identity and page passages without user fields', async () => {
  const result = await discoverReportCase({ store: makeStore(), task, input: {},
    fetcher: { fetchDocument: async () => ({ rawPath: '/fixture.pdf', sha256: 'hash' }) }, extract: async () => pages });
  assert.equal(result.status, 'located'); assert.equal(result.identity.court, 'Supreme Court of India');
  assert.equal(result.identity.decisionDate, '2017-04-11'); assert.equal(result.paragraphs[0].para, 'p1.1');
  assert.equal(result.authority, 'court-record-mirror'); assert.match(result.anchor, /not court paragraph/);
});
test('partial party-name matches do not select an unrelated judgment', async () => {
  const result = await discoverReportCase({ store: makeStore([{ ...row, title: 'Asterix versus State of Example' }]), task, input: {} });
  assert.equal(result.status, 'research-incomplete'); assert.equal(result.candidates.length, 0);
});
test('multiple matching cases ask only for a choice and do not download before selection', async () => {
  const store = makeStore([row, { ...row, id: 8, case_no: 'TEST-18' }]);
  const result = await discoverReportCase({ store, task, input: {}, fetcher: { fetchDocument: () => { throw Error('must not download'); } } });
  assert.equal(result.status, 'choose-case'); assert.equal(result.candidates.length, 2);
  const selected = await discoverReportCase({ store, task, input: { selectedCaseId: 8 }, fetcher: { fetchDocument: async () => ({ rawPath: '/fixture.pdf' }) }, extract: async () => pages });
  assert.equal(selected.identity.caseNo, 'TEST-18');
  const invalid = await discoverReportCase({ store, task, input: { selectedCaseId: 99 } });
  assert.equal(invalid.status, 'choose-case');
});
test('a missing case triggers a bounded online metadata refresh before giving up', async () => {
  let refreshed = false;
  const store = { ...makeStore(), reportCaseCandidates: () => refreshed ? [row] : [] };
  const result = await discoverReportCase({ store, task, input: {}, fetcher: { fetchDocument: async () => ({ rawPath: '/fixture.pdf' }) },
    syncYear: async ({year}) => { assert.equal(year, 2017); refreshed = true; return { ok: true }; }, extract: async () => pages });
  assert.equal(result.status, 'located'); assert.ok(result.log.find((r) => r.action === 'refresh-court-metadata'));
});
test('a cached PDF is read without another download and source failures are actionable', async () => {
  const store = { ...makeStore(), latestDocument: () => ({ raw_path: '/cached.pdf', sha256: 'abc' }) };
  const result = await discoverReportCase({ store, task, input: {}, fetcher: { fetchDocument: () => { throw Error('no network'); } }, extract: async (path) => { assert.equal(path, '/cached.pdf'); return pages; } });
  assert.equal(result.status, 'located');
  const failed = await discoverReportCase({ store: makeStore(), task, input: {}, fetcher: { fetchDocument: async () => ({ ok: false, status: 503 }) } });
  assert.equal(failed.status, 'research-incomplete'); assert.doesNotMatch(failed.message, /Supply|Missing:/);
});
test('a citation alone routes to case discovery', () => {
  assert.equal(identifyReportTask('2017 INSC 716').kind, 'named-case');
});

test('retrieved PDF identity mismatch cannot enter the report pipeline', async () => {
  const result = await discoverReportCase({ store: makeStore(), task, input: {},
    fetcher: { fetchDocument: async () => ({ rawPath: '/wrong.pdf' }) },
    extract: async () => [{page:1,lines:[{text:'[2017] 1 SCR 1. Other Person versus State of Example. April 11, 2017.'}]}] });
  assert.equal(result.status, 'research-incomplete'); assert.equal(result.text, undefined);
  assert.match(result.log.at(-1).error, /identity/);
});
