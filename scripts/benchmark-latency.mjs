#!/usr/bin/env node
/**
 * AdvocateVox Latency & Performance Benchmark Suite
 *
 * Standalone automated benchmark measuring empirical performance across 7 operational vectors:
 * - Vector 1: RAG Corpus Search & Coverage (Connection pooling & statement compilation caching)
 * - Vector 2: Provision Retrieval & Caching (SovereignLruCache hits vs cold SQLite lookups)
 * - Vector 3: Term Coverage Calculation (In-memory token set intersection vs SQL query storm)
 * - Vector 4: Precedent Case Ranking (Batched treatment & bench strength lookups vs N+1 queries)
 * - Vector 5: Speech Audio Cache Turnaround (In-memory audio cache turnaround vs cold network fetch)
 * - Vector 6: Reports Pipeline Concurrency (runConcurrent bounded pool DAG throughput vs serial)
 * - Vector 7: Content-Addressed PDF Passage Cache (In-memory SHA-256 passage cache vs cold worker spawn)
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Domain imports
import { openCorpus, createCorpusLoader } from '../src/rag/corpus.js';
import { openLegalStore } from '../src/store/db.js';
import { getConstitutionProvision, getActProvision } from '../src/service.js';
import { CONSTITUTION_ACT } from '../src/ingest/constitution.js';
import { CENTRAL_ACTS, actRecord } from '../src/ingest/act.js';
import { casesForProvision, toCard, citationsOf } from '../src/cases/service.js';
import { synthesizeIndianVoice, resetSpeechState } from '../src/speech/indianVoice.js';
import { runConcurrent } from '../src/reports/pipeline.js';
import { computePdfSha256, passageCache, clearPdfCache, extractPdfTextWithCache } from '../src/extract/pdfText.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SCRATCH_DIR = path.join(REPO_ROOT, '.benchmark_tmp');

/**
 * Computes comprehensive statistical distribution metrics for an array of latency measurements.
 * @param {number[]} latenciesMs Array of elapsed times in milliseconds.
 * @returns {object}
 */
export function computeDistributionStats(latenciesMs) {
  if (!Array.isArray(latenciesMs) || latenciesMs.length === 0) {
    return {
      iterations: 0,
      totalDurationMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      opsSec: 0,
    };
  }

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const totalDurationMs = latenciesMs.reduce((sum, v) => sum + v, 0);
  const meanMs = totalDurationMs / latenciesMs.length;
  const p50Ms = sorted[Math.floor(sorted.length * 0.50)];
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const p99Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  const opsSec = totalDurationMs > 0 ? (latenciesMs.length / (totalDurationMs / 1000)) : 0;

  return {
    iterations: latenciesMs.length,
    totalDurationMs,
    meanMs,
    p50Ms,
    p95Ms,
    p99Ms,
    opsSec,
  };
}

/**
 * Computes speedup multiplier and latency reduction percentage.
 */
export function computeDelta(baseline, optimized) {
  const speedup = baseline.meanMs > 0 && optimized.meanMs > 0
    ? baseline.meanMs / optimized.meanMs
    : 1;
  const reductionPct = baseline.meanMs > 0
    ? ((baseline.meanMs - optimized.meanMs) / baseline.meanMs) * 100
    : 0;

  return {
    speedupRatio: speedup,
    reductionPct: Math.max(0, reductionPct),
  };
}

function printStatsRow(label, stats) {
  console.log(
    `  ${label.padEnd(28)} | ` +
    `N: ${stats.iterations.toString().padStart(4)} | ` +
    `Total: ${stats.totalDurationMs.toFixed(1).padStart(7)}ms | ` +
    `Mean: ${stats.meanMs.toFixed(4).padStart(7)}ms | ` +
    `p50: ${stats.p50Ms.toFixed(4).padStart(7)}ms | ` +
    `p95: ${stats.p95Ms.toFixed(4).padStart(7)}ms | ` +
    `p99: ${stats.p99Ms.toFixed(4).padStart(7)}ms | ` +
    `Ops/s: ${stats.opsSec.toFixed(0).padStart(7)}`
  );
}

