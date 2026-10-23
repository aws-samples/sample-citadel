/**
 * Shared in-memory query cache with request deduplication.
 *
 * - `cached(key, fetcher, ttlMs)` deduplicates concurrent calls to the same
 *   key and caches the resolved value for `ttlMs` (default 60 s).
 * - `invalidate(prefix)` evicts every entry whose key starts with `prefix`.
 * - `clearAll()` drops the entire cache (called on sign-out).
 */

interface CacheEntry<T = unknown> {
  /** Resolved value (set once the fetcher settles). */
  value: T;
  /** Absolute timestamp (ms) after which the entry is stale. */
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/** Settled cache: key → resolved value + expiry. */
const cache = new Map<string, CacheEntry>();

/** In-flight promises: key → pending fetch (removed once settled). */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Return a cached value if fresh, otherwise call `fetcher`, deduplicate
 * concurrent callers against the same key, and cache the result.
 */
export function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  // 1. Settled cache hit?
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T);
  }

  // 2. Already in flight? Piggy-back on the same promise.
  const pending = inflight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }

  // 3. Start a new fetch, share the promise with concurrent callers.
  const promise = fetcher().then(
    (value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      inflight.delete(key);
      return value;
    },
    (err) => {
      inflight.delete(key);
      throw err;
    },
  );

  inflight.set(key, promise);
  return promise;
}

/** Evict every cache entry (and cancel dedup) whose key starts with `prefix`. */
export function invalidate(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      inflight.delete(key);
    }
  }
}

/** Drop the entire cache and all in-flight dedup entries. */
export function clearAll(): void {
  cache.clear();
  inflight.clear();
}
