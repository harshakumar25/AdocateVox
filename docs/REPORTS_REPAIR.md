# Reports repair and submission write-up

Updated 25 October 2026.

## Incident and implemented behavior

The audited request, “Subhash v. State (2017)”, entered an unscoped any-term statute search. An unidentified judgment was then described using unrelated statutory sources. Valid source IDs did not establish support for the model's assertions. An empty model response also promoted the retrieved provisions to “Applicable law”.

Reports now identify case work before retrieval. Court, decision date, citation or case number, caption and numbered judgment text are required. Parties and identifiers must match the supplied header; a separate model stage must return matching header quotations. Missing or mismatched identity yields a status in the review panel and no case write-up. Candidates from the existing Supreme Court index are unconfirmed leads. A supplied judgment is not authenticated merely because its header matches.

The Reports document and Word export contain **only legal prose and references**: case details, facts, procedural history, issues, holding, reasoning/arguments, order, available later treatment, analysis, statutory framework and numbered references. Empty sections, model settings, prompts, hashes, quality scores, debug information and counsel checklists are excluded. The separate evidence/validation panel retains these details. Clean export is disabled for unresolved identity, no supported sentences, failed quality checks, backend disagreement or missing core case sections. It is not an automated court-filing approval.

## Pipeline

1. Deterministic task parsing and identity checks; short identity confirmation call with literal header evidence.
2. Supplied numbered judgment paragraphs are grouped into about 1,200-word chunks. Paragraphs are never cut mid-sentence to meet a character limit. Oversize prompts stop with a context-budget error.
3. Extract typed quote cards using first/last five-word anchors and paragraph numbers. Precomputed sentence anchors help small models count reliably. Edge punctuation is ignored when locating anchors, but the returned quotation is cut from the **original text**, preserving every character. Ambiguous spans and invalid source types are rejected.
4. Draft each section only from allowed card types. Default drafts per section: Ollama 5, Groq 1, Grok 1. Each sentence has one evidence card.
5. A separate verification call classifies each sentence as SUPPORTED, PARTIAL or UNSUPPORTED. Missing, duplicate or wrong-kind verdicts do not pass. Majority voting counts distinct drafts, using the same card and conservative token similarity. This can undercount differently worded equivalent claims; it is not a proof of semantic agreement.
6. Code checks long dashes, configurable stock phrases and unquoted six-word overlap with supplied/retrieved sources. Only failing sentences are repaired, up to five rounds. Repairs are verified again against both the source card and the original supported proposition. Failure is visible in the review panel and prevents clean export. Provider failure during repair preserves the reviewed partial output and its failure status.
7. Private stage checkpoints allow resuming an unchanged request. Optional backend comparison reports substantial differences in retained claims and blocks clean export pending review.

For statutory memos, retrieval uses specifically named provisions and necessary linked provisions. Complete subsection text is retained. Every candidate receives an explicit-reference/lexical score, a threshold decision and, if above threshold, a model KEEP/DROP decision. It is a reranking gate, **not an embedding retrieval implementation**. Zero accepted sources gives “No applicable provision identified”. No source is automatically placed under applicable law.

The report-specific concordance contains only CrPC s.152 to BNSS s.171. Its official references are recorded in `src/reports/concordance.json`. The correspondence is shown only when relevant judgment cards mention the provision. BNSS commencement does not by itself decide every pending proceeding: section 531 and procedural history remain necessary. No IPC/BNS or Evidence Act/BSA rows were inferred.

## Inputs and configuration

Use `/lawbuddy/reports`. Open “Case analysis: supply the judgment and identity”, enter header fields, and paste numbered text or load a UTF-8 `.txt` file. PDF/OCR ingestion is not implemented in this report intake. Files load into the browser first; generation sends the material to the explicitly selected providers. Additional commentary, later citing judgments and statutes can be supplied through the API's `supportingSources` array (`kind`, `title`, `text`, `url`, `snapshotDate`, optional `label` and `version`). Later judgments and commentary need paragraph numbers. The report pipeline does not scrape judgment links.

`src/reports/config.json` controls phrase list, overlap limit (0.10), shingle length (6), repair rounds (5), relevance floor (0.65), consensus similarity (0.55), disagreement threshold (0.40), chunk/quote/card/claim limits, draft counts, temperatures, context and output budgets. Temperatures: 0 for identity/extraction/relevance/verification, 0.5 for drafting, 0.2 for repair. Default seed: 7. Ollama context: 16,384; local output reserve: 2,048 tokens; cloud output limit: 6,000.

