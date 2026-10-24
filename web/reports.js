import { buildReportDocx, WORD_MIME } from './reportDocx.js';

const form = document.getElementById('report-form');
const output = document.getElementById('report-output');
const empty = document.getElementById('report-empty');
const error = document.getElementById('report-error');
const status = document.getElementById('report-status');
const submit = document.getElementById('report-submit');
const exportButton = document.getElementById('report-export');
let currentReport = null;
form.elements.asOf.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
fetch('/lawbuddy/api/reports/providers').then((response) => response.json()).then((data) => {
  for (const name of ['grok', 'groq']) {
    const option = form.elements.provider.querySelector(`option[value="${name}"]`);
    if (option && !data.providers?.[name]?.configured) { option.disabled = true; option.textContent += ' · needs server key'; }
  }
}).catch(() => { /* Generation still reports provider configuration errors. */ });

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const section = (title) => { const node = el('section', undefined, 'report-section'); node.append(el('h3', title)); output.append(node); return node; };
const link = (url, label) => {
  const a = el('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
};
const headings = { executiveSummary: 'Executive summary', issues: 'Issues for determination', applicableLaw: 'Applicable law', analysis: 'Analysis and application', counterarguments: 'Counterarguments and adverse points', conclusion: 'Provisional conclusion' };
const render = (report) => {
  output.replaceChildren();
  output.append(el('p', `${report.typeLabel} · ${report.jurisdiction} · law as of ${report.asOf}`, 'eyebrow'));
  const question = section('Original request'); question.append(el('p', report.prompt));
  if (report.caseCheck) {
    const check = section('Case identity must be confirmed');
    check.append(el('p', report.caseCheck.message, 'report-alert'));
    check.append(el('p', `Parsed reference: ${report.caseCheck.caption}${report.caseCheck.year ? ` (${report.caseCheck.year})` : ''}`));
    if (report.caseCheck.identity) check.append(el('p', `Indexed identity: ${report.caseCheck.identity.title} · ${report.caseCheck.identity.decidedOn || 'date unconfirmed'}`));
    if (report.caseCheck.candidates.length) {
      check.append(el('h4', 'Possible matches in the Supreme Court index'));
      for (const candidate of report.caseCheck.candidates) {
        const card = el('article', undefined, 'report-source');
        card.append(el('h4', candidate.title), el('p', `${candidate.court} · ${candidate.decidedOn || 'date unknown'} · ${candidate.caseNo || 'case number unavailable'}`));
        if (candidate.citations.length) card.append(el('p', `Indexed citations: ${candidate.citations.slice(0, 4).join('; ')}`));
        if (candidate.officialUrl) card.append(link(candidate.officialUrl, 'Open court record'));
        check.append(card);
      }
    } else check.append(el('p', 'No matching 2017 Supreme Court record was found in this index. This does not establish that the case does not exist.', 'empty'));
    const next = section('What is needed to continue'); const list = el('ul');
    for (const item of report.nextSteps) list.append(el('li', item)); next.append(list);
    empty.hidden = true; output.hidden = false; exportButton.disabled = false;
    exportButton.textContent = 'Download identity check';
    return;
  }
  exportButton.textContent = 'Download Word';
  if (report.systemStatus) { const part = section('Research status'); part.append(el('p', report.systemStatus, 'report-alert')); }
  for (const [key, title] of Object.entries(headings)) {
    const part = section(title);
    const items = report.sections?.[key] || [];
    if (!items.length) part.append(el('p', 'No source-supported proposition produced for this section.', 'empty'));
    for (const item of items) { const p = el('p', item.text); p.append(el('span', ` [${item.evidenceIds.join(', ')}]`, 'report-source-ids')); part.append(p, el('p', `Source quotation: “${item.quote}”`, 'report-quote')); }
  }
  for (const [key, title] of [['nextSteps', 'Next steps'], ['researchGaps', 'Research gaps']]) {
    const part = section(title); const list = el('ul');
    for (const item of report[key] || []) list.append(el('li', item));
    if (!list.childElementCount) list.append(el('li', key === 'nextSteps' ? 'Verify the facts and complete authority review.' : 'Review current law and controlling decisions.'));
    part.append(list);
  }
  const sources = section('Indexed official sources');
  if (!report.sources.length) sources.append(el('p', 'No relevant provision verified for the chosen date.', 'empty'));
  for (const item of report.sources) {
    const card = el('article', undefined, 'report-source');
    const h = el('h4', `[${item.id}] ${item.title}`); card.append(h, link(item.url, 'Open official source'), el('p', item.excerpt)); sources.append(card);
  }
  const leads = section('Online catalogue leads · not verified authority');
  if (!report.onlineLeads.length) leads.append(el('p', 'No online leads added.', 'empty'));
  for (const item of report.onlineLeads) { const p = el('p'); p.append(link(item.url, item.title), el('span', ` — ${item.note}`)); leads.append(p); }
  const review = section('Before relying on this report'); const list = el('ul');
  for (const item of report.warnings) list.append(el('li', item)); review.append(list);
  empty.hidden = true; output.hidden = false; exportButton.disabled = false;
};

form.addEventListener('submit', async (event) => {
  event.preventDefault(); currentReport = null; output.hidden = true; exportButton.disabled = true; error.hidden = true;
  submit.disabled = true; status.textContent = 'Searching the index and preparing report…';
  const fields = new FormData(form);
  const input = { prompt: fields.get('prompt'), type: fields.get('type'), jurisdiction: fields.get('jurisdiction'), asOf: fields.get('asOf'), provider: fields.get('provider'), online: fields.has('online') };
  try {
    const response = await fetch('/lawbuddy/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const report = await response.json();
    if (!response.ok || !report.ok) throw new Error(report.error || 'The report could not be prepared.');
    currentReport = report; render(report); status.textContent = report.caseCheck ? 'Case identity check · no judgment analysis generated' : `${report.sources.length} indexed sources · ${report.onlineLeads.length} catalogue leads`;
  } catch (cause) { error.textContent = cause.message; error.hidden = false; status.textContent = 'Report unavailable.'; }
  finally { submit.disabled = false; }
});

exportButton.addEventListener('click', () => {
  if (!currentReport) return;
  try {
    const bytes = buildReportDocx(currentReport);
    const url = URL.createObjectURL(new Blob([bytes], { type: WORD_MIME }));
    const a = el('a'); a.href = url; a.download = `lawbuddy-${currentReport.caseCheck ? 'case-identity-check' : 'legal-report'}-${currentReport.asOf}.docx`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000); status.textContent = 'Word report downloaded.';
  } catch (cause) { error.textContent = cause.message; error.hidden = false; }
});
