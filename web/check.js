// "Check my bare act, or my notes": sends a PDF to POST /lawbuddy/api/copy-check, which first works out what
// the document is (a copy of an Act, a copy of a repealed code, or a write-up) and then checks it. Every
// finding is shown with the official text or judgment behind it. Untrusted text is only set through textContent.
import { el, fetchJson, formatDate, hostOf, safeLink } from './common.js';

const MAX_BYTES = 30 * 1024 * 1024;
const FIRST_SHOWN = 25;
const VERDICTS = Object.freeze({
  official: ['ok', 'Matches imported source file'],
  matches: ['ok', 'No difference detected'],
  differs: ['warn', 'Differences found'],
  outdated: ['warn', 'Possible outdated copy'],
  'needs-review': ['warn', 'Needs review'],
  unreadable: ['warn', 'Could not compare'],
  repealed: ['danger', 'Repealed law'],
  reliable: ['ok', 'No checked issue found'],
  'use-with-care': ['warn', 'Use with care'],
  unreliable: ['danger', 'Contains errors'],
  'nothing-to-check': ['', 'Nothing to check'],
});
const KIND_TEXT = Object.freeze({
  'act-copy': 'a copy of an Act LawBuddy holds in its official text',
  repealed: 'a copy of a repealed code',
  'write-up': 'a write-up (notes, an article or an answer) about the law',
  unsupported: 'an Act-like document LawBuddy cannot compare yet',
});

const form = document.getElementById('check-form');
const fileInput = document.getElementById('file');
const dateInput = document.getElementById('date');
const localOnlyInput = document.getElementById('local-only');
const button = document.getElementById('check');
const statusLine = document.getElementById('status');
const verdictBadge = document.getElementById('verdict');
const summary = document.getElementById('summary');
const facts = document.getElementById('facts');
const errorBox = document.getElementById('error');
const changes = document.getElementById('changes');

const learnLink = (title) =>
  el('a', { text: `Learn the current ${title}`, attrs: { href: `/lawbuddy/teach?q=${encodeURIComponent(`Explain ${title}`)}` } });

const phrases = (label, items) => {
  const line = el('p', { text: label });
  items.forEach((phrase, index) => {
    if (index) line.append(' · ');
    line.append(el('q', { text: phrase }));
  });
  return line;
};

const judgmentLink = (judgment) => (judgment
  ? safeLink(judgment.pdfUrl, `${judgment.title}${judgment.decidedOn ? ` (${formatDate(judgment.decidedOn)})` : ''}`)
  : null);

