/**
 * Polite fetcher for registered legal sources.
 *
 * Every request:
 * - must target a host in the source registry, including every redirect hop;
 * - honours robots.txt (cached per origin) and its Crawl-delay;
 * - waits its turn per host (one request at a time, min interval between them);
 * - sends If-None-Match / If-Modified-Since from the last successful fetch;
 * - stores the body once, content-addressed by sha256, in the raw vault (size-capped,
 *   per source where a source declares its own maxBytes), or, for yearly archives too large
 *   to keep (streamDocument), streams it to the caller and records only its sha256 and size;
 * - is written to fetch_log, success or failure.
 * There is deliberately no CAPTCHA handling: a source that needs one is not
 * fetched automatically.
 * Servers that send an incomplete certificate chain are completed and verified
 * the way browsers do (see tlsChain.js); verification itself is never relaxed.
 */

import { createHash } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { config } from '../config.js';
import { LEGAL_SOURCES, findSourceForUrl } from './registry.js';
import { parseRobots } from './robots.js';
import { storeInVault } from './vault.js';
import { createChainCompletingFetch } from './tlsChain.js';

const MAX_REDIRECTS = 5;
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_ERROR_TTL_MS = 10 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// A streamed archive is never stored, so its cap guards bandwidth, not disk: the largest SC year is ~0.9 GB.
const STREAM_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const STREAM_IDLE_MS = 120000;

// Shared by every fetcher in the process, so each host's chain is completed at most once.
const chainCompletingFetch = createChainCompletingFetch(fetch);

const ALLOW_ALL = Object.freeze({ isAllowed: () => true, crawlDelayMs: null });
const DISALLOW_ALL = Object.freeze({ isAllowed: () => false, crawlDelayMs: null });

