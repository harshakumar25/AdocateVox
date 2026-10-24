import { buildWorkingDraftDocx, WORD_MIME } from './practiceDocx.js';
export { WORD_MIME };

export const reviewBlocks = (report) => {
  if (!report?.ok) throw new TypeError('A prepared report is required.');
  const blocks = [];
  const heading = (text) => blocks.push({ kind: 'heading', text });
  const paragraph = (text) => blocks.push({ kind: 'paragraph', text });
  const list = (text) => blocks.push({ kind: 'list', text });
  heading(report.caseCheck ? 'CASE IDENTITY CHECK: NO JUDGMENT ANALYSIS' : report.typeLabel.toUpperCase());
  if (report.quality && !report.quality.pass) paragraph(`QUALITY GATE FAILED: ${report.quality.dash_hits} long dashes; banned phrases: ${report.quality.banned_phrases.join(', ') || 'none'}; source overlap ${report.quality.overlap_pct}%. Review the flagged wording before use.`);
  if (report.quality?.repairErrors?.length) paragraph(`SYSTEM STATUS: Output repair stopped. ${report.quality.repairErrors.join(' ')} Resume the saved run to retry.`);
  if (report.comparison?.disagreement) paragraph(report.comparison.notice);
  paragraph(`Jurisdiction: ${report.jurisdiction}\nRequested research date: ${report.requestedAsOf || report.asOf}\nSource snapshot cutoff: ${report.lawAsOf || 'not established from all source snapshots'}\nPrepared: ${report.generatedAt}`);
  if (report.runId) paragraph(`Run ID: ${report.runId}`);
  if (report.provenance) {
    const stages = report.provenance.stages || [];
    const models = [...new Set(stages.map((s) => `${s.provider}/${s.model}`))];
    paragraph(`Models used: ${models.join(', ') || 'none'}\nTemperatures: ${[...new Set(stages.map((s) => s.temperature))].join(', ')}\nSeeds: ${[...new Set(stages.map((s) => s.seed ?? 'not supported'))].join(', ')}\nPrompt hash: ${report.provenance.promptHash || 'not available'}\nRetriever: ${report.provenance.retrieverVersion}`);
  }
  if (report.caseCheck) {
    heading('IDENTITY STATUS'); paragraph(report.caseCheck.message);
    for (const missing of report.caseCheck.missing || []) list(`Missing: ${missing}`);
    heading('QUERY AS UNDERSTOOD');
    paragraph(`Task: case analysis\nCaption: ${report.task?.caption || 'not supplied'}\nYear: ${report.task?.year || 'not supplied'}\nCourt: ${report.task?.court || 'not supplied'}\nCitation: ${report.task?.citation || 'not supplied'}\nRequested sections: ${(report.task?.requestedSections || []).join(', ') || 'case analysis'}`);
    heading('WHAT IS NEEDED TO CONTINUE'); report.nextSteps.forEach(list);
  } else {
    if (report.systemStatus) { heading('SYSTEM STATUS'); paragraph(report.systemStatus); }
    if (report.caseIdentity) {
      heading('CASE IDENTITY');
      const c = report.caseIdentity;
      paragraph(`${c.caption}\nCourt: ${c.court}\nDecision date: ${c.decisionDate}\nCitation: ${c.citation || 'not supplied'}\nCase number: ${c.caseNo || 'not supplied'}\nIdentity matched against supplied text; authenticity requires source review.`);
    }
    if (report.temporal?.length) {
      heading('HISTORICAL LAW AND CORRESPONDENCE');
      for (const row of report.temporal) {
        list(`As decided: ${row.asDecided} [${row.evidenceIds.join(', ')}]. Corresponding provision at requested date: ${row.currentEquivalent}. Commencement: ${row.commencement}.`);
        paragraph(row.caution);
      }
    }
    if (report.researchGaps?.length) { heading('LEGAL RESEARCH GAPS'); report.researchGaps.forEach(list); }
    if (report.coverageGaps?.length) { heading('INDEX COVERAGE'); report.coverageGaps.forEach(list); }
    if (report.counselChecks?.length) { heading('ITEMS FOR COUNSEL TO VERIFY'); report.counselChecks.forEach(list); }
  }
  if (report.quality) {
    heading('OUTPUT CHECKS'); paragraph(`Style and source overlap: ${report.quality.pass ? 'PASS' : 'FAIL'}. Long dashes: ${report.quality.dash_hits}. Banned phrases: ${report.quality.banned_phrases.join(', ') || 'none'}. Six-word overlap: ${report.quality.overlap_pct}% (limit ${100 * report.quality.maxOverlap}%). These checks do not establish legal accuracy or an external similarity score.`);
  }
  heading('SOURCE LEDGER');
  for (const source of report.sources || []) {
    paragraph(`[${source.id}] ${source.title}\nKind: ${source.kind}; provenance: ${source.authority}\n${source.url || 'User-supplied text; no URL provided'}\nRetrieved: ${source.retrievedAt}; snapshot: ${source.snapshotDate || 'unknown'}; version: ${source.version || 'unknown'}\nSHA-256: ${source.contentHash}\nAnchor: ${source.anchor}`);
    for (const card of (report.cards || []).filter((c) => c.sourceId === source.id)) list(`[${card.id}] Paragraph ${card.para}, ${card.type}: “${card.quote}”`);
  }
  for (const row of report.temporal || []) paragraph(`Correspondence sources:\n${row.oldSource}\n${row.newSource}\n${row.correspondenceSource}\nCommencement: ${row.commencementSource}\nChecked: ${row.checkedOn}`);
  if (!report.sources?.length) paragraph('No source was admitted as evidence.');
  if (report.caseCheck?.candidates?.length) {
    heading('UNCONFIRMED INDEX CANDIDATES');
    for (const c of report.caseCheck.candidates) list(`${c.title}; ${c.court}; ${c.decidedOn || 'date unknown'}; ${c.caseNo || 'case number unavailable'}\n${c.citations.join('; ')}\n${c.officialUrl || ''}`);
  }
  if (report.onlineLeads?.length) { heading('ONLINE CATALOGUE LEADS'); for (const l of report.onlineLeads) paragraph(`${l.title}\n${l.url}\n${l.note}`); }
  if (report.retrievalLog?.some((r) => r.decision === 'DROP')) {
    heading('EXCLUDED SOURCES'); for (const row of report.retrievalLog.filter((r) => r.decision === 'DROP')) list(`${row.title || row.sourceId}: ${row.reason}; score ${row.score}`);
  }
  heading('ORIGINAL REQUEST'); paragraph(report.prompt);
  if (report.task?.suppliedFacts) { heading('USER ASSERTIONS: UNVERIFIED'); paragraph(report.task.suppliedFacts); }
  heading('REVIEW LIMITS'); for (const warning of report.warnings || []) list(warning);
  return blocks;
};