/** The checker may attach a page or a list of pages to a finding. */
const pageEvidence = (finding) => {
  const values = [finding?.page, ...(Array.isArray(finding?.pages) ? finding.pages : [])];
  const pages = [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  return pages.length ? el('p', { className: 'page-evidence', text: `Page evidence: ${pages.join(', ')}` }) : null;
};

const judicialNotes = (finding) => (finding.judicial || []).map((note) => el('div', { className: 'judicial' }, [
  el('strong', { text: note.kind === 'struck-down' ? 'Struck-down note: ' : 'Commencement note: ' }),
  document.createTextNode(note.text),
  note.judgment ? el('span', { className: 'judgment' }, [document.createTextNode(' Judgment: '), judgmentLink(note.judgment)]) : null,
  pageEvidence(note),
].filter(Boolean)));

/** A titled list that shows the first FIRST_SHOWN items and a button for the rest. */
const group = (title, items, render, { note = null } = {}) => {
  const list = el('ul', { className: 'diff-list' }, items.slice(0, FIRST_SHOWN).map(render));
  const section = el('section', { className: 'diff-group' }, [el('h3', { text: `${title} (${items.length})` }), note ? el('p', { className: 'group-note', text: note }) : null, list].filter(Boolean));
  if (items.length > FIRST_SHOWN) {
    const more = el('button', { className: 'button ghost', text: `Show all ${items.length}`, attrs: { type: 'button' } });
    more.addEventListener('click', () => {
      list.replaceChildren(...items.map(render));
      more.remove();
    });
    section.append(more);
  }
  return section;
};

const item = (head, detail, children) => el('li', { className: 'diff' }, [
  el('div', { className: 'diff-head' }, [el('strong', { text: head }), detail ? el('span', { text: detail }) : null].filter(Boolean)),
  ...children.filter(Boolean),
]);

// ------------------------------------------------------------------ copies of Acts

const notLocated = (report) => Array.isArray(report.absentLabels)
  ? report.absentLabels
  : Array.isArray(report.notLocated) ? report.notLocated : [];

const absentCount = (report) => Number.isInteger(report.counts?.absent)
  ? report.counts.absent
  : notLocated(report).length;

const scopeOf = (report) => {
  const declared = report.scope?.kind ?? report.scope ?? report.copyScope;
  if (declared === 'extract' || declared === 'partial') return 'extract';
  if (declared === 'apparently-incomplete' || declared === 'incomplete') return 'apparently-incomplete';
  if (declared === 'complete') return 'complete';
  if (report.partial) return 'extract';
  return absentCount(report) ? 'apparently-incomplete' : 'complete';
};

const actCopySummary = (report) => {
  if (report.verdict === 'official') {
    return `This PDF has the same SHA-256 fingerprint as the source file imported into LawBuddy for ${report.act}. Confirm that the imported source is current before relying on it.`;
  }
  const counts = report.counts;
  if (!counts) return report.summary;
  const parts = [`LawBuddy located ${counts.present} of ${counts.comparable} comparable provisions in the uploaded PDF.`];
  if (counts.reworded) parts.push(`${counts.reworded} difference${counts.reworded === 1 ? '' : 's'} need review.`);
  if (counts.explained) parts.push(`${counts.explained} difference${counts.explained === 1 ? '' : 's'} have judicial or commencement notes to review.`);
  if (absentCount(report)) parts.push(`${absentCount(report)} provision${absentCount(report) === 1 ? ' was' : 's were'} not located.`);
  if (report.newerThanCopy?.length) parts.push(`${report.newerThanCopy.length} provision${report.newerThanCopy.length === 1 ? ' has' : 's have'} a library effective date after the print date supplied; this date signal alone does not show that the copy has old wording.`);
  if (report.verdict === 'unreadable') parts.push('Too little text could be located for a dependable comparison.');
  return parts.join(' ');
};

const actCopyGroups = (report) => {
  const groups = [];
  const scope = scopeOf(report);
  const absent = absentCount(report);
  if (scope === 'extract') {
    groups.push(el('div', { className: 'notice warn partial' }, [
      el('strong', { text: 'Appears to be an extract' }),
      document.createTextNode(`LawBuddy located ${report.counts.present} of ${report.counts.comparable} comparable provisions. It checked the text it could locate; provisions outside an extract still need separate checking.`),
    ]));
  } else if (scope === 'apparently-incomplete') {
    groups.push(el('div', { className: 'notice warn partial' }, [
      el('strong', { text: 'Apparently incomplete copy' }),
      document.createTextNode(`${absent} provision${absent === 1 ? ' was' : 's were'} not located. The PDF may omit them, or extraction may have missed them. Review the pages and source before treating this as a complete Act.`),
    ]));
  }
  if (absent) {
    const labels = notLocated(report);
    groups.push(labels.length
      ? group('Provisions not located in the PDF', labels, (entry) => {
        const label = typeof entry === 'string' ? entry : entry.label;
        return item(label || 'Unlabelled provision', null, [typeof entry === 'string' ? null : pageEvidence(entry)]);
      }, { note: 'Not located does not prove the provision is missing from the printed pages. A scan, unusual layout or deliberate extract can also cause this result.' })
      : el('p', { className: 'group-note', text: `${absent} provisions could not be located in the PDF.` }));
  }
  if (report.newerThanCopy?.length) {
    groups.push(group('Library dates later than the supplied print date', report.newerThanCopy, (provision) =>
      item(provision.label, `library date ${formatDate(provision.validFrom)}`, [provision.heading ? el('p', { text: provision.heading }) : null, pageEvidence(provision)]),
    { note: 'A printed date is only a clue. Compare the actual wording and check commencement before deciding that this copy is outdated.' }));
  }
  if (report.reworded?.length) {
    groups.push(group('Differences from the imported official source', report.reworded, (provision) =>
      item(provision.title || provision.label, Number.isFinite(provision.coverage) ? `${Math.round(provision.coverage * 100)}% of the imported wording detected` : null, [
        provision.heading ? el('p', { text: provision.heading }) : null,
        provision.missing?.length ? phrases('Imported source words not detected in your copy: ', provision.missing) : null,
        pageEvidence(provision),
        ...judicialNotes(provision),
        learnLink(provision.title),
      ])));
  }
  if (report.explained?.length) {
    groups.push(group('Differences with judicial or commencement notes', report.explained, (provision) =>
      item(provision.title || provision.label, null, [
        provision.missing?.length ? phrases('The imported source prints: ', provision.missing) : null,
        pageEvidence(provision),
        ...judicialNotes(provision),
      ]), { note: 'Read the cited note and compare the exact changed words. A note about a provision does not by itself explain every difference in that provision.' }));
  }
  if (!report.reworded?.length && !report.newerThanCopy?.length && !report.explained?.length && !absent) {
    groups.push(el('p', { className: 'empty', text: report.verdict === 'official'
      ? 'The upload is the same file as the imported source.'
      : 'No difference was detected in the provisions LawBuddy could locate.' }));
  }
  return groups;
};

const actCopyFacts = (report) => [
  el('li', { className: report.counts.reworded || absentCount(report) ? 'warn' : 'info', text: `No difference detected in ${report.counts.identical} of ${report.counts.present} located provisions` }),
  report.counts.reworded ? el('li', { className: 'warn', text: `${report.counts.reworded} read differently` }) : null,
  absentCount(report) ? el('li', { className: 'warn', text: `${absentCount(report)} not located in the PDF` }) : null,
  report.counts.explained ? el('li', { className: 'warn', text: `${report.counts.explained} differences have legal notes to review` }) : null,
  report.counts.formatting ? el('li', { text: `${report.counts.formatting} may reflect PDF layout or extraction` }) : null,
  report.textCurrentTo ? el('li', { text: `Amendment footnotes stop at ${formatDate(report.textCurrentTo)}` }) : null,
  report.official ? el('li', {}, [document.createTextNode(`Imported source for ${report.act}: `), safeLink(report.official.url, hostOf(report.official.url) || 'source')]) : null,
];

// ------------------------------------------------------------------ repealed codes

const lookupBox = (report) => {
  const input = el('input', { attrs: { type: 'text', placeholder: 'Section number, e.g. 302', 'aria-label': `Section of the ${report.act}` } });
  const result = el('div', { className: 'lookup-result' });
  const go = el('button', { className: 'button ghost', text: 'Find the section that replaced it', attrs: { type: 'button' } });
  go.addEventListener('click', async () => {
    const section = input.value.trim();
    if (!section) return;
    const params = new URLSearchParams({ act: report.actCode, section });
    const { body } = await fetchJson(`/lawbuddy/api/lookup?${params}`).catch(() => ({ body: {} }));
    result.replaceChildren(...(body.matches?.length
      ? body.matches.map((match) => el('p', { text: `${match.old} → ${match.new}${match.shared ? ` (${Math.round(match.shared * 100)}% of the new wording carried over)` : ''}` }))
      : [el('p', { className: 'empty', text: `LawBuddy found no section of the new code carrying forward ${report.actCode} s.${section}: it may have been merged, reworded or omitted.` })]));
  });
  return el('section', { className: 'diff-group' }, [
    el('h3', { text: 'Which section replaced it?' }),
    el('div', { className: 'lookup' }, [input, go]),
    result,
    el('p', { className: 'group-note', text: 'Matched by LawBuddy from the two texts, not the official MHA table.' }),
  ]);
};

const repealedGroups = (report) => [
  report.repeal ? el('section', { className: 'diff-group' }, [
    el('h3', { text: `Repealed by ${report.repeal.act}, section ${report.repeal.label.slice(2)}` }),
    el('blockquote', { className: 'official', text: report.repeal.text }),
    el('p', { text: `In force from ${formatDate(report.repeal.validFrom)}.` }),
    pageEvidence(report.repeal),
  ]) : null,
  lookupBox(report),
].filter(Boolean);

const unsupportedGroups = (report) => [
  el('div', { className: 'notice warn partial' }, [
    el('strong', { text: 'No section-level check was run' }),
    document.createTextNode('This appears to be an Act that LawBuddy does not yet hold as an imported official source. Review it against the relevant Gazette or India Code publication.'),
  ]),
  report.identified?.words ? el('p', { className: 'group-note', text: `${report.identified.words} words were extracted, but readable text alone cannot establish whether the Act is current.` }) : null,
].filter(Boolean);

// ------------------------------------------------------------------ write-ups

const STATUS_TEXT = Object.freeze({
  'in-force': ['ok', 'In library text'],
  'not-in-force': ['danger', 'Not verified in force'],
  'commencement-caution': ['warn', 'Commencement needs review'],
  'not-found': ['danger', 'Not in imported text'],
  'not-held': ['', 'Not in the library'],
  repealed: ['warn', 'Repealed'],
  exact: ['ok', 'Quotation found'],
  approximate: ['warn', 'Similar wording found'],
  altered: ['danger', 'Not the law\'s wording'],
  'cut-before-condition': ['warn', 'Stops before a condition'],
  unmatched: ['', 'Not a provision LawBuddy holds'],
  verified: ['ok', 'Citation matched index'],
  'name-mismatch': ['danger', 'Wrong case for this citation'],
  overruled: ['danger', 'Overruled'],
  caution: ['warn', 'Partly overruled or doubted'],
  'not-in-index': ['', 'Not in the Supreme Court index'],
  'other-court': ['', 'Another court\'s report'],
  supported: ['ok', 'Supported by the text'],
  overstated: ['warn', 'Broader than the text'],
  contradicted: ['danger', 'Contradicted by the text'],
  unsupported: ['', 'Not settled by the statute'],
  unchecked: ['', 'Not checked'],
});
const chip = (status) => {
  const [tone, text] = STATUS_TEXT[status] || ['', status];
  return el('span', { className: `verdict ${tone || 'info'}`, text });
};

const writeUpGroups = (report) => {
  const groups = [];
  if (report.errors.length) {
    groups.push(el('div', { className: 'notice danger' }, [el('strong', { text: 'Errors' }), el('ul', {}, report.errors.map((text) => el('li', { text })))]));
  }
  if (report.warnings.length) {
    groups.push(el('div', { className: 'notice warn' }, [el('strong', { text: 'Needs care' }), el('ul', {}, report.warnings.map((text) => el('li', { text })))]));
  }
  if (report.references.length) {
    groups.push(group('Provisions it names', report.references, (reference) => item(reference.reference, null, [
      chip(reference.status),
      reference.heading ? el('p', { text: reference.heading }) : null,
      pageEvidence(reference),
      reference.status === 'repealed'
        ? el('p', { text: reference.successors.length
          ? `Replaced by ${reference.successors.map((successor) => `${successor.tag}${successor.heading ? ` (${successor.heading})` : ''}`).join('; ')}. Matched by LawBuddy from the two texts.`
          : `Repealed by ${reference.repealedBy}; LawBuddy found no section carrying its wording forward.` })
        : null,
    ])));
  }
  if (report.quotations.length) {
    groups.push(group('Quotations', report.quotations, (quotation) => item(quotation.source || 'Quotation', null, [
      chip(quotation.status),
      el('blockquote', { text: `“${quotation.text}”` }),
      quotation.condition ? el('p', { text: `The official text continues: “${quotation.condition}…”` }) : null,
      pageEvidence(quotation),
    ])));
  }
  if (report.citations.length) {
    groups.push(group('Case citations', report.citations, (citation) => item(citation.citation, citation.name, [
      chip(citation.status),
      citation.judgment ? el('p', {}, [
        document.createTextNode(citation.status === 'name-mismatch' ? 'This citation is: ' : 'Judgment: '),
        judgmentLink(citation.judgment),
        document.createTextNode(`${citation.judgment.bench ? ` · ${citation.judgment.bench}-judge bench` : ''}${citation.judgment.citedBy ? ` · cited in ${citation.judgment.citedBy} later judgments indexed` : ''}`),
      ]) : null,
      pageEvidence(citation),
    ])));
  }
  const claims = report.critique?.claims || [];
  if (claims.length) {
    groups.push(group('Claims read against the law they cite', claims, (claim) => item(claim.tags.join(', '), null, [
      chip(claim.verdict),
      el('p', { text: claim.text }),
      claim.reason ? el('p', { className: 'claim-reason', text: claim.reason }) : null,
      claim.correction ? el('p', { className: 'claim-correction' }, [el('strong', { text: 'What the text says: ' }), document.createTextNode(claim.correction)]) : null,
      pageEvidence(claim),
    ]), { note: `Read by a second model (${report.critique.model}) beside the official text of each provision.` }));
  } else if (report.critique?.error) {
    groups.push(el('p', { className: 'empty', text: report.critique.error }));
  }
  if (!groups.length) groups.push(el('p', { className: 'empty', text: 'No provision, quotation of the law or case citation was found to check.' }));
  return groups;
};

const writeUpFacts = (report) => [
  el('li', { text: `${report.counts.references} provisions, ${report.counts.quotations} quotations and ${report.counts.citations} case citations identified` }),
  report.counts.claims ? el('li', { text: `${report.counts.claims} claims read against the law they cite` }) : null,
  report.counts.errors ? el('li', { className: 'danger', text: `${report.counts.errors} errors` }) : null,
  report.counts.warnings ? el('li', { className: 'warn', text: `${report.counts.warnings} points need care` }) : null,
];

// ------------------------------------------------------------------ page

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
};

