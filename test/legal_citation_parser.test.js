import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, parseCitation } from '../src/parse/citationParser.js';

// [input, scheme, normalized, court]
const SINGLE_CITATIONS = [
  ['2023 INSC 1', 'INSC', '2023 INSC 1', 'SC'],
  ['2023INSC1', 'INSC', '2023 INSC 1', 'SC'],
  ['2024 INSC 512', 'INSC', '2024 INSC 512', 'SC'],
  ['(2017) 10 SCC 1', 'SCC', '(2017) 10 SCC 1', 'SC'],
  ['(1973) 4 SCC 225', 'SCC', '(1973) 4 SCC 225', 'SC'],
  ['(1978) 1 S.C.C. 248', 'SCC', '(1978) 1 SCC 248', 'SC'],
  ['( 1978 ) 1 SCC 248', 'SCC', '(1978) 1 SCC 248', 'SC'],
  ['(1994) Supp (3) SCC 5', 'SCC', '(1994) Supp (3) SCC 5', 'SC'],
  ['(1994) Supp. (3) SCC 5', 'SCC', '(1994) Supp (3) SCC 5', 'SC'],
  ['2017 SCC OnLine SC 996', 'SCC_ONLINE', '2017 SCC OnLine SC 996', 'SC'],
  ['2023 SCC OnLine Del 1234', 'SCC_ONLINE', '2023 SCC OnLine Del 1234', 'Del'],
  ['AIR 1978 SC 597', 'AIR', 'AIR 1978 SC 597', 'SC'],
  ['AIR 1973 SC 1461', 'AIR', 'AIR 1973 SC 1461', 'SC'],
  ['A.I.R. 1990 Del 12', 'AIR', 'AIR 1990 Del 12', 'Del'],
  ['AIR 1960 MP 1', 'AIR', 'AIR 1960 MP 1', 'MP'],
  ['[1978] 2 SCR 621', 'SCR', '[1978] 2 SCR 621', 'SC'],
  ['[1950] SCR 88', 'SCR', '[1950] SCR 88', 'SC'],
  ['[2023] 1 S.C.R. 1', 'SCR', '[2023] 1 SCR 1', 'SC'],
  ['[1973] Supp. S.C.R. 1', 'SCR', '[1973] Supp. SCR 1', 'SC'],
  ['1978 SCR (2) 621', 'SCR', '[1978] 2 SCR 621', 'SC'],
  ['(2017) 10 SCALE 1', 'SCALE', '(2017) 10 SCALE 1', 'SC'],
  ['2017 (10) SCALE 1', 'SCALE', '(2017) 10 SCALE 1', 'SC'],
  ['2023:DHC:1234', 'HC_NEUTRAL', '2023:DHC:1234', 'DHC'],
  ['2023:DHC:1234-DB', 'HC_NEUTRAL', '2023:DHC:1234-DB', 'DHC'],
  ['2024:BHC-AS:1234', 'HC_NEUTRAL', '2024:BHC-AS:1234', 'BHC-AS'],
  ['2023:KER:12345', 'HC_NEUTRAL', '2023:KER:12345', 'KER'],
];

test('parseCitation normalises every supported reporter format', () => {
  for (const [input, scheme, normalized, court] of SINGLE_CITATIONS) {
    const parsed = parseCitation(input);
    assert.ok(parsed, `expected a citation in ${JSON.stringify(input)}`);
    assert.equal(parsed.scheme, scheme, input);
    assert.equal(parsed.normalized, normalized, input);
    assert.equal(parsed.court, court, input);
  }
});

test('parseCitation accepts search-box input in any case and with stray punctuation', () => {
  assert.equal(parseCitation('(2017) 10 scc 1').normalized, '(2017) 10 SCC 1');
  assert.equal(parseCitation('air 1978 sc 597').normalized, 'AIR 1978 SC 597');
  assert.equal(parseCitation('2023 insc 1').normalized, '2023 INSC 1');
  assert.equal(parseCitation('2017 scc online sc 996').normalized, '2017 SCC OnLine SC 996');
  assert.equal(parseCitation('  (1973) 4 SCC 225, ').normalized, '(1973) 4 SCC 225');
});

test('parseCitation extracts year, volume and page as numbers', () => {
  const parsed = parseCitation('(2017) 10 SCC 1');
  assert.equal(parsed.year, 2017);
  assert.equal(parsed.volume, 10);
  assert.equal(parsed.page, 1);
  assert.equal(parseCitation('2023 INSC 1').volume, null);
});

test('parseCitation rejects non-citations, partial input, and implausible values', () => {
  const rejected = [
    '',
    'Maneka Gandhi v. Union of India',
    'Article 21',
    'section 302 IPC',
    'AIR',
    '(2017) SCC 1',
    'meeting at 10:30:15',
    '(1700) 1 SCC 5',
    `(${new Date().getFullYear() + 5}) 1 SCC 5`,
    '(2017) 100 SCC 1',
    '(2017) 10 SCC 1 and AIR 1978 SC 597',
    'see (2017) 10 SCC 1',
    null,
    42,
  ];
  for (const input of rejected) {
    assert.equal(parseCitation(input), null, `expected no citation for ${JSON.stringify(input)}`);
  }
});

test('extractCitations finds parallel citations in judgment prose, in reading order', () => {
  const prose =
    'In Kesavananda Bharati v. State of Kerala, (1973) 4 SCC 225 : AIR 1973 SC 1461, the Court evolved the basic ' +
    'structure doctrine. Maneka Gandhi v. Union of India [1978] 2 SCR 621 followed; see also 2023 INSC 1 and 2023:DHC:1234.';
  const found = extractCitations(prose);
  assert.deepEqual(
    found.map((c) => `${c.scheme}|${c.normalized}`),
    [
      'SCC|(1973) 4 SCC 225',
      'AIR|AIR 1973 SC 1461',
      'SCR|[1978] 2 SCR 621',
      'INSC|2023 INSC 1',
      'HC_NEUTRAL|2023:DHC:1234',
    ],
  );
  for (const citation of found) {
    assert.equal(prose.slice(citation.index, citation.index + citation.raw.length), citation.raw);
  }
});

test('extractCitations never double-counts one span and ignores look-alikes', () => {
  assert.equal(extractCitations('(1994) Supp (3) SCC 5').length, 1);
  assert.equal(extractCitations('2017 SCC OnLine SC 996').length, 1);
  assert.deepEqual(extractCitations('Section 2023 of the Act; 12:30:45; AIR conditioning in 2023'), []);
  assert.deepEqual(extractCitations(undefined), []);
});
