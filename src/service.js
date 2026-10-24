/**
 * LawBuddy read operations shared by the CLI and the /lawbuddy HTTP routes,
 * so both return the same answers: a provision as in force on a date, a
 * full-text search, and the official old↔new section correspondence.
 */

import { CONSTITUTION_ACT } from './ingest/constitution.js';
import { CENTRAL_ACTS, actRecord } from './ingest/act.js';
import { PRACTICE_ACTS, PRACTICE_TOPICS, cataloguedActs } from './ingest/libraryCatalog.js';
import { isCitableOfficialSource } from './sources/registry.js';

const ACT_ALIASES = Object.freeze({ bns: 'BNS', ipc: 'IPC', bnss: 'BNSS', crpc: 'CrPC', bsa: 'BSA', iea: 'IEA' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validIsoDate = (value) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

const INDIA_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = (instant = new Date()) => {
  const fields = Object.fromEntries(INDIA_DATE.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

/** "21", "art 21a", "Article 21A", "preamble", "sch 7", "Schedule 7" → "Art.21A" / "Preamble" / "Sch.7". */
export const toConstitutionLabel = (input) => {
  const value = String(input ?? '').trim();
  if (/^preamble$/i.test(value)) return 'Preamble';
  const schedule = /^(?:sch\.?|schedule)\s*(\d{1,2})$/i.exec(value);
  if (schedule) return `Sch.${Number(schedule[1])}`;
  const article = /^(?:art\.?|article)?\s*(\d{1,3}[A-Za-z]{0,3})$/i.exec(value);
  return article ? `Art.${article[1].toUpperCase()}` : null;
};

/** "302", "s.302", "section 65B(3)" → "s.302" / "s.65B(3)". */
export const toSectionLabel = (input) => {
  const match = /^(?:s\.?\s*|section\s*)?(\d{1,3}[A-Za-z]{0,2})((?:\s*\([0-9A-Za-z]{1,7}\))*)$/i.exec(String(input ?? '').trim());
  return match ? `s.${match[1].toUpperCase()}${match[2].replace(/\s+/g, '')}` : null;
};

export const toActCode = (input) => ACT_ALIASES[String(input ?? '').toLowerCase()] ?? null;

/**
 * A Constitution provision as in force on `date`, with cautions, pending
 * amendments, amendment history and the official source. `ok: false` when
 * the input is not a provision label or nothing was in force on that date.
 */
export const getConstitutionProvision = (store, input, date = today()) => {
  const label = toConstitutionLabel(input);
  if (!label) return { ok: false, status: 400, error: `"${input}" is not an Article, Schedule or the Preamble` };
  if (!validIsoDate(date)) return { ok: false, status: 400, error: 'asOf must be a date like 2026-10-12' };

  const actId = store.findAct(CONSTITUTION_ACT);
  const version = actId ? store.getProvisionAsOf({ actId, label, date }) : null;
  if (!version) {
    return { ok: false, status: 404, label, asOf: date, error: 'No text in force on that date in the stored official editions' };
  }

  const footnotes = JSON.parse(version.footnotes || '[]');
  return {
    ok: true,
    label,
    heading: version.heading,
    context: JSON.parse(version.context || 'null'),
    asOf: date,
    reviewedThrough: version.verified_through ?? null,
    inForceSince: version.valid_from,
    lastAmendedBy: version.amended_by_ref,
    text: version.text,
    caution: footnotes.some((note) => note.invalidated)
      ? 'The printed text includes an amendment the Supreme Court struck down; see judicialNotes before relying on it.'
      : null,
    judicialNotes: footnotes.filter((note) => note.invalidated).map((note) => note.text),
    pendingAmendments: footnotes.filter((note) => note.pending).map((note) => note.text),
    amendmentHistory: footnotes.filter((note) => !note.pending).map((note) => note.text),
    source: { url: version.source_url, sha256: version.source_sha256 },
  };
};

/** One indexed section or rule on a date, shaped like an Article. */
export const getActProvision = (store, actInput, sectionInput, date = today()) => {
  const key = String(actInput ?? '').toUpperCase();
  const act = CENTRAL_ACTS[key];
  const catalogued = PRACTICE_ACTS.find((entry) => entry.id === key && entry.jurisdiction === 'IN' && entry.instrumentType !== 'standard');
  const normalized = toSectionLabel(String(sectionInput ?? '').replace(/^r(?:ule)?\.?\s*/i, ''));
  const requestedLabel = catalogued?.instrumentType === 'rules' ? normalized?.replace(/^s\./, 'r.') : normalized;
  const label = requestedLabel?.replace(/\(.*$/, '');
  if ((!act && !catalogued) || !label) return { ok: false, status: 400, error: 'Use an indexed Indian Act or rule ID and a provision number like 38.' };
  if (!validIsoDate(date)) return { ok: false, status: 400, error: 'asOf must be a date like 2026-10-12' };
  const actTitle = act?.shortTitle || catalogued.title;
  const actId = store.findAct(act ? actRecord(act) : { shortTitle: catalogued.title, year: catalogued.year });
  const version = actId ? store.getProvisionAsOf({ actId, label, date }) : null;
  if (!version) {
    const prior = actId ? store.lastProvisionReview({ actId, label }) : null;
    const outdated = prior?.verified_through < date;
    return { ok: false, status: 404, act: key, label, asOf: date,
      reason: outdated ? 'edition-not-verified-for-date' : actId ? 'not-indexed-as-of' : 'not-indexed',
      ...(outdated ? { reviewedThrough: prior.verified_through, source: { url: prior.source_url, sha256: prior.source_sha256 } } : {}),
      error: outdated
        ? `${actTitle} section ${label.slice(2)} was last reviewed through ${prior.verified_through}; this library has not verified its text for ${date}.`
        : `${actTitle} has no ${catalogued?.instrumentType === 'rules' ? 'rule' : 'section'} ${label.slice(2)} indexed for that date in the library` };
  }
  if (!isCitableOfficialSource(version.source_url, version.source_sha256)) {
    return { ok: false, status: 404, act: key, label, asOf: date, reason: 'unverified-source', error: 'This provision has no verified official source in the library.' };
  }
  const footnotes = JSON.parse(version.footnotes || '[]');
  const pending = footnotes.filter((note) => note.pending);
  const subsection = /\((\d+[A-Z]?)\)/i.exec(requestedLabel)?.[1] ?? null;
  const excluded = subsection ? pending.find((note) => new RegExp(`(?:sub[- ]?section|section)\\s*\\(${subsection}\\)`, 'i').test(note.text)) : null;
  return {
    ok: true,
    act: act?.code || key,
    actTitle,
    label,
    requestedLabel,
    heading: version.heading,
    context: JSON.parse(version.context || 'null'),
    asOf: date,
    reviewedThrough: version.verified_through ?? null,
    inForceSince: excluded ? null : version.valid_from,
    forceStatus: excluded ? 'not-verified-in-force' : pending.length ? 'commencement-caution' : 'in-force-in-library',
    gazette: version.gazette_ref,
    text: version.text,
    caution: excluded?.text ?? (pending.length ? 'A part of this printed provision has a commencement exception; inspect the notes before relying on any subsection.'
      : act ? null : 'Check later amendments, commencement notifications and applicable subordinate instruments before relying on this indexed version.'),
    judicialNotes: footnotes.filter((note) => note.invalidated).map((note) => note.text),
    pendingAmendments: pending.map((note) => note.text),
    amendmentHistory: [],
    source: { url: version.source_url, sha256: version.source_sha256 },
  };
};

export const searchCatalog = (store, { query = '', topic = '', includeForeign = false, asOf = today() } = {}) => {
  if (String(query).length > 200) return { ok: false, status: 400, error: 'Search terms are too long.' };
  try {
    const items = cataloguedActs(store, { query, topic, includeForeign, asOf });
    const foreignMatch = !includeForeign && PRACTICE_ACTS.find((entry) => entry.jurisdiction !== 'IN'
      && [entry.id, entry.title, ...entry.aliases].some((name) => name.toLowerCase() === String(query).toLowerCase().trim()));
    return {
      ok: true, asOf, topics: PRACTICE_TOPICS, items,
      foreignNotice: foreignMatch ? `${foreignMatch.title} is ${foreignMatch.jurisdiction} law and is excluded from Indian provision search.` : null,
      note: 'An official source link identifies an instrument. Indexed-as-of entries have text for the requested date; indexed-historical entries have older reviewed text only. Acts, rules, directions and technical standards have different legal force; amendments, commencement and local variations still require review.',
    };
  } catch (error) {
    return { ok: false, status: 400, error: error.message };
  }
};

export const searchLaw = (store, query, { limit = 8, act = null, asOf = today() } = {}) => {
  const words = String(query ?? '').trim();
  if (!words) return { ok: false, status: 400, error: 'Search words are required' };
  if (!validIsoDate(asOf)) return { ok: false, status: 400, error: 'asOf must be a date like 2026-10-18' };
  let actId = null;
  let selected = null;
  if (act) {
    const key = String(act).trim().toUpperCase();
    selected = PRACTICE_ACTS.find((entry) => entry.id === key)
      || (CENTRAL_ACTS[key] ? CENTRAL_ACTS[key] : null);
    if (!selected || selected.jurisdiction === 'UK' || selected.instrumentType === 'standard') return { ok: false, status: 400, error: 'Select an Indian Act, rule or direction ID from the library catalogue; technical standards are not statutory provisions.' };
    actId = store.findAct(selected.shortTitle ? actRecord(selected) : { shortTitle: selected.title, year: selected.year });
    if (!actId) return {
      ok: false, status: 404, reason: 'not-indexed', asOf, act: key,
      sourceUrl: selected.sourceUrl ?? selected.officialUrl,
      error: 'This instrument has an official source identified, but its provision text has not been indexed and verified in LawBuddy.',
    };
  }
  const hits = store.searchProvisions(words, { limit, match: 'any', actId, asOf, officialOnly: true })
    .filter((hit) => isCitableOfficialSource(hit.source_url, hit.source_sha256));
  return {
    ok: hits.length > 0,
    status: hits.length ? 200 : 404,
    query: words,
    asOf,
    act: act || null,
    hits: hits.map(({ label, heading, short_title: actTitle, valid_from, source_url, source_sha256, snippet }) => ({
      label, heading, act: actTitle, inForceSince: valid_from,
      source: source_url ? { url: source_url, sha256: source_sha256 } : null, snippet,
    })),
  };
};

export const lookupSection = (store, actInput, sectionInput) => {
  const act = toActCode(actInput);
  const label = toSectionLabel(sectionInput);
  if (!act || !label) return { ok: false, status: 400, error: 'Use an act (BNS IPC BNSS CrPC BSA IEA) and a section like 302 or 65B' };

  const rows = store.findCorrespondence({ act, label });
  return {
    ok: rows.length > 0,
    status: rows.length ? 200 : 404,
    query: `${act} ${label}`,
    matches: rows.map((row) => ({
      kind: row.kind,
      changed: Boolean(row.changed),
      new: row.new_label ? `${row.new_act} ${row.new_label} ${row.new_title ?? ''}`.trim() : `${row.new_act}: —`,
      old: row.old_label ? `${row.old_act} ${row.old_label} ${row.old_title ?? ''}`.trim() : `${row.old_act}: —`,
      source: row.source_url,
      // 'alignment': LawBuddy matched the two texts (with the share of new wording found in the old section);
      // 'official': the MHA/NCRB correspondence table.
      method: String(row.chapter || '').startsWith('text alignment') ? 'alignment' : 'official',
      shared: Number(/(\d+)%/.exec(row.chapter || '')?.[1] ?? NaN) / 100 || null,
    })),
  };
};
