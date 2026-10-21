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
  entrypoints: [join(here, '../packages/relic-viewer/probe-boundary/browser-entry.ts')],
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
      if (!/^[\w.]+$/.test(name)) return new Response('no', { status: 400 });
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
  if (await evaluate<boolean>('Boolean(window.probeReady)')) break;
  await Bun.sleep(100);
}

// ---------- exact rational expectations ----------
type Q = { n: bigint; d: bigint };
const q = (n: number | bigint, d: number | bigint = 1): Q => ({
  n: BigInt(n),
  d: BigInt(d),
});
const mulQ = (a: Q, b: Q): Q => ({ n: a.n * b.n, d: a.d * b.d });
const divQ = (a: Q, b: Q): Q => ({ n: a.n * b.d, d: a.d * b.n });
const floorQ = (a: Q): number => {
  const f = a.n / a.d;
  return Number(a.n % a.d !== 0n && a.n < 0n ? f - 1n : f);
};
// Containing media frame of value/rate seconds on a media grid fps.
const expectedFrame = (value: Q, rate: Q, fps: Q): number =>
  floorQ(mulQ(divQ(value, rate), fps));

const R24 = q(24);
const R30 = q(30);
const R60 = q(60);
const R48 = q(48);
const R1 = q(1);
const R2997 = q(30000, 1001);
const R2398 = q(24000, 1001);
const num = (r: Q): number => Number(r.n) / Number(r.d);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

interface Spec {
  name: string;
  path: string;
  fps: Q;
  rate: Q;
  values: Q[];
  hidden?: boolean;
}
const specs: Spec[] = [
  {
    name: 'control 24 on 24fps mp4',
    path: '/media/fr24.mp4',
    fps: R24,
    rate: R24,
    values: range(48).map((k) => q(k)),
  },
  {
    name: 'control 24 on 24fps mp4 b-frames',
    path: '/media/fr24b.mp4',
    fps: R24,
    rate: R24,
    values: range(48).map((k) => q(k)),
  },
  {
    name: 'control 60 on 60fps mp4',
    path: '/media/fr60.mp4',
    fps: R60,
    rate: R60,
    values: range(60).map((k) => q(k)),
  },
  {
    name: 'control 29.97 on 29.97 mp4',
    path: '/media/fr2997.mp4',
    fps: R2997,
    rate: R2997,
    values: range(60).map((k) => q(k)),
  },
  {
    name: 'control 30 on 30fps webm',
    path: '/media/fr30.webm',
    fps: R30,
    rate: R30,
    values: range(60).map((k) => q(k)),
  },
  {
    name: 'control 24 on 24fps webm',
    path: '/media/fr24.webm',
    fps: R24,
    rate: R24,
    values: range(48).map((k) => q(k)),
  },
  {
    name: 'OTIO rate 24 on 60fps mp4',
    path: '/media/fr60.mp4',
    fps: R60,
    rate: R24,
    values: range(48).map((k) => q(k)),
  },
  {
    name: 'OTIO rate 24 on 48fps mp4',
    path: '/media/fr48.mp4',
    fps: R48,
    rate: R24,
    values: range(48).map((k) => q(k)),
  },
  {
    name: 'OTIO rate 30000/1001 on 24fps mp4',
    path: '/media/fr24.mp4',
    fps: R24,
    rate: R2997,
    values: range(59).map((k) => q(k)),
  },
  {
    name: 'OTIO rate 1 (k/24 s) on 24fps mp4',
    path: '/media/fr24.mp4',
    fps: R24,
    rate: R1,
    values: range(48).map((k) => q(k, 24)),
  },
  {
    name: 'OTIO rate 1 (k/8 s) on 24fps mp4',
    path: '/media/fr24.mp4',
    fps: R24,
    rate: R1,
    values: range(16).map((k) => q(k, 8)),
  },
  {
    name: 'OTIO rate 24 on 60fps mp4 hidden host',
    path: '/media/fr60.mp4',
    fps: R60,
    rate: R24,
    values: range(12).map((k) => q(k)),
    hidden: true,
  },
];

