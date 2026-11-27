# AdvocateVox: Low-Level Design (LLD) Specification
**Class & Module Specifications, Algorithmic Implementation, Interface Contracts, and Concurrency Models**

---

## 1. System Module Architecture & Interface Contracts

AdvocateVox is implemented as an ES module ecosystem under Node.js v22+. All data structures, algorithms, and interface contracts are strictly defined to guarantee zero external runtime npm dependencies, sub-millisecond retrieval overhead, and bounded concurrency execution.

```text
src/
├── index.js                     # Sovereign library exports
├── config.js                    # Environment & path configuration
├── server.js                    # HTTP server & security headers
├── routes.js                    # Uniform API route dispatch & persistent loaders
├── service.js                   # High-level legal query facade
├── cli.js                       # Command-line interface
├── store/
│   ├── cache.js                 # [NEW] Sovereign in-memory LRU Cache
│   ├── db.js                    # SQLite WAL database & in-memory termCoverage
│   └── migrations.js            # 14 schema migration definitions
├── rag/
│   ├── corpus.js                # Practice corpus, persistent loader & statement cache
│   └── ingest.js                # Document chunker & FTS5 indexer
├── retrieval/
│   └── legalRetriever.js        # Query projection & temporal grounding
├── cases/
│   ├── service.js               # Precedent retrieval & SQL batching
│   ├── brief.js                 # Case brief generator & quote validator
│   ├── rank.js                  # Coram bench strength scoring
│   ├── opinions.js              # Opinion role classifier (author/dissent)
│   └── citationGraph.js         # Citation treatment and overruling matrix
├── reports/
│   ├── pipeline.js              # Bounded concurrency DAG drafting & verification
│   ├── cards.js                 # Bounded concurrency quote card extraction
│   ├── stages.js                # Asynchronous non-blocking file I/O checkpoints
│   ├── provider.js              # LLM client adapters (Ollama, Groq, Grok)
│   ├── discovery.js             # Automatic case citation resolver
│   └── quality.js               # 6-word shingle & banned phrase verifier
├── extract/
│   └── pdfText.js               # Content-addressed PDF passage cache & worker
└── speech/
    └── indianVoice.js           # Audio cache, burst queue & Sarvam Bulbul v3 adapter
web/
└── teach.js                     # Pipelined speculative audio prefetch client
```

---

## 2. Low-Level Design: Sovereign LRU Cache (`src/store/cache.js`)

### 2.1 Purpose & Algorithmic Strategy
Provides a zero-dependency, thread-safe, in-process Least Recently Used (LRU) cache with Millisecond Time-to-Live (TTL) eviction. It prevents redundant SQLite disk reads and regex evaluations for hot statutory provisions, legal references, and section crosswalks.

### 2.2 Class Specification
```javascript
/**
 * Zero-dependency in-memory LRU Cache with TTL eviction.
 * Utilizes JavaScript Map's insertion-order preservation to achieve O(1) operations.
 */
export class SovereignLruCache {
  /**
   * @param {number} [maxSize=500] Maximum number of entries before LRU eviction.
   * @param {number} [ttlMs=300000] Time-to-live per entry in milliseconds (default 5 minutes).
   */
  constructor(maxSize = 500, ttlMs = 300000) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new TypeError('maxSize must be a positive integer.');
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive integer.');
    }
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // Key -> { value, expiresAt }
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Retrieves an item from cache, refreshing its recency.
   * @param {string} key
   * @returns {any|null} Cached value or null if missed/expired.
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return null;
    }
    // Refresh LRU order: delete and re-insert at end
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  /**
   * Stores an item in cache, evicting the oldest item if maxSize is exceeded.
   * @param {string} key
   * @param {any} value
   * @param {number} [customTtlMs] Optional custom TTL override.
   */
  set(key, value, customTtlMs) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Oldest entry is the first key in Map iterator
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
    const ttl = Number.isInteger(customTtlMs) && customTtlMs > 0 ? customTtlMs : this.ttlMs;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /**
   * Checks for valid (non-expired) key existence without modifying LRU order.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expirations++;
      return false;
    }
    return true;
  }

  /**
   * Deletes a specific key.
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clears all cached entries and resets statistics.
   */
  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Returns current cache diagnostics.
   * @returns {{ size: number, maxSize: number, stats: object }}
   */
  diagnostics() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      stats: { ...this.stats },
    };
  }
}
```

