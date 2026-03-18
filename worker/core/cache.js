/**
 * @fileoverview TypedArray LRU isolate cache.
 * Uses index-mapped arrays rather than object properties to bypass V8 garbage collection delays during heavy traffic spikes.
 */

const MAX_CACHE_SLOTS = 256;
const MAX_CACHE_SIZE = 96 * 1024 * 1024;

/**
 * Cache staleness constraint evaluated dynamically inline.
 * @type {number}
 */
export const INDEX_TTL = 3600000;

/**
 * Timestamp synced to the initial payload arrival for O(1) clock comparisons without generating Date objects.
 * @type {number}
 */
export let _now = 0;

/**
 * Asserts the absolute runtime clock directly inside the environment on each request cycle.
 * @param {number} n - Unified Unix sequence boundary.
 */
export function setNow(n) { _now = n; }

const _cacheIndex = new Map();
const _cacheBuf = new Array(MAX_CACHE_SLOTS).fill(null);
const _cacheMeta = new Array(MAX_CACHE_SLOTS).fill(null);
const _cacheKey = new Array(MAX_CACHE_SLOTS).fill(null);
const _cacheHits = new Int32Array(MAX_CACHE_SLOTS);
const _cacheLastUsed = new Uint32Array(MAX_CACHE_SLOTS);
const _cacheBytes = new Int32Array(MAX_CACHE_SLOTS);
const _cacheAddedAt = new Float64Array(MAX_CACHE_SLOTS);

let _cacheClock = 0;
let _cacheSize = 0;
let _cacheFreeSlot = 0;

function _evictLRU() {
  let lruSlot = 0, lruTime = _cacheLastUsed[0];
  for (let i = 1; i < MAX_CACHE_SLOTS; i++) {
    if (_cacheLastUsed[i] < lruTime) { lruTime = _cacheLastUsed[i]; lruSlot = i; }
  }
  _cacheIndex.delete(_cacheKey[lruSlot]);
  _cacheSize -= _cacheBytes[lruSlot];
  _cacheBuf[lruSlot] = null;
  _cacheMeta[lruSlot] = null;
  _cacheKey[lruSlot] = null;
  _cacheHits[lruSlot] = 0;
  _cacheLastUsed[lruSlot] = 0;
  _cacheBytes[lruSlot] = 0;
  _cacheAddedAt[lruSlot] = 0;
  return lruSlot;
}

/**
 * Inserts binary buffers and their associated metadata into the statically allocated TypedArrays.
 * When limits are reached, it triggers _evictLRU to locate and purge the oldest accessed index before writing.
 *
 * @param {string} key - R2 path or synthetic identifier.
 * @param {ArrayBuffer|Uint8Array} buf - File content binary payload.
 * @param {Object} meta - Edge cache metadata dictionary.
 */
export function addToCache(key, buf, meta) {
  let slot = _cacheIndex.get(key);
  if (slot !== undefined) {
    _cacheSize -= _cacheBytes[slot];
  } else {
    if (_cacheFreeSlot < MAX_CACHE_SLOTS) {
      slot = _cacheFreeSlot++;
    } else {
      slot = _evictLRU();
    }
    _cacheIndex.set(key, slot);
    _cacheKey[slot] = key;
    _cacheHits[slot] = 0;
    _cacheLastUsed[slot] = _cacheClock = (_cacheClock + 1) >>> 0;
  }
  _cacheBuf[slot] = buf;
  _cacheMeta[slot] = meta;
  _cacheBytes[slot] = buf.byteLength;
  _cacheAddedAt[slot] = _now;
  _cacheSize += buf.byteLength;

  while (_cacheSize > MAX_CACHE_SIZE && _cacheIndex.size > 0) _evictLRU();
}

/**
 * Locates matched buffers by translating the string key to its array index mapping.
 * Bumps the LRU clock properties for the requested slot to delay future eviction.
 *
 * @param {string} key - Lookup identifier.
 * @returns {Object|null} Struct containing the physical buffer and HTTP metadata.
 */
export function getFromCache(key) {
  const slot = _cacheIndex.get(key);
  if (slot === undefined) return null;
  _cacheHits[slot]++;
  _cacheLastUsed[slot] = _cacheClock = (_cacheClock + 1) >>> 0;
  return { buf: _cacheBuf[slot], meta: _cacheMeta[slot], hits: _cacheHits[slot], addedAt: _cacheAddedAt[slot] };
}

/**
 * Refreshes the insertion timestamp for a specific cache parameter explicitly pushing its TTL validation window out.
 *
 * @param {string} key - The tracked lookup parameter.
 */
export function updateCacheTTL(key) {
  const slot = _cacheIndex.get(key);
  if (slot !== undefined) {
    _cacheAddedAt[slot] = _now;
  }
}

/**
 * Used for existence checks bypassing complete buffer variable instantiations.
 *
 * @param {string} key - Map lookup target parameter.
 * @returns {boolean} Presence within the existing map keys.
 */
export function hasInCache(key) {
  return _cacheIndex.has(key);
}

/**
 * Returns cache utilization metrics for health checks.
 *
 * @returns {Object} JSON format cache limits.
 */
export function getCacheStats() {
  return { items: _cacheIndex.size, bytes: _cacheSize };
}
