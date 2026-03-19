import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, charOrder, compareVersionPart, compareDebianVersions } from '../../worker/proxy/version.js';

test('proxyVersion/parseVersion', () => {
  assert.deepEqual(parseVersion("1:2.3.4-5"), { epoch: 1, upstream: "2.3.4", revision: "5" });
  assert.deepEqual(parseVersion("2.3.4-5"), { epoch: 0, upstream: "2.3.4", revision: "5" });
  assert.deepEqual(parseVersion("2.3.4"), { epoch: 0, upstream: "2.3.4", revision: "0" });
  assert.deepEqual(parseVersion("2:1.0~rc1-1ubuntu1"), { epoch: 2, upstream: "1.0~rc1", revision: "1ubuntu1" });
});

test('proxyVersion/charOrder', () => {
  assert.equal(charOrder("~"), -1);
  assert.equal(charOrder(undefined), 0);
  assert.ok(charOrder("A") > 0);
  assert.ok(charOrder("a") > 0);
  // letters sort before punctuation
  assert.ok(charOrder("a") < charOrder("."));
});

test('proxyVersion/compareVersionPart', () => {
  assert.equal(compareVersionPart("1.0", "1.0"), 0);
  assert.ok(compareVersionPart("1.1", "1.0") > 0);
  assert.ok(compareVersionPart("1.0~rc1", "1.0") < 0);
  assert.ok(compareVersionPart("1.0~rc1", "1.0~b") > 0);
  assert.ok(compareVersionPart("2.0.0", "10.0.0") < 0);
});

test('proxyVersion/compareDebianVersions', () => {
  // Epoch overrides
  assert.ok(compareDebianVersions("1:1.0", "2:0.1") < 0);
  
  // Upstream overrides
  assert.ok(compareDebianVersions("1.2-5", "1.1-6") > 0);
  
  // Revision overrides
  assert.ok(compareDebianVersions("1.1-6", "1.1-5") > 0);
  assert.ok(compareDebianVersions("1.1", "1.1-0") === 0);
  
  // Tilde sorts before empty string
  assert.ok(compareDebianVersions("1.0~rc1-1", "1.0-1") < 0);
  assert.ok(compareDebianVersions("1.0~rc1-1", "1.0~beta-1") > 0);
});
