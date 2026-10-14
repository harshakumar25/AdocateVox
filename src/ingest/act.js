/**
 * Loads a Central Act from its official Gazette of India print into the legal store: the stored PDF
 * (fetched from egazette.gov.in) → positioned words → sections with their margin headings → versions,
 * each carrying the Gazette ID, source URL and sha256.
 *
 * Integrity before anything is stored: the PDF must print the expected Gazette ID, and the parse must
 * find every section the Act has, numbered without a gap. A partial or wrong document stores nothing.
 */

import { extractPdfWords } from '../extract/pdfWords.js';
import { parseGazetteAct } from '../parse/gazetteAct.js';

// The new criminal laws, in force from 1 July 2024: the BNS by S.O. 850(E) and the BNSS by S.O. 848(E),
// both of 23 February 2024, and the BSA by a notification of the same date (implementation plan §11a).
export const CENTRAL_ACTS = Object.freeze({
  BNS: Object.freeze({
    code: 'BNS',
    shortTitle: 'Bharatiya Nyaya Sanhita, 2023',
    actNumber: '45 of 2023',
    year: 2023,
    ministry: 'Home Affairs',
    gazetteId: 'CG-DL-E-25122023-250883',
    officialUrl: 'https://egazette.gov.in/WriteReadData/2023/250883.pdf',
    sections: 358,
    inForceFrom: '2024-07-01',
    // S.O. 850(E) brought the Sanhita into force except section 106(2) (hit-and-run by drivers).
    notInForce: Object.freeze({
      's.106': 'Sub-section (2) of this section was excluded when the Sanhita was brought into force on 1 July 2024 (S.O. 850(E), 23 February 2024). LawBuddy has not verified any later notification bringing it into force: do not treat sub-section (2) as law in force.',
    }),
  }),
  BNSS: Object.freeze({
    code: 'BNSS',
    shortTitle: 'Bharatiya Nagarik Suraksha Sanhita, 2023',
    actNumber: '46 of 2023',
    year: 2023,
    ministry: 'Home Affairs',
    gazetteId: 'CG-DL-E-25122023-250884',
    officialUrl: 'https://egazette.gov.in/WriteReadData/2023/250884.pdf',
    sections: 531,
    inForceFrom: '2024-07-01',
    notInForce: Object.freeze({}),
  }),
  BSA: Object.freeze({
    code: 'BSA',
    shortTitle: 'Bharatiya Sakshya Adhiniyam, 2023',
    actNumber: '47 of 2023',
    year: 2023,
    ministry: 'Home Affairs',
    gazetteId: 'CG-DL-E-25122023-250882',
    officialUrl: 'https://egazette.gov.in/WriteReadData/2023/250882.pdf',
    sections: 170,
    inForceFrom: '2024-07-01',
    notInForce: Object.freeze({}),
  }),
});

/** The act record for the store (`act` table): looked up by short title and year. */
export const actRecord = (act) => ({ shortTitle: act.shortTitle, actNumber: act.actNumber, year: act.year, ministry: act.ministry });

export const ingestCentralAct = async ({ store, code, url = null, extract = extractPdfWords }) => {
  const act = CENTRAL_ACTS[String(code || '').toUpperCase()];
  if (!act) throw new Error(`Unknown Act "${code}". Known: ${Object.keys(CENTRAL_ACTS).join(', ')}`);
  const sourceUrl = url || act.officialUrl;
  const document = store.latestDocument(sourceUrl);
  if (!document) {
    throw new Error(`No stored copy of ${sourceUrl}. Fetch it first: npm run legal -- fetch ${sourceUrl}`);
  }

  const pages = await extract(document.raw_path);
  const firstPage = (pages[0]?.words || []).map((word) => word.text).join(' ');
  if (!firstPage.includes(act.gazetteId)) {
    throw new Error(`${sourceUrl} does not print Gazette ID ${act.gazetteId}; refusing to load it as the ${act.shortTitle}.`);
  }
  const printed = /NO\.\s*(\d+)\s+OF\s+(\d{4})/i.exec(pages.slice(0, 2).flatMap((page) => page.words.map((word) => word.text)).join(' '));
  if (!printed || `${printed[1]} of ${printed[2]}` !== act.actNumber) {
    throw new Error(`${sourceUrl} prints ${printed ? `Act No. ${printed[1]} of ${printed[2]}` : 'no Act number'}, not ${act.actNumber}; nothing was stored.`);
  }
  const { sections, warnings } = parseGazetteAct(pages);
  if (sections.length !== act.sections) {
    throw new Error(`Found ${sections.length} of the ${act.sections} sections of the ${act.shortTitle}; nothing was stored. ${warnings.slice(0, 3).join(' ')}`);
  }

  const actId = store.upsertAct(actRecord(act));
  for (const section of sections) {
    const provisionId = store.upsertProvision({
      actId,
      label: section.label,
      heading: section.heading ? section.heading.replace(/\.$/, '') : null,
      context: {
        chapter: section.chapter ? `Chapter ${section.chapter}` : null,
        chapterTitle: section.chapterTitle,
        group: section.subheading,
        pageStart: section.page,
        act: act.code,
      },
    });
    const notInForce = act.notInForce[section.label];
    store.addProvisionVersion({
      provisionId,
      text: section.text,
      validFrom: act.inForceFrom,
      gazetteRef: act.gazetteId,
      sourceUrl,
      sourceSha256: document.sha256,
      footnotes: notInForce ? [{ pending: true, text: notInForce }] : [],
    });
  }
  return {
    ok: true,
    act: act.shortTitle,
    actId,
    gazetteId: act.gazetteId,
    sha256: document.sha256,
    sections: sections.length,
    withoutHeading: sections.filter((section) => !section.heading).map((section) => section.label),
    warnings,
  };
};