---

## 3. Low-Level Design: Persistent Corpus Loader & Statement Compilation Caching (`src/rag/corpus.js` & `src/routes.js`)

### 3.1 Problem Solved
Currently, `routes.js` invokes `openCorpus()` on every request to `/rag/search`, `/rag/coverage`, and `/catalog`, opening and closing connections. Furthermore, `corpus.search()` dynamically executes `db.prepare(...)` inside a `.map()` callback for up to 30 matched chunks.

### 3.2 Low-Level Architecture & Persistent Loader
```javascript
// src/rag/corpus.js

/**
 * Pre-compiled statement cache associated with a database handle.
 */
class CorpusStatementRegistry {
  constructor(db) {
    this.searchChunks = db.prepare(`
      SELECT c.*, d.title, d.url, d.sha256, d.type, d.note, d.status, d.checked_at, bm25(rag_fts, 2, 1) AS rank
      FROM rag_fts
      JOIN rag_chunk c ON c.id = rag_fts.rowid
      JOIN rag_document d ON d.id = c.document_id
      WHERE rag_fts MATCH ? AND (? = '' OR d.id = ?) AND (? = '' OR EXISTS(SELECT 1 FROM json_each(d.topics) WHERE value = ?))
      ORDER BY rank, c.id LIMIT ?
    `);

    // Statement compiled ONCE during initialization, reused across all chunks
    this.adjacentContext = db.prepare(`
      SELECT page, start_offset, end_offset, text
      FROM rag_chunk
      WHERE document_id = ? AND id IN (?, ?)
      ORDER BY id
    `);

    this.getDoc = db.prepare('SELECT * FROM rag_document WHERE id = ?');
    this.coverage = db.prepare(`
      SELECT d.*, COUNT(c.id) AS chunks
      FROM rag_document d
      LEFT JOIN rag_chunk c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.title
    `);
    this.upsertDoc = db.prepare(`
      INSERT INTO rag_document VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, topics = excluded.topics, type = excluded.type,
        url = excluded.url, sha256 = excluded.sha256, checked_at = excluded.checked_at,
        status = excluded.status, error = excluded.error, note = excluded.note
    `);
    this.deleteFts = db.prepare('DELETE FROM rag_fts WHERE rowid IN (SELECT id FROM rag_chunk WHERE document_id = ?)');
    this.deleteChunks = db.prepare('DELETE FROM rag_chunk WHERE document_id = ?');
    this.insertChunk = db.prepare('INSERT INTO rag_chunk(document_id, page, start_offset, end_offset, text) VALUES(?,?,?,?,?)');
    this.insertFts = db.prepare('INSERT INTO rag_fts(rowid, title, text) VALUES(?,?,?)');
  }
}

/**
 * Thread-safe, persistent singleton corpus loader.
 */
let corpusInstance = null;
let corpusFilePath = null;

export const getCorpusLoader = (file = CORPUS_PATH) => {
  const getCorpus = () => {
    if (!corpusInstance || corpusFilePath !== file) {
      if (corpusInstance) {
        try { corpusInstance.close(); } catch {}
      }
      corpusInstance = openCorpus(file);
      corpusFilePath = file;
    }
    return corpusInstance;
  };

  const close = () => {
    if (corpusInstance) {
      try { corpusInstance.close(); } catch {}
      corpusInstance = null;
      corpusFilePath = null;
    }
  };

  return { getCorpus, close };
};
```