// ============================================================================
// Vector 1: RAG Corpus Search & Coverage
// ============================================================================
async function benchmarkVector1() {
  console.log('\n================================================================================');
  console.log('Vector 1: RAG Corpus Search & Coverage');
  console.log('Evaluating persistent connection pooling & prepared statement caching vs baseline');
  console.log('--------------------------------------------------------------------------------');

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  const ragDbPath = path.join(SCRATCH_DIR, 'bench-rag.db');
  try { fs.unlinkSync(ragDbPath); } catch {}

  // Seed RAG corpus
  const seedCorpus = openCorpus(ragDbPath);
  seedCorpus.replace(
    { id: 'DPDP-2023', title: 'Digital Personal Data Protection Act, 2023', topics: ['privacy', 'data'], instrumentType: 'statute' },
    { url: 'https://egazette.gov.in/dpdp.pdf', sha256: 'a'.repeat(64) },
    [
      { page: 1, lines: ['The Digital Personal Data Protection Act, 2023 regulates processing of digital personal data.', 'Section 4. Grounds for processing personal data under legitimate uses.'] },
      { page: 2, lines: ['Section 6. Notice and consent requirements for data fiduciaries.', 'Section 8. General obligations of data fiduciaries for technical safeguards.'] },
    ]
  );
  seedCorpus.replace(
    { id: 'IT-2000', title: 'Information Technology Act, 2000', topics: ['cyber', 'it'], instrumentType: 'statute' },
    { url: 'https://egazette.gov.in/it.pdf', sha256: 'b'.repeat(64) },
    [
      { page: 1, lines: ['Information Technology Act, 2000 provides legal recognition for electronic records.', 'Section 43A. Compensation for failure to protect sensitive data.'] },
      { page: 2, lines: ['Section 66A. Punishment for offensive messages (invalidated).', 'Section 69. Interception and monitoring of digital information.'] },
    ]
  );
  seedCorpus.close();

  const iterations = 50;

  // Baseline: Opening fresh DB connection, preparing queries dynamically, running search & coverage, and closing
  const baselineLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const c = openCorpus(ragDbPath);
    c.search('personal data protection');
    c.coverage();
    c.close();
    baselineLatencies.push(performance.now() - t0);
  }

  // Optimized: Using createCorpusLoader with persistent handle and cached prepared statements
  const loader = createCorpusLoader(ragDbPath);
  const optimizedCorpus = loader.getCorpus();

  // Warm-up
  optimizedCorpus.search('personal data protection');
  optimizedCorpus.coverage();

  const optimizedLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    optimizedCorpus.search('personal data protection');
    optimizedCorpus.coverage();
    optimizedLatencies.push(performance.now() - t0);
  }

  loader.close();
  try { fs.unlinkSync(ragDbPath); } catch {}

  const baseStats = computeDistributionStats(baselineLatencies);
  const optStats = computeDistributionStats(optimizedLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (No Pooling)', baseStats);
  printStatsRow('Optimized (Pooled & Cached)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 1: RAG Corpus Search & Coverage', baseStats, optStats, delta };
}

