import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openLegalStore } from '../src/store/db.js';
import { importLocalDocument } from '../src/sources/manualImport.js';
import { extractPdfText } from '../src/extract/pdfText.js';
import { buildPdf } from './helpers/pdf.js';

const workerInstalled = existsSync(config.LEGAL_PYTHON);
const skipReason = workerInstalled ? false : 'PDF worker venv not installed (python3 -m venv workers/.venv && workers/.venv/bin/pip install -r workers/requirements.txt)';

test('extractPdfText returns ordered lines per page with font size and boldness', { skip: skipReason }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-pdf-'));
  try {
    const pdfPath = path.join(dir, 'sample.pdf');
    await writeFile(pdfPath, buildPdf([
      [
        { text: 'PART III', size: 14, bold: true, x: 72, y: 780 },
        { text: '21. Protection of life and personal liberty.', size: 11, bold: false, x: 72, y: 750 },
        { text: '1. Subs. by the Constitution (Forty-fourth Amendment) Act, 1978.', size: 8, bold: false, x: 72, y: 60 },
      ],
      [{ text: 'Second page (with parentheses)', size: 11, bold: false, x: 72, y: 780 }],
    ]));

    const pages = await extractPdfText(pdfPath);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].page, 1);
    assert.deepEqual(pages[0].lines.map((line) => line.text), [
      'PART III',
      '21. Protection of life and personal liberty.',
      '1. Subs. by the Constitution (Forty-fourth Amendment) Act, 1978.',
    ]);
    assert.deepEqual(pages[0].lines.map((line) => [line.size, line.bold]), [[14, true], [11, false], [8, false]]);
    assert.ok(pages[0].lines[0].top < pages[0].lines[2].top, 'top grows down the page');
    assert.equal(pages[1].lines[0].text, 'Second page (with parentheses)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractPdfText rejects with the worker error for a file that is not a PDF', { skip: skipReason }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-pdf-'));
  try {
    const bogus = path.join(dir, 'not-a.pdf');
    await writeFile(bogus, '<html>Access Denied</html>');
    await assert.rejects(extractPdfText(bogus), /pdf_extract failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractPdfText reports a missing interpreter clearly', async () => {
  await assert.rejects(
    extractPdfText('/nonexistent.pdf', { python: '/nonexistent/python' }),
    /Could not start PDF worker/,
  );
});

test('importLocalDocument vaults a manual download with provenance, separate from automatic fetches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-import-'));
  const store = openLegalStore(':memory:');
  try {
    const file = path.join(dir, 'COI_2024.pdf');
    await writeFile(file, buildPdf([[{ text: 'THE CONSTITUTION OF INDIA', size: 14, bold: true, x: 72, y: 780 }]]));
    const url = 'https://lddashboard.legislative.gov.in/sites/default/files/coi/COI_2024.pdf';

    const result = await importLocalDocument({ store, filePath: file, url, vaultDir: path.join(dir, 'vault') });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'manual');
    assert.equal(result.sourceId, 'legislative');
    assert.equal(result.contentType, 'application/pdf');
    assert.deepEqual(await readFile(result.rawPath), await readFile(file));

    const latest = store.latestDocument(url);
    assert.equal(latest.method, 'manual');
    assert.equal(latest.sha256, result.sha256);
    assert.equal(store.lastSuccessfulFetch(url), null, 'manual copies never drive conditional revalidation');

    const again = await importLocalDocument({ store, filePath: file, url, vaultDir: path.join(dir, 'vault') });
    assert.equal(again.rawPath, result.rawPath, 'identical content is stored once');

    await assert.rejects(
      importLocalDocument({ store, filePath: file, url: 'https://randomblog.example/coi.pdf', vaultDir: dir }),
      /not on a registered legal source/,
    );
    await assert.rejects(importLocalDocument({ store, filePath: dir, url, vaultDir: dir }), /is not a file/);
    await assert.rejects(
      importLocalDocument({ store, filePath: file, url, vaultDir: dir, maxBytes: 10 }),
      /exceeds 10 bytes/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
