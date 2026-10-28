// LawBuddy teaching studio: streams a grounded answer from POST /lawbuddy/teach,
// speaks it (Chatterbox clips, browser speech as fallback) and shows the official
// text it relied on. Untrusted text is only ever set through textContent.
import { el, fetchJson, formatDate, hostOf, humanLabel, safeLink } from './common.js';
import { selectPreferredVoice, normaliseSpeechRate, isBannedRoboticVoice, voiceProfile } from './voiceSelector.js';
import { createCasesView } from './cases.js';

const form = document.getElementById('ask-form');
const question = document.getElementById('question');
const teachButton = document.getElementById('teach');
const stopButton = document.getElementById('stop');
const narrator = document.getElementById('narrator');
const speechRate = document.getElementById('speech-rate');
const cloudConsent = document.getElementById('cloud-speech-consent');
let indianVoiceConfigured = false;
const voiceNote = document.getElementById('voice-note');
let storedNarrator = 'auto';
try { storedNarrator = localStorage.getItem('lawbuddy.narrator') || 'auto'; speechRate.value = localStorage.getItem('lawbuddy.speech-rate') || '1'; } catch {}
const voiceToggle = document.getElementById('voice');
const answer = document.getElementById('answer');
const statusLine = document.getElementById('status');
const grounding = document.getElementById('grounding');
const errorBox = document.getElementById('error');
const evidence = document.getElementById('evidence');
const reading = document.getElementById('reading');
const answerCheck = document.getElementById('answer-check');
const critiquePanel = document.getElementById('critique');
const examples = document.getElementById('examples');
const cases = createCasesView({
  pointsTable: document.getElementById('points-table'),
  pointsBody: document.getElementById('points-body'),
  pointsEmpty: document.getElementById('points-empty'),
  pointsTitle: document.getElementById('points-title'),
  pointsChoices: document.getElementById('points-choices'),
  casesSection: document.getElementById('cases'),
  casesList: document.getElementById('case-list'),
  casesTitle: document.getElementById('cases-title'),
  casesNote: document.getElementById('cases-note'),
});

const OFFICIAL_TEXT_PREVIEW_PARAGRAPHS = 4;

let controller = null;
let runId = 0;
let streaming = false;

const setStatus = (text) => {
  statusLine.textContent = text;
};

const setBusy = (busy) => {
  streaming = busy;
  teachButton.disabled = busy;
  document.getElementById('voice-preview').disabled = busy;
  stopButton.hidden = !busy && !voice.playing;
};

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
};

// ---------------------------------------------------------------- voice

