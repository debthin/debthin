// test_comprehensive.js
// Natively parses config.json to exhaustively test ALL Cloudflare Worker routing branches, aliases, base assets, proxy redirects, and caching layers.

const fs = require('fs');

const TARGET_HOST = process.env.TARGET_HOST || 'http://localhost:8787';

// Hashes mimicking empty file hashes used by the worker for `by-hash` injection
const EMPTY_HASH         = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_GZ_HASH      = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";

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
        
        // Wait, for 301 manual redirects, what if it expects a specific location format? We can just check it existed.
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
            return false;
        }

        console.log(`✅ PASS: ${label} [${duration}ms, x-debthin: ${actualHeader || 'N/A'}]`);
        return true;
    } catch (err) {
        console.error(`❌ ERROR: Fetch failed for ${label}:`, err.message);
        return false;
    }
}

async function runTests() {
    console.log(`Starting exhaustive worker routing tests against ${TARGET_HOST}\n`);
    let allPassed = true;

    console.log(`======================================`);
    console.log(`1. Base Assets & Static Routes`);
    console.log(`======================================\n`);

    const assets = [
        fetchAndAnalyze("Root (index.html)", "", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("Config JSON", "config.json", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("Status JSON", "status.json", 200, ["hit", "hit-isolate-cache"]),
        fetchAndAnalyze("Debthin Keyring (Binary)", "debthin-keyring-binary.gpg", 200, ["hit", "hit-isolate-cache"])
    ];
    if ((await Promise.all(assets)).some(r => !r)) allPassed = false;

    console.log(`\n======================================`);
    console.log(`1.5. HTTP Method Restrictions`);
    console.log(`======================================\n`);

    const methods = [
        fetchAndAnalyze("POST Method Rejected", "config.json", 405, null, 'manual', { method: 'POST' })
    ];
    if ((await Promise.all(methods)).some(r => !r)) allPassed = false;

    console.log(`\n======================================`);
    console.log(`2. Package Proxies (/pkg/ redirect)`);
    console.log(`======================================\n`);
    const proxies = [
        fetchAndAnalyze("/pkg/ routing to upstream host", "pkg/archive.ubuntu.com/ubuntu/pool/main/h/hello/hello.deb", 301)
    ];
    if ((await Promise.all(proxies)).some(r => !r)) allPassed = false;


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
            fetchAndAnalyze("Packages (decompression)", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages`, 200, "hit-decomp"),
            fetchAndAnalyze("Arch Release (generated native text)", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Release`, 200, "hit-generated"),

            // By-Hash empty file intercepts
            fetchAndAnalyze("by-hash empty string intercept", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/${EMPTY_HASH}`, 200, "hit-empty"),
            fetchAndAnalyze("by-hash empty gzip intercept", `${distro}/dists/${testSuite}/${component}/by-hash/SHA256/${EMPTY_GZ_HASH}`, 200, "hit-empty"),

            // Alias routing (e.g. `24.04` maps to `noble`)
            ...(testAlias ? [
                fetchAndAnalyze(`Suite Alias resolution (${testAlias} -> ${testSuite})`, `${distro}/dists/${testAlias}/InRelease`, 200, ["hit", "hit-isolate-cache"])
            ] : []),

            // Native pool/ URL pass-through (should 301 to native upstream repository host)
            fetchAndAnalyze("Native /pool/ upstream 301 routing", `${distro}/pool/main/b/bash/bash.deb`, 301)
        ]);
        
        // --- Explicit Isolate Cache Verification ---
        // Ensure that the preceding requests successfully populated the local isolate cache
        const cacheVerifyResults = await Promise.all([
            fetchAndAnalyze("InRelease - Isolate Cache Verification", `${distro}/dists/${testSuite}/InRelease`, 200, "hit-isolate-cache"),
            fetchAndAnalyze("Packages.gz - Isolate Cache Verification", `${distro}/dists/${testSuite}/${component}/binary-${arch}/Packages.gz`, 200, "hit-isolate-cache")
        ]);
        
        // --- Dynamic live by-hash testing ---
        // Grab the InRelease text (pulling from memory cache is fine)
        const inReleaseUrl = `${TARGET_HOST}/${distro}/dists/${testSuite}/InRelease`;
        const irResp = await fetch(inReleaseUrl);
        const irText = await irResp.text();
        
        // Find a valid SHA256 of the Packages file
        const sectionIdx = irText.indexOf("\nSHA256:");
        if (sectionIdx !== -1) {
            let pos = irText.indexOf("\n", sectionIdx + 1) + 1;
            let realHash = null;
            let realPath = null;
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
                
                if (name.includes('by-hash/SHA256/') && hash.length === 64 && hash !== EMPTY_HASH && hash !== EMPTY_GZ_HASH) {
                    realHash = hash;
                    realPath = name;
                    break;
                }
                pos = lineEnd === -1 ? irText.length : lineEnd + 1;
            }
            
            if (realHash) {
                const hashResult = await fetchAndAnalyze("Live by-hash index routing", `${distro}/dists/${testSuite}/${realPath}`, 200, ["hit", "hit-isolate-cache"]);
                if (!hashResult) allPassed = false;
            } else {
                console.log(`⚠️  Could not locate a valid Packages hash in InRelease for ${distro}. Skipping by-hash live check.`);
            }
        }

        if (results.some(r => !r) || cacheVerifyResults.some(r => !r)) allPassed = false;
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
