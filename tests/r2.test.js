import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotModified } from '../worker/core/r2.js';

test('r2/isNotModified Strict ETags', () => {
  const reqObj = { etag: '"abcdef"' };
  
  const headersHit = new Headers({ 'if-none-match': '"abcdef"' });
  assert.equal(isNotModified(headersHit, reqObj), true, 'Exact match');
  
  const headersMiss = new Headers({ 'if-none-match': '"123456"' });
  assert.equal(isNotModified(headersMiss, reqObj), false, 'Mismatch');
});

test('r2/isNotModified Weak ETag Parsing', () => {
  const reqObj = { etag: '"abcd"' };
  
  const headersWeak = new Headers({ 'if-none-match': 'W/"abcd"' });
  assert.equal(isNotModified(headersWeak, reqObj), true, 'Strips Weak Prefix natively');
});

test('r2/isNotModified Last-Modified bounds', () => {
  const t = Math.floor(Date.now() / 1000) * 1000;
  const reqObj = { lastModified: t };
  
  const headersHit = new Headers({ 'if-modified-since': new Date(t).toUTCString() });
  assert.equal(isNotModified(headersHit, reqObj), true, 'Exact timestamp match');
  
  const headersMiss = new Headers({ 'if-modified-since': new Date(t - 100000).toUTCString() });
  assert.equal(isNotModified(headersMiss, reqObj), false, 'Client cache strictly older than file');
});
