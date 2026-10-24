import { extractCitations } from '../parse/citationParser.js';
import { verifyCaseCitation } from '../cases/citationVerify.js';

const CASE_WORK = /\b(?:judg(?:e)?ment|case note|case analysis|landmark case|holding|ratio decidendi|facts of (?:the )?case|review of (?:the )?case)\b/i;
const CAPTION = /([\p{L}][\p{L} .'&-]{1,75}?)\s+(?:v\.?|vs\.?|versus)\s+([\p{L}][\p{L} .'&-]{1,75})/iu;
const STOP = /\s*(?:\(\s*(?:19|20)\d{2}\s*\)|[,;:\n]|\b(?:judg(?:e)?ment|facts|issues|reviews?|analysis|holding|ratio|citation|case number)\b)/i;

export const identifyReportTask = (prompt) => {
  const citations = extractCitations(prompt);
  const match = CAPTION.exec(prompt);
  if (!match || (!CASE_WORK.test(prompt) && !citations.length && !/\(\s*(?:19|20)\d{2}\s*\)/.test(prompt))) return { kind: 'general' };
  const partyA = match[1].split(/[:;\n]/).at(-1).replace(/^\s*(?:landmark\s+)?case\s*/i, '').trim();
  const partyB = match[2].split(STOP)[0].trim();
  const year = /\(\s*((?:19|20)\d{2})\s*\)/.exec(prompt.slice(match.index + match[0].length))?.[1]
    || citations[0]?.year || null;
  return { kind: 'named-case', caption: `${partyA} v. ${partyB}`, partyA, partyB, year: year ? String(year) : null,
    citations: citations.map((item) => item.normalized) };
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
