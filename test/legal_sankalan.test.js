import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, extractTableRows } from '../src/parse/html.js';
import { parseSankalanTable, scanRefs } from '../src/parse/sankalanTable.js';
import { openLegalStore } from '../src/store/db.js';
import { findSourceForUrl } from '../src/sources/registry.js';

const cell = (...paragraphs) =>
  `<td style="width: 50%; vertical-align: top;">${paragraphs.map((p) => ` <p style="padding-left: 5px;">${p}</p>`).join('')} </td>`;
const row = (left, right) => `<tr>${left}${right}</tr>`;

// Mirrors the markup of https://www.ncrb.gov.in/uploads/SankalanPortal/SectionTableBNS.html (rows abridged).
const BNS_TABLE = `<!doctype html><html><head><script>var x = "<tr><td>not a row</td></tr>";</script></head><body>
<table id="example" class="display">
<thead><tr>
  <th style="border: 1pt solid windowtext;"><p><strong><span>Bharatiya Nyaya Sanhita, 2023</span></strong><br><!--<input placeholder="Search In BNS">--></p></th>
  <th><p><strong><span>Indian Penal Code, 1860</span></strong></p></th>
</tr></thead><tbody>
${row(cell('<strong><span>CHAPTER I &ndash; PRELIMINARY</span></strong>'), cell('<strong><span>CHAPTER I &ndash; INTRODUCTION</span></strong>'))}
${row(cell('<span>1. Short title, commencement and application.</span>', '<span>1(1)</span>'), cell('<span>1. Title and extent of operation of the Code.</span>'))}
${row(cell('<strong><span style="color:#00B050;">1(2)</span></strong>'), cell('<strong><span style="color:#00B050;">New Sub-Section</span></strong>'))}
${row(cell('<span>1(3)</span>'), cell('<span>2. Punishment of offences committed within India.</span>'))}
${row(cell('<span>2. Definitions. (Change)</span>'), cell(''))}
${row(cell('<span>2(3) &lsquo;child&rsquo;</span>'), cell('<span>New Sub-Section</span>'))}
${row(cell('<strong><em><span>Of right of private defence</span></em></strong>'), cell('<strong><em><span>Of the Right of Private Defence</span></em></strong>'))}
${row(cell('<span>33. Act causing slight harm.</span>'), cell('<span>95. Act causing slight harm.</span>'))}
${row(cell('<span style="color:#000080; font-weight:bold">103. Punishment for murder. (Change)</span>'), cell('<span>302. Punishment for murder.</span>'))}
${row(cell('<span>69. Sexual intercourse by employing deceitful means etc.</span>'), cell('<span>New Section</span>'))}
${row(cell('<strong><span style="color:red;">Deleted</span></strong>'), cell('<span>124A. Sedition</span>'))}
${row(cell('<span>152. Acts endangering sovereignty, unity and integrity of India.</span>'), cell('<span>New Section</span>'))}
${row(cell('<span>178. Counterfeiting coin, Government stamps, currency-notes or bank-notes.</span>'), cell('<span>231. Counterfeiting coin. 255.Counterfeiting Government stamp. 489A. Counterfeiting currency-notes or bank-notes.</span>'))}
${row(cell('<span>148. Conspiracy to commit offences punishable by section 147.</span>'), cell('<span>121A. Conspiracy to commit offences punishable by section 121.</span>'))}
${row(cell('<span>302. Uttering words, etc., with deliberate intent to wound religious feelings of any person.</span>'), cell('<span>298. Uttering words, etc., with deliberate intent to wound religious feelings of any person.</span>'))}
${row(cell('<span>49. Punishment of abetment if act abetted is committed in consequence.</span>'), cell('<span>Corresponds partly to Explanation 3 of section 108.</span>'))}
${row(cell('<strong><span style="color:red;">Deleted</span></strong>'), cell('<span>309. &ldquo;Attempt to commit suicide&rdquo;.</span>'))}
</tbody></table></body></html>`;

