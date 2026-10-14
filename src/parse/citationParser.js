/**
 * Indian case-citation parser.
 *
 * Finds citations in free text and normalises each one to a canonical
 * (scheme, normalized) pair, so the same case resolves whichever reporter a
 * textbook or judgment happened to use. Reporter citations are identifiers
 * only — LawBuddy never copies a reporter's editorial content.
 */

const MAX_VOLUME = 99;
const MIN_YEAR = 1800;

const isPlausibleYear = (year) => year >= MIN_YEAR && year <= new Date().getFullYear() + 1;
const isPlausibleVolume = (volume) => volume === null || (volume >= 1 && volume <= MAX_VOLUME);

const toInt = (value) => (value === undefined || value === null || value === '' ? null : Number.parseInt(value, 10));

/**
 * Each pattern captures named groups and builds the canonical form.
 * Order matters only for overlap resolution: earlier, longer matches win.
 */
const PATTERNS = [
  {
    // Supreme Court neutral citation, from 2023: "2023 INSC 1", "2023INSC1"
    scheme: 'INSC',
    regex: /\b(?<year>(?:19|20)\d{2})\s*INSC\s*(?<page>\d{1,5})\b/g,
    build: ({ year, page }) => ({ normalized: `${year} INSC ${page}`, court: 'SC' }),
  },
  {
    // "2017 SCC OnLine SC 996", "2023 SCC OnLine Del 1234"
    scheme: 'SCC_ONLINE',
    regex: /\b(?<year>(?:19|20)\d{2})\s+SCC\s*On\s*Line\s+(?<court>[A-Z][A-Za-z&]{1,9})\s+(?<page>\d{1,6})\b/g,
    build: ({ year, court, page }) => ({ normalized: `${year} SCC OnLine ${court} ${page}`, court }),
  },
  {
    // "(1994) Supp (3) SCC 5"
    scheme: 'SCC',
    regex: /\(\s*(?<year>\d{4})\s*\)\s*Supp\.?\s*\(\s*(?<volume>\d{1,2})\s*\)\s*S\.?\s?C\.?\s?C\.?\s*(?<page>\d{1,4})\b/g,
    build: ({ year, volume, page }) => ({ normalized: `(${year}) Supp (${volume}) SCC ${page}`, court: 'SC' }),
  },
  {
    // "(2017) 10 SCC 1", "(1973) 4 S.C.C. 225"
    scheme: 'SCC',
    regex: /\(\s*(?<year>\d{4})\s*\)\s*(?<volume>\d{1,2})\s+S\.?\s?C\.?\s?C\.?\s*(?<page>\d{1,4})\b/g,
    build: ({ year, volume, page }) => ({ normalized: `(${year}) ${volume} SCC ${page}`, court: 'SC' }),
  },
  {
    // "AIR 1978 SC 597", "A.I.R. 1990 Del 12", and the e-SCR form "AIR 2023 SUPREME COURT 5709"
    scheme: 'AIR',
    regex: /\bA\.?\s?I\.?\s?R\.?\s*(?<year>\d{4})\s+(?<court>SC|SUPREME\s+COURT|[A-Z][A-Za-z&]{1,9})\s+(?<page>\d{1,5})\b/g,
    build: ({ year, court, page }) => {
      const name = /^SUPREME\s+COURT$/.test(court) ? 'SC' : court;
      return { normalized: `AIR ${year} ${name} ${page}`, court: name };
    },
  },
  {
    // "[1978] 2 SCR 621", "[1950] SCR 88", "[2023] 1 S.C.R. 1", and supplementary volumes in every printed
    // order: "[1976] SUPP. 1 S.C.R. 172" (the Court's own form), "[1976] Supp. SCR 172", "[2004] 2 Suppl. SCR 723".
    scheme: 'SCR',
    regex: /[[(]\s*(?<year>\d{4})\s*[\])]\s*(?:(?<volume>\d{1,2})\s*(?<suppAfter>Supp(?:\s?l)?\.?\s*)?|(?<supp>Supp(?:\s?l)?\.?)\s*(?:\(?\s*(?<suppVolume>\d{1,2})\s*\)?\s*)?)?S\.?\s?C\.?\s?R\.?(?=\s*\d)\s*(?<page>\d{1,4})\b/gi,
    build: ({ year, volume, suppAfter, supp, suppVolume, page }) => {
      if (supp || suppAfter) {
        const number = suppVolume || volume;
        return { normalized: `[${year}] Supp. ${number ? `${number} ` : ''}SCR ${page}`, court: 'SC', volume: number ?? null };
      }
      return { normalized: `[${year}] ${volume ? `${volume} ` : ''}SCR ${page}`, court: 'SC' };
    },
  },
  {
    // Online-database style "1978 SCR (2) 621"
    scheme: 'SCR',
    regex: /\b(?<year>\d{4})\s+S\.?\s?C\.?\s?R\.?\s*\(\s*(?<volume>\d{1,2})\s*\)\s*(?<page>\d{1,4})\b/g,
    build: ({ year, volume, page }) => ({ normalized: `[${year}] ${volume} SCR ${page}`, court: 'SC' }),
  },
  {
    // "(2017) 10 SCALE 1" and "2017 (10) SCALE 1"
    scheme: 'SCALE',
    regex: /(?:\(\s*(?<year>\d{4})\s*\)\s*(?<volume>\d{1,2})|\b(?<yearAlt>\d{4})\s*\(\s*(?<volumeAlt>\d{1,2})\s*\))\s*SCALE\s*(?<page>\d{1,4})\b/g,
    build: ({ year, volume, yearAlt, volumeAlt, page }) => ({
      normalized: `(${year || yearAlt}) ${volume || volumeAlt} SCALE ${page}`,
      court: 'SC',
      year: year || yearAlt,
      volume: volume || volumeAlt,
    }),
  },
  {
    // High Court neutral citations: "2023:DHC:1234", "2024:BHC-AS:1234", "2023:KER:12345", "2023:DHC:1234-DB"
    scheme: 'HC_NEUTRAL',
    regex: /\b(?<year>(?:19|20)\d{2})\s*:\s*(?<court>[A-Z]{2,6}(?:-[A-Z]{1,6})?)\s*:\s*(?<page>\d{1,7})(?:-(?<bench>[A-Z]{1,4})\b)?/g,
    build: ({ year, court, page, bench }) => ({
      normalized: bench ? `${year}:${court}:${page}-${bench}` : `${year}:${court}:${page}`,
      court,
    }),
  },
];

