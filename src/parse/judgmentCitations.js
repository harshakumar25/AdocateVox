/**
 * What a judgment's full text cites, and how.
 *
 * Supreme Court Reports print, before the judgment, the reporter's list of the
 * cases the judgment cites, each with its treatment:
 *   modern e-SCR: "Case Law Cited\n Mohd. Hussain v. State [2012] 10 SCR 480 : (2012) 9 SCC 408; … – referred to."
 *   older SCR:    "A. K. Gopalan v. State of Madras, [1950] SCR 88 and … [1976] Suppl. SCR 172 @ 327 referred to."
 * and the judgment then cites cases in its own words ("in Maneka Gandhi v. Union
 * of India (1978) 1 SCC 248, this Court held …").
 *
 * A case is usually cited with parallel citations printed together
 * ("[1976] Supp. SCR 172 : (1976) 2 SCC 521"); such a group is one cluster and
 * names one case. The reporter's label is attached to every case in the list
 * that ends with it. Article mentions are counted from the same text.
 *
 * Older reports are OCR'd ("[19671 3 SCR .525", "L1973]", "(1976) 2 sec 521"),
 * so known OCR damage to citations is repaired before parsing. Nothing here
 * resolves a citation to a case: see cases/citationGraph.js.
 */

import { extractCitations } from './citationParser.js';

/**
 * Bumped whenever a change alters what is read from a judgment; judgments indexed by an older version are
 * re-read on the next run. 2: no label across a page break or on a footnote citation.
 */
export const JUDGMENT_READER_VERSION = 2;

const HEAD_ZONE = 3;
const FOOT_ZONE = 2;
const SCR_RUNNING_HEAD = /^(?:\d{1,4}\s+)?(?:supreme court reports\s+)?(?:[[({]\s*\d{4}\s*[\])}]\s*(?:\d{1,2}\s+)?(?:supp\S*\s*(?:\d{1,2}\s+)?)?s\.?\s?c\.?\s?r\.?(?:\s+\d{1,4})?|digital supreme court reports|supreme court reports(?:\s+\d{1,4})?)$/i;
const PAGE_NUMBER_OR_MARGIN = /^(?:\d{1,4}|[A-H])$/;

const shape = (line) => line.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();

/**
 * Drops the lines a report repeats at the top or foot of its pages (the "[2024] 5 S.C.R. 631" head,
 * the case-name or author head, page numbers), so they are never read as citations or text.
 */
export const stripRunningHeads = (pages) => {
  const split = pages.map((page) => String(page || '').split('\n'));
  const zone = (lines) => {
    const filled = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line);
    return [...filled.slice(0, HEAD_ZONE), ...filled.slice(Math.max(HEAD_ZONE, filled.length - FOOT_ZONE))];
  };
  const counts = new Map();
  for (const lines of split) {
    for (const key of new Set(zone(lines).map(({ line }) => shape(line)).filter((key) => key.length >= 3))) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const recurring = Math.max(3, Math.ceil(split.length * 0.2));
  return split.map((lines) => {
    const drop = new Set(zone(lines)
      .filter(({ line }) => SCR_RUNNING_HEAD.test(line) || PAGE_NUMBER_OR_MARGIN.test(line) || (counts.get(shape(line)) || 0) >= recurring)
      .map(({ index }) => index));
    return lines.filter((_, index) => !drop.has(index)).join('\n');
  });
};

const SCR_AHEAD = String.raw`(?=\s*(?:\d{1,2}\s*)?(?:Supp\S*\s*\(?\d{0,2}\)?\s*)?S\.?\s?C\.?\s?R)`;
const OCR_REPAIRS = [
  // "[19671 3 SCR" / "[19541 SCR" / "L1973] 3 SCR" / "T19731 3 SCR" / "[1 973] 1 SCR" / "[1973} 1 S.C.R." → "[1967] 3 SCR" …
  [new RegExp(String.raw`(?:\[|\{|\b[LT](?=[12]))\s*([12])\s?(\d)\s?(\d)\s?(\d)\s*(?:[\]})]|1(?=\s+(?:\d{1,2}\s+)?S\.?\s?C\.?\s?R))${SCR_AHEAD}`, 'g'), '[$1$2$3$4]'],
  // "(1976) 2 sec 521" → "(1976) 2 SCC 521"
  [/(\(\s*\d{4}\s*\)\s*\d{1,2}\s+)s\s?e\s?c(?=\s+\d)/gi, '$1SCC'],
  // "SCR .525", "S.C.R., 856" → "SCR 525"
  [/(S\.?\s?C\.?\s?[RC]\.?)\s*[.,]\s*(?=\d)/g, '$1 '],
  // "(2007) 2 SCC l" → "(2007) 2 SCC 1"
  [/(S\.?\s?C\.?\s?[RC]\.?\s+)[lI]\b/g, '$11'],
  // "AIR [1967] SC 1269" → "AIR 1967 SC 1269"
  [/\bA\.?\s?I\.?\s?R\.?\s*[[(]\s*(\d{4})\s*[\])]\s*(?=S\.?\s?C\b)/g, 'AIR $1 '],
];

