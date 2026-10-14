/**
 * Parser for NCRB "Sankalan" Corresponding Section Tables (MHA's official
 * old↔new criminal-law mapping): BNS↔IPC, BNSS↔CrPC, BSA↔Indian Evidence Act.
 *
 * Each data row pairs a new-law cell with an old-law cell. Row kinds:
 *   mapped   — one new provision ↔ one old provision ("(Change)" marks a modified one)
 *   merged   — one new provision ↔ several old provisions (one entry per old provision)
 *   new      — new provision with no old counterpart ("New Section" / "New Sub-Section")
 *   deleted  — old provision dropped ("Deleted")
 * Chapter rows set context; group headings and parent rows without a
 * counterpart are skipped; anything unrecognised is reported, never guessed.
 */

import { extractTableRows } from './html.js';

export const ACT_CODES = Object.freeze({
  'BHARATIYA NYAYA SANHITA, 2023': 'BNS',
  'INDIAN PENAL CODE, 1860': 'IPC',
  'BHARATIYA NAGARIK SURAKSHA SANHITA, 2023': 'BNSS',
  'CODE OF CRIMINAL PROCEDURE, 1973': 'CrPC',
  'BHARATIYA SAKSHYA ADHINIYAM, 2023': 'BSA',
  'INDIAN EVIDENCE ACT, 1872': 'IEA',
});

const SUBDIVISION = String.raw`\(\s*(?:\d{1,3}[A-Za-z]?|[a-z]{1,2}|[ivxl]{1,7})\s*\)`;
const REF = new RegExp(String.raw`(\d{1,3}[A-Z]{0,2})((?:\s*${SUBDIVISION})*)(\.?)`, 'y');
const CHANGE_MARK = /\s*\(Change\)\s*$/i;

const toLabel = (section, subdivisions) =>
  `s.${section}${(subdivisions.match(/\(\s*([^)]+?)\s*\)/g) || []).map((part) => part.replace(/\s+/g, '')).join('')}`;

/**
 * Finds provision references that start at the beginning of `text` or right
 * after a full stop, e.g. "231. Counterfeiting coin. 255.Counterfeiting ..."
 * or "65B (3) (a) by a combination of computers ...". A number in running
 * prose ("punishable by section 121.") is never taken as a reference.
 */
export const scanRefs = (text, { startOnly = false } = {}) => {
  const starts = [0];
  if (!startOnly) {
    for (const match of text.matchAll(/\.\s*/g)) starts.push(match.index + match[0].length);
  }

  const found = [];
  for (const start of starts) {
    if (found.length && start < found[found.length - 1].end) continue;
    REF.lastIndex = start;
    const match = REF.exec(text);
    if (!match) continue;

    const [whole, section, subdivisions, dot] = match;
    const after = text.slice(start + whole.length);
    // "302. Punishment for murder." — a numbered heading.
    const isHeading = dot === '.' && /^\s*(?:[A-Z“‘"(]|$)/.test(after);
    // "1(2)", "178 (5)", "65B (3) (a) by a combination ..." — a bare sub-division reference.
    const isSubdivision = subdivisions.trim() !== '' && dot === '' && /^(?:\s|$)/.test(after);
    if (!isHeading && !isSubdivision) continue;

    found.push({ label: toLabel(section, subdivisions), start, end: start + whole.length });
  }

  return found.map((ref, index) => {
    const titleEnd = index + 1 < found.length ? found[index + 1].start : text.length;
    const title = text.slice(ref.end, titleEnd).replace(CHANGE_MARK, '').trim() || null;
    return { label: ref.label, title };
  });
};

const isChapterRow = (paragraphs) => /^(PART|CHAPTER)\b/i.test(paragraphs[0] || '');

/**
 * @returns {{ newAct: string, oldAct: string, entries: Array<{kind: string, newLabel: string|null,
 *   newTitle: string|null, oldLabel: string|null, oldTitle: string|null, changed: boolean,
 *   chapter: string|null}>, unparsed: Array<{newCell: string, oldCell: string}> }}
 */
export const parseSankalanTable = (html) => {
  const rows = extractTableRows(html).filter((cells) => cells.length === 2);
  const headerIndex = rows.findIndex((cells) =>
    cells.every((cell) => ACT_CODES[cell.paragraphs.join(' ').toUpperCase()]),
  );
  if (headerIndex === -1) {
    throw new Error('Not a Sankalan correspondence table: no header row naming two known Acts');
  }

  const [newAct, oldAct] = rows[headerIndex].map((cell) => ACT_CODES[cell.paragraphs.join(' ').toUpperCase()]);
  const entries = [];
  const unparsed = [];
  let chapter = null;

  for (const [newCell, oldCell] of rows.slice(headerIndex + 1)) {
    const newParas = newCell.paragraphs;
    const oldText = oldCell.paragraphs.join(' ');

    if (isChapterRow(newParas)) {
      chapter = newParas.join(' — ');
      continue;
    }

    const isDeleted = /^Deleted\b/i.test(newParas[0] || '');
    const isNew = /^New\s+(Sub-?)?Section\b/i.test(oldText);
    const newRefs = isDeleted ? [] : newParas.flatMap((paragraph) => scanRefs(paragraph, { startOnly: true }));
    const oldRefs = isNew ? [] : scanRefs(oldText);

    if (!isDeleted && newRefs.length === 0) {
      // Group heading such as "Of right of private defence": context only.
      if (oldRefs.length === 0 && !isNew) continue;
      unparsed.push({ newCell: newParas.join(' ¶ '), oldCell: oldText });
      continue;
    }

    const newRef = newRefs.length ? newRefs[newRefs.length - 1] : null;
    const newTitle = newRefs.find((ref) => ref.title)?.title ?? null;
    const changed = CHANGE_MARK.test(newParas.join(' '));
    const base = { newLabel: newRef?.label ?? null, newTitle, changed, chapter };

    if (isNew) {
      entries.push({ ...base, kind: 'new', oldLabel: null, oldTitle: null });
    } else if (oldRefs.length === 0) {
      // A parent row ("2. Definitions. (Change)") whose sub-rows carry the mapping.
      if (!oldText && !isDeleted) continue;
      unparsed.push({ newCell: newParas.join(' ¶ '), oldCell: oldText });
    } else {
      const kind = isDeleted ? 'deleted' : oldRefs.length > 1 ? 'merged' : 'mapped';
      for (const oldRef of oldRefs) {
        entries.push({ ...base, kind, oldLabel: oldRef.label, oldTitle: oldRef.title });
      }
    }
  }

  return { newAct, oldAct, entries, unparsed };
};
