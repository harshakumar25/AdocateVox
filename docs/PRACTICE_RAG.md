# Practice text retrieval corpus

The broader practice catalogue is the import manifest. `scripts/index-practice-rag.mjs` visits every Indian instrument, uses the registered polite downloader and content-addressed vault, extracts PDF text through the isolated pdfium worker, checks the instrument title and writes page-bounded chunks to `practice-rag.db` beside the legal database.

This is **lexical RAG retrieval using SQLite FTS5/BM25**, not a vector embedding index. It provides retrieval context with full text, instrument type, practice topics, source URL, SHA-256, extraction page and offsets. It does not upgrade a downloaded edition into verified current law. Reports and Teach retain their existing reviewed-provision evidence boundary; this corpus is exposed as research passage search, not silently fed into current-law answers.

Run `node scripts/index-practice-rag.mjs` to retry unavailable documents and skip indexed snapshots. `--recheck` re-extracts cached source bytes and reruns identity checks. `--force` re-fetches source documents. Four bounded workers share the existing per-host pacing and robots policy. Failed documents remain explicitly unavailable. Do not evade denied downloads or substitute search snippets for full text.

Landing pages are never indexed as law. PDF links must identify the named instrument; unrelated regulator guidance is not a substitute. Multi-instrument Gazettes require document boundaries before import. Licensed standards are recorded as unavailable. UK legislation is excluded from this Indian corpus. The importer records whole retrieved PDF snapshots, not a guarantee of all amendments, schedules or correct OCR reading order. Title checks are conservative heuristics, not legal validation.

`GET /lawbuddy/api/rag/search?q=...&topic=...&instrument=...` returns ranked chunks with source provenance and a legal-currency warning. `GET /lawbuddy/api/rag/coverage` returns per-instrument chunk counts and failures. The homepage broader practice index displays corpus counts separately from verified provision counts, and offers full-text search using the selected practice area.

Storage uses WAL, transactions and FTS replacement to prevent stale chunks surviving document replacement. Query terms are escaped; SQL filters are bound. Chunks retain exact extracted characters and page offsets. No cloud model or embedding service receives source text during indexing.

Remaining work: resolve unavailable official documents; segment multi-notification Gazettes; check editions/amendments/commencement; semantic embeddings and evaluated hybrid ranking; controlled report integration after legal status validation. Full corpus coverage must be measured from the coverage endpoint, never inferred from catalogue size.

## Measured coverage, 25 October 2026

All 43 Indian catalogue instruments were attempted. Eight yielded accepted text snapshots, totalling 1,895 searchable chunks; 35 remain unavailable. See [per-instrument coverage](PRACTICE_RAG_COVERAGE.json) for exact URLs, hashes, timestamps and errors. Accepted snapshots cover the Constitution, BNS, BNSS, BSA, Companies Act, IT Act, Patents Act and the 2026 intermediary amendment. This is not complete corpus coverage. Most failures are HTTP 403 or robots restrictions; others are missing identifiable PDF links, multi-notification segmentation or licensed text.

The source search API was verified live (HTTP 200 with IT Act passages), and 194 regression tests passed. New tests cover exact offsets, provenance, topic/instrument isolation, replacing stale FTS rows, query escaping and rejection of partial title matches.

## Follow-up source and retrieval improvements

The CERT-In directions dated 28 April 2022 and the final Telecom Cyber Security Rules, 2024 were located at their issuing authorities and indexed. Coverage now stands at **10 of 43 instruments and 1,924 passages**, with 33 unresolved entries. The measured JSON snapshot is updated. The CERT-In document uses a document-number/date/subject identity check because the catalogue display title differs from its printed subject. Search filters common query filler words, demotes contents pages and returns neighboring source chunks for context. Retrieval remains BM25, not semantic embeddings.