const rawCases = specs.map((s) => ({
  name: s.name,
  path: s.path,
  fps: num(s.fps),
  hidden: s.hidden ?? false,
  samples: s.values.map((v) => ({ value: num(v), rate: num(s.rate) })),
}));
const rawResults = await evaluate<
  {
    name: string;
    rows: {
      sample: { value: number; rate: number };
      exact: number;
      mid: number;
      atExact: { index: number | null; mediaTime: number | null };
      atMid: { index: number | null; mediaTime: number | null };
      atNaturalMid: { index: number | null; mediaTime: number | null };
    }[];
  }[]
>(`probeRaw(${JSON.stringify(rawCases)})`);

const summary: unknown[] = [];
for (const [i, result] of rawResults.entries()) {
  const spec = specs[i]!;
  let exactWrong = 0;
  let midWrong = 0;
  let naturalMidWrong = 0;
  const examples: unknown[] = [];
  let rvfc = 0;
  for (const [j, row] of result.rows.entries()) {
    const expected = expectedFrame(spec.values[j]!, spec.rate, spec.fps);
    const e = row.atExact.index !== expected;
    const m = row.atMid.index !== expected;
    if (row.atMid.mediaTime !== null) rvfc += 1;
    if (e) exactWrong += 1;
    if (m) midWrong += 1;
    if (row.atNaturalMid.index !== expected) naturalMidWrong += 1;
    if ((e || m) && examples.length < 4)
      examples.push({
        value: row.sample.value,
        rate: row.sample.rate,
        expected,
        exactSeek: row.exact,
        exactShown: row.atExact.index,
        midSeek: row.mid,
        midShown: row.atMid.index,
        midMediaTime: row.atMid.mediaTime,
      });
  }
  summary.push({
    case: spec.name,
    samples: result.rows.length,
    exact_seek_wrong: exactWrong,
    bf48a31_mid_seek_wrong: midWrong,
    natural_grid_mid_seek_wrong: naturalMidWrong,
    rvfc_reported: rvfc,
    examples,
  });
}
const rawReport = { chrome: version['product'], raw: summary };
await Bun.write(join(here, 'raw-results.json'), JSON.stringify(rawReport, null, 1));

// ---------- real viewer path ----------
type Json = Record<string, unknown>;
const RT = (value: number, rate: number): Json => ({
  OTIO_SCHEMA: 'RationalTime.1',
  value,
  rate,
});
const TR = (start: Json, duration: Json): Json => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: start,
  duration,
});
const clip = (
  id: string,
  source: Json,
  available: Json | null,
  url: string
): Json => ({
  OTIO_SCHEMA: 'Clip.1',
  name: id,
  metadata: { relic: { id } },
  source_range: source,
  media_reference: {
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: url,
    available_range: available,
  },
});
const timeline = (children: Json[]): string =>
  JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline_1' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: { relic: { id: 'stack_1' } },
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track_1' } },
          children,
        },
      ],
    },
  });
const r2398 = num(R2398);
const r2997 = num(R2997);

