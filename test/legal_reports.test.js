import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { createLegalReport, searchOfficialOnlineLeads } from '../src/reports/report.js';
import { generateReportText } from '../src/reports/provider.js';
import { buildReportDocx, reportToText } from '../web/reportDocx.js';
import { LAWBUDDY_FILES } from '../src/routes.js';

const input = { prompt: 'Research section 43 of Information Technology Act, 2000 and permission for security testing.', type: 'memo', asOf: '2026-10-20', jurisdiction: 'India', provider: 'ollama' };
const withStore = (fn) => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct({ shortTitle: 'Information Technology Act, 2000', year: 2000 });
  const section = store.upsertProvision({ actId, label: 's.43', heading: 'Damage to computer' });
  store.addProvisionVersion({ provisionId: section, text: 'Accesses or secures access to a computer without permission of the owner.', validFrom: '2001-01-01',
    sourceUrl: 'https://indiacode.gov.in/bitstream/123456789/ITACT/1/itact.pdf', sourceSha256: 'official' });
  return Promise.resolve(fn(store)).finally(() => store.close());
};

test('report accepts only source-linked model propositions and exports a Word package', () => withStore(async (store) => {
  let calls = 0;
  const report = await createLegalReport({ store, input, onlineSearch: async () => [], generate: async ({ prompt }) => {
    calls += 1;
    assert.match(prompt, /without permission/);
    return JSON.stringify({ executiveSummary: [{ text: 'The permission issue is relevant.', evidenceIds: ['S1'], quote: 'without permission of the owner' }, { text: 'Invented authority.', evidenceIds: ['S9'], quote: 'without permission of the owner' }],
      analysis: [{ text: 'The record needs proof of permission.', evidenceIds: ['S1'], quote: 'without permission of the owner' }], researchGaps: [{ text: 'Check evidence of authorisation.' }] });
  } });
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.equal(report.sources[0].id, 'S1');
  assert.equal(report.sections.executiveSummary.length, 1);
  assert.equal(report.sections.analysis[0].evidenceIds[0], 'S1');
  assert.deepEqual(report.researchGaps, ['Check evidence of authorisation.']);
  assert.doesNotMatch(reportToText(report), /Invented authority/);
  const bytes = buildReportDocx(report);
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), 'PK\u0003\u0004');
  assert.ok(bytes.length > 2000);
  assert.ok(LAWBUDDY_FILES['/lawbuddy/reports']);
}));

test('report with no date-valid indexed text exposes research gap and does not ask model to invent law', () => withStore(async (store) => {
  let called = false;
  const report = await createLegalReport({ store, input: { ...input, asOf: '1990-01-01' }, generate: async () => { called = true; return '{}'; }, onlineSearch: async () => [] });
  assert.equal(report.ok, true);
  assert.equal(called, false);
  assert.equal(report.sources.length, 0);
  assert.match(report.systemStatus, /No specifically identified official provision/);
}));

test('future as-of date is rejected before model or online lookup', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input: { ...input, asOf: '2099-01-01' },
    generate: async () => { throw new Error('model should not run'); }, onlineSearch: async () => { throw new Error('online should not run'); } });
  assert.equal(report.status, 400);
}));

test('unparseable model output leaves analysis empty without laundering indexed sources', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input, generate: async () => 'not JSON', onlineSearch: async () => [] });
  assert.equal(report.sections.analysis.length, 0);
  assert.equal(report.sections.applicableLaw.length, 0);
  assert.match(report.researchGaps[0], /no claim with a valid source quotation/i);
}));

test('online discovery uses fixed India Code host and passes only matched Act title', async () => {
  let queried;
  const leads = await searchOfficialOnlineLeads('My private client record concerns section 43 of Information Technology Act, 2000', {
    fetchFn: async (url) => { queried = url; return { ok: true, json: async () => ({ _embedded: { searchResult: { _embedded: { objects: [{ _embedded: { indexableObject: {
      name: 'The Information Technology Act, 2000', handle: '123456789/42', metadata: { 'dc.identifier.act_name': [{ value: 'Information Technology Act, 2000' }] },
    } } }] } } } }) }; },
  });
  assert.equal(queried.host, 'indiacode.gov.in');
  assert.doesNotMatch(queried.href, /private|client/i);
  assert.equal(leads[0].status, 'online-catalogue-lead');
  assert.match(leads[0].url, /indiacode.gov.in/);
});

