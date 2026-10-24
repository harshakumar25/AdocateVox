import { PRACTICE_ACTS } from '../ingest/libraryCatalog.js';
import { detectLegalReferences, retrieveLegalEvidence } from '../retrieval/legalRetriever.js';
import { getActProvision, today } from '../service.js';
import { identifyReportTask, resolveCaseRequest } from './task.js';

const TYPES = Object.freeze({ memo: 'Legal research memorandum', opinion: 'Legal opinion', preparation: 'Case preparation report', legislative: 'Legislative and policy research report' });
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const metadata = (item, key) => item?.metadata?.[key]?.[0]?.value ?? '';
const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
const discoverActs = (prompt) => PRACTICE_ACTS.filter((act) => act.jurisdiction === 'IN' && act.instrumentType !== 'standard'
  && [act.title, ...act.aliases].some((alias) => alias.length >= 4 && new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(prompt))).slice(0, 2);

export const searchOfficialOnlineLeads = async (prompt, { fetchFn = fetch } = {}) => {
  const acts = discoverActs(prompt);
  const results = [];
  for (const act of acts) {
    const url = new URL('https://indiacode.gov.in/server/api/discover/search/objects');
    url.searchParams.set('query', act.title);
    url.searchParams.set('size', '20');
    try {
      const response = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
      if (!response.ok) continue;
      const json = await response.json();
      const objects = json?._embedded?.searchResult?._embedded?.objects ?? [];
      for (const object of objects) {
        const item = object?._embedded?.indexableObject;
        const title = metadata(item, 'dc.identifier.act_name') || item?.name;
        const handle = item?.handle;
        if (!title || !handle || norm(title) !== norm(act.title) || norm(item.name) !== norm(act.title)) continue;
        if (results.some((lead) => lead.url.endsWith(handle))) continue;
        const catalogueJurisdiction = metadata(item, 'dc.identifier.state_name') || 'unspecified';
        results.push({ title: item.name || title, url: `https://indiacode.gov.in/handle/${handle}`,
          status: 'online-catalogue-lead', catalogueJurisdiction,
          note: `India Code ${catalogueJurisdiction} catalogue metadata only. Open the record and verify text, amendments and commencement before citation.` });
        break;
      }
    } catch { /* Network lookup is optional; the indexed report remains usable. */ }
  }
  return results;
};

const cyberCompanions = (store, references, asOf, existing) => {
  if (!references.sections.some((item) => item.act === 'IT2000' && ['s.43', 's.66'].includes(item.label))) return [];
  const needed = ['s.43', 's.66'].filter((label) => !existing.some((item) => item.act === 'IT2000' && item.label === label));
  return needed.flatMap((label) => {
    const result = getActProvision(store, 'IT2000', label.slice(2), asOf);
    return result.ok ? [{ kind: 'statute', act: 'IT2000', label, title: `${result.actTitle} ${label} — ${result.heading}`,
      url: result.source.url, content: `Official indexed text, reviewed through ${result.reviewedThrough || 'unspecified'}:\n${result.text}` }] : [];
  });
};

const parseModel = (text) => {
  const value = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch {
    const first = value.indexOf('{'); const last = value.lastIndexOf('}');
    try { return first >= 0 && last > first ? JSON.parse(value.slice(first, last + 1)) : null; } catch { return null; }
  }
};
const normalized = (value) => String(value || '').replace(/[\u00a0\u2000-\u200b\u202f\s]+/g, ' ').trim().toLowerCase();
const claimTerms = (value) => new Set((normalized(value).match(/[a-z]{4,}/g) || []).filter((word) =>
  !/^(about|above|after|again|also|been|case|cited|claim|could|from|have|into|itself|legal|more|must|needs|only|that|their|them|there|these|this|those|under|when|where|which|with|would)$/.test(word)));
