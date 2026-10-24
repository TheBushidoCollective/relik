// Standalone probe: node:child_process extra-stdio "pipe" fds (index >= 3)
// are double-owned in Bun <= 1.3.14 (net.connect({fd}) socket + Subprocess
// stdio_pipes). If the socket closes the fd first, the Subprocess finalizer
// closes the same number again on GC. This probe recycles that number into a
// second live child's CDP-like pipe, forces GC, and observes (a) the fd table
// across the GC call with fstat only (no fd allocation), and (b) whether the
// second child's echo round trip still completes.
//
// Usage: bun extra-stdio-gc.mjs [--gc=on|off] [--cycles=N]
//        node --expose-gc extra-stdio-gc.mjs [--gc=on|off] [--cycles=N]
import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const forceGc = (args.get('gc') ?? 'on') === 'on';
const cycles = Number(args.get('cycles') ?? '4');
const runtime = process.versions.bun
  ? `bun-${process.versions.bun}`
  : `node-${process.versions.node}`;

function census() {
  const table = new Map();
  for (let fd = 0; fd < 1024; fd += 1) {
    try {
      const s = fstatSync(fd);
      table.set(fd, `${s.dev}:${s.ino}:${(s.mode & 0o170000).toString(8)}`);
    } catch {
      // closed
    }
  }
  return table;
}

function diff(before, after) {
  const closed = [];
  const opened = [];
  const changed = [];
  for (const [fd, id] of before) {
    if (!after.has(fd)) closed.push({ fd, id });
    else if (after.get(fd) !== id) changed.push({ fd, from: id, to: after.get(fd) });
  }
  for (const [fd, id] of after) if (!before.has(fd)) opened.push({ fd, id });
  return { closed, opened, changed };
}

function runGc() {
  if (typeof Bun !== 'undefined') Bun.gc(true);
  else if (typeof globalThis.gc === 'function') globalThis.gc();
  else throw new Error('node needs --expose-gc');
}

// Spawn a child that echoes its fd 3 to its fd 4, exactly the extra-stdio
// shape a CDP pipe launcher uses: ['ignore','ignore','pipe','pipe','pipe'].
function spawnEcho() {
  return spawn('/bin/sh', ['-c', 'cat <&3 >&4'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
}

function roundTrip(child, payload, timeoutMs) {
  return new Promise((resolve) => {
    const toChild = child.stdio[3];
    const fromChild = child.stdio[4];
    const chunks = [];
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ outcome, received: Buffer.concat(chunks).toString('utf8') });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    fromChild.on('data', (c) => chunks.push(Buffer.from(c)));
    fromChild.on('end', () => finish('end'));
    fromChild.on('error', (e) => finish(`read_error:${e.code ?? e.message}`));
    toChild.on('error', (e) => finish(`write_error:${e.code ?? e.message}`));
    toChild.write(payload, (e) => {
      if (e) finish(`write_cb_error:${e.code ?? e.message}`);
    });
    toChild.end();
  });
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

// Retire one child: round trip, wait for exit, destroy both sockets (the
// cdp.dispose() shape), then drop every reference so only GC can reach it.
async function retireOne(ordinal) {
  const before = census();
  const child = spawnEcho();
  const born = diff(before, census()).opened.map((e) => e.fd);
  const rt = await roundTrip(child, `retire-${ordinal}\n`, 3000);
  const exit = await exited(child);
  child.stdio[3].destroy();
  child.stdio[4].destroy();
  child.stderr?.destroy();
  await new Promise((r) => setTimeout(r, 20));
  return { ordinal, born, rt, exit };
}

const report = { runtime, forceGc, cycles, retired: [], victims: [] };
for (let i = 1; i <= cycles; i += 1) {
  report.retired.push(await retireOne(i));

  const before = census();
  const victim = spawnEcho();
  const afterSpawn = census();
  const born = diff(before, afterSpawn).opened.map((e) => e.fd);
  let gcDiff = null;
  if (forceGc) {
    const pre = census();
    runGc();
    gcDiff = diff(pre, census());
  }
  const rt = await roundTrip(victim, `victim-${i}\n`, 3000);
  victim.kill('SIGKILL');
  const exit = await exited(victim);
  report.victims.push({ cycle: i, born, gcDiff, rt, exit });
  try {
    victim.stdio[3].destroy();
    victim.stdio[4].destroy();
  } catch {}
  if (rt.outcome !== 'end' || rt.received !== `victim-${i}\n`) break;
}
console.log(JSON.stringify(report, null, 1));
