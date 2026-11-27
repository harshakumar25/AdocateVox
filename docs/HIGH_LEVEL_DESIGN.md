# AdvocateVox: High-Level Design (HLD) Specification
**Architecture, Layered Decomposition, Security Boundaries, and Latency Optimization Principles**

---

## 1. Executive System Overview & Sovereign Architecture

### 1.1 Mission & Foundational Philosophy
AdvocateVox is a sovereign, voice-first legal intelligence, statutory retrieval, and multi-agent report drafting platform tailored to the Indian legal system. The platform is architected upon an uncompromising institutional canon:

> **"Cite or Stay Silent."**  
> In the sanctum of jurisprudence, an unverified citation is perjury; an invented precedent is an assault on justice. If an official gazetted provision, judicial holding, or historical amendment cannot be deterministically proven down to the specific paragraph, gazette notification, and point-in-time commencement boundary, the system deterministically declines to answer. Generative hallucination is categorically barred.

### 1.2 Sovereign Runtime Architecture (Zero Runtime NPM Dependencies)
Unlike conventional enterprise web applications that accumulate hundreds of transitive third-party dependencies, AdvocateVox operates on a **sovereign runtime architecture**:
- **Runtime Core**: Node.js v22+ utilizing exclusively native standard library modules:
  - `node:http`: High-performance HTTP server, custom URL routing, connection pooling, and Server-Sent Events (SSE) streaming.
  - `node:sqlite`: Native synchronous embedded database driver (`DatabaseSync`) managing Write-Ahead Logging (WAL) and SQLite FTS5 BM25 search tables without external C++ bindings.
  - `node:crypto`: Cryptographic SHA-256 content addressing, UUIDv4 generation, and tamper-evident run fingerprinting.
  - `node:fs` & `node:fs/promises`: Atomic file persistence, directory structures, and non-blocking checkpoint storage.
  - `node:events` & `node:stream`: Pipelined streaming abstractions for LLM tokens and audio buffers.
- **Zero External NPM Runtime Dependencies**: `package.json` specifies `"dependencies": {}`. This eliminates supply-chain vulnerabilities, binary incompatibility across OS distributions, prototype pollution, and uncontrolled runtime bloat.
- **Isolated Python Worker Subsystem**: Python 3.10+ is invoked in isolated mode (`-I`) exclusively as an untrusted subprocess for PDF layout and text extraction (`pdfplumber`, `pypdfium2`), strictly sandboxed from network access and application business logic.
- **SQLite Engine Configuration**:
  - `PRAGMA journal_mode = WAL;` (Concurrent readers during active writes).
  - `PRAGMA busy_timeout = 5000;` (Resilient lock wait handling).
  - `PRAGMA foreign_keys = ON;` (Strict referential integrity).
  - Virtual Tables: SQLite FTS5 with Porter stemming and Unicode61 tokenization for multilingual legal text.

---

## 2. Detailed 5-Layer Architectural Model

The AdvocateVox architecture is strictly organized into six decoupled tiers (Layer 0 through Layer 5), enforcing clear separation of concerns, data sovereignty, and deterministic verification.

