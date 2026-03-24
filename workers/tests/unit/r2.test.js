import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotModified } from '../../core/http.js';

test('r2/isNotModified Strict ETags', () => {
  const reqObj = { etag: '"abcdef"' };
  
  const headersHit = new Headers({ 'if-none-match': '"abcdef"' });
  assert.equal(isNotModified(headersHit, reqObj), true, 'Exact match');
  
  const headersMiss = new Headers({ 'if-none-match': '"123456"' });
  assert.equal(isNotModified(headersMiss, reqObj), false, 'Mismatch');
});

test('r2/isNotModified Weak ETag Parsing', () => {
  const reqObj = { etag: '"abcd"' };
  
  const headersWeak = new Headers({ 'if-none-match': 'W/"abcd"' });
  assert.equal(isNotModified(headersWeak, reqObj), true, 'Strips Weak Prefix natively');
});

test('r2/isNotModified Last-Modified bounds', () => {
  const t = Math.floor(Date.now() / 1000) * 1000;
  const reqObj = { lastModified: t };
  
  const headersHit = new Headers({ 'if-modified-since': new Date(t).toUTCString() });
  assert.equal(isNotModified(headersHit, reqObj), true, 'Exact timestamp match');
  
  const headersMiss = new Headers({ 'if-modified-since': new Date(t - 100000).toUTCString() });
  assert.equal(isNotModified(headersMiss, reqObj), false, 'Client cache strictly older than file');
});

import { warmRamCacheFromRelease, _hashIndexes } from '../../debthin/indexes.js';

test('r2/warmRamCacheFromRelease - hashes only Packages.gz', () => {
  const mockParams = "\nSHA256:\n" +
    " ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf 1234 main/binary-amd64/Packages.gz\n" +
    " b3a12ae12d5259e24143b202aecd675a094f91ab01bc9cb308dacd74285b5755 5678 main/Contents-amd64.gz\n" +
    " c22d03bdd4c7619e1e39e73b4a7b9dfdf1cc1141ed9b10913fbcac58b3a943d0 9012 main/i18n/Translation-en.gz\n";
    
  warmRamCacheFromRelease(mockParams, "dists/debian/bookworm", true);
  
  const idx = _hashIndexes.get("debian");
  assert.ok(idx["ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf"], "Packages.gz should be hashed");
  assert.equal(idx["b3a12ae12d5259e24143b202aecd675a094f91ab01bc9cb308dacd74285b5755"], undefined, "Contents-amd64.gz should NOT be hashed");
  assert.equal(idx["c22d03bdd4c7619e1e39e73b4a7b9dfdf1cc1141ed9b10913fbcac58b3a943d0"], undefined, "Translation-en.gz should NOT be hashed");
});

// ── L2 Colo Cache Tests ──────────────────────────────────────────────────────

import { r2Get } from '../../core/r2.js';
import { LRUCache } from '../../core/cache.js';

/**
 * Creates a minimal mock of the CF `caches.default` API.
 * Tracks match/put calls for assertion purposes.
 *
 * @param {Response|undefined} matchResult - The response to return from match(), or undefined for a miss.
 * @returns {{ mock: Object, calls: { match: string[], put: Array } }}
 */
function makeCachesMock(matchResult) {
  const calls = { match: [], put: [] };
  globalThis.caches = {
    default: {
      match: async (url) => { calls.match.push(url); return matchResult; },
      put: async (url, resp) => { calls.put.push({ url, resp }); }
    }
  };
  return { mock: globalThis.caches, calls };
}

test('r2Get/L2 hit returns payload without calling R2', async () => {
  const payload = new TextEncoder().encode("package-data");
  const l2Resp = new Response(payload, {
    headers: { "ETag": '"abc123"', "Last-Modified": new Date(1700000000000).toUTCString() }
  });
  const { calls } = makeCachesMock(l2Resp);

  let r2Called = false;
  const env = { DEBTHIN_BUCKET: { get: async () => { r2Called = true; return null; } } };
  const cache = LRUCache(16, 1024 * 1024, 60000);

  const result = await r2Get(env, "dists/debian/bookworm/InRelease", cache, null, {});

  assert.equal(r2Called, false, "R2 bucket must not be called on L2 hit");
  assert.equal(result.isCached, true);
  assert.equal(result.etag, '"abc123"');
  const buf = await result.arrayBuffer();
  assert.equal(new TextDecoder().decode(buf), "package-data");
  assert.equal(calls.match.length, 1, "L2 match should be called once");

  delete globalThis.caches;
});

test('r2Get/L2 miss falls through to R2 and populates L2', async () => {
  const { calls } = makeCachesMock(undefined); // L2 miss

  const payload = new TextEncoder().encode("from-r2");
  const env = {
    DEBTHIN_BUCKET: {
      get: async () => ({
        body: new Blob([payload]).stream(),
        httpMetadata: { contentType: "application/octet-stream" },
        etag: '"r2etag"',
        uploaded: new Date(1700000000000),
        size: payload.byteLength,
        arrayBuffer: async () => payload.buffer
      })
    }
  };
  const cache = LRUCache(16, 1024 * 1024, 60000);
  const waitUntilPromises = [];
  const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

  const result = await r2Get(env, "test/file.gz", cache, ctx, {});

  assert.equal(result.isCached, false, "R2 fetch is a cold hit");
  assert.equal(result.etag, '"r2etag"');
  assert.equal(calls.match.length, 1, "L2 match should be called once");

  // Flush background jobs so L2 put fires
  await Promise.all(waitUntilPromises);
  assert.equal(calls.put.length, 1, "L2 put should populate the colo cache");
  assert.ok(calls.put[0].url.includes("test/file.gz"), "L2 put URL should contain the key");

  delete globalThis.caches;
});

test('r2Get/L2 hit does not fire onDiskMiss', async () => {
  const l2Resp = new Response(new ArrayBuffer(8), {
    headers: { "ETag": '"tag"' }
  });
  makeCachesMock(l2Resp);

  const env = { DEBTHIN_BUCKET: { get: async () => null } };
  const cache = LRUCache(16, 1024 * 1024, 60000);
  let diskMissCalled = false;

  await r2Get(env, "any/key", cache, null, { onDiskMiss: () => { diskMissCalled = true; } });

  assert.equal(diskMissCalled, false, "onDiskMiss must not fire on L2 cache hit");

  delete globalThis.caches;
});

