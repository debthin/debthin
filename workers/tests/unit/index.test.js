import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../debthin/index.js';

test('index/Method Rejection (POST)', async () => {
  const req = new Request('https://debthin.org/config.json', { method: 'POST' });
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 405);
  const text = await res.text();
  assert.equal(text, "Method Not Allowed\n");
});

test('index/Query String Rejection', async () => {
  const req = new Request('https://debthin.org/config.json?test=1');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 400);
});

test('index/Directory Traversal Rejection', async () => {
  // We use a mock request because Node's native Request() constructor aggressively standardizes
  // URL paths, collapsing '..' before it ever reaches the worker. We need to test raw Edge TCP payloads.
  const req = {
    method: 'GET',
    url: 'https://debthin.org/dists/../config.json',
    headers: new Headers()
  };
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 400);
});

test('index/Invalid Distro 404 Fallback', async () => {
  // Requesting a distro not mapped in config.json returns a 404
  const req = new Request('https://debthin.org/invalid-distro/dists/bookworm/InRelease');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 404);
});

test('index/Unmatched Path 301 Fallback', async () => {
  // Requesting a valid distro but an unmapped path (not in dists/ or pool/)
  // must cleanly fall back to an upstream 301 Location redirect.
  const req = new Request('https://debthin.org/debian/random-unmatched-path.txt');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://deb.debian.org/debian/random-unmatched-path.txt');
});
