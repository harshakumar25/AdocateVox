import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONO_ROOT = path.resolve(PKG_ROOT, '../..');

// The same repo-root .env DocVex reads, so the CLI and the server agree. Variables already
// set in the environment win over the file.
try {
  const envPath = path.join(MONO_ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  // Fall back to the environment as it is.
}

const parsePositiveInteger = (val, fallback) => {
  if (val === undefined || val === null || val === '') return fallback;
  const parsed = Number(val);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Paths in .env (".lawbuddy/raw", "workers/pdf_extract.py") are relative to the repo root, not the cwd. */
const repoPath = (value, fallback) => path.resolve(MONO_ROOT, value || fallback);

export const config = Object.freeze({
  LEGAL_DB_PATH: repoPath(process.env.LEGAL_DB_PATH, '.lawbuddy/lawbuddy.db'),
  LEGAL_RAW_DIR: repoPath(process.env.LEGAL_RAW_DIR, '.lawbuddy/raw'),
  LEGAL_USER_AGENT: (process.env.LEGAL_USER_AGENT || 'LawBuddyBot/0.1 (+educational legal research)').trim(),
  LEGAL_FETCH_MIN_INTERVAL_MS: parsePositiveInteger(process.env.LEGAL_FETCH_MIN_INTERVAL_MS, 3000),
  LEGAL_FETCH_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_FETCH_TIMEOUT_MS, 30000),
  LEGAL_FETCH_MAX_BYTES: parsePositiveInteger(process.env.LEGAL_FETCH_MAX_BYTES, 50 * 1024 * 1024),
  LEGAL_PYTHON: repoPath(process.env.LEGAL_PYTHON, 'packages/lawbuddy/workers/.venv/bin/python'),
  LEGAL_PDF_WORKER: repoPath(process.env.LEGAL_PDF_WORKER, 'packages/lawbuddy/workers/pdf_extract.py'),
  LEGAL_PDF_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_PDF_TIMEOUT_MS, 300000),
  // Plain page text through pdfium, for indexing judgments in bulk (workers/pdf_text.py).
  LEGAL_TEXT_WORKER: repoPath(process.env.LEGAL_TEXT_WORKER, 'packages/lawbuddy/workers/pdf_text.py'),
  // Case briefs are prepared once per judgment and cached, so the larger model is worth its latency.
  GROQ_API_KEY: (process.env.GROQ_API_KEY || '').trim(),
  LEGAL_BRIEF_MODEL: (process.env.LEGAL_BRIEF_MODEL || 'openai/gpt-oss-120b').trim(),
  // Law-mode answers weigh provisions against each other; the 20B model generalised conditions in testing.
  LEGAL_ANSWER_MODEL: (process.env.LEGAL_ANSWER_MODEL || 'openai/gpt-oss-120b').trim(),
  // The claim-by-claim critic. Tested on planted errors, the 20B model passed every claim; the 120B model
  // caught a reversed "unless" and a shortened punishment, so the critic uses it (and may wait on its quota).
  LEGAL_CRITIC_MODEL: (process.env.LEGAL_CRITIC_MODEL || 'openai/gpt-oss-120b').trim(),
});
