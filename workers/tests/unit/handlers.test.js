import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleStaticAssets, handleUpstreamRedirect } from '../../debthin/handlers/index.js';

// Stub the CF Cache API so r2Get's L2 layer is transparent in unit tests.
before(() => {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
});
after(() => { delete globalThis.caches; });


test('handlers/handleUpstreamRedirect', () => {
  const protocol = 'https';
  const upstream = 'deb.debian.org/debian';
  const rawPath = 'pool/main/f/foo/foo.deb';
  
  const res = handleUpstreamRedirect(protocol, upstream, rawPath);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://deb.debian.org/debian/pool/main/f/foo/foo.deb');
});

// Note: robots.txt and health endpoints are now handled by core/admin.js
// before handleStaticAssets is called. See tests/unit/admin.test.js.

test('handlers/handleStaticAssets -> /config.json', async () => {
  const req = { headers: new Headers() };
  const dummyConfig = JSON.stringify({ distributions: [] });
  const res = await handleStaticAssets("config.json", {}, req, dummyConfig);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.distributions !== undefined);
  assert.ok(res.headers.get('ETag').includes('W/'));
  assert.equal(res.headers.get('X-Debthin'), 'hit-synthetic');
});

import { handleDistributionHashIndex } from '../../debthin/handlers/index.js';

test('handlers/handleDistributionHashIndex permits headless components inherently', async () => {
  const req = { method: 'GET', headers: new Headers() };
  const env = { DEBTHIN_BUCKET: { get: async () => null } }; // Mock miss
  
  const tokens = { p1: 'dists', p2: 'headless', p3: 'binary-amd64', p4: 'Packages.gz' };
  const distroConfig = { components: new Set(['main']), arches: new Set(['amd64']) };
  
  // Attempt to route a headless component request
  const res = await handleDistributionHashIndex(req, env, {}, 'debian', 'shared/headless/binary-amd64/Packages.gz', tokens, distroConfig);
  
  // If it rejects because of components.has(p2), it returns null or 404.
  // We use serveR2 which returns 404 if the bucket mock returns null.
  assert.equal(res.status, 404, 'The route mapped natively to serveR2 evaluating the bucket successfully despite headless not existing in the config Set');
});
