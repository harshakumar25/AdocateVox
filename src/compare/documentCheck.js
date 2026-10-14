/**
 * "Check my bare act", for any legal PDF: first decide what the document is, then check it the way
 * that kind of document must be checked. The old check compared every upload with the Constitution,
 * so a BNS copy, an IPC copy or a student's essay produced a report full of false "differences".
 *
 *   act-copy     a copy (whole or part) of an Act the library holds in its official text — the
 *                Constitution, BNS, BNSS or BSA. Only the provisions the copy actually contains are
 *                compared; each is identical, reworded (with the official words it lacks) or absent.
 *   repealed     a copy of a repealed code (IPC, CrPC, Indian Evidence Act): said plainly, with the
 *                repeal section quoted from the official text of its replacement, and how much of it the
 *                replacement carries forward.
 *   write-up     notes, an article, an answer, a commentary: fact-checked. Every provision it names
 *                must exist and be in force (or is mapped to its successor); every quotation must be in
 *                the official text and not stop before a condition; every case citation must resolve to
 *                a Supreme Court judgment of the same name (and is flagged if overruled); every claim
 *                that cites a provision is read beside that provision's text by the critic.
 */

import { comparableWords, latestEffectiveDate, newerThan } from './copyCheck.js';
import { CENTRAL_ACTS, actRecord } from '../ingest/act.js';
import { CONSTITUTION_ACT } from '../ingest/constitution.js';
import { CODE_PAIRS, oldSectionHeadings, bodyStartOf } from './correspondence.js';
import { detectLegalReferences } from '../retrieval/legalRetriever.js';
import { extractCitations } from '../parse/citationParser.js';
import { checkLegalAnswer, qualifierAfter } from '../analysis/answerCheck.js';
import { critiqueClaims } from '../analysis/answerCritique.js';

// The Acts the library holds in their official text, by the code a citation uses.
export const HELD_ACTS = Object.freeze({
  COI: Object.freeze({ code: 'COI', record: CONSTITUTION_ACT, title: 'Constitution of India', titlePattern: /CONSTITUTION\s+OF\s+INDIA/i }),
  BNS: Object.freeze({ code: 'BNS', record: actRecord(CENTRAL_ACTS.BNS), title: CENTRAL_ACTS.BNS.shortTitle, titlePattern: /BHARATIYA\s+NYAYA\s+SANHITA/i }),
  BNSS: Object.freeze({ code: 'BNSS', record: actRecord(CENTRAL_ACTS.BNSS), title: CENTRAL_ACTS.BNSS.shortTitle, titlePattern: /BHARATIYA\s+NAGARIK\s+SURAKSHA\s+SANHITA/i }),
  BSA: Object.freeze({ code: 'BSA', record: actRecord(CENTRAL_ACTS.BSA), title: CENTRAL_ACTS.BSA.shortTitle, titlePattern: /BHARATIYA\s+SAKSHYA\s+ADHINIYAM/i }),
});

const REPEALED_TITLES = Object.freeze({
  IPC: /INDIAN\s+PENAL\s+CODE/i,
  CrPC: /CODE\s+OF\s+CRIMINAL\s+PROCEDURE/i,
  IEA: /INDIAN\s+EVIDENCE\s+ACT/i,
});

const SHINGLE = 8;
// Share of the document's eight-word runs that are an Act's own wording: a copy of the Act is mostly
// the Act; an essay quoting it is mostly the essay.
const ACT_COPY_OVERLAP = 0.4;
const MIN_LOCATED = 3;
// Below this share of a provision's wording, the copy does not contain the provision (only shared phrasing).
const PRESENT_COVERAGE = 0.7;
const MIN_OLD_HEADINGS = 20;
const MIN_QUOTE_WORDS = 6;
const MAX_REFERENCES = 60;
const MAX_QUOTES = 40;
const MAX_CITATIONS = 40;
const MAX_CLAIMS = 12;

const shingles = (words) => {
  const set = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i += 1) set.add(words.slice(i, i + SHINGLE).join(' '));
  return set;
};

/** Each held Act's provisions in force, with a run index for locating quotations and measuring overlap. */
export const loadHeldActs = (store) => {
  const acts = [];
  for (const act of Object.values(HELD_ACTS)) {
    const actId = store.findAct(act.record);
    if (!actId) continue;
    const provisions = store.currentProvisions(actId);
    const runs = new Set();
    for (const provision of provisions) for (const run of shingles(comparableWords(provision.text))) runs.add(run);
    acts.push({ ...act, actId, provisions, runs, source: store.actSource(actId) });
  }
  return acts;
};

