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
// Below this share of a provision's five-word runs, the copy does not contain the provision at all.
const PRESENT_COVERAGE = 0.3;
const MIN_OLD_HEADINGS = 20;
const MIN_QUOTE_WORDS = 6;
const MAX_REFERENCES = 60;
const MAX_QUOTES = 40;
const MAX_CITATIONS = 40;
const MAX_CLAIMS = 12;
const MAX_COPY_WORDS = 600_000;

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
  // A recognised title is useful evidence even when an old edition has little wording in common.
  // Do not quietly treat an unrecognised Act as prose and give it a green write-up verdict.
  if (heldByTitle && best?.overlap >= 0.15) return { kind: 'act-copy', code: heldByTitle.code, overlaps, words: words.length };
  if (/\b(?:THE\s+)?[A-Z][A-Z\s,()\-]{6,100}\b(?:ACT|SANHITA|ADHINIYAM),?\s*(?:18|19|20)\d{2}\b/i.test(opening)
    && /\b(?:section|chapter|schedule|short title|extent)\b/i.test(text.slice(0, 20_000))) {
    return { kind: 'unsupported', code: null, overlaps, words: words.length };
  }
  return { kind: 'write-up', code: null, overlaps, words: words.length };
};

const humanLabel = (code, label) => (code === 'COI'
  ? (label.startsWith('Art.') ? `Article ${label.slice(4)}` : label)
  : `${code} ${label.replace(/^s\./, 's. ')}`);

// ------------------------------------------------------------------ copies of Acts

const RUN = 5;
const MIN_PROVISION_WORDS = 8;
const IDENTICAL = 0.97;
const MAX_PHRASES = 3;
const MAX_PHRASE_WORDS = 18;

/**
 * Find a provision's strongest local run of matching wording. Looking up shingles throughout the
 * whole PDF lets unrelated sections collectively impersonate a match. A bounded word window keeps
 * those matches near one another while allowing page heads, margin notes and footnotes inside it.
 */
const bestLocalWindow = (words, index) => {
  const hits = [];
  for (let offset = 0; offset + RUN <= words.length; offset += 1) {
    for (const position of index.get(words.slice(offset, offset + RUN).join(' ')) || []) {
      hits.push({ position, offset });
    }
  }
  if (!hits.length) return { hits: [], coveredRuns: 0 };
  hits.sort((a, b) => a.position - b.position);
  const span = Math.ceil(words.length * 1.7) + 300;
  const counts = new Map();
  let left = 0;
  let unique = 0;
  let best = { left: 0, right: 0, coveredRuns: 0 };
  for (let right = 0; right < hits.length; right += 1) {
    const offset = hits[right].offset;
    if (!counts.has(offset)) unique += 1;
    counts.set(offset, (counts.get(offset) || 0) + 1);
    while (hits[right].position - hits[left].position > span) {
      const old = hits[left].offset;
      const remaining = counts.get(old) - 1;
      if (remaining) counts.set(old, remaining);
      else { counts.delete(old); unique -= 1; }
      left += 1;
    }
    if (unique > best.coveredRuns) best = { left, right, coveredRuns: unique };
  }
  return { hits: hits.slice(best.left, best.right + 1), coveredRuns: best.coveredRuns };
};

