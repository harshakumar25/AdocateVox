// LawBuddy home: shows what the verified library holds, from /lawbuddy/api/health.
import { el, fetchJson, hostOf, safeLink } from './common.js';

const library = document.getElementById('library');
const catalogForm = document.getElementById('catalog-form');
const catalogQuery = document.getElementById('catalog-query');
const catalogTopic = document.getElementById('catalog-topic');
const catalogStatus = document.getElementById('catalog-status');
const catalogResults = document.getElementById('catalog-results');
const catalogMore = document.getElementById('catalog-more');
let catalogGeneration = 0;
let catalogItems = [];
let catalogNotice = null;
let catalogVisible = 12;
let catalogAsOf = null;

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
    el('span', { className: `tag ${table.method === 'official' ? 'info' : 'warn'}`, text: table.method === 'official' ? 'Official correspondence table' : table.method === 'alignment' ? 'LawBuddy text alignment' : 'Correspondence source needs review' }),
    el('h3', { text: table.table }),
    el('p', {}, [el('span', { className: 'stat', text: table.rows.toLocaleString('en-IN') }), document.createTextNode(' mapped rows')]),
    table.sourceUrl ? el('p', {}, [document.createTextNode(table.method === 'alignment' ? 'Compared copy: ' : 'Source: '), safeLink(table.sourceUrl, hostOf(table.sourceUrl))]) : null,
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
  );
};

render();

const catalogCard = (item) => el('article', { className: 'card' }, [
  el('span', { className: `tag ${item.status === 'indexed-as-of' ? 'ok' : 'warn'}`, text: item.status === 'indexed-as-of'
    ? `${item.indexedSections} provisions indexed as of ${catalogAsOf}`
    : item.status === 'indexed-historical'
      ? `${item.historicalIndexedSections} provisions reviewed through ${item.reviewedThrough} · current text not verified`
      : item.rag?.chunks ? 'Source text searchable · provision review pending' : 'Official source identified · text not indexed' }),
  el('h3', { text: item.title }),
  item.rag?.chunks ? el('p', { text: `${item.rag.chunks} full-text RAG passages · source snapshot, legal currency not reviewed` }) : null,
  el('p', { text: `${item.instrumentType}${item.actNumber ? ` · ${item.actNumber}` : ''}${item.parentId ? ` · under ${item.parentId}` : ''} · ${item.topics.map((topic) => topic.replace(/-/g, ' ')).join(' · ')}` }),
  item.note ? el('p', { className: 'research-caution', text: item.note }) : null,
  el('p', {}, [safeLink(item.indexedSourceUrl || item.historicalSourceUrl || item.sourceUrl, item.status === 'source-identified' ? 'Open official source' : 'Open reviewed source')]),
].filter(Boolean));

const showCatalog = () => {
  const shown = catalogItems.slice(0, catalogVisible);
  catalogStatus.textContent = catalogNotice || `${catalogItems.length} instrument${catalogItems.length === 1 ? '' : 's'} matched · ${shown.length} shown. “Source identified” means provision text is not yet available for LawBuddy answers.`;
  catalogResults.replaceChildren(...(shown.length ? shown.map(catalogCard) : [el('p', { className: 'empty', text: 'No Indian instrument matched. Try a precise title or another practice area.' })]));
  catalogMore.hidden = shown.length >= catalogItems.length;
};

const loadCatalog = async () => {
  const generation = ++catalogGeneration;
  const params = new URLSearchParams({ q: catalogQuery.value.trim(), topic: catalogTopic.value });
  catalogStatus.textContent = 'Checking the instrument index…';
  const { ok, body } = await fetchJson(`/lawbuddy/api/catalog?${params}`).catch(() => ({ ok: false, body: {} }));
  if (generation !== catalogGeneration) return;
  if (!ok || !body.ok) {
    catalogStatus.textContent = body.error || 'The instrument index could not be loaded.';
    catalogResults.replaceChildren();
    catalogMore.hidden = true;
    return;
  }
  catalogItems = body.items;
  catalogNotice = body.foreignNotice;
  catalogAsOf = body.asOf;
  catalogVisible = 12;
  showCatalog();
};

catalogForm.addEventListener('submit', (event) => { event.preventDefault(); loadCatalog(); });
catalogTopic.addEventListener('change', loadCatalog);
catalogMore.addEventListener('click', () => { catalogVisible += 12; showCatalog(); });
loadCatalog();

const ragForm = document.getElementById('rag-form');
let ragRequest = 0;
ragForm?.addEventListener('submit', async (event) => {
  event.preventDefault(); const sequence = ++ragRequest;
  const output = document.getElementById('rag-results');
  output.textContent = 'Searching indexed source text…';
  try {
    const params = new URLSearchParams({q: document.getElementById('rag-query').value,topic: catalogTopic.value});
    const {ok,body} = await fetchJson(`/lawbuddy/api/rag/search?${params}`);
    if (sequence !== ragRequest) return;
    if (!ok) throw new Error('Source search failed.');
    output.replaceChildren(...(body.items.length ? body.items.map((hit) => el('article',{className:'card'},[
      el('h3',{text:hit.title}),el('p',{text:hit.citation}),el('p',{text:hit.text}),
      el('p',{className:'research-caution',text:hit.legalCurrency}), safeLink(hit.url,'Open source PDF'),
    ])) : [el('p',{text:'No indexed passage matched. Source-only entries and unavailable documents are not search evidence.'})]));
  } catch(error) {if(sequence === ragRequest) output.textContent=error.message;}
});
