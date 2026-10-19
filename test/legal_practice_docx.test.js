import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPracticePacket } from '../web/practiceModel.js';
import { buildWorkingDraftDocx, WORD_MIME } from '../web/practiceDocx.js';

const entries = (zip) => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const result = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034B50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    result.set(name, new TextDecoder().decode(zip.subarray(start, start + size)));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014B50, 'central directory follows local entries');
  return result;
};

test('Word export is an actual OOXML package with escaped matter facts and separate review notes', () => {
  const packet = buildPracticePacket({
    kind: 'legal-opinion', clientName: 'A & B <Partners>', opinionQuestion: 'Does the notice apply?',
    opinionFacts: 'Receipt & dispatch | p. 2', filingDate: '2026-10-18',
  });
  const zip = buildWorkingDraftDocx(packet, { createdAt: new Date('2026-10-18T12:00:00Z') });
  const files = entries(zip);
  assert.equal(WORD_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(files.size, 6);
  assert.match(files.get('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
  assert.match(files.get('word/document.xml'), /A &amp; B &lt;Partners&gt;/);
  assert.match(files.get('word/document.xml'), /Receipt &amp; dispatch/);
  assert.match(files.get('word/document.xml'), /Working document for advocate review/);
  assert.match(files.get('word/document.xml'), /<w:pageBreakBefore\/>/);
  assert.match(files.get('word/document.xml'), /Internal review notes/);
  assert.match(files.get('word/document.xml'), /Primary statutes and judgments/);
  assert.doesNotMatch(files.get('word/document.xml'), /<Partners>|2024 INSC 1/);
  assert.doesNotMatch(files.get('docProps/core.xml'), /A &amp; B|Does the notice apply/);
});

test('known legal or forum blockers prevent Word export', () => {
  const packet = buildPracticePacket({ kind: 'anticipatory-bail', courtLevel: 'magistrate', offenceSections: 'BNS 65' });
  assert.throws(() => buildWorkingDraftDocx(packet), /Resolve known forum or statutory restrictions/);
});