/** Plays Chatterbox clips and browser speech strictly in arrival order (the server synthesizes in order). */
const voice = {
  queue: [],
  playing: false,
  generation: 0,
  audio: null,
  objectUrl: null,
  speechRequest: null,
  speechResolve: null,
  clipResolve: null,

  reset() {
    this.speechRequest?.abort(); this.speechRequest = null;
    this.generation += 1;
    this.queue = [];
    this.playing = false;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    this.clipResolve?.(); this.clipResolve = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.speechResolve?.(); this.speechResolve = null;
  },

  enqueue(item) {
    if (!voiceToggle.checked) return;
    this.queue.push(item);
    if (!this.playing) this.next();
  },

  async next() {
    const generation = this.generation;
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      stopButton.hidden = !streaming;
      if (!streaming && errorBox.hidden) setStatus('Done.');
      return;
    }
    this.playing = true;
    stopButton.hidden = false;
    try {
      if (item.fileName && narrator.value === 'auto') await this.playClip(item.fileName, generation);
      else await this.speak(item.text);
    } catch {
      // A clip that cannot be fetched or played is read by the browser instead.
      if (generation === this.generation && item.text) await this.speak(item.text);
    }
    if (generation === this.generation) this.next();
  },

  async playClip(fileName, generation) {
    const response = await fetch(`/audio/${encodeURIComponent(fileName)}`, {
      headers: { 'X-DocVex-Extension-Origin': window.location.origin },
    });
    if (!response.ok) throw new Error(`Audio unavailable (${response.status})`);
    const blob = await response.blob();
    if (generation !== this.generation) return;
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);
    this.audio.playbackRate = normaliseSpeechRate(speechRate.value);
    await new Promise((resolve, reject) => {
      this.clipResolve = resolve;
      this.audio.onended = resolve;
      this.audio.onerror = reject;
      this.audio.play().catch(reject);
    });
    if (generation !== this.generation) return;
    this.clipResolve = null;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.audio = null;
  },

  async speakIndian(text) {
    const generation = this.generation;
    if (!cloudConsent.checked || !indianVoiceConfigured) {
      voiceNote.textContent = indianVoiceConfigured ? 'Allow cloud speech above to use this Indian voice.' : 'Indian neural voices need server setup. Choose a device voice for now.';
      this.queue = [];
      return;
    }
    const request = new AbortController(); this.speechRequest = request;
    try {
      // Preserve every character; split long paragraphs at whitespace, not mid-word.
      let remaining = String(text || '').trim();
      while (remaining && generation === this.generation) {
        let end = Math.min(2200, remaining.length);
        if (end < remaining.length) { const space = remaining.lastIndexOf(' ', end); if (space > 1000) end = space; }
        const segment = remaining.slice(0, end); remaining = remaining.slice(end).trimStart();
        voiceNote.textContent = 'Preparing Indian-English audio…';
        const response = await fetch('/lawbuddy/api/speech', {
          method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: segment, voice: narrator.value, rate: normaliseSpeechRate(speechRate.value), cloudConsent: true }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Indian voice is unavailable.');
        if (generation !== this.generation) return;
        const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
        this.objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
        this.audio = new Audio(this.objectUrl);
        // Pace is synthesized by the provider; do not time-stretch the audio twice.
        voiceNote.textContent = `Speaking with ${narrator.value === 'indian-female' ? 'Ishita' : 'Ratan'} · Indian English.`;
        await new Promise((resolve, reject) => {
          this.clipResolve = resolve;
          this.audio.onended = resolve; this.audio.onerror = () => reject(new Error('Audio playback failed.'));
          this.audio.play().catch(reject);
        });
        if (generation !== this.generation) return;
        URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; this.audio = null; this.clipResolve = null;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.reset(); voiceNote.textContent = error.message || 'Indian voice unavailable. Choose a device voice.';
        stopButton.hidden = !streaming;
      }
    } finally { if (this.speechRequest === request) this.speechRequest = null; }
  },

  speak(text) {
    if (narrator.value.startsWith('indian-')) return this.speakIndian(text);
    return new Promise((resolve) => {
      if (!text || !('speechSynthesis' in window)) {
        resolve();
        return;
      }
      // Never let the browser fall back to its default voice (often Daniel on macOS):
      // only an allowed voice from the shared selector may read the answer.
      const chosen = selectPreferredVoice(window.speechSynthesis.getVoices(), narrator.value);
      if (!chosen) {
        voiceNote.textContent = 'This voice is not available on this device. Choose another installed voice or Automatic.';
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
      utterance.rate = normaliseSpeechRate(speechRate.value);
      voiceNote.textContent = `Speaking with ${chosen.name}.`;
      const finish = () => { if (this.speechResolve === finish) this.speechResolve = null; resolve(); };
      this.speechResolve = finish;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  },
};

// Chromium loads the voice list lazily; asking once at start-up means it is ready for the first fallback.
const refreshVoices = () => {
  const voices = window.speechSynthesis?.getVoices() || [];
  const selected = narrator.value || storedNarrator;
  for (const option of [...narrator.options]) if (option.value.startsWith('voice:')) option.remove();
  for (const v of voices.filter((v) => /^en(?:-|$)/i.test(v.lang) && (!isBannedRoboticVoice(v.name) || voiceProfile(v) === 'male'))) {
    const option = document.createElement('option'); option.value = `voice:${v.voiceURI}`; option.textContent = `${v.name} · ${v.lang}`; narrator.append(option);
  }
  for (const profile of ['female', 'male']) narrator.querySelector(`option[value="${profile}"]`).disabled = !selectPreferredVoice(voices, profile);
  const wanted = storedNarrator || selected;
  if (![...narrator.options].some((o) => o.value === wanted) && wanted.startsWith('voice:')) { const missing = document.createElement('option'); missing.value = wanted; missing.textContent = 'Saved voice · unavailable'; missing.disabled = true; narrator.append(missing); }
  if ([...narrator.options].some((o) => o.value === wanted)) narrator.value = wanted;
  if (wanted.startsWith('indian-')) voiceNote.textContent = indianVoiceConfigured ? 'Indian English via Sarvam. Enable cloud speech and preview to compare voices.' : 'Indian neural voices need SARVAM_API_KEY on the server; device voices work now.';
  else if (wanted !== 'auto' && !selectPreferredVoice(voices, wanted)) voiceNote.textContent = 'Your saved voice is not available yet. Choose an installed voice or Automatic.';
  else voiceNote.textContent = wanted === 'auto' ? 'Automatic uses the configured server narrator; preview uses browser fallback.' : `Ready: ${selectPreferredVoice(voices, wanted).name}.`;
};
if ('speechSynthesis' in window) { window.speechSynthesis.addEventListener('voiceschanged', refreshVoices); }
refreshVoices();
narrator.addEventListener('change', () => {
  voice.reset(); storedNarrator = narrator.value;
  try { localStorage.setItem('lawbuddy.narrator', narrator.value); } catch {}
  if (narrator.value.startsWith('indian-')) { refreshVoices(); return; }
  voiceNote.textContent = narrator.value === 'auto' ? 'Using the configured server voice; browser speech is the fallback.' : 'Using your selected device voice for answers and fallback audio.';
});
cloudConsent.addEventListener('change', () => { voice.reset(); refreshVoices(); });
fetch('/lawbuddy/api/speech').then((r) => r.ok ? r.json() : null).then((data) => {
  indianVoiceConfigured = data?.configured === true;
  for (const [value, name] of [['indian-female', 'Ishita'], ['indian-male', 'Ratan']]) {
    const option = narrator.querySelector(`option[value="${value}"]`);
    option.disabled = !indianVoiceConfigured;
    option.textContent = `Indian English · ${name} (cloud${indianVoiceConfigured ? '' : ', setup required'})`;
  }
  refreshVoices();
}).catch(() => {});
speechRate.addEventListener('change', () => { voice.reset(); try { localStorage.setItem('lawbuddy.speech-rate', speechRate.value); } catch {} });
document.getElementById('voice-preview').addEventListener('click', () => {
  voice.reset();
  if (narrator.value === 'auto') voiceNote.textContent = 'Preview uses the browser fallback. The server narrator is heard during an answer.';
  const generation = voice.generation; voice.playing = true; stopButton.hidden = false;
  voice.speak('Welcome to LawBuddy. Let us read the law carefully, one provision at a time.').finally(() => { if (generation === voice.generation) { voice.playing = false; stopButton.hidden = !streaming; } });
});

const splitSentences = (text) =>
  (String(text).match(/[^.!?]+[.!?]+["'’”)\]]*\s*|[^.!?]+$/g) || []).map((sentence) => sentence.trim()).filter(Boolean);

// ---------------------------------------------------------------- evidence

const placeholderCard = (title) =>
  el('article', { className: 'provision' }, [
    el('div', { className: 'provision-head' }, [el('h3', { text: title }), el('p', { className: 'provision-kicker', text: 'Opening the official text…' })]),
  ]);

const officialText = (text) => {
  const paragraphs = String(text).split('\n').filter(Boolean);
  const quote = el('blockquote', { className: 'official' }, paragraphs.map((paragraph) => el('p', { text: paragraph })));
  if (paragraphs.length <= OFFICIAL_TEXT_PREVIEW_PARAGRAPHS) return [quote];

  quote.classList.add('clamped');
  const more = el('button', { className: 'more', text: `Show full text (${paragraphs.length} paragraphs)`, attrs: { type: 'button', 'aria-expanded': 'false' } });
  more.addEventListener('click', () => {
    const expanded = quote.classList.toggle('clamped') === false;
    more.textContent = expanded ? 'Show less' : `Show full text (${paragraphs.length} paragraphs)`;
    more.setAttribute('aria-expanded', String(expanded));
  });
  return [quote, more];
};

// Why a provision was retrieved for this question (from LawBuddy's question analysis).
const ROLE_CHIPS = Object.freeze({
  allows: ['Permits', 'ok'],
  right: ['Your right', 'ok'],
  forbids: ['Forbids', 'danger'],
  limits: ['Where the line is', 'warn'],
  duty: ['Duty of the authorities', 'info'],
  procedure: ['Procedure', 'info'],
  consequence: ['If the line is crossed', 'danger'],
  scope: ['Where the law applies', 'info'],
  liability: ['Who is liable', 'warn'],
});

/** "s.38" of the BNS → "Section 38"; Articles and Schedules as before. */
const provisionTitle = (provision) => (provision.act && provision.act !== 'COI' && provision.label?.startsWith('s.')
  ? `Section ${provision.label.slice(2)}`
  : humanLabel(provision.label));

const provisionCard = (provision, { viaSearch, role = null }) => {
  const where = [
    provision.actTitle || 'Constitution of India',
    provision.context?.part,
    provision.context?.chapter && provision.context?.chapterTitle
      ? `${provision.context.chapter}: ${provision.context.chapterTitle.charAt(0)}${provision.context.chapterTitle.slice(1).toLowerCase()}`
      : provision.context?.chapter,
    provision.context?.group,
  ].filter(Boolean);
  const [roleText, roleClass] = ROLE_CHIPS[role] || [];
  const facts = [
    roleText ? el('li', { className: roleClass, text: roleText }) : null,
    el('li', { className: 'ok', text: `In force since ${formatDate(provision.inForceSince)}` }),
    provision.gazette ? el('li', { className: 'info', text: `Gazette ${provision.gazette}` }) : null,
    provision.lastAmendedBy ? el('li', { text: `Last amended by the ${provision.lastAmendedBy}` }) : null,
    viaSearch ? el('li', { className: 'info', text: 'Matched by search' }) : null,
  ];
  const judicial = provision.judicialNotes?.length
    ? el('div', { className: 'notice danger', attrs: { role: 'note' } }, [
      el('strong', { text: 'Not good law as printed' }),
      el('ul', {}, provision.judicialNotes.map((note) => el('li', { text: note }))),
    ])
    : null;
  const pending = provision.pendingAmendments?.length
    ? el('div', { className: 'notice warn', attrs: { role: 'note' } }, [
      el('strong', {
        text: provision.act
          ? 'Part of this section is not in force'
          : `${provision.pendingAmendments.length} amendment${provision.pendingAmendments.length > 1 ? 's' : ''} never brought into force`,
      }),
      el('ul', {}, provision.pendingAmendments.map((note) => el('li', { text: note }))),
    ])
    : null;
  const source = provision.source?.url
    ? el('footer', { className: 'provenance' }, [
      document.createTextNode('Source: '),
      safeLink(provision.source.url, hostOf(provision.source.url) || 'official source'),
      document.createTextNode(provision.source.sha256 ? ` · fingerprint ${provision.source.sha256.slice(0, 12)}…` : ''),
    ])
    : null;

  return el('article', { className: 'provision' }, [
    el('div', { className: 'provision-head' }, [
      el('p', { className: 'provision-kicker', text: where.join(' · ') }),
      el('h3', { text: provisionTitle(provision) }, [el('span', { text: provision.heading })]),
      el('ul', { className: 'facts' }, facts),
    ]),
    judicial,
    pending,
    ...officialText(provision.text),
    source,
  ]);
};

const absenceCard = (source) =>
  el('article', { className: 'provision' }, [
    el('div', { className: 'provision-head' }, [
      el('p', { className: 'provision-kicker', text: 'Constitution of India' }),
      el('h3', { text: humanLabel(source.label) }),
    ]),
    el('div', { className: 'notice warn', attrs: { role: 'note' } }, [
      el('strong', { text: 'Not in the official text' }),
      document.createTextNode('LawBuddy could not find this provision in force in the stored official edition, so it will not describe it.'),
    ]),
  ]);

const correspondenceCard = (source, lookup) =>
  el('article', { className: 'provision' }, [
    el('div', { className: 'provision-head' }, [
      el('p', {
        className: 'provision-kicker',
        text: (lookup.matches || []).every((match) => match.method === 'alignment')
          ? 'Old and new law, matched by LawBuddy from the two texts (not the official MHA table)'
          : 'Official correspondence table (MHA/NCRB Sankalan)',
      }),
      el('h3', { text: lookup.query || source.title }),
    ]),
    el('ul', { className: 'official' }, (lookup.matches || []).map((match) =>
      el('li', { text: `${match.old} → ${match.new}${match.shared ? ` · ${Math.round(match.shared * 100)}% of the wording carried over` : match.changed ? ' (changed)' : ''}` }))),
    source.url ? el('footer', { className: 'provenance' }, [document.createTextNode('Source: '), safeLink(source.url, hostOf(source.url))]) : null,
  ]);

const renderEvidence = (sources, id, analysis = null) => {
  if (!sources.length) {
    const cyberGap = (analysis?.concepts || []).some((concept) => concept.id === 'unauthorised-security-testing');
    const missing = analysis?.coverage?.missing?.filter((item) => item.act === 'IT2000') || [{ label: 's.43' }, { label: 's.66' }];
    const missingText = missing.length === 1 ? `section ${missing[0].label.slice(2)}` : `sections ${missing.map((item) => item.label.slice(2)).join(' and ')}`;
    const reviewed = missing.filter((item) => item.reviewedThrough);
    const cyberMessage = reviewed.length
      ? `This is a cyber-law question. IT Act ${missingText} ${missing.length === 1 ? 'is' : 'are'} needed, but ${reviewed.map((item) => `section ${item.label.slice(2)} was reviewed only through ${item.reviewedThrough}`).join('; ')}. LawBuddy cannot assess the case for the requested date from older text or FIR provisions alone.`
      : `This is a cyber-law question. The verified text of IT Act ${missingText} is not indexed here yet, so LawBuddy cannot assess your case from the FIR provisions alone.`;
    evidence.replaceChildren(
      el('p', { className: 'empty', text: cyberGap
        ? cyberMessage
        : 'No official text matched this question, so LawBuddy will not answer it from memory. Try naming a provision, such as “Article 21”.' }),
      ...(cyberGap ? [el('p', {}, [document.createTextNode('Read the '), safeLink('https://indiacode.gov.in/', 'India Code portal'), document.createTextNode(' and speak with an Indian cybercrime lawyer if a complaint or FIR has been filed.')])] : []),
    );
    return;
  }

  evidence.replaceChildren();
  for (const source of sources) {
    const card = placeholderCard(source.label ? provisionTitle(source) : source.title);
    evidence.append(card);

    const fill = async () => {
      if (source.kind === 'statute-absence') return absenceCard(source);
      if (source.kind === 'correspondence' && source.lookup) {
        const params = new URLSearchParams({ act: source.lookup.act, section: source.lookup.section });
        const { body } = await fetchJson(`/lawbuddy/api/lookup?${params}`);
        return correspondenceCard(source, body);
      }
      if (source.label) {
        const path = source.act && source.act !== 'COI'
          ? `/lawbuddy/api/section/${encodeURIComponent(source.act)}/${encodeURIComponent(source.label)}`
          : `/lawbuddy/api/article/${encodeURIComponent(source.label)}`;
        const { ok, body } = await fetchJson(path);
        if (ok) return provisionCard(body, { viaSearch: source.via === 'search', role: source.role });
      }
      return el('article', { className: 'provision' }, [
        el('div', { className: 'provision-head' }, [el('h3', { text: source.title })]),
        source.url ? el('footer', { className: 'provenance' }, [document.createTextNode('Source: '), safeLink(source.url, hostOf(source.url))]) : null,
      ]);
    };
    fill()
      .then((filled) => id === runId && card.replaceWith(filled))
      .catch(() => id === runId && card.replaceWith(el('p', { className: 'empty', text: `Could not open ${source.title}.` })));
  }
};

const KIND_TEXT = Object.freeze({
  scenario: 'a situation to solve, so the answer spots each legal issue in your facts and applies the law to it, issue by issue, and says what it could not verify',
  permission: 'a “can I…?” question, so the answer weighs what the law allows against what it forbids and shows where the line is',
  rights: 'a question about rights, so the answer sets out the rights, the duties of the authorities and their limits',
  procedure: 'a question about procedure, so the answer gives the steps the law sets out',
  punishment: 'a question about punishment, so the answer states the offence and the punishment as written',
  formal: 'a request for a formal write-up, so the answer is a legal note: question, applicable law, analysis, conclusion',
  definition: 'a request to explain the law',
  general: 'a general question about the law',
});

/** How LawBuddy read the question: its kind and the legal concepts it maps to. */
const showReading = (analysis) => {
  if (!analysis) {
    reading.hidden = true;
    return;
  }
  const concepts = (analysis.concepts || []).map((concept) => concept.name);
  reading.replaceChildren(
    el('strong', { text: 'How LawBuddy read your question: ' }),
    document.createTextNode(`${KIND_TEXT[analysis.kind] || KIND_TEXT.general}.${concepts.length ? ` Legal concepts: ${concepts.join('; ')}.` : ''}`),
    ...(analysis.warnings || []).filter((warning) => /needed to answer this question/.test(warning))
      .map((warning) => el('span', { className: 'reading-warning', text: ` ${warning}` })),
  );
  reading.hidden = false;
};

/** After the answer: which citations and quotations are tied to the official text it was given. */
const showCheck = (check) => {
  if (!check || (!check.citations.length && !check.quotes.length)) {
    answerCheck.hidden = true;
    return;
  }
  const failures = [
    ...check.citations.filter((citation) => !citation.ok).map((citation) => (citation.problem
      ? `[${citation.tag}]: ${citation.problem}.`
      : `[${citation.tag}] is not one of the provisions LawBuddy retrieved for this answer.`)),
    ...check.quotes.filter((quote) => !quote.ok).map((quote) => `“${quote.text}” is not word for word in the official text: read the provision itself.`),
    ...check.quotes.filter((quote) => quote.cutBefore).map((quote) => `“${quote.text}” stops just before a condition in [${quote.source}]: “${quote.cutBefore}…”. The rule is narrower than the quotation suggests.`),
  ];
  const summary = `Checked against the official text: ${check.verifiedCitations} of ${check.citations.length} citation${check.citations.length === 1 ? '' : 's'} are provisions retrieved for this answer; ${check.verifiedQuotes} of ${check.quotes.length} quotation${check.quotes.length === 1 ? '' : 's'} found in that text.`;
  answerCheck.className = `answer-check ${failures.length ? 'warn' : 'ok'}`;
  answerCheck.replaceChildren(...[
    el('p', { text: summary }),
    failures.length ? el('ul', {}, failures.map((failure) => el('li', { text: failure }))) : null,
  ].filter(Boolean));
  answerCheck.hidden = false;
};

const VERDICT_TEXT = Object.freeze({
  supported: ['Supported by the text', 'ok'],
  overstated: ['Overstated: the text is narrower', 'warn'],
  contradicted: ['Contradicted by the text', 'danger'],
  unsupported: ['Not in the cited text', 'warn'],
  unchecked: ['Not checked', 'info'],
});

/** The independent critique: each claim that cites a provision, read beside that provision's text. */
const showCritique = (critique) => {
  if (critique?.unavailable) {
    critiquePanel.replaceChildren(
      el('h3', { text: 'Critique not available this time' }),
      el('p', { className: 'critique-summary', text: `The second model could not read the claims against the law (${critique.unavailable}). Read each cited provision below before relying on the answer, or ask again in a minute.` }),
    );
    critiquePanel.hidden = false;
    return;
  }
  if (!critique?.claims?.length) {
    critiquePanel.hidden = true;
    return;
  }
  const flagged = critique.claims.filter((claim) => claim.verdict !== 'supported' && claim.verdict !== 'unchecked');
  const unchecked = critique.claims.filter((claim) => claim.verdict === 'unchecked');
  const supported = critique.claims.filter((claim) => claim.verdict === 'supported');
  const card = (claim) => {
    const [label, tone] = VERDICT_TEXT[claim.verdict] || VERDICT_TEXT.unchecked;
    return el('li', { className: `claim ${tone}` }, [
      el('span', { className: `verdict ${tone}`, text: label }),
      el('p', { className: 'claim-text', text: claim.text }),
      claim.reason ? el('p', { className: 'claim-reason', text: claim.reason }) : null,
      claim.correction ? el('p', { className: 'claim-correction' }, [el('strong', { text: 'What the text says: ' }), document.createTextNode(claim.correction)]) : null,
    ]);
  };
  critiquePanel.replaceChildren(...[
    el('h3', { text: 'Critique: every claim read against the law it cites' }),
    el('p', {
      className: 'critique-summary',
      text: `${critique.claims.length} claim${critique.claims.length === 1 ? '' : 's'} read by a second model (${critique.model}): ${supported.length} supported, ${flagged.length} flagged${unchecked.length ? `, ${unchecked.length} not checked` : ''}.${flagged.length ? ' Read the flagged ones with the official text open.' : ''}`,
    }),
    flagged.length ? el('ol', { className: 'claims' }, flagged.map(card)) : null,
    supported.length
      ? el('details', {}, [el('summary', { text: `Supported claims (${supported.length})` }), el('ol', { className: 'claims' }, supported.map(card))])
      : null,
    unchecked.length
      ? el('details', {}, [el('summary', { text: `Not checked (${unchecked.length})` }), el('ol', { className: 'claims' }, unchecked.map(card))])
      : null,
  ].filter(Boolean));
  critiquePanel.hidden = false;
};

const showGrounding = (metadata) => {
  const sources = metadata.sources || [];
  const onlyAbsences = sources.length > 0 && sources.every((source) => source.kind === 'statute-absence');
  const grounded = metadata.groundingStatus === 'grounded' && !onlyAbsences;
  grounding.textContent = grounded ? 'Grounded in the official text' : onlyAbsences ? 'Not found in the official text' : 'Not in the library';
  grounding.className = `badge ${grounded ? 'ok' : 'warn'}`;
  grounding.hidden = false;
};

// ---------------------------------------------------------------- streaming

const readEvents = async (response, onEvent) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        onEvent(event, JSON.parse(data.join('\n')));
      } catch {
        // ignore a malformed event rather than abandon the whole answer
      }
    }
  }
};

const teach = async (text) => {
  const id = ++runId;
  controller?.abort();
  controller = new AbortController();
  voice.reset();
  setBusy(true);
  errorBox.hidden = true;
  grounding.hidden = true;
  answer.classList.remove('placeholder');
  answer.replaceChildren();
  reading.hidden = true;
  answerCheck.hidden = true;
  critiquePanel.hidden = true;
  evidence.replaceChildren(el('p', { className: 'empty', text: 'Finding the official text…' }));
  cases.reset();
  setStatus('Finding the official text…');

  let chatterboxOn = false;
  try {
    const response = await fetch('/lawbuddy/teach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text, stream: true, requestId: `lawbuddy_${Date.now()}_${id}` }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `LawBuddy could not answer (HTTP ${response.status}).`);
    }

    await readEvents(response, (event, data) => {
      if (id !== runId) return;
      if (event === 'metadata') {
        chatterboxOn = Boolean(data.chatterbox?.enabled);
        showGrounding(data);
        showReading(data.analysis);
        renderEvidence(data.sources || [], id, data.analysis);
        // The judgments shown are for the first Article the answer is grounded in.
        // Judgments for each provision the answer relies on: Articles directly; sections of the new codes
        // also through the IPC/CrPC/Evidence Act section they replaced. The most decisive role comes first.
        // A situation question turns on who is liable and where the law reaches; others on what it forbids.
        const ROLE_FIRST = data.analysis?.kind === 'scenario'
          ? ['liability', 'scope', 'forbids', 'limits', 'right', 'allows', 'procedure', 'duty', 'consequence']
          : ['forbids', 'liability', 'limits', 'right', 'allows', 'scope', 'procedure', 'duty', 'consequence'];
        const statutes = (data.sources || []).filter((source) => source.kind === 'statute' && source.label)
          .sort((a, b) => (ROLE_FIRST.indexOf(a.role) + 1 || 99) - (ROLE_FIRST.indexOf(b.role) + 1 || 99));
        const choices = [...new Set(statutes.map((source) => (source.act && source.act !== 'COI' ? `${source.act} ${source.label}` : source.label)))];
        if (choices.length) {
          cases.offer(choices, choices[0]);
          cases.load(choices[0]);
        } else {
          cases.offer([], null);
          cases.reset('Supreme Court judgments appear here for the provisions an answer relies on.');
        }
        setStatus('Teaching…');
      } else if (event === 'token') {
        answer.append(document.createTextNode(data.token));
      } else if (event === 'audio_ready') {
        voice.enqueue({ fileName: data.fileName, text: data.speechText || data.sentence });
        setStatus('Speaking…');
      } else if (event === 'audio_error') {
        voice.enqueue({ text: data.speechText || data.sentence });
      } else if (event === 'done') {
        showCheck(data.check);
        showCritique(data.critique);
      } else if (event === 'speech_done' && !chatterboxOn) {
        setStatus('Checking every claim against the law…');
        for (const sentence of splitSentences(answer.textContent)) voice.enqueue({ text: sentence });
      } else if (event === 'error') {
        showError(data.error || 'LawBuddy could not finish this answer.');
      }
    });
  } catch (error) {
    if (error.name !== 'AbortError' && id === runId) showError(error.message);
  } finally {
    if (id === runId) {
      // Never leave a "Done" with an empty box under a grounding badge.
      if (errorBox.hidden && !answer.textContent.trim() && !controller.signal.aborted) {
        showError('LawBuddy received no explanation this time. Please ask again.');
      }
      setBusy(false);
      if (!voice.playing) setStatus(errorBox.hidden ? 'Done.' : 'Stopped.');
    }
  }
};

// ---------------------------------------------------------------- wiring

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text) return;
  window.history.replaceState(null, '', `/lawbuddy/teach?q=${encodeURIComponent(text)}`);
  teach(text);
});

question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

stopButton.addEventListener('click', () => {
  runId += 1;
  controller?.abort();
  voice.reset();
  setBusy(false);
  stopButton.hidden = true;
  setStatus('Stopped.');
});

voiceToggle.addEventListener('change', () => {
  if (!voiceToggle.checked) {
    voice.reset();
    stopButton.hidden = !streaming;
  }
});

examples.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  question.value = chip.textContent;
  form.requestSubmit();
});

const initial = new URLSearchParams(window.location.search).get('q');
if (initial) {
  question.value = initial;
  teach(initial.trim());
}
