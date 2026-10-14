import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { openLegalStore } from '../src/store/db.js';
import { config } from '../src/config.js';
import { extractCitations } from '../src/parse/citationParser.js';
import { analyseJudgment, articleMentions, repairOcrCitations, stripRunningHeads } from '../src/parse/judgmentCitations.js';
import { rebuildCitationGraph, resolveCitationGraph } from '../src/cases/citationGraph.js';
import { indexScTextYear, runTextWorker, scTextArchiveUrl, scTextIndexUrl, sourceKeyOf } from '../src/cases/textIndex.js';
import { scrCitationFromKey } from '../src/sources/scOpenData.js';
import { casesForProvision, citingJudgments } from '../src/cases/service.js';
import { handleLawBuddyApiRoute } from '../src/routes.js';
import { citationPoints, scoreCase } from '../src/cases/rank.js';
import { createPoliteFetcher } from '../src/sources/fetcher.js';
import { CONSTITUTION_ACT } from '../src/ingest/constitution.js';
import { buildPdf } from './helpers/pdf.js';
import { quotedByLaterJudgments, quotedPassageScores, selectPassages } from '../src/cases/brief.js';

// ------------------------------------------------------------------ reading a judgment

test('SCR citations in every printed form, including supplementary volumes and the e-SCR AIR form', () => {
  const normalized = (text) => extractCitations(text).map((citation) => citation.normalized);
  assert.deepEqual(normalized('[1976] SUPP. 1 S.C.R. 172'), ['[1976] Supp. 1 SCR 172'], 'the Court\'s own form');
  assert.deepEqual(normalized('[2004] 2 Suppl. SCR 723'), ['[2004] Supp. 2 SCR 723']);
  assert.deepEqual(normalized('[2001] Supp. 2 SCR 128'), ['[2001] Supp. 2 SCR 128']);
  assert.deepEqual(normalized('[1976] Supp l. SCR 172'), ['[1976] Supp. SCR 172'], 'OCR "Supp l."');
  assert.deepEqual(normalized('[2017) 10 S.C.R. 569'), ['[2017] 10 SCR 569']);
  assert.deepEqual(normalized('[2023] 11 SCR 1005 : AIR 2023 SUPREME COURT 5709'), ['[2023] 11 SCR 1005', 'AIR 2023 SC 5709']);
  assert.deepEqual(normalized('608 SUPREME COURT REPORTS [2017) 10 S.C.R. A (1976)'), [], 'a page head with no page number is no citation');
  assert.equal(scrCitationFromKey('2017_10_569_999'), '[2017] 10 SCR 569');
  assert.equal(scrCitationFromKey('S_1976_1_172_477'), '[1976] Supp. 1 SCR 172');
  assert.equal(scrCitationFromKey('garbage'), null);
});

test('OCR damage to citations is repaired, and running heads are dropped before reading', () => {
  assert.equal(repairOcrCitations('[19671 3 SCR .525'), '[1967] 3 SCR 525');
  assert.equal(repairOcrCitations('[19541 SCR 587'), '[1954] SCR 587');
  assert.equal(repairOcrCitations('L1973] 3 SCR 530 and T19731 3 SCR 530'), '[1973] 3 SCR 530 and [1973] 3 SCR 530');
  assert.equal(repairOcrCitations('[1 973] 1 SCR 856'), '[1973] 1 SCR 856');
  assert.equal(repairOcrCitations('(1976) 2 sec 521'), '(1976) 2 SCC 521');
  assert.equal(repairOcrCitations('(2007) 2 SCC l'), '(2007) 2 SCC 1');
  assert.equal(repairOcrCitations('AIR [1967] SC 1269'), 'AIR 1967 SC 1269');
  assert.equal(repairOcrCitations('[1978] 2 SCR 621'), '[1978] 2 SCR 621', 'a sound citation is untouched');

  const bodies = ['Hearing the accused on sentence.', 'There is no sentencing policy.', 'A retrial was ordered.', 'The appeal is dismissed.'];
  const pages = bodies.map((body, n) => `[2024] 5 S.C.R. ${629 + n}\nSunita Devi v. The State of Bihar & Anr.\n${body}\n${n + 1}`);
  const stripped = stripRunningHeads(pages);
  assert.ok(stripped.every((page) => !/S\.C\.R\.|Sunita Devi/.test(page)), 'the citation head and the case-name head are gone');
  assert.deepEqual(stripped, bodies, 'and so are the page numbers; the text stays');
});

