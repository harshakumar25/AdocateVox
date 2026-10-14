import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegalStore } from '../src/store/db.js';
import { readTar } from '../src/parse/tar.js';
import { constitutionArticleGroups, parseScMetadata } from '../src/parse/scMetadata.js';
import { syncScYear, scPdfUrl } from '../src/sources/scOpenData.js';
import { benchPoints, catchwordPoints, rankCases, scoreCase } from '../src/cases/rank.js';
import { casesForProvision, referencedArticles } from '../src/cases/service.js';
import { matchCoram, opinionOnPage, parseOpinions } from '../src/cases/opinions.js';
import {
  locateQuote, pointMatchesQuote, pointNamesRightJudge, prepareCaseBrief, selectPassages, toPassages, verifyBrief,
} from '../src/cases/brief.js';
import { groqJson } from '../src/enrich/groq.js';
import { handleLawBuddyApiRoute, LAWBUDDY_FILES } from '../src/routes.js';
import { CONSTITUTION_ACT } from '../src/ingest/constitution.js';

// ------------------------------------------------------------------ tar

const tarEntry = (name, data, type = '0') => {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(body);
  return Buffer.concat([header, body]);
};
const tarOf = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

test('readTar returns regular files, honours pax long names, skips directories and rejects truncation', () => {
  const longName = `metadata/${'x'.repeat(120)}.json`;
  const pax = Buffer.from(`${(`path=${longName}\n`.length + 4).toString()} path=${longName}\n`);
  const archive = tarOf(
    tarEntry('metadata/', Buffer.alloc(0), '5'),
    tarEntry('metadata/a.json', Buffer.from('{"a":1}')),
    tarEntry('PaxHeader', pax, 'x'),
    tarEntry('ignored-short-name', Buffer.from('{"b":2}')),
  );
  const files = readTar(archive);
  assert.deepEqual(files.map((file) => file.name), ['metadata/a.json', longName]);
  assert.equal(files[1].data.toString(), '{"b":2}');
  assert.throws(() => readTar(archive.subarray(0, 700)), /ends inside an entry header/);
  assert.throws(() => readTar(archive.subarray(0, 1024 + 3)), /runs past the end/);
});

// ------------------------------------------------------------------ metadata

const row = ({ title = 'MANEKA GANDHI<span class=\'fst-italic\'> versus </span>UNION OF INDIA', scr = '[1978] 2 S.C.R. 621',
  neutral = '1978 INSC 16', headnote = 'Constitution of India Articles 14, 19 (1) (a) and 21-Personal liberty', bench = '7 Judges' } = {}) =>
  `<button aria-label=" x pdf"><font size='4'> <strong>${title} </strong>- <span class='escrText'>${scr}</span>`
  + `<span class='ncDisplay'>${neutral}</span><input type='hidden' id='cnr' value=ESCR010000011978></button></font>`
  + `<br><strong>Coram : M. HAMEEDULLAH BEG, P.N. BHAGWATI<sup data-tooltip="Author">*</sup></strong><br> ${headnote}`
  + `<br><strong class='caseDetailsTD' ><span style='color:#212F3D' > Decision Date :</span><font color='green'> 25-01-1978</font>`
  + `<span> | Case No :</span><font color='green'> WRIT PETITION No. 231/1977</font>`
  + `<span> | Disposal Nature :</span><font color='green'> Disposed off</font>`
  + `<span> | Bench :</span><font color='green'> ${bench}</font></strong>`;

test('parseScMetadata reads the Court\'s listing row: title, citations, coram and author, dates, bench, headnote', () => {
  const parsed = parseScMetadata({ raw_html: row(), path: '1978_2_621_776' });
  assert.equal(parsed.title, 'MANEKA GANDHI versus UNION OF INDIA');
  assert.equal(parsed.scr, '[1978] 2 S.C.R. 621');
  assert.equal(parsed.neutral, '1978 INSC 16');
  assert.equal(parsed.cnr, 'ESCR010000011978');
  assert.deepEqual(parsed.coram, ['M. HAMEEDULLAH BEG', 'P.N. BHAGWATI']);
  assert.equal(parsed.author, 'P.N. BHAGWATI');
  assert.equal(parsed.decidedOn, '1978-01-25');
  assert.equal(parsed.benchStrength, 7);
  assert.equal(parsed.caseNo, 'WRIT PETITION No. 231/1977');
  assert.deepEqual(parsed.articles, [{ label: 'Art.14', group: 0 }, { label: 'Art.19', group: 0 }, { label: 'Art.21', group: 0 }]);
  assert.equal(parseScMetadata({ raw_html: '<div>no case here</div>', path: 'x' }), null);
});

