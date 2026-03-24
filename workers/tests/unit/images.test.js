/**
 * @fileoverview Unit and integration tests for the worker/images module.
 * Uses Node.js built-in test runner with synthetic R2 mocks.
 *
 * Run: node --test tests/unit/images.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../images/index.js';
import { indexCache } from '../../images/cache.js';
import { hydrateRegistryState, getOciState, getFileSizes } from '../../images/indexes.js';
import { buildDerivedResponse, H_CACHED, STATIC_OCI_LAYOUT } from '../../images/http.js';
import { handleImageRedirect, handleIncusPointer, handleOciLayout, handleImageMetadata, routeImagePath } from '../../images/handlers/index.js';

// ── Synthetic State & Mocks ─────────────────────────────────────────────────

/**
 * Builds a synthetic registry-state.json payload matching the R2 format
 * produced by generate_image_manifest.py.
 */
function makeSyntheticState() {
    return {
        lxc_csv: [
            'debian;bookworm;amd64;default;20231010_01:23;/images/debian/bookworm/amd64/default/20231010_01:23/',
            'debian;bullseye;arm64;default;20231011_02:00;/images/debian/bullseye/arm64/default/20231011_02:00/'
        ].join('\n'),
        incus_json: {
            content_id: 'images',
            datatype: 'image-downloads',
            format: 'products:1.0',
            products: {
                'debian:bookworm:amd64:default': {
                    aliases: 'debian/bookworm',
                    arch: 'amd64',
                    os: 'Debian',
                    release: 'bookworm',
                    variant: 'default',
                    versions: {
                        '20231010_01:23': {
                            items: {
                                'incus.tar.xz': { ftype: 'incus.tar.xz', size: 1000, sha256: 'mockhash1' },
                                'rootfs.tar.xz': { ftype: 'root.tar.xz', size: 30000000, sha256: 'mockhash2' }
                            }
                        }
                    }
                }
            }
        },
        oci_blobs: {
            'sha256:abc123def456': 'images/oci/blobs/sha256/abc123def456',
            'sha256:manifest111': 'images/oci/manifests/sha256/manifest111'
        },
        oci_manifests: {
            'debian:latest': 'images/oci/manifests/debian/latest.json'
        },
        file_sizes: {
            'images/debian/bookworm/amd64/default/20231010_01:23/incus.tar.xz': 696,
            'images/debian/bookworm/amd64/default/20231010_01:23/meta.tar.xz': 812,
            'images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz': 62481948,
            'images/debian/bookworm/amd64/default/20231010_01:23/rootfs.squashfs': 66854912,
            'images/ubuntu/noble/amd64/default/20260322_2318/incus.tar.xz': 696,
            'images/ubuntu/noble/amd64/default/20260322_2318/meta.tar.xz': 756,
            'images/ubuntu/noble/amd64/default/20260322_2318/rootfs.tar.xz': 42682612,
            'images/ubuntu/noble/amd64/default/20260322_2318/rootfs.squashfs': 45195264,
            'images/ubuntu/noble/amd64/default/20260322_2318/oci/index.json': 186,
            'images/ubuntu/noble/amd64/default/20260322_2318/oci/blobs/sha256/2041187ab55b': 504,
            'images/ubuntu/noble/amd64/default/20260322_2318/oci/blobs/sha256/2736c1e6438f': 93446376
        }
    };
}

let stateGetCount = 0;

/**
 * Builds a mock R2 bucket that serves registry-state.json and OCI manifests.
 */
