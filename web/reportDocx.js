import { buildWorkingDraftDocx, WORD_MIME } from './practiceDocx.js';

export { WORD_MIME };
const TITLES = Object.freeze({ executiveSummary: 'Executive summary', issues: 'Issues for determination', applicableLaw: 'Applicable law', analysis: 'Analysis and application', counterarguments: 'Counterarguments and adverse points', conclusion: 'Provisional conclusion' });

export const reportToText = (report) => {
  if (!report?.ok) throw new TypeError('A prepared report is required.');
  const lines = [report.caseCheck ? 'CASE IDENTITY CHECK — NO JUDGMENT ANALYSIS' : report.typeLabel.toUpperCase(),
    `Jurisdiction: ${report.jurisdiction}`, `Law as of: ${report.asOf}`, `Prepared: ${report.generatedAt}`,
    `Requested model: ${report.provider}`, '', 'ORIGINAL REQUEST', report.prompt];
  if (report.caseCheck) {
    const check = report.caseCheck;
    lines.push('', 'IDENTITY STATUS', check.message, `Parsed reference: ${check.caption}${check.year ? ` (${check.year})` : ''}`);
    if (check.identity) lines.push(`Indexed identity: ${check.identity.title} · ${check.identity.decidedOn || 'date unconfirmed'}`);
    lines.push('', 'POSSIBLE INDEX MATCHES');
    lines.push(...(check.candidates.length ? check.candidates.map((item) => `${item.title} · ${item.court} · ${item.decidedOn || 'date unknown'} · ${item.caseNo || 'case number unavailable'}\n${item.citations.join('; ')}\n${item.officialUrl || ''}`)
      : ['No matching record in this Supreme Court index; existence of the case is not disproved.']));
    lines.push('', 'WHAT IS NEEDED TO CONTINUE', ...report.nextSteps.map((item, index) => `${index + 1}. ${item}`));
    return lines.join('\n');
  }
  if (report.systemStatus) lines.push('', 'RESEARCH STATUS', report.systemStatus);
  for (const [key, title] of Object.entries(TITLES)) {
    lines.push('', title.toUpperCase());
    const items = report.sections?.[key] || [];
    lines.push(...(items.length ? items.map((item, index) => `${index + 1}. ${item.text} [${item.evidenceIds.join(', ')}]\nSource quotation: “${item.quote}”`) : ['No source-supported proposition produced for this section.']));
  }
  lines.push('', 'NEXT STEPS', ...(report.nextSteps?.length ? report.nextSteps.map((item, index) => `${index + 1}. ${item}`) : ['Confirm facts and complete authority review.']));
  lines.push('', 'RESEARCH GAPS', ...(report.researchGaps?.length ? report.researchGaps.map((item, index) => `${index + 1}. ${item}`) : ['Review source currency, judgments, amendments and local procedure.']));
  lines.push('', 'INDEXED OFFICIAL SOURCES', ...(report.sources?.length ? report.sources.map((source) => `[${source.id}] ${source.title}\n${source.url}\n${source.excerpt}`) : ['No verified indexed provision found.']));
  lines.push('', 'ONLINE CATALOGUE LEADS — NOT VERIFIED AUTHORITY', ...(report.onlineLeads?.length ? report.onlineLeads.map((lead) => `${lead.title}\n${lead.url}\n${lead.note}`) : ['No online leads added.']));
  return lines.join('\n');
};

export const buildReportDocx = (report, options) => buildWorkingDraftDocx({
  kind: report.caseCheck ? 'case-identity-check' : 'legal-report', draft: reportToText(report), blockers: [], gaps: [],
  jurisdictionReview: report.caseCheck ? [] : [`Confirm ${report.jurisdiction} jurisdiction and local practice for the intended use.`, 'Check current amendments, commencement and any later binding decisions.'],
  limitations: report.warnings,
}, options);
