import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { analyseQuestion, answerDirection, classifyQuestion, LEGAL_CONCEPTS } from '../src/analysis/questionAnalysis.js';
import { checkLegalAnswer, normalizeTag, qualifierAfter } from '../src/analysis/answerCheck.js';
import { critiqueAnswer, extractClaims } from '../src/analysis/answerCritique.js';
import { condenseSection, conceptEvidence, createLawRetriever } from '../src/retrieval/legalRetriever.js';
import { parseGazetteAct, respaceCapitals } from '../src/parse/gazetteAct.js';
import { CENTRAL_ACTS, actRecord, ingestCentralAct } from '../src/ingest/act.js';
import { getActProvision } from '../src/service.js';

// ------------------------------------------------------------------ question analysis

test('questions are classified by what they ask for', () => {
  assert.equal(classifyQuestion('While protecting myself, can I kill someone?'), 'permission');
  assert.equal(classifyQuestion('Is it legal to record a call without consent?'), 'permission');
  assert.equal(classifyQuestion('Draft a formal note: is a WhatsApp screenshot valid evidence?'), 'formal');
  assert.equal(classifyQuestion('Please write a reply to the notice in legal language'), 'formal');
  assert.equal(classifyQuestion('Police arrested my brother; what are his rights?'), 'rights');
  assert.equal(classifyQuestion('How do I file an FIR if the police refuse?'), 'procedure');
  assert.equal(classifyQuestion('What is the punishment for cheating?'), 'punishment');
  assert.equal(classifyQuestion('What is culpable homicide?'), 'definition');
  assert.equal(classifyQuestion('Tell me about the new criminal laws'), 'general');
  assert.match(answerDirection('permission'), /What the law allows:[\s\S]*What the law forbids:[\s\S]*Where the line is:[\s\S]*If the line is crossed:/);
  assert.match(answerDirection('formal'), /Question presented:[\s\S]*Applicable law:[\s\S]*Analysis:[\s\S]*Conclusion:/);
  assert.equal(answerDirection('general'), null);
});

test('lay words map to legal concepts and to the provisions on each side of the question', () => {
  const analysis = analyseQuestion('while protecting myself can i kill someone ?');
  assert.deepEqual(analysis.concepts.map((concept) => concept.id), ['private-defence', 'causing-death']);
  const roles = analysis.provisions.map((provision) => `${provision.role}:${provision.label}`);
  assert.deepEqual(roles.slice(0, 2), ['allows:s.34', 'allows:s.35'], 'what permits it comes first');
  assert.ok(roles.includes('forbids:s.101') && roles.includes('limits:s.38') && roles.includes('consequence:s.105'));
  assert.equal(analysis.focus.length, 2);
  assert.deepEqual(analyseQuestion('my landlord changed the locks').concepts, [], 'no concept is guessed');
  // Every concept names provisions with a heading check.
  for (const concept of LEGAL_CONCEPTS) {
    assert.ok(concept.focus instanceof RegExp, concept.id);
    for (const provision of concept.provisions) assert.ok(provision.expect instanceof RegExp, `${concept.id} ${provision.label}`);
  }
});

test('an accused security researcher is routed to cyber law, not FIR filing or physical self-defence', async () => {
  const question = 'I am an individual cyber security researcher. I did penetration testing on a website for white hacking practice. The owner of the website filed a case against me. My intention was good. How can I defend myself?';
  const analysis = analyseQuestion(question);
  assert.equal(analysis.kind, 'scenario');
  assert.deepEqual(analysis.concepts.map((concept) => concept.id), ['unauthorised-security-testing']);
  assert.deepEqual(analyseQuestion('I did penetration testing; the owner filed an FIR against me. How can I defend myself?').concepts.map((concept) => concept.id),
    ['unauthorised-security-testing'], 'being named in an FIR is not a request to register one');
  assert.deepEqual(analysis.provisions.map((provision) => provision.label).sort(), ['s.43', 's.66']);
  const store = bnsLibrary();
  try {
    const retrieve = createLawRetriever({ loader: { get: async () => store }, asOf: '2026-10-19' });
    const evidence = await retrieve({ text: question });
    assert.equal(evidence.length, 0, 'unrelated statute text must not substitute for the missing IT Act');
    assert.match(evidence.analysis.warnings[0], /section 43 and section 66.*not indexed/i);
  } finally {
    store.close();
  }
});

