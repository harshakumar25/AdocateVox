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
import { PRACTICE_ACTS } from '../ingest/libraryCatalog.js';
import { isCitableOfficialSource } from '../sources/registry.js';
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

const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
const catalogueReferences = PRACTICE_ACTS
  .filter((entry) => entry.jurisdiction === 'IN' && entry.instrumentType !== 'standard'
    && !['COI', 'IEA1872', 'BNS2023', 'BNSS2023', 'BSA2023'].includes(entry.id))
  .flatMap((entry) => [entry.title, ...entry.aliases.filter((alias) => /\b(?:act|code|rules|directions|sanhita|adhiniyam)\b/i.test(alias) || /^(?:bns|bnss|bsa|dpdp|pmla|cpc|ibc)$/i.test(alias))]
    .map((name) => {
      const pattern = escapeRegex(name);
      const unit = entry.instrumentType === 'rules' ? String.raw`(?:rules?|r\.)` : String.raw`(?:sections?|sec\.?|s\.)`;
      const number = String.raw`(\d{1,3}[A-Z]{0,2})`;
      const subsection = String.raw`((?:\s*\(\s*\w{1,4}\s*\))*)`;
      return {
        entry,
        after: new RegExp(String.raw`\b` + unit + String.raw`\s*` + number + subsection + String.raw`\s*(?:of\s+(?:the\s+)?)?` + pattern + String.raw`\b`, 'gi'),
        before: new RegExp(String.raw`\b` + pattern + String.raw`\s+` + unit + String.raw`\s*` + number + subsection, 'gi'),
      };
    }));

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
  const addSection = (act, number, subsection = '', prefix = 's.') => {
    const label = `${prefix}${number.toUpperCase()}`;
    const normalizedSubsection = subsection.replace(/\s+/g, '').toUpperCase();
    if (act && !sections.some((s) => s.act === act && s.label === label && (s.subsection || '') === normalizedSubsection)) {
      sections.push({ act, label, ...(normalizedSubsection ? { subsection: normalizedSubsection } : {}) });
    }
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
  for (const [, number, subsection, act] of value.matchAll(new RegExp(String.raw`\b(?:sections?|sec\.?|s\.)\s*(\d{1,3}[A-Z]{0,2})((?:\s*\(\s*\w{1,4}\s*\))*)\s*(?:of\s+(?:the\s+)?)?(${ACT_NAMES})`, 'gi'))) {
    addSection(toActCode(act), number, subsection);
  }
  // "IPC 302", "BNS s. 103"
  for (const [, act, number, subsection] of value.matchAll(new RegExp(String.raw`\b(IPC|BNSS|BNS|CrPC|BSA|IEA)\s*(?:sections?|sec\.?|s\.)?\s*(\d{1,3}[A-Z]{0,2})\b((?:\s*\(\s*\w{1,4}\s*\))*)`, 'gi'))) {
    addSection(toActCode(act), number, subsection);
  }
  // "302 IPC"
  for (const [, number, subsection, act] of value.matchAll(/\b(\d{1,3}[A-Z]{0,2})((?:\s*\(\s*\w{1,4}\s*\))*)\s+(IPC|BNSS|BNS|CrPC|BSA|IEA)\b/gi)) addSection(toActCode(act), number, subsection);

  // Exact instrument names and unambiguous aliases; a practice-area label alone is not a legal citation.
  for (const { entry, after, before } of catalogueReferences) {
    for (const [, n, sub] of value.matchAll(after)) addSection(entry.id, n, sub, entry.instrumentType === 'rules' ? 'r.' : 's.');
    for (const [, n, sub] of value.matchAll(before)) addSection(entry.id, n, sub, entry.instrumentType === 'rules' ? 'r.' : 's.');
  }

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
export const citationTag = (act, label) => {
  if (act === 'COI' || !act) return label.startsWith('Art.') ? `Article ${label.slice(4)}` : humanLabel(label);
  const catalogued = PRACTICE_ACTS.find((entry) => entry.id === act && !['BNS2023', 'BNSS2023', 'BSA2023'].includes(entry.id));
  return `${catalogued?.title || act} ${label}`;
};

const actIdFor = (store, code) => {
  if (code === 'COI') return store.findAct(CONSTITUTION);
  const act = CENTRAL_ACTS[code];
  if (act) return store.findAct(actRecord(act));
  const catalogued = PRACTICE_ACTS.find((entry) => entry.id === code && entry.jurisdiction === 'IN');
  return catalogued ? store.findAct({ shortTitle: catalogued.title, year: catalogued.year }) : null;
};

/** Official text of one section of a Central Act as evidence. */
const sectionEvidence = (code, version, { note = null, budget = MAX_EVIDENCE_CHARS, focus = null } = {}) => {
  const act = CENTRAL_ACTS[code] || PRACTICE_ACTS.find((entry) => entry.id === code && entry.jurisdiction === 'IN');
  if (!act || !isCitableOfficialSource(version.source_url, version.source_sha256)) return null;
  const title = act.shortTitle || act.title;
  const footnotes = JSON.parse(version.footnotes || '[]');
  const context = JSON.parse(version.context || 'null');
  const where = [context?.chapter && `${context.chapter}${context.chapterTitle ? ` (${context.chapterTitle})` : ''}`, context?.group]
    .filter(Boolean).join('; ');
  const number = version.label.replace(/^[sr]\./, '');
  const unit = act.instrumentType === 'rules' ? 'rule' : 'section';
  const lines = [
    `${title}, ${unit} ${number}${version.heading ? ` — ${version.heading}` : ''}. Cite it as [${citationTag(code, version.label)}].`,
    where ? `Location: ${where}.` : null,
    note,
    version.gazette_ref ? `Official text (Gazette of India ${version.gazette_ref}), indexed as in force since ${version.valid_from}:`
      : `Stored official-source text, indexed as in force since ${version.valid_from}; verify amendments and commencement against the linked source:`,
    version.verified_through ? `This edition was reviewed through ${version.verified_through}; it is unavailable for later as-of dates until a newer edition is checked.` : null,
    condenseSection(version.text, budget, focus),
    ...footnotes.filter((item) => item.pending).map((item) => `NOT IN FORCE — ${item.text}`),
    ...footnotes.filter((item) => item.invalidated).map((item) => `JUDICIAL CAUTION — ${item.text}`),
  ];
  return {
    kind: 'statute',
    act: code,
    label: version.label,
    url: version.source_url,
    domain: hostOf(version.source_url),
    title: `${title} — ${unit} ${number}${version.heading ? ` (${version.heading})` : ''}`,
    content: lines.filter(Boolean).join('\n'),
    retrievedAt: new Date().toISOString(),
  };
};

const statuteEvidence = (label, version, { note = null, budget = MAX_EVIDENCE_CHARS, focus = null } = {}) => {
  if (!isCitableOfficialSource(version.source_url, version.source_sha256)) return null;
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
      const item = statuteEvidence(label, version);
      if (item) evidence.push(item);
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
    if (version) {
      const item = sectionEvidence(reference.act, version);
      if (item) evidence.push(item);
    }
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
          const item = sectionEvidence(code, current, {
            note: `In force in place of the repealed ${reference.act} ${reference.label} (by LawBuddy's text alignment of the two codes).`,
          });
          if (item) evidence.push(item);
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
  scope: 1300, liability: 1000,
});
// A situation raises several issues, so it gets more provisions, each kept shorter (same total budget).
const SCENARIO_PROVISIONS = 11;
const SCENARIO_BUDGET_SHARE = 0.7;