function mockBucket(state) {
    const encoder = new TextEncoder();
    const stateBytes = encoder.encode(JSON.stringify(state));

    const manifests = {
        'images/oci/manifests/debian/latest.json': JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: []
        }),
        'images/oci/manifests/sha256/manifest111': JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: {},
            layers: []
        })
    };

    return {
        get(key) {
            if (key === 'registry-state.json') {
                stateGetCount++;
                return Promise.resolve({
                    arrayBuffer: () => Promise.resolve(stateBytes.buffer.slice(0)),
                    etag: '"state-etag-1"'
                });
            }
            if (manifests[key]) {
                const buf = encoder.encode(manifests[key]);
                return Promise.resolve({
                    arrayBuffer: () => Promise.resolve(buf.buffer.slice(0)),
                    etag: `"${key}-etag"`
                });
            }
            // Serve synthetic metadata files for image paths
            if (key.endsWith('/incus.tar.xz') || key.endsWith('/meta.tar.xz')) {
                const fakeTar = new Uint8Array([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]); // XZ magic bytes
                return Promise.resolve({
                    arrayBuffer: () => Promise.resolve(fakeTar.buffer.slice(0)),
                    etag: `"${key}-meta-etag"`
                });
            }
            if (key.endsWith('/oci/index.json')) {
                const ociIdx = encoder.encode(JSON.stringify({ schemaVersion: 2, manifests: [] }));
                return Promise.resolve({
                    arrayBuffer: () => Promise.resolve(ociIdx.buffer.slice(0)),
                    etag: `"${key}-oci-idx-etag"`
                });
            }
            // Small OCI blobs (under 100KB size threshold)
            if (key.endsWith('/oci/blobs/sha256/2041187ab55b')) {
                const smallBlob = encoder.encode('{"config":{}}');
                return Promise.resolve({
                    arrayBuffer: () => Promise.resolve(smallBlob.buffer.slice(0)),
                    etag: `"${key}-blob-etag"`
                });
            }
            return Promise.resolve(null);
        },
        head(key) {
            return Promise.resolve(key === 'healthcheck-ping' ? { etag: 'mock' } : null);
        }
    };
}

function mockCtx() {
    const promises = [];
    return {
        waitUntil(p) { promises.push(p); p.catch(() => {}); },
        promises
    };
}

function mockEnv(state) {
    return {
        IMAGES_BUCKET: mockBucket(state),
        PUBLIC_R2_URL: 'https://r2-public.debthin.org'
    };
}

// ── Unit Tests: indexes.js ──────────────────────────────────────────────────

describe('indexes.js - hydrateRegistryState', () => {
    beforeEach(() => {
        indexCache.purge();
        stateGetCount = 0;
    });

    it('populates LXC and Incus cache entries from state JSON', async () => {
        const state = makeSyntheticState();
        await hydrateRegistryState(mockBucket(state));

        const lxc = indexCache.get('meta/1.0/index-system');
        assert.notEqual(lxc, null, 'LXC index should be cached');
        const lxcText = new TextDecoder().decode(lxc.buf);
        assert.ok(lxcText.includes('debian;bookworm;amd64'), 'LXC CSV should contain the expected entry');

        const incus = indexCache.get('streams/v1/images.json');
        assert.notEqual(incus, null, 'Incus index should be cached');
        const incusData = JSON.parse(new TextDecoder().decode(incus.buf));
        assert.ok(incusData.products, 'Incus JSON should have products');
    });

    it('sets metadata with both lastModified (numeric) and lastModifiedStr', async () => {
        const state = makeSyntheticState();
        await hydrateRegistryState(mockBucket(state));

        const lxc = indexCache.get('meta/1.0/index-system');
        assert.equal(typeof lxc.meta.lastModified, 'number', 'lastModified should be numeric');
        assert.equal(typeof lxc.meta.lastModifiedStr, 'string', 'lastModifiedStr should be a string');
        assert.ok(lxc.meta.etag.startsWith('W/'), 'etag should be a weak validator');
    });

    it('returns OCI state after hydration', async () => {
        const state = makeSyntheticState();
        const ctx = mockCtx();
        const oci = await getOciState(mockBucket(state), ctx);
        assert.ok(oci.blobs, 'should have blobs dictionary');
        assert.ok(oci.manifests, 'should have manifests dictionary');
        assert.equal(oci.blobs['sha256:abc123def456'], 'images/oci/blobs/sha256/abc123def456');
    });

    it('deduplicates concurrent hydration calls via pending map', async () => {
        const state = makeSyntheticState();
        const bucket = mockBucket(state);

        await Promise.all([
            hydrateRegistryState(bucket),
            hydrateRegistryState(bucket)
        ]);

        assert.equal(stateGetCount, 1, 'should only fetch state once for concurrent calls');
    });
});

