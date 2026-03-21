/**
 * @fileoverview Caching orchestrator for the image distribution worker.
 * Connects the generic core LRU primitive to cache dynamically generated JSON/CSV indexes.
 */

import { LRUCache } from '../core/cache.js';
import { CACHE_TTL_MS } from '../core/constants.js';

// Index manifests can be natively large, so we assign a 20MB ArrayBuffer isolate limit.
export const indexCache = LRUCache(16, 20 * 1024 * 1024, CACHE_TTL_MS);

/**
 * Returns aggregated memory cache statistics.
 * @returns {Object} Index object usage stats.
 */
export function getCacheStats() {
    const s = indexCache.getStats();
    return {
        indexItems: s.items,
        indexBytes: s.bytes
    };
}
