/**
 * "Is my bare act current?" as a service. Compares a copy of an Act with the
 * official text in the library, stores the report and returns a verdict.
 * The copy itself is never used as evidence.
 *
 * - checkCopy: a stored copy (a watched mirror's PDF, or a manually imported file), by URL.
 * - checkUploadedCopy: a PDF a person uploads. The file is read in a private
 *   temporary folder and deleted; only its sha256 and the report are kept, so
 *   the same file uploaded again is answered from the stored report.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractPdfText } from '../extract/pdfText.js';
import { CONSTITUTION_ACT } from '../ingest/constitution.js';
import { compareCopyWithProvisions, latestEffectiveDate, newerThan } from './copyCheck.js';
import { checkDocument } from './documentCheck.js';
import { runTextWorker } from '../cases/textIndex.js';

/** Acts whose official text the library holds, so copies of them can be checked. */
export const CHECKABLE_ACTS = Object.freeze({ constitution: CONSTITUTION_ACT });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toIsoDay = (httpDate) => {
  const time = Date.parse(httpDate ?? '');
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

const verdictFor = ({ newerThanCopy, differs, compared }, fileDate, textCurrentTo) => {
  if (!newerThanCopy.length && !differs.length) {
    return { verdict: 'current', summary: `All ${compared} comparable provisions match the official text in force.` };
  }
  const parts = [];
  if (newerThanCopy.length) parts.push(`${newerThanCopy.length} provisions took effect after this copy's date (${fileDate})`);
  if (differs.length) parts.push(`${differs.length} of ${compared} provisions read differently from the official text in force`);
  const footnotes = textCurrentTo ? ` Its amendment footnotes stop at ${textCurrentTo}.` : '';
  return { verdict: newerThanCopy.length ? 'outdated' : 'differs', summary: `${parts.join('; ')}.${footnotes}` };
};

/** The Act to check against and the official document its library text came from, or an error result. */
const resolveAct = (store, act) => {
  const actRef = CHECKABLE_ACTS[act];
  if (!actRef) {
    return { error: { ok: false, status: 400, error: `Copies can be checked against: ${Object.keys(CHECKABLE_ACTS).join(', ')}` } };
  }
  const actId = store.findAct(actRef);
  const official = actId ? store.actSource(actId) : null;
  if (!official) {
    return { error: { ok: false, status: 503, error: `The official ${actRef.shortTitle} is not in the library yet` } };
  }
  return { actRef, actId, official };
};

/** Reads the copy's pages and builds the full report against the library. */
const buildReport = ({ actRef, official, provisions, pages, copy, fileDate }) => {
  const copyText = pages.map((page) => page.lines.map((line) => line.text).join('\n')).join('\n');
  const textCurrentTo = latestEffectiveDate(copyText);
  const comparison = compareCopyWithProvisions({ provisions, copyText, copyDate: fileDate });
  return {
    act: actRef.shortTitle,
    ...verdictFor(comparison, fileDate, textCurrentTo),
    copy: { ...copy, fileDate, textCurrentTo },
    official: { url: official.source_url, sha256: official.source_sha256 },
    ...comparison,
  };
};

export const checkCopy = async ({ store, url, act = 'constitution', copyDate = null, extract = extractPdfText, now = Date.now }) => {
  const { error, actRef, actId, official } = resolveAct(store, act);
  if (error) return error;
  const copy = store.latestDocument(url);
  if (!copy) {
    return { ok: false, status: 404, error: `No stored copy of ${url}. Fetch or import it first.` };
  }

  // A 304 revalidation row carries no Last-Modified; the 200 that delivered these bytes does.
  const delivered = store.lastSuccessfulFetch(url);
  const fileDate = copyDate
    ?? toIsoDay(copy.last_modified ?? (delivered?.sha256 === copy.sha256 ? delivered.last_modified : null));

  const report = buildReport({
    actRef, official, provisions: store.currentProvisions(actId), pages: await extract(copy.raw_path),
    copy: { url, sha256: copy.sha256 }, fileDate,
  });
  store.saveCopyCheck({
    copyUrl: url, copySha256: copy.sha256, actId, officialSha256: official.source_sha256, report,
    checkedAt: new Date(now()).toISOString(),
  });
  return { ok: true, ...report };
};

/** The PDF format requires "%PDF-" within the first 1024 bytes. */
const looksLikePdf = (body) => Buffer.isBuffer(body) && body.subarray(0, 1024).includes('%PDF-');

/** Page texts of a PDF through the fast worker (plain text: the document checker needs no layout). */
const pageTexts = async (file) => {
  let pages = null;
  let failure = null;
  await runTextWorker({
    files: [file],
    onRecord: (record) => {
      pages = record.pages ?? null;
      failure = record.error ?? null;
    },
  });
  if (!pages) throw new Error(failure || 'The PDF could not be read.');
  return pages;
};

/**
 * An uploaded PDF of any kind: identified first (a copy of an Act LawBuddy holds, a copy of a repealed
 * code, or a write-up), then checked the way that kind of document must be (see documentCheck.js).
 * The file is read in a private temporary folder and deleted; only its sha256 is kept with the report.
 */
export const checkUploadedDocument = async ({
  store, body, copyDate = null, readPages = pageTexts, critique, cloudClaims = false, tmpRoot = os.tmpdir(),
}) => {
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'lawbuddy-upload-'));
  let pages;
  try {
    const file = path.join(dir, 'document.pdf');
    await fs.writeFile(file, body, { mode: 0o600 });
    pages = await readPages(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  if (!pages.join('').trim()) {
    return { ok: false, status: 422, error: 'This PDF has no text layer (it is a scan or images), so there is nothing LawBuddy can read in it.' };
  }
  const report = await checkDocument({ store, pages, copyDate, sha256,
    ...(cloudClaims ? (critique ? { critique } : {}) : { critique: async () => null }),
  });
  return report.ok ? {
    ...report,
    ...(report.kind === 'write-up' && !cloudClaims && report.critique === null
      ? { critique: { error: 'Claim-by-claim model review was not run because local-only processing was selected.' } }
      : {}),
    processing: { cloudClaims },
    copy: { url: null, sha256, upload: true, fileDate: copyDate },
  } : report;
};

export const checkUploadedCopy = async ({
  store, body, act = 'constitution', copyDate = null, extract = extractPdfText, now = Date.now, tmpRoot = os.tmpdir(), readPages, critique, cloudClaims = false,
}) => {
  if (!looksLikePdf(body)) return { ok: false, status: 415, error: 'That file is not a PDF.' };
  if (copyDate !== null && (!ISO_DATE.test(copyDate) || Number.isNaN(Date.parse(copyDate)))) {
    return { ok: false, status: 400, error: 'The date of your copy must be YYYY-MM-DD.' };
  }
  if (act === 'auto') return checkUploadedDocument({ store, body, copyDate, tmpRoot, readPages, critique, cloudClaims });
  const { error, actRef, actId, official } = resolveAct(store, act);
  if (error) return error;

  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const provisions = store.currentProvisions(actId);
  const stored = store.copyCheckFor({ copySha256: sha256, actId, officialSha256: official.source_sha256 });

  // The stored report is undated; a copy date only decides which provisions are newer than the copy.
  let base = stored?.report;
  if (!base) {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'lawbuddy-upload-'));
    let pages;
    try {
      const file = path.join(dir, 'copy.pdf');
      await fs.writeFile(file, body, { mode: 0o600 });
      pages = await extract(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    base = buildReport({ actRef, official, provisions, pages, copy: { url: null, sha256, upload: true }, fileDate: null });
    store.saveCopyCheck({
      copyUrl: `upload:${sha256}`, copySha256: sha256, actId, officialSha256: official.source_sha256, report: base,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  const newerThanCopy = copyDate ? newerThan(provisions, copyDate) : [];
  return {
    ...base,
    ok: true,
    cached: Boolean(stored),
    ...verdictFor({ ...base, newerThanCopy }, copyDate, base.copy.textCurrentTo),
    copy: {
      url: null,
      sha256,
      upload: true,
      fileDate: copyDate,
      textCurrentTo: base.copy.textCurrentTo,
      // The stored report may be for a watched copy with these exact bytes: say where it is published.
      ...(base.copy.url ? { sameAs: base.copy.url } : {}),
    },
    newerThanCopy,
  };
};

/**
 * Change-event hooks for watchlists that declare which of their documents are copies of a
 * checkable Act ({ acts: { 'constitution-of-india.pdf': 'constitution' } }): a new or changed
 * copy is checked automatically and the verdict is recorded with the event's outcome.
 */
export const createCopyCheckers = ({ store, watchlists, check = checkCopy }) =>
  Object.fromEntries(
    watchlists
      .filter((list) => list.acts)
      .map((list) => [list.id, async (event) => {
        const act = list.acts[path.posix.basename(new URL(event.url).pathname)];
        if (!act || !['discovered', 'changed'].includes(event.kind)) return null;
        const result = await check({ store, url: event.url, act });
        return result.ok ? `copy check: ${result.verdict} — ${result.summary}` : `copy check failed: ${result.error}`;
      }]),
  );
