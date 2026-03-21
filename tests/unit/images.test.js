import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/images/index.js';

// Mock Cloudflare Worker Environment Storage
const mockEnv = {
    IMAGES_BUCKET: {
        async list(options) {
            // Provide a mock listing of images/debian/
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
                        // No custom metadata for branch coverage
                    }
                ],
                truncated: false
            };
        }
    }
};

test('images/Method Rejection (POST)', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/index.json', { method: 'POST' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 405);
});

test('images/Query String Rejection', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/index.json?foo=bar');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 400);
});

test('images/Path Traversal Rejection', async () => {
    const req = {
        method: 'GET',
        url: 'https://images.debthin.org/streams/../v1/index.json',
        headers: new Headers({'x-forwarded-proto': 'https'})
    };
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 400);
});

test('images/LXC Index Generation', async () => {
    const req = new Request('https://images.debthin.org/meta/1.0/index-system');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('debian;bookworm;amd64;default;20231010_01:23;/images/debian/bookworm/amd64/default/20231010_01:23/'));
    assert.ok(text.includes('debian;bullseye;arm64;default;20231011_02:00;/images/debian/bullseye/arm64/default/20231011_02:00/'));
});

test('images/Incus Pointer Index', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/index.json');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.format, "index:1.0");
    assert.equal(json.index.images.path, "streams/v1/images.json");
});

test('images/Incus Images Index', async () => {
    const req = new Request('https://images.debthin.org/streams/v1/images.json');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.format, "products:1.0");
    
    const bw = json.products['debian:bookworm:amd64:default'];
    assert.ok(bw, "bookworm product must exist");
    assert.equal(bw.os, 'debian');
    assert.equal(bw.architecture, 'amd64');
    
    const versionInfo = bw.versions['20231010_01:23'];
    assert.ok(versionInfo, "bookworm version must exist");
    assert.equal(versionInfo.items.rootfs.sha256, 'mockhash2');
    assert.equal(versionInfo.items.incus_meta.sha256, 'mockhash1');

    const be = json.products['debian:bullseye:arm64:default'];
    assert.ok(be, "bullseye product must exist");
    // fallback hash check for HASH_MISSING branch
    assert.equal(be.versions['20231011_02:00'].items.incus_meta.sha256, 'HASH_MISSING');
});

test('images/Static Binary Redirect', async () => {
    const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), 'https://r2-public.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
});

test('images/Not Found Fallback', async () => {
    const req = new Request('https://images.debthin.org/random/path.txt');
    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 404);
});