// ============================================================================
// Vector 2: Provision Retrieval & Caching
// ============================================================================
async function benchmarkVector2() {
  console.log('\n================================================================================');
  console.log('Vector 2: Provision Retrieval & Caching (getConstitutionProvision & getActProvision)');
  console.log('Evaluating SovereignLruCache hot turnaround vs cold SQLite retrieval & parsing');
  console.log('--------------------------------------------------------------------------------');

  const store = openLegalStore(':memory:');

  // Seed Constitution of India
  const coiActId = store.upsertAct(CONSTITUTION_ACT);
  const p21 = store.upsertProvision({ actId: coiActId, label: 'Art.21', heading: 'Protection of life and personal liberty' });
  store.addProvisionVersion({
    provisionId: p21,
    text: 'No person shall be deprived of his life or personal liberty except according to procedure established by law.',
    validFrom: '1950-01-26',
    verifiedThrough: '2026-01-01',
    sourceUrl: 'https://legislative.gov.in/constitution.pdf',
    sourceSha256: 'c'.repeat(64),
    footnotes: [],
  });

  const p14 = store.upsertProvision({ actId: coiActId, label: 'Art.14', heading: 'Equality before law' });
  store.addProvisionVersion({
    provisionId: p14,
    text: 'The State shall not deny to any person equality before the law or the equal protection of the laws within the territory of India.',
    validFrom: '1950-01-26',
    verifiedThrough: '2026-01-01',
    sourceUrl: 'https://legislative.gov.in/constitution.pdf',
    sourceSha256: 'c'.repeat(64),
    footnotes: [],
  });

  // Seed Bharatiya Nyaya Sanhita, 2023
  const bnsActId = store.upsertAct(actRecord(CENTRAL_ACTS.BNS));
  const s302 = store.upsertProvision({ actId: bnsActId, label: 's.302', heading: 'Snatching' });
  store.addProvisionVersion({
    provisionId: s302,
    text: 'Snatching is theft accomplished by suddenly or quickly or forcibly seizing, grabbing or taking away any movable property...',
    validFrom: '2024-07-01',
    verifiedThrough: '2026-01-01',
    sourceUrl: 'https://egazette.gov.in/WriteReadData/2023/250883.pdf',
    sourceSha256: 'd'.repeat(64),
    footnotes: [],
  });

  const coldIterations = 100;
  const coldLatencies = [];

  // Cold lookups: evicting cache before each retrieval
  for (let i = 0; i < coldIterations; i++) {
    // Clear provisionCache to simulate cold hit
    store.clearCache?.();
    const t0 = performance.now();
    getConstitutionProvision(store, '21', '2026-01-01');
    getActProvision(store, 'BNS', '302', '2026-01-01');
    coldLatencies.push(performance.now() - t0);
  }

  // Warm lookups: utilizing in-memory SovereignLruCache
  // Prime cache
  getConstitutionProvision(store, '21', '2026-01-01');
  getActProvision(store, 'BNS', '302', '2026-01-01');

  const warmIterations = 300;
  const warmLatencies = [];
  for (let i = 0; i < warmIterations; i++) {
    const t0 = performance.now();
    getConstitutionProvision(store, '21', '2026-01-01');
    getActProvision(store, 'BNS', '302', '2026-01-01');
    warmLatencies.push(performance.now() - t0);
  }

  store.close();

  const baseStats = computeDistributionStats(coldLatencies);
  const optStats = computeDistributionStats(warmLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (Cold Hits)', baseStats);
  printStatsRow('Optimized (LRU Cache Hits)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 2: Provision Retrieval & Caching', baseStats, optStats, delta };
}

// ============================================================================
// Vector 3: Term Coverage Calculation
// ============================================================================
async function benchmarkVector3() {
  console.log('\n================================================================================');
  console.log('Vector 3: Term Coverage Calculation (termCoverage)');
  console.log('Evaluating in-memory token set intersection throughput vs SQL query storm fallback');
  console.log('--------------------------------------------------------------------------------');

  const store = openLegalStore(':memory:');
  const coiActId = store.upsertAct(CONSTITUTION_ACT);
  const p21 = store.upsertProvision({ actId: coiActId, label: 'Art.21', heading: 'Protection of life and personal liberty' });

  const statutoryText = `
    No person shall be deprived of his life or personal liberty except according to procedure established by law.
    The State shall provide free and compulsory education to all children of the age of six to fourteen years
    in such manner as the State may, by law, determine. Every individual has the right to privacy, dignity, and bodily autonomy
    emanating from the fundamental guarantees of liberty, fair hearing, natural justice, and non-arbitrary administrative action.
  `.repeat(10); // Expansive statutory version text

  const versionId = store.addProvisionVersion({
    provisionId: p21,
    text: statutoryText,
    validFrom: '1950-01-26',
    verifiedThrough: '2026-01-01',
    sourceUrl: 'https://legislative.gov.in/constitution.pdf',
    sourceSha256: 'e'.repeat(64),
    footnotes: [],
  });

  const versionObj = {
    version_id: versionId,
    label: 'Art.21',
    heading: 'Protection of life and personal liberty',
    text: statutoryText,
  };

  const candidateQueries = [
    'What procedure protects personal liberty and fundamental right to privacy under established law?',
    'Does the state have an obligation to provide free education and fair hearing for children?',
    'Explain the guarantees of bodily autonomy, dignity, and natural justice in administrative action.',
    'Is arbitrary deprivation of life prohibited under constitutional guarantees of liberty?',
  ];

  // Baseline: SQL query storm fallback executing individual versionMatches queries per token
  const baselineIterations = 100;
  const baselineLatencies = [];
  const testTerms = ['procedure', 'protects', 'personal', 'liberty', 'fundamental', 'right', 'privacy', 'established', 'law'];

  // Access internal db statement for un-cached baseline comparison
  for (let i = 0; i < baselineIterations; i++) {
    const t0 = performance.now();
    // Simulate legacy per-term SQL query storm:
    let matches = 0;
    for (const term of testTerms) {
      // Direct SQL match query per term
      const row = store.searchProvisions(term, { asOf: '2026-01-01', limit: 1 });
      if (row.length > 0) matches++;
    }
    baselineLatencies.push(performance.now() - t0);
  }

  // Optimized: In-memory token set intersection with versionTokensCache
  const optimizedIterations = 300;
  const optimizedLatencies = [];

  // Warm-up cache
  store.termCoverage(versionObj, candidateQueries[0]);

  for (let i = 0; i < optimizedIterations; i++) {
    const query = candidateQueries[i % candidateQueries.length];
    const t0 = performance.now();
    store.termCoverage(versionObj, query);
    optimizedLatencies.push(performance.now() - t0);
  }

  store.close();

  const baseStats = computeDistributionStats(baselineLatencies);
  const optStats = computeDistributionStats(optimizedLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (SQL Query Storm)', baseStats);
  printStatsRow('Optimized (In-Memory Set)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 3: Term Coverage Calculation', baseStats, optStats, delta };
}

// ============================================================================
// Vector 4: Precedent Case Ranking
// ============================================================================
async function benchmarkVector4() {
  console.log('\n================================================================================');
  console.log('Vector 4: Precedent Case Ranking (casesForProvision)');
  console.log('Evaluating batched treatment & bench strength lookups with cardCache vs N+1 queries');
  console.log('--------------------------------------------------------------------------------');

  const store = openLegalStore(':memory:');
  const coiActId = store.upsertAct(CONSTITUTION_ACT);
  const p21 = store.upsertProvision({ actId: coiActId, label: 'Art.21', heading: 'Protection of life' });
  store.addProvisionVersion({
    provisionId: p21,
    text: 'No person shall be deprived of his life or personal liberty except according to procedure established by law.',
    validFrom: '1950-01-26',
    verifiedThrough: '2026-01-01',
    sourceUrl: 'https://legislative.gov.in/constitution.pdf',
    sourceSha256: 'f'.repeat(64),
    footnotes: [],
  });

  // Seed multiple landmark cases on Article 21
  const casesData = [
    { key: '1950_INSC_1', title: 'A.K. Gopalan v. State of Madras', decidedOn: '1950-05-19', benchStrength: 6 },
    { key: '1963_INSC_2', title: 'Kharak Singh v. State of U.P.', decidedOn: '1962-12-18', benchStrength: 6 },
    { key: '1978_INSC_3', title: 'Maneka Gandhi v. Union of India', decidedOn: '1978-01-25', benchStrength: 7 },
    { key: '1980_INSC_4', title: 'Sunil Batra v. Delhi Administration', decidedOn: '1979-12-20', benchStrength: 3 },
    { key: '1981_INSC_5', title: 'Francis Coralie Mullin v. UT of Delhi', decidedOn: '1981-01-13', benchStrength: 2 },
    { key: '1989_INSC_6', title: 'Parmanand Katara v. Union of India', decidedOn: '1989-08-28', benchStrength: 2 },
    { key: '1997_INSC_7', title: 'D.K. Basu v. State of West Bengal', decidedOn: '1996-12-18', benchStrength: 2 },
    { key: '2014_INSC_8', title: 'NALSA v. Union of India', decidedOn: '2014-04-15', benchStrength: 2 },
    { key: '2017_INSC_9', title: 'K.S. Puttaswamy v. Union of India', decidedOn: '2017-08-24', benchStrength: 9 },
    { key: '2018_INSC_10', title: 'Navtej Singh Johar v. Union of India', decidedOn: '2018-09-06', benchStrength: 5 },
  ];

  const caseIds = [];
  for (const c of casesData) {
    const id = store.upsertScCase({
      key: c.key,
      title: c.title,
      decidedOn: c.decidedOn,
      benchStrength: c.benchStrength,
      sourceUrl: `https://main.sci.gov.in/${c.key}.pdf`,
      pdfUrl: `https://main.sci.gov.in/${c.key}.pdf`,
      headnote: `Landmark interpretation of Article 21 regarding ${c.title}.`,
      provisions: [{ label: 'Art.21', group: 0 }],
      act: 'COI',
    });
    caseIds.push(id);
  }

  // Seed citation graph edges
  const edges = [
    { citingId: caseIds[8], citedId: caseIds[0], inList: true, treatment: 'Overruled', category: 'overruled', mentions: 12, refPage: 45, context: 'Gopalan doctrine discarded', contextPage: 45, method: 'alias' },
    { citingId: caseIds[8], citedId: caseIds[1], inList: true, treatment: 'Partly overruled', category: 'partly_overruled', mentions: 8, refPage: 60, context: 'Majority in Kharak Singh partly overruled', contextPage: 60, method: 'alias' },
    { citingId: caseIds[8], citedId: caseIds[2], inList: true, treatment: 'Approved', category: 'approved', mentions: 25, refPage: 110, context: 'Maneka Gandhi trilogy followed', contextPage: 110, method: 'alias' },
    { citingId: caseIds[9], citedId: caseIds[8], inList: true, treatment: 'Followed', category: 'approved', mentions: 18, refPage: 70, context: 'Puttaswamy autonomy followed', contextPage: 70, method: 'alias' },
    { citingId: caseIds[7], citedId: caseIds[2], inList: true, treatment: 'Followed', category: 'approved', mentions: 10, refPage: 35, context: 'Maneka expanded to gender identity', contextPage: 35, method: 'alias' },
    { citingId: caseIds[6], citedId: caseIds[2], inList: true, treatment: 'Followed', category: 'approved', mentions: 14, refPage: 55, context: 'DK Basu on custody safeguards', contextPage: 55, method: 'alias' },
    { citingId: caseIds[2], citedId: caseIds[0], inList: true, treatment: 'Questioned', category: 'questioned', mentions: 10, refPage: 30, context: 'Exclusivity theory questioned', contextPage: 30, method: 'alias' },
  ];

  store.replaceCitationGraph({
    edges,
    learned: [],
    statuses: caseIds.map((id) => [id, 'good']),
  });

  const iterations = 100;

  // Baseline: Un-batched N+1 lookups (re-fetching each case's bench strength individually without cardCache)
  const baselineLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const rows = store.casesForProvision({ act: 'COI', label: 'Art.21' });
    const cards = [];
    for (const row of rows) {
      // Simulating un-batched N+1 lookups: querying getCase for target bench strength
      const citing = store.citedBy(row.id);
      for (const edge of citing) {
        store.getCase(edge.citing_id); // N+1 query
      }
      // Re-query case details for target
      store.getCase(row.id);
      cards.push(toCard(store, { row, points: 50, breakdown: [] }, null));
    }
    baselineLatencies.push(performance.now() - t0);
  }

  // Optimized: Batched execution via casesForProvision with cardCache & targetBenchStrength
  const optimizedLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    casesForProvision(store, { provision: 'Art.21', limit: 6 });
    optimizedLatencies.push(performance.now() - t0);
  }

  store.close();

  const baseStats = computeDistributionStats(baselineLatencies);
  const optStats = computeDistributionStats(optimizedLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (N+1 Query Storm)', baseStats);
  printStatsRow('Optimized (Batched & Cached)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 4: Precedent Case Ranking', baseStats, optStats, delta };
}

// ============================================================================
// Vector 5: Speech Audio Cache Turnaround
// ============================================================================
async function benchmarkVector5() {
  console.log('\n================================================================================');
  console.log('Vector 5: Speech Audio Cache Turnaround (synthesizeIndianVoice)');
  console.log('Evaluating in-memory LRU audio cache turnaround vs cold network round-trip simulation');
  console.log('--------------------------------------------------------------------------------');

  resetSpeechState();

  const mockPayload = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const coldMockFetch = async () => {
    // Simulate remote neural speech synthesis network latency (~15ms)
    await new Promise((r) => setTimeout(r, 15));
    return {
      ok: true,
      json: async () => ({ audios: [mockPayload] }),
    };
  };

  const sampleTexts = [
    'Article 21 guarantees that no person shall be deprived of personal liberty.',
    'The Supreme Court in Puttaswamy held that privacy is a fundamental constitutional guarantee.',
    'Procedure established by law must be just, fair and reasonable, not arbitrary or fanciful.',
  ];

  // Baseline: Cold requests invoking remote neural TTS endpoint
  const coldIterations = 20;
  const coldLatencies = [];
  for (let i = 0; i < coldIterations; i++) {
    resetSpeechState(); // Force cold path
    const text = sampleTexts[i % sampleTexts.length];
    const t0 = performance.now();
    await synthesizeIndianVoice(
      { text, voice: 'indian-female', cloudConsent: true },
      { apiKey: 'mock-sarvam-key', fetchImpl: coldMockFetch }
    );
    coldLatencies.push(performance.now() - t0);
  }

  // Pre-seed audioCache for warm turnaround testing
  for (const text of sampleTexts) {
    await synthesizeIndianVoice(
      { text, voice: 'indian-female', cloudConsent: true },
      { apiKey: 'mock-sarvam-key', fetchImpl: coldMockFetch, useCache: true }
    );
  }

  // Optimized: Instantaneous turnaround from in-memory audioCache
  const warmIterations = 300;
  const warmLatencies = [];
  for (let i = 0; i < warmIterations; i++) {
    const text = sampleTexts[i % sampleTexts.length];
    const t0 = performance.now();
    await synthesizeIndianVoice(
      { text, voice: 'indian-female', cloudConsent: true },
      { apiKey: 'mock-sarvam-key' }
    );
    warmLatencies.push(performance.now() - t0);
  }

  resetSpeechState();

  const baseStats = computeDistributionStats(coldLatencies);
  const optStats = computeDistributionStats(warmLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (Cold Network TTS)', baseStats);
  printStatsRow('Optimized (Audio LRU Cache)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 5: Speech Audio Cache Turnaround', baseStats, optStats, delta };
}

// ============================================================================
// Vector 6: Reports Pipeline Concurrency
// ============================================================================
async function benchmarkVector6() {
  console.log('\n================================================================================');
  console.log('Vector 6: Reports Pipeline Concurrency (runConcurrent)');
  console.log('Evaluating bounded concurrency pool throughput across parallel DAG tasks vs serial');
  console.log('--------------------------------------------------------------------------------');

  const taskCount = 12;
  const simulatedDelayMs = 4;
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `claim-${i + 1}`,
    text: `Verified legal assertion statement ${i + 1} regarding statutory applicability.`,
  }));

  const simulatedWorker = async (task) => {
    await new Promise((r) => setTimeout(r, simulatedDelayMs));
    return { ...task, verified: true };
  };

  const iterations = 15;

  // Baseline: Serial execution (concurrency = 1)
  const serialLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await runConcurrent(tasks, 1, simulatedWorker);
    serialLatencies.push(performance.now() - t0);
  }

  // Optimized: Bounded concurrent execution (concurrency = 4)
  const concurrentLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await runConcurrent(tasks, 4, simulatedWorker);
    concurrentLatencies.push(performance.now() - t0);
  }

  const baseStats = computeDistributionStats(serialLatencies);
  const optStats = computeDistributionStats(concurrentLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (Serial limit=1)', baseStats);
  printStatsRow('Optimized (Concurrent limit=4)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 6: Reports Pipeline Concurrency', baseStats, optStats, delta };
}

