/**
 * Supreme Court of India judgments from the AWS Open Data mirror of the
 * Court's e-SCR records (Dattam Labs, CC-BY-4.0; tier 1).
 *
 * Layout: metadata/tar/year=YYYY/metadata.tar holds one JSON record per
 * judgment (the Court's listing row as HTML), and each judgment's English PDF
 * is at data/pdf/year=YYYY/english/<path>_EN.pdf. A year is imported from its
 * archive in one pass; the archive's sha256 is recorded only once every record
 * is stored, so an interrupted import is redone rather than mistaken for done.
 */

import fs from 'node:fs/promises';
import { readTar } from '../parse/tar.js';
import { parseScMetadata } from '../parse/scMetadata.js';
import { parseCitation } from '../parse/citationParser.js';

export const SC_BUCKET = 'https://indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com';
export const SC_LISTING_URL = `${SC_BUCKET}/?list-type=2&prefix=metadata/tar/&max-keys=1000`;
export const scMetadataTarUrl = (year) => `${SC_BUCKET}/metadata/tar/year=${year}/metadata.tar`;
export const scMetadataJsonUrl = (year, key) => `${SC_BUCKET}/metadata/json/year=${year}/${key}.json`;
export const scPdfUrl = (year, key) => `${SC_BUCKET}/data/pdf/year=${year}/english/${key}_EN.pdf`;

/**
 * The SCR citation a dataset key encodes: "2017_10_569_999" (year, volume, first and last page) is
 * "[2017] 10 SCR 569"; "S_1976_1_172_477", a supplementary volume, is "[1976] Supp. 1 SCR 172".
 */
export const scrCitationFromKey = (key) => {
  const match = /^(S_)?(\d{4})_(\d{1,2})_(\d{1,4})_/.exec(String(key || ''));
  if (!match) return null;
  const [, supp, year, volume, page] = match;
  return `[${year}] ${supp ? 'Supp. ' : ''}${Number(volume)} SCR ${Number(page)}`;
};

/** The years the bucket has a metadata archive for, ascending. */
export const listScYears = async ({ fetcher, readFile = fs.readFile }) => {
  const listing = await fetcher.fetchDocument(SC_LISTING_URL);
  if (!listing.ok) throw new Error(`Could not list the Supreme Court dataset: ${listing.error || `HTTP ${listing.status}`}`);
  const xml = await readFile(listing.rawPath, 'utf8');
  return [...new Set([...xml.matchAll(/<Key>metadata\/tar\/year=(\d{4})\/metadata\.tar<\/Key>/g)].map(([, year]) => Number(year)))]
    .sort((a, b) => a - b);
};

/**
 * Imports one year's judgment records. `knownArticles` (labels such as "Art.21") filters headnote
 * catchwords to Articles that exist in the official text, so OCR noise ("Art. 2l") never links.
 */
export const syncScYear = async ({ store, fetcher, year, knownArticles, force = false, readFile = fs.readFile }) => {
  const url = scMetadataTarUrl(year);
  const fetched = await fetcher.fetchDocument(url);
  // A dropped connection must not stop a re-parse: the archive fetched earlier is in the vault.
  const stored = fetched.ok ? null : store.latestDocument(url);
  const archive = fetched.ok ? fetched : stored && { ok: true, sha256: stored.sha256, rawPath: stored.raw_path, fromVault: true };
  if (!archive) return { year, ok: false, error: fetched.error || `HTTP ${fetched.status}` };

  const previous = store.getScImport(year);
  if (!force && previous?.archive_sha256 === archive.sha256) {
    return { year, ok: true, skipped: true, cases: previous.cases };
  }

  const summary = { year, ok: true, skipped: false, records: 0, cases: 0, unparsed: 0, linked: 0, aliasConflicts: 0 };
  for (const entry of readTar(await readFile(archive.rawPath))) {
    if (!entry.name.endsWith('.json')) continue;
    summary.records += 1;

    let parsed;
    try {
      parsed = parseScMetadata(JSON.parse(entry.data.toString('utf8')));
    } catch {
      parsed = null;
    }
    if (!parsed?.key) {
      summary.unparsed += 1;
      continue;
    }

    // Articles that exist in the official text, and the sections of the criminal codes the catchwords cite.
    const provisions = [...parsed.articles.filter((article) => knownArticles.has(article.label)), ...(parsed.codeSections || [])];
    const caseId = store.upsertScCase({
      key: parsed.key,
      sourceUrl: scMetadataJsonUrl(year, parsed.key),
      pdfUrl: scPdfUrl(year, parsed.key),
      title: parsed.title,
      decidedOn: parsed.decidedOn,
      benchStrength: parsed.benchStrength,
      caseNo: parsed.caseNo,
      disposal: parsed.disposal,
      coram: parsed.coram,
      author: parsed.author,
      headnote: parsed.headnote,
      cnr: parsed.cnr,
      provisions,
    });
    summary.cases += 1;
    if (provisions.length) summary.linked += 1;

    const fromKey = scrCitationFromKey(parsed.key);
    const printed = [parsed.neutral, parsed.scr].map((text) => (text ? parseCitation(text) : null)).filter(Boolean);
    if (fromKey && !printed.some((citation) => citation.normalized === fromKey)) printed.push({ scheme: 'SCR', normalized: fromKey });
    for (const citation of printed) {
      try {
        store.addCitationAlias(caseId, { scheme: citation.scheme, normalized: citation.normalized });
      } catch {
        summary.aliasConflicts += 1; // the dataset lists one citation under two records; keep the first
      }
    }
  }

  store.saveScImport({ year, archiveSha256: archive.sha256, records: summary.records, cases: summary.cases });
  return summary;
};
