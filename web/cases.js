// Supreme Court judgments for the Article being taught: the precedent points table (top right)
// and judgment cards with the official headnote and a brief whose every point quotes the
// judgment. Untrusted text is only ever set through textContent.
import { el, fetchJson, formatDate, hostOf, humanLabel, safeLink } from './common.js';

const SMALL_WORDS = new Set(['of', 'and', 'the', 'versus', 'v', 'vs', 'in', 'for', 'to', 'by', 'on', 'at', 'an', 'a', 'or']);
const SECTION_TITLES = { facts: 'Facts', issues: 'Legal issues', held: 'Held', reasoning: 'Reasoning' };

/** "STATE OF BIHAR versus DEOKARAN NENSHI" → "State of Bihar versus Deokaran Nenshi"; initials ("M.C.") stay. */
export const titleCase = (title) =>
  String(title || '').replace(/^[^A-Za-z0-9(]+/, '').toLowerCase().split(/(\s+)/).map((word, index) => {
    if (/^\s+$/.test(word) || (index > 0 && SMALL_WORDS.has(word))) return word;
    if (/^([a-z]\.)+[a-z]?\.?$/.test(word)) return word.toUpperCase();
    return word.replace(/^([("'[]*)([a-z])/, (_, lead, letter) => `${lead}${letter.toUpperCase()}`);
  }).join('');

const year = (iso) => (iso ? iso.slice(0, 4) : '—');
const STATUS = {
  overruled: { className: 'overruled', chip: 'Overruled', heading: 'Overruled by a later judgment' },
  caution: { className: 'caution', chip: 'Caution', heading: 'Partly overruled or held per incuriam by a later judgment' },
};
const QUESTIONED = { className: 'caution', heading: 'Questioned in a later judgment' };
const pageLink = (url, page) => (url && page ? `${url}#page=${page}` : url);
const benchText = (bench) => (bench ? `, ${bench}-judge bench` : '');
const reviewLabel = ({ count, average }) =>
  (count ? `${Number(average).toFixed(1)}★ (${count})` : 'none yet');

export const createCasesView = ({ pointsTable, pointsBody, pointsEmpty, pointsTitle, pointsChoices, casesSection, casesList, casesTitle, casesNote }) => {
  let current = 0;

  const reset = (message) => {
    current += 1;
    pointsTitle.textContent = 'Precedent points';
    pointsTable.hidden = true;
    pointsBody.replaceChildren();
    pointsEmpty.hidden = false;
    pointsEmpty.textContent = message || 'Ask about an Article of the Constitution to see the Supreme Court judgments on it, ranked by points from the official record.';
    casesSection.hidden = true;
    casesList.replaceChildren();
  };

  const briefView = (brief) => {
    const sections = Object.entries(SECTION_TITLES)
      .filter(([key]) => brief[key]?.length)
      .map(([key, heading]) => el('section', { className: 'brief-section' }, [
        el('h4', { text: heading }),
        el('ol', {}, brief[key].map((item) => el('li', {}, [
          el('p', { text: item.point }),
          el('blockquote', { text: `“${item.quote}”` }),
          el('span', { className: 'brief-cite', text: `${item.opinion || 'Judgment'} · PDF page ${item.page}${item.exact ? '' : ' · matched through OCR errors'}` }),
        ]))),
      ]));
    return el('div', { className: 'brief' }, [
      el('p', { className: 'brief-badge', text: `AI-structured from the judgment. Every quote is checked against the judgment's own text, holdings come only from the leading opinion or the official headnote, and dates in a point must appear in its quote (${brief.kept} points kept, ${brief.dropped} dropped).${brief.guidance?.quotedPassages ? ` ${brief.guidance.quotedPassages} of the passages read were chosen because later judgments quote them.` : ''} Not reviewed by a lawyer: read the quotes.` }),
      ...sections,
    ]);
  };

  const briefSlot = (card, label, run) => {
    const slot = el('div', { className: 'brief-slot' });
    if (card.brief) {
      slot.append(briefView(card.brief));
      return { slot, prepare: null };
    }
    const button = el('button', { className: 'button ghost', text: 'Prepare facts, issues and holding', attrs: { type: 'button' } });
    const status = el('p', { className: 'status' });
    const prepare = async () => {
      button.disabled = true;
      status.textContent = 'Reading the judgment and checking every quote… this can take a minute.';
      const params = new URLSearchParams(label ? { label } : {});
      const { ok, body } = await fetchJson(`/lawbuddy/api/cases/${card.id}/brief?${params}`, { method: 'POST' })
        .catch(() => ({ ok: false, body: {} }));
      if (run !== current) return;
      if (ok && body.ok) {
        slot.replaceChildren(briefView(body));
      } else {
        button.disabled = false;
        status.textContent = body.error || 'The brief could not be prepared right now.';
      }
    };
    button.addEventListener('click', prepare);
    slot.append(button, status);
    return { slot, prepare };
  };

  /** "Overruled by …": the reporter's label in each later judgment, linked to the page it is printed on. */
  const statusView = (card) => {
    const status = STATUS[card.status];
    const treatments = card.citedBy?.treatments || [];
    if (!status && !treatments.length) return null;
    const view = status || QUESTIONED;
    return el('div', { className: `case-status ${view.className}` }, [
      el('h4', { text: view.heading }),
      el('ul', {}, treatments.map((item) => el('li', {}, [
        document.createTextNode(`${item.treatment} in `),
        safeLink(pageLink(item.pdfUrl, item.page), `${titleCase(item.title)} (${year(item.decidedOn)}${benchText(item.benchStrength)})`),
        document.createTextNode(item.binding
          ? `: "${item.printed}" in that report's list of cases cited${item.page ? `, PDF page ${item.page}` : ''}.`
          : `: "${item.printed}" in that report, but a smaller bench cannot overrule a larger one, so LawBuddy does not treat it as overruled.`),
      ]))),
    ]);
  };

  /** Every citing judgment, loaded on request: title, year, and the reporter's treatment where listed. */
  const allCitingButton = (card, run) => {
    const button = el('button', { className: 'button ghost', text: `List all ${card.citedBy.count} citing judgments`, attrs: { type: 'button' } });
    const list = el('ol', { className: 'citing-list' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      const { ok, body } = await fetchJson(`/lawbuddy/api/cases/${card.id}/cited-by`).catch(() => ({ ok: false, body: {} }));
      if (run !== current) return;
      if (!ok || !body.ok) {
        button.disabled = false;
        button.textContent = 'Could not load the list. Try again';
        return;
      }
      button.remove();
      list.replaceChildren(...body.citing.map((item) => el('li', {}, [
        safeLink(pageLink(item.pdfUrl, item.contextPage || item.page), `${titleCase(item.title)} (${year(item.decidedOn)})`),
        document.createTextNode(item.treatment ? ` · ${item.treatment}` : ''),
      ])));
    });
    return [button, list];
  };

  /** How later judgments put this one, in their own words (the sentence that cites it). */
  const citedView = (card, run) => {
    if (!card.citedBy?.count) return null;
    const contexts = card.citedBy.contexts || [];
    return el('details', { className: 'case-cited' }, [
      el('summary', { text: `How later judgments cite it (${card.citedBy.count} in the full-text index)` }),
      ...contexts.map((item) => el('figure', {}, [
        el('blockquote', { text: item.context }),
        el('figcaption', {}, [
          safeLink(pageLink(item.pdfUrl, item.page), `${titleCase(item.title)} (${year(item.decidedOn)})`),
          document.createTextNode(`${item.page ? ` · PDF page ${item.page}` : ''}${item.treatment ? ` · reporter: ${item.treatment}` : ''}`),
        ]),
      ])),
      ...allCitingButton(card, run),
    ]);
  };

  const caseCard = (card, label, run) => {
    const { slot, prepare } = briefSlot(card, card.via || label, run);
    const facts = [
      card.decidedOn ? el('li', { text: `Decided ${formatDate(card.decidedOn)}` }) : null,
      card.benchStrength ? el('li', { className: card.constitutionBench ? 'ok' : '', text: `${card.benchStrength}-judge bench${card.constitutionBench ? ' · Constitution Bench' : ''}` }) : null,
      card.citedBy?.count ? el('li', { text: `Cited in ${card.citedBy.count} later judgment${card.citedBy.count === 1 ? '' : 's'}` }) : null,
      ...card.citations.map((citation) => el('li', { className: 'info', text: citation })),
    ];
    const article = el('article', { className: 'case-card' }, [
      el('div', { className: 'case-head' }, [
        el('h3', { text: titleCase(card.title) }),
        el('span', { className: 'points-badge', text: `${card.points} pts` }),
      ]),
      card.viaNote ? el('p', { className: 'case-via', text: card.viaNote })
        : card.via ? el('p', { className: 'case-via', text: `Interprets ${humanLabel(card.via)}, closely related to ${humanLabel(label)}` }) : null,
      statusView(card),
      el('ul', { className: 'facts' }, facts),
      // The record's "author" mark is not reliably the leading opinion (Maneka Gandhi: Untwalia J, not Bhagwati J),
      // so it is not shown; the brief names the opinion each quote comes from instead.
      card.coram?.length ? el('p', { className: 'case-coram', text: `Coram: ${card.coram.map(titleCase).join(', ')}` }) : null,
      el('details', { className: 'case-why' }, [
        el('summary', { text: 'Why these points' }),
        el('ul', {}, card.breakdown.map((item) => el('li', { text: `+${item.points} · ${item.reason}` }))),
      ]),
      citedView(card, run),
      card.headnote ? el('details', { className: 'case-headnote' }, [
        el('summary', { text: 'Official headnote (Supreme Court Reports)' }),
        el('p', { text: card.headnote }),
      ]) : null,
      slot,
      el('p', { className: 'case-reviews', text: `Verified reviews: ${reviewLabel(card.reviews)}` }),
      ...(card.reviews.items || []).map((review) => el('blockquote', { className: 'case-review', text: `${review.rating}★ “${review.comment}” — ${review.reviewer_name}, ${review.reviewer_credential}` })),
      el('footer', { className: 'provenance' }, [
        safeLink(card.pdfUrl, 'Judgment (PDF)'),
        document.createTextNode(' · '),
        safeLink(card.sourceUrl, 'Court record'),
        document.createTextNode(` · ${hostOf(card.pdfUrl) ? 'Supreme Court of India via AWS Open Data (CC-BY-4.0)' : ''}`),
      ]),
    ]);
    return { article, prepare };
  };

  const pointsRow = (card, rank, onSelect) => {
    const status = STATUS[card.status];
    const row = el('tr', {}, [
      el('td', { text: String(rank) }),
      el('td', {}, [
        el('button', { className: 'points-case', text: titleCase(card.title), attrs: { type: 'button', title: card.citations.join(' · ') } }),
        status ? el('span', { className: `status-chip ${status.className}`, text: status.chip }) : null,
      ]),
      el('td', { text: year(card.decidedOn) }),
      el('td', { text: card.benchStrength ? String(card.benchStrength) : '—' }),
      el('td', { text: String(card.citedBy?.count ?? 0) }),
      el('td', { className: 'points-value', text: String(card.points) }),
      el('td', { text: reviewLabel(card.reviews) }),
    ]);
    row.querySelector('.points-case').addEventListener('click', onSelect);
    return row;
  };

  const load = async (label) => {
    reset('Finding the Supreme Court judgments…');
    const run = current;
    const { ok, body } = await fetchJson(`/lawbuddy/api/cases?provision=${encodeURIComponent(label)}&limit=6`)
      .catch(() => ({ ok: false, body: {} }));
    if (run !== current) return;
    if (!ok || !body.ok) {
      reset(body.error || 'The judgments could not be loaded.');
      return;
    }

    const human = humanLabel(label);
    pointsTitle.textContent = `Precedent points · ${human}`;
    if (!body.cases.length) {
      reset(`No Supreme Court judgment in the library is indexed to ${human} or the provisions around it yet (${body.library.cases.toLocaleString('en-IN')} judgments indexed).`);
      pointsTitle.textContent = `Precedent points · ${human}`;
      return;
    }

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    casesTitle.textContent = {
      direct: `Supreme Court judgments on ${human}`,
      text: `Supreme Court judgments discussing ${human}`,
      predecessor: `How the Supreme Court has read ${human}, through the section it replaced`,
    }[body.relation] || `Judgments on provisions closely related to ${human}`;
    const carried = (body.predecessors || []).map((item) => `${item.old} → ${item.carriedAs}${item.changed ? ' (reworded)' : ''}`).join('; ');
    const relationNote = {
      direct: `${plural(body.total, 'indexed judgment')} name ${human} in the official headnote${carried ? ` or the section it replaced (${carried})` : ''}; showing the top ${body.cases.length} by points.`,
      predecessor: `${human} is new law (in force from 1 July 2024), so the Supreme Court's reading of it is in judgments on the section it carries forward: ${carried}. ${plural(body.total, 'indexed judgment')} name that section in the official headnote; showing the top ${body.cases.length} by points. Where the wording changed, check the new text before relying on an old judgment.`,
      none: `No indexed judgment's headnote names ${human}${carried ? ` or the section it replaced (${carried})` : ''} yet.`,
      text: `No official headnote names ${human}, but ${plural(body.total, 'judgment')} in the full-text index discuss${body.total === 1 ? 'es' : ''} it in the text; showing the top ${body.cases.length} by points.`,
    }[body.relation] || `No indexed judgment's headnote names ${human} itself. These interpret ${body.relatedLabels.slice(0, 6).map(humanLabel).join(', ')}, which ${human} cross-references or sits beside.`;
    const index = body.library.textIndex;
    const coverage = index?.judgments
      ? ` Citation counts cover the ${index.judgments.toLocaleString('en-IN')} judgments whose full text is indexed so far (decided ${year(index.earliest)}–${year(index.latest)}).`
      : ' The full-text citation index is empty, so no citation counts yet.';
    casesNote.textContent = `${relationNote}${coverage}`;

    const cards = body.cases.map((card) => caseCard(card, label, run));
    casesList.replaceChildren(...cards.map(({ article }) => article));
    casesSection.hidden = false;

    pointsBody.replaceChildren(...body.cases.map((card, index) => pointsRow(card, index + 1, () => {
      cards[index].article.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })));
    pointsEmpty.hidden = true;
    pointsTable.hidden = false;

    // The leading judgment's brief is prepared straight away; the rest on request.
    cards[0].prepare?.();
  };

  /** Buttons to switch the judgments shown between the provisions an answer relies on. */
  const offer = (labels, active) => {
    pointsChoices.replaceChildren(...labels.map((label) => {
      const button = el('button', { className: `chip${label === active ? ' active' : ''}`, text: humanLabel(label), attrs: { type: 'button', 'aria-pressed': String(label === active) } });
      button.addEventListener('click', () => {
        offer(labels, label);
        load(label);
      });
      return button;
    }));
    pointsChoices.hidden = labels.length < 2;
  };

  return { load, reset, offer };
};
