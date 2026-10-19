import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { CONSTITUTION_ACT } from '../src/ingest/constitution.js';
import { CENTRAL_ACTS, actRecord } from '../src/ingest/act.js';
import { checkDocument, compareByPresence } from '../src/compare/documentCheck.js';

// Distinct, long provisions make it possible to tell an extract from an almost-complete copy.
// These are synthetic legal sentences; the test library is never used as real legal evidence.
const PROVISIONS = [
  {
    label: 'Art.1',
    text: 'Whoever knowingly damages a public record shall be punished with imprisonment for a term which may extend to seven years and shall also be liable to fine.',
  },
  {
    label: 'Art.2',
    text: 'Every person detained by a public officer must receive written notice of the grounds for detention within twenty four hours of the initial arrest.',
  },
  {
    label: 'Art.3',
    text: 'The review board must publish a copy of every rule before entry into force, and the public may submit comments within thirty days after publication. A special council appointed by the executive may cancel the board without reasons.',
    footnotes: [{ invalidated: true, text: 'The printed words about the special council appointed by the executive were struck down.' }],
  },
  {
    label: 'Art.4',
    text: 'A district tribunal shall record the reasons for every order in writing and shall provide a certified copy to each affected party on request.',
  },
  {
    label: 'Art.5',
    text: 'The registrar shall maintain a public register of licenses and disclose the date of each grant renewal suspension and cancellation to applicants.',
  },
  {
    label: 'Art.6',
    text: 'No local authority may collect a service charge until the proposed rate has been published and objections have been heard at an open meeting.',
  },
  {
    label: 'Art.7',
    text: 'An appeal against a final decision may be filed within sixty days and the appellate bench shall give written reasons for its judgment.',
  },
];

const fixtureStore = () => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct(CONSTITUTION_ACT);
  for (const provision of PROVISIONS) {
    const provisionId = store.upsertProvision({ actId, label: provision.label, heading: `Test ${provision.label}` });
    store.addProvisionVersion({
      provisionId,
      text: provision.text,
      validFrom: '1950-01-26',
      sourceUrl: 'https://legislative.gov.in/test-fixture.pdf',
      sourceSha256: 'synthetic-official-sha',
      footnotes: provision.footnotes ?? [],
    });
  }
  return store;
};

const copy = (provisions = PROVISIONS) => `THE CONSTITUTION OF INDIA\n${provisions.map((item) => `${item.label} ${item.text}`).join('\n')}`;

test('one-word penalty and modal changes in an otherwise matching Act are reported', async () => {
  const original = PROVISIONS[0];
  const changed = [
    original.text.replace('seven years', 'ten years'),
    original.text.replace('shall be punished', 'may be punished'),
  ];
  const store = fixtureStore();
  try {
    for (const text of changed) {
      const direct = compareByPresence({ provisions: [original], copyText: text });
      assert.ok(direct.differs.some((item) => item.label === original.label), 'a changed legal word cannot be called formatting');

      const report = await checkDocument({
        store,
        pages: [copy([{ ...original, text }, ...PROVISIONS.slice(1)])],
      });
      assert.equal(report.kind, 'act-copy');
      assert.equal(report.verdict, 'differs');
      assert.ok(report.reworded.some((item) => item.label === original.label));
    }
  } finally {
    store.close();
  }
});

test('a judicial footnote excuses only the specific invalidated wording, not another change', async () => {
  const store = fixtureStore();
  try {
    const altered = PROVISIONS[2].text.replace(
      'the public may submit comments within thirty days after publication',
      'comments may be sent at any time',
    );
    const report = await checkDocument({
      store,
      pages: [copy(PROVISIONS.map((item, index) => index === 2 ? { ...item, text: altered } : item))],
    });
    assert.equal(report.kind, 'act-copy');
    assert.equal(report.verdict, 'differs');
    assert.ok(report.reworded.some((item) => item.label === 'Art.3'), 'unrelated change must remain unresolved');
    assert.ok(!report.explained?.some((item) => item.label === 'Art.3'), 'judicial note must not excuse the whole Article');
  } finally {
    store.close();
  }
});

