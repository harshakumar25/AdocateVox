/**
 * Precedent points: how strongly a Supreme Court judgment speaks to a provision,
 * computed only from the official record and always returned with its reasons.
 *
 * - Bench strength: a larger bench binds every smaller one; five or more is a
 *   Constitution Bench (Art. 145(3)).
 * - Catchword position: the official SCR headnote opens with the provisions a
 *   judgment is about; leading with this one means the case is centrally on it.
 * - Citations: how many later judgments in the full-text index cite it, the
 *   landmark signal of citation-network studies (IIIT-H, WWW 2015; DU 2024).
 *   Banded, so a heavily cited case gains standing without swamping the bench.
 * - For a judgment linked only through its text (no headnote names the
 *   provision), how often the text names the provision.
 *
 * Opinions (reviews) are never mixed into the points; they are shown beside them.
 */

const BENCH_POINTS = [[13, 60], [9, 50], [7, 45], [5, 40], [3, 20], [2, 10], [1, 5]];
export const CONSTITUTION_BENCH = 5;

export const benchPoints = (bench) => {
  if (!Number.isInteger(bench) || bench < 1) return 0;
  return BENCH_POINTS.find(([size]) => bench >= size)[1];
};

export const catchwordPoints = (position) => {
  if (!Number.isInteger(position) || position < 0) return 0;
  if (position === 0) return 30;
  if (position === 1) return 20;
  return position <= 3 ? 12 : 6;
};

const CITATION_POINTS = [[50, 40], [20, 32], [10, 24], [5, 16], [2, 10], [1, 5]];
const MENTION_POINTS = [[20, 20], [10, 15], [5, 10], [3, 5]];
const banded = (bands, count) => (Number.isInteger(count) && count > 0 ? bands.find(([least]) => count >= least)?.[1] ?? 0 : 0);

export const citationPoints = (citedBy) => banded(CITATION_POINTS, citedBy);
export const mentionPoints = (mentions) => banded(MENTION_POINTS, mentions);

const ordinal = (n) => ['lead', '2nd', '3rd'][n] ?? `${n + 1}th`;
const human = (label) => label.replace('Art.', 'Art. ');

/** Points and their reasons for one judgment on one provision. */
export const scoreCase = ({ bench_strength: bench, position, cited_by: citedBy, mentions }, label) => {
  const breakdown = [];
  const fromBench = benchPoints(bench);
  if (fromBench) {
    breakdown.push({
      points: fromBench,
      reason: `${bench}-judge bench${bench >= CONSTITUTION_BENCH ? ' (Constitution Bench)' : ''}`,
    });
  }
  const fromCatchword = catchwordPoints(position);
  if (fromCatchword) {
    breakdown.push({ points: fromCatchword, reason: `${human(label)} is the ${ordinal(position)} provision in the official headnote` });
  }
  const fromCitations = citationPoints(citedBy);
  if (fromCitations) {
    breakdown.push({ points: fromCitations, reason: `Cited in ${citedBy} later judgment${citedBy === 1 ? '' : 's'} in the full-text index` });
  }
  // Text mentions count only where no headnote links the provision: there, they are the link.
  const fromMentions = position === null || position === undefined ? mentionPoints(mentions) : 0;
  if (fromMentions) {
    breakdown.push({ points: fromMentions, reason: `${human(label)} is named ${mentions} times in the judgment's text` });
  }
  return { points: breakdown.reduce((sum, item) => sum + item.points, 0), breakdown };
};

/** Highest points first; ties go to the earlier judgment (it set the law the later one applies). */
export const rankCases = (rows, label) =>
  rows
    .map((row) => ({ row, ...scoreCase(row, label) }))
    .sort((a, b) => b.points - a.points
      || String(a.row.decided_on || '9999').localeCompare(String(b.row.decided_on || '9999'))
      || a.row.id - b.row.id);
