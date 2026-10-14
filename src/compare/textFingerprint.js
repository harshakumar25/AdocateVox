/**
 * Text fingerprints for stored PDFs: sha256 of the extracted text with only
 * whitespace and Unicode-form differences normalised away. Two versions with
 * the same fingerprint say the same thing word for word, punctuation and case
 * included, so a re-upload that only changed bytes (new producer, timestamps,
 * re-save) is recognised. Anything less certain counts as a real change:
 * calling an amendment "the same text" is the error that must not happen.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { extractPdfText } from '../extract/pdfText.js';
import { vaultPath } from '../sources/vault.js';

export const normalizeForFingerprint = (pages) =>
  pages
    .map((page) => page.lines.map((line) => line.text).join(' '))
    .join(' ')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

/** Returns `fingerprint(sha256)` for any PDF body in the vault, extracting it once and caching the result. */
export const createTextFingerprinter = ({ store, vaultDir = config.LEGAL_RAW_DIR, extract = extractPdfText }) =>
  async (sha256) => {
    const cached = store.getTextFingerprint(sha256);
    if (cached) return cached.text_sha256;

    const pages = await extract(vaultPath(vaultDir, sha256));
    const text = normalizeForFingerprint(pages);
    const textSha256 = crypto.createHash('sha256').update(text).digest('hex');
    store.saveTextFingerprint({ sha256, textSha256, pages: pages.length, chars: text.length });
    return textSha256;
  };

const isPdf = (event) => {
  try {
    return /pdf/i.test(JSON.parse(event.detail || '{}').contentType || '') || /\.pdf$/i.test(new URL(event.url).pathname);
  } catch {
    return false;
  }
};

/**
 * For the event router: true only when a changed PDF's old and new versions have identical
 * fingerprints. Any extraction failure answers false, so the change is handled as real.
 */
export const createSameTextCheck = (fingerprint) => async (event) => {
  if (event.kind !== 'changed' || !event.old_sha256 || !event.new_sha256 || !isPdf(event)) return false;
  try {
    const [before, after] = await Promise.all([fingerprint(event.old_sha256), fingerprint(event.new_sha256)]);
    return before === after;
  } catch {
    return false;
  }
};
