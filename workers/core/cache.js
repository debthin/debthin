/**
 * @fileoverview TypedArray LRU isolate cache.
 * Provides contiguous high-performance RAM boundaries minimizing V8 garbage collection overheads natively.
 * 
 * Exports:
 * - LRUCache: Mathematical struct abstraction operating flat Arrays for maximum eviction speed.
 */



/**
 * Why a Uint32Array (Clock-based arrays) instead of a Doubly-Linked List?
 * In a traditional LRU, doubly-linked lists require allocating new wrapper objects
 * for every node, triggering V8 heap fragmentation and GC pauses.
 * At cache limits of 128~256 items, iterating over a contiguous flat Uint32Array 
 * fits entirely inside the CPU L1 cache. It provides exponentially faster real-world
 * performance by completely bypassing memory indirection and object instantiation, 
 * despite being O(N) theoretically rather than O(1).
 * Constructs a slot-based LRU cache backed by TypedArrays.
 *
 * @param {number} maxSlots - Maximum number of cache entries.
 * @param {number} maxSize - Maximum total byte capacity.
 * @param {number} [ttlMs=3600000] - Time-to-live per entry in milliseconds.
 * @returns {LocalCache} The cache instance.
 */
export function LRUCache(maxSlots, maxSize, ttlMs = 3600000) {
  const index = new Map();
  let bufArray = new Array(maxSlots).fill(null);
  let metaArray = new Array(maxSlots).fill(null);
  let keyArray = new Array(maxSlots).fill(null);
  let hitsArray = new Int32Array(maxSlots);
  let usedArray = new Uint32Array(maxSlots);
  let bytesArray = new Int32Array(maxSlots);
  let addedArray = new Float64Array(maxSlots);
  let pinnedArray = new Uint8Array(maxSlots);

  let clock = 0;
  let size = 0;
  let freeSlot = 0;

  function evict() {
    let lru = -1, lruTime = Infinity;
    for (let i = 0; i < maxSlots; i++) {
      if (keyArray[i] !== null && pinnedArray[i] === 0) {
        if (usedArray[i] < lruTime) {
          lruTime = usedArray[i]; lru = i;
        } else if (usedArray[i] === lruTime && lru !== -1 && hitsArray[i] < hitsArray[lru]) {
          lru = i;
        }
      }
    }
    if (lru === -1) return -1;
    index.delete(keyArray[lru]);
    size -= bytesArray[lru];
    bufArray[lru] = null;
    metaArray[lru] = null;
    keyArray[lru] = null;
    hitsArray[lru] = 0;
    usedArray[lru] = 0;
    bytesArray[lru] = 0;
    addedArray[lru] = 0;
    pinnedArray[lru] = 0;
    return lru;
  }

  return {
    ttl: ttlMs,
    pending: new Map(),
    add: (key, buf, meta, now, pinned = false) => {
      let slot = index.get(key);
      if (slot !== undefined) {
        size -= bytesArray[slot];
      } else {
        if (freeSlot < maxSlots) {
          slot = freeSlot++;
        } else {
          slot = -1;
          for (let i = 0; i < maxSlots; i++) {
            if (keyArray[i] === null) { slot = i; break; }
          }
          if (slot === -1) slot = evict();
          if (slot === -1) return; // Cache is completely full of pinned items, abort gracefully
        }
        index.set(key, slot);
        keyArray[slot] = key;
        hitsArray[slot] = 0;
        usedArray[slot] = clock = (clock + 1) >>> 0;
        if (clock === 0) usedArray.fill(0);
      }
      bufArray[slot] = buf;
      metaArray[slot] = meta;
      bytesArray[slot] = buf.byteLength;
      addedArray[slot] = now;
      pinnedArray[slot] = pinned ? 1 : 0;
      size += buf.byteLength;

      while (size > maxSize && index.size > 0) evict();
    },
    get: (key) => {
      const slot = index.get(key);
      if (slot === undefined) return null;
      hitsArray[slot]++;
      usedArray[slot] = clock = (clock + 1) >>> 0;
      if (clock === 0) usedArray.fill(0);
      return { buf: bufArray[slot], meta: metaArray[slot], hits: hitsArray[slot], addedAt: addedArray[slot] };
    },
    has: (key) => index.has(key),
    updateTTL: (key, now) => {
      const slot = index.get(key);
      if (slot !== undefined) addedArray[slot] = now;
    },
    purge: (key) => {
      if (key !== undefined) {
        const slot = index.get(key);
        if (slot !== undefined) {
          index.delete(key);
          size -= bytesArray[slot];
          bufArray[slot] = null;
          metaArray[slot] = null;
          keyArray[slot] = null;
          hitsArray[slot] = 0;
          usedArray[slot] = 0;
          bytesArray[slot] = 0;
          addedArray[slot] = 0;
          pinnedArray[slot] = 0;
        }
      } else {
        index.clear();
        bufArray = new Array(maxSlots).fill(null);
        metaArray = new Array(maxSlots).fill(null);
        keyArray = new Array(maxSlots).fill(null);
        hitsArray = new Int32Array(maxSlots);
        usedArray = new Uint32Array(maxSlots);
        bytesArray = new Int32Array(maxSlots);
        addedArray = new Float64Array(maxSlots);
        pinnedArray = new Uint8Array(maxSlots);
        size = 0;
        freeSlot = 0;
        clock = 0;
        // Do not clear the pending map during purge, to prevent crashing concurrent flights.
      }
    },
    getStats: () => ({ items: index.size, bytes: size, limit: maxSize })
  };
}

