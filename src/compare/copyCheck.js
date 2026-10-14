/**
 * "Is this copy of the Act current?" — compares any copy of an Act (a coaching
 * site's PDF, a student's download) with the official provisions in the
 * library, without needing a parser for the copy's layout.
 *
 * Two independent signals per provision:
 * - newerThanCopy: its current text took effect after the copy's date, so the
 *   copy cannot be showing it as law in force (deterministic, from the library).
 * - coverage: how much of the official wording appears, in order, in the copy.
 *   The provision is located by voting on where its word 5-grams occur, then
 *   aligned word by word (longest common subsequence) inside that region, so
 *   margin notes and page headers interleaved into the copy's lines cost
 *   nothing. A current copy scores ~1; amended, missing or reworded text scores low.
 * - missing: the official phrases (3+ consecutive words) the copy lacks, so a
 *   short inserted clause in a long Article is caught and shown, not averaged away.
 */

const SHINGLE = 5;
// Fewer words than this gives too few 5-grams to locate ("Omitted.", "[Repealed.]").
const MIN_WORDS = 8;
// Room in the located region for words the copy interleaves (margin notes, running heads).
const REGION_SLACK = 0.6;
const REGION_PAD = 40;
// A page break drops a block of footnotes and a running head into the middle of a provision,
// whatever the provision's length.
const PAGE_BREAK_WORDS = 300;
// Consecutive official words the copy lacks before it counts as a missing phrase; single-word
// misses are typos and hyphenation ("menbers", "legis-lature"), not amendments.
const MIN_MISSING_RUN = 3;
const MAX_ALIGNMENT_CELLS = 40_000_000;
const MAX_REPORTED_PHRASES = 3;
const MAX_PHRASE_WORDS = 16;

const WEF = /w\.\s?e\.\s?f\.\s*(\d{1,2})\s*[-.]\s*(\d{1,2})\s*[-.]\s*(\d{4})/g;

/**
 * The latest "w.e.f." (with effect from) date a copy's amendment footnotes mention, as ISO —
 * roughly how current its text is, whatever date the file itself carries. Null when it has none.
 */
export const latestEffectiveDate = (text) => {
  let latest = null;
  for (const [, day, month, year] of String(text || '').matchAll(WEF)) {
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) continue;
    if (!latest || iso > latest) latest = iso;
  }
  return latest;
};

/** Lower-case word stream with footnote markers ("1[", "2***") and punctuation removed. */
export const comparableWords = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/\d{1,2}(?=\s*[[*])/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);

const shingleAt = (words, index) => words.slice(index, index + SHINGLE).join(' ');

/** Every 5-gram of the copy → the word positions where it starts. */
const indexCopy = (words) => {
  const index = new Map();
  for (let position = 0; position + SHINGLE <= words.length; position += 1) {
    const key = shingleAt(words, position);
    const positions = index.get(key);
    if (positions) positions.push(position);
    else index.set(key, [position]);
  }
  return index;
};

/**
 * Regions of the copy that may hold the provision, best first. Each matching 5-gram votes for the
 * start it implies; words the copy interleaves (footnotes, running heads) push later votes further
 * along, so votes within the provision's slack of each other form one cluster. Clusters are ranked by
 * votes. Boilerplate ("Omitted by the Constitution (Seventh Amendment) Act, 1956") matches in many
 * places, so several regions are returned and the caller keeps the best alignment.
 */
const candidateRegions = (words, copyWords, copyIndex, limit = 3) => {
  const starts = [];
  for (let offset = 0; offset + SHINGLE <= words.length; offset += 1) {
    for (const position of copyIndex.get(shingleAt(words, offset)) || []) starts.push(position - offset);
  }
  starts.sort((a, b) => a - b);

  const gap = REGION_PAD + PAGE_BREAK_WORDS + Math.ceil(words.length * REGION_SLACK);
  const clusters = [];
  for (const start of starts) {
    const last = clusters.at(-1);
    if (last && start - last.to <= gap) {
      last.to = start;
      last.votes += 1;
    } else {
      clusters.push({ from: start, to: start, votes: 1 });
    }
  }
  return clusters
    .sort((a, b) => b.votes - a.votes)
    .slice(0, limit)
    .map(({ from, to }) => [Math.max(0, from - REGION_PAD), Math.min(copyWords.length, to + words.length + REGION_PAD)]);
};

