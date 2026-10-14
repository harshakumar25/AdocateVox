/**
 * Runs workers/pdf_extract.py and returns the PDF's text, page by page, with
 * line positions, font sizes and boldness preserved for structure parsing.
 * Python runs in isolated mode (-I) because the PDF is untrusted input.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config } from '../config.js';

/**
 * @returns {Promise<Array<{page: number, width: number, height: number,
 *   lines: Array<{text: string, x0: number, top: number, size: number|null, bold: boolean}>}>>}
 */
export const extractPdfText = (pdfPath, {
  python = config.LEGAL_PYTHON,
  worker = config.LEGAL_PDF_WORKER,
  timeoutMs = config.LEGAL_PDF_TIMEOUT_MS,
} = {}) => new Promise((resolve, reject) => {
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
