// Standalone: close an fs.watch watcher, then immediately (same tick, and
// after one microtask) watch the same file again, append, and record whether
// the new watchers fire. This mirrors stdio-eof-path.ts waitForTrace, which
// closes its watcher in finish() and resolves, so the next stage's watchers
// are created on the following microtask. Prints one JSON line per scenario.
import { appendFileSync, mkdtempSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runtime = process.versions.bun
  ? `bun-${process.versions.bun}-${Bun.revision}`
  : `node-${process.versions.node}`;

const settle = () => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, 300);
  return promise;
};

async function scenario(name, rewatchDelay) {
  const dir = mkdtempSync(join(tmpdir(), 'fs-rewatch-'));
  const file = join(dir, 'trace.jsonl');
  writeFileSync(file, '');
  const counts = { first: 0, second: 0, third: 0 };
  const first = watch(file, { persistent: false }, () => {
    counts.first += 1;
  });
  appendFileSync(file, 'a\n');
  await settle();
  first.close();
  if (rewatchDelay === 'microtask') await Promise.resolve();
  if (rewatchDelay === 'macrotask') await settle();
  const second = watch(file, { persistent: false }, () => {
    counts.second += 1;
  });
  const third = watch(file, { persistent: false }, () => {
    counts.third += 1;
  });
  appendFileSync(file, 'b\n');
  await settle();
  appendFileSync(file, 'c\n');
  await settle();
  second.close();
  third.close();
  return {
    runtime,
    platform: process.platform,
    scenario: name,
    counts,
    rewatchedFired: counts.second > 0 && counts.third > 0,
  };
}

for (const [name, delay] of [
  ['same-tick', 'none'],
  ['after-microtask', 'microtask'],
  ['after-macrotask', 'macrotask'],
]) {
  console.log(JSON.stringify(await scenario(name, delay)));
}
