import { extractCitations } from '../parse/citationParser.js';
import { verifyCaseCitation } from '../cases/citationVerify.js';

const CASE_WORK = /\b(?:judg(?:e)?ment|case note|case analysis|landmark case|holding|ratio decidendi|facts of (?:the )?case|review of (?:the )?case)\b/i;
const CAPTION = /([\p{L}][\p{L} .'&-]{1,75}?)\s+(?:v\.?|vs\.?|versus)\s+([\p{L}][\p{L} .'&-]{1,75})/iu;
const STOP = /\s*(?:\(\s*(?:19|20)\d{2}\s*\)|[,;:\n]|\b(?:judg(?:e)?ment|facts|issues|reviews?|analysis|holding|ratio|citation|case number)\b)/i;

export const identifyReportTask = (prompt, input = {}) => {
  const citations = extractCitations(prompt);
  const supplied = input.caseIdentity || {};
  const match = CAPTION.exec(supplied.caption || prompt);
  const queryMatch = CAPTION.exec(prompt);
  const requestedSections = ['judgment', 'facts', 'issues', 'reviews', 'analysis', 'reasoning', 'holding', 'order'].filter((s) =>
    new RegExp(s === 'judgment' ? 'judg(?:e)?ment' : `\\b${s}\\b`, 'i').test(prompt));
  if (!match && !CASE_WORK.test(prompt) && !input.judgmentText && input.type !== 'case-analysis') return { kind: 'general', taskType: input.type || 'memo', suppliedFacts: String(input.facts || '') };
  const partyA = match?.[1].split(/[:;\n]/).at(-1).replace(/^\s*(?:(?:analyse|analyze|explain|review|landmark)\s+)*(?:case\s+)?/i, '').trim() || '';
  const partyB = match?.[2].split(STOP)[0].trim() || '';
  const year = /\(\s*((?:19|20)\d{2})\s*\)/.exec(prompt)?.[1]
    || citations[0]?.year || null;
  return { kind: 'named-case', taskType: 'case-analysis', caption: partyA && partyB ? `${partyA} v. ${partyB}` : '',
    partyA, partyB, year: year ? String(year) : null, court: String(supplied.court || ''),
    decisionDate: String(supplied.decisionDate || ''), citation: String(supplied.citation || citations[0]?.normalized || ''),
    queryPartyA: queryMatch?.[1].replace(/^\s*(?:(?:analyse|analyze|explain|review|landmark)\s+)*(?:case\s+)?/i, '').trim() || '',
    caseNo: String(supplied.caseNo || ''), bench: String(supplied.bench || ''), requestedSections,
    suppliedFacts: String(input.facts || ''), citations: citations.map((item) => item.normalized) };
};

const normalize = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const suppliedIdentityGate = (task, text = '') => {
  const missing = [];
  const header = normalize(text.split(/\s+/).slice(0, 300).join(' '));
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(task.decisionDate) && !Number.isNaN(Date.parse(task.decisionDate))
    && new Date(task.decisionDate).toISOString().slice(0, 10) === task.decisionDate;
  if (!task.caption) missing.push('case caption');
  if (task.queryPartyA && task.partyA && !normalize(task.partyA).includes(normalize(task.queryPartyA))
    && !normalize(task.queryPartyA).includes(normalize(task.partyA))) missing.push('case caption consistent with the research question');
  if (!task.court) missing.push('court');
  if (!dateValid) missing.push('valid decision date');
  if (!task.citation && !task.caseNo) missing.push('citation or case number');
  if (!text.trim()) missing.push('judgment text');
  const partiesMatch = Boolean(task.partyA && task.partyB && [task.partyA, task.partyB].every((p) => header.includes(normalize(p))));
  if (text.trim() && !partiesMatch) missing.push('parties matching the caption in the judgment header');
  if (task.year && dateValid && !task.decisionDate.startsWith(task.year)) missing.push('decision year consistent with the query');
  if (task.court && text.trim() && !header.includes(normalize(task.court))) missing.push('court matching the judgment header');
  if ((task.citation || task.caseNo) && text.trim() && ![task.citation, task.caseNo].filter(Boolean).some((id) => header.includes(normalize(id)))) missing.push('citation or case number matching the judgment header');
  return { proceed: !missing.length, missing, partiesMatch, judgmentTextPresent: Boolean(text.trim()) };
};

export const resolveCaseRequest = (store, task) => {
  const citations = task.citations.map((citation) => verifyCaseCitation(store, citation));
  const verified = citations.filter((item) => item.verified);
  const candidates = task.year && task.partyA && task.partyB
    ? store.reportCaseCandidates({ partyA: task.partyA, partyB: task.partyB, year: task.year }) : [];
  const matchCaption = (row) => [task.partyA, task.partyB].every((party) => row.title.toLowerCase().includes(party.toLowerCase()));
  const identity = verified.length === 1 && matchCaption(verified[0].case)
    && (!task.year || verified[0].case.decidedOn?.startsWith(task.year)) ? verified[0].case : null;
  return {
    status: identity ? 'judgment-not-reviewed' : 'case-not-identified',
    caption: task.caption, year: task.year, citations: task.citations, identity,
    candidates: candidates.map((item) => ({ title: item.title, court: item.court, decidedOn: item.decided_on,
      caseNo: item.case_no, citations: item.aliases, officialUrl: item.pdf_url || item.source_url })),
    message: identity
      ? 'The citation matches an indexed case, but this report has not reviewed the judgment text. Facts, issues, holdings, reasoning and later treatment cannot be stated from the citation alone.'
      : 'This case has not been uniquely identified. A party name and year are insufficient to attribute facts, issues, holdings or later treatment.',
  };
};
