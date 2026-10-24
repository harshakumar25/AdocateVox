import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegalStore } from '../src/store/db.js';
import { ingestReviewedIndiaCodeEdition, sectionTextFromHtml } from '../src/ingest/indiaCodeEdition.js';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('a reviewed India Code section needs the right Act identity and PDF clause before any text is indexed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-india-code-'));
  const store = openLegalStore(':memory:');
  try {
    const pdfUrl = 'https://indiacode.gov.in/server/api/core/bitstreams/reviewed/content';
    const itemUrl = 'https://indiacode.gov.in/server/api/core/items/reviewed';
    const pdf = Buffer.from('%PDF-synthetic-review-fixture');
    const pdfPath = path.join(dir, 'act.pdf');
    await writeFile(pdfPath, pdf);
    const makeItem = (actId) => Buffer.from(JSON.stringify({
      id: 'reviewed', name: 'Computer related offences.',
      metadata: {
        'dc.identifier.act_id': [{ value: actId }],
        'dc.identifier.state_name': [{ value: 'CENTRAL' }],
        'dc.identifier.section_number': [{ value: '66' }],
        'dc.identifier.section_page_note': [{ value: '<sup>1</sup>[66. <b>Computer related offences.</b> If any person, dishonestly or fraudulently, does an act.]' }],
      },
    }));
    const itemPath = path.join(dir, 'section.json');
    const documents = new Map([[pdfUrl, { raw_path: pdfPath, sha256: hash(pdf) }]]);
    const library = { ...store, latestDocument: (url) => documents.get(url) ?? null };
    const extract = async () => [{ lines: [{ text: 'The Information Technology Act, 2000 ACT NO. 21 OF 2000 27th June, 2025' }] },
      { lines: [{ text: 'If any person, dishonestly or fraudulently, does an act.' }] }];
    const manifest = (itemSha) => ({
      title: 'Information Technology Act, 2000', year: 2000, actNumber: '21 of 2000', actId: 'CENTRAL-IT',
      pdfUrl, pdfSha256: hash(pdf), editionAsOf: '2025-06-27',
      header: /Information Technology Act, 2000.*ACT NO\. 21 OF 2000.*27th June, 2025/,
      sections: [{ label: 's.66', uuid: 'reviewed', sha256: itemSha, heading: 'Computer related offences.',
        validFrom: '2009-10-27', pages: [2, 2], anchors: ['dishonestly or fraudulently'] }],
    });

    const wrong = makeItem('STATE-IT');
    await writeFile(itemPath, wrong);
    documents.set(itemUrl, { raw_path: itemPath, sha256: hash(wrong) });
    await assert.rejects(ingestReviewedIndiaCodeEdition({ store: library, manifest: manifest(hash(wrong)), extract }), /does not belong/);
    assert.equal(store.findAct({ shortTitle: 'Information Technology Act, 2000', year: 2000 }), null);

    const correct = makeItem('CENTRAL-IT');
    await writeFile(itemPath, correct);
    documents.set(itemUrl, { raw_path: itemPath, sha256: hash(correct) });
    const result = await ingestReviewedIndiaCodeEdition({ store: library, manifest: manifest(hash(correct)), extract });
    assert.deepEqual(result.sections, ['s.66']);
    assert.match(store.getProvisionAsOf({ actId: result.actId, label: 's.66', date: '2025-06-27' }).text, /dishonestly or fraudulently/);
    assert.equal(store.getProvisionAsOf({ actId: result.actId, label: 's.66', date: '2026-10-24' }), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('section HTML removes editorial footnote markers without losing clauses', () => {
  assert.equal(sectionTextFromHtml('<sup>1</sup>[66. <b>Computer related offences.</b><br> If any person acts.]'),
    '[66. Computer related offences.\nIf any person acts.]');
});