test('an extract is scoped to its contents; an almost-complete copy omitting a provision needs review', async () => {
  const store = fixtureStore();
  try {
    const extract = await checkDocument({ store, pages: [copy(PROVISIONS.slice(0, 3))] });
    assert.equal(extract.kind, 'act-copy');
    assert.equal(extract.partial, true);
    assert.equal(extract.scope, 'extract');
    assert.equal(extract.counts.present, 3);
    assert.equal(extract.counts.absent, 4);
    assert.equal(extract.verdict, 'matches', 'matching extract means only its contained provisions match');

    const omitted = await checkDocument({ store, pages: [copy(PROVISIONS.slice(0, 6))] });
    assert.equal(omitted.kind, 'act-copy');
    assert.equal(omitted.partial, false);
    assert.equal(omitted.verdict, 'needs-review');
    assert.ok(omitted.absentLabels.includes('Art.7'));
  } finally {
    store.close();
  }
});

test('a substantive write-up is never certified reliable when claim critique is unavailable', async () => {
  const store = fixtureStore();
  try {
    const report = await checkDocument({
      store,
      pages: ['Article 1 gives every person a permanent exemption from taxes and fees in all circumstances, regardless of income or conduct.'],
      critique: async () => null,
    });
    assert.equal(report.kind, 'write-up');
    assert.ok(report.references.some((item) => item.reference === 'Article 1'));
    assert.equal(report.verdict, 'needs-review');
  } finally {
    store.close();
  }
});

const bnsStore = () => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct(actRecord(CENTRAL_ACTS.BNS));
  const add = (label, text, footnotes = []) => {
    const provisionId = store.upsertProvision({ actId, label, heading: label === 's.358' ? 'Repeal and savings' : 'Causing death by negligence' });
    store.addProvisionVersion({
      provisionId,
      text,
      validFrom: '2024-07-01',
      sourceUrl: CENTRAL_ACTS.BNS.officialUrl,
      sourceSha256: 'synthetic-bns-gazette-sha',
      footnotes,
    });
  };
  add('s.106', '(1) Whoever causes the death of any person by doing any rash or negligent act not amounting to culpable homicide shall be punished.\n(2) Whoever causes the death of any person by rash and negligent driving of vehicle and escapes without reporting it shall be punished.', [
    { pending: true, text: CENTRAL_ACTS.BNS.notInForce['s.106'] },
  ]);
  // Exact excerpts from the official BNS s.358 stored in the LawBuddy library.
  add('s.358', [
    '(1) The Indian Penal Code is hereby repealed.',
    '(2) Notwithstanding the repeal of the Code referred to in sub-section (1), it shall not affect,—',
    '(a) the previous operation of the Code so repealed or anything duly done or suffered thereunder; or',
    '(c) any penalty, or punishment incurred in respect of any offences committed against the Code so repealed; or',
    '(e) any proceeding, investigation or remedy in respect of any such penalty or punishment as aforesaid, and any such proceeding or remedy may be instituted, continued or enforced, and any such penalty may be imposed as if that Code had not been repealed.',
  ].join('\n'));
  return store;
};

test('the excluded BNS s.106(2) is not certified in force merely because s.106 exists', async () => {
  const store = bnsStore();
  try {
    const report = await checkDocument({
      store,
      pages: ['BNS section 106(2) is in force and imposes a punishment on every driver in every case of a road accident.'],
      critique: async () => null,
    });
    assert.equal(report.kind, 'write-up');
    const reference = report.references.find((item) => /106\(2\)/.test(item.reference));
    assert.ok(reference, 'the subsection must be preserved in the reported reference');
    assert.equal(reference.status, 'not-in-force');
    assert.equal(report.verdict, 'needs-review');
  } finally {
    store.close();
  }
});

test('a repealed IPC copy shows the BNS savings that preserve earlier acts and proceedings', async () => {
  const store = bnsStore();
  try {
    const ipc = [
      'THE INDIAN PENAL CODE',
      ...Array.from({ length: 20 }, (_, index) => `${index + 1}. Rule number ${index + 1}.— A person shall comply with this provision.`),
    ].join('\n');
    const report = await checkDocument({ store, pages: [ipc] });
    assert.equal(report.kind, 'repealed');
    assert.equal(report.actCode, 'IPC');
    assert.equal(report.repeal.label, 's.358');
    assert.match(report.repeal.text, /previous operation of the Code so repealed/);
    assert.match(report.summary, /sav(?:e|ing)|pre-.*2024|past|earlier/i);
  } finally {
    store.close();
  }
});
