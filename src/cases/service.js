/**
 * Supreme Court judgments for a provision of the Constitution, ranked by
 * precedent points (see rank.js), for the CLI and GET /lawbuddy/api/cases.
 *
 * When no indexed judgment's headnote names the provision itself, judgments
 * whose full text discusses it are offered (relation 'text'); failing that, the
 * judgments on closely related provisions, each marked with the provision it
 * actually interprets.
 *
 * Every card carries what the citation graph knows: how many later judgments
 * cite it, how a few of them put it (their own sentence, with the page), and
 * whether the reporter records it as overruled, and by whom. Related means: in the same group
 * of the Constitution or cross-referenced by the provision's official text
 * ("subject to the provisions of article 67"), ordered by how much the official
 * headings share: for Article 68 (filling a Vice-President vacancy), the
 * election Articles 66 and 71 come before Article 72 (pardons).
 */

import { CONSTITUTION_ACT } from '../ingest/constitution.js';
import { toConstitutionLabel } from '../service.js';
import { CONSTITUTION_BENCH, rankCases } from './rank.js';

const HEADNOTE_CHARS = 600;
const CROSS_REFERENCE_BONUS = 3;
const HEADING_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'etc', 'certain', 'cases', 'other', 'any', 'such', 'its', 'their']);
const LATEST = 3;
const CITING_CONTEXTS = 3;
const MIN_TEXT_MENTIONS = 3;
const NEGATIVE = new Set(['overruled', 'partly_overruled', 'per_incuriam', 'questioned']);
const TREATMENT_WORDS = {
  overruled: 'Overruled', partly_overruled: 'Partly overruled', per_incuriam: 'Held per incuriam', questioned: 'Doubted',
};

const contextOf = (provision) => {
  try {
    return JSON.parse(provision.context || '{}') || {};
  } catch {
    return {};
  }
};

/** Article cross-references in a provision's official text, in order. */
export const referencedArticles = (text) =>
  [...new Set([...String(text || '').matchAll(/\barticles?\s+(\d{1,3}[A-Z]{0,3})\b/gi)].map(([, number]) => `Art.${number.toUpperCase()}`))];

/** The meaningful words of an official heading ("Election of Vice-President" → election, vice, president). */
const headingWords = (heading) =>
  new Set((String(heading || '').toLowerCase().match(/[a-z]+/g) || []).filter((word) => word.length > 2 && !HEADING_STOP_WORDS.has(word)));

const citingCase = (row) => ({
  id: row.citing_id,
  title: row.title,
  decidedOn: row.decided_on,
  benchStrength: row.bench_strength,
  pdfUrl: row.pdf_url,
});

/** What later judgments in the full-text index say about one judgment. */
const citationsOf = (store, caseId) => {
  const citing = store.citedBy(caseId);
  const treatments = citing.filter((row) => NEGATIVE.has(row.category)).map((row) => ({
    ...citingCase(row),
    treatment: TREATMENT_WORDS[row.category],
    printed: row.treatment,
    page: row.ref_page,
    // A smaller bench cannot overrule a larger one: such a label is shown, but sets no status.
    binding: !row.bench_strength || row.bench_strength >= (store.getCase(caseId)?.bench_strength ?? 0),
  }));
  const contexts = citing.filter((row) => row.context).slice(0, CITING_CONTEXTS).map((row) => ({
    ...citingCase(row),
    treatment: row.treatment,
    context: row.context,
    page: row.context_page,
  }));
  return { count: citing.length, treatments, contexts };
};

const toCard = (store, { row, points, breakdown, via = null }) => {
  const brief = store.getCaseBrief(row.id);
  const reviews = store.verifiedReviewsFor(row.id);
  return {
    id: row.id,
    title: row.title,
    decidedOn: row.decided_on,
    benchStrength: row.bench_strength,
    constitutionBench: Number(row.bench_strength) >= CONSTITUTION_BENCH,
    coram: row.coram,
    author: row.author,
    caseNo: row.case_no,
    disposal: row.disposal,
    citations: row.aliases.map((alias) => alias.normalized),
    headnote: row.headnote && row.headnote.length > HEADNOTE_CHARS ? `${row.headnote.slice(0, HEADNOTE_CHARS)}…` : row.headnote,
    pdfUrl: row.pdf_url,
    sourceUrl: row.source_url,
    points,
    breakdown,
    via,
    status: row.status,
    mentions: row.mentions ?? null,
    citedBy: citationsOf(store, row.id),
    brief: brief
      ? { ...brief.brief, model: brief.model, generatedAt: brief.generated_at, kept: brief.kept, dropped: brief.dropped }
      : null,
    reviews: { count: reviews.reviews, average: reviews.average, items: reviews.items },
  };
};

const byDateDescending = (a, b) => String(b.row.decided_on || '').localeCompare(String(a.row.decided_on || ''));

