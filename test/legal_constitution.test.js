import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConstitution, stripMarkers } from '../src/parse/constitution.js';
import { ingestConstitution } from '../src/ingest/constitution.js';
import { openLegalStore } from '../src/store/db.js';

const STAR = ''; // Symbol-font asterisk, as extracted from the official PDF
let top = 0;
const line = (text, { x0 = 36, size = 9, bold = false } = {}) => ({ text, x0, top: (top += 11), size, bold });
const footnote = (text, x0 = 36) => ({ text, x0, top: (top += 9) + 300, size: 8, bold: false });
const page = (number, lines) => {
  top = 60;
  return { page: number, width: 360, height: 504, lines: [...lines, { text: String(number), x0: 178, top: 478, size: 10, bold: false }] };
};

// Synthetic pages reproducing every layout quirk met in the official 2026 English edition.
const PAGES = [
  page(1, [line('CONTENTS', { x0: 154, size: 10 }), line('PREAMBLE', { x0: 150 }), line('1. Name and territory of the Union.', { x0: 48 })]),
  page(2, [
    line('THE CONSTITUTION OF INDIA', { x0: 90, size: 11, bold: true }),
    line('PREAMBLE', { x0: 154, size: 8, bold: true }),
    line('WE, THE PEOPLE OF INDIA, having solemnly resolved to constitute', { x0: 60 }),
    line('India into a 1[SOVEREIGN SOCIALIST SECULAR DEMOCRATIC'),
    line('REPUBLIC] and to secure to all its citizens.'),
    footnote('1. Subs. by the Constitution (Forty-second Amendment) Act, 1976, s.2, for "SOVEREIGN'),
    footnote('DEMOCRATIC REPUBLIC" (w.e.f. 3-1-1977).', 44.4),
  ]),
  page(3, [
    line('PART III', { x0: 160, bold: true }),
    line('FUNDAMENTAL RIGHTS', { x0: 110 }),
    line('Right to Freedom', { x0: 148 }),
    line('21. Protection of life and personal liberty.—No person shall be', { x0: 60 }),
    line('deprived of his life or personal liberty except according to procedure established'),
    line('by law.'),
    line('2[21A. Right to education.—The State shall provide free and compulsory', { x0: 60 }),
    line('education to all children.]'),
    line('22. Protection against arrest and detention in', { x0: 60, bold: true }),
    line('certain cases.—(1) No person who is arrested shall be detained.', { bold: true }),
    line(`${STAR}(4) No law providing for preventive detention shall authorise detention.`, { x0: 60 }),
    footnote('2 Ins. by the Constitution (Eighty-sixth Amendment) Act, 2002, s. 2 (w.e.f. 1-4-2010)'),
    footnote(`${STAR} Cl. (4) shall stand substituted by the Constitution (Forty-fourth Amendment) Act, 1978, s. 3 (date yet to be notified).`),
  ]),
  page(4, [
    line('23. Prohibition of traffic in human beings.—(1) Traffic in human beings is prohibited.', { x0: 60 }),
    line('3[(2) Nothing in this article shall prevent the State from imposing service.]', { x0: 60 }),
    line('724. [Saving of laws in respect of anti-national activities.].—Omitted by', { x0: 62.4 }),
    line('the Constitution (Forty-third Amendment) Act,1977, s. 2 (w.e.f.13-4-1978).'),
    line('5. Things to be done in good faith.—This stray numbered line is not an article.', { x0: 60 }),
    footnote('3. Subs. by the Constitution (Ninety-ninth Amendment) Act, 2014, s. 3 (w.e.f. 13-4-2015). This amendment has'),
    footnote('been struck down by the Supreme Court.', 44.4),
    footnote('7. Ins. by the Constitution (Forty-second Amendment) Act, 1976, s. 5 (w.e.f. 03-01-1977).'),
  ]),
  page(5, [
    line('CHAPTER I.—THE EXECUTIVE', { x0: 110 }),
    line('The President and Vice-President', { x0: 120 }),
    line('25. Freedom of conscience.—All persons are equally entitled to form a co-', { x0: 60 }),
    line('operative society.'),
    line('Provided that nothing here applies.', { x0: 60 }),
  ]),
  page(6, [
    line('1[FIRST SCHEDULE', { x0: 134, bold: true }),
    line('[Articles 1 and 4]', { x0: 150 }),
    line('1. Andhra Pradesh', { x0: 60 }),
    footnote('1. Subs. by the Constitution (Seventh Amendment) Act, 1956, s. 2 (w.e.f. 1-11-1956).'),
  ]),
  page(7, [
    line('[Articles 59(3), 65(3) and 221]', { x0: 45 }),
    line('PART A', { x0: 160, bold: true }),
    line('1. There shall be paid to the President 10,000 rupees.', { x0: 60 }),
  ]),
  page(8, [line('APPENDIX I', { x0: 154, bold: true }), line('99. Not part of the Constitution.—Ignored.', { x0: 60 })]),
];

