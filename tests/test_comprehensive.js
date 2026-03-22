// test_comprehensive.js
// Parses config.json to test all Cloudflare Worker routing branches, aliases, base assets, proxy redirects, and caching layers.

const fs = require('fs');

const TARGET_HOST = process.env.TARGET_HOST || 'http://localhost:8787';

// Hashes mimicking empty file hashes used by the worker for `by-hash` injection
const EMPTY_HASH         = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_GZ_HASH      = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";

// Expected security headers injected into every response by the worker
const EXPECTED_SECURITY_HEADERS = [
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
    "x-clacks-overhead"
];

async function fetchAndAnalyze(label, path, expectedStatus, expectedXDebthinLayer = null, redirect = 'manual', fetchOpts = {}) {
    // Drop leading slash from path if present so we don't double up
    if (path.startsWith('/')) path = path.slice(1);
    const url = `${TARGET_HOST}/${path}`;
    const start = performance.now();
    try {
        const res = await fetch(url, { redirect, ...fetchOpts });
        // Consume text so fetch completes natively
        await res.text();
        const duration = Math.round(performance.now() - start);
        
        const actualHeader = res.headers.get('x-debthin');
        const isHeaderValid = !expectedXDebthinLayer || 
            (Array.isArray(expectedXDebthinLayer) ? expectedXDebthinLayer.includes(actualHeader) : actualHeader === expectedXDebthinLayer);

        let isLocationValid = true;
        
        const location = res.headers.get('location');

        // Expected status might be an array
        const isStatusValid = Array.isArray(expectedStatus) ? expectedStatus.includes(res.status) : res.status === expectedStatus;

        const passed = isStatusValid && isHeaderValid && isLocationValid;

        if (!passed) {
            console.error(`❌ FAILED: ${label}`);
            console.error(`   URL: ${url}`);
            console.error(`   Expected Status: ${expectedStatus}, Got: ${res.status}`);
            if (expectedXDebthinLayer) {
                console.error(`   Expected X-Debthin: ${expectedXDebthinLayer}, Got: ${actualHeader}`);
            }
            if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
                console.error(`   Location: ${location}`);
            }
            return { ok: false, headers: res.headers };
        }

        console.log(`✅ PASS: ${label} [${duration}ms, x-debthin: ${actualHeader || 'N/A'}]`);
        return { ok: true, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), headers: res.headers };
    } catch (err) {
        console.error(`❌ ERROR: Fetch failed for ${label}:`, err.message);
        return { ok: false };
    }
}

/**
 * Validates that a response carries all expected security headers.
 * @param {string} label - Human-readable test label.
 * @param {Headers} headers - Response headers to check.
 * @returns {boolean} True if all expected headers are present.
 */
function checkSecurityHeaders(label, headers) {
    if (!headers) return false;
    let ok = true;
    for (const h of EXPECTED_SECURITY_HEADERS) {
        if (!headers.get(h)) {
            console.error(`❌ FAILED: ${label} — missing security header: ${h}`);
            ok = false;
        }
    }
    if (ok) console.log(`✅ PASS: ${label} — all security headers present`);
    return ok;
}