/** A conservative wording check; every uncovered official word in a located provision is visible. */
export const compareByPresence = ({ provisions, copyText, pages = null }) => {
  const pageTexts = pages?.length ? pages : [copyText];
  const copyWords = [];
  const pageStarts = [];
  for (const page of pageTexts) {
    pageStarts.push(copyWords.length);
    const words = comparableWords(page);
    if (copyWords.length + words.length > MAX_COPY_WORDS) {
      throw new RangeError('This PDF has too much extracted text to check in one pass.');
    }
    for (const word of words) copyWords.push(word);
  }
  const index = new Map();
  for (let position = 0; position + RUN <= copyWords.length; position += 1) {
    const key = copyWords.slice(position, position + RUN).join(' ');
    const positions = index.get(key);
    if (positions) positions.push(position);
    else index.set(key, [position]);
  }
  const pageFor = (position) => {
    let low = 0;
    let high = pageStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (pageStarts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const differs = [];
  let compared = 0;
  let formatting = 0;
  for (const provision of provisions) {
    const words = comparableWords(provision.text);
    if (words.length < MIN_PROVISION_WORDS) continue;
    compared += 1;
    const local = bestLocalWindow(words, index);
    const covered = new Uint8Array(words.length);
    const runs = words.length - RUN + 1;
    for (const hit of local.hits) covered.fill(1, hit.offset, hit.offset + RUN);
    const coverage = local.coveredRuns / runs;
    const missing = [];
    for (let i = 0; i < words.length;) {
      if (covered[i]) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < words.length && !covered[i]) i += 1;
      // A one-word substitution can change a punishment, a time limit or a duty. Suppressing it as
      // formatting produced false green results for "seven"→"ten" and "shall"→"may".
      if (i - start >= 1) {
        const phrase = words.slice(start, i);
        missing.push(phrase.length > MAX_PHRASE_WORDS ? `${phrase.slice(0, MAX_PHRASE_WORDS).join(' ')} …` : phrase.join(' '));
      }
    }
    const page = local.hits.length ? pageFor(local.hits[0].position) : null;
    if (missing.length) {
      differs.push({ label: provision.label, heading: provision.heading, coverage: Math.round(coverage * 100) / 100, missing: missing.slice(0, MAX_PHRASES), page });
    } else if (coverage < IDENTICAL) {
      formatting += 1;
    }
  }
  return { compared, differs, formatting };
};

/**
 * What courts and the Gazette say about a provision's printed text: an amendment the Supreme Court struck down
 * (the 99th Amendment's NJAC words in Articles 124A-128) or one never brought into force. A copy that differs
 * from the official text only there is not wrong: its older wording is the one that applies. The judgment
 * named in the footnote is resolved to the Supreme Court index where it can be.
 */
const judicialNotes = (store, provision) => {
  let footnotes = [];
  try {
    footnotes = JSON.parse(provision.footnotes || '[]');
  } catch {
    footnotes = [];
  }
  return footnotes.filter((note) => note.invalidated || note.pending).map((note) => {
    let judgment = null;
    // "… Advocates-on-Record Association and another vs. Union of India in its judgment dated 16-10-2015":
    // the decision date and a party's name identify the judgment in the Court's record.
    const dated = /([A-Z][\w.&'’\- ]{3,120}?)\s+(?:[Vv][Ss]?\.?|versus)\s+[\s\S]{0,120}?dated\s+(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{4})/.exec(note.text);
    if (dated) {
      const date = `${dated[4]}-${dated[3].padStart(2, '0')}-${dated[2].padStart(2, '0')}`;
      const wanted = nameWords(dated[1]);
      const match = store.casesDecidedOn(date).find((row) => {
        const title = new Set(nameWords(row.title));
        return wanted.filter((word) => title.has(word)).length >= Math.min(2, wanted.length);
      });
      if (match) judgment = { id: match.id, title: match.title, decidedOn: match.decided_on, pdfUrl: match.pdf_url, citation: null };
    }
    for (const citation of judgment ? [] : extractCitations(note.text)) {
      const found = store.findCaseByCitation(citation) ?? (store.findLearnedAlias(citation) ? store.getCase(store.findLearnedAlias(citation).case_id) : null);
      if (found) {
        judgment = { id: found.id, title: found.title, decidedOn: found.decided_on, pdfUrl: found.pdf_url, citation: citation.normalized };
        break;
      }
    }
    return { kind: note.invalidated ? 'struck-down' : 'not-in-force', text: note.text, judgment };
  });
};

const checkActCopy = ({ store, act, pages, copyDate, sha256 }) => {
  const copyText = pages.join('\n');
  // The very file the library's text was taken from: nothing to compare.
  if (sha256 && act.source?.source_sha256 === sha256) {
    return {
      kind: 'act-copy', act: act.title, actCode: act.code, verdict: 'official',
      summary: `This PDF is byte for byte the official ${act.title} that LawBuddy's text comes from (${act.source.source_url}).`,
      counts: { comparable: act.provisions.length, present: act.provisions.length, identical: act.provisions.length, reworded: 0, absent: 0 },
      partial: false, scope: 'complete', reworded: [], explained: [], absentLabels: [], newerThanCopy: [], textCurrentTo: null,
      official: { url: act.source.source_url, sha256: act.source.source_sha256 },
    };
  }
  const comparison = compareByPresence({ provisions: act.provisions, copyText, pages });
  const byLabel = new Map(act.provisions.map((provision) => [provision.label, provision]));
  const annotated = comparison.differs.map((item) => {
    const notes = judicialNotes(store, byLabel.get(item.label));
    return notes.length ? { ...item, judicial: notes } : item;
  });
  const absent = annotated.filter((item) => item.coverage < PRESENT_COVERAGE);
  const differing = annotated.filter((item) => item.coverage >= PRESENT_COVERAGE);
  // A judicial note does not establish that *this* difference is the invalidated wording. Show it
  // beside the difference for a human to resolve, without excusing unrelated changed words.
  const reworded = differing;
  const present = comparison.compared - absent.length;
  const identical = present - differing.length;
  const textCurrentTo = act.code === 'COI' ? latestEffectiveDate(copyText) : null;
  // A pre-commencement printed Gazette can already contain the exact enacted wording. Date alone
  // cannot prove that the PDF is outdated; report only later-effective provisions that also differ.
  const changedLabels = new Set(reworded.map((item) => item.label));
  const newer = copyDate ? newerThan(act.provisions.filter((item) => changedLabels.has(item.label)), copyDate) : [];
  const partial = absent.length > comparison.compared / 2;
  const scope = absent.length === 0 ? 'complete' : partial ? 'extract' : 'apparently-incomplete';

  let verdict = 'matches';
  if (newer.length) verdict = 'outdated';
  else if (reworded.length) verdict = 'differs';
  else if (scope === 'apparently-incomplete' || comparison.formatting) verdict = 'needs-review';
  if (present === 0) verdict = 'unreadable';

  const scopeText = partial
    ? `Your PDF holds ${present} of the ${comparison.compared} comparable provisions of the ${act.title} (an extract, not the whole Act).`
    : `Your PDF holds ${present} of the ${comparison.compared} comparable provisions of the ${act.title}${scope === 'apparently-incomplete' ? '; some expected provisions could not be located' : ''}.`;
  const findings = verdict === 'unreadable'
    ? 'No provision could be located with enough confidence to compare. The PDF may be a scan or a substantially different edition.'
    : `${identical} located provisions have no missing official wording detected${reworded.length ? `; ${reworded.length} differ from the stored official text, with the missing words shown` : ''}.${newer.length ? ` ${newer.length} differing provisions took effect after your copy's date; the date alone does not establish what this PDF prints.` : ''}${scope === 'apparently-incomplete' ? ' Review the provisions that could not be located before relying on this as a complete copy.' : ''}`;

  return {
    kind: 'act-copy',
    act: act.title,
    actCode: act.code,
    verdict,
    summary: `${scopeText} ${findings}`,
    counts: { comparable: comparison.compared, present, identical, reworded: reworded.length, explained: 0, absent: absent.length, formatting: comparison.formatting },
    partial,
    scope,
    reworded: reworded.map((item) => ({ ...item, title: humanLabel(act.code, item.label) })),
    explained: [],
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
    verdict: repeal ? 'repealed' : 'needs-review',
    summary: `This is a copy of the ${pair.oldTitle}. ${repeal ? `Section ${pair.repealedBy.slice(2)} of the ${successor.title} repeals it, but its savings clauses can preserve the old law for earlier acts or pending matters.` : 'LawBuddy has not loaded the official repeal section needed to verify its transition.'} Check the relevant act or proceeding date and the full repeal-and-savings text before choosing which code applies. Section correspondence is a research aid, not an automatic legal equivalence.`,
    repeal: repeal ? { act: successor.title, label: repeal.label, heading: repeal.heading, text: repeal.text, validFrom: repeal.validFrom, source: successor.source ? { url: successor.source.source_url, sha256: successor.source.source_sha256 } : null } : null,
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

const pendingForReference = (provision, label) => {
  let notes = [];
  try { notes = JSON.parse(provision?.footnotes || '[]'); } catch { return null; }
  const pending = notes.filter((note) => note.pending);
  if (!pending.length) return null;
  const subsection = /\((\d+[A-Z]?)\)/i.exec(label)?.[1] ?? null;
  const matching = subsection && pending.find((note) => new RegExp(`(?:sub[- ]?section|section)\\s*\\(${subsection}\\)`, 'i').test(note.text));
  return { status: matching ? 'not-in-force' : 'commencement-caution', note: (matching || pending[0]).text };
};

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
  for (const { act, label, subsection = '' } of references.sections.slice(0, MAX_REFERENCES)) {
    const fullLabel = `${label}${subsection}`;
    if (byCode.has(act)) {
      const provision = provisionFor(act, label);
      const pending = pendingForReference(provision, fullLabel);
      results.push(provision
        ? { reference: humanLabel(act, fullLabel), status: pending?.status ?? 'in-force', code: act, label: fullLabel, heading: provision.heading, tag: tagFor(act, label), ...(pending ? { note: pending.note } : {}) }
        : { reference: humanLabel(act, fullLabel), status: 'not-found', code: act, label: fullLabel });
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
    // The case name is printed just before its citation, after the previous citation or sentence ends.
    let before = text.slice(Math.max(0, citation.index - 160), citation.index);
    const cut = Math.max(before.lastIndexOf(')'), before.lastIndexOf(']'), before.lastIndexOf(';'),
      ...[...before.matchAll(/\b[a-z]{4,}\.\s+(?=[A-Z])/g)].map((match) => match.index + match[0].length - 1));
    if (cut > 0) before = before.slice(cut + 1);
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
  const pending = new Set(references.filter((item) => ['not-in-force', 'commencement-caution'].includes(item.status))
    .map((item) => `${item.code}|${item.label}`));
  for (const reference of references) {
    const tags = reference.status === 'in-force' ? [reference.tag] : (reference.successors || []).map((successor) => successor.tag);
    if (tags.length) tagsByReference.set(reference.reference.toLowerCase(), tags);
  }
  const claims = [];
  for (const sentence of text.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+(?=[A-Z“"(])/)) {
    if (sentence.split(' ').length < 8) continue;
    const found = detectLegalReferences(sentence);
    const tags = new Set();
    const notes = [];
    for (const label of found.constitution) tags.add(tagFor('COI', label));
    for (const { act, label, subsection = '' } of found.sections) {
      if (HELD_ACTS[act] && !pending.has(`${act}|${label}${subsection}`)) tags.add(tagFor(act, label));
      const successors = HELD_ACTS[act] ? [] : tagsByReference.get(`${act} ${label.replace(/^s\./, 's. ')}`.toLowerCase()) || [];
      for (const tag of successors) tags.add(tag);
      // The claim names a repealed section: the critic judges its substance against the successor in force.
      if (successors.length) notes.push(`${act} ${label} is repealed; [${successors.join('], [')}] carries it forward. Judge what the claim says the law provides against that text, not the section number it uses.`);
    }
    if (!tags.size) continue;
    claims.push({ n: claims.length + 1, text: sentence.slice(0, 700), tags: [...tags], ...(notes.length ? { note: notes.join(' ') } : {}) });
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
    ...references.filter((item) => item.status === 'not-in-force' || item.status === 'commencement-caution').map((item) => `${item.reference}: ${item.note}`),
    ...quotations.filter((item) => item.status === 'cut-before-condition').map((item) => `A quotation from ${item.source} stops before a condition.`),
    ...citations.filter((item) => item.status === 'overruled' || item.status === 'caution').map((item) => `${item.judgment.title} (${item.citation}) has been ${item.status === 'overruled' ? 'overruled' : 'partly overruled or doubted'}.`),
    ...(critic?.claims || []).filter((claim) => claim.verdict === 'overstated').map((claim) => `A claim goes beyond ${claim.tags.join(', ')}.`),
  ];
  // "Unsupported" here means the statute's text does not settle the claim (it may be about a judgment's
  // holding): shown with the claim, not counted against the document.
  const unsettled = (critic?.claims || []).filter((claim) => claim.verdict === 'unsupported').length;
  const checked = references.length + quotations.length + citations.length + (critic?.claims?.length || 0);
  const unchecked = claims.length > (critic?.claims?.length || 0)
    || (critic?.claims || []).some((claim) => claim.verdict === 'unchecked')
    || references.some((item) => item.status === 'not-held' || item.status === 'not-in-force' || item.status === 'commencement-caution')
    || quotations.some((item) => item.status === 'unmatched' || item.status === 'approximate')
    || citations.some((item) => item.status === 'not-in-index' || item.status === 'other-court');
  const verdict = !checked ? 'nothing-to-check' : errors.length ? 'unreliable' : unchecked ? 'needs-review' : warnings.length ? 'use-with-care' : 'reliable';
  const summaries = {
    'nothing-to-check': 'LawBuddy found no provision, quotation of the law or case citation in this document to check.',
    unreliable: `${errors.length} statement${errors.length === 1 ? '' : 's'} in this document conflict with the official text or the Court's record. Do not rely on it without correcting them.`,
    'use-with-care': `Nothing in it conflicts with the official text, but ${warnings.length} point${warnings.length === 1 ? '' : 's'} need care: repealed law, a quotation cut short, an overruled judgment or a claim broader than the law.`,
    'needs-review': 'Some references or claims could not be fully verified. Review the unchecked items and the linked official sources before relying on this document.',
    reliable: 'The references, quotations and citations checked here match the sources in LawBuddy\'s library. This does not verify claims outside the checked scope.',
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
      unsettled,
      unchecked: Number(unchecked),
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
  if (identity.kind === 'unsupported') return {
    ...base,
    kind: 'unsupported',
    verdict: 'needs-review',
    summary: 'This appears to be an Act, but its official text is not in LawBuddy’s library. It cannot be checked here yet.',
  };
  if (identity.kind === 'repealed') return { ...base, ...checkRepealedCopy({ store, code: identity.code, held }) };
  if (identity.kind === 'act-copy') return { ...base, ...checkActCopy({ store, act: held.find((act) => act.code === identity.code), pages, copyDate, sha256 }) };
  return { ...base, ...(await checkWriteUp({ store, pages, held, critique })) };
};
