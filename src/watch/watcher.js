/**
 * Change watcher: revalidates watched listings and documents through the
 * polite fetcher and turns every observed difference into a change_event.
 *
 * - Listings are compared by the set of document links they offer, not by
 *   bytes, so a cosmetic page edit is not a "change". New links become
 *   watched documents; vanished links are marked gone; returning links are restored.
 * - Documents are compared by sha256 against the last version this watcher
 *   saw. The fetcher's If-None-Match / If-Modified-Since revalidation makes
 *   an unchanged check a bodiless 304 wherever the server supports it.
 * - 403 pauses a target for a person to decide (we never get around a bot
 *   block); 404/410 three times in a row marks it gone; any other failure
 *   backs off. Every check moves the target's next due time on its
 *   adaptive schedule (see cadence.js).
 */

import fs from 'node:fs/promises';
import { LEGAL_SOURCES, findSourceForUrl } from '../sources/registry.js';
import { WATCHLISTS } from './watchlists.js';
import { extractLinks } from './links.js';
import { nextInterval, withJitter } from './cadence.js';

const MISSING_STATUSES = new Set([404, 410]);
const GONE_AFTER_MISSES = 3;
const LEASE_MS = 10 * 60 * 1000;
const CLAIM_BATCH = 10;
export const REMOVED_FROM_LISTING = 'link removed from its listing page';