const MODERN_REPORT = [
  `[2024] 5 S.C.R. 629 : 2024 INSC 448
Sunita Devi
v.
The State of Bihar & Anr.
Headnotes
Sentencing – Constitution of India – Articles 14, 21:
Held: ...
Case Law Cited
Mohd. Hussain v. State (Govt. of NCT of Delhi) [2012] 10 SCR
480 : (2012) 9 SCC 408; Kewal Krishan v. Suraj Bhan 1980 (Supp.) SCC
499; Swamy Shraddananda (2) v. State of Karnataka [2008] 11 SCR
93 : (2008) 13 SCC 767 – referred to.
Munna Pandey v. State of Bihar [2023] 11 SCR 1005 : AIR 2023
SUPREME COURT 5709; Sakshi v. Union of India [2004]
2 Suppl. SCR 723 : (2004) 5 SCC 518 – held inapplicable.
ADM Jabalpur v. Shivakant Shukla (1976) 2 SCC 521 : [1976] Supp. SCR 172 – overruled.
List of Acts
Code of Criminal Procedure, 1973.`,
  `JUDGMENT
In Mohd. Hussain v. State (Govt. of NCT of Delhi), (2012) 9 SCC 408, this Court held that a retrial is the exception. Learned counsel relied on Sakshi v. Union of India (2004) 5 SCC 518. The procedure under Article 21 must be fair, and Article 137 of the Limitation Act does not apply; see also Articles 14, 19 and 21.`,
];

test('modern reports: the "Case Law Cited" list, its treatment labels, parallel citations, names and body contexts', () => {
  const { references, articles } = analyseJudgment(MODERN_REPORT, { knownArticles: new Set(['Art.14', 'Art.19', 'Art.21', 'Art.137']) });
  const listed = references.filter((reference) => reference.inReferenceList);
  const summary = (reference) => [reference.citations.map((citation) => citation.normalized).join(' : '), reference.treatment];
  assert.deepEqual(listed.map(summary), [
    ['[2012] 10 SCR 480 : (2012) 9 SCC 408', 'referred to'],
    ['[2008] 11 SCR 93 : (2008) 13 SCC 767', 'referred to'],
    ['[2023] 11 SCR 1005 : AIR 2023 SC 5709', 'held inapplicable'],
    ['[2004] Supp. 2 SCR 723 : (2004) 5 SCC 518', 'held inapplicable'],
    ['(1976) 2 SCC 521 : [1976] Supp. SCR 172', 'overruled'],
  ], 'one label covers the whole list it ends, across an unparsed citation ("1980 (Supp.) SCC 499")');
  assert.equal(listed.find((reference) => reference.treatment === 'overruled').category, 'overruled');
  assert.match(listed[1].name, /^Swamy Shraddananda \(2\) v\. State of Karnataka/);

  const [self, ...body] = references.filter((reference) => !reference.inReferenceList);
  assert.deepEqual(self.citations.map((citation) => citation.normalized), ['[2024] 5 SCR 629', '2024 INSC 448'],
    'the report\'s own citation is read too (the graph drops it as a self-citation)');
  assert.equal(body.length, 2);
  assert.match(body[0].context, /^In Mohd\. Hussain v\. State .* this Court held that a retrial is the exception\.$/);
  assert.equal(body[0].argument, false);
  assert.equal(body[1].argument, true, 'counsel\'s argument is told apart from the Court\'s own words');
  assert.equal(body[0].page, 2);

  assert.equal(articles.get('Art.21'), 3);
  assert.equal(articles.get('Art.14'), 2);
  assert.equal(articles.get('Art.19'), 1);
  assert.equal(articles.has('Art.137'), false, '"Article 137 of the Limitation Act" is not the Constitution');
});

