import { buildReportDocx, reportBlocks, reviewBlocks, exportBlockers, WORD_MIME } from './reportDocx.js';

const form = document.getElementById('report-form');
const output = document.getElementById('report-output');
const empty = document.getElementById('report-empty');
const error = document.getElementById('report-error');
const status = document.getElementById('report-status');
const submit = document.getElementById('report-submit');
const exportButton = document.getElementById('report-export');
const review = document.getElementById('report-review');
const reviewBody = document.getElementById('report-review-body');
const reviewNotice = document.getElementById('report-review-notice');
let currentReport = null; let revision = 0;
form.elements.asOf.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
fetch('/lawbuddy/api/reports/providers').then((r) => r.json()).then((data) => {
  for (const name of ['grok', 'groq']) for (const select of [form.elements.provider, form.elements.verifierProvider, form.elements.compareProvider]) {
    const option = select?.querySelector(`option[value="${name}"]`);
    if (option && !data.providers?.[name]?.configured) { option.disabled = true; option.textContent += ' · needs server key'; }
  }
}).catch(() => {});
const el = (tag, text, className) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
};
const appendText = (node, text) => {
  for (const [i, line] of text.split('\n').entries()) {
    if (i) node.append(document.createElement('br'));
    if (/^https?:\/\/\S+$/.test(line)) {
      const a = el('a', 'Open source'); a.href = line; a.target = '_blank'; a.rel = 'noopener noreferrer'; node.append(a);
    } else node.append(document.createTextNode(line));
  }
};
const renderBlocks = (parent, blocks) => {
  parent.replaceChildren(); let part = parent; let list = null;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      part = el('section', undefined, 'report-section'); part.append(el('h3', block.text)); parent.append(part); list = null;
    } else if (block.kind === 'list') {
      if (!list) { list = el('ul'); part.append(list); }
      const li = el('li'); appendText(li, block.text); list.append(li);
    } else {
      list = null; const p = el('p', undefined, /^(QUALITY GATE FAILED|Backend disagreement:|Status: case)/.test(block.text) ? 'report-alert' : undefined);
      appendText(p, block.text); part.append(p);
    }
  }
};
const render = (report) => {
  const blocks = reportBlocks(report); const blockers = exportBlockers(report);
  renderBlocks(output, blocks); renderBlocks(reviewBody, reviewBlocks(report));
  reviewNotice.textContent = blockers.join(' '); reviewNotice.hidden = !blockers.length;
  review.hidden = false; review.open = blockers.length > 0;
  empty.hidden = blocks.length > 0;
  empty.textContent = blocks.length ? '' : 'The legal write-up will appear after the issues shown in the review panel are resolved.';
  output.hidden = !blocks.length; exportButton.disabled = blockers.length > 0;
  exportButton.textContent = 'Download write-up';
};
form.addEventListener('input', () => { revision++; currentReport = null; exportButton.disabled = true; });
form.elements.judgmentFile.addEventListener('change', async () => {
  const file = form.elements.judgmentFile.files[0]; if (!file) return;
  if (file.size > 800000 || !/\.txt$/i.test(file.name)) { error.textContent = 'Use a UTF-8 .txt judgment of at most 800 KB with paragraph numbers.'; error.hidden = false; return; }
  const text = await file.text();
  if (text.length > 400000) { error.textContent = 'Judgment exceeds 400000 characters.'; error.hidden = false; return; }
  form.elements.judgmentText.value = text; revision++; currentReport = null; exportButton.disabled = true;
  status.textContent = 'Judgment text loaded locally. Review its identity fields before generating.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault(); currentReport = null; output.hidden = true; review.hidden = true; reviewNotice.hidden = true; exportButton.disabled = true; error.hidden = true;
  const requestedRevision = revision;
  submit.disabled = true; status.textContent = 'Checking identity, reading paragraphs, drafting and verifying. Local runs may take several minutes.';
  const fields = new FormData(form);
  const input = Object.fromEntries(['prompt', 'type', 'jurisdiction', 'asOf', 'provider', 'judgmentText', 'judgmentUrl', 'judgmentSnapshotDate', 'facts'].map((key) => [key, fields.get(key) || '']));
  input.online = fields.has('online');
  input.caseIdentity = Object.fromEntries(['caption', 'court', 'citation', 'caseNo', 'decisionDate'].map((key) => [key, fields.get(key) || '']));
  for (const key of ['verifierProvider', 'compareProvider', 'resumeRunId']) if (fields.get(key)) input[key] = fields.get(key);
  try {
    const response = await fetch('/lawbuddy/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const report = await response.json();
    if (!response.ok || !report.ok) throw new Error(`${report.error || 'Report could not be prepared.'}${report.runId ? ` Resume ID: ${report.runId}` : ''}`);
    if (requestedRevision !== revision) { status.textContent = 'The request changed during generation. Submit the revised request to enable export.'; return; }
    currentReport = report; render(report);
    status.textContent = report.caseCheck ? 'Case not confirmed. No case analysis generated.' : report.systemStatus || (report.quality?.pass ? 'Evidence checks and output gates completed.' : 'Output gate failed. Review the visible banner.');
  } catch (cause) { error.textContent = cause.message; error.hidden = false; status.textContent = 'Generation stopped.'; }
  finally { submit.disabled = false; }
});
exportButton.addEventListener('click', () => {
  if (!currentReport) return;
  try {
    const bytes = buildReportDocx(currentReport);
    const url = URL.createObjectURL(new Blob([bytes], { type: WORD_MIME }));
    const a = el('a'); a.href = url; a.download = `lawbuddy-${currentReport.caseCheck ? 'case-identity-check' : 'legal-report'}-${currentReport.asOf}.docx`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    status.textContent = 'Word document downloaded.';
  } catch (cause) { error.textContent = cause.message; error.hidden = false; }
});
