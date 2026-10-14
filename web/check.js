// "Is my bare act current?": sends a PDF to POST /lawbuddy/api/copy-check and shows the verdict
// and, provision by provision, what the copy is missing compared with the official text.
import { el, formatDate, hostOf, humanLabel, safeLink } from './common.js';

const MAX_BYTES = 30 * 1024 * 1024;
const FIRST_SHOWN = 25;
// Below this share of the official wording, what the copy holds is only shared legal phrasing
// ("No person shall be deprived of his …"), not the provision: treat it as absent.
const PRESENT_COVERAGE = 0.7;
// When most provisions are absent, the PDF is an extract (or a scan without text), not a full copy.
const PARTIAL_COPY_SHARE = 0.5;
const VERDICTS = Object.freeze({
  current: ['ok', 'Current'],
  outdated: ['warn', 'Outdated'],
  differs: ['warn', 'Differs from the official text'],
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

const learnLink = (label) =>
  el('a', {
    text: `Learn the current ${humanLabel(label)}`,
    attrs: { href: `/lawbuddy/teach?q=${encodeURIComponent(`Explain ${humanLabel(label)}`)}` },
  });

const newerItem = (provision) =>
  el('li', { className: 'diff' }, [
    el('div', { className: 'diff-head' }, [
      el('strong', { text: humanLabel(provision.label) }),
      el('span', { text: `in force from ${formatDate(provision.validFrom)}` }),
    ]),
    provision.heading ? el('p', { text: provision.heading }) : null,
    learnLink(provision.label),
  ]);

const missingLine = (phrases) => {
  const line = el('p', { text: 'Missing from your copy: ' });
  phrases.forEach((phrase, index) => {
    if (index) line.append(' · ');
    line.append(el('q', { text: phrase }));
  });
  return line;
};

const differsItem = (provision) =>
  el('li', { className: 'diff' }, [
    el('div', { className: 'diff-head' }, [
      el('strong', { text: humanLabel(provision.label) }),
      el('span', { text: `${Math.round(provision.coverage * 100)}% of the official wording found` }),
    ]),
    provision.heading ? el('p', { text: provision.heading }) : null,
    provision.missing?.length ? missingLine(provision.missing) : null,
    learnLink(provision.label),
  ]);

/** A titled list that shows the first FIRST_SHOWN items and a button for the rest. */
const group = (title, items, render) => {
  const list = el('ul', { className: 'diff-list' }, items.slice(0, FIRST_SHOWN).map(render));
  const section = el('section', { className: 'diff-group' }, [el('h3', { text: `${title} (${items.length})` }), list]);
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

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
};

const render = (report) => {
  const [tone, text] = VERDICTS[report.verdict] || ['', report.verdict];
  verdictBadge.className = `badge ${tone}`;
  verdictBadge.textContent = text;
  verdictBadge.hidden = false;
  summary.textContent = report.summary;
  summary.hidden = false;

  facts.replaceChildren(
    el('li', { className: report.matching === report.compared ? 'ok' : '', text: `${report.matching} of ${report.compared} provisions match` }),
    el('li', {
      text: report.copy.textCurrentTo
        ? `Amendment footnotes stop at ${formatDate(report.copy.textCurrentTo)}`
        : 'No amendment footnotes found in your copy',
    }),
    report.cached ? el('li', { className: 'info', text: 'Answered from an earlier check of this exact file' }) : null,
    report.copy.sameAs
      ? el('li', { className: 'info' }, [
        document.createTextNode('Byte-for-byte the copy published at '),
        safeLink(report.copy.sameAs, hostOf(report.copy.sameAs) || 'its source'),
      ])
      : null,
    el('li', {}, [
      document.createTextNode(`Checked against the ${report.act}: `),
      safeLink(report.official.url, hostOf(report.official.url) || 'official source'),
    ]),
  );

  // A provision the copy has with changed words (an amendment it lacks) teaches more than one it lacks
  // entirely, so those come first, closest matches first; absent ones follow in the Act's order.
  const changed = report.differs.filter((d) => d.coverage >= PRESENT_COVERAGE).sort((a, b) => b.coverage - a.coverage);
  const absent = report.differs.filter((d) => d.coverage < PRESENT_COVERAGE)
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));

  const groups = [];
  if (absent.length > report.compared * PARTIAL_COPY_SHARE) {
    groups.push(el('div', { className: 'notice warn partial' }, [
      el('strong', { text: 'This looks like part of the Act, not a full copy' }),
      document.createTextNode(`${report.compared - absent.length} of ${report.compared} provisions were found in your PDF. `
        + 'It may be an extract, or a scan without a text layer; the check only covers what it contains.'),
    ]));
  }
  if (report.newerThanCopy.length) groups.push(group("Took effect after your copy's date", report.newerThanCopy, newerItem));
  if (changed.length) groups.push(group('Wording differs from the official text in force', changed, differsItem));
  if (absent.length) groups.push(group('Not found in your copy', absent, differsItem));
  changes.replaceChildren(...(groups.length
    ? groups
    : [el('p', { className: 'empty', text: 'Nothing to show: every comparable provision matches the official text.' })]));
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

  const params = new URLSearchParams({ act: 'constitution' });
  if (dateInput.value) params.set('date', dateInput.value);
  button.disabled = true;
  statusLine.textContent = 'Reading your PDF and comparing it with the official text. This can take up to a minute…';
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
