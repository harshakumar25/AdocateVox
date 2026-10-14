/**
 * Parser for one judgment record of the Supreme Court open dataset
 * (metadata/json/year=YYYY/<path>.json): the Court's own listing row as HTML,
 * plus path and neutral citation. Yields the case title, SCR and neutral
 * citations, CNR, coram (with the authoring judge), decision date, case
 * number, disposal, bench size, and the official SCR headnote, and the
 * Constitution Articles the headnote's catchwords name.
 */

import { decodeEntities } from './html.js';

const toText = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const field = (html, label) => {
  const match = new RegExp(`${label}\\s*:\\s*</span>\\s*<font[^>]*>([\\s\\S]*?)</font>`, 'i').exec(html);
  return match ? toText(match[1]) : null;
};

const isoFromDmy = (value) => {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value || '');
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCDate() === Number(match[1]) ? iso : null;
};

// "Art."/"Article", and the OCR misreadings seen in SCR headnotes: "A11.21" (Puttaswamy, 2017), "Arl.", "Ar1.",
// "Atticle", "Aiticle". "A11" counts only with its full stop, since "A11 " is usually "All".
const ARTICLE_LIST = /\b(?:Art(?:icle)?s?\b\.?|A(?:11|rl|r1)s?\.|A(?:tt|it)icles?\b)[\s·:]*((?:\d{1,3}[A-Z]{0,3}(?:\s*\([0-9A-Za-z]{1,5}\))*(?:\s*(?:,|and|&|or|to|r\/w|read\s+with)\s*)?)+)/g;
// An instrument named before an "Art." reference: the Constitution, or something else ("Limitation Act", "Code").
// Old SCR headnotes are OCR'd: "Comtitution of India", "Co11.1titutio11 of India". The tolerant form must still
// read "…titu…o… of India".
const CONSTITUTION = /\bCo\S{0,4}titu\S{0,3}o\S{0,2}(?=\s+of\s+India)|Constitution/gi;
// A constitutional amendment Act amends Articles of the Constitution: its title is Constitution context, not "another Act".
const AMENDMENT_ACT = /Constitution\s*\([^)]*Amendment\)\s*Act(?:\s*,\s*\d{4})?/gi;
const OTHER_INSTRUMENT = /\b(?:Act|Code|Schedule|Ordinance|Rules?|Regulations?|Order|Convention|Treaty)\b/g;

const lastIndex = (regex, text) => {
  let last = -1;
  for (const match of text.matchAll(regex)) last = match.index;
  return last;
};

/**
 * Constitution Articles named in a headnote, each with the catchword group it first appears in:
 * "Constitution of India Articles 14, 19 (1) (a) and 21-Personal liberty-…" names 14, 19 and 21
 * together as the lead group (group 0). An "Art." reference counts only when the nearest
 * instrument named before it is the Constitution: "Limitation Act-Art. 137" is that Act's Schedule.
 * @returns {{ label: string, group: number }[]} in order of first mention
 */
export const constitutionArticleGroups = (headnote) => {
  const text = String(headnote || '');
  const found = [];
  let group = -1;
  for (const match of text.matchAll(ARTICLE_LIST)) {
    const before = text.slice(0, match.index).replace(AMENDMENT_ACT, 'Constitution');
    if (lastIndex(CONSTITUTION, before) <= lastIndex(OTHER_INSTRUMENT, before)) continue;
    group += 1;
    const numbers = match[1].replace(/\([^)]*\)/g, ' ').match(/\b\d{1,3}[A-Z]{0,3}\b/g) || [];
    for (const number of numbers) {
      const label = `Art.${number}`;
      if (!found.some((entry) => entry.label === label)) found.push({ label, group });
    }
  }
  return found;
};

