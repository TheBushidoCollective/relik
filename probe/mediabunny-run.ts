// Loopback-only browser probe driver. Serves probe/ on 127.0.0.1, launches
// headless Chrome over a debug pipe, runs raw-seek and real-viewer cases.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { connectPipe } from '../packages/relic-mcp/src/cover/cdp.ts';
import {
  chromeArgs,
  discoverChrome,
} from '../packages/relic-mcp/src/cover/chrome.ts';

const here = new URL('.', import.meta.url).pathname;
const built = await Bun.build({
  entrypoints: [join(here, '../packages/relic-viewer/probe-boundary/mediabunny-entry.ts')],
  target: 'browser',
  format: 'esm',
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  throw new Error('bundle failed');
}
const bundle = await built.outputs[0]!.text();

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') {
      return new Response(
        '<!doctype html><meta charset=utf-8><body><script type=module src=/probe.js></script></body>',
        { headers: { 'content-type': 'text/html' } }
      );
    }
    if (pathname === '/probe.js') {
      return new Response(bundle, {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    if (pathname.startsWith('/media/')) {
      const name = pathname.slice('/media/'.length);
      if (!/^[\w.-]+$/.test(name)) return new Response('no', { status: 400 });
      const bytes = await readFile(join(here, 'media', name));
      const type = name.endsWith('.webm') ? 'video/webm' : 'video/mp4';
      return new Response(bytes, { headers: { 'content-type': type } });
    }
    return new Response('not found', { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const found = await discoverChrome(undefined);
if (found.kind !== 'found') throw new Error(`no chrome: ${found.kind}`);
const profile = await mkdtemp(join(tmpdir(), 'otio-boundary-chrome-'));
const args = [
  ...chromeArgs(found.path, profile).map((arg) =>
    arg === '--proxy-bypass-list=<-loopback>'
      ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${server.port}`
      : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : arg
  ),
  '--autoplay-policy=no-user-gesture-required',
];
const child = spawn(found.path, args, {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
const toChrome = child.stdio[3];
const fromChrome = child.stdio[4];
if (!(toChrome instanceof Writable) || !(fromChrome instanceof Readable))
  throw new Error('no debug pipe');
const cdp = connectPipe(toChrome, fromChrome);
process.on('uncaughtException', (error) => { console.error(error); child.kill('SIGKILL'); server.stop(true); process.exit(1); });
const version = await cdp.send('Browser.getVersion');
const { targetId } = (await cdp.send('Target.createTarget', {
  url: 'about:blank',
})) as { targetId: string };
const { sessionId } = (await cdp.send('Target.attachToTarget', {
  targetId,
  flatten: true,
})) as { sessionId: string };
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
const loaded = cdp.waitForEvent('Page.loadEventFired', {
  sessionId,
  timeoutMs: 20000,
});
await cdp.send('Page.navigate', { url: `${origin}/` }, sessionId);
await loaded;

async function evaluate<T>(expression: string): Promise<T> {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, timeout: 600000 },
    sessionId
  );
  if (res['exceptionDetails'])
    throw new Error(JSON.stringify(res['exceptionDetails']));
  return (res['result'] as { value: T }).value;
}

for (let i = 0; i < 50; i += 1) {
  if (await evaluate<boolean>('Boolean(window.demuxProbeReady)')) break;
  await Bun.sleep(100);
}


const cases = [
 ['fr24.mp4', [0,1/24,4/24,7/24,1,47/24]],
 ['fr24b.mp4', [0,1/24,4/24,7/24,1,47/24]],
 ['fr60.mp4', [0,1/24,2/24,1,47/24]],
 ['fr2997.mp4', [0,1/(30000/1001),7/(30000/1001),1]],
 ['fr30.webm', [0,1/30,2/30,7/30,1,2.5]],
 ['fr24.webm', [0,1/24,2/24,7/24,1,47/24]],
 ['fr24b.mov', [0,1/24,7/24,1]],
 ['fr24b-offset.mov', [0,0.25,0.25+1/24,0.25+7/24,1]],
 ['fr24b-trimmed.mov', [0,1/24,7/24,0.5]],
 ['short-edit.mp4', [0,7/24,0.9,1,1.25,1.5]],
 ['rate-edit.mp4', [0,0.5,1]],
 ['loop-edit.mp4', [0,0.5,1,1.25,1.5]],
 ['vfr.mp4', [0,1/24,2/24,3/24,7/24,1,47/24]],
 ['vfr.webm', [0,1/24,2/24,3/24,7/24,1,47/24]],
];
const results = [];
for (const [name,times] of cases) {
 const expression = `probeDemux(${JSON.stringify('/media/'+name)},${JSON.stringify(times)})`;
 try { results.push(await evaluate(expression)); } catch (error) { results.push({path:name,error:String(error)}); }
}
const report = { package:'mediabunny@1.62.0', license:'MPL-2.0', chrome:version.product, cases:results, probeBundleBytes:new TextEncoder().encode(bundle).length };
await Bun.write(join(here, 'mediabunny-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({package:report.package,chrome:report.chrome,probeBundleBytes:report.probeBundleBytes,cases:results.map((r:any)=>({path:r.path,format:r.format,packets:r.packetCount,reads:r.readCalls,readBytes:r.readBytes,metadataOnly:r.allMetadataOnly,disposed:r.sourceDisposed,duration:r.videoDuration,warnings:r.warnings,error:r.error,rows:r.rows}))},null,1));
await cdp.send('Browser.close').catch(()=>{});
child.kill('SIGKILL');
server.stop(true);
process.exit(0);
