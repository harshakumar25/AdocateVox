# LawBuddy ⚖️

> **Source-linked Indian legal research, Bare Act checking and practitioner preparation.**

LawBuddy is an educational AI legal research engine designed to teach Indian statutory law, constitutional law, and Supreme Court precedent **strictly from verified primary sources**. It cites every claim down to the paragraph, identifies invalidated amendments and judicial cautions, and enforces a strict "cite-or-silence" boundary.

## Core Capabilities

1. **Statutory Grounding ("Cite-or-Silence")**: Searches versioned enactments (currently the Constitution of India, BNS, BNSS and BSA) using BM25 and Porter stemming. Search is filtered by the requested date, and can be scoped to an Act ID. If official text is not found, the model declines rather than inventing law.
2. **e-Gazette Provenance & TLS Completion**: Connects to `egazette.gov.in`, completes missing intermediate TLS chains, and maintains a content-addressed vault.
3. **Point-in-Time Provision History**: Tracks amendments, pending substitutions, and judicially struck-down provisions (e.g. NJAC 99th Amendment).
4. **Bare Act Copy Checker ("Check my Bare Act")**: Compares student-uploaded PDFs or mirror URLs against official text, detecting outdated provisions and omitted amendments.
5. **Precedent Points & Citation Graph**: Scores Supreme Court judgments by bench strength, headnote placement, and subsequent citing cases from AWS Open Data.
6. **Statutory Correspondence Tables**: Maps old codes to new enactments (IPC ↔ BNS, CrPC ↔ BNSS, Evidence Act ↔ BSA).
7. **Practice Workbench (early access)**: `/lawbuddy/practice` prepares distinct local working structures for police information, bail, civil adjournment and legal opinions. It separates incident, case station, court and filing place, flags known forum restrictions, and exposes missing facts and adverse issues. Statute/case leads stay separate from the draft; a citation match confirms identity only, not a holding. A prepared, unblocked packet can be downloaded as an editable Word `.docx` with internal review notes on a separate page; editing intake disables the export until the packet is prepared again. Matter facts stay in the browser unless explicitly exported. Browser storage is not encrypted chamber storage or a backup.
8. **Practice Instrument Index**: `/lawbuddy` identifies Indian corporate, civil and cyber Acts, rules, directions and standards by exact title, type, topic, parent and source. It distinguishes `source-identified` entries from `indexed-as-of` provision text. Cyber coverage includes IT, DPDP and the SPDI transition, intermediary rules and their notified 2026 amendment, blocking rules, telecom, e-commerce, CERT-In, digital evidence, IP and sector security instruments. The UK Companies Act 2006 is kept outside Indian search. Source-only entries never become teaching evidence.
9. **Legal Reports (early access)**: `/lawbuddy/reports` produces a legal write-up with numbered references and a clean Word export. Supply a judgment as numbered text or a `.txt` file with matching case identity. The pipeline extracts literal quote cards, drafts separate sections, verifies each sentence and applies deterministic output gates. Unresolved cases and failed checks cannot export as finished reports. Diagnostics and source quotations stay in a separate review panel. Ollama, Groq and configured xAI Grok are supported. See [report repair and configuration](docs/REPORTS_REPAIR.md).

**Cyber-law teaching coverage:** Questions about unauthorised penetration testing and a case against the researcher are routed to Information Technology Act, 2000 sections 43 and 66. Those two sections are indexed from an India Code edition marked **as on 27 June 2025**, with its PDF and section-record hashes retained. A later as-of date still reports a coverage gap until a newer edition and amendments are reviewed; Teach me does not answer the 2026 scenario from unrelated FIR-registration provisions. The catalogue distinguishes this historical coverage from current verified text.

See [legal library architecture and cyber import plan](docs/LEGAL_LIBRARY_ARCHITECTURE.md), the [master indexing prompt](docs/LEGAL_LIBRARY_MASTER_PROMPT.md), [2026 priorities](docs/PRIORITIES_2026.md), the [advocate MVP release plan](docs/MVP_RELEASE_PLAN.md), the [practitioner workflow](docs/PRACTICE_WORKBENCH.md), and the [drafting architecture, jurisdiction matrix and roadmap](docs/DRAFTING_ARCHITECTURE.md).

