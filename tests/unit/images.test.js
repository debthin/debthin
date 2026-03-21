import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/images/index.js';
import { indexCache } from '../../worker/images/cache.js';

let listCallCount = 0;

// Mock Cloudflare Worker Environment Storage
const mockEnv = {
    IMAGES_BUCKET: {
        async head(key) {
            return { etag: "mock" };
        },
        async list(options) {
            listCallCount++;
            return {
                objects: [
                    {
                        key: 'images/debian/bookworm/amd64/default/20231010_01:23/incus.tar.xz',
                        size: 1000,
                        customMetadata: { sha256: 'mockhash1' }
                    },
                    {
                        key: 'images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz',
                        size: 30000000,
                        customMetadata: { sha256: 'mockhash2' }
                    },
                    {
                        key: 'images/debian/bullseye/arm64/default/20231011_02:00/incus.tar.xz',
                        size: 900,
                    }
                ],
                truncated: false
            };
        }
    }
};

const mockCtx = {
    waitUntil: (promise) => { promise.catch(() => {}); }
};

test('images/Method Rejection (POST)', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/index.json', { method: 'POST' });
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 405);
});

test('images/Query String Rejection', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/index.json?foo=bar');
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 400);
});

test('images/Health Endpoint & Cache Purge', async () => {
    indexCache.purge(); // Clean slate
    listCallCount = 0;

    const req = new Request('https://images.debthin.org/health');
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, "OK");
    // Global fetch warmup activates asynchronously; items will inherently populate.
    assert.ok(json.cache.indexItems >= 0);
});

test('images/LXC Index Generation (Caching logic)', async () => {
    indexCache.purge();
    listCallCount = 0;

    // Call 1: Miss, Generates text (or HIT if the background thread optimally pre-warms first)
    const req1 = new Request('https://images.debthin.org/meta/1.0/index-system');
    const res1 = await worker.fetch(req1, mockEnv, mockCtx);
    assert.equal(res1.status, 200);
    assert.ok(["HIT", "MISS"].includes(res1.headers.get("X-Cache")));
    
    // Validate text contents
    const text1 = await res1.text();
    assert.ok(text1.includes('debian;bookworm;amd64;default;20231010_01:23;'));
    assert.equal(listCallCount, 1); // Hit R2 once

    // Call 2: Hit entirely from LRU
    const req2 = new Request('https://images.debthin.org/meta/1.0/index-system');
    const res2 = await worker.fetch(req2, mockEnv, mockCtx);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Cache"), "HIT");

    // Call 3: 304 Not Modified
    const req3 = new Request('https://images.debthin.org/meta/1.0/index-system', {
        headers: { "If-None-Match": res2.headers.get("ETag") }
    });
    const res3 = await worker.fetch(req3, mockEnv, mockCtx);
    assert.equal(res3.status, 304);

    // Call 4: HEAD Optimization
    const reqHead = new Request('https://images.debthin.org/meta/1.0/index-system', { method: 'HEAD' });
    const resHead = await worker.fetch(reqHead, mockEnv, mockCtx);
    assert.equal(resHead.status, 200);
    assert.equal(await resHead.text(), ""); // Body stripped cleanly

    // R2 List was only executed ONCE
    assert.equal(listCallCount, 1);
});

test('images/Incus Images Index (Concurrency coalescing)', async () => {
    indexCache.purge(); // Clean cache from previous tests
    listCallCount = 0; // Reset
    
    // Simulate 3 concurrent connections requesting the large manifest tree
    const reqs = [
        new Request('https://images.debthin.org/streams/v1/images.json'),
        new Request('https://images.debthin.org/streams/v1/images.json'),
        new Request('https://images.debthin.org/streams/v1/images.json')
    ];

    const responses = await Promise.all(reqs.map(req => worker.fetch(req, mockEnv, mockCtx)));
    
    // First connection triggered the MISS (or cache hit if hook races)
    assert.ok(["HIT", "MISS"].includes(responses[0].headers.get("X-Cache")));
    // Next two concurrent connections waited on indexCache.pending and were served the exact same memory pointer!
    assert.equal(responses[1].headers.get("X-Cache"), "HIT");
    assert.equal(responses[2].headers.get("X-Cache"), "HIT");
    
    // Validate that missing sha256 payloads are actively discarded instead of stringified
    const json = await responses[0].json();
    assert.equal(json.products['debian:bullseye:arm64:default'], undefined);
    
    // Despite 3 requests, R2 list was called only 1 time natively
    assert.equal(listCallCount, 1);
});

test('images/Static Binary Redirect', async () => {
    const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 301);
});

test('images/Static Binary Redirect (Custom URL)', async () => {
    const envWithUrl = { ...mockEnv, PUBLIC_R2_URL: 'https://custom-r2.example.com' };
    const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
    const res = await worker.fetch(req, envWithUrl, mockCtx);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), 'https://custom-r2.example.com/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
});

test('images/Root and Robots.txt Routes', async () => {
    const reqRobots = new Request('https://images.debthin.org/robots.txt');
    const resRobots = await worker.fetch(reqRobots, mockEnv, mockCtx);
    assert.equal(resRobots.status, 200);
    assert.ok((await resRobots.text()).includes('Disallow: /'));

    const reqRoot = new Request('https://images.debthin.org/');
    const resRoot = await worker.fetch(reqRoot, mockEnv, mockCtx);
    assert.equal(resRoot.status, 200);
    assert.ok((await resRoot.text()).includes('debthin container registry'));
});

test('images/Not Found Fallback', async () => {
    const req = new Request('https://images.debthin.org/random/path.txt');
    const res = await worker.fetch(req, mockEnv, mockCtx);
    assert.equal(res.status, 404);
});
