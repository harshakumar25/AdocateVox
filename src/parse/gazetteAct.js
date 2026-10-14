/**
 * Sections of a Central Act from its official Gazette of India print
 * (e.g. the Bharatiya Nyaya Sanhita, 2023: CG-DL-E-25122023-250883).
 *
 * The Gazette prints each section's heading in a narrow margin column level
 * with the section's first line ("38. The right of private defence of the body
 * extends…" beside "When right of private defence of body extends to causing
 * death."), alternating sides with the page, and the citations of Acts it
 * refers to in the opposite margin ("45 of 1860."). The input is positioned
 * line segments (workers/pdf_text.py --lines), so the margin can be told from
 * the body by position rather than guessed from text:
 *   - body column: the span of the page's long lines; margin: outside it;
 *   - a section starts where a body line opens with the next number in sequence
 *     ("39." after 38): numbers inside the text never break a section;
 *   - its heading is the margin block whose top is level with that line;
 *   - "CHAPTER XI" + its title, and centred italic sub-headings ("Of the right
 *     of private defence"), become the section's context, not its text.
 */

const HEAD_ZONE_TOP = 76;
// Body lines are 12 pt apart; a chapter title's raised initials sit ~3 pt above its small capitals.
const SAME_LINE = 3.5;
const TOUCHING = 1;
const MIN_LINE_WORDS = 6;
const COLUMN_MARGIN = 3;
const LEFT_MARGIN_START = 6;
const HEADING_ALIGN = 16;
const MARGIN_BLOCK_GAP = 14;
const CENTRED = 40;

const CHAPTER = /^CHAPTER\s+([IVXLC]+)$/;
const SECTION_START = /^(\d{1,3}[A-Z]?)\.\s*(.*)$/;
const ACT_CITATION = /^\d{1,3}\s+of\s+\d{4}\.?$/;
const END_RULE = /^[—–-]{3,}$/;
const KEEP_CENTRED = /^(?:Illustrations?|Explanations?(?:\s+\d+)?|Exceptions?|Example)\.?(?:—)?$/i;
// A centred sub-heading ("Of the right of private defence") is a capitalised phrase; a short centred line
// that ends mid-sentence ("Court; or") is the tail of a clause.
const SUBHEADING = /^[A-Z][^;:,]*[^;:,\s]$/;
const MID_SENTENCE = /\b(?:or|and|the|of|to)$/;
const PARAGRAPH_OPENING = /^(?:\([a-z0-9]{1,4}\)|Explanation|Illustration|Exception|Provided|Example)/;

/** A page's words grouped into printed lines (top to bottom, words left to right), below the page head. */
const wordLines = (page) => {
  const words = page.words.filter((word) => word.top >= HEAD_ZONE_TOP && !/^_+$/.test(word.text))
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines = [];
  for (const word of words) {
    const line = lines.find((candidate) => Math.abs(candidate.top - word.top) <= SAME_LINE);
    if (line) line.words.push(word);
    else lines.push({ top: word.top, words: [word] });
  }
  for (const line of lines) line.words.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => a.top - b.top);
};

const mode = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/**
 * The body column's edges for the whole document: where most full lines begin and end. Margin notes,
 * which sit beside only some lines, cannot move either edge.
 */
export const bodyEdges = (pages) => {
  const lines = pages.flatMap(wordLines).filter((line) => line.words.length >= MIN_LINE_WORDS);
  return {
    left: mode(lines.map((line) => Math.round(line.words[0].x0))),
    right: mode(lines.map((line) => Math.round(line.words.at(-1).x1))),
  };
};

const lineOf = (words) => ({
  x0: words[0].x0,
  x1: words.at(-1).x1,
  top: words[0].top,
  // "(c)an assault" (the clause letter set tight against its first word) → "(c) an assault".
  // Glyphs that touch belong to one word ("O" + "F" of a small-capitals "OF"); a gap separates words.
  // U+FFFE is how this print encodes a hyphen at the end of a line ("search-" / "warrant").
  text: words.map((word, index) => (index && (word.sp || word.x0 - words[index - 1].x1 >= TOUCHING) ? ` ${word.text}` : word.text)).join('')
    .replace(/\uFFFE/g, '-')
    .replace(/^(\([a-z0-9]{1,4}\))(?=[A-Za-z])/, '$1 '),
});