```
+====================================================================================================+
|                     LAYER 5: PRESENTATION, CLIENT STREAMING & PRIVACY WORKBENCH                     |
|  - Teach Me Voice Studio (`web/teach.js`)              - Legal Reports Studio (`web/reports.js`)   |
|  - Practice Workbench (`web/practice.js`, `model.js`)  - Bare Act Copy Checker (`web/check.js`)    |
|  - Word .docx Gatekeeper (`web/reportDocx.js`)         - Pipelined Audio Prefetcher Controller     |
+====================================================================================================+
                                                  |
                                                  | HTTP / SSE / Client-Side Privacy Firewall
                                                  v
+====================================================================================================+
|                    LAYER 4: ROUTING, SECURITY & EVENT-DRIVEN SERVICE DISPATCH                      |
|  - Strict Content-Security-Policy (CSP) & Header Gating (`src/server.js`)                          |
|  - REST & SSE Endpoint Dispatcher (`src/routes.js`)                                                |
|  - High-Level Legal Service Facade (`src/service.js`)                                              |
|  - Request Concurrency Limiters & Bounded Worker Queues                                            |
+====================================================================================================+
                                                  |
                    +-----------------------------+-----------------------------+
                    |                                                           |
                    v                                                           v
+===========================================+   +====================================================+
|       LAYER 3: DETERMINISTIC VERIFIER     |   |          LAYER 2: MULTI-AGENT REPORT &             |
|             & PRECEDENT GRAPH             |   |                  SPEECH ENGINE                     |
| (`src/analysis/`, `src/compare/`, `cases`)|   | (`src/reports/`, `src/speech/indianVoice.js`)      |
|  - "Cite or Stay Silent" Refusal Engine   |   |  - Automated SC Case Discovery (`discovery.js`)    |
|  - Question Classifier (`questionAnalysis`|   |  - Typed Quote Card Extraction (`cards.js`)        |
|  - Literal Quote Matcher (5-word boundary)|   |  - Bounded DAG Section Drafter (`pipeline.js`)     |
|  - 6-Word Shingle Overlap Detector        |   |  - Multi-Draft Majority Voting & Consensus         |
|  - Bench Strength & Coram Ranks (1-13 SC) |   |  - Deterministic Repair Loop (5 rounds max)        |
|  - Overruling & Binding Status Resolver   |   |  - Sarvam Bulbul v3 Indian-English TTS Adapter     |
|  - Statutory Crosswalk (IPC/CrPC <-> BNS) |   |  - In-Memory Audio Cache & Burst Request Queue     |
+===========================================+   +====================================================+
                    |                                                           |
                    +-----------------------------+-----------------------------+
                                                  |
                                                  v
+====================================================================================================+
|                       LAYER 1: TEMPORAL RETRIEVAL & GROUNDING MATRIX                               |
| (`src/retrieval/legalRetriever.js`)                                                                |
|  - Point-in-Time Temporal Gate (`valid_from`, `valid_to`, `verified_through` boundary)             |
|  - Explicit Statutory Provision Resolution (Constitution, Central Acts, Subordinate Rules)         |
|  - Semantic Concept Classification (`LEGAL_CONCEPTS` taxonomy)                                     |
|  - In-Memory Token Set Term Coverage Filtering (sub-millisecond algorithmic pruning)               |
|  - Query Projection Optimization (zero redundant re-queries)                                       |
+====================================================================================================+
                                                  |
                                                  v
+====================================================================================================+
|                     LAYER 0: IMMUTABLE CONTENT VAULT & STORAGE SUBSYSTEM                           |
| (`src/store/db.js`, `src/store/cache.js`, `src/rag/corpus.js`)                                     |
|  - Main Legal Database (`lawbuddy.db`): 14 Schema Migrations, SQLite WAL, FTS5 BM25                |
|  - Practice Corpus Database (`practice-rag.db`): 43 Instruments, Chunk Indexes, FTS5 Unicode61     |
|  - In-Memory Sovereign LRU Cache (`SovereignLruCache`): Fast-path hit resolution                   |
|  - Persistent Corpus Loader & Precompiled Prepared Statement Pool                                  |
|  - Content-Addressed PDF Passage Cache (`sha256(pdfBuffer)`)                                       |
|  - eGazette Recursive TLS Certificate Chain Auto-Completion (`src/sources/tlsChain.js`)             |
+====================================================================================================+
```

