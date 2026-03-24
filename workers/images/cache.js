/**
 * @fileoverview Cache instance for the image distribution worker.
 * Wraps the core LRU cache with image-specific size limits.
 */

import { LRUCache } from '../core/cache.js';
import { CACHE_TTL_MS } from '../core/constants.js';

// Index manifests can be large; allow up to 20MB total with 256 slots.
export const indexCache = LRUCache(256, 20 * 1024 * 1024, CACHE_TTL_MS);

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
