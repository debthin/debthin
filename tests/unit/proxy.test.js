import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/proxy/index.js';

test('proxy/Method Rejection (POST)', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/InRelease', { method: 'POST' });
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 405);
  const text = await res.text();
  assert.equal(text, "Method Not Allowed\n");
});

test('proxy/Query String Rejection', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/InRelease?test=1');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 400);
});

test('proxy/Directory Traversal Rejection', async () => {
  // Use a duck-typed request bypass to test raw Edge TCP payloads before URL standardization
  const req = {
    method: 'GET',
    url: 'https://debthin.org/dists/../config.json',
    headers: new Headers()
  };
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 400);
});

test('proxy/Package Passthrough Redirect (301)', async () => {
  const req = new Request('https://debthin.org/pkg/apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb');
});

test('proxy/Bad Proxy Path Structure', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable');
  const res = await worker.fetch(req, {}, {});
  // Fails the parseProxySuitePath validation bounds
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.equal(text, "Bad proxy path\n");
});

test('proxy/Unknown Root Namespace (404)', async () => {
  const req = new Request('https://debthin.org/invalid-root/test');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text, "Proxy Not Found\n");
});
