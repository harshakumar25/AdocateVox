import { el, fetchJson, formatDate, indiaToday, safeLink } from './common.js';
import { buildPracticePacket, PRACTICE_WORKFLOWS } from './practiceModel.js';
import { buildWorkingDraftDocx, WORD_MIME } from './practiceDocx.js';
import { deleteMatter, getMatter, listMatters, saveMatter } from './practiceStore.js';

const form = document.getElementById('practice-form');
const status = document.getElementById('practice-status');
const saved = document.getElementById('saved-matters');
const packetContent = document.getElementById('packet-content');
const packetNote = document.getElementById('packet-note');
const draftText = document.getElementById('draft-text');
const copyDraft = document.getElementById('copy-draft');
const exportWord = document.getElementById('export-word');
const citationInput = document.getElementById('citation-input');
const citationResult = document.getElementById('citation-result');
let currentId = null;
let researchGeneration = 0;
let researchController = null;
let citationGeneration = 0;
let currentPacket = null;

const input = () => Object.fromEntries(new FormData(form).entries());
const setStatus = (message) => { status.textContent = message; };
const addTextList = (target, entries, empty) => {
  target.replaceChildren(...(entries.length ? entries.map((entry) => el('li', { text: entry })) : [el('li', { text: empty })]));
};

const localLink = (title, href) => safeLink(href, title);
const CRPC_SOURCE = 'https://www.indiacode.nic.in/bitstream/123456789/15269/1/crpc.pdf';
const CPC_SOURCE = 'https://www.indiacode.nic.in/bitstream/123456789/2191/1/A1908-05.pdf';

const syncWorkflowFields = () => {
  const kind = form.elements.namedItem('kind').value;
  for (const group of form.querySelectorAll('[data-workflows]')) {
    const visible = group.dataset.workflows.split(' ').includes(kind);
    group.hidden = !visible;
    for (const field of group.querySelectorAll('input, select, textarea')) field.disabled = !visible;
  }
};

const loadSaved = async () => {
  try {
    const records = await listMatters();
    saved.replaceChildren(el('option', { text: 'Open saved matter…', attrs: { value: '' } }),
      ...records.map((record) => el('option', {
        text: `${record.input.matterTitle || record.input.clientName || PRACTICE_WORKFLOWS[record.kind]?.title || 'Matter'} · ${record.updatedAt.slice(0, 10)}`,
        attrs: { value: record.id },
      })));
    saved.value = currentId || '';
  } catch {
    saved.disabled = true;
    setStatus('Browser matter storage is unavailable. Drafting and export still work.');
  }
};

const getLaw = async (lead, asOf, signal) => {
  if (lead.act === 'CPC') return {
    act: lead.act, label: `s.${lead.section}`,
    error: 'Order XVII rule 1 is not in AdvocateVox’s dated section library. Check the official Code, amendments and current court directions.',
    sourceUrl: CPC_SOURCE,
  };
  if (lead.act === 'CrPC') return {
    act: lead.act, label: `s.${lead.section}`,
    error: 'Historical CrPC text is not in AdvocateVox’s dated library. Inspect the official edition, State amendments and transitional provisions.',
    sourceUrl: CRPC_SOURCE,
  };
  const url = `/advocatevox/api/section/${lead.act}/${lead.section}${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`;
  try {
    const { body } = await fetchJson(url, { signal });
    return body.ok ? body : { act: lead.act, label: `s.${lead.section}`, error: body.error || 'The provision could not be verified in this library.' };
  } catch {
    return { act: lead.act, label: `s.${lead.section}`, error: 'The legal library could not be reached.' };
  }
};

const getCases = async (lead, decidedBy, signal) => {
  try {
    const query = new URLSearchParams({ provision: `${lead.act} ${lead.section}`, limit: '5', decidedBy });
    const { body } = await fetchJson(`/advocatevox/api/cases?${query}`, { signal });
    return body.ok ? body : { cases: [], error: body.error || 'Cases could not be searched.' };
  } catch {
    return { cases: [], error: 'The case index could not be reached.' };
  }
};

