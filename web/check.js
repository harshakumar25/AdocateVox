// "Check my bare act, or my notes": sends a PDF to POST /lawbuddy/api/copy-check, which first works out what
// the document is (a copy of an Act, a copy of a repealed code, or a write-up) and then checks it. Every
// finding is shown with the official text or judgment behind it. Untrusted text is only set through textContent.
import { el, fetchJson, formatDate, hostOf, safeLink } from './common.js';

const MAX_BYTES = 30 * 1024 * 1024;
const FIRST_SHOWN = 25;
const VERDICTS = Object.freeze({
  official: ['ok', 'The official text itself'],
  matches: ['ok', 'Matches the official text'],
  differs: ['warn', 'Differs from the official text'],
  outdated: ['warn', 'Outdated'],
  unreadable: ['warn', 'Could not be compared'],
  repealed: ['danger', 'Repealed law'],
  reliable: ['ok', 'Checks out'],
  'use-with-care': ['warn', 'Use with care'],
  unreliable: ['danger', 'Contains errors'],
  'nothing-to-check': ['', 'Nothing to check'],
});
const KIND_TEXT = Object.freeze({
  'act-copy': 'a copy of an Act LawBuddy holds in its official text',
  repealed: 'a copy of a repealed code',
  'write-up': 'a write-up (notes, an article or an answer) about the law',
});

const form = document.getElementById('check-form');
const fileInput = document.getElementById('file');
const dateInput = document.getElementById('date');
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

const actCopyGroups = (report) => {
  const groups = [];
  if (report.partial) {
    groups.push(el('div', { className: 'notice warn partial' }, [
      el('strong', { text: 'This is part of the Act, not a full copy' }),
      document.createTextNode(`It holds ${report.counts.present} of ${report.counts.comparable} provisions; the check covers what it contains, and the missing provisions are not counted as errors.`),
    ]));
  }
  if (report.newerThanCopy?.length) {
    groups.push(group("Took effect after your copy's date", report.newerThanCopy, (provision) =>
      item(provision.label, `in force from ${formatDate(provision.validFrom)}`, [provision.heading ? el('p', { text: provision.heading }) : null])));
  }
  if (report.reworded?.length) {
    groups.push(group('Reads differently from the official text in force', report.reworded, (provision) =>
      item(provision.title, `${Math.round(provision.coverage * 100)}% of the official wording found`, [
        provision.heading ? el('p', { text: provision.heading }) : null,
        provision.missing?.length ? phrases('Official words your copy lacks: ', provision.missing) : null,
        learnLink(provision.title),
      ])));
  }
  if (report.explained?.length) {
    groups.push(group('Differs only where a court struck down the printed amendment', report.explained, (provision) =>
      item(provision.title, null, [
        provision.missing?.length ? phrases('The official text prints: ', provision.missing) : null,
        ...provision.judicial.map((note) => el('p', { className: 'judicial' }, [
          el('strong', { text: note.kind === 'struck-down' ? 'Struck down: ' : 'Not in force: ' }),
          document.createTextNode(note.text),
          note.judgment ? el('span', { className: 'judgment' }, [document.createTextNode(' Judgment: '), judgmentLink(note.judgment)]) : null,
        ].filter(Boolean))),
      ]), { note: 'Your copy is not wrong here: the words it lacks are an amendment the Supreme Court struck down, or one never brought into force, so the older wording in your copy is what applies.' }));
  }
  if (!groups.length || (!report.reworded?.length && !report.newerThanCopy?.length)) {
    groups.push(el('p', { className: 'empty', text: report.verdict === 'official'
      ? 'Nothing to compare: this is the official file itself.'
      : 'Every provision your copy contains matches the official text in force.' }));
  }
  return groups;
};

const actCopyFacts = (report) => [
  el('li', { className: report.counts.reworded ? '' : 'ok', text: `${report.counts.identical} of ${report.counts.present} provisions in your copy match word for word` }),
  report.counts.reworded ? el('li', { className: 'warn', text: `${report.counts.reworded} read differently` }) : null,
  report.counts.explained ? el('li', { className: 'info', text: `${report.counts.explained} differ only where a court struck down the printed text` }) : null,
  report.counts.formatting ? el('li', { text: `${report.counts.formatting} differ only in how the PDF was printed (line breaks, page heads): not counted` }) : null,
  report.textCurrentTo ? el('li', { text: `Amendment footnotes stop at ${formatDate(report.textCurrentTo)}` }) : null,
  report.official ? el('li', {}, [document.createTextNode(`Checked against the official ${report.act}: `), safeLink(report.official.url, hostOf(report.official.url) || 'official source')]) : null,
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
  ]) : null,
  lookupBox(report),
].filter(Boolean);

// ------------------------------------------------------------------ write-ups

const STATUS_TEXT = Object.freeze({
  'in-force': ['ok', 'In force'],
  'not-found': ['danger', 'Not in the official text'],
  'not-held': ['', 'Not in the library'],
  repealed: ['warn', 'Repealed'],
  exact: ['ok', 'Word for word'],
  approximate: ['ok', 'Matches closely'],
  altered: ['danger', 'Not the law\'s wording'],
  'cut-before-condition': ['warn', 'Stops before a condition'],
  unmatched: ['', 'Not a provision LawBuddy holds'],
  verified: ['ok', 'Verified'],
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
    ])));
  }
  const claims = report.critique?.claims || [];
  if (claims.length) {
    groups.push(group('Claims read against the law they cite', claims, (claim) => item(claim.tags.join(', '), null, [
      chip(claim.verdict),
      el('p', { text: claim.text }),
      claim.reason ? el('p', { className: 'claim-reason', text: claim.reason }) : null,
      claim.correction ? el('p', { className: 'claim-correction' }, [el('strong', { text: 'What the text says: ' }), document.createTextNode(claim.correction)]) : null,
    ]), { note: `Read by a second model (${report.critique.model}) beside the official text of each provision.` }));
  } else if (report.critique?.error) {
    groups.push(el('p', { className: 'empty', text: report.critique.error }));
  }
  if (!groups.length) groups.push(el('p', { className: 'empty', text: 'No provision, quotation of the law or case citation was found to check.' }));
  return groups;
};

const writeUpFacts = (report) => [
  el('li', { text: `${report.counts.references} provisions, ${report.counts.quotations} quotations and ${report.counts.citations} case citations checked` }),
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
  summary.textContent = `LawBuddy read this as ${KIND_TEXT[report.kind] || 'a document'}${report.act ? ` (${report.act})` : ''}. ${report.summary}`;
  summary.hidden = false;

  const kindFacts = report.kind === 'act-copy' ? actCopyFacts(report) : report.kind === 'write-up' ? writeUpFacts(report) : [];
  facts.replaceChildren(...kindFacts.filter(Boolean));
  const groups = report.kind === 'act-copy' ? actCopyGroups(report) : report.kind === 'repealed' ? repealedGroups(report) : writeUpGroups(report);
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

  const params = new URLSearchParams({ act: 'auto' });
  if (dateInput.value) params.set('date', dateInput.value);
  button.disabled = true;
  statusLine.textContent = 'Reading your PDF, working out what it is and checking it. A write-up\'s claims are read one by one, which can take a minute…';
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
    statusLine.textContent = `Checked ${file.name}.`;
    render(body);
  } catch {
    statusLine.textContent = 'The check did not complete.';
    showError('Could not reach LawBuddy. Is the server running?');
  } finally {
    button.disabled = false;
  }
});