async function runTests() {
    console.log(`Starting exhaustive worker routing tests against ${TARGET_HOST}\n`);
    let allPassed = true;

    // =========================================================================
    // 1. Base Assets & Static Routes
    // =========================================================================
    console.log(`======================================`);
    console.log(`1. Base Assets & Static Routes`);
    console.log(`======================================\n`);

    const assets = [
        fetchAndAnalyze("Root (index.html)", "", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("Config JSON", "config.json", 200, ["hit-synthetic"]),
        fetchAndAnalyze("Status JSON", "status.json", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("Debthin Keyring (Binary)", "debthin-keyring-binary.gpg", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("robots.txt (synthetic)", "robots.txt", 200, "hit-synthetic"),
        fetchAndAnalyze("Health endpoint", "health", 200, "hit-synthetic")
    ];
    if ((await Promise.all(assets)).some(r => !r.ok)) allPassed = false;

    // =========================================================================
    // 1.5. HTTP Method & Input Validation
    // =========================================================================
    console.log(`\n======================================`);
    console.log(`1.5. HTTP Method & Input Validation`);
    console.log(`======================================\n`);

    const validation = [
        fetchAndAnalyze("POST Method Rejected", "config.json", 405, null, 'manual', { method: 'POST' }),
        fetchAndAnalyze("PUT Method Rejected", "config.json", 405, null, 'manual', { method: 'PUT' }),
        fetchAndAnalyze("Query string rejection", "config.json?foo=bar", 400),
        fetchAndAnalyze("Directory traversal rejection", "debian/../../../etc/passwd", [400, 404]),
        fetchAndAnalyze("Unknown distribution 404", "nonexistent/dists/trixie/InRelease", 404)
    ];
    if ((await Promise.all(validation)).some(r => !r.ok)) allPassed = false;

    // =========================================================================
    // 2. Security Headers Verification
    // =========================================================================
    console.log(`\n======================================`);
    console.log(`2. Security Headers`);
    console.log(`======================================\n`);

    const configResult = await fetchAndAnalyze("Security headers on config.json", "config.json", 200, "hit-synthetic");
    if (!checkSecurityHeaders("config.json security headers", configResult.headers)) allPassed = false;

    // Verify X-Timer and X-Served-By are present on responses
    if (configResult.headers) {
        const xTimer = configResult.headers.get('x-timer');
        const xServed = configResult.headers.get('x-served-by');
        if (xTimer) {
            console.log(`✅ PASS: X-Timer header present: ${xTimer}`);
        } else {
            console.error(`❌ FAILED: X-Timer header missing`);
            allPassed = false;
        }
        if (xServed) {
            console.log(`✅ PASS: X-Served-By header present: ${xServed}`);
        } else {
            console.error(`❌ FAILED: X-Served-By header missing`);
            allPassed = false;
        }
    }

    // =========================================================================
    // 2.5. config.json ETag 304 Caching
    // =========================================================================
    console.log(`\n======================================`);
    console.log(`2.5. config.json ETag Caching`);
    console.log(`======================================\n`);

    if (configResult.etag) {
        const configEtagHit = await fetchAndAnalyze("config.json ETag 304", "config.json", 304, null, 'manual', { headers: { 'If-None-Match': configResult.etag }});
        if (!configEtagHit.ok) allPassed = false;
    } else {
        console.error(`❌ SKIPPED: config.json did not return an ETag`);
        allPassed = false;
    }

    // =========================================================================
    // 3. Dynamic Distribution Suite Execution
    // =========================================================================
    console.log(`\n======================================`);
    console.log(`3. Dynamic Distribution Suite Execution`);
    console.log(`======================================\n`);

    const path = require('path');
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));

    for (const [distro, meta] of Object.entries(config)) {
        const upstreamRaw = meta.upstream || meta.upstream_archive || meta.upstream_ports;
        if (!upstreamRaw) continue;

        const suites = Object.keys(meta.suites || {});
        if (suites.length === 0) continue;
        
        // Find a suite with an alias to test aliasing logic
        let testSuite = suites[0];
        let testAlias = null;
        for(let s of suites) {
            if(meta.suites[s].aliases && meta.suites[s].aliases.length > 0) {
                testSuite = s;
                testAlias = meta.suites[s].aliases[0];
                break;
            }
        }
        
        const arch = (meta.arches && meta.arches[0]) || (meta.archive_arches && meta.archive_arches[0]) || "amd64";
        const component = (meta.components && meta.components[0]) || "main";

        console.log(`\n--- Testing ${distro.toUpperCase()} (${testSuite}) ---`);

        const results = await Promise.all([
            // Standard fetch paths
            fetchAndAnalyze("InRelease - Read & R2 Hit", `${distro}/dists/${testSuite}/InRelease`, 200, ["hit", "hit-isolate-cache"]),
            fetchAndAnalyze("Packages.gz - Read & R2 Hit", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages.gz`, 200, ["hit", "hit-isolate-cache"]),
            
            // Dynamic derived paths
            fetchAndAnalyze("Release (strip-pgp derived)", `${distro}/dists/${testSuite}/Release`, 200, "hit-derived"),
            fetchAndAnalyze("Release.gpg", `${distro}/dists/${testSuite}/Release.gpg`, 200, ["hit", "hit-isolate-cache"]),
            fetchAndAnalyze("Packages (decompression)", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages`, 200, ["hit-decomp", "hit-decomp-bypassed"]),
            fetchAndAnalyze("Arch Release (generated native text)", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Release`, 200, "hit-generated"),

            // By-Hash empty file intercepts
            fetchAndAnalyze("by-hash empty string intercept", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/${EMPTY_HASH}`, 200, "hit-synthetic"),
            fetchAndAnalyze("by-hash empty gzip intercept", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/${EMPTY_GZ_HASH}`, 200, "hit-synthetic"),

            // by-hash unknown valid hex64 hash → 404
            fetchAndAnalyze("by-hash unknown hash 404", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`, 404),

            // by-hash invalid format (not hex64) → falls to upstream 301
            fetchAndAnalyze("by-hash invalid format upstream fallback", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/not-a-valid-hash`, 301),

            // Alias routing (e.g. `24.04` maps to `noble`)
            ...(testAlias ? [
                fetchAndAnalyze(`Suite Alias resolution (${testAlias} -> ${testSuite})`, `${distro}/dists/${testAlias}/InRelease`, 200, ["hit", "hit-isolate-cache"])
            ] : []),

            // Native pool/ and i18n/ URL pass-through (should 301 to native upstream repository host)
            fetchAndAnalyze("Native /pool/ upstream 301 routing", `${distro}/pool/main/b/bash/bash.deb`, 301),
            fetchAndAnalyze("Native /i18n/ Translation upstream 301 routing", `${distro}/dists/${testSuite}/${component}/i18n/Translation-en`, 301),
            fetchAndAnalyze("Native /i18n/ by-hash upstream 301 routing", `${distro}/dists/${testSuite}/${component}/i18n/by-hash/SHA256/1111111111111111111111111111111111111111111111111111111111111111`, 301),

            // Unmatched dists/ path → upstream 301 fallback
            fetchAndAnalyze("Unmatched dists/ path upstream fallback", `${distro}/dists/${testSuite}/something/completely/random`, 301)
        ]);
        
        // --- Explicit Isolate Cache Verification ---
        // Ensure that the preceding requests populated the local isolate cache
        const inReleaseCache = await fetchAndAnalyze("InRelease - Isolate Cache Verification", `${distro}/dists/${testSuite}/InRelease`, 200, "hit-isolate-cache");
        const packagesCache = await fetchAndAnalyze("Packages.gz - Isolate Cache Verification", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages.gz`, 200, ["hit", "hit-isolate-cache"]);
        const cacheVerifyResults = [inReleaseCache, packagesCache];

        // --- Security Headers on InRelease ---
        if (!checkSecurityHeaders("InRelease security headers", inReleaseCache.headers)) allPassed = false;

        // --- InRelease Cache-Control max-age=120 verification ---
        if (inReleaseCache.headers) {
            const cc = inReleaseCache.headers.get('cache-control');
            if (cc && cc.includes('max-age=120')) {
                console.log(`✅ PASS: InRelease Cache-Control contains max-age=120`);
            } else {
                console.error(`❌ FAILED: InRelease Cache-Control expected max-age=120, got: ${cc}`);
                allPassed = false;
            }
        }

        // --- Headless Component Verification ---
        const headlessResults = await Promise.all([
            fetchAndAnalyze("Headless Packages.gz - Read & R2 Hit", `${distro}/dists/${testSuite}/headless/binary-${arch}/Packages.gz`, 200, ["hit", "hit-isolate-cache"]),
            fetchAndAnalyze("Headless Packages (decompression)", `${distro}/dists/${testSuite}/headless/binary-${arch}/Packages`, 200, ["hit-decomp", "hit-decomp-bypassed"])
        ]);
        if (headlessResults.some(r => !r.ok)) allPassed = false;
        
        // --- HEAD Method Verification ---
        console.log(`\n  -- HEAD method tests --`);
        const headResults = await Promise.all([
            fetchAndAnalyze("HEAD InRelease", `${distro}/dists/${testSuite}/InRelease`, 200, ["hit", "hit-isolate-cache"], 'manual', { method: 'HEAD' }),
            fetchAndAnalyze("HEAD Packages.gz", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages.gz`, 200, ["hit", "hit-isolate-cache"], 'manual', { method: 'HEAD' }),
            fetchAndAnalyze("HEAD by-hash empty gzip", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/${EMPTY_GZ_HASH}`, 200, "hit-synthetic", 'manual', { method: 'HEAD' })
        ]);
        if (headResults.some(r => !r.ok)) allPassed = false;

        // --- 304 Not Modified Caching Verification ---
        if (inReleaseCache.etag) {
           const eTagHit = await fetchAndAnalyze("InRelease - ETag 304 Not Modified", `${distro}/dists/${testSuite}/InRelease`, 304, ["hit", "hit-isolate-cache"], 'manual', { headers: { 'If-None-Match': inReleaseCache.etag }});
           if (!eTagHit.ok) allPassed = false;
        }
        
        if (inReleaseCache.lastModified) {
           const imsHit = await fetchAndAnalyze("InRelease - If-Modified-Since 304 Not Modified", `${distro}/dists/${testSuite}/InRelease`, 304, ["hit", "hit-isolate-cache"], 'manual', { headers: { 'If-Modified-Since': inReleaseCache.lastModified }});
           if (!imsHit.ok) allPassed = false;
        }
        
        // --- Dynamic live by-hash testing ---
        // Grab the InRelease text (pulling from memory cache is fine)
        const inReleaseUrl = `${TARGET_HOST}/${distro}/dists/${testSuite}/InRelease`;
        const irResp = await fetch(inReleaseUrl);
        const irText = await irResp.text();
        
        // Find a valid SHA256 hash for a Packages.gz file and test the by-hash URL
        const sectionIdx = irText.indexOf("\nSHA256:");
        if (sectionIdx !== -1) {
            let pos = irText.indexOf("\n", sectionIdx + 1) + 1;
            let realHash = null;
            let realName = null;
            while (pos > 0 && pos < irText.length && irText.charCodeAt(pos) === 32) {
                const lineEnd = irText.indexOf("\n", pos);
                const line = lineEnd === -1 ? irText.slice(pos) : irText.slice(pos, lineEnd);
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) {
                    pos = lineEnd === -1 ? irText.length : lineEnd + 1;
                    continue;
                }
                const hash = parts[0];
                const name = parts[2];
                
                if (name.endsWith('/Packages.gz') && hash.length === 64 && hash !== EMPTY_HASH && hash !== EMPTY_GZ_HASH) {
                    realHash = hash;
                    realName = name;
                    break;
                }
                pos = lineEnd === -1 ? irText.length : lineEnd + 1;
            }
            
            if (realHash) {
                // Construct the by-hash URL from the component path (e.g. main/binary-amd64/by-hash/SHA256/<hash>)
                const componentDir = realName.slice(0, realName.lastIndexOf('/'));
                const byHashPath = `${componentDir}/by-hash/SHA256/${realHash}`;
                const hashResult = await fetchAndAnalyze("Live by-hash index routing", `${distro}/dists/${testSuite}/${byHashPath}`, 200, ["hit", "hit-isolate-cache"]);
                if (!hashResult.ok) allPassed = false;
            } else {
                console.log(`⚠️  Could not locate a valid Packages.gz hash in InRelease for ${distro}. Skipping by-hash live check.`);
            }
        }

        if (results.some(r => !r.ok) || cacheVerifyResults.some(r => !r.ok)) allPassed = false;
    }
    
    if (allPassed) {
        console.log(`\n🎉 All exhaustive worker routing tests passed successfully!`);
        process.exit(0);
    } else {
        console.error(`\n💥 Tests completed with failures.`);
        process.exit(1);
    }
}

runTests();