test('headnote catchwords: Constitution context only, OCR-tolerant, amendment Acts count, groups ordered', () => {
  const cases = [
    ['Comtitution of India, 1950-Articles 14 & 16-Equality', [['Art.14', 0], ['Art.16', 0]]],
    ['Constitution of India - A11.21 - Right to privacy', [['Art.21', 0]]],
    ['Constitution of India, 1950 : Article · 32 - Fundamental Rights - Article 21', [['Art.32', 0], ['Art.21', 1]]],
    ['Limitation Act, 1963-Art. 137-Constitution of India Art. 226', [['Art.226', 0]]],
    ['Constitution (Forty-second Amendment) Act, 1976, s. 4-Art. 31C', [['Art.31C', 0]]],
    ['Mysore Civil Service Regulations of Art. 294', []],
    ['All the accused - Constitution of India: A11 32 was', []],
  ];
  for (const [headnote, expected] of cases) {
    assert.deepEqual(constitutionArticleGroups(headnote).map(({ label, group }) => [label, group]), expected, headnote);
  }
});

// ------------------------------------------------------------------ import

const constitutionLibrary = () => {
  const store = openLegalStore(':memory:');
  store.registerSource({ id: 'aws-sc-judgments', name: 'SC', tier: 1, baseUrl: 'https://indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com' });
  const actId = store.upsertAct(CONSTITUTION_ACT);
  const provisions = [
    ['Art.66', 'Election of Vice-President.', 'The Vice-President shall be elected by the members of an electoral college.', { part: 'PART V', group: 'The President and Vice-President' }],
    ['Art.67', 'Term of office of Vice-President.', 'The Vice-President shall hold office for a term of five years.', { part: 'PART V', group: 'The President and Vice-President' }],
    ['Art.68', 'Time of holding election to fill vacancy in the office of Vice-President and the term of office of person elected to fill casual vacancy.',
      'An election to fill a vacancy ... subject to the provisions of article 67, be entitled to hold office for the full term of five years.', { part: 'PART V', group: 'The President and Vice-President' }],
    ['Art.72', 'Power of President to grant pardons, etc.', 'The President shall have the power to grant pardons.', { part: 'PART V', group: 'The President and Vice-President' }],
    ['Art.21', 'Protection of life and personal liberty.', 'No person shall be deprived of his life or personal liberty except according to procedure established by law.', { part: 'PART III', group: 'Right to Freedom' }],
    ['Art.14', 'Equality before law.', 'The State shall not deny to any person equality before the law.', { part: 'PART III', group: 'Right to Equality' }],
  ];
  for (const [label, heading, text, context] of provisions) {
    const provisionId = store.upsertProvision({ actId, label, heading, context });
    store.addProvisionVersion({ provisionId, text, validFrom: '1950-01-26', sourceUrl: 'https://legislative.gov.in/coi.pdf', sourceSha256: 'coi' });
  }
  return store;
};

