/**
 * Legal grounding for the DocVex teaching pipeline ("cite-or-silence").
 *
 * When the student's selection or question names a provision ("Article 21",
 * "Articles 14, 19 and 21", "अनुच्छेद 21", "Seventh Schedule", "Section 302 IPC",
 * "BNS 103"), the evidence handed to the model is the stored official text,
 * with its in-force date, struck-down cautions, pending amendments and source.
 * A provision that is not in the official text yields an explicit "not found"
 * notice so the tutor says so instead of inventing it.
 *
 * Used only by the /lawbuddy routes; node:sqlite is loaded lazily on first
 * use, so DocVex users without a legal store never touch it.
 */

import fs from 'node:fs';
import { config } from '../config.js';
import { CENTRAL_ACTS, actRecord } from '../ingest/act.js';
import { analyseQuestion, answerDirection, roleNote } from '../analysis/questionAnalysis.js';

const CONSTITUTION = Object.freeze({ shortTitle: 'Constitution of India', year: 1950 });
const MAX_PROVISIONS = 4;
const MAX_EVIDENCE_CHARS = 2500;

const SCHEDULE_NAMES = Object.freeze([
  'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth',
]);
const ROMAN = Object.freeze({ i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 });

const ACT_CODES = Object.freeze({
  ipc: 'IPC', 'indian penal code': 'IPC',
  bns: 'BNS', 'bharatiya nyaya sanhita': 'BNS',
  bnss: 'BNSS', 'bharatiya nagarik suraksha sanhita': 'BNSS',
  crpc: 'CrPC', 'code of criminal procedure': 'CrPC',
  bsa: 'BSA', 'bharatiya sakshya adhiniyam': 'BSA',
  iea: 'IEA', 'evidence act': 'IEA', 'indian evidence act': 'IEA',
});
const ACT_NAMES = String.raw`IPC|BNSS|BNS|Cr\.?\s?P\.?\s?C\.?|BSA|IEA|Indian Penal Code|Bharatiya Nyaya Sanhita|Bharatiya Nagarik Suraksha Sanhita|Bharatiya Sakshya Adhiniyam|Code of Criminal Procedure|(?:Indian\s+)?Evidence Act`;
const toActCode = (name) => ACT_CODES[name.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').replace(/^cr ?p ?c$/, 'crpc')] ?? null;

export const LEGAL_EVIDENCE_KINDS = Object.freeze(['statute', 'statute-absence', 'correspondence']);

/**
 * @returns {{ constitution: string[], sections: Array<{act: string, label: string}> }}
 *   constitution labels like "Art.21", "Preamble", "Sch.7"; sections like {act: 'IPC', label: 's.302'}.
 */
export const detectLegalReferences = (text) => {
  const value = String(text || '');
  const constitution = [];
  const sections = [];
  const addArticle = (label) => !constitution.includes(label) && constitution.push(label);
  const addSection = (act, number) => {
    const label = `s.${number.toUpperCase()}`;
    if (act && !sections.some((s) => s.act === act && s.label === label)) sections.push({ act, label });
  };

  // "Article 21", "Art. 21A(1)", "Articles 14, 19 and 21"
  for (const [, list] of value.matchAll(/\bArt(?:icle)?s?\.?\s*((?:\d{1,3}[A-Z]{0,3}(?:\s*\(\s*\w{1,4}\s*\))*\s*(?:,|and|&|or)?\s*)+)/gi)) {
    for (const [number] of list.replace(/\(\s*\w{1,4}\s*\)/g, ' ').matchAll(/\d{1,3}[A-Z]{0,3}/gi)) {
      addArticle(`Art.${number.toUpperCase()}`);
    }
  }
  // Hindi: "अनुच्छेद 21"
  for (const [, number] of value.matchAll(/(?:^|[^\p{L}])अनुच्छेद\s*(\d{1,3}[A-Z]{0,3})/gu)) addArticle(`Art.${number.toUpperCase()}`);

  if (/\bpreamble\b|प्रस्तावना/i.test(value)) addArticle('Preamble');

  for (const [, name] of value.matchAll(new RegExp(String.raw`\b(${SCHEDULE_NAMES.join('|')})\s+Schedule\b`, 'gi'))) {
    addArticle(`Sch.${SCHEDULE_NAMES.findIndex((n) => n.toLowerCase() === name.toLowerCase()) + 1}`);
  }
  for (const [, number] of value.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+Schedule\b/gi)) addArticle(`Sch.${Number(number)}`);
  for (const [, number] of value.matchAll(/\bSchedule\s+(\d{1,2}|[ivx]{1,4})\b/gi)) {
    const n = ROMAN[number.toLowerCase()] ?? Number(number);
    if (n >= 1 && n <= 12) addArticle(`Sch.${n}`);
  }

  // "Section 302 IPC", "s. 103 of the Bharatiya Nyaya Sanhita"
  for (const [, number, act] of value.matchAll(new RegExp(String.raw`\b(?:sections?|sec\.?|s\.)\s*(\d{1,3}[A-Z]{0,2})(?:\s*\(\s*\w{1,4}\s*\))*\s*(?:of\s+(?:the\s+)?)?(${ACT_NAMES})`, 'gi'))) {
    addSection(toActCode(act), number);
  }
  // "IPC 302", "BNS s. 103"
  for (const [, act, number] of value.matchAll(new RegExp(String.raw`\b(IPC|BNSS|BNS|CrPC|BSA|IEA)\s*(?:sections?|sec\.?|s\.)?\s*(\d{1,3}[A-Z]{0,2})\b`, 'gi'))) {
    addSection(toActCode(act), number);
  }
  // "302 IPC"
  for (const [, number, act] of value.matchAll(/\b(\d{1,3}[A-Z]{0,2})\s+(IPC|BNSS|BNS|CrPC|BSA|IEA)\b/gi)) addSection(toActCode(act), number);

  return { constitution, sections };
};