### 2.1 Layer 5: Presentation, Streaming & Privacy Workbench
- **Components**:
  - `web/teach.js`: Interactive legal tutoring interface with real-time SSE token rendering, synchronized sentence-by-sentence neural audio playback, and cancel/abort control.
  - `web/reports.js`: Multi-stage legal memorandum generation dashboard displaying real-time extraction progress, quote card inspectability, claim consensus graphs, and quality metrics.
  - `web/practice.js` & `web/practiceModel.js`: Record-first practice workbench for criminal and civil matters (FIR analysis, anticipatory bail, remand, civil plaints).
  - `web/check.js`: Gazette and Bare Act copy audit interface detecting altered text, omissions, and outdated statutory editions.
  - `web/reportDocx.js` & `web/practiceDocx.js`: Client-side binary `.docx` generation strictly protected by cryptographic validation gates.
- **Client Privacy Boundary**: High-stakes client facts (accused identities, alleged transaction amounts, sensitive dates, local police station specifics) remain quarantined in browser-local memory or LocalStorage. Only neutral statutory questions, section numbers, and legal concept tags cross the network to the server.

### 2.2 Layer 4: Routing, Security & Event-Driven Dispatch
- **Components**:
  - `src/server.js`: Native HTTP server running on `node:http`. Enforces hardened HTTP headers:
    - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';` (Zero inline script evaluation, complete elimination of XSS vectors).
    - `X-Content-Type-Options: nosniff`.
    - `X-Frame-Options: DENY`.
  - `src/routes.js`: Uniform API routing engine handling `/advocatevox/api/*` and backward-compatible `/lawbuddy/api/*` endpoints. Implements request body limits (30MB maximum for PDF uploads, detached and drained immediately on overflow).
  - `src/service.js`: High-level orchestration facade mediating between HTTP endpoints and core domain engines.

### 2.3 Layer 3: Deterministic Verifier & Precedent Graph
- **Components**:
  - `src/analysis/questionAnalysis.js`: Classifies queries into 8 formal categories (`formal`, `scenario`, `permission`, `rights`, `procedure`, `punishment`, `definition`, `general`).
  - `src/analysis/answerCheck.js` & `answerCritique.js`: Post-generation claim auditors verifying clause quotations against primary retrieved statutory text and executing critique passes.
  - `src/compare/checkCopy.js` & `correspondence.js`: Performs literal text normalization, diff analysis, and cross-code correspondence between historical codes (IPC 1860, CrPC 1973, IEA 1872) and contemporary codes (BNS 2023, BNSS 2023, BSA 2023).
  - `src/cases/service.js`, `rank.js`, `brief.js`, `citationGraph.js`: Analyzes Supreme Court coram composition (1 to 13 judges), differentiates authors, concurrences, and dissents, applies binding bench hierarchy rules, and maps the citation treatment graph.

### 2.4 Layer 2: Multi-Agent Report & Speech Engine
- **Components**:
  - `src/reports/discovery.js`: Automatic Supreme Court judgment discovery from natural language prompts without manual metadata entry.
  - `src/reports/cards.js`: Literal quote card extraction engine identifying verbatim passages bounded by 5-word boundary locators.
  - `src/reports/pipeline.js`: Multi-stage DAG pipeline coordinating section drafting, claim verification, majority voting across independent seeds, and quality metric repair.
  - `src/reports/stages.js`: Persistent checkpoint manager enabling resumption of interrupted report runs with cryptographic request matching.
  - `src/speech/indianVoice.js`: Neural voice adapter connecting to Sarvam AI Bulbul v3 (`ishita`, `ratan`) with 24 kHz MP3 synthesis and device speech fallback.

### 2.5 Layer 1: Temporal Retrieval & Grounding Matrix
- **Components**:
  - `src/retrieval/legalRetriever.js`: The central cognitive routing gateway. It analyzes the incoming query against indexed central acts (Constitution, BNS, BNSS, BSA, IT Act 2000, CPC, POCSO, etc.).
  - Enforces Point-in-Time validity (`valid_from <= asOf < valid_to` and `verified_through >= asOf`). Queries beyond the audited verification horizon fail closed with `edition-not-verified-for-date`.
  - Evaluates term coverage using in-memory set intersections to discard spurious FTS matches.