// The codes a headnote's catchwords cite by section, and the highest section each has (a larger number is
// OCR noise). The 1898 Code of Criminal Procedure numbers its sections differently from the 1973 Code, so it
// is kept apart and never mapped to the BNSS.
const YEAR = String.raw`(?:,?\s*[1Il]\s?[8]\s?[6]\s?[0O])?`;
const CODES = Object.freeze([
  { act: 'BNSS', max: 531, name: /Bharatiya\s+Nagarik\s+Suraksha\s+Sanhita(?:,?\s*2023)?|\bBNSS\b/i },
  { act: 'BNS', max: 358, name: /Bharatiya\s+Nyaya\s+Sanhita(?:,?\s*2023)?|\bBNS\b/i },
  { act: 'BSA', max: 170, name: /Bharatiya\s+Sakshya\s+Adhiniyam(?:,?\s*2023)?|\bBSA\b/i },
  { act: 'IPC', max: 511, name: new RegExp(String.raw`(?:Indian\s+)?Penal\s+Code${YEAR}|\bI\.\s?P\.\s?C\.?`, 'i') },
  { act: 'CrPC1898', max: 565, name: /Code\s+of\s+Criminal\s+Procedure,?\s*(?:\(V\s+of\s+)?1898\)?/i },
  { act: 'CrPC', max: 484, name: /Code\s+of\s+Criminal\s+Procedure(?:,?\s*1973)?|\bCr\.?\s?P\.?\s?C\.?/i },
  { act: 'IEA', max: 167, name: /(?:Indian\s+)?Evidence\s+Act(?:,?\s*1872)?/i },
]);
// A section list as printed, OCR included: "ss. 353 and 506", "Sections 120-B, 420/34 and 477-A",
// "Ss. 3021149" (302/149), "s.304-8" (304-B), "ss:306", "ss.302,394 rlw 397", "ss.323, c 324 and 302".
const MARGIN = String.raw`(?:[A-Ha-h]\s+){0,3}`;
const NUMBER = String.raw`\d{1,6}(?:\s*-?\s*[A-Z8](?![a-z]))?(?:\s*\([0-9A-Za-z]{1,4}\))*`;
const JOIN = String.raw`(?:\s*(?:,|and|&|\/|r\s*[\/l]\s*w|read\s+with|to|or)\s*${MARGIN}(?:s{1,2}\s*[.:]?\s*)?)`;
const LIST = String.raw`(?:${NUMBER}${JOIN}?)+`;
const SECTION_WORD = String.raw`(?:s{1,2}\s*[.:]\s*|s{1,2}\s+(?=\d)|Secs?\.?\s*|Sections?\.?\s*)`;
const SECTION_LIST = new RegExp(String.raw`^[\s,;:–—-]*${MARGIN}[\s,;:–—-]*${SECTION_WORD}(${LIST})`, 'i');
// The section written before the code: "under Sec. 406 Penal Code", "s. 149, Indian Penal Code".
const SECTION_BEFORE = new RegExp(String.raw`${SECTION_WORD}(${LIST})\s*,?\s*(?:of\s+the\s+)?$`, 'i');

/** Section labels in a printed list, with the OCR forms of "/" ("302134" → 302, 34) and "-B" ("304-8"). */
const labelsIn = (list, max) => {
  const labels = [];
  for (const [, raw, letter] of list.replace(/\([^)]*\)/g, ' ').matchAll(/\b(\d{1,6})(?:\s*-?\s*([A-Z8])(?![a-z]))?/g)) {
    let numbers = [raw];
    // "/" read as "1" fuses two sections: "302134" is 302/34; "3021149" is 302/149.
    if (raw.length > 3) {
      const at = [3, 2, 1].find((cut) => raw[cut] === '1' && Number(raw.slice(0, cut)) <= max && raw.length - cut - 1 >= 1);
      numbers = at ? [raw.slice(0, at), raw.slice(at + 1)] : [];
    }
    numbers.forEach((number, index) => {
      if (Number(number) < 1 || Number(number) > max) return;
      const suffix = index === numbers.length - 1 && letter ? (letter === '8' ? 'B' : letter.toUpperCase()) : '';
      labels.push(`s.${Number(number)}${suffix}`);
    });
  }
  return labels;
};

/**
 * Sections of the criminal codes a headnote's catchwords name, with the catchword group they first appear
 * in: [{ act: 'IPC', label: 's.302', group: 0 }, { act: 'IPC', label: 's.34', group: 0 }].
 */
