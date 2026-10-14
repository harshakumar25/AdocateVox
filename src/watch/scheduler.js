/**
 * Long-running watch loop: run a cycle, then sleep until the next target is
 * due (never less than a second, never more than `maxSleepMs`, so new
 * watchlists are picked up), until `signal` aborts. A failing cycle is
 * reported and the loop carries on; a daemon must outlive one bad night.
 */

const sleepUnlessAborted = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export const runWatchLoop = async ({
  cycle,
  nextDueAt,
  signal,
  maxSleepMs = 15 * 60 * 1000,
  minSleepMs = 1000,
  now = Date.now,
  sleep = sleepUnlessAborted,
  onCycle = () => {},
  onError = () => {},
}) => {
  while (!signal.aborted) {
    try {
      onCycle(await cycle());
    } catch (error) {
      onError(error);
    }
    if (signal.aborted) break;

    const due = nextDueAt();
    const untilDue = due ? Date.parse(due) - now() : maxSleepMs;
    await sleep(Math.min(maxSleepMs, Math.max(minSleepMs, untilDue)), signal);
  }
};
