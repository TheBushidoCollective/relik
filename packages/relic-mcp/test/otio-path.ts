/**
 * End-to-end OTIO review path proof.
 *
 *   bun packages/relic-mcp/test/otio-path.ts
 *
 * Publishes a real `.otiod` through a fresh bundled Node MCP process against
 * a loopback `createApp` backed by `MemoryStore` and `MemoryStorage`, decrypts
 * the stored ciphertext, checks the archive against the official OTIO reader,
 * opens the returned link in a fresh headless browser and measures decoded
 * pixels and simultaneous audio, posts a track-specific point and range
 * through the rendered UI, reads the encrypted feedback back through a second
 * fresh MCP process, and republishes a revision that the acknowledgement gate
 * accepts. Every network write targets loopback. Nothing here sends mail,
 * touches a vendor, or writes to GCS.
 *
 * The script ends with `OTIO_PATH_OK` only when the whole flow passed. A
 * wrong source offset or a wrong track identity must fail it.
 *
 * Prerequisites, all pinned:
 *   mise exec -- bun install --frozen-lockfile
 *   mise exec -- bun run --cwd packages/relic-mcp build
 *   uv run --with opentimelineio==0.18.1 python3 -c 'import opentimelineio'
 *   ffmpeg on PATH
 *   a headless Chrome, named by RELIC_OTIO_CHROME_PATH (falls back to
 *   RELIC_CHROME_PATH when that names an executable, never to a headed browser)
 *
 * RELIC_OTIO_PATH_CLIENT selects the MCP client: `source` (the built bundle,
 * the default) or `npx:<version>` for a published package.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeKey,
  deriveCommentKey,
  encryptComment,
  evaluateOtioAt,
  indexOtioZip,
  openRelic,
  readOtioDocument,
  resolveOtioAnchor,
  sourceSpansForOtioRange,
  type OtioAnchorV1,
  type OtioDocumentV1,
  type OtioTimeRange,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { loadPublishState } from '../src/state.ts';

const clientMode = process.env['RELIC_OTIO_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const fixtureDir = fileURLToPath(
  new URL(
    '../../relic-format/test/fixtures/otio/standard-sample.otiod/',
    import.meta.url
  )
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-path-'));
const statePath = join(scratch, 'state.json');
const shotDir = join(scratch, 'shots');

let fakeNow = Date.now();
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: { to: string; mail: OutboundMail }[] = [];

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async (to, mail) => {
      mails.push({ to, mail });
    },
  },
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  assert.ok(
    url.hostname === '127.0.0.1' || url.hostname === 'localhost',
    `non-loopback request reached the proof server: ${url.hostname}`
  );
  if (url.pathname.startsWith('/__storage/upload/') && request.method === 'PUT') {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
};

function resolveCommand(): string[] {
  if (isNpxMode) return ['npx', '-y', `relic-mcp@${clientMode.slice(4)}`];
  return ['node', relicMcpBundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(resolveCommand(), {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CHROME_PATH: 'none',
      RELIC_CLIENT_NAME: 'relic-mcp/otio-path',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, `relic-mcp exited ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.ok(lines.length > 0, 'no JSON-RPC response from relic-mcp');
  const response = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<
    string,
    unknown
  >;
  assert.ok(
    !response['error'],
    `JSON-RPC error from ${toolName}: ${JSON.stringify(response['error'])}`
  );
  const result = response['result'] as Record<string, unknown>;
  assert.ok(
    !result['isError'],
    `tool error from ${toolName}: ${JSON.stringify(result['content'])}`
  );
  return (result['structuredContent'] ?? {}) as Record<string, unknown>;
}

function inflateEntry(data: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.inflateSync(data));
}

interface ChromeSession {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  screenshot(label: string): Promise<void>;
  close(): Promise<void>;
}

async function openBrowser(url: string): Promise<ChromeSession> {
  const named =
    process.env['RELIC_OTIO_CHROME_PATH'] ?? process.env['RELIC_CHROME_PATH'];
  const found = await discoverChrome(
    named && named !== 'none' && named !== 'disabled' ? named : undefined
  );
  assert.equal(
    found.kind,
    'found',
    `no headless Chrome: ${found.kind === 'not_found' ? found.detail : found.kind}`
  );
  if (found.kind !== 'found') throw new Error('unreachable');

  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-chrome-'));
  const child = spawn(found.path, [...chromeArgs(found.path, profile)], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  assert.ok(toChrome && fromChrome, 'Chrome did not expose the debug pipe');
  const cdp = connectPipe(toChrome, fromChrome);

  const version = await cdp.send('Browser.getVersion');
  const product = String(version['product'] ?? '');
  assert.ok(
    /headless/i.test(product) || found.path.includes('headless'),
    `browser is not headless: ${product} at ${found.path}`
  );

  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const loaded = cdp.waitForEvent('Page.loadEventFired', {
    sessionId,
    timeoutMs: 20000,
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;

  return {
    send: (method, params, sid) => cdp.send(method, params, sid ?? sessionId),
    async evaluate<T>(expression: string): Promise<T> {
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      const inner = res['result'] as
        | { value?: T; description?: string }
        | undefined;
      const exception = res['exceptionDetails'] as
        | { text?: string }
        | undefined;
      assert.ok(
        !exception,
        `page evaluation failed: ${exception?.text ?? JSON.stringify(res)}`
      );
      return inner?.value as T;
    },
    async screenshot(label: string): Promise<void> {
      const shot = (await cdp.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sessionId
      )) as { data: string };
      await writeFile(join(shotDir, `${label}.png`), Buffer.from(shot.data, 'base64'));
    },
    async close(): Promise<void> {
      await cdp.send('Browser.close').catch(() => {});
      child.kill('SIGKILL');
      cdp.dispose();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function officialArchiveCheck(archive: Uint8Array): Promise<void> {
  const archivePath = join(scratch, 'published.otioz');
  await writeFile(archivePath, archive);
  const script = [
    'import json, sys',
    'import opentimelineio as otio',
    'tl = otio.adapters.read_from_file(sys.argv[1])',
    'assert tl.name == "Relik Feature Editorial", tl.name',
    'print(json.dumps({"name": tl.name, "tracks": len(tl.tracks)}))',
  ].join('\n');
  const scriptPath = join(scratch, 'official-read.py');
  await writeFile(scriptPath, script);
  const child = Bun.spawn(
    ['uv', 'run', '--with', 'opentimelineio==0.18.1', 'python3', scriptPath, archivePath],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(
    exit,
    0,
    `official OTIO reader rejected the published archive: ${stderr}`
  );
  const parsed = JSON.parse(stdout) as { name: string; tracks: number };
  assert.equal(parsed.name, 'Relik Feature Editorial');
  assert.ok(parsed.tracks >= 2, `expected multiple tracks, got ${parsed.tracks}`);
 }

 interface OfficialHit {
   readonly track_id: string | null;
   readonly item_id: string | null;
   readonly schema: string;
   readonly media: string | null;
   readonly source: { readonly value: number; readonly rate: number } | null;
   readonly file: { readonly value: number; readonly rate: number } | null;
   readonly frame: number | null;
   readonly timeline_start: number | null;
   readonly timeline_end: number | null;
 }

 interface OfficialOracle {
   readonly at_200: readonly OfficialHit[];
   readonly v1_60_90: readonly OfficialHit[];
   readonly duplicates: readonly { readonly name: string; readonly ids: readonly string[] }[];
   readonly nested_dissolves: readonly {
     readonly item_id: string | null;
     readonly track_id: string | null;
     readonly timeline_start: number;
     readonly timeline_end: number;
     readonly rate: number;
   }[];
   readonly spill_time: { readonly value: number; readonly rate: number } | null;
   readonly spill_hits: readonly OfficialHit[];
   readonly black_time: { readonly value: number; readonly rate: number } | null;
   readonly hold: {
     readonly track_id: string | null;
     readonly time: { readonly value: number; readonly rate: number };
     readonly frame: number;
   } | null;
 }

 async function officialTimingOracle(content: Uint8Array): Promise<OfficialOracle> {
   const otioPath = join(scratch, 'content.otio');
   await writeFile(otioPath, content);
   const script = `
 import json, sys
 import opentimelineio as otio
 assert otio.__version__ == "0.18.1", otio.__version__
 tl = otio.adapters.read_from_file(sys.argv[1])
 stack = tl.tracks

 def rid(item):
     relic = (item.metadata or {}).get("relic") or {}
     return relic.get("id")

 def rat(value):
     return {"value": value.value, "rate": value.rate}

 def later(a, b):
     return a if a > b else b

 def earlier(a, b):
     return a if a < b else b

 def file_time(clip, source):
     ref = clip.media_reference
     origin = 0.0
     if ref is not None and getattr(ref, "available_range", None) is not None:
         origin = ref.available_range.start_time.rescaled_to(source.rate).value
     return {"value": source.value - origin, "rate": source.rate}

 def media_of(clip, source):
     ref = clip.media_reference
     if isinstance(ref, otio.schema.ImageSequenceReference):
         local = source.rescaled_to(ref.rate)
         frame = int(ref.start_frame + local.value * ref.frame_step)
         padded = str(frame).zfill(ref.frame_zero_padding)
         return f"{ref.target_url_base}{ref.name_prefix}{padded}{ref.name_suffix}", frame
     if ref is not None:
         return getattr(ref, "target_url", None), None
     return None, None

 def hit(item, source, timeline_start, timeline_end):
     media, frame = (None, None)
     file_at = None
     if isinstance(item, otio.schema.Clip) and source is not None:
         media, frame = media_of(item, source)
         file_at = file_time(item, source)
     parent = item.parent()
     return {
         "track_id": rid(parent) if parent is not None else None,
         "item_id": rid(item),
         "schema": item.schema_name(),
         "media": media,
         "source": None if source is None else rat(source),
         "file": file_at,
         "frame": frame,
         "timeline_start": None if timeline_start is None else timeline_start.value,
         "timeline_end": None if timeline_end is None else timeline_end.value,
     }

 def active_at(item, when):
     found = []
     if isinstance(item, otio.schema.Clip):
         try:
             local = stack.transformed_time(when, item)
             trimmed = item.trimmed_range()
             if trimmed.start_time <= local < trimmed.end_time_exclusive():
                 parent = item.parent()
                 placed = item.range_in_parent()
                 start = parent.transformed_time(placed.start_time, stack)
                 end = parent.transformed_time(placed.end_time_exclusive(), stack)
                 found.append(hit(item, local, start, end))
         except Exception:
             pass
     if isinstance(item, (otio.schema.Stack, otio.schema.Track)):
         for child in item:
             found.extend(active_at(child, when))
     return found

 def overlapping(item, start, end, into):
     if isinstance(item, otio.schema.Transition):
         parent = item.parent()
         placed = item.range_in_parent()
         try:
             a = parent.transformed_time(placed.start_time, stack)
             b = parent.transformed_time(placed.end_time_exclusive(), stack)
         except Exception:
             return
         if b <= start or a >= end:
             return
         into.append(hit(item, None, later(a, start), earlier(b, end)))
         return
     if isinstance(item, otio.schema.Clip):
         parent = item.parent()
         placed = item.range_in_parent()
         try:
             a = parent.transformed_time(placed.start_time, stack)
             b = parent.transformed_time(placed.end_time_exclusive(), stack)
         except Exception:
             return
         if b <= start or a >= end:
             return
         left = later(a, start)
         right = earlier(b, end)
         into.append(hit(item, stack.transformed_time(left, item), left, right))
         return
     if isinstance(item, (otio.schema.Stack, otio.schema.Track)):
         for child in item:
             overlapping(child, start, end, into)

 names = {}
 def collect_tracks(item):
     if isinstance(item, otio.schema.Track):
         names.setdefault(item.name, []).append(rid(item))
         for child in item:
             collect_tracks(child)
     elif isinstance(item, otio.schema.Stack):
         for child in item:
             collect_tracks(child)
 collect_tracks(stack)
 v1 = None
 for child in stack:
     if rid(child) == "track-v1-main":
         v1 = child
 if v1 is None:
     raise SystemExit("official reader found no track-v1-main")
 query_start = otio.opentime.RationalTime(60, 24)
 query_end = otio.opentime.RationalTime(90, 24)
 spans = []
 overlapping(v1, query_start, query_end, spans)

 def walk_transitions(item):
     found = []
     if isinstance(item, otio.schema.Transition):
         parent = item.parent()
         placed = item.range_in_parent()
         start = parent.transformed_time(placed.start_time, stack)
         end = parent.transformed_time(placed.end_time_exclusive(), stack)
         found.append({
             "item_id": rid(item),
             "track_id": rid(parent),
             "nested": parent is not None and parent.parent() is not stack,
             "timeline_start": start.value,
             "timeline_end": end.value,
             "rate": start.rate,
         })
         return found
     if isinstance(item, (otio.schema.Stack, otio.schema.Track)):
         for child in item:
             found.extend(walk_transitions(child))
     return found

 nested_dissolves = [item for item in walk_transitions(stack) if item["nested"]]

 def find_named(item, wanted):
     if rid(item) == wanted:
         return item
     if isinstance(item, (otio.schema.Stack, otio.schema.Track)):
         for child in item:
             found = find_named(child, wanted)
             if found is not None:
                 return found
     return None

 spill_time = None
 submaster = find_named(stack, "stack-vfx-submaster")
 if submaster is not None:
     parent = submaster.parent()
     placed = submaster.range_in_parent()
     start = parent.transformed_time(placed.start_time, stack)
     if start.value > 0:
         spill_time = otio.opentime.RationalTime(start.value - 1, start.rate)

 black_time = None
 limit = int(stack.trimmed_range().duration.rescaled_to(24).value)
 for frame in range(limit):
     when = otio.opentime.RationalTime(frame, 24)
     if not active_at(stack, when):
         black_time = rat(when)
         break

 hold = None
 def find_sequences(item):
     found = []
     if isinstance(item, otio.schema.Clip) and isinstance(item.media_reference, otio.schema.ImageSequenceReference):
         found.append(item)
     if isinstance(item, (otio.schema.Stack, otio.schema.Track)):
         for child in item:
             found.extend(find_sequences(child))
     return found
 sequences = find_sequences(stack)
 if sequences:
     clip = next((item for item in sequences if rid(item.parent()) == "track-nested-plate-base"), sequences[0])
     ref = clip.media_reference
     trimmed = clip.trimmed_range()
     last_source = trimmed.end_time_exclusive() - otio.opentime.RationalTime(1, trimmed.duration.rate)
     when = clip.transformed_time(last_source, stack)
     local = last_source.rescaled_to(ref.rate)
     last = int(ref.start_frame + local.value * ref.frame_step)
     hold = {"track_id": rid(clip.parent()), "time": rat(when), "frame": last}

 print(json.dumps({
     "at_200": active_at(stack, otio.opentime.RationalTime(200, 24)),
     "v1_60_90": spans,
     "duplicates": [{"name": name, "ids": ids} for name, ids in names.items() if len([i for i in ids if i]) > 1],
     "nested_dissolves": nested_dissolves,
     "spill_time": None if spill_time is None else rat(spill_time),
     "spill_hits": [] if spill_time is None else active_at(stack, spill_time),
     "black_time": black_time,
     "hold": hold,
 }))
 `;
   const scriptPath = join(scratch, 'official-timing.py');
   await writeFile(scriptPath, script);
   const child = Bun.spawn(
     ['uv', 'run', '--with', 'opentimelineio==0.18.1', 'python3', scriptPath, otioPath],
     { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } }
   );
   const [stdout, stderr, exit] = await Promise.all([
     new Response(child.stdout).text(),
     new Response(child.stderr).text(),
     child.exited,
   ]);
   assert.equal(exit, 0, `official timing oracle failed: ${stderr}`);
   return JSON.parse(stdout) as OfficialOracle;
 }
const POINT_FRAME = 36;
const POINT_RATE = 24;
const RANGE_START_FRAME = 36;
const RANGE_END_FRAME = 48;

try {
  await Bun.spawn(['mkdir', '-p', shotDir]).exited;

  // 1. Publish the real fixture directory through a fresh MCP process.
  const published = await callMcp('relic_publish', {
    path: fixtureDir,
    title: 'Relik Feature Editorial',
    cover: false,
  });
  const relicId = String(published['relic_id']);
  const shareUrl = String(published['url'] ?? published['link'] ?? '');
  assert.ok(relicId, 'publish returned no relic_id');
  assert.ok(shareUrl.includes('#'), 'publish returned no keyed link');
  console.log(`PUBLISHED relic_id=${relicId}`);

  // 2. The store holds ciphertext. Decrypt it locally and check the archive.
  const stored = await storage.read(relicId);
  assert.ok(stored, 'nothing stored for the published relic');
  process.env['RELIC_PUBLISH_STATE'] = statePath;
  const localState = await loadPublishState(relicId);
  assert.ok(localState, 'local publish state missing');
  const key = decodeKey(localState.key);
  const opened = await openRelic(stored, key);
  const archive = opened.content;
  const index = await indexOtioZip(archive, { inflater: inflateEntry });
  assert.equal(index.versionText.trim(), '1.0.0');
  assert.ok(index.entries.has('content.otio'), 'archive lacks content.otio');
  const document = readOtioDocument(index.contentOtioBytes);
  assert.equal(document.version, 1);
  console.log(`DECRYPTED bytes=${archive.length} sha256=${index.contentSha256}`);

  // 3. The official reader accepts the archive we stored.
  await officialArchiveCheck(archive);
  console.log('OFFICIAL_READER ok');
  const oracle = await officialTimingOracle(index.contentOtioBytes);
  console.log(`OFFICIAL_ORACLE t200=${oracle.at_200.length} v1=${oracle.v1_60_90.length}`);

  // 4. Open the link and measure decoded playback.
  const browser = await openBrowser(shareUrl);
  let selectedTrackId = '';
  let duplicateTrackId = '';
  let nestedPointTrack = '';
  let nestedRangeTrack = '';
  try {
    const ready = await browser.evaluate<boolean>(
      `(() => {
        const { promise, resolve } = Promise.withResolvers();
        const start = Date.now();
        const tick = () => {
          if (document.querySelector('.otio-view[data-ready="true"]')) resolve(true);
          else if (Date.now() - start > 15000) resolve(false);
          else setTimeout(tick, 100);
        };
        tick();
        return promise;
      })()`
    );
    assert.equal(ready, true, 'OTIO view never reported ready');

    const pixel = await browser.evaluate<{ r: number; g: number; b: number }>(
      `(() => {
        const canvas = document.querySelector('canvas.otio-canvas');
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        return { r: data[0], g: data[1], b: data[2] };
      })()`
    );
    assert.ok(pixel, 'no decoded canvas to sample');
    const isBlack = pixel.r === 0 && pixel.g === 0 && pixel.b === 0;
    assert.equal(
      isBlack,
      false,
      'decoded frame at the playhead is black; playback did not composite a source'
    );
    await browser.screenshot('desktop-light');
    console.log(`DECODED pixel=${pixel.r},${pixel.g},${pixel.b}`);

    // 5. Select a specific track by id, then a point, then a range.
    const expectedTrackId = Object.values(document.nodes).find(
      (node) => node.schema.startsWith('Track') && node.name === 'Video 1'
    )?.id;
    assert.ok(expectedTrackId, 'fixture has no Video 1 track');
    selectedTrackId = await browser.evaluate<string>(
      `(() => {
        const select = document.querySelector('select.otio-track-select');
        select.value = ${JSON.stringify(expectedTrackId)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return select.value;
      })()`
    );
    assert.equal(
      selectedTrackId,
      expectedTrackId,
      'track selector did not accept the requested track id'
    );
    await browser.evaluate<void>(
      `(() => {
        document.querySelector('button[data-otio-mode="point"]').click();
        const input = document.querySelector('.otio-selection-in');
        input.value = '${POINT_FRAME}';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    );
    const pointSelection = await browser.evaluate<{
      track: string;
      start: string;
      duration: string;
    }>(
      `(() => {
        const mark = document.querySelector('.otio-selection');
        return { track: mark.dataset.trackId, start: mark.dataset.start, duration: mark.dataset.duration };
      })()`
    );
    assert.equal(pointSelection.track, selectedTrackId, 'point landed on the wrong track');
    assert.equal(pointSelection.duration, '0', 'a point must have zero duration');

    await browser.evaluate<void>(
      `(() => {
        document.querySelector('button[data-otio-mode="range"]').click();
        const start = document.querySelector('.otio-selection-in');
        const end = document.querySelector('.otio-selection-out');
        start.value = '${RANGE_START_FRAME}';
        end.value = '${RANGE_END_FRAME}';
        for (const input of [start, end]) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`
    );
    const rangeSelection = await browser.evaluate<{
      track: string;
      duration: string;
    }>(
      `(() => {
        const mark = document.querySelector('.otio-selection');
        return { track: mark.dataset.trackId, duration: mark.dataset.duration };
      })()`
    );
    assert.equal(rangeSelection.track, selectedTrackId);
    assert.equal(
      rangeSelection.duration,
      String(RANGE_END_FRAME - RANGE_START_FRAME),
      'range duration does not match the frames selected'
    );
    console.log(`SELECTED track=${selectedTrackId} range=${RANGE_START_FRAME}-${RANGE_END_FRAME}`);
    const picked = await browser.evaluate<{
      duplicate: string;
      nestedPoint: string;
      nestedRange: string;
      nestedStart: string;
      nestedDuration: string;
    }>(
      `(() => {
        const select = document.querySelector('select.otio-track-select');
        const pick = (id, mode, start, end) => {
          select.value = id;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('button[data-otio-mode="' + mode + '"]').click();
          const inn = document.querySelector('.otio-selection-in');
          const out = document.querySelector('.otio-selection-out');
          inn.value = String(start);
          out.value = String(end);
          inn.dispatchEvent(new Event('change', { bubbles: true }));
          out.dispatchEvent(new Event('change', { bubbles: true }));
          const mark = document.querySelector('.otio-selection');
          return mark ? mark.dataset.trackId + '|' + mark.dataset.start + '|' + mark.dataset.duration : '';
        };
        const duplicate = pick('track-v2-duplicate', 'point', 0, 0);
        const point = pick('track-nested-plate-base', 'point', 200, 200);
        const range = pick('track-nested-fx-glow', 'range', 200, 208);
        const [nestedRange, nestedStart, nestedDuration] = range.split('|');
        return {
          duplicate: duplicate.split('|')[0],
          nestedPoint: point.split('|')[0],
          nestedRange,
          nestedStart,
          nestedDuration,
        };
      })()`
    );
    duplicateTrackId = picked.duplicate;
    nestedPointTrack = picked.nestedPoint;
    nestedRangeTrack = picked.nestedRange;
    assert.equal(duplicateTrackId, 'track-v2-duplicate', 'duplicate name resolved to the wrong track id');
    assert.equal(nestedPointTrack, 'track-nested-plate-base');
    assert.equal(nestedRangeTrack, 'track-nested-fx-glow');
    assert.equal(picked.nestedStart, '200');
    assert.equal(picked.nestedDuration, '8');
    const audioReady = await browser.evaluate<number>(
      `(() => {
        const { promise, resolve } = Promise.withResolvers();
        const seek = document.querySelector('input.otio-seek');
        seek.value = '${RANGE_START_FRAME}';
        seek.dispatchEvent(new Event('input', { bubbles: true }));
        seek.dispatchEvent(new Event('change', { bubbles: true }));
        const start = Date.now();
        const tick = () => {
          const ready = [...document.querySelectorAll('audio')].filter((node) => node.readyState >= 2).length;
          if (ready >= 2 || Date.now() - start > 10000) resolve(ready);
          else setTimeout(tick, 100);
        };
        tick();
        return promise;
      })()`
    );
    assert.ok(
      audioReady >= 2,
      'decoded playback did not expose two ready audio elements after seek'
    );
    console.log(`AUDIO ready=${audioReady}`);
    for (const [width, scheme] of [
      [1440, 'light'],
      [390, 'light'],
      [1440, 'dark'],
      [390, 'dark'],
    ] as const) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await browser.screenshot(`${width}-${scheme}`);
    }
    await browser.screenshot('desktop-selected');
  } finally {
    await browser.close();
  }

  // 6. Post the track-specific feedback the UI selected, encrypted.
  const cookie = await (async () => {
    const token = `otio-path-token-${Math.random()}`;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token)
    );
    const tokenHash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    await store.putSession({
      tokenHash,
      email: 'reader@example.test',
      createdAt: fakeNow,
      expiresAt: fakeNow + 3600 * 1000,
    });
    return `relic_session=${token}`;
  })();

  const range: OtioTimeRange = {
    start_time: { value: RANGE_START_FRAME, rate: POINT_RATE },
    duration: {
      value: RANGE_END_FRAME - RANGE_START_FRAME,
      rate: POINT_RATE,
    },
  };
  const anchor: OtioAnchorV1 = {
    kind: 'otio',
    v: 1,
    relic_version: 1,
    document_sha256: document.document_sha256,
    timeline_id: document.timeline_ids[0] ?? '',
    track_id: selectedTrackId,
    range,
    snapshot: { timeline: 'Relik Feature Editorial', track: 'Video 1', item: null },
  };
  const commentKey = await deriveCommentKey(key);
  const ciphertext = await encryptComment(commentKey, {
    body: 'Grade correction on the primary track',
    display_name: null,
    anchor,
  });
  assert.equal(ciphertext.includes('primary_a.mp4'), false);
  assert.equal(ciphertext.includes('Grade correction'), false);
  const posted = await fetch(`${origin}/api/relics/${relicId}/comments`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.20',
    },
    body: JSON.stringify({ ciphertext }),
  });
  assert.equal(posted.status, 201, 'posting the OTIO comment failed');
  const postedBody = (await posted.json()) as { comment_id: string };
  console.log(`COMMENTED comment_id=${postedBody.comment_id}`);
  const nestedPosts: { id: string; track: string; start: number; duration: number }[] = [];
  for (const item of [
    { track: nestedPointTrack, start: 200, duration: 0, body: 'Plate point at 200' },
    { track: nestedRangeTrack, start: 200, duration: 8, body: 'Flare range at 200' },
  ]) {
    const nestedAnchor: OtioAnchorV1 = {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: document.document_sha256,
      timeline_id: document.timeline_ids[0] ?? '',
      track_id: item.track,
      range: {
        start_time: { value: item.start, rate: POINT_RATE },
        duration: { value: item.duration, rate: POINT_RATE },
      },
      snapshot: { timeline: 'Relik Feature Editorial', track: item.track, item: null },
    };
    const nestedCiphertext = await encryptComment(commentKey, {
      body: item.body,
      display_name: null,
      anchor: nestedAnchor,
    });
    const nestedPosted = await fetch(`${origin}/api/relics/${relicId}/comments`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.21',
      },
      body: JSON.stringify({ ciphertext: nestedCiphertext }),
    });
    assert.equal(nestedPosted.status, 201, `nested comment on ${item.track} failed`);
    const nestedBody = (await nestedPosted.json()) as { comment_id: string };
    nestedPosts.push({
      id: nestedBody.comment_id,
      track: item.track,
      start: item.start,
      duration: item.duration,
    });
  }

  // 7. The stored row is ciphertext. No anchor label or source path leaks.
  const listed = (await (
    await fetch(`${origin}/api/relics/${relicId}/comments`)
  ).json()) as Array<Record<string, unknown>>;
  const row = listed.find((entry) => entry['comment_id'] === postedBody.comment_id);
  assert.ok(row, 'posted comment missing from the list');
  const storedText = JSON.stringify(row);
  assert.equal(storedText.includes('media/primary_a.mp4'), false);
  assert.equal(storedText.includes('track-v1-main'), false);
  assert.equal(typeof row['ciphertext'], 'string');

  // 8. A fresh MCP process reads the original source context back.
  const read = await callMcp('relic_read_comments', {
    relic_id: relicId,
    version: '*',
    resolve_anchors: true,
  });
  const comments = read['comments'] as Array<Record<string, unknown>>;
  const echoed = comments.find(
    (entry) => entry['comment_id'] === postedBody.comment_id
  );
  assert.ok(echoed, 'fresh MCP process did not return the posted comment');
  const echoedAnchor = echoed['anchor'] as OtioAnchorV1;
  assert.equal(echoedAnchor.kind, 'otio');
  assert.equal(echoedAnchor.track_id, anchor.track_id);
  assert.equal(echoedAnchor.range.start_time.value, RANGE_START_FRAME);
  assert.equal(
    echoedAnchor.range.duration.value,
    RANGE_END_FRAME - RANGE_START_FRAME
  );


  for (const item of nestedPosts) {
    const echoedNested = comments.find((entry) => entry['comment_id'] === item.id);
    assert.ok(echoedNested, `fresh MCP process missed nested comment ${item.id}`);
    const nestedEcho = echoedNested['anchor'] as OtioAnchorV1;
    assert.equal(nestedEcho.track_id, item.track);
    assert.equal(nestedEcho.range.start_time.value, item.start);
    assert.equal(nestedEcho.range.duration.value, item.duration);
  }
  console.log(`NESTED_READBACK count=${nestedPosts.length}`);

  const plate = oracle.at_200.find((hit) => hit.media?.endsWith('plate_1009.png'));
  const flare = oracle.at_200.find(
    (hit) => hit.media === 'media/fx_flare.webm' && hit.source?.value === 8 && hit.source.rate === 24
  );
  assert.ok(plate, `official t200 missed plate 1009: ${JSON.stringify(oracle.at_200)}`);
  assert.ok(flare, `official t200 missed flare source 8: ${JSON.stringify(oracle.at_200)}`);
  const handleA = oracle.v1_60_90.find((hit) => hit.media === 'media/primary_a.mp4');
  const handleB = oracle.v1_60_90.find((hit) => hit.media === 'media/secondary_b.mp4');
  const dissolve = oracle.v1_60_90.find((hit) => hit.schema.startsWith('Transition'));
  assert.equal(handleA?.file?.value, 84);
  assert.equal(handleA?.timeline_start, 60);
  assert.equal(handleA?.timeline_end, 84);
  assert.equal(handleB?.file?.value, 12);
  assert.equal(handleB?.timeline_start, 60);
  assert.equal(handleB?.timeline_end, 90);
  assert.equal(dissolve?.timeline_start, 60);
  assert.equal(dissolve?.timeline_end, 84);
  const videoTwo = oracle.duplicates.find((row) => row.name === 'Video 2');
  assert.deepEqual([...(videoTwo?.ids ?? [])].sort(), ['track-v2-duplicate', 'track-v2-main']);
  assert.ok(oracle.nested_dissolves.length > 0, 'official archive has no hierarchical nested dissolve');
  assert.ok(oracle.spill_time, 'official archive has no time just outside the nested stack');
  assert.equal(
    oracle.spill_hits.some((hit) => hit.media?.includes('plate_') || hit.media === 'media/fx_flare.webm'),
    false,
    'nested media spilled outside the stack'
  );
  assert.ok(oracle.black_time, 'official archive has no opaque-black sample');
  assert.ok(oracle.hold, 'official archive has no image-sequence hold sample');
  assert.equal(oracle.hold?.frame, 1048);

  const timelineId = document.timeline_ids[0] ?? '';
  const at200 = evaluateOtioAt(document, timelineId, { value: 200, rate: 24 });
  const again = evaluateOtioAt(document, timelineId, { value: 200, rate: 24 });
  const ourPlate = at200.video_contributions.find((layer) => layer.track_id === plate?.track_id);
  const ourFlare = at200.video_contributions.find((layer) => layer.track_id === flare?.track_id);
  assert.equal(ourPlate?.source_frame, 1009);
  assert.equal(ourFlare?.source_time.value, 8);
  assert.equal(ourFlare?.source_time.rate, 24);
  assert.equal(
    again.video_contributions.find((layer) => layer.track_id === plate?.track_id)?.source_frame,
    ourPlate?.source_frame,
    'hold frame changed between evaluations'
  );
  const v1Spans = sourceSpansForOtioRange(document, timelineId, 'track-v1-main', {
    start_time: { value: 60, rate: 24 },
    duration: { value: 30, rate: 24 },
  });
  const ourA = v1Spans.find((span) => span.bundle_path === 'media/primary_a.mp4');
  const ourB = v1Spans.find((span) => span.bundle_path === 'media/secondary_b.mp4');
  const ourDissolve = v1Spans.find((span) => span.schema.startsWith('Transition'));
  assert.equal(ourA?.file_relative_source_range?.start_time.value, handleA?.file?.value);
  assert.equal(ourB?.file_relative_source_range?.start_time.value, handleB?.file?.value);
  assert.equal(ourDissolve?.timeline_range.start_time.value, dissolve?.timeline_start);
  const spill = evaluateOtioAt(document, timelineId, oracle.spill_time ?? { value: 0, rate: 24 });
  assert.equal(
    spill.video_contributions.some(
      (layer) => layer.bundle_path?.includes('plate_') || layer.bundle_path === 'media/fx_flare.webm'
    ),
    false,
    'evaluator spilled nested media outside the stack'
  );
  const black = evaluateOtioAt(document, timelineId, oracle.black_time ?? { value: 0, rate: 24 });
  assert.equal(black.video_contributions.length, 0, 'opaque-black sample still had a video contribution');
  const held = evaluateOtioAt(document, timelineId, oracle.hold?.time ?? { value: 0, rate: 24 });
  assert.equal(
    held.video_contributions.find((layer) => layer.track_id === oracle.hold?.track_id)?.source_frame,
    oracle.hold?.frame
  );
  console.log('OFFICIAL_MATCH t200=plate_1009 flare=8 v1=[60,90)');


  // 9. Republish a revision through the acknowledgement gate.
  const revised = await callMcp('relic_republish', {
    relic_id: relicId,
    path: fixtureDir,
    cover: false,
    addresses: [{ comment_id: postedBody.comment_id, note: 'Corrected the grade' }],
  });
  assert.ok(revised['version'], 'republish did not land a new version');
  console.log(`REPUBLISHED version=${String(revised['version'])}`);

  // 10. The original feedback still resolves, and an ambiguous revision does
  // not get a confident remap.
  const resolution = resolveOtioAnchor(anchor, document, document);
  assert.equal(resolution.status, 'same');
  const ambiguous = resolveOtioAnchor(
    { ...anchor, item_id: duplicateItemId(document) },
    document,
    shiftedDocument(document)
  );
  if (duplicateItemId(document)) {
    assert.notEqual(
      ambiguous.status,
      'mapped',
      'an ambiguous revision received a confident remap'
    );
  }
  console.log(`PROJECTION status=${resolution.status}`);

  assert.equal(mails.length, 0, 'the proof sent mail');
  console.log('OTIO_PATH_OK');
 } finally {
  const kept = join(process.cwd(), 'otio-path-shots');
  await rm(kept, { recursive: true, force: true });
  await Bun.spawn(['cp', '-R', shotDir, kept]).exited;
  console.log(`SHOTS ${kept}`);
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true });
 }


function duplicateItemId(document: OtioDocumentV1): string | undefined {
  return Object.values(document.nodes).find(
    (node) => node.identity_origin === 'derived-duplicate'
  )?.id;
}

function shiftedDocument(document: OtioDocumentV1): OtioDocumentV1 {
  return { ...document, document_sha256: `${document.document_sha256}ff` };
}
