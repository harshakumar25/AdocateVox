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
    decidedOn: isoFromDmy(field(html, 'Decision Date')),
    caseNo: field(html, 'Case No'),
    disposal: disposal && disposal !== 'None' ? disposal : null,
    benchStrength: bench ? Number(bench[1]) : null,
    headnote,
    articles: constitutionArticleGroups(headnote),
  };
};
