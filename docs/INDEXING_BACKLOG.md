# Provision indexing backlog

**Audit date: 24 October 2026.** The pasted catalogue has 43 Indian instruments and one UK reference. Four Indian instruments have broad indexed text (Constitution, BNS, BNSS, BSA). IT Act sections 43 and 66 now have a **bounded historical edition** reviewed through 27 June 2025. The remaining 38 Indian entries identify a source but do not have verified provision text for today's search. “Official source identified” is deliberately not an assertion that the operative text, amendments, commencement or territorial reach was checked.

## Import order tied to advocate work

| Queue | Instruments | Why and release condition |
| --- | --- | --- |
| **P0: source and date foundation** | `IT2000` newer edition; `ICA1872`, `CPC1908`, `LA1963`, `SRA1963`, `TPA1882`, historical `IEA1872` | These govern frequent contract, pleading, limitation, property and evidence questions. Resolve a current central PDF and the relevant State modifications; distinguish historical proceedings and savings. The IT Act's 2025 sections must not pass a 2026 query until re-reviewed. |
| **P1: cyber and consumer** | `DPDP2023`, `DPDPR2025`, `ITINTERMEDIARY2021`, `ITINTERMEDIARYAMEND2026`, `ITBLOCK2009`, `CERTINRULES2013`, `CERT2022`, `ITSPDI2011`, `TELECOM2023`, `TELCYBER2024`, `CPA2019`, `ECOM2020` | Ingest sections/rules with phased commencement, notified amendments and entity scope. Keep original rules, amendment notifications and regulator directions separate. Government-hosted SPDI copy is a research lead until reconciled with its Gazette. |
| **P1: corporate and financial practice** | `CA2013`, `COMP2002`, `SEBI1992`, `IBC2016`, `BR1949`, `INS1938`, `PMLA2002`, `PCA1988`, `FTDR1992` | Start with high-use provisions chosen from pilot drafts. Check current amendments, regulator instruments, sanctions and procedural stage before a full-act status. |
| **P2: specialist and sector** | `PATENTS1970`, `TM1999`, `COPYRIGHT1957`, `EPA1986`, `WAGES2019`, `IRC2020`, `SOCSEC2020`, `OSH2020`, `SEBICSCRF2024`, `RBIIT2023` | Add as review demand and source capacity justify. Labour codes need provision-level commencement and State rules; regulator texts need regulated-entity and effective-date checks. |
| **Reference, not a statutory text import** | `BIS27001` | A technical standard can be binding through a different instrument or contract. Its full text may need licensed access; the catalogue must not present it as an Act. |

The [India Code migration notice](https://www.indiacode.nic.in/) points to `indiacode.gov.in`. The new [India Code DSpace API](https://indiacode.gov.in/server/api) exposes central Act PDFs and section records. Old catalogue handle links should be replaced **only after resolving the matching central item**; the same Act title can also appear under State records. The IT Act importer pins the central Act ID `AC_CEN_45_76_00001_200021_1517807324077`, exact PDF and section-record hashes, headings, PDF page clauses and printed edition date. This pattern can be reused for other Acts after a legal editor reviews each manifest. It is not a bulk “download and mark current” switch.

The [central Contract Act PDF](https://indiacode.gov.in/server/api/core/bitstreams/e7571d39-11a7-4a2c-86e3-c515ae43e617/content) and section 10 record were also located and checked for identity. The PDF does **not** print an as-on edition date. It remains source-identified until its amendment and commencement trail establishes a defensible review interval; LawBuddy must not infer freshness from the website's 2026 migration timestamp.

## Repeatable IT Act import

The pinned PDF and two official section records are already in the local content-addressed vault. A fresh machine can download these three URLs from the [reviewed import manifest](../src/ingest/indiaCodeEdition.js), import each with `node src/cli.js import <local-file> <source-url>`, then run `node src/cli.js ingest-it-act-2025-core`. The ingestor refuses changed bytes, a State item, a wrong section, a title mismatch or clauses missing from the PDF. It writes section text, official PDF hash, section item URL, page span and `verified_through = 2025-06-27`.

Verify with `node src/cli.js search --act IT2000 --as-of 2025-06-27 "dishonestly fraudulently"`. The same query with `--as-of 2026-10-24` must return no current-law hit. The catalogue reports `indexed-historical` with two sections reviewed through 27 June 2025. A newer official edition should be reviewed and imported as a **new source snapshot**, even if the operative wording is unchanged; the store retains both hashes.

## Gate for every next instrument

1. Resolve exact central/State identity and instrument type. Capture PDF, section records and hashes from a registered official source.
2. Establish edition review date and provision-level effective dates from the Act and notifications. Reconcile amendment and savings text; mark uncertainty, do not guess.
3. Parse only the reviewed set. Check numbering, heading, page anchors, operative words, footnotes and omissions against the PDF. Reject the whole proposed set if a required section fails.
4. Publish bounded versions and expose `indexed-as-of`, `indexed-historical` or `source-identified`. Search, exact lookup and model retrieval must use the same date filter.
5. Run an advocate review on representative questions and drafts before expanding the Act or calling the area covered.

The official [eGazette](https://egazette.gov.in/) and issuer portals remain necessary to identify later events. India Code's [disclaimer](https://www.indiacode.nic.in/disclaimer.jsp?abv=LD&col=123456789%2F2496) warns that State/UT updates are continuous; an indexed PDF is a dated snapshot, not a guarantee of current local law.
