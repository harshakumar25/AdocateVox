# LawBuddy ⚖️

> **Voice-first legal tutor with verified statutory grounding.**

LawBuddy is an educational AI legal research engine designed to teach Indian statutory law, constitutional law, and Supreme Court precedent **strictly from verified primary sources**. It cites every claim down to the paragraph, identifies invalidated amendments and judicial cautions, and enforces a strict "cite-or-silence" boundary.

## Core Capabilities

1. **Statutory Grounding ("Cite-or-Silence")**: Searches versioned enactments (Constitution of India, BNS, BNSS, BSA) using BM25 and Porter stemming. If official text is not found, the model declines rather than hallucinating legal advice.
2. **e-Gazette Provenance & TLS Completion**: Connects to `egazette.gov.in`, completes missing intermediate TLS chains, and maintains a content-addressed vault.
3. **Point-in-Time Provision History**: Tracks amendments, pending substitutions, and judicially struck-down provisions (e.g. NJAC 99th Amendment).
4. **Bare Act Copy Checker ("Check my Bare Act")**: Compares student-uploaded PDFs or mirror URLs against official text, detecting outdated provisions and omitted amendments.
5. **Precedent Points & Citation Graph**: Scores Supreme Court judgments by bench strength, headnote placement, and subsequent citing cases from AWS Open Data.
6. **Statutory Correspondence Tables**: Maps old codes to new enactments (IPC ↔ BNS, CrPC ↔ BNSS, Evidence Act ↔ BSA).

## Architecture

* **Zero External npm Dependencies**: Built with Node.js built-ins (`node:sqlite`, `node:http`, `node:crypto`, `node:fs`, `node:test`).
* **Storage**: Local SQLite with FTS5 virtual tables and BM25 ranking.
* **Extraction Workers**: Python worker (`pdfplumber==0.11.4`) for structured PDF layout parsing.
* **Web UI**: Semantic, accessible web studio (`/lawbuddy/teach`) with strict Content Security Policy (no inline scripts, no `innerHTML`).

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

# Lookup correspondence
npm run cli -- lookup IPC 302

# Check bare act copy
npm run cli -- check-copy <url>
```

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
