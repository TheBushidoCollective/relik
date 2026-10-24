// Standalone control for the stdio 0-2 class: does GC finalization of a dead
// Bun.spawn / node:child_process child whose stdin/stdout/stderr pipes were
// already consumed and closed ever close a recycled descriptor number?
// No extra stdio (index >= 3) anywhere, so the #30443 extra-pipe path is absent.
//
// Usage: bun bun-spawn-stdio-gc.mjs --retire=bun-spawn|node-cp --gc=on|off [--cycles=N]
import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const retireKind = args.get('retire') ?? 'bun-spawn';
const forceGc = (args.get('gc') ?? 'on') === 'on';
const cycles = Number(args.get('cycles') ?? '6');
const runtime = `bun-${Bun.version}-${Bun.revision.slice(0, 8)}`;

function census() {
  const table = new Map();
  for (let fd = 0; fd < 256; fd += 1) {
    try {
      const s = fstatSync(fd, { bigint: true });
      table.set(fd, `${s.dev}:${s.ino}:${(Number(s.mode) & 0o170000).toString(8)}`);
    } catch {}
  }
  return table;
}
function diff(before, after) {
  const closed = [];
  const opened = [];
  for (const [fd, id] of before) if (after.get(fd) !== id) closed.push(fd);
  for (const [fd, id] of after) if (before.get(fd) !== id) opened.push(fd);
  return { closed, opened };
}

// Retire one child with all three stdio pipes fully consumed and closed.
async function retireOne(ordinal) {
  const before = census();
  if (retireKind === 'bun-spawn') {
    const p = Bun.spawn(['/bin/sh', '-c', 'cat; echo err >&2'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const born = diff(before, census()).opened;
    p.stdin.write(`retire-${ordinal}\n`);
    p.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    registry.register(p, ordinal);
    return { born, ok: out === `retire-${ordinal}\n` && err === 'err\n' && code === 0 };
  }
  const c = spawn('/bin/sh', ['-c', 'cat; echo err >&2'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const born = diff(before, census()).opened;
  const out = [];
  const err = [];
  c.stdout.on('data', (d) => out.push(d));
  c.stderr.on('data', (d) => err.push(d));
  c.stdin.end(`retire-${ordinal}\n`);
  const code = await new Promise((r) => c.once('close', (x) => r(x)));
  registry.register(c, ordinal);
  return {
    born,
    ok:
      Buffer.concat(out).toString() === `retire-${ordinal}\n` &&
      Buffer.concat(err).toString() === 'err\n' &&
      code === 0,
  };
}

const report = { runtime, retireKind, forceGc, cycles, retired: [], victims: [] };
let collected = 0;
const registry = new FinalizationRegistry(() => { collected += 1; });
globalThis.__registry = registry;
for (let i = 1; i <= cycles; i += 1) {
  report.retired.push(await retireOne(i));
  await new Promise((r) => setTimeout(r, 20));

  // Victim: a live Bun.spawn child whose stdout pipe reuses the freed numbers
  // and is read only after the forced GC.
  const before = census();
  const victim = Bun.spawn(['/bin/sh', '-c', `sleep 0.2; echo victim-${i}`], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const born = diff(before, census()).opened;
  let gcDiff = null;
  if (forceGc) {
    const pre = census();
    Bun.gc(true);
    gcDiff = diff(pre, census());
  }
  await new Promise((r) => setTimeout(r, 0));
  const collectedSoFar = collected;
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3000));
  const read = Promise.all([new Response(victim.stdout).text(), victim.exited]);
  const outcome = await Promise.race([read, timeout]);
  victim.kill();
  const ok = Array.isArray(outcome) && outcome[0] === `victim-${i}\n` && outcome[1] === 0;
  report.victims.push({
    cycle: i,
    born,
    gcDiff,
    outcome: Array.isArray(outcome) ? { stdout: outcome[0], exit: outcome[1] } : outcome,
    ok,
    collectedSoFar,
  });
  if (!ok) break;
}
console.log(JSON.stringify(report));
