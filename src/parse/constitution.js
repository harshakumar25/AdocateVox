/**
 * Parser for the official consolidated "Constitution of India" PDF published
 * by the Legislative Department (layout of the 2026 English edition), working
 * on the line stream produced by extract/pdfText.js.
 *
 * Produces the Preamble, every Article and every Schedule with its Part,
 * Chapter and group heading, clean text (amendment brackets kept, footnote
 * markers removed), the footnotes that amend it, the date its current text
 * took effect, any amendment still awaiting commencement, and any amendment
 * the Supreme Court struck down (printed in the text, flagged in a footnote).
 */

const CONSTITUTION_COMMENCEMENT = '1950-01-26';
const ARTICLE_INDENT = { min: 55, max: 66 };
const FOOTNOTE_INDENT_MAX = 42;
const CENTERED_MIN_X = 95;
const HEADING_LOOKAHEAD_LINES = 3;
const MAX_ARTICLE_STEP = 3;

const SCHEDULE_ORDINALS = Object.freeze({
  FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6,
  SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10, ELEVENTH: 11, TWELFTH: 12,
});

const ARTICLE_START = /^\[*\s*(\d{1,3})([A-Z]{0,3})\.\s*(.*)$/;
const HEADING_END = /\.\s*\]?\s*[—–]\s*|\.\s*-(?=\s|$|\()/;
const PART_LINE = /^\[*\s*PART\s+[IVXLC]+[A-Z]{0,2}\]?$/;
const CHAPTER_LINE = /^\[*\s*CHAPTER\s+[IVXLC]+\b/;
const SCHEDULE_LINE = /^\[*\s*(?:THE\s+)?([A-Z]+)\s+SCHEDULE\]?$/;
const APPENDIX_LINE = /^APPENDIX\s+[IVX]+\b/;
const PARAGRAPH_START = /^\[*\s*(?:\((?:\d{1,3}[A-Za-z]?|[a-z]{1,3}|[ivxlc]{1,7})\)|Provided\b|Explanation\b|Illustration\b)/;
// Footnote numbers sometimes lack their full stop in the official PDF ("2 Ins. by ...").
const FOOTNOTE_START = /^(\d{1,2}|\*{1,6})\.?\s+(\S.*)$/;
const SCHEDULE_BASIS = /^[[(]Articles?\s+[\dA-Z(),\s]+(?:and\s+[\dA-Z()]+)?[\])]\*?$/;
const RUNNING_HEAD = /^(?:\d{1,3}\s+THE CONSTITUTION OF INDIA|THE CONSTITUTION OF INDIA\s+\d{1,3})$/;
const RUNNING_CAPTION = /^\((?:Part|Sch\.?|Schedule)\s[^)]*\)$/i;
const RUNNING_HEAD_MAX_TOP = 45;
const RUNNING_CAPTION_MAX_TOP = 65;
const WEF = /w\.\s?e\.\s?f\.\s*(\d{1,2})\s*[-.]\s*(\d{1,2})\s*[-.]\s*(\d{4})/g;
const PENDING = /date\s+(?:yet\s+)?to\s+be\s+notified|date\s+not\s+notified/i;
// The consolidated text keeps amendments the Supreme Court struck down and says so only in a footnote.
const INVALIDATED = /struck\s+down|declared\s+(?:invalid|void|unconstitutional|ultra\s+vires)/i;

const normalizeText = (text) =>
  text
    // U+F02A is the Symbol-font asterisk used for "*", "**" ... footnotes; other private-use glyphs are noise.
    .replace(/\uF02A/g, '*')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\u23AF/g, '—')
    .replace(/\s+/g, ' ')
    .trim();

const toIsoDate = (day, month, year) => {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day) ? iso : null;
};

const wefDates = (text) =>
  [...text.matchAll(WEF)].map(([, day, month, year]) => toIsoDate(day, month, year)).filter(Boolean).sort();

