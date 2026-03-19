import test from 'node:test';
import assert from 'node:assert/strict';
import { addToCache, getFromCache, hasInCache, updateCacheTTL, getCacheStats } from '../../worker/core/cache.js';

test('cache/Dual-Silo Segregation Checks', () => {
  // Push into Meta cache
  addToCache('dists/debian/InRelease', new ArrayBuffer(100), { etag: 'meta-1' }, 1000);
  assert.equal(hasInCache('dists/debian/InRelease'), true);
  
  // Push into Data cache
  addToCache('dists/debian/main/binary-amd64/Packages.gz', new ArrayBuffer(500), { etag: 'data-1' }, 1000);
  assert.equal(hasInCache('dists/debian/main/binary-amd64/Packages.gz'), true);

  const stats = getCacheStats();
  assert.equal(stats.metaItems, 1);
  assert.equal(stats.metaBytes, 100);
  assert.equal(stats.dataItems, 1);
  assert.equal(stats.dataBytes, 500);

  // Retrieve objects properly
  const metaObj = getFromCache('dists/debian/InRelease');
  assert.equal(metaObj.meta.etag, 'meta-1');
  assert.equal(metaObj.addedAt, 1000);
});

test('cache/LRU Eviction Logic Thresholds', () => {
  const initialStats = getCacheStats();
  const currentDataItems = initialStats.dataItems;
  
  // Fill data cache directly up to limit (128 slots)
  // Generating completely unique keys ensures insertions increment index tracking
  for(let i = 0; i < 129; i++) {
    addToCache(`packages/test${i}Packages.gz`, new ArrayBuffer(1024), { etag: `e${i}` }, 2000 + i);
  }
  
  // 129 items were added. Because the cache has 128 slots, evict() natively purges the oldest.
  // Final count must precisely maintain the bounded ceiling.
  const stats = getCacheStats();
  assert.equal(stats.dataItems, 128); 
  
  // Verify extreme byte limits. Pushing a massive 93MB file into data cache
  addToCache(`packages/enormousPackages.gz`, new ArrayBuffer(94 * 1024 * 1024), { etag: `boss` }, 5000);
  
  // Notice that 94MB > 92MB. The while loop actively kicks out the payload immediately.
  const afterStats = getCacheStats();
  assert.equal(afterStats.dataBytes <= (92 * 1024 * 1024), true, "Bytes strictly bound to max size");
});

test('cache/TTL Updates', () => {
  addToCache('dists/ubuntu/Release', new ArrayBuffer(10), { etag: 'refresh' }, 10);
  updateCacheTTL('dists/ubuntu/Release', 20000);
  const cached = getFromCache('dists/ubuntu/Release');
  assert.equal(cached.addedAt, 20000);
});

test('cache/Pinning Eviction Evasion', () => {
  // Add an unpinned item
  addToCache('unpinned-item', new ArrayBuffer(10), { etag: 'unpinned' }, 100, false);
  
  // Add a pinned item
  addToCache('pinned-item', new ArrayBuffer(10), { etag: 'pinned' }, 100, true);
  
  // Spam 256 generic items to completely flood the 256-slot meta cache and trigger LRU eviction
  for(let i = 0; i < 257; i++) {
    addToCache(`spam-${i}`, new ArrayBuffer(10), { etag: `s${i}` }, 200 + i);
  }
  
  // The unpinned item was the oldest and unprotected, so it must be gone.
  assert.equal(hasInCache('unpinned-item'), false, 'Unpinned item should be evicted under pressure');
  
  // The pinned item is fundamentally shielded from the LRU loop, so it must remain cached.
  assert.equal(hasInCache('pinned-item'), true, 'Pinned item MUST survive full cache displacement');
});
