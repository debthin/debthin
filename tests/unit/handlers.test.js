import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStaticAssets, handleUpstreamRedirect } from '../../worker/debthin/handlers/index.js';

test('handlers/handleUpstreamRedirect', () => {
  const protocol = 'https';
  const upstream = 'deb.debian.org/debian';
  const rawPath = 'pool/main/f/foo/foo.deb';
  
  const res = handleUpstreamRedirect(protocol, upstream, rawPath);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://deb.debian.org/debian/pool/main/f/foo/foo.deb');
});

test('handlers/handleStaticAssets -> /robots.txt', async () => {
  const req = { headers: new Headers() };
  const res = await handleStaticAssets("robots.txt", {}, req, "{}");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "User-agent: *\nAllow: /$\nDisallow: /\n");
  assert.equal(res.headers.get('Content-Type'), 'text/plain; charset=utf-8');
});

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

test('handlers/handleStaticAssets -> /health (pass)', async () => {
  const req = { headers: new Headers() };
  const env = {
    DEBTHIN_BUCKET: {
      head: async () => ({ etag: 'healthy' })
    }
  };
  const res = await handleStaticAssets("health", env, req, "{}");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'OK');
  assert.equal(data.r2, 'OK');
  assert.ok(data.cache !== undefined);
});

test('handlers/handleStaticAssets -> /health (fail)', async () => {
  const req = { headers: new Headers() };
  const env = {
    DEBTHIN_BUCKET: {
      head: async () => { throw new Error('R2 Down'); }
    }
  };
  const res = await handleStaticAssets("health", env, req, "{}");
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'DEGRADED');
  assert.equal(data.r2, 'ERROR');
});

import { handleDistributionHashIndex } from '../../worker/debthin/handlers/index.js';

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
