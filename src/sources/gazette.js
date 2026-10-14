/**
 * Gazette of India identifiers and mirror provenance.
 *
 * Every Gazette of India issue carries an ID such as "CG-DL-E-25122023-250883"
 * (Central Government, printed at Delhi, Extraordinary, 25-12-2023, number
 * 250883), and e-Gazette serves it at /WriteReadData/2023/250883.pdf. An
 * unofficial copy that prints such an ID can therefore be traced to the
 * official file: the official copy is fetched (tier 0), must itself carry the
 * same ID, and the two are compared byte for byte. The ID comes from untrusted
 * text, so only its digits are used, and only to build an e-Gazette URL.
 */

import { config } from '../config.js';
import { extractPdfText } from '../extract/pdfText.js';
import { vaultPath } from './vault.js';

const GAZETTE_ID = /CG-[A-Z]{2}-[EW]-(\d{2})(\d{2})(\d{4})-(\d{5,7})/g;
// The masthead is on the first page; later pages can cite other Gazettes.
const MASTHEAD_PAGES = 2;
const MAX_IDS = 2;

/** Gazette IDs in `text`, de-duplicated, each with the e-Gazette URL of its PDF. */
export const gazetteIdsIn = (text) => {
  const found = new Map();
  for (const [id, day, month, year, number] of String(text || '').matchAll(GAZETTE_ID)) {
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day)) continue;
    if (!found.has(id)) {
      found.set(id, { id, date: `${year}-${month}-${day}`, url: `https://egazette.gov.in/WriteReadData/${year}/${number}.pdf` });
    }
  }
  return [...found.values()];
};

const mastheadText = (pages) =>
  pages.slice(0, MASTHEAD_PAGES).map((page) => page.lines.map((line) => line.text).join('\n')).join('\n');

/**
 * Returns `resolve({ url, sha256 })` for a stored copy: finds the Gazette IDs on its masthead,
 * fetches each official file, and records whether the copy is byte-identical to it.
 * Resolves to a one-line summary, or null when the copy prints no Gazette ID.
 */
export const createProvenanceResolver = ({ store, fetcher, vaultDir = config.LEGAL_RAW_DIR, extract = extractPdfText, now = Date.now }) =>
  async ({ url, sha256 }) => {
    const ids = gazetteIdsIn(mastheadText(await extract(vaultPath(vaultDir, sha256)))).slice(0, MAX_IDS);
    if (!ids.length) return null;

    const notes = [];
    for (const gazette of ids) {
      const official = await fetcher.fetchDocument(gazette.url);
      if (!official.ok) {
        notes.push(`official Gazette ${gazette.id} could not be fetched (${official.error || `HTTP ${official.status}`})`);
        continue;
      }
      // The official file must name itself: a mismatch means our ID-to-URL mapping is wrong.
      const officialIds = gazetteIdsIn(mastheadText(await extract(official.rawPath))).map((entry) => entry.id);
      if (!officialIds.includes(gazette.id)) {
        notes.push(`the file at ${gazette.url} does not carry Gazette ID ${gazette.id}; not linked`);
        continue;
      }
      const relation = official.sha256 === sha256 ? 'identical' : 'different';
      store.saveProvenance({
        copyUrl: url, copySha256: sha256, gazetteId: gazette.id, officialUrl: gazette.url,
        officialSha256: official.sha256, relation, checkedAt: new Date(now()).toISOString(),
      });
      notes.push(relation === 'identical'
        ? `byte-identical to the official Gazette ${gazette.id}`
        : `differs from the official Gazette ${gazette.id} (official copy now stored)`);
    }
    return notes.join('; ');
  };

/** The resolver as a change-event hook: new or changed PDFs only. */
export const provenanceHook = (resolve) => async (event) => {
  if (!['discovered', 'changed'].includes(event.kind) || !event.new_sha256 || !/\.pdf$/i.test(new URL(event.url).pathname)) return null;
  try {
    return await resolve({ url: event.url, sha256: event.new_sha256 });
  } catch (error) {
    return `provenance not resolved: ${error.message}`;
  }
};
