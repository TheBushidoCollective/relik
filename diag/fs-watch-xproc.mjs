// Standalone: one fs.watch watcher on one file, two appends in the same
// millisecond, one process. The first change event (L1) reaches the listener.
// On the first callback only, the listener appends L2 at once. The listener
// neither closes nor re-arms the watcher. Callbacks are counted over a 1 s
// settle, then the watcher is closed once.
//
// Why the counts should differ by runtime: Bun suppresses duplicate change
// events per handler. A repeat of the same path and event type that arrives
// within 1 ms of the last event emitted to that handler is dropped. L2 is
// appended inside the first callback, so its event falls inside that window.
//   bun-v1.4.3   src/runtime/node/path_watcher.rs:224-245 (ChangeEvent::should_emit)
//                suppresses only when hash and type both match and time_diff <= 1.
//   bun-v1.3.14  src/runtime/node/path_watcher.zig:134-150 (ChangeEvent.shouldEmit)
//                as written, `and` binds tighter than `or`, so it suppresses when
//                the type or the hash matches. Its comment says both. L2 matches
//                L1 on both, so either reading drops it.
//
// Expected on Linux: Bun 1.4.3 and 1.3.14 deliver one callback per iteration.
// Node 24 delivers two, one for L1 and one for L2.
//
// Outcome per iteration, from the callbacks seen:
//   two     some callback re-read the file and found both rows
//   single  one or more callbacks, and none found the second row
//   zero    no callback at all (the watcher did not see L1)
//
//   bun  diag/fs-watch-xproc.mjs [--iterations=50] [--out=run.jsonl]
//   node diag/fs-watch-xproc.mjs [--iterations=50] [--out=run.jsonl]
//
// Stdout: one JSON summary line. Stderr: one digit per iteration, the number of
// callbacks it saw. --out: one JSON line per iteration.
// The file name predates this design. The repro is now single-process.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ITERATIONS = 50;
const SETTLE_MS = 1000;
const USAGE = 'usage: bun|node diag/fs-watch-xproc.mjs [--iterations=N] [--out=FILE.jsonl]';

const runtime = process.versions.bun
  ? `bun-${process.versions.bun}-${Bun.revision}`
  : `node-${process.versions.node}`;

const now = () => performance.timeOrigin + performance.now();
const round3 = (x) => Math.round(x * 1000) / 1000;
const countRows = (text) => text.split('\n').filter((row) => row.length > 0).length;

const settle = () => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, SETTLE_MS);
  return promise;
};

async function runIteration(i, dir) {
  const file = join(dir, `iter-${i}.log`);
  writeFileSync(file, '');

  const rec = {
    iteration: i,
    first_append_ms: null,
    second_append_ms: null,
    callbacks: [],
    second_line_callback: false,
    outcome: null,
  };
  let secondAppended = false;

  const watcher = watch(file, { persistent: false }, () => {
    const at = now();
    const rows = countRows(readFileSync(file, 'utf8'));
    rec.callbacks.push({ at, rows });
    if (!secondAppended) {
      secondAppended = true;
      rec.second_append_ms = now();
      appendFileSync(file, 'L2\n');
    }
  });

  try {
    rec.first_append_ms = now();
    appendFileSync(file, 'L1\n');
    await settle();
  } finally {
    watcher.close();
  }

  rec.second_line_callback = rec.callbacks.some((c) => c.rows >= 2);
  if (rec.callbacks.length === 0) rec.outcome = 'zero';
  else rec.outcome = rec.second_line_callback ? 'two' : 'single';
  return rec;
}

function toOutput(rec) {
  const rel = (t) => (t == null ? null : round3(t - rec.first_append_ms));
  return {
    iteration: rec.iteration,
    outcome: rec.outcome,
    second_line_callback: rec.second_line_callback,
    second_append_ms: rel(rec.second_append_ms),
    callbacks: rec.callbacks.map((c) => ({ at_ms: rel(c.at), rows: c.rows })),
  };
}

function summarize(records, iterations) {
  const count = (outcome) => records.filter((r) => r.outcome === outcome).length;
  return {
    runtime,
    platform: `${process.platform} ${release()}`,
    iterations,
    single_callback_iterations: count('single'),
    two_callback_iterations: count('two'),
    zero_callback_iterations: count('zero'),
  };
}

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { iterations: DEFAULT_ITERATIONS, out: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? '' : arg.slice(eq + 1);
    if (key === '--iterations') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) fail(`--iterations needs a positive integer, got "${value}"`);
      opts.iterations = n;
    } else if (key === '--out' && value) {
      opts.out = value;
    } else {
      fail(`unrecognised argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), 'fs-watch-dedup-'));
  if (opts.out) writeFileSync(opts.out, '');
  const records = [];
  try {
    for (let i = 1; i <= opts.iterations; i++) {
      const rec = await runIteration(i, dir);
      records.push(rec);
      process.stderr.write(String(Math.min(9, rec.callbacks.length)));
      if (opts.out) appendFileSync(opts.out, `${JSON.stringify(toOutput(rec))}\n`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.stderr.write('\n');
  console.log(JSON.stringify(summarize(records, opts.iterations)));
}

main();
