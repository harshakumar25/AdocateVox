/**
 * Full-text indexing of Supreme Court judgments, for the citation graph.
 *
 * The AWS Open Data mirror publishes each year's English judgments as one
 * archive (data/tar/year=YYYY/english/english.tar, 45–864 MB; 22.7 GB for
 * 1950–2026) with a small index of its files. An archive is streamed straight
 * through workers/pdf_text.py and never stored: per judgment, only what it
 * cites (and how), one sentence of context per cited case, and its Article
 * mention counts are kept. Judgment PDFs already in the vault (fetched for
 * briefs) are indexed from there at no download cost.
 *
 * A year is skipped when its index file is unchanged since it was last indexed by
 * the current reader; a judgment is skipped when its PDF's sha256 is unchanged and
 * the current reader indexed it. A stream that drops is retried: what was already
 * indexed is skipped on the retry.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { analyseJudgment, JUDGMENT_READER_VERSION } from '../parse/judgmentCitations.js';
import { SC_BUCKET } from '../sources/scOpenData.js';

export const scTextIndexUrl = (year) => `${SC_BUCKET}/data/tar/year=${year}/english/english.index.json`;
export const scTextArchiveUrl = (year) => `${SC_BUCKET}/data/tar/year=${year}/english/english.tar`;

/** "2024_5_629_729_EN.pdf" → "2024_5_629_729", the judgment's dataset key. */
export const sourceKeyOf = (name) => /^(.+?)_EN\.pdf$/i.exec(path.basename(String(name || '')))?.[1] ?? null;

const WORKER_IDLE_MS = 10 * 60 * 1000;
const STREAM_ATTEMPTS = 3;

/** Whether the current reader already indexed this exact PDF for this judgment. */
const isCurrent = (store, caseId, sha256) => {
  const indexed = store.getCaseText(caseId);
  return indexed?.pdf_sha256 === sha256 && Number(indexed.parser_version) >= JUDGMENT_READER_VERSION;
};

/**
 * Runs the page-text worker over PDF files, or over a tar stream (`input`), calling `onRecord`
 * for each PDF it reports ({ name, sha256, bytes, pages } or { name, error }).
 */
export const runTextWorker = ({
  files = [], input = null, onRecord,
  python = config.LEGAL_PYTHON, worker = config.LEGAL_TEXT_WORKER, idleTimeoutMs = WORKER_IDLE_MS,
}) => new Promise((resolve, reject) => {
  const child = spawn(python, ['-I', worker, ...(input ? ['--tar'] : files)], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let settled = false;
  let timer = null;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) {
      child.kill('SIGKILL');
      reject(error);
    } else {
      resolve();
    }
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(new Error(`text worker produced nothing for ${idleTimeoutMs}ms`)), idleTimeoutMs);
  };
  arm();

  if (input) {
    input.on('error', finish);
    child.stdin.on('error', () => {}); // a worker that died is reported by its exit code
    input.pipe(child.stdin);
  }
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (settled || !line.trim()) return;
    arm();
    try {
      onRecord(JSON.parse(line));
    } catch (error) {
      finish(error instanceof SyntaxError ? new Error('text worker emitted invalid JSON') : error);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on('error', (error) => finish(new Error(`Could not start the text worker (${python}): ${error.message}`)));
  child.on('close', (code) => finish(code === 0 ? null : new Error(stderr.trim() || `text worker exited with code ${code}`)));
});

/** Analyses one judgment's page texts and stores what it cites. Returns the number of cited groups. */
export const indexJudgmentRecord = ({ store, caseId, record, knownArticles }) => {
  const { references, articles, citations } = analyseJudgment(record.pages, { knownArticles });
  return store.saveJudgmentText({
    caseId,
    pdfSha256: record.sha256,
    pages: record.pages.length,
    chars: record.pages.reduce((sum, page) => sum + page.length, 0),
    citations,
    references,
    articles,
  });
};

