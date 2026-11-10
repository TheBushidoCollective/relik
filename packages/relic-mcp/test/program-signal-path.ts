import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProgramBrowser } from '../src/program/browser.ts';
import { run } from '../src/program/ramdisk.ts';

if (process.platform !== 'darwin') throw new Error('macOS required');
const shell = await resolveProgramBrowser(
  process.env['RELIC_OTIO_CHROME_PATH']
);
if (!shell.ok) throw new Error('owned shell missing');
const assets = await mkdtemp(join(tmpdir(), 'relic-signal-assets-'));
await writeFile(
  join(assets, 'index.html'),
  '<script src="/index.js"></script>'
);
await writeFile(
  join(assets, 'index.js'),
  'window.__relicProgram={protocol:1,render:()=>new Promise(()=>{})}'
);
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('./program-signal-child.ts', import.meta.url))],
  {
    env: { ...process.env, SIGNAL_SHELL: shell.path, SIGNAL_ASSET: assets },
    stdio: ['ignore', 'ignore', 'pipe'],
  }
);
const exited = new Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
let stderr = '';
child.stderr?.on('data', (chunk) => {
  stderr += String(chunk);
});
let mount = '';
let shellPid = 0;
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('signal fixture exited before browser: ' + stderr);
    const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
    for (const row of ps.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
      if (
        !match ||
        Number(match[2]) !== child.pid ||
        !match[3]!.startsWith(shell.path + ' ')
      )
        continue;
      const dir = /--user-data-dir=([^\s]+\/w\/relic-chrome-[^\s]+)/.exec(
        match[3]!
      );
      if (dir) {
        mount = dir[1]!.slice(0, dir[1]!.indexOf('/w/relic-chrome-'));
        shellPid = Number(match[1]);
        break;
      }
    }
    if (mount) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!mount || !shellPid)
    throw new Error('signal fixture never started its confined browser');
  child.kill('SIGTERM');
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('signal cleanup timed out')), 30000)
    ),
  ]);
  if (result.code !== 143)
    throw new Error(
      `unexpected signal exit: ${JSON.stringify(result)} ${stderr}`
    );
  const ps = await run('/bin/ps', ['-p', String(shellPid), '-o', 'pid=']);
  if (ps.code === 0 && ps.stdout.trim() !== '')
    throw new Error('browser survived signal cleanup');
  try {
    await stat(mount);
    throw new Error('RAM mount directory survived signal cleanup');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  console.log('PROGRAM_SIGNAL_PATH_OK');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await exited;
  }
  await rm(assets, { recursive: true, force: true });
}
