/**
 * @fileoverview Debthin-specific multi-layer caching orchestrator.
 * Connects the generic LRU primitive into exact workload layouts for debian metadata vs packages.
 */

import { LRUCache } from '../core/cache.js';
import { CACHE_TTL_MS } from '../core/constants.js';

export const metaCache = LRUCache(256, 4 * 1024 * 1024, CACHE_TTL_MS);
export const dataCache = LRUCache(128, 92 * 1024 * 1024, CACHE_TTL_MS);

/**
 * Discards all currently active caches allocating pristine LRUCache targets.
 * Lets V8 garbage collection efficiently clean up the old TypedArrays safely.
 */
export function purgeAllCaches() {
  metaCache.purge();
  dataCache.purge();
}


/**
 * Returns aggregated memory cache statistics.
 * @returns {Object} Meta and Data object usage stats.
 */
export function getCacheStats() {
  const m = metaCache.getStats();
  const d = dataCache.getStats();
  return { 
    metaItems: m.items, metaBytes: m.bytes,
    dataItems: d.items, dataBytes: d.bytes 
  };
}