For an incident review of the cyber-testing question, the retrieval failure chain and remaining assurance gaps, see [Why Teach me can give a grounded but wrong legal answer](docs/TEACH_ME_FAILURE_MODES.md). The [indexing backlog](docs/INDEXING_BACKLOG.md) records which remaining catalogue entries need operative text and what blocks safe import.

## Architecture

* **Zero External npm Dependencies**: Built with Node.js built-ins (`node:sqlite`, `node:http`, `node:crypto`, `node:fs`, `node:test`).
* **Storage**: Local SQLite with FTS5 virtual tables and BM25 ranking.
* **Instrument identity**: One canonical record per Indian Act, rule, direction, circular or technical standard; topics point to records rather than duplicating them. `parentId` links subordinate instruments to their enabling Act.
* **Import boundary**: The current Gazette parser is specific to BNS/BNSS/BSA. Other instruments are metadata and official-source leads until their editions, provision completeness and commencement dates pass review. A downloaded PDF or draft amendment alone does not create operative law.
* **Extraction Workers**: Python worker (`pdfplumber==0.11.4`) for structured PDF layout parsing.
* **Web UI**: Semantic, accessible web studio (`/lawbuddy/teach`) with strict Content Security Policy (no inline scripts, no `innerHTML`).
* **Report pipeline**: `src/reports/task.js` checks identity; `cards.js` extracts literal evidence; `pipeline.js` drafts and verifies sections; `quality.js` applies deterministic gates; `stages.js` stores private checkpoints. `sources.js` gates specifically identified provisions. The browser and Word export share a submission-only template; validation details remain outside the document. See [architecture and limits](docs/REPORTS_REPAIR.md).

## Getting Started

### Prerequisites

* Node.js >= 22 (for built-in `node:sqlite` and test runner)
* Python 3.10+ (for PDF extraction)

```bash
# Setup Python worker venv
python3 -m venv workers/.venv
workers/.venv/bin/pip install -r workers/requirements.txt
```

### Installation

```bash
npm install
```

### Running Tests

```bash
npm test
```

### CLI Usage

```bash
# Search provisions
npm run cli -- search "right to education"
npm run cli -- search --act BNS --as-of 2024-07-01 "murder"

# Find an exact Indian instrument and see whether its text is indexed
npm run cli -- catalog "DPDP Rules"

# Lookup correspondence
npm run cli -- lookup IPC 302

# Check bare act copy
npm run cli -- check-copy <url>
```

HTTP clients can use `GET /lawbuddy/api/catalog?q=DPDP&topic=data-protection` and `GET /lawbuddy/api/search?q=consent&act=DPDP2023&asOf=2026-10-19`. The latter returns `not-indexed` until verified provision text is imported; the official source link in the catalogue is a starting point for research, not an answer. For a legitimately downloaded official document when the source blocks automated access, use `npm run cli -- import <file> <official-url>` and then follow the review gate in the [architecture](docs/LEGAL_LIBRARY_ARCHITECTURE.md).

## Integration with DocVex

DocVex consumes `@docvex/lawbuddy` as an external package:

```javascript
import {
  handleLawBuddyStaticRoute,
  handleLawBuddyApiRoute,
  createLawRetriever,
  createLegalStoreLoader,
  LAWBUDDY_FILES,
  LAWBUDDY_SECURITY_HEADERS
} from '@docvex/lawbuddy';
```

## License

MIT

### Reports and output checks

Run `npm run dev`, open `/lawbuddy/reports`, enter the research question and, for case analysis, expand the judgment intake. Supply court, decision date, citation or case number and matching numbered text. Select the model before submitting; cloud providers receive the supplied material. Word export unlocks only after required evidence and output checks pass.

Run `npm test` for regressions and `python3 scripts/quality_gates.py memo.txt source1.txt source2.txt` for standalone style/source-overlap checks. Configuration, resume instructions, provider limits and the full changed-file inventory are in [Reports repair](docs/REPORTS_REPAIR.md).
