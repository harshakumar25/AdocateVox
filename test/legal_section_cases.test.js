import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { codeSectionGroups } from '../src/parse/scMetadata.js';
import { casesForProvision } from '../src/cases/service.js';

test('headnote catchwords name sections of the criminal codes, in every printed form', () => {
  const read = (text) => codeSectionGroups(text).map(({ act, label, group }) => `${act} ${label}@${group}`);
  assert.deepEqual(read('Penal Code, 1860 – s.306 – Abetment of suicide'), ['IPC s.306@0']);
  assert.deepEqual(read('Indian Penal Code, 1860 : Sections 120-B, 420/34 and 477-A. Prevention of Corruption Act'),
    ['IPC s.120B@0', 'IPC s.420@0', 'IPC s.34@0', 'IPC s.477A@0']);
  assert.deepEqual(read('Penal Code, 1860 - ss.323, c 324 and 302 - Quarrel'), ['IPC s.323@0', 'IPC s.324@0', 'IPC s.302@0'],
    'a lone margin letter from the printed page is skipped');
  assert.deepEqual(read('Evidence Act, 1872 - s.32 - Dying declaration; Penal Code, 1860 - s.302'), ['IEA s.32@0', 'IPC s.302@1']);
  assert.deepEqual(read('Code of Criminal Procedure, 1898 - s.488'), ['CrPC1898 s.488@0'], 'the 1898 Code is kept apart');
  assert.deepEqual(read('Code of Criminal Procedure, 1973 - s.482 - Quashing'), ['CrPC s.482@0']);
  assert.deepEqual(codeSectionGroups('Code of Criminal Procedure-Section 342-Examination of accused', { decidedOn: '1960-05-01' }).map((item) => item.act),
    ['CrPC1898'], 'before 1 April 1974, "the Code" is the 1898 Code');
  assert.deepEqual(codeSectionGroups('Code of Criminal Procedure-Section 342', { decidedOn: '1990-05-01' }).map((item) => item.act), ['CrPC']);
  assert.deepEqual(read('Penal Code, 1860 - s.9999'), [], 'a section the code does not have is OCR noise');
  assert.deepEqual(read('PENAL CODE, 1860: A B s.304-8 - Dowry death'), ['IPC s.304B@0'], 'capitals, margin letters, "-8" for "-B"');
  assert.deepEqual(read('Indian Penal Code, 1860 : S. 302134-Appellant'), ['IPC s.302@0', 'IPC s.34@0'], '"/" read as "1"');
  assert.deepEqual(read('B Penal Code, I 860: ss.302,394 rlw 397-Robbery'), ['IPC s.302@0', 'IPC s.394@0', 'IPC s.397@0']);
  assert.deepEqual(read('PENAL CODE, 1860: ss:306 and 498A rlw s.34 - Suicidal death'), ['IPC s.306@0', 'IPC s.498A@0', 'IPC s.34@0']);
  assert.deepEqual(read('under Sec. 406 Penal Code for misappropriating'), ['IPC s.406@0'], 'the section written before the code');
  assert.deepEqual(read('Indian Penal Code, 1860-Sections. 302, 34 and 201-Murder'), ['IPC s.302@0', 'IPC s.34@0', 'IPC s.201@0']);
});

test('a BNS section finds the judgments on the IPC section it carries forward, each saying so', () => {
  const store = openLegalStore(':memory:');
  try {
    store.replaceMappings({
      newAct: 'BNS', oldAct: 'IPC', sourceUrl: 'alignment', sourceSha256: 'x',
      entries: [
        { newLabel: 's.310(3)', newTitle: 'Dacoity', oldLabel: 's.396', oldTitle: 'Dacoity with murder', kind: 'mapped', changed: true, chapter: null },
        { newLabel: 's.310(1)', newTitle: 'Dacoity', oldLabel: 's.391', oldTitle: 'Dacoity', kind: 'mapped', changed: false, chapter: null },
      ],
    });
    const add = (key, title, bench, provisions, decidedOn = '1990-01-01') => store.upsertScCase({
      key, title, sourceUrl: `https://x/${key}.json`, pdfUrl: `https://x/${key}.pdf`, decidedOn, benchStrength: bench,
      headnote: 'Penal Code, 1860', provisions,
    });
    add('a', 'STATE versus GANG', 3, [{ act: 'IPC', label: 's.396', group: 0 }]);
    add('b', 'X versus Y', 2, [{ act: 'IPC', label: 's.391', group: 1 }]);
    add('c', 'UNRELATED versus Z', 5, [{ act: 'IPC', label: 's.302', group: 0 }]);

    const result = casesForProvision(store, { provision: 'BNS s.310' });
    assert.equal(result.relation, 'predecessor');
    assert.deepEqual(result.cases.map((card) => card.title), ['STATE versus GANG', 'X versus Y']);
    assert.match(result.cases[0].viaNote, /Decided under IPC s\.396 .* which BNS s\.310\(3\) carries forward with changes to its wording/);
    assert.match(result.cases[1].viaNote, /carries forward unchanged/);
    assert.match(result.cases[0].viaNote, /not the official correspondence table/);
    assert.deepEqual(result.predecessors.map((item) => item.old), ['IPC s.396', 'IPC s.391']);
    assert.equal(casesForProvision(store, { provision: 'IPC 302' }).cases[0].title, 'UNRELATED versus Z', 'old sections can be asked about directly');
    assert.equal(casesForProvision(store, { provision: 'BNS s.999' }).relation, 'none');
    add('d', 'LATER versus STATE', 7, [{ act: 'IPC', label: 's.396', group: 0 }], '2025-04-01');
    const historic = casesForProvision(store, { provision: 'BNS s.310', decidedBy: '2020-01-01' });
    assert.deepEqual(historic.cases.map((card) => card.title), ['STATE versus GANG', 'X versus Y']);
    assert.equal(historic.decidedBy, '2020-01-01');
    assert.equal(casesForProvision(store, { provision: 'BNS s.310', decidedBy: 'not-a-date' }).status, 400);
    assert.equal(casesForProvision(store, { provision: 'BNS s.310', decidedBy: '2020-02-30' }).status, 400);
  } finally {
    store.close();
  }
});
