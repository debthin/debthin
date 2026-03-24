import test from 'node:test';
import assert from 'node:assert/strict';
import { metaCache, dataCache, getCacheStats, purgeAllCaches } from '../../debthin/cache.js';

function selectCache(key) {
  return (key.endsWith(".gz") || key.endsWith(".xz") || key.endsWith(".lz4")) ? dataCache : metaCache;
}

function add(key, buf, meta, now, pinned) { selectCache(key).add(key, buf, meta, now, pinned); }
function get(key) { return selectCache(key).get(key); }
function has(key) { return selectCache(key).has(key); }
function upd(key, now) { selectCache(key).updateTTL(key, now); }
test('cache/Dual-Silo Segregation Checks', () => {
  // Push into Meta cache
  add('dists/debian/InRelease', new ArrayBuffer(100), { etag: 'meta-1' }, 1000);
  assert.equal(has('dists/debian/InRelease'), true);
  
  // Push into Data cache
  add('dists/debian/main/binary-amd64/Packages.gz', new ArrayBuffer(500), { etag: 'data-1' }, 1000);
  assert.equal(has('dists/debian/main/binary-amd64/Packages.gz'), true);

  const stats = getCacheStats();
  assert.equal(stats.metaItems, 1);
  assert.equal(stats.metaBytes, 100);
  assert.equal(stats.dataItems, 1);
  assert.equal(stats.dataBytes, 500);

  // Retrieve objects properly
  const metaObj = get('dists/debian/InRelease');
  assert.equal(metaObj.meta.etag, 'meta-1');
  assert.equal(metaObj.addedAt, 1000);
});

test('cache/LRU Eviction Logic Thresholds', () => {
  const initialStats = getCacheStats();
  const currentDataItems = initialStats.dataItems;
  
  // Fill data cache directly up to limit (128 slots)
  // Generating completely unique keys ensures insertions increment index tracking
  for(let i = 0; i < 129; i++) {
    add(`packages/test${i}Packages.gz`, new ArrayBuffer(1024), { etag: `e${i}` }, 2000 + i);
  }
  
  // 129 items were added. Because the cache has 128 slots, evict() natively purges the oldest.
  // Final count must precisely maintain the bounded ceiling.
  const stats = getCacheStats();
  assert.equal(stats.dataItems, 128); 
  
  // Verify extreme byte limits. Pushing a massive 93MB file into data cache
  add(`packages/enormousPackages.gz`, new ArrayBuffer(94 * 1024 * 1024), { etag: `boss` }, 5000);
  
  // Notice that 94MB > 92MB. The while loop actively kicks out the payload immediately.
  const afterStats = getCacheStats();
  assert.equal(afterStats.dataBytes <= (92 * 1024 * 1024), true, "Bytes strictly bound to max size");
});

test('cache/TTL Updates', () => {
  add('dists/ubuntu/Release', new ArrayBuffer(10), { etag: 'refresh' }, 10);
  upd('dists/ubuntu/Release', 20000);
  const cached = get('dists/ubuntu/Release');
  assert.equal(cached.addedAt, 20000);
});

test('cache/Pinning Eviction Evasion', () => {
  // Add an unpinned item
  add('unpinned-item', new ArrayBuffer(10), { etag: 'unpinned' }, 100, false);
  
  // Add a pinned item
  add('pinned-item', new ArrayBuffer(10), { etag: 'pinned' }, 100, true);
  
  // Spam 256 generic items to completely flood the 256-slot meta cache and trigger LRU eviction
  for(let i = 0; i < 257; i++) {
    add(`spam-${i}`, new ArrayBuffer(10), { etag: `s${i}` }, 200 + i);
  }
  
  // The unpinned item was the oldest and unprotected, so it must be gone.
  assert.equal(has('unpinned-item'), false, 'Unpinned item should be evicted under pressure');
  
  // The pinned item is fundamentally shielded from the LRU loop, so it must remain cached.
  assert.equal(has('pinned-item'), true, 'Pinned item MUST survive full cache displacement');
});

test('cache/Manual Key Purging & Reclaiming', () => {
  add('delete-me', new ArrayBuffer(50), { etag: 'x' }, 10, false);
  assert.equal(has('delete-me'), true);
  
  const beforeStats = getCacheStats();
  // Manually purge target
  selectCache('delete-me').purge('delete-me');
  
  assert.equal(has('delete-me'), false, 'Key must be deleted natively');
  
  const afterStats = getCacheStats();
  assert.equal(afterStats.metaItems, beforeStats.metaItems - 1, 'Length accurately recrements');
  assert.equal(afterStats.metaBytes, beforeStats.metaBytes - 50, 'Bytes gracefully yielded back');
  
  // Re-inserting cleanly reuses the hole instead of appending blindly
  add('reclaimed', new ArrayBuffer(10), { etag: 'y' }, 20, false);
  assert.equal(has('reclaimed'), true);
});

test('cache/Global Cache Flush Reinstantiation', () => {
  add('mass-1', new ArrayBuffer(1), { etag: 'a' }, 1);
  add('mass-2', new ArrayBuffer(1), { etag: 'b' }, 1);
  assert.equal(getCacheStats().metaItems > 0, true);
  
  // Cleanly orphan the underlying structural boundaries into native V8 memory
  purgeAllCaches();
  
  const finalStats = getCacheStats();
  assert.equal(finalStats.metaItems, 0, 'Everything is structurally orphaned natively');
  assert.equal(finalStats.metaBytes, 0, 'Bytes clearly resetted to bounds');
});
