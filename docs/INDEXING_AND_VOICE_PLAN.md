# Indexing completion and voice preferences

## Baseline

The 43-instrument Indian practice catalogue currently has eight retrieved text snapshots and 1,895 searchable chunks. Thirty-five entries remain unavailable. Retrieval uses FTS5/BM25; vector embeddings and automatic use of unreviewed snapshots in generated legal answers are not implemented.

Teaching audio primarily plays Chatterbox clips delivered by the host application. `web/voiceSelector.js` only selects browser fallback speech. A preference must reach both paths; changing the fallback alone will not change the main narrator.

## Implementation order

1. Resolve missing sources by failure category. Find and verify alternative official publisher PDFs for denied or obsolete links; parse regulator download pages without confusing related guidance with the named instrument; isolate the relevant notification in multi-instrument Gazettes. Retain explicit licensed-access and genuinely unavailable states. Never count metadata or inaccessible standards as indexed text.
2. Improve corpus structure and incremental imports. Prefer section/subsection boundaries and attach parent sections, exceptions, schedules and adjacent context. Keep edition, jurisdiction, instrument type, source hash and page provenance. Fingerprint extraction/chunking versions; update changed documents atomically, retry transient errors with bounded backoff and retain a clearly dated last-good snapshot on refresh failure.
3. Add evaluated hybrid retrieval. Establish baseline questions across corporate, civil and cyber topics, including exact-section lookups and paraphrases. Inspect available local embedding models, select and version one, index locally, and combine semantic candidates with BM25. Apply jurisdiction/date/type filters and rerank. Measure recall, irrelevant-source rate, citation correctness, index size and latency before enabling generated-answer integration. Keep catalogue-only records, repealed/current editions and foreign law distinct.
4. Add narrator preferences in Teach: Soft female, Male and Automatic, with a short preview, reading-speed control and remembered choice. Inspect host Chatterbox configuration and available voice assets, then pass the chosen supported voice through the synthesis request and audio cache key. Handle browser voices loading asynchronously; expose actual available voices and an honest fallback when a requested profile is unavailable. Do not imitate an identifiable person's voice or invent a voice capability from pitch adjustments.
5. Verify delivery. Exercise both primary audio and browser fallback, switching voices, stopping speech, rapid new questions, missing voices and unavailable synthesis. Run retrieval regressions, import idempotency/update tests, endpoint checks and browser checks. Refresh coverage documentation with actual counts and unresolved causes.

## Completion criteria

- Every catalogue entry has a measured status and source trail; every legally accessible, accepted text has searchable chunks. Restricted or unavailable sources remain visible exceptions, not fabricated coverage.
- Search returns relevant passages with usable context and reproducible citations. Legal-currency review remains distinct from successful extraction and embedding.
- Voice selection audibly affects the main narrator and fallback where supported, survives reload, and never mixes queued clips from different choices.
- Document the model/voice capabilities actually installed, test results, retrieval quality and remaining external blockers. Do not describe the entire corpus as complete while source gaps remain.

## Implementation progress

- Located and indexed two further issuer PDFs: CERT-In directions and Telecom Cyber Security Rules. Coverage: 10/43, 1,924 passages; 33 remain unresolved.
- Added stop-word filtering, contents-page demotion and neighboring chunk context to BM25 retrieval.
- Added narrator profiles, installed voice choices, preview, persisted preference and speed controls to Teach. Explicit profiles use device speech for incoming answer clips as well as fallback; Automatic retains Chatterbox. Preview of Automatic uses the browser fallback, explicitly labelled.
- Fixed cancellation cleanup for speech promises and pending audio clips; unavailable saved voices do not silently change profile.
- Browser checks confirmed Samantha for the female profile, Rishi for male, and persistence after reload on this machine. These are device capabilities, not a guarantee on every browser or an audio-quality listening assessment.
- Server-side Chatterbox profile assets, disabling redundant synthesis for device-only playback, hybrid embeddings, full source completion and verified-current-law promotion remain outstanding.