export const exportBlockers = (report) => {
  if (!report?.ok || report.caseCheck) return ['Confirm the case identity and supply the judgment before preparing a submission write-up.'];
  const blockers = [];
  if (!Object.values(report.sections || {}).flat().length) blockers.push('No supported legal write-up has been produced.');
  if (!report.quality?.pass) blockers.push('Resolve the failed output quality checks before exporting the write-up.');
  if (report.comparison?.disagreement) blockers.push('Resolve the backend disagreement before exporting the write-up.');
  const cards = new Map((report.cards || []).map((card) => [card.id, card]));
  if (Object.values(report.sections || {}).flat().some((claim) => claim.support !== 'SUPPORTED' || !cards.has(claim.cardId))) blockers.push('Every sentence needs a verified evidence reference.');
  if (report.caseIdentity) {
    const missing = ['facts', 'issues', 'holding', 'reasoning', 'finalOrder'].filter((key) => !report.sections?.[key]?.length);
    if (missing.length) blockers.push(`Complete the case write-up: ${missing.map((key) => report.sectionTitles?.[key] || key).join(', ')}.`);
  }
  return blockers;
};

// The deliverable contains legal prose and its references. Diagnostics belong to reviewBlocks only.
export const reportBlocks = (report) => {
  if (!report?.ok) throw new TypeError('A prepared report is required.');
  if (report.caseCheck || !Object.values(report.sections || {}).flat().length) return [];
  const blocks = []; const refs = new Map();
  const heading = (text) => blocks.push({ kind: 'heading', text });
  const paragraph = (text) => blocks.push({ kind: 'paragraph', text });
  const cite = (id) => { if (!refs.has(id)) refs.set(id, refs.size + 1); return `[${refs.get(id)}]`; };
  heading(report.caseIdentity ? 'CASE ANALYSIS' : report.typeLabel.toUpperCase());
  if (report.caseIdentity) {
    const c = report.caseIdentity;
    paragraph(c.caption);
    paragraph([c.court, `Decision dated ${c.decisionDate}`, c.citation, c.caseNo && `Case No. ${c.caseNo}`].filter(Boolean).join('\n'));
  } else paragraph(`Jurisdiction: ${report.jurisdiction}\nResearch date: ${report.requestedAsOf || report.asOf}`);
  for (const [key, title] of Object.entries(report.sectionTitles || {})) {
    const claims = report.sections?.[key] || [];
    if (!claims.length) continue;
    heading(title.toUpperCase());
    for (const claim of claims) blocks.push({ kind: key === 'issues' ? 'list' : 'paragraph',
      text: `${claim.text.replace(/^Analysis:\s*/, '')} ${cite(claim.cardId)}` });
  }
  if (report.temporal?.length) {
    heading('STATUTORY CORRESPONDENCE');
    for (const row of report.temporal) {
      paragraph(`The provision identified for the decision is ${row.asDecided}. The corresponding provision at the requested research date is ${row.currentEquivalent}. ${row.evidenceIds.map(cite).join(' ')}`);
      paragraph(row.caution);
    }
  }
  heading('REFERENCES');
  for (const [id, number] of refs) {
    const card = report.cards?.find((c) => c.id === id);
    const source = report.sources?.find((s) => s.id === card?.sourceId);
    paragraph(`[${number}] ${source?.title || 'Reference unavailable'}, ${source?.kind === 'statute' ? 'provision' : 'paragraph'} ${card?.para || 'unavailable'}.${source?.url ? `\n${source.url}` : ''}`);
  }
  for (const row of report.temporal || []) paragraph(`Statutory correspondence and commencement:\n${row.oldSource}\n${row.newSource}\n${row.correspondenceSource}\n${row.commencementSource}`);
  return blocks;
};
const blocksToText = (blocks) => blocks.map((b) => b.kind === 'list' ? `• ${b.text}` : b.text).join('\n\n');
export const reportToText = (report) => blocksToText(reportBlocks(report));
export const reviewToText = (report) => blocksToText(reviewBlocks(report));
export const buildReportDocx = (report, options) => {
  const blockers = exportBlockers(report);
  if (blockers.length) throw new Error(blockers.join(' '));
  return buildWorkingDraftDocx({ kind: 'legal-report', draft: reportToText(report),
    documentBlocks: reportBlocks(report), blockers: [], gaps: [] }, options);
};
