import { synthesizeIndianVoice } from './speech/indianVoice.js';
import { openCorpus } from './rag/corpus.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActProvision, getConstitutionProvision, lookupSection, searchCatalog, searchLaw } from './service.js';
import { checkUploadedCopy } from './compare/checkCopy.js';
import { casesForProvision, citingJudgments } from './cases/service.js';
import { prepareCaseBrief } from './cases/brief.js';
import { verifyCaseCitation } from './cases/citationVerify.js';
import { createPoliteFetcher } from './sources/fetcher.js';
import { createLegalReport } from './reports/report.js';
import { generateReportText } from './reports/provider.js';

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/**
 * The request body as a Buffer, or null when it exceeds `maxBytes`. An oversized body is
 * drained rather than buffered, so the 413 can still be sent on the same connection.
 */
const readBody = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => resolve(total > maxBytes ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });

// One PDF is read at a time (uploads and judgment briefs alike): each read starts a Python worker.
let pdfQueue = Promise.resolve();
const queuePdfWork = (task) => {
  const run = pdfQueue.then(task);
  pdfQueue = run.catch(() => {});
  return run;
};

// One polite fetcher per open library, so per-host spacing and robots.txt caching hold across requests.
const fetchers = new WeakMap();
const fetcherFor = (store) => {
  if (!fetchers.has(store)) fetchers.set(store, createPoliteFetcher({ store }));
  return fetchers.get(store);
};

/** POST /lawbuddy/api/cases/:id/brief — the verified brief of one judgment, prepared once and cached. */
const handleCaseBrief = async (store, caseId, parsedUrl, prepareBrief) => {
  try {
    return await queuePdfWork(() => prepareBrief({
      store, fetcher: fetcherFor(store), caseId, label: parsedUrl.searchParams.get('label') || null,
    }));
  } catch {
    return { ok: false, status: 502, error: 'The brief could not be prepared right now. Please try again shortly.' };
  }
};