// ── Unit Tests: http.js ─────────────────────────────────────────────────────

describe('http.js - buildDerivedResponse', () => {
    it('returns 200 with body for a normal GET', () => {
        const request = new Request('https://images.debthin.org/test');
        const buf = new TextEncoder().encode('hello').buffer;
        const meta = { etag: 'W/"5"', lastModified: Date.now(), lastModifiedStr: new Date().toUTCString() };

        const resp = buildDerivedResponse(request, meta, buf, true, 3, H_CACHED);
        assert.equal(resp.status, 200);
        assert.equal(resp.headers.get('ETag'), 'W/"5"');
        assert.equal(resp.headers.get('X-Cache'), 'HIT');
        assert.equal(resp.headers.get('X-Cache-Hits'), '3');
    });

    it('returns 304 when If-None-Match matches', () => {
        const request = new Request('https://images.debthin.org/test', {
            headers: { 'If-None-Match': 'W/"5"' }
        });
        const meta = { etag: 'W/"5"', lastModified: Date.now(), lastModifiedStr: new Date().toUTCString() };

        const resp = buildDerivedResponse(request, meta, new ArrayBuffer(0), true, 1, H_CACHED);
        assert.equal(resp.status, 304);
        assert.equal(resp.body, null);
    });

    it('merges extra headers into the response', () => {
        const request = new Request('https://images.debthin.org/test');
        const meta = { etag: '"abc"', lastModified: Date.now(), lastModifiedStr: new Date().toUTCString() };
        const extra = { 'Content-Type': 'application/vnd.oci.image.index.v1+json' };

        const resp = buildDerivedResponse(request, meta, new ArrayBuffer(0), false, 0, H_CACHED, extra);
        assert.equal(resp.headers.get('Content-Type'), 'application/vnd.oci.image.index.v1+json');
    });
});

// ── Unit Tests: handlers ────────────────────────────────────────────────────

describe('handlers - handleImageRedirect', () => {
    it('returns 301 with correct Location', () => {
        const env = { PUBLIC_R2_URL: 'https://r2.example.com' };
        const resp = handleImageRedirect('/images/debian/rootfs.tar.xz', env);
        assert.equal(resp.status, 301);
        assert.equal(resp.headers.get('Location'), 'https://r2.example.com/images/debian/rootfs.tar.xz');
    });

    it('falls back to default host when PUBLIC_R2_URL is not set', () => {
        const resp = handleImageRedirect('/images/debian/rootfs.tar.xz', {});
        assert.equal(resp.status, 301);
        assert.ok(resp.headers.get('Location').startsWith('https://r2-public.debthin.org'));
    });

    it('includes immutable cache headers', () => {
        const resp = handleImageRedirect('/images/test', { PUBLIC_R2_URL: 'https://r2.example.com' });
        const cc = resp.headers.get('Cache-Control');
        assert.ok(cc.includes('immutable'), 'Should have immutable cache-control');
        assert.ok(cc.includes('max-age=31536000'), 'Should have 1-year max-age');
    });
});