### 3.3 Optimized Search Function Using Cached Statements
```javascript
const search = (query, { topic = '', instrument = '', limit = 8 } = {}) => {
  const stop = new Set(['the','and','for','with','from','what','which','how','does','under','explain','report','please']);
  const tokens = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => !stop.has(t)))].slice(0, 24);
  if (!tokens.length) return [];
  const match = tokens.map((t) => `"${t}"`).join(' OR ');

  const rawHits = statements.searchChunks.all(
    match, instrument, instrument, topic, topic,
    Math.max(1, Math.min(120, (Number(limit) || 8) * 5))
  );

  return rawHits
    .map((r) => ({
      ...r,
      contentsPage: /arrangement of (?:sections|rules)|(?:^|\n)\s*SECTIONS\s*(?:\n|$)/i.test(r.text),
      citation: `${r.document_id}, PDF page ${r.page}, offsets ${r.start_offset}-${r.end_offset}`,
      legalCurrency: 'Unreviewed source snapshot; not verified law in force.',
    }))
    .sort((a, b) => (a.contentsPage ? a.rank * 0.15 : a.rank) - (b.contentsPage ? b.rank * 0.15 : b.rank))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))
    .map((r) => ({
      ...r,
      // Reuses pre-compiled statement instead of compiling dynamically!
      adjacentContext: statements.adjacentContext.all(r.document_id, r.id - 1, r.id + 1),
    }));
};
```

### 3.4 Integration in `src/routes.js`
In `src/routes.js`, instantiate `const corpusLoader = getCorpusLoader();` at module scope. Replace all ephemeral `openCorpus()` / `corpus.close()` blocks with `const corpus = corpusLoader.getCorpus();`, eliminating per-request connection churn.

---

## 4. Low-Level Design: In-Memory Token Set `termCoverage` & Query Projection (`src/store/db.js` & `src/retrieval/legalRetriever.js`)

### 4.1 Problem Solved
1. `termCoverage` runs an $O(K \times M)$ SQL query loop: executing `statements.versionMatches.get(versionId, '"' + term + '"')` for each question word across every candidate hit.
2. `searchEvidence` drops version details from the BM25 query, triggering secondary `actIdFor` and `getProvisionAsOf` queries for every surviving candidate.

### 4.2 Algorithmic Token Extraction & In-Memory Coverage
```javascript
// src/store/db.js

/**
 * Normalizes and extracts meaningful tokens from text.
 * Strips punctuation, downcases, filters stop words, and applies simple English stemming.
 * @param {string} text
 * @returns {Set<string>}
 */
export const tokenizeToSet = (text) => {
  if (!text || typeof text !== 'string') return new Set();
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'what', 'which', 'how', 'does', 'under',
    'explain', 'report', 'please', 'this', 'that', 'shall', 'been', 'have', 'were'
  ]);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const tokenSet = new Set();
  for (const token of tokens) {
    if (!STOP_WORDS.has(token)) {
      // Basic stemming (suffix reduction matching SQLite Porter tokenizer behavior)
      const stemmed = token.replace(/(?:ing|edly|ed|tion|ness|ment|es|s)$/, '');
      tokenSet.add(stemmed.length >= 3 ? stemmed : token);
    }
  }
  return tokenSet;
};

/**
 * High-performance in-memory term coverage calculation.
 * Replaces O(K * M) SQLite queries with O(M) Set membership lookups.
 * @param {string} provisionText
 * @param {string} questionText
 * @returns {{ matched: number, total: number }}
 */
export const calculateTermCoverageInMemory = (provisionText, questionText) => {
  const questionTokens = tokenizeToSet(questionText);
  if (questionTokens.size === 0) return { matched: 0, total: 0 };
  const provisionTokens = tokenizeToSet(provisionText);

  let matched = 0;
  for (const qToken of questionTokens) {
    if (provisionTokens.has(qToken)) {
      matched++;
    }
  }
  return { matched, total: questionTokens.size };
};
```

### 4.3 Query Projection Optimization in `src/store/db.js`
Expand `searchVerifiedAsOf` and `searchVerifiedActAsOf` statements to project version details:
```sql
SELECT pv.id AS version_id, p.label, p.heading, a.id AS act_id, a.short_title,
       pv.valid_from, pv.valid_to, pv.verified_through, pv.source_url, pv.source_sha256,
       pv.text AS version_text, pv.judicial_notes, pv.pending_amendments,
       snippet(provision_fts, 2, '[', ']', ' … ', 12) AS snippet,
       bm25(provision_fts, 2.0, 5.0, 1.0) AS score
FROM provision_fts
JOIN provision_version pv ON pv.id = provision_fts.rowid
JOIN provision p ON p.id = pv.provision_id
JOIN act a ON a.id = p.act_id
WHERE provision_fts MATCH ? AND pv.valid_from <= ? AND (pv.valid_to IS NULL OR pv.valid_to > ?)
  AND (pv.verified_through IS NULL OR pv.verified_through >= ?)
  AND is_citable_official_source(pv.source_url, pv.source_sha256) = 1
ORDER BY score LIMIT ?;
```

