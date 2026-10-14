/**
 * Loads the official consolidated Constitution of India into the legal store:
 * stored document → PDF text → parsed provisions → point-in-time versions,
 * each carrying its source URL, sha256 and amending footnotes.
 */

import { extractPdfText } from '../extract/pdfText.js';
import { parseConstitution } from '../parse/constitution.js';

export const CONSTITUTION_ACT = Object.freeze({ shortTitle: 'Constitution of India', year: 1950, ministry: 'Law and Justice' });

export const ingestConstitution = async ({ store, url, extract = extractPdfText }) => {
  const document = store.latestDocument(url);
  if (!document) {
    throw new Error(`No stored copy of ${url}. Import it first: npm run legal -- import <file> "${url}"`);
  }

  const { provisions, warnings } = parseConstitution(await extract(document.raw_path));
  if (provisions.length === 0) throw new Error(`No provisions found in ${url}; is it the consolidated Constitution PDF?`);

  const actId = store.upsertAct(CONSTITUTION_ACT);
  const byKind = {};
  for (const provision of provisions) {
    byKind[provision.kind] = (byKind[provision.kind] || 0) + 1;
    const provisionId = store.upsertProvision({
      actId,
      label: provision.label,
      heading: provision.heading,
      context: { part: provision.part, chapter: provision.chapter, group: provision.group, pageStart: provision.pageStart },
    });
    store.addProvisionVersion({
      provisionId,
      text: provision.text,
      validFrom: provision.validFrom,
      amendedByRef: provision.amendedByRef,
      sourceUrl: url,
      sourceSha256: document.sha256,
      footnotes: provision.footnotes,
    });
  }

  return {
    ok: true,
    actId,
    sha256: document.sha256,
    provisions: provisions.length,
    byKind,
    pendingAmendments: provisions.filter((p) => p.pendingAmendments.length).map((p) => p.label),
    judiciallyInvalidated: provisions.filter((p) => p.judicialNotes.length).map((p) => p.label),
    warnings,
  };
};