test('a footnote citation never takes a label, and no label is read across a page break', () => {
  const { references } = analyseJudgment([
    'The decision in Sree Balaji Nagar cannot be said to be good law and is\n19 [2000] Supp. 1 SCR 538 : (2000) 6 SCC 359',
    'overruled. The appeal is dismissed.',
  ]);
  assert.equal(references.length, 1);
  assert.equal(references[0].treatment, null, 'Kunhayammed (a footnote) was not "overruled" by BSK Realtors');
  const named = analyseJudgment(['A. K. Gopalan v. State of Madras, [1950] SCR 88', 'referred to. Next page.']);
  assert.equal(named.references[0].treatment, null, 'not even for a named case across the page break');
  const footnote = analyseJudgment(['and is also\n19 [2000] Supp. 1 SCR 538 : (2000) 6 SCC 359 overruled. Next.']);
  assert.equal(footnote.references[0].treatment, null, 'a footnote on the same page is no list entry either');
  const short = analyseJudgment(['[752 C-D] D Kharak Singh [1964] 1 SCR 332 relied on; Bank Nationalisation [1970] 3 SCR 530 and Bennet Coleman [1973] 2 SCR 757 distinguished.']);
  assert.deepEqual(short.references.map((reference) => reference.treatment), ['relied on', 'distinguished', 'distinguished'],
    'old lists name cases briefly, without "v."');
});

test('older reports: labels after the list ("relied on."), OCR\'d citations, and the 2010s "Para" table', () => {
  const old = analyseJudgment([`personal liberty. [643 G] Satwant Singh Sawhney v. D. Ramarathnam, [19671 3 SCR .525 and Kharak SinRh v. State of U.P. & Ors. [1964] 1 SCR 332 relied on. 2. Article 21 though framed as a shield. [644 B} A. K. Gopalan v. State of Madras, [1950] SCR 88 and Additional District Magistrate, Jabalpur v. S. S. Shukla [1976] Suppl. SCR 172 @ 327 referred to. The view that Articles 19 and 21 are watertight compartments was overruled by a majority of the Court in R. C. Cooper's case.`]);
  assert.deepEqual(old.references.map((reference) => [reference.citations[0].normalized, reference.treatment]), [
    ['[1967] 3 SCR 525', 'relied on'],
    ['[1964] 1 SCR 332', 'relied on'],
    ['[1950] SCR 88', 'referred to'],
    ['[1976] Supp. SCR 172', 'referred to'],
  ], 'the "[644 B]" margin reference ends the first list; prose about overruling is not a label');

  const table = analyseJudgment([`Case Law Reference:
(2002) 8 SCC 237 relied on Para 19
(1965) 1 SCR 413 explained Para 29
[1955] 1 SCR 613 referred to
c
Para 112
CIVIL APPELLATE JURISDICTION : Civil Appeal No. 1 of 2010.
The appeal was heard. In Maneka Gandhi v. Union of India (1978) 1 SCC 248 this Court held that the procedure must be fair.`]);
  assert.deepEqual(table.references.map((reference) => [reference.citations[0].normalized, reference.treatment, reference.inReferenceList]), [
    ['(2002) 8 SCC 237', 'relied on', true],
    ['[1965] 1 SCR 413', 'explained', true],
    ['[1955] 1 SCR 613', 'referred to', true],
    ['(1978) 1 SCC 248', null, false],
  ]);
  assert.equal(table.references[3].name, 'Maneka Gandhi v. Union of India');
  assert.equal(articleMentions('Article 6 of the European Convention; Art. 21; article 19(1)(a) and 21').get('Art.21'), 2);
});

// ------------------------------------------------------------------ resolving the graph

const library = () => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct(CONSTITUTION_ACT);
  for (const [label, heading] of [['Art.21', 'Protection of life and personal liberty.'], ['Art.68', 'Time of holding election to fill vacancy in the office of Vice-President.']]) {
    const provisionId = store.upsertProvision({ actId, label, heading, context: { part: 'PART V', group: 'G' } });
    store.addProvisionVersion({ provisionId, text: heading, validFrom: '1950-01-26', sourceUrl: 'https://legislative.gov.in/coi.pdf', sourceSha256: 'coi' });
  }
  const add = (key, title, decidedOn, bench, provisions = [], insc = null) => {
    const id = store.upsertScCase({
      key, title, decidedOn, benchStrength: bench, sourceUrl: `https://x/${key}.json`, pdfUrl: `https://x/${key}_EN.pdf`,
      headnote: 'Constitution of India', provisions: provisions.map((label) => ({ label, group: 0 })),
    });
    if (insc) store.addCitationAlias(id, { scheme: 'INSC', normalized: insc });
    return id;
  };
  const ids = {
    gopalan: add('1950_1_88_334', 'A.K. GOPALAN versus THE STATE OF MADRAS.', '1950-05-19', 6, ['Art.21']),
    adm: add('S_1976_1_172_477', 'ADDITIONAL DISTRICT MAGISTRATE, JABALPUR versus S. S. SHUKLA ETC. ETC.', '1976-04-28', 5, ['Art.21']),
    maneka: add('1978_2_621_776', 'MANEKA GANDHI versus UNION OF INDIA', '1978-01-25', 7, ['Art.21']),
    joginder: add('1994_3_92_99', 'JOGINDER KUMAR versus STATE OF U.P. AND OTHERS', '1994-04-25', 3),
    small: add('2010_1_1_9', 'SMALL BENCH versus ANYONE', '2010-01-01', 2),
    putt: add('2017_10_569_999', 'JUSTICE K S PUTTASWAMY (RETD.), AND ANR. versus UNION OF INDIA AND ORS.', '2017-08-24', 9, ['Art.21'], '2017 INSC 801'),
    later: add('2024_5_629_729', 'SUNITA DEVI versus THE STATE OF BIHAR & ANR.', '2024-05-17', 2),
  };
  return { store, ids };
};