/**
 * Every concept's lead provision first (a situation raising five issues needs all five), then up to
 * PER_ROLE_FIRST provisions of each role, so every side of the question is represented, then the rest.
 */
const balanceRoles = (provisions, limit) => {
  const chosen = [];
  for (const concept of [...new Set(provisions.map((provision) => provision.concept))]) {
    const own = provisions.filter((provision) => provision.concept === concept);
    chosen.push(own.reduce((lead, provision) => ((provision.rank ?? 0) < (lead.rank ?? 0) ? provision : lead)));
  }
  for (const role of [...new Set(provisions.map((provision) => provision.role))]) {
    for (const provision of provisions.filter((item) => item.role === role).slice(0, PER_ROLE_FIRST)) {
      if (!chosen.includes(provision)) chosen.push(provision);
    }
  }
  for (const provision of provisions) if (!chosen.includes(provision)) chosen.push(provision);
  // Presented in role order (what permits it, then what forbids it…), whatever order they were chosen in.
  return chosen.slice(0, limit).sort((a, b) => provisions.indexOf(a) - provisions.indexOf(b));
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
  const scenario = analysis.kind === 'scenario';
  for (const provision of balanceRoles(analysis.provisions, scenario ? SCENARIO_PROVISIONS : MAX_CONCEPT_PROVISIONS)) {
    const actId = actIdFor(store, provision.act);
    const version = actId ? store.getProvisionAsOf({ actId, label: provision.label, date: asOf }) : null;
    if (!version) {
      const prior = actId ? store.lastProvisionReview?.({ actId, label: provision.label }) : null;
      warnings.push(prior?.verified_through < asOf
        ? `${citationTag(provision.act, provision.label)} was last verified through ${prior.verified_through}, not ${asOf}.`
        : `${citationTag(provision.act, provision.label)} is not in the library.`);
      continue;
    }
    if (!provision.expect.test(String(version.heading || '').replace(/\.$/, ''))) {
      warnings.push(`${citationTag(provision.act, provision.label)} was skipped: its official heading "${version.heading}" does not match the concept index.`);
      continue;
    }
    const note = roleNote({ ...provision, conceptName: names.get(provision.concept) });
    const budget = Math.round((ROLE_BUDGET[provision.role] ?? MAX_EVIDENCE_CHARS) * (scenario ? SCENARIO_BUDGET_SHARE : 1));
    const shaping = { note, budget, focus: analysis.focus };
    const item = provision.act === 'COI'
      ? statuteEvidence(provision.label, version, shaping)
      : sectionEvidence(provision.act, version, shaping);
    if (item) evidence.push({ ...item, via: 'concept', role: provision.role });
    else warnings.push(`${citationTag(provision.act, provision.label)} was skipped: source provenance is incomplete or not official.`);
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
  ...PRACTICE_ACTS.filter((act) => act.jurisdiction === 'IN' && act.instrumentType !== 'standard').map((act) => [act.title, act.id]),
  ...Object.values(CENTRAL_ACTS).map((act) => [act.shortTitle, act.code]),
]);