const researchLaw = (packet) => {
  const target = document.getElementById('law-results');
  target.replaceChildren(el('h4', { text: 'Provision checks' }), ...packet.statuteLeads.map((lead) => {
    const law = lead.verification;
    const heading = `${lead.act} ${lead.act === 'CPC' ? '' : 'section '}${lead.section} · ${lead.purpose}`;
    if (!law?.ok) return el('article', { className: 'research-card warn' }, [
      el('strong', { text: heading }),
      el('p', { text: law?.error || 'Not checked. Import the official text before using this as a cited provision.' }),
      law?.sourceUrl ? el('p', {}, [localLink(`Open official ${lead.act} text`, law.sourceUrl)]) : null,
    ].filter(Boolean));
    return el('article', { className: 'research-card' }, [
      el('strong', { text: heading }),
      el('p', { text: `${law.heading || 'Section text loaded'} · ${law.inForceSince ? `library in-force date ${formatDate(law.inForceSince)}` : 'commencement requires review'} · checked as of ${formatDate(law.asOf)}` }),
      law.caution ? el('p', { className: 'research-caution', text: law.caution }) : null,
      law.pendingAmendments?.length ? el('p', { className: 'research-caution', text: law.pendingAmendments.join(' ') }) : null,
      law.source?.url ? el('p', {}, [localLink('Read imported official source', law.source.url)]) : null,
      el('details', {}, [el('summary', { text: 'Read the stored section text' }), el('pre', { text: law.text })]),
    ].filter(Boolean));
  }));
};

const researchCases = (response) => {
  const target = document.getElementById('case-results');
  const cases = response.cases || [];
  target.replaceChildren(...[el('h4', { text: 'Judgments to inspect' }),
    response.decidedBy ? el('p', { className: 'research-note', text: `Showing judgments decided by ${formatDate(response.decidedBy)}. Later-treatment labels reflect the current index.` }) : null,
    response.library?.latest ? el('p', { className: 'research-note', text: `Latest decision dated ${formatDate(response.library.latest)} in this index; coverage may be incomplete.` }) : null,
    response.relation === 'predecessor' ? el('p', { className: 'research-caution', text: 'These results concern predecessor provisions. Verify the legal change and factual fit before using them under the current code.' }) : null,
    response.relation === 'related' ? el('p', { className: 'research-caution', text: 'These judgments concern related provisions, not the requested provision.' }) : null,
    response.error ? el('p', { className: 'research-caution', text: response.error }) : null,
    !response.error && !cases.length ? el('p', { text: 'No judgment was found for this provision in the current index. That is a coverage gap, not a legal conclusion.' }) : null,
    ...cases.map((judgment) => el('article', { className: 'research-card' }, [
      el('strong', { text: judgment.title }),
      el('p', { text: `${judgment.citations?.[0] || 'Citation not indexed'} · ${judgment.decidedOn ? formatDate(judgment.decidedOn) : 'date unavailable'}${judgment.benchStrength ? ` · ${judgment.benchStrength}-judge bench` : ''}` }),
      judgment.status && judgment.status !== 'unknown' ? el('p', { className: judgment.status === 'overruled' ? 'research-caution' : '', text: `Index treatment: ${judgment.status}` }) : el('p', { className: 'research-note', text: 'Later treatment has not been verified.' }),
      judgment.viaNote ? el('p', { className: 'research-caution', text: judgment.viaNote }) : null,
      judgment.pdfUrl ? el('p', {}, [localLink('Read indexed judgment PDF', judgment.pdfUrl)]) : null,
      el('p', { className: 'research-note', text: 'Check the exact paragraph, factual fit and later treatment before relying on this case.' }),
    ].filter(Boolean)))].filter(Boolean));
};

const renderPacket = (packet) => {
  currentPacket = packet;
  packetContent.hidden = false;
  packetNote.textContent = `${packet.blockers.length ? 'Known forum or legal restriction needs resolution. ' : ''}${packet.transition ? `${packet.transition} ` : ''}Facts below are user supplied. This is a working document; no filing has been made.`;
  draftText.textContent = packet.draft;
  copyDraft.disabled = packet.blockers.length > 0;
  exportWord.disabled = packet.blockers.length > 0;
  document.getElementById('blocker-panel').hidden = packet.blockers.length === 0;
  addTextList(document.getElementById('blockers-list'), packet.blockers, '');
  addTextList(document.getElementById('forum-list'), packet.jurisdictionReview, 'Forum details entered. Counsel must still verify jurisdiction and local rules.');
  addTextList(document.getElementById('gaps-list'), packet.gaps, 'No intake field in the current checklist is blank. Verify accuracy against the file.');
  document.getElementById('arguments-title').textContent = packet.kind === 'legal-opinion' ? 'Issues, sources and limits' : packet.kind === 'civil-adjournment' ? 'Cause and opposition grid' : 'Argument and opposition grid';
  const grid = document.getElementById('argument-grid');
  grid.replaceChildren(...packet.argumentGrid.map((row) => el('article', { className: 'argument-row' }, [
    el('h4', { text: row.issue }),
    el('p', {}, [el('strong', { text: 'Record: ' }), document.createTextNode(row.record || '[confirm from the file]')]),
    el('p', {}, [el('strong', { text: 'Response / question: ' }), document.createTextNode(row.answer || '[prepare a record-backed answer]')]),
  ])));
  addTextList(document.getElementById('hearing-list'), packet.hearingPrompts, 'No preparation prompt available.');
};

