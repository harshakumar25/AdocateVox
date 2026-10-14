/**
 * Old ↔ new correspondence by text alignment: which section of a repealed code (IPC, CrPC, Indian
 * Evidence Act) each sub-section of its replacement (BNS, BNSS, BSA) carries forward.
 *
 * Judgments, textbooks and students' notes cite "Section 302 IPC"; the law in force is BNS s.103(1).
 * The MHA/NCRB correspondence table is the authority, but until it is in the library LawBuddy can
 * derive the correspondence from the two texts themselves: each sub-section of the new code votes, with
 * every six-word run it shares with the old code, for the old section that run sits in. The winning
 * section is recorded with how much of the new wording it shares, so "carried forward unchanged" (≈1)
 * is told apart from "rewritten" (lower). A sub-section sharing too little has no predecessor
 * ("new"). The rows say they are LawBuddy's alignment, never the official table.
 */

const SHINGLE = 6;
const MIN_UNIT_WORDS = 10;
const MIN_SHARED = 0.33;
const SAME_HEADING = 0.7;
const UNCHANGED = 0.9;
const MIN_LEAD = 1.5;
const MAX_NUMBER_JUMP = 12;

const words = (text) => (String(text || '').toLowerCase().normalize('NFKC').match(/[a-z0-9]+/g) || []);

/** Every section heading of the old code's body ("302. Punishment for murder.—"), with its offset. */
export const oldSectionHeadings = (text, { bodyStart = 0 } = {}) => {
  const headings = [];
  // A heading may wrap over lines ("109. Punishment of abetment if the act abetted is committed in
  // consequence and where no express provision is made for its punishment.—"), but never runs into the
  // next numbered heading.
  // A substituted section is printed after an amendment bracket ("1\n[34. Acts done by several persons…").
  // The dash after a heading is an em dash ("—") in some copies and a doubled en dash (" –– ") in others.
  const pattern = /(?:^|\n)\s*\[?\s*(\d{1,3})([A-Z]{0,2})\.\s*((?:(?!\n\s*\[?\s*\d{1,3}[A-Z]{0,2}\.\s)[^—–]){2,320}?)\.?\s*[—–]{1,2}/g;
  pattern.lastIndex = bodyStart;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const number = Number(match[1]);
    // Section numbers only move forward, a few at a time; footnotes ("3. Ins. by Act 8 of 1913") do not.
    if (number < last || number > last + MAX_NUMBER_JUMP) continue;
    last = number;
    headings.push({ label: `s.${match[1]}${match[2]}`, heading: match[3].replace(/\s+/g, ' ').trim(), offset: match.index });
  }
  return headings;
};

/**
 * The old code as a word stream, each word knowing the section it sits in, and a six-word-run index.
 * @param {string} text the old code's full text
 */
export const indexOldCode = (text, { bodyStart = 0 } = {}) => {
  const headings = oldSectionHeadings(text, { bodyStart });
  const tokens = [];
  let section = -1;
  for (const match of text.slice(bodyStart).matchAll(/[A-Za-z0-9]+/g)) {
    const offset = bodyStart + match.index;
    while (section + 1 < headings.length && headings[section + 1].offset <= offset) section += 1;
    tokens.push({ word: match[0].toLowerCase(), section });
  }
  const index = new Map();
  for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
    const key = tokens.slice(i, i + SHINGLE).map((token) => token.word).join(' ');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(i);
  }
  return { headings, tokens, index };
};

/** A new section's units: its numbered sub-sections ("(5) When a criminal act…"), or the whole text. */
export const sectionUnits = (provision) => {
  const paragraphs = String(provision.text || '').split('\n');
  const units = [];
  let current = null;
  for (const paragraph of paragraphs) {
    const sub = /^\((\d{1,2}[A-Z]?)\)\s/.exec(paragraph);
    if (sub) {
      current = { label: `${provision.label}(${sub[1]})`, text: paragraph };
      units.push(current);
    } else if (current) {
      current.text += `\n${paragraph}`;
    } else {
      current = { label: provision.label, text: paragraph };
      units.push(current);
    }
  }
  // A section whose only "unit" is its whole text keeps its plain label.
  return units.filter((unit) => words(unit.text).length >= MIN_UNIT_WORDS);
};

/** The old section a unit's wording comes from, with the share of its six-word runs found there. */
const headingSimilarity = (a, b) => {
  const left = new Set(words(a));
  const right = new Set(words(b));
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, new Set([...left, ...right]).size);
};