// ============================================================================
// Vector 7: Content-Addressed PDF Passage Cache Turnaround
// ============================================================================
async function benchmarkVector7() {
  console.log('\n================================================================================');
  console.log('Vector 7: Content-Addressed PDF Passage Cache');
  console.log('Evaluating SHA-256 passage cache turnaround vs cold worker extraction round-trip');
  console.log('--------------------------------------------------------------------------------');

  clearPdfCache();

  const mockPdfBuffers = [
    Buffer.from('%PDF-1.4 Mock Legal Document 1: Constitutional Bench Judgment on Right to Privacy.'),
    Buffer.from('%PDF-1.4 Mock Legal Document 2: Consolidated Criminal Procedure Code Gazette Edition.'),
    Buffer.from('%PDF-1.4 Mock Legal Document 3: Digital Personal Data Protection Act Notification.'),
  ];

  const extractedPagesMock = [
    { page: 1, width: 612, height: 792, lines: [{ text: 'SUPREME COURT OF INDIA', x0: 50, top: 100, size: 14, bold: true }] },
    { page: 2, width: 612, height: 792, lines: [{ text: 'JUDGMENT on Article 21 and Privacy', x0: 50, top: 120, size: 12, bold: false }] },
  ];

  const coldIterations = 20;
  const coldLatencies = [];

  // Baseline: Cold path simulating SHA calculation + Python worker invocation (~12ms)
  for (let i = 0; i < coldIterations; i++) {
    clearPdfCache();
    const buffer = mockPdfBuffers[i % mockPdfBuffers.length];
    const t0 = performance.now();
    const sha = await computePdfSha256(buffer);
    // Simulate isolated worker execution delay
    await new Promise((r) => setTimeout(r, 12));
    passageCache.set(sha, extractedPagesMock);
    coldLatencies.push(performance.now() - t0);
  }

  // Pre-seed passageCache with SHA-256 entries
  for (const buffer of mockPdfBuffers) {
    const sha = await computePdfSha256(buffer);
    passageCache.set(sha, extractedPagesMock);
  }

  // Optimized: Instantaneous turnaround through memory cache
  const warmIterations = 300;
  const warmLatencies = [];
  for (let i = 0; i < warmIterations; i++) {
    const buffer = mockPdfBuffers[i % mockPdfBuffers.length];
    const t0 = performance.now();
    await extractPdfTextWithCache(buffer);
    warmLatencies.push(performance.now() - t0);
  }

  clearPdfCache();

  const baseStats = computeDistributionStats(coldLatencies);
  const optStats = computeDistributionStats(warmLatencies);
  const delta = computeDelta(baseStats, optStats);

  printStatsRow('Baseline (Cold Worker Spawn)', baseStats);
  printStatsRow('Optimized (Passage Cache Hit)', optStats);
  console.log(`  >>> Speedup Delta: ${delta.speedupRatio.toFixed(2)}x faster | Latency Reduction: ${delta.reductionPct.toFixed(1)}%`);

  return { name: 'Vector 7: PDF Passage Cache Turnaround', baseStats, optStats, delta };
}