const byLabel = (provisions) => Object.fromEntries(provisions.map((p) => [p.label, p]));

test('stripMarkers removes only footnote markers that exist on the page', () => {
  assert.deepEqual(stripMarkers('under article 3172[the words]', new Set(['2'])), { text: 'under article 317[the words]', refs: ['2'] });
  assert.deepEqual(stripMarkers('**(b) the maximum period', new Set(['**'])), { text: '(b) the maximum period', refs: ['**'] });
  assert.deepEqual(stripMarkers('the 1* * * States', new Set(['1'])), { text: 'the * * * States', refs: ['1'] });
  assert.deepEqual(stripMarkers('kept * * * omission', new Set(['*'])), { text: 'kept * * * omission', refs: [] });
  assert.deepEqual(stripMarkers('19 or article 31', new Set(['1', '9'])), { text: '19 or article 31', refs: [] });
  assert.deepEqual(stripMarkers('clause 4[x]', new Set(['3'])), { text: 'clause 4[x]', refs: [] });
});

test('parseConstitution reads the Preamble, articles and schedules in order, and nothing outside them', () => {
  const { provisions } = parseConstitution(PAGES);
  assert.deepEqual(provisions.map((p) => p.label), ['Preamble', 'Art.21', 'Art.21A', 'Art.22', 'Art.23', 'Art.24', 'Art.25', 'Sch.1', 'Sch.2']);
  assert.equal(provisions.some((p) => /Not part of the Constitution|Name and territory/.test(p.text)), false);
});

test('amendment footnotes give each provision its in-force date and amending Act', () => {
  const p = byLabel(parseConstitution(PAGES).provisions);
  assert.equal(p.Preamble.text, 'WE, THE PEOPLE OF INDIA, having solemnly resolved to constitute India into a [SOVEREIGN SOCIALIST SECULAR DEMOCRATIC REPUBLIC] and to secure to all its citizens.');
  assert.equal(p.Preamble.validFrom, '1977-01-03');
  assert.equal(p.Preamble.amendedByRef, 'Constitution (Forty-second Amendment) Act, 1976');

  assert.equal(p['Art.21'].validFrom, '1950-01-26');
  assert.equal(p['Art.21'].amendedByRef, null);
  assert.equal(p['Art.21A'].text, 'The State shall provide free and compulsory education to all children.', 'marker and wrapper bracket removed');
  assert.equal(p['Art.21A'].validFrom, '2010-04-01', 'footnote printed without its full stop still counts');
  assert.equal(p['Sch.1'].validFrom, '1956-11-01');
});

test('structure: Part, group and Chapter headings, wrapped headings, paragraphs and hyphenation', () => {
  const p = byLabel(parseConstitution(PAGES).provisions);
  assert.equal(p['Art.21'].part, 'PART III — FUNDAMENTAL RIGHTS');
  assert.equal(p['Art.21'].group, 'Right to Freedom');
  assert.equal(p['Art.21'].heading, 'Protection of life and personal liberty.');
  assert.equal(p['Art.21'].text, 'No person shall be deprived of his life or personal liberty except according to procedure established by law.');
  assert.equal(p['Art.22'].heading, 'Protection against arrest and detention in certain cases.');
  assert.equal(p['Art.22'].text, '(1) No person who is arrested shall be detained.\n(4) No law providing for preventive detention shall authorise detention.');
  assert.equal(p['Art.25'].chapter, 'CHAPTER I.—THE EXECUTIVE');
  assert.equal(p['Art.25'].group, 'The President and Vice-President');
  assert.equal(p['Art.25'].text, 'All persons are equally entitled to form a co-operative society.\nProvided that nothing here applies.');
});

test('never-notified amendments stay pending; struck-down amendments are flagged, not trusted', () => {
  const p = byLabel(parseConstitution(PAGES).provisions);
  assert.equal(p['Art.22'].pendingAmendments.length, 1);
  assert.match(p['Art.22'].pendingAmendments[0], /date yet to be notified/);
  assert.equal(p['Art.22'].validFrom, '1950-01-26', 'a pending amendment does not change the in-force date');
  assert.deepEqual(p['Art.22'].footnotes.map((f) => f.n), ['*']);

  assert.equal(p['Art.23'].judicialNotes.length, 1);
  assert.match(p['Art.23'].judicialNotes[0], /struck down by the Supreme Court/);
  assert.equal(p['Art.21'].judicialNotes.length, 0);
});