/** Repairs the OCR damage that most often breaks a citation in older reports. */
export const repairOcrCitations = (text) => OCR_REPAIRS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

const TREATMENTS = [
  ['partly overruled', 'partly_overruled'], ['partially overruled', 'partly_overruled'], ['overruled in part', 'partly_overruled'],
  ['overruled to that extent', 'partly_overruled'], ['impliedly overruled', 'overruled'], ['overruled', 'overruled'],
  ['over-ruled', 'overruled'], ['over ruled', 'overruled'],
  ['held per incuriam', 'per_incuriam'], ['declared per incuriam', 'per_incuriam'], ['per incuriam', 'per_incuriam'],
  ['disapproved', 'questioned'], ['doubted', 'questioned'], ['not followed', 'questioned'], ['not approved', 'questioned'],
  ['relied on', 'followed'], ['relied upon', 'followed'], ['followed', 'followed'], ['applied', 'followed'],
  ['approved', 'followed'], ['affirmed', 'followed'], ['reiterated', 'followed'], ['upheld', 'followed'],
  ['distinguished', 'distinguished'], ['held inapplicable', 'distinguished'], ['held not applicable', 'distinguished'],
  ['not applicable', 'distinguished'], ['inapplicable', 'distinguished'],
  ['referred to', 'referred'], ['referred', 'referred'], ['cited', 'referred'], ['considered', 'referred'],
  ['discussed', 'referred'], ['explained', 'referred'], ['clarified', 'referred'], ['noticed', 'referred'],
];
const TREATMENT_CATEGORY = new Map(TREATMENTS);
/** The more consequential label wins when a judgment lists the same case twice. */
export const TREATMENT_RANK = Object.freeze({
  overruled: 6, partly_overruled: 5, per_incuriam: 4, questioned: 3, distinguished: 2, followed: 1, referred: 0,
});

