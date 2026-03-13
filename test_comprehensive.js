// test_comprehensive.js
// Natively parses config.json to exhaustively test Cloudflare Worker caching layers, availability, and 301 redirects across distributions.

const fs = require('fs');

const TARGET_HOST = process.env.TARGET_HOST || 'http://localhost:8787';

async function fetchAndAnalyze(label, path, expectedStatus, expectedXDebthinLayer = null, redirect = 'follow') {
    const url = `${TARGET_HOST}/${path}`;
    const start = performance.now();
    try {
        const res = await fetch(url, { redirect });
        const text = redirect === 'follow' ? await res.text() : '';
        const duration = Math.round(performance.now() - start);
        
        const actualHeader = res.headers.get('x-debthin');
        const isHeaderValid = !expectedXDebthinLayer || 
            (Array.isArray(expectedXDebthinLayer) ? expectedXDebthinLayer.includes(actualHeader) : actualHeader === expectedXDebthinLayer);

        const passed = res.status === expectedStatus && isHeaderValid;

        if (!passed) {
            console.error(`❌ FAILED: ${label}`);
            console.error(`   URL: ${url}`);
            console.error(`   Expected Status: ${expectedStatus}, Got: ${res.status}`);
            if (expectedXDebthinLayer) {
                console.error(`   Expected X-Debthin: ${expectedXDebthinLayer}, Got: ${res.headers.get('x-debthin')}`);
            }
            if (res.status === 301) {
                console.error(`   Location: ${res.headers.get('location')}`);
            }
            return false;
        }

        console.log(`✅ PASS: ${label}`);
        console.log(`   URL: ${url}`);
        console.log(`   Time: ${duration}ms, X-Debthin: ${res.headers.get('x-debthin') || 'N/A'}`);
        if (res.status === 301) {
            console.log(`   Location: ${res.headers.get('location')}`);
        }
        return true;
    } catch (err) {
        console.error(`❌ ERROR: Fetch failed for ${label}:`, err.message);
        return false;
    }
}

async function runTests() {
    console.log(`Starting comprehensive cache test against ${TARGET_HOST}\n`);

    const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    let allPassed = true;

    for (const [distro, meta] of Object.entries(config)) {
        console.log(`\n======================================`);
        console.log(`Testing Distribution: ${distro.toUpperCase()}`);
        console.log(`======================================\n`);

        const upstreamRaw = meta.upstream || meta.upstream_archive || meta.upstream_ports;
        if (!upstreamRaw) {
            console.log(`Skipping metadata key: ${distro}`);
            continue;
        }

        const upstreamHost = upstreamRaw.split('//')[1];
        const suites = Object.keys(meta.suites || {});
        if (suites.length === 0) continue;
        const testSuite = suites[0]; // test the first suite mapped
        
        const arch = (meta.arches && meta.arches[0]) || (meta.archive_arches && meta.archive_arches[0]) || "amd64";
        const component = (meta.components && meta.components[0]) || "main";

        const inReleasePath = `${distro}/dists/${testSuite}/InRelease`;
        const releasePath = `${distro}/dists/${testSuite}/Release`;
        const packagesGzPath = `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages.gz`;
        const packagesPath = `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages`;
        const dummyPoolPath = `${distro}/pool/main/b/bash/bash.deb`;

        console.log(`--- Caching Layers: InRelease ---`);
        const r1 = await fetchAndAnalyze("InRelease - Initial Request (MISS or WARM)", inReleasePath, 200, ["hit", "hit-isolate-cache"]);
        const r2 = await fetchAndAnalyze("InRelease - Immediate Follow-up (ISOLATE CACHE)", inReleasePath, 200, "hit-isolate-cache");
        
        console.log(`\n--- Caching Layers: Packages.gz ---`);
        const r3 = await fetchAndAnalyze("Packages.gz - Initial Request (MISS or WARM)", packagesGzPath, 200, ["hit", "hit-isolate-cache"]);
        const r4 = await fetchAndAnalyze("Packages.gz - Immediate Follow-up (ISOLATE CACHE)", packagesGzPath, 200, "hit-isolate-cache");

        console.log(`\n--- Dynamic Routing Transforms ---`);
        const r5 = await fetchAndAnalyze("Release (strip-pgp derived signature layer)", releasePath, 200, "hit-derived");
        const r6 = await fetchAndAnalyze("Packages (on-the-fly decompression)", packagesPath, 200, "hit-decomp");

        console.log(`\n--- 301 Proxy Redirects: Pool .deb Binaries ---`);
        const r7 = await fetchAndAnalyze("Binary .deb Redirect", dummyPoolPath, 301, null, "manual");

        if (!(r1 && r2 && r3 && r4 && r5 && r6 && r7)) {
            allPassed = false;
        }

        console.log(`\n--- Parallel Load Stress Test ---`);
        const parallelPromises = [];
        for (let i = 1; i <= 5; i++) {
            parallelPromises.push(
                fetchAndAnalyze(`Parallel Stress #${i}`, packagesGzPath, 200, "hit-isolate-cache")
            );
        }
        const parallelResults = await Promise.all(parallelPromises);
        if (parallelResults.some(r => !r)) allPassed = false;
    }

    if (allPassed) {
        console.log(`\n🎉 All tests passed successfully!`);
        process.exit(0);
    } else {
        console.error(`\n💥 Tests completed with failures.`);
        process.exit(1);
    }
}

runTests();
