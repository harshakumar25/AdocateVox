import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import { verifyCaseCitation } from '../src/cases/citationVerify.js';
import { handleLawBuddyApiRoute, LAWBUDDY_FILES } from '../src/routes.js';
import { today } from '../src/service.js';
import { indiaToday } from '../web/common.js';
import { buildPracticePacket, intakeGaps, statuteLeadsFor } from '../web/practiceModel.js';

test('a bail packet uses supplied facts, exposes gaps and leaves research leads separate', () => {
  const input = {
    kind: 'anticipatory-bail', clientName: 'A. Kumar', court: 'Court of Session, Example District',
    incidentDate: '2024-09-10', allegations: 'The FIR alleges document alteration.',
    chronology: '2024-09-10 | document received | file p. 3',
    evidence: 'Original document | provenance | file p. 3',
    response: 'The applicant disputes authorship of the alteration.',
  };
  const packet = buildPracticePacket(input, { cases: [{ id: 1, title: 'Example v. State', citations: ['2024 INSC 1'], pdfUrl: 'https://example.org/1.pdf' }] });
  assert.match(packet.draft, /The FIR alleges document alteration\./);
  assert.match(packet.draft, /disputes authorship/);
  assert.match(packet.draft, /\[confirm from the source record\]/);
  assert.ok(packet.gaps.includes('Earlier bail applications and orders, including adverse orders'));
  assert.equal(packet.statuteLeads[0].verification, null);
  assert.equal(packet.caseLeads[0].title, 'Example v. State');
  assert.doesNotMatch(packet.draft, /Example v\. State|2024 INSC 1|cooperated with the investigation/);
});

test('FIR information is a request to record, not an invented registered FIR; old incidents trigger transition review', () => {
  const packet = buildPracticePacket({
    kind: 'fir-information', clientName: 'P. Sen', incidentDate: '2023-11-01',
    policeStation: 'Example Police Station', location: 'Example district',
    allegations: 'A parcel was missing on arrival.', chronology: '2023-11-01 | parcel sent | receipt 7',
    evidence: 'Dispatch receipt 7',
  });
  assert.match(packet.draft, /request to record and act/);
  assert.doesNotMatch(packet.draft, /FIR registered|accused is guilty/);
  assert.match(packet.transition, /predates 1 July 2024/);
  assert.deepEqual(packet.statuteLeads.map((item) => `${item.act} ${item.section}`), ['BNSS 173']);
  assert.equal(intakeGaps({ kind: 'regular-bail' }).includes('Arrest and custody dates with remand records'), true);
});

test('a historical filing searches the prior procedure code and discloses the missing dated text', () => {
  const historical = buildPracticePacket({ kind: 'regular-bail', filingDate: '2023-12-15', incidentDate: '2023-11-01' });
  assert.deepEqual(historical.statuteLeads.map((item) => `${item.act} ${item.section}`), ['CrPC 437', 'CrPC 439']);
  assert.match(historical.transition, /does not yet hold verified historical section text/);
  const present = buildPracticePacket({ kind: 'regular-bail', filingDate: '2026-10-18', incidentDate: '2023-11-01' });
  assert.deepEqual(present.statuteLeads.map((item) => `${item.act} ${item.section}`), ['BNSS 480', 'BNSS 483']);
  assert.match(present.transition, /repeal-and-savings/);
});

test('bail forum, incident, FIR station and filing place remain distinct; wrong forum and express exclusion stop copying', () => {
  const matter = {
    kind: 'anticipatory-bail', clientName: 'A. Kumar', court: 'Metropolitan Magistrate', courtLevel: 'magistrate',
    courtDistrict: 'Delhi', courtState: 'Delhi', jurisdictionBasis: 'Counsel to review forum',
    incidentPlace: 'Faridabad, Haryana', casePoliceStation: 'Sector 15 Police Station, Haryana',
    filingPlace: 'New Delhi', offenceSections: 'BNS section 65', filingDate: '2026-10-18',
  };
  const packet = buildPracticePacket(matter);
  assert.match(packet.draft, /Place of alleged occurrence: Faridabad, Haryana/);
  assert.match(packet.draft, /Police station: Sector 15 Police Station, Haryana/);
  assert.match(packet.draft, /Place of filing \/ presentation: New Delhi/);
  assert.equal(packet.blockers.length, 2);
  assert.match(packet.blockers.join(' '), /Magistrate/);
  assert.match(packet.blockers.join(' '), /482\(4\)/);
  assert.doesNotMatch(packet.draft, /annexed hereto|territorial jurisdiction is established/);
  const reverseOrder = buildPracticePacket({ ...matter, courtLevel: 'sessions', offenceSections: 'section 70(2) of the BNS' });
  assert.equal(reverseOrder.blockers.length, 1);
});

