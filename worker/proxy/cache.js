/**
 * @fileoverview Proxy-specific multi-layer caching orchestrator.
 * Connects the generic LRU primitive into exact workload layouts for proxy metadata vs packages.
 */

import { LRUCache } from '../core/cache.js';
import { CACHE_TTL_MS } from '../core/constants.js';

export const proxyMetaCache = LRUCache(256, 4 * 1024 * 1024, CACHE_TTL_MS);
export const proxyDataCache = LRUCache(128, 92 * 1024 * 1024, CACHE_TTL_MS);

/**
 * Discards all currently active caches allocating pristine LRUCache targets.
 * Lets V8 garbage collection efficiently clean up the old TypedArrays safely.
 */
export function purgeProxyCaches() {
  proxyMetaCache.purge();
  proxyDataCache.purge();
}

/**
 * Returns aggregated memory cache statistics natively.
 * @returns {Object} Meta and Data object usage stats natively.
 */
export function getProxyCacheStats() {
  const m = proxyMetaCache.getStats();
  const d = proxyDataCache.getStats();
  return { 
    metaItems: m.items, metaBytes: m.bytes,
    dataItems: d.items, dataBytes: d.bytes 
  };
}