const statements = (value, ids, sources) => (Array.isArray(value) ? value : []).slice(0, 8).map((item) => ({
  text: clean(item?.text, 1200), quote: clean(item?.quote, 700),
  evidenceIds: [...new Set((Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).filter((id) => ids.has(id)))],
})).filter((item) => {
  if (!item.text || !item.evidenceIds.length || !item.quote || normalized(item.quote).length < 20) return false;
  const cited = item.evidenceIds.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
  if (!cited.some((source) => normalized(source.text).includes(normalized(item.quote)))) return false;
  const terms = claimTerms(item.text); const quoteTerms = claimTerms(item.quote);
  if (terms.size && [...terms].filter((word) => quoteTerms.has(word)).length / terms.size < 0.2) return false;
  if (cited.every((source) => source.kind === 'indexed-official-text')
    && /\b(?:court (?:held|ruled|observed|found)|judg(?:e)?ment (?:held|says)|case (?:held|decided)|ratio decidendi|landmark case)\b/i.test(item.text)) return false;
  const has43 = cited.some((source) => source.act === 'IT2000' && source.label === 's.43');
  const has66 = cited.some((source) => source.act === 'IT2000' && source.label === 's.66');
  const claim = item.text.replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ');
  const criminal = /criminal|punish|imprison|offen[cs]e/i.test(claim);
  if (has43 && criminal && !has66 && !/\b(?:not|no|separate|distinct|unlike)\b/i.test(claim)) return false;
  if (has66 && criminal && !/dishonest|fraudulen|intent|mens rea/i.test(claim)) return false;
  if (has43 && /(?:mere|only).*potenti(?:al|ally).*damage.*sufficien/i.test(claim)) return false;
  if (has43 && /(?:absence|lack|without|no) (?:of )?(?:actual )?(?:damage|disruption).{0,65}(?:limit|negat|preclud|defen[cs]e)/i.test(claim)) return false;
  if (has43 && /section\s*43.{0,70}(?:requires?|only|must).{0,45}(?:damage|disruption)/i.test(claim)) return false;
  if (has66 && /(?:routine|good.faith|non.malicious).{0,100}(?:does not|cannot|will not).{0,50}(?:dishonest|fraudulen|element)/i.test(claim)) return false;
  if (has66 && /(?:bypass|exfiltrat|disrupt).{0,100}likely.{0,30}(?:dishonest|fraudulen)/i.test(claim)) return false;
  if (has66 && /(?:section|sections)\s*24\s*(?:and|&)\s*25.{0,120}(?:mean|intend|deceiv)/i.test(claim)
    && !cited.some((source) => ['IPC', 'BNS'].includes(source.act))) return false;
  return true;
});
const notes = (value) => (Array.isArray(value) ? value : []).slice(0, 10)
  .map((item) => clean(typeof item === 'string' ? item : item?.text || item?.action || item?.gap || '', 500)).filter(Boolean);

