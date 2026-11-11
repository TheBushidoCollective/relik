import assert from 'node:assert/strict';

// Import the actual content implementation transpiled by the Bun test harness.
let source = '';
for await (const chunk of process.stdin) source += chunk;
assert.equal(process.versions.bun, undefined, 'the fixture requires Node');
const { CONTENT_BATCH_BYTES, createContentSink } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const sizes = JSON.parse(process.argv[2]);
assert.deepEqual(sizes, [
  0,
  1,
  65_519,
  65_520,
  CONTENT_BATCH_BYTES - 1,
  CONTENT_BATCH_BYTES,
  CONTENT_BATCH_BYTES + 1,
  40 * 1024 * 1024,
]);

let completed = 0;
for (const size of sizes) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + (i >>> 13)) & 255;
  const sink = createContentSink(size);
  for (let offset = 0; offset < size; offset += 65_519) {
    sink.write(bytes.slice(offset, Math.min(size, offset + 65_519)));
  }
  const content = await sink.finish();
  assert.equal(content.blob('text/plain').type, 'text/plain', `size ${size}`);
  completed++;
}
assert.equal(completed, 8);
console.log(`CONTENT_NODE_MIME_CASES=${completed}`);