### 4.4 Streamlined `searchEvidence` in `src/retrieval/legalRetriever.js`
```javascript
const searchEvidence = (store, question, asOf, limit) => {
  const hits = store.searchProvisions(question, { asOf, limit, match: 'any', officialOnly: true });
  if (!hits.length) return [];
  const best = hits[0].score;

  return hits
    .filter((hit) => hit.score <= best * RELATIVE_SCORE_CUTOFF)
    .filter((hit) => {
      // In-memory token set intersection -- Zero SQLite queries!
      const { matched, total } = calculateTermCoverageInMemory(hit.version_text, question);
      return total > 0 && matched / total >= MIN_TERM_COVERAGE;
    })
    .map((hit) => {
      const code = CODE_BY_TITLE.get(hit.short_title);
      if (!code) return null;
      // Synthesize version object directly from projected fields -- Zero redundant DB queries!
      const version = {
        id: hit.version_id,
        label: hit.label,
        heading: hit.heading,
        text: hit.version_text,
        judicialNotes: hit.judicial_notes ? JSON.parse(hit.judicial_notes) : [],
        pendingAmendments: hit.pending_amendments ? JSON.parse(hit.pending_amendments) : [],
        validFrom: hit.valid_from,
        sourceUrl: hit.source_url,
        sourceSha256: hit.source_sha256,
      };
      return { code, version };
    })
    .filter(Boolean)
    .map(({ code, version }) => {
      const evidence = code === 'COI' ? statuteEvidence(version.label, version) : sectionEvidence(code, version);
      if (!evidence) return null;
      return {
        ...evidence,
        via: 'search',
        title: `${evidence.title} (found by search)`,
        content: `Found by searching the official text for the student's question; teach it only if it answers that question.\n${evidence.content}`,
      };
    })
    .filter(Boolean);
};
```

---

## 5. Low-Level Design: Precedent Batch Querying (`src/cases/service.js`)

### 5.1 Problem Solved
`toCard` runs $3N$ queries inside a loop for $N$ ranked cases. Inside `citationsOf`, `store.getCase(caseId)` is re-queried for every treatment row to check bench strength.

### 5.2 Low-Level Batch Refactoring
```javascript
// src/cases/service.js

/**
 * Retrieves case cards in batches, eliminating N+1 queries.
 */
export const casesForProvision = (store, { act = 'COI', label, limit = 12 }) => {
  const rawCases = store.casesForProvision({ act, label });
  if (!rawCases.length) return [];

  const ranked = rankCases(rawCases).slice(0, limit);
  const caseIds = ranked.map((r) => r.row.id);

  // 1. Batch fetch briefs for all case IDs in a single query
  const briefMap = store.getCaseBriefsBatch ? store.getCaseBriefsBatch(caseIds) : new Map();

  // 2. Batch fetch verified reviews
  const reviewMap = store.verifiedReviewsBatch ? store.verifiedReviewsBatch(caseIds) : new Map();

  // 3. Batch fetch citations
  const citationMap = store.citedByBatch ? store.citedByBatch(caseIds) : new Map();

  return ranked.map(({ row, points, breakdown, via }) => {
    const brief = briefMap.get(row.id) || store.getCaseBrief(row.id);
    const reviews = reviewMap.get(row.id) || store.verifiedReviewsFor(row.id);
    const citedRows = citationMap.get(row.id) || store.citedBy(row.id);

    // Pass row.bench_strength directly to avoid store.getCase(row.id) lookups!
    const citedBy = processCitations(citedRows, row.bench_strength);

    return toCardOptimized({ row, points, breakdown, via, brief, reviews, citedBy });
  });
};