test('syncScYear stores judgments with citation aliases and Article links, skips an unchanged archive, and re-parses on force', async () => {
  const store = constitutionLibrary();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-sc-'));
  try {
    const records = [
      { raw_html: row(), path: '1978_2_621_776' },
      { raw_html: row({ title: 'A versus B', scr: '[1973] Supp. S.C.R. 1', neutral: '1973 INSC 91', headnote: 'Constitution of India-Art. 368 and Art. 999', bench: '13 Judges' }), path: '1973_supp_1' },
      { raw_html: row({ title: 'C versus D', scr: '[1978] 2 S.C.R. 621', neutral: '1978 INSC 999', headnote: 'Income-tax Act, 1961-s. 4' }), path: 'dup' },
      { raw_html: '<p>garbage</p>', path: 'bad' },
    ];
    const tarPath = path.join(dir, 'metadata.tar');
    await writeFile(tarPath, tarOf(...records.map((record) => tarEntry(`metadata/${record.path}.json`, Buffer.from(JSON.stringify(record))))));
    let sha = 'archive-v1';
    const fetcher = { fetchDocument: async () => ({ ok: true, sha256: sha, rawPath: tarPath }) };
    const knownArticles = new Set(['Art.14', 'Art.19', 'Art.21', 'Art.368']);

    const first = await syncScYear({ store, fetcher, year: 1978, knownArticles });
    assert.deepEqual({ ...first, year: undefined }, {
      year: undefined, ok: true, skipped: false, records: 4, cases: 3, unparsed: 1, linked: 2, aliasConflicts: 1,
    });
    const maneka = store.findCaseByCitation({ scheme: 'SCR', normalized: '[1978] 2 SCR 621' });
    assert.equal(maneka.title, 'MANEKA GANDHI versus UNION OF INDIA');
    assert.equal(maneka.pdf_url, scPdfUrl(1978, '1978_2_621_776'));
    assert.ok(store.findCaseByCitation({ scheme: 'SCR', normalized: '[1973] Supp. SCR 1' }), 'supplementary volumes resolve');
    assert.deepEqual(store.casesForProvision({ label: 'Art.368' }).map((c) => c.title), ['A versus B']);
    assert.equal(store.casesForProvision({ label: 'Art.999' }).length, 0, 'Articles not in the official text never link');

    assert.equal((await syncScYear({ store, fetcher, year: 1978, knownArticles })).skipped, true);
    sha = 'archive-v2';
    assert.equal((await syncScYear({ store, fetcher, year: 1978, knownArticles })).skipped, false, 'a changed archive is re-imported');
    assert.equal((await syncScYear({ store, fetcher, year: 1978, knownArticles, force: true })).skipped, false);
    assert.equal(store.caseStats().cases, 3, 're-imports update, never duplicate');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ points

test('precedent points come from bench strength and catchword group, with reasons; ties go to the earlier judgment', () => {
  assert.deepEqual([13, 9, 7, 6, 5, 3, 2, 1, null].map(benchPoints), [60, 50, 45, 40, 40, 20, 10, 5, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, null].map(catchwordPoints), [30, 20, 12, 12, 6, 0]);
  assert.deepEqual(scoreCase({ bench_strength: 7, position: 0 }, 'Art.21'), {
    points: 75,
    breakdown: [
      { points: 45, reason: '7-judge bench (Constitution Bench)' },
      { points: 30, reason: 'Art. 21 is the lead provision in the official headnote' },
    ],
  });
  const ranked = rankCases([
    { id: 1, bench_strength: 2, position: 0, decided_on: '2020-01-01' },
    { id: 2, bench_strength: 7, position: 0, decided_on: '2002-01-01' },
    { id: 3, bench_strength: 7, position: 0, decided_on: '1978-01-25' },
  ], 'Art.21');
  assert.deepEqual(ranked.map(({ row: r }) => r.id), [3, 2, 1]);
});

test('casesForProvision ranks direct judgments, falls back to related provisions by heading overlap, and shows only verified reviews', () => {
  const store = constitutionLibrary();
  try {
    const add = (key, title, bench, provisions, decidedOn = '1990-01-01') => store.upsertScCase({
      key, title, sourceUrl: `https://x/${key}.json`, pdfUrl: `https://x/${key}.pdf`, decidedOn, benchStrength: bench,
      coram: ['A. B. JUDGE'], headnote: 'Constitution of India', provisions: provisions.map(([label, group]) => ({ label, group })),
    });
    const maneka = add('m', 'MANEKA GANDHI versus UNION OF INDIA', 7, [['Art.14', 0], ['Art.21', 0]], '1978-01-25');
    add('s', 'SMALL versus BENCH', 2, [['Art.21', 0]]);
    add('vp', 'VP ELECTION versus X', 5, [['Art.66', 0]]);
    add('pardon', 'PARDON versus Y', 5, [['Art.72', 0]]);

    const direct = casesForProvision(store, { provision: '21' });
    assert.equal(direct.relation, 'direct');
    assert.deepEqual(direct.cases.map((card) => [card.title, card.points]), [['MANEKA GANDHI versus UNION OF INDIA', 75], ['SMALL versus BENCH', 40]]);
    assert.equal(direct.cases[0].constitutionBench, true);

    const related = casesForProvision(store, { provision: 'Art.68' });
    assert.equal(related.relation, 'related');
    assert.deepEqual(related.relatedLabels.slice(0, 2), ['Art.67', 'Art.66'], 'cross-referenced first, then the closest heading');
    assert.deepEqual(related.cases.map((card) => [card.title, card.via]), [['VP ELECTION versus X', 'Art.66'], ['PARDON versus Y', 'Art.72']]);
    assert.deepEqual(referencedArticles('subject to the provisions of article 67 and articles 71'), ['Art.67', 'Art.71']);

    assert.equal(casesForProvision(store, { provision: 'Art.999' }).status, 404);
    assert.equal(casesForProvision(store, { provision: 's.302' }).status, 400);

    store.addCaseReview({ caseId: maneka, reviewerName: 'Anon', reviewerCredential: 'unverified', rating: 1, comment: 'not shown' });
    store.addCaseReview({
      caseId: maneka, reviewerName: 'A. Advocate', reviewerCredential: 'Advocate, Delhi', rating: 5, comment: 'Clear brief.',
      verifiedBy: 'admin', verifiedAt: '2026-10-12T00:00:00Z',
    });
    const reviews = casesForProvision(store, { provision: '21' }).cases[0].reviews;
    assert.equal(reviews.count, 1);
    assert.deepEqual(reviews.items.map((item) => item.reviewer_name), ['A. Advocate']);
    assert.throws(() => store.addCaseReview({ caseId: maneka, reviewerName: ' ', reviewerCredential: 'x', rating: 3, comment: 'y' }), /reviewerName/);
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ opinions

const line = (text) => ({ text });
const REPORT = [
  { page: 1, lines: [line('BEG, C. J., (Concurring with Bhagwati, J.)'), line('KRISHNA IYER, J. (Concurring with Bhagwati, J.)'), line('Kailasam, J. (Dissenting)')] },
  { page: 2, lines: [line('BEG, C.J. The case before us involves questions relating to basic rights.')] },
  { page: 3, lines: [line('I agree with the order proposed by Brother Bhagwati.'), line('BHAGWATI, J.-The Petitioner is the holder of the passport.'), line('The procedure must be fair, just and reasonable.')] },
  { page: 4, lines: [line('KAI ASAM, J.-I regret I cannot agree with the majority.')] },
];
const CORAM = ['M. HAMEEDULLAH BEG', 'P.N. BHAGWATI', 'V.R. KRISHNA IYER', 'P.S. KAILASAM'];

test('opinions: authors found despite OCR, leading opinion is the one others concur with, dissent recognised line by line', () => {
  assert.equal(matchCoram('KAI ASAM', CORAM), 3);
  assert.equal(matchCoram('BEG', CORAM), 0);
  assert.equal(matchCoram('SOMEONE ELSE', CORAM), -1);

  const parsed = parseOpinions(REPORT, { coram: CORAM });
  assert.deepEqual(parsed.opinions.map((opinion) => [opinion.name, opinion.page, opinion.line]),
    [['Hameedullah Beg CJ', 2, 0], ['Bhagwati J', 3, 1], ['Kailasam J', 4, 0]]);
  assert.equal(parsed.leading, 'coram:1');
  assert.deepEqual(parsed.dissenting, ['coram:3']);
  assert.deepEqual(opinionOnPage(parsed, 1), { role: 'headnote', name: null });
  assert.deepEqual(opinionOnPage(parsed, 3, 0), { role: 'separate', name: 'Hameedullah Beg CJ' }, 'the line above Bhagwati J begins is still Beg CJ');
  assert.deepEqual(opinionOnPage(parsed, 3, 2), { role: 'leading', name: 'Bhagwati J' });
  assert.deepEqual(opinionOnPage(parsed, 4, 0), { role: 'dissenting', name: 'Kailasam J' });

  const single = parseOpinions([{ page: 1, lines: [line('The Judgment of the Court was delivered by MAHAJAN J.'), line('Text.')] }]);
  assert.equal(single.leading, 'mahajan');
});

test('recent reports: running heads, headings alone on a line, headnote PER summaries ignored, Order of the Court', () => {
  const coram = ['JAGDISH SINGH KHEHAR', 'D.Y. CHANDRACHUD', 'R. F. NARIMAN', 'SANJAY KISHAN KAUL'];
  const report = [
    { page: 10, lines: [line('Headnotes'), line('PER DR. D. Y. CHANDRACHUD, J.:'), line('PERR. F. NARIMAN, J.')] },
    { page: 74, lines: [line('the questions referred.'), line('DR. D. Y. CHANDRACHUD, J.'), line('1. Nine judges of this Court assembled.')] },
    { page: 75, lines: [line('JUSTICE K S PUTTASWAMY (RETD.) v. UNION OF INDIA 641'), line('[DR. D. Y. CHANDRACHUD. J.]'), line('Privacy is intrinsic.')] },
    { page: 279, lines: [line('PUTTASWAMY 845'), line('[R. F. NARIMAN; J.]'), line('I agree that privacy is a fundamental right.')] },
    { page: 432, lines: [
      line('ORDER OF THE COURT'),
      line('1. The judgment on behalf of the Hon\'ble Chief Justice Shri Justice Jagdish Singh Khehar and Dr Justice DY Chandrachud was delivered by Dr Justice'),
      line('DY Chandrachud. Shri Justice Rohinton Fali Nariman delivered a separate judgment.'),
      line('(iii) The right to privacy is protected as an intrinsic part of the right to life.'),
    ] },
  ];
  const parsed = parseOpinions(report, { coram });
  assert.deepEqual(parsed.opinions.map((opinion) => [opinion.name, opinion.page]),
    [['Chandrachud J', 74], ['Nariman J', 279], ['Order of the Court', 432]], 'no opinion starts inside the headnote');
  assert.equal(coram[Number(parsed.leading.split(':')[1])], 'D.Y. CHANDRACHUD', 'named by "was delivered by"');
  assert.equal(opinionOnPage(parsed, 10).role, 'headnote');
  assert.equal(opinionOnPage(parsed, 75).role, 'leading');
  assert.equal(opinionOnPage(parsed, 279).role, 'separate');
  assert.deepEqual(opinionOnPage(parsed, 432, 3), { role: 'order', name: 'Order of the Court' });
});

// ------------------------------------------------------------------ quotes and meaning

test('locateQuote finds exact, OCR-damaged, ellipsis and line-broken quotes, and keeps to the tightest placement', () => {
  const passage = {
    text: 'The petitioner immediately addressed a letter to the Regional Passport Officer requesting him to furnish a copy of the statement '
      + 'of reasons for making the order as provided in section 10(5), to which the Govern- ment has decided "in the interest of the general '
      + 'public" not to furnish her a copy of the statement of reasons, for making of the order.',
  };
  assert.deepEqual(locateQuote('The petitioner immediately addressed a letter', passage), { text: 'The petitioner immediately addressed a letter', exact: true });
  assert.equal(locateQuote('requesting a copy of the statement of reasons', passage).text,
    'requesting him to furnish a copy of the statement of reasons', 'tightest span, though the phrase repeats later');
  const ellipsis = locateQuote('addressed a letter... requesting him to furnish a copy... the Government has decided', passage);
  assert.match(ellipsis.text, /addressed a letter … requesting him to furnish a copy … the Govern- ment has decided/);
  assert.equal(ellipsis.exact, false);
  assert.ok(locateQuote('The petitioner immediately adressed a letter to the Regional Passport Officer requesting', passage), 'an OCR-style slip is tolerated');
  assert.equal(locateQuote('The petitioner immediately adressed a leter to the Regional Passport Officer requesting', passage), null, 'two slips in twelve words is below 85%');
  assert.equal(locateQuote('The Court held that the right to travel abroad is absolute', passage), null);
  assert.equal(locateQuote('requesting him', passage), null, 'too short to verify');
});

test('a point may not state a number, month, outcome or judge its source does not', () => {
  assert.equal(pointMatchesQuote('Passport issued on 1 July 1976', 'issued a passport on Juqe 1, 1976'), false);
  assert.equal(pointMatchesQuote('Passport issued on 1 June 1976', 'issued a passport on Juqe 1, 1976'), true);
  assert.equal(pointMatchesQuote('Section 10(3)(c) violates Article 14', 'section lO(3)(c) is violative of Art. 14'), true, 'OCR digits');
  assert.equal(pointMatchesQuote('under section 10(5)', 'requesting reasons', 'as provided in section 10(5)'), true, 'number from the passage');
  assert.equal(pointMatchesQuote('The Court dismissed the petition', 'We dispose of the Writ Petition'), false);
  assert.equal(pointMatchesQuote('A provision which allows impounding violates Article 14', 'empowers the authority to impound … Art. 14'), true);
  const judges = ['Hameedullah Beg CJ', 'Bhagwati J', 'Kailasam J'];
  assert.equal(pointNamesRightJudge('Chief Justice Bhagwati cautioned', { name: 'Bhagwati J' }, judges), false);
  assert.equal(pointNamesRightJudge('Kailasam J disagreed', { name: 'Bhagwati J' }, judges), false);
  assert.equal(pointNamesRightJudge('Bhagwati J held', { name: 'Bhagwati J' }, judges), true);
  assert.equal(pointNamesRightJudge('The Court had to decide whether privacy is protected', { name: null }, judges), true, '"the Court" names no judge');
});

test('verifyBrief keeps verified points with their opinion, refuses a holding quoted from a dissent, and says why', () => {
  const passages = [
    { id: 'p3.1', page: 3, text: 'The procedure prescribed by law has to be fair, just and reasonable, not fanciful, oppressive or arbitrary.', opinion: { role: 'leading', name: 'Bhagwati J' } },
    { id: 'p4.1', page: 4, text: 'I hold that the petitioner is not entitled to any of the fundamental rights enumerated in Article 19.', opinion: { role: 'dissenting', name: 'Kailasam J' } },
  ];
  const { brief, kept, dropped, rejected } = verifyBrief({
    held: [
      { point: 'Procedure prescribed by law must be fair, just and reasonable.', quote: 'The procedure prescribed by law has to be fair, just and reasonable', passage: 'p3.1' },
      { point: 'Procedure under Article 21 must be fair.', quote: 'The procedure prescribed by law has to be fair, just and reasonable', passage: 'p3.1' },
      { point: 'The petitioner has no Article 19 rights.', quote: 'the petitioner is not entitled to any of the fundamental rights enumerated in Article 19', passage: 'p4.1' },
    ],
    reasoning: [{ point: 'Kailasam J would deny Article 19 rights.', quote: 'not entitled to any of the fundamental rights enumerated in Article 19', passage: 'p4.1' }],
    facts: [{ point: 'Invented.', quote: 'the Court ordered the release of all detainees forthwith', passage: 'p3.1' }],
  }, passages, { judges: ['Bhagwati J', 'Kailasam J'] });
  assert.equal(kept, 2);
  assert.equal(dropped, 3);
  assert.equal(brief.held[0].opinion, 'Bhagwati J, leading opinion');
  assert.equal(brief.reasoning[0].opinion, 'Kailasam J, dissenting opinion', 'a dissent may inform reasoning, labelled');
  assert.deepEqual(rejected.map((item) => item.reason).sort(), [
    'held point quotes a dissenting opinion',
    'point states a number, month or outcome its source does not',
    'quote not found in the judgment',
  ]);
});

test('passages never straddle an opinion boundary, and selection centres on the leading opinion', () => {
  const opinions = parseOpinions(REPORT, { coram: CORAM });
  const passages = toPassages(REPORT, opinions.opinions).map((passage) => ({ ...passage, opinion: opinionOnPage(opinions, passage.page, passage.line) }));
  assert.deepEqual(passages.filter((passage) => passage.page === 3).map((passage) => [passage.line, passage.opinion.name]),
    [[0, 'Hameedullah Beg CJ'], [1, 'Bhagwati J']]);
  const selected = selectPassages(passages, 'Art.21');
  assert.ok(selected.some((passage) => passage.opinion.role === 'leading'));
});

test('prepareCaseBrief uses the stored copy when a refetch fails, stores only verified briefs, and serves the cache', async () => {
  const store = constitutionLibrary();
  try {
    const caseId = store.upsertScCase({
      key: 'k', title: 'MANEKA GANDHI versus UNION OF INDIA', sourceUrl: 'https://x/k.json', pdfUrl: 'https://indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com/k.pdf',
      decidedOn: '1978-01-25', benchStrength: 7, coram: CORAM, headnote: 'h', provisions: [],
    });
    store.recordFetch({ sourceId: 'aws-sc-judgments', url: 'https://indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com/k.pdf', httpStatus: 200, sha256: 'pdfsha', rawPath: '/vault/pdfsha' });
    const fetcher = { fetchDocument: async () => ({ ok: false, error: 'network down' }) };
    const extract = async (rawPath) => {
      assert.equal(rawPath, '/vault/pdfsha');
      return REPORT;
    };
    const llm = async ({ user }) => {
      assert.match(user, /Bhagwati J, leading opinion/);
      return { model: 'test-model', data: { held: [{ point: 'Procedure must be fair, just and reasonable.', quote: 'The procedure must be fair, just and reasonable', passage: 'p3.2' }] } };
    };
    const made = await prepareCaseBrief({ store, fetcher, caseId, extract, llm, apiKey: 'k' });
    assert.equal(made.ok, true);
    assert.equal(made.held[0].opinion, 'Bhagwati J, leading opinion');
    const again = await prepareCaseBrief({ store, fetcher, caseId, extract: () => assert.fail('cached'), llm: () => assert.fail('cached') });
    assert.equal(again.cached, true);

    const unverifiable = await prepareCaseBrief({
      store, fetcher, caseId, force: true, extract, apiKey: 'k',
      llm: async () => ({ model: 'm', data: { held: [{ point: 'x y z', quote: 'words that are nowhere in this judgment at all', passage: 'p3.1' }] } }),
    });
    assert.equal(unverifiable.ok, false);
    assert.equal(store.getCaseBrief(caseId).model, 'test-model', 'an unverifiable brief never replaces a verified one');
    assert.equal((await prepareCaseBrief({ store, fetcher, caseId: 999999 })).status, 404);
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ Groq client

test('groqJson retries rate limits (honouring Retry-After), dropped connections and empty answers', async () => {
  const waits = [];
  const replies = [
    () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    () => { throw new TypeError('fetch failed'); },
    () => Response.json({ choices: [{ message: { content: '' } }] }),
    () => Response.json({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: '{"held": []}' } }] }),
  ];
  const result = await groqJson({
    apiKey: 'k', model: 'm', system: 's', user: 'u', sleep: async (ms) => waits.push(ms), fetchImpl: async () => replies.shift()(),
  });
  assert.deepEqual(result.data, { held: [] });
  assert.equal(waits[0], 2000);
  assert.equal(waits.length, 3);
  await assert.rejects(groqJson({ apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl: async () => Response.json({ error: { message: 'bad' } }, { status: 400 }) }), /HTTP 400: bad/);
  await assert.rejects(groqJson({ apiKey: '', model: 'm', system: 's', user: 'u' }), /GROQ_API_KEY/);
});

// ------------------------------------------------------------------ API

test('GET /lawbuddy/api/cases and POST /lawbuddy/api/cases/:id/brief, and the page module is served', async () => {
  const store = constitutionLibrary();
  try {
    store.upsertScCase({ key: 'm', title: 'MANEKA GANDHI versus UNION OF INDIA', sourceUrl: 'https://x/m.json', pdfUrl: 'https://x/m.pdf', benchStrength: 7, provisions: [{ label: 'Art.21', group: 0 }] });
    const call = async (method, url, prepareBrief) => {
      let sent = null;
      const parsedUrl = new URL(`http://localhost${url}`);
      await handleLawBuddyApiRoute({ method, resume: () => {} }, {}, {
        pathname: parsedUrl.pathname, parsedUrl, legalLibrary: { get: async () => store }, prepareBrief,
        sendJson: (res, status, body) => { sent = { status, body }; },
      });
      return sent;
    };
    const listed = await call('GET', '/lawbuddy/api/cases?provision=Art.21');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.cases[0].title, 'MANEKA GANDHI versus UNION OF INDIA');
    assert.equal((await call('GET', '/lawbuddy/api/cases?provision=nonsense')).status, 400);

    const briefed = await call('POST', '/lawbuddy/api/cases/1/brief?label=Art.21', async ({ caseId, label }) => ({ ok: true, caseId, label }));
    assert.deepEqual(briefed.body, { ok: true, caseId: 1, label: 'Art.21' });
    const failed = await call('POST', '/lawbuddy/api/cases/1/brief', async () => { throw new Error('Groq HTTP 413 at /secret/path'); });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.body.error, /secret/);
    assert.match(LAWBUDDY_FILES['/lawbuddy/assets/cases.js'][0], /web[\\/]cases\.js$/);
  } finally {
    store.close();
  }
});
