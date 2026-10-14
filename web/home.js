// LawBuddy home: shows what the verified library holds, from /lawbuddy/api/health.
import { el, fetchJson, hostOf, safeLink } from './common.js';

const library = document.getElementById('library');

const actCard = (act) =>
  el('div', { className: 'card' }, [
    el('span', { className: 'tag ok', text: 'Official text · verified' }),
    el('h3', { text: act.title }),
    el('p', {}, [el('span', { className: 'stat', text: act.provisions.toLocaleString('en-IN') }), document.createTextNode(' provisions')]),
    act.sourceUrl ? el('p', {}, [document.createTextNode('Source: '), safeLink(act.sourceUrl, hostOf(act.sourceUrl) || 'official source')]) : null,
    act.sha256 ? el('p', { className: 'mono', text: `Fingerprint ${act.sha256.slice(0, 16)}…` }) : null,
  ]);

const tableCard = (table) =>
  el('div', { className: 'card' }, [
    el('span', { className: 'tag info', text: 'Official correspondence table' }),
    el('h3', { text: table.table }),
    el('p', {}, [el('span', { className: 'stat', text: table.rows.toLocaleString('en-IN') }), document.createTextNode(' mapped rows')]),
    table.sourceUrl ? el('p', {}, [document.createTextNode('Source: '), safeLink(table.sourceUrl, hostOf(table.sourceUrl))]) : null,
  ]);

const comingCard = () =>
  el('div', { className: 'card' }, [
    el('span', { className: 'tag warn', text: 'Coming next' }),
    el('h3', { text: 'New criminal laws' }),
    el('p', { text: 'BNS, BNSS and BSA with the official MHA/NCRB old↔new section tables (IPC 302 → BNS 103).' }),
  ]);

const render = async () => {
  const { ok, body } = await fetchJson('/lawbuddy/api/health').catch(() => ({ ok: false, body: {} }));
  if (!ok || !body.library) {
    library.replaceChildren(
      el('p', { className: 'empty', text: 'The legal library is not installed on this server yet.' }),
    );
    return;
  }
  const { acts = [], correspondence = [] } = body.library;
  library.replaceChildren(
    ...acts.map(actCard),
    ...correspondence.map(tableCard),
    ...(correspondence.length ? [] : [comingCard()]),
  );
};

render();