const humanLabel = (label) => {
  if (label === 'Preamble') return 'the Preamble';
  if (label.startsWith('Sch.')) return `the ${SCHEDULE_NAMES[Number(label.slice(4)) - 1]} Schedule`;
  return `Article ${label.slice(4)}`;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)} … [text truncated; the full text is at the source]` : text);

const ILLUSTRATIONS = /^Illustrations?\.?$/i;
const RESUMES_LAW = /^(?:Exception|Explanation|Provided)/;

/**
 * A long section without its illustrations (worked examples), keeping every operative paragraph,
 * exception, explanation and proviso: in BNS s.101 (murder), Exception 2 (private defence exceeded in
 * good faith) comes after many illustrations and must never be the part that is cut.
 */
export const condenseSection = (text, max, focus = null) => {
  if (text.length <= max) return text;
  const kept = [];
  let inIllustrations = false;
  let omittedIllustrations = false;
  for (const paragraph of text.split('\n')) {
    if (ILLUSTRATIONS.test(paragraph.trim())) {
      inIllustrations = true;
      omittedIllustrations = true;
      continue;
    }
    if (inIllustrations && RESUMES_LAW.test(paragraph.trim())) inIllustrations = false;
    if (!inIllustrations) kept.push(paragraph);
  }
  const illustrationsNote = omittedIllustrations ? '[Illustrations omitted here; they are in the full text at the source.]' : null;
  const whole = [...kept, illustrationsNote].filter(Boolean).join('\n');
  const patterns = [focus].flat().filter(Boolean);
  if (whole.length <= max || !patterns.length) return truncate(whole, max);

  // Still too long: the opening, then the paragraphs touching most of the question's concepts, then the
  // rest; printed in the section's own order, with every gap marked.
  const score = (paragraph) => patterns.filter((pattern) => pattern.test(paragraph)).length;
  const order = [0, ...kept.map((_, index) => index).filter((index) => index > 0)
    .sort((a, b) => score(kept[b]) - score(kept[a]) || a - b)];
  const chosen = new Set();
  let used = 0;
  for (const index of order) {
    const length = kept[index].length + 1;
    if (used + length > max && chosen.size) continue;
    chosen.add(index);
    used += length;
  }
  const parts = [];
  kept.forEach((paragraph, index) => {
    if (chosen.has(index)) parts.push(paragraph);
    else if (parts.at(-1) !== '[…]') parts.push('[…]');
  });
  return `${parts.join('\n')}\n[Parts of this section that do not bear on the question are omitted; the full text is at the source.]`;
};

/** The tag an answer cites a provision by: "[Article 21]", "[BNS s.38]". */
export const citationTag = (act, label) => (act === 'COI' || !act
  ? (label.startsWith('Art.') ? `Article ${label.slice(4)}` : humanLabel(label))
  : `${act} ${label}`);

const actIdFor = (store, code) => {
  if (code === 'COI') return store.findAct(CONSTITUTION);
  const act = CENTRAL_ACTS[code];
  return act ? store.findAct(actRecord(act)) : null;
};

/** Official text of one section of a Central Act as evidence. */
const sectionEvidence = (code, version, { note = null, budget = MAX_EVIDENCE_CHARS, focus = null } = {}) => {
  const act = CENTRAL_ACTS[code];
  const footnotes = JSON.parse(version.footnotes || '[]');
  const context = JSON.parse(version.context || 'null');
  const where = [context?.chapter && `${context.chapter}${context.chapterTitle ? ` (${context.chapterTitle})` : ''}`, context?.group]
    .filter(Boolean).join('; ');
  const number = version.label.replace(/^s\./, '');
  const lines = [
    `${act.shortTitle}, section ${number}${version.heading ? ` — ${version.heading}` : ''}. Cite it as [${citationTag(code, version.label)}].`,
    where ? `Location: ${where}.` : null,
    note,
    `Official text (Gazette of India ${version.gazette_ref || act.gazetteId}), in force since ${version.valid_from}:`,
    condenseSection(version.text, budget, focus),
    ...footnotes.filter((item) => item.pending).map((item) => `NOT IN FORCE — ${item.text}`),
  ];
  return {
    kind: 'statute',
    act: code,
    label: version.label,
    url: version.source_url,
    domain: hostOf(version.source_url) ?? 'egazette.gov.in',
    title: `${act.shortTitle} — section ${number}${version.heading ? ` (${version.heading})` : ''}`,
    content: lines.filter(Boolean).join('\n'),
    retrievedAt: new Date().toISOString(),
  };
};

const statuteEvidence = (label, version, { note = null, budget = MAX_EVIDENCE_CHARS, focus = null } = {}) => {
  const footnotes = JSON.parse(version.footnotes || '[]');
  const context = JSON.parse(version.context || 'null');
  const where = [context?.part, context?.chapter, context?.group].filter(Boolean).join('; ');
  const lines = [
    `Constitution of India, ${humanLabel(label)}${version.heading && label.startsWith('Art.') ? ` — ${version.heading}` : ''}. Cite it as [${citationTag('COI', label)}].`,
    where ? `Location: ${where}.` : null,
    note,
    `Official text, in force since ${version.valid_from}${version.amended_by_ref ? ` (last amended by the ${version.amended_by_ref})` : ''}:`,
    condenseSection(version.text, budget, focus),
    ...footnotes.filter((note) => note.invalidated).map((note) => `CAUTION — the printed text includes an amendment a court invalidated: ${note.text}`),
    ...footnotes.filter((note) => note.pending).map((note) => `PENDING — an amendment never brought into force: ${note.text}`),
  ];
  return {
    kind: 'statute',
    act: 'COI',
    label,
    url: version.source_url,
    domain: hostOf(version.source_url) ?? 'legislative.gov.in',
    title: `Constitution of India — ${humanLabel(label).replace(/^the /, '')}`,
    content: lines.filter(Boolean).join('\n'),
    retrievedAt: new Date().toISOString(),
  };
};

/** Whether a correspondence row is LawBuddy's text alignment rather than the official MHA/NCRB table. */
export const isAlignedRow = (row) => String(row.chapter || '').startsWith('text alignment');

const correspondenceEvidence = ({ act, label }, rows) => {
  const aligned = rows.every(isAlignedRow);
  const describe = (row) => {
    const neu = row.new_label ? `${row.new_act} ${row.new_label}${row.new_title ? ` (${row.new_title})` : ''}` : null;
    const old = row.old_label ? `${row.old_act} ${row.old_label}${row.old_title ? ` (${row.old_title})` : ''}` : null;
    if (row.kind === 'new') return `${neu} is a new provision with no counterpart in the ${row.old_act}.`;
    if (row.kind === 'deleted') return `${old} was deleted; it has no counterpart in the ${row.new_act}.`;
    if (isAlignedRow(row)) {
      const shared = /(\d+)%/.exec(row.chapter)?.[1];
      return `${old} is carried forward in ${neu}${shared ? `: ${shared}% of the new wording is shared with it` : ''}${row.changed ? ', so it was reworded or extended' : ''}.`;
    }
    return `${old} corresponds to ${neu}${row.changed ? ', with changes' : ''}${row.kind === 'merged' ? ' (merged with other old provisions)' : ''}.`;
  };
  return {
    kind: 'correspondence',
    lookup: { act, section: label },
    url: rows[0].source_url,
    domain: hostOf(rows[0].source_url) ?? 'ncrb.gov.in',
    title: aligned
      ? `Old and new law, by LawBuddy's text alignment — ${act} ${label}`
      : `Official correspondence table (MHA/NCRB Sankalan) — ${act} ${label}`,
    content: [
      aligned
        ? `LawBuddy's alignment of the official text of the new code with a bare-act copy of the repealed ${act} (not the official MHA/NCRB table) for ${act} ${label}:`
        : `Official correspondence table published by MHA/NCRB (Sankalan of New Criminal Laws) for ${act} ${label}:`,
      ...rows.map(describe),
    ].join('\n'),
    retrievedAt: new Date().toISOString(),
  };
};

