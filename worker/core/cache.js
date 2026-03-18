/**
 * @fileoverview TypedArray LRU isolate cache.
 * Splits allocations distinctly into Meta (thousands of tiny index files) and Data (chunky Packages.gz binaries).
 */

export const INDEX_TTL = 3600000;

function createCache(maxSlots, maxSize) {
  const index = new Map();
  const bufArray = new Array(maxSlots).fill(null);
  const metaArray = new Array(maxSlots).fill(null);
  const keyArray = new Array(maxSlots).fill(null);
  const hitsArray = new Int32Array(maxSlots);
  const usedArray = new Uint32Array(maxSlots);
  const bytesArray = new Int32Array(maxSlots);
  const addedArray = new Float64Array(maxSlots);

  let clock = 0;
  let size = 0;
  let freeSlot = 0;

  function evict() {
    let lru = 0, lruTime = usedArray[0];
    for (let i = 1; i < maxSlots; i++) {
      if (usedArray[i] < lruTime) { lruTime = usedArray[i]; lru = i; }
    }
    index.delete(keyArray[lru]);
    size -= bytesArray[lru];
    bufArray[lru] = null;
    metaArray[lru] = null;
    keyArray[lru] = null;
    hitsArray[lru] = 0;
    usedArray[lru] = 0;
    bytesArray[lru] = 0;
    addedArray[lru] = 0;
    return lru;
  }

  return {
    add: (key, buf, meta, now) => {
      let slot = index.get(key);
      if (slot !== undefined) {
        size -= bytesArray[slot];
      } else {
        if (freeSlot < maxSlots) {
          slot = freeSlot++;
        } else {
          slot = evict();
        }
        index.set(key, slot);
        keyArray[slot] = key;
        hitsArray[slot] = 0;
        usedArray[slot] = clock = (clock + 1) >>> 0;
      }
      bufArray[slot] = buf;
      metaArray[slot] = meta;
      bytesArray[slot] = buf.byteLength;
      addedArray[slot] = now;
      size += buf.byteLength;

      while (size > maxSize && index.size > 0) evict();
    },
    get: (key) => {
      const slot = index.get(key);
      if (slot === undefined) return null;
      hitsArray[slot]++;
      usedArray[slot] = clock = (clock + 1) >>> 0;
      return { buf: bufArray[slot], meta: metaArray[slot], hits: hitsArray[slot], addedAt: addedArray[slot] };
    },
    has: (key) => index.has(key),
    updateTTL: (key, now) => {
      const slot = index.get(key);
      if (slot !== undefined) addedArray[slot] = now;
    },
    getStats: () => ({ items: index.size, bytes: size, limit: maxSize })
  };
}

const metaCache = createCache(256, 4 * 1024 * 1024);
const dataCache = createCache(128, 92 * 1024 * 1024);

function selectCache(key) {
  return key.includes('Packages') ? dataCache : metaCache;
}

export function addToCache(key, buf, meta, now) {
  selectCache(key).add(key, buf, meta, now);
}

export function getFromCache(key) {
  return selectCache(key).get(key);
}

export function updateCacheTTL(key, now) {
  selectCache(key).updateTTL(key, now);
}

export function hasInCache(key) {
  return selectCache(key).has(key);
}

export function getCacheStats() {
  const m = metaCache.getStats();
  const d = dataCache.getStats();
  return { 
    metaItems: m.items, metaBytes: m.bytes,
    dataItems: d.items, dataBytes: d.bytes 
  };
}