test('cyber merits need both IT Act sections even when the question names an available procedural section', async () => {
  const store = openLegalStore(':memory:');
  const add = (shortTitle, year, label, heading, text) => {
    const actId = store.upsertAct({ shortTitle, year });
    const provisionId = store.upsertProvision({ actId, label, heading });
    store.addProvisionVersion({ provisionId, text, validFrom: '2024-07-01',
      sourceUrl: 'https://www.indiacode.nic.in/official-test.pdf', sourceSha256: 'test-source' });
  };
  try {
    add('Bharatiya Nagarik Suraksha Sanhita, 2023', 2023, 's.173', 'Information in cognizable cases', 'Information relating to the commission of a cognizable offence.');
    const retrieve = createLawRetriever({ loader: { get: async () => store }, asOf: '2026-10-19' });
    const question = 'I performed penetration testing without permission; the owner filed a case against me. Explain IT Act section 66 and BNSS section 173 in my case.';
    const absent = await retrieve({ text: question });
    assert.equal(absent.length, 0, 'BNSS must not make a partial cyber answer look grounded');
    add('Information Technology Act, 2000', 2000, 's.43', 'Penalty and compensation for damage to computer, computer system, etc.', 'If any person without permission accesses a computer.');
    const partial = await retrieve({ text: question });
    assert.equal(partial.length, 0, 'section 43 alone cannot support the section 66 mental-element analysis');
    assert.match(partial.analysis.warnings[0], /section 66.*not indexed/i);
    assert.deepEqual(partial.analysis.coverage.missing, [{ act: 'IT2000', label: 's.66' }]);
    add('Information Technology Act, 2000', 2000, 's.66', 'Computer related offences', 'If any person, dishonestly or fraudulently, does any act referred to in section 43.');
    const complete = await retrieve({ text: question });
    assert.deepEqual(complete.filter((item) => item.kind === 'statute').map((item) => `${item.act}:${item.label}`).sort(),
      ['BNSS:s.173', 'IT2000:s.43', 'IT2000:s.66']);
  } finally { store.close(); }
});

const S101 = [
  'Except in the cases hereinafter excepted, culpable homicide is murder,––',
  '(a) if the act by which the death is caused is done with the intention of causing death; or',
  'Illustrations.',
  '(a) A shoots Z with the intention of killing him. Z dies in consequence. A commits murder.',
  '(b) A, knowing that Z is labouring under such a disease that a blow is likely to cause his death, strikes him. Z dies. A is guilty of murder.',
  'Exception 1.—Culpable homicide is not murder if the offender, whilst deprived of the power of self-control by grave and sudden provocation, causes the death of the person who gave the provocation.',
  'Exception 2.—Culpable homicide is not murder if the offender in the exercise in good faith of the right of private defence of person or property, exceeds the power given to him by law and causes the death of the person against whom he is exercising such right of defence without premeditation.',
  'Exception 3.—Culpable homicide is not murder if the offender, being a public servant, exceeds the powers given to him by law and causes death.',
].join('\n');

test('a long section loses its illustrations first, then keeps the paragraphs touching most of the question\'s concepts', () => {
  const noIllustrations = condenseSection(S101, 900);
  assert.doesNotMatch(noIllustrations, /A shoots Z/);
  assert.match(noIllustrations, /Exception 2/);
  assert.match(noIllustrations, /Illustrations omitted/);
  const focused = condenseSection(S101, 600, [/private defence/i, /\bdeath\b/i]);
  assert.match(focused, /^Except in the cases hereinafter excepted/, 'the opening stays');
  assert.match(focused, /Exception 2\.—/, 'private defence and death: the paragraph that matters most');
  assert.doesNotMatch(focused, /Exception 3/);
  assert.match(focused, /\[…\]/);
  assert.equal(condenseSection('short', 900), 'short');
});

// ------------------------------------------------------------------ a library with the BNS

