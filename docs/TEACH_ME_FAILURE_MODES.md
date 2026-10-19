# Why Teach me can give a grounded but wrong legal answer

Status: 19 October 2026. This is an engineering incident review of the security-researcher question reported by a user. It describes the observed failure, the current repair, and remaining risks. It is not a statement about the merits of that person's case.

## The incident

A user asked about a website owner filing a case **against the researcher** after penetration testing without permission. The intended subject was the legal effect of the testing, including authorisation, the alleged acts, and the distinction between civil exposure and a criminal allegation under the Information Technology Act, 2000. The old Teach me response instead explained how a person reports an offence to police under BNSS sections 173 and 174. It labelled the answer “Grounded in the official text” and verified its two BNSS citations. The statutory text was real; it did not answer the user's question.

The same answer also said, without the limiting facts, that recording the information “must be videographed” and the informant's statement obtained before a Magistrate. In the stored text of BNSS section 173(1), these duties occur in the further proviso for a person affected by one of the specified offences **who is temporarily or permanently mentally or physically disabled**. A citation to the correct section did not make that broader statement correct.

For legal teaching, five different checks are needed. **Provenance** asks whether the text came from a verified official source. **Relevance** asks whether it governs the issue the user raised. **Fidelity** asks whether the explanation keeps the source's conditions and exceptions. **Completeness** asks whether the essential opposing or linked provisions are present. **Time** asks whether that version applied on the relevant date. The reported answer passed a narrow provenance and citation check while failing relevance and fidelity; the missing IT Act text meant completeness could not be established.

## Failure chain before the repair

```text
User describes testing and a case filed against them
  → keyword rule reads “filed case” as reporting an offence
  → no cyber-testing concept exists, and personal-case classifier says “general”
  → FIR concept retrieves available BNSS 173/174 text
  → retriever returns on any concept evidence; no search for a better subject
  → model explains the evidence it was given
  → citation checker confirms the BNSS tags exist and displays “grounded”
```

The first two errors were in [`questionAnalysis.js`](../src/analysis/questionAnalysis.js). The earlier FIR trigger treated “filed a case” as though the questioner wanted to file one. It did not identify who filed against whom. The scenario classifier was built around criminal-law hypotheticals with specified people, events and a liability word; this account of an actual case did not fit it. There was no concept mapping for unauthorised security testing or IT Act sections 43 and 66.

The next error was in [`legalRetriever.js`](../src/retrieval/legalRetriever.js): if a concept yields *any* official provision, it returns those provisions. It does not prove that they cover the central issue. Its lexical fallback is reached only after concept evidence fails. The IT Act had an official-source identity in the [library catalogue](../src/ingest/libraryCatalog.js), but no verified provision text in the dated store. A catalogue entry must not be mistaken for searchable law.

The final error was an assurance mismatch. “Grounded” means the answer had source text, not that the source was relevant or every proposition was correct. [`answerCheck.js`](../src/analysis/answerCheck.js) verifies that citation tags name retrieved provisions and that long quotations appear in them. It does not establish that the cited provision answers the question, nor that a paraphrase preserves a proviso's scope. The second-model critic in [`answerCritique.js`](../src/analysis/answerCritique.js) considers lines that carry a recognised citation; the erroneous explanatory bullets in the reported answer had no per-line tags. The critic also runs after answer tokens have been streamed, so even a later warning cannot retract an already shown or spoken claim.

## Why this class of issue recurs

| Failure pattern | What happens | Needed boundary |
| --- | --- | --- |
| Word match without actor and direction | “Owner filed a case against me” resembles “I want to file a case.” | Identify claimant, respondent, action and requested remedy before choosing procedure law. |
| Topic catalogue exceeds provision coverage | An Act is discoverable but its operative text is absent. | Expose coverage at section and date level; never turn source identity into answer evidence. |
| Partial evidence is treated as enough | A procedural section exists, while the governing offence or liability section is missing. | Require the central source for the question before presenting peripheral sources as an answer. |
| Citation validity stands in for legal accuracy | A real section supports some facts, but the answer omits who a proviso applies to. | Check each material claim, including limits, exceptions and conditions, against the exact clause. |
| Review follows publication | An advisory critic flags errors after the learner sees or hears them. | Block or revise high-stakes answers before delivery when required evidence or claim checks fail. |
| Narrow test examples | Direct questions such as “How do I file an FIR?” pass, but adversarially similar wording is not exercised. | Test minimal pairs and realistic narratives, including accused versus complainant. |
| Multiple repositories own one answer path | LawBuddy selects evidence; DocVex chooses the no-text response and streaming behaviour. | Test the integrated path and keep contracts for coverage and warnings explicit. |