test('regular bail selects the court-level provision while unknown forum preserves alternatives for review', () => {
  assert.deepEqual(statuteLeadsFor('regular-bail', '2026-10-18', 'magistrate').map((x) => x.section), ['480']);
  assert.deepEqual(statuteLeadsFor('regular-bail', '2026-10-18', 'sessions').map((x) => x.section), ['483']);
  assert.deepEqual(statuteLeadsFor('regular-bail', '2023-12-01', 'high-court').map((x) => x.section), ['439']);
  assert.deepEqual(statuteLeadsFor('regular-bail', '2026-10-18').map((x) => x.section), ['480', '483']);
});

test('a receiving police station outside the occurrence district is not treated as a filing error', () => {
  const packet = buildPracticePacket({ kind: 'fir-information', policeStation: 'Station A, Delhi', incidentPlace: 'Noida, Uttar Pradesh' });
  assert.equal(packet.blockers.length, 0);
  assert.match(packet.draft, /Station A, Delhi/);
  assert.match(packet.draft, /Noida, Uttar Pradesh/);
  assert.match(packet.jurisdictionReview.join(' '), /receiving station may differ/i);
});

test('civil adjournment has a separate form and does not turn counsel engagement into sufficient cause', () => {
  const packet = buildPracticePacket({
    kind: 'civil-adjournment', court: 'Civil Judge', caseNumber: 'CS 25/2026', hearingDate: '2026-11-01',
    hearingStage: 'Plaintiff evidence', adjournmentReason: 'Counsel engaged in another court',
    witnessStatus: 'One witness listed', priorAdjournments: 'Two', adjournmentRelief: 'One week',
  });
  assert.match(packet.draft, /Order XVII rule 1 CPC/);
  assert.match(packet.draft, /Plaintiff evidence/);
  assert.doesNotMatch(packet.draft, /PRAYER[\s\S]*release on bail/);
  assert.equal(packet.blockers.length, 1);
  assert.deepEqual(packet.statuteLeads.map((x) => x.act), ['CPC']);
});

test('research opinion keeps assumptions apart from facts and does not invent authorities', () => {
  const packet = buildPracticePacket({ kind: 'legal-opinion', clientName: 'Client', opinionQuestion: 'Is the notice valid?',
    opinionFacts: 'Notice delivered | receipt p. 2', opinionAssumptions: 'Service date disputed',
    opinionConclusion: 'Further evidence required', filingDate: '2026-10-18' });
  assert.equal(packet.family, 'research');
  assert.equal(packet.statuteLeads.length, 0);
  assert.match(packet.draft, /Material facts established[\s\S]*Notice delivered/);
  assert.match(packet.draft, /Instructions or assumptions[\s\S]*Service date disputed/);
  assert.match(packet.draft, /\[statute provision or judgment paragraph/);
  assert.doesNotMatch(packet.draft, /2026 INSC|the law clearly/);
});

test('the default legal research date follows India time across the UTC midnight boundary', () => {
  const instant = new Date('2026-10-17T20:30:00Z');
  assert.equal(today(instant), '2026-10-18');
  assert.equal(indiaToday(instant), '2026-10-18');
});

test('case citation identity is checked against the index without claiming its holding', () => {
  const store = openLegalStore(':memory:');
  try {
    const id = store.addCase({ court: 'SC', title: 'Maneka Gandhi v. Union of India', decidedOn: '1978-01-25', benchStrength: 7 });
    store.addCitationAlias(id, { scheme: 'AIR', normalized: 'AIR 1978 SC 597' });
    const found = verifyCaseCitation(store, 'air 1978 sc 597');
    assert.equal(found.verified, true);
    assert.equal(found.case.title, 'Maneka Gandhi v. Union of India');
    assert.match(found.note, /holding/);
    const missing = verifyCaseCitation(store, '2024 INSC 1');
    assert.equal(missing.verified, false);
    assert.match(missing.reason, /coverage gap/);
    const otherCourt = verifyCaseCitation(store, '2023:DHC:1234');
    assert.equal(otherCourt.verified, false);
    assert.match(otherCourt.reason, /another court/);
    assert.equal(verifyCaseCitation(store, 'not a citation').status, 400);
  } finally {
    store.close();
  }
});

test('practice page and citation endpoint are wired into the app', async () => {
  assert.match(LAWBUDDY_FILES['/lawbuddy/practice'][0], /web[\\/]practice\.html$/);
  const store = openLegalStore(':memory:');
  try {
    let sent;
    const parsedUrl = new URL('http://localhost/lawbuddy/api/citation?citation=2024%20INSC%201');
    await handleLawBuddyApiRoute({ method: 'GET' }, {}, {
      pathname: parsedUrl.pathname, parsedUrl, legalLibrary: { get: async () => store },
      sendJson: (res, code, body) => { sent = { code, body }; },
    });
    assert.equal(sent.code, 200);
    assert.equal(sent.body.verified, false);
  } finally {
    store.close();
  }
});
