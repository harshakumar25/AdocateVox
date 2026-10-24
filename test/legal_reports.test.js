import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openLegalStore } from '../src/store/db.js';
import { createLegalReport, searchOfficialOnlineLeads } from '../src/reports/report.js';
import { buildReportDocx, reportToText, reviewToText, exportBlockers } from '../web/reportDocx.js';
import { reportConfig } from '../src/reports/config.js';
import { gateSources, subsectionParagraphs } from '../src/reports/sources.js';
import { majorityClaims, backendDisagreement, verifyClaims } from '../src/reports/pipeline.js';
import { LAWBUDDY_FILES, handleLawBuddyApiRoute } from '../src/routes.js';

const judgment = readFileSync(new URL('./fixtures/reports/fictional-judgment.txt', import.meta.url), 'utf8');
const caseInput = { prompt: 'Analyse Aster v. State of Example (2017): judgment, facts, issues, reviews and analysis.',
  type: 'case-analysis', provider: 'groq', asOf: '2026-10-24', jurisdiction: 'India', judgmentText: judgment,
  judgmentSnapshotDate: '2017-04-11', caseIdentity: { caption: 'Aster v. State of Example', court: 'Fictional Test Court',
    caseNo: 'TEST-17', citation: '', decisionDate: '2017-04-11' } };
const options = { checkpointDir: false };
const kindByPara = { '1': 'fact', '2': 'procedural', '3': 'party_argument', '4': 'issue', '5': 'statute_ref', '6': 'reasoning', '7': 'holding', '8': 'order' };
const paraphrases = { fact: 'Aster positioned a blue notice near a public walkway.', procedural: 'The initial forum rejected the request without hearing Aster.',
  party_argument: 'The respondent claimed the sign immediately obstructed pedestrian movement.', issue: 'Whether Aster could answer the objection was in issue.',
  statute_ref: 'The submissions mention CrPC section 152.', reasoning: 'Notice was absent from the record.',
  holding: 'Aster must have an opportunity to answer the objection.', order: 'The request will receive a new hearing after reversal of the dismissal.',
  statute: 'Permission is an element of this fictional provision.' };
const model = async ({ stage, prompt }) => {
  const data = JSON.parse(prompt);
  if (stage === 'identity') return JSON.stringify({ matched: true, courtQuote: 'Fictional Test Court', dateQuote: '2017-04-11', identifierQuote: 'TEST-17', partiesQuote: 'Aster v. State of Example', reason: 'Fixture header matches.' });
  if (stage === 'relevance') return JSON.stringify({ decision: 'KEEP', reason: 'Explicitly requested fixture.' });
  if (stage === 'extract') return JSON.stringify({ cards: data.paragraphs.map((p) => {
    const words = p.text.split(/\s+/); return { para: p.para, type: data.kind === 'statute' ? 'statute' : kindByPara[p.para], firstFive: words.slice(0, 5).join(' '), lastFive: words.slice(-5).join(' ') };
  }) });
  if (stage === 'draft') {
    const card = data.section === 'Critical analysis' ? data.cards.find((c) => c.type === 'reasoning') || data.cards[0] : data.cards[0];
    return JSON.stringify({ claims: [{ text: `${/analysis/i.test(data.section) ? 'Analysis: ' : ''}${paraphrases[card.type]}`, cardId: card.id }] });
  }
  if (stage === 'verify') return JSON.stringify({ verdicts: data.sentences.map((s) => {
    const card = data.cards.find((c) => c.id === s.cardId);
    return { id: s.id, verdict: 'SUPPORTED', claimKind: s.text.startsWith('Analysis:') ? 'analysis' : ['statute', 'statute_ref'].includes(card.type) ? 'statute' : 'case', reason: 'Supported by fictional fixture.' };
  }) });
  if (stage === 'repair') return JSON.stringify({ claims: [{ text: paraphrases[data.card.type], cardId: data.card.id }] });
  throw new Error(`Unexpected stage ${stage}`);
};
const withStore = (fn) => {
  const store = openLegalStore(':memory:');
  return Promise.resolve(fn(store)).finally(() => store.close());
};

test('ambiguous audited caption and nonexistent case stop without model calls, statutes or case claims', () => withStore(async (store) => {
  for (const prompt of ['Landmark case: Subhash v. State (2017), include judgement, facts, issues, reviews and analysis', 'Analyse Orion Nemo v. State of Example (2017): judgment and facts']) {
    const report = await createLegalReport({ store, input: { prompt, provider: 'ollama', asOf: '2026-10-24' }, options,
      generate: () => { throw new Error('model must not run'); }, retrieveSources: () => { throw new Error('statutes must not be retrieved'); } });
    assert.equal(report.status, 'identity-check-required'); assert.equal(report.sources.length, 0);
    assert.ok(report.caseCheck.missing.includes('judgment text'));
    const text = reviewToText(report); assert.match(text, /Nothing in this memo describes/);
    assert.doesNotMatch(text, /BNSS|329|Article 346/);
    assert.equal(reportToText(report), '');
    assert.throws(() => buildReportDocx(report), /Confirm the case identity/);
  }
}));