const bnsLibrary = () => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct(actRecord(CENTRAL_ACTS.BNS));
  const add = (label, heading, text) => {
    const provisionId = store.upsertProvision({ actId, label, heading, context: { chapter: 'Chapter III', act: 'BNS' } });
    store.addProvisionVersion({
      provisionId, text, validFrom: '2024-07-01', gazetteRef: CENTRAL_ACTS.BNS.gazetteId,
      sourceUrl: CENTRAL_ACTS.BNS.officialUrl, sourceSha256: 'bns',
    });
  };
  add('s.34', 'Things done in private defence', 'Nothing is an offence which is done in the exercise of the right of private defence.');
  add('s.35', 'Right of private defence of body and of property', 'Every person has a right, subject to the restrictions contained in section 37, to defend his own body.');
  add('s.37', 'Acts against which there is no right of private defence', '(2) The right of private defence in no case extends to the inflicting of more harm than it is necessary to inflict for the purpose of defence.');
  // A deliberately wrong heading: the concept index expects s.38 to be about causing death in private defence.
  add('s.38', 'Something else entirely', 'Unrelated text.');
  add('s.100', 'Culpable homicide', 'Whoever causes death by doing an act with the intention of causing death commits the offence of culpable homicide.');
  add('s.101', 'Murder', S101);
  add('s.103', 'Punishment for murder', '(1) Whoever commits murder shall be punished with death or imprisonment for life, and shall also be liable to fine.');
  return store;
};

test('concept evidence: official text with the reason it was retrieved; a provision whose heading does not match is dropped', () => {
  const store = bnsLibrary();
  try {
    const analysis = analyseQuestion('While protecting myself, can I kill someone?');
    const { evidence, warnings } = conceptEvidence({ store, analysis, asOf: '2026-10-14' });
    assert.deepEqual(evidence.map((item) => `${item.role}:${item.label}`),
      ['allows:s.34', 'allows:s.35', 'forbids:s.100', 'forbids:s.101', 'limits:s.37', 'consequence:s.103']);
    assert.match(warnings.join(' '), /BNS s\.38 was skipped: its official heading "Something else entirely"/);
    assert.match(warnings.join(' '), /BNS s\.105 is not in the library/);
    const s34 = evidence[0];
    assert.equal(s34.act, 'BNS');
    assert.match(s34.content, /Cite it as \[BNS s\.34\]/);
    assert.match(s34.content, /Retrieved because, for this question \(Right of private defence \(self-defence\)\), it permits the act/);
    assert.match(s34.content, /Gazette of India CG-DL-E-25122023-250883/);
  } finally {
    store.close();
  }
});

