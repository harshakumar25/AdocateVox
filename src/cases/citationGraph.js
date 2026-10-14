/**
 * The Supreme Court citation graph: which judgment cites which, and how the
 * reporter recorded the treatment ("relied on", "distinguished", "overruled").
 * Rebuilt in full from the stored references whenever more judgments are
 * indexed, because every new judgment can teach the resolver new citations.
 *
 * A group of parallel citations is resolved to one judgment, most certain first:
 * 1. Official citations from the Court's record: the neutral citation, and the
 *    SCR citation encoded in the dataset key (2017_10_569_999 → "[2017] 10 SCR 569";
 *    S_1976_1_172_477 → "[1976] Supp. 1 SCR 172"). A citation printed without a
 *    volume ("[1950] SCR 88") is tried as volume 1, as the record prints it.
 * 2. Learned citations: a reporter citation printed together with an official
 *    one names the same judgment ("[1978] 2 SCR 621 : (1978) 1 SCC 248"). Each
 *    pairing is a vote; a citation is learned once the votes agree and its year
 *    fits the decision year. This is how body text that cites only SCC resolves.
 * 3. Case names: an unresolved group is matched by name to a judgment decided in
 *    the citation's year or the year before, only when one judgment clearly fits.
 *
 * A self-citation, a "cited" judgment decided after the citing one, or a match
 * whose printed case name shares no distinctive word with the judgment's title
 * (a foreign report: the Supreme Court of Canada's reports are also "SCR") is
 * dropped as a misreading. A judgment is marked overruled ('caution' when partly
 * overruled or held per incuriam) only from the reporter's own label, and only
 * when the later bench is at least as large: a smaller bench cannot overrule a
 * larger one (Central Board of Dawoodi Bohra Community v. State of Maharashtra,
 * (2005) 2 SCC 673).
 */

import { TREATMENT_RANK } from '../parse/judgmentCitations.js';
import { scrCitationFromKey } from '../sources/scOpenData.js';

const aliasKey = (scheme, normalized) => `${scheme}|${normalized}`;

/** The forms a printed citation may take in the Court's record: "[1950] SCR 88" is "[1950] 1 SCR 88" there. */
const recordForms = ({ scheme, normalized }) => {
  const forms = [aliasKey(scheme, normalized)];
  if (scheme === 'SCR') {
    const plain = /^\[(\d{4})\] SCR (\d+)$/.exec(normalized);
    if (plain) forms.push(aliasKey('SCR', `[${plain[1]}] 1 SCR ${plain[2]}`));
    const supp = /^\[(\d{4})\] Supp\. SCR (\d+)$/.exec(normalized);
    if (supp) forms.push(aliasKey('SCR', `[${supp[1]}] Supp. 1 SCR ${supp[2]}`));
  }
  return forms;
};

const yearOf = (date) => (date ? Number(String(date).slice(0, 4)) : null);

/** A report is printed in the decision year or the next; a neutral citation carries the decision year. */
const yearFits = (citation, decidedYear) => {
  if (!citation.year || !decidedYear) return true;
  return citation.scheme === 'INSC' ? citation.year === decidedYear : citation.year >= decidedYear && citation.year <= decidedYear + 1;
};

const GENERIC = new Set(['state', 'union', 'india', 'government', 'govt', 'commissioner', 'collector', 'officer', 'corporation',
  'municipal', 'board', 'director', 'secretary', 'company', 'bank', 'district', 'magistrate', 'income', 'tax', 'general', 'national']);
const NOISE = new Set(['and', 'the', 'ors', 'anr', 'others', 'another', 'etc', 'its', 'through', 'thr', 'with', 'for', 'ltd',
  'limited', 'pvt', 'private', 'mrs', 'smt', 'shri', 'sri', 'case', 'cases', 'law', 'cited', 'see', 'also', 'this', 'court',
  'precedents', 'decision', 'judgment', 'versus', 'vrs', 'per']);
const MIN_NAME_SCORE = 0.6;
const MIN_PETITIONER_SCORE = 0.5;
const MIN_NAME_MARGIN = 0.15;

const nameTokens = (text) => (String(text || '').toLowerCase().replace(/1(?=[a-z])/g, 'i').match(/[a-z]{3,}/g) || [])
  .filter((token) => !NOISE.has(token));

const splitParties = (text) => {
  const parts = String(text || '').split(/\s(?:v\.?|vs\.?|versus)\s/i);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' ')] : null;
};

const weight = (token) => (GENERIC.has(token) ? 0.3 : 1);

/** Share of the record title's party words (weighted) that the printed name contains. */
const sideScore = (printed, recorded) => {
  if (!recorded.length) return null;
  const words = new Set(printed);
  const total = recorded.reduce((sum, token) => sum + weight(token), 0);
  return recorded.reduce((sum, token) => sum + (words.has(token) ? weight(token) : 0), 0) / total;
};