test('supplied fictional judgment produces distinct sections with literal quotes and historical correspondence', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input: caseInput, generate: model, options });
  assert.equal(report.ok, true, report.error); assert.equal(report.status, 'working-report');
  assert.ok(report.sections.facts.length); assert.ok(report.sections.holding.length); assert.ok(report.sections.finalOrder.length);
  assert.equal(report.sections.laterTreatment.length, 0); assert.match(report.researchGaps.join('\n'), /Later treatment.*Not found/);
  for (const claim of Object.values(report.sections).flat()) {
    assert.ok(claim.cardId); assert.ok(judgment.includes(claim.quote)); assert.equal(claim.support, 'SUPPORTED');
  }
  assert.equal(report.lawAsOf, '2017-04-11'); assert.equal(report.requestedAsOf, '2026-10-24');
  assert.match(report.temporal[0].asDecided, /CrPC s.152/); assert.match(report.temporal[0].currentEquivalent, /BNSS s.171/);
  assert.match(report.temporal[0].caution, /pending/);
  assert.ok(report.provenance.stages.every((s) => s.promptHash && s.model && s.temperature !== undefined));
  const doc = Buffer.from(buildReportDocx(report)).toString('utf8');
  assert.match(doc, /w:numPr/); assert.match(doc, /word\/numbering.xml/); assert.doesNotMatch(doc, /No listed intake field is blank/);
  assert.doesNotMatch(reportToText(report), /Run ID|Prompt hash|OUTPUT CHECKS|SHA-256|LEGAL RESEARCH GAPS|Not found|Models used|ORIGINAL REQUEST|REVIEW LIMITS/);
  assert.match(reportToText(report), /REFERENCES/); assert.match(reportToText(report), /\[1\]/);
  assert.equal(exportBlockers(report).length, 0);
  assert.ok(LAWBUDDY_FILES['/lawbuddy/reports']);
}));

test('mismatched parties and absent metadata cannot be filled in by a model', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input: { ...caseInput, caseIdentity: { ...caseInput.caseIdentity, caption: 'Someone Else v. State of Example' } }, options,
    generate: () => { throw new Error('must not run'); } });
  assert.equal(report.status, 'identity-check-required'); assert.match(report.caseCheck.missing.join(', '), /parties/);
}));

test('independent verifier removes partial claims and rejects a case claim backed by a statute card', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input: caseInput, options, generate: async (args) => {
    const output = JSON.parse(await model(args));
    if (args.stage === 'verify') for (const verdict of output.verdicts) verdict.verdict = 'PARTIAL';
    return JSON.stringify(output);
  } });
  assert.equal(report.status, 'insufficient-analysis');
  assert.equal(Object.values(report.sections).flat().length, 0); assert.equal(report.sections.applicableLaw.length, 0);
  assert.match(report.systemStatus, /No sentences passed/);
  assert.doesNotMatch(report.researchGaps.join(' '), /pipeline|JSON|model returned/);
}));

test('wrong literal anchors are removed even if the model provides a plausible holding', () => withStore(async (store) => {
  const report = await createLegalReport({ store, input: caseInput, options, generate: async (args) => {
    if (args.stage === 'extract') return JSON.stringify({ cards: [{ para: '7', type: 'holding', firstFive: 'The fictional court allowed all', lastFive: 'unauthorised access to any computer.' }] });
    return model(args);
  } });
  assert.equal(report.status, 'insufficient-analysis'); assert.equal(report.cards.length, 0); assert.equal(report.rejectedCards, 1);
}));

test('injected irrelevant sources are dropped and every relevance decision has a score', async () => {
  const runner = { call: async () => ({ decision: 'DROP', reason: 'Shared words only.' }), save() {} };
  const candidates = [
    { id: 'S1', title: 'BNSS s.329', text: 'Government scientific expert reports.', kind: 'statute' },
    { id: 'S2', title: 'Constitution Article 346', text: 'Official language between States.', kind: 'statute' },
    { id: 'S3', title: 'Explicit but unrelated provision', text: 'Unrelated material.', kind: 'statute', referenceScore: 1 },
  ];
  const result = await gateSources(candidates, caseInput.prompt, runner, reportConfig());
  assert.equal(result.sources.length, 0); assert.equal(result.retrievalLog.length, 3);
  assert.ok(result.retrievalLog.every((entry) => entry.decision === 'DROP' && Number.isFinite(entry.score)));
});

test('five drafts need three distinct supporting votes and diverging backends raise a notice', async () => {
  const claim = { cardId: 'C1', text: 'The test applicant can answer the objection.' };
  assert.equal(majorityClaims([[claim, claim], [claim], [], [], []], reportConfig()).length, 0);
  assert.equal(majorityClaims([[claim], [claim], [claim], [], []], reportConfig()).length, 1);
  assert.equal(backendDisagreement({ facts: [claim] }, { facts: [] }).disagreement, true);
  assert.equal(backendDisagreement({ facts: [claim] }, { facts: [claim] }).disagreement, false);
});

