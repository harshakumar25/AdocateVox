/**
 * LawBuddy legal-corpus CLI.
 *
 *   npm run legal -- fetch <url>                 polite automatic fetch from a registered source
 *   npm run legal -- import <file> <url>         import a document a person downloaded from <url>
 *   npm run legal -- import-table <file> <url>   import + load an NCRB Sankalan correspondence table
 *   npm run legal -- lookup <act> <section>      official old↔new correspondence, e.g. "lookup IPC 302"
 *   npm run legal -- ingest-constitution <url>
  npm run legal -- ingest-act <BNS | BNSS | BSA> [url]
  npm run legal -- align-codes [IPC | CrPC | IEA]   parse a stored Constitution PDF into versioned provisions
 *   npm run legal -- ingest-act <BNS|BNSS|BSA> [url]  load a Central Act's sections from its stored official Gazette PDF
 *   npm run legal -- align-codes [IPC|CrPC|IEA]   old ↔ new correspondence by text alignment (stored as LawBuddy's, not official)
 *   npm run legal -- article <number> [date]     an Article (or Preamble / Sch.7) as in force on a date
 *   npm run legal -- search <words...>           full-text search of current provisions
 *   npm run legal -- watch once [--listings-only] check every watched URL that is due, then route change events
 *   npm run legal -- watch run                   keep watching until Ctrl+C, sleeping until the next URL is due
 *   npm run legal -- watch status                watched URLs, their schedules, and recent change events
 *   npm run legal -- check-copy <url> [date]     is a stored copy of the Constitution current? (vs the official text)
 *   npm run legal -- resolve-provenance [url]    trace watched unofficial PDFs to the official Gazette they print
 *   npm run legal -- sync-sc [from] [to] [--force]  import Supreme Court judgment records (AWS Open Data); --force re-parses
 *   npm run legal -- cases <article>             Supreme Court judgments on an Article, ranked by precedent points
 *   npm run legal -- brief <caseId> [article]    prepare (or show) a judgment's verified brief
 *   npm run legal -- add-review <caseId> <1-5> --name <n> --credential <c> --comment <t> --verified-by <admin> [--source <url>]
 *   npm run legal -- index-texts [from] [to] [--force]   index judgment full texts (vault PDFs, then the yearly archives
 *                                                        from..to, streamed), then rebuild the citation graph
 *   npm run legal -- citation-graph                 re-resolve every stored reference into the citation graph
 *   npm run legal -- cited-by <caseId>              later judgments citing a judgment, with the reporter's treatment
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { openLegalStore } from './store/db.js';
import { createPoliteFetcher } from './sources/fetcher.js';
import { LEGAL_SOURCES, findSourceForUrl } from './sources/registry.js';
import { importLocalDocument } from './sources/manualImport.js';
import { parseSankalanTable } from './parse/sankalanTable.js';
import { ingestConstitution } from './ingest/constitution.js';
import { ingestCentralAct } from './ingest/act.js';
import { buildCorrespondence } from './compare/buildCorrespondence.js';
import { getConstitutionProvision, lookupSection, searchCatalog, searchLaw, toConstitutionLabel } from './service.js';
import { createWatcher } from './watch/watcher.js';
import { drainChangeEvents } from './watch/events.js';
import { runWatchLoop } from './watch/scheduler.js';
import { WATCHLISTS } from './watch/watchlists.js';
import { checkCopy, createCopyCheckers } from './compare/checkCopy.js';
import { createSameTextCheck, createTextFingerprinter } from './compare/textFingerprint.js';
import { createProvenanceResolver, provenanceHook } from './sources/gazette.js';
import { listScYears, syncScYear } from './sources/scOpenData.js';
import { CONSTITUTION_ACT } from './ingest/constitution.js';
import { casesForProvision, citingJudgments } from './cases/service.js';
import { prepareCaseBrief } from './cases/brief.js';
import { indexScTextYear, indexStoredJudgments } from './cases/textIndex.js';
import { rebuildCitationGraph } from './cases/citationGraph.js';

const USAGE = `Usage:
  npm run legal -- fetch <url>
  npm run legal -- import <file> <url>
  npm run legal -- import-table <file> <url>
  npm run legal -- lookup <act> <section>     acts: BNS IPC BNSS CrPC BSA IEA
  npm run legal -- ingest-constitution <url>
  npm run legal -- article <21 | 21A | Preamble | Sch.7> [YYYY-MM-DD]
  npm run legal -- catalog [words...]
  npm run legal -- search [--act ACT_ID] [--as-of YYYY-MM-DD] <words...>
  npm run legal -- watch once [--listings-only]
  npm run legal -- watch run
  npm run legal -- watch status
  npm run legal -- check-copy <url> [YYYY-MM-DD]
  npm run legal -- resolve-provenance [url]
  npm run legal -- sync-sc [fromYear] [toYear] [--force]
  npm run legal -- cases <21 | Art.21>
  npm run legal -- brief <caseId> [Art.21]
  npm run legal -- add-review <caseId> <1-5> --name <name> --credential <credential> --comment <text> --verified-by <admin> [--source <url>]
  npm run legal -- index-texts [fromYear] [toYear] [--force]
  npm run legal -- citation-graph
  npm run legal -- cited-by <caseId>`;

/** "--name x --comment y" → { name: 'x', comment: 'y' }; null when a flag lacks its value. */
const parseFlags = (args) => {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || args[index + 1] === undefined) return null;
    flags[args[index].slice(2)] = args[index + 1];
  }
  return flags;
};