describe('handlers - handleIncusPointer', () => {
    it('returns pointer JSON with correct structure', async () => {
        const request = new Request('https://images.debthin.org/streams/v1/index.json');
        const resp = await handleIncusPointer(request, null, null);
        assert.equal(resp.status, 200);
        const body = JSON.parse(await resp.text());
        assert.equal(body.format, 'index:1.0');
        assert.equal(body.index.images.path, 'streams/v1/images.json');
    });

    it('uses stable metadata (same etag across calls)', async () => {
        const r1 = new Request('https://images.debthin.org/streams/v1/index.json');
        const r2 = new Request('https://images.debthin.org/streams/v1/index.json');
        const resp1 = await handleIncusPointer(r1, null, null);
        const resp2 = await handleIncusPointer(r2, null, null);
        assert.equal(resp1.headers.get('ETag'), resp2.headers.get('ETag'), 'ETags should be stable');
    });
});

// ── Integration Tests: full worker.fetch() ──────────────────────────────────

describe('Integration: worker.fetch()', () => {
    beforeEach(() => {
        indexCache.purge();
        stateGetCount = 0;
    });

    it('rejects POST with 405', async () => {
        const req = new Request('https://images.debthin.org/streams/v1/index.json', { method: 'POST' });
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 405);
    });

    it('rejects query strings with 400', async () => {
        const req = new Request('https://images.debthin.org/streams/v1/index.json?foo=bar');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 400);
    });

    it('serves health endpoint', async () => {
        const req = new Request('https://images.debthin.org/health');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.status, 'ok');
    });

    it('redirects /images/* to R2 public domain', async () => {
        const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 301);
        assert.ok(res.headers.get('Location').includes('rootfs.tar.xz'));
    });

    it('redirects /images/* with custom PUBLIC_R2_URL', async () => {
        const env = { ...mockEnv(makeSyntheticState()), PUBLIC_R2_URL: 'https://custom-r2.example.com' };
        const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 301);
        assert.equal(res.headers.get('Location'), 'https://custom-r2.example.com/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
    });

    it('serves LXC index with correct caching', async () => {
        const state = makeSyntheticState();
        const env = mockEnv(state);

        // First call: populates cache
        const req1 = new Request('https://images.debthin.org/meta/1.0/index-system');
        const res1 = await worker.fetch(req1, env, mockCtx());
        assert.equal(res1.status, 200);
        const text = await res1.text();
        assert.ok(text.includes('debian;bookworm;amd64'));

        // Second call: served from cache
        const req2 = new Request('https://images.debthin.org/meta/1.0/index-system');
        const res2 = await worker.fetch(req2, env, mockCtx());
        assert.equal(res2.status, 200);
        assert.equal(res2.headers.get('X-Cache'), 'HIT');

        // Third call: 304 Not Modified
        const req3 = new Request('https://images.debthin.org/meta/1.0/index-system', {
            headers: { 'If-None-Match': res2.headers.get('ETag') }
        });
        const res3 = await worker.fetch(req3, env, mockCtx());
        assert.equal(res3.status, 304);
    });

    it('serves Incus images.json', async () => {
        const req = new Request('https://images.debthin.org/streams/v1/images.json');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.ok(json.products);
    });

    it('returns 404 for unknown paths', async () => {
        const req = new Request('https://images.debthin.org/random/path.txt');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 404);
    });

    it('handles OCI v2 root', async () => {
        const req = new Request('https://images.debthin.org/v2');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.equal(body, '{}');
    });

    it('handles HEAD requests with no body', async () => {
        const state = makeSyntheticState();
        const env = mockEnv(state);

        // Ensure cache is populated first
        const warmReq = new Request('https://images.debthin.org/meta/1.0/index-system');
        await worker.fetch(warmReq, env, mockCtx());

        const req = new Request('https://images.debthin.org/meta/1.0/index-system', { method: 'HEAD' });
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '');
    });

    it('appends timing and serving headers', async () => {
        const req = new Request('https://images.debthin.org/health');
        const res = await worker.fetch(req, mockEnv(makeSyntheticState()), mockCtx());
        assert.ok(res.headers.get('X-Timer'), 'Should have X-Timer header');
        assert.ok(res.headers.get('X-Served-By'), 'Should have X-Served-By header');
    });
});

// ── Metadata Cache Tests ────────────────────────────────────────────────────

