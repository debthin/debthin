import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackages, parseDeps, reduceToLatest, filterPackages, serializePackages } from '../../proxy/packages.js';

const mockPackages = `
Package: testA
Version: 1.0
Depends: testB (>= 1.0)
Filename: pool/main/t/testA/testA_1.0.deb

Package: testB
Version: 1.1

Package: testB
Version: 1.0
`;

test('proxyPackages/parsePackages', () => {
  const pkgs = parsePackages(mockPackages);
  assert.equal(pkgs.length, 3);
  assert.equal(pkgs[0].package, "testA");
  assert.equal(pkgs[0].version, "1.0");
});

test('proxyPackages/parseDeps', () => {
  const deps = parseDeps("libc6 (>= 2.1), perl | awk");
  assert.deepEqual(deps, [["libc6"], ["perl", "awk"]]);
  
  const empty = parseDeps("");
  assert.deepEqual(empty, []);
});

test('proxyPackages/reduceToLatest', () => {
  const pkgs = parsePackages(mockPackages);
  
  // No pin
  const best = reduceToLatest(pkgs, null);
  assert.equal(best.size, 2);
  assert.equal(best.get("testB").version, "1.1");

  // With pin
  const pinned = reduceToLatest(pkgs, "1.0");
  assert.equal(pinned.size, 2);
  assert.equal(pinned.get("testB").version, "1.0");
});

test('proxyPackages/filterPackages', () => {
  const pkgs = parsePackages(mockPackages);
  // Remove testB so testA's dependency fails
  const subset = new Map();
  subset.set("testA", pkgs[0]);
  
  const filtered = filterPackages(subset);
  // testA should be removed because testB is missing
  assert.equal(filtered.size, 0);

  // With testB included
  subset.set("testB", pkgs[1]);
  const filtered2 = filterPackages(subset);
  assert.equal(filtered2.size, 2);
});

test('proxyPackages/serializePackages', () => {
  const pkgs = parsePackages(mockPackages);
  const best = reduceToLatest(pkgs, null);
  
  const serialized = serializePackages(best);
  assert.ok(serialized.includes("Package: testA\n"));
  assert.ok(serialized.includes("Version: 1.0\n"));
  assert.ok(serialized.includes("Depends: testB (>= 1.0)\n"));
  // testB 1.1 is included
  assert.ok(serialized.includes("Package: testB\n"));
  assert.ok(serialized.includes("Version: 1.1\n"));
  // testB 1.0 is excluded
  assert.ok(!serialized.includes("Version: 1.0\n\nPackage: testB"));
});