const firstPagesText = (pages) => pages.slice(0, 2).join('\n').slice(0, 6000);

/** What the document is: a copy of a held Act, a copy of a repealed code, or a write-up. */
export const identifyDocument = ({ pages, held }) => {
  const text = pages.join('\n');
  const words = comparableWords(text);
  const documentRuns = shingles(words);
  const overlaps = held.map((act) => {
    let shared = 0;
    for (const run of documentRuns) if (act.runs.has(run)) shared += 1;
    return { code: act.code, overlap: documentRuns.size ? shared / documentRuns.size : 0 };
  }).sort((a, b) => b.overlap - a.overlap);

  const opening = firstPagesText(pages);
  const heldByTitle = held.find((act) => act.titlePattern.test(opening));
  const repealedTitle = Object.entries(REPEALED_TITLES).find(([, pattern]) => pattern.test(opening))?.[0] ?? null;
  // A repealed code's copy prints its own numbered sections ("302. Punishment for murder.—"); an essay about
  // the IPC does not, and a BNS copy names the BNS on its title page.
  if (repealedTitle && !heldByTitle && oldSectionHeadings(text, { bodyStart: bodyStartOf(text) }).length >= MIN_OLD_HEADINGS) {
    return { kind: 'repealed', code: repealedTitle, overlaps, words: words.length };
  }
  const best = overlaps[0];
  if (best && best.overlap >= ACT_COPY_OVERLAP) return { kind: 'act-copy', code: best.code, overlaps, words: words.length };
  return { kind: 'write-up', code: null, overlaps, words: words.length };
};

const humanLabel = (code, label) => (code === 'COI'
  ? (label.startsWith('Art.') ? `Article ${label.slice(4)}` : label)
  : `${code} ${label.replace(/^s\./, 's. ')}`);

// ------------------------------------------------------------------ copies of Acts

const RUN = 5;
const MIN_PROVISION_WORDS = 8;
const MIN_MISSING_RUN = 4;
const IDENTICAL = 0.97;
const MAX_PHRASES = 3;
const MAX_PHRASE_WORDS = 18;

/**
 * Presence comparison: each provision's five-word runs are looked up anywhere in the copy. A PDF reader may
 * move margin notes, page heads and footnotes into the middle of a section, so in-order alignment reported
 * false differences for a copy byte-identical to the Gazette; presence does not care about order, while words
 * the copy truly lacks (an amendment, a changed punishment) still leave runs of missing official words.
 */
export const compareByPresence = ({ provisions, copyText }) => {
  const copyWords = comparableWords(copyText);
  const copyRuns = new Set();
  for (let i = 0; i + RUN <= copyWords.length; i += 1) copyRuns.add(copyWords.slice(i, i + RUN).join(' '));
  const differs = [];
  let compared = 0;
  for (const provision of provisions) {
    const words = comparableWords(provision.text);
    if (words.length < MIN_PROVISION_WORDS) continue;
    compared += 1;
    const covered = new Uint8Array(words.length);
    let present = 0;
    const runs = words.length - RUN + 1;
    for (let i = 0; i < runs; i += 1) {
      if (!copyRuns.has(words.slice(i, i + RUN).join(' '))) continue;
      present += 1;
      covered.fill(1, i, i + RUN);
    }
    const coverage = present / runs;
    const missing = [];
    for (let i = 0; i < words.length;) {
      if (covered[i]) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < words.length && !covered[i]) i += 1;
      if (i - start >= MIN_MISSING_RUN) {
        const phrase = words.slice(start, i);
        missing.push(phrase.length > MAX_PHRASE_WORDS ? `${phrase.slice(0, MAX_PHRASE_WORDS).join(' ')} …` : phrase.join(' '));
      }
    }
    if (coverage < IDENTICAL || missing.length) {
      differs.push({ label: provision.label, heading: provision.heading, coverage: Math.round(coverage * 100) / 100, missing: missing.slice(0, MAX_PHRASES) });
    }
  }
  return { compared, differs };
};

