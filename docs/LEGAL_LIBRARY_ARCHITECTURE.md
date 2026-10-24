# Legal library architecture and cyber expansion

Status: updated 24 October 2026. Read [the master indexing prompt](LEGAL_LIBRARY_MASTER_PROMPT.md) before adding an instrument.

## What is indexed

The operative library contains the Constitution of India, BNS, BNSS and BSA (1,569 provisions in the local store when this expansion began). On 24 October 2026, two IT Act provisions, sections 43 and 66, were added from the [India Code central Act PDF](https://indiacode.gov.in/server/api/core/bitstreams/770a7d02-48f2-4274-bab9-10d0f48ee264/content) and its individual official section records. That PDF is marked **as on 27 June 2025**, so these two sections are queryable only through that date, not as verified current text in October 2026. The wider corporate, civil and cyber catalogue remains an **identity and source index**. `indexed-as-of`, `indexed-historical` and `source-identified` have distinct meanings; a past edition cannot silently pass a later date filter. The UK Companies Act 2006 is segregated from Indian retrieval.

## Data path

```text
Official source registry → polite fetch or manual import → immutable raw file + SHA-256
                  ↓
Instrument identity (jurisdiction, type, title, year, parent, topics, aliases)
                  ↓
Edition and commencement review → provision parser → dated provision versions
                  ↓
SQLite FTS5 + Act ID + effective interval → exact reference / scoped search
                  ↓
Source-linked legal evidence → teaching, checking and practitioner research
```

`src/ingest/libraryCatalog.js` contains canonical identities and cross-topic links. One Contract Act record appears in civil and corporate search. Subordinate instruments have their own IDs and `parentId`; a DPDP rule is never stored as a DPDP Act section. `src/sources/registry.js` is the tier-0 allowlist, including India Code's migrated `indiacode.gov.in` host and archived `indiacode.nic.in` URLs. `src/store/db.js` keeps immutable source hashes, point-in-time versions and an optional `verified_through` boundary for dated consolidated editions; official-source FTS queries filter **before ranking limits** by source, effective interval, edition review date and optionally Act ID. Coverage counts include only provisions with a registered primary HTTPS source, hash and suitable review date. `src/retrieval/legalRetriever.js` recognizes explicit Act/section and Rules/rule references, but only emits a provision with an official source URL and hash. The catalogue API and page show coverage; they do not feed source-only entries to the answer model.

The section endpoint supports an indexed Indian Act ID and a provision number, and the search API accepts `act` and `asOf`. A requested Act with no indexed text returns `not-indexed`; a date before a stored version returns `not-indexed-as-of`. A technical standard cannot be used as a statute in Act-scoped search. Historical queries are ranked against the version in force on the requested date, not against today's version.

## Cyber instrument map

| Question family | Primary instruments identified | Essential distinction |
|---|---|---|
| Computer crime and electronic evidence | IT Act 2000; BNS; BNSS; BSA | Offence, procedure and admissibility are separate questions; event and proceeding dates matter. |
| Privacy and breach response | IT SPDI Rules 2011; DPDP Act 2023; DPDP Rules 2025; CERT-In Functions Rules 2013; CERT-In directions 2022 | DPDP Act and rules have phased commencement. Section 44(2)'s IT Act amendment is scheduled eighteen months after the November 2025 commencement Gazette publication, so the 2011 rules need transition review. CERT-In rules and directions have separate scopes. |
| Social media and intermediaries | IT Act 2000; IT Intermediary Rules 2021; notified Amendment Rules 2026; IT Blocking Rules 2009 | G.S.R. 120(E) amended the 2021 rules from 20 February 2026. A later proposed Second Amendment is still a draft in the sources checked. Intermediary due diligence and section 69A blocking use different procedures. |
| E-commerce and digital IP | Consumer Protection Act 2019; E-Commerce Rules 2020; Contract Act; Copyright, Trade Marks and Patents Acts | There is no single “intellectual property act”; misleading listings, contracts and infringement need separate analysis. |
| Telecommunications | Telecommunications Act 2023; Telecom Cyber Security Rules 2024 | The Act commenced in batches; DoT rules and directions are separate instruments. |
| Security controls | BIS IS/ISO/IEC 27001:2022; SEBI CSCRF; RBI IT Governance Directions | A technical standard has a different status from a sector-specific regulatory direction or circular. Applicability depends on entity and instrument. |

## Import gate for a new Act or rule

1. Confirm jurisdiction, exact title, Act or notification number, issuer, parent instrument and source URL. Register the source host; retain the source document hash. A PDF printed as “updated” or “consolidated” is a **candidate edition**, not proof of current force.
2. Record every commencement event at the smallest affected unit. Distinguish enactment, Gazette publication, notification and effective date. DPDP Rules 2025 are a concrete example: rules 1, 2 and 17–21 commenced on publication, rule 4 one year later, and rules 3, 5–16, 22–23 eighteen months later under the published rules, subject to corrigenda and later changes.
3. Parse an expected provision set with page references. Reject missing or duplicate numbering, absent definitions/schedules, bad OCR, or a mismatch between the document title and expected instrument. Produce a changed-text report against the prior stored edition.
4. Have a legal editor approve ambiguous amendment/repeal/savings treatment. Write versions transactionally with source URL and SHA-256; preserve old versions. Index only text whose effective interval is justified by a legal event. Do not turn a draft consultation into operative law.
5. Verify exact references, dated search, cross-Act disambiguation, source display and abstention on missing provisions. Recheck dependencies such as State rules, regulator circulars and court orders before claiming a topic is complete.

The current Gazette ingestor is deliberately specialised for BNS/BNSS/BSA; a generic PDF is **not** routed through it. During this pass, the polite fetcher received HTTP 403 for the MeitY DPDP Rules PDF and respected `robots.txt` disallowing the Consumer E-Commerce Rules PDF. India Code also returned HTTP 403 for an attempted Contract Act PDF fetch. The existing manual import path is available for a copy obtained legitimately from the displayed official URL; the same identity, completeness and commencement review still applies. The SEBI-hosted Act PDF inspected during this work prints an amendment cutoff at 2014, so it is not a safe current-law edition for automatic provision import.

The new India Code DSpace API exposed the central IT Act PDF and separate section records. The IT Act import is a pinned review manifest: exact central Act ID, PDF and section-record SHA-256 hashes, printed edition date, section numbers, headings and matching PDF clauses must all pass before storage. The first MeitY-hosted PDF found in search was a **2005 proposed-amendments report**, and was rejected. The reviewed India Code PDF is a 44-page 2025 consolidated edition. Its two imported sections carry `verified_through = 2025-06-27`; a 2026 question still declines. Importing more sections from that PDF requires a new reviewed manifest and completeness checks, rather than treating the whole Act as indexed.

The SPDI Rules entry links a government-hosted copy of G.S.R. 313(E) because the old MeitY PDF URL currently fails. That mirror contains multiple notifications; isolate G.S.R. 313(E) by page and reconcile its text with the original Gazette before provision import. It is a tier-1 research lead. The [DPDP commencement notification](https://upload.indiacode.nic.in/showfile?actid=AC_CEN_45_0_00003_2023-22_1763464807080&filename=c56ceae6c383460ca69577428d36828b.pdf&type=hindinotification) schedules DPDP Act section 44(2), which omits IT Act section 43A and section 87(2)(ob), for eighteen months after publication. This transition is not collapsed into a single privacy-law status.

## Next import order

1. **High-value, lower ambiguity:** identify current IT Act and Contract Act editions, verify section sets, then add historical-safe initial versions and an amendment ledger.
2. **Cyber procedural core:** index DPDP Act/Rules with per-section and per-rule commencement; add Telecom Act/Rules, CERT-In Functions Rules and 2022 directions after amendment and entity-scope review.
3. **Platform and commerce:** IT Intermediary Rules with the operative 2026 amendment, IT Blocking Rules, Consumer E-Commerce Rules, copyright and trade marks. Separate operative Gazette versions from consultation drafts and consolidated display copies.
4. **Sector requirements:** SEBI CSCRF and RBI IT Directions as circular/direction types with entity applicability and later clarifications. BIS standard metadata remains non-statutory.
5. **Broader practice:** CPC, Limitation, Specific Relief, Companies, Competition, SEBI, labour codes and State rules. Each requires its own completeness and commencement gate.

## Official source starting points

- [India Code: IT Act 2000](https://www.indiacode.nic.in/indiacode/handle/123456789/1999?locale=en), [DPDP Act 2023](https://www.indiacode.nic.in/indiacode/handle/123456789/22037?view_type=browse), [Telecommunications Act 2023](https://www.indiacode.nic.in/bitstream/123456789/20101/1/a2023-44.pdf).
- [MeitY: DPDP Rules 2025](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf), [IT Rules 2021 consolidated edition](https://www.meity.gov.in/static/uploads/2025/10/708f6a344c74249c2e1bbb6890342f80.pdf), [CERT-In Functions Rules 2013](https://www.meity.gov.in/static/uploads/2024/05/gazette_11-01-2014.pdf), [IT Blocking Rules 2009](https://www.meity.gov.in/static/uploads/2024/10/91f628cb778f94e76df356bc3fd3ac60.pdf), [2026 proposed amendments](https://www.meity.gov.in/documents/act-and-policies/draft-amendments-to-the-it-rules-2021-in-relation-to-strengthening-intermediary-compliance-with-clarifications-advisories-and-directions-issued-by-the-ministry-and-digital-media-oversight-AjM2YjMtQWa).
- [e-Gazette: IT Intermediary Amendment Rules 2026, G.S.R. 120(E)](https://egazette.gov.in/WriteReadData/2026/269993.pdf), effective 20 February 2026. [MeitY's later proposed Second Amendment](https://www.meity.gov.in/static/uploads/2026/03/30591fc6e322dcbcc9dae84a0f02e9e7.pdf) has blank notification and commencement fields and is treated as a draft.
- [Government-hosted SPDI Rules 2011 Gazette copy](https://emb.mes.gov.in/Common/help/gsr3_10511.pdf), [MeitY clarification](https://www.meity.gov.in/sites/upload_files/dit/files/PressNote_25811.pdf), [DPDP section 44(2) commencement notification](https://upload.indiacode.nic.in/showfile?actid=AC_CEN_45_0_00003_2023-22_1763464807080&filename=c56ceae6c383460ca69577428d36828b.pdf&type=hindinotification).
- [CERT-In directions](https://www.cert-in.org.in/Directions70B.jsp), [DoT telecom cyber security portal](https://eservices.dot.gov.in/telecom-cyber-security), [Consumer E-Commerce Rules 2020](https://consumeraffairs.nic.in/sites/default/files/E%20commerce%20rules_0.pdf).
- [BIS IS/ISO/IEC 27001:2022](https://www.bis.gov.in/system-certification-overview/systems-under-certification/information-security-management-systems/?lang=en), [SEBI CSCRF](https://www.sebi.gov.in/legal/circulars/aug-2024/cybersecurity-and-cyber-resilience-framework-cscrf-for-sebi-regulated-entities-res-_85964.html), [RBI IT Governance Directions](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12562).