/**
 * Adds a review only with everything a reader needs to trust it: a named reviewer, their
 * credential, and the administrator who verified them. Nothing anonymous is ever shown.
 */
const addReview = (store, [caseId, rating, ...rest]) => {
  const flags = parseFlags(rest);
  const required = ['name', 'credential', 'comment', 'verified-by'];
  if (!flags || required.some((flag) => !flags[flag]?.trim()) || !/^[1-5]$/.test(rating ?? '') || !store.getCase(Number(caseId))) {
    return null;
  }
  const id = store.addCaseReview({
    caseId: Number(caseId), reviewerName: flags.name, reviewerCredential: flags.credential, rating: Number(rating),
    comment: flags.comment, sourceUrl: flags.source ?? null, verifiedBy: flags['verified-by'], verifiedAt: new Date().toISOString(),
  });
  return { ok: true, reviewId: id, ...store.verifiedReviewsFor(Number(caseId)) };
};

/** One watch pass: register watchlists, check what is due, route the resulting change events. */
const watchCycle = async (store, fetcher, watcher, kind = null) => {
  watcher.seed();
  const checked = await watcher.runDue({ kind });
  const checkers = createCopyCheckers({ store, watchlists: WATCHLISTS });
  const sameText = createSameTextCheck(createTextFingerprinter({ store }));
  const signalHooks = [provenanceHook(createProvenanceResolver({ store, fetcher }))];
  return { ...checked, routed: await drainChangeEvents({ store, checkers, signalHooks, sameText }) };
};

/** Imports Supreme Court judgment records year by year, reporting progress on stderr. */
const syncSupremeCourt = async (store, from = null, to = null, force = false) => {
  const actId = store.findAct(CONSTITUTION_ACT);
  if (!actId) return { ok: false, error: 'Ingest the Constitution first: Article links are checked against its official text.' };
  const knownArticles = new Set(store.currentProvisions(actId).map((provision) => provision.label));
  const fetcher = createPoliteFetcher({ store });
  const years = (await listScYears({ fetcher }))
    .filter((year) => (from === null || year >= from) && (to === null || year <= to));
  const results = [];
  for (const year of years) {
    const result = await syncScYear({ store, fetcher, year, knownArticles, force });
    console.error(JSON.stringify(result));
    results.push(result);
  }
  return {
    ok: results.every((result) => result.ok),
    years: results.length,
    failed: results.filter((result) => !result.ok),
    ...store.caseStats(),
  };
};