const reference = (citing, citations, extra = {}) => ({
  citations: citations.map(([scheme, normalized, year]) => ({ scheme, normalized, year })),
  name: null, page: 3, inReferenceList: false, treatment: null, category: null, context: null, argument: false, ...extra,
});
const save = (store, caseId, references, articles = new Map()) => store.saveJudgmentText({
  caseId, pdfSha256: `sha-${caseId}`, pages: 5, chars: 1000, citations: references.length, references, articles,
});

test('the graph resolves official, volume-less, learned (parallel) and name citations, and drops self and later citations', () => {
  const { store, ids } = library();
  try {
    // Puttaswamy's list pairs ADM Jabalpur's SCC citation with its official SCR one, and overrules it.
    save(store, ids.putt, [
      reference(ids.putt, [['SCC', '(1976) 2 SCC 521', 1976], ['SCR', '[1976] Supp. SCR 172', 1976]], { inReferenceList: true, treatment: 'overruled', category: 'overruled', page: 21 }),
      reference(ids.putt, [['SCR', '[1978] 2 SCR 621', 1978], ['SCC', '(1978) 1 SCC 248', 1978]], { inReferenceList: true, treatment: 'relied on', category: 'followed' }),
      reference(ids.putt, [['SCR', '[1950] SCR 88', 1950]], { inReferenceList: true, treatment: 'referred to', category: 'referred' }),
      reference(ids.putt, [['INSC', '2017 INSC 801', 2017]]),
    ]);
    // A later judgment cites Maneka only by SCC (learned above), Joginder Kumar only by name, and a "later" case.
    save(store, ids.later, [
      reference(ids.later, [['SCC', '(1978) 1 SCC 248', 1978]], { context: 'In Maneka Gandhi this Court held that procedure must be fair.', page: 14 }),
      reference(ids.later, [['SCC', '(1994) 4 SCC 260', 1994]], { name: 'Similarly, in Joginder Kumar v. State of U.P.', context: 'Joginder Kumar on arrest.' }),
      reference(ids.later, [['SCC', '(2030) 1 SCC 1', 2030]], { name: 'Nobody v. Nothing' }),
    ]);
    // A foreign report with an Indian-looking citation: "Lavigne v. Canada, (2002) 2 SCR 773" is the Canadian SCR.
    save(store, ids.later, [
      ...store.citationGraphInputs().references.filter((row) => row.citing_id === ids.later).map((row) => reference(ids.later,
        row.citations.map((citation) => [citation.scheme, citation.normalized, citation.year]), { name: row.name, context: row.context, page: row.page })),
      reference(ids.later, [['SCR', '[1978] 2 SCR 621', 1978]], { name: 'Lavigne v. Canada (Office of the Commissioner)' }),
    ]);
    // A two-judge bench "overruling" a seven-judge bench is recorded but sets no status.
    save(store, ids.small, [
      reference(ids.small, [['SCR', '[1978] 2 SCR 621', 1978]], { inReferenceList: true, treatment: 'overruled', category: 'overruled' }),
    ]);

    const stats = rebuildCitationGraph(store);
    assert.equal(stats.self, 1, 'Puttaswamy citing its own neutral citation');
    assert.equal(stats.byName, 1);
    assert.equal(stats.byLearned, 1);
    assert.equal(stats.unresolved, 1);
    assert.equal(stats.nameMismatch, 1, 'the Canadian report is not taken for Maneka Gandhi');

    assert.equal(store.getCase(ids.adm).status, 'overruled', '9-judge Puttaswamy overrules 5-judge ADM Jabalpur');
    assert.equal(store.getCase(ids.maneka).status, 'unknown', 'a 2-judge bench cannot overrule a 7-judge bench');
    assert.ok(store.findCaseByCitation({ scheme: 'SCR', normalized: '[1976] Supp. 1 SCR 172' }), 'key-derived SCR alias stored');

    const maneka = store.citedBy(ids.maneka);
    assert.deepEqual(maneka.map((row) => [row.citing_id, row.method]), [[ids.later, 'learned'], [ids.putt, 'alias'], [ids.small, 'alias']],
      'newest citing judgment first');
    assert.equal(maneka[0].context, 'In Maneka Gandhi this Court held that procedure must be fair.');
    assert.deepEqual(store.citedBy(ids.gopalan).map((row) => row.citing_id), [ids.putt], '"[1950] SCR 88" is the record\'s "[1950] 1 SCR 88"');
    assert.deepEqual(store.citedBy(ids.joginder).map((row) => [row.citing_id, row.method]), [[ids.later, 'name']]);
    assert.equal(store.citedBy(ids.adm)[0].ref_page, 21, 'the page where the reporter printed "overruled"');

    // Rebuilding is idempotent.
    rebuildCitationGraph(store);
    assert.equal(store.textIndexStats().edges, 6);
  } finally {
    store.close();
  }
});