### 2.6 Layer 0: Content Vault & Storage Subsystem
- **Components**:
  - `src/store/db.js`: Primary relational and full-text vault (`lawbuddy.db`). Implements 14 schema migrations tracking acts, provisions, versions, case briefs, citations, and change events.
  - `src/store/cache.js`: Zero-dependency, thread-safe `SovereignLruCache` providing sub-millisecond in-process caching for hot provisions and reference patterns.
  - `src/rag/corpus.js`: Secondary practice instrument corpus (`practice-rag.db`) indexing 43 practice manuals, circulars, and subordinate rules with BM25 ranking.
  - `src/sources/tlsChain.js`: Automated X.509 certificate chain builder resolving AIA (`Authority Information Access`) headers for government gazette portals (`egazette.gov.in`).

---

## 3. End-to-End Component Interactions & Data Flow Diagrams

### 3.1 Flow A: Interactive Voice Tutoring (Teach Me Flow)
The voice tutoring pipeline combines sub-second token streaming with pipelined neural speech prefetching.

```text
[Advocate / Student]             [Browser Client (teach.js)]           [AdvocateVox Server]         [Sarvam AI / Engine]
       |                                      |                                  |                           |
       |--- 1. Submits Legal Question ------->|                                  |                           |
       |    ("Can police search phone         |                                  |                           |
       |     without warrant under BNSS?")    |                                  |                           |
       |                                      |--- 2. POST /api/chat (SSE) ----->|                           |
       |                                      |                                  |--- 3. Classify Query ---->|
       |                                      |                                  |    (QuestionAnalysis)     |
       |                                      |                                  |--- 4. Temporal Retrieval->|
       |                                      |                                  |    (Point-in-time BNSS)   |
       |                                      |                                  |<-- 5. Primary Text Hit ---|
       |                                      |<-- 6. Stream SSE Tokens ---------|                           |
       |<-- 7. Display Live Token Stream -----|    (First sentence completed)    |                           |
       |                                      |                                  |                           |
       |                                      |--- 8. POST /api/speech (Sent 1)->|                           |
       |                                      |       (Prefetch Sentence 1)      |--- 9. Bulbul v3 TTS ----->|
       |                                      |                                  |<-- 10. Base64 MP3 Audio---|
       |                                      |<-- 11. Return Audio Chunk 1 -----|                           |
       |<-- 12. Playback Audio (Sentence 1) --|                                  |                           |
       |                                      |--- 13. POST /api/speech (Sent 2)->|                           |
       |                                      |       (Concurrent Prefetch)      |--- 14. Bulbul v3 TTS ---->|
       |                                      |       [DURING SENTENCE 1 PLAY]   |<-- 15. Base64 MP3 Audio---|
       |                                      |<-- 16. Return Audio Chunk 2 -----|                           |
       |<-- 17. Seamless Transition to Sent 2-|                                  |                           |
       |    (ZERO AUDIBLE DEAD SILENCE GAP)   |                                  |                           |
```

### 3.2 Flow B: Multi-Stage Evidence-Grounded Legal Report Flow
The legal report generator transforms raw judgments and statutory provisions into verified legal memoranda.