test('the law retriever answers a lay question through its concepts and carries the answer format', async () => {
  const store = bnsLibrary();
  try {
    const retrieve = createLawRetriever({ loader: { get: async () => store }, asOf: '2026-10-14' });
    const evidence = await retrieve({ text: 'While protecting myself, can I kill someone?' });
    assert.ok(evidence.length >= 5);
    assert.equal(evidence.analysis.kind, 'permission');
    assert.match(evidence.analysis.direction, /Where the line is:/);
    assert.deepEqual(Object.keys(evidence[0]).includes('analysis'), false, 'the analysis is not an evidence item');
    const named = await retrieve({ text: 'Explain BNS 103' });
    assert.equal(named[0].title, 'Bharatiya Nyaya Sanhita, 2023 — section 103 (Punishment for murder)');
    assert.equal(getActProvision(store, 'bns', '103', '2026-10-14').heading, 'Punishment for murder');
    assert.equal(getActProvision(store, 'bns', '103', '2023-01-01').status, 404, 'not in force before 1 July 2024');
    assert.equal(getActProvision(store, 'xyz', '1').status, 400);
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ checking the finished answer

test('citation tags are normalised, and an answer\'s citations and quotations are checked against its evidence', () => {
  assert.equal(normalizeTag('BNS s. 37(2)'), 'BNS s.37');
  assert.equal(normalizeTag('section 38 of the BNS'), 'BNS s.38');
  assert.equal(normalizeTag('Art. 21(1)'), 'Article 21');
  assert.equal(normalizeTag('Information Technology Act, 2000 s.43'), 'IT2000 s.43');
  assert.equal(normalizeTag('emphasis supplied'), null);

  const evidence = [
    { kind: 'statute', act: 'BNS', label: 's.34', title: 'BNS s.34', content: 'Official text: Nothing is an offence which is done in the exercise of the right of private defence.' },
    { kind: 'statute', act: 'BNS', label: 's.37', title: 'BNS s.37', content: '(2) The right of private defence in no case extends to the inflicting of more harm than it is necessary to inflict for the purpose of defence.' },
    { kind: 'statute', act: 'COI', label: 'Art.21', title: 'Article 21', content: 'No person shall be deprived of his life or personal liberty except according to procedure established by law.' },
  ];
  const answer = [
    'What the law allows: “Nothing is an offence which is done in the exercise of the right of private defence” [BNS s.34].',
    'Where the line is: the right “in no case extends to the inflicting of more harm than it is necessary to inflict” [BNS s.37(2)].',
    'And "no person shall be deprived of his life or personal liberty except according to procedure established by law" [Art. 21].',
    'But "a person may always kill an intruder at night" [BNS s.103], says nothing in the evidence.',
  ].join('\n');
  const check = checkLegalAnswer(answer, evidence);
  assert.deepEqual(check.citations.map((citation) => [citation.tag, citation.ok]),
    [['BNS s.34', true], ['BNS s.37', true], ['Article 21', true], ['BNS s.103', false]]);
  assert.deepEqual(check.quotes.map((quote) => quote.ok), [true, true, true, false]);
  assert.equal(check.quotes[2].source, 'Article 21', 'case differences do not matter');
  assert.equal(check.ok, false);
  assert.equal(check.verifiedCitations, 3);
  const withQuestion = Object.defineProperty([...evidence], 'analysis', { value: { question: 'an offence in territorial waters of 48 nautical miles of India' }, enumerable: false });
  assert.equal(checkLegalAnswer('The question says “territorial waters of 48 nautical miles of India” [Article 21].', withQuestion).quotes.length, 0,
    'a quotation of the question is not checked against the law');
  const invented = checkLegalAnswer('Exceeding the right is not murder [BNS s.37(5)], and "no right" [BNS s.37(2)].', evidence);
  assert.deepEqual(invented.citations.map((citation) => [citation.tag, citation.ok]), [['BNS s.37(5)', false], ['BNS s.37', true]],
    'a sub-section the official text does not have is flagged; one it has is fine');
  const fragments = checkLegalAnswer('“(2) The right of private defence … more harm than it is necessary to inflict” [BNS s.37].', evidence);
  assert.equal(fragments.quotes[0].ok, true, 'a quotation with an ellipsis is checked fragment by fragment');
  const shuffled = checkLegalAnswer('“more harm than it is necessary to inflict … (2) The right of private defence” [BNS s.37].', evidence);
  assert.equal(shuffled.quotes[0].exact, false, 'fragments out of order are not an exact quotation');
});

test('IT Act citations use the same identity in answer checking and claim critique', () => {
  const evidence = [{ kind: 'statute', act: 'IT2000', label: 's.66', title: 'IT Act s.66',
    content: 'If any person, dishonestly or fraudulently, does any act referred to in section 43.' }];
  const answer = 'Section 66 turns on a dishonest or fraudulent act referred to in section 43 [Information Technology Act, 2000 s.66].';
  assert.deepEqual(checkLegalAnswer(answer, evidence).citations.map((item) => [item.tag, item.ok]), [['IT2000 s.66', true]]);
  assert.deepEqual(extractClaims(answer).map((claim) => claim.tags), [['IT2000 s.66']]);
});

// ------------------------------------------------------------------ the Gazette parser

const word = (text, x0, top, sp = true) => ({ text, x0, x1: x0 + text.length * 5, top, sp });
const line = (text, x0, top) => {
  const words = [];
  let x = x0;
  for (const piece of text.split(' ')) {
    words.push(word(piece, x, top));
    x += piece.length * 5 + 3;
  }
  return words;
};
// A body line runs from x 118 to 478; margin headings sit right (x ≥ 486) on odd pages and left (x < 112) on even.
const fill = (text, top) => line(`${text} ${'filler '.repeat(Math.max(0, 60 - text.length) / 7)}`.trim(), 118, top)
  .map((item, index, all) => (index === all.length - 1 ? { ...item, x1: 478 } : item));
const gazettePages = () => [
  {
    page: 1,
    words: [
      ...line('CG-DL-E-25122023-250883', 250, 200), ...line('NO. 45 OF 2023', 260, 220),
      ...line('CHAPTER I', 270, 300), ...line('PRELIMINARY', 270, 318),
      ...line('1. (1) This Act may be called the Sanhita.', 142, 340), ...line('Short title.', 486, 340),
      ...fill('text of section one that runs on to fill the line', 352), ...fill('more of section one', 364),
      // As printed: a raised initial touching the small capitals, with the spaces between words lost.
      ...line('CHAPTER II', 270, 400), { text: 'G', x0: 258, x1: 265, top: 415, sp: false }, { text: 'ENERALEXCEPTIONS', x0: 265, x1: 345, top: 418, sp: false },
      ...line('Of right of private defence', 230, 440),
      ...line('2. Nothing done in private defence is an offence.', 142, 460), ...line('Things done', 486, 460), ...line('in private', 486, 470), ...line('defence.', 486, 480),
      ...line('these general exceptions cover the house-', 118, 472), ...fill('breaker text of section two', 484),
      ...line('3. The right of private defence extends to the', 142, 760), ...line('Right of', 486, 760), ...line('defence against', 486, 770),
    ],
  },
  {
    page: 2,
    words: [
      ...line('2', 120, 62), ...line('THE GAZETTE OF INDIA EXTRAORDINARY', 217, 62),
      ...line('innocent person.', 58, 80),
      ...fill('voluntary causing of death of the assailant.', 82),
      ...line('4. The Indian Penal Code is hereby repealed.', 142, 120), ...line('Repeal.', 58, 120), ...line('45 of 1860.', 497, 120),
      ...line('—————', 276, 300),
      ...line('SECRETARY TO THE GOVERNMENT', 232, 320),
    ],
  },
];

test('Gazette parser: margin headings by position, numbering in sequence, chapters, sub-headings, run-on headings', () => {
  const { sections, warnings } = parseGazetteAct(gazettePages());
  assert.deepEqual(warnings, []);
  assert.deepEqual(sections.map((section) => [section.label, section.heading]), [
    ['s.1', 'Short title.'],
    ['s.2', 'Things done in private defence.'],
    ['s.3', 'Right of defence against innocent person.'],
    ['s.4', 'Repeal.'],
  ], 'the left-margin "45 of 1860." is an Act citation, not a heading; a heading runs on across a page');
  assert.equal(sections[0].chapterTitle, 'PRELIMINARY');
  assert.equal(sections[1].chapterTitle, 'GENERAL EXCEPTIONS', 'a raised initial and lost spaces are restored');
  assert.equal(sections[1].subheading, 'Of right of private defence');
  assert.match(sections[1].text, /house-breaker/, 'a hyphen at a line end joins the word');
  assert.match(sections[2].text, /extends to the voluntary causing of death of the assailant\./, 'a section runs on across a page');
  assert.doesNotMatch(sections[2].text, /GAZETTE/, 'the page head is not text');
  assert.doesNotMatch(sections[3].text, /SECRETARY/, 'the Act ends at the closing rule');
  assert.equal(respaceCapitals('CRIMINALCONSPIRACY', new Set(['criminal', 'conspiracy'])), 'CRIMINAL CONSPIRACY');
  assert.equal(respaceCapitals('ZZZZZZZZ', new Set(['criminal'])), 'ZZZZZZZZ', 'left as printed unless it splits completely');
});

test('ingestCentralAct refuses a document that is not the expected Gazette, or a partial parse', async () => {
  const store = openLegalStore(':memory:');
  try {
    store.registerSource({ id: 'egazette', name: 'e-Gazette', tier: 0, baseUrl: 'https://egazette.gov.in' });
    store.recordFetch({ sourceId: 'egazette', url: CENTRAL_ACTS.BNS.officialUrl, httpStatus: 200, sha256: 'x', rawPath: '/vault/x' });
    const pages = gazettePages();
    await assert.rejects(() => ingestCentralAct({ store, code: 'BNS', extract: async () => pages }), /Found 4 of the 358 sections/);
    const wrongId = pages.map((page, index) => (index ? page : { ...page, words: page.words.filter((item) => !item.text.startsWith('CG-DL')) }));
    await assert.rejects(() => ingestCentralAct({ store, code: 'BNS', extract: async () => wrongId }), /does not print Gazette ID/);
    const wrongNumber = pages.map((page, index) => (index ? page : { ...page, words: page.words.map((item) => (item.text === '45' ? { ...item, text: '46' } : item)) }));
    await assert.rejects(() => ingestCentralAct({ store, code: 'BNS', extract: async () => wrongNumber }), /prints Act No\. 46 of 2023, not 45 of 2023/);
    await assert.rejects(() => ingestCentralAct({ store, code: 'XYZ' }), /Unknown Act/);
    assert.equal(store.findAct(actRecord(CENTRAL_ACTS.BNS)), null, 'nothing was stored');
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ selective quoting and the critique

const S37 = '(1) There is no right of private defence,––\n(a) against an act which does not reasonably cause the apprehension of death or of grievous hurt, if done, or attempted to be done, by a public servant acting in good faith under colour of his office;\n(2) The right of private defence in no case extends to the inflicting of more harm than it is necessary to inflict for the purpose of defence.';
const S37_EVIDENCE = { kind: 'statute', act: 'BNS', label: 's.37', title: 'BNS s.37', content: `Official text (Gazette), in force since 2024-07-01:\n${S37}` };

test('a quotation cut just before a condition is flagged: the rule is narrower than it reads', () => {
  assert.match(qualifierAfter('against an act which does not reasonably cause the apprehension of death or of grievous hurt', S37), /^if done, or attempted to be done, by a public servant/);
  assert.equal(qualifierAfter('more harm than it is necessary to inflict for the purpose of defence', S37), null);
  const check = checkLegalAnswer('No right exists “against an act which does not reasonably cause the apprehension of death or of grievous hurt” [BNS s.37].', [S37_EVIDENCE]);
  assert.equal(check.quotes[0].ok, true);
  assert.match(check.quotes[0].cutBefore, /public servant/);
  assert.equal(check.cutQuotes, 1);
  assert.equal(check.ok, false);
});

test('the critique reads each cited claim beside the clause it quotes, and withholds a correction that misquotes', async () => {
  const answer = [
    'Short answer: only within limits.',
    '- No right exists “against an act which does not reasonably cause the apprehension of death or of grievous hurt” [BNS s.37].',
    '- **Proportionality**: “The right of private defence in no case extends to the inflicting of more harm than it is necessary” [BNS s.37].',
    '- A claim about a provision that was not retrieved [BNS s.999].',
  ].join('\n');
  assert.deepEqual(extractClaims(answer).map((claim) => [claim.n, claim.tags]), [[1, ['BNS s.37']], [2, ['BNS s.37']], [3, ['BNS s.999']]]);

  let prompt = null;
  const llm = async ({ user, model }) => {
    prompt = user;
    return {
      model,
      data: {
        claims: [
          { n: 1, verdict: 'overstated', reason: 'omits the public-servant condition', correction: 'Only for an act “done, or attempted to be done, by a public servant acting in good faith”.' },
          { n: 2, verdict: 'supported', reason: 'matches', correction: '' },
          { n: 3, verdict: 'contradicted', reason: 'invented', correction: 'The text says “anyone may kill an intruder”.' },
        ],
      },
    };
  };
  const result = await critiqueAnswer({ answer, evidence: [S37_EVIDENCE], apiKey: 'test', model: 'critic', llm });
  assert.match(prompt, /quoted from \[BNS s\.37\]: \(a\) against an act which does not reasonably cause/, 'the whole clause is shown');
  assert.match(prompt, /stops just before the condition "if done, or attempted to be done, by a public servant/);
  assert.doesNotMatch(prompt, /Retrieved because|Cite it as/, 'only the official text, not the framing');
  assert.deepEqual(result.claims.map((claim) => [claim.n, claim.verdict]), [[1, 'overstated'], [2, 'supported']],
    'a claim citing nothing that was retrieved is not sent');
  assert.match(result.claims[0].correction, /by a public servant acting in good faith/);
  assert.equal(result.flagged, 1);

  const misquoting = async () => ({ model: 'critic', data: { claims: [{ n: 1, verdict: 'overstated', reason: 'x', correction: 'The text says “anyone may kill an intruder at night”.' }] } });
  const withheld = await critiqueAnswer({ answer, evidence: [S37_EVIDENCE], apiKey: 'test', llm: misquoting });
  assert.equal(withheld.claims[0].correction, null, 'a correction whose quotation is not in the text is withheld');
  assert.equal(withheld.claims[1].verdict, 'unchecked');
  assert.equal(await critiqueAnswer({ answer: 'No citations here.', evidence: [S37_EVIDENCE], apiKey: 'test', llm }), null);
});

test('the critique sends claims in batches, so a long answer is checked in full', async () => {
  const answer = Array.from({ length: 8 }, (_, i) => `- Claim ${i + 1}: “The right of private defence in no case extends to the inflicting of more harm” [BNS s.37].`).join('\n');
  const batches = [];
  const llm = async ({ user, model }) => {
    const numbers = [...user.matchAll(/^(\d+)\. Claim/gm)].map((match) => Number(match[1]));
    batches.push(numbers);
    return { model, data: { claims: numbers.map((n) => ({ n, verdict: 'supported', reason: 'ok', correction: '' })) } };
  };
  const result = await critiqueAnswer({ answer, evidence: [S37_EVIDENCE], apiKey: 'test', model: 'critic', llm });
  assert.deepEqual(batches, [[1, 2, 3, 4, 5, 6], [7, 8]]);
  assert.equal(result.claims.every((claim) => claim.verdict === 'supported'), true);
  assert.equal(result.unchecked, 0);
});

test('a situation question is solved issue by issue, with every concept it raises represented', async () => {
  const question = 'a offence had committed in territorial of 48 nautical miles of India towards the Indian ocean 7 person had involved in this offense of robbery and murder in which 5 of them committed the crime on the water bodies and 2 of them linked with this crime from the land territorial of india but the two person was not present tell me whether all the 7 person will be liable';
  assert.equal(classifyQuestion(question), 'scenario');
  assert.equal(classifyQuestion('While protecting myself, can I kill someone?'), 'permission', 'a short "can I" is not a fact pattern');
  const analysis = analyseQuestion(question);
  assert.deepEqual(analysis.concepts.map((concept) => concept.id).sort(),
    ['abetment-conspiracy', 'causing-death', 'joint-liability', 'robbery-dacoity', 'territorial-reach']);
  const direction = answerDirection('scenario');
  assert.match(direction, /Issues:[\s\S]*Facts that would change the answer:[\s\S]*What LawBuddy could not verify/);
  assert.match(direction, /point of law built into the question[\s\S]*as a claim to verify, not a fact/);
  assert.match(direction, /being present/);
});

test('a situation\'s evidence includes each concept\'s lead provision: criminal conspiracy for those not present', () => {
  const store = openLegalStore(':memory:');
  try {
    const actId = store.upsertAct(actRecord(CENTRAL_ACTS.BNS));
    const sections = [['s.1', 'Short title, commencement and application'], ['s.3', 'General explanations'], ['s.47', 'Abetment in India of offences outside India'],
      ['s.61', 'Criminal conspiracy'], ['s.45', 'Abetment of a thing'], ['s.100', 'Culpable homicide'], ['s.101', 'Murder'], ['s.309', 'Robbery'], ['s.310', 'Dacoity']];
    for (const [label, heading] of sections) {
      const provisionId = store.upsertProvision({ actId, label, heading });
      store.addProvisionVersion({ provisionId, text: `${heading} text.`, validFrom: '2024-07-01', sourceUrl: CENTRAL_ACTS.BNS.officialUrl, sourceSha256: 'bns' });
    }
    const analysis = analyseQuestion('7 persons were involved in robbery and murder at sea, 5 of them on a boat and 2 of them linked from the land but not present; tell me whether all 7 are liable');
    assert.equal(analysis.kind, 'scenario');
    const labels = conceptEvidence({ store, analysis, asOf: '2026-10-14' }).evidence.map((item) => item.label);
    for (const label of ['s.1', 's.3', 's.61', 's.100', 's.309']) assert.ok(labels.includes(label), label);
  } finally {
    store.close();
  }
});
