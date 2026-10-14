/**
 * Runs workers/pdf_text.py --words and returns each page's positioned words, for parsers that must
 * tell columns apart (a Gazette Act's margin headings beside its body text). Python runs in isolated
 * mode (-I) because the PDF is untrusted input.
 */

import { execFile } from 'node:child_process';
import { config } from '../config.js';

const MAX_OUTPUT = 256 * 1024 * 1024;

/** @returns {Promise<Array<{ page: number, width: number, words: Array<{x0: number, x1: number, top: number, text: string, sp: boolean}> }>>} */
export const extractPdfWords = (pdfPath, {
  python = config.LEGAL_PYTHON,
  worker = config.LEGAL_TEXT_WORKER,
  timeoutMs = config.LEGAL_PDF_TIMEOUT_MS,
} = {}) => new Promise((resolve, reject) => {
  execFile(python, ['-I', worker, '--words', pdfPath], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(String(stderr || '').trim() || `text worker failed: ${error.message}`));
      return;
    }
    try {
      resolve(stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));
    } catch {
      reject(new Error('text worker emitted invalid JSON'));
    }
  });
});