const clearPacket = (message) => {
  researchGeneration += 1;
  researchController?.abort();
  researchController = null;
  packetContent.hidden = true;
  currentPacket = null;
  copyDraft.disabled = true;
  exportWord.disabled = true;
  packetNote.textContent = message;
};

const clearCitation = () => {
  citationGeneration += 1;
  citationInput.value = '';
  citationResult.replaceChildren();
};

const markPacketStale = () => {
  if (packetContent.hidden) return;
  clearPacket('Matter details changed. Prepare a new packet so the draft and research use the same facts.');
  setStatus('Matter details changed. Prepare the packet again.');
};

form.addEventListener('input', markPacketStale);
form.addEventListener('change', markPacketStale);
form.elements.namedItem('kind').addEventListener('change', syncWorkflowFields);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const matter = input();
  if (!PRACTICE_WORKFLOWS[matter.kind]) return setStatus('Choose a workflow.');
  const generation = ++researchGeneration;
  researchController?.abort();
  researchController = new AbortController();
  const controller = researchController;
  const packet = buildPracticePacket(matter);
  const leads = packet.statuteLeads;
  renderPacket(packet);
  if (!leads.length) {
    researchController = null;
    document.getElementById('law-results').replaceChildren(el('p', { text: 'No authority was automatically selected. Add and verify primary statutes and judgment paragraphs for this specific question.' }));
    document.getElementById('case-results').replaceChildren(el('p', { text: 'Use the citation identity check below for a lead, then read the full judgment and later treatment.' }));
    setStatus(`Working opinion ready. ${packet.gaps.length} intake item${packet.gaps.length === 1 ? '' : 's'} to confirm. No matter facts or opinion analysis were sent for research.`);
    return;
  }
  document.getElementById('law-results').replaceChildren(el('p', { text: 'Checking the stored provisions…' }));
  document.getElementById('case-results').replaceChildren(el('p', { text: 'Searching indexed judgments…' }));
  setStatus(`Working draft ready. ${packet.blockers.length} stop item${packet.blockers.length === 1 ? '' : 's'} and ${packet.gaps.length} intake item${packet.gaps.length === 1 ? '' : 's'} to confirm. Research is loading; matter facts stay in this browser.`);
  const asOf = matter.filingDate || indiaToday();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let laws;
  let caseResponse;
  try {
    [laws, caseResponse] = await Promise.all([
      Promise.all(leads.map((lead) => getLaw(lead, asOf, controller.signal))),
      packet.blockers.length
        ? Promise.resolve({ cases: [], error: 'Judgment leads are withheld while the known forum or statutory restriction remains unresolved. First verify an available legal route.' })
        : leads[0]?.act === 'CPC'
        ? Promise.resolve({ cases: [], error: 'Automated case search is not enabled for this civil instrument. Check current judgments and local directions independently.' })
        : leads[0]
          ? getCases(leads[0], asOf, controller.signal)
          : Promise.resolve({ cases: [], error: 'No automatic case search is available for this instrument.' }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (generation !== researchGeneration) return;
  researchController = null;
  researchLaw(buildPracticePacket(matter, { laws }));
  researchCases(caseResponse);
  setStatus(`Packet ready. ${packet.blockers.length} stop item${packet.blockers.length === 1 ? '' : 's'} and ${packet.gaps.length} intake item${packet.gaps.length === 1 ? '' : 's'} to confirm. Research queries did not send matter facts.`);
});

document.getElementById('save-matter').addEventListener('click', async () => {
  try {
    const record = await saveMatter({ id: currentId, kind: input().kind, input: input() });
    currentId = record.id;
    await loadSaved();
    setStatus(`Saved in this browser on ${formatDate(record.updatedAt.slice(0, 10))}.`);
  } catch (error) {
    setStatus(error.message || 'Could not save this matter.');
  }
});

saved.addEventListener('change', async () => {
  if (!saved.value) return;
  try {
    const record = await getMatter(saved.value);
    if (!record) return setStatus('Saved matter not found.');
    form.reset();
    for (const [name, value] of Object.entries(record.input || {})) {
      const field = form.elements.namedItem(name);
      if (field && typeof value === 'string') field.value = value;
    }
    syncWorkflowFields();
    currentId = record.id;
    clearPacket('Matter opened. Prepare a packet to refresh its draft and research.');
    clearCitation();
    setStatus('Matter opened from this browser. Prepare the packet to refresh research.');
  } catch {
    setStatus('Could not open that saved matter.');
  }
});

document.getElementById('new-matter').addEventListener('click', () => {
  form.reset();
  syncWorkflowFields();
  currentId = null;
  saved.value = '';
  clearPacket('Enter matter details, then prepare a packet.');
  clearCitation();
  setStatus('New unsaved matter.');
});

document.getElementById('delete-matter').addEventListener('click', async () => {
  if (!currentId) return setStatus('Open a saved matter before deleting it.');
  if (!window.confirm('Delete this matter from this browser? This cannot be undone.')) return;
  try {
    await deleteMatter(currentId);
    form.reset();
    currentId = null;
    clearPacket('Saved matter deleted. Enter new details to prepare a packet.');
    clearCitation();
    await loadSaved();
    setStatus('Saved matter deleted from this browser.');
  } catch {
    setStatus('Could not delete that saved matter.');
  }
});

document.getElementById('export-matter').addEventListener('click', () => {
  const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), matter: input() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: 'lawbuddy-matter.json' } });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Matter JSON exported to your downloads. Protect this file as a client record.');
});

