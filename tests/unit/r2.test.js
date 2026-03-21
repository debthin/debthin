import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotModified } from '../../worker/core/http.js';

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

import { warmRamCacheFromRelease, _hashIndexes } from '../../worker/debthin/indexes.js';

test('r2/warmRamCacheFromRelease - hashes components mapping securely', () => {
  const mockParams = "\nSHA256:\n" +
    " ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf 1234 main/binary-amd64/Packages.gz\n" +
    " b3a12ae12d5259e24143b202aecd675a094f91ab01bc9cb308dacd74285b5755 5678 main/Contents-amd64.gz\n" +
    " c22d03bdd4c7619e1e39e73b4a7b9dfdf1cc1141ed9b10913fbcac58b3a943d0 9012 main/i18n/Translation-en.gz\n";
    
  warmRamCacheFromRelease(mockParams, "dists/debian/bookworm", true);
  
  const idx = _hashIndexes.get("debian");
  assert.equal(idx["ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf"], "main/binary-amd64/Packages.gz", "Packages.gz should be hashed");
  assert.equal(idx["b3a12ae12d5259e24143b202aecd675a094f91ab01bc9cb308dacd74285b5755"], "main/Contents-amd64.gz", "Contents-amd64.gz should be hashed directly without arbitrary package restrictions");
  assert.equal(idx["c22d03bdd4c7619e1e39e73b4a7b9dfdf1cc1141ed9b10913fbcac58b3a943d0"], "main/i18n/Translation-en.gz", "Translation-en.gz should also be hashed generically via extension");
});