/** Appends a wrapped line, re-joining words hyphenated across the break. */
const joinLine = (paragraph, line) => {
  if (!paragraph) return line;
  if (/[A-Za-z]-$/.test(paragraph) && /^[a-z]/.test(line)) return `${paragraph}${line}`;
  return `${paragraph} ${line}`;
};

const modeSize = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(line.size, (counts.get(line.size) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** Splits one page into body lines and its trailing footnote block; drops the page number and running head. */
export const splitPage = (page) => {
  let lines = page.lines.map((line) => ({ ...line, text: normalizeText(line.text) })).filter((line) => line.text);
  const last = lines[lines.length - 1];
  if (last && /^\d{1,3}$/.test(last.text) && last.top > page.height - 60) lines = lines.slice(0, -1);
  // A few pages open with "3 THE CONSTITUTION OF INDIA" and a "(Part I.—Union and its territory)" caption;
  // left in, they land mid-sentence in whichever provision runs across the page break.
  if (lines[0] && RUNNING_HEAD.test(lines[0].text) && lines[0].top < RUNNING_HEAD_MAX_TOP) {
    lines = lines.slice(1);
    if (lines[0] && RUNNING_CAPTION.test(lines[0].text) && lines[0].top < RUNNING_CAPTION_MAX_TOP) lines = lines.slice(1);
  }

  const upper = lines.filter((line) => line.top < page.height * 0.6);
  const bodySize = modeSize(upper.length ? upper : lines);
  const isSmall = (line) => line.size !== null && bodySize !== null && line.size < bodySize - 0.25;

  let start = lines.length;
  for (let index = lines.length - 1; index >= 0 && isSmall(lines[index]); index -= 1) {
    if (FOOTNOTE_START.test(lines[index].text) && lines[index].x0 < FOOTNOTE_INDENT_MAX) start = index;
  }
  return { body: lines.slice(0, start), footnoteLines: lines.slice(start) };
};

/**
 * Parses a page's footnote lines. `context.lastAct` carries the most recent
 * amending Act across pages so "ibid." resolves correctly.
 */
export const parseFootnotes = (lines, page, context) => {
  const notes = [];
  for (const line of lines) {
    const match = line.x0 < FOOTNOTE_INDENT_MAX ? FOOTNOTE_START.exec(line.text) : null;
    if (match) notes.push({ n: match[1], page, text: match[2] });
    else if (notes.length) notes[notes.length - 1].text = joinLine(notes[notes.length - 1].text, line.text);
  }

  return notes.map((note) => {
    const constitutionAct = /Constitution\s*\((?:[^()]|\([^()]*\))*\)\s*(?:Act|Order),?\s*\d{4}/.exec(note.text);
    // Act names may hold commas inside parentheses: "... (Duties, Powers and Conditions of Service) Act, 1971".
    const otherAct = /([A-Z](?:[A-Za-z'’ -]|\([^()]*\)){2,120}?\s(?:Act|Order),\s*\d{4})/.exec(note.text);
    let act = constitutionAct?.[0] ?? otherAct?.[1]?.replace(/^the\s+/i, '') ?? null;
    if (!act && /\bibid\b/i.test(note.text)) act = context.lastAct;
    if (act) context.lastAct = act;

    const dates = wefDates(note.text);
    return {
      ...note,
      act: act ? normalizeText(act) : null,
      wef: dates.length ? dates[dates.length - 1] : null,
      pending: PENDING.test(note.text),
      invalidated: INVALIDATED.test(note.text),
    };
  });
};

/**
 * Removes footnote markers and reports which of this page's footnotes the line
 * cites. Markers are digits before "[" or "*" ("1[", "2* * *", glued as in
 * "article 3172[") or asterisk runs before text ("**(b)"). A digit run counts
 * only through its shortest suffix that is a footnote on this page; spaced
 * "* * *" omission marks are left alone.
 */
export const stripMarkers = (text, footnoteIds) => {
  const refs = [];
  const clean = text
    .replace(/(\d+)(?=\[|\s?\*)/g, (digits) => {
      for (let cut = digits.length - 1; cut >= 0; cut -= 1) {
        const candidate = digits.slice(cut);
        if (candidate[0] !== '0' && footnoteIds.has(candidate)) {
          refs.push(candidate);
          return digits.slice(0, cut);
        }
      }
      return digits;
    })
    .replace(/(?<!\*)(\*{1,6})(?=[^\s*])/g, (stars) => {
      if (!footnoteIds.has(stars)) return stars;
      refs.push(stars);
      return '';
    });
  return { text: clean.replace(/\s+/g, ' ').trim(), refs };
};

const articleKey = (number, suffix) => ({ number: Number(number), suffix });
const isAfter = (key, previous) =>
  !previous || key.number > previous.number || (key.number === previous.number && key.suffix > previous.suffix);

/** Tries to read an article heading starting at lines[index]; it may wrap over a few lines. */
const readArticleStart = (lines, index) => {
  const first = lines[index];
  if (first.x0 < ARTICLE_INDENT.min || first.x0 > ARTICLE_INDENT.max) return null;
  const match = ARTICLE_START.exec(first.text);
  if (!match) return null;
  const inserted = first.text.startsWith('[');

  let combined = match[3];
  for (let used = 1; used <= HEADING_LOOKAHEAD_LINES; used += 1) {
    const end = HEADING_END.exec(combined);
    if (end) {
      return {
        number: match[1],
        suffix: match[2],
        heading: combined.slice(0, end.index + 1).replace(/\]\.$/, ']').trim(),
        rest: combined.slice(end.index + end[0].length).trim(),
        consumed: used,
        inserted,
      };
    }
    const next = lines[index + used];
    if (!next || PARAGRAPH_START.test(next.text)) return null;
    combined = joinLine(combined, next.text);
  }
  return null;
};

const finishProvision = (provision, footnotesByPage) => {
  const footnotes = [];
  const seen = new Set();
  for (const { page, n } of provision.refs) {
    const key = `${page}:${n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const note = footnotesByPage.get(page)?.find((candidate) => candidate.n === n);
    if (note) footnotes.push(note);
  }

  let text = provision.paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean).join('\n');
  // An inserted article is wrapped as "[21A. ... determine.]": drop the closing bracket of that wrapper.
  if (provision.inserted && text.endsWith(']')) text = text.slice(0, -1).trimEnd();
  const omitted = /^\[/.test(provision.heading) && /^Omitted\b/i.test(text);
  const changes = footnotes.filter((note) => note.wef && !note.pending).map((note) => ({ wef: note.wef, act: note.act }));
  if (omitted) {
    // An omitted article's own text carries the omission: "Omitted by the Constitution (...) Act, 1977, s. 2 (w.e.f. ...)".
    const omittedBy = /Constitution\s*\((?:[^()]|\([^()]*\))*\)\s*Act,?\s*\d{4}/.exec(text)?.[0] ?? null;
    for (const wef of wefDates(text)) changes.push({ wef, act: omittedBy ? normalizeText(omittedBy) : null });
  }
  changes.sort((a, b) => a.wef.localeCompare(b.wef));
  const latest = changes[changes.length - 1];
  const { refs, paragraphs, inserted, ...rest } = provision;
  return {
    ...rest,
    text,
    footnotes: footnotes.map(({ n, page, text: noteText, act, wef, pending, invalidated }) => ({
      n, page, text: noteText, act, wef, pending, invalidated,
    })),
    validFrom: latest?.wef ?? CONSTITUTION_COMMENCEMENT,
    amendedByRef: latest?.act ?? null,
    pendingAmendments: footnotes.filter((note) => note.pending).map((note) => note.text),
    // Printed text that includes an amendment a court invalidated is not plain good law.
    judicialNotes: footnotes.filter((note) => note.invalidated).map((note) => note.text),
    omitted,
  };
};

/**
 * @param {Array<{page:number,width:number,height:number,lines:Array}>} pages
 * @returns {{ provisions: Array<object>, warnings: string[] }}
 */
export const parseConstitution = (pages) => {
  const context = { lastAct: null };
  const footnotesByPage = new Map();
  const lines = [];
  let started = false;
  let ended = false;

  for (const page of pages) {
    const { body, footnoteLines } = splitPage(page);
    // The table of contents also says "PREAMBLE"; the real one is followed by "WE, THE PEOPLE".
    const preambleIndex = body.findIndex(
      (line, i) => line.text === 'PREAMBLE' && body.slice(i + 1, i + 4).some((next) => /^WE, THE PEOPLE/.test(next.text)),
    );
    if (!started && preambleIndex === -1) continue;
    started = true;

    const footnotes = parseFootnotes(footnoteLines, page.page, context);
    footnotesByPage.set(page.page, footnotes);
    const footnoteIds = new Set(footnotes.map((note) => note.n));

    for (const line of body.slice(Math.max(preambleIndex, 0))) {
      const { text, refs } = stripMarkers(line.text, footnoteIds);
      if (line.x0 >= CENTERED_MIN_X - 20 && APPENDIX_LINE.test(text)) {
        ended = true;
        break;
      }
      if (text) lines.push({ ...line, text, refs: refs.map((n) => ({ page: page.page, n })), page: page.page });
    }
    if (ended) break;
  }

  const provisions = [];
  const warnings = [];
  const headingBuffer = [];
  let current = null;
  let part = null;
  let chapter = null;
  let group = null;
  let lastArticle = null;
  let inSchedules = false;

  const close = () => {
    if (current) provisions.push(finishProvision(current, footnotesByPage));
    current = null;
  };
  const open = (provision) => {
    close();
    current = { part, chapter, group, refs: [], paragraphs: [], ...provision };
  };
  const addLine = (line, { forceParagraph = false } = {}) => {
    if (!current) return;
    current.refs.push(...line.refs);
    if (forceParagraph || !current.paragraphs.length || PARAGRAPH_START.test(line.text)) current.paragraphs.push(line.text);
    else current.paragraphs[current.paragraphs.length - 1] = joinLine(current.paragraphs[current.paragraphs.length - 1], line.text);
  };
  const flushHeadings = () => {
    for (const line of headingBuffer.splice(0)) addLine(line, { forceParagraph: true });
  };
  const isCentered = (line) => line.x0 >= CENTERED_MIN_X && /^\[?[A-Z]/.test(line.text) && !/[.,;:]$/.test(line.text);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.text === 'PREAMBLE' && !current) {
      open({ kind: 'preamble', label: 'Preamble', heading: 'Preamble', pageStart: line.page });
      continue;
    }

    const schedule = SCHEDULE_LINE.exec(line.text);
    if (schedule && SCHEDULE_ORDINALS[schedule[1]] && line.x0 >= CENTERED_MIN_X) {
      inSchedules = true;
      flushHeadings();
      part = null;
      chapter = null;
      group = null;
      const number = SCHEDULE_ORDINALS[schedule[1]];
      const name = `${schedule[1][0]}${schedule[1].slice(1).toLowerCase()} Schedule`;
      const basis = lines[index + 1] && /^[[(]Articles?\b/.test(lines[index + 1].text) ? lines[index + 1] : null;
      open({ kind: 'schedule', label: `Sch.${number}`, heading: basis ? `${name} ${basis.text}` : name, pageStart: line.page });
      current.refs.push(...line.refs, ...(basis?.refs ?? []));
      if (basis) index += 1;
      continue;
    }

    if (inSchedules && SCHEDULE_BASIS.test(line.text)) {
      // The "SECOND SCHEDULE" heading of the 2026 edition is not in the PDF's text layer; its
      // "[Articles ...]" basis line still is, so the next schedule number is inferred (and reported).
      const number = Number(current?.label?.slice(4) ?? 0) + 1;
      const name = Object.keys(SCHEDULE_ORDINALS).find((ordinal) => SCHEDULE_ORDINALS[ordinal] === number);
      if (name) {
        warnings.push(`p${line.page}: heading for Sch.${number} missing from the text layer; inferred from "${line.text.slice(0, 40)}"`);
        open({ kind: 'schedule', label: `Sch.${number}`, heading: `${name[0]}${name.slice(1).toLowerCase()} Schedule ${line.text}`, pageStart: line.page });
        current.refs.push(...line.refs);
        continue;
      }
    }

    if (inSchedules) {
      addLine(line);
      continue;
    }

    if (PART_LINE.test(line.text)) {
      flushHeadings();
      close();
      const titles = [];
      const isPartTitle = (candidate) => candidate && /^[^a-z]+$/.test(candidate.text)
        && !CHAPTER_LINE.test(candidate.text) && !PART_LINE.test(candidate.text) && !readArticleStart(lines, index + 1);
      while (isPartTitle(lines[index + 1])) {
        titles.push(lines[index + 1].text);
        index += 1;
      }
      const partLabel = line.text.replace(/^\[+|\]+$/g, '');
      part = titles.length ? `${partLabel} — ${titles.join(' ')}` : partLabel;
      chapter = null;
      group = null;
      continue;
    }

    if (CHAPTER_LINE.test(line.text) && line.x0 >= CENTERED_MIN_X - 20) {
      flushHeadings();
      close();
      let text = line.text;
      // Wrapped chapter titles are all caps ("... LIABILITIES," / "OBLIGATIONS AND SUITS"); a mixed-case
      // centred line after them is the group heading of the next articles.
      while (lines[index + 1] && isCentered(lines[index + 1]) && /^[^a-z]+$/.test(lines[index + 1].text)
        && !readArticleStart(lines, index + 1)) {
        text = joinLine(text, lines[index + 1].text);
        index += 1;
      }
      chapter = text.replace(/^\[+/, '');
      group = null;
      continue;
    }

    const start = readArticleStart(lines, index);
    if (start) {
      // Articles run in sequence, so the next one is at most a few numbers on; the first one can be anything
      // (a document may begin mid-Constitution).
      const fits = (number, suffix) => {
        const candidate = articleKey(number, suffix);
        if (!lastArticle) return true;
        return isAfter(candidate, lastArticle) && candidate.number <= lastArticle.number + MAX_ARTICLE_STEP;
      };
      if (!fits(start.number, start.suffix)) {
        // "731D." on a page with footnote 7 is footnote marker 7 glued to article 31D.
        const pageNotes = footnotesByPage.get(line.page) ?? [];
        for (let cut = 1; cut < start.number.length; cut += 1) {
          const marker = start.number.slice(0, cut);
          const number = start.number.slice(cut);
          if (number[0] !== '0' && pageNotes.some((note) => note.n === marker) && fits(number, start.suffix)) {
            line.refs.push({ page: line.page, n: marker });
            start.number = number;
            break;
          }
        }
      }
      const key = articleKey(start.number, start.suffix);
      if (fits(start.number, start.suffix)) {
        if (headingBuffer.length) group = headingBuffer.splice(0).map((heading) => heading.text).join(' ');
        lastArticle = key;
        open({
          kind: 'article',
          label: `Art.${start.number}${start.suffix}`,
          heading: start.heading,
          pageStart: line.page,
          inserted: start.inserted,
        });
        for (let used = 0; used < start.consumed; used += 1) current.refs.push(...lines[index + used].refs);
        if (start.rest) current.paragraphs.push(start.rest);
        index += start.consumed - 1;
        continue;
      }
      warnings.push(`p${line.page}: "${line.text.slice(0, 60)}" looks like an article start but is out of sequence`);
    }

    if (isCentered(line)) {
      headingBuffer.push(line);
      continue;
    }

    flushHeadings();
    addLine(line);
  }
  flushHeadings();
  close();

  for (const provision of provisions) {
    if (!provision.text) warnings.push(`${provision.label} has no text`);
  }
  return { provisions, warnings };
};