```text
[Advocate]                     [Reports Studio]              [Pipeline Controller]             [LLM Workers & Verifiers]
    |                                 |                                |                                   |
    |-- 1. Prompt / Case Citation --->|                                |                                   |
    |   ("Puttaswamy privacy ruling") |--- 2. POST /api/reports ------>|                                   |
    |                                 |                                |-- 3. Discover SC Case & PDF ----->|
    |                                 |                                |<-- 4. PDF Text (Passage Cache) ---|
    |                                 |                                |                                   |
    |                                 |                                |-- 5. Bounded DAG Extraction ----->|
    |                                 |                                |    (runConcurrent, limit=3)       |
    |                                 |                                |    Chunks 0, 1, 2 in parallel --->|
    |                                 |                                |<-- 6. Typed Literal Quote Cards --|
    |                                 |                                |                                   |
    |                                 |                                |-- 7. Bounded DAG Section Drafting |
    |                                 |                                |    (Facts, Issues, Holding)       |
    |                                 |                                |    Drafts 0..N in parallel ------>|
    |                                 |                                |<-- 8. Section Draft Candidates ---|
    |                                 |                                |                                   |
    |                                 |                                |-- 9. Batched Claim Verification ->|
    |                                 |                                |    (5 claims per batch, parallel)-|
    |                                 |                                |<-- 10. SUPPORTED / REJECTED ------|
    |                                 |                                |                                   |
    |                                 |                                |-- 11. Majority Voting Consensus --|
    |                                 |                                |-- 12. Quality Gate Audit ---------|
    |                                 |                                |    (Shingles, Banned Phrases)     |
    |                                 |<-- 13. Stream Progress Updates |                                   |
    |                                 |<-- 14. Final Report Payload ---|                                   |
    |                                 |                                                                    |
    |                                 |-- 15. Check Quality Gate & Shingle Metrics                         |
    |                                 |       [PASSED: 100% Verified Claims]                               |
    |<-- 16. Unlock Word .docx Export-|                                                                    |
    |-- 17. Click Download .docx ---->|                                                                    |
    |<-- 18. Deliver Compiled File ---|                                                                    |
```

### 3.3 Flow C: Practice Matter Intake & Chamber Privacy Firewall
Ensures absolute client confidentiality within the advocate's local chamber.