const checkActCopy = ({ act, pages, copyDate, sha256 }) => {
  const copyText = pages.join('\n');
  // The very file the library's text was taken from: nothing to compare.
  if (sha256 && act.source?.source_sha256 === sha256) {
    return {
      kind: 'act-copy', act: act.title, actCode: act.code, verdict: 'official',
      summary: `This PDF is byte for byte the official ${act.title} that LawBuddy's text comes from (${act.source.source_url}).`,
      counts: { comparable: act.provisions.length, present: act.provisions.length, identical: act.provisions.length, reworded: 0, absent: 0 },
      partial: false, reworded: [], absentLabels: [], newerThanCopy: [], textCurrentTo: null,
      official: { url: act.source.source_url, sha256: act.source.source_sha256 },
    };
  }
  const comparison = compareByPresence({ provisions: act.provisions, copyText });
  const absent = comparison.differs.filter((item) => item.coverage < PRESENT_COVERAGE);
  const reworded = comparison.differs.filter((item) => item.coverage >= PRESENT_COVERAGE);
  const present = comparison.compared - absent.length;
  const identical = present - reworded.length;
  const textCurrentTo = act.code === 'COI' ? latestEffectiveDate(copyText) : null;
  const newer = copyDate ? newerThan(act.provisions, copyDate) : [];
  const partial = absent.length > comparison.compared / 2;

  let verdict = 'matches';
  if (newer.length) verdict = 'outdated';
  else if (reworded.length) verdict = 'differs';
  if (present < MIN_LOCATED) verdict = 'unreadable';

  const scope = partial
    ? `Your PDF holds ${present} of the ${comparison.compared} comparable provisions of the ${act.title} (an extract, not the whole Act).`
    : `Your PDF holds ${present} of the ${comparison.compared} comparable provisions of the ${act.title}.`;
  const findings = verdict === 'unreadable'
    ? 'Too little of the Act could be read to compare it: the PDF may be a scan without a text layer.'
    : `${identical} of them match the official text word for word${reworded.length ? `; ${reworded.length} read differently, each shown with the official words your copy lacks` : ''}.${newer.length ? ` ${newer.length} provisions took effect after your copy's date.` : ''}`;

  return {
    kind: 'act-copy',
    act: act.title,
    actCode: act.code,
    verdict,
    summary: `${scope} ${findings}`,
    counts: { comparable: comparison.compared, present, identical, reworded: reworded.length, absent: absent.length },
    partial,
    reworded: reworded.map((item) => ({ ...item, title: humanLabel(act.code, item.label) })),
    absentLabels: absent.map((item) => item.label),
    newerThanCopy: newer,
    textCurrentTo,
    official: act.source ? { url: act.source.source_url, sha256: act.source.source_sha256 } : null,
  };
};

const checkRepealedCopy = ({ store, code, held }) => {
  const pair = CODE_PAIRS[code];
  const successor = held.find((act) => act.code === pair.newAct);
  const repeal = successor?.provisions.find((provision) => provision.label === pair.repealedBy);
  const mappings = store.findCorrespondenceSummary?.(pair.oldAct, pair.newAct) ?? null;
  return {
    kind: 'repealed',
    act: pair.oldTitle,
    actCode: code,
    verdict: 'repealed',
    summary: `This is a copy of the ${pair.oldTitle}, which is no longer in force. It was repealed by section ${pair.repealedBy.slice(2)} of the ${successor?.title ?? pair.newAct}, in force from ${successor?.provisions[0]?.validFrom ?? '1 July 2024'}. Study the ${successor?.title ?? pair.newAct} instead; LawBuddy shows, for any section of the old code, the section that replaced it.`,
    repeal: repeal ? { act: successor.title, label: repeal.label, heading: repeal.heading, text: repeal.text.split('\n')[0], validFrom: repeal.validFrom } : null,
    successor: successor ? { code: successor.code, title: successor.title } : null,
    correspondence: mappings,
  };
};

// ------------------------------------------------------------------ write-ups

/** The official text of a held provision as a statute evidence item (for quote checks and the critic). */
const evidenceItem = (act, provision) => ({
  kind: 'statute',
  act: act.code,
  label: provision.label,
  title: `${act.title}, ${humanLabel(act.code, provision.label)}${provision.heading ? ` (${provision.heading})` : ''}`,
  content: `${act.title}, ${humanLabel(act.code, provision.label)}. Official text, in force since ${provision.validFrom}:\n${provision.text}`,
});

