import { CONSTITUTION_ACT } from '../ingest/constitution.js';
import { syncScYear } from '../sources/scOpenData.js';
import { extractPdfText } from '../extract/pdfText.js';
import { toPassages } from '../cases/brief.js';
import { verifyCaseCitation } from '../cases/citationVerify.js';

const normal = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text, phrase) => (` ${normal(text)} `).includes(` ${normal(phrase)} `);
const courtName = (court) => court === 'SC' ? 'Supreme Court of India' : court;
const publicCandidate = (row) => ({ id: row.id, title: row.title, court: courtName(row.court),
  decidedOn: row.decided_on, caseNo: row.case_no, citations: row.aliases || [], officialUrl: row.pdf_url || row.source_url });
const refreshes = new WeakMap();
const compact = (value) => normal(value).replace(/ /g, '');
export const checkRetrievedIdentity = (row, text) => {
  const header = text.split(/\s+/).slice(0, 1600).join(' ');
  const flat = compact(header);
  const parties = row.title.split(/\s+(?:versus|vs?\.?)\s+/i).map((p) => p.replace(/\b(?:etc|and others|and another|anr|ors)\.?/gi, '').trim());
  const partiesMatch = parties.length === 2 && parties.every((p) => compact(p).length > 3 && flat.includes(compact(p)));
  const identifiers = [...(row.aliases || []), row.case_no].filter(Boolean);
  const identifier = identifiers.find((id) => flat.includes(compact(id)));
  const date = row.decided_on;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !Number.isNaN(Date.parse(date));
  let dateMatch = false;
  if (valid) {
    const [y, m, d] = date.split('-');
    const month = ['january','february','march','april','may','june','july','august','september','october','november','december'][Number(m)-1];
    dateMatch = header.includes(date) || new RegExp(`\\b(?:${month}\\s+0?${Number(d)}[,\\s]+${y}|0?${Number(d)}\\s+${month}[,\\s]+${y})\\b`, 'i').test(header);
  }
  return { proceed: Boolean(partiesMatch && identifier && dateMatch), partiesMatch, identifier: identifier || null, dateMatch,
    method: 'Catalogue parties, citation/case number and decision date matched against extracted PDF header; court from collection metadata.' };
};

// Share one metadata refresh per store/year. Never launch a full corpus import for a report.
const refreshYear = async (store, fetcher, year, syncYear) => {
  if (!refreshes.has(store)) refreshes.set(store, new Map());
  const pending = refreshes.get(store);
  const actId = store.findAct?.(CONSTITUTION_ACT);
  if (!pending.has(year)) pending.set(year, syncYear({ store, fetcher, year: Number(year), knownArticles: new Set(actId ? store.currentProvisions(actId).map((p) => p.label) : []) })
    .finally(() => pending.delete(year)));
  return pending.get(year);
};

export const discoverReportCase = async ({ store, task, input, fetcher, extract = extractPdfText, syncYear = syncScYear }) => {
  const log = [];
  const search = () => {
    const fromCitation = (task.citations || []).map((citation) => verifyCaseCitation(store, citation))
      .filter((item) => item.verified).map((item) => store.getCase(item.case.id)).filter(Boolean);
    const fromNames = task.partyA && task.partyB ? store.reportCaseCandidates({ partyA: task.partyA, partyB: task.partyB, year: task.year }) : [];
    return [...new Map([...fromCitation, ...fromNames].map((row) => [row.id, row])).values()]
      .filter((row) => (!task.partyA || contains(row.title, task.partyA)) && (!task.partyB || contains(row.title, task.partyB))
        && (!task.year || row.decided_on?.startsWith(task.year)) && (!task.court || normal(courtName(row.court)) === normal(courtName(task.court))))
      .map((row) => ({ ...row, aliases: (row.aliases || []).map((a) => typeof a === 'string' ? a : a.normalized) }));
  };
  let candidates = search();
  log.push({ action: 'search-library', matches: candidates.length });
  if (!candidates.length && task.year && fetcher && Number(task.year) >= 1950 && Number(task.year) <= new Date().getFullYear()) {
    try {
      const refreshed = await refreshYear(store, fetcher, task.year, syncYear);
      log.push({ action: 'refresh-court-metadata', year: task.year, ok: refreshed.ok, error: refreshed.error });
      candidates = search();
    } catch (error) { log.push({ action: 'refresh-court-metadata', ok: false, error: error.message }); }
  }
  const selected = input.selectedCaseId ? candidates.find((c) => String(c.id) === String(input.selectedCaseId))
    : candidates.length === 1 ? candidates[0] : null;
  if (!selected) return { status: candidates.length ? 'choose-case' : 'research-incomplete', candidates: candidates.map(publicCandidate), log,
    message: candidates.length ? 'Several judgments match this request. Choose the intended case; LawBuddy will retrieve and read it.'
      : 'Automatic research did not locate a matching judgment in the available Supreme Court collection. Try a fuller case name or describe the dispute. Court details and judgment uploads are optional.' };
  if (!fetcher || !selected.pdf_url) return { status: 'research-incomplete', candidates: candidates.map(publicCandidate), log,
    message: 'The case was located, but its judgment download is unavailable. Please retry when the source is reachable.' };
  try {
    const cached = store.latestDocument(selected.pdf_url);
    const document = cached?.raw_path ? { rawPath: cached.raw_path, sha256: cached.sha256 } : await fetcher.fetchDocument(selected.pdf_url);
    if (!document.rawPath) throw new Error(document.error || `Source returned HTTP ${document.status}`);
    const pages = await extract(document.rawPath);
    const text = pages.map((page) => page.lines.map((line) => typeof line === 'string' ? line : line.text).join('\n')).join('\n\n');
    const passages = toPassages(pages);
    if (!text.trim() || !passages.length) throw new Error('The judgment PDF has no readable text.');
    const pdfIdentity = checkRetrievedIdentity(selected, text);
    if (!pdfIdentity.proceed) throw new Error('Catalogue identity could not be matched to the extracted PDF header.');
    log.push({ action: 'read-judgment', url: selected.pdf_url, sha256: document.sha256, pages: pages.length, cached: Boolean(cached) });
    return { status: 'located', log, pdfIdentity, text, paragraphs: passages.map((p) => ({ para: p.id, text: p.text })),
      identity: { caption: selected.title, court: courtName(selected.court), decisionDate: selected.decided_on,
        caseNo: selected.case_no || '', citation: selected.aliases[0] || '' },
      citations: selected.aliases, url: selected.pdf_url, authority: 'court-record-mirror', anchor: 'PDF page and passage (pN.M); not court paragraph numbers' };
  } catch (error) {
    log.push({ action: 'read-judgment', ok: false, error: error.message });
    return { status: 'research-incomplete', candidates: candidates.map(publicCandidate), log,
      message: 'The case was located, but LawBuddy could not read its judgment. Retry research; no legal findings have been invented.' };
  }
};