interface ViewerSpec {
  name: string;
  otio: string;
  media: Record<string, string>;
  times: { value: number; rate: number }[];
  expected: (number | null)[];
}
const viewerSpecs: ViewerSpec[] = [
  {
    name: 'viewer: 24-rate source on 24fps (control)',
    otio: timeline([
      clip(
        'c',
        TR(RT(0, 24), RT(48, 24)),
        TR(RT(0, 24), RT(48, 24)),
        'media/fr24.mp4'
      ),
    ]),
    media: { 'media/fr24.mp4': '/media/fr24.mp4' },
    times: range(48).map((k) => ({ value: k, rate: 24 })),
    expected: range(48),
  },
  {
    name: 'viewer: 24-rate source on 60fps (EDL-style rate)',
    otio: timeline([
      clip(
        'c',
        TR(RT(0, 24), RT(48, 24)),
        TR(RT(0, 24), RT(48, 24)),
        'media/fr60.mp4'
      ),
    ]),
    media: { 'media/fr60.mp4': '/media/fr60.mp4' },
    times: range(48).map((k) => ({ value: k, rate: 24 })),
    expected: range(48).map((k) => expectedFrame(q(k), R24, R60)),
  },
  {
    name: 'viewer: rate-1 (from_seconds) source on 24fps',
    otio: timeline([
      clip(
        'c',
        TR(RT(0, 1), RT(2, 1)),
        TR(RT(0, 1), RT(2, 1)),
        'media/fr24.mp4'
      ),
    ]),
    media: { 'media/fr24.mp4': '/media/fr24.mp4' },
    times: range(48).map((k) => ({ value: k / 24, rate: 1 })),
    expected: range(48),
  },
  {
    name: 'viewer: 29.97-rate source on 24fps (mixed-rates fixture shape)',
    otio: timeline([
      clip('c', TR(RT(0, r2997), RT(59, r2997)), null, 'media/fr24.mp4'),
    ]),
    media: { 'media/fr24.mp4': '/media/fr24.mp4' },
    times: range(59).map((k) => ({ value: k, rate: r2997 })),
    expected: range(59).map((k) => expectedFrame(q(k), R2997, R24)),
  },
  {
    name: 'viewer: strict negative, source 4@23.976 vs available 5@29.97',
    otio: timeline([
      clip(
        'c',
        TR(RT(4, r2398), RT(24, r2398)),
        TR(RT(5, r2997), RT(60, r2997)),
        'media/fr2997.mp4'
      ),
    ]),
    media: { 'media/fr2997.mp4': '/media/fr2997.mp4' },
    times: [0, 1, 2].map((k) => ({ value: k, rate: r2398 })),
    expected: [0, 1, 2].map((k) => expectedFrame(q(k), R2398, R2997)),
  },
  {
    name: 'viewer: strict negative, sequential drift 12@23.976 + 55@29.97',
    otio: timeline([
      clip(
        'a',
        TR(RT(0, r2398), RT(12, r2398)),
        TR(RT(0, r2398), RT(24, r2398)),
        'media/fr24.mp4'
      ),
      clip(
        'b',
        TR(RT(0, r2997), RT(55, r2997)),
        TR(RT(0, r2997), RT(90, r2997)),
        'media/fr2997.mp4'
      ),
      clip(
        'c',
        TR(RT(0, r2398), RT(24, r2398)),
        TR(RT(0, r2398), RT(24, r2398)),
        'media/fr24.mp4'
      ),
    ]),
    media: {
      'media/fr24.mp4': '/media/fr24.mp4',
      'media/fr2997.mp4': '/media/fr2997.mp4',
    },
    times: [56, 57].map((k) => ({ value: k, rate: r2398 })),
    expected: [0, 1].map((k) => expectedFrame(q(k), R2398, R24)),
  },
];
const viewerResults = await evaluate<
  {
    name: string;
    rows: { time: unknown; index: number | null; diagnostics: string[] }[];
  }[]
>(
  `probeViewer(${JSON.stringify(
    viewerSpecs.map(({ name, otio, media, times }) => ({
      name,
      otio,
      media,
      times,
    }))
  )})`
);
const viewerSummary = viewerResults.map((result, i) => {
  const spec = viewerSpecs[i]!;
  const wrong = result.rows
    .map((row, j) => ({ ...row, expected: spec.expected[j] }))
    .filter((row) => row.index !== row.expected);
  return {
    case: spec.name,
    samples: result.rows.length,
    wrong: wrong.length,
    examples: wrong.slice(0, 5),
  };
});
await Bun.write(join(here, 'viewer-results.json'), JSON.stringify({ viewer: viewerSummary }, null, 1));

const hidden = await evaluate<unknown>(`rvfcInHiddenHost('/media/fr24.mp4')`);
console.log(JSON.stringify({ chrome: version['product'], raw: summary.map((r) => { const v = r as Record<string, unknown>; return [v.case, v.samples, v.exact_seek_wrong, v.bf48a31_mid_seek_wrong, v.natural_grid_mid_seek_wrong]; }), viewer: viewerSummary.map((v) => [v.case, v.samples, v.wrong]), rvfc_hidden_decoder_host: hidden }, null, 1));
await Bun.write(join(here, 'results.json'), JSON.stringify({ ...rawReport, viewer: viewerSummary, rvfc_hidden_decoder_host: hidden }, null, 1));

await cdp.send('Browser.close').catch(() => {});
child.kill('SIGKILL');
server.stop(true);
process.exit(0);