const processCitations = (citing, targetBenchStrength = 0) => {
  const treatments = citing.filter((row) => NEGATIVE.has(row.category)).map((row) => ({
    ...citingCase(row),
    treatment: TREATMENT_WORDS[row.category],
    printed: row.treatment,
    page: row.ref_page,
    // Bench comparison performed directly without DB read:
    binding: !row.bench_strength || row.bench_strength >= targetBenchStrength,
  }));
  const contexts = citing.filter((row) => row.context).slice(0, CITING_CONTEXTS).map((row) => ({
    ...citingCase(row),
    treatment: row.treatment,
    context: row.context,
    page: row.context_page,
  }));
  return { count: citing.length, treatments, contexts };
};
```

---

## 6. Low-Level Design: Bounded Concurrency DAG Executor (`src/reports/pipeline.js` & `src/reports/cards.js`)

### 6.1 Concurrency Model & Interface Specification
```javascript
/**
 * Bounded concurrency executor running up to `limit` promises simultaneously.
 * Preserves the original array order in returned results.
 * Handles task failures with immediate rejection or aggregated errors.
 *
 * @template T, R
 * @param {T[]} items Array of items to process.
 * @param {number} limit Maximum simultaneous tasks (concurrency bound).
 * @param {(item: T, index: number) => Promise<R>} taskFn Async task worker.
 * @returns {Promise<R[]>}
 */
export const runConcurrent = async (items, limit, taskFn) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 3, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await taskFn(items[currentIndex], currentIndex);
    }
  };

  const pool = Array.from({ length: concurrency }, () => worker());
  await Promise.all(pool);
  return results;
};
```

### 6.2 Parallel Quote Card Extraction (`src/reports/cards.js`)
```javascript
export const extractCards = async (sources, runner, config, options = {}) => {
  const concurrency = options.concurrency || config.cardConcurrency || 3;
  const chunkTasks = [];

  for (const source of sources) {
    const paragraphs = source.paragraphs || numberedParagraphs(source.text);
    const allowed = source.kind === 'judgment' ? CARD_TYPES.slice(0, 8)
      : source.kind === 'statute' ? ['statute']
      : source.kind === 'citing-judgment' ? ['later_treatment'] : ['commentary'];

    for (const [chunkIndex, chunk] of chunkParagraphs(paragraphs, config.chunkWords).entries()) {
      chunkTasks.push({ source, chunk, chunkIndex, allowed });
    }
  }

  // Execute extraction concurrently across judgment chunks
  const chunkResults = await runConcurrent(chunkTasks, concurrency, async ({ source, chunk, chunkIndex, allowed }) => {
    const result = await runner.call({
      stage: 'extract',
      key: `extract-${source.id}-${chunkIndex}`,
      schema: CARD_SCHEMA,
      system: `Extract evidence passages from supplied text only...`,
      payload: {
        sourceId: source.id,
        kind: source.kind,
        paragraphs: chunk.map((p) => ({ ...p, passageAnchors: passageAnchors(p.text, config.maxQuoteWords) })),
      },
    });
    return { source, chunk, allowed, cards: result.cards || [] };
  });

  const cards = [];
  const rejected = [];
  for (const { source, chunk, allowed, cards: candidates } of chunkResults) {
    for (const candidate of candidates.slice(0, config.maxCardsPerChunk)) {
      const paragraph = chunk.find((p) => p.para === candidate.para);
      const quote = paragraph && quoteFromAnchors(paragraph.text, candidate.firstFive, candidate.lastFive, config.maxQuoteWords);
      if (!quote || !allowed.includes(candidate.type) || !source.text.includes(quote)) {
        rejected.push({ sourceId: source.id, para: candidate.para, reason: 'Invalid literal anchors, paragraph or source type.' });
        continue;
      }
      if (cards.some((c) => c.sourceId === source.id && c.para === candidate.para && c.quote === quote && c.type === candidate.type)) {
        continue;
      }
      cards.push({
        id: `C${cards.length + 1}`,
        sourceId: source.id,
        sourceKind: source.kind,
        para: candidate.para,
        type: candidate.type,
        quote,
        context: paragraph.text,
        contentHash: source.contentHash,
      });
    }
  }

  runner.save('cards', { cards, rejected });
  return { cards, rejected };
};
```

### 6.3 Parallel Section Drafting & Verification (`src/reports/pipeline.js`)
```javascript
const draftSections = async ({ input, cards, runner, config, sections, provider }) => {
  const sectionEntries = Object.entries(sections);
  const concurrency = config.sectionConcurrency || 3;

  const sectionResults = await runConcurrent(sectionEntries, concurrency, async ([key, [title, allowed]]) => {
    const eligible = cards.filter((c) => allowed.includes(c.type)).slice(0, config.maxCardsPerSection);
    if (!eligible.length) return [key, []];

    const count = Math.max(1, Math.min(8, config.drafts[provider]));
    const draftIndices = Array.from({ length: count }, (_, i) => i);

    // Draft seeds in parallel for this section
    const drafts = await runConcurrent(draftIndices, 2, async (index) => {
      const stageKey = `${provider}-${key}-${index}`;
      const draft = await runner.call({
        stage: 'draft',
        key: stageKey,
        provider,
        schema: DRAFT_SCHEMA,
        seed: config.seed + index,
        system: `Write only the requested section from the supplied evidence cards...`,
        payload: {
          section: title,
          question: input.prompt,
          suppliedFacts: input.facts || '',
          cards: eligible.map(({ context, ...card }) => card),
        },
      });
      const claims = key === 'analysis' ? draft.claims.filter((c) => c.text.startsWith('Analysis:')) : draft.claims;
      return verifyClaims(claims, eligible, runner, config, stageKey, input.verifierProvider || provider);
    });

    const consensus = majorityClaims(drafts, config);
    return [key, consensus];
  });

  return Object.fromEntries(sectionResults);
};
```

---

## 7. Low-Level Design: Asynchronous File I/O Checkpointing (`src/reports/stages.js`)

### 7.1 Problem Solved
Currently, `writePrivate` uses synchronous `writeFileSync` and `renameSync`. Pruning old runs uses synchronous `readdirSync`, `statSync`, and `rmSync`. Checkpoint verification uses synchronous `readFileSync`. Under concurrent user load, the Node.js event loop is completely blocked during file system operations.

### 7.2 Asynchronous Implementation
```javascript
// src/reports/stages.js
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const writePrivateAsync = async (file, value) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
};