const BSA_ROWS = `<table>
<tr><th><p>BHARATIYA SAKSHYA ADHINIYAM, 2023</p></th><th><p>INDIAN EVIDENCE ACT, 1872</p></th></tr>
${row(cell('PART I', 'RELEVANCY OF FACTS', 'CHAPTER I', 'PRELIMINARY'), cell('PART I', 'CHAPTER I', 'PRELIMINARY'))}
${row(cell('61. Electronic or digital record.'), cell('New Section'))}
${row(cell('62. Special provisions as to evidence relating to electronic record.'), cell('65A. Special provisions as to evidence relating to electronic record.'))}
${row(cell('63. Admissibility of electronic records. (Change)'), cell('65B. Admissibility of electronic records.'))}
${row(cell('<span style="color:red">Deleted</span>'), cell('65B (3) (a) by a combination of computers operating over that period; or'))}
</table>`;

test('decodeEntities and extractTableRows read cells as paragraphs of plain text', () => {
  assert.equal(decodeEntities('&lsquo;child&rsquo; &ndash; &#8212; &#x2014; &amp;amp; &bogus;'), '‘child’ – — — &amp; &bogus;');
  const rows = extractTableRows(BNS_TABLE);
  assert.equal(rows.some((cells) => cells.some((c) => c.paragraphs.includes('not a row'))), false, 'script content ignored');
  assert.deepEqual(rows[0].map((c) => [c.header, c.paragraphs]), [
    [true, ['Bharatiya Nyaya Sanhita, 2023']],
    [true, ['Indian Penal Code, 1860']],
  ]);
  assert.deepEqual(rows[2][0].paragraphs, ['1. Short title, commencement and application.', '1(1)']);
});

test('scanRefs reads headings, merged references and clause-level labels, never prose numbers', () => {
  assert.deepEqual(scanRefs('103. Punishment for murder. (Change)'), [{ label: 's.103', title: 'Punishment for murder.' }]);
  assert.deepEqual(
    scanRefs('231. Counterfeiting coin. 255.Counterfeiting Government stamp. 489A. Counterfeiting currency-notes.').map((r) => r.label),
    ['s.231', 's.255', 's.489A'],
  );
  assert.deepEqual(scanRefs('121A. Conspiracy to commit offences punishable by section 121.').map((r) => r.label), ['s.121A']);
  assert.deepEqual(scanRefs('65B (3) (a) by a combination of computers'), [
    { label: 's.65B(3)(a)', title: 'by a combination of computers' },
  ]);
  assert.deepEqual(scanRefs('178 (5)'), [{ label: 's.178(5)', title: null }]);
  assert.deepEqual(scanRefs('1. Short title. Extent. Commencement of Act.').map((r) => r.label), ['s.1']);
  assert.deepEqual(scanRefs('Of right of private defence'), []);
  assert.deepEqual(scanRefs('Punishable under 302. Murder', { startOnly: true }), []);
});

test('parseSankalanTable classifies every BNS↔IPC row kind and reports what it cannot read', () => {
  const { newAct, oldAct, entries, unparsed } = parseSankalanTable(BNS_TABLE);
  assert.equal(newAct, 'BNS');
  assert.equal(oldAct, 'IPC');

  const find = (predicate) => entries.filter(predicate).map((e) => `${e.kind}|${e.newLabel}|${e.oldLabel}|${e.changed}`);
  assert.deepEqual(find((e) => e.newLabel === 's.1(1)'), ['mapped|s.1(1)|s.1|false']);
  assert.equal(entries.find((e) => e.newLabel === 's.1(1)').newTitle, 'Short title, commencement and application.');
  assert.deepEqual(find((e) => e.newLabel === 's.1(2)'), ['new|s.1(2)|null|false']);
  assert.deepEqual(find((e) => e.newLabel === 's.1(3)'), ['mapped|s.1(3)|s.2|false']);
  assert.deepEqual(find((e) => e.newLabel === 's.103'), ['mapped|s.103|s.302|true']);
  assert.deepEqual(find((e) => e.newLabel === 's.69'), ['new|s.69|null|false']);
  assert.deepEqual(find((e) => e.oldLabel === 's.124A'), ['deleted|null|s.124A|false']);
  assert.deepEqual(find((e) => e.newLabel === 's.178'), [
    'merged|s.178|s.231|false',
    'merged|s.178|s.255|false',
    'merged|s.178|s.489A|false',
  ]);
  assert.deepEqual(find((e) => e.newLabel === 's.148'), ['mapped|s.148|s.121A|false']);
  assert.deepEqual(find((e) => e.newLabel === 's.302'), ['mapped|s.302|s.298|false']);
  assert.equal(entries.find((e) => e.oldLabel === 's.309').oldTitle, '“Attempt to commit suicide”.');

  assert.equal(entries.find((e) => e.newLabel === 's.103').chapter, 'CHAPTER I – PRELIMINARY');
  assert.equal(entries.some((e) => e.newLabel === 's.2'), false, 'parent row without a counterpart is skipped');
  assert.equal(entries.find((e) => e.newLabel === 's.2(3)').newTitle, '‘child’');
  assert.deepEqual(unparsed, [{
    newCell: '49. Punishment of abetment if act abetted is committed in consequence.',
    oldCell: 'Corresponds partly to Explanation 3 of section 108.',
  }], 'a counterpart described only in prose is surfaced for review, never guessed');
});