export const createWatcher = ({
  store,
  fetcher,
  watchlists = WATCHLISTS,
  sources = LEGAL_SOURCES,
  now = Date.now,
  random = Math.random,
  readFile = fs.readFile,
}) => {
  const listsById = new Map(watchlists.map((list) => [list.id, list]));
  const iso = (ms) => new Date(ms).toISOString();

  /** Registers every watchlist's listing page (idempotent; existing schedules are kept). */
  const seed = () =>
    watchlists.map((list) => ({
      watchlist: list.id,
      targetId: store.upsertWatchTarget({
        url: list.listingUrl,
        sourceId: list.sourceId,
        watchlist: list.id,
        kind: 'listing',
        minIntervalMs: list.listing.minIntervalMs,
        maxIntervalMs: list.listing.maxIntervalMs,
        nextCheckAt: iso(now()),
      }),
    }));

  /** The listing's current document links: matching the pattern and on the watchlist's own source. */
  const documentLinks = (list, html, pageUrl) =>
    extractLinks(html, pageUrl).filter((link) => {
      const { pathname } = new URL(link.url);
      return list.documentPattern.test(pathname) && findSourceForUrl(link.url, sources)?.id === list.sourceId;
    });

  /** Reconciles a listing's children with the links it offers now; returns what moved. */
  const syncListing = async (target, list, result, at, record) => {
    const links = documentLinks(list, await readFile(result.rawPath, 'utf8'), result.finalUrl || target.url);
    const children = new Map(store.childWatchTargets(target.id).map((child) => [child.url, child]));
    const offered = new Set(links.map((link) => link.url));
    const delta = { added: [], removed: [], restored: [] };

    for (const link of links) {
      const child = children.get(link.url);
      const label = (list.cleanLabel ? list.cleanLabel(link.text) : link.text) || null;
      if (!child || child.label !== label) {
        // New link, or a known one whose title changed: upserting keeps an existing schedule and state.
        store.upsertWatchTarget({
          url: link.url,
          sourceId: list.sourceId,
          watchlist: list.id,
          kind: 'document',
          parentId: target.id,
          label,
          minIntervalMs: list.documents.minIntervalMs,
          maxIntervalMs: list.documents.maxIntervalMs,
          nextCheckAt: iso(at),
        });
      }
      if (!child) {
        delta.added.push(link.url);
      } else if (child.state === 'gone' && child.state_reason === REMOVED_FROM_LISTING) {
        store.setWatchTargetState({ id: child.id, state: 'active', nextCheckAt: iso(at) });
        record(child, 'restored', { detail: { listing: target.url } });
        delta.restored.push(link.url);
      }
    }

    for (const child of children.values()) {
      if (child.state === 'active' && !offered.has(child.url)) {
        store.setWatchTargetState({ id: child.id, state: 'gone', reason: REMOVED_FROM_LISTING });
        record(child, 'removed', { detail: { listing: target.url } });
        delta.removed.push(child.url);
      }
    }

    return { ...delta, documents: links.length };
  };

  /** One revalidation of one claimed target. Never throws: failures are recorded on the target. */
  const checkTarget = async (claimed) => {
    // A listing checked earlier in the same batch may have retired this document since it was claimed.
    const target = store.getWatchTarget(claimed.id);
    if (target?.state !== 'active') {
      store.releaseWatchLease(claimed.id);
      return { url: claimed.url, kind: claimed.kind, outcome: 'skipped', state: target?.state ?? 'gone', events: [], error: null };
    }

    const events = [];
    const at = now();
    const record = (owner, kind, extra = {}) => {
      store.recordChangeEvent({ targetId: owner.id, kind, detectedAt: iso(at), ...extra });
      events.push({ kind, url: owner.url, label: owner.label });
    };
    const finish = ({ outcome, state = 'active', stateReason = null, sha256 = null, failures = 0, changed = false }) => {
      const intervalMs = nextInterval({
        intervalMs: target.interval_ms,
        minIntervalMs: target.min_interval_ms,
        maxIntervalMs: target.max_interval_ms,
        outcome,
      });
      store.completeWatchCheck({
        id: target.id,
        state,
        stateReason,
        intervalMs,
        nextCheckAt: iso(at + withJitter(intervalMs, random)),
        checkedAt: iso(at),
        changedAt: changed ? iso(at) : null,
        sha256,
        failures,
      });
      return { url: target.url, kind: target.kind, outcome, state, events, error: stateReason };
    };

    try {
      const list = listsById.get(target.watchlist);
      if (!list) {
        return finish({ outcome: 'failed', state: 'paused', stateReason: `unknown watchlist ${target.watchlist}` });
      }

      const result = await fetcher.fetchDocument(target.url);
      if (!result.ok) {
        const failures = target.failures + 1;
        if (result.status === 403) {
          record(target, 'paused', { detail: { status: 403 } });
          return finish({ outcome: 'failed', state: 'paused', stateReason: 'HTTP 403: blocked for our bot; import manually or ask the publisher for access', failures });
        }
        if (MISSING_STATUSES.has(result.status) && failures >= GONE_AFTER_MISSES) {
          record(target, 'gone', { detail: { status: result.status, failures } });
          return finish({ outcome: 'failed', state: 'gone', stateReason: `HTTP ${result.status} ${failures} times in a row`, failures });
        }
        return finish({ outcome: 'failed', stateReason: result.error || `HTTP ${result.status}`, failures });
      }

      if (target.kind === 'listing') {
        const delta = await syncListing(target, list, result, at, record);
        const moved = delta.added.length + delta.removed.length + delta.restored.length > 0;
        if (!target.last_checked_at || moved) {
          record(target, target.last_checked_at ? 'changed' : 'discovered', { newSha256: result.sha256, detail: delta });
        }
        return finish({ outcome: moved ? 'changed' : 'unchanged', sha256: result.sha256, changed: moved });
      }

      const isNew = result.sha256 !== target.last_sha256;
      if (isNew) {
        record(target, target.last_sha256 ? 'changed' : 'discovered', {
          oldSha256: target.last_sha256,
          newSha256: result.sha256,
          rawPath: result.rawPath,
          detail: { contentType: result.contentType ?? null, byteLength: result.byteLength ?? null },
        });
      }
      return finish({ outcome: isNew ? 'changed' : 'unchanged', sha256: result.sha256, changed: isNew });
    } catch (error) {
      return finish({ outcome: 'failed', stateReason: error.message, failures: target.failures + 1 });
    }
  };

  /**
   * Checks everything due now (listings first, then the documents they
   * reveal), at most `limit` targets. `kind: 'listing'` checks listings only:
   * a discovery pass that downloads no documents.
   */
  const runDue = async ({ limit = 100, kind = null } = {}) => {
    const summary = { ok: true, checked: 0, outcomes: {}, events: [], errors: [] };
    while (summary.checked < limit) {
      const batch = store.claimDueWatchTargets({
        now: iso(now()),
        leaseUntil: iso(now() + LEASE_MS),
        limit: Math.min(CLAIM_BATCH, limit - summary.checked),
        kind,
      });
      if (!batch.length) break;
      for (const target of batch) {
        const checked = await checkTarget(target);
        summary.checked += 1;
        summary.outcomes[checked.outcome] = (summary.outcomes[checked.outcome] || 0) + 1;
        summary.events.push(...checked.events);
        if (checked.outcome === 'failed') summary.errors.push({ url: checked.url, state: checked.state, error: checked.error });
      }
    }
    return summary;
  };

  return { seed, checkTarget, runDue };
};