const createRecordHandler = ({ store, knownArticles, force, summary, onProgress }) => (record) => {
  const key = sourceKeyOf(record.name);
  const caseId = key ? store.caseIdBySourceKey(key) : null;
  if (!caseId) {
    summary.unmatched += 1;
    return;
  }
  if (record.error || !Array.isArray(record.pages)) {
    summary.failed += 1;
    return;
  }
  if (!force && isCurrent(store, caseId, record.sha256)) {
    summary.unchanged += 1;
    return;
  }
  indexJudgmentRecord({ store, caseId, record, knownArticles });
  summary.indexed += 1;
  onProgress?.(summary);
};

/**
 * Indexes one year's judgments from the streamed archive.
 * @returns {Promise<object>} { year, ok, skipped?, files, indexed, unchanged, unmatched, failed, bytes }
 */
export const indexScTextYear = async ({
  store, fetcher, year, knownArticles, force = false, readFile = fs.readFile, runWorker = runTextWorker, onProgress,
}) => {
  const index = await fetcher.fetchDocument(scTextIndexUrl(year));
  if (!index.ok) return { year, ok: false, error: index.error || `HTTP ${index.status}` };
  let listing;
  try {
    listing = JSON.parse(await readFile(index.rawPath, 'utf8'));
  } catch {
    return { year, ok: false, error: 'the archive index is not valid JSON' };
  }
  const files = Number(listing.file_count) || 0;
  const previous = store.getScTextImport(year);
  if (!force && previous?.index_sha256 === index.sha256 && Number(previous.parser_version) >= JUDGMENT_READER_VERSION) {
    return { year, ok: true, skipped: true, files, indexed: previous.indexed };
  }

  const summary = { year, ok: true, skipped: false, files, indexed: 0, unchanged: 0, unmatched: 0, failed: 0, attempts: 0 };
  let streamed = null;
  for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt += 1) {
    summary.attempts = attempt;
    // On a retry, a judgment indexed by the dropped attempt counts once: as unchanged, not again.
    const tally = { ...summary, indexed: 0, unchanged: 0, unmatched: 0, failed: 0 };
    const onRecord = createRecordHandler({
      store, knownArticles, force: force && attempt === 1, summary: tally, onProgress,
    });
    streamed = await fetcher.streamDocument(scTextArchiveUrl(year), (stream) => runWorker({ input: stream, onRecord }));
    summary.indexed += tally.indexed;
    if (streamed.ok) {
      Object.assign(summary, { unchanged: tally.unchanged - (summary.indexed - tally.indexed), unmatched: tally.unmatched, failed: tally.failed });
      break;
    }
  }
  if (!streamed.ok) return { ...summary, ok: false, error: streamed.error };

  store.saveScTextImport({
    year, indexSha256: index.sha256, archiveSha256: streamed.sha256, files,
    indexed: summary.indexed + summary.unchanged, unmatched: summary.unmatched, failed: summary.failed,
  });
  return { ...summary, bytes: streamed.byteLength };
};

/** Indexes the judgment PDFs already in the vault (fetched for briefs). */
export const indexStoredJudgments = async ({ store, knownArticles, force = false, runWorker = runTextWorker }) => {
  const summary = { indexed: 0, unchanged: 0, unmatched: 0, failed: 0 };
  const pending = store.storedJudgmentPdfs().filter((row) => force || !isCurrent(store, row.id, row.sha256));
  summary.unchanged = store.storedJudgmentPdfs().length - pending.length;
  for (const row of pending) {
    // The vault names files by sha256, so each is run on its own and mapped back by case id.
    await runWorker({
      files: [row.raw_path],
      onRecord: (record) => {
        if (record.error || !Array.isArray(record.pages)) {
          summary.failed += 1;
          return;
        }
        indexJudgmentRecord({ store, caseId: row.id, record, knownArticles });
        summary.indexed += 1;
      },
    });
  }
  return summary;
};