These are architectural risks, not a claim that every Teach me answer has failed. The reported response is direct evidence of the first, third and fourth patterns in this incident.

## Repair now in place

- Security-testing language maps to a cyber-law concept with IT Act sections 43 and 66 as the core provisions. A case against the researcher is classified as a fact scenario. “Defend myself” in that context no longer triggers physical private-defence law.
- FIR-registration language now requires a more specific reporting intent; being named in an FIR is not treated as a request to register one.
- When neither core IT Act provision has verified text, concept retrieval declines instead of answering from incidental BNSS or BSA text. The page states the exact gap and links the official IT Act listing.
- The DocVex no-text path emits a cyber-specific reply without calling a model. A regression test covers the user's failure pattern and a case “against me” phrased as an FIR.

This repair prevents the original wrong-law answer. It does **not** mean Teach me can yet give a complete IT Act analysis: sections 43 and 66 remain source-identified, not provision-indexed. Import requires an official edition, raw document hash, section extraction, amendment and commencement review, and dated versions under the [library import gate](LEGAL_LIBRARY_ARCHITECTURE.md#import-gate-for-a-new-act-or-rule).

## Open failure paths to close next

1. **Exact-reference bypass.** `createLawRetriever` returns as soon as *any* named reference resolves. A mixed question naming an absent IT Act section and an available BNSS section can therefore bypass the cyber concept's missing-core guard. The gate must run before every return path, including exact references and search.
2. **One of two core provisions is enough.** The current cyber guard declines only when *neither* section 43 nor 66 is retrieved. If just one is imported, the answer needs an explicit partial-coverage status and must not imply that the other was reviewed.
3. **Citation vocabulary is incomplete.** `normalizeTag` in `answerCheck.js` recognises the criminal codes and Constitution but not the full “Information Technology Act, 2000 s.43” tag. Indexing the IT Act without extending citation parsing would leave some IT Act claims unverified by this checker.
4. **Untagged claims escape the critic.** `extractClaims` selects lines with recognised citation tags. A section cited once in a heading does not verify each subsequent bullet. Every material legal claim needs its own source association or a checker that maps claims to the enclosing source.
5. **Applicability is not represented as structured data.** The concept map points to section numbers, but the pipeline has no typed record of each rule's actor, preconditions, exception, remedy, procedural posture and effective interval. This makes omitted qualifiers hard to detect deterministically.
6. **Language and phrasing coverage remain limited.** The concept rules are English regular expressions. Hindi, Hinglish, typos and alternative descriptions of the same event need evaluated examples; keyword expansion alone risks more false matches.

## Prevention and acceptance criteria

Prioritise a source-coverage gate shared by exact-reference, concept and search retrieval. A question should carry its **primary issues**, **required provisions**, **available provisions**, **missing provisions**, **as-of date** and **answer scope** as explicit fields. The result can be `ready`, `partial` or `unavailable`. `partial` must never display the same “grounded” assurance as a complete answer. Record why each retrieved source is applicable, not only why its words matched.

Before a legal answer is shown or spoken, check that the governing Act for each primary issue is present, and that every material claim retains the limits in its source clause. If a claim cannot be checked, label it as unverified or withhold it. A later critique can remain a second defence, but it should not be the only scope check.

The regression set should include these pairs at minimum:

| Input | Expected route |
| --- | --- |
| “How do I file an FIR after finding a breach?” | FIR reporting procedure; cyber law if the testing itself is also asked about. |
| “The owner filed an FIR against me after I tested the site.” | Accused researcher's cyber-law situation; no FIR-registration explanation. |
| “I had written permission limited to one host, then tested another.” | Scope of authorisation and actual conduct are central facts. |
| “I found a vulnerability and only read a public page.” | Do not assume unauthorised access, damage or guilt from the term “vulnerability.” |
| “Explain IT Act section 66 and BNSS section 173 in my case.” | Preserve both named sources, disclose the absent IT Act text and avoid a BNSS-only merits answer. |
| A section 173 summary that says videography is always required | Flag the omitted disability and specified-offence conditions. |

Run these through both the LawBuddy retriever tests and the DocVex streaming route. Inspect the UI badge, answer, cited source cards and warning text. Passing citation counts alone is not an acceptance criterion.