const searchEvidence = (store, question, asOf, limit) => {
  // Any-word search ranked by BM25: provisions matching more (and rarer) words of the question rank first.
  const hits = store.searchProvisions(question, { asOf, limit, match: 'any', officialOnly: true });
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
      if (!evidence) return null;
      return {
        ...evidence,
        via: 'search',
        title: `${evidence.title} (found by search)`,
        content: `Found by searching the official text for the student's question; teach it only if it answers that question.\n${evidence.content}`,
      };
    }).filter(Boolean);
};

/**
 * Attaches the question analysis (kind, concepts, the answer format) to the evidence for the prompt, as a
 * non-enumerable property: the evidence stays a plain array of evidence items for every other reader.
 */
const withAnalysis = (evidence, analysis, warnings = [], coverage = null) => Object.defineProperty(evidence, 'analysis', {
  value: {
    kind: analysis.kind,
    concepts: analysis.concepts,
    direction: evidence.length ? answerDirection(analysis.kind) : null,
    warnings,
    ...(coverage ? { coverage } : {}),
    // The question itself, so the answer check can tell a quotation of the question from one of the law.
    question: analysis.question ?? null,
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

  const analysis = { ...analyseQuestion(params.text), question: String(params.text || '') };
  const references = detectLegalReferences(params.text);
  // A named procedural section must not short-circuit the merits of a cyber-defence question.
  // Require both independently verified IT Act provisions, including their expected headings,
  // before any other evidence is allowed into the answer prompt.
  if (analysis.concepts.some((concept) => concept.id === 'unauthorised-security-testing')) {
    const { evidence: core, warnings } = conceptEvidence({ store, analysis, asOf: date });
    const missing = ['s.43', 's.66'].filter((label) => !core.some((item) => item.kind === 'statute' && item.act === 'IT2000' && item.label === label));
    if (missing.length) {
      const itActId = actIdFor(store, 'IT2000');
      const missingProvisions = missing.map((label) => {
        const reviewedThrough = itActId ? store.lastProvisionReview?.({ actId: itActId, label })?.verified_through : null;
        return { act: 'IT2000', label, ...(reviewedThrough ? { reviewedThrough } : {}) };
      });
      return withAnalysis([], analysis, [
        `Information Technology Act, 2000 ${missing.map((label) => `section ${label.slice(2)}`).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} needed to answer this question but verified text is not indexed for ${date}.`,
        ...warnings,
      ], { status: 'unavailable', missing: missingProvisions, asOf: date });
    }
    const named = references.constitution.length || references.sections.length
      ? retrieveLegalEvidence({ store, references, asOf: date }) : [];
    const seen = new Set();
    const evidence = [...core, ...named].filter((item) => {
      const key = item.kind === 'statute' ? `${item.act}:${item.label}` : `${item.kind}:${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return withAnalysis(evidence, analysis, warnings, { status: 'ready', missing: [], asOf: date });
  }
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