// The 1973 Code of Criminal Procedure came into force on 1 April 1974: before that, "the Code" was the 1898 one.
const CRPC_1973_FROM = '1974-04-01';

export const codeSectionGroups = (headnote, { decidedOn = null } = {}) => {
  const text = String(headnote || '');
  const found = [];
  const mentions = [];
  for (const code of CODES) {
    for (const match of text.matchAll(new RegExp(code.name.source, 'gi'))) {
      // A longer code name claims its span first ("Code of Criminal Procedure, 1898" over "… Procedure").
      if (mentions.some((m) => match.index >= m.start && match.index < m.end)) continue;
      mentions.push({ code, start: match.index, end: match.index + match[0].length });
    }
  }
  mentions.sort((a, b) => a.start - b.start);
  mentions.forEach(({ code: named, start, end }, group) => {
    // An unqualified "Code of Criminal Procedure" in a judgment decided before the 1973 Code is the 1898 Code.
    const code = named.act === 'CrPC' && decidedOn && decidedOn < CRPC_1973_FROM && !/1973/.test(text.slice(start, end))
      ? CODES.find((candidate) => candidate.act === 'CrPC1898') : named;
    const after = SECTION_LIST.exec(text.slice(end, end + 220));
    const before = after ? null : SECTION_BEFORE.exec(text.slice(Math.max(0, start - 80), start));
    const list = after?.[1] ?? before?.[1];
    if (!list) return;
    for (const label of labelsIn(list, code.max)) {
      if (!found.some((entry) => entry.act === code.act && entry.label === label)) found.push({ act: code.act, label, group });
    }
  });
  return found;
};

/** Constitution Article labels ("Art.21") named in a headnote, in order of first mention. */
export const constitutionArticlesIn = (headnote) => constitutionArticleGroups(headnote).map((entry) => entry.label);

/**
 * @param {{ raw_html: string, path: string, nc_display?: string }} record
 * @returns {object|null} null when the record has no recognisable case title
 */
export const parseScMetadata = (record) => {
  const html = String(record?.raw_html || '');
  const titleMatch = /<strong>([\s\S]*?)<\/strong>\s*-\s*<span class='escrText'>([\s\S]*?)<\/span>/i.exec(html)
    || /<strong>([\s\S]*?\bversus\b[\s\S]*?)<\/strong>/i.exec(html);
  if (!titleMatch) return null;

  const coramMatch = /Coram\s*:([\s\S]*?)<\/strong>/i.exec(html);
  const coram = [];
  let author = null;
  if (coramMatch) {
    for (const part of coramMatch[1].split(',')) {
      const isAuthor = /data-tooltip=["']Author["']/i.test(part);
      const name = toText(part.replace(/<sup[\s\S]*?<\/sup>/gi, ''));
      if (!name) continue;
      coram.push(name);
      if (isAuthor) author = name;
    }
  }

  const decidedOn = isoFromDmy(field(html, 'Decision Date'));
  const headnoteMatch = /Coram\s*:[\s\S]*?<\/strong>\s*<br\s*\/?>([\s\S]*?)<br\s*\/?>\s*<strong class=['"]caseDetailsTD/i.exec(html);
  const headnote = headnoteMatch ? toText(headnoteMatch[1]) : null;
  const bench = /(\d+)\s*Judges?/i.exec(field(html, 'Bench') || '');
  const neutral = toText((/class='ncDisplay'>([\s\S]*?)<\/span>/i.exec(html) || [])[1] || '') || null;
  const disposal = field(html, 'Disposal Nature');

  return {
    key: record.path,
    title: toText(titleMatch[1]),
    scr: titleMatch[2] ? toText(titleMatch[2]) : null,
    neutral,
    cnr: (/id=['"]cnr['"]\s+value=['"]?([A-Z0-9]+)/i.exec(html) || [])[1] ?? null,
    coram,
    author,
    decidedOn,
    caseNo: field(html, 'Case No'),
    disposal: disposal && disposal !== 'None' ? disposal : null,
    benchStrength: bench ? Number(bench[1]) : null,
    headnote,
    articles: constitutionArticleGroups(headnote),
    codeSections: codeSectionGroups(headnote, { decidedOn }),
  };
};
