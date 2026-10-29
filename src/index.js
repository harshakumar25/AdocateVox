/**
 * @docvex/lawbuddy
 * Voice-first legal tutor with verified statutory grounding.
 */

export { config } from './config.js';
export { openLegalStore, toFtsQuery } from './store/db.js';
export {
  createLawRetriever,
  createLegalStoreLoader,
  detectLegalReferences,
  retrieveLegalEvidence,
  LEGAL_EVIDENCE_KINDS,
} from './retrieval/legalRetriever.js';
export {
  getConstitutionProvision,
  lookupSection,
  searchLaw,
} from './service.js';
export {
  LAWBUDDY_FILES,
  LAWBUDDY_SECURITY_HEADERS,
  getLawBuddyFiles,
  isLawBuddyRoute,
  handleLawBuddyStaticRoute,
  handleLawBuddyApiRoute,
  ADVOCATEVOX_FILES,
  ADVOCATEVOX_SECURITY_HEADERS,
  getAdvocateVoxFiles,
  isAdvocateVoxRoute,
  handleAdvocateVoxStaticRoute,
  handleAdvocateVoxApiRoute,
} from './routes.js';
export { findSourceForUrl, LEGAL_SOURCES } from './sources/registry.js';
export { parseRobots } from './sources/robots.js';
export { createPoliteFetcher } from './sources/fetcher.js';
export { importLocalDocument } from './sources/manualImport.js';
export { storeInVault, vaultPath } from './sources/vault.js';
export { createProvenanceResolver, gazetteIdsIn, provenanceHook } from './sources/gazette.js';
export { completeChain, createChainCompletingFetch, installIntermediates, isIncompleteChainError, issuerUrls } from './sources/tlsChain.js';
export { extractPdfText } from './extract/pdfText.js';
export { parseConstitution, stripMarkers } from './parse/constitution.js';
export { ingestConstitution } from './ingest/constitution.js';
export { parseSankalanTable, scanRefs } from './parse/sankalanTable.js';
export { extractCitations, parseCitation } from './parse/citationParser.js';
export { decodeEntities, extractTableRows } from './parse/html.js';
export { WATCHLISTS } from './watch/watchlists.js';
export { extractLinks } from './watch/links.js';
export { nextInterval, withJitter } from './watch/cadence.js';
export { createWatcher, REMOVED_FROM_LISTING } from './watch/watcher.js';
export { drainChangeEvents, routeChangeEvent, SIGNAL_ONLY, BYTES_ONLY } from './watch/events.js';
export { createSameTextCheck, createTextFingerprinter, normalizeForFingerprint } from './compare/textFingerprint.js';
export { runWatchLoop } from './watch/scheduler.js';
export { comparableWords, compareCopyWithProvisions, latestEffectiveDate } from './compare/copyCheck.js';
export { checkCopy, createCopyCheckers, CHECKABLE_ACTS } from './compare/checkCopy.js';
export { analyseQuestion, answerDirection, classifyQuestion, LAW_SYSTEM_PROMPT, LEGAL_CONCEPTS, QUESTION_KINDS } from './analysis/questionAnalysis.js';
export { checkLegalAnswer, normalizeTag } from './analysis/answerCheck.js';
export { critiqueAnswer, critiqueClaims, extractClaims } from './analysis/answerCritique.js';
export { CENTRAL_ACTS, ingestCentralAct } from './ingest/act.js';
export { parseGazetteAct, respaceCapitals } from './parse/gazetteAct.js';
export { extractPdfWords } from './extract/pdfWords.js';
export { analyseJudgment, articleMentions, JUDGMENT_READER_VERSION } from './parse/judgmentCitations.js';
export { rebuildCitationGraph, resolveCitationGraph } from './cases/citationGraph.js';
export { indexScTextYear, indexStoredJudgments, runTextWorker } from './cases/textIndex.js';