const render = (report) => {
  const [tone, text] = VERDICTS[report.verdict] || ['', report.verdict];
  verdictBadge.className = `badge ${tone}`;
  verdictBadge.textContent = text;
  verdictBadge.hidden = false;
  const resultSummary = report.kind === 'act-copy' ? actCopySummary(report) : report.summary;
  summary.textContent = `LawBuddy read this as ${KIND_TEXT[report.kind] || 'a document'}${report.act ? ` (${report.act})` : ''}. ${resultSummary || 'This document could not be fully checked.'}`;
  summary.hidden = false;

  const kindFacts = report.kind === 'act-copy' ? actCopyFacts(report) : report.kind === 'write-up' ? writeUpFacts(report) : [];
  facts.replaceChildren(...kindFacts.filter(Boolean));
  const groups = report.kind === 'act-copy' ? actCopyGroups(report)
    : report.kind === 'repealed' ? repealedGroups(report)
      : report.kind === 'unsupported' ? unsupportedGroups(report)
        : writeUpGroups(report);
  if (report.kind !== 'unsupported') {
    groups.push(el('p', { className: 'source-caveat', text: 'This check uses official sources imported into LawBuddy. Check for later amendments, commencement notifications and decisions before relying on their current status.' }));
  }
  changes.replaceChildren(...groups);
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  errorBox.hidden = true;
  if (!file) return;
  if (file.size > MAX_BYTES) {
    showError('That PDF is larger than 30 MB.');
    return;
  }

  const localOnly = localOnlyInput.checked;
  const params = new URLSearchParams({ act: 'auto' });
  if (dateInput.value) params.set('date', dateInput.value);
  if (!localOnly) params.set('cloudClaims', '1');
  button.disabled = true;
  statusLine.textContent = localOnly
    ? 'Reading your PDF and running local checks…'
    : 'Reading your PDF and checking it. Optional AI claim analysis can take a minute…';
  try {
    const response = await fetch(`/lawbuddy/api/copy-check?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      statusLine.textContent = 'The check did not complete.';
      showError(body.error || `The check failed (HTTP ${response.status}).`);
      return;
    }
    statusLine.textContent = localOnly
      ? `Checked ${file.name} locally. AI claim analysis was skipped.`
      : `Checked ${file.name}.`;
    render(body);
  } catch {
    statusLine.textContent = 'The check did not complete.';
    showError('Could not reach LawBuddy. Is the server running?');
  } finally {
    button.disabled = false;
  }
});