// A pin cite or page-margin reference printed after a citation: "@ 327", "at p. 670", ", 670", "@ E 1271", "[644 B]".
const PIN = String.raw`(?:\s*(?:@|at\s+(?:pp?\.?|pages?)?|,\s*(?:pp?\.?|pages?)?)\s*[A-H]?\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?(?:\s*[A-H](?:\s*[-–]\s*[A-H])?)?)*`;
const CLUSTER_GAP = new RegExp(String.raw`^${PIN}\s*[:=,]?\s*$`, 'i');
const LABEL_AFTER = new RegExp(
  String.raw`^${PIN}\s*[-–—,·•]?\s*(${TREATMENTS.map(([label]) => label.replace(/[-\s]/g, (c) => (c === '-' ? '-' : '\\s+'))).join('|')})\b`,
  'i',
);
// The 2010s format closes each entry with the paragraph instead: "(1965) 1 SCR 413 explained Para 29".
const LABEL_END = /^\s*[·•]?\s*(?:[A-Ha-h]\s+)?(?:[.;]|Paras?(?=[\s.\d])|$)/i;
// Cases in one list are joined by ";", "," or "and"; a sentence end or a page-margin reference ("[644 B]") ends the list.
const LIST_JOIN = /;|,|&|\band\b/i;
const LIST_BREAK = /\b[a-z]{4,}\.\s+[A-Z0-9]|\[\s*Paras?\b|\bHeld\b|[[{]\s*\d{3,4}\s*[A-H]/;
// Pages are joined with a form feed, so a label is never read across a page break: a footnote citation
// at the foot of a page followed by a page that happens to begin "overruled." is not a treatment.
const PAGE_BREAK = '\f';
const FOOTNOTE_LINE = /^\s*[[(]?\d{1,3}[\])]?\s*$/;
const LIST_GAP_LIMIT = 260;
const LABEL_GAP_LIMIT = 60;

const LIST_START = /\b(?:Case\s+Law\s+(?:Cited|Reference)|List\s+of\s+Citations(?:\s+and\s+Other\s+References)?|Cases?\s+(?:referred|cited)(?:\s+to)?\s*:)/gi;
const LIST_END = /\b(?:Books\s+and\s+Periodicals\s+Cited|List\s+of\s+Acts|List\s+of\s+Keywords|Case\s+Arising\s+From|Appearances\s+for\s+Parties|Judgment\s*\/\s*Order\s+of\s+the\s+Supreme\s+Court|Other\s+Case\s+Details|Foreign\s+Case\s+Law\s+Cited)\b/gi;
// Older reports go straight from the list to the case's jurisdiction line or the judgment.
const LIST_END_HEADING = /\b(?:CIVIL|CRIMINAL) APPELLATE JURISDICTION|\b(?:ORIGINAL|ADVISORY|EXTRAORDINARY) JURISDICTION|\bJUDGMENT\b|The Judgment of the Court was delivered by/g;
const LIST_MAX_CHARS = 20000;

/** [start, end) ranges of the report's "Case Law Cited" sections. */
const referenceZones = (text) => {
  const zones = [];
  for (const start of text.matchAll(LIST_START)) {
    if (zones.length && start.index < zones.at(-1)[1]) continue;
    const ends = [LIST_END, LIST_END_HEADING].map((pattern) => {
      pattern.lastIndex = start.index + start[0].length;
      return pattern.exec(text)?.index ?? text.length;
    });
    zones.push([start.index, Math.min(...ends, start.index + LIST_MAX_CHARS)]);
  }
  return zones;
};

const yearsAgree = (a, b) => Math.abs(a - b) <= 1;

/** Groups citations printed together for one case ("[1978] 2 SCR 621 : (1978) 1 SCC 248"). */
const clusterCitations = (text, citations) => {
  const clusters = [];
  for (const citation of citations) {
    const last = clusters.at(-1);
    const previous = last?.citations.at(-1);
    const joinable = previous
      && CLUSTER_GAP.test(text.slice(previous.index + previous.raw.length, citation.index))
      && !last.citations.some((member) => member.scheme === citation.scheme)
      && last.citations.every((member) => yearsAgree(member.year, citation.year));
    if (joinable) {
      last.citations.push(citation);
      last.end = citation.index + citation.raw.length;
    } else {
      clusters.push({ citations: [citation], start: citation.index, end: citation.index + citation.raw.length });
    }
  }
  return clusters;
};

const VERSUS = /\s(?:v\.?|vs\.?|versus)\s/gi;
const NAME_STOP = new RegExp(String.raw`[;\]}]|Case\s+Law\s+Cited\s+|\b(?:in|In|see|See|also|of the decision|judgment in|decision in|case of|Case of|reliance on|${TREATMENTS.map(([label]) => label.replace(/\s+/g, '\\s+')).join('|')})\.?\s+(?=[A-Z])`, 'g');

/** The case name printed before a cluster ("Maneka Gandhi v. Union of India"), or null. */
const nameBefore = (text, start, floor) => {
  const from = Math.max(floor, start - 220);
  const window = text.slice(from, start);
  const versus = [...window.matchAll(VERSUS)].at(-1);
  if (!versus) return null;
  let head = window.slice(0, versus.index);
  const stops = [...head.matchAll(NAME_STOP)].at(-1);
  if (stops) head = head.slice(stops.index + stops[0].length);
  const petitioner = head.split(/\s+/).filter(Boolean).slice(-8).join(' ').replace(/^[^A-Za-z(]+/, '');
  const respondent = window.slice(versus.index + versus[0].length).replace(/[\s,([]+$/, '').replace(/\s+/g, ' ').trim();
  if (!petitioner || !respondent || respondent.length > 140) return null;
  return `${petitioner} v. ${respondent}`;
};

const ABBREVIATION = /(?:\b[A-Z]|\bv|\bvs|\bNo|\bNos|\bArt|\bArts|\bOrs|\bAnr|\bCo|\bLtd|\bMr|\bMrs|\bDr|\bSmt|\bSh|\bs|\bss|\bp|\bpp|\bpara|\bparas|\bi\.e|\be\.g|\bviz|\bcl|\bSupp|\bSuppl|\bJ|\bJJ|\bCJ|\bC\.J|\bVol|\bed|\bGovt|\bMohd|\bCorpn|\bBros|\bAssn|\bPvt|\bSt|\bHon'ble)$/;
// A new sentence starts with a capital, a digit, or an opening quote or bracket.
const SENTENCE_OPENING = /^\s+["“'‘(\[]?[A-Z0-9]/;
// A heading on its own line ("JUDGMENT", "Precedents:") ends whatever came before it.
const HEADING_LINE = /^\s*(?:[A-Z][A-Z\s./&-]{2,}|[A-Z][a-z]+(?:\s[a-z]+){0,3}:?)\s*$/;

const sentenceStart = (text, index, limit) => {
  for (let i = index - 1; i > Math.max(0, index - limit); i -= 1) {
    if ((text[i] === '.' || text[i] === '?' || text[i] === '!') && SENTENCE_OPENING.test(text.slice(i + 1, i + 4))
      && !ABBREVIATION.test(text.slice(Math.max(0, i - 8), i))) {
      return i + 1;
    }
    if (text[i] === '\n' && (text[i - 1] === '\n' || HEADING_LINE.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i)))) return i + 1;
  }
  return Math.max(0, index - limit);
};

const sentenceEnd = (text, index, limit) => {
  for (let i = index; i < Math.min(text.length, index + limit); i += 1) {
    if ((text[i] === '.' || text[i] === '?' || text[i] === '!') && (i + 1 >= text.length || SENTENCE_OPENING.test(text.slice(i + 1, i + 4)) || /^\s*$/.test(text.slice(i + 1, i + 3)))
      && !ABBREVIATION.test(text.slice(Math.max(0, i - 8), i))) {
      return i + 1;
    }
  }
  return Math.min(text.length, index + limit);
};

const CONTEXT_CHARS = 360;
// The later Court often quotes the passage it relies on right after the citation: keep that passage.
const QUOTE_FOLLOWS = /^[\s,:;)\]]*(?:\(\s*SCC\s+pp?\.[^)]{0,30}\)\s*)?[“"]/;
const REPORTER_TOKEN = /\b(?:S\.?C\.?R|S\.?C\.?C|A\.?I\.?R|INSC)\b/g;
const LIST_CONTEXT_CITATIONS = 4;
const FOOTNOTE_START = /^[A-H]?\s*[·•]?\s*\d{1,3}\s+[([]/;
const MIN_PROSE_WORDS = 5;

/**
 * Whether a context reads as the Court's prose. Not: a run of citations (an unlabelled list), footnote
 * debris ("… 7 Ibid, at page 14 58 (1973) 1 SCC 471 …"), or a fragment with too few ordinary words.
 */
const isProse = (context) => (context.match(REPORTER_TOKEN) || []).length < LIST_CONTEXT_CITATIONS
  && !/\bIbid\b/i.test(context)
  && !FOOTNOTE_START.test(context)
  && (context.match(/\b[a-z]{3,}\b/g) || []).length >= MIN_PROSE_WORDS;
const ARGUMENT = /\b(?:submitted|submits|contended|contends|argued|argues|urged|learned (?:senior )?counsel|placed reliance|relied upon by|on behalf of the (?:appellant|respondent|petitioner)s?)\b/i;

/** The sentence a body citation sits in, trimmed to CONTEXT_CHARS around the citation. */
// The end of an earlier quotation ("… trial.” (emphasis supplied) Rattiram v. …") starts the next context.
const QUOTE_CLOSE = /\((?:emphasis|underlining|italics)[^)]{0,30}\)\s*|[”"]\s+(?=[A-Z])/g;

const contextAround = (text, cluster) => {
  let start = sentenceStart(text, cluster.start, 260);
  const close = [...text.slice(start, cluster.start).matchAll(QUOTE_CLOSE)].at(-1);
  if (close) start += close.index + close[0].length;
  const quoted = QUOTE_FOLLOWS.test(text.slice(cluster.end, cluster.end + 40));
  const end = quoted ? Math.min(text.length, cluster.end + CONTEXT_CHARS) : sentenceEnd(text, cluster.end, 200);
  let sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (sentence.length > CONTEXT_CHARS) {
    const anchor = text.slice(start, cluster.start).replace(/\s+/g, ' ').length;
    const from = Math.max(0, Math.min(anchor - 180, sentence.length - CONTEXT_CHARS));
    sentence = `${from > 0 ? '…' : ''}${sentence.slice(from, from + CONTEXT_CHARS).trim()}${from + CONTEXT_CHARS < sentence.length ? '…' : ''}`;
  }
  return sentence;
};

// "Article 21", "Art. 19(1)(a)", "Articles 14, 19 and 21", OCR "Artic1e 21"; never "Article 137 of the Limitation Act".
const ARTICLE_LIST = /\bArt(?:ic[l1i]e|\.)?s?\s*(\d{1,3}[A-Z]{0,3})((?:\s*\(\s*[\da-z]{1,4}\s*\))*(?:\s*(?:,|and|or|&|to)\s*(?:Art(?:ic[l1i]e|\.)?s?\s*)?\d{1,3}[A-Z]{0,3}(?:\s*\(\s*[\da-z]{1,4}\s*\))*)*)/gi;
const OTHER_INSTRUMENT = /^\s*(?:of|in|under)\s+(?:the\s+)?(?!Constitution)(?:[A-Z][\w.'-]*\s+){0,6}?(?:Act|Convention|Covenant|Schedule|Code|Treaty|Declaration|Charter|Rules?|Order|Agreement|Statute|Regulations?|Ordinance|ECHR|ICCPR|UDHR|CEDAW|UNCRC)\b/;

/** How often the text names each Article of the Constitution (base Article: "Art.19" for 19(1)(a)). */
export const articleMentions = (text, knownArticles = null) => {
  const counts = new Map();
  for (const match of text.matchAll(ARTICLE_LIST)) {
    if (OTHER_INSTRUMENT.test(text.slice(match.index + match[0].length, match.index + match[0].length + 90))) continue;
    const numbers = [match[1], ...[...(match[2] || '').matchAll(/(?:,|and|or|&|to)\s*(?:Art(?:ic[l1i]e|\.)?s?\s*)?(\d{1,3}[A-Z]{0,3})/gi)].map(([, number]) => number)];
    for (const number of numbers) {
      const label = `Art.${number.toUpperCase()}`;
      if (knownArticles && !knownArticles.has(label)) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return counts;
};

/**
 * Reads one judgment's page texts.
 *
 * @param {string[]} pages page texts in order
 * @returns {{ references: Array<{ citations: {scheme: string, normalized: string, year: number}[], name: string|null,
 *   page: number, inReferenceList: boolean, treatment: string|null, category: string|null, context: string|null }>,
 *   articles: Map<string, number>, citations: number }}
 */
export const analyseJudgment = (pages, { knownArticles = null } = {}) => {
  const cleaned = stripRunningHeads(pages).map(repairOcrCitations);
  const pageStarts = [];
  let text = '';
  for (const page of cleaned) {
    pageStarts.push(text.length);
    text += `${page}\n${PAGE_BREAK}\n`;
  }
  const pageAt = (index) => {
    let low = 0;
    let high = pageStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (pageStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const citations = extractCitations(text);
  const clusters = clusterCitations(text, citations);
  const zones = referenceZones(text);
  const inZone = (index) => zones.some(([start, end]) => index >= start && index < end);

  clusters.forEach((cluster, index) => {
    cluster.name = nameBefore(text, cluster.start, index ? clusters[index - 1].end : 0);
    cluster.inReferenceList = inZone(cluster.start);
    cluster.treatment = null;
  });

  // A label right after a cluster applies to it and to every case listed before it in the same list.
  // A footnote ("19 [2000] Supp. 1 SCR 538" opening its line) is never part of the reporter's list.
  const isFootnote = (cluster) => FOOTNOTE_LINE.test(text.slice(text.lastIndexOf('\n', cluster.start) + 1, cluster.start));
  clusters.forEach((cluster, index) => {
    if (!cluster.inReferenceList && isFootnote(cluster)) return;
    const after = text.slice(cluster.end, cluster.end + LABEL_GAP_LIMIT);
    const label = LABEL_AFTER.exec(after);
    if (!label || after.slice(0, label.index + label[0].length).includes(PAGE_BREAK)
      || !LABEL_END.test(after.slice(label.index + label[0].length))) return;
    const treatment = label[1].toLowerCase().replace(/\s+/g, ' ');
    for (let i = index; i >= 0; i -= 1) {
      const member = clusters[i];
      if (member.treatment) break;
      member.treatment = treatment;
      member.inReferenceList = true;
      if (i === 0) break;
      const gap = text.slice(clusters[i - 1].end, member.start);
      if (gap.length > LIST_GAP_LIMIT || !LIST_JOIN.test(gap) || LIST_BREAK.test(gap)) break;
    }
  });

  const references = clusters.map((cluster) => {
    const around = cluster.inReferenceList ? null : contextAround(text, cluster);
    const context = around && isProse(around) ? around : null;
    return {
      citations: cluster.citations.map(({ scheme, normalized, year }) => ({ scheme, normalized, year })),
      name: cluster.name,
      page: pageAt(cluster.start),
      inReferenceList: cluster.inReferenceList,
      treatment: cluster.treatment,
      category: cluster.treatment ? TREATMENT_CATEGORY.get(cluster.treatment) ?? TREATMENT_CATEGORY.get(cluster.treatment.replace(/-/g, ' ')) ?? null : null,
      context,
      argument: Boolean(around) && ARGUMENT.test(around),
    };
  });

  return { references, articles: articleMentions(text, knownArticles), citations: citations.length };
};