```text
+----------------------------------------------------------------------------------------------------+
|                                    CLIENT BROWSER (LOCAL CHAMBER)                                  |
|                                                                                                    |
|  +----------------------------------------------------------------------------------------------+  |
|  | PRACTICE WORKBENCH INTAKE:                                                                   |  |
|  | - Client Name: "Ramesh Sharma"          - Alleged Offence Date: "2024-08-15"                 |  |
|  | - Police Station: "Indiranagar PS"     - Seized Property: "Encrypted Laptop & Mobile"       |  |
|  | - Accusation Summary: "Alleged unauthorised penetration testing under IT Act § 43/66"        |  |
|  | - Desired Relief: "Anticipatory Bail under BNSS § 482"                                       |  |
|  +----------------------------------------------------------------------------------------------+  |
|                                                |                                                   |
|                        LOCAL SENSITIVE DATA ENCLAVE (Never Leaves Browser)                          |
|                                                |                                                   |
|                        SANITIZATION & STATUTORY PROJECTION MATRIX                                  |
|                                                |                                                   |
|         Transmitted Statutory Query Payload   | (Zero Client Facts / Zero Accused Identifiers)     |
|         - Target Act: "BNSS"                   |                                                   |
|         - Section: "482"                       |                                                   |
|         - Accused Act: "IT2000 s.43, s.66"     |                                                   |
|         - Date: "2024-08-15"                   |                                                   |
|         - Forum Question: "Sessions or HC?"    |                                                   |
|                                                v                                                   |
+------------------------------------------------+---------------------------------------------------+
                                                 |
                                                 | HTTPS POST /advocatevox/api/lookup
                                                 v
+----------------------------------------------------------------------------------------------------+
|                              ADVOCATE VOX SERVER (STATUTORY RETRIEVAL)                             |
|                                                                                                    |
|  1. Verify BNSS § 482 In-Force Status on 2024-08-15.                                               |
|  2. Crosswalk IT Act § 43/66 penalties and bailability schedule.                                   |
|  3. Detect Forum Bar: Warn if user selected Magistrate (BNSS § 482 is High Court / Sessions only).  |
|  4. Return Statutory Text, Legal Precedent Cards, and Verified Forum Rules.                        |
+----------------------------------------------------------------------------------------------------+
                                                 |
                                                 | HTTPS Response (Statutory Rules & Cards)
                                                 v
+----------------------------------------------------------------------------------------------------+
|                                    CLIENT BROWSER (LOCAL CHAMBER)                                  |
|                                                                                                    |
|  Local Merging: Merges retrieved statutory text with quarantined client facts in browser RAM.     |
|  Word .docx Drafting: Local assembly of petition without exposing facts to external LLMs.          |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Core System Design Principles for Latency Reduction

An empirical audit of the baseline AdvocateVox MVP identified 9 critical latency bottlenecks spanning database query storms, ephemeral connection teardowns, unpipelined speech synthesis, and serial LLM chaining. To eliminate these bottlenecks without compromising the sovereign zero-dependency architecture or legal verification invariants, AdvocateVox establishes six foundational system design principles.

```
+====================================================================================================+
|                        6 CORE SYSTEM DESIGN PRINCIPLES FOR LATENCY REDUCTION                       |
+====================================================================================================+
| 1. Bounded Concurrency DAG Execution   | Eliminates serial LLM awaits via bounded worker pools.    |
| 2. Persistent Resource Lifecycle Pool  | Eliminates per-request SQLite connection churn & compile. |
| 3. In-Memory Algorithmic Simplification| Converts O(KxM) SQL query storms into sub-ms Set math.    |
| 4. Two-Tier Sovereign LRU Caching      | In-memory hot-path caching for immutable statutory text.  |
| 5. Speculative Audio Prefetching       | Pipelined sentence synthesis eliminating audio dead gaps. |
| 6. Content-Addressed Passage Caching   | SHA-256 memoization eliminating Python VM cold-starts.    |
+====================================================================================================+
```

### 4.1 Principle 1: Bounded Concurrency DAG Execution
- **Problem**: In the MVP, legal report generation sequentially executes chunk extraction (10–18 chunks), section drafting (6–9 sections $\times$ 5 seeds = 30–45 drafts), and claim verification batches. Each model call is sequentially awaited (`for (const ... of ...) { await runner.call(...) }`), resulting in 60 to 180+ seconds of blocking wall-clock latency.
- **Architectural Solution**: Transform serial loops into an asynchronous Directed Acyclic Graph (DAG) governed by a zero-dependency bounded concurrency executor `runConcurrent(items, limit, workerFn)`:
  - **Chunk Card Extraction**: Multiple judgment chunks are extracted concurrently with a concurrency limit of $N=3$.
  - **Section Drafting**: Independent sections (Facts, Procedural History, Issues, Reasoning, Holding, Order) have zero cross-dependencies and are drafted concurrently.
  - **Claim Verification**: Independent claim batches (5 claims per batch) are dispatched concurrently to the verifier model.
  - **Bounded Concurrency Guarantee**: Concurrency limits ($N=3\text{ to }5$) prevent event-loop thread starvation, socket exhaustion, and provider rate-limiting (e.g. Groq TPM ceilings).

### 4.2 Principle 2: Persistent Resource Lifecycle & Statement Caching
- **Problem**: API endpoints `/lawbuddy/api/rag/search`, `/rag/coverage`, and `/catalog` call `openCorpus()` on every request, executing `new DatabaseSync(file)` and `PRAGMA` setup, followed immediately by `corpus.close()`. Inside `search()`, prepared statements are compiled dynamically inside iteration loops (`db.prepare(...)` executed for every search hit).
- **Architectural Solution**:
  - Implement a persistent connection manager `getCorpusLoader(file)` mirroring `createLegalStoreLoader`, maintaining a singleton connection handle across requests.
  - Compile SQLite prepared statements exactly once during corpus initialization (`statements.adjacentContext`, `statements.search`, `statements.upsert`).

### 4.3 Principle 3: Algorithmic Query Simplification & Projection
- **Problem**:
  1. `store.termCoverage` in `src/store/db.js` executes $K$ search hits $\times M$ question words individual SQLite FTS queries (`statements.versionMatches.get(versionId, '"' + term + '"')`), causing up to 120 synchronous database roundtrips per search.
  2. `searchEvidence` in `src/retrieval/legalRetriever.js` matches provisions in BM25, but because `pv.text` and metadata were omitted from the SELECT projection, it re-queries `actIdFor` and `getProvisionAsOf` for every candidate.
  3. `casesForProvision` in `src/cases/service.js` triggers N+1 queries (`getCaseBrief`, `verifiedReviewsFor`, `citationsOf`, and `getCase`) for each ranked judgment.
- **Architectural Solution**:
  - Replace the SQL-based `termCoverage` loop with an **in-memory token set intersection**. By tokenizing and stemming the question once and checking against an in-memory `Set` of the provision's normalized words, 120 SQLite queries reduce to 0 queries in sub-millisecond memory arithmetic.
  - Expand the BM25 search projection to include all required fields (`text`, `judicial_notes`, `pending_amendments`, `act_id`), completely eliminating downstream re-queries.
  - Batch case precedent queries using `WHERE id IN (...)` and pass case metadata directly through `citationsOf`, eliminating N+1 queries.

### 4.4 Principle 4: In-Memory Sovereign LRU Caching
- **Problem**: Official Indian statutes (Constitution of India, Bharatiya Nyaya Sanhita, Information Technology Act 2000) and historical judgments are immutable for a specific `asOf` date and content hash. Re-reading them from SQLite on every request wastes CPU cycles and disk I/O.
- **Architectural Solution**:
  - Deploy `SovereignLruCache` (`src/store/cache.js`) with an $O(1)$ doubly-linked Map implementation and TTL expiration.
  - Hot provisions, parsed statutory reference regexes (`detectLegalReferences`), and cross-code correspondence mappings are served directly from RAM in $<0.2\text{ms}$.

### 4.5 Principle 5: Speculative Audio Prefetching & Playback Pipelining
- **Problem**: In `web/teach.js`, the client waits for speech segment $N$ to play to completion before sending the HTTP fetch request for segment $N+1$. Users experience an audible 1 to 3 second dead gap of silence between every paragraph.
- **Architectural Solution**:
  - Implement a two-stage pipelined audio prefetch queue. While segment $N$ is actively playing, the client speculatively prefetches segment $N+1$ in the background.
  - Upon completion of segment $N$, segment $N+1$'s audio buffer is already decoded and begins playback instantaneously ($<20\text{ms}$ transition).
  - Implement an in-memory/disk audio cache in `src/speech/indianVoice.js` keyed by `sha256(voice + rate + text)`, avoiding duplicate external calls to Sarvam AI.

### 4.6 Principle 6: Content-Addressed Passage Caching
- **Problem**: PDF extraction spawns an isolated Python worker process (`workers/pdf_extract.py`). Python process initialization overhead was empirically measured at **231ms to 358ms** per invocation. When analyzing judgments across discovery and briefing stages, identical PDFs are repeatedly parsed by spawning new Python subprocesses.
- **Architectural Solution**:
  - Implement content-addressed passage caching keyed by the document's cryptographic `sha256` hash.
  - Parsed pages and paragraph passage structures are cached in memory/disk upon first extraction. Subsequent reads for the same judgment bypass Python execution entirely, reducing extraction time from $>500\text{ms}$ to $<1\text{ms}$.

---

## 5. Security & Verification Invariants

1. **The Silence Invariant**: Under no circumstances may an ungrounded or out-of-scope query trigger creative text synthesis. Missing coverage must yield `not-indexed`, `not-indexed-as-of`, or `identity-check-required`.
2. **The 6-Word Shingle Invariant**: In drafted reports, no continuous sequence of 6 or more words from the primary source text may appear without literal quotation attribution.
3. **The Bench Hierarchy Invariant**: A smaller bench cannot overrule a larger bench. An alleged overruling by a 2-judge bench of a 5-judge Constitution Bench is flagged as legally non-binding.
4. **The Export Lock Invariant**: Word `.docx` download buttons remain cryptographically disabled until 100% of claims pass literal quotation matching, boundary anchor verification, and quality gates.

---
*Authored for AdvocateVox Sovereign Legal Intelligence Runtime.*
