import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceStreamToLatest } from '../../worker/proxy/packages.js';

test('proxy/packages/Streaming Chunk Boundaries', async () => {
  // We feed a mock stream that breaks exactly in the middle of a stanza, 
  // verifying that the parser accumulates text cleanly across buffers natively.
  
  const textChunks = [
    "Package: test\nVersion: 1.0\nDepends",
    ": libc6 (>= 2.3)\n\n",
    "Package: test\nVersion: 2",
    ".0\nOrigin: local\n",
    "\nPack",
    "age: ignore\n\nPackage: test\nVersion: 0.5\n\n"
  ];
  
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of textChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  const best = await reduceStreamToLatest(readable, null);
  
  assert.equal(best.size, 2);
  assert.equal(best.get("test")["version"], "2.0");
  assert.ok(best.has("ignore"));
});
