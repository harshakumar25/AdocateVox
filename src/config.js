import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Check potential locations for .env: current working directory, package root, or monorepo root.
const candidateEnvs = [
  path.join(process.cwd(), '.env'),
  path.join(PKG_ROOT, '.env'),
  path.resolve(PKG_ROOT, '../../.env'),
];
for (const envPath of candidateEnvs) {
  try {
    if (fs.existsSync(envPath)) {
      process.loadEnvFile(envPath);
      break;
    }
  } catch {}
}

const parsePositiveInteger = (val, fallback) => {
  if (val === undefined || val === null || val === '') return fallback;
  const parsed = Number(val);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Base directory for relative legal store and raw vault paths:
// Prefer LEGAL_ROOT env, or whichever directory holds an existing .lawbuddy/ directory,
// falling back to process.cwd().
const resolveBaseDir = () => {
  if (process.env.LEGAL_ROOT) return path.resolve(process.env.LEGAL_ROOT);
  if (fs.existsSync(path.join(process.cwd(), '.lawbuddy'))) return process.cwd();
  if (fs.existsSync(path.join(PKG_ROOT, '.lawbuddy'))) return PKG_ROOT;
  return process.cwd();
};

const baseDir = resolveBaseDir();
const repoPath = (value, fallback) => path.resolve(baseDir, value || fallback);

export const config = Object.freeze({
  LEGAL_DB_PATH: repoPath(process.env.LEGAL_DB_PATH, '.lawbuddy/lawbuddy.db'),
  LEGAL_RAW_DIR: repoPath(process.env.LEGAL_RAW_DIR, '.lawbuddy/raw'),
  LEGAL_USER_AGENT: (process.env.LEGAL_USER_AGENT || 'LawBuddyBot/0.1 (+educational legal research)').trim(),
  LEGAL_FETCH_MIN_INTERVAL_MS: parsePositiveInteger(process.env.LEGAL_FETCH_MIN_INTERVAL_MS, 3000),
  LEGAL_FETCH_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_FETCH_TIMEOUT_MS, 30000),
  LEGAL_FETCH_MAX_BYTES: parsePositiveInteger(process.env.LEGAL_FETCH_MAX_BYTES, 50 * 1024 * 1024),
  LEGAL_PYTHON: process.env.LEGAL_PYTHON
    ? path.resolve(baseDir, process.env.LEGAL_PYTHON)
    : path.join(PKG_ROOT, 'workers/.venv/bin/python'),
  LEGAL_PDF_WORKER: process.env.LEGAL_PDF_WORKER
    ? path.resolve(baseDir, process.env.LEGAL_PDF_WORKER)
    : path.join(PKG_ROOT, 'workers/pdf_extract.py'),
  LEGAL_PDF_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_PDF_TIMEOUT_MS, 300000),
  // Plain page text through pdfium, for indexing judgments in bulk (workers/pdf_text.py).
  LEGAL_TEXT_WORKER: process.env.LEGAL_TEXT_WORKER
    ? path.resolve(baseDir, process.env.LEGAL_TEXT_WORKER)
    : path.join(PKG_ROOT, 'workers/pdf_text.py'),
  // Case briefs are prepared once per judgment and cached, so the larger model is worth its latency.
  GROQ_API_KEY: (process.env.GROQ_API_KEY || '').trim(),
  LEGAL_BRIEF_MODEL: (process.env.LEGAL_BRIEF_MODEL || 'openai/gpt-oss-120b').trim(),
  // Law-mode answers weigh provisions against each other; the 20B model generalised conditions in testing.
  LEGAL_ANSWER_MODEL: (process.env.LEGAL_ANSWER_MODEL || 'openai/gpt-oss-120b').trim(),
  // The claim-by-claim critic. Tested on planted errors, the 20B model passed every claim; the 120B model
  // caught a reversed "unless" and a shortened punishment, so the critic uses it (and may wait on its quota).
  LEGAL_CRITIC_MODEL: (process.env.LEGAL_CRITIC_MODEL || 'openai/gpt-oss-120b').trim(),
});