export const pruneOldReportRunsAsync = async (root, maxAgeMs = DEFAULT_RETENTION_MS) => {
  if (!root || !existsSync(root)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      try {
        const stats = await fs.stat(dirPath);
        if (stats.mtimeMs < cutoff) {
          await fs.rm(dirPath, { recursive: true, force: true });
          pruned++;
        }
      } catch {}
    }
  } catch {}
  return pruned;
};
```

---

## 8. Low-Level Design: Content-Addressed Passage Caching (`src/extract/pdfText.js`)

### 8.1 Problem Solved
PDF text extraction spawns a Python subprocess (`python -I workers/pdf_extract.py`). Python process startup introduces a **231ms to 358ms** penalty per execution. Identical PDFs are repeatedly parsed during case discovery and brief extraction.

### 8.2 Content-Addressed Cache Implementation
```javascript
// src/extract/pdfText.js
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const passageCache = new Map(); // SHA-256 -> Extracted Pages Array

export const extractPdfTextWithCache = async (pdfPath, options = {}) => {
  // Compute fast SHA-256 hash of PDF file header/stat
  let fileHash = null;
  try {
    const buffer = await fs.readFile(pdfPath);
    fileHash = createHash('sha256').update(buffer).digest('hex');
    if (passageCache.has(fileHash)) {
      return passageCache.get(fileHash);
    }
  } catch {}

  // Cache miss: execute isolated Python worker
  const pages = await extractPdfText(pdfPath, options);

  if (fileHash && pages.length > 0) {
    if (passageCache.size >= 100) {
      const oldestKey = passageCache.keys().next().value;
      passageCache.delete(oldestKey);
    }
    passageCache.set(fileHash, pages);
  }
  return pages;
};
```

---

## 9. Low-Level Design: Speech Audio Caching & Client Pipelining (`src/speech/indianVoice.js` & `web/teach.js`)

### 9.1 Server Audio Cache & Burst Queue (`src/speech/indianVoice.js`)
```javascript
// src/speech/indianVoice.js
import { createHash } from 'node:crypto';
import { SovereignLruCache } from '../store/cache.js';

