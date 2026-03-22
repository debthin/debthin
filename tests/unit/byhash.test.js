import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { warmRamCacheFromRelease, _hashIndexes } from '../../worker/debthin/indexes.js';
import { handleByHash } from '../../worker/debthin/handlers/index.js';
import { EMPTY_GZ_HASH } from '../../worker/core/constants.js';

// Stub the CF Cache API so r2Get's L2 layer is transparent in unit tests.
before(() => {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
});
after(() => { delete globalThis.caches; });


// Read the mock file
const mockInRelease = readFileSync(join(import.meta.dirname, 'mock_InRelease'), 'utf8');

test('r2/warmRamCacheFromRelease evaluates SHA256 indices', () => {
  // Clear any existing index to maintain test isolation
  _hashIndexes.delete('debian');
  
  warmRamCacheFromRelease(mockInRelease, 'dists/debian/bookworm', false);
  
  const distroIndex = _hashIndexes.get('debian');
  assert.ok(distroIndex !== undefined, 'Distro index should be created');
  assert.equal(distroIndex['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'], 'bookworm/main/binary-amd64/Packages.gz');
  assert.equal(distroIndex['761aa55eb09fedd08dd85ba46a7ece43e59503464522971239aaed2d03cc094e'], 'bookworm/contrib/binary-amd64/Packages.gz');
  
  // It shouldn't map non .gz files according to limits logic
  assert.equal(distroIndex['46d6b633fb01bc43fb2764f691605dcabdeecacae21f37eaf9be3babb43202e1'], undefined);
});

test('handlers/handleByHash routes empty magic hashes securely', async () => {
  const req = { method: 'GET', headers: new Headers() };
  const res = await handleByHash(req, {}, {}, 'debian', EMPTY_GZ_HASH);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/x-gzip');
});

test('handlers/handleByHash routes valid indexes dynamically', async () => {
  warmRamCacheFromRelease(mockInRelease, 'dists/debian/bookworm', false);
  
  const req = { method: 'GET', headers: new Headers() };
  const env = {
    DEBTHIN_BUCKET: {
      get: async (key) => {
        if (key === 'dists/debian/bookworm/contrib/binary-amd64/Packages.gz') {
           return {
             body: new ArrayBuffer(5),
             arrayBuffer: async () => new ArrayBuffer(5),
             text: async () => 'hello',
             size: 5,
             etag: '"cache123"',
             lastModified: new Date(),
             httpMetadata: {}
           }
        }
        return null;
      }
    }
  };
  
  const targetHash = '761aa55eb09fedd08dd85ba46a7ece43e59503464522971239aaed2d03cc094e';
  const res = await handleByHash(req, env, {}, 'debian', targetHash);
  
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Debthin'), 'hit');
});

test('handlers/handleByHash bounces unmapped or invalid hashes', async () => {
  const req = { method: 'GET', headers: new Headers() };
  const resInvalid = await handleByHash(req, {}, {}, 'debian', 'zz1aa55eb09fedd08dd85ba46a7ece43e59503464522971239aaed2d03cc094e');
  assert.equal(resInvalid, null, 'Invalid hex falls through router completely');
  
  const validHexUnmapped = '0000a55eb09fedd08dd85ba46a7ece43e59503464522971239aaed2d03cc094e';
  const resUnmapped = await handleByHash(req, {}, {}, 'debian', validHexUnmapped);
  assert.equal(resUnmapped.status, 404, 'Valid hex not located in RAM yields explicit 404 error');
});
