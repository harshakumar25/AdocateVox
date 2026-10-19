/**
 * A local, deterministic preparation packet. Matter facts never leave this module for drafting.
 * The packet is an editable working draft: every factual sentence comes from the user's intake,
 * and statutes/cases remain research leads until a lawyer verifies applicability and holding.
 */

export const PRACTICE_WORKFLOWS = Object.freeze({
  'fir-information': Object.freeze({
    title: 'Information for police / FIR request',
    statute: Object.freeze([{ act: 'BNSS', section: '173', purpose: 'Recording information about a cognizable offence' }]),
    historicalStatute: Object.freeze([{ act: 'CrPC', section: '154', purpose: 'Recording information about a cognizable offence under the prior Code' }]),
  }),
  'anticipatory-bail': Object.freeze({
    title: 'Anticipatory bail',
    statute: Object.freeze([{ act: 'BNSS', section: '482', purpose: 'Direction for bail in the event of arrest' }]),
    historicalStatute: Object.freeze([{ act: 'CrPC', section: '438', purpose: 'Direction for bail in the event of arrest under the prior Code' }]),
  }),
  'regular-bail': Object.freeze({
    title: 'Regular bail',
    statute: Object.freeze([
      { act: 'BNSS', section: '480', purpose: 'Bail in a non-bailable offence before the competent court' },
      { act: 'BNSS', section: '483', purpose: 'Special powers of the High Court or Court of Session' },
    ]),
    historicalStatute: Object.freeze([
      { act: 'CrPC', section: '437', purpose: 'Bail in a non-bailable offence before the competent court under the prior Code' },
      { act: 'CrPC', section: '439', purpose: 'Special powers of the High Court or Court of Session under the prior Code' },
    ]),
  }),
  'civil-adjournment': Object.freeze({
    title: 'Civil hearing adjournment',
    family: 'litigation',
    statute: Object.freeze([{ act: 'CPC', section: 'Order XVII rule 1', purpose: 'Adjournment of a civil suit on sufficient cause' }]),
    historicalStatute: Object.freeze([{ act: 'CPC', section: 'Order XVII rule 1', purpose: 'Adjournment of a civil suit on sufficient cause' }]),
  }),
  'legal-opinion': Object.freeze({
    title: 'Research-based legal opinion',
    family: 'research',
    statute: Object.freeze([]),
    historicalStatute: Object.freeze([]),
  }),
});

const CRIMINAL_CODE_TRANSITION = '2024-07-01';
export const statuteLeadsFor = (kind, filingDate, courtLevel) => {
  const workflow = PRACTICE_WORKFLOWS[kind];
  if (!workflow) return [];
  const leads = clean(filingDate) && filingDate < CRIMINAL_CODE_TRANSITION ? workflow.historicalStatute : workflow.statute;
  if (kind !== 'regular-bail') return leads;
  if (courtLevel === 'magistrate') return leads.filter((lead) => ['437', '480'].includes(lead.section));
  if (courtLevel === 'sessions' || courtLevel === 'high-court') return leads.filter((lead) => ['439', '483'].includes(lead.section));
  return leads;
};