Existing model environment options remain: `OLLAMA_MODEL`, `OLLAMA_HOST`, `GROQ_MODEL`, `GROQ_API_KEY`, `XAI_MODEL`, `XAI_API_KEY`. Optional `REPORT_OLLAMA_CONTEXT`, `REPORT_SEED` and `REPORT_CHECKPOINT_DIR` override their corresponding settings. The JavaScript API also accepts trusted server-side config overrides through `options.config`; clients cannot change thresholds. Exact provider/model, stage temperature/seed, prompt hash and actual returned token usage are retained. Grok does not claim seed support.

Local context preflight uses a conservative UTF-8-byte upper bound rather than pretending to know an exact tokenizer count. Actual prompt token counts are recorded when the backend supplies them. Ollama uses JSON schemas, an explicit context and no client timeout. Prose mode omits JSON formatting. Groq JSON failures can be salvaged only as valid JSON, otherwise retried; failed generation text stays in private stage files. Rate-limit retries honor short Retry-After values and are bounded.

By default checkpoints are under `.lawbuddy/report-runs` relative to the server working directory (the development host runs from `../DOCVEX`). Run directories use mode 0700 and files 0600. They contain supplied material and model outputs, are unencrypted, and have no automatic retention cleanup. Keep this deployment local; chamber/multi-user access control and encrypted storage remain separate work. API keys are not stored. Resume by sending the identical request with `resumeRunId`. Changed sources, model settings or config reject the resume.

Source records retain kind, provenance, retrieval time, document/content hashes, version and paragraph/provision anchor. The source snapshot cutoff is the oldest known snapshot only when all source snapshots are known; otherwise it is explicitly unestablished. The run date is not substituted for unknown legal currency.

## Verification

Run `npm test`, `npm run lint`, and `python3 scripts/quality_gates.py memo.txt source1.txt ...`. The Python command shares the application's configuration and exits 1 when a gate fails. It measures only overlap with the provided source set; it cannot promise an external plagiarism or AI-detection score.

The fixture in `test/fixtures/reports/fictional-judgment.txt` is explicitly fictional. Tests cover ambiguous/nonexistent cases, mismatched identity, exact quote recovery, absent and partial support, irrelevant sources, temporal correspondence, distinct-draft voting, backend disagreement, failed repairs, resumable private files, Word list markup, submission-only exports and route status handling. Live HTTP testing additionally caught and fixed a server crash caused by confusing a report state string with an HTTP status code.

On 25 October 2026, all 181 tests and JavaScript syntax checks passed. Live Groq testing produced supported sections but failed the overlap threshold and encountered HTTP 429 during repair; export remained blocked. The local-model smoke test did not establish complete usable output. These are failure-path checks, not evidence of reliable end-to-end generation or advocate-approved submissions. Word output was checked structurally in tests; page rendering was not assessed in this pass.

## Files

- `PLAN.md`: implementation sequence.
- `src/reports/task.js`, `report.js`: task identity and orchestration.
- `src/reports/cards.js`, `pipeline.js`, `sources.js`: source selection, quote cards, section drafts, verification, consensus, repair and comparison.
- `src/reports/config.json`, `config.js`, `quality.js`, `json.js`: configuration, deterministic output gates and schema validation.
- `src/reports/provider.js`, `stages.js`: model calls, context limits, retries, provenance and checkpoints.
- `src/reports/concordance.json`, `temporal.js`: one reviewed temporal correspondence with transition cautions.
- `src/routes.js`: bounded larger intake and correct numeric HTTP statuses.
- `web/reports.html`, `reports.js`, `lawbuddy.css`: judgment intake, submission write-up and separate validation panel.
- `web/reportDocx.js`, `practiceDocx.js`: clean submission export and genuine Word lists, without internal notes.
- `scripts/quality_gates.py`: standalone deterministic checks.
- `test/legal_reports.test.js`, `legal_report_gates.test.js`, fictional fixture: regression coverage.
- `README.md`, `docs/LEGAL_REPORTS_MVP.md`, this document: usage, limitations and architecture.

Remaining assurance work: advocate-reviewed proposition/paragraph evaluations; independent court-source authentication; current-edition coverage; semantic contradiction checking across all sections; broader reviewed concordance; document import/OCR; optional commentary intake UI; chamber-grade access control and encrypted retention. The verifier is a model and can still misread a source. Passing these checks is not a legal accuracy guarantee.