/** Splits one page into body lines and margin heading blocks, by position. */
export const columnsOf = (page, { left, right }) => {
  const body = [];
  const marginLines = [];
  // A word belongs to a margin by where it starts: a left-margin word can end within a point of the body
  // ("person." 91–116.2 beside a body starting at 117.6), but no body word starts left of the body edge.
  const inLeftMargin = (word) => word.x0 <= left - LEFT_MARGIN_START;
  const inRightMargin = (word) => word.x0 >= right + COLUMN_MARGIN;
  for (const line of wordLines(page)) {
    const bodyWords = line.words.filter((word) => !inLeftMargin(word) && !inRightMargin(word));
    const leftMargin = line.words.filter(inLeftMargin);
    const rightMargin = line.words.filter(inRightMargin);
    if (bodyWords.length) body.push(lineOf(bodyWords));
    for (const words of [leftMargin, rightMargin]) if (words.length) marginLines.push(lineOf(words));
  }

  const margin = [];
  for (const line of marginLines.sort((a, b) => a.top - b.top)) {
    if (ACT_CITATION.test(line.text)) continue;
    const block = margin.at(-1);
    if (block && !block.closed && line.top - block.bottom <= MARGIN_BLOCK_GAP) {
      block.text = block.text.endsWith('-') ? `${block.text}${line.text}` : `${block.text} ${line.text}`;
      block.bottom = line.top;
    } else {
      margin.push({ text: line.text, top: line.top, bottom: line.top, closed: false });
    }
    // A heading ends with a full stop; the next margin line starts another.
    if (/\.$/.test(line.text)) margin.at(-1).closed = true;
  }
  return { body, margin: margin.map(({ text, top }) => ({ text: text.replace(/\s+/g, ' ').trim(), top })), left, right };
};

const MIN_RESPACE = 6;

/**
 * Restores the spaces a small-capitals title loses in extraction ("GENERALEXCEPTIONS" → "GENERAL
 * EXCEPTIONS"), using the Act's own words: a run is split only when it splits completely into words the
 * Act uses, preferring the fewest (so the longest) words. Anything else is left as printed.
 */
export const respaceCapitals = (title, vocabulary) => String(title || '').replace(/[A-Z]{6,}/g, (run) => {
  const lower = run.toLowerCase();
  const best = Array(lower.length + 1).fill(null);
  best[0] = [];
  for (let end = 1; end <= lower.length; end += 1) {
    for (let start = Math.max(0, end - 20); start <= end - 2; start += 1) { // words of two letters or more
      const word = lower.slice(start, end);
      if (best[start] && vocabulary.has(word) && (!best[end] || best[start].length + 1 < best[end].length)) {
        best[end] = [...best[start], word];
      }
    }
  }
  return run.length >= MIN_RESPACE && best[lower.length] ? best[lower.length].join(' ').toUpperCase() : run;
});

/** A chapter title as printed, without extraction artefacts: letter-spacing, lost spaces, stray spaces. */
const tidyTitle = (title, vocabulary) => respaceCapitals(
  title
    .replace(/\s+/g, ' ')
    .replace(/\b(?:[A-Z] ){2,}[A-Z]\b/g, (spaced) => spaced.replace(/ /g, '')) // "D E C E N C Y"
    .replace(/\b([A-Z]{2,}) ([A-Z])\b/g, (whole, word, letter) => (vocabulary.has(`${word}${letter}`.toLowerCase()) ? `${word}${letter}` : whole))
    .replace(/\s+-/g, '-'),
  vocabulary,
).replace(/\s*,\s*/g, ', ').replace(/\s+\./g, '.').replace(/\s+/g, ' ').trim();

const isCapitals = (text) => {
  const letters = text.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.9;
};

const isCentred = (line, left, right) => line.x0 - left > CENTRED && right - line.x1 > CENTRED;

/** Joins a section's lines into text, keeping sub-sections, clauses, provisos and explanations as paragraphs. */
const sectionText = (lines, left) => {
  const paragraphs = [];
  for (const line of lines) {
    const indented = line.x0 - left > 12;
    const opens = PARAGRAPH_OPENING.test(line.text) || KEEP_CENTRED.test(line.text);
    if (!paragraphs.length || opens || (indented && /[.:;—–]$/.test(paragraphs.at(-1)))) {
      paragraphs.push(line.text);
    } else {
      // A line ending in a hyphen continues the word on the next line ("house-" + "breaker").
      paragraphs[paragraphs.length - 1] += /\w-$/.test(paragraphs.at(-1)) ? line.text : ` ${line.text}`;
    }
  }
  return paragraphs.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()).join('\n');
};