test('a footnote marker glued to an article number is recovered, and omitted articles are dated', () => {
  const { provisions, warnings } = parseConstitution(PAGES);
  const omitted = byLabel(provisions)['Art.24'];
  assert.equal(omitted.heading, '[Saving of laws in respect of anti-national activities.]');
  assert.equal(omitted.omitted, true);
  assert.equal(omitted.validFrom, '1978-04-13');
  assert.equal(omitted.amendedByRef, 'Constitution (Forty-third Amendment) Act,1977');
  assert.deepEqual(omitted.footnotes.map((f) => f.n), ['7']);
  assert.ok(warnings.some((w) => /"5\. Things to be done in good faith/.test(w)), 'out-of-sequence numbered line is reported');
  assert.match(omitted.text, /This stray numbered line is not an article/, '...and kept as text, not dropped');
});

test('schedules: headings, basis lines, and a heading missing from the text layer is inferred and reported', () => {
  const { provisions, warnings } = parseConstitution(PAGES);
  const p = byLabel(provisions);
  assert.equal(p['Sch.1'].heading, 'First Schedule [Articles 1 and 4]');
  assert.equal(p['Sch.1'].text, '1. Andhra Pradesh');
  assert.equal(p['Sch.2'].heading, 'Second Schedule [Articles 59(3), 65(3) and 221]');
  assert.match(p['Sch.2'].text, /^PART A/);
  assert.ok(warnings.some((w) => /heading for Sch\.2 missing from the text layer/.test(w)));
});

test('a running head and Part caption at the top of a page never land inside the provision that spans it', () => {
  const at = (text, lineTop, { x0 = 60, size = 9 } = {}) => ({ text, x0, top: lineTop, size, bold: false });
  const { provisions } = parseConstitution([
    {
      page: 1, width: 360, height: 504, lines: [
        { text: 'THE CONSTITUTION OF INDIA', x0: 90, top: 40, size: 11, bold: true },
        at('PREAMBLE', 51, { x0: 154, size: 8 }),
        at('WE, THE PEOPLE OF INDIA, having solemnly resolved to constitute India.', 62),
        at('PART I', 73, { x0: 160 }),
        at('UNION AND ITS TERRITORY', 84, { x0: 110 }),
        at('3. Formation of new States.—Parliament may by law— (e) alter the name of any State:', 95),
        at('2', 478, { x0: 178, size: 10 }),
      ],
    },
    {
      page: 2, width: 360, height: 504, lines: [
        at('3 THE CONSTITUTION OF INDIA', 37.4, { x0: 36 }),
        at('(Part I.—Union and its territory)', 53.9, { x0: 114.8, size: 10 }),
        at('Provided that no Bill for the purpose shall be introduced in either House.', 72.1),
        at('3', 478, { x0: 178, size: 10 }),
      ],
    },
  ]);
  const art3 = provisions.find((provision) => provision.label === 'Art.3');
  assert.equal(art3.text, 'Parliament may by law— (e) alter the name of any State:\nProvided that no Bill for the purpose shall be introduced in either House.');
});

test('ingestConstitution stores versioned provisions with provenance, idempotently', async () => {
  const store = openLegalStore(':memory:');
  try {
    const url = 'https://www.legislative.gov.in/static/uploads/2025/07/coi.pdf';
    store.registerSource({ id: 'legislative', name: 'Legislative Department', tier: 0, baseUrl: 'https://legislative.gov.in' });
    store.recordFetch({ sourceId: 'legislative', url, method: 'manual', sha256: 'f00d', rawPath: '/vault/f0/f00d' });

    const extract = async (rawPath) => {
      assert.equal(rawPath, '/vault/f0/f00d');
      return PAGES;
    };
    const result = await ingestConstitution({ store, url, extract });
    assert.equal(result.provisions, 9);
    assert.deepEqual(result.pendingAmendments, ['Art.22']);
    assert.deepEqual(result.judiciallyInvalidated, ['Art.23']);

    const actId = result.actId;
    const art21A = store.getProvisionAsOf({ actId, label: 'Art.21A', date: '2026-10-12' });
    assert.equal(art21A.source_sha256, 'f00d');
    assert.equal(art21A.source_url, url);
    assert.equal(JSON.parse(art21A.context).group, 'Right to Freedom');
    assert.equal(store.getProvisionAsOf({ actId, label: 'Art.21A', date: '2009-12-31' }), null, 'no text before it took effect');
    assert.equal(JSON.parse(store.getProvisionAsOf({ actId, label: 'Art.23', date: '2026-10-12' }).footnotes)[0].invalidated, true);

    await ingestConstitution({ store, url, extract });
    assert.equal(store.searchProvisions('personal liberty').length, 1, 're-ingest does not duplicate');

    await assert.rejects(ingestConstitution({ store, url: 'https://legislative.gov.in/other.pdf', extract }), /No stored copy/);
  } finally {
    store.close();
  }
});
