/**
 * Runs workers/pdf_extract.py and returns the PDF's text, page by page, with
 * line positions, font sizes and boldness preserved for structure parsing.
 * Python runs in isolated mode (-I) because the PDF is untrusted input.
 *
 * Includes content-addressed in-memory LRU passage caching keyed by sha256(pdfBufferOrPath).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { config } from '../config.js';

const MAX_PDF_CACHE_SIZE = 100;
export const passageCache = new Map(); // SHA-256 -> Extracted Pages Array

export const clearPdfCache = () => {
  passageCache.clear();
};

export const computePdfSha256 = async (pdfBufferOrPath) => {
  if (Buffer.isBuffer(pdfBufferOrPath) || pdfBufferOrPath instanceof Uint8Array) {
    return createHash('sha256').update(pdfBufferOrPath).digest('hex');
  }
  if (typeof pdfBufferOrPath === 'string') {
    try {
      const buffer = await fs.readFile(pdfBufferOrPath);
      return createHash('sha256').update(buffer).digest('hex');
    } catch {
      return createHash('sha256').update(pdfBufferOrPath).digest('hex');
    }
  }
  return null;
};

const spawnPdfWorker = (pdfPath, { python, worker, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(python, ['-I', worker, pdfPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pages = [];
  let stderr = '';
  let settled = false;

  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(pages);
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(new Error(`PDF extraction timed out after ${timeoutMs}ms: ${pdfPath}`));
  }, timeoutMs);

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      pages.push(JSON.parse(line));
    } catch {
      child.kill('SIGKILL');
      finish(new Error(`PDF worker emitted invalid JSON for ${pdfPath}`));
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  child.on('error', (error) => finish(new Error(`Could not start PDF worker (${python}): ${error.message}`)));

  child.on('close', (code) => {
    if (code === 0) finish(null);
    else finish(new Error(stderr.trim() || `PDF worker exited with code ${code}`));
  });
});

/**
 * @param {string|Buffer} pdfPath
 * @param {object} [options]
 * @returns {Promise<Array<{page: number, width: number, height: number,
 *   lines: Array<{text: string, x0: number, top: number, size: number|null, bold: boolean}>}>>}
 */
export const extractPdfText = async (pdfPath, options = {}) => {
  const {
    python = config.LEGAL_PYTHON,
    worker = config.LEGAL_PDF_WORKER,
    timeoutMs = config.LEGAL_PDF_TIMEOUT_MS,
    bypassCache = false,
  } = options;

  let fileHash = null;
  if (!bypassCache) {
    fileHash = await computePdfSha256(pdfPath);
    if (fileHash && passageCache.has(fileHash)) {
      const cached = passageCache.get(fileHash);
      // Refresh LRU order: delete & re-insert
      passageCache.delete(fileHash);
      passageCache.set(fileHash, cached);
      return cached;
    }
  }

  const pages = await spawnPdfWorker(pdfPath, { python, worker, timeoutMs });

  if (fileHash && Array.isArray(pages) && pages.length > 0) {
    if (passageCache.has(fileHash)) {
      passageCache.delete(fileHash);
    } else if (passageCache.size >= MAX_PDF_CACHE_SIZE) {
      const oldestKey = passageCache.keys().next().value;
      passageCache.delete(oldestKey);
    }
    passageCache.set(fileHash, pages);
  }

  return pages;
};

export const extractPdfTextWithCache = extractPdfText;