export const createLegalReport = async ({ store, input, generate, onlineSearch = searchOfficialOnlineLeads }) => {
  const prompt = clean(input?.prompt, 5001);
  if (prompt.length < 15 || prompt.length > 5000) return { ok: false, status: 400, error: 'Describe the legal question in 15–5000 characters.' };
  const type = TYPES[input?.type] ? input.type : 'memo';
  const asOf = input?.asOf || today();
  if (!ISO.test(asOf) || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf) return { ok: false, status: 400, error: 'Use a valid as-of date (YYYY-MM-DD).' };
  if (asOf > today()) return { ok: false, status: 400, error: 'A report cannot verify law for a future date.' };
  if (!['ollama', 'grok', 'groq'].includes(input?.provider)) return { ok: false, status: 400, error: 'Choose local Ollama, xAI Grok or Groq.' };
  const jurisdiction = clean(input?.jurisdiction || 'India', 120);
  const scope = { type, typeLabel: TYPES[type], asOf, jurisdiction, prompt, generatedAt: new Date().toISOString(), provider: input.provider };
  const task = identifyReportTask(prompt);
  if (task.kind === 'named-case') {
    const caseCheck = resolveCaseRequest(store, task);
    return { ok: true, ...scope, status: 'identity-check-required', caseCheck,
      sections: Object.fromEntries(['executiveSummary', 'issues', 'applicableLaw', 'analysis', 'counterarguments', 'conclusion'].map((key) => [key, []])),
      nextSteps: ['Supply an exact citation, court, case number or official judgment PDF for the intended case.',
        'Confirm the case identity and read the judgment before requesting a case analysis.'],
      researchGaps: [], sources: [], onlineLeads: [],
      warnings: ['No case holding, facts, issues or subsequent treatment has been verified. Candidate names are identity leads, not authority.'] };
  }
  const references = detectLegalReferences(prompt);
  const explicit = retrieveLegalEvidence({ store, references, asOf }).filter((item) => item.kind === 'statute');
  const companions = cyberCompanions(store, references, asOf, explicit);
  const selected = [...explicit, ...companions];
  const indexed = selected.slice(0, 6)
    .map((item, index) => ({ id: `S${index + 1}`, kind: 'indexed-official-text', act: item.act, title: item.title, label: item.label, url: item.url, text: item.content.slice(0, 1800) }));
  const leads = input?.online ? await onlineSearch(prompt) : [];
  const ids = new Set(indexed.map((item) => item.id));
  let draft = null;
  if (indexed.length && generate) {
    const systemPrompt = `You are a careful Indian legal researcher. Return one valid JSON object only. Keys: executiveSummary, issues, applicableLaw, analysis, counterarguments, conclusion, nextSteps, researchGaps. First six values are arrays of {"text":"short proposition","evidenceIds":["S1"],"quote":"exact supporting words copied from S1"}. Quote must be an exact span of at least 20 characters from one cited source. A source ID alone does not support a claim. Cite only listed source IDs; omit unsupported legal propositions. Statutes do not establish judgment facts, holdings or later treatment. Distinguish alleged facts from proved facts. Never invent case law or holdings. Last two values are arrays of {"text":"research task or open question"}, never conclusions. Include adverse arguments and limits. Keep under 1500 words.${indexed.some((item) => item.act === 'IT2000' && item.label === 's.43') ? ' Specific accuracy rule: IT Act section 43 concerns compensation for listed conduct without permission; it is not itself the criminal offence. Access under clause (a) is a separate listed act; damage or disruption need not be proved for every clause. Section 66 concerns acts referred to in section 43 done dishonestly or fraudulently. Do not equate every scan with disruption or damage. Analyse conduct, permission and required mental element separately.' : ''}`;
    const userPrompt = JSON.stringify({ task: 'Produce an internal legal research report, not a filing document.', question: prompt, jurisdiction, asOf, type: TYPES[type],
      evidence: indexed.map(({ id, title, text }) => ({ id, title, text })), onlineCatalogueLeads: leads });
    try { draft = parseModel(await generate({ systemPrompt, prompt: userPrompt, provider: input.provider })); } catch (error) {
      return { ok: false, status: error.statusCode || 502, error: error.message || 'The model could not generate the report.' };
    }
  }
  const sections = Object.fromEntries(['executiveSummary', 'issues', 'applicableLaw', 'analysis', 'counterarguments', 'conclusion']
    .map((key) => [key, statements(draft?.[key], ids, indexed)]));
  const researchGaps = notes(draft?.researchGaps);
  const systemStatus = !indexed.length ? 'No specifically identified official provision was available in the local index for this question and date.' : null;
  const hasAnalysis = Object.values(sections).some((items) => items.length);
  if (indexed.length && !hasAnalysis) {
    researchGaps.unshift('The model returned no claim with a valid source quotation. Review the indexed material directly.');
  }
  if (references.constitution.length + references.sections.length > explicit.length) researchGaps.push('One or more specifically named provisions were unavailable as verified indexed text for this date.');
  return { ok: true, ...scope, status: systemStatus ? 'insufficient-sources' : hasAnalysis ? 'working-report' : 'insufficient-analysis',
    systemStatus: systemStatus || (hasAnalysis ? null : 'No source-supported analysis was produced.'), sections, nextSteps: notes(draft?.nextSteps), researchGaps,
    sources: indexed.map(({ text, ...item }) => ({ ...item, excerpt: text.slice(0, 900) })), onlineLeads: leads,
    warnings: ['User-supplied facts are unverified.', 'Quotes establish source provenance, not that every interpretation follows from the quoted words. Counsel must inspect the full text, current amendments and controlling cases.'] };
};