test('IT Act report brings section 66 beside section 43 and rejects an unsupported criminalisation claim', () => withStore(async (store) => {
  const actId = store.findAct({ shortTitle: 'Information Technology Act, 2000', year: 2000 });
  const section = store.upsertProvision({ actId, label: 's.66', heading: 'Computer related offences' });
  store.addProvisionVersion({ provisionId: section, text: 'If any person, dishonestly or fraudulently, does any act referred to in section 43, he shall be punishable.',
    validFrom: '2001-01-01', sourceUrl: 'https://indiacode.gov.in/bitstream/123456789/ITACT/1/itact.pdf', sourceSha256: 'official' });
  const report = await createLegalReport({ store, input, onlineSearch: async () => [], generate: async ({ systemPrompt, prompt }) => {
    assert.match(systemPrompt, /not itself the criminal offence/);
    assert.match(prompt, /dishonestly or fraudulently/);
    return JSON.stringify({ executiveSummary: [
      { text: 'Section 43 imposes criminal liability.', evidenceIds: ['S1'], quote: 'without permission of the owner' },
      { text: 'Section 66 punishes a section 43 act done dishonestly or fraudulently.', evidenceIds: ['S1', 'S2'], quote: 'dishonestly or fraudulently, does any act referred to in section 43' },
    ] });
  } });
  assert.equal(report.sources.length >= 2, true);
  assert.equal(report.sections.executiveSummary.length, 1);
  assert.match(report.sections.executiveSummary[0].text, /Section 66/);
}));

test('named 2017 case stops before statutory retrieval and either model, exposing only identity leads', () => withStore(async (store) => {
  store.upsertScCase({ key: 'candidate', title: 'Subhash Kumar v. State of Maharashtra', decidedOn: '2017-04-11',
    caseNo: 'Criminal Appeal 1/2017', sourceUrl: 'https://www.sci.gov.in/example', pdfUrl: 'https://www.sci.gov.in/example.pdf' });
  let modelCalls = 0;
  const report = await createLegalReport({ store, input: { ...input, prompt: 'Landmark case: Subhash v. State (2017) — judgement, facts, issues, reviews, analysis', provider: 'groq' },
    generate: async () => { modelCalls++; return '{}'; }, onlineSearch: async () => { throw new Error('statute lookup must not run'); } });
  assert.equal(report.status, 'identity-check-required');
  assert.equal(modelCalls, 0);
  assert.equal(report.sources.length, 0);
  assert.equal(report.sections.applicableLaw.length, 0);
  assert.equal(report.caseCheck.candidates.length, 1);
  assert.match(reportToText(report), /NO JUDGMENT ANALYSIS/);
  assert.doesNotMatch(reportToText(report), /BNSS|Article 346|holding of the case/i);
}));

test('a source ID without an exact source quotation cannot pass as grounded analysis', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input, onlineSearch: async () => [], generate: async () => JSON.stringify({
    analysis: [{ text: 'The court held that all scans are lawful.', evidenceIds: ['S1'], quote: 'The court held that all scans are lawful.' },
      { text: 'A claim with a quoted but unrelated statute.', evidenceIds: ['S1'], quote: 'without permission of the owner' }],
  }) });
  assert.equal(report.sections.analysis.length, 0);
  assert.doesNotMatch(reportToText(report), /all scans are lawful/);
}));

test('Grok uses xAI Responses API with server-side key and disabled response storage', async () => {
  const result = await generateReportText({ provider: 'grok', systemPrompt: 'system', prompt: 'question', options: {
    XAI_API_KEY: 'test-key', XAI_MODEL: 'grok-test', fetchFn: async (url, init) => {
      assert.equal(url, 'https://api.x.ai/v1/responses');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'grok-test');
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, 'json_object');
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"issues":[]}' }] }] }) };
    },
  } });
  assert.equal(result, '{"issues":[]}');
});

test('Groq report uses strict JSON schema on the configured GPT-OSS model', async () => {
  const result = await generateReportText({ provider: 'groq', systemPrompt: 'system', prompt: 'question', options: {
    GROQ_API_KEY: 'test-key', GROQ_MODEL: 'openai/gpt-oss-20b', fetchFn: async (url, init) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(body.response_format.json_schema.schema.required, ['executiveSummary', 'issues', 'applicableLaw', 'analysis', 'counterarguments', 'conclusion', 'nextSteps', 'researchGaps']);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"issues":[]}' } }] }) };
    },
  } });
  assert.equal(result, '{"issues":[]}');
});
