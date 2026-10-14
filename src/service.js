/**
 * LawBuddy read operations shared by the CLI and the /lawbuddy HTTP routes,
 * so both return the same answers: a provision as in force on a date, a
 * full-text search, and the official old↔new section correspondence.
 */

import { CONSTITUTION_ACT } from './ingest/constitution.js';
import { CENTRAL_ACTS, actRecord } from './ingest/act.js';

const ACT_ALIASES = Object.freeze({ bns: 'BNS', ipc: 'IPC', bnss: 'BNSS', crpc: 'CrPC', bsa: 'BSA', iea: 'IEA' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const today = () => new Date().toISOString().slice(0, 10);

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
  if (!ISO_DATE.test(date)) return { ok: false, status: 400, error: 'asOf must be a date like 2026-10-12' };

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

/** One section of a stored Central Act (BNS, BNSS, BSA) as in force on a date, shaped like an Article. */
export const getActProvision = (store, actInput, sectionInput, date = today()) => {
  const act = CENTRAL_ACTS[String(actInput ?? '').toUpperCase()];
  const label = toSectionLabel(sectionInput)?.replace(/\(.*$/, '');
  if (!act || !label) return { ok: false, status: 400, error: `Use an Act (${Object.keys(CENTRAL_ACTS).join(', ')}) and a section like 38` };
  if (!ISO_DATE.test(date)) return { ok: false, status: 400, error: 'asOf must be a date like 2026-10-12' };
  const actId = store.findAct(actRecord(act));
  const version = actId ? store.getProvisionAsOf({ actId, label, date }) : null;
  if (!version) return { ok: false, status: 404, act: act.code, label, asOf: date, error: `${act.shortTitle} has no section ${label.slice(2)} in force on that date in the library` };
  const footnotes = JSON.parse(version.footnotes || '[]');
  return {
    ok: true,
    act: act.code,
    actTitle: act.shortTitle,
    label,
    heading: version.heading,
    context: JSON.parse(version.context || 'null'),
    asOf: date,
    inForceSince: version.valid_from,
    gazette: version.gazette_ref,
    text: version.text,
    caution: null,
    judicialNotes: [],
    pendingAmendments: footnotes.filter((note) => note.pending).map((note) => note.text),
    amendmentHistory: [],
    source: { url: version.source_url, sha256: version.source_sha256 },
  };
};

export const searchLaw = (store, query, { limit = 8 } = {}) => {
  const words = String(query ?? '').trim();
  if (!words) return { ok: false, status: 400, error: 'Search words are required' };
  const hits = store.searchProvisions(words, { limit, match: 'any' });
  return {
    ok: hits.length > 0,
    status: hits.length ? 200 : 404,
    query: words,
    hits: hits.map(({ label, heading, short_title: act, snippet }) => ({ label, heading, act, snippet })),
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
