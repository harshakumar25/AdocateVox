/**
 * Adaptive revalidation interval for a watched URL.
 *
 * - changed:   drop to the minimum — documents that just changed often change again
 *              (corrigenda, re-uploads), so look sooner.
 * - unchanged: back off ×1.5 towards the maximum — stable pages cost almost nothing.
 * - failed:    back off ×2 — a struggling server should hear from us less, not more.
 * Jitter (±10%) keeps targets seeded together from all coming due in one burst.
 */

const GROWTH = Object.freeze({ unchanged: 1.5, failed: 2 });

export const nextInterval = ({ intervalMs, minIntervalMs, maxIntervalMs, outcome }) => {
  if (outcome === 'changed') return minIntervalMs;
  const growth = GROWTH[outcome];
  if (!growth) throw new TypeError(`unknown check outcome ${JSON.stringify(outcome)}`);
  return Math.min(maxIntervalMs, Math.max(minIntervalMs, Math.round(intervalMs * growth)));
};

export const withJitter = (ms, random = Math.random, spread = 0.1) =>
  Math.max(1, Math.round(ms * (1 - spread + 2 * spread * random())));
