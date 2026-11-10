import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plainPath, SANDBOX_EXEC } from './confine.ts';
import { run } from './ramdisk.ts';

// Node 18-compatible, passed on the command line rather than written to disk.
const PROBE = String.raw`
const fs = require('fs'); const net = require('net'); const dgram = require('dgram'); const cp = require('child_process');
let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', async () => {
 const p=JSON.parse(input), r={};
 const attempt=(name,fn)=>{try { fn(); r[name]='ok'; } catch(e) {r[name]=e.code || 'error';}};
 attempt('inside',()=>{fs.writeFileSync(p.inside,'x'); if(fs.readFileSync(p.inside,'utf8')!=='x') throw Error();});
 attempt('outside',()=>fs.writeFileSync(p.outside,'x'));
 attempt('hosts',()=>fs.readFileSync('/private/etc/hosts'));
 attempt('home',()=>fs.readdirSync(p.home));
 for(const [name,bin] of [['true','/usr/bin/true'],['sh','/bin/sh']]) { const x=cp.spawnSync(bin, [], {timeout:3000}); r[name]=x.error ? x.error.code : x.status===0 ? 'ok' : 'error'; }
 const grand=cp.spawnSync(p.runtime,['-e',"try{require('fs').writeFileSync(process.argv[1],'x');console.log('ok')}catch(e){console.log(e.code)}",p.grand],{encoding:'utf8',timeout:3000});
 r.grand=grand.error ? grand.error.code : (grand.stdout || '').trim();
 r.tcp=await new Promise(resolve=>{const s=net.connect(p.tcp,'127.0.0.1'); const t=setTimeout(()=>{s.destroy();resolve('timeout')},2000); s.on('connect',()=>{clearTimeout(t);s.destroy();resolve('ok')});s.on('error',e=>{clearTimeout(t);resolve(e.code)});});
 r.udp=await new Promise(resolve=>{const s=dgram.createSocket('udp4');let done=false;const finish=e=>{if(done)return;done=true;try{s.close()}catch{}resolve(e ? e.code : 'ok')};s.on('error',finish);try{s.send(Buffer.from('x'),p.udp,'127.0.0.1',finish)}catch(e){finish(e)}});
 r.listen=await new Promise(resolve=>{const s=net.createServer(); s.on('error',e=>resolve(e.code));s.listen(0,'127.0.0.1',()=>s.close(()=>resolve('ok')));});
 console.log(JSON.stringify(r));
});`;

async function child(
  command: string,
  args: string[],
  config: object
): Promise<Record<string, string>> {
  return await new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      env: { PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('probe timeout'));
    }, 30_000);
    p.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.length > 16384) p.kill('SIGKILL');
    });
    p.stderr.on('data', (b: Buffer) => {
      err += b.toString();
      if (err.length > 16384) p.kill('SIGKILL');
    });
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('probe failed'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('probe output'));
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(config));
  });
}
export async function verifyJail({
  profile,
  ramRoot,
  runtime,
}: {
  profile: string;
  ramRoot: string;
  runtime?: string;
}): Promise<{ ok: boolean }> {
  if (process.platform !== 'darwin') return { ok: false };
  let outside: string | undefined;
  let inside: string | undefined;
  const tcp = createServer((s) => s.destroy());
  const udp = createSocket('udp4');
  let connections = 0;
  let datagrams = 0;
  tcp.on('connection', () => connections++);
  udp.on('message', () => datagrams++);
  try {
    const which =
      runtime === undefined ? await run('/usr/bin/which', ['node']) : undefined;
    if (which && which.code !== 0) return { ok: false };
    const node = plainPath(await realpath(runtime ?? which!.stdout.trim()));
    outside = await mkdtemp(join(tmpdir(), 'relic-jail-probe-'));
    inside = await mkdtemp(join(ramRoot, 'w', 'probe-'));
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(0, '127.0.0.1', resolve);
      }),
      new Promise<void>((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(0, '127.0.0.1', resolve);
      }),
    ]);
    const config = {
      inside: join(inside, 'inside'),
      outside: join(outside, 'outside'),
      grand: join(outside, 'grand'),
      home: homedir(),
      runtime: node,
      tcp: (tcp.address() as { port: number }).port,
      udp: udp.address().port,
    };
    const control = await child(node, ['-e', PROBE], config);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const keys = [
      'inside',
      'outside',
      'hosts',
      'home',
      'true',
      'sh',
      'grand',
      'tcp',
      'udp',
      'listen',
    ];
    if (
      !keys.every((k) => control[k] === 'ok') ||
      connections < 1 ||
      datagrams < 1
    )
      return { ok: false };
    await Promise.all([stat(config.outside), stat(config.grand)]);
    await rm(config.outside);
    await rm(config.grand);
    connections = 0;
    datagrams = 0;
    const ancestors: string[] = [];
    for (let p = dirname(node); p !== '/'; p = dirname(p))
      ancestors.push(`(literal "${plainPath(p)}")`);
    const appendix = `\n(allow process-exec (literal "${node}"))\n(allow file-read* file-map-executable (literal "${node}") (literal "/System/Volumes/Data${node}"))\n(allow file-read-metadata ${ancestors.join(' ')})`;
    const jailed = await child(
      SANDBOX_EXEC,
      ['-p', profile + appendix, node, '-e', PROBE],
      config
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const absent = async (path: string) => {
      try {
        await stat(path);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT';
      }
    };
    return {
      ok:
        jailed.inside === 'ok' &&
        keys
          .filter((k) => k !== 'inside')
          .every((k) => jailed[k] === 'EPERM') &&
        connections === 0 &&
        datagrams === 0 &&
        (await absent(config.outside)) &&
        (await absent(config.grand)),
    };
  } catch {
    return { ok: false };
  } finally {
    if (tcp.listening) tcp.close();
    try {
      udp.close();
    } catch {}
    if (outside) await rm(outside, { recursive: true, force: true });
    if (inside) await rm(inside, { recursive: true, force: true });
  }
}