/** POST /lawbuddy/api/copy-check — "Is my bare act current?" for an uploaded PDF. */
const handleCopyUpload = async (req, store, parsedUrl, checkUpload) => {
  if (!/^application\/pdf\b/i.test(req.headers['content-type'] || '')) {
    req.resume();
    return { ok: false, status: 415, error: 'Send the file as application/pdf.' };
  }
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body) return { ok: false, status: 413, error: `The PDF is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };

  try {
    return await queuePdfWork(() => checkUpload({
      store,
      body,
      act: parsedUrl.searchParams.get('act') || 'auto',
      copyDate: parsedUrl.searchParams.get('date') || null,
      cloudClaims: parsedUrl.searchParams.get('cloudClaims') === '1',
    }));
  } catch {
    // Worker output can carry file paths; the browser only needs to know the file could not be read.
    return { ok: false, status: 422, error: 'Could not read text from that PDF. Scanned (image-only) PDFs cannot be checked yet.' };
  }
};

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAWBUDDY_WEB_DIR = path.resolve(PKG_ROOT, 'web');
const LOCAL_VOICE_SELECTOR = path.join(LAWBUDDY_WEB_DIR, 'voiceSelector.js');
const SHARED_VOICE_SELECTOR = path.resolve(PKG_ROOT, '../docvex/extension/voiceSelector.js');
const MONO_VOICE_SELECTOR = path.resolve(PKG_ROOT, '../../extension/voiceSelector.js');

const resolveVoiceSelector = () => {
  if (existsSync(LOCAL_VOICE_SELECTOR)) return LOCAL_VOICE_SELECTOR;
  if (existsSync(SHARED_VOICE_SELECTOR)) return SHARED_VOICE_SELECTOR;
  if (existsSync(MONO_VOICE_SELECTOR)) return MONO_VOICE_SELECTOR;
  return LOCAL_VOICE_SELECTOR;
};

export const LAWBUDDY_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
    + "font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; "
    + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
});

export const getLawBuddyFiles = () => {
  const voiceSelectorPath = resolveVoiceSelector();
  const cssFile = existsSync(path.join(LAWBUDDY_WEB_DIR, 'advocatevox.css'))
    ? path.join(LAWBUDDY_WEB_DIR, 'advocatevox.css')
    : path.join(LAWBUDDY_WEB_DIR, 'lawbuddy.css');

  const files = {
    '/advocatevox': [path.join(LAWBUDDY_WEB_DIR, 'index.html'), 'text/html; charset=utf-8'],
    '/advocatevox/': [path.join(LAWBUDDY_WEB_DIR, 'index.html'), 'text/html; charset=utf-8'],
    '/advocatevox/teach': [path.join(LAWBUDDY_WEB_DIR, 'teach.html'), 'text/html; charset=utf-8'],
    '/advocatevox/check': [path.join(LAWBUDDY_WEB_DIR, 'check.html'), 'text/html; charset=utf-8'],
    '/advocatevox/practice': [path.join(LAWBUDDY_WEB_DIR, 'practice.html'), 'text/html; charset=utf-8'],
    '/advocatevox/reports': [path.join(LAWBUDDY_WEB_DIR, 'reports.html'), 'text/html; charset=utf-8'],
    '/advocatevox/assets/reports.js': [path.join(LAWBUDDY_WEB_DIR, 'reports.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/reportDocx.js': [path.join(LAWBUDDY_WEB_DIR, 'reportDocx.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/practice.js': [path.join(LAWBUDDY_WEB_DIR, 'practice.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/practiceModel.js': [path.join(LAWBUDDY_WEB_DIR, 'practiceModel.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/practiceDocx.js': [path.join(LAWBUDDY_WEB_DIR, 'practiceDocx.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/practiceStore.js': [path.join(LAWBUDDY_WEB_DIR, 'practiceStore.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/check.js': [path.join(LAWBUDDY_WEB_DIR, 'check.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/cases.js': [path.join(LAWBUDDY_WEB_DIR, 'cases.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/advocatevox.css': [cssFile, 'text/css; charset=utf-8'],
    '/advocatevox/assets/lawbuddy.css': [cssFile, 'text/css; charset=utf-8'],
    '/advocatevox/assets/home.js': [path.join(LAWBUDDY_WEB_DIR, 'home.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/teach.js': [path.join(LAWBUDDY_WEB_DIR, 'teach.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/common.js': [path.join(LAWBUDDY_WEB_DIR, 'common.js'), 'text/javascript; charset=utf-8'],
    '/advocatevox/assets/voiceSelector.js': [voiceSelectorPath, 'text/javascript; charset=utf-8'],
  };

  // Backwards compatibility for /lawbuddy routes
  for (const [route, entry] of Object.entries(files)) {
    const legacyRoute = route.replace('/advocatevox', '/lawbuddy');
    files[legacyRoute] = entry;
  }

  return Object.freeze(files);
};

export const LAWBUDDY_FILES = getLawBuddyFiles();
export const ADVOCATEVOX_FILES = LAWBUDDY_FILES;
export const getAdvocateVoxFiles = getLawBuddyFiles;
export const ADVOCATEVOX_SECURITY_HEADERS = LAWBUDDY_SECURITY_HEADERS;

export const isAdvocateVoxRoute = (pathname) => {
  return (
    pathname === '/advocatevox' ||
    pathname.startsWith('/advocatevox/') ||
    pathname === '/lawbuddy' ||
    pathname.startsWith('/lawbuddy/')
  );
};

export const isLawBuddyRoute = isAdvocateVoxRoute;

export const handleLawBuddyStaticRoute = (req, res, pathname, files = LAWBUDDY_FILES) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && files[pathname]) {
    const [filePath, contentType] = files[pathname];
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, ...LAWBUDDY_SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AdvocateVox page not found.' }));
      return true;
    }
  }
  return false;
};

export const handleAdvocateVoxStaticRoute = handleLawBuddyStaticRoute;

export const handleLawBuddyApiRoute = async (req, res, {
  pathname,
  parsedUrl,
  legalLibrary,
  sendJson,
  libraryMissingMessage = 'AdvocateVox legal library is not installed. Import and ingest it first, e.g. npm run legal -- ingest-constitution <url>.',
  checkUpload = checkUploadedCopy,
  prepareBrief = prepareCaseBrief,
  reportGenerate = generateReportText,
  reportOptions = {},
  reportDiscover,
}) => {
  const isSpeech = (pathname === '/advocatevox/api/speech' || pathname === '/lawbuddy/api/speech') && ['GET', 'POST'].includes(req.method);
  if (isSpeech) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      sendJson(res, 200, { configured: Boolean(process.env.SARVAM_API_KEY), provider: 'Sarvam', language: 'en-IN' }, req);
    } else {
      // This paid endpoint accepts same-origin JSON requests only.
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
      if (!sameOrigin || !String(req.headers['content-type']).startsWith('application/json')) {
        sendJson(res, 403, { error: 'Use the AdvocateVox voice controls.' }, req);
        return true;
      }
      const body = await readBody(req, 16000);
      let input;
      try { input = body && JSON.parse(body.toString('utf8')); } catch {}
      const result = body ? await synthesizeIndianVoice(input) : { status: 413, error: 'Speech request is too large.' };
      sendJson(res, result.status, result, req);
    }
    return true;
  }

  // Normalize API pathname to /lawbuddy/api/... for unified dispatch
  let apiPath = pathname;
  if (apiPath.startsWith('/advocatevox/api/')) {
    apiPath = '/lawbuddy/api/' + apiPath.slice('/advocatevox/api/'.length);
  } else if (apiPath === '/advocatevox/api') {
    apiPath = '/lawbuddy/api';
  }

  const isUpload = req.method === 'POST' && apiPath === '/lawbuddy/api/copy-check';
  const isReport = req.method === 'POST' && apiPath === '/lawbuddy/api/reports';
  const briefMatch = req.method === 'POST' ? /^\/lawbuddy\/api\/cases\/(\d+)\/brief$/.exec(apiPath) : null;
  if ((req.method !== 'GET' && !isUpload && !isReport && !briefMatch) || !apiPath.startsWith('/lawbuddy/api/')) {
    return false;
  }

  const store = await legalLibrary.get();
  if (apiPath === '/lawbuddy/api/health') {
    sendJson(res, store ? 200 : 503, store
      ? { status: 'ok', service: 'AdvocateVox', library: { ...store.stats(), ...store.librarySummary() } }
      : { status: 'unavailable', service: 'AdvocateVox', error: libraryMissingMessage }, req);
    return true;
  }

  if (!store) {
    sendJson(res, 503, { error: libraryMissingMessage }, req);
    return true;
  }

  let result = null;
  if (apiPath === '/lawbuddy/api/reports/providers') {
    result = { ok: true, providers: {
      ollama: { configured: true },
      grok: { configured: Boolean(reportOptions.XAI_API_KEY || process.env.XAI_API_KEY) },
      groq: { configured: Boolean(reportOptions.GROQ_API_KEY || process.env.GROQ_API_KEY) },
    } };
  } else if (isReport) {
    const body = await readBody(req, 2 * 1024 * 1024);
    if (!body) result = { ok: false, status: 413, error: 'Report request is too large.' };
    else {
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { input = null; }
      result = input && typeof input === 'object' ? await createLegalReport({ store, input, fetcher: fetcherFor(store), discoverCase: reportDiscover,
        generate: (args) => reportGenerate({ ...args, options: reportOptions }),
        options: { ...reportOptions, checkpointDir: reportOptions.REPORT_CHECKPOINT_DIR || undefined },
      }) : { ok: false, status: 400, error: 'Send a JSON report request.' };
    }
  } else if (isUpload) {
    result = await handleCopyUpload(req, store, parsedUrl, checkUpload);
  } else if (briefMatch) {
    req.resume();
    result = await handleCaseBrief(store, Number(briefMatch[1]), parsedUrl, prepareBrief);
  } else if (/^\/lawbuddy\/api\/cases\/\d+\/cited-by$/.test(apiPath)) {
    // Every later judgment in the full-text index that cites this one, with the reporter's treatment.
    result = citingJudgments(store, Number(apiPath.split('/')[4]));
  } else if (apiPath === '/lawbuddy/api/cases') {
    // Supreme Court judgments on a provision, ranked by precedent points with their reasons.
    const limit = Math.min(12, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 6));
    result = casesForProvision(store, {
      provision: parsedUrl.searchParams.get('provision'), limit,
      decidedBy: parsedUrl.searchParams.get('decidedBy') || null,
    });
  } else if (apiPath === '/lawbuddy/api/citation') {
    result = verifyCaseCitation(store, parsedUrl.searchParams.get('citation'));
  } else if (apiPath.startsWith('/lawbuddy/api/article/')) {
    let label;
    try {
      label = decodeURIComponent(apiPath.slice('/lawbuddy/api/article/'.length));
    } catch {
      sendJson(res, 400, { error: 'Malformed provision label' }, req);
      return true;
    }
    result = getConstitutionProvision(store, label, parsedUrl.searchParams.get('asOf') || undefined);
  } else if (/^\/lawbuddy\/api\/section\/[A-Za-z][A-Za-z0-9]{1,19}\/[^/]+$/.test(apiPath)) {
    // One dated, official-source section or rule from an indexed instrument.
    const [, , , , act, section] = apiPath.split('/');
    let label;
    try {
      label = decodeURIComponent(section);
    } catch {
      sendJson(res, 400, { error: 'Malformed section label' }, req);
      return true;
    }
    result = getActProvision(store, act, label, parsedUrl.searchParams.get('asOf') || undefined);
  } else if (apiPath === '/lawbuddy/api/search') {
    result = searchLaw(store, parsedUrl.searchParams.get('q'), {
      act: parsedUrl.searchParams.get('act'), asOf: parsedUrl.searchParams.get('asOf') || undefined,
    });
  } else if (apiPath === '/lawbuddy/api/rag/search') {
    const corpus = openCorpus();
    try { result = { ok: true, mode: 'FTS5 BM25 source retrieval', items: corpus.search((parsedUrl.searchParams.get('q') || '').slice(0,2000), { topic: parsedUrl.searchParams.get('topic') || '', instrument: parsedUrl.searchParams.get('instrument') || '' }) }; } finally { corpus.close(); }
  } else if (apiPath === '/lawbuddy/api/rag/coverage') {
    const corpus = openCorpus();
    try { result = { ok: true, items: corpus.coverage() }; } finally { corpus.close(); }
  } else if (apiPath === '/lawbuddy/api/catalog') {
    result = searchCatalog(store, {
      query: parsedUrl.searchParams.get('q') || '', topic: parsedUrl.searchParams.get('topic') || '',
      includeForeign: parsedUrl.searchParams.get('includeForeign') === '1',
      asOf: parsedUrl.searchParams.get('asOf') || undefined,
    });
    if (result.ok) {
      const corpus = openCorpus();
      try { const coverage = new Map(corpus.coverage().map((row) => [row.id,row])); result.items = result.items.map((item) => ({...item, rag: coverage.get(item.id) || null})); } finally { corpus.close(); }
    }
  } else if (apiPath === '/lawbuddy/api/lookup') {
    result = lookupSection(store, parsedUrl.searchParams.get('act'), parsedUrl.searchParams.get('section'));
  } else if (apiPath === '/lawbuddy/api/sync') {
    // What is being watched for updates, when each URL is next checked, and what changed recently.
    result = { ok: true, ...store.watchSummary() };
  } else if (apiPath === '/lawbuddy/api/copy-check') {
    // The stored "is this copy current?" report for a copy's URL (checks run in the watch pipeline / CLI).
    const stored = store.latestCopyCheck(parsedUrl.searchParams.get('url') || '');
    result = stored
      ? { ok: true, checkedAt: stored.checked_at, ...stored.report }
      : { ok: false, status: 404, error: 'No check has been run for that copy.' };
  }

  if (!result) {
    sendJson(res, 404, { error: 'Not found' }, req);
    return true;
  }

  const { status, ...body } = result;
  const httpStatus = Number.isInteger(status) ? status : (body.ok ? 200 : 404);
  sendJson(res, httpStatus, typeof status === 'string' ? { ...body, status } : body, req);
  return true;
};

export const handleAdvocateVoxApiRoute = handleLawBuddyApiRoute;