/** Length of the longest common subsequence of two word arrays (two-row DP). */
const lcsLength = (a, b) => {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
};

/**
 * Runs of `a`'s words that an optimal in-order alignment with `b` leaves unmatched — the phrases
 * the copy lacks. Needs the full DP table, so it is only run on the best region, and skipped
 * (null) when the table would be too large to hold.
 */
const unmatchedRuns = (a, b) => {
  const width = b.length + 1;
  // Uint16 cells: an LCS can never exceed a.length, so that must fit too.
  if (a.length > 0xffff || (a.length + 1) * width > MAX_ALIGNMENT_CELLS) return null;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i * width + j] = a[i - 1] === b[j - 1]
        ? table[(i - 1) * width + j - 1] + 1
        : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
    }
  }
  const matched = new Uint8Array(a.length);
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) {
      matched[i - 1] = 1;
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  const runs = [];
  for (let i = 0; i < a.length;) {
    if (matched[i]) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < a.length && !matched[i]) i += 1;
    runs.push(a.slice(start, i));
  }
  return runs;
};

/**
 * How much of a provision the copy holds: the share of its words found in order (0 when it cannot be
 * located at all), and the phrases of MIN_MISSING_RUN+ consecutive words the copy lacks — an inserted
 * clause can be under 1% of a long Article, so the ratio alone would miss it.
 */
const coverageIn = (words, copyWords, copyIndex) => {
  let best = { coverage: 0, region: null };
  for (const region of candidateRegions(words, copyWords, copyIndex)) {
    const coverage = lcsLength(words, copyWords.slice(...region)) / words.length;
    if (coverage > best.coverage) best = { coverage, region };
    if (coverage === 1) break;
  }
  if (!best.region || best.coverage === 1) return { coverage: best.coverage, missing: [] };
  const runs = unmatchedRuns(words, copyWords.slice(...best.region));
  return {
    coverage: best.coverage,
    missing: (runs ?? []).filter((run) => run.length >= MIN_MISSING_RUN).map((run) => run.join(' ')),
  };
};

/** Provisions whose current text took effect after `date`: a copy from that date cannot show them in force. */
export const newerThan = (provisions, date) =>
  provisions
    .filter((provision) => provision.validFrom > date)
    .map(({ label, heading, validFrom }) => ({ label, heading, validFrom }));

/**
 * @param {object} params
 * @param {{label: string, heading: string|null, text: string, validFrom: string}[]} params.provisions official, current
 * @param {string} params.copyText full text of the copy being checked
 * @param {string|null} params.copyDate ISO date the copy dates from (e.g. its Last-Modified), if known
 * @param {number} [params.threshold] coverage below which a provision is reported as differing
 */
export const compareCopyWithProvisions = ({ provisions, copyText, copyDate = null, threshold = 0.9 }) => {
  const copyWords = comparableWords(copyText);
  const copyIndex = indexCopy(copyWords);
  const differs = [];
  let compared = 0;
  let tooShort = 0;

  for (const provision of provisions) {
    const words = comparableWords(provision.text);
    if (words.length < MIN_WORDS) {
      tooShort += 1;
      continue;
    }
    compared += 1;
    const { coverage, missing } = coverageIn(words, copyWords, copyIndex);
    if (coverage < threshold || missing.length) {
      differs.push({
        label: provision.label,
        heading: provision.heading,
        coverage: Math.round(coverage * 100) / 100,
        missing: missing.slice(0, MAX_REPORTED_PHRASES).map((phrase) => {
          const phraseWords = phrase.split(' ');
          return phraseWords.length > MAX_PHRASE_WORDS ? `${phraseWords.slice(0, MAX_PHRASE_WORDS).join(' ')} …` : phrase;
        }),
      });
    }
  }

  differs.sort((a, b) => a.coverage - b.coverage);
  return {
    provisions: provisions.length,
    compared,
    tooShort,
    matching: compared - differs.length,
    newerThanCopy: copyDate ? newerThan(provisions, copyDate) : [],
    differs,
  };
};