/**
 * Builds pipeline evidence for the detected references from the legal store.
 * Section references with no stored correspondence add nothing (the table may
 * simply not be imported yet), so absence is only ever asserted for the
 * Constitution, whose full official text is stored.
 */
export const retrieveLegalEvidence = ({ store, references, asOf = new Date().toISOString().slice(0, 10) }) => {
  const evidence = [];
  const constitutionId = references.constitution.length ? store.findAct(CONSTITUTION) : null;
  const source = constitutionId ? store.actSource(constitutionId) : null;

  for (const label of references.constitution.slice(0, MAX_PROVISIONS)) {
    if (!constitutionId) break;
    const version = store.getProvisionAsOf({ actId: constitutionId, label, date: asOf });
    if (version) {
      evidence.push(statuteEvidence(label, version));
    } else {
      evidence.push({
        kind: 'statute-absence',
        label,
        url: source?.source_url ?? null,
        domain: hostOf(source?.source_url) ?? 'legislative.gov.in',
        title: `Constitution of India — ${humanLabel(label).replace(/^the /, '')} (not found)`,
        content: `The stored official text of the Constitution of India has no ${humanLabel(label)} in force on ${asOf}. Do not describe its contents; say it could not be verified in the official text.`,
        retrievedAt: new Date().toISOString(),
      });
    }
  }

  for (const reference of references.sections.slice(0, MAX_PROVISIONS)) {
    const actId = actIdFor(store, reference.act);
    const version = actId ? store.getProvisionAsOf({ actId, label: reference.label.replace(/\(.*$/, ''), date: asOf }) : null;
    if (version) evidence.push(sectionEvidence(reference.act, version));
    const rows = store.findCorrespondence(reference);
    if (rows.length) evidence.push(correspondenceEvidence(reference, rows));
    // A repealed code's section: teach from the official text of its successor in force.
    if (!version) {
      const successors = [...new Set(rows.filter((row) => row.kind === 'mapped' && row.old_act === reference.act && row.new_label)
        .map((row) => `${row.new_act}|${row.new_label.replace(/\(.*$/, '')}`))].slice(0, 2);
      for (const key of successors) {
        const [code, successor] = key.split('|');
        const successorId = actIdFor(store, code);
        const current = successorId ? store.getProvisionAsOf({ actId: successorId, label: successor, date: asOf }) : null;
        if (current) {
          evidence.push(sectionEvidence(code, current, {
            note: `In force in place of the repealed ${reference.act} ${reference.label} (by LawBuddy's text alignment of the two codes).`,
          }));
        }
      }
    }
  }
  return evidence;
};

const MAX_CONCEPT_PROVISIONS = 8;
const PER_ROLE_FIRST = 2;
// Characters of official text per provision, by the part it plays in the answer: about 2,000 tokens for a
// full set, so a question fits a tokens-per-minute quota with room for the answer.
const ROLE_BUDGET = Object.freeze({
  allows: 1000, right: 1300, forbids: 1300, limits: 1600, duty: 1000, procedure: 1600, consequence: 800,
});

/** Up to PER_ROLE_FIRST provisions of each role first, so every side of the question is represented. */
const balanceRoles = (provisions, limit) => {
  const chosen = [];
  for (const role of [...new Set(provisions.map((provision) => provision.role))]) {
    chosen.push(...provisions.filter((provision) => provision.role === role).slice(0, PER_ROLE_FIRST));
  }
  for (const provision of provisions) if (!chosen.includes(provision)) chosen.push(provision);
  return chosen.slice(0, limit);
};

/**
 * Evidence for the legal concepts a question raises: each mapped provision's official text, with the
 * reason it was retrieved. A provision whose official heading does not match the concept index is dropped
 * with a warning: the index must never put the wrong law in front of the model.
 */
export const conceptEvidence = ({ store, analysis, asOf }) => {
  const evidence = [];
  const warnings = [];
  const names = new Map(analysis.concepts.map((concept) => [concept.id, concept.name]));
  for (const provision of balanceRoles(analysis.provisions, MAX_CONCEPT_PROVISIONS)) {
    const actId = actIdFor(store, provision.act);
    const version = actId ? store.getProvisionAsOf({ actId, label: provision.label, date: asOf }) : null;
    if (!version) {
      warnings.push(`${citationTag(provision.act, provision.label)} is not in the library.`);
      continue;
    }
    if (!provision.expect.test(String(version.heading || '').replace(/\.$/, ''))) {
      warnings.push(`${citationTag(provision.act, provision.label)} was skipped: its official heading "${version.heading}" does not match the concept index.`);
      continue;
    }
    const note = roleNote({ ...provision, conceptName: names.get(provision.concept) });
    const shaping = { note, budget: ROLE_BUDGET[provision.role] ?? MAX_EVIDENCE_CHARS, focus: analysis.focus };
    evidence.push(provision.act === 'COI'
      ? { ...statuteEvidence(provision.label, version, shaping), via: 'concept', role: provision.role }
      : { ...sectionEvidence(provision.act, version, shaping), via: 'concept', role: provision.role });
  }
  return { evidence, warnings };
};

/**
 * Opens the legal store lazily: node:sqlite is only loaded once LawBuddy is
 * actually used, and a store ingested after server start is picked up.
 */
export const createLegalStoreLoader = ({ store = null, dbPath = config.LEGAL_DB_PATH } = {}) => {
  let storePromise = store ? Promise.resolve(store) : null;
  return {
    async get() {
      if (!storePromise) {
        storePromise = fs.existsSync(dbPath)
          ? import('../store/db.js').then((module) => module.openLegalStore(dbPath))
          : Promise.resolve(null);
      }
      const opened = await storePromise;
      if (!opened) storePromise = null;
      return opened;
    },
    async close() {
      if (store || !storePromise) return;
      (await storePromise)?.close();
      storePromise = null;
    },
  };
};

// A search hit is only used when it scores at least this share of the best hit (BM25, lower is better):
// "can the police detain me" keeps Article 22 and drops provisions that merely mention "police".
const RELATIVE_SCORE_CUTOFF = 0.6;
// ...and when it contains at least half of the question's meaningful words: "how do Kubernetes pods
// work?" must not surface Articles 41-43 just because they mention "work".
const MIN_TERM_COVERAGE = 0.5;

const CODE_BY_TITLE = new Map([
  [CONSTITUTION.shortTitle, 'COI'],
  ...Object.values(CENTRAL_ACTS).map((act) => [act.shortTitle, act.code]),
]);

const searchEvidence = (store, question, asOf, limit) => {
  // Any-word search ranked by BM25: provisions matching more (and rarer) words of the question rank first.
  const hits = store.searchProvisions(question, { limit, match: 'any' });
  const best = hits[0]?.score ?? 0;

  return hits
    .filter((hit) => hit.score <= best * RELATIVE_SCORE_CUTOFF)
    .filter((hit) => {
      const { matched, total } = store.termCoverage(hit.version_id, question);
      return total > 0 && matched / total >= MIN_TERM_COVERAGE;
    })
    .map((hit) => {
      const code = CODE_BY_TITLE.get(hit.short_title);
      const actId = code ? actIdFor(store, code) : null;
      const version = actId ? store.getProvisionAsOf({ actId, label: hit.label, date: asOf }) : null;
      return version ? { code, version } : null;
    })
    .filter(Boolean)
    .map(({ code, version }) => {
      const evidence = code === 'COI' ? statuteEvidence(version.label, version) : sectionEvidence(code, version);
      return {
        ...evidence,
        via: 'search',
        title: `${evidence.title} (found by search)`,
        content: `Found by searching the official text for the student's question; teach it only if it answers that question.\n${evidence.content}`,
      };
    });
};

/**
 * Attaches the question analysis (kind, concepts, the answer format) to the evidence for the prompt, as a
 * non-enumerable property: the evidence stays a plain array of evidence items for every other reader.
 */
const withAnalysis = (evidence, analysis, warnings = []) => Object.defineProperty(evidence, 'analysis', {
  value: {
    kind: analysis.kind,
    concepts: analysis.concepts,
    direction: evidence.length ? answerDirection(analysis.kind) : null,
    warnings,
  },
  enumerable: false,
});

/**
 * Retriever for the /lawbuddy route ("cite-or-silence"): named provisions are
 * grounded exactly; otherwise the official text is searched; otherwise there
 * is no evidence and the law-mode prompt tells the student so.
 */
export const createLawRetriever = ({ loader, asOf, searchLimit = 3 }) => async (params) => {
  const store = await loader.get();
  if (!store) return [];
  const date = asOf ?? new Date().toISOString().slice(0, 10);

  const analysis = analyseQuestion(params.text);
  const references = detectLegalReferences(params.text);
  if (references.constitution.length || references.sections.length) {
    const evidence = retrieveLegalEvidence({ store, references, asOf: date });
    if (evidence.length) return withAnalysis(evidence, analysis);
  }
  // The question's legal concepts ("protecting myself" → private defence; "kill" → culpable homicide).
  if (analysis.provisions.length) {
    const { evidence, warnings } = conceptEvidence({ store, analysis, asOf: date });
    if (evidence.length) return withAnalysis(evidence, analysis, warnings);
  }
  return withAnalysis(searchEvidence(store, params.text, date, searchLimit), analysis);
};
