# India drafting engine: research, architecture and release order

**Research snapshot: 18 October 2026.** This is a product and engineering specification, not a statement that every listed instrument is already automated. The live workbench currently produces working structures for police information, anticipatory bail, regular bail, civil adjournment and a legal opinion. The machine-readable [instrument contract](draft-schemas.v1.json) identifies implemented and planned formats.

## Priority decision

The hardest repeated chamber failure is the chain from **wrong or incomplete source record → wrong forum or provision → plausible draft → filing or hearing defect**. The first product should make that chain inspectable. A lawyer should be able to tell which sentence came from a record, which came from instructions, what is missing, what authority supports the legal proposition, and which court rule was checked. More instrument types without those controls would multiply the defect surface.

Release order: (1) dated Bare Act and provision reliability; (2) matter chronology, source references and jurisdiction; (3) bail and common procedural applications; (4) citation/paragraph-grounded research and opinions; (5) high-volume contracts, notices and settlement instruments; (6) court-specific filing preflight. The [BNSS](https://www.indiacode.nic.in/bitstream/123456789/20340/1/bnss%2C_2023.pdf), [CPC](https://www.indiacode.nic.in/bitstream/123456789/2191/1/A1908-05.pdf) and official [eCourts advocate forms](https://services.ecourts.gov.in/ecourtindia_v6/?p=forms_for_advocates%2Findex) show why a single universal pleading template is inadequate.

## A. Drafting taxonomy and instrument boundaries

The title alone does not classify a document. A memorandum of understanding is usually a transaction instrument; a settlement MoU connected to pending litigation also needs a case-disposal path. A “notification” can be subordinate legislation or an administrative communication depending on its enabling power and legal effect. An affidavit may support a pleading or a transaction, but it has its own oath, deponent and verification requirements. A “confession” or admission must never be drafted from model inference; require explicit counsel review of voluntariness, source, procedural setting and consequence.

| Family and first instruments | Purpose / stage and likely recipient | Distinct core structure | Annexures, verification and filing checks |
| --- | --- | --- | --- |
| Transactional: NDA, service agreement, settlement, lease, deed, will, trust | Allocate rights and performance; parties, registrar or other executing authority | Identity/capacity, authority, operative obligation, consideration/property, default, termination, dispute clause, execution, schedules | Title/authority documents, board or personal authority, stamp/registration/tax, witnesses and execution; terms vary by instrument and State. [Contract Act sections 10–14](https://www.indiacode.nic.in/handle/123456789/2187?col=123456789%2F1362) are an initial validity check, not a complete transaction checklist. |
| Litigation initiation: FIR information, plaint, complaint, petition, writ | Start a police/court process | Forum, parties, event and cause of action, dated facts, jurisdiction, relief, verification | Actual source record and list of documents; limitation, valuation/court fee, oath, service and local form. [CPC Order VII rule 1](https://www.indiacode.nic.in/bitstream/123456789/2191/1/A1908-05.pdf) expressly calls for court, parties, cause of action, jurisdiction facts, relief and valuation in a plaint. |
| Litigation interim/procedural: pre-arrest or regular bail, stay, injunction, adjournment, exemption, attendance, memo | Obtain time-limited relief in an existing case | Existing case and order history, urgency, exact power, test for relief, candid adverse facts, narrow prayer | FIR/order sheet/remand papers or other actual record; affidavit, notice, pagination and local directions. [CPC Order XVII rule 1](https://www.indiacode.nic.in/bitstream/123456789/2191/5/190805.pdf) makes a civil adjournment materially different from a bail application. |
| Evidence and witness applications: production, summoning, admission/denial, inspection, recall, electronic record | Secure or challenge a defined evidentiary step | Item/witness identification, relevance, custody/source, disputed fact, prior request and proportional relief | Custody chain, original/copy status, relevant certificate where applicable, service and order history. No generated “admission” without an explicit lawyer-approved statement. |
| Challenge: appeal, revision, review, recall, execution | Challenge or implement a specific order | Impugned order/date, forum power, limitation, permitted grounds, record references, precise relief | Certified/available order, delay/condonation facts, paper book and court-specific appeal rules. A review and appeal are not interchangeable remedies. |
| Legislative: Bill, amendment, ordinance, rule, statutory notification | Change legal norms through competent authority | Competence, long title, extent, commencement, definitions, operative clauses, delegation, transition, repeal/savings | Existing-law comparison, financial/administrative notes, consultation and formal drafting route. Use the Legislative Department’s [Drafting Guide](https://www.legislative.gov.in/static/uploads/2025/09/8a4346215c7e7359773d4b940ed18881.pdf) as a primary reference, then check the specific legislature’s rules. |
| Policy: scheme, guideline, circular, non-statutory notice | Define administrative eligibility and operation | Enabling authority, objective, beneficiaries, benefits/duties, implementation, grievance, review | Budget and approval, equality/accessibility, privacy, publication, consultation and monitoring. Determine whether the instrument is actually delegated legislation before selecting a policy template. |
| Research: opinion, report, commentary, issue note | Answer a bounded question for client, court team or institution | Question, jurisdiction/date, reviewed material, facts/assumptions, primary law, contrary law, analysis, conclusion, limitations | Exact section and judgment paragraph, later treatment, source versions, reviewer and citation check. |

### Critical distinctions within litigation

- **FIR information vs a private complaint:** addressee, statutory path and available case number differ. [BNSS section 173](https://www.indiacode.nic.in/bitstream/123456789/20340/1/bnss%2C_2023.pdf) allows information about a cognizable offence to be given irrespective of where the offence occurred. Record *receiving station* and *occurrence* separately; never fabricate a registered FIR.
- **Pre-arrest vs regular bail:** pre-arrest relief has a different forum and posture. BNSS section 482 names the High Court or Court of Session and subsection (4) excludes the specified BNS accusations. Regular bail requires custody/remand context and a court-level choice between BNSS sections 480 and 483. Earlier orders, special-law restrictions, notice and local rules remain counsel checks. [Primary text](https://www.indiacode.nic.in/bitstream/123456789/20340/1/bnss%2C_2023.pdf).
- **Civil adjournment:** capture the present listing, witnesses, earlier adjournments, specific cause, mitigation and a narrow request. Counsel engaged in another court alone is not a ground under the cited Order XVII rule 1 proviso. [Primary text](https://www.indiacode.nic.in/bitstream/123456789/2191/5/190805.pdf).

## B. Jurisdiction matrix

Capture **six separate facts**: occurrence or cause-of-action place; station or administrative office receiving information; court/authority and level; its district and State/UT; place of presentation; and the legal/factual basis for that forum. Add pecuniary value, stage and enabling special Act when relevant. Geographical proximity is not proof of jurisdiction.

| Matter | Territorial question | Subject matter / monetary / stage question | Forum and legal gate |
| --- | --- | --- | --- |
| Police information | Where did conduct occur? Which station receives the information? These can differ. | Does the supplied conduct disclose a cognizable offence? | Police station; BNSS 173 or historically CrPC 154, then review routing and any special procedure. |
| Pre-arrest bail | What is the FIR/investigation location and why this court? | Is the application before a permitted court? Is there a special-law or BNSS 482(4) bar? | High Court or Court of Session under the applicable procedure; record the territorial basis, do not infer it from a typed court name. |
| Regular bail | Where is the case and custody/remand proceeding? | Court level, offence/triability, special court and custody stage. | Magistrate route or Sessions/High Court route; select provision by forum, not by convenience. |
| Civil plaint | Where did the cause arise and where are parties/property? | Subject matter, value/court fee, original jurisdiction, limitation. | Specific civil/commercial/family/special court; [Order VII rule 1](https://www.indiacode.nic.in/bitstream/123456789/2191/1/A1908-05.pdf) requires jurisdiction facts and valuation. |
| Existing-case application | Which court currently has the file/listing? | Power to grant this relief at the current stage. | Court seized of the matter unless governing law directs otherwise; inspect last order and local roster. |
| Appeal / revision / review | Which court or authority made the impugned order? | Is this remedy and stage permitted? What is the value/limitation? | Statute-specific appellate/revisional/review forum; the same order may have different routes. |
| Contract / property instrument | Place of performance, property and execution; dispute clause. | Capacity, enforceability, property/registration and instrument-specific law. | Execution/registration authority or chosen dispute forum; choice-of-court wording cannot create jurisdiction that law denies. |
| Bill / scheme | Union, State or local competence and territorial extent. | Legislative/executive authority and delegated power. | Competent department/legislature; approvals and publication route must be checked. |

The rules engine must return `supported`, `needs-review`, or `known-conflict` with an explanation and source. It must not silently choose a forum from a police station, postal code or first search result.

## C. Court and authority configuration

| Forum layer | Configuration needed before a filing preflight can pass |
| --- | --- |
| Supreme Court | Jurisdiction type, current Supreme Court Rules and practice directions, filing categories, affidavits, paper-book, service and e-filing requirements. |
| High Court | Court-specific original/appellate/writ rules, bench/territory, criminal/civil roster, forms, affidavits, pagination and current notices. |
| District civil/criminal courts | Court designation, local territorial and pecuniary allocation, case type, district rules, cause list/order-sheet state, court fee and forms. |
| Special courts, tribunals and commissions | Enabling Act, exclusive/concurrent jurisdiction, appeal route, local procedure and limitation. Never map them merely from a generic “court” field. |
| Police, registrar and administrative authorities | Receiving/issuing authority, territorial office, digital/physical submission route, acknowledgement, appeal/grievance path. |

Each configuration should be versioned as `{authority, jurisdiction, caseType, ruleSourceUrl, ruleHash, effectiveFrom, retrievedAt, reviewer, confidence}`. A stale or absent rule produces a review item; it cannot become a green filing check. Official [eCourts forms](https://services.ecourts.gov.in/ecourtindia_v6/?p=forms_for_advocates%2Findex) are useful source leads, but a form list is not proof that a particular court will accept a particular filing.

## D. Schema and output contract

[draft-schemas.v1.json](draft-schemas.v1.json) is the first machine-readable instrument catalogue. The runtime’s five current formats share an intake model but have different required fields, sections and review gates. A future runtime should compile these schemas into intake controls, rule checks, section renderers and tests; bespoke rule modules remain necessary for complex remedies. Do **not** build a single universal blank template.

```text
Case file → event → source document/page → assertion
          → disputed issue → dated law and case paragraph
          → draft section/sentence → review decision
```

An assertion should carry `record | client-instruction | inference | assumption`, source hash/page or explicit absence, reviewer and timestamp. Render verified source facts separately from unverified instructions. The current runtime has fields for free-text source/page references but does **not yet** enforce sentence-level provenance, OCR confidence or an annexure manifest; that is a blocking next step before any filing-ready claim.

The three output layers are: **analysis** (classification, forum, law, gaps, contrary material), **draft plan** (required sections and source map), and **working draft**. A fourth state, `filing-preflight-passed`, should only be attainable after a human reviewer confirms every hard gate and a versioned local rule pack. Empty placeholders are acceptable in `working`; they are blockers in a filing candidate. No quality percentage is meaningful without validated ground truth and calibration.

## E. Legal knowledge architecture

Use an authority and provenance ledger, not a single vector index. Store: source body and hash; issuing body; publication/notification; effective interval; territorial scope; repeal/savings; amendment chain; subsection status; retrieval time; and confidence in extraction. Keep the original PDF or HTML link for inspection. **Authority ranking is issue-dependent:** Constitution and applicable legislation/control rules govern; binding judgments interpret them; official orders and current court rules govern procedure where applicable; circulars and secondary commentary can be leads but cannot silently override primary law. A lower-court or vendor summary is never automatically binding.

For judgments store citation aliases, court, bench, opinion, decision date, exact paragraph, proposition, fact context, later treatment, and whether that treatment was verified from the citing judgment. Citation identity alone is insufficient. The existing citation checker deliberately confirms identity only. A missing decision in LawBuddy’s index is a coverage gap, not evidence that the decision does not exist.

The old/new criminal-code transition requires the act date, procedural step date and BNSS repeal/savings analysis; do not map an IPC/CrPC number to BNS/BNSS by string substitution. [BNSS section 531](https://www.indiacode.nic.in/bitstream/123456789/20340/1/bnss%2C_2023.pdf) is a mandatory review lead for pre-commencement proceedings. State amendments and special Acts need their own versioned layer.

## F. Engineering architecture and hard stops

1. **Frontend:** browser-local matter intake, schema-specific fields, current-law warnings, source-status badges and editable preview. No client facts in statute/case search requests. Explicit save/export/delete.
2. **Ingestion:** consented file upload, PDF/OCR with page coordinates, language/script and confidence; source hashes; malware/file-type checks; human correction of low-confidence spans. This is planned for matter files, not implemented in the present workbench.
3. **Stores:** encrypted object storage for source files, relational store for matter/events/assertions/review decisions, full-text and optional vector retrieval for candidates, citation/relationship graph for judgments and amendment chains. Retrieval relevance never equals legal validity.
4. **Engines:** classifier → forum/stage rules → dated statute resolver → candidate judgment retrieval → proposition/paragraph verifier → template renderer → contradiction/omission audit → annexure map → local-rule preflight. Every stage can abstain.
5. **LLM boundary:** if an LLM is later added, it receives only scoped source spans and a typed output schema. Retrieved documents are untrusted data, not instructions. Reject invented parties, dates, case citations, statutory language, admissions, annexures and counsel assurances. Keep deterministic rule gates outside the model.
6. **Governance:** matter-level permissions, audit events, reviewer identity, immutable exported version, retention/deletion controls and no model training on client files by default before a hosted multi-user release. The present browser storage is a prototype, not enterprise document management.

Hard-stop tests: wrong court level for pre-arrest bail; express BNSS 482(4) accusation; pre-2024 act/procedure confusion; missing prior order; counsel-engagement-only civil adjournment; annexure named but not held; conflicting dates; unsupported proposition or fabricated case; prompt injection embedded in uploaded record; stale court rule. A lawyer may override a *review item* with a recorded reason; a known statutory conflict needs a different verified legal route, not a hidden bypass.

## G. MVP and market test

Use a **qualitative** prioritisation until real chamber interviews and timed case studies exist. The dimensions are frequency, severity of error, repeatability, availability of authoritative sources, and ease of practitioner review. Do not present invented market shares or time savings.

| Order | Workflow | Reason / release gate |
| --- | --- | --- |
| 1 | Bail packet and hearing card | High consequence, record and prior-order intensive; needs forum, special-act and adverse-fact checks. Implemented as a working draft only. |
| 2 | Police information / FIR request | Frequent first-contact workflow; receiving station and occurrence must be distinct. Implemented as a request, not a registered FIR. |
| 3 | Civil adjournment / short procedural application | Narrow format and common stage problem; separate Order XVII rule 1 checks. Implemented as a working draft. |
| 4 | Legal opinion / case research memo | Lawyers need bounded, citation-backed answers; implemented structure, authority verification remains manual. |
| 5 | Legal notice and reply | High repeatability; needs cause, demand, service and statutory pre-notice conditions by subject. Planned. |
| 6 | Civil plaint / written statement | High value; must gate jurisdiction, limitation, valuation, verification and admissions. Planned. |
| 7 | Settlement terms and agreement | Frequent negotiations; needs authority, consideration, tax/stamp and pending-case disposal logic. Planned. |
| 8 | Appeal/revision/review classifier | Severe wrong-remedy risk; first ship a route recommendation with cited statute, then instrument draft. Planned. |
| 9 | Witness/document production application | Record mapping and evidentiary relevance are automatable, legal admissibility needs separate review. Planned. |
| 10 | Court-specific filing preflight | Requires current local rule packs and defect feedback; build only after source coverage. Planned. |

Pakistan and Nigeria are useful *product analogues*, not transplantable sources of Indian law. Pakistani vendor [Legalise](https://legalise.pk/about/) advertises controlled-corpus drafting/templates and national case search. Nigerian vendor [LawPavilionAI](https://lawpavilion.ai/) advertises drafting, review and source traceability. These are vendor descriptions, not independent quality measurements. The transferable product lesson is a combined **template + local primary corpus + inspectable source** experience. In India, official [eFiling](https://filing.ecourts.gov.in/pdedev/?p=otherPages%2FAboutUs) and [eCourts forms](https://services.ecourts.gov.in/ecourtindia_v6/?p=forms_for_advocates%2Findex) already cover parts of submission and form access; LawBuddy’s defensible role is verified preparation and preflight, followed by the official filing route.

## H. Twelve-month delivery path

| Window | Release | Evidence required before expansion |
| --- | --- | --- |
| Months 1–2: foundation | Finish dated statute ledger, source hashes, matter assertion model, redacted evaluation files and review UI. | Legal-editor gold set for false-green law and invented-fact rates, with abstention tracked. |
| Months 3–4: litigation | Harden bail/FIR; add notice and civil pleading schemas; pilot court-rule packs for a small set of named forums. | Advocate review of real redacted files; zero fabricated orders/citations in the pilot set; defects classified by source. |
| Months 5–6: research | Paragraph-level case propositions, contrary-authority search, legal opinion workflow. | Citation identity, proposition support and later-treatment precision measured separately. |
| Months 7–8: transactional | Settlement and one bounded agreement type with execution/stamp/registration review. | Transaction lawyers test missed clauses, inconsistent dates/parties and unenforceable assumptions. |
| Months 9–10: court intelligence | Versioned local rules, filing preflight and order-sheet/next-date links where lawful and reliable. | Rule freshness and actual defect outcomes; no green check when local rule source is stale. |
| Months 11–12: team mode | Permissions, audit/export, template governance, consented document ingestion and redline. | Security/privacy review, deletion tests, audit completeness and chamber usability study. |

The launch gate is **measured safe abstention and reviewability**, not the number of generated document types. A filing-ready label should wait until source provenance, local rules and practitioner evaluation can support it.
