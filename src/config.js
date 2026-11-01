import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The project that installed AdvocateVox as a dependency (".../node_modules/@docvex/lawbuddy" → "..."), or null
 * when AdvocateVox runs from its own checkout.
 */
export const hostRootOf = (pkgRoot) => {
  const parts = pkgRoot.split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : null;
};

/**
 * Every .env that can configure AdvocateVox, most specific first: the working directory, the host project
 * (when installed as a dependency, its own .env holds GROQ_API_KEY and the library location), AdvocateVox's
 * own checkout, and finally the .env beside the library data (LEGAL_ROOT). All are read and the first
 * value set wins (process.loadEnvFile never overwrites a variable already set), so a key missing from
 * one file is still found in the next instead of the first file found silently being the only one.
 */
export const loadLegalEnv = ({ cwd = process.cwd(), pkgRoot = PKG_ROOT, load = process.loadEnvFile, exists = fs.existsSync } = {}) => {
  const loaded = [];
  const tryLoad = (file) => {
    if (!file || loaded.includes(file) || !exists(file)) return;
    try {
      load(file);
      loaded.push(file);
    } catch {
      // an unreadable .env is skipped; the environment as it stands still applies
    }
  };
  const host = hostRootOf(pkgRoot);
  for (const dir of [cwd, host, pkgRoot]) if (dir) tryLoad(path.join(dir, '.env'));
  if (process.env.LEGAL_ROOT) tryLoad(path.join(path.resolve(process.env.LEGAL_ROOT), '.env'));
  return loaded;
};

loadLegalEnv();

const parsePositiveInteger = (val, fallback) => {
  if (val === undefined || val === null || val === '') return fallback;
  const parsed = Number(val);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Base directory for relative legal store and raw vault paths: LEGAL_ROOT, else the first of the working
// directory, the host project and AdvocateVox's own checkout that holds a .advocatevox/ or .lawbuddy/ library, else the cwd.
export const resolveBaseDir = ({ cwd = process.cwd(), pkgRoot = PKG_ROOT, legalRoot = process.env.LEGAL_ROOT, exists = fs.existsSync } = {}) => {
  if (legalRoot) return path.resolve(legalRoot);
  const host = hostRootOf(pkgRoot);
  for (const dir of [cwd, host, pkgRoot]) if (dir && (exists(path.join(dir, '.advocatevox')) || exists(path.join(dir, '.lawbuddy')))) return dir;
  return cwd;
};

const baseDir = resolveBaseDir();
const repoPath = (value, fallback) => path.resolve(baseDir, value || fallback);

export const resolvePythonBinary = ({
  envPython = process.env.LEGAL_PYTHON,
  pkgRoot = PKG_ROOT,
  base = baseDir,
  homedir = process.env.HOME || '',
  exists = fs.existsSync,
} = {}) => {
  if (envPython) {
    const candidate = path.isAbsolute(envPython) ? envPython : path.resolve(base, envPython);
    if (exists(candidate)) return candidate;
  }
  const standardVenvs = [
    path.join(pkgRoot, 'workers/.venv/bin/python'),
    path.join(pkgRoot, '.venv/bin/python'),
    path.join(homedir, '.venvs/advocatevox-pdf/bin/python'),
    path.join(homedir, '.venvs/lawbuddy-pdf/bin/python'),
  ];
  for (const candidate of standardVenvs) {
    if (candidate && exists(candidate)) return candidate;
  }
  return envPython ? path.resolve(base, envPython) : (process.env.PYTHON || 'python3');
};

export const config = Object.freeze({
  LEGAL_DB_PATH: repoPath(process.env.LEGAL_DB_PATH, fs.existsSync(path.join(baseDir, '.advocatevox/advocatevox.db')) ? '.advocatevox/advocatevox.db' : '.lawbuddy/lawbuddy.db'),
  LEGAL_RAW_DIR: repoPath(process.env.LEGAL_RAW_DIR, fs.existsSync(path.join(baseDir, '.advocatevox/raw')) ? '.advocatevox/raw' : '.lawbuddy/raw'),
  LEGAL_USER_AGENT: (process.env.LEGAL_USER_AGENT || 'AdvocateVoxBot/0.1 (+educational legal research)').trim(),
  LEGAL_FETCH_MIN_INTERVAL_MS: parsePositiveInteger(process.env.LEGAL_FETCH_MIN_INTERVAL_MS, 3000),
  LEGAL_FETCH_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_FETCH_TIMEOUT_MS, 30000),
  LEGAL_FETCH_MAX_BYTES: parsePositiveInteger(process.env.LEGAL_FETCH_MAX_BYTES, 50 * 1024 * 1024),
  LEGAL_PYTHON: resolvePythonBinary(),
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
