import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../proxy/index.js';
import { proxyMetaCache, proxyDataCache } from '../../proxy/cache.js';

const mockCtx = {
  waitUntil: (promise) => { promise.catch(() => {}); }
};

// Clean caches between tests
test.beforeEach(() => {
  proxyMetaCache.purge();
  proxyDataCache.purge();
});

test('proxy/Method Rejection (POST)', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/InRelease', { method: 'POST' });
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 405);
  const text = await res.text();
  assert.equal(text, "Method Not Allowed\n");
});

test('proxy/Query String Rejection', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/InRelease?test=1');
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 400);
});

test('proxy/Directory Traversal Rejection', async () => {
  const req = {
    method: 'GET',
    url: 'https://debthin.org/dists/../config.json',
    headers: new Headers()
  };
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 400);
});

test('proxy/Package Passthrough Redirect (301)', async () => {
  const req = new Request('https://debthin.org/pkg/apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb');
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb');
});

test('proxy/Bad Proxy Path Structure', async () => {
  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable');
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.equal(text, "Bad proxy path\n");
});

test('proxy/Unknown Root Namespace (404)', async () => {
  const req = new Request('https://debthin.org/invalid-root/test');
  const res = await worker.fetch(req, {}, mockCtx);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text, "Proxy Not Found\n");
});

test('proxy/Metadata Handle (Concurrent HEAD checks + SWR)', async () => {
  let puts = [];
  const mockEnv = {
    DEBTHIN_BUCKET: {
      async head() { return null; },
      async put(key, blob) { puts.push(key); }
    }
  };

  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async (url, opts) => {
    fetchCount++;
    return new Response(null, { status: 200 }); // All up!
  };

  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/main/Release');
  const res = await worker.fetch(req, mockEnv, mockCtx);
  
  global.fetch = originalFetch;

  assert.equal(res.status, 200);
  assert.ok(puts.includes('proxy/apt.grafana.com/stable/Release'));
  // Prove that Promise.any() fired all 3 simultaneously natively!
  assert.equal(fetchCount, 3);
});

test('proxy/Packages Handle (SWR 304 Fast Path Metadata)', async () => {
  let puts = [];
  const mockEnv = {
    DEBTHIN_BUCKET: {
      // Simulate cache explicitly already present and expired
      async head(key) { 
        return { lastModified: Date.now() - 9999999999 };
      },
      async put(key, blob) { puts.push(key); }
    }
  };
  
  // Inject mock state into isolate natively validating SWR
  proxyDataCache.add('proxy/apt.grafana.com/stable/main/amd64/Packages.gz', new ArrayBuffer(0), { lastModified: Date.now() - 9999999999 }, Date.now());

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('InRelease')) return new Response(null, { status: 304 }); // Upstream validates unmodified
    return new Response("Unexpected", { status: 500 });
  };

  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/main/grafana/binary-amd64/Packages.gz');
  // Pass ctx dummy natively catching the SWR cascade sequence internally
  const res = await worker.fetch(req, mockEnv, mockCtx);

  global.fetch = originalFetch;
  
  // Because it fell back explicitly to the stable proxyDataCache SWR natively
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Cache"), "HIT");

  // Validate FAST PATH `.meta` tracking instead of gigantic buffer overwrite
  assert.equal(puts.length, 1);
  assert.equal(puts[0], 'proxy/apt.grafana.com/stable/main/amd64/Packages.gz.meta');
});

test('proxy/Packages Handle (Explicit Error degradation limits)', async () => {
  const mockEnv = {
    DEBTHIN_BUCKET: {
      async head(key) { return { lastModified: Date.now() - 9999999999 }; },
      async put(key, blob) { }
    }
  };

  proxyDataCache.add('proxy/apt.grafana.com/stable/main/amd64/Packages.gz', new ArrayBuffer(10), { lastModified: Date.now() - 9999999999 }, Date.now() - 9999999);

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    throw new TypeError("DNS FAILURE SIMULATION");
  };

  const req = new Request('https://debthin.org/dists/apt.grafana.com/stable/main/grafana/binary-amd64/Packages.gz');
  const res = await worker.fetch(req, mockEnv, mockCtx);

  global.fetch = originalFetch;

  // The worker cleanly traps the fetch failure, and purposefully degraded back down to the stale payload instead of crashing!
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Cache"), "HIT");
});
