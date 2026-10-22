// Standalone: two fs.watch watchers on one file. Close the first after its
// first event, then append again and record whether the second still fires.
// Prints one JSON line. Usage: bun fs-watch-shared-path.mjs
import { appendFileSync, mkdtempSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runtime = process.versions.bun
  ? `bun-${process.versions.bun}-${process.revision ?? Bun.revision}`
  : `node-${process.versions.node}`;
const dir = mkdtempSync(join(tmpdir(), 'fs-watch-shared-'));
const file = join(dir, 'trace.jsonl');
writeFileSync(file, '');

const counts = { a: 0, b: 0, solo: 0 };
const a = watch(file, { persistent: false }, () => {
  counts.a += 1;
});
const b = watch(file, { persistent: false }, () => {
  counts.b += 1;
});

const settle = () => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, 300);
  return promise;
};

appendFileSync(file, 'first\n');
await settle();
const beforeClose = { ...counts };
a.close();
appendFileSync(file, 'second\n');
await settle();
const afterClose = { ...counts };

// Control: a fresh watcher on the same path after the close.
const solo = watch(file, { persistent: false }, () => {
  counts.solo += 1;
});
appendFileSync(file, 'third\n');
await settle();
b.close();
solo.close();

console.log(
  JSON.stringify({
    runtime,
    platform: process.platform,
    beforeClose,
    afterClose,
    final: counts,
    survivorFiredAfterSiblingClose: afterClose.b > beforeClose.b,
    freshWatcherFired: counts.solo > 0,
  })
);
