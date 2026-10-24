# Legal reports: research template and implementation plan

## Purpose and boundary

`/lawbuddy/reports` prepares an **internal working report**, not a pleading, affidavit, signed opinion or filing copy. The user supplies the question and known facts, chooses report type, jurisdiction, as-of date and model, and can download an editable Word file. The prompt is sent to the selected model. With Ollama it stays on the configured local model host; with xAI Grok or Groq it leaves the machine. Grok uses the xAI Responses API with `store: false` and requires `XAI_API_KEY`; Groq uses the existing `GROQ_API_KEY`. Optional India Code discovery sends **matched Act titles only**, never the full prompt.

There is no single mandatory Indian court format for all legal research reports. The MVP uses a reusable research structure, informed by how the Law Commission describes research and recommendations and by the Supreme Court's distinct rules for court submissions. A report must not masquerade as a court filing. India Code's official catalogue covers Acts, sections and subordinate legislation, but a search hit alone is not proof of current operative text.

Primary references: [Law Commission of India](https://lawcommissionofindia.nic.in/), [Supreme Court Rules](https://www.sci.gov.in/supreme-court-rules/), [Supreme Court notices and circulars](https://www.sci.gov.in/notices-and-circulars/), [India Code](https://www.indiacode.nic.in/indiacode/home.jsp).

## Report template

1. **Cover and scope:** document type, question, jurisdiction, as-of date, generation time and model.
2. **Question and facts:** user assertions clearly identified as unverified; no inferred client facts.
3. **Executive summary and issues:** each retained model proposition carries an indexed source ID and an exact quotation from that source.
4. **Applicable law:** exact versioned official text sources, with links and source excerpts.
5. **Analysis:** apply that text to the stated facts; separate alternative readings and adverse points.
6. **Provisional conclusion:** only if supported by the cited record.
7. **Next steps and gaps:** missing documents, judicial authority, amendments, commencement, territorial and forum questions.
8. **Source ledger:** indexed official provisions in one group; online catalogue leads in a separate, explicitly unverified group.
9. **Review checklist:** lawyer verifies facts, full law, local procedure and current binding cases before relying on the report.

The types tune the research framing: a **memorandum** answers a legal question; an **opinion** should state assumptions and qualifications; **case preparation** should identify proof, adverse positions and hearing actions; **legislative/policy research** should distinguish current law from options and recommendations. The current schema shares the core sections so export and source review are consistent. Type-specific intake and evidence matrices are the next extension.

## Implemented pipeline

`POST /lawbuddy/api/reports` validates size/date/provider and routes named-judgment requests to a case-identity gate before retrieval or model generation. A name and year cannot establish a unique judgment. The gate shows possible Supreme Court index matches, but does not write facts, holdings, issues or later treatment without reviewed judgment text. An exact citation match establishes identity only.

For non-case requests, the pipeline retrieves **specifically named** provisions and date-valid linked provisions such as IT Act sections 43 and 66. Broad “any term” statutory FTS was removed after it returned BNSS sections 171 and 329 and Constitution Article 346 for a `Subhash v. State (2017)` case-note request. The model must return a source ID and an exact quotation for each legal proposition. The server checks that the quotation occurs in that indexed source, applies a conservative term-overlap screen and removes certain statute-backed judgment claims. These mechanical checks do **not** prove that an interpretation follows from the quotation. A failed or unparseable response leaves analysis empty; source listings are never relabelled “Applicable law.” Missing sources and failed analysis appear as system status, separate from legal research gaps. The Grok provider follows the [xAI Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses) and [structured output guidance](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

An optional online search queries the India Code DSpace discovery endpoint for exact matched Act titles. It returns catalogue metadata and record links as leads; no web text is promoted into the verified evidence set. The Word export uses the existing dependency-free OOXML generator, adds all report sections and source links, and includes separate internal review notes.

## Remaining assurance work

1. Add a reviewed Supreme Court judgment evidence lane with paragraph-level holdings and later-treatment checks, plus a court/citation selection flow. The current identity-check status is deliberately not a case report.
2. Import current official editions and commencement notices for high-demand Acts; a historical reviewed edition cannot answer a present-day merits question.
3. Build type-specific intake (client facts, documents, procedural posture, relief, limitation, forum) and distinguish record exhibits from user assertions.
4. Add human-editable annotations, saved report revisions, source refresh, and export audit metadata. Persistence needs access control and encryption before multi-user chamber deployment.
5. Evaluate model outputs against advocate-reviewed scenarios for source support, omissions, adverse authority, temporal accuracy and unsafe overclaiming. Exact quotations establish provenance, not entailment; a sentence can still misread its quote. No automated legal-accuracy guarantee is claimed.

The release gate is a lawyer-reviewed evaluation set across criminal, civil, corporate and cyber matters, including stale-law, absent-source, contradictory-source and adversarial-prompt cases. Reports are currently working research aids.
