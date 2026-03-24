import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceStreamToLatest } from '../../proxy/packages.js';

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
  assert.equal(best.get("test").get("version"), "2.0");
  assert.ok(best.has("ignore"));
});

test('proxy/packages/Streaming Byte Sweep Pin Filter', async () => {
  const text =
    "Package: pinA\nVersion: 1:12.0-1\nFilename: pool/a\n\n" +
    "Package: pinB\nVersion: 1:13.0-2\nFilename: pool/b\n\n" +
    "Package: pinC\nVersion: 12.0.1-1\nFilename: pool/c\n";

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });

  const best = await reduceStreamToLatest(readable, "12.0");

  assert.equal(best.size, 2, "Only packages matching pin 12.0 should be kept");
  assert.ok(best.has("pinA"));
  assert.ok(best.has("pinC"));
  assert.ok(!best.has("pinB"), "pinB has upstream 13.0 and should be excluded");
});

test('proxy/packages/Streaming Byte Sweep Continuation Lines', async () => {
  const text =
    "Package: desc-test\nVersion: 1.0\nDescription: Short desc\n" +
    " Long description line 1\n" +
    " Long description line 2\n\n";

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });

  const best = await reduceStreamToLatest(readable, null);

  assert.equal(best.size, 1);
  const desc = best.get("desc-test").get("description");
  assert.ok(desc.includes("Short desc"), "First line preserved");
  assert.ok(desc.includes("Long description line 1"), "Continuation line 1 preserved");
  assert.ok(desc.includes("Long description line 2"), "Continuation line 2 preserved");
});