export const casesForProvision = (store, { provision, limit = 6 }) => {
  const label = toConstitutionLabel(provision);
  if (!label?.startsWith('Art.')) {
    return { ok: false, status: 400, error: 'Name an Article of the Constitution, e.g. "21" or "Art.21".' };
  }
  const actId = store.findAct(CONSTITUTION_ACT);
  if (!actId) return { ok: false, status: 503, error: 'The Constitution is not in the library yet.' };
  const provisions = store.currentProvisions(actId);
  const self = provisions.find((candidate) => candidate.label === label);
  if (!self) return { ok: false, status: 404, error: `${label} is not in the official text of the Constitution.` };

  const { cases, earliest, latest } = store.caseStats();
  const text = store.textIndexStats();
  const base = {
    ok: true,
    provision: label,
    heading: self.heading,
    library: {
      cases, earliest, latest,
      textIndex: { judgments: text.judgments, earliest: text.earliest, latest: text.latest, citations: text.edges },
    },
  };

  const direct = rankCases(store.casesForProvision({ label }), label);
  if (direct.length) {
    return {
      ...base,
      relation: 'direct',
      total: direct.length,
      cases: direct.slice(0, limit).map((ranked) => toCard(store, ranked)),
      latest: [...direct].sort(byDateDescending).slice(0, LATEST).map((ranked) => toCard(store, ranked)),
    };
  }

  const discussed = rankCases(store.casesMentioning({ label, minMentions: MIN_TEXT_MENTIONS }), label);
  if (discussed.length) {
    return {
      ...base,
      relation: 'text',
      total: discussed.length,
      cases: discussed.slice(0, limit).map((ranked) => toCard(store, ranked)),
      latest: [...discussed].sort(byDateDescending).slice(0, LATEST).map((ranked) => toCard(store, ranked)),
    };
  }

  const own = contextOf(self);
  const ownWords = headingWords(self.heading);
  const referenced = new Set(referencedArticles(self.text));
  const relatedness = new Map();
  for (const candidate of provisions) {
    if (candidate.label === label || !candidate.label.startsWith('Art.')) continue;
    const context = contextOf(candidate);
    const sameGroup = own.group ? context.group === own.group && context.part === own.part : Boolean(own.chapter) && context.chapter === own.chapter;
    if (!sameGroup && !referenced.has(candidate.label)) continue;
    const shared = [...headingWords(candidate.heading)].filter((word) => ownWords.has(word)).length;
    const score = shared + (referenced.has(candidate.label) ? CROSS_REFERENCE_BONUS : 0);
    if (score > 0) relatedness.set(candidate.label, score);
  }
  const relatedLabels = [...relatedness.keys()].sort((a, b) => relatedness.get(b) - relatedness.get(a));

  const best = new Map();
  for (const related of relatedLabels) {
    for (const ranked of rankCases(store.casesForProvision({ label: related }), related)) {
      const candidate = { ...ranked, via: related, relatedness: relatedness.get(related) };
      const known = best.get(ranked.row.id);
      if (!known || known.relatedness < candidate.relatedness
        || (known.relatedness === candidate.relatedness && known.points < candidate.points)) {
        best.set(ranked.row.id, candidate);
      }
    }
  }
  const relatedCases = [...best.values()]
    .sort((a, b) => b.relatedness - a.relatedness || b.points - a.points || a.row.id - b.row.id);
  return {
    ...base,
    relation: relatedCases.length ? 'related' : 'none',
    total: 0,
    relatedLabels,
    cases: relatedCases.slice(0, limit).map((ranked) => toCard(store, ranked)),
    latest: [],
  };
};

const CITING_LIMIT = 200;

/**
 * Every later judgment in the full-text index that cites one judgment, newest first: the reporter's
 * treatment where it lists the case, and the citing judgment's own sentence where it discusses it.
 */
export const citingJudgments = (store, caseId, { limit = CITING_LIMIT } = {}) => {
  const judgment = store.getCase(caseId);
  if (!judgment) return { ok: false, status: 404, error: 'No such judgment in the library.' };
  const citing = store.citedBy(caseId);
  const text = store.textIndexStats();
  return {
    ok: true,
    case: {
      id: judgment.id, title: judgment.title, decidedOn: judgment.decided_on,
      benchStrength: judgment.bench_strength, status: judgment.status, pdfUrl: judgment.pdf_url,
    },
    total: citing.length,
    textIndex: { judgments: text.judgments, earliest: text.earliest, latest: text.latest },
    citing: citing.slice(0, limit).map((row) => ({
      ...citingCase(row),
      treatment: row.treatment,
      category: row.category,
      inReporterList: Boolean(row.in_list),
      mentions: row.mentions,
      resolvedBy: row.method,
      page: row.ref_page,
      context: row.context,
      contextPage: row.context_page,
    })),
  };
};