/**
 * Indexes judgment full texts for the citation graph: first the PDFs already in the vault, then (when a
 * year range is given) each year's archive, streamed and never stored. The graph is rebuilt at the end.
 */
const indexTexts = async (store, from = null, to = null, force = false) => {
  const actId = store.findAct(CONSTITUTION_ACT);
  if (!actId) return { ok: false, error: 'Ingest the Constitution first: Article mentions are checked against its official text.' };
  const knownArticles = new Set(store.currentProvisions(actId).map((provision) => provision.label));
  const stored = await indexStoredJudgments({ store, knownArticles, force });
  console.error(JSON.stringify({ stored }));
  const results = [];
  if (from !== null) {
    const fetcher = createPoliteFetcher({ store });
    const years = (await listScYears({ fetcher })).filter((year) => year >= from && year <= (to ?? from));
    for (const year of years) {
      let last = 0;
      const result = await indexScTextYear({
        store, fetcher, year, knownArticles, force,
        onProgress: (summary) => {
          if (summary.indexed - last >= 100) {
            last = summary.indexed;
            console.error(JSON.stringify({ year, indexed: summary.indexed }));
          }
        },
      });
      console.error(JSON.stringify(result));
      results.push(result);
    }
  }
  const graph = rebuildCitationGraph(store);
  return { ok: results.every((result) => result.ok), stored, years: results, graph, index: store.textIndexStats() };
};

/** Traces stored unofficial PDFs (one URL, or every watched tier-2 document) to their official Gazette. */
const resolveProvenance = async (store, url = null) => {
  const resolve = createProvenanceResolver({ store, fetcher: createPoliteFetcher({ store }) });
  const tierTwo = new Set(LEGAL_SOURCES.filter((source) => source.tier === 2).map((source) => source.id));
  const urls = url ? [url] : store.watchSummary().targets
    .filter((target) => target.kind === 'document' && target.state === 'active' && /\.pdf$/i.test(target.url))
    .map((target) => target.url)
    .filter((candidate) => tierTwo.has(findSourceForUrl(candidate)?.id));
  const results = [];
  for (const candidate of urls) {
    const stored = store.latestDocument(candidate);
    results.push({ url: candidate, provenance: stored ? await resolve({ url: candidate, sha256: stored.sha256 }) : 'not stored yet' });
  }
  return { ok: true, checked: results.length, results };
};

const watch = async (store, [mode, ...flags]) => {
  if (mode === 'status' && flags.length === 0) {
    return { ok: true, ...store.watchSummary() };
  }

  const fetcher = createPoliteFetcher({ store });
  const watcher = createWatcher({ store, fetcher });
  if (mode === 'once' && (flags.length === 0 || (flags.length === 1 && flags[0] === '--listings-only'))) {
    return watchCycle(store, fetcher, watcher, flags.length ? 'listing' : null);
  }
  if (mode === 'run' && flags.length === 0) {
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
    await runWatchLoop({
      cycle: () => watchCycle(store, fetcher, watcher),
      nextDueAt: store.nextWatchDueAt,
      signal: controller.signal,
      onCycle: ({ checked, outcomes, events, errors }) => {
        console.log(JSON.stringify({ at: new Date().toISOString(), checked, outcomes, events: events.length, errors }));
      },
      onError: (error) => console.error(`watch cycle failed: ${error.message}`),
    });
    return { ok: true, stopped: true };
  }
  return null;
};