const clean = (value) => String(value ?? '').trim();
const supplied = (value, placeholder) => clean(value) || `[${placeholder}]`;
const lineItems = (value) => clean(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const numbered = (items, empty) => items.length ? items.map((item, index) => `${index + 1}. ${item}`).join('\n') : `[${empty}]`;

const sourceStatement = (label, value) => `${label}: ${supplied(value, 'confirm from the source record')}`;
const location = (matter) => clean(matter.incidentPlace) || clean(matter.location);
const counselCheck = (value, label) => `${label}: ${supplied(value, 'verify from the file and local rules')}`;
const isBnsExcluded = (sections) => {
  const text = clean(sections);
  return /\b(?:BNS|Bharatiya Nyaya Sanhita)\s*(?:s(?:ections?)?\.?)?\s*(?:65\b|70\s*\(\s*2\s*\))/i.test(text)
    || /\b(?:s(?:ections?)?\.?)?\s*(?:65\b|70\s*\(\s*2\s*\))\s*(?:of\s+the\s+)?(?:BNS|Bharatiya Nyaya Sanhita)\b/i.test(text);
};
const courtLevelLabel = (level) => ({ 'sessions': 'Court of Session', 'high-court': 'High Court', magistrate: 'Magistrate' })[level] || level;

export const jurisdictionReview = (matter) => {
  const kind = matter?.kind;
  const review = [];
  const blockers = [];
  if (kind === 'fir-information') {
    if (!clean(matter.policeStation)) review.push('Identify the station or officer receiving this information.');
    if (!location(matter)) review.push('Identify the place of occurrence separately from the receiving station.');
    review.push('A receiving station may differ from the place of occurrence. Confirm routing and acknowledgement; do not assume an FIR number.');
  } else if (kind === 'legal-opinion') {
    if (!clean(matter.opinionJurisdiction)) review.push('Define the jurisdiction, issue date and temporal scope of the opinion.');
    review.push('An opinion must distinguish instructions, verified record, assumptions and the limits of the authorities reviewed.');
  } else {
    if (!clean(matter.court)) review.push('Enter the actual court or forum named for filing.');
    if (!clean(matter.courtDistrict) || !clean(matter.courtState)) review.push('Confirm the court district and State or Union Territory.');
    if (!clean(matter.jurisdictionBasis)) review.push('Record why this forum has territorial and subject-matter jurisdiction.');
    if (!clean(matter.filingPlace)) review.push('Confirm the place of filing or presentation.');
    if (kind === 'anticipatory-bail') {
      if (matter.courtLevel === 'magistrate') blockers.push('BNSS section 482 / CrPC section 438 names the High Court or Court of Session; a Magistrate is not the forum for this application.');
      if (!['sessions', 'high-court'].includes(matter.courtLevel)) review.push('Select and verify a High Court or Court of Session for pre-arrest bail.');
      if (isBnsExcluded(matter.offenceSections || '') && !(clean(matter.filingDate) && matter.filingDate < CRIMINAL_CODE_TRANSITION)) blockers.push('BNSS section 482(4) excludes accusations under BNS section 65 or section 70(2). Verify the recorded section and any applicable remedy before using this draft.');
    }
    if (kind === 'regular-bail' && !['magistrate', 'sessions', 'high-court'].includes(matter.courtLevel)) review.push('Select the court level to distinguish BNSS 480/483 or CrPC 437/439.');
    if (kind === 'civil-adjournment' && !clean(matter.caseNumber)) review.push('Confirm the suit or proceeding number and current listing.');
  }
  if (clean(matter.specialLaw)) review.push(`Check any restriction, notice requirement or special forum under ${clean(matter.specialLaw)} against its current official text.`);
  return { review, blockers };
};

/** Lists facts the lawyer must establish before a filing or oral submission. */
export const intakeGaps = (matter) => {
  const kind = matter?.kind;
  if (!PRACTICE_WORKFLOWS[kind]) return ['Select a supported workflow.'];
  const gaps = [];
  if (!clean(matter.clientName)) gaps.push(kind === 'fir-information' ? 'Complainant or informant identity' : kind === 'legal-opinion' ? 'Client or instructing counsel identity' : 'Applicant identity');
  if (!['civil-adjournment', 'legal-opinion'].includes(kind) && !clean(matter.incidentDate)) gaps.push('Date or period of the incident');
  if (!clean(matter.filingDate)) gaps.push(kind === 'legal-opinion' ? 'Opinion date' : 'Planned filing or submission date');
  if (!['civil-adjournment', 'legal-opinion'].includes(kind)) {
    if (!lineItems(matter.chronology).length) gaps.push('Dated chronology tied to records or witnesses');
    if (!clean(matter.allegations)) gaps.push('The complaint or prosecution allegation in its strongest fair form');
    if (!clean(matter.evidence)) gaps.push('Documents, witnesses and their source or page references');
  }
  if (kind === 'fir-information') {
    if (!clean(matter.policeStation)) gaps.push('Police station or receiving officer');
    if (!location(matter)) gaps.push('Where the incident occurred');
  } else if (kind === 'legal-opinion') {
    if (!clean(matter.opinionQuestion)) gaps.push('The exact question the opinion is to answer');
    if (!clean(matter.opinionJurisdiction)) gaps.push('Jurisdiction and applicable date');
    if (!clean(matter.opinionFacts)) gaps.push('Material facts with source references');
    if (!clean(matter.opinionAuthorities)) gaps.push('Primary statutes and judgments with exact provisions or paragraphs');
    if (!clean(matter.opinionAnalysis)) gaps.push('Issue-by-issue analysis, including contrary material');
    if (!clean(matter.opinionConclusion)) gaps.push('Bounded conclusion and unresolved questions');
  } else if (kind === 'civil-adjournment') {
    if (!clean(matter.court)) gaps.push('Court and proceeding');
    if (!clean(matter.caseNumber)) gaps.push('Suit or proceeding number');
    if (!clean(matter.hearingDate)) gaps.push('Current hearing date and stage');
    if (!clean(matter.hearingStage)) gaps.push('Current hearing stage or step listed');
    if (!clean(matter.adjournmentReason)) gaps.push('Specific cause for adjournment with supporting record');
    if (!clean(matter.witnessStatus)) gaps.push('Whether witnesses are present and what evidence is scheduled');
    if (!clean(matter.priorAdjournments)) gaps.push('Earlier adjournments taken by this party during hearing');
    if (!clean(matter.adjournmentRelief)) gaps.push('Requested next date or limited accommodation');
  } else {
    if (!clean(matter.court)) gaps.push('Competent court and local filing rules');
    if (!clean(matter.caseNumber)) gaps.push('FIR or case number, if already available');
    if (!clean(matter.offenceSections)) gaps.push('Sections alleged, transcribed from the FIR or complaint');
    if (!clean(matter.response)) gaps.push('Applicant account and response to the allegation');
    if (!clean(matter.priorOrders)) gaps.push('Earlier bail applications and orders, including adverse orders');
    if (!clean(matter.risks)) gaps.push('Flight, witness influence and evidence-tampering risks with a factual answer');
    if (!clean(matter.adverseFacts)) gaps.push('Adverse facts and the answer to each from the record');
    if (!clean(matter.relief)) gaps.push('Precise relief and proposed conditions');
    if (!clean(matter.courtLevel)) gaps.push('Court level and statutory forum');
    if (!clean(matter.casePoliceStation)) gaps.push('Police station named in FIR or case record');
    if (!location(matter)) gaps.push('Place of alleged occurrence, separately from court and police station');
    if (!clean(matter.jurisdictionBasis)) gaps.push('Why the selected court has jurisdiction');
    if (!clean(matter.filingPlace)) gaps.push('Place of filing');
    if (!clean(matter.grounds)) gaps.push('Proposed grounds tied to instructions or source records');
    if (kind === 'regular-bail' && !clean(matter.custodySince)) gaps.push('Arrest and custody dates with remand records');
    if (kind === 'anticipatory-bail' && !clean(matter.arrestConcern)) gaps.push('Specific basis for apprehending arrest');
  }
  return gaps;
};

const draftFir = (matter) => [
  `To\nThe Officer in Charge\n${supplied(matter.policeStation, 'police station and district')}`,
  'Subject: Information concerning a suspected offence; request to record and act on it under applicable law',
  `From: ${supplied(matter.clientName, 'informant name and contact details')}`,
  `Place and date of occurrence: ${supplied(location(matter), 'place')} | ${supplied(matter.incidentDate, 'date / time')}`,
  `Receiving station / officer: ${supplied(matter.policeStation, 'name and district')}`,
  'The receiving station and place of occurrence are recorded separately; routing or territorial allocation should be confirmed by the police.',
  'I provide the following account for recording. It is based on the information and records identified below. Any point not personally witnessed should be identified as such before submission.',
  `Chronology as supplied:\n${numbered(lineItems(matter.chronology), 'insert dated events, with the source of each')}`,
  sourceStatement('Allegation / conduct reported', matter.allegations),
  sourceStatement('Persons and records that may assist verification', matter.evidence),
  sourceStatement('Offence provisions proposed for counsel to verify', matter.offenceSections),
  'Please acknowledge receipt, record the information and take the steps required by the applicable law. I can provide the listed records and clarify the account.',
  `${supplied(matter.clientName, 'signature / name')}\n${supplied(matter.filingDate, 'date of submission')}`,
].join('\n\n');

const draftBail = (matter, anticipatory) => [
  `IN THE COURT OF ${supplied(matter.court, 'competent court')}`,
  `Matter / FIR: ${supplied(matter.caseNumber, 'number and year')} | Police station: ${supplied(matter.casePoliceStation, 'station named in case record')}`,
  `${supplied(matter.clientName, 'applicant')} — Applicant\nVersus\nState / Respondent — Respondent`,
  anticipatory ? 'WORKING DRAFT — APPLICATION SEEKING PROTECTION IN THE EVENT OF ARREST' : 'WORKING DRAFT — APPLICATION FOR RELEASE ON BAIL',
  'Statutory provision, special-law restrictions and local form to be verified by counsel before filing.',
  'FORUM AND JURISDICTION',
  `Court level: ${supplied(courtLevelLabel(matter.courtLevel), 'High Court / Court of Session / Magistrate as applicable')}`,
  `Court location: ${supplied(matter.courtDistrict, 'district')} | ${supplied(matter.courtState, 'State or Union Territory')}`,
  `Place of alleged occurrence: ${supplied(location(matter), 'place and district')}`,
  counselCheck(matter.jurisdictionBasis, 'Basis for this court’s territorial and subject-matter jurisdiction'),
  counselCheck(matter.specialLaw, 'Special statute or special-court restriction, if any'),
  `Place of filing / presentation: ${supplied(matter.filingPlace, 'place of filing')}`,
  'FACTUAL AND PROCEDURAL BACKGROUND',
  sourceStatement('Incident date', matter.incidentDate),
  sourceStatement('Sections alleged, as shown in the FIR / case record', matter.offenceSections),
  sourceStatement('Prosecution / complainant case, stated fairly', matter.allegations),
  `Chronology to verify against the file:\n${numbered(lineItems(matter.chronology), 'insert dated events and record references')}`,
  sourceStatement('Applicant account and response to the allegation', matter.response),
  sourceStatement('Records and witnesses relied upon, with page or source references', matter.evidence),
  `Proposed grounds with record references (not independently verified):\n${numbered(lineItems(matter.grounds), 'insert each ground and its supporting source')}`,
  anticipatory
    ? sourceStatement('Specific basis for apprehending arrest', matter.arrestConcern)
    : sourceStatement('Arrest, custody and remand history', matter.custodySince),
  sourceStatement('Earlier applications / orders; disclose adverse orders', matter.priorOrders),
  sourceStatement('Flight, witness and evidence risks; answer each from the record', matter.risks),
  sourceStatement('Adverse facts requiring candid treatment', matter.adverseFacts),
  sourceStatement('Specific relief and proposed conditions requested', matter.relief),
  `ANNEXURES IDENTIFIED BY COUNSEL\n${numbered(lineItems(matter.annexures), 'list actual documents and page ranges; no annexure is assumed attached')}`,
  'PRAYER\nSubject to counsel verifying the record, forum and applicable law, the applicant requests that the Court consider the relief set out above, subject to such lawful conditions as it considers appropriate.',
  'Verification, affidavit, notice/service, vakalatnama and local form requirements: [check applicable court rules before filing]',
  `Place / date: ${supplied(matter.filingPlace, 'filing place')} / ${supplied(matter.filingDate, 'filing date')}\nCounsel: [name, enrolment and signature]`,
].join('\n\n');

const draftAdjournment = (matter) => [
  `IN THE COURT OF ${supplied(matter.court, 'court and designation')}`,
  `Suit / proceeding: ${supplied(matter.caseNumber, 'number and year')}`,
  `${supplied(matter.clientName, 'applicant / party')} — Applicant`,
  'WORKING DRAFT — APPLICATION FOR ADJOURNMENT OF A CIVIL HEARING',
  'Forum, Order XVII rule 1 CPC, local rules and case-specific directions require counsel review.',
  'FORUM AND LISTING',
  `Court district / State: ${supplied(matter.courtDistrict, 'district')} / ${supplied(matter.courtState, 'State or Union Territory')}`,
  counselCheck(matter.jurisdictionBasis, 'Basis for this forum and current listing'),
  sourceStatement('Current hearing date', matter.hearingDate),
  sourceStatement('Stage or step listed on the order sheet', matter.hearingStage),
  sourceStatement('Specific cause for adjournment and supporting record', matter.adjournmentReason),
  sourceStatement('Whether the cause was within the party’s control and steps taken to avoid delay', matter.mitigation),
  sourceStatement('Witnesses present and evidence scheduled', matter.witnessStatus),
  sourceStatement('Previous adjournments sought by this party during hearing', matter.priorAdjournments),
  sourceStatement('Notice to the other side / response, if known', matter.otherSideNotice),
  sourceStatement('Limited accommodation or next date sought', matter.adjournmentRelief),
  `SUPPORTING RECORD IDENTIFIED BY COUNSEL\n${numbered(lineItems(matter.annexures), 'list actual record and page references; no attachment is assumed')}`,
  'PRAYER\nThe applicant asks the Court to consider the limited accommodation stated above, subject to its assessment of sufficient cause, the hearing stage, witnesses and costs.',
  `Place / date: ${supplied(matter.filingPlace, 'filing place')} / ${supplied(matter.filingDate, 'filing date')}\nCounsel: [name, enrolment and signature]`,
].join('\n\n');

const draftOpinion = (matter) => [
  'PRIVILEGED / CONFIDENTIALITY STATUS: [counsel to determine; label alone does not create privilege]',
  `WORKING LEGAL OPINION\nPrepared for: ${supplied(matter.clientName, 'client or instructing counsel')}\nDate: ${supplied(matter.filingDate, 'opinion date')}`,
  sourceStatement('Question presented', matter.opinionQuestion),
  sourceStatement('Jurisdiction and law as-of date', matter.opinionJurisdiction),
  `MATERIALS REVIEWED\n${numbered(lineItems(matter.opinionMaterials), 'list actual documents, versions and page references')}`,
  sourceStatement('Material facts established by those sources', matter.opinionFacts),
  sourceStatement('Instructions or assumptions that remain unverified', matter.opinionAssumptions),
  `AUTHORITIES TO VERIFY\n${numbered(lineItems(matter.opinionAuthorities), 'statute provision or judgment paragraph with official source and date')}`,
  sourceStatement('Issues and analysis, including contrary law or facts', matter.opinionAnalysis),
  sourceStatement('Conclusion within stated assumptions and limits', matter.opinionConclusion),
  sourceStatement('Further documents, research or action required', matter.opinionNextSteps),
  'This is a working structure. It does not establish that an authority exists, remains good law, or supports the stated proposition. Counsel must verify each source and conclusion.',
].join('\n\n');

const hearingPrompts = (matter) => {
  if (matter.kind === 'legal-opinion') return [
    'Check the exact question, governing jurisdiction and date before finalising the scope.',
    'Mark each fact as a verified record fact, client instruction, inference or assumption.',
    'Read each primary provision and judgment paragraph; record adverse authority and later treatment.',
    'State alternative outcomes if a disputed or missing fact changes the analysis.',
    'Have a second lawyer review the conclusion, citations and practical next steps.',
  ];
  if (matter.kind === 'civil-adjournment') return [
    'Identify the scheduled step, witnesses in attendance and exact time needed; request the narrowest accommodation.',
    'Show the cause and supporting record, what was done to avoid delay, and whether it was beyond the party’s control.',
    'Count previous hearing adjournments taken by this party; check Order XVII rule 1 and current court directions.',
    'Prepare to address inconvenience and costs to the other side; disclose notice or opposition accurately.',
    'A pleader being engaged in another court alone is not a ground under Order XVII rule 1 CPC.',
  ];
  const common = [
    'State the precise relief and the court’s power to grant it; verify forum and any special-statute bar.',
    'Put the strongest adverse fact and the answer on one page. Do not omit an earlier order or contrary record.',
    'For each factual assertion, mark the document, date and page; separate client instructions from verified record.',
    'Check whether each proposed case actually decides the point, its bench, later treatment and factual distinction.',
    'Prepare a short opening, three record-backed points, likely bench questions, and the fallback relief.',
    'Recheck the applicable law on the incident and filing dates, including savings and commencement.',
  ];
  if (matter.kind === 'fir-information') return [
    'Separate what the informant personally saw from information received from others.',
    'Check dates, location, sequence, names, source records and the correct receiving police station.',
    'Check whether the facts disclose a cognizable offence; do not invent sections or intent.',
    'Keep copies of the submission, annexures and acknowledgement; verify the applicable escalation path.',
    ...common.slice(1, 4),
  ];
  return [
    ...common,
    'Be ready to address seriousness, role, custody necessity, cooperation, flight risk and witness or evidence risk on this record.',
    'Take the FIR, arrest/remand papers, earlier bail orders, medical records and documents relied on, if applicable.',
    'Confirm notice/service, affidavit, annexures, pagination and local filing directions for this court.',
  ];
};

/**
 * Produces no legal conclusion. `laws` and `cases` are independently fetched research leads,
 * never inserted as a proposition into the draft without counsel review.
 */
export const buildPracticePacket = (matter, { laws = [], cases = [] } = {}) => {
  const kind = matter?.kind;
  const spec = PRACTICE_WORKFLOWS[kind];
  if (!spec) throw new TypeError('Choose a supported practice workflow.');
  const gaps = intakeGaps(matter);
  const historicalFiling = !['civil-adjournment', 'legal-opinion'].includes(kind) && clean(matter.filingDate) && matter.filingDate < CRIMINAL_CODE_TRANSITION;
  const transition = historicalFiling
    ? 'The planned filing date predates 1 July 2024. The research leads use the CrPC; LawBuddy does not yet hold verified historical section text. Check the official edition and State amendments.'
    : !['civil-adjournment', 'legal-opinion'].includes(kind) && clean(matter.incidentDate) && matter.incidentDate < CRIMINAL_CODE_TRANSITION
      ? 'The incident predates 1 July 2024. Check the old codes, the new codes’ repeal-and-savings clauses, and the procedural stage before choosing provisions.'
      : null;
  const statute = statuteLeadsFor(kind, matter.filingDate, matter.courtLevel);
  const jurisdiction = jurisdictionReview(matter);
  if (kind === 'civil-adjournment' && /engaged\s+in\s+another\s+court/i.test(clean(matter.adjournmentReason))) jurisdiction.blockers.push('Order XVII rule 1 CPC does not treat counsel being engaged in another court as a ground for adjournment.');
  return {
    kind,
    title: spec.title,
    family: spec.family || 'litigation',
    draft: kind === 'fir-information' ? draftFir(matter) : kind === 'civil-adjournment' ? draftAdjournment(matter) : kind === 'legal-opinion' ? draftOpinion(matter) : draftBail(matter, kind === 'anticipatory-bail'),
    gaps,
    jurisdictionReview: jurisdiction.review,
    blockers: jurisdiction.blockers,
    transition,
    hearingPrompts: hearingPrompts(matter),
    argumentGrid: kind === 'legal-opinion' ? [
      { issue: 'Question and legal scope', record: clean(matter.opinionQuestion) || null, answer: clean(matter.opinionJurisdiction) || null },
      { issue: 'What facts can be relied upon?', record: clean(matter.opinionFacts) || null, answer: clean(matter.opinionAssumptions) || null },
      { issue: 'What supports or limits the conclusion?', record: clean(matter.opinionAuthorities) || null, answer: clean(matter.opinionAnalysis) || null },
    ] : kind === 'civil-adjournment' ? [
      { issue: 'Why is more time necessary?', record: clean(matter.adjournmentReason) || null, answer: clean(matter.mitigation) || null },
      { issue: 'What step is due today?', record: [clean(matter.hearingDate), clean(matter.hearingStage)].filter(Boolean).join(' · ') || null, answer: clean(matter.witnessStatus) || null },
      { issue: 'What is the narrowest request?', record: clean(matter.adjournmentRelief) || null, answer: clean(matter.otherSideNotice) || null },
    ] : [
      { issue: 'What is alleged?', record: clean(matter.allegations) || null, answer: clean(matter.response) || null },
      { issue: 'What can be proved now?', record: clean(matter.evidence) || null, answer: null },
      { issue: 'What may be said against us?', record: clean(matter.adverseFacts) || null, answer: clean(matter.risks) || null },
      { issue: 'What relief is requested?', record: clean(matter.relief) || null, answer: null },
    ],
    annexurePlan: lineItems(matter.annexures),
    statuteLeads: statute.map((lead) => ({ ...lead, verification: laws.find((law) => law.act === lead.act && law.label === `s.${lead.section}`) || null })),
    caseLeads: cases.map(({ id, title, citations, decidedOn, status, pdfUrl, viaNote }) => ({ id, title, citations, decidedOn, status, pdfUrl, viaNote })),
    limitations: [
      'Matter facts are user supplied and have not been independently verified.',
      'Research leads are not holdings or advice on outcome. Read the full judgment and later treatment.',
      'Local court rules, special statutes, state amendments and current notifications require a separate check.',
    ],
  };
};