test('name matching refuses ambiguous or generic names and checks the year', () => {
  const cases = [
    { id: 1, source_key: '1994_3_92_99', title: 'JOGINDER KUMAR versus STATE OF U.P.', decided_on: '1994-04-25', bench_strength: 3 },
    { id: 2, source_key: '1994_3_100_110', title: 'STATE OF U.P. versus RAM SINGH', decided_on: '1994-05-01', bench_strength: 2 },
    { id: 3, source_key: '1994_3_111_120', title: 'STATE OF U.P. versus SHYAM SINGH', decided_on: '1994-06-01', bench_strength: 2 },
  ];
  const resolve = (name, year) => resolveCitationGraph({
    cases, aliases: [],
    references: [{ citing_id: 99, ref_key: 'k', citations: [{ scheme: 'SCC', normalized: '(x) 1 SCC 1', year }], name, page: 1, in_list: 0, treatment: null, category: null, mentions: 1, context: null, context_page: null }],
  }).stats;
  assert.equal(resolve('Joginder Kumar v. State of U.P.', 1994).byName, 1);
  assert.equal(resolve('Joginder Kumar v. State of U.P.', 1995).byName, 1, 'reported the year after the decision');
  assert.equal(resolve('Joginder Kumar v. State of U.P.', 1997).byName, 0, 'wrong year');
  assert.equal(resolve('State of U.P. v. Singh', 1994).byName, 0, 'two judgments fit equally');
  assert.equal(resolve('State v. Union of India', 1994).byName, 0, 'nothing distinctive in the name');
});

