/** Resolve a typed case citation to the Supreme Court index without inferring a holding. */
import { parseCitation } from '../parse/citationParser.js';

export const verifyCaseCitation = (store, input) => {
  const citation = parseCitation(input);
  if (!citation) return { ok: false, status: 400, error: 'Enter one complete recognised case citation, such as 2023 INSC 1.' };
  if (citation.court && citation.court !== 'SC') return {
    ok: true, verified: false, citation: citation.normalized,
    reason: 'This index currently covers Supreme Court judgments; another court’s citation needs checking at that court’s source.',
  };
  let row = store.findCaseByCitation(citation);
  let matchedBy = 'court-index';
  if (!row) {
    const alias = store.findLearnedAlias(citation);
    if (alias) {
      row = store.getCase(alias.case_id);
      matchedBy = 'learned-parallel-citation';
    }
  }
  if (!row) return {
    ok: true, verified: false, citation: citation.normalized,
    reason: 'No match in the indexed Supreme Court records. This is a coverage gap, not proof that the citation is false.',
    library: store.caseStats(),
  };
  return {
    ok: true,
    verified: true,
    citation: citation.normalized,
    matchedBy,
    case: {
      id: row.id,
      title: row.title,
      decidedOn: row.decided_on,
      benchStrength: row.bench_strength,
      status: row.status ?? null,
      pdfUrl: row.pdf_url,
      sourceUrl: row.source_url,
      aliases: row.aliases.map((item) => item.normalized),
    },
    note: 'Identity matched. The holding, exact paragraph, applicability and later treatment still require reading the judgment.',
  };
};