test('a statute card cannot support a case fact even if the verifier votes supported', async () => {
  const card = { id: 'C1', sourceId: 'S1', sourceKind: 'statute', type: 'statute', para: 's.1', quote: 'A fictional rule about a blue notice.', context: 'A fictional rule about a blue notice.' };
  const runner = { save() {}, call: async ({ payload }) => ({ verdicts: payload.sentences.map((s) => ({ id: s.id, verdict: 'SUPPORTED', claimKind: 'case', reason: 'Bad verifier vote.' })) }) };
  const claims = await verifyClaims([{ text: 'Aster placed a blue notice outside the gate.', cardId: 'C1' }], [card], runner, reportConfig(), 'wrong-kind', 'groq');
  assert.equal(claims.length, 0);
});

test('quality repair is reverified; exhausted repairs retain a visible failure banner', () => withStore(async (store) => {
  let repairCalls = 0;
  const report = await createLegalReport({ store, input: caseInput, options: { ...options, config: { maxRepairRounds: 2 } }, generate: async (args) => {
    if (args.stage === 'repair') { repairCalls++; return JSON.stringify({ claims: [] }); }
    const result = JSON.parse(await model(args));
    if (args.stage === 'draft') result.claims[0].text += ' Moreover, that is pivotal — to the issue.';
    return JSON.stringify(result);
  } });
  assert.equal(report.status, 'quality-gates-failed'); assert.equal(report.quality.pass, false);
  assert.equal(report.quality.repairRounds, 2); assert.ok(repairCalls > 0);
  assert.match(reviewToText(report), /QUALITY GATE FAILED/);
  assert.doesNotMatch(reportToText(report), /QUALITY GATE FAILED/);
  assert.throws(() => buildReportDocx(report), /quality checks/);
}));

test('checkpoint resume reuses complete stages, rejects changed requests and saves files privately', () => withStore(async (store) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lawbuddy-resume-'));
  try {
    const savedOptions = { checkpointDir: dir };
    const first = await createLegalReport({ store, input: caseInput, options: savedOptions, generate: model });
    assert.equal(first.ok, true, first.error);
    const resumed = await createLegalReport({ store, input: { ...caseInput, resumeRunId: first.runId }, options: savedOptions,
      generate: () => { throw new Error('complete stages should be cached'); } });
    assert.equal(resumed.ok, true, resumed.error); assert.ok(resumed.provenance.stages.every((s) => s.cacheHit));
    const changed = await createLegalReport({ store, input: { ...caseInput, prompt: `${caseInput.prompt} More.`, resumeRunId: first.runId }, options: savedOptions, generate: model });
    assert.equal(changed.status, 409);
    for (const file of readdirSync(path.join(dir, first.runId))) assert.equal(statSync(path.join(dir, first.runId, file)).mode & 0o077, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('no date-valid sources and future dates never trigger invented model analysis', () => withStore(async (store) => {
  const input = { prompt: 'Research section 43 of Information Technology Act, 2000.', provider: 'groq', asOf: '2026-10-24' };
  const report = await createLegalReport({ store, input, options, generate: () => { throw new Error('no evidence'); } });
  assert.equal(report.status, 'insufficient-sources'); assert.equal(report.systemStatus, 'No applicable provision identified.');
  const future = await createLegalReport({ store, input: { ...input, asOf: '2099-01-01' }, options });
  assert.equal(future.status, 400);
}));

test('subsection chunking preserves the complete third subsection instead of slicing characters', () => {
  const text = '(1) First subsection.\n(2) Second subsection.\n(3) Third subsection has a condition and an exception that must remain.';
  const chunks = subsectionParagraphs(text, 's.329');
  assert.equal(chunks[2].para, 's.329(3)'); assert.match(chunks[2].text, /must remain\.$/);
});

test('online discovery sends only named Act title to India Code', async () => {
  let queried;
  const leads = await searchOfficialOnlineLeads('Private client facts about Information Technology Act, 2000', { fetchFn: async (url) => {
    queried = url; return { ok: true, json: async () => ({ _embedded: { searchResult: { _embedded: { objects: [{ _embedded: { indexableObject: {
      name: 'The Information Technology Act, 2000', handle: '123456789/42', metadata: { 'dc.identifier.act_name': [{ value: 'Information Technology Act, 2000' }] },
    } } }] } } } }) };
  } });
  assert.equal(queried.host, 'indiacode.gov.in'); assert.doesNotMatch(queried.href, /Private|client/); assert.equal(leads.length, 1);
});

test('HTTP route uses numeric status while preserving report state in the response body', () => withStore(async (store) => {
  const input = { prompt: 'Landmark case: Subhash v. State (2017), judgment and facts', provider: 'ollama', asOf: '2026-10-24' };
  const req = Readable.from([Buffer.from(JSON.stringify(input))]); req.method = 'POST'; req.headers = {};
  let result;
  await handleLawBuddyApiRoute(req, {}, { pathname: '/lawbuddy/api/reports', parsedUrl: new URL('http://localhost/lawbuddy/api/reports'),
    legalLibrary: { get: async () => store }, reportGenerate: () => { throw new Error('no model'); },
    sendJson: (_res, status, body) => { result = { status, body }; } });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'identity-check-required');
}));
