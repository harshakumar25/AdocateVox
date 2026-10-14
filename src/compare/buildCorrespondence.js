/**
 * Builds and stores the old ↔ new correspondence for a repealed code (IPC → BNS, CrPC → BNSS,
 * IEA → BSA) from the library's official text of the new code and a stored bare-act copy of the old one.
 * Rows go into provision_mapping with the old copy as their source, so every lookup can say they are
 * LawBuddy's text alignment and not the official MHA/NCRB table.
 */

import { runTextWorker } from '../cases/textIndex.js';
import { CENTRAL_ACTS, actRecord } from '../ingest/act.js';
import { alignCodes, bodyStartOf, CODE_PAIRS } from './correspondence.js';

/** Plain page text of a stored PDF through the fast worker. */
const pageText = async (rawPath, runWorker) => {
  let pages = null;
  await runWorker({ files: [rawPath], onRecord: (record) => { pages = record.pages || null; } });
  if (!pages) throw new Error(`Could not read ${rawPath}`);
  return pages.join('\n');
};

export const buildCorrespondence = async ({ store, oldAct, runWorker = runTextWorker }) => {
  const pair = CODE_PAIRS[oldAct];
  if (!pair) throw new Error(`Unknown code "${oldAct}". Known: ${Object.keys(CODE_PAIRS).join(', ')}`);
  const copy = store.latestDocument(pair.copyUrl);
  if (!copy) throw new Error(`No stored copy of the ${pair.oldTitle}. Fetch it first: npm run legal -- fetch ${pair.copyUrl}`);
  const actId = store.findAct(actRecord(CENTRAL_ACTS[pair.newAct]));
  if (!actId) throw new Error(`The ${CENTRAL_ACTS[pair.newAct].shortTitle} is not in the library yet.`);

  const oldText = await pageText(copy.raw_path, runWorker);
  const rows = alignCodes({ provisions: store.currentProvisions(actId), oldText, bodyStart: bodyStartOf(oldText) });
  store.replaceMappings({
    newAct: pair.newAct,
    oldAct: pair.oldAct,
    entries: rows.map((row) => ({ ...row, chapter: `text alignment: ${Math.round(row.shared * 100)}% of the new wording shared` })),
    sourceUrl: copy.url ?? pair.copyUrl,
    sourceSha256: copy.sha256,
  });
  return {
    ok: true,
    pair: `${pair.oldAct} → ${pair.newAct}`,
    units: rows.length,
    mapped: rows.filter((row) => row.kind === 'mapped').length,
    unchanged: rows.filter((row) => row.kind === 'mapped' && !row.changed).length,
    new: rows.filter((row) => row.kind === 'new').length,
  };
};
