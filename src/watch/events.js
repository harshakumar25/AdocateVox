/**
 * Downstream of the watcher: routes each pending change_event to what should
 * happen next, and marks it processed with the outcome.
 *
 * - Listing events are bookkeeping (their documents are already queued).
 * - A changed PDF whose text is identical to its previous version (only the
 *   bytes changed) is closed as such, before anything is checked or ingested.
 * - Tier 2 sources (unofficial copies) are signals only: never ingested. Signal
 *   hooks run for every such copy (tracing it to its official Gazette), and when
 *   the watchlist has a copy checker for the document, the copy is compared
 *   with the official text; their findings are recorded with the outcome.
 * - Tier 0/1 documents go to the ingestor registered for their watchlist.
 *   With no ingestor yet the event stays pending, so adding one later
 *   replays everything it missed.
 */

export const SIGNAL_ONLY = 'signal only: unofficial copy — verify against the official text; never ingested';
export const BYTES_ONLY = 'bytes-only change: the extracted text is identical to the previous version';

export const routeChangeEvent = async (event, { ingestors = {}, checkers = {}, signalHooks = [], sameText = null } = {}) => {
  if (event.target_kind === 'listing') return `listing ${event.kind}`;
  if (sameText && await sameText(event)) return BYTES_ONLY;
  if (event.tier === 2) {
    // Hooks that apply to every unofficial copy (provenance), then the watchlist's own checker.
    const notes = [];
    for (const hook of [...signalHooks, checkers[event.watchlist]].filter(Boolean)) {
      const note = await hook(event);
      if (note) notes.push(note);
    }
    return notes.length ? `${SIGNAL_ONLY}; ${notes.join('; ')}` : SIGNAL_ONLY;
  }
  const ingest = ingestors[event.watchlist];
  return ingest ? ingest(event) : null;
};

export const drainChangeEvents = async ({
  store, ingestors = {}, checkers = {}, signalHooks = [], sameText = null, limit = 100, now = Date.now,
}) => {
  const pending = store.pendingChangeEvents(limit);
  const processed = [];
  for (const event of pending) {
    const outcome = await routeChangeEvent(event, { ingestors, checkers, signalHooks, sameText });
    if (!outcome) continue;
    store.markChangeEventProcessed({ id: event.id, outcome, processedAt: new Date(now()).toISOString() });
    processed.push({ id: event.id, kind: event.kind, url: event.url, outcome });
  }
  return { pending: pending.length, processed };
};