const tagFor = (code, label) => (code === 'COI' ? `Article ${label.slice(4)}` : `${code} ${label.replace(/\(.*$/, '')}`);

/** Every provision a write-up names, checked: in force, not in the official text, or repealed (with successor). */
const checkReferences = ({ store, text, held }) => {
  const references = detectLegalReferences(text);
  const byCode = new Map(held.map((act) => [act.code, act]));
  const results = [];
  const provisionFor = (code, label) => byCode.get(code)?.provisions.find((provision) => provision.label === label.replace(/\(.*$/, '')) ?? null;

  for (const label of references.constitution.slice(0, MAX_REFERENCES)) {
    const provision = provisionFor('COI', label);
    results.push(provision
      ? { reference: humanLabel('COI', label), status: 'in-force', code: 'COI', label, heading: provision.heading, tag: tagFor('COI', label) }
      : { reference: humanLabel('COI', label), status: byCode.has('COI') ? 'not-found' : 'not-held', code: 'COI', label });
  }
  for (const { act, label } of references.sections.slice(0, MAX_REFERENCES)) {
    if (byCode.has(act)) {
      const provision = provisionFor(act, label);
      results.push(provision
        ? { reference: humanLabel(act, label), status: 'in-force', code: act, label, heading: provision.heading, tag: tagFor(act, label) }
        : { reference: humanLabel(act, label), status: 'not-found', code: act, label });
    } else if (CODE_PAIRS[act]) {
      const successors = store.findCorrespondence({ act, label })
        .filter((row) => row.kind === 'mapped' && row.old_act === act && row.new_label)
        .map((row) => ({ code: row.new_act, label: row.new_label, heading: row.new_title, tag: tagFor(row.new_act, row.new_label) }));
      results.push({
        reference: `${act} ${label.replace(/^s\./, 's. ')}`,
        status: 'repealed',
        code: act,
        label,
        repealedBy: `${CODE_PAIRS[act].newAct} ${CODE_PAIRS[act].repealedBy}`,
        successors,
      });
    }
  }
  return results;
};

/** A run index over every held provision, to find which one a quotation comes from. */
const quotationIndex = (held) => {
  const index = new Map();
  for (const act of held) {
    for (const provision of act.provisions) {
      const words = comparableWords(provision.text);
      for (let i = 0; i + 5 <= words.length; i += 1) {
        const key = words.slice(i, i + 5).join(' ');
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ act, provision });
      }
    }
  }
  return index;
};

/**
 * Every quotation in the write-up: found word for word in a provision (and not cut before a condition),
 * found only approximately, or not the wording of any provision LawBuddy holds (perhaps a judgment).
 */
const checkQuotations = ({ text, held }) => {
  const index = quotationIndex(held);
  const results = [];
  for (const match of text.matchAll(/[“"‘]([^”"’\n]{20,900})[”"’]/g)) {
    const quoted = match[1].trim();
    const words = comparableWords(quoted);
    if (words.length < MIN_QUOTE_WORDS) continue;
    const votes = new Map();
    for (let i = 0; i + 5 <= words.length; i += 1) {
      for (const hit of index.get(words.slice(i, i + 5).join(' ')) || []) {
        const key = `${hit.act.code}|${hit.provision.label}`;
        votes.set(key, { hit, count: (votes.get(key)?.count || 0) + 1 });
      }
    }
    const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) {
      results.push({ text: quoted, status: 'unmatched' });
    } else {
      const item = evidenceItem(best.hit.act, best.hit.provision);
      const check = checkLegalAnswer(`“${quoted}”`, [item]).quotes[0];
      const condition = check?.exact ? qualifierAfter(quoted, best.hit.provision.text) : null;
      results.push({
        text: quoted,
        status: !check?.ok ? 'altered' : condition ? 'cut-before-condition' : check.exact ? 'exact' : 'approximate',
        source: humanLabel(best.hit.act.code, best.hit.provision.label),
        ...(condition ? { condition } : {}),
      });
    }
    if (results.length >= MAX_QUOTES) break;
  }
  return results;
};

const NAME_NOISE = new Set(['the', 'and', 'ors', 'anr', 'others', 'another', 'of', 'in', 'state', 'union', 'india', 'versus', 'etc', 'ltd']);
const nameWords = (text) => (String(text || '').toLowerCase().match(/[a-z]{3,}/g) || []).filter((word) => !NAME_NOISE.has(word));