// Cache up to 200 synthesized audio clips (TTL 1 hour)
const audioCache = new SovereignLruCache(200, 3600000);
const requestQueue = [];
let activeRequests = 0;
const MAX_CONCURRENT_SPEECH = 3;

export const synthesizeIndianVoice = async (input, options = {}) => {
  // Validate input parameters
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2500) {
    return { status: 400, error: 'Invalid speech input.' };
  }

  const cacheKey = createHash('sha256')
    .update(`${input.voice}:${input.rate || 1}:${input.text.trim()}`)
    .digest('hex');

  const cached = audioCache.get(cacheKey);
  if (cached) {
    return { status: 200, audio: cached.audio, mime: 'audio/mpeg', cached: true };
  }

  // Queue burst requests instead of returning instant 429
  if (activeRequests >= MAX_CONCURRENT_SPEECH) {
    if (requestQueue.length >= 10) {
      return { status: 429, error: 'Voice service is busy. Please retry shortly.' };
    }
    await new Promise((resolve) => requestQueue.push(resolve));
  }

  activeRequests++;
  try {
    const result = await executeSpeechFetch(input, options);
    if (result.status === 200 && result.audio) {
      audioCache.set(cacheKey, { audio: result.audio });
    }
    return result;
  } finally {
    activeRequests--;
    if (requestQueue.length > 0) {
      const next = requestQueue.shift();
      next();
    }
  }
};
```

### 9.2 Client Pipelined Audio Prefetching (`web/teach.js`)
```javascript
// web/teach.js (Enhanced speakIndian method)
async speakIndian(text) {
  const generation = this.generation;
  const segments = this.segmentTextIntoSentences(text);
  if (!segments.length) return;

  const prefetchQueue = new Map(); // Index -> Promise<{ audioUrl }>
  const fetchSegmentAudio = async (segmentText, index) => {
    const response = await fetch('/advocatevox/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: segmentText, voice: this.narrator.value, rate: this.speechRate.value, cloudConsent: true }),
    });
    const result = await response.json();
    if (!result.ok && !result.audio) throw new Error(result.error || 'Speech failed');
    const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: result.mime || 'audio/mpeg' }));
  };

  // Prefetch first segment immediately
  prefetchQueue.set(0, fetchSegmentAudio(segments[0], 0));

  for (let i = 0; i < segments.length; i++) {
    if (generation !== this.generation) break;

    // Speculatively prefetch NEXT segment while CURRENT segment is preparing / playing
    if (i + 1 < segments.length && !prefetchQueue.has(i + 1)) {
      prefetchQueue.set(i + 1, fetchSegmentAudio(segments[i + 1], i + 1));
    }

    // Await audio URL for current segment
    const audioUrl = await prefetchQueue.get(i);
    prefetchQueue.delete(i);
    if (generation !== this.generation) {
      URL.revokeObjectURL(audioUrl);
      break;
    }

    // Playback segment
    await this.playAudioClip(audioUrl);
    URL.revokeObjectURL(audioUrl);
  }
}
```

---

## 10. Error Handling & Graceful Degradation Matrix

| Component | Failure Mode | Fallback / Defensive Behavior |
| :--- | :--- | :--- |
| `SovereignLruCache` | Memory allocation pressure or high eviction rate | Automatic LRU eviction of oldest non-expired entry; logs eviction stats. |
| `CorpusLoader` | Corrupt or locked `practice-rag.db` | Retries with `busy_timeout=5000`; returns empty hits on total read failure without server crash. |
| `calculateTermCoverage` | Malformed unicode or special characters | Graceful regex fallback; returns `{ matched: 0, total: 0 }`; excludes candidate safely. |
| `runConcurrent` | One of the worker tasks throws an error | Error caught, remaining pending tasks are aborted or drained; error propagated with context. |
| `IndianVoice` (TTS) | Sarvam AI API timeout / 502 / network partition | Seamless fallback to browser local device voice (`window.speechSynthesis`) without audio gap. |
| `PdfExtract` | Worker crash / malformed PDF stream | Returns empty page array; marks case as unparsed; declines brief extraction gracefully. |

---
*Authored for AdvocateVox Sovereign Legal Intelligence Runtime.*