/**
 * Extracts every citation found in `text`, in reading order, without overlaps.
 *
 * @returns {Array<{scheme: string, normalized: string, year: number, volume: number|null,
 *   page: number, court: string|null, raw: string, index: number}>}
 */
export const extractCitations = (text) => {
  if (typeof text !== 'string' || !text) return [];

  const candidates = [];
  PATTERNS.forEach((pattern, priority) => {
    for (const match of text.matchAll(pattern.regex)) {
      const groups = match.groups;
      const built = pattern.build(groups);
      const year = toInt(built.year ?? groups.year);
      const volume = toInt(built.volume ?? groups.volume);
      if (!isPlausibleYear(year) || !isPlausibleVolume(volume)) continue;

      candidates.push({
        scheme: pattern.scheme,
        normalized: built.normalized,
        year,
        volume,
        page: toInt(groups.page),
        court: built.court ?? null,
        raw: match[0],
        index: match.index,
        priority,
      });
    }
  });

  candidates.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length || a.priority - b.priority);

  const accepted = [];
  let coveredUntil = -1;
  for (const candidate of candidates) {
    if (candidate.index < coveredUntil) continue;
    accepted.push(candidate);
    coveredUntil = candidate.index + candidate.raw.length;
  }

  return accepted.map(({ priority, ...citation }) => citation);
};

/**
 * Parses a string that should be exactly one citation (e.g. a search box).
 * Reporter names are accepted in any case. Returns null unless the whole
 * input, ignoring surrounding whitespace and punctuation, is a single
 * recognised citation.
 */
const REPORTER_TOKENS = Object.freeze({
  insc: 'INSC', scc: 'SCC', scr: 'SCR', air: 'AIR', scale: 'SCALE', supp: 'Supp', online: 'OnLine', sc: 'SC',
});

/** Restores canonical casing of reporter names typed in lowercase, e.g. "(2017) 10 scc 1". */
const canonicalizeReporterTokens = (input) =>
  input.replace(/\b(insc|scc|scr|air|scale|supp|online|sc)\b/gi, (token) => REPORTER_TOKENS[token.toLowerCase()]);

export const parseCitation = (input) => {
  if (typeof input !== 'string') return null;
  const trimmed = canonicalizeReporterTokens(input.trim().replace(/^[\s,.;:]+|[\s,.;:]+$/g, ''));
  const [first, ...rest] = extractCitations(trimmed);
  if (!first || rest.length > 0 || first.index !== 0 || first.raw.length !== trimmed.length) return null;
  return first;
};