const createNameMatcher = (cases) => {
  const byYear = new Map();
  for (const row of cases) {
    const parties = splitParties(row.title);
    const year = yearOf(row.decided_on);
    if (!parties || !year) continue;
    const entry = { id: row.id, petitioner: [...new Set(nameTokens(parties[0]))], respondent: [...new Set(nameTokens(parties[1]))] };
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(entry);
  }
  return (name, citation) => {
    const parties = splitParties(name);
    if (!parties || !citation.year) return null;
    const petitioner = nameTokens(parties[0]);
    const respondent = nameTokens(parties[1]);
    if (!petitioner.some((token) => !GENERIC.has(token)) && !respondent.some((token) => !GENERIC.has(token))) return null;
    const years = citation.scheme === 'INSC' ? [citation.year] : [citation.year, citation.year - 1];
    const scored = [];
    for (const year of years) {
      for (const entry of byYear.get(year) || []) {
        const pet = sideScore(petitioner, entry.petitioner);
        const resp = sideScore(respondent, entry.respondent);
        if (pet === null || pet < MIN_PETITIONER_SCORE) continue;
        const distinctive = [...entry.petitioner, ...entry.respondent].some((token) => !GENERIC.has(token)
          && (petitioner.includes(token) || respondent.includes(token)));
        if (!distinctive) continue;
        const score = resp === null ? pet : (pet + resp) / 2;
        if (score >= MIN_NAME_SCORE) scored.push({ id: entry.id, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length || (scored[1] && scored[0].score - scored[1].score < MIN_NAME_MARGIN)) return null;
    return scored[0].id;
  };
};

/**
 * A printed name that shares no distinctive word with the judgment a citation resolved to names another
 * case: usually a foreign report with the same abbreviation ("Lavigne v. Canada, (2002) 2 SCR 773" is the
 * Supreme Court of Canada's SCR), or a misread citation. Such a resolution is refused.
 */
const createNameVeto = (cases) => {
  const titles = new Map(cases.map((row) => [row.id, new Set(nameTokens(row.title))]));
  return (name, caseId) => {
    const printed = nameTokens(name).filter((token) => !GENERIC.has(token));
    if (printed.length < 2) return false;
    const title = titles.get(caseId);
    return Boolean(title) && !printed.some((token) => title.has(token));
  };
};

const NEGATIVE = new Map([['overruled', 'overruled'], ['partly_overruled', 'caution'], ['per_incuriam', 'caution']]);
const METHOD_RANK = { alias: 2, learned: 1, name: 0 };

/**
 * Resolves stored references into citation edges.
 *
 * @param {{ references: object[], aliases: {case_id: number, scheme: string, normalized: string}[],
 *   cases: {id: number, source_key: string, title: string, decided_on: string, bench_strength: number}[] }} inputs
 */
export const resolveCitationGraph = ({ references, aliases, cases }) => {
  const caseById = new Map(cases.map((row) => [row.id, row]));
  const official = new Map(aliases.map((alias) => [aliasKey(alias.scheme, alias.normalized), alias.case_id]));
  const derived = [];
  for (const row of cases) {
    const scr = scrCitationFromKey(row.source_key);
    if (scr && !official.has(aliasKey('SCR', scr))) {
      official.set(aliasKey('SCR', scr), row.id);
      derived.push({ caseId: row.id, scheme: 'SCR', normalized: scr });
    }
  }

  const lookup = (table, citation) => {
    for (const form of recordForms(citation)) if (table.has(form)) return table.get(form);
    return null;
  };
  const resolveWith = (table, reference) => {
    const ids = new Set(reference.citations.map((citation) => lookup(table, citation)).filter((id) => id !== null));
    return ids.size === 1 ? [...ids][0] : null;
  };

  const vetoed = createNameVeto(cases);
  const resolved = new Map(); // reference → { caseId, method }
  const conflicts = new Set();
  const mismatched = new Set();
  for (const reference of references) {
    const ids = new Set(reference.citations.map((citation) => lookup(official, citation)).filter((id) => id !== null));
    if (ids.size > 1) conflicts.add(reference);
    if (ids.size !== 1) continue;
    const caseId = [...ids][0];
    if (reference.name && vetoed(reference.name, caseId)) mismatched.add(reference);
    else resolved.set(reference, { caseId, method: 'alias' });
  }

  const learn = (method, minVotes) => {
    const votes = new Map();
    for (const [reference, { caseId, method: how }] of resolved) {
      if (method === 'parallel' ? how !== 'alias' : how !== 'name') continue;
      const decidedYear = yearOf(caseById.get(caseId)?.decided_on);
      for (const citation of reference.citations) {
        const key = aliasKey(citation.scheme, citation.normalized);
        if (official.has(key) || lookup(official, citation) !== null || !yearFits(citation, decidedYear)) continue;
        if (!votes.has(key)) votes.set(key, { citation, tally: new Map() });
        const { tally } = votes.get(key);
        tally.set(caseId, (tally.get(caseId) || 0) + 1);
      }
    }
    const learned = [];
    for (const [key, { citation, tally }] of votes) {
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((sum, [, count]) => sum + count, 0);
      const [caseId, count] = ranked[0];
      if (count >= minVotes && count / total >= 0.8) learned.push({ key, caseId, votes: count, method, ...citation });
    }
    return learned;
  };

  const learnedTable = new Map();
  const learnedAliases = [];
  const adopt = (entries) => {
    for (const entry of entries) {
      if (learnedTable.has(entry.key)) continue;
      learnedTable.set(entry.key, entry.caseId);
      learnedAliases.push({ scheme: entry.scheme, normalized: entry.normalized, caseId: entry.caseId, votes: entry.votes, method: entry.method });
    }
  };
  const applyLearned = () => {
    for (const reference of references) {
      if (resolved.has(reference) || conflicts.has(reference) || mismatched.has(reference)) continue;
      const caseId = resolveWith(learnedTable, reference);
      if (caseId === null) continue;
      if (reference.name && vetoed(reference.name, caseId)) mismatched.add(reference);
      else resolved.set(reference, { caseId, method: 'learned' });
    }
  };

  // A single parallel pairing is strong evidence; agreement between judgments is required otherwise.
  adopt(learn('parallel', 1));
  applyLearned();

  const matchName = createNameMatcher(cases);
  for (const reference of references) {
    if (resolved.has(reference) || conflicts.has(reference) || mismatched.has(reference) || !reference.name) continue;
    const caseId = matchName(reference.name, reference.citations[0]);
    if (caseId !== null) resolved.set(reference, { caseId, method: 'name' });
  }
  adopt(learn('name', 2));
  applyLearned();

  const edges = new Map();
  const stats = {
    references: references.length, byAlias: 0, byLearned: 0, byName: 0, unresolved: 0,
    conflicts: conflicts.size, nameMismatch: mismatched.size, self: 0, later: 0,
  };
  for (const reference of references) {
    const hit = resolved.get(reference);
    if (!hit) {
      if (!mismatched.has(reference)) stats.unresolved += 1;
      continue;
    }
    if (hit.caseId === reference.citing_id) {
      stats.self += 1;
      continue;
    }
    const citing = caseById.get(reference.citing_id);
    const cited = caseById.get(hit.caseId);
    if (citing?.decided_on && cited?.decided_on && cited.decided_on > citing.decided_on) {
      stats.later += 1;
      continue;
    }
    stats[{ alias: 'byAlias', learned: 'byLearned', name: 'byName' }[hit.method]] += 1;
    const key = `${reference.citing_id}|${hit.caseId}`;
    const edge = edges.get(key) || {
      citingId: reference.citing_id, citedId: hit.caseId, inList: false, treatment: null, category: null,
      mentions: 0, refPage: reference.page, context: null, contextPage: null, method: hit.method,
    };
    edge.inList ||= Boolean(reference.in_list);
    edge.mentions += reference.mentions;
    if (reference.category && (!edge.category || TREATMENT_RANK[reference.category] > TREATMENT_RANK[edge.category])) {
      edge.category = reference.category;
      edge.treatment = reference.treatment;
      edge.refPage = reference.page; // where the reporter's label is printed
    }
    if (!edge.context && reference.context) {
      edge.context = reference.context;
      edge.contextPage = reference.context_page;
    }
    if (METHOD_RANK[hit.method] > METHOD_RANK[edge.method]) edge.method = hit.method;
    edges.set(key, edge);
  }

  const statuses = new Map();
  for (const edge of edges.values()) {
    const status = NEGATIVE.get(edge.category);
    if (!status) continue;
    const citing = caseById.get(edge.citingId);
    const cited = caseById.get(edge.citedId);
    const benchAllows = !citing?.bench_strength || !cited?.bench_strength || citing.bench_strength >= cited.bench_strength;
    const later = !citing?.decided_on || !cited?.decided_on || citing.decided_on > cited.decided_on;
    if (!benchAllows || !later) continue;
    if (statuses.get(edge.citedId) !== 'overruled') statuses.set(edge.citedId, status);
  }

  return { edges: [...edges.values()], learned: learnedAliases, statuses, derived, stats };
};

/** Re-resolves every stored reference and swaps in the new graph. */
export const rebuildCitationGraph = (store) => {
  const result = resolveCitationGraph(store.citationGraphInputs());
  for (const alias of result.derived) {
    try {
      store.addCitationAlias(alias.caseId, { scheme: alias.scheme, normalized: alias.normalized });
    } catch {
      // the record already lists this citation under another judgment; keep the record's
    }
  }
  store.replaceCitationGraph(result);
  return { ...result.stats, edges: result.edges.length, learned: result.learned.length, overruled: [...result.statuses.values()].filter((status) => status === 'overruled').length, caution: [...result.statuses.values()].filter((status) => status === 'caution').length };
};
