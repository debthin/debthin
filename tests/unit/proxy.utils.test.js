import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxySuitePath, proxyCacheBase, extractInReleaseHash } from '../../worker/proxy/utils.js';

test('proxyUtils/parseProxySuitePath (InRelease)', () => {
  const result = parseProxySuitePath("apt.grafana.com/stable/main/InRelease");
  assert.deepEqual(result, {
    host: "apt.grafana.com",
    suite: "stable",
    component: "main",
    type: "inrelease"
  });
});

test('proxyUtils/parseProxySuitePath (Arch Release)', () => {
  const result = parseProxySuitePath("apt.grafana.com/stable/main/grafana==1.10/binary-amd64/Release");
  assert.deepEqual(result, {
    host: "apt.grafana.com",
    suite: "stable",
    component: "main",
    pin: "1.10",
    arch: "amd64",
    type: "arch-release"
  });
});

test('proxyUtils/parseProxySuitePath (Packages)', () => {
  const result = parseProxySuitePath("apt.grafana.com/stable/main/grafana/binary-arm64/Packages.gz");
  assert.deepEqual(result, {
    host: "apt.grafana.com",
    suite: "stable",
    component: "main",
    pin: null, // No pin
    arch: "arm64",
    gz: true,
    type: "packages"
  });
});

test('proxyUtils/parseProxySuitePath (Invalid paths)', () => {
  assert.equal(parseProxySuitePath("apt.grafana.com/stable"), null);
  assert.equal(parseProxySuitePath("apt.grafana.com/stable/main/binary-something-missing"), null);
});

test('proxyUtils/proxyCacheBase Formatting', () => {
  assert.equal(
    proxyCacheBase("apt.grafana.com", "stable", "main", "1.10", "amd64"),
    "proxy/apt.grafana.com/stable/main==1.10/amd64"
  );
  assert.equal(
    proxyCacheBase("dl.google.com", "stable", "main", null, "arm64"),
    "proxy/dl.google.com/stable/main/arm64"
  );
});

test('proxyUtils/extractInReleaseHash', () => {
  const fakeInRelease = `
SHA256:
 0000000000000000000000000000000000000000000000000000000000001234 100 main/binary-amd64/Packages.gz
 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 200 main/binary-arm64/Packages.gz
`;
  const result = extractInReleaseHash(fakeInRelease, "main/binary-amd64/Packages.gz");
  assert.equal(result.expected, "0000000000000000000000000000000000000000000000000000000000001234");
  assert.equal(result.subtle, "SHA-256");

  const missing = extractInReleaseHash(fakeInRelease, "main/binary-i386/Packages.gz");
  assert.equal(missing, null);
});