export const alignUnit = (unitText, old, heading = null) => {
  const unitWords = words(unitText);
  const runs = unitWords.length - SHINGLE + 1;
  if (runs < 1) return null;
  // A run found in k sections gives each 1/k of a vote: stock phrases ("shall be punished with death or
  // imprisonment for life, and shall also be liable to fine") cannot outvote the run only one section has.
  const votes = new Map();
  const hits = new Map();
  for (let i = 0; i < runs; i += 1) {
    const positions = old.index.get(unitWords.slice(i, i + SHINGLE).join(' '));
    if (!positions) continue;
    const sections = [...new Set(positions.map((position) => old.tokens[position].section))].filter((section) => section >= 0);
    for (const section of sections) {
      votes.set(section, (votes.get(section) || 0) + 1 / sections.length);
      hits.set(section, (hits.get(section) || 0) + 1);
    }
  }
  if (!votes.size) return { shared: 0, section: null };
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  let [section, weight] = ranked[0];
  let lead = ranked[1] ? weight / ranked[1][1] : Infinity;
  // A close vote (a unit made of stock phrases, like "Whoever commits murder shall be punished with death or
  // imprisonment for life") is decided by the official heading when exactly one candidate's heading matches.
  if (lead < MIN_LEAD && heading) {
    const matching = ranked.slice(0, 5).filter(([candidate]) => headingSimilarity(heading, old.headings[candidate].heading) >= SAME_HEADING);
    if (matching.length === 1) {
      [section, weight] = matching[0];
      lead = Infinity;
    }
  }
  return { shared: hits.get(section) / runs, lead, section: old.headings[section] };
};

/**
 * @param {{ provisions: {label: string, heading: string, text: string}[], oldText: string, bodyStart?: number,
 *   newAct: string, oldAct: string }} params
 * @returns {Array<{ newLabel: string, newTitle: string, oldLabel: string|null, oldTitle: string|null,
 *   kind: 'mapped'|'new', changed: boolean, shared: number }>}
 */
export const alignCodes = ({ provisions, oldText, bodyStart = 0 }) => {
  const old = indexOldCode(oldText, { bodyStart });
  const rows = [];
  for (const provision of provisions) {
    for (const unit of sectionUnits(provision)) {
      const match = alignUnit(unit.text, old, provision.heading);
      const mapped = match?.section && match.shared >= MIN_SHARED && match.lead >= MIN_LEAD;
      rows.push({
        newLabel: unit.label,
        newTitle: provision.heading,
        oldLabel: mapped ? match.section.label : null,
        oldTitle: mapped ? match.section.heading : null,
        kind: mapped ? 'mapped' : 'new',
        changed: !mapped || match.shared < UNCHANGED,
        shared: Math.round((match?.shared ?? 0) * 100) / 100,
      });
    }
  }
  // An old section no unit carries forward is not recorded as "deleted": in testing, IPC sections the BNS
  // merged into fewer sections (the coin offences, ss. 230-251) looked the same. Absence is reported at
  // lookup time as "no carried-forward wording found", never as a repeal fact.
  return rows;
};

/** Where the body of an old code begins: its first numbered section heading ("1. Title and extent….—"). */
export const bodyStartOf = (text) => {
  const match = /(?:^|\n)\s*1\.\s*[A-Z][^\n—–]{3,160}\.?\s*[—–]{1,2}/.exec(text);
  return match ? match.index : 0;
};

// The repealed codes and their bare-act copies in the library (each says, in its own replacement's repeal
// section, that it is repealed: BNS s.358, BNSS s.531, BSA s.170).
export const CODE_PAIRS = Object.freeze({
  IPC: Object.freeze({ newAct: 'BNS', oldAct: 'IPC', oldTitle: 'Indian Penal Code, 1860', repealedBy: 's.358', copyUrl: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/ipc-bare-act.pdf' }),
  CrPC: Object.freeze({ newAct: 'BNSS', oldAct: 'CrPC', oldTitle: 'Code of Criminal Procedure, 1973', repealedBy: 's.531', copyUrl: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/crpc-bare-act-1973.pdf' }),
  IEA: Object.freeze({ newAct: 'BSA', oldAct: 'IEA', oldTitle: 'Indian Evidence Act, 1872', repealedBy: 's.170', copyUrl: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/evidence-act.pdf' }),
});
