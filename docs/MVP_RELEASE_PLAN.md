# LawBuddy advocate MVP: verified law before generated work

**Decision date:** 24 October 2026. **First customer:** an Indian litigation advocate or small chamber checking statutory references while preparing a filing. Students can use the same source layer for learning, but their tutor is not the release gate for a practitioner product.

## The job to solve

An advocate needs to know whether a draft's section, quotation and legal proposition are supported by the **right provision, in the right jurisdiction, on the relevant date**, and needs a reviewable Word document. The first paid workflow is: choose matter dates and forum → paste or import a draft → identify every legal reference → resolve it to a dated official source → review missing, changed and uncertain references → accept edits → export a source-linked report and working draft. A model may suggest wording or arguments only inside that evidence boundary.

This is a narrower wedge than another case-status app. The official [eCourts app already has case search, cause lists, My Cases, notes, calendar and order downloads](https://services.ecourts.gov.in/App/appfaq.html). India Code provides official PDFs but [warns that State/UT updating is continuous](https://www.indiacode.nic.in/disclaimer.jsp?abv=LD&col=123456789%2F2496). The [old India Code host announces its migration to indiacode.gov.in](https://www.indiacode.nic.in/). Treat the new host as an official source identity; retain historical URLs, hashes and retrieval dates, and verify redirects and content per document. Gazette notifications remain essential to confirm commencement and amendments through the [eGazette portal](https://egazette.gov.in/).

## Present state and hard problems

| Surface | Works now | Release problem |
| --- | --- | --- |
| Bare Act and search | Constitution, BNS, BNSS and BSA have indexed text; catalogue identifies many more instruments. | Act identity is broader than verified provision coverage. A catalogue entry does not answer a legal question. Provision-level commencement, amendments, State variations and savings need a consistent result type. |
| Teach me | Official evidence, citation and quote checks, and a second-model critique. The cyber testing incident now refuses to answer until IT Act sections 43 **and** 66 are indexed. | Other concepts can still return a partial source set. Untagged legal bullets escape the claim critic; its verdict arrives after streaming. “Grounded” must never imply that applicability or every proposition was checked. |
| Practice workbench | Intake, issue structure, source leads and local editable Word export for selected drafts. | A working template is not a court-ready filing. Forum, territorial jurisdiction, local practice, adverse orders, annexures and approval need per-template gates. Browser-only matter state is not chamber storage. |
| Case law | Citation resolution and point verification exist for available Supreme Court material. | A matching citation is not a verified holding or current treatment. Add pinpoint, opinion, procedural posture and later-treatment checks before a draft may cite a case as authority. |

The [security-researcher incident review](TEACH_ME_FAILURE_MODES.md) is a useful adversarial fixture: official BNSS text supported a polished answer to the wrong question. The product must check source **relevance and completeness**, as well as provenance.

## MVP scope, in order

### 1. Dated Bare Act check: release foundation

Input: `act + provision + jurisdiction + as-of date + event/proceeding date when transition matters`. Output: one of `verified text`, `changed`, `not commenced`, `repealed/savings review`, `source conflict`, or `unknown`, with official PDF, page/section anchor, SHA-256, capture time, effective interval and an explanation of what remains unresolved. Store the source snapshot separately from the legal event it supports; a corrected PDF creates a new snapshot. No green status from a catalogue record, search snippet, unofficial mirror, or a single Act-level commencement flag.

Use the existing BNS 106(2), DPDP phased commencement, CPC State amendment and old/new criminal-code savings fixtures in [2026 priorities](PRIORITIES_2026.md). Add a fixture for a source URL that moved hosts without silently changing its stored snapshot.

### 2. Advocate draft audit: first marketable workflow

Start with pasted text and uploaded DOCX/PDF; preserve offsets, paragraph IDs and source file hash. Extract Act, rule, section, subsection, dates, quotations and case citations. Resolve aliases and compare the relevant date with today. Show a queue with `verified`, `changed`, `missing`, `ambiguous`, `source conflict`, and `not checked` items. Every finding opens the underlying page and highlights the draft span. Proposed replacements require advocate acceptance and are recorded in an audit trail. Export a DOCX report and the accepted working draft; mark unresolved items in both.

The audit should detect a real error that matters to practice: a correct quotation attached to the wrong section, a subsection that does not exist, old-code references after a transition, a proviso stated without its limiting conditions, or a provision valid in one State but not another. A crosswalk is a research lead, not an automatic substitution.

### 3. One end-to-end drafting path

Pilot **anticipatory and regular bail** as distinct templates, then add notice and opinion after review data. Require court/forum, district and State, police station/FIR, incident and arrest dates, sections alleged, custody status, prior applications and adverse orders, prosecution account, applicant response, document/page references, risks and proposed conditions. Generate a fact ledger, chronology, issues, draft and missing-facts list. Keep source evidence and counsel's assertions visibly separate. Show a filing preflight for local-form requirements and an explicit counsel sign-off; export only the reviewable working product.

Do not call a draft court-ready merely because placeholders are filled. A filed document depends on verified facts, the correct forum and current local practice.

## Architecture contracts

1. **Source ledger:** `source_snapshot(id, instrument_id, url, retrieved_at, sha256, official_tier, page_map, extraction_status)` plus immutable bytes; `legal_event(id, provision_id, jurisdiction, effective_from/to, event_kind, authority_snapshot, review_status)`.
2. **Coverage resolver:** for each primary issue, return required provisions, obtained versions, missing versions, date/jurisdiction basis and `ready | partial | unavailable`. Every retrieval path—named section, concept and search—must use it before an answer or draft can claim coverage.
3. **Claim ledger:** each legal sentence in generated content stores its source span, rule conditions and confidence state. Uncited or semantically unchecked sentences are visibly unverified. Run deterministic citation, date and quotation checks before display; reserve the second model for a separately labelled semantic review.
4. **Matter evidence:** facts come from user-entered records with document/page references. Allegations, admissions, inferences and instructions are different types. Never silently transform a party's account into a proven fact.
5. **Export manifest:** include template version, as-of date, accepted edits, unresolved items, source hashes, generation time and counsel review status. DOCX and report must be reproducible from the saved review state.

## Release gates and measurements

| Gate | Acceptance evidence |
| --- | --- |
| No wrong-law answer | Mixed named-reference and narrative regression pairs return `unavailable` when core law is missing; test the integrated HTTP and UI path. |
| Source/date fidelity | All P0 fixtures produce the expected status, source link and explanation; unknown or conflicting sources never render as verified. |
| Citation quality | In a redacted advocate sample, measure precision and recall for section/subsection extraction, quotation alignment, and old/new-law detection. Review every missed high-impact reference before widening the pilot. |
| Draft quality | Two independent practitioners inspect redacted bail packets for forum, chronology, adverse facts, legal basis, prayer and annexures. Track time saved, correction count and defects that would prevent filing. |
| Privacy and security | Matter-level access control, audit log, retention/deletion and encrypted storage precede server-side client files. Local-only practice state must say so clearly. |
| Operational reliability | Pin source parser versions; quarantine changed PDFs; alert on failed source checks; maintain restore tests for the legal store and exported review state. |

## Next implementation sequence

1. Build the shared coverage result and use it in Teach me, Bare Act Check and drafting evidence selection. The cyber gate is a tested first instance, not the final abstraction.
2. Finish official IT Act sections 43 and 66 through the import review gate, including amendments and effective dates; only then reopen cyber-merits teaching. Do not populate them from synthetic test text.
3. Make claim checks cover uncited substantive bullets and withhold a “checked” badge until prepublication checks pass.
4. Pilot the draft audit against redacted real documents; use observed misses to select the next Acts and templates instead of indexing every catalogue item at once.
5. Add permissioned matter storage and court-data integrations only after the source and review workflow passes the pilot gates. Use user-supplied court records or approved access; do not make an unverified sync the basis for a deadline.

**Out of MVP:** automatic filing, autonomous legal advice, bulk court scraping, a generic chamber ERP, and legislative drafting. These require separate legal, data and operational validation. The first product promise is a faster, more accountable advocate review of source-linked law and working drafts.