describe('Integration: metadata file caching', () => {
    beforeEach(() => {
        indexCache.purge();
        stateGetCount = 0;
    });

    it('serves incus.tar.xz from R2 then cache', async () => {
        const env = mockEnv(makeSyntheticState());
        const path = 'images/debian/bookworm/amd64/default/20231010_01:23/incus.tar.xz';

        // First call: cache miss, fetches from R2
        const req1 = new Request(`https://images.debthin.org/${path}`);
        const res1 = await worker.fetch(req1, env, mockCtx());
        assert.equal(res1.status, 200);
        assert.equal(res1.headers.get('Content-Type'), 'application/x-xz');
        assert.equal(res1.headers.get('X-Cache'), 'MISS');

        // Second call: served from LRU cache
        const req2 = new Request(`https://images.debthin.org/${path}`);
        const res2 = await worker.fetch(req2, env, mockCtx());
        assert.equal(res2.status, 200);
        assert.equal(res2.headers.get('X-Cache'), 'HIT');

        // Third call: 304 with matching ETag
        const req3 = new Request(`https://images.debthin.org/${path}`, {
            headers: { 'If-None-Match': res2.headers.get('ETag') }
        });
        const res3 = await worker.fetch(req3, env, mockCtx());
        assert.equal(res3.status, 304);
    });

    it('serves meta.tar.xz with correct Content-Type', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/meta.tar.xz');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'application/x-xz');
    });

    it('serves oci/index.json with OCI Content-Type', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/oci/index.json');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'application/vnd.oci.image.index.v1+json');
        const body = JSON.parse(await res.text());
        assert.equal(body.schemaVersion, 2);
    });

    it('returns hardwired oci-layout response', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/oci/oci-layout');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'application/json');
        const body = JSON.parse(await res.text());
        assert.equal(body.imageLayoutVersion, '1.0.0');
    });

    it('oci-layout returns consistent ETag across calls', async () => {
        const env = mockEnv(makeSyntheticState());
        const r1 = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/v1/oci/oci-layout');
        const r2 = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/v2/oci/oci-layout');
        const res1 = await worker.fetch(r1, env, mockCtx());
        const res2 = await worker.fetch(r2, env, mockCtx());
        assert.equal(res1.headers.get('ETag'), res2.headers.get('ETag'));
    });

    it('still 301-redirects rootfs.tar.xz (large binary)', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.tar.xz');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 301);
        assert.ok(res.headers.get('Location').includes('rootfs.tar.xz'));
    });

    it('still 301-redirects rootfs.squashfs', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/rootfs.squashfs');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 301);
    });

    it('still 301-redirects OCI blob files', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/oci/blobs/sha256/abc123');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 301);
    });

    it('HEAD request on metadata returns no body', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/debian/bookworm/amd64/default/20231010_01:23/incus.tar.xz', { method: 'HEAD' });
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '');
    });

    it('caches small OCI blob under 100KB threshold', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/oci/blobs/sha256/2041187ab55b');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 200, 'small blob should be served from cache');
        assert.equal(res.headers.get('X-Cache'), 'MISS');
    });

    it('301-redirects large OCI blob over 100KB threshold', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/20260322_2318/oci/blobs/sha256/2736c1e6438f');
        const res = await worker.fetch(req, env, mockCtx());
        assert.equal(res.status, 301, 'large blob should be redirected');
    });

    it('oci-layout has immutable cache headers', async () => {
        const env = mockEnv(makeSyntheticState());
        const req = new Request('https://images.debthin.org/images/ubuntu/noble/amd64/default/v1/oci/oci-layout');
        const res = await worker.fetch(req, env, mockCtx());
        const cc = res.headers.get('Cache-Control');
        assert.ok(cc.includes('immutable'), 'oci-layout should have immutable cache-control');
        assert.ok(cc.includes('max-age=31536000'), 'oci-layout should have 1-year max-age');
    });
});
