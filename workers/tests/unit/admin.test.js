import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, routeAdminPath, wrapHandler } from '../../core/admin.js';

// ── validateRequest ──────────────────────────────────────────────────────────

test('validateRequest allows GET', () => {
  const req = { method: 'GET', url: 'https://example.com/foo' };
  assert.equal(validateRequest(req, 'foo'), null);
});

test('validateRequest allows HEAD', () => {
  const req = { method: 'HEAD', url: 'https://example.com/foo' };
  assert.equal(validateRequest(req, 'foo'), null);
});

test('validateRequest rejects POST', () => {
  const req = { method: 'POST', url: 'https://example.com/foo' };
  const res = validateRequest(req, 'foo');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET, HEAD');
});

test('validateRequest accepts custom methods', () => {
  const req = { method: 'POST', url: 'https://example.com/foo' };
  assert.equal(validateRequest(req, 'foo', ['GET', 'HEAD', 'POST']), null);
});

test('validateRequest rejects query strings', () => {
  const req = { method: 'GET', url: 'https://example.com/foo?bar=1' };
  const res = validateRequest(req, 'foo');
  assert.equal(res.status, 400);
});

test('validateRequest rejects traversal', () => {
  const req = { method: 'GET', url: 'https://example.com/../etc/passwd' };
  const res = validateRequest(req, '../etc/passwd');
  assert.equal(res.status, 400);
});

test('validateRequest rejects .git', () => {
  const req = { method: 'GET', url: 'https://example.com/.git/config' };
  const res = validateRequest(req, '.git/config');
  assert.equal(res.status, 404);
});

test('validateRequest rejects .env', () => {
  const req = { method: 'GET', url: 'https://example.com/.env' };
  const res = validateRequest(req, '.env');
  assert.equal(res.status, 404);
});

test('validateRequest rejects ecp/', () => {
  const req = { method: 'GET', url: 'https://example.com/ecp/default.flt' };
  const res = validateRequest(req, 'ecp/default.flt');
  assert.equal(res.status, 404);
});

test('validateRequest rejects xmlrpc', () => {
  const req = { method: 'GET', url: 'https://example.com/xmlrpc.php' };
  const res = validateRequest(req, 'xmlrpc.php');
  assert.equal(res.status, 404);
});

test('validateRequest rejects wp-includes in second path segment', () => {
  const req = { method: 'GET', url: 'https://example.com/blog/wp-includes/test.php' };
  const res = validateRequest(req, 'blog/wp-includes/test.php');
  assert.equal(res.status, 404);
});

test('validateRequest allows paths containing "wp" that are not wp-includes', () => {
  const req = { method: 'GET', url: 'https://example.com/images/debian/trixie' };
  assert.equal(validateRequest(req, 'images/debian/trixie'), null);
});

// ── routeAdminPath ───────────────────────────────────────────────────────────

const adminOpts = {
  bucket: { head: async () => ({}) },
  serviceName: 'test-svc',
  getStats: () => ({ items: 5, bytes: 1024 }),
  flush: () => {},
};

test('routeAdminPath returns robots.txt', async () => {
  const res = routeAdminPath('robots.txt', {}, adminOpts);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Disallow: /'));
  assert.ok(body.includes('Allow: /$'));
});

test('routeAdminPath returns health with R2 OK', async () => {
  const res = await routeAdminPath('health', {}, adminOpts);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'OK');
  assert.equal(data.service, 'test-svc');
  assert.equal(data.r2, 'OK');
  assert.deepEqual(data.cache, { items: 5, bytes: 1024 });
  assert.ok(data.time > 0);
});

test('routeAdminPath returns health with R2 ERROR', async () => {
  const failOpts = { ...adminOpts, bucket: { head: async () => { throw new Error('down'); } } };
  const res = await routeAdminPath('health', {}, failOpts);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'DEGRADED');
  assert.equal(data.r2, 'ERROR');
});

test('routeAdminPath returns cache status with valid secret', async () => {
  const env = { ADMIN_SECRET: 'abc123' };
  const res = routeAdminPath('_cache_status.abc123', env, adminOpts);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.items, 5);
  assert.equal(data.bytes, 1024);
});

test('routeAdminPath rejects cache status with wrong secret', () => {
  const env = { ADMIN_SECRET: 'abc123' };
  const res = routeAdminPath('_cache_status.wrong', env, adminOpts);
  assert.equal(res, null);
});

test('routeAdminPath rejects cache status with no secret set', () => {
  const res = routeAdminPath('_cache_status.anything', {}, adminOpts);
  assert.equal(res, null);
});

test('routeAdminPath flushes caches with valid secret', async () => {
  let flushed = false;
  const opts = { ...adminOpts, flush: () => { flushed = true; } };
  const env = { ADMIN_SECRET: 'sec456' };
  const res = routeAdminPath('_cache_flush.sec456', env, opts);
  assert.equal(res.status, 200);
  assert.ok(flushed);
  const data = await res.json();
  assert.equal(data.flushed, true);
});

test('routeAdminPath rejects cache flush with wrong secret', () => {
  const env = { ADMIN_SECRET: 'sec456' };
  const res = routeAdminPath('_cache_flush.nope', env, adminOpts);
  assert.equal(res, null);
});

test('routeAdminPath returns null for unknown paths', () => {
  assert.equal(routeAdminPath('images/debian/trixie', {}, adminOpts), null);
  assert.equal(routeAdminPath('v2/something', {}, adminOpts), null);
});

// ── wrapHandler ──────────────────────────────────────────────────────────────

test('wrapHandler adds performance headers', async () => {
  const handler = async () => new Response('ok');
  const worker = wrapHandler(handler, 'test-worker');
  const req = { cf: { colo: 'AMS' } };
  const res = await worker.fetch(req, {}, {});

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.ok(res.headers.get('X-Timer').startsWith('S'));
  assert.equal(res.headers.get('X-Served-By'), 'cache-AMS-test-worker');
});

test('wrapHandler catches errors and returns 500', async () => {
  const handler = async () => { throw new Error('boom'); };
  const worker = wrapHandler(handler, 'test-broken');
  const req = { cf: { colo: 'LAX' } };
  const res = await worker.fetch(req, {}, {});

  assert.equal(res.status, 500);
  assert.equal(res.headers.get('X-Served-By'), 'cache-LAX-test-broken');
});

test('wrapHandler uses UNKNOWN when colo is missing', async () => {
  const handler = async () => new Response('ok');
  const worker = wrapHandler(handler, 'test-nocf');
  const req = {};
  const res = await worker.fetch(req, {}, {});

  assert.equal(res.headers.get('X-Served-By'), 'cache-UNKNOWN-test-nocf');
});

test('wrapHandler preserves original response headers', async () => {
  const handler = async () => new Response('ok', {
    headers: { 'X-Custom': 'value', 'Content-Type': 'text/plain' }
  });
  const worker = wrapHandler(handler, 'test-headers');
  const req = { cf: { colo: 'FRA' } };
  const res = await worker.fetch(req, {}, {});

  assert.equal(res.headers.get('X-Custom'), 'value');
  assert.equal(res.headers.get('Content-Type'), 'text/plain');
  assert.ok(res.headers.has('X-Timer'));
});
