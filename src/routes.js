import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActProvision, getConstitutionProvision, lookupSection, searchLaw } from './service.js';
import { checkUploadedCopy } from './compare/checkCopy.js';
import { casesForProvision, citingJudgments } from './cases/service.js';
import { prepareCaseBrief } from './cases/brief.js';
import { createPoliteFetcher } from './sources/fetcher.js';

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
      act: parsedUrl.searchParams.get('act') || 'constitution',
      copyDate: parsedUrl.searchParams.get('date') || null,
    }));
  } catch {
    // Worker output can carry file paths; the browser only needs to know the file could not be read.
    return { ok: false, status: 422, error: 'Could not read text from that PDF. Scanned (image-only) PDFs cannot be checked yet.' };
  }
};

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAWBUDDY_WEB_DIR = path.resolve(PKG_ROOT, 'web');
const SHARED_VOICE_SELECTOR = path.resolve(PKG_ROOT, '../docvex/extension/voiceSelector.js');
const MONO_VOICE_SELECTOR = path.resolve(PKG_ROOT, '../../extension/voiceSelector.js');

const resolveVoiceSelector = () => {
  if (existsSync(SHARED_VOICE_SELECTOR)) return SHARED_VOICE_SELECTOR;
  if (existsSync(MONO_VOICE_SELECTOR)) return MONO_VOICE_SELECTOR;
  return path.resolve(PKG_ROOT, '../docvex/extension/voiceSelector.js');
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
  return Object.freeze({
    '/lawbuddy': [path.join(LAWBUDDY_WEB_DIR, 'index.html'), 'text/html; charset=utf-8'],
    '/lawbuddy/': [path.join(LAWBUDDY_WEB_DIR, 'index.html'), 'text/html; charset=utf-8'],
    '/lawbuddy/teach': [path.join(LAWBUDDY_WEB_DIR, 'teach.html'), 'text/html; charset=utf-8'],
    '/lawbuddy/check': [path.join(LAWBUDDY_WEB_DIR, 'check.html'), 'text/html; charset=utf-8'],
    '/lawbuddy/assets/check.js': [path.join(LAWBUDDY_WEB_DIR, 'check.js'), 'text/javascript; charset=utf-8'],
    '/lawbuddy/assets/cases.js': [path.join(LAWBUDDY_WEB_DIR, 'cases.js'), 'text/javascript; charset=utf-8'],
    '/lawbuddy/assets/lawbuddy.css': [path.join(LAWBUDDY_WEB_DIR, 'lawbuddy.css'), 'text/css; charset=utf-8'],
    '/lawbuddy/assets/home.js': [path.join(LAWBUDDY_WEB_DIR, 'home.js'), 'text/javascript; charset=utf-8'],
    '/lawbuddy/assets/teach.js': [path.join(LAWBUDDY_WEB_DIR, 'teach.js'), 'text/javascript; charset=utf-8'],
    '/lawbuddy/assets/common.js': [path.join(LAWBUDDY_WEB_DIR, 'common.js'), 'text/javascript; charset=utf-8'],
    '/lawbuddy/assets/voiceSelector.js': [voiceSelectorPath, 'text/javascript; charset=utf-8'],
  });
};

export const LAWBUDDY_FILES = getLawBuddyFiles();

export const isLawBuddyRoute = (pathname) => {
  return (
    pathname === '/lawbuddy' ||
    pathname.startsWith('/lawbuddy/')
  );
};

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
      res.end(JSON.stringify({ error: 'LawBuddy page not found.' }));
      return true;
    }
  }
  return false;
};

export const handleLawBuddyApiRoute = async (req, res, {
  pathname,
  parsedUrl,
  legalLibrary,
  sendJson,
  libraryMissingMessage = 'LawBuddy legal library is not installed. Import and ingest it first, e.g. npm run legal -- ingest-constitution <url>.',
  checkUpload = checkUploadedCopy,
  prepareBrief = prepareCaseBrief,
}) => {
  const isUpload = req.method === 'POST' && pathname === '/lawbuddy/api/copy-check';
  const briefMatch = req.method === 'POST' ? /^\/lawbuddy\/api\/cases\/(\d+)\/brief$/.exec(pathname) : null;
  if ((req.method !== 'GET' && !isUpload && !briefMatch) || !pathname.startsWith('/lawbuddy/api/')) {
    return false;
  }

  const store = await legalLibrary.get();
  if (pathname === '/lawbuddy/api/health') {
    sendJson(res, store ? 200 : 503, store
      ? { status: 'ok', service: 'LawBuddy', library: { ...store.stats(), ...store.librarySummary() } }
      : { status: 'unavailable', service: 'LawBuddy', error: libraryMissingMessage }, req);
    return true;
  }

  if (!store) {
    sendJson(res, 503, { error: libraryMissingMessage }, req);
    return true;
  }

  let result = null;
  if (isUpload) {
    result = await handleCopyUpload(req, store, parsedUrl, checkUpload);
  } else if (briefMatch) {
    req.resume();
    result = await handleCaseBrief(store, Number(briefMatch[1]), parsedUrl, prepareBrief);
  } else if (/^\/lawbuddy\/api\/cases\/\d+\/cited-by$/.test(pathname)) {
    // Every later judgment in the full-text index that cites this one, with the reporter's treatment.
    result = citingJudgments(store, Number(pathname.split('/')[4]));
  } else if (pathname === '/lawbuddy/api/cases') {
    // Supreme Court judgments on a provision, ranked by precedent points with their reasons.
    const limit = Math.min(12, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 6));
    result = casesForProvision(store, { provision: parsedUrl.searchParams.get('provision'), limit });
  } else if (pathname.startsWith('/lawbuddy/api/article/')) {
    let label;
    try {
      label = decodeURIComponent(pathname.slice('/lawbuddy/api/article/'.length));
    } catch {
      sendJson(res, 400, { error: 'Malformed provision label' }, req);
      return true;
    }
    result = getConstitutionProvision(store, label, parsedUrl.searchParams.get('asOf') || undefined);
  } else if (/^\/lawbuddy\/api\/section\/[A-Za-z]{2,5}\/[^/]+$/.test(pathname)) {
    // One section of a Central Act (BNS, BNSS, BSA) from its official Gazette text.
    const [, , , , act, section] = pathname.split('/');
    let label;
    try {
      label = decodeURIComponent(section);
    } catch {
      sendJson(res, 400, { error: 'Malformed section label' }, req);
      return true;
    }
    result = getActProvision(store, act, label, parsedUrl.searchParams.get('asOf') || undefined);
  } else if (pathname === '/lawbuddy/api/search') {
    result = searchLaw(store, parsedUrl.searchParams.get('q'));
  } else if (pathname === '/lawbuddy/api/lookup') {
    result = lookupSection(store, parsedUrl.searchParams.get('act'), parsedUrl.searchParams.get('section'));
  } else if (pathname === '/lawbuddy/api/sync') {
    // What is being watched for updates, when each URL is next checked, and what changed recently.
    result = { ok: true, ...store.watchSummary() };
  } else if (pathname === '/lawbuddy/api/copy-check') {
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
  sendJson(res, status ?? (body.ok ? 200 : 404), body, req);
  return true;
};