const importTable = async (store, filePath, url) => {
  const imported = await importLocalDocument({ store, filePath, url });
  const table = parseSankalanTable(await fs.readFile(imported.rawPath, 'utf8'));
  store.replaceMappings({ ...table, sourceUrl: url, sourceSha256: imported.sha256 });

  const byKind = {};
  for (const entry of table.entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
  return {
    ok: true,
    table: `${table.newAct} ↔ ${table.oldAct}`,
    sha256: imported.sha256,
    entries: table.entries.length,
    byKind,
    unparsedCount: table.unparsed.length,
    unparsedSamples: table.unparsed.slice(0, 10),
  };
};

const run = async ([command, ...args]) => {
  const store = openLegalStore();
  try {
    if (command === 'fetch' && args.length === 1) {
      return await createPoliteFetcher({ store }).fetchDocument(args[0]);
    }
    if (command === 'import' && args.length === 2) {
      return await importLocalDocument({ store, filePath: path.resolve(args[0]), url: args[1] });
    }
    if (command === 'import-table' && args.length === 2) {
      return await importTable(store, path.resolve(args[0]), args[1]);
    }
    if (command === 'lookup' && args.length === 2) {
      return lookupSection(store, args[0], args[1]);
    }
    if (command === 'ingest-constitution' && args.length === 1) {
      return await ingestConstitution({ store, url: args[0] });
    }
    if (command === 'article' && (args.length === 1 || args.length === 2)) {
      return getConstitutionProvision(store, ...args);
    }
    if (command === 'catalog') {
      return searchCatalog(store, { query: args.join(' ') });
    }
    if (command === 'search' && args.length > 0) {
      let act = null;
      let asOf = undefined;
      const words = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--act' && args[index + 1]) act = args[++index];
        else if (args[index] === '--as-of' && args[index + 1]) asOf = args[++index];
        else if (args[index].startsWith('--')) return null;
        else words.push(args[index]);
      }
      return searchLaw(store, words.join(' '), { act, asOf });
    }
    if (command === 'check-copy' && (args.length === 1 || args.length === 2)) {
      return await checkCopy({ store, url: args[0], copyDate: args[1] ?? null });
    }
    if (command === 'cases' && args.length === 1) {
      return casesForProvision(store, { provision: args[0], limit: 10 });
    }
    if (command === 'brief' && (args.length === 1 || args.length === 2) && /^\d+$/.test(args[0])) {
      return await prepareCaseBrief({
        store, fetcher: createPoliteFetcher({ store }), caseId: Number(args[0]), label: args[1] ? (toConstitutionLabel(args[1]) ?? args[1]) : null,
      });
    }
    if (command === 'add-review') {
      return addReview(store, args);
    }
    if (command === 'sync-sc') {
      const force = args.includes('--force');
      const years = args.filter((arg) => arg !== '--force');
      if (years.length > 2 || !years.every((arg) => /^\d{4}$/.test(arg))) return null;
      return await syncSupremeCourt(store, years[0] ? Number(years[0]) : null, years[1] ? Number(years[1]) : null, force);
    }
    if (command === 'align-codes' && args.length <= 1) {
      const codes = args.length ? [args[0]] : ['IPC', 'CrPC', 'IEA'];
      const results = [];
      for (const code of codes) results.push(await buildCorrespondence({ store, oldAct: code }));
      return { ok: true, results };
    }
    if (command === 'ingest-act' && (args.length === 1 || args.length === 2)) {
      return await ingestCentralAct({ store, code: args[0], url: args[1] ?? null });
    }
    if (command === 'index-texts') {
      const force = args.includes('--force');
      const years = args.filter((arg) => arg !== '--force');
      if (years.length > 2 || !years.every((arg) => /^\d{4}$/.test(arg))) return null;
      return await indexTexts(store, years[0] ? Number(years[0]) : null, years[1] ? Number(years[1]) : null, force);
    }
    if (command === 'citation-graph' && args.length === 0) {
      return { ok: true, graph: rebuildCitationGraph(store), index: store.textIndexStats() };
    }
    if (command === 'cited-by' && args.length === 1 && /^\d+$/.test(args[0])) {
      return citingJudgments(store, Number(args[0]));
    }
    if (command === 'resolve-provenance' && args.length <= 1) {
      return await resolveProvenance(store, args[0] ?? null);
    }
    if (command === 'watch') {
      return await watch(store, args);
    }
    return null;
  } finally {
    store.close();
  }
};

try {
  const result = await run(process.argv.slice(2));
  if (!result) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