copyDraft.addEventListener('click', async () => {
  if (!currentPacket || currentPacket.blockers.length) return setStatus('Prepare a current draft and resolve stop items before copying.');
  try {
    await navigator.clipboard.writeText(currentPacket.draft);
    setStatus('Working draft copied. Verify all bracketed fields, law and facts before use.');
  } catch {
    setStatus('Clipboard unavailable. Select the draft text to copy it.');
  }
});

exportWord.addEventListener('click', () => {
  if (!currentPacket || packetContent.hidden || currentPacket.blockers.length) return setStatus('Prepare a current draft and resolve stop items before exporting.');
  try {
    const bytes = buildWorkingDraftDocx(currentPacket);
    const url = URL.createObjectURL(new Blob([bytes], { type: WORD_MIME }));
    const link = el('a', { attrs: { href: url, download: `lawbuddy-working-draft-${indiaToday()}.docx` } });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus('Word working draft downloaded with separate review notes. It contains the entered matter facts; protect it as a client record.');
  } catch (error) {
    setStatus(error.message || 'Could not create the Word document.');
  }
});

citationInput.addEventListener('input', () => {
  citationGeneration += 1;
  citationResult.replaceChildren();
});

document.getElementById('citation-check').addEventListener('click', async () => {
  const value = citationInput.value.trim();
  if (!value) return;
  const generation = ++citationGeneration;
  citationResult.textContent = 'Checking citation identity…';
  try {
    const { body } = await fetchJson(`/advocatevox/api/citation?${new URLSearchParams({ citation: value })}`);
    if (generation !== citationGeneration) return;
    if (!body.ok) return void (citationResult.textContent = body.error || 'Citation could not be checked.');
    if (!body.verified) return void (citationResult.textContent = `${body.citation}: ${body.reason}`);
    citationResult.replaceChildren(el('p', { text: `${body.citation} → ${body.case.title}${body.case.decidedOn ? ` (${formatDate(body.case.decidedOn)})` : ''}` }),
      body.case.status && body.case.status !== 'unknown' ? el('p', { className: 'research-caution', text: `Index treatment: ${body.case.status}` }) : el('p', { className: 'research-note', text: 'Later treatment has not been verified.' }),
      body.case.pdfUrl ? el('p', {}, [localLink('Read indexed judgment PDF', body.case.pdfUrl)]) : null,
      el('p', { text: body.note }));
  } catch {
    if (generation === citationGeneration) citationResult.textContent = 'The citation index could not be reached.';
  }
});

syncWorkflowFields();
loadSaved();
