# Reports repair plan

24 October 2026. Continue the existing Node/SQLite and browser application.

1. `src/reports/task.js`, `web/reports.html`, `web/reports.js`: structured case identity, numbered judgment text/file intake and an explicit stop memo for missing or mismatched identity.
2. `src/reports/config.json`, `quality.js`, `scripts/quality_gates.py`: configurable deterministic dash, phrase and six-word overlap gates, with failing sentence locations and a visible failure result.
3. `src/reports/cards.js`, `stages.js`, `pipeline.js`, `provider.js`: paragraph chunks, literal quote extraction, short schema-controlled calls, independent support verification, majority voting, targeted repair and private resumable stage files.
4. `src/reports/report.js`, `sources.js`, `temporal.js`, `concordance.json`: explicit-source retrieval with scored relevance decisions, source provenance and a narrowly seeded, documented temporal cross-reference.
5. `web/reportDocx.js`, `web/practiceDocx.js`, `src/routes.js`: shared case/report output, real lists, provenance, quality banners, larger bounded judgment requests and Word export.
6. `test/legal_reports*.test.js`, fictional fixtures, README and report architecture/incident documentation: regressions for false case claims, wrong source kind, quote mismatch, irrelevant sources, temporal boundaries, backend disagreement, quality repair and checkpoints.

Use small commits after each coherent tested group. Do not commit report run data, secrets or private judgment text. Passing style or exact-quote checks is not proof of legal accuracy. Current source snapshots must not be inferred from the generation date. Case identity leads do not count as judgment evidence.

## Completion check, 25 October 2026

Implemented the six groups above. The latest presentation requirement supersedes the combined audit/report layout: the report body and Word export contain legal prose and references only; diagnostics live in a separate review panel. Incomplete or failed reports cannot be exported as submission write-ups.

Validation: all 181 automated tests pass, JavaScript syntax checks pass, and whitespace checks pass. Live ambiguous-case HTTP testing returns an identity-check result without fabricated analysis. Live provider testing remains limited: Groq produced evidence-backed sections but failed the overlap gate and encountered a repair rate limit; a local-model smoke test did not establish complete usable output. These failures are retained in review, not represented as successful submission reports. See docs/REPORTS_REPAIR.md for remaining assurance work.