test('points add a banded citation component; text-only links add mention points; the service shows treatments and contexts', () => {
  assert.deepEqual([0, 1, 2, 5, 10, 20, 50, 400].map(citationPoints), [0, 5, 10, 16, 24, 32, 40, 40]);
  assert.deepEqual(scoreCase({ bench_strength: 5, position: 0, cited_by: 12, mentions: 40 }, 'Art.21').breakdown.map((item) => item.points), [40, 30, 24]);

  const { store, ids } = library();
  try {
    save(store, ids.putt, [
      reference(ids.putt, [['SCR', '[1976] Supp. SCR 172', 1976]], { inReferenceList: true, treatment: 'overruled', category: 'overruled', page: 21 }),
      reference(ids.putt, [['SCR', '[1978] 2 SCR 621', 1978]], { context: 'Maneka Gandhi requires a fair, just and reasonable procedure.', page: 40 }),
    ]);
    save(store, ids.joginder, [reference(ids.joginder, [['SCR', '[1978] 2 SCR 621', 1978]])], new Map([['Art.68', 4]]));
    rebuildCitationGraph(store);

    const result = casesForProvision(store, { provision: '21' });
    const maneka = result.cases.find((card) => card.id === ids.maneka);
    assert.equal(maneka.citedBy.count, 2);
    assert.deepEqual(maneka.citedBy.contexts.map((item) => [item.id, item.page]), [[ids.putt, 40]]);
    assert.ok(maneka.breakdown.some((item) => item.reason === 'Cited in 2 later judgments in the full-text index'));
    const adm = result.cases.find((card) => card.id === ids.adm);
    assert.equal(adm.status, 'overruled');
    assert.deepEqual(adm.citedBy.treatments.map((item) => [item.id, item.treatment, item.page, item.binding]), [[ids.putt, 'Overruled', 21, true]]);
    assert.equal(result.library.textIndex.judgments, 2);

    const discussed = casesForProvision(store, { provision: '68' });
    assert.equal(discussed.relation, 'text', 'no headnote names Art. 68, but a judgment\'s text discusses it');
    assert.deepEqual(discussed.cases.map((card) => [card.id, card.mentions]), [[ids.joginder, 4]]);
    assert.ok(discussed.cases[0].breakdown.some((item) => /named 4 times in the judgment's text/.test(item.reason)));
  } finally {
    store.close();
  }
});

test('GET /lawbuddy/api/cases/:id/cited-by lists every citing judgment with its treatment', async () => {
  const { store, ids } = library();
  try {
    save(store, ids.putt, [
      reference(ids.putt, [['SCR', '[1976] Supp. SCR 172', 1976]], { inReferenceList: true, treatment: 'overruled', category: 'overruled', page: 21 }),
    ]);
    rebuildCitationGraph(store);
    const call = async (url) => {
      let sent = null;
      const parsedUrl = new URL(`http://localhost${url}`);
      await handleLawBuddyApiRoute({ method: 'GET', resume: () => {} }, {}, {
        pathname: parsedUrl.pathname, parsedUrl, legalLibrary: { get: async () => store },
        sendJson: (res, status, body) => { sent = { status, body }; },
      });
      return sent;
    };
    const listed = await call(`/lawbuddy/api/cases/${ids.adm}/cited-by`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.case.status, 'overruled');
    assert.deepEqual(listed.body.citing.map((item) => [item.id, item.treatment, item.page, item.inReporterList]), [[ids.putt, 'overruled', 21, true]]);
    assert.equal((await call('/lawbuddy/api/cases/999999/cited-by')).status, 404);
    assert.equal(citingJudgments(store, ids.gopalan).total, 0);
  } finally {
    store.close();
  }
});

test('saveJudgmentText merges repeated citations: weightiest label, Court\'s words over counsel\'s', () => {
  const { store, ids } = library();
  try {
    save(store, ids.later, [
      reference(ids.later, [['SCR', '[1978] 2 SCR 621', 1978]], { context: 'Counsel relied on Maneka.', argument: true, page: 4 }),
      reference(ids.later, [['SCR', '[1978] 2 SCR 621', 1978], ['SCC', '(1978) 1 SCC 248', 1978]], { inReferenceList: true, treatment: 'distinguished', category: 'distinguished', context: null }),
      reference(ids.later, [['SCR', '[1978] 2 SCR 621', 1978]], { context: 'We hold, following Maneka, that the procedure fails.', page: 9 }),
      reference(ids.later, [['SCR', '[1978] 2 SCR 621', 1978]], { inReferenceList: true, treatment: 'referred to', category: 'referred' }),
    ]);
    const [row] = store.citationGraphInputs().references;
    assert.equal(row.mentions, 4);
    assert.equal(row.treatment, 'distinguished');
    assert.equal(row.in_list, 1);
    assert.equal(row.context, 'We hold, following Maneka, that the procedure fails.');
    assert.equal(row.context_page, 9);
    assert.deepEqual(row.citations.map((citation) => citation.normalized), ['[1978] 2 SCR 621', '(1978) 1 SCC 248']);
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ indexing pipeline

test('indexScTextYear maps archive files to judgments, skips unchanged files and years, and counts failures', async () => {
  const { store, ids } = library();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-text-'));
  try {
    const indexPath = path.join(dir, 'index.json');
    await writeFile(indexPath, JSON.stringify({ year: 2017, file_count: 3 }));
    let indexSha = 'index-v1';
    const fetcher = {
      fetchDocument: async (url) => {
        assert.equal(url, scTextIndexUrl(2017));
        return { ok: true, sha256: indexSha, rawPath: indexPath };
      },
      streamDocument: async (url, consume) => {
        assert.equal(url, scTextArchiveUrl(2017));
        const result = await consume(Readable.from([]));
        return { ok: true, sha256: 'archive', byteLength: 10, result };
      },
    };
    const records = [
      { name: '2017_10_569_999_EN.pdf', sha256: 'p1', pages: ['Case Law Cited\nADM Jabalpur v. S. S. Shukla [1976] Supp. SCR 172 – overruled.\nList of Acts'] },
      { name: '2099_1_1_2_EN.pdf', sha256: 'p2', pages: ['unknown judgment'] },
      { name: '1978_2_621_776_EN.pdf', sha256: 'p3', error: 'PdfiumError: Failed to load document' },
    ];
    const runWorker = async ({ onRecord }) => records.forEach(onRecord);
    const knownArticles = new Set(['Art.21']);

    const first = await indexScTextYear({ store, fetcher, year: 2017, knownArticles, runWorker });
    assert.deepEqual({ ...first, year: undefined }, {
      year: undefined, ok: true, skipped: false, files: 3, indexed: 1, unchanged: 0, unmatched: 1, failed: 1, attempts: 1, bytes: 10,
    });
    assert.equal(store.getCaseText(ids.putt).pdf_sha256, 'p1');
    assert.equal((await indexScTextYear({ store, fetcher, year: 2017, knownArticles, runWorker })).skipped, true);
    indexSha = 'index-v2';
    const again = await indexScTextYear({ store, fetcher, year: 2017, knownArticles, runWorker });
    assert.equal(again.unchanged, 1, 'an unchanged PDF is not re-read');
    assert.equal(sourceKeyOf('data/2024_5_629_729_EN.pdf'), '2024_5_629_729');

    rebuildCitationGraph(store);
    assert.equal(store.getCase(ids.adm).status, 'overruled');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dropped archive stream is retried, keeping what was indexed; an older reader\'s judgments are re-read', async () => {
  const { store, ids } = library();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-text-'));
  try {
    const indexPath = path.join(dir, 'index.json');
    await writeFile(indexPath, JSON.stringify({ year: 2017, file_count: 2 }));
    const records = [
      { name: '2017_10_569_999_EN.pdf', sha256: 'p1', pages: ['In Maneka Gandhi v. Union of India (1978) 1 SCC 248 this Court held so.'] },
      { name: '2024_5_629_729_EN.pdf', sha256: 'p2', pages: ['Nothing cited here.'] },
    ];
    let calls = 0;
    const fetcher = {
      fetchDocument: async () => ({ ok: true, sha256: 'index', rawPath: indexPath }),
      streamDocument: async (url, consume) => {
        calls += 1;
        if (calls === 1) {
          await consume({ records: records.slice(0, 1) });
          return { ok: false, error: 'terminated' };
        }
        await consume({ records });
        return { ok: true, sha256: 'archive', byteLength: 20 };
      },
    };
    const runWorker = async ({ input, onRecord }) => input.records.forEach(onRecord);
    const result = await indexScTextYear({ store, fetcher, year: 2017, knownArticles: new Set(), runWorker });
    assert.deepEqual([result.ok, result.attempts, result.indexed, result.unchanged], [true, 2, 2, 0],
      'the judgment indexed before the drop is not counted twice');

    // A judgment indexed by an older reader is re-read even though its PDF is unchanged.
    store.saveJudgmentText({ caseId: ids.putt, pdfSha256: 'p1', pages: 1, chars: 1, citations: 0, references: [], articles: new Map(), parserVersion: 1 });
    store.saveScTextImport({ year: 2017, indexSha256: 'index', files: 2, indexed: 2, unmatched: 0, failed: 0, parserVersion: 1 });
    const again = await indexScTextYear({ store, fetcher, year: 2017, knownArticles: new Set(), runWorker });
    assert.deepEqual([again.skipped, again.indexed, again.unchanged], [false, 1, 1]);
    assert.equal((await indexScTextYear({ store, fetcher, year: 2017, knownArticles: new Set(), runWorker })).skipped, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streamDocument streams through without storing, records sha256 and size, and reports a stream cut short', async () => {
  const store = openLegalStore(':memory:');
  try {
    const body = Buffer.from('x'.repeat(5000));
    let cut = false;
    const fetchImpl = async (url) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private/', { status: 200 });
      const chunks = cut ? [body.subarray(0, 100)] : [body.subarray(0, 2000), body.subarray(2000)];
      return new Response(Readable.toWeb(Readable.from(chunks)), { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const sources = [{ id: 'aws-sc-judgments', name: 'SC', tier: 1, baseUrl: 'https://example.test', hosts: ['example.test'] }];
    const fetcher = createPoliteFetcher({ store, sources, fetchImpl, minIntervalMs: 0, vaultDir: '/nonexistent', sleep: async () => {} });
    const drain = async (stream) => {
      let total = 0;
      for await (const chunk of stream) total += chunk.length;
      return total;
    };

    const ok = await fetcher.streamDocument('https://example.test/a.tar', drain);
    assert.equal(ok.ok, true);
    assert.equal(ok.result, 5000);
    assert.equal(ok.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(store.lastSuccessfulFetch('https://example.test/a.tar'), null, 'nothing stored, so no conditional GET later');

    assert.match((await fetcher.streamDocument('https://example.test/private/b.tar', drain)).error, /robots/);
    cut = true;
    assert.match((await fetcher.streamDocument('https://example.test/a.tar', drain)).error, /stream ended after 100 bytes of 5000/);
    await assert.rejects(() => fetcher.streamDocument('https://elsewhere.test/a.tar', drain), /not a registered legal source/);
  } finally {
    store.close();
  }
});

const workerInstalled = existsSync(config.LEGAL_PYTHON);

test('the pdfium worker reads a streamed tar of judgments and reports a broken PDF without stopping', {
  skip: workerInstalled ? false : 'PDF worker venv not installed',
}, async () => {
  const pdf = buildPdf([[{ text: 'ADM Jabalpur v. S. S. Shukla [1976] Supp. SCR 172 - overruled.', size: 10, x: 72, y: 700 }]]);
  const entry = (name, data) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  };
  const archive = Buffer.concat([
    entry('2017_10_569_999_EN.pdf', pdf),
    entry('._2017_10_569_999_EN.pdf', Buffer.from('mac metadata')),
    entry('broken_EN.pdf', Buffer.from('not a pdf')),
    Buffer.alloc(10240),
  ]);
  const records = [];
  await runTextWorker({ input: Readable.from([archive]), onRecord: (record) => records.push(record) });
  assert.deepEqual(records.map((record) => record.name), ['2017_10_569_999_EN.pdf', 'broken_EN.pdf']);
  assert.match(records[0].pages[0], /\[1976\] Supp\. SCR 172 - overruled\./);
  assert.equal(records[0].sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.match(records[1].error, /PdfiumError/);
});

test('briefs read first the passages later judgments quote (citation-guided selection)', () => {
  const filler = (n) => Array.from({ length: 105 }, (_, i) => `word${n}x${i}`).join(' ');
  const opinion = (role) => ({ role, name: role === 'leading' ? 'Bhagwati J' : 'Kailasam J' });
  const passages = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i + 2}.1`, page: i + 2, line: 0, text: filler(i), opinion: opinion('leading') })),
    { id: 'p40.1', page: 40, line: 0, opinion: opinion('leading'), text: 'The procedure prescribed by law has to be fair, just and reasonable, not fanciful, oppressive or arbitrary.' },
    { id: 'p41.1', page: 41, line: 0, opinion: opinion('dissenting'), text: 'The procedure prescribed by law has to be fair, just and reasonable in the view of the majority.' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i + 50}.1`, page: i + 50, line: 0, text: filler(i + 40), opinion: opinion('leading') })),
  ];
  const quotes = quotedByLaterJudgments([
    'Maneka Gandhi v. Union of India, (1978) 1 SCC 248 “The procedure prescribed by law has to be fair, just and reasonable, not fanciful, oppressive or arbitrary.”',
    null,
  ]);
  assert.deepEqual(quotes, ['The procedure prescribed by law has to be fair, just and reasonable, not fanciful, oppressive or arbitrary.']);
  const scores = quotedPassageScores(passages, quotes);
  assert.ok(scores[30] > scores[31] && scores[31] > 0, 'the leading passage matches best; the dissent shares a phrase');

  const without = selectPassages(passages, 'Art.21').map((passage) => passage.id);
  assert.equal(without.includes('p40.1'), false, 'mid-opinion, the ratio is beyond the word budget unaided');
  const guided = selectPassages(passages, 'Art.21', { quotes });
  const quoted = guided.filter((passage) => passage.quotedLater).map((passage) => passage.id);
  assert.deepEqual(quoted, ['p40.1', 'p41.1'], 'the quoted passages are read, the leading opinion first');
  assert.ok(guided.reduce((sum, passage) => sum + passage.text.split(/\s+/).length, 0) <= 2900, 'within the same word budget');
});