const readBodyWithLimit = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const createPoliteFetcher = ({
  store,
  sources = LEGAL_SOURCES,
  vaultDir = config.LEGAL_RAW_DIR,
  userAgent = config.LEGAL_USER_AGENT,
  minIntervalMs = config.LEGAL_FETCH_MIN_INTERVAL_MS,
  timeoutMs = config.LEGAL_FETCH_TIMEOUT_MS,
  maxBytes = config.LEGAL_FETCH_MAX_BYTES,
  fetchImpl = chainCompletingFetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  for (const source of sources) store.registerSource(source);

  const productToken = userAgent.split(/[/\s]/)[0];
  const hosts = new Map();
  const robotsCache = new Map();

  const hostState = (hostname) => {
    if (!hosts.has(hostname)) {
      hosts.set(hostname, { tail: Promise.resolve(), lastAt: null, nextAt: 0, intervalMs: minIntervalMs });
    }
    return hosts.get(hostname);
  };

  /** Resolves when it is this caller's turn to hit `hostname`. */
  const waitForTurn = (hostname) => {
    const state = hostState(hostname);
    const turn = state.tail.then(async () => {
      const wait = state.nextAt - now();
      if (wait > 0) await sleep(wait);
      state.lastAt = now();
      state.nextAt = state.lastAt + state.intervalMs;
    });
    state.tail = turn.catch(() => {});
    return turn;
  };

  const withTimeout = async (run) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  // A network error says nothing about the site's rules, so it gets one more try; an HTTP answer is final.
  const ROBOTS_ATTEMPTS = 2;
  const loadRobots = async (origin, hostname) => {
    for (let attempt = 1; ; attempt += 1) {
      await waitForTurn(hostname);
      try {
        return await withTimeout(async (signal) => {
          const response = await fetchImpl(`${origin}/robots.txt`, { headers: { 'User-Agent': userAgent }, signal });
          if (response.status >= 200 && response.status < 300) {
            const text = (await readBodyWithLimit(response, ROBOTS_MAX_BYTES)).toString('utf8');
            return { rules: parseRobots(text, productToken), ttlMs: ROBOTS_TTL_MS };
          }
          await response.body?.cancel();
          // RFC 9309: 4xx means no restrictions; 5xx means assume complete disallow.
          if (response.status >= 400 && response.status < 500) return { rules: ALLOW_ALL, ttlMs: ROBOTS_TTL_MS };
          return { rules: DISALLOW_ALL, ttlMs: ROBOTS_ERROR_TTL_MS };
        });
      } catch {
        if (attempt >= ROBOTS_ATTEMPTS) return { rules: DISALLOW_ALL, ttlMs: ROBOTS_ERROR_TTL_MS };
      }
    }
  };

  /**
   * Robots rules for an origin. The in-flight lookup itself is cached, so
   * concurrent requests to one origin share a single robots.txt fetch.
   */
  const robotsFor = (parsedUrl) => {
    const cached = robotsCache.get(parsedUrl.origin);
    if (cached && cached.expiresAt > now()) return cached.rules;

    const entry = { expiresAt: Infinity, rules: null };
    entry.rules = loadRobots(parsedUrl.origin, parsedUrl.hostname).then(({ rules, ttlMs }) => {
      entry.expiresAt = now() + ttlMs;
      if (rules.crawlDelayMs) {
        const state = hostState(parsedUrl.hostname);
        state.intervalMs = Math.max(state.intervalMs, rules.crawlDelayMs);
        if (state.lastAt !== null) state.nextAt = Math.max(state.nextAt, state.lastAt + state.intervalMs);
      }
      return rules;
    });
    robotsCache.set(parsedUrl.origin, entry);
    return entry.rules;
  };

  /**
   * Fetches one document from a registered source.
   * Rejects only for programming errors (unregistered host); every network or
   * HTTP outcome is logged and returned as { ok, status, ... }.
   */
  const fetchDocument = async (url) => {
    const source = findSourceForUrl(url, sources);
    if (!source) {
      throw new TypeError(`Refusing to fetch ${url}: host is not a registered legal source`);
    }

    const fail = (status, error) => {
      store.recordFetch({ sourceId: source.id, url, httpStatus: status, error });
      return { ok: false, status, url, sourceId: source.id, error };
    };

    const previous = store.lastSuccessfulFetch(url);
    const headers = { 'User-Agent': userAgent };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.last_modified) headers['If-Modified-Since'] = previous.last_modified;

    try {
      let currentUrl = url;
      for (let hop = 0; ; hop += 1) {
        const parsed = new URL(currentUrl);
        if (!findSourceForUrl(currentUrl, sources)) {
          return fail(null, `redirected to unregistered host ${parsed.hostname}`);
        }
        const robots = await robotsFor(parsed);
        if (!robots.isAllowed(`${parsed.pathname}${parsed.search}`)) {
          return fail(null, `disallowed by robots.txt: ${currentUrl}`);
        }

        // Queue time is not network time: the timeout starts only once it is our turn.
        await waitForTurn(parsed.hostname);
        const outcome = await withTimeout(async (signal) => {
          const response = await fetchImpl(currentUrl, { headers, redirect: 'manual', signal });
          if (REDIRECT_STATUSES.has(response.status)) {
            await response.body?.cancel();
            return { kind: 'redirect', status: response.status, location: response.headers.get('location') };
          }
          if (response.status === 304 && previous) {
            await response.body?.cancel();
            return { kind: 'not-modified' };
          }
          if (response.status !== 200) {
            await response.body?.cancel();
            return { kind: 'http-error', status: response.status };
          }
          return {
            kind: 'ok',
            body: await readBodyWithLimit(response, source.maxBytes ?? maxBytes),
            contentType: response.headers.get('content-type'),
            etag: response.headers.get('etag'),
            lastModified: response.headers.get('last-modified'),
          };
        });

        if (outcome.kind === 'redirect') {
          if (!outcome.location) return fail(outcome.status, 'redirect without Location header');
          if (hop >= MAX_REDIRECTS) return fail(outcome.status, `more than ${MAX_REDIRECTS} redirects`);
          currentUrl = new URL(outcome.location, currentUrl).href;
          continue;
        }

        if (outcome.kind === 'not-modified') {
          store.recordFetch({
            sourceId: source.id, url, httpStatus: 304, sha256: previous.sha256, rawPath: previous.raw_path,
          });
          return {
            ok: true, status: 304, url, finalUrl: currentUrl, sourceId: source.id, notModified: true,
            changed: false, sha256: previous.sha256, rawPath: previous.raw_path, contentType: previous.content_type,
          };
        }

        if (outcome.kind === 'http-error') return fail(outcome.status, `HTTP ${outcome.status}`);

        const { sha256, rawPath } = await storeInVault(vaultDir, outcome.body);
        store.recordFetch({
          sourceId: source.id, url, httpStatus: 200, sha256, contentType: outcome.contentType,
          byteLength: outcome.body.length, etag: outcome.etag, lastModified: outcome.lastModified, rawPath,
        });
        return {
          ok: true, status: 200, url, finalUrl: currentUrl, sourceId: source.id, notModified: false,
          changed: previous?.sha256 !== sha256, sha256, rawPath, contentType: outcome.contentType,
          byteLength: outcome.body.length,
        };
      }
    } catch (error) {
      return fail(null, error.message);
    }
  };

  /**
   * Streams one large document (a yearly archive of judgments) from a registered source into
   * `consume(stream)` without storing it: the same host, redirect, robots.txt and turn-taking rules
   * as fetchDocument, but an idle timeout instead of a total one. The body's sha256 and size are logged
   * once `consume` has read it to the end; a body that was not read to the end is reported as failed.
   */
  const streamDocument = async (url, consume, { idleTimeoutMs = STREAM_IDLE_MS, maxStreamBytes = STREAM_MAX_BYTES } = {}) => {
    const source = findSourceForUrl(url, sources);
    if (!source) {
      throw new TypeError(`Refusing to fetch ${url}: host is not a registered legal source`);
    }
    const fail = (status, error) => {
      store.recordFetch({ sourceId: source.id, url, httpStatus: status, error });
      return { ok: false, status, url, sourceId: source.id, error };
    };

    let timer = null;
    try {
      let currentUrl = url;
      for (let hop = 0; ; hop += 1) {
        const parsed = new URL(currentUrl);
        if (!findSourceForUrl(currentUrl, sources)) return fail(null, `redirected to unregistered host ${parsed.hostname}`);
        const robots = await robotsFor(parsed);
        if (!robots.isAllowed(`${parsed.pathname}${parsed.search}`)) return fail(null, `disallowed by robots.txt: ${currentUrl}`);
        await waitForTurn(parsed.hostname);

        const controller = new AbortController();
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(new Error(`no data for ${idleTimeoutMs}ms`)), idleTimeoutMs);
        };
        arm();
        const response = await fetchImpl(currentUrl, { headers: { 'User-Agent': userAgent }, redirect: 'manual', signal: controller.signal });
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location) return fail(response.status, 'redirect without Location header');
          if (hop >= MAX_REDIRECTS) return fail(response.status, `more than ${MAX_REDIRECTS} redirects`);
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          return fail(response.status, `HTTP ${response.status}`);
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxStreamBytes) {
          await response.body.cancel();
          return fail(response.status, `response body exceeds ${maxStreamBytes} bytes`);
        }

        const hash = createHash('sha256');
        let bytes = 0;
        let ended = false;
        const tap = new Transform({
          transform(chunk, _encoding, done) {
            arm();
            bytes += chunk.length;
            if (bytes > maxStreamBytes) {
              done(new Error(`response body exceeds ${maxStreamBytes} bytes`));
              return;
            }
            hash.update(chunk);
            done(null, chunk);
          },
          flush(done) {
            ended = true;
            done();
          },
        });
        pipeline(Readable.fromWeb(response.body), tap, () => {});
        const result = await consume(tap, { contentLength: Number.isFinite(declared) ? declared : null });
        clearTimeout(timer);
        if (!ended || (Number.isFinite(declared) && bytes !== declared)) {
          controller.abort();
          return fail(200, `stream ended after ${bytes} bytes${Number.isFinite(declared) ? ` of ${declared}` : ''}`);
        }
        const sha256 = hash.digest('hex');
        const contentType = response.headers.get('content-type');
        store.recordFetch({
          sourceId: source.id, url, httpStatus: 200, sha256, contentType, byteLength: bytes,
          etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), rawPath: null,
        });
        return { ok: true, status: 200, url, finalUrl: currentUrl, sourceId: source.id, sha256, byteLength: bytes, contentType, result };
      }
    } catch (error) {
      clearTimeout(timer);
      return fail(null, error.message);
    }
  };

  return { fetchDocument, streamDocument };
};