test('parseSankalanTable handles the BSA↔Evidence Act table, multi-line chapters and clause deletions', () => {
  const { newAct, oldAct, entries, unparsed } = parseSankalanTable(BSA_ROWS);
  assert.equal(newAct, 'BSA');
  assert.equal(oldAct, 'IEA');
  assert.deepEqual(unparsed, []);
  assert.deepEqual(
    entries.map((e) => `${e.kind}|${e.newLabel}|${e.oldLabel}|${e.changed}`),
    ['new|s.61|null|false', 'mapped|s.62|s.65A|false', 'mapped|s.63|s.65B|true', 'deleted|null|s.65B(3)(a)|false'],
  );
  assert.equal(entries[0].chapter, 'PART I — RELEVANCY OF FACTS — CHAPTER I — PRELIMINARY');
});

test('parseSankalanTable rejects pages that are not a correspondence table', () => {
  assert.throws(() => parseSankalanTable('<html><body>Access Denied</body></html>'), /Not a Sankalan correspondence table/);
  assert.throws(
    () => parseSankalanTable('<table><tr><th>Some Act, 1900</th><th>Other Act, 1950</th></tr></table>'),
    /no header row naming two known Acts/,
  );
});

test('stored correspondence answers both directions, includes sub-divisions, and re-imports cleanly', () => {
  const store = openLegalStore(':memory:');
  try {
    const source = { sourceUrl: 'https://www.ncrb.gov.in/uploads/SankalanPortal/SectionTableBNS.html', sourceSha256: 'abc' };
    const bns = parseSankalanTable(BNS_TABLE);
    assert.equal(store.replaceMappings({ ...bns, ...source }), bns.entries.length);
    const bsa = parseSankalanTable(BSA_ROWS);
    store.replaceMappings({ ...bsa, ...source });

    const ipc302 = store.findCorrespondence({ act: 'IPC', label: 's.302' });
    assert.deepEqual(ipc302.map((r) => `${r.new_act} ${r.new_label}`), ['BNS s.103']);
    assert.equal(ipc302[0].changed, 1);

    const bns302 = store.findCorrespondence({ act: 'BNS', label: 's.302' });
    assert.deepEqual(bns302.map((r) => `${r.old_act} ${r.old_label}`), ['IPC s.298'], 'BNS 302 is not IPC 302');

    assert.deepEqual(store.findCorrespondence({ act: 'IPC', label: 's.124A' }).map((r) => r.kind), ['deleted']);
    assert.deepEqual(store.findCorrespondence({ act: 'BNS', label: 's.1' }).map((r) => r.new_label), ['s.1(1)', 's.1(2)', 's.1(3)']);
    assert.deepEqual(store.findCorrespondence({ act: 'IEA', label: 's.65B' }).map((r) => `${r.kind} ${r.old_label}`), [
      'mapped s.65B',
      'deleted s.65B(3)(a)',
    ]);
    assert.deepEqual(store.findCorrespondence({ act: 'IPC', label: 's.30' }), [], 'no false prefix match on s.302');

    store.replaceMappings({ ...bns, entries: bns.entries.slice(0, 2), ...source });
    assert.deepEqual(store.findCorrespondence({ act: 'IPC', label: 's.302' }), [], 're-import replaces, not appends');
    assert.equal(store.findCorrespondence({ act: 'IEA', label: 's.65B' }).length, 2, 'other tables untouched');
  } finally {
    store.close();
  }
});

test('NCRB is a registered tier-0 source', () => {
  const source = findSourceForUrl('https://www.ncrb.gov.in/uploads/SankalanPortal/SectionTableBNS.html');
  assert.equal(source.id, 'ncrb');
  assert.equal(source.tier, 0);
});