// ============================================================================
// Comprehensive Summary Matrix
// ============================================================================
function printSummaryMatrix(results) {
  console.log('\n========================================================================================================================');
  console.log('                                     ADVOCATEVOX LATENCY BENCHMARK SUITE SUMMARY');
  console.log('========================================================================================================================');
  console.log(
    'Operational Vector                          | Baseline Mean | Optimized Mean | Speedup   | Latency Reduction | Status'
  );
  console.log(
    '------------------------------------------------------------------------------------------------------------------------'
  );

  for (const res of results) {
    const vectorName = res.name.padEnd(43);
    const baseMean = `${res.baseStats.meanMs.toFixed(3)} ms`.padStart(13);
    const optMean = `${res.optStats.meanMs.toFixed(3)} ms`.padStart(14);
    const speedup = `${res.delta.speedupRatio.toFixed(2)}x`.padStart(9);
    const reduction = `${res.delta.reductionPct.toFixed(1)}%`.padStart(17);
    const status = res.delta.speedupRatio > 1.0 ? ' PASS ' : ' CHECK';

    console.log(`${vectorName} | ${baseMean} | ${optMean} | ${speedup} | ${reduction} | ${status}`);
  }

  console.log('========================================================================================================================');
}

// ============================================================================
// Main Execution
// ============================================================================
async function main() {
  console.log('################################################################################');
  console.log('# ADVOCATEVOX ARCHITECTURAL ENHANCEMENTS: LATENCY BENCHMARK SUITE              #');
  console.log('# Environment: Node.js ' + process.version + ' on ' + process.platform + ' (' + process.arch + ')'.padEnd(47) + '#');
  console.log('# Zero External Runtime NPM Dependencies | Sovereign In-Memory Acceleration   #');
  console.log('################################################################################');

  const startTimestamp = new Date().toISOString();
  console.log(`Benchmark Run Started: ${startTimestamp}`);

  const results = [];

  try {
    results.push(await benchmarkVector1());
    results.push(await benchmarkVector2());
    results.push(await benchmarkVector3());
    results.push(await benchmarkVector4());
    results.push(await benchmarkVector5());
    results.push(await benchmarkVector6());
    results.push(await benchmarkVector7());

    printSummaryMatrix(results);

    const endTimestamp = new Date().toISOString();
    console.log(`\nBenchmark Completed Successfully: ${endTimestamp}`);
    process.exit(0);
  } catch (error) {
    console.error('\n[FATAL] Benchmark Suite Failed with Error:', error);
    process.exit(1);
  } finally {
    try {
      if (fs.existsSync(SCRATCH_DIR)) {
        fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
      }
    } catch {}
  }
}

main();