/**
 * @param {{ page: number, lines: {x0: number, x1: number, top: number, text: string}[] }[]} pages
 * @returns {{ sections: Array<{ number: string, label: string, heading: string|null, text: string, page: number,
 *   chapter: string|null, chapterTitle: string|null, subheading: string|null }>, warnings: string[] }}
 */
export const parseGazetteAct = (pages) => {
  const sections = [];
  const warnings = [];
  let chapter = null;
  let chapterTitle = null;
  let subheading = null;
  let expecting = null; // 'chapter-title' right after "CHAPTER XI"
  let current = null;
  let ended = false;

  const nextNumber = () => (sections.length ? Number.parseInt(sections.at(-1).number, 10) + 1 : 1);
  const edges = bodyEdges(pages);
  let titleTop = null;

  let pendingHeading = null; // a section whose margin heading did not end on its page
  for (const page of pages) {
    if (ended) break;
    const { body, margin, left, right } = columnsOf(page, edges);
    const headings = [...margin];
    // A heading too long for the foot of a page runs on at the top of the next ("innocent" / "person."):
    // the first margin block, if no section starts level with it, completes the unfinished heading.
    const startTops = body.filter((line) => SECTION_START.test(line.text)).map((line) => line.top);
    if (pendingHeading && headings.length && !startTops.some((top) => Math.abs(top - headings[0].top) <= HEADING_ALIGN)) {
      pendingHeading.heading = `${pendingHeading.heading}${/-$/.test(pendingHeading.heading) ? '' : ' '}${headings.shift().text}`;
    }
    pendingHeading = null;
    for (const line of body) {
      if (END_RULE.test(line.text) && current) {
        ended = true;
        break;
      }
      const chapterMatch = CHAPTER.exec(line.text);
      if (chapterMatch) {
        chapter = chapterMatch[1];
        chapterTitle = null;
        subheading = null;
        expecting = 'chapter-title';
        continue;
      }
      // A chapter title is set in capitals, may run to two lines (the first full width), and may be
      // printed with a raised initial ("G" a little above "ENERAL EXCEPTIONS").
      if (expecting === 'chapter-title' && isCapitals(line.text) && !SECTION_START.test(line.text)) {
        if (chapterTitle && line.top - titleTop > 20) {
          expecting = null;
        } else {
          chapterTitle = chapterTitle ? `${chapterTitle}${/^[A-Z]$/.test(chapterTitle) ? '' : ' '}${line.text}` : line.text;
          titleTop = line.top;
          continue;
        }
      }
      expecting = null;
      const start = SECTION_START.exec(line.text);
      if (start && Number.parseInt(start[1], 10) === nextNumber() && line.x0 - left < 40) {
        // The heading printed level with this line, nearest first.
        const candidates = headings
          .map((heading, index) => ({ index, distance: Math.abs(heading.top - line.top) }))
          .filter((candidate) => candidate.distance <= HEADING_ALIGN)
          .sort((a, b) => a.distance - b.distance);
        const heading = candidates.length ? headings.splice(candidates[0].index, 1)[0].text : null;
        if (!heading) warnings.push(`s.${start[1]}: no margin heading level with the section (page ${page.page})`);
        current = {
          number: start[1],
          label: `s.${start[1]}`,
          heading,
          lines: [{ ...line, text: start[2] }],
          page: page.page,
          chapter,
          chapterTitle,
          subheading,
        };
        sections.push(current);
        if (heading && !/\.$/.test(heading)) pendingHeading = current;
        continue;
      }
      if (!current) continue; // the long title and enacting formula
      if (isCentred(line, left, right) && !KEEP_CENTRED.test(line.text) && !PARAGRAPH_OPENING.test(line.text)
        && SUBHEADING.test(line.text) && !MID_SENTENCE.test(line.text)) {
        subheading = line.text; // "Of the right of private defence": applies to the sections that follow
        continue;
      }
      current.lines.push(line);
    }
  }

  const built = sections.map(({ lines, ...section }) => ({
    ...section,
    text: sectionText(lines.filter((line) => line.text), Math.min(...lines.map((line) => line.x0))),
  }));
  const vocabulary = new Set(built.flatMap((section) => `${section.text} ${section.heading || ''}`.toLowerCase().match(/[a-z]+/g) || []));
  return {
    sections: built.map((section) => ({
      ...section,
      chapterTitle: section.chapterTitle && tidyTitle(section.chapterTitle, vocabulary),
    })),
    warnings,
  };
};