/** Forms the record may print a volume-less citation in ("[1950] SCR 88" is "[1950] 1 SCR 88"). */
const citationForms = ({ scheme, normalized }) => {
  const forms = [{ scheme, normalized }];
  const plain = /^\[(\d{4})\] SCR (\d+)$/.exec(normalized);
  if (scheme === 'SCR' && plain) forms.push({ scheme, normalized: `[${plain[1]}] 1 SCR ${plain[2]}` });
  const supp = /^\[(\d{4})\] Supp\. SCR (\d+)$/.exec(normalized);
  if (scheme === 'SCR' && supp) forms.push({ scheme, normalized: `[${supp[1]}] Supp. 1 SCR ${supp[2]}` });
  return forms;
};

/**
 * Every case citation: the Supreme Court judgment it belongs to (from the Court's record, or a citation
 * LawBuddy learned from parallel citations), whether the name printed beside it is that judgment's, and
 * whether a later judgment overruled it.
 */
const checkCitations = ({ store, text }) => {
  const results = [];
  const seen = new Set();
  for (const citation of extractCitations(text)) {
    if (seen.has(citation.normalized) || results.length >= MAX_CITATIONS) continue;
    seen.add(citation.normalized);
    const before = text.slice(Math.max(0, citation.index - 160), citation.index);
    const name = /([A-Z][\w.&'’()\- ]{1,90}?)\s+(?:v\.?|vs\.?|versus)\s+([A-Z][\w.&'’()\- ]{1,90}?)[\s,([]*$/.exec(before);
    let judgment = null;
    let via = null;
    for (const form of citationForms(citation)) {
      const official = store.findCaseByCitation(form);
      if (official) {
        judgment = official;
        via = 'official';
        break;
      }
      const learned = store.findLearnedAlias(form);
      if (learned) {
        judgment = store.getCase(learned.case_id);
        via = 'learned';
        break;
      }
    }
    const printedName = name ? `${name[1].trim()} v. ${name[2].trim()}` : null;
    if (!judgment) {
      results.push({ citation: citation.normalized, name: printedName, status: citation.court && citation.court !== 'SC' ? 'other-court' : 'not-in-index' });
      continue;
    }
    const titleWords = new Set(nameWords(judgment.title));
    const nameMatches = printedName ? nameWords(printedName).some((word) => titleWords.has(word)) : null;
    results.push({
      citation: citation.normalized,
      name: printedName,
      status: nameMatches === false ? 'name-mismatch' : judgment.status === 'overruled' ? 'overruled' : judgment.status === 'caution' ? 'caution' : 'verified',
      resolvedBy: via,
      judgment: {
        id: judgment.id, title: judgment.title, decidedOn: judgment.decided_on, bench: judgment.bench_strength,
        status: judgment.status, citedBy: store.citedByCount(judgment.id), pdfUrl: judgment.pdf_url,
      },
    });
  }
  return results;
};

/** Sentences that state something about a provision the library holds: the claims the critic reads. */
const writeUpClaims = ({ text, references }) => {
  const tagsByReference = new Map();
  for (const reference of references) {
    const tags = reference.status === 'in-force' ? [reference.tag] : (reference.successors || []).map((successor) => successor.tag);
    if (tags.length) tagsByReference.set(reference.reference.toLowerCase(), tags);
  }
  const claims = [];
  for (const sentence of text.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+(?=[A-Z“"(])/)) {
    if (sentence.split(' ').length < 8) continue;
    const found = detectLegalReferences(sentence);
    const tags = new Set();
    for (const label of found.constitution) tags.add(tagFor('COI', label));
    for (const { act, label } of found.sections) {
      if (HELD_ACTS[act]) tags.add(tagFor(act, label));
      for (const tag of tagsByReference.get(`${act} ${label.replace(/^s\./, 's. ')}`.toLowerCase()) || []) tags.add(tag);
    }
    if (!tags.size) continue;
    claims.push({ n: claims.length + 1, text: sentence.slice(0, 700), tags: [...tags] });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
};

const checkWriteUp = async ({ store, pages, held, critique }) => {
  const text = pages.join('\n');
  const references = checkReferences({ store, text, held });
  const quotations = checkQuotations({ text, held });
  const citations = checkCitations({ store, text });

  const claims = writeUpClaims({ text, references });
  const byCode = new Map(held.map((act) => [act.code, act]));
  const evidence = [];
  for (const tag of new Set(claims.flatMap((claim) => claim.tags))) {
    const [code, label] = tag.startsWith('Article ') ? ['COI', `Art.${tag.slice(8)}`] : tag.split(' ');
    const provision = byCode.get(code)?.provisions.find((item) => item.label === label);
    if (provision) evidence.push(evidenceItem(byCode.get(code), provision));
  }
  let critic = null;
  if (claims.length && evidence.length) {
    try {
      critic = await critique({ claims, evidence });
    } catch {
      critic = { error: 'The claim-by-claim reading could not run right now; the other checks are complete.' };
    }
  }

  const errors = [
    ...references.filter((item) => item.status === 'not-found').map((item) => `${item.reference} is not in the official text in force.`),
    ...quotations.filter((item) => item.status === 'altered').map((item) => `A quotation attributed to the law is not its wording (nearest: ${item.source}).`),
    ...citations.filter((item) => item.status === 'name-mismatch').map((item) => `${item.citation} is ${item.judgment.title}, not ${item.name}.`),
    ...(critic?.claims || []).filter((claim) => claim.verdict === 'contradicted').map((claim) => `A claim contradicts ${claim.tags.join(', ')}.`),
  ];
  const warnings = [
    ...references.filter((item) => item.status === 'repealed').map((item) => `${item.reference} is repealed${item.successors.length ? `; the law in force is ${item.successors.map((successor) => successor.tag).join(', ')}` : ''}.`),
    ...quotations.filter((item) => item.status === 'cut-before-condition').map((item) => `A quotation from ${item.source} stops before a condition.`),
    ...citations.filter((item) => item.status === 'overruled' || item.status === 'caution').map((item) => `${item.judgment.title} (${item.citation}) has been ${item.status === 'overruled' ? 'overruled' : 'partly overruled or doubted'}.`),
    ...(critic?.claims || []).filter((claim) => claim.verdict === 'overstated' || claim.verdict === 'unsupported').map((claim) => `A claim goes beyond ${claim.tags.join(', ')}.`),
  ];
  const checked = references.length + quotations.length + citations.length + (critic?.claims?.length || 0);
  const verdict = !checked ? 'nothing-to-check' : errors.length ? 'unreliable' : warnings.length ? 'use-with-care' : 'reliable';
  const summaries = {
    'nothing-to-check': 'LawBuddy found no provision, quotation of the law or case citation in this document to check.',
    unreliable: `${errors.length} statement${errors.length === 1 ? '' : 's'} in this document conflict with the official text or the Court's record. Do not rely on it without correcting them.`,
    'use-with-care': `Nothing in it conflicts with the official text, but ${warnings.length} point${warnings.length === 1 ? '' : 's'} need care: repealed law, a quotation cut short, an overruled judgment or a claim broader than the law.`,
    reliable: 'Every provision, quotation and citation LawBuddy could check matches the official text and the Court\'s record.',
  };
  return {
    kind: 'write-up',
    verdict,
    summary: summaries[verdict],
    counts: {
      references: references.length,
      quotations: quotations.length,
      citations: citations.length,
      claims: critic?.claims?.length || 0,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
    references,
    quotations,
    citations,
    critique: critic,
  };
};

/**
 * @param {{ store: object, pages: string[], copyDate?: string|null, critique?: Function }} params pages: page texts
 */
export const checkDocument = async ({ store, pages, copyDate = null, sha256 = null, critique = (input) => critiqueClaims(input) }) => {
  const held = loadHeldActs(store);
  if (!held.length) return { ok: false, status: 503, error: 'The library holds no official Act text yet.' };
  const identity = identifyDocument({ pages, held });
  const base = { ok: true, identified: { kind: identity.kind, code: identity.code, overlaps: identity.overlaps.slice(0, 3), words: identity.words } };
  if (identity.kind === 'repealed') return { ...base, ...checkRepealedCopy({ store, code: identity.code, held }) };
  if (identity.kind === 'act-copy') return { ...base, ...checkActCopy({ act: held.find((act) => act.code === identity.code), pages, copyDate, sha256 }) };
  return { ...base, ...(await checkWriteUp({ store, pages, held, critique })) };
};
