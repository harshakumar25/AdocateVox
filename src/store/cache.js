/**
 * Zero-dependency in-process Least Recently Used (LRU) cache with Time-To-Live (TTL) eviction.
 * Utilizes JavaScript Map's insertion-order preservation to achieve O(1) get/set/evict.
 */
export class SovereignLruCache {
  /**
   * @param {number} [maxSize=500] Maximum number of entries before LRU eviction.
   * @param {number} [ttlMs=300000] Time-to-live per entry in milliseconds (default 5 minutes).
   */
  constructor(maxSize = 500, ttlMs = 300000) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new TypeError('maxSize must be a positive integer.');
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive integer.');
    }
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // Key -> { value, expiresAt }
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Retrieves an item from cache, refreshing its recency in the LRU order.
   * @param {string} key
   * @returns {any|null} Cached value or null if missed or expired.
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expirations += 1;
      this.stats.misses += 1;
      return null;
    }
    // Refresh LRU order: re-insert at end of Map iteration order
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.stats.hits += 1;
    return entry.value;
  }

  /**
   * Stores an item in cache, evicting the least recently used item if maxSize is exceeded.
   * @param {string} key
   * @param {any} value
   * @param {number} [customTtlMs] Optional custom TTL override.
   */
  set(key, value, customTtlMs) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions += 1;
    }
    const ttl = Number.isInteger(customTtlMs) && customTtlMs > 0 ? customTtlMs : this.ttlMs;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /**
   * Checks for valid (non-expired) key existence without modifying LRU order.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expirations += 1;
      return false;
    }
    return true;
  }

  /**
   * Deletes a specific key from the cache.
   * @param {string} key
   * @returns {boolean} True if an element in the Map existed and has been removed.
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clears all cached entries and resets statistics.
   */
  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Returns current cache diagnostics.
   * @returns {{ size: number, maxSize: number, ttlMs: number, stats: { hits: number, misses: number, evictions: number, expirations: number } }}
   */
  diagnostics() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      stats: { ...this.stats },
    };
  }
}
