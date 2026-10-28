/**
 * Loopback OTIO review path.
 *
 *   mise exec -- bun packages/relic-mcp/test/otio-path.ts
 *
 * Publishes the real `.otiod` through a fresh Node MCP process, decrypts the
 * stored ciphertext, and asks official OpenTimelineIO 0.18.1 (no user plugins)
 * for the archive layout and the ranges the viewer must hit. A headless
 * browser then seeks, samples decoded pixels, measures simultaneous audio,
 * and posts point and range comments through the native composer. A second
 * fresh MCP process must return those anchors with the original source
 * context and, after insert, trim, and ambiguous republishes, a separate
 * projection that does not guess coordinates.
 *
 * `OTIO_PATH_OK` is printed only after every stage below has passed. A skipped
 * stage is a failure. Expected frames come from the official reader of the
 * stored archive, not from a copied literal.
 *
 * Prerequisites:
 *   mise exec -- bun install --frozen-lockfile
 *   mise exec -- bun run --cwd packages/relic-mcp build
 *   uv on PATH, able to run `uv run --with opentimelineio==0.18.1`
 *   ffmpeg and ffprobe on PATH
 *   Chrome in RELIC_OTIO_CHROME_PATH, or RELIC_CHROME_PATH when that names an
 *   executable. The owned browser's CDP command line must attest headless mode.
 *
 * RELIC_OTIO_PATH_CLIENT selects the MCP client: `source` (the built bundle)
 * or `npx:<version>` for a published package. Both run the full path.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  compareRationalTimes,
  decodeKey,
  evaluateOtioAt,
  indexOtioZip,
  openRelic,
  readOtioDocument,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { loadPublishState } from '../src/state.ts';
import {
  attestBrowserHeadless,
  type BrowserHeadlessLaunch,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { isOpaqueBlack } from './otio-path-pixels.ts';

const clientMode = process.env['RELIC_OTIO_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');
const OTIO_PIN = 'opentimelineio==0.18.1';

const RUN_BUDGET_MS = 600_000;
const currentStep = 'startup';
const cdpInFlight = new Map<number, string>();
let cdpCallId = 0;
const runningBrowsers: Array<{
  child: ChildProcess;
  cdp: CdpConnection;
  profile: string;
}> = [];
const watchdog = setTimeout(() => {
  const pending = [...cdpInFlight.values()].join(', ') || 'none';
  console.error(
    `OTIO_PATH_TIMEOUT after ${RUN_BUDGET_MS}ms at step "${currentStep}"; CDP calls in flight: ${pending}`
  );
  for (const b of runningBrowsers) b.child.kill('SIGKILL');
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();
const viewerDist =
  process.env['RELIC_POPOVER_VIEWER_DIST'] ??
  process.env['RELIC_VIEWER_DIST'] ??
  fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const fixtureDir = fileURLToPath(
  new URL(
    '../../relic-format/test/fixtures/otio/standard-sample.otiod/',
    import.meta.url
  )
);
const decoderFixtureDir = fileURLToPath(
  new URL(
    '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/',
    import.meta.url
  )
);
const decoderMediaDir = join(decoderFixtureDir, 'media');
// Resolve the harness-owned temporary parent, never an input bundle or its entries.
const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'relic-otio-path-')
);
const statePath = join(scratch, 'state.json');
const shotDir = join(scratch, 'shots');
const mediaDir = join(scratch, 'media');
const emptyManifest = join(scratch, 'empty.otio-manifest.json');
const width = 160;
const height = 90;

const REQUIRED = [
  'published',
  'decrypted',
  'official-archive',
  'pixels-offset',
  'native-playback',
  'native-playback-late',
  'paint-parity',
  'default-view-negative-head',
  'nested-200',
  'nested-no-spill',
  'dissolve-pixels',
  'audio-signal',
  'ui-point-nested',
  'ui-range-nested',
  'ui-point-duplicate',
  'ui-range-duplicate',
  'ui-range-dissolve',
  'ui-track-duplicate',
  'ciphertext',
  'mcp-original',
  'revision-insert',
  'revision-trim',
  'revision-ambiguous',
  'state-gap-black',
  'state-effect',
  'state-codec',
  'state-hold',
  'state-sequence-black',
  'network-block',
  'no-mail',
  'decoder-timing-windows',
  'decoder-webm-quantization',
  'decoder-near-zero',
  'decoder-edit-diagnostics',
  'decoder-no-duration',
  'decoder-worker-csp',
  'screenshots',
] as const;

const passed = new Set<string>();
function pass(stage: (typeof REQUIRED)[number]): void {
  passed.add(stage);
  console.log(`STAGE ${stage}`);
}

const fakeNow = Date.now();
let loopbackNow = fakeNow;
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: { to: string; mail: OutboundMail }[] = [];
const children = new Set<ChildProcess>();
const packetCanvasMeasurements: Array<Record<string, unknown>> = [];

interface PendingMcpLoopbackReceipt {
  readonly callOrdinal: number;
  readonly tool: string;
  readonly relicId: string | null;
  readonly pid: number;
  readonly method: string;
  readonly pathname: string;
  readonly event: 'entry' | 'response';
  readonly status: number | null;
}
interface McpLoopbackReceipt extends PendingMcpLoopbackReceipt {
  readonly requestHash: string;
}
interface PersistedMcpLoopbackReceipts {
  readonly requestHash: string;
  readonly receipts: readonly McpLoopbackReceipt[];
}
interface ActiveMcpCall {
  readonly callOrdinal: number;
  readonly tool: string;
  readonly relicId: string | null;
  readonly pid: number;
  readonly pendingReceipts: PendingMcpLoopbackReceipt[];
}
const mcpLoopbackReceipts: McpLoopbackReceipt[] = [];
let activeMcpCall: ActiveMcpCall | undefined;
let nextMcpCallOrdinal = 0;

function recordMcpLoopbackReceipt(
  method: string,
  pathname: string,
  event: PendingMcpLoopbackReceipt['event'],
  status: number | null
): void {
  const call = activeMcpCall;
  if (!call) return;
  call.pendingReceipts.push({
    callOrdinal: call.callOrdinal,
    tool: call.tool,
    relicId: call.relicId,
    pid: call.pid,
    method,
    pathname,
    event,
    status,
  });
}

async function persistMcpLoopbackReceipts(
  call: ActiveMcpCall,
  packet: string
): Promise<PersistedMcpLoopbackReceipts> {
  const requestHash = await sha256Hex(packet);
  const receipts = call.pendingReceipts.map((receipt) => ({
    ...receipt,
    requestHash,
  }));
  mcpLoopbackReceipts.push(...receipts);
  return { requestHash, receipts };
}

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
  now: () => loopbackNow,
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
  recordMcpLoopbackReceipt(request.method, url.pathname, 'entry', null);

  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
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
  try {
    const response = await app.fetch(request);
    recordMcpLoopbackReceipt(
      request.method,
      url.pathname,
      'response',
      response.status
    );
    return response;
  } catch (err) {
    console.error('LOOPBACK APP FETCH ERROR:', err);
    throw err;
  }
};

interface Rational {
  readonly value: number;
  readonly rate: number;
}
interface TimeRange {
  readonly start_time: Rational;
  readonly duration: Rational;
}
interface SpanExpect {
  readonly relic_id: string | null;
  readonly name: string;
  readonly bundle_path: string | null;
  readonly source_range: TimeRange | null;
  readonly file_relative_source_range: TimeRange | null;
  readonly file_frame: number | null;
  readonly source_seconds: number | null;
}
interface SourcePixelProbe {
  readonly timeline_frame: number;
  readonly media: string;
  readonly file_frame: number;
  readonly wrong_file_frame: number;
}
interface DefaultViewNegativeHead {
  readonly timeline_frame: number;
  readonly timewarp_track_id: string;
  readonly timewarp_file_frame: number;
  readonly underlying_media: string;
  readonly underlying_file_frame: number;
  readonly clamped_file_frame: number;
}
interface Plan {
  readonly timeline_name: string;
  readonly timeline_rate: number;
  readonly nested_frame: number;
  readonly nested_inside: boolean;
  readonly nested_exposure: TimeRange;
  readonly nested_local_frame: number;
  readonly nested_image_url: string;
  readonly nested_image_file: string;
  readonly nested_predecessor_file: string;
  readonly nested_successor_file: string;
  readonly nested_occluders: readonly string[];
  readonly outside_frame: number;
  readonly outside_kind: string;
  readonly primary_frame: number;
  readonly primary_file_frame: number;
  readonly primary_wrong_file_frame: number;
  readonly primary_media: string;
  readonly primary_start?: number;
  readonly primary_end?: number;
  readonly primary_clip_frames?: Record<string, number>;
  readonly parity_layers: readonly {
    readonly relic_id: string | null;
    readonly track_id: string | null;
    readonly media: string;
    readonly file_seconds: Record<string, number>;
  }[];
  readonly source_pixel_probes: readonly SourcePixelProbe[];
  readonly default_view_negative_head: DefaultViewNegativeHead;
  readonly dissolve_frame: number;
  readonly dissolve_query: TimeRange;
  readonly dissolve_spans: readonly SpanExpect[];
  readonly dissolve_weights: readonly {
    readonly media: string;
    readonly file_frame: number;
    readonly weight: number;
  }[];
  readonly dissolve_occluders: readonly string[];
  readonly duplicate_track_id: string;
  readonly duplicate_other_track_id: string;
  readonly duplicate_name: string;
  readonly duplicate_frame: number;
  readonly duplicate_range: TimeRange;
  readonly nested_track_id: string;
  readonly nested_range: TimeRange;
  readonly dissolve_track_id: string;
  readonly audio_frame: number;
  readonly audio: readonly {
    readonly track_id: string;
    readonly bundle_path: string;
    readonly source_seconds: number;
  }[];
  readonly gap_frame: number;
  readonly effect_frame: number;
  readonly effect_media: string;
  readonly effect_file_frame: number;
  readonly private_labels: readonly string[];
  readonly comment_source: {
    readonly relic_id: string;
    readonly source_range: TimeRange;
    readonly editorial: TimeRange;
  };
}

function rationalClose(
  a: Rational | null | undefined,
  b: Rational | null | undefined
): boolean {
  if (!a || !b || !Number.isFinite(a.value) || !Number.isFinite(b.value))
    return false;
  if (a.rate === 0 || b.rate === 0) return false;
  const left = a.value * b.rate;
  const right = b.value * a.rate;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= 1e-4 * scale;
}

function rangeClose(
  a: TimeRange | null | undefined,
  b: TimeRange | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    rationalClose(a.start_time, b.start_time) &&
    rationalClose(a.duration, b.duration)
  );
}

function resolveCommand(): string[] {
  if (isNpxMode) return ['npx', '-y', `relic-mcp@${clientMode.slice(4)}`];
  return ['node', relicMcpBundlePath];
}

async function runChild(
  cmd: string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Uint8Array;
    readonly timeoutMs: number;
  }
): Promise<{ stdout: Buffer; stderr: string; exit: number }> {
  const child = spawn(cmd[0] ?? '', cmd.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
  if (options.input && child.stdin) {
    child.stdin.end(options.input);
  } else {
    child.stdin?.end();
  }
  const exit = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`timed out after ${options.timeoutMs}ms: ${cmd.join(' ')}`)
      );
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  }).finally(() => {
    children.delete(child);
  });
  return {
    stdout: Buffer.concat(chunks),
    stderr: Buffer.concat(errors).toString('utf8'),
    exit,
  };
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let call: ActiveMcpCall | undefined;
  let packetForReceipt: string | undefined;
  let receiptsPersisted = false;
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
  const timer = setTimeout(() => {
    child.kill();
  }, 45000);
  try {
    const packet = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    })}\n`;
    packetForReceipt = packet;
    const relicId = args['relic_id'];
    call = {
      callOrdinal: ++nextMcpCallOrdinal,
      tool: toolName,
      relicId: typeof relicId === 'string' ? relicId : null,
      pid: child.pid,
      pendingReceipts: [],
    };
    activeMcpCall = call;
    const writeResult = child.stdin.write(packet);
    const endResult = child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) {
      console.error(
        `callMcp ${toolName} failed (exit ${exit}). stderr: "${stderr}" stdout: "${stdout}"`
      );
    }
    const inputOutcomes = await Promise.allSettled([writeResult, endResult]);
    if (activeMcpCall === call) activeMcpCall = undefined;
    const persistedReceipts = await persistMcpLoopbackReceipts(call, packet);
    receiptsPersisted = true;
    const transport =
      exit !== 0 || stdout.trim().length === 0
        ? JSON.stringify({
            pid: child.pid,
            packetBytes: Buffer.byteLength(packet),
            packetSha256: persistedReceipts.requestHash,
            inputOutcomes,
            stdoutBytes: Buffer.byteLength(stdout),
            stdoutSha256: await sha256Hex(stdout),
            exit,
            signal: child.signalCode,
            stderr,
            loopbackReceipts: persistedReceipts.receipts,
          })
        : '';
    assert.equal(exit, 0, `relic-mcp exited ${exit}: ${transport}`);
    const lines = stdout
      .trim()
      .split('\n')
      .filter((line: string) => line.trim().length > 0);
    assert.ok(
      lines.length > 0,
      `no JSON-RPC response from ${toolName}: ${transport}`
    );
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
  } finally {
    clearTimeout(timer);
    child.kill();
    if (activeMcpCall === call) activeMcpCall = undefined;
    if (!receiptsPersisted && call && packetForReceipt) {
      await persistMcpLoopbackReceipts(call, packetForReceipt);
    }
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function createSession(email = 'reader@example.test'): Promise<string> {
  const token = `otio-path-token-${Math.random().toString(16).slice(2)}`;
  await store.putSession({
    tokenHash: await sha256Hex(token),
    email,
    createdAt: fakeNow,
    expiresAt: fakeNow + 3600 * 1000,
  });
  return token;
}

const ORACLE = String.raw`
import json, os, shutil, sys, zipfile
from pathlib import Path
from collections.abc import Mapping

os.environ.setdefault("OTIO_PLUGIN_MANIFEST_PATH", sys.argv[1])
import opentimelineio as otio

def rational(t):
    if t is None:
        return None
    return {"value": float(t.value), "rate": float(t.rate)}

def range_json(r):
    if r is None:
        return None
    return {"start_time": rational(r.start_time), "duration": rational(r.duration)}

def close(a, b):
    if a is None or b is None or a.rate == 0 or b.rate == 0:
        return False
    left = a.value * b.rate
    right = b.value * a.rate
    return abs(left - right) <= 1e-4 * max(1.0, abs(left), abs(right))

def relic_id(item):
    meta = item.metadata.get("relic") if item.metadata else None
    if isinstance(meta, Mapping):
        return meta.get("id")
    return None

def frame_number(t, rate):
    scaled = t.rescaled_to(rate)
    if abs(scaled.value - round(scaled.value)) > 1e-4:
        raise SystemExit("non-integer frame %s at rate %s" % (scaled.value, rate))
    return int(round(scaled.value))

def walk(item):
    if isinstance(item, (otio.schema.Track, otio.schema.Stack)):
        for child in item:
            yield child
            yield from walk(child)
    elif isinstance(item, otio.schema.Timeline):
        yield from walk(item.tracks)

def overlaps(rng, t):
    if rng is None:
        return False
    start = rng.start_time
    end = rng.end_time_exclusive()
    return start <= t and t < end

def establish(timeline, primary):
    parent = primary.trimmed_range_in_parent()
    if parent is None or primary.source_range is None:
        raise SystemExit("primary clip has no parent range")
    start = parent.start_time
    expected = primary.source_range.start_time
    forward = timeline.tracks.transformed_time(start, primary)
    if close(forward, expected):
        return start.rate
    backward = primary.transformed_time(start, timeline.tracks)
    if close(backward, expected):
        raise SystemExit("transform direction is reversed; refusing to guess offsets")
    global_start = timeline.global_start_time
    if global_start is not None:
        shifted = start - global_start
        if close(timeline.tracks.transformed_time(shifted, primary), expected):
            raise SystemExit("timeline time includes global_start; viewer frames would be wrong")
    raise SystemExit("could not map primary source start through the official timeline")

def source_at(timeline, clip, t):
    return timeline.tracks.transformed_time(t, clip)

def bundle_of(clip):
    ref = clip.media_reference
    if ref is None:
        return None
    url = getattr(ref, "target_url", None)
    if url:
        return url
    return None

def file_frame_of(clip, source):
    ref = clip.media_reference
    available = getattr(ref, "available_range", None) if ref is not None else None
    origin = available.start_time if available is not None else otio.opentime.RationalTime(0, source.rate)
    relative = source - origin.rescaled_to(source.rate)
    scaled = relative.rescaled_to(origin.rate)
    if abs(scaled.value - round(scaled.value)) > 1e-3:
        return None
    return int(round(scaled.value))
def retimed_file_frame(clip, t):
    parent = clip.trimmed_range_in_parent()
    source = clip.source_range
    ref = clip.media_reference
    available = getattr(ref, "available_range", None) if ref is not None else None
    if parent is None or source is None or available is None:
        raise SystemExit("timewarp clip needs parent, source, and available ranges")
    if not overlaps(parent, t):
        raise SystemExit("timewarp sample is outside its editorial range")
    warps = [effect for effect in clip.effects
             if isinstance(effect, otio.schema.LinearTimeWarp) and effect.enabled]
    if len(warps) != 1:
        raise SystemExit("timewarp clip needs exactly one enabled LinearTimeWarp")
    scalar = float(warps[0].time_scalar)
    if scalar == 0:
        raise SystemExit("timewarp scalar must not be zero")
    rate = source.start_time.rate
    offset = t.rescaled_to(parent.start_time.rate) - parent.start_time
    authored = otio.opentime.RationalTime(
        source.start_time.rescaled_to(rate).value
        + offset.rescaled_to(rate).value * scalar,
        rate,
    )
    relative = authored - available.start_time.rescaled_to(rate)
    return frame_number(relative, available.start_time.rate)


def span_for(timeline, clip, t):
    source = source_at(timeline, clip, t)
    ref = clip.media_reference
    available = getattr(ref, "available_range", None) if ref is not None else None
    origin = available.start_time if available is not None else otio.opentime.RationalTime(0, source.rate)
    relative = source - origin.rescaled_to(source.rate)
    one = otio.opentime.RationalTime(1, source.rate)
    return {
        "relic_id": relic_id(clip),
        "name": clip.name,
        "bundle_path": bundle_of(clip),
        "source_range": {"start_time": rational(source), "duration": rational(one)},
        "file_relative_source_range": {"start_time": rational(relative), "duration": rational(one)},
        "file_frame": file_frame_of(clip, source),
        "source_seconds": float(source.rescaled_to(1).value) if source is not None else None,
    }

def image_index_at(ref, sample):
    count = ref.number_of_images_in_sequence()
    available = ref.available_range
    if available is None:
        raise SystemExit("sequence has no available range")
    for index in range(count):
        start = ref.presentation_time_for_image_number(index)
        end = (
            ref.presentation_time_for_image_number(index + 1)
            if index + 1 < count
            else available.end_time_exclusive()
        )
        window = otio.opentime.TimeRange.range_from_start_end_time(start, end)
        if window.contains(sample.rescaled_to(start.rate)):
            return index
    raise SystemExit("source sample is outside sequence presentation windows")

def image_url(ref, index):
    if not hasattr(ref, "target_url_for_image_number"):
        raise SystemExit("official image-number API is missing")
    url = ref.target_url_for_image_number(int(index))
    if url.startswith("http://") or url.startswith("https://") or ".." in url:
        raise SystemExit("image URL is not a bundle path: %s" % url)
    return url

def derive(archive, out_dir):
    timeline = otio.adapters.read_from_file(archive)
    if not isinstance(timeline, otio.schema.Timeline):
        raise SystemExit("archive root is not a timeline")
    names = zipfile.ZipFile(archive).namelist()
    if "content.otio" not in names:
        raise SystemExit("archive has no content.otio")
    rate = establish(timeline, next(c for c in walk(timeline) if relic_id(c) == "clip-v1-primary-a"))
    tracks = [item for item in timeline.tracks if isinstance(item, otio.schema.Track)]
    by_name = {}
    for track in tracks:
        by_name.setdefault(track.name, []).append(track)
    def top_track(wanted):
        rows = [track for track in tracks if relic_id(track) == wanted]
        if len(rows) != 1:
            raise SystemExit("fixture needs exactly one top-level track %s, found %d" % (wanted, len(rows)))
        return rows[0]
    dup = top_track("track-v2-duplicate")
    other = top_track("track-v2-main")
    dup_name = dup.name
    if other.name != dup_name:
        raise SystemExit("duplicate proof needs one display name on both tracks, got %r and %r" % (dup_name, other.name))
    if [relic_id(track) for track in by_name.get(dup_name, [])] != ["track-v2-main", "track-v2-duplicate"]:
        raise SystemExit("display name %r is not shared by exactly track-v2-main then track-v2-duplicate" % dup_name)
    if relic_id(dup) == relic_id(other):
        raise SystemExit("duplicate tracks are not distinguishable by id")

    nested = next(item for item in walk(timeline) if relic_id(item) == "stack-vfx-submaster")
    nested_range = nested.trimmed_range_in_parent()
    exposure_start = frame_number(nested_range.start_time, rate)
    exposure_end = frame_number(nested_range.end_time_exclusive(), rate)
    nested_frame = 200
    inside = exposure_start <= nested_frame < exposure_end
    if not inside:
        raise SystemExit("nested exposure %s-%s does not contain frame 200" % (exposure_start, exposure_end))
    sample = otio.opentime.RationalTime(nested_frame, rate)
    plate = next(item for item in walk(nested) if relic_id(item) == "clip-nested-plate")
    plate_track = plate.parent()
    local = source_at(timeline, plate, sample)
    ref = plate.media_reference
    local_frames = int(round(local.rescaled_to(ref.rate).value))
    image_index = image_index_at(ref, local)
    if image_index == 0:
        raise SystemExit("nested sample has no predecessor for hold proof")
    url = image_url(ref, image_index)
    predecessor = image_url(ref, image_index - 1)
    if image_index + 1 >= ref.number_of_images_in_sequence():
        raise SystemExit("nested sample has no successor for the frame proof")
    successor = image_url(ref, image_index + 1)
    def covering_clip(track, at):
        item = track.child_at_time(timeline.tracks.transformed_time(at, track), True)
        if item is None or isinstance(item, otio.schema.Gap):
            return None
        if isinstance(item, otio.schema.Clip):
            return item if item.enabled else None
        raise SystemExit("cannot classify %s over %s" % (type(item).__name__, relic_id(track)))
    def occluders_above(owner, at):
        rows = list(owner.parent())
        index = next(i for i, row in enumerate(rows) if row is owner)
        return [relic_id(row) for row in rows[index + 1:]
                if isinstance(row, otio.schema.Track) and row.kind == otio.schema.TrackKind.Video
                and row.enabled and covering_clip(row, at) is not None]
    nested_occluders = occluders_above(plate_track, sample) + occluders_above(nested.parent(), sample)
    zf = zipfile.ZipFile(archive)
    for needed in (url, predecessor, successor):
        if needed not in zf.namelist():
            raise SystemExit("bundle is missing %s" % needed)
        target = Path(out_dir) / needed
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(zf.read(needed))

    outside = exposure_start - 1
    outside_t = otio.opentime.RationalTime(outside, rate)
    outside_item = nested.parent().child_at_time(timeline.tracks.transformed_time(outside_t, nested.parent()), True)
    if outside_item is nested:
        outside_kind = "plate"
    elif isinstance(outside_item, otio.schema.Gap):
        outside_kind = "gap"
    else:
        outside_kind = type(outside_item).__name__.lower()

    primary = next(item for item in walk(timeline) if relic_id(item) == "clip-v1-primary-a")
    primary_range = primary.trimmed_range_in_parent()
    if primary_range is None:
        raise SystemExit("primary clip has no editorial range")
    primary_start = frame_number(primary_range.start_time, rate)
    primary_end = frame_number(primary_range.end_time_exclusive(), rate)
    primary_frame = primary_start + 8
    if primary_frame - 1 < primary_start or primary_frame + 1 >= primary_end:
        raise SystemExit("primary clip cannot supply three consecutive source-pixel probes")
    primary_t = otio.opentime.RationalTime(primary_frame, rate)
    primary_span = span_for(timeline, primary, primary_t)
    if primary_span["file_frame"] is None:
        raise SystemExit("primary file frame is not an integer")
    primary_media = primary_span["bundle_path"]
    if primary_media not in zf.namelist():
        raise SystemExit("bundle is missing %s" % primary_media)
    source_pixel_probes = []
    for frame in range(primary_frame - 1, primary_frame + 2):
        span = span_for(timeline, primary, otio.opentime.RationalTime(frame, rate))
        if span["file_frame"] is None:
            raise SystemExit("source-pixel probe has no integer file frame at %s" % frame)
        if span["bundle_path"] != primary_media:
            raise SystemExit("source-pixel probes do not share one media bundle")
        source_pixel_probes.append({
            "timeline_frame": frame,
            "media": span["bundle_path"],
            "file_frame": span["file_frame"],
            "wrong_file_frame": span["file_frame"] + 2,
        })
    if (len(source_pixel_probes) != 3
            or any(source_pixel_probes[index]["file_frame"] != source_pixel_probes[0]["file_frame"] + index
                   for index in range(len(source_pixel_probes)))):
        raise SystemExit("source-pixel probes are not consecutive official file samples")
    primary_clip_frames = {}
    for frame in range(primary_start, primary_end):
        span = span_for(timeline, primary, otio.opentime.RationalTime(frame, rate))
        if span["file_frame"] is not None:
            primary_clip_frames[str(frame)] = span["file_frame"]
    (Path(out_dir) / primary_media).parent.mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / primary_media).write_bytes(zf.read(primary_media))
    parity_layers = []
    video_tracks = [t for t in timeline.tracks if isinstance(t, otio.schema.Track) and t.kind == otio.schema.TrackKind.Video and t.enabled]
    for track in video_tracks:
        covered = [covering_clip(track, otio.opentime.RationalTime(f, rate)) for f in range(20, 46)]
        if all(c is None for c in covered):
            continue
        first_clip = covered[0]
        if any(c is not first_clip for c in covered):
            raise SystemExit("parity layer on %s is not one clip across frames 20-45" % track.name)
        if len(first_clip.effects) > 0:
            raise SystemExit("parity layer clip %s has effects" % first_clip.name)
        ref = first_clip.media_reference
        available = getattr(ref, "available_range", None)
        avail_start = available.start_time if available is not None else otio.opentime.RationalTime(0, 1)
        file_seconds = {}
        for f in range(20, 46):
            t = otio.opentime.RationalTime(f, rate)
            s = timeline.tracks.transformed_time(t, first_clip)
            rel = s - avail_start.rescaled_to(s.rate)
            file_seconds[str(f)] = rel.to_seconds()
        parity_layers.append({
            "relic_id": relic_id(first_clip),
            "track_id": relic_id(track),
            "media": bundle_of(first_clip),
            "file_seconds": file_seconds,
        })
    if len(parity_layers) != 2:
        raise SystemExit("parity layers count is not 2: %d" % len(parity_layers))
    for layer in parity_layers:
        media_path = layer["media"]
        (Path(out_dir) / media_path).parent.mkdir(parents=True, exist_ok=True)
        (Path(out_dir) / media_path).write_bytes(zf.read(media_path))

    timewarp = next(item for item in walk(other) if relic_id(item) == "clip-v2-timewarp")
    if timewarp.parent() is not other:
        raise SystemExit("timewarp clip is not an immediate child of track-v2-main")
    timewarp_track_id = relic_id(other)
    if timewarp_track_id is None:
        raise SystemExit("timewarp track needs a relic id")
    timewarp_range = timewarp.trimmed_range_in_parent()
    if timewarp_range is None:
        raise SystemExit("timewarp clip has no editorial range")
    timewarp_start = frame_number(timewarp_range.start_time, rate)
    timewarp_end = frame_number(timewarp_range.end_time_exclusive(), rate)
    negative_head_frame = None
    negative_timewarp_file_frame = None
    for frame in range(timewarp_start, timewarp_end):
        candidate = otio.opentime.RationalTime(frame, rate)
        authored_file_frame = retimed_file_frame(timewarp, candidate)
        if authored_file_frame < 0:
            negative_head_frame = frame
            negative_timewarp_file_frame = authored_file_frame
            break
    if negative_head_frame is None or negative_timewarp_file_frame is None:
        raise SystemExit("timewarp has no authored retimed sample before available media")
    negative_t = otio.opentime.RationalTime(negative_head_frame, rate)
    if covering_clip(other, negative_t) is not timewarp:
        raise SystemExit("negative-head sample is not covered by the timewarp clip")
    negative_underlying = span_for(timeline, primary, negative_t)
    if negative_underlying["file_frame"] is None:
        raise SystemExit("negative-head underlying V1 sample is not an integer file frame")
    if negative_underlying["bundle_path"] != primary_media:
        raise SystemExit("negative-head underlying V1 sample changed media bundle")
    primary_ref = primary.media_reference
    primary_available = getattr(primary_ref, "available_range", None)
    if primary_available is None:
        raise SystemExit("primary clip has no available range for clamp control")
    clamped_file_frame = file_frame_of(primary, primary_available.start_time)
    if clamped_file_frame is None:
        raise SystemExit("primary clamp control is not an integer file frame")
    primary_file_count = frame_number(
        primary_available.duration,
        primary_available.start_time.rate,
    )
    if not 0 <= negative_underlying["file_frame"] < primary_file_count:
        raise SystemExit("negative-head underlying V1 sample is outside available media")
    if negative_underlying["file_frame"] == clamped_file_frame:
        raise SystemExit("negative-head underlying V1 sample cannot distinguish a clamped substitute")

    transition = next(item for item in walk(timeline) if isinstance(item, otio.schema.Transition))
    trans_range = transition.trimmed_range_in_parent()
    dissolve_start = frame_number(trans_range.start_time, rate)
    dissolve_end = frame_number(trans_range.end_time_exclusive(), rate)
    query_end = dissolve_end + 6
    query = otio.opentime.TimeRange(
        otio.opentime.RationalTime(dissolve_start, rate),
        otio.opentime.RationalTime(query_end - dissolve_start, rate),
    )
    mid = dissolve_start + max(1, (dissolve_end - dissolve_start) // 2)
    mid_t = otio.opentime.RationalTime(mid, rate)
    v1 = next(track for track in tracks if relic_id(track) == "track-v1-main")
    dissolve_spans = []
    weights = []
    frac = (mid - dissolve_start) / max(1, dissolve_end - dissolve_start)
    dissolve_occluders = occluders_above(v1, mid_t)
    incoming = next(item for item in v1 if relic_id(item) == "clip-v1-primary-a")
    outgoing = next(item for item in v1 if relic_id(item) == "clip-v1-secondary-b")
    for clip, weight in ((incoming, 1 - frac), (outgoing, frac)):
        if not isinstance(clip, otio.schema.Clip):
            raise SystemExit("dissolve neighbors are not clips")
        span = span_for(timeline, clip, mid_t)
        dissolve_spans.append(span)
        media = span["bundle_path"]
        if media and media in zf.namelist():
            dest = Path(out_dir) / media
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(media))
        weights.append({"media": media, "file_frame": span["file_frame"], "weight": weight})
    window_spans = []
    for clip in walk(v1):
        if not isinstance(clip, otio.schema.Clip):
            continue
        base = v1.range_of_child(clip)
        if base is None:
            raise SystemExit("official range_of_child returned no range for %s" % (relic_id(clip) or clip.name))
        parent = clip.parent()
        if parent is None:
            raise SystemExit("official clip has no immediate parent for %s" % (relic_id(clip) or clip.name))
        pre, post = parent.handles_of_child(clip)
        start = base.start_time
        end = base.end_time_exclusive()
        if pre is not None:
            start = start - pre.rescaled_to(start.rate)
        if post is not None:
            end = end + post.rescaled_to(end.rate)
        visible = base if not (end > start) else otio.opentime.TimeRange.range_from_start_end_time(start, end)
        if not visible.intersects(query):
            continue
        hit_start = visible.start_time if visible.start_time >= query.start_time else query.start_time
        hit_end = visible.end_time_exclusive() if visible.end_time_exclusive() <= query.end_time_exclusive() else query.end_time_exclusive()
        if not (hit_end > hit_start):
            continue
        hit = otio.opentime.TimeRange.range_from_start_end_time(hit_start, hit_end)
        source_start = v1.transformed_time(hit.start_time, clip)
        source_end = v1.transformed_time(hit.end_time_exclusive(), clip)
        if source_start is None or source_end is None or not (source_end > source_start):
            raise SystemExit("official transform did not produce a source interval for %s" % (relic_id(clip) or clip.name))
        source_range = otio.opentime.TimeRange.range_from_start_end_time(source_start, source_end)
        ref = clip.media_reference
        available = getattr(ref, "available_range", None) if ref is not None else None
        file_range = None
        if available is not None and available.start_time is not None:
            origin = available.start_time
            file_start = source_start - origin.rescaled_to(source_start.rate)
            file_end = source_end - origin.rescaled_to(source_end.rate)
            if not (file_end > file_start):
                raise SystemExit("official transform did not produce a file interval for %s" % (relic_id(clip) or clip.name))
            file_range = otio.opentime.TimeRange.range_from_start_end_time(file_start, file_end)
        window_spans.append({
            "relic_id": relic_id(clip),
            "name": clip.name,
            "bundle_path": bundle_of(clip),
            "source_range": range_json(source_range),
            "file_relative_source_range": range_json(file_range),
            "file_frame": file_frame_of(clip, source_start) if file_range is not None else None,
            "source_seconds": float(source_start.rescaled_to(1).value),
        })

    dup_clips = [item for item in walk(dup) if isinstance(item, otio.schema.Clip)]
    if [relic_id(item) for item in dup_clips] != ["clip-v2-duplicate-disabled"]:
        raise SystemExit("track-v2-duplicate must hold exactly clip-v2-duplicate-disabled, found %s" % [relic_id(item) or item.name for item in dup_clips])
    dup_clip = dup_clips[0]
    if dup_clip.parent() is not dup:
        raise SystemExit("clip-v2-duplicate-disabled is not an immediate child of track-v2-duplicate")
    if dup_clip.enabled:
        raise SystemExit("duplicate proof requires the authored disabled clip; clip-v2-duplicate-disabled is enabled")
    dup_range = dup_clip.trimmed_range_in_parent()
    dup_frame = frame_number(dup_range.start_time, rate)
    dup_end = min(frame_number(dup_range.end_time_exclusive(), rate), dup_frame + 4)

    audio = []
    audio_frame = None
    for frame in range(0, exposure_end + 24):
        t = otio.opentime.RationalTime(frame, rate)
        active = []
        for track in tracks:
            if track.kind != otio.schema.TrackKind.Audio:
                continue
            for clip in track:
                if isinstance(clip, otio.schema.Clip) and overlaps(clip.trimmed_range_in_parent(), t) and bundle_of(clip):
                    span = span_for(timeline, clip, t)
                    active.append({
                        "track_id": relic_id(track),
                        "bundle_path": span["bundle_path"],
                        "source_seconds": float((span["file_relative_source_range"]["start_time"]["value"]) / span["file_relative_source_range"]["start_time"]["rate"]),
                    })
        if len(active) >= 2:
            audio = active
            audio_frame = frame
            break
    if audio_frame is None:
        raise SystemExit("no simultaneous audio frame")
    for row in audio:
        if row["bundle_path"] in zf.namelist():
            dest = Path(out_dir) / row["bundle_path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(row["bundle_path"]))

    gap = next(item for item in walk(timeline) if isinstance(item, otio.schema.Gap) and relic_id(item) == "gap-v1-slug")
    gap_range = gap.trimmed_range_in_parent()
    effect = next(item for item in walk(timeline) if relic_id(item) == "clip-v2-unsupported")
    effect_range = effect.trimmed_range_in_parent()
    effect_available = getattr(effect.media_reference, "available_range", None)
    if effect_available is None:
        raise SystemExit("unsupported-effect clip has no available range, so its base frame cannot be named")
    effect_count = frame_number(effect_available.duration, effect_available.start_time.rate)
    def effect_base_frame(frame):
        found = file_frame_of(effect, source_at(timeline, effect, otio.opentime.RationalTime(frame, rate)))
        return found if found is not None and 0 <= found < effect_count else None
    effect_frame = next((frame for frame in range(frame_number(effect_range.start_time, rate), frame_number(effect_range.end_time_exclusive(), rate))
                         if effect_base_frame(frame) is not None), None)
    if effect_frame is None:
        raise SystemExit("unsupported-effect clip never exposes base media inside its available range")
    effect_span = span_for(timeline, effect, otio.opentime.RationalTime(effect_frame, rate))
    if effect_span["bundle_path"] in zf.namelist():
        dest = Path(out_dir) / effect_span["bundle_path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(zf.read(effect_span["bundle_path"]))

    labels = ["track-v1-main", "track-v2-duplicate", "track-nested-plate-base", primary_media, url, "media/dx_mic1.wav"]
    plan = {
        "timeline_name": timeline.name,
        "timeline_rate": rate,
        "nested_frame": nested_frame,
        "nested_inside": True,
        "nested_exposure": range_json(nested_range),
        "nested_local_frame": local_frames,
        "nested_image_url": url,
        "nested_image_file": url,
        "nested_predecessor_file": predecessor,
        "nested_successor_file": successor,
        "nested_occluders": nested_occluders,
        "outside_frame": outside,
        "outside_kind": outside_kind,
        "primary_frame": primary_frame,
        "primary_file_frame": primary_span["file_frame"],
        "primary_wrong_file_frame": primary_span["file_frame"] + 2,
        "primary_media": primary_media,
        "primary_start": primary_start,
        "primary_end": primary_end,
        "primary_clip_frames": primary_clip_frames,
        "parity_layers": parity_layers,
        "source_pixel_probes": source_pixel_probes,
        "default_view_negative_head": {
            "timeline_frame": negative_head_frame,
            "timewarp_track_id": timewarp_track_id,
            "timewarp_file_frame": negative_timewarp_file_frame,
            "underlying_media": negative_underlying["bundle_path"],
            "underlying_file_frame": negative_underlying["file_frame"],
            "clamped_file_frame": clamped_file_frame,
        },
        "dissolve_frame": mid,
        "dissolve_query": range_json(query),
        "dissolve_spans": window_spans,
        "dissolve_weights": weights,
        "dissolve_occluders": dissolve_occluders,
        "duplicate_track_id": relic_id(dup),
        "duplicate_other_track_id": relic_id(other),
        "duplicate_name": dup_name,
        "duplicate_frame": dup_frame,
        "duplicate_range": {
            "start_time": {"value": dup_frame, "rate": rate},
            "duration": {"value": dup_end - dup_frame, "rate": rate},
        },
        "nested_track_id": relic_id(plate_track),
        "nested_range": {
            "start_time": {"value": nested_frame, "rate": rate},
            "duration": {"value": 4, "rate": rate},
        },
        "dissolve_track_id": relic_id(v1),
        "audio_frame": audio_frame,
        "audio": audio,
        "gap_frame": frame_number(gap_range.start_time, rate),
        "effect_frame": effect_frame,
        "effect_media": effect_span["bundle_path"],
        "effect_file_frame": effect_span["file_frame"],
        "private_labels": labels,
        "comment_source": {
            "relic_id": relic_id(primary),
            "source_range": {
                "start_time": rational(source_at(timeline, primary, otio.opentime.RationalTime(primary_frame, rate))),
                "duration": rational(source_at(timeline, primary, otio.opentime.RationalTime(primary_frame + 8, rate)) - source_at(timeline, primary, otio.opentime.RationalTime(primary_frame, rate))),
            },
            "editorial": {
                "start_time": {"value": primary_frame, "rate": rate},
                "duration": {"value": 8, "rate": rate},
            },
        },
    }
    json.dump(plan, sys.stdout)
    sys.stdout.write("\n")

def load_dir(path):
    return otio.adapters.read_from_file(str(Path(path) / "content.otio"))

def write_dir(timeline, path):
    otio.adapters.write_to_file(timeline, str(Path(path) / "content.otio"))

def project(path, relic, source_range):
    timeline = load_dir(path)
    matches = [item for item in walk(timeline) if relic_id(item) == relic and isinstance(item, otio.schema.Clip)]
    if len(matches) != 1:
        return {"status": "ambiguous" if len(matches) > 1 else "missing", "mapped_range": None}
    clip = matches[0]
    start = otio.opentime.RationalTime(source_range["start_time"]["value"], source_range["start_time"]["rate"])
    duration = otio.opentime.RationalTime(source_range["duration"]["value"], source_range["duration"]["rate"])
    wanted = otio.opentime.TimeRange(start, duration)
    parent = clip.parent()
    base = parent.range_of_child(clip)
    pre, post = parent.handles_of_child(clip)
    visible_start = base.start_time - (pre.rescaled_to(base.start_time.rate) if pre is not None else otio.opentime.RationalTime(0, base.start_time.rate))
    visible_end = base.end_time_exclusive() + (post.rescaled_to(base.start_time.rate) if post is not None else otio.opentime.RationalTime(0, base.start_time.rate))
    have_start = parent.transformed_time(visible_start, clip)
    have_end = parent.transformed_time(visible_end, clip)
    overlap_start = max(wanted.start_time, have_start)
    overlap_end = min(wanted.end_time_exclusive(), have_end)
    if overlap_end <= overlap_start:
        return {"status": "missing", "mapped_range": None}
    surviving = otio.opentime.TimeRange(overlap_start, overlap_end - overlap_start)
    editorial = clip.transformed_time_range(surviving, timeline.tracks)
    status = "partial" if not close(overlap_end - overlap_start, duration) else "mapped"
    return {"status": status, "mapped_range": range_json(editorial)}

def mutate(op, src, dest, extra):
    if "standard-sample.otiod" in str(Path(dest).resolve()):
        raise SystemExit("refusing to edit the fixture directory")
    if Path(dest).resolve() != Path(src).resolve():
        if Path(dest).exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
    timeline = load_dir(dest)
    if op == "insert":
        track = next(item for item in timeline.tracks if relic_id(item) == "track-v1-main")
        gap = otio.schema.Gap(name="Insert", source_range=otio.opentime.TimeRange(
            otio.opentime.RationalTime(0, 24), otio.opentime.RationalTime(24, 24)))
        track.insert(0, gap)
        write_dir(timeline, dest)
        print(json.dumps(project(dest, "clip-v1-primary-a", json.loads(extra))))
        return
    if op == "trim":
        clip = next(item for item in walk(timeline) if relic_id(item) == "clip-v1-primary-a")
        source = json.loads(extra)
        start = otio.opentime.RationalTime(source["start_time"]["value"], source["start_time"]["rate"])
        duration = otio.opentime.RationalTime(source["duration"]["value"], source["duration"]["rate"])
        midpoint = start + otio.opentime.RationalTime(duration.value / 2, duration.rate)
        parent = clip.parent()
        index = next(i for i, item in enumerate(parent) if item is clip)
        if index > 0 and isinstance(parent[index - 1], otio.schema.Transition):
            raise SystemExit("head trim needs no transition before the clip")
        clip_end = clip.source_range.end_time_exclusive()
        clip.source_range = otio.opentime.TimeRange(midpoint, clip_end.rescaled_to(midpoint.rate) - midpoint)
        write_dir(timeline, dest)
        print(json.dumps(project(dest, "clip-v1-primary-a", source)))
        return
    if op == "ambiguous":
        clip = next(item for item in walk(timeline) if relic_id(item) == "clip-v1-primary-a")
        track = clip.parent()
        children = list(track)
        copy = otio.adapters.read_from_string(otio.adapters.write_to_string(clip))
        track.insert(children.index(clip) + 1, copy)
        write_dir(timeline, dest)
        print(json.dumps(project(dest, "clip-v1-primary-a", json.loads(extra))))
        return
    if op == "states":
        plate = next(item for item in walk(timeline) if relic_id(item) == "clip-nested-plate")
        ref = plate.media_reference
        sample = json.loads(extra)
        local = source_at(
            timeline, plate,
            otio.opentime.RationalTime(sample["value"], sample["rate"]),
        )
        missing = image_url(ref, image_index_at(ref, local))
        target = Path(dest) / missing
        if target.exists():
            target.unlink()
        black_ref = otio.schema.ImageSequenceReference(
            target_url_base="media/",
            name_prefix="missing_black_",
            name_suffix=".png",
            start_frame=9000,
            frame_step=1,
            rate=24,
            frame_zero_padding=4,
        )
        black_ref.missing_frame_policy = otio.schema.ImageSequenceReference.MissingFramePolicy.black
        one = otio.opentime.RationalTime(1, 24)
        black = otio.schema.Clip(name="Black Policy Probe", media_reference=black_ref, source_range=otio.opentime.TimeRange(
            otio.opentime.RationalTime(0, 24), one))
        black.metadata["relic"] = {"id": "clip-black-policy-probe"}
        under = next(item for item in walk(timeline) if relic_id(item) == "clip-v1-primary-a")
        if not under.enabled or under.parent().parent() is not timeline.tracks:
            raise SystemExit("black probe needs an enabled top-level clip beneath it")
        black_at = under.trimmed_range_in_parent().start_time.rescaled_to(24)
        if file_frame_of(under, source_at(timeline, under, black_at)) is None or file_frame_of(under, source_at(timeline, under, black_at)) < 0:
            raise SystemExit("clip beneath the black probe has no in-range media at %s" % black_at)
        prores = "media/unsupported_prores.mov"
        if not (Path(dest) / prores).exists():
            raise SystemExit("bundle is missing %s" % prores)
        codec = otio.schema.Clip(name="Codec Probe", media_reference=otio.schema.ExternalReference(
            target_url=prores,
            available_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, 24), otio.opentime.RationalTime(24, 24))),
            source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, 24), one))
        codec.metadata["relic"] = {"id": "clip-codec-probe"}
        duration = timeline.duration().rescaled_to(24)
        track = otio.schema.Track(name="State Probes", kind=otio.schema.TrackKind.Video)
        track.metadata["relic"] = {"id": "track-state-probes"}
        if black_at.value > 0:
            track.append(otio.schema.Gap(source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, 24), black_at)))
        track.append(black)
        track.append(otio.schema.Gap(source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, 24), duration - black_at - one)))
        track.append(codec)
        timeline.tracks.append(track)
        write_dir(timeline, dest)
        print(json.dumps({
            "missing_file": missing,
            "black_frame": frame_number(black.trimmed_range_in_parent().start_time, 24),
            "black_under": relic_id(under),
            "probe_track": relic_id(track),
            "codec_frame": frame_number(codec.trimmed_range_in_parent().start_time, 24),
            "codec_media": prores,
        }))
        return
    raise SystemExit("unknown mutate %s" % op)

cmd = sys.argv[2]
if cmd == "derive":
    derive(sys.argv[3], sys.argv[4])
elif cmd == "mutate":
    if len(sys.argv) < 6:
        raise SystemExit("mutate needs op, src, and dest")
    mutate(sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6] if len(sys.argv) > 6 else None)
else:
    raise SystemExit("unknown command")
`;

async function oracle(args: string[], _input?: string): Promise<string> {
  const script = join(scratch, 'official-otio.py');
  await writeFile(
    emptyManifest,
    JSON.stringify({
      OTIO_SCHEMA: 'PluginManifest.1',
      adapters: [],
      hook_scripts: [],
      hooks: {},
      media_linkers: [],
      schemadefs: [],
      version_manifests: {},
    })
  );
  await writeFile(script, ORACLE);
  const result = await runChild(
    [
      'uv',
      'run',
      '--with',
      OTIO_PIN,
      'python3',
      script,
      emptyManifest,
      ...args,
    ],
    {
      cwd: scratch,
      timeoutMs: 120000,
      env: { ...process.env, OTIO_PLUGIN_MANIFEST_PATH: emptyManifest },
    }
  );
  assert.equal(
    result.exit,
    0,
    `official OTIO reader failed: ${result.stderr}\n${result.stdout.toString('utf8')}`
  );
  return result.stdout.toString('utf8');
}

async function extractFrame(
  file: string,
  frame: number,
  width: number,
  height: number
): Promise<Uint8Array> {
  const result = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${frame}),scale=${width}:${height}:flags=neighbor`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    result.exit,
    0,
    `ffmpeg could not decode ${file} frame ${frame}: ${result.stderr}`
  );
  assert.equal(
    result.stdout.length,
    width * height * 4,
    `decoded ${file} frame ${frame} is ${result.stdout.length} bytes`
  );
  return new Uint8Array(result.stdout);
}

function rmse(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum / a.length);
}

function blend(
  a: Uint8Array,
  b: Uint8Array,
  weightA: number,
  weightB: number
): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = Math.max(
      0,
      Math.min(255, Math.round((a[i] ?? 0) * weightA + (b[i] ?? 0) * weightB))
    );
  }
  return out;
}

function barColumn(rgb: Uint8Array, width: number, height: number): number {
  let best = 0;
  let bestX = 0;
  const y = Math.floor(height / 2);
  const stride = rgb.length === width * height * 4 ? 4 : 3;
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * stride;
    const lum = (rgb[i] ?? 0) + (rgb[i + 1] ?? 0) + (rgb[i + 2] ?? 0);
    if (lum > best) {
      best = lum;
      bestX = x;
    }
  }
  return bestX;
}

/** Luminance-weighted centre of the above-half-peak run, as a fraction of row width. */
function rowCenter(rgb: Uint8Array, rowWidth: number): number {
  const stride = rgb.length % 4 === 0 && rgb.length !== rowWidth * 3 ? 4 : 3;
  const lum: number[] = [];
  for (let x = 0; x < rowWidth; x++) {
    const i = x * stride;
    lum.push((rgb[i] ?? 0) + (rgb[i + 1] ?? 0) + (rgb[i + 2] ?? 0));
  }
  const half = (Math.min(...lum) + Math.max(...lum)) / 2;
  let sum = 0;
  let weight = 0;
  for (let x = 0; x < rowWidth; x++) {
    const w = Math.max(0, (lum[x] ?? 0) - half);
    sum += (x + 0.5) * w;
    weight += w;
  }
  assert.ok(weight > 0, 'row has no bar brighter than its background');
  return sum / weight / rowWidth;
}

async function frameRowCenter(
  file: string,
  frame: number
): Promise<{ center: number; width: number }> {
  const result = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${frame}),format=rgb24,crop=iw:1:0:trunc(ih/2)`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    result.exit,
    0,
    `ffmpeg could not read ${file} frame ${frame}: ${result.stderr}`
  );
  assert.ok(
    result.stdout.length > 0 && result.stdout.length % 3 === 0,
    `middle row of ${file} frame ${frame} is ${result.stdout.length} bytes`
  );
  const rowWidth = result.stdout.length / 3;
  return {
    center: rowCenter(new Uint8Array(result.stdout), rowWidth),
    width: rowWidth,
  };
}

interface FfprobePacket {
  readonly pts?: number;
  readonly duration?: number;
}

interface FfprobeFrame {
  readonly best_effort_timestamp?: number;
}

interface FfprobeTimingFile {
  readonly stream?: { readonly time_base?: string };
  readonly packets?: readonly FfprobePacket[];
  readonly frames?: readonly FfprobeFrame[];
}

interface FfprobeTimingOracle {
  readonly files?: Readonly<Record<string, FfprobeTimingFile>>;
}

interface PacketWindow {
  readonly start: number;
  readonly end: number;
  readonly frame: number;
}

let decoderTimingOracle: Promise<FfprobeTimingOracle> | undefined;

async function readDecoderTimingOracle(): Promise<FfprobeTimingOracle> {
  decoderTimingOracle ??= readFile(
    join(decoderMediaDir, 'timing-oracle.json'),
    'utf8'
  ).then((text) => JSON.parse(text) as FfprobeTimingOracle);
  return decoderTimingOracle;
}

function ffprobeTimeBase(value: string | undefined, label: string): number {
  assert.ok(value, `${label} has no ffprobe time_base`);
  const [numerator, denominator, extra] = value.split('/');
  assert.equal(extra, undefined, `${label} has malformed time_base ${value}`);
  const seconds = Number(numerator) / Number(denominator);
  assert.ok(
    Number.isFinite(seconds) && seconds > 0,
    `${label} has invalid time_base ${value}`
  );
  return seconds;
}

async function packetWindows(
  fileName: string,
  includeFinal: boolean
): Promise<readonly PacketWindow[]> {
  const oracle = await readDecoderTimingOracle();
  const file = oracle.files?.[fileName];
  assert.ok(file, `ffprobe oracle has no ${fileName}`);
  const timeBase = ffprobeTimeBase(file.stream?.time_base, fileName);
  const frames = (file.frames ?? [])
    .map((frame) => frame.best_effort_timestamp)
    .filter((tick): tick is number => Number.isSafeInteger(tick))
    .sort((a, b) => a - b);
  assert.ok(frames.length > 0, `${fileName} has no presentation frame PTS`);
  const frameByTick = new Map<number, number>();
  for (const [index, tick] of frames.entries()) {
    assert.equal(
      frameByTick.has(tick),
      false,
      `${fileName} has duplicate presentation frame PTS ${tick}`
    );
    frameByTick.set(tick, index);
  }
  const packets = (file.packets ?? [])
    .map((packet) => ({
      pts: packet.pts,
      duration: packet.duration,
    }))
    .filter(
      (
        packet
      ): packet is {
        readonly pts: number;
        readonly duration: number | undefined;
      } => Number.isSafeInteger(packet.pts)
    )
    .sort((a, b) => a.pts - b.pts);
  assert.ok(packets.length > 0, `${fileName} has no packet PTS`);
  const windows: PacketWindow[] = [];
  // This is an independent PTS-to-presentation-frame identity oracle. It is
  // not the production certified-window builder, which uses the reader's own
  // reported packet durations.
  for (const [index, packet] of packets.entries()) {
    const next = packets[index + 1]?.pts;
    assert.notEqual(next, packet.pts, `${fileName} has duplicate packet PTS`);
    if (next !== undefined) {
      const frame = frameByTick.get(packet.pts);
      assert.notEqual(
        frame,
        undefined,
        `${fileName} packet PTS ${packet.pts} has no ffprobe presentation frame`
      );
      windows.push({
        start: packet.pts * timeBase,
        end: next * timeBase,
        frame: frame as number,
      });
      continue;
    }
    if (!includeFinal) continue;
    assert.ok(
      Number.isSafeInteger(packet.duration) && (packet.duration ?? 0) > 0,
      `${fileName} has no certified final packet duration`
    );
    const frame = frameByTick.get(packet.pts);
    assert.notEqual(
      frame,
      undefined,
      `${fileName} packet PTS ${packet.pts} has no ffprobe presentation frame`
    );
    windows.push({
      start: packet.pts * timeBase,
      end: (packet.pts + (packet.duration ?? 0)) * timeBase,
      frame: frame as number,
    });
  }
  return windows;
}

async function finalPacketStartSeconds(fileName: string): Promise<number> {
  const oracle = await readDecoderTimingOracle();
  const file = oracle.files?.[fileName];
  assert.ok(file, `ffprobe oracle has no ${fileName}`);
  const timeBase = ffprobeTimeBase(file.stream?.time_base, fileName);
  const starts = (file.packets ?? [])
    .map((packet) => packet.pts)
    .filter((tick): tick is number => Number.isSafeInteger(tick))
    .sort((a, b) => a - b);
  const last = starts.at(-1);
  assert.ok(last !== undefined, `${fileName} has no final packet PTS`);
  return last * timeBase;
}

function windowForSeconds(
  windows: readonly PacketWindow[],
  seconds: number,
  label: string
): PacketWindow {
  const epsilon = 1e-9;
  const match = windows.find(
    (window) =>
      seconds >= window.start - epsilon && seconds < window.end - epsilon
  );
  assert.ok(
    match,
    `${label} source seconds ${seconds} are not inside an ffprobe packet window`
  );
  return match;
}

interface ChromeSession {
  evaluate<T>(expression: string): Promise<T>;
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  screenshot(label: string): Promise<void>;
  mediaSeekTargets(): Promise<number[]>;
  waitForWorkerHooks(): Promise<void>;
  close(): Promise<void>;
  blocked: string[];
  continuedNonLoopback: string[];
  cspHeaders: string[];
  workerUrls: string[];
  label: string | null;
  getContextEvents?(): Promise<
    Array<{ type: string; timestamp: number; target: string | null }>
  >;
}
interface OpenBrowserOptions {
  readonly label?: string;
  readonly recordMediaSeekTargets?: boolean;
  readonly blockWebCodecs?: boolean;
  readonly blockRequestVideoFrameCallback?: boolean;
  readonly rvfcBusyWaitMs?: number;
}

function loopbackUrl(value: string): boolean {
  if (
    value.startsWith('blob:') ||
    value.startsWith('data:') ||
    value.startsWith('about:')
  )
    return true;
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}
interface CanvasAlphaStatistics {
  readonly sample_count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly zero_count: number;
  readonly opaque_count: number;
}

interface CanvasAlphaCensusRecord {
  readonly sequence: number;
  readonly browser_label: string | null;
  readonly width: number;
  readonly height: number;
  readonly lost: boolean;
  readonly alpha: CanvasAlphaStatistics;
  readonly context_events: ReadonlyArray<{
    readonly type: string;
    readonly timestamp: number;
    readonly target: string | null;
  }>;
  readonly timestamp: number;
}

let nextBrowserSeq = 0;
let nextCanvasAlphaCensusSeq = 0;
const canvasAlphaCensus: CanvasAlphaCensusRecord[] = [];
let latestCanvasAlphaRecord: CanvasAlphaCensusRecord | undefined;

async function persistCanvasAlphaCensus(): Promise<void> {
  try {
    await mkdir(shotDir, { recursive: true });
    await writeFile(
      join(shotDir, 'canvas-alpha-census.json'),
      `${JSON.stringify({ format: 'relic-otio-canvas-alpha-census/v1', census: canvasAlphaCensus, observations: canvasAlphaCensus }, null, 2)}\n`
    );
  } catch {}
}

function formatAlphaCensus(record?: CanvasAlphaCensusRecord | null): string {
  const r = record ?? latestCanvasAlphaRecord;
  if (!r) return 'census:none';
  const a = r.alpha;
  return `census(lost=${r.lost}, alpha=[min=${a.min}, max=${a.max}, mean=${a.mean.toFixed(2)}, zero=${a.zero_count}, opaque=${a.opaque_count}])`;
}

const contextEventLogPrelude = `(() => {
  try {
    const events = [];
    globalThis.__otioContextEvents = events;
    globalThis.__relicOtioContextEvents = events;

    const record = (type, target, event) => {
      try {
        if (event) {
          if (event.__otioLogged) return;
          event.__otioLogged = true;
        }
        events.push({
          type,
          timestamp: performance.timeOrigin + performance.now(),
          target:
            target && target.tagName
              ? target.tagName.toLowerCase() +
                (target.className ? '.' + target.className : '')
              : null,
        });
      } catch {}
    };

    const attach = (canvas) => {
      if (!canvas || canvas.__otioContextObserved) return;
      canvas.__otioContextObserved = true;
      try {
        canvas.addEventListener(
          'contextlost',
          (e) => {
            try {
              record('contextlost', e.target, e);
            } catch {}
          },
          { capture: true, passive: true }
        );
        canvas.addEventListener(
          'contextrestored',
          (e) => {
            try {
              record('contextrestored', e.target, e);
            } catch {}
          },
          { capture: true, passive: true }
        );
      } catch {}
    };

    const scan = () => {
      try {
        const canvases = document.querySelectorAll('canvas.otio-canvas');
        for (let i = 0; i < canvases.length; i++) attach(canvases[i]);
      } catch {}
    };

    window.addEventListener(
      'contextlost',
      (e) => {
        try {
          const t = e.target;
          if (
            t &&
            ((t.matches && t.matches('canvas.otio-canvas')) ||
              (t.classList && t.classList.contains('otio-canvas')))
          ) {
            record('contextlost', t, e);
          }
        } catch {}
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      'contextrestored',
      (e) => {
        try {
          const t = e.target;
          if (
            t &&
            ((t.matches && t.matches('canvas.otio-canvas')) ||
              (t.classList && t.classList.contains('otio-canvas')))
          ) {
            record('contextrestored', t, e);
          }
        } catch {}
      },
      { capture: true, passive: true }
    );

    const setupObserver = () => {
      try {
        scan();
        if (document.documentElement) {
          const observer = new MutationObserver(() => scan());
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
      } catch {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupObserver);
    } else {
      setupObserver();
    }
  } catch {}
})();`;

async function openBrowser(
  url: string,
  sessionToken: string,
  options: OpenBrowserOptions = {}
): Promise<ChromeSession> {
  const named =
    process.env['RELIC_OTIO_CHROME_PATH'] ?? process.env['RELIC_CHROME_PATH'];
  const found = await discoverChrome(
    named && named !== 'none' && named !== 'disabled' ? named : undefined
  );
  assert.equal(
    found.kind,
    'found',
    `no Chrome: ${found.kind === 'not_found' ? found.detail : found.kind}`
  );
  if (found.kind !== 'found') throw new Error('unreachable');
  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-chrome-'));
  const shared = chromeArgs(found.path, profile);
  assert.deepEqual(
    shared.filter(
      (arg) =>
        arg.startsWith('--proxy-bypass-list=') ||
        arg.startsWith('--host-resolver-rules=')
    ),
    [
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-bypass-list=<-loopback>',
    ],
    'shared Chrome network isolation changed; re-derive the OTIO loopback exception'
  );
  let launch: BrowserHeadlessLaunch;
  let child: ChildProcess;
  try {
    launch = createBrowserHeadlessLaunch(
      [
        ...shared.map((arg) =>
          arg === '--proxy-bypass-list=<-loopback>'
            ? `--proxy-bypass-list=<-loopback>;127.0.0.1`
            : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
              ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
              : arg
        ),
        '--autoplay-policy=no-user-gesture-required',
      ],
      profile
    );
    child = spawn(found.path, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  children.add(child);
  const browserSeq = ++nextBrowserSeq;
  const seq = String(browserSeq).padStart(2, '0');
  const label = options.label ?? 'browser';
  const stderrDir = join(shotDir, 'browser-stderr');
  await mkdir(stderrDir, { recursive: true });
  const stderrPath = join(stderrDir, `${seq}-${label}.log`);
  await writeFile(stderrPath, Buffer.alloc(0)).catch(() => {});

  const stderrPipe = child.stdio[2];
  assert.ok(
    stderrPipe instanceof Readable,
    'Chrome fd 2 did not expose a readable stderr pipe'
  );
  const MAX_STDERR_BYTES = 1024 * 1024;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  const flushStderr = async () => {
    try {
      await writeFile(stderrPath, Buffer.concat(stderrChunks));
    } catch {}
  };

  stderrPipe.on('data', (chunk: Buffer) => {
    if (stderrBytes < MAX_STDERR_BYTES) {
      const take = Math.min(chunk.length, MAX_STDERR_BYTES - stderrBytes);
      stderrChunks.push(chunk.subarray(0, take));
      stderrBytes += take;
    }
  });
  stderrPipe.on('end', () => {
    void flushStderr();
  });
  stderrPipe.on('close', () => {
    void flushStderr();
  });
  let startupConnection: CdpConnection | undefined;
  try {
    const toChrome = child.stdio[3];
    const fromChrome = child.stdio[4];
    assert.ok(
      toChrome instanceof Writable,
      'Chrome fd 3 did not expose a writable debug pipe'
    );
    assert.ok(
      fromChrome instanceof Readable,
      'Chrome fd 4 did not expose a readable debug pipe'
    );
    const rawCdp = connectPipe(toChrome, fromChrome);
    const cdp: CdpConnection = {
      ...rawCdp,
      send(method, params, sessionId) {
        const id = ++cdpCallId;
        cdpInFlight.set(id, method);
        return rawCdp
          .send(method, params, sessionId)
          .finally(() => cdpInFlight.delete(id));
      },
    };
    runningBrowsers.push({ child, cdp, profile });
    startupConnection = cdp;
    const blocked: string[] = [];
    const continuedNonLoopback: string[] = [];
    const cspHeaders: string[] = [];
    const workerUrls: string[] = [];
    const workerHookErrors: Error[] = [];
    const workerHooks = new Set<Promise<void>>();
    let stopWorkerAttach: (() => void) | undefined;
    const documentUrl = url.split('#')[0] ?? url;
    await attestBrowserHeadless(cdp, launch);
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
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );
    const stopResponses = cdp.onEvent((event) => {
      if (
        event.method !== 'Network.responseReceived' ||
        event.sessionId !== sessionId
      )
        return;
      const params = event.params as {
        response?: {
          url?: string;
          headers?: Record<string, string | number | boolean>;
        };
      };
      const response = params.response;
      if (response === undefined || response.url !== documentUrl) return;
      for (const [name, value] of Object.entries(response.headers ?? {})) {
        if (name.toLowerCase() === 'content-security-policy')
          cspHeaders.push(String(value));
      }
    });
    const stopEvents = cdp.onEvent((event) => {
      if (
        event.method !== 'Fetch.requestPaused' ||
        event.sessionId !== sessionId
      )
        return;
      const params = event.params as {
        requestId?: string;
        request?: { url?: string };
      };
      const requestUrl = params.request?.url ?? '';
      const requestId = params.requestId;
      if (!requestId) return;
      if (loopbackUrl(requestUrl)) {
        void cdp
          .send('Fetch.continueRequest', { requestId }, sessionId)
          .catch(() => {});
        return;
      }
      blocked.push(requestUrl);
      void cdp
        .send(
          'Fetch.failRequest',
          { requestId, errorReason: 'BlockedByClient' },
          sessionId
        )
        .catch(() => {});
    });
    const webCodecsTrap = String.raw`(() => {
    for (const name of ['VideoDecoder', 'AudioDecoder']) {
      const constructor = Reflect.get(globalThis, name);
      if (typeof constructor !== 'function') continue;
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error('__RELIC_OTIO_WEB_CODECS__ ' + name);
        },
      });
    }
  })();`;
    const blockRVFC = Boolean(
      options.blockRequestVideoFrameCallback ||
        process.env.RELIC_OTIO_BLOCK_RVFC === '1'
    );
    const rvfcTrap = String.raw`(() => {
      try {
        delete HTMLVideoElement.prototype.requestVideoFrameCallback;
      } catch {}
      try {
        delete globalThis.requestVideoFrameCallback;
      } catch {}
    })();`;
    const busyWaitMs = options.rvfcBusyWaitMs ?? 0;
    const rvfcLateTrap =
      busyWaitMs > 0
        ? `(() => {
      const busy = ${busyWaitMs};
      const orig = HTMLVideoElement.prototype.requestVideoFrameCallback;
      if (typeof orig !== 'function') return;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return orig.call(this, (_now, metadata) => {
          const start = performance.now();
          while (performance.now() - start < busy) {}
          return callback.call(this, performance.now(), metadata);
        });
      };
    })();`
        : '';
    const pagePrelude = [
      options.recordMediaSeekTargets
        ? String.raw`(() => {
          const key = '__relicOtioMediaSeekTargets';
          const videoKey = '__relicOtioVideoSeekTargets';
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            'currentTime'
          );
          if (!descriptor?.get || !descriptor.set || !descriptor.configurable) return;
          Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
              return descriptor.get.call(this);
            },
            set(value) {
              const targets = Reflect.get(globalThis, key) ?? [];
              targets.push(Number(value));
              Reflect.set(globalThis, key, targets);
              if (this instanceof HTMLVideoElement || this.tagName === 'VIDEO') {
                const videoTargets = Reflect.get(globalThis, videoKey) ?? [];
                videoTargets.push(Number(value));
                Reflect.set(globalThis, videoKey, videoTargets);
              }
              descriptor.set.call(this, value);
            },
          });
        })();`
        : '',
      blockRVFC ? rvfcTrap : '',
      rvfcLateTrap,
      contextEventLogPrelude,
      options.blockWebCodecs ? webCodecsTrap : '',
    ]
      .filter(Boolean)
      .join(';\n');
    if (pagePrelude) {
      await cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: pagePrelude },
        sessionId
      );
    }
    if (options.blockWebCodecs) {
      stopWorkerAttach = cdp.onEvent((event) => {
        if (event.method !== 'Target.attachedToTarget') return;
        const params = event.params as {
          sessionId?: string;
          targetInfo?: { type?: string; url?: string };
        };
        const workerSessionId = params.sessionId;
        if (!workerSessionId) return;
        if (params.targetInfo?.type !== 'worker') {
          void cdp
            .send('Runtime.runIfWaitingForDebugger', {}, workerSessionId)
            .catch(() => {});
          return;
        }
        workerUrls.push(params.targetInfo.url ?? '');
        const hook = (async () => {
          try {
            await cdp.send('Runtime.enable', {}, workerSessionId);
            const patched = await cdp.send(
              'Runtime.evaluate',
              { expression: webCodecsTrap, returnByValue: true },
              workerSessionId
            );
            if (patched['exceptionDetails'])
              throw new Error(
                `could not trap WebCodecs in worker ${params.targetInfo?.url ?? ''}`
              );
          } catch (error) {
            workerHookErrors.push(
              error instanceof Error ? error : new Error(String(error))
            );
          } finally {
            await cdp
              .send('Runtime.runIfWaitingForDebugger', {}, workerSessionId)
              .catch((error) => {
                workerHookErrors.push(
                  error instanceof Error ? error : new Error(String(error))
                );
              });
          }
        })();
        workerHooks.add(hook);
        void hook.then(() => workerHooks.delete(hook));
      });
      await cdp.send(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        },
        sessionId
      );
    }
    await cdp.send(
      'Network.setCookie',
      {
        name: 'relic_session',
        value: sessionToken,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      sessionId
    );
    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId,
      timeoutMs: 20000,
    });
    const navigated = await cdp.send('Page.navigate', { url }, sessionId);
    if (navigated['errorText'] !== undefined) {
      loaded.catch(() => {});
      assert.fail(`navigation failed: ${String(navigated['errorText'])}`);
    }
    await loaded;
    const landed = await cdp.send(
      'Runtime.evaluate',
      {
        expression: 'location.origin',
        returnByValue: true,
      },
      sessionId
    );
    assert.equal(
      (landed['result'] as { value?: unknown } | undefined)?.value,
      new URL(url).origin,
      'browser did not land on the service origin'
    );
    return {
      blocked,
      continuedNonLoopback,
      cspHeaders,
      workerUrls,
      label,
      async getContextEvents(): Promise<
        Array<{ type: string; timestamp: number; target: string | null }>
      > {
        return (await cdp
          .send(
            'Runtime.evaluate',
            {
              expression: '(globalThis.__otioContextEvents || []).slice()',
              returnByValue: true,
            },
            sessionId
          )
          .then(
            (res) => (res['result'] as { value?: unknown } | undefined)?.value
          )
          .catch(() => [])) as Array<{
          type: string;
          timestamp: number;
          target: string | null;
        }>;
      },
      send: (method, params) => cdp.send(method, params, sessionId),
      async evaluate<T>(expression: string): Promise<T> {
        const res = await cdp.send(
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: 15000,
          },
          sessionId
        );
        const exception = res['exceptionDetails'] as
          | { text?: string; exception?: { description?: string } }
          | undefined;
        assert.ok(
          !exception,
          `page evaluation failed: ${exception?.text ?? exception?.exception?.description ?? JSON.stringify(res)}`
        );
        const inner = res['result'] as { value?: T } | undefined;
        return inner?.value as T;
      },
      async mediaSeekTargets(): Promise<number[]> {
        const result = await cdp.send(
          'Runtime.evaluate',
          {
            expression:
              'Array.isArray(globalThis.__relicOtioMediaSeekTargets) ? globalThis.__relicOtioMediaSeekTargets : []',
            returnByValue: true,
          },
          sessionId
        );
        const value = (result['result'] as { value?: unknown } | undefined)
          ?.value;
        return Array.isArray(value)
          ? value.filter((entry): entry is number => typeof entry === 'number')
          : [];
      },
      async waitForWorkerHooks(): Promise<void> {
        await Promise.all([...workerHooks]);
        assert.deepEqual(
          workerHookErrors,
          [],
          `could not install the WebCodecs trap: ${workerHookErrors.map((error) => error.message).join('; ')}`
        );
      },
      async screenshot(label: string): Promise<void> {
        const shot = (await cdp.send(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId
        )) as { data: string };
        const bytes = Buffer.from(shot.data, 'base64');
        assert.ok(bytes.length > 1000, `screenshot ${label} is empty`);
        await writeFile(join(shotDir, `${label}.png`), bytes);
      },
      async close(): Promise<void> {
        await cdp
          .send(
            'Runtime.evaluate',
            {
              expression: `(() => {
          for (const node of document.querySelectorAll('audio,video')) {
            node.pause();
            node.removeAttribute('src');
            node.load();
          }
          document.querySelector('.otio-view')?.dispatchEvent(new Event('pagehide'));
        })()`,
              awaitPromise: true,
            },
            sessionId
          )
          .catch(() => {});
        stopEvents();
        stopResponses();
        stopWorkerAttach?.();
        await cdp
          .send(
            'Target.setAutoAttach',
            {
              autoAttach: false,
              waitForDebuggerOnStart: false,
              flatten: true,
            },
            sessionId
          )
          .catch(() => {});
        try {
          const events = (await cdp
            .send(
              'Runtime.evaluate',
              {
                expression: '(globalThis.__otioContextEvents || []).slice()',
                returnByValue: true,
              },
              sessionId
            )
            .then(
              (res) => (res['result'] as { value?: unknown } | undefined)?.value
            )
            .catch(() => [])) as unknown[];
          if (Array.isArray(events) && events.length > 0) {
            const contextEventsDir = join(shotDir, 'context-events');
            await mkdir(contextEventsDir, { recursive: true });
            await writeFile(
              join(contextEventsDir, `${seq}-${label}.json`),
              `${JSON.stringify({ sequence: seq, label, events }, null, 2)}\n`
            );
          }
        } catch {}
        await flushStderr();
        await cdp.send('Browser.close').catch(() => {});
        child.kill('SIGKILL');
        children.delete(child);
        const idx = runningBrowsers.findIndex((b) => b.child === child);
        if (idx !== -1) runningBrowsers.splice(idx, 1);
        cdp.dispose();
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await flushStderr();
    await cleanupOwnedBrowserStartup({
      child,
      connection: startupConnection,
      forgetChild: () => children.delete(child),
      profile,
      removeProfile: undefined,
    });
    throw error;
  }
}

async function waitReady(browser: ChromeSession): Promise<string> {
  const ready = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const start = Date.now();
    const tick = () => {
      const root = document.querySelector('.otio-view');
      const state = root?.dataset?.ready ?? '';
      if (state === 'true' || state === 'diagnostic' || state === 'structural' || state === 'error') resolve(state);
      else if (Date.now() - start > 20000) resolve(state || 'timeout');
      else setTimeout(tick, 100);
    };
    tick();
    return promise;
  })()`);
  assert.notEqual(ready, 'error', 'OTIO view reported a parse error');
  assert.ok(
    ready === 'true' || ready === 'diagnostic' || ready === 'structural',
    `OTIO view never settled: ${ready}`
  );
  return ready;
}

async function seekTo(browser: ChromeSession, frame: number): Promise<void> {
  const landed = await browser.evaluate<boolean>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const seek = document.querySelector('input.otio-seek');
    if (!seek) { resolve(false); return promise; }
    seek.value = '${frame}';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    const start = Date.now();
    const tick = () => {
      const root = document.querySelector('.otio-view');
      if (root && root.dataset.buffering === 'false' && Number(root.dataset.frame) === ${frame}) resolve(true);
      else if (Date.now() - start > 12000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
    return promise;
  })()`);
  assert.equal(
    landed,
    true,
    `seek to frame ${frame} did not settle on a decoded frame`
  );
}

interface SampledCanvas extends Uint8Array {
  dataFrame?: number | null;
  center?: number | null;
}

const CANVAS_READ_FN = `(width, height) => {
  const view = document.querySelector('section.otio-view');
  const dataFrameAttr = view?.getAttribute('data-frame') ?? null;
  const data_frame = dataFrameAttr !== null ? Number(dataFrameAttr) : null;
  const canvas = document.querySelector('canvas.otio-canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const lost = typeof ctx?.isContextLost === 'function' ? ctx.isContextLost() : false;
  let src = null;
  try {
    src = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
  } catch {}
  if (!src) {
    src = new Uint8Array(canvas.width * canvas.height * 4);
  }
  const out = [];
  let alphaMin = 255;
  let alphaMax = 0;
  let alphaSum = 0;
  let alphaZeroCount = 0;
  let alphaOpaqueCount = 0;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(canvas.height - 1, Math.floor(y * canvas.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(canvas.width - 1, Math.floor(x * canvas.width / width));
      const i = (sy * canvas.width + sx) * 4;
      out.push(src[i], src[i + 1], src[i + 2], src[i + 3]);
      const a = src[i + 3];
      if (a < alphaMin) alphaMin = a;
      if (a > alphaMax) alphaMax = a;
      alphaSum += a;
      if (a === 0) alphaZeroCount++;
      if (a === 255) alphaOpaqueCount++;
    }
  }
  let center = null;
  if (src && canvas.width > 0) {
    const cy = Math.floor(canvas.height / 2);
    const lum = [];
    for (let x = 0; x < canvas.width; x++) {
      const i = (cy * canvas.width + x) * 4;
      lum.push((src[i] ?? 0) + (src[i + 1] ?? 0) + (src[i + 2] ?? 0));
    }
    const half = (Math.min(...lum) + Math.max(...lum)) / 2;
    let sum = 0;
    let weight = 0;
    for (let x = 0; x < canvas.width; x++) {
      const w = Math.max(0, (lum[x] ?? 0) - half);
      sum += (x + 0.5) * w;
      weight += w;
    }
    if (weight > 0) {
      center = sum / weight / canvas.width;
    }
  }
  const sample_count = width * height;
  return {
    values: out,
    lost,
    context_events: (globalThis.__otioContextEvents || []).slice(),
    alpha: {
      sample_count,
      min: sample_count > 0 ? alphaMin : 0,
      max: sample_count > 0 ? alphaMax : 0,
      mean: sample_count > 0 ? alphaSum / sample_count : 0,
      zero_count: alphaZeroCount,
      opaque_count: alphaOpaqueCount,
    },
    data_frame,
    center,
  };
}`;

async function sampleCanvas(
  browser: ChromeSession,
  width: number,
  height: number
): Promise<SampledCanvas> {
  const read = await browser.evaluate<{
    values: number[] | null;
    lost: boolean;
    context_events: Array<{
      type: string;
      timestamp: number;
      target: string | null;
    }>;
    alpha: CanvasAlphaStatistics;
    data_frame: number | null;
    center: number | null;
  }>(`(${CANVAS_READ_FN})(${width}, ${height})`);
  assert.ok(
    read?.values && read.values.length === width * height * 4,
    'canvas sample missing'
  );
  const record: CanvasAlphaCensusRecord = {
    sequence: ++nextCanvasAlphaCensusSeq,
    browser_label: browser.label ?? null,
    width,
    height,
    lost: Boolean(read.lost),
    alpha: read.alpha,
    context_events: read.context_events ?? [],
    timestamp: Date.now(),
  };
  canvasAlphaCensus.push(record);
  latestCanvasAlphaRecord = record;
  await persistCanvasAlphaCensus();
  const pixels = Uint8Array.from(read.values) as SampledCanvas;
  pixels.dataFrame = read.data_frame;
  pixels.center = read.center;
  return pixels;
}

type LabelCaptureRequest =
  | {
      readonly kind: 'targets';
      readonly targets: readonly number[];
    }
  | {
      readonly kind: 'intervals';
      readonly intervals: readonly {
        readonly frame: number;
        readonly lo: number;
        readonly hi: number;
        readonly span: number;
      }[];
    };

async function installLabelCapture(
  browser: ChromeSession,
  width: number,
  height: number,
  req: LabelCaptureRequest
): Promise<void> {
  await browser.evaluate<void>(`(() => {
    if (globalThis.__otioLabelObserver) {
      globalThis.__otioLabelObserver.disconnect();
      delete globalThis.__otioLabelObserver;
    }
    globalThis.__otioLabelCaptures = [];
    const req = ${JSON.stringify(req)};
    const readCanvas = ${CANVAS_READ_FN};
    const view = document.querySelector('section.otio-view');
    if (!view) throw new Error('section.otio-view not found');

    const remainingTargets = req.kind === 'targets' ? [...req.targets] : [];
    const capturedFrames = new Set();

    const onCallback = () => {
      if (view.dataset.playing !== 'true') return;
      const frameAttr = view.dataset.frame;
      if (frameAttr === undefined || frameAttr === null || frameAttr === '') return;
      const df = Number(frameAttr);
      if (!Number.isFinite(df)) return;

      if (req.kind === 'targets') {
        const reached = [];
        while (remainingTargets.length > 0 && remainingTargets[0] <= df) {
          reached.push(remainingTargets.shift());
        }
        if (reached.length > 0) {
          const read = readCanvas(${width}, ${height});
          if (read) {
            for (const target of reached) {
              globalThis.__otioLabelCaptures.push({
                target,
                data_frame: df,
                ...read,
              });
            }
          }
        }
      } else if (req.kind === 'intervals') {
        for (const interval of req.intervals) {
          if (!capturedFrames.has(interval.frame) && df >= interval.lo && df < interval.hi) {
            capturedFrames.add(interval.frame);
            const read = readCanvas(${width}, ${height});
            if (read) {
              globalThis.__otioLabelCaptures.push({
                frame: interval.frame,
                span: interval.span,
                data_frame: df,
                ...read,
              });
            }
            break;
          }
        }
      }
    };

    const observer = new MutationObserver(() => {
      onCallback();
    });
    observer.observe(view, {
      attributes: true,
      attributeFilter: ['data-frame'],
    });
    globalThis.__otioLabelObserver = observer;
  })()`);
}

interface WaitLabelCapturesOptions {
  readonly count?: number;
  readonly untilFrame?: number;
  readonly ceiling?: number;
  readonly timeoutMs?: number;
  readonly label?: string;
}

async function waitLabelCaptures(
  browser: ChromeSession,
  options: WaitLabelCapturesOptions
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const label = options.label ?? 'playback';
  const start = Date.now();
  let lastDf: number | null = null;
  let lastCount = 0;

  while (Date.now() - start < timeoutMs) {
    const status = await browser.evaluate<{
      readonly df: number | null;
      readonly count: number;
    }>(`(() => {
      const root = document.querySelector('section.otio-view');
      const frameAttr = root?.getAttribute('data-frame') ?? null;
      const df = frameAttr !== null ? Number(frameAttr) : null;
      const count = (globalThis.__otioLabelCaptures || []).length;
      return { df: Number.isFinite(df) ? df : null, count };
    })()`);

    lastDf = status.df;
    lastCount = status.count;

    if (options.count !== undefined && status.count >= options.count) {
      return;
    }
    if (
      options.untilFrame !== undefined &&
      status.df !== null &&
      status.df >= options.untilFrame
    ) {
      return;
    }
    if (
      options.ceiling !== undefined &&
      status.df !== null &&
      status.df > options.ceiling
    ) {
      if (options.count !== undefined && status.count < options.count) {
        assert.fail(
          `${label} captured ${status.count}/${options.count} label samples before timeout; last label ${status.df}`
        );
      }
    }

    await Bun.sleep(50);
  }

  if (options.count !== undefined) {
    assert.fail(
      `${label} captured ${lastCount}/${options.count} label samples before timeout; last label ${lastDf ?? 'none'}`
    );
  }
  if (options.untilFrame !== undefined) {
    assert.fail(
      `${label} reached label ${lastDf ?? 'none'} before timeout waiting for frame ${options.untilFrame}`
    );
  }
}

interface LabelCaptureItem {
  readonly sample: SampledCanvas;
  readonly dataFrame: number;
  readonly center: number;
  readonly target?: number | undefined;
  readonly frame?: number | undefined;
  readonly span?: number | undefined;
}

async function collectLabelCaptures(
  browser: ChromeSession,
  width: number,
  height: number
): Promise<readonly LabelCaptureItem[]> {
  const rawCaptures = await browser.evaluate<
    Array<{
      readonly values: number[] | null;
      readonly lost: boolean;
      readonly context_events: Array<{
        readonly type: string;
        readonly timestamp: number;
        readonly target: string | null;
      }>;
      readonly alpha: CanvasAlphaStatistics;
      readonly data_frame: number | null;
      readonly center: number | null;
      readonly target?: number;
      readonly frame?: number;
      readonly span?: number;
    }>
  >(`(() => {
    if (globalThis.__otioLabelObserver) {
      globalThis.__otioLabelObserver.disconnect();
      delete globalThis.__otioLabelObserver;
    }
    const captures = (globalThis.__otioLabelCaptures || []).slice();
    delete globalThis.__otioLabelCaptures;
    return captures;
  })()`);

  const results: LabelCaptureItem[] = [];
  for (const capture of rawCaptures) {
    assert.ok(
      capture?.values && capture.values.length === width * height * 4,
      'canvas sample missing'
    );
    const record: CanvasAlphaCensusRecord = {
      sequence: ++nextCanvasAlphaCensusSeq,
      browser_label: browser.label ?? null,
      width,
      height,
      lost: Boolean(capture.lost),
      alpha: capture.alpha,
      context_events: capture.context_events ?? [],
      timestamp: Date.now(),
    };
    canvasAlphaCensus.push(record);
    latestCanvasAlphaRecord = record;

    const pixels = Uint8Array.from(capture.values) as SampledCanvas;
    pixels.dataFrame = capture.data_frame;
    pixels.center = capture.center;

    assert.ok(
      typeof capture.center === 'number' && Number.isFinite(capture.center),
      'missing center row bar measurement'
    );
    assert.ok(
      typeof capture.data_frame === 'number' &&
        Number.isFinite(capture.data_frame),
      'missing data_frame in label capture'
    );

    results.push({
      sample: pixels,
      dataFrame: capture.data_frame,
      center: capture.center,
      target: capture.target,
      frame: capture.frame,
      span: capture.span,
    });
  }
  await persistCanvasAlphaCensus();
  return results;
}

async function layerPacketStarts(mediaFile: string): Promise<number[]> {
  const result = await runChild(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=time_base:packet=pts',
      '-of',
      'json',
      mediaFile,
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    result.exit,
    0,
    `ffprobe failed on ${mediaFile}: ${result.stderr}`
  );
  const parsed = JSON.parse(result.stdout.toString('utf8')) as {
    streams?: Array<{ time_base?: string }>;
    packets?: Array<{ pts?: number }>;
  };
  const stream = parsed.streams?.[0];
  assert.ok(stream?.time_base, `${mediaFile} has no stream time_base`);
  const [num, den, extra] = stream.time_base.split('/');
  assert.equal(
    extra,
    undefined,
    `${mediaFile} malformed time_base ${stream.time_base}`
  );
  const timeBase = Number(num) / Number(den);
  assert.ok(
    Number.isFinite(timeBase) && timeBase > 0,
    `${mediaFile} invalid timeBase ${stream.time_base}`
  );
  const packets = (parsed.packets ?? [])
    .map((p) => p.pts)
    .filter((pts): pts is number => Number.isSafeInteger(pts))
    .sort((a, b) => a - b);
  assert.ok(packets.length > 0, `${mediaFile} has no packets`);
  const firstPacket = packets[0];
  assert.ok(
    firstPacket !== undefined && Math.abs(firstPacket * timeBase) < 1e-9,
    `${mediaFile} first packet is not at 0`
  );
  return packets.map((pts) => pts * timeBase);
}

async function canvasRowCenter(browser: ChromeSession): Promise<number> {
  const row = await browser.evaluate<number[] | null>(`(() => {
    const canvas = document.querySelector('canvas.otio-canvas');
    if (!canvas) return null;
    const data = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
    const out = [];
    for (let x = 0; x < canvas.width; x++) out.push(data[x * 4], data[x * 4 + 1], data[x * 4 + 2], data[x * 4 + 3]);
    return out;
  })()`);
  assert.ok(
    row && row.length > 0 && row.length % 4 === 0,
    'canvas row missing'
  );
  return rowCenter(Uint8Array.from(row), row.length / 4);
}

async function setTracksHidden(
  browser: ChromeSession,
  trackIds: readonly string[],
  hidden: boolean
): Promise<void> {
  for (const trackId of trackIds) {
    const pressed = await browser.evaluate<string | null>(`(() => {
      const toggle = document.querySelector(${JSON.stringify(`button[data-track-toggle="${trackId}"]`)});
      if (!toggle) return null;
      if (toggle.getAttribute('aria-pressed') !== ${JSON.stringify(String(hidden))}) toggle.click();
      return toggle.getAttribute('aria-pressed');
    })()`);
    assert.equal(
      pressed,
      String(hidden),
      `Hide toggle for ${trackId} did not reach aria-pressed=${hidden}`
    );
  }
}
async function assertTrackVisible(
  browser: ChromeSession,
  trackId: string
): Promise<void> {
  const pressed = await browser.evaluate<string | null>(`(() => {
    const toggle = document.querySelector(${JSON.stringify(`button[data-track-toggle="${trackId}"]`)});
    return toggle?.getAttribute('aria-pressed') ?? null;
  })()`);
  assert.equal(
    pressed,
    'false',
    `default view hid track ${trackId} before the negative-head probe`
  );
}

async function selectTrack(
  browser: ChromeSession,
  trackId: string,
  mode: 'point' | 'range' | 'track',
  start: number,
  end: number
): Promise<void> {
  const selected = await browser.evaluate<{
    track: string;
    start: string;
    duration: string;
  }>(`(() => {
    const select = document.querySelector('select.otio-track-select');
    if (![...select.options].some((option) => option.value === ${JSON.stringify(trackId)})) return null;
    select.value = ${JSON.stringify(trackId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('button[data-otio-mode="${mode}"]').click();
    const input = document.querySelector('.otio-selection-in');
    const out = document.querySelector('.otio-selection-out');
    input.value = '${start}';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if ('${mode}' === 'range') {
      out.value = '${end}';
      out.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const mark = document.querySelector('.otio-selection');
    return { track: mark?.dataset?.trackId ?? '', start: mark?.dataset?.start ?? '', duration: mark?.dataset?.duration ?? '' };
  })()`);
  assert.ok(selected, `track ${trackId} is not in the comment track select`);
  assert.equal(
    selected.track,
    trackId,
    `selection landed on ${selected.track}, not ${trackId}`
  );
  if (mode === 'point')
    assert.equal(selected.duration, '0', 'point selection has a duration');
  if (mode === 'track')
    assert.ok(
      Number(selected.duration) > 0,
      `whole-track selection has no exposed core: ${JSON.stringify(selected)}`
    );
}

interface HeldComposerProbe {
  readonly sameField: boolean;
  readonly text: string;
  readonly focused: boolean;
  readonly track: string;
  readonly start: number;
  readonly duration: number;
  readonly rate: number;
  readonly moved: boolean;
  readonly sidebarClosed: boolean;
}

async function aimHeldDraftWithPointer(
  browser: ChromeSession,
  trackId: string,
  draft: string,
  fromFrame: number,
  toFrame: number
): Promise<HeldComposerProbe> {
  const rail = await browser.evaluate<{
    x: number;
    y: number;
    end: number;
  } | null>(
    `(() => {
      const field = document.querySelector(
        '.popover-card.popover-composer.is-otio-composer textarea, .popover-composer textarea'
      );
      const rail = [...document.querySelectorAll('.otio-track-rail')].find(
        (row) => row.dataset.trackId === ${JSON.stringify(trackId)});
      if (!(field instanceof HTMLTextAreaElement) || !(rail instanceof HTMLElement)) return null;
      field.value = ${JSON.stringify(draft)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.blur();
      window.__otioHeldField = field;
      const card = document.querySelector(
        '.popover-card.popover-composer.is-otio-composer, .popover-card.popover-composer'
      );
      window.__otioInitialCardRect = card ? card.getBoundingClientRect() : null;
      const box = rail.getBoundingClientRect();
      const count = Number(document.querySelector('input.otio-seek')?.max) + 1;
      return {
        x: box.left + box.width * ${fromFrame} / count,
        end: box.left + box.width * ${toFrame} / count,
        y: box.top + box.height / 2,
      };
    })()`
  );
  assert.ok(rail, `no visible rail for ${trackId}`);
  for (const event of [
    { type: 'mouseMoved', x: rail.x, y: rail.y, button: 'none' },
    {
      type: 'mousePressed',
      x: rail.x,
      y: rail.y,
      button: 'left',
      clickCount: 1,
    },
    { type: 'mouseMoved', x: rail.end, y: rail.y, button: 'left', buttons: 1 },
    {
      type: 'mouseReleased',
      x: rail.end,
      y: rail.y,
      button: 'left',
      clickCount: 1,
    },
  ])
    await browser.send('Input.dispatchMouseEvent', event);
  return browser.evaluate<HeldComposerProbe>(`(() => {
    const field = document.querySelector(
      '.popover-card.popover-composer.is-otio-composer textarea, .popover-composer textarea'
    );
    const mark = document.querySelector('.otio-selection');
    const finalCard = document.querySelector(
      '.popover-card.popover-composer.is-otio-composer, .popover-card.popover-composer'
    );
    const initial = window.__otioInitialCardRect;
    const finalRect = finalCard ? finalCard.getBoundingClientRect() : null;
    const thread = document.querySelector('.thread');
    const toggle = document.querySelector('.thread-toggle');
    const moved =
      initial &&
      finalRect &&
      (Math.abs(initial.left - finalRect.left) > 1 ||
        Math.abs(initial.top - finalRect.top) > 1);
    const sidebarClosed =
      (thread === null || !thread.classList.contains('is-open')) &&
      toggle?.getAttribute('aria-expanded') !== 'true';
    return {
      sameField: field === window.__otioHeldField,
      text: field?.value ?? '',
      focused: field === document.activeElement,
      track: mark?.dataset.trackId ?? '',
      start: Number(mark?.dataset.start),
      duration: Number(mark?.dataset.duration),
      rate: Number(mark?.dataset.rate),
      moved: !!moved,
      sidebarClosed,
    };
  })()`);
}
async function clickWithRealPointer(
  browser: ChromeSession,
  x: number,
  y: number
): Promise<void> {
  for (const event of [
    { type: 'mouseMoved', x, y, button: 'none' },
    {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    },
    {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    },
  ])
    await browser.send('Input.dispatchMouseEvent', event);
}

async function postComposer(
  browser: ChromeSession,
  body: string
): Promise<void> {
  const posted = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    document.querySelector('button.otio-comment-selection')?.click();
    const start = Date.now();
    const tick = () => {
      const composer = document.querySelector(
        '.popover-card.popover-composer.is-otio-composer'
      );
      const field = composer?.querySelector('textarea.popover-field');
      const submit = [
        ...(composer?.querySelectorAll(
          'button.popover-action.is-primary'
        ) ?? []),
      ].find((button) => button.textContent === 'Post');
      if (
        field instanceof HTMLTextAreaElement &&
        submit instanceof HTMLButtonElement
      ) {
        field.value = ${JSON.stringify(body)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
        submit.click();
        const wait = Date.now();
        const done = () => {
          if (document.body.textContent.includes(${JSON.stringify(body)}))
            resolve('posted');
          else if (Date.now() - wait > 10000) resolve('timeout');
          else setTimeout(done, 100);
        };
        done();
        return;
      }
      if (Date.now() - start > 4000) resolve('no-composer');
      else setTimeout(tick, 50);
    };
    tick();
    return promise;
  })()`);
  if (posted !== 'posted') {
    const failure = await browser.evaluate<Record<string, unknown>>(
      String.raw`(() => {
        const card = document.querySelector('.popover-card');
        const composer = document.querySelector(
          '.popover-card.popover-composer.is-otio-composer'
        );
        const field = composer?.querySelector('textarea.popover-field');
        const submit = [...(composer?.querySelectorAll('button') ?? [])].find(
          (button) => button.textContent === 'Post'
        );
        const note = composer?.querySelector('.popover-note');
        const selection = document.querySelector('.otio-selection');
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const rect = (node) => {
          if (!(node instanceof Element)) return null;
          const value = node.getBoundingClientRect();
          return {
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            width: value.width,
            height: value.height,
          };
        };
        return {
          posted: ${JSON.stringify(posted)},
          payload: {
            expectedBody: ${JSON.stringify(body)},
            fieldValue: field instanceof HTMLTextAreaElement ? field.value : null,
            selection: {
              trackId: selection?.getAttribute('data-track-id') ?? null,
              start: selection?.getAttribute('data-start') ?? null,
              duration: selection?.getAttribute('data-duration') ?? null,
              rate: selection?.getAttribute('data-rate') ?? null,
              durationRate:
                selection?.getAttribute('data-duration-rate') ?? null,
            },
          },
          card: rect(card),
          composer: {
            present: composer !== null,
            visible: visible(composer),
            className: composer?.getAttribute('class') ?? null,
            ariaBusy: composer?.getAttribute('aria-busy') ?? null,
            text: composer?.textContent ?? '',
          },
          submit: {
            present: submit !== undefined,
            disabled: submit?.hasAttribute('disabled') ?? false,
            ariaBusy: submit?.getAttribute('aria-busy') ?? null,
            text: submit?.textContent ?? null,
          },
          note: {
            present: note != null,
            visible: visible(note),
            text: note?.textContent ?? '',
          },
          bodyVisible: document.body.textContent?.includes(${JSON.stringify(body)}) ?? false,
        };
      })()`
    );
    await browser.screenshot('otio-post-composer-failure');
    console.log(`OTIO_POST_COMPOSER_FAILURE ${JSON.stringify(failure)}`);
  }
  assert.equal(
    posted,
    'posted',
    `native composer did not submit ${JSON.stringify(body)}: ${posted}`
  );

  const postedCard = await browser.evaluate<{
    readonly present: boolean;
    readonly visible: boolean;
    readonly cardId: string | null;
    readonly anchorKind: string | null;
    readonly hasNoField: boolean;
    readonly gapValid: boolean;
    readonly gap: number | null;
    readonly horizontalCentred: boolean;
    readonly overlapArea: number;
    readonly sidebarUntouched: boolean;
    readonly focusInside: boolean;
  }>(String.raw`(() => {
    const card = document.querySelector('.popover-card[data-comment-id]');
    const thread = document.querySelector('.thread');
    const toggle = document.querySelector('.thread-toggle');
    const markId = card?.getAttribute('data-comment-id');
    const mark = markId
      ? document.querySelector('.otio-comment-mark[data-comment-id="' + markId + '"]')
      : null;
    const stage = document.querySelector('.stage-wrap');

    const rect = (n) => {
      if (!(n instanceof HTMLElement)) return null;
      const v = n.getBoundingClientRect();
      return { left: v.left, top: v.top, right: v.right, bottom: v.bottom, width: v.width, height: v.height };
    };
    const cardRect = rect(card);
    const markRect = rect(mark);
    const stageRect = rect(stage);

    const side =
      card?.getAttribute('data-side') ??
      (cardRect && markRect && cardRect.top >= markRect.bottom ? 'below' : 'above');
    let gap = null;
    let gapValid = false;
    let horizontalCentred = false;
    let overlapArea = 0;
    if (cardRect && markRect) {
      gap =
        side === 'below'
          ? Math.abs(cardRect.top - markRect.bottom - 8)
          : Math.abs(markRect.top - cardRect.bottom - 8);
      gapValid = gap <= 1.5;
      const markCenterX = (markRect.left + markRect.right) / 2;
      const againstMargin = stageRect
        ? cardRect.left <= stageRect.left + 9 || cardRect.right >= stageRect.right - 9
        : false;
      horizontalCentred =
        againstMargin ||
        (markCenterX >= cardRect.left - 1 && markCenterX <= cardRect.right + 1);
      const overlapW = Math.max(
        0,
        Math.min(cardRect.right, markRect.right) - Math.max(cardRect.left, markRect.left)
      );
      const overlapH = Math.max(
        0,
        Math.min(cardRect.bottom, markRect.bottom) - Math.max(cardRect.top, markRect.top)
      );
      overlapArea = overlapW * overlapH;
    }

    const activeEl = document.activeElement;
    const focusInside =
      card instanceof HTMLElement &&
      activeEl instanceof HTMLElement &&
      (card === activeEl || card.contains(activeEl));
    const sidebarUntouched =
      (thread === null || !thread.classList.contains('is-open')) &&
      toggle?.getAttribute('aria-expanded') !== 'true';

    return {
      present: card instanceof HTMLElement,
      visible: cardRect !== null && cardRect.width > 0 && cardRect.height > 0,
      cardId: markId ?? null,
      anchorKind: card?.getAttribute('data-anchor-kind') ?? null,
      hasNoField: card?.querySelector('.popover-field') === null,
      gapValid,
      gap,
      horizontalCentred,
      overlapArea,
      sidebarUntouched,
      focusInside,
    };
  })()`);

  assert.equal(postedCard.present, true, 'posted comment card is not present');
  assert.equal(postedCard.visible, true, 'posted comment card is not visible');
  assert.equal(
    postedCard.hasNoField,
    true,
    'posted comment card still contains composer field'
  );
  assert.ok(
    postedCard.gapValid,
    `posted comment card gap ${postedCard.gap} deviates from 8px`
  );
  assert.equal(
    postedCard.horizontalCentred,
    true,
    'posted comment card is not horizontally centred on mark'
  );
  assert.equal(postedCard.overlapArea, 0, 'posted comment card overlaps mark');
  assert.equal(
    postedCard.sidebarUntouched,
    true,
    'posted comment card left sidebar open'
  );
  assert.equal(
    postedCard.focusInside,
    true,
    'focus is not inside posted comment card'
  );

  await browser.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });

  const cardClosed = await browser.evaluate<boolean>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const started = Date.now();
    const check = () => {
      if (!document.querySelector('.popover-card')) resolve(true);
      else if (Date.now() - started > 4000) resolve(false);
      else setTimeout(check, 50);
    };
    check();
    return promise;
  })()`);
  assert.equal(cardClosed, true, 'Escape did not close posted comment card');
}

async function postHeldComposer(
  browser: ChromeSession,
  body: string
): Promise<void> {
  const result = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const field = document.querySelector(
      '.popover-card.popover-composer.is-otio-composer textarea, .popover-composer textarea'
    );
    const button = document.querySelector(
      '.popover-card.popover-composer.is-otio-composer .popover-action.is-primary, .popover-composer .popover-action.is-primary'
    );
    if (!(field instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
      resolve('missing');
      return promise;
    }
    if (field.value !== ${JSON.stringify(body)}) {
      resolve('lost-draft');
      return promise;
    }
    button.click();
    const start = Date.now();
    const tick = () => {
      if (document.body.textContent.includes(${JSON.stringify(body)})) resolve('posted');
      else if (Date.now() - start > 10000) resolve('timeout');
      else setTimeout(tick, 50);
    };
    tick();
    return promise;
  })()`);
  assert.equal(result, 'posted', `held OTIO draft did not post: ${result}`);
}

async function openComposer(browser: ChromeSession): Promise<void> {
  const opened = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    document.querySelector('button.otio-comment-selection')?.click();
    const started = Date.now();
    const tick = () => {
      if (
        document.querySelector(
          '.popover-card.popover-composer.is-otio-composer textarea.popover-field'
        )
      ) {
        resolve('open');
      } else if (Date.now() - started > 4000) {
        resolve('timeout');
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
  assert.equal(opened, 'open', `native composer did not open: ${opened}`);
}

async function dismissComposer(browser: ChromeSession): Promise<void> {
  const dismissed = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const cancel = [
      ...document.querySelectorAll(
        '.popover-card.popover-composer.is-otio-composer button, .popover-composer button'
      ),
    ].find((button) => button.textContent === 'Cancel');
    cancel?.click();
    const started = Date.now();
    const tick = () => {
      if (!document.querySelector('.popover-composer')) {
        const stage = document.querySelector('.stage-wrap');
        const timeline = document.querySelector('.otio-timeline-scroll');
        if (stage instanceof HTMLElement) stage.scrollTop = 0;
        if (timeline instanceof HTMLElement) timeline.scrollLeft = 0;
        resolve('closed');
      } else if (Date.now() - started > 4000) {
        resolve('timeout');
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
  assert.equal(
    dismissed,
    'closed',
    `native composer did not close: ${dismissed}`
  );
  await browser.evaluate<void>(`(() => {
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    if (stage instanceof HTMLElement) stage.scrollTop = 0;
    if (timeline instanceof HTMLElement) timeline.scrollLeft = 0;
  })()`);
}

interface DomRectProbe {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}
interface CommentMarkAnchor {
  readonly trackId: string;
  readonly start: number;
  readonly duration: number;
  readonly rate: number;
  readonly durationRate: number;
}

interface CommentMarkPointerCase {
  readonly caseName: string;
  readonly body: string;
  readonly expectedId: string;
  readonly expectedAnchor: CommentMarkAnchor;
}

interface CommentMarkPointerPosition {
  readonly rect: DomRectProbe | null;
  readonly center: { readonly x: number; readonly y: number } | null;
  readonly hitId: string | null;
  readonly anchor: CommentMarkAnchor | null;
  readonly commentLane: number | null;
  readonly stageScrollTop: number | null;
  readonly timelineScrollLeft: number | null;
  readonly exposedLeft: number | null;
  readonly exposedRight: number | null;
}

interface CommentMarkPointerExposureAttempt {
  readonly beforeScrollTop: number;
  readonly requestedScrollTop: number;
  readonly appliedScrollTop: number;
}

interface CommentMarkPointerExposure {
  readonly missing: readonly string[];
  readonly blocker: string | null;
  readonly before: CommentMarkPointerPosition;
  readonly after: CommentMarkPointerPosition;
  readonly stageClientBounds: DomRectProbe | null;
  readonly stageScrollHeight: number | null;
  readonly stageClientHeight: number | null;
  readonly maxScrollTop: number | null;
  readonly attempts: readonly CommentMarkPointerExposureAttempt[];
}
interface CommentMarkPointerClickCapture {
  readonly commentId: string | null;
  readonly trusted: boolean | null;
  readonly events?: readonly unknown[];
}

interface CommentMarkPopoverProbe {
  readonly cardId: string | null;
  readonly anchorKind: string | null;
  readonly visible: boolean;
  readonly bodyPresent: boolean;
  readonly composerOpen: boolean;
  readonly sidebarClosed: boolean;
  readonly cardRect: DomRectProbe | null;
  readonly markRect: DomRectProbe | null;
  readonly side: 'above' | 'below' | null;
  readonly gap: number | null;
  readonly gapValid: boolean;
  readonly horizontalCentred: boolean;
  readonly overlapArea: number;
  readonly withinStage: boolean;
  readonly withinViewport: boolean;
  readonly hasReply: boolean;
  readonly hasOpenThread: boolean;
  readonly hasNoField: boolean;
}
interface AuxiliarySpatialMark {
  readonly id: string;
  readonly rect: DomRectProbe;
  readonly commentLane: number | null;
}

interface AuxiliaryCoincidentMarksProbe {
  readonly missing: readonly string[];
  readonly marks: readonly AuxiliarySpatialMark[];
  readonly bandHeight: number | null;
  readonly stageClientHeight: number | null;
  readonly spatialTopId: string | null;
  readonly spatialBottomId: string | null;
}

interface AuxiliaryStageSnapshot {
  readonly stageScrollTop: number | null;
  readonly timelineScrollLeft: number | null;
  readonly timelineScrollTop: number | null;
  readonly stageContent: DomRectProbe | null;
  readonly bodyRect: DomRectProbe | null;
  readonly markRect: DomRectProbe | null;
  readonly bodySpansStage: boolean;
  readonly markOffscreen: boolean;
  readonly direction: 'above' | 'below' | null;
}

interface AuxiliarySidebarPrecondition {
  readonly missing: readonly string[];
  readonly blocker: string | null;
  readonly before: AuxiliaryStageSnapshot;
  readonly after: AuxiliaryStageSnapshot;
}

interface AuxiliarySidebarRowProbe {
  readonly missing: readonly string[];
  readonly rowRect: DomRectProbe | null;
  readonly center: { readonly x: number; readonly y: number } | null;
  readonly visible: boolean;
  readonly hitOwned: boolean;
  readonly stageBefore: number | null;
  readonly stageAfter: number | null;
  readonly timelineBefore: number | null;
  readonly timelineAfter: number | null;
  readonly timelineTopBefore: number | null;
  readonly timelineTopAfter: number | null;
}

interface AuxiliarySidebarClickCapture {
  readonly commentId: string | null;
  readonly trusted: boolean | null;
}

interface AuxiliaryRevealProbe {
  readonly missing: readonly string[];
  readonly markRect: DomRectProbe | null;
  readonly stageContent: DomRectProbe | null;
  readonly center: { readonly x: number; readonly y: number } | null;
  readonly usableLeft: number | null;
  readonly usableRight: number | null;
  readonly hitId: string | null;
  readonly hitOwned: boolean;
  readonly activeIds: readonly string[];
  readonly cardId: string | null;
  readonly cardVisible: boolean;
  readonly bodyPresent: boolean;
  readonly anchor: CommentMarkAnchor | null;
  readonly stageScrollTop: number | null;
  readonly timelineScrollLeft: number | null;
  readonly gap: number | null;
  readonly gapValid: boolean;
  readonly horizontalCentred: boolean;
  readonly overlapArea: number;
}

interface NativeControlProbe {
  readonly label: string;
  readonly withinStage: boolean;
  readonly coveredByTab: boolean;
}

interface NativeSelectProbe extends NativeControlProbe {
  readonly arrowOwned: boolean;
}

interface NativeControlSnapshot {
  readonly tab: {
    readonly present: boolean;
    readonly visible: boolean;
    readonly outsideStage: boolean;
  };
  readonly controls: readonly NativeControlProbe[];
  readonly selects: readonly NativeSelectProbe[];
}

interface ClosedNativeControlsProbe {
  readonly missing: readonly string[];
  readonly before: NativeControlSnapshot;
  readonly afterScroll: NativeControlSnapshot;
  readonly documentOverflow: number;
  readonly bodyOverflow: number;
  readonly stageOverflow: number;
  readonly timelineOverflow: number;
  readonly stageScrollRange: number;
  readonly timelineScrollRange: number;
}

interface SidebarProbe {
  readonly missing: readonly string[];
  readonly open: boolean;
  readonly threadVisibleWhenOpen: boolean;
  readonly tabVisibleWhenOpen: boolean;
  readonly resizerVisible: boolean;
  readonly stageToThreadGap: number | null;
  readonly narrowThreadOwnsRow: boolean;
  readonly tabVisibleAfterClose: boolean;
  readonly threadOpenAfterClose: boolean;
}

function assertClosedNativeControls(
  probe: ClosedNativeControlsProbe,
  label: string
): void {
  assert.deepEqual(probe.missing, [], `${label} missing native controls`);
  for (const [phase, snapshot, requireWithinStage] of [
    ['before scrolling', probe.before, true],
    ['after stage and timeline scrolling', probe.afterScroll, false],
  ] as const) {
    assert.equal(snapshot.tab.present, true, `${label} ${phase} has no tab`);
    assert.equal(
      snapshot.tab.visible,
      true,
      `${label} ${phase} closed Comments tab is not visible`
    );
    assert.equal(
      snapshot.tab.outsideStage,
      true,
      `${label} ${phase} closed Comments tab covers stage content`
    );
    assert.ok(
      snapshot.controls.length > 0,
      `${label} ${phase} has no exposed OTIO controls`
    );
    for (const control of snapshot.controls) {
      if (requireWithinStage)
        assert.equal(
          control.withinStage,
          true,
          `${label} ${phase} control escapes the stage: ${control.label}`
        );
      assert.equal(
        control.coveredByTab,
        false,
        `${label} ${phase} control is covered by Comments: ${control.label}`
      );
    }
    for (const select of snapshot.selects) {
      if (requireWithinStage)
        assert.equal(
          select.withinStage,
          true,
          `${label} ${phase} select escapes the stage: ${select.label}`
        );
      assert.equal(
        select.coveredByTab,
        false,
        `${label} ${phase} select is covered by Comments: ${select.label}`
      );
      assert.equal(
        select.arrowOwned,
        true,
        `${label} ${phase} native select arrow is not exposed: ${select.label}`
      );
    }
  }
  assert.ok(
    probe.documentOverflow <= 1,
    `${label} document has horizontal overflow ${probe.documentOverflow}px`
  );
  assert.ok(
    probe.bodyOverflow <= 1,
    `${label} body has horizontal overflow ${probe.bodyOverflow}px`
  );
  assert.ok(
    probe.stageOverflow <= 1,
    `${label} stage has horizontal overflow ${probe.stageOverflow}px`
  );
  assert.ok(
    probe.timelineOverflow >= 0,
    `${label} has invalid timeline overflow measurement`
  );
}

async function measureClosedNativeControls(
  browser: ChromeSession
): Promise<ClosedNativeControlsProbe> {
  return browser.evaluate<ClosedNativeControlsProbe>(String.raw`(async () => {
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    const root = document.querySelector('.otio-view');
    const missing = [];
    if (!stage) missing.push('.stage-wrap');
    if (!timeline) missing.push('.otio-timeline-scroll');
    if (!root) missing.push('.otio-view');
    if (missing.length > 0) {
      return {
        missing,
        before: { tab: { present: false, visible: false, outsideStage: false }, controls: [], selects: [] },
        afterScroll: { tab: { present: false, visible: false, outsideStage: false }, controls: [], selects: [] },
        documentOverflow: 0,
        bodyOverflow: 0,
        stageOverflow: 0,
        timelineOverflow: 0,
        stageScrollRange: 0,
        timelineScrollRange: 0,
      };
    }
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = getComputedStyle(node);
      const value = rect(node);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        value.width > 0 && value.height > 0;
    };
    const overlaps = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const stageContent = () => {
      const value = stage.getBoundingClientRect();
      const left = value.left + stage.clientLeft;
      const top = value.top + stage.clientTop;
      return {
        left,
        top,
        right: left + stage.clientWidth,
        bottom: top + stage.clientHeight,
        width: stage.clientWidth,
        height: stage.clientHeight,
      };
    };
    const within = (inner, outer) =>
      inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const labelOf = (node) =>
      node.getAttribute('aria-label') || node.className || node.tagName;
    const snapshot = () => {
      const content = stageContent();
      const tab = document.querySelector('.thread-tab');
      const tabVisible = visible(tab);
      const tabRect = tabVisible ? rect(tab) : null;
      const exposed = (node) => visible(node) && overlaps(rect(node), content);
      const controls = [
        ...document.querySelectorAll(
          '.otio-transport button, .otio-transport input, .otio-timeline-heading button, .otio-selection-readout button, .otio-selection-readout input'
        ),
      ].filter(exposed).map((node) => {
        const value = rect(node);
        return {
          label: labelOf(node),
          withinStage: within(value, content),
          coveredByTab: tabRect !== null && overlaps(value, tabRect),
        };
      });
      const selects = [
        ...document.querySelectorAll(
          '.otio-timeline-heading select, select.otio-track-select'
        ),
      ].filter(exposed).map((node) => {
        const value = rect(node);
        const arrowX = Math.max(value.left + 1, value.right - Math.min(8, value.width / 3));
        const arrowY = value.top + value.height / 2;
        const hit = document.elementFromPoint(arrowX, arrowY);
        return {
          label: labelOf(node),
          withinStage: within(value, content),
          coveredByTab: tabRect !== null && overlaps(value, tabRect),
          arrowOwned: hit === node || hit?.closest('select') === node,
        };
      });
      return {
        tab: {
          present: tab !== null,
          visible: tabVisible,
          outsideStage: tabRect === null || !overlaps(tabRect, content),
        },
        controls,
        selects,
      };
    };
    const before = snapshot();
    const priorStageTop = stage.scrollTop;
    const priorTimelineLeft = timeline.scrollLeft;
    stage.scrollTop = stage.scrollHeight;
    timeline.scrollLeft = timeline.scrollWidth;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterScroll = snapshot();
    stage.scrollTop = priorStageTop;
    timeline.scrollLeft = priorTimelineLeft;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      missing,
      before,
      afterScroll,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
      stageOverflow: stage.scrollWidth - stage.clientWidth,
      timelineOverflow: timeline.scrollWidth - timeline.clientWidth,
      stageScrollRange: stage.scrollHeight - stage.clientHeight,
      timelineScrollRange: timeline.scrollWidth - timeline.clientWidth,
    };
  })()`);
}

async function measureSidebar(browser: ChromeSession): Promise<SidebarProbe> {
  return browser.evaluate<SidebarProbe>(String.raw`(async () => {
    const row = document.querySelector('.relic-row');
    const stage = document.querySelector('.stage-wrap');
    const thread = document.querySelector('.thread');
    const tab = document.querySelector('.thread-tab');
    const missing = [];
    if (!row) missing.push('.relic-row');
    if (!stage) missing.push('.stage-wrap');
    if (!thread) missing.push('.thread');
    if (!tab) missing.push('.thread-tab');
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    if (missing.length > 0) {
      return {
        missing,
        open: false,
        threadVisibleWhenOpen: false,
        tabVisibleWhenOpen: false,
        resizerVisible: false,
        stageToThreadGap: null,
        narrowThreadOwnsRow: false,
        tabVisibleAfterClose: false,
        threadOpenAfterClose: false,
      };
    }
    tab.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const stageRect = stage.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const resizer = document.querySelector('.thread-resizer');
    const open = thread.classList.contains('is-open');
    const threadVisibleWhenOpen = visible(thread);
    const tabVisibleWhenOpen = visible(tab);
    const resizerVisible = visible(resizer);
    const gap = Math.max(0, threadRect.left - stageRect.right);
    const narrowThreadOwnsRow =
      threadRect.left <= rowRect.left + 1 && threadRect.right >= rowRect.right - 1;
    const closer = thread.querySelector('.thread-toggle');
    closer?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      missing,
      open,
      threadVisibleWhenOpen,
      tabVisibleWhenOpen,
      resizerVisible,
      stageToThreadGap: gap,
      narrowThreadOwnsRow,
      tabVisibleAfterClose: visible(tab),
      threadOpenAfterClose: thread.classList.contains('is-open'),
    };
  })()`);
}

function assertSidebar(
  probe: SidebarProbe,
  label: string,
  narrow: boolean
): void {
  assert.deepEqual(probe.missing, [], `${label} missing sidebar chrome`);
  assert.equal(probe.open, true, `${label} Comments did not open`);
  assert.equal(
    probe.threadVisibleWhenOpen,
    true,
    `${label} open Comments sidebar has no visible row`
  );
  assert.equal(
    probe.tabVisibleWhenOpen,
    false,
    `${label} hidden Comments tab still consumes visible chrome`
  );
  assert.equal(
    probe.tabVisibleAfterClose,
    true,
    `${label} Comments tab did not return after close`
  );
  assert.equal(
    probe.threadOpenAfterClose,
    false,
    `${label} Comments sidebar did not close`
  );
  if (narrow) {
    assert.equal(
      probe.narrowThreadOwnsRow,
      true,
      `${label} narrow Comments sidebar does not own the row`
    );
    assert.equal(
      probe.resizerVisible,
      false,
      `${label} narrow Comments sidebar exposed the desktop resizer`
    );
  } else {
    assert.equal(
      probe.resizerVisible,
      true,
      `${label} desktop Comments sidebar lost its resizer`
    );
    assert.ok(
      (probe.stageToThreadGap ?? Infinity) <= 1,
      `${label} hidden Comments tab left a ${probe.stageToThreadGap}px gap`
    );
  }
}

interface ComposerElementProbe {
  readonly name: string;
  readonly present: boolean;
  readonly visible: boolean;
  readonly withinStage: boolean;
  readonly rect: DomRectProbe | null;
  readonly hitOwned: boolean;
  readonly text: string;
  readonly scrollReachable: boolean;
}

interface ComposerControlProbe {
  readonly label: string;
  readonly rect: DomRectProbe;
  readonly intersectionArea: number;
  readonly hitOwned: boolean;
  readonly sample: {
    readonly x: number;
    readonly y: number;
    readonly hitTag: string | null;
    readonly hitClass: string | null;
    readonly hitLabel: string | null;
    readonly markerOwner: string | null;
    readonly markerIndex: string | null;
  };
}
interface ComposerContextFragmentProbe {
  readonly name: 'target' | 'disclosure' | 'note';
  readonly present: boolean;
  readonly visible: boolean;
  readonly text: string;
  readonly paragraphRect: DomRectProbe | null;
  readonly lineRects: readonly DomRectProbe[];
  readonly paragraphInBody: boolean;
  readonly paragraphInCard: boolean;
  readonly paragraphInSafeRegion: boolean;
  readonly linesInBody: boolean;
  readonly linesInCard: boolean;
  readonly linesInSafeRegion: boolean;
}

interface ComposerContextAllocationProbe {
  readonly bodyPresent: boolean;
  readonly bodyRect: DomRectProbe | null;
  readonly bodyClientHeight: number | null;
  readonly bodyScrollHeight: number | null;
  readonly initialScrollTop: number | null;
  readonly bodyBorderHeight: number | null;
  readonly naturalBodyHeight: number | null;
  readonly nonBodyHeight: number | null;
  readonly naturalRequiredCardHeight: number | null;
  readonly naturalFitsSafeRegion: boolean;
  readonly cardRect: DomRectProbe | null;
  readonly safeRegion: DomRectProbe | null;
  readonly fragments: readonly ComposerContextFragmentProbe[];
}

interface ComposerProbe {
  readonly missing: readonly string[];
  readonly stageContent: DomRectProbe | null;
  readonly card: DomRectProbe | null;
  readonly anchor: DomRectProbe | null;
  readonly side: 'above' | 'below' | null;
  readonly capped: boolean;
  readonly gap: number | null;
  readonly gapValid: boolean;
  readonly horizontalCentred: boolean;
  readonly overlapArea: number;
  readonly anchorExposed: boolean;
  readonly withinStage: boolean;
  readonly withinViewport: boolean;
  readonly preview: DomRectProbe | null;
  readonly scope: DomRectProbe | null;
  readonly safeRegion: DomRectProbe | null;
  readonly nativeControls: readonly ComposerControlProbe[];
  readonly viewportWidth: number;
  readonly documentOverflow: number;
  readonly bodyOverflow: number;
  readonly stageOverflow: number;
  readonly timelineOverflow: number;
  readonly components: readonly ComposerElementProbe[];
  readonly contextAllocation: ComposerContextAllocationProbe;
  readonly post: {
    readonly hovered: boolean;
    readonly foreground: string | null;
    readonly background: string | null;
    readonly contrast: number | null;
  };
}

interface StageControlExposure {
  readonly missing: readonly string[];
  readonly visible: boolean;
  readonly withinStage: boolean;
  readonly rect: DomRectProbe | null;
}
function assertComposerContextAllocation(
  allocation: ComposerContextAllocationProbe,
  label: string
): void {
  assert.equal(
    allocation.bodyPresent,
    true,
    `${label} has no bounded composer context body`
  );
  if (allocation.naturalFitsSafeRegion) {
    assert.ok(
      allocation.bodyScrollHeight !== null &&
        allocation.bodyClientHeight !== null &&
        allocation.bodyScrollHeight <= allocation.bodyClientHeight + 1,
      `${label} naturally fitting context still overflows: ${JSON.stringify(allocation)}`
    );
    assert.equal(
      allocation.initialScrollTop,
      0,
      `${label} naturally fitting context starts scrolled: ${JSON.stringify(allocation)}`
    );
    for (const fragment of allocation.fragments) {
      if (
        fragment.name !== 'target' &&
        fragment.name !== 'disclosure' &&
        !(fragment.name === 'note' && fragment.visible && fragment.text.trim())
      )
        continue;
      assert.equal(
        fragment.present,
        true,
        `${label} ${fragment.name} context is absent: ${JSON.stringify(allocation)}`
      );
      assert.equal(
        fragment.visible,
        true,
        `${label} ${fragment.name} context is hidden despite a natural fit: ${JSON.stringify(allocation)}`
      );
      assert.ok(
        fragment.text.trim().length > 0,
        `${label} ${fragment.name} context is empty: ${JSON.stringify(allocation)}`
      );
      assert.ok(
        fragment.paragraphRect && fragment.lineRects.length > 0,
        `${label} ${fragment.name} has no measured full paragraph or line rects: ${JSON.stringify(allocation)}`
      );
      assert.equal(
        fragment.paragraphInBody,
        true,
        `${label} ${fragment.name} paragraph escapes the bounded body: ${JSON.stringify(allocation)}`
      );
      assert.equal(
        fragment.paragraphInCard,
        true,
        `${label} ${fragment.name} paragraph escapes the card: ${JSON.stringify(allocation)}`
      );
      assert.equal(
        fragment.linesInBody,
        true,
        `${label} ${fragment.name} line rect escapes the bounded body: ${JSON.stringify(allocation)}`
      );
      assert.equal(
        fragment.linesInCard,
        true,
        `${label} ${fragment.name} line rect escapes the card: ${JSON.stringify(allocation)}`
      );
    }
  } else {
    assert.ok(
      allocation.bodyScrollHeight !== null &&
        allocation.bodyClientHeight !== null &&
        allocation.bodyScrollHeight >= allocation.bodyClientHeight,
      `${label} capped context body does not scroll: ${JSON.stringify(allocation)}`
    );
  }
}

function assertComposerProbe(
  probe: ComposerProbe,
  label: string,
  expectHovered: boolean
): void {
  assert.deepEqual(probe.missing, [], `${label} composer controls are missing`);
  assert.ok(
    probe.card && probe.card.width > 0 && probe.card.height > 0,
    `${label} has no measurable composer card`
  );
  assert.ok(
    probe.anchor && probe.anchor.width >= 0 && probe.anchor.height > 0,
    `${label} has no measurable track selection anchor`
  );

  assert.ok(
    probe.gap !== null && probe.gapValid,
    `${label} gap ${probe.gap}px deviates from 8px (side=${probe.side}): card=${JSON.stringify(probe.card)}, anchor=${JSON.stringify(probe.anchor)}`
  );

  assert.equal(
    probe.horizontalCentred,
    true,
    `${label} anchor is not horizontally centred in card: card=${JSON.stringify(probe.card)}, anchor=${JSON.stringify(probe.anchor)}`
  );

  assert.equal(
    probe.overlapArea,
    0,
    `${label} composer overlaps track selection anchor: area=${probe.overlapArea}`
  );

  assert.equal(
    probe.withinStage,
    true,
    `${label} composer escapes stage bounds: card=${JSON.stringify(probe.card)}, stage=${JSON.stringify(probe.stageContent)}`
  );
  assert.equal(
    probe.withinViewport,
    true,
    `${label} composer escapes viewport: card=${JSON.stringify(probe.card)}`
  );

  assert.equal(
    probe.anchorExposed,
    true,
    `${label} anchor center is occluded by popover`
  );

  if (
    !probe.capped &&
    probe.stageContent &&
    probe.card &&
    probe.anchor &&
    probe.anchor.bottom + 8 + probe.card.height <= probe.stageContent.bottom - 8
  ) {
    assert.equal(
      probe.side,
      'below',
      `${label} card fits below selection but side is ${probe.side}`
    );
  }

  for (const component of probe.components) {
    assert.equal(
      component.present,
      true,
      `${label} composer component is absent: ${component.name}`
    );
    assert.equal(
      component.visible,
      true,
      `${label} composer component is hidden: ${component.name}`
    );
    if (['card', 'textarea', 'Post', 'Cancel'].includes(component.name)) {
      assert.equal(
        component.withinStage,
        true,
        `${label} composer component escapes its stage: ${component.name}`
      );
      if (component.name !== 'card') {
        assert.equal(
          component.hitOwned,
          true,
          `${label} ${component.name} does not own its hit target`
        );
      }
    } else {
      assert.ok(
        component.text.trim().length > 0,
        `${label} ${component.name} text is empty`
      );
      // context and disclosure text is verified in assertComposerContextAllocation
    }
  }

  assertComposerContextAllocation(probe.contextAllocation, label);

  assert.equal(
    probe.post.hovered,
    expectHovered,
    `${label} Post hover state was not reached`
  );
  assert.ok(
    probe.post.contrast !== null && probe.post.contrast >= 4.5,
    `${label} Post contrast is ${probe.post.contrast} (${probe.post.foreground} on ${probe.post.background})`
  );
  assert.ok(
    probe.documentOverflow <= 1,
    `${label} document has horizontal overflow ${probe.documentOverflow}px`
  );
  assert.ok(
    probe.bodyOverflow <= 1,
    `${label} body has horizontal overflow ${probe.bodyOverflow}px`
  );
  assert.ok(
    probe.stageOverflow <= 1,
    `${label} stage has horizontal overflow ${probe.stageOverflow}px`
  );
  assert.ok(
    probe.timelineOverflow >= 0,
    `${label} has invalid timeline overflow measurement`
  );
}

async function measureComposer(browser: ChromeSession): Promise<ComposerProbe> {
  return browser.evaluate<ComposerProbe>(String.raw`(async () => {
    const stage = document.querySelector('.stage-wrap');
    const card = document.querySelector(
      '.popover-card.popover-composer.is-otio-composer'
    );
    const missing = [];
    if (!stage) missing.push('.stage-wrap');
    if (!card) missing.push('.popover-card.popover-composer.is-otio-composer');
    const empty = {
      missing,
      stageContent: null,
      card: null,
      anchor: null,
      side: null,
      capped: false,
      gap: null,
      gapValid: false,
      horizontalCentred: false,
      overlapArea: 0,
      anchorExposed: false,
      withinStage: false,
      withinViewport: false,
      preview: null,
      scope: null,
      safeRegion: null,
      nativeControls: [],
      viewportWidth: window.innerWidth,
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      bodyOverflow:
        document.body.scrollWidth - document.documentElement.clientWidth,
      stageOverflow: 0,
      timelineOverflow: 0,
      components: [],
      contextAllocation: {
        bodyPresent: false,
        bodyRect: null,
        bodyClientHeight: null,
        bodyScrollHeight: null,
        initialScrollTop: null,
        bodyBorderHeight: null,
        naturalBodyHeight: null,
        nonBodyHeight: null,
        naturalRequiredCardHeight: null,
        naturalFitsSafeRegion: false,
        cardRect: null,
        safeRegion: null,
        fragments: [],
      },
      post: {
        hovered: false,
        foreground: null,
        background: null,
        contrast: null,
      },
    };
    if (missing.length > 0) return empty;

    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const contentRect = () => {
      const value = stage.getBoundingClientRect();
      const left = value.left + stage.clientLeft;
      const top = value.top + stage.clientTop;
      return {
        left,
        top,
        right: left + stage.clientWidth,
        bottom: top + stage.clientHeight,
        width: stage.clientWidth,
        height: stage.clientHeight,
      };
    };
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = getComputedStyle(node);
      const value = rect(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        value.width > 0 &&
        value.height > 0
      );
    };
    const within = (inner, outer) =>
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1;
    const intersect = (a, b) => {
      const left = Math.max(a.left, b.left);
      const right = Math.min(a.right, b.right);
      const top = Math.max(a.top, b.top);
      const bottom = Math.min(a.bottom, b.bottom);
      return {
        left,
        right,
        top,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    };
    const samplePoint = (box) => ({
      x: Math.max(
        0,
        Math.min(window.innerWidth - 1, (box.left + box.right) / 2)
      ),
      y: Math.max(
        0,
        Math.min(window.innerHeight - 1, (box.top + box.bottom) / 2)
      ),
    });
    const hitOwned = (node, box) => {
      if (!node || box.width <= 0 || box.height <= 0) return false;
      const { x, y } = samplePoint(box);
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === node || node.contains(hit));
    };

    const content = contentRect();
    const viewport = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };

    const selection = document.querySelector('.otio-selection');
    let anchor = null;
    if (selection instanceof HTMLElement) {
      const selRect = rect(selection);
      const rail =
        selection.closest('.otio-track-rail') ||
        document.querySelector('.otio-track-rail');
      const scroll = document.querySelector('.otio-timeline-scroll');
      const row = rail?.closest('.otio-track-row');
      const label = row?.querySelector('.otio-track-label');
      const scrollRect = scroll ? rect(scroll) : null;
      const labelRect = label ? rect(label) : null;
      const clipLeft = labelRect
        ? labelRect.right
        : scrollRect
          ? scrollRect.left
          : 0;
      const clipRight = scrollRect ? scrollRect.right : window.innerWidth;
      const clampedLeft = Math.max(clipLeft, selRect.left);
      const clampedRight = Math.min(clipRight, selRect.right);
      const width = Math.max(0, clampedRight - clampedLeft);
      anchor = {
        left: clampedLeft,
        top: selRect.top,
        right: clampedLeft + width,
        bottom: selRect.bottom,
        width,
        height: selRect.height,
      };
    }

    const cardRect = rect(card);
    const side =
      card.getAttribute('data-side') ||
      (cardRect && anchor && cardRect.top >= anchor.bottom ? 'below' : 'above');
    const capped = card.getAttribute('data-capped') === 'true';

    let gap = null;
    let gapValid = false;
    let horizontalCentred = false;
    let overlapArea = 0;
    let anchorExposed = false;
    if (cardRect && anchor) {
      gap =
        side === 'below'
          ? Math.abs(cardRect.top - anchor.bottom - 8)
          : Math.abs(anchor.top - cardRect.bottom - 8);
      gapValid = gap <= 1.5;

      const anchorCenterX = (anchor.left + anchor.right) / 2;
      const againstMargin = content
        ? cardRect.left <= content.left + 9 || cardRect.right >= content.right - 9
        : false;
      horizontalCentred =
        againstMargin ||
        (anchorCenterX >= cardRect.left - 1 && anchorCenterX <= cardRect.right + 1);

      const overlapW = Math.max(
        0,
        Math.min(cardRect.right, anchor.right) - Math.max(cardRect.left, anchor.left)
      );
      const overlapH = Math.max(
        0,
        Math.min(cardRect.bottom, anchor.bottom) - Math.max(cardRect.top, anchor.top)
      );
      overlapArea = overlapW * overlapH;

      const hit = document.elementFromPoint(
        Math.max(0, Math.min(window.innerWidth - 1, anchorCenterX)),
        Math.max(0, Math.min(window.innerHeight - 1, (anchor.top + anchor.bottom) / 2))
      );
      anchorExposed = !hit || (!hit.closest('.popover') && !card.contains(hit));
    }

    const withinStage = cardRect !== null && within(cardRect, content);
    const withinViewport =
      cardRect !== null &&
      cardRect.left >= -1 &&
      cardRect.right <= window.innerWidth + 1 &&
      cardRect.top >= -1 &&
      cardRect.bottom <= window.innerHeight + 1;

    const parseColor = (value) => {
      const parts = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      return parts?.length === 3 && parts.every(Number.isFinite) ? parts : null;
    };
    const luminance = (channels) => {
      const linear = channels.map((value) => {
        const unit = value / 255;
        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = (foreground, background) => {
      const fg = parseColor(foreground);
      const bg = parseColor(background);
      if (!fg || !bg) return null;
      const first = luminance(fg);
      const second = luminance(bg);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };

    const post = card.querySelector('.popover-action.is-primary');
    const cancel =
      [...card.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel'
      ) ?? null;
    const boundedBody = card.querySelector('.popover-bounded-body');
    const bodyRect =
      boundedBody instanceof HTMLElement ? rect(boundedBody) : null;
    const bodyStyle =
      boundedBody instanceof HTMLElement ? getComputedStyle(boundedBody) : null;
    const bodyBorderHeight =
      bodyStyle === null
        ? null
        : parseFloat(bodyStyle.borderTopWidth) +
          parseFloat(bodyStyle.borderBottomWidth);

    const paragraphLines = (node) => {
      if (!(node instanceof HTMLElement)) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((value) => ({
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      }));
    };
    const contextFragment = (name, node) => {
      const present = node instanceof HTMLElement;
      const isVisible = present && visible(node);
      const paragraphRect = isVisible ? rect(node) : null;
      const lineRects = isVisible ? paragraphLines(node) : [];
      const paragraphInside = (outer) =>
        paragraphRect !== null && outer !== null && within(paragraphRect, outer);
      const linesInside = (outer) =>
        lineRects.length > 0 &&
        outer !== null &&
        lineRects.every((line) => within(line, outer));
      return {
        name,
        present,
        visible: isVisible,
        text: node?.textContent ?? '',
        paragraphRect,
        lineRects,
        paragraphInBody: paragraphInside(bodyRect),
        paragraphInCard: paragraphInside(cardRect),
        paragraphInSafeRegion: true,
        linesInBody: linesInside(bodyRect),
        linesInCard: linesInside(cardRect),
        linesInSafeRegion: true,
      };
    };
    const fragments = [
      contextFragment('target', card.querySelector('.popover-target')),
      contextFragment(
        'disclosure',
        card.querySelector('.popover-disclosure')
      ),
      contextFragment('note', card.querySelector('.popover-note')),
    ];
    const contextAllocation = {
      bodyPresent: boundedBody instanceof HTMLElement,
      bodyRect,
      bodyClientHeight:
        boundedBody instanceof HTMLElement ? boundedBody.clientHeight : null,
      bodyScrollHeight:
        boundedBody instanceof HTMLElement ? boundedBody.scrollHeight : null,
      initialScrollTop:
        boundedBody instanceof HTMLElement ? boundedBody.scrollTop : null,
      bodyBorderHeight,
      naturalBodyHeight: null,
      nonBodyHeight: null,
      naturalRequiredCardHeight: null,
      naturalFitsSafeRegion: !capped,
      cardRect,
      safeRegion: null,
      fragments,
    };
    const parts = [
      ['card', card],
      ['context', card.querySelector('.popover-target')],
      ['textarea', card.querySelector('textarea.popover-field')],
      ['Post', post],
      ['Cancel', cancel],
      ['disclosure', card.querySelector('.popover-disclosure')],
    ];
    const components = [];
    for (const [name, node] of parts) {
      const isVisible = visible(node);
      const value = isVisible ? rect(node) : null;
      const scrollReachable = isVisible;
      const exposed = value
        ? intersect(intersect(value, content), viewport)
        : null;
      components.push({
        name,
        present: node !== null,
        visible: isVisible,
        withinStage: value !== null && within(value, content),
        rect: value,
        hitOwned: exposed !== null && hitOwned(node, exposed),
        text: node?.textContent ?? '',
        scrollReachable,
      });
    }
    const style = post instanceof HTMLElement ? getComputedStyle(post) : null;
    const timeline = document.querySelector('.otio-timeline-scroll');
    return {
      missing,
      stageContent: content,
      card: cardRect,
      anchor,
      side,
      capped,
      gap,
      gapValid,
      horizontalCentred,
      overlapArea,
      anchorExposed,
      withinStage,
      withinViewport,
      preview: null,
      scope: null,
      safeRegion: null,
      nativeControls: [],
      viewportWidth: window.innerWidth,
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      bodyOverflow:
        document.body.scrollWidth - document.documentElement.clientWidth,
      stageOverflow: stage.scrollWidth - stage.clientWidth,
      timelineOverflow: timeline
        ? timeline.scrollWidth - timeline.clientWidth
        : 0,
      components,
      contextAllocation,
      post: {
        hovered: post instanceof Element && post.matches(':hover'),
        foreground: style?.color ?? null,
        background: style?.backgroundColor ?? null,
        contrast: style ? ratio(style.color, style.backgroundColor) : null,
      },
    };
  })()`);
}

async function hoverComposerPost(browser: ChromeSession): Promise<void> {
  const point = await browser.evaluate<{
    readonly x: number;
    readonly y: number;
  } | null>(
    `(() => {
      const post = document.querySelector('.popover-card .popover-action.is-primary');
      if (!(post instanceof HTMLElement)) return null;
      const rect = post.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  );
  assert.ok(point, 'native Post button has no hover point');
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await browser.evaluate<void>(
    `new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 50);
    })`
  );
}

async function clearPointerHover(browser: ChromeSession): Promise<void> {
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 0,
    y: 0,
    button: 'none',
  });
  await browser.evaluate<void>(
    `new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(finish);
      setTimeout(finish, 50);
    })`
  );
}
function pointerCommentCase(
  comments: Array<Record<string, unknown>>,
  caseName: string,
  body: string,
  expectedTrackId: string,
  expectedRange: TimeRange
): CommentMarkPointerCase {
  const comment = commentByBody(comments, body);
  const readbackBody = comment['body'];
  assert.ok(
    typeof readbackBody === 'string',
    `${caseName} fresh readback has no body`
  );
  assert.equal(
    readbackBody,
    body,
    `${caseName} fresh readback body changed before pointer proof`
  );
  const commentId = comment['comment_id'];
  assert.ok(
    typeof commentId === 'string' && commentId.length > 0,
    `${caseName} fresh readback has no comment_id`
  );
  const rawAnchor = comment['anchor'];
  assert.ok(
    rawAnchor && typeof rawAnchor === 'object',
    `${caseName} fresh readback has no anchor`
  );
  const anchor = rawAnchor as {
    readonly track_id?: unknown;
    readonly range?: unknown;
  };
  assert.equal(
    anchor.track_id,
    expectedTrackId,
    `${caseName} fresh readback track changed`
  );
  const range = asRange(anchor.range);
  assert.ok(range, `${caseName} fresh readback has no OTIO range`);
  assert.ok(
    rangeClose(range, expectedRange),
    `${caseName} fresh readback anchor differs from the expected OTIO range`
  );
  assert.ok(
    Number.isFinite(range.start_time.value) &&
      Number.isFinite(range.start_time.rate) &&
      Number.isFinite(range.duration.value) &&
      Number.isFinite(range.duration.rate),
    `${caseName} fresh readback has non-finite anchor fields`
  );
  return {
    caseName,
    body: readbackBody,
    expectedId: commentId,
    expectedAnchor: {
      trackId: expectedTrackId,
      start: range.start_time.value,
      duration: range.duration.value,
      rate: range.start_time.rate,
      durationRate: range.duration.rate,
    },
  };
}

async function closePopoverWithEscape(browser: ChromeSession): Promise<void> {
  for (const event of [
    {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    },
    {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    },
  ])
    await browser.send('Input.dispatchKeyEvent', event);
  await browser.evaluate<void>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
    return promise;
  })()`);
}

async function commentMarkPointerPosition(
  browser: ChromeSession,
  expectedId: string
): Promise<CommentMarkPointerPosition> {
  return browser.evaluate<CommentMarkPointerPosition>(String.raw`(() => {
    const empty = {
      rect: null,
      center: null,
      hitId: null,
      anchor: null,
      commentLane: null,
      stageScrollTop: null,
      timelineScrollLeft: null,
      exposedLeft: null,
      exposedRight: null,
    };
    const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
      (node) => node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
    );
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    if (
      !(mark instanceof HTMLElement) ||
      !(stage instanceof HTMLElement) ||
      !(timeline instanceof HTMLElement)
    )
      return empty;
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const clientBounds = (node) => {
      const value = rect(node);
      return {
        left: value.left + node.clientLeft,
        top: value.top + node.clientTop,
        right: value.left + node.clientLeft + node.clientWidth,
        bottom: value.top + node.clientTop + node.clientHeight,
      };
    };
    const markRect = rect(mark);
    const center = {
      x: markRect.left + markRect.width / 2,
      y: markRect.top + markRect.height / 2,
    };
    const hit = document.elementFromPoint(center.x, center.y);
    const hitId =
      hit?.closest('.otio-comment-mark')?.getAttribute('data-comment-id') ?? null;
    const label = mark
      .closest('.otio-track-row')
      ?.querySelector('.otio-track-label');
    const timelineBounds = clientBounds(timeline);
    const workbenchBounds = clientBounds(stage);
    const labelRect = label instanceof HTMLElement ? rect(label) : null;
    const exposedLeft =
      labelRect === null
        ? null
        : Math.max(
            timelineBounds.left,
            workbenchBounds.left,
            labelRect.right
          );
    const exposedRight =
      labelRect === null
        ? null
        : Math.min(
            timelineBounds.right,
            workbenchBounds.right,
            window.innerWidth
          );
    const fields = [
      Number(mark.dataset.start),
      Number(mark.dataset.duration),
      Number(mark.dataset.rate),
      Number(mark.dataset.durationRate),
    ];
    const anchor =
      mark.dataset.trackId && fields.every(Number.isFinite)
        ? {
            trackId: mark.dataset.trackId,
            start: fields[0],
            duration: fields[1],
            rate: fields[2],
            durationRate: fields[3],
          }
        : null;
    const laneValue = mark.style.getPropertyValue('--otio-comment-lane');
    const lane = Number(laneValue);
    const commentLane =
      laneValue.trim().length > 0 && Number.isFinite(lane) ? lane : null;
    return {
      rect: markRect,
      center,
      hitId,
      anchor,
      commentLane,
      stageScrollTop: stage.scrollTop,
      timelineScrollLeft: timeline.scrollLeft,
      exposedLeft,
      exposedRight,
    };
  })()`);
}

async function exposeCommentMarkForPointer(
  browser: ChromeSession,
  expectedId: string
): Promise<CommentMarkPointerExposure> {
  return browser.evaluate<CommentMarkPointerExposure>(String.raw`(async () => {
    const empty = {
      rect: null,
      center: null,
      hitId: null,
      anchor: null,
      commentLane: null,
      stageScrollTop: null,
      timelineScrollLeft: null,
      exposedLeft: null,
      exposedRight: null,
    };
    const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
      (node) => node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
    );
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    const missing = [];
    if (!(mark instanceof HTMLElement)) missing.push('.otio-comment-mark[data-comment-id]');
    if (!(stage instanceof HTMLElement)) missing.push('.stage-wrap');
    if (!(timeline instanceof HTMLElement)) missing.push('.otio-timeline-scroll');
    const label = mark
      ?.closest('.otio-track-row')
      ?.querySelector('.otio-track-label');
    if (!(label instanceof HTMLElement)) missing.push('.otio-track-label');
    if (missing.length > 0) {
      return {
        missing,
        blocker: 'pointer exposure is missing ' + missing.join(', '),
        before: empty,
        after: empty,
        stageClientBounds: null,
        stageScrollHeight: null,
        stageClientHeight: null,
        maxScrollTop: null,
        attempts: [],
      };
    }
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const clientBounds = (node) => {
      const value = rect(node);
      return {
        left: value.left + node.clientLeft,
        top: value.top + node.clientTop,
        right: value.left + node.clientLeft + node.clientWidth,
        bottom: value.top + node.clientTop + node.clientHeight,
        width: node.clientWidth,
        height: node.clientHeight,
      };
    };
    const position = () => {
      const markRect = rect(mark);
      const center = {
        x: markRect.left + markRect.width / 2,
        y: markRect.top + markRect.height / 2,
      };
      const hit = document.elementFromPoint(center.x, center.y);
      const hitId =
        hit?.closest('.otio-comment-mark')?.getAttribute('data-comment-id') ?? null;
      const timelineBounds = clientBounds(timeline);
      const workbenchBounds = clientBounds(stage);
      const labelRect = rect(label);
      const exposedLeft = Math.max(
        timelineBounds.left,
        workbenchBounds.left,
        labelRect.right
      );
      const exposedRight = Math.min(
        timelineBounds.right,
        workbenchBounds.right,
        window.innerWidth
      );
      const fields = [
        Number(mark.dataset.start),
        Number(mark.dataset.duration),
        Number(mark.dataset.rate),
        Number(mark.dataset.durationRate),
      ];
      const anchor =
        mark.dataset.trackId && fields.every(Number.isFinite)
          ? {
              trackId: mark.dataset.trackId,
              start: fields[0],
              duration: fields[1],
              rate: fields[2],
              durationRate: fields[3],
            }
          : null;
      const laneValue = mark.style.getPropertyValue('--otio-comment-lane');
      const lane = Number(laneValue);
      const commentLane =
        laneValue.trim().length > 0 && Number.isFinite(lane) ? lane : null;
      return {
        rect: markRect,
        center,
        hitId,
        anchor,
        commentLane,
        stageScrollTop: stage.scrollTop,
        timelineScrollLeft: timeline.scrollLeft,
        exposedLeft,
        exposedRight,
      };
    };
    const before = position();
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const frames = () => {
      const { promise, resolve } = Promise.withResolvers();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 50);
      return promise;
    };
    const stageScrollHeight = timeline.scrollHeight;
    const stageClientHeight = timeline.clientHeight;
    const maxScrollTop = Math.max(0, stageScrollHeight - stageClientHeight);
    const attempts = [];
    let blocker = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = position();
      const stageBounds = clientBounds(timeline);
      if (current.exposedRight - current.exposedLeft <= 0) {
        blocker =
          'sticky label leaves no exposed pointer interval: ' +
          JSON.stringify(current);
        break;
      }
      const beforeScrollTop = timeline.scrollTop;
      let requestedScrollTop = beforeScrollTop;
      if (current.rect.top < stageBounds.top)
        requestedScrollTop += Math.floor(
          current.rect.top - stageBounds.top
        );
      else if (current.rect.bottom > stageBounds.bottom)
        requestedScrollTop += Math.ceil(
          current.rect.bottom - stageBounds.bottom
        );
      const nextStage = clamp(requestedScrollTop, 0, maxScrollTop);
      const targetCenter =
        (current.exposedLeft + current.exposedRight) / 2;
      const beforeTimelineLeft = timeline.scrollLeft;
      const nextTimeline = clamp(
        timeline.scrollLeft + current.center.x - targetCenter,
        0,
        Math.max(0, timeline.scrollWidth - timeline.clientWidth)
      );
      timeline.scrollTop = nextStage;
      timeline.scrollLeft = nextTimeline;
      await frames();
      attempts.push({
        beforeScrollTop,
        requestedScrollTop,
        appliedScrollTop: timeline.scrollTop,
      });
      const changed =
        Math.abs(timeline.scrollTop - beforeScrollTop) > 0.01 ||
        Math.abs(timeline.scrollLeft - beforeTimelineLeft) > 0.01;
      if (!changed) break;
    }
    await frames();
    const after = position();
    if (
      blocker === null &&
      (after.center.x < after.exposedLeft ||
        after.center.x > after.exposedRight ||
        after.rect.top < Math.max(clientBounds(stage).top, clientBounds(timeline).top, 0) ||
        after.rect.bottom > Math.min(clientBounds(stage).bottom, clientBounds(timeline).bottom, window.innerHeight))
    )
      blocker =
        'mark cannot be exposed in the stage and sticky-safe interval: ' +
        JSON.stringify(after);
    if (blocker === null && after.hitId !== ${JSON.stringify(expectedId)})
      blocker =
        'exposed mark center hit ' +
        JSON.stringify(after.hitId) +
        ', not ' +
        JSON.stringify(${JSON.stringify(expectedId)});
    return {
      missing,
      blocker,
      before,
      after,
      stageClientBounds: clientBounds(stage),
      stageScrollHeight,
      stageClientHeight,
      maxScrollTop,
      attempts,
    };
  })()`);
}

async function installCommentMarkClickCapture(
  browser: ChromeSession,
  expectedId: string
): Promise<boolean> {
  return browser.evaluate<boolean>(String.raw`(() => {
    const prior = window.__otioPointerClickCapture;
    prior?.controller?.abort();
    const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
      (node) => node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
    );
    if (!(mark instanceof HTMLElement)) return false;
    const controller = new AbortController();
    const capture = {
      commentId: null,
      trusted: null,
      events: [],
      controller,
    };
    const onCapture = (event) => {
      capture.events.push({
        type: event.type,
        target: event.target ? (event.target.tagName + '.' + event.target.className) : null,
        clientX: event.clientX,
        clientY: event.clientY,
        isTrusted: event.isTrusted,
      });
      const target = event.target instanceof Element ? event.target.closest('.otio-comment-mark') : null;
      if (target && target.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}) {
        capture.commentId = target.getAttribute('data-comment-id');
        capture.trusted = event.isTrusted;
      }
    };
    document.addEventListener('click', onCapture, { capture: true, signal: controller.signal });
    document.addEventListener('mousedown', onCapture, { capture: true, signal: controller.signal });
    document.addEventListener('mouseup', onCapture, { capture: true, signal: controller.signal });
    mark.addEventListener(
      'click',
      (event) => {
        capture.commentId = mark.dataset.commentId ?? null;
        capture.trusted = event.isTrusted;
      },
      { capture: true, signal: controller.signal }
    );
    window.__otioPointerClickCapture = capture;
    return true;
  })()`);
}

async function readCommentMarkClickCapture(
  browser: ChromeSession
): Promise<CommentMarkPointerClickCapture> {
  return browser.evaluate<CommentMarkPointerClickCapture>(`(() => {
    const capture = window.__otioPointerClickCapture;
    return {
      commentId: capture?.commentId ?? null,
      trusted: capture?.trusted ?? null,
      events: capture?.events ?? [],
    };
  })()`);
}

async function clearCommentMarkClickCapture(
  browser: ChromeSession
): Promise<void> {
  await browser.evaluate<void>(`(() => {
    const capture = window.__otioPointerClickCapture;
    capture?.controller?.abort();
    delete window.__otioPointerClickCapture;
  })()`);
}

async function measureMarkControls(
  browser: ChromeSession,
  expectedId: string,
  body?: string
): Promise<CommentMarkPopoverProbe> {
  return browser.evaluate<CommentMarkPopoverProbe>(String.raw`(() => {
    const expectedId = ${JSON.stringify(expectedId)};
    const expectedBody = ${JSON.stringify(body ?? '')};
    const card = document.querySelector('.popover-card[data-anchor-kind="otio"]');
    const mark = document.querySelector('.otio-comment-mark[data-comment-id="' + expectedId + '"]');
    const stage = document.querySelector('.stage-wrap');
    const thread = document.querySelector('.thread');
    const toggle = document.querySelector('.thread-toggle');
    const composer = document.querySelector('.popover-composer');

    const rect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const v = node.getBoundingClientRect();
      return { left: v.left, top: v.top, right: v.right, bottom: v.bottom, width: v.width, height: v.height };
    };
    const cardRect = rect(card);
    const markRect = rect(mark);
    const stageRect = rect(stage);

    const visible = (node, r) => {
      if (!(node instanceof HTMLElement) || !r) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };

    const side = (card?.getAttribute('data-side') ?? (cardRect && markRect && cardRect.top >= markRect.bottom ? 'below' : 'above'));
    let gap = null;
    let gapValid = false;
    let horizontalCentred = false;
    let overlapArea = 0;
    let withinStage = false;
    let withinViewport = false;

    if (cardRect && markRect) {
      gap = side === 'below' ? Math.abs(cardRect.top - markRect.bottom - 8) : Math.abs(markRect.top - cardRect.bottom - 8);
      gapValid = gap <= 1.5;
      const markCenterX = (markRect.left + markRect.right) / 2;
      const againstMargin = stageRect ? (cardRect.left <= stageRect.left + 9 || cardRect.right >= stageRect.right - 9) : false;
      horizontalCentred = againstMargin || (markCenterX >= cardRect.left - 1 && markCenterX <= cardRect.right + 1);
      const overlapW = Math.max(0, Math.min(cardRect.right, markRect.right) - Math.max(cardRect.left, markRect.left));
      const overlapH = Math.max(0, Math.min(cardRect.bottom, markRect.bottom) - Math.max(cardRect.top, markRect.top));
      overlapArea = overlapW * overlapH;
    }
    if (cardRect && stageRect) {
      withinStage = cardRect.left >= stageRect.left - 1 && cardRect.right <= stageRect.right + 1 &&
                    cardRect.top >= stageRect.top - 1 && cardRect.bottom <= stageRect.bottom + 1;
    }
    if (cardRect) {
      withinViewport = cardRect.left >= -1 && cardRect.right <= window.innerWidth + 1 &&
                       cardRect.top >= -1 && cardRect.bottom <= window.innerHeight + 1;
    }

    return {
      cardId: card?.getAttribute('data-comment-id') ?? null,
      anchorKind: card?.getAttribute('data-anchor-kind') ?? null,
      visible: visible(card, cardRect),
      bodyPresent: expectedBody ? (card?.textContent?.includes(expectedBody) ?? false) : true,
      composerOpen: composer !== null && visible(composer, rect(composer)),
      sidebarClosed: (thread === null || !thread.classList.contains('is-open')) && toggle?.getAttribute('aria-expanded') !== 'true',
      cardRect,
      markRect,
      side,
      gap,
      gapValid,
      horizontalCentred,
      overlapArea,
      withinStage,
      withinViewport,
      hasReply: card?.querySelector('.popover-reply') !== null,
      hasOpenThread: card?.querySelector('.popover-open-thread') !== null,
      hasNoField: card?.querySelector('.popover-field') === null,
    };
  })()`);
}

async function waitForCommentMarkPopover(
  browser: ChromeSession,
  expectedId: string,
  body: string
): Promise<CommentMarkPopoverProbe> {
  const started = Date.now();
  let latest = await measureMarkControls(browser, expectedId, body);
  while (Date.now() - started < 5000) {
    if (latest.cardId === expectedId && latest.visible && latest.bodyPresent) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await measureMarkControls(browser, expectedId, body);
  }
  return latest;
}

async function assertCommentMarkPointerClick(
  browser: ChromeSession,
  pointerCase: CommentMarkPointerCase,
  nativeControlMeasurements: Array<Record<string, unknown>>
): Promise<void> {
  let savedScroll: {
    stageScrollTop: number;
    timelineScrollLeft: number;
  } | null = null;
  const receipt: Record<string, unknown> = {
    state: 'comment-mark-pointer-click',
    case: pointerCase.caseName,
    expectedId: pointerCase.expectedId,
    expectedAnchor: pointerCase.expectedAnchor,
  };
  try {
    savedScroll = await browser.evaluate<{
      stageScrollTop: number;
      timelineScrollLeft: number;
    } | null>(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const timeline = document.querySelector('.otio-timeline-scroll');
      if (!(stage instanceof HTMLElement) || !(timeline instanceof HTMLElement))
        return null;
      return {
        stageScrollTop: stage.scrollTop,
        timelineScrollLeft: timeline.scrollLeft,
      };
    })()`);
    await closePopoverWithEscape(browser);
    await clearPointerHover(browser);
    const exposure = await exposeCommentMarkForPointer(
      browser,
      pointerCase.expectedId
    );
    const captureInstalled = await installCommentMarkClickCapture(
      browser,
      pointerCase.expectedId
    );
    let card: CommentMarkPopoverProbe = {
      cardId: null,
      anchorKind: null,
      visible: false,
      bodyPresent: false,
      composerOpen: false,
      sidebarClosed: true,
      cardRect: null,
      markRect: null,
      side: null,
      gap: null,
      gapValid: false,
      horizontalCentred: false,
      overlapArea: 0,
      withinStage: false,
      withinViewport: false,
      hasReply: false,
      hasOpenThread: false,
      hasNoField: true,
    };
    const freshCenter = await browser.evaluate<{ x: number; y: number } | null>(
      String.raw`(() => {
        const mark = document.querySelector('.otio-comment-mark[data-comment-id="' + ${JSON.stringify(pointerCase.expectedId)} + '"]');
        if (!(mark instanceof HTMLElement)) return null;
        const r = mark.getBoundingClientRect();
        const label = mark.closest('.otio-track-row')?.querySelector('.otio-track-label');
        const labelRight = label instanceof HTMLElement ? label.getBoundingClientRect().right : 0;
        const left = Math.max(r.left, labelRight);
        const right = r.right;
        const x = left < right ? (left + right) / 2 : r.left + r.width / 2;
        return { x, y: r.top + r.height / 2 };
      })()`
    );
    const clickTarget = freshCenter ?? exposure.after.center;
    if (clickTarget !== null && captureInstalled) {
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: clickTarget.x,
        y: clickTarget.y,
        button: 'none',
      });
      const adjustedCenter = await browser.evaluate<{
        x: number;
        y: number;
      } | null>(
        String.raw`(() => {
          const mark = document.querySelector('.otio-comment-mark[data-comment-id="' + ${JSON.stringify(pointerCase.expectedId)} + '"]');
          if (!(mark instanceof HTMLElement)) return null;
          const r = mark.getBoundingClientRect();
          const label = mark.closest('.otio-track-row')?.querySelector('.otio-track-label');
          const labelRight = label instanceof HTMLElement ? label.getBoundingClientRect().right : 0;
          const left = Math.max(r.left, labelRight);
          const right = r.right;
          const x = left < right ? (left + right) / 2 : r.left + r.width / 2;
          return { x, y: r.top + r.height / 2 };
        })()`
      );
      const target = adjustedCenter ?? clickTarget;
      await clickWithRealPointer(browser, target.x, target.y);
      card = await waitForCommentMarkPopover(
        browser,
        pointerCase.expectedId,
        pointerCase.body
      );
    }
    const capture = await readCommentMarkClickCapture(browser);
    const postClick = await commentMarkPointerPosition(
      browser,
      pointerCase.expectedId
    );
    Object.assign(receipt, {
      savedScroll,
      exposure,
      captureInstalled,
      hitId: exposure.after.hitId,
      trustedClickId: capture.commentId,
      trusted: capture.trusted,
      cardId: card.cardId,
      card,
      markRect: exposure.after.rect,
      sample: exposure.after.center,
      anchor: exposure.after.anchor,
      commentLane: exposure.after.commentLane,
      preExposure: exposure.before,
      postClick,
    });
    await browser.screenshot(
      `otio-comment-mark-pointer-${pointerCase.caseName}`
    );
    nativeControlMeasurements.push(receipt);
    const evidence = JSON.stringify(receipt);
    assert.ok(savedScroll, `pointer receipt has no saved scroll: ${evidence}`);
    assert.deepEqual(
      exposure.missing,
      [],
      `pointer mark is missing: ${evidence}`
    );
    assert.equal(
      exposure.blocker,
      null,
      `pointer mark cannot be exposed: ${evidence}`
    );
    assert.equal(
      exposure.after.hitId,
      pointerCase.expectedId,
      `pointer pre-hit did not identify the expected comment: ${evidence}`
    );
    assert.equal(
      captureInstalled,
      true,
      `pointer click listener was not installed on the expected mark: ${evidence}`
    );
    assert.equal(
      capture.commentId,
      pointerCase.expectedId,
      `real pointer click reached the wrong comment: ${evidence}`
    );
    assert.equal(
      capture.trusted,
      true,
      `real pointer click was not trusted: ${evidence}`
    );
    assert.equal(
      card.cardId,
      pointerCase.expectedId,
      `pointer click opened the wrong popover: ${evidence}`
    );
    assert.equal(
      card.anchorKind,
      'otio',
      `pointer click popover is not an otio popover: ${evidence}`
    );
    assert.equal(
      card.visible,
      true,
      `pointer click did not leave a visible popover: ${evidence}`
    );
    assert.equal(
      card.bodyPresent,
      true,
      `pointer click popover omitted the independently read back body: ${evidence}`
    );
    assert.equal(
      card.composerOpen,
      false,
      `pointer click left composer open: ${evidence}`
    );
    assert.equal(
      card.sidebarClosed,
      true,
      `pointer click opened sidebar: ${evidence}`
    );
    assert.ok(
      card.gapValid,
      `pointer click card gap ${card.gap} deviates from 8px: ${evidence}`
    );
    assert.equal(
      card.horizontalCentred,
      true,
      `pointer click card is not horizontally centred on mark: ${evidence}`
    );
    assert.equal(
      card.overlapArea,
      0,
      `pointer click card overlaps mark: ${evidence}`
    );
    assert.equal(
      card.withinStage,
      true,
      `pointer click card escapes stage: ${evidence}`
    );
    assert.equal(
      card.hasNoField,
      true,
      `mark card carries a composer field: ${evidence}`
    );
    assert.equal(
      card.hasReply,
      true,
      `mark card is missing reply button: ${evidence}`
    );
    assert.equal(
      card.hasOpenThread,
      true,
      `mark card is missing open thread button: ${evidence}`
    );
    assert.deepEqual(
      exposure.after.anchor,
      pointerCase.expectedAnchor,
      `pointer mark anchor differs from fresh comment readback: ${evidence}`
    );
  } finally {
    await closePopoverWithEscape(browser);
    await clearPointerHover(browser);
    receipt['postDrawerClose'] = await commentMarkPointerPosition(
      browser,
      pointerCase.expectedId
    );
    if (savedScroll !== null) {
      await browser.evaluate<void>(String.raw`(() => {
        const stage = document.querySelector('.stage-wrap');
        const timeline = document.querySelector('.otio-timeline-scroll');
        if (!(stage instanceof HTMLElement) || !(timeline instanceof HTMLElement))
          return;
        stage.scrollTop = ${savedScroll.stageScrollTop};
        timeline.scrollLeft = ${savedScroll.timelineScrollLeft};
      })()`);
    }
    receipt['restoredScroll'] = await browser.evaluate<Record<string, unknown>>(
      `(() => {
        const stage = document.querySelector('.stage-wrap');
        const timeline = document.querySelector('.otio-timeline-scroll');
        return {
          stageScrollTop: stage instanceof HTMLElement ? stage.scrollTop : null,
          timelineScrollLeft:
            timeline instanceof HTMLElement ? timeline.scrollLeft : null,
        };
      })()`
    );
    await clearCommentMarkClickCapture(browser);
  }
}
async function openCommentsSidebarWithPointer(
  browser: ChromeSession
): Promise<void> {
  const tab = await browser.evaluate<{
    readonly center: { readonly x: number; readonly y: number } | null;
    readonly hitOwned: boolean;
  }>(`(() => {
    const tab = document.querySelector('.thread-tab');
    if (!(tab instanceof HTMLElement)) return { center: null, hitOwned: false };
    const rect = tab.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      center,
      hitOwned: hit === tab || tab.contains(hit),
    };
  })()`);
  assert.ok(tab.center, 'auxiliary Comments tab has no pointer center');
  assert.equal(
    tab.hitOwned,
    true,
    'auxiliary Comments tab does not own its hit'
  );
  await clickWithRealPointer(browser, tab.center.x, tab.center.y);
  const opened = await browser.evaluate<boolean>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const started = Date.now();
    const tick = () => {
      const thread = document.querySelector('.thread');
      const list = document.querySelector('.thread-list');
      if (
        thread instanceof HTMLElement &&
        thread.classList.contains('is-open') &&
        list instanceof HTMLElement
      ) {
        resolve(true);
      } else if (Date.now() - started > 4000) {
        resolve(false);
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
  assert.equal(opened, true, 'auxiliary Comments sidebar did not open');
}

async function waitForAuxiliaryCoincidentMarks(
  browser: ChromeSession,
  expectedIds: readonly string[]
): Promise<AuxiliaryCoincidentMarksProbe> {
  return browser.evaluate<AuxiliaryCoincidentMarksProbe>(String.raw`(() => {
    const expectedIds = ${JSON.stringify(expectedIds)};
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const snapshot = () => {
      const stage = document.querySelector('.otio-timeline-scroll');
      const thread = document.querySelector('.thread');
      const list = document.querySelector('.thread-list');
      const missing = [];
      if (!(stage instanceof HTMLElement)) missing.push('.stage-wrap');
      if (!(thread instanceof HTMLElement)) missing.push('.thread');
      if (!(list instanceof HTMLElement)) missing.push('.thread-list');
      const matched = expectedIds
        .map((id) => {
          const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
            (node) => node.getAttribute('data-comment-id') === id
          );
          return mark instanceof HTMLElement ? { id, mark } : null;
        })
        .filter((entry) => entry !== null);
      if (matched.length !== expectedIds.length)
        missing.push('.otio-comment-mark[data-comment-id]');
      if (
        list instanceof HTMLElement &&
        !matched.every(({ id }) =>
          [...list.querySelectorAll('[data-comment-id]')].some(
            (row) => row.getAttribute('data-comment-id') === id
          )
        )
      )
        missing.push('.thread-list [data-comment-id]');
      if (thread instanceof HTMLElement && !thread.classList.contains('is-open'))
        missing.push('.thread.is-open');
      const marks = matched.map(({ id, mark }) => {
        const laneValue = mark.style.getPropertyValue('--otio-comment-lane');
        const lane = Number(laneValue);
        return {
          id,
          rect: rect(mark),
          commentLane:
            laneValue.trim().length > 0 && Number.isFinite(lane)
              ? lane
              : null,
        };
      });
      const band = matched[0]?.mark.closest('.otio-comment-band');
      const spatialTop = [...marks].sort(
        (a, b) =>
          a.rect.top - b.rect.top ||
          a.rect.left - b.rect.left ||
          a.id.localeCompare(b.id)
      )[0];
      const spatialBottom = [...marks].sort(
        (a, b) =>
          b.rect.bottom - a.rect.bottom ||
          b.rect.right - a.rect.right ||
          a.id.localeCompare(b.id)
      )[0];
      return {
        missing,
        marks,
        bandHeight:
          band instanceof HTMLElement ? band.getBoundingClientRect().height : null,
        stageClientHeight:
          stage instanceof HTMLElement ? stage.clientHeight : null,
        spatialTopId: spatialTop?.id ?? null,
        spatialBottomId: spatialBottom?.id ?? null,
      };
    };
    const { promise, resolve } = Promise.withResolvers();
    const started = Date.now();
    const tick = () => {
      const current = snapshot();
      if (current.missing.length === 0) {
        resolve(current);
      } else if (Date.now() - started > 10000) {
        resolve(current);
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
}

async function arrangeAuxiliarySidebarActivation(
  browser: ChromeSession,
  expectedId: string
): Promise<AuxiliarySidebarPrecondition> {
  return browser.evaluate<AuxiliarySidebarPrecondition>(String.raw`(async () => {
    const empty = {
      stageScrollTop: null,
      timelineScrollLeft: null,
      timelineScrollTop: null,
      stageContent: null,
      bodyRect: null,
      markRect: null,
      bodySpansStage: false,
      markOffscreen: false,
      direction: null,
    };
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
      (node) => node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
    );
    const body = mark?.closest('.otio-track-body');
    const missing = [];
    if (!(stage instanceof HTMLElement)) missing.push('.stage-wrap');
    if (!(timeline instanceof HTMLElement)) missing.push('.otio-timeline-scroll');
    if (!(mark instanceof HTMLElement)) missing.push('.otio-comment-mark[data-comment-id]');
    if (!(body instanceof HTMLElement)) missing.push('.otio-track-body');
    if (missing.length > 0)
      return {
        missing,
        blocker: 'auxiliary reveal precondition is missing ' + missing.join(', '),
        before: empty,
        after: empty,
      };
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const stageContent = () => {
      const value = timeline.getBoundingClientRect();
      const left = value.left + timeline.clientLeft;
      const top = value.top + timeline.clientTop;
      return {
        left,
        top,
        right: left + timeline.clientWidth,
        bottom: top + timeline.clientHeight,
        width: timeline.clientWidth,
        height: timeline.clientHeight,
      };
    };
    const snapshot = (direction) => {
      const content = stageContent();
      const bodyRect = rect(body);
      const markRect = rect(mark);
      return {
        stageScrollTop: stage.scrollTop,
        timelineScrollLeft: timeline.scrollLeft,
        timelineScrollTop: timeline.scrollTop,
        stageContent: content,
        bodyRect,
        markRect,
        bodySpansStage:
          bodyRect.top < content.top && bodyRect.bottom > content.bottom,
        markOffscreen:
          markRect.bottom <= content.top || markRect.top >= content.bottom,
        direction,
      };
    };
    const before = snapshot(null);
    const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
    const epsilon = 0.5;
    const bodySpanMin = Math.max(
      0,
      timeline.scrollTop + before.bodyRect.top - before.stageContent.top + epsilon
    );
    const bodySpanMax = Math.min(
      maximum,
      timeline.scrollTop + before.bodyRect.bottom - before.stageContent.bottom - epsilon
    );
    const aboveMin =
      timeline.scrollTop + before.markRect.bottom - before.stageContent.top + epsilon;
    const belowMax =
      timeline.scrollTop + before.markRect.top - before.stageContent.bottom - epsilon;
    const candidates = [
      {
        direction: 'above',
        min: Math.max(bodySpanMin, aboveMin),
        max: bodySpanMax,
      },
      {
        direction: 'below',
        min: bodySpanMin,
        max: Math.min(bodySpanMax, belowMax),
      },
    ].filter((candidate) => candidate.min <= candidate.max);
    const candidate = candidates[0];
    if (!candidate)
      return {
        missing,
        blocker:
          'no stage scroll position keeps the whole track body spanning both edges while the chosen mark is offscreen: ' +
          JSON.stringify(before),
        before,
        after: empty,
      };
    timeline.scrollTop = (candidate.min + candidate.max) / 2;
    const { promise, resolve } = Promise.withResolvers();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
    await promise;
    const after = snapshot(candidate.direction);
    const blocker =
      after.bodySpansStage && after.markOffscreen
        ? null
        : 'auxiliary reveal precondition did not survive stage scroll: ' +
          JSON.stringify(after);
    return { missing, blocker, before, after };
  })()`);
}

async function scrollAuxiliarySidebarRowIntoView(
  browser: ChromeSession,
  expectedId: string
): Promise<AuxiliarySidebarRowProbe> {
  return browser.evaluate<AuxiliarySidebarRowProbe>(String.raw`(async () => {
    const stage = document.querySelector('.stage-wrap');
    const timeline = document.querySelector('.otio-timeline-scroll');
    const list = document.querySelector('.thread-list');
    const row =
      list instanceof HTMLElement
        ? [...list.querySelectorAll('[data-comment-id]')].find(
            (node) =>
              node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
          )
        : null;
    const missing = [];
    if (!(stage instanceof HTMLElement)) missing.push('.stage-wrap');
    if (!(timeline instanceof HTMLElement)) missing.push('.otio-timeline-scroll');
    if (!(list instanceof HTMLElement)) missing.push('.thread-list');
    if (!(row instanceof HTMLElement)) missing.push('.thread-list [data-comment-id]');
    if (missing.length > 0)
      return {
        missing,
        rowRect: null,
        center: null,
        visible: false,
        hitOwned: false,
        stageBefore: null,
        stageAfter: null,
        timelineBefore: null,
        timelineAfter: null,
        timelineTopBefore: null,
        timelineTopAfter: null,
      };
    const stageBefore = stage.scrollTop;
    const timelineBefore = timeline.scrollLeft;
    const timelineTopBefore = timeline.scrollTop;
    row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const { promise, resolve } = Promise.withResolvers();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
    await promise;
    const rowRectValue = row.getBoundingClientRect();
    const rowRect = {
      left: rowRectValue.left,
      top: rowRectValue.top,
      right: rowRectValue.right,
      bottom: rowRectValue.bottom,
      width: rowRectValue.width,
      height: rowRectValue.height,
    };
    const listRect = list.getBoundingClientRect();
    const center = {
      x: rowRect.left + rowRect.width / 2,
      y: rowRect.top + rowRect.height / 2,
    };
    const hit = document.elementFromPoint(center.x, center.y);
    const style = getComputedStyle(row);
    return {
      missing,
      rowRect,
      center,
      visible:
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rowRect.width > 0 &&
        rowRect.height > 0 &&
        rowRect.left >= listRect.left &&
        rowRect.right <= listRect.right &&
        rowRect.top >= listRect.top &&
        rowRect.bottom <= listRect.bottom,
      hitOwned: hit === row || row.contains(hit),
      stageBefore,
      stageAfter: stage.scrollTop,
      timelineBefore,
      timelineAfter: timeline.scrollLeft,
      timelineTopBefore,
      timelineTopAfter: timeline.scrollTop,
    };
  })()`);
}

async function installAuxiliarySidebarClickCapture(
  browser: ChromeSession,
  expectedId: string
): Promise<boolean> {
  return browser.evaluate<boolean>(String.raw`(() => {
    const prior = window.__otioAuxiliarySidebarClick;
    prior?.controller?.abort();
    const list = document.querySelector('.thread-list');
    const row =
      list instanceof HTMLElement
        ? [...list.querySelectorAll('[data-comment-id]')].find(
            (node) =>
              node.getAttribute('data-comment-id') === ${JSON.stringify(expectedId)}
          )
        : null;
    if (!(row instanceof HTMLElement)) return false;
    const controller = new AbortController();
    const capture = {
      commentId: null,
      trusted: null,
      controller,
    };
    row.addEventListener(
      'click',
      (event) => {
        capture.commentId = row.dataset.commentId ?? null;
        capture.trusted = event.isTrusted;
      },
      { capture: true, once: true, signal: controller.signal }
    );
    window.__otioAuxiliarySidebarClick = capture;
    return true;
  })()`);
}

async function readAuxiliarySidebarClickCapture(
  browser: ChromeSession
): Promise<AuxiliarySidebarClickCapture> {
  return browser.evaluate<AuxiliarySidebarClickCapture>(`(() => {
    const capture = window.__otioAuxiliarySidebarClick;
    return {
      commentId: capture?.commentId ?? null,
      trusted: capture?.trusted ?? null,
    };
  })()`);
}

async function clearAuxiliarySidebarClickCapture(
  browser: ChromeSession
): Promise<void> {
  await browser.evaluate<void>(`(() => {
    const capture = window.__otioAuxiliarySidebarClick;
    capture?.controller?.abort();
    delete window.__otioAuxiliarySidebarClick;
  })()`);
}

async function waitForAuxiliaryReveal(
  browser: ChromeSession,
  expectedId: string,
  body: string
): Promise<AuxiliaryRevealProbe> {
  return browser.evaluate<AuxiliaryRevealProbe>(String.raw`(() => {
    const expectedId = ${JSON.stringify(expectedId)};
    const expectedBody = ${JSON.stringify(body)};
    const empty = {
      missing: [],
      markRect: null,
      stageContent: null,
      center: null,
      usableLeft: null,
      usableRight: null,
      hitId: null,
      hitOwned: false,
      activeIds: [],
      cardId: null,
      cardVisible: false,
      bodyPresent: false,
      anchor: null,
      stageScrollTop: null,
      timelineScrollLeft: null,
      gap: null,
      gapValid: false,
      horizontalCentred: false,
      overlapArea: 0,
    };
    const snapshot = () => {
      const stage = document.querySelector('.stage-wrap');
      const timeline = document.querySelector('.otio-timeline-scroll');
      const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
        (node) => node.getAttribute('data-comment-id') === expectedId
      );
      const label = mark
        ?.closest('.otio-track-row')
        ?.querySelector('.otio-track-label');
      const card = document.querySelector('.popover-card');
      const missing = [];
      if (!(stage instanceof HTMLElement)) missing.push('.stage-wrap');
      if (!(timeline instanceof HTMLElement)) missing.push('.otio-timeline-scroll');
      if (!(mark instanceof HTMLElement)) missing.push('.otio-comment-mark[data-comment-id]');
      if (!(label instanceof HTMLElement)) missing.push('.otio-track-label');
      if (missing.length > 0) return { ...empty, missing };
      const rect = (node) => {
        const value = node.getBoundingClientRect();
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      };
      const clientBounds = (node) => {
        const value = rect(node);
        return {
          left: value.left + node.clientLeft,
          top: value.top + node.clientTop,
          right: value.left + node.clientLeft + node.clientWidth,
          bottom: value.top + node.clientTop + node.clientHeight,
          width: node.clientWidth,
          height: node.clientHeight,
        };
      };
      const markRect = rect(mark);
      const center = {
        x: markRect.left + markRect.width / 2,
        y: markRect.top + markRect.height / 2,
      };
      const stageBounds = clientBounds(stage);
      const timelineBounds = clientBounds(timeline);
      const labelRect = rect(label);
      const usableLeft = Math.max(
        stageBounds.left,
        timelineBounds.left,
        labelRect.right
      );
      const usableRight = Math.min(
        stageBounds.right,
        timelineBounds.right,
        window.innerWidth
      );
      const hit = document.elementFromPoint(center.x, center.y);
      const hitId =
        hit?.closest('.otio-comment-mark')?.getAttribute('data-comment-id') ?? null;
      const fields = [
        Number(mark.dataset.start),
        Number(mark.dataset.duration),
        Number(mark.dataset.rate),
        Number(mark.dataset.durationRate),
      ];
      const anchor =
        mark.dataset.trackId && fields.every(Number.isFinite)
          ? {
              trackId: mark.dataset.trackId,
              start: fields[0],
              duration: fields[1],
              rate: fields[2],
              durationRate: fields[3],
            }
          : null;
      const cardRect =
        card instanceof HTMLElement ? card.getBoundingClientRect() : null;
      const cardStyle =
        card instanceof HTMLElement ? getComputedStyle(card) : null;
      const side =
        card?.getAttribute('data-side') ??
        (cardRect && markRect && cardRect.top >= markRect.bottom
          ? 'below'
          : 'above');
      let gap = null;
      let gapValid = false;
      let horizontalCentred = false;
      let overlapArea = 0;
      if (cardRect && markRect) {
        gap =
          side === 'below'
            ? Math.abs(cardRect.top - markRect.bottom - 8)
            : Math.abs(markRect.top - cardRect.bottom - 8);
        gapValid = gap <= 1.5;
        const markCenterX = (markRect.left + markRect.right) / 2;
        const againstMargin = stageBounds
          ? cardRect.left <= stageBounds.left + 9 ||
            cardRect.right >= stageBounds.right - 9
          : false;
        horizontalCentred =
          againstMargin ||
          (markCenterX >= cardRect.left - 1 && markCenterX <= cardRect.right + 1);
        const overlapW = Math.max(
          0,
          Math.min(cardRect.right, markRect.right) -
            Math.max(cardRect.left, markRect.left)
        );
        const overlapH = Math.max(
          0,
          Math.min(cardRect.bottom, markRect.bottom) -
            Math.max(cardRect.top, markRect.top)
        );
        overlapArea = overlapW * overlapH;
      }
      return {
        missing,
        markRect,
        stageContent: {
          ...stageBounds,
          top: Math.max(stageBounds.top, timelineBounds.top, 0),
          bottom: Math.min(stageBounds.bottom, timelineBounds.bottom, window.innerHeight),
        },
        center,
        usableLeft,
        usableRight,
        hitId,
        hitOwned: hit === mark || mark.contains(hit),
        activeIds: [...document.querySelectorAll('.otio-comment-mark.is-active')]
          .map((node) => node.getAttribute('data-comment-id'))
          .filter((id) => id !== null),
        cardId: card?.getAttribute('data-comment-id') ?? null,
        cardVisible:
          cardRect !== null &&
          cardStyle !== null &&
          cardStyle.display !== 'none' &&
          cardStyle.visibility !== 'hidden' &&
          cardRect.width > 0 &&
          cardRect.height > 0,
        bodyPresent: card?.textContent?.includes(expectedBody) ?? false,
        anchor,
        stageScrollTop: stage.scrollTop,
        timelineScrollLeft: timeline.scrollLeft,
        gap,
        gapValid,
        horizontalCentred,
        overlapArea,
      };
    };
    const { promise, resolve } = Promise.withResolvers();
    const started = Date.now();
    const tick = () => {
      const current = snapshot();
      if (
        current.missing.length === 0 &&
        current.hitOwned &&
        current.hitId === expectedId &&
        current.center !== null &&
        current.usableLeft !== null &&
        current.usableRight !== null &&
        current.center.x >= current.usableLeft &&
        current.center.x <= current.usableRight &&
        current.stageContent !== null &&
        current.center.y >= current.stageContent.top &&
        current.center.y <= current.stageContent.bottom &&
        current.activeIds.length === 1 &&
        current.activeIds[0] === expectedId &&
        current.cardId === expectedId &&
        current.cardVisible &&
        current.bodyPresent
      ) {
        resolve(current);
      } else if (Date.now() - started > 10000) {
        resolve(current);
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
}
async function runAuxiliaryCoincidentCommentRevealScenario(
  plan: Plan
): Promise<void> {
  const published = await callMcp('relic_publish', {
    path: fixtureDir,
    force_new: true,
    title: 'OTIO coincident comment reveal proof',
    cover: false,
  });
  const relicId = String(published['relic_id']);
  const shareUrl = String(published['url'] ?? published['link'] ?? '');
  assert.ok(relicId, 'auxiliary publish returned no relic_id');
  assert.ok(shareUrl.includes('#'), 'auxiliary publish returned no keyed link');
  assert.ok(
    shareUrl.startsWith(origin),
    `auxiliary publish URL left loopback: ${shareUrl}`
  );
  const windowMilliseconds = app.config.commentRateLimit.windowSeconds * 1000;
  const initialClockBefore = loopbackNow;
  loopbackNow += windowMilliseconds;
  const clockReceipt = {
    configuredLimit: app.config.commentRateLimit.limit,
    configuredWindowSeconds: app.config.commentRateLimit.windowSeconds,
    initialBoundary: {
      before: initialClockBefore,
      after: loopbackNow,
    },
    boundaries: [] as Array<{
      before: number;
      after: number;
      completedUiPosts: number;
    }>,
    completedUiPosts: 0,
  };
  const auxiliaryToken = `otio-auxiliary-token-${Math.random().toString(16).slice(2)}`;
  await store.putSession({
    tokenHash: await sha256Hex(auxiliaryToken),
    email: 'reader@example.test',
    createdAt: loopbackNow,
    expiresAt: loopbackNow + app.config.sessionTtlSeconds * 1000,
  });
  const browser = await openBrowser(shareUrl, auxiliaryToken, {
    label: 'auxiliary-coincident-comment-reveal',
  });
  const measurements: Array<Record<string, unknown>> = [];
  try {
    assert.equal(
      await waitReady(browser),
      'true',
      'auxiliary coincident-comment relic did not become ready'
    );
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    const pointRange: TimeRange = {
      start_time: {
        value: plan.duplicate_frame,
        rate: plan.timeline_rate,
      },
      duration: {
        value: 0,
        rate: plan.timeline_rate,
      },
    };
    const bodies = Array.from(
      { length: 40 },
      (_, index) => `Coincident duplicate-point reveal ${index + 1}.`
    );
    for (const [index, body] of bodies.entries()) {
      if (index > 0 && index % app.config.commentRateLimit.limit === 0) {
        const before = loopbackNow;
        loopbackNow += windowMilliseconds;
        clockReceipt.boundaries.push({
          before,
          after: loopbackNow,
          completedUiPosts: clockReceipt.completedUiPosts,
        });
      }
      await selectTrack(
        browser,
        plan.duplicate_track_id,
        'point',
        plan.duplicate_frame,
        plan.duplicate_frame
      );
      await postComposer(browser, body);
      clockReceipt.completedUiPosts += 1;
    }
    const fresh = await readComments(relicId);
    const cases = bodies.map((body, index) =>
      pointerCommentCase(
        fresh,
        `coincident-point-${index + 1}`,
        body,
        plan.duplicate_track_id,
        pointRange
      )
    );
    assert.equal(
      new Set(cases.map((pointerCase) => pointerCase.expectedId)).size,
      cases.length,
      'auxiliary fresh readback reused a comment_id across coincident points'
    );
    await openCommentsSidebarWithPointer(browser);
    const coincident = await waitForAuxiliaryCoincidentMarks(
      browser,
      cases.map((pointerCase) => pointerCase.expectedId)
    );
    assert.deepEqual(
      coincident.missing,
      [],
      `auxiliary coincident marks are missing: ${JSON.stringify(coincident)}`
    );
    assert.equal(
      coincident.marks.length,
      cases.length,
      `auxiliary rendered ${coincident.marks.length}, not ${cases.length}, coincident marks`
    );
    assert.ok(
      coincident.bandHeight !== null &&
        coincident.stageClientHeight !== null &&
        coincident.bandHeight > coincident.stageClientHeight,
      `auxiliary comment band does not exceed the stage viewport: ${JSON.stringify(coincident)}`
    );
    assert.ok(
      coincident.spatialTopId && coincident.spatialBottomId,
      `auxiliary spatial mark selection is incomplete: ${JSON.stringify(coincident)}`
    );
    assert.notEqual(
      coincident.spatialTopId,
      coincident.spatialBottomId,
      `auxiliary spatial extremes resolved to one mark: ${JSON.stringify(coincident)}`
    );
    const casesById = new Map(
      cases.map((pointerCase) => [pointerCase.expectedId, pointerCase])
    );
    const activations = [
      ['spatial-top', coincident.spatialTopId],
      ['spatial-bottom', coincident.spatialBottomId],
    ] as const;
    for (const [position, expectedId] of activations) {
      const pointerCase = casesById.get(expectedId ?? '');
      assert.ok(
        pointerCase,
        `auxiliary ${position} mark is absent from fresh readback: ${expectedId}`
      );
      const beforeScreenshot = `auxiliary-coincident-${position}-sidebar-before`;
      const afterScreenshot = `auxiliary-coincident-${position}-sidebar-after`;
      const receipt: Record<string, unknown> = {
        state: 'auxiliary-coincident-sidebar-reveal',
        position,
        expectedId: pointerCase.expectedId,
        expectedAnchor: pointerCase.expectedAnchor,
        beforeScreenshot,
        afterScreenshot,
      };
      try {
        await closePopoverWithEscape(browser);
        await clearPointerHover(browser);
        const precondition = await arrangeAuxiliarySidebarActivation(
          browser,
          pointerCase.expectedId
        );
        const row = await scrollAuxiliarySidebarRowIntoView(
          browser,
          pointerCase.expectedId
        );
        Object.assign(receipt, { precondition, row });
        await browser.screenshot(beforeScreenshot);
        const preEvidence = JSON.stringify(receipt);
        assert.deepEqual(
          precondition.missing,
          [],
          `auxiliary ${position} reveal precondition is missing: ${preEvidence}`
        );
        assert.equal(
          precondition.blocker,
          null,
          `auxiliary ${position} reveal could not span the body and hide the mark: ${preEvidence}`
        );
        assert.equal(
          precondition.after.bodySpansStage,
          true,
          `auxiliary ${position} whole track body does not span both stage edges: ${preEvidence}`
        );
        assert.equal(
          precondition.after.markOffscreen,
          true,
          `auxiliary ${position} mark is still visible before sidebar activation: ${preEvidence}`
        );
        assert.deepEqual(
          row.missing,
          [],
          `auxiliary ${position} sidebar row is missing: ${preEvidence}`
        );
        assert.equal(
          row.stageBefore,
          precondition.after.stageScrollTop,
          `auxiliary ${position} sidebar row pre-scroll moved the stage: ${preEvidence}`
        );
        assert.equal(
          row.stageAfter,
          row.stageBefore,
          `auxiliary ${position} row.scrollIntoView moved the stage: ${preEvidence}`
        );
        assert.equal(
          row.timelineAfter,
          row.timelineBefore,
          `auxiliary ${position} row.scrollIntoView moved timeline time: ${preEvidence}`
        );
        assert.equal(
          row.timelineTopBefore,
          precondition.after.timelineScrollTop,
          `auxiliary ${position} precondition changed before row exposure: ${preEvidence}`
        );
        assert.equal(
          row.timelineTopAfter,
          row.timelineTopBefore,
          `auxiliary ${position} row.scrollIntoView moved timeline vertically: ${preEvidence}`
        );
        assert.equal(
          row.visible,
          true,
          `auxiliary ${position} sidebar row is not visible: ${preEvidence}`
        );
        assert.equal(
          row.hitOwned,
          true,
          `auxiliary ${position} sidebar row does not own its pointer center: ${preEvidence}`
        );
        assert.ok(
          row.center,
          `auxiliary ${position} sidebar row has no pointer center: ${preEvidence}`
        );
        const captureInstalled = await installAuxiliarySidebarClickCapture(
          browser,
          pointerCase.expectedId
        );
        assert.equal(
          captureInstalled,
          true,
          `auxiliary ${position} sidebar click listener was not installed: ${preEvidence}`
        );
        await clickWithRealPointer(browser, row.center.x, row.center.y);
        const capture = await readAuxiliarySidebarClickCapture(browser);
        const after = await waitForAuxiliaryReveal(
          browser,
          pointerCase.expectedId,
          pointerCase.body
        );
        Object.assign(receipt, {
          captureInstalled,
          trustedClickId: capture.commentId,
          trusted: capture.trusted,
          after,
        });
        await browser.screenshot(afterScreenshot);
        measurements.push(receipt);
        console.log(`OTIO_AUXILIARY_REVEAL ${JSON.stringify(receipt)}`);
        const evidence = JSON.stringify(receipt);
        assert.equal(
          capture.commentId,
          pointerCase.expectedId,
          `auxiliary ${position} sidebar click reached the wrong comment: ${evidence}`
        );
        assert.equal(
          capture.trusted,
          true,
          `auxiliary ${position} sidebar click was not trusted: ${evidence}`
        );
        assert.deepEqual(
          after.missing,
          [],
          `auxiliary ${position} reveal is missing geometry: ${evidence}`
        );
        assert.ok(
          after.center && after.stageContent,
          `auxiliary ${position} reveal has no mark center or stage content: ${evidence}`
        );
        assert.ok(
          after.center.x >= (after.usableLeft ?? Infinity) &&
            after.center.x <= (after.usableRight ?? -Infinity) &&
            after.center.y >= after.stageContent.top &&
            after.center.y <= after.stageContent.bottom,
          `auxiliary ${position} exact mark center is outside usable stage/time content: ${evidence}`
        );
        assert.equal(
          after.hitOwned,
          true,
          `auxiliary ${position} exact mark center does not own elementFromPoint: ${evidence}`
        );
        assert.equal(
          after.hitId,
          pointerCase.expectedId,
          `auxiliary ${position} post-reveal hit belongs to another comment: ${evidence}`
        );
        assert.deepEqual(
          after.activeIds,
          [pointerCase.expectedId],
          `auxiliary ${position} active mark id differs from sidebar target: ${evidence}`
        );
        assert.equal(
          after.cardId,
          pointerCase.expectedId,
          `auxiliary ${position} card id differs from sidebar target: ${evidence}`
        );
        assert.equal(
          after.cardVisible,
          true,
          `auxiliary ${position} sidebar click did not leave a visible card: ${evidence}`
        );
        assert.equal(
          after.bodyPresent,
          true,
          `auxiliary ${position} card omitted the fresh readback body: ${evidence}`
        );
        assert.deepEqual(
          after.anchor,
          pointerCase.expectedAnchor,
          `auxiliary ${position} reveal changed track or time fields: ${evidence}`
        );
        assert.ok(
          after.gapValid,
          `auxiliary ${position} reveal card gap ${after.gap} deviates from 8px: ${evidence}`
        );
        assert.equal(
          after.horizontalCentred,
          true,
          `auxiliary ${position} reveal card is not horizontally centred: ${evidence}`
        );
        assert.equal(
          after.overlapArea,
          0,
          `auxiliary ${position} reveal card overlaps mark: ${evidence}`
        );
      } finally {
        await closePopoverWithEscape(browser);
        await clearPointerHover(browser);
        await clearAuxiliarySidebarClickCapture(browser);
      }
    }
  } finally {
    try {
      await writeFile(
        join(shotDir, 'auxiliary-coincident-comment-reveal-measurements.json'),
        `${JSON.stringify(
          {
            relic_id: relicId,
            viewport: { width: 900, height: 900 },
            clock: {
              ...clockReceipt,
              finalNow: loopbackNow,
            },
            measurements,
          },
          null,
          2
        )}\n`
      );
    } finally {
      await browser.close();
    }
  }
}

function assertStageControlExposure(
  probe: StageControlExposure,
  label: string
): void {
  assert.deepEqual(probe.missing, [], `${label} control is unavailable`);
  assert.equal(probe.visible, true, `${label} control is hidden`);
  assert.equal(probe.withinStage, true, `${label} control escapes the stage`);
}

async function exposePreviewBase(
  browser: ChromeSession
): Promise<StageControlExposure> {
  return browser.evaluate<StageControlExposure>(String.raw`(async () => {
    const stage = document.querySelector('.stage-wrap');
    const block = document.querySelector('button.otio-preview-block');
    const missing = [];
    if (!stage) missing.push('.stage-wrap');
    if (!(block instanceof HTMLButtonElement) || block.hidden) missing.push('.otio-preview-block');
    if (missing.length > 0) return { missing, visible: false, withinStage: false, rect: null };
    stage.scrollTop = 0;
    block.click();
    const started = Date.now();
    while (Date.now() - started < 4000) {
      const preview = document.querySelector('button.otio-preview-base');
      if (preview instanceof HTMLElement) {
        const style = getComputedStyle(preview);
        const rect = preview.getBoundingClientRect();
        const host = stage.getBoundingClientRect();
        const left = host.left + stage.clientLeft;
        const top = host.top + stage.clientTop;
        const content = {
          left,
          top,
          right: left + stage.clientWidth,
          bottom: top + stage.clientHeight,
        };
        return {
          missing,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          withinStage: rect.left >= content.left - 1 && rect.right <= content.right + 1 &&
            rect.top >= content.top - 1 && rect.bottom <= content.bottom + 1,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
        };
      }
      await new Promise((resolve) => { requestAnimationFrame(resolve); setTimeout(resolve, 50); });
    }
    return { missing: [...missing, '.otio-preview-base'], visible: false, withinStage: false, rect: null };
  })()`);
}

async function restorePreviewBase(browser: ChromeSession): Promise<void> {
  const restored = await browser.evaluate<string>(String.raw`(async () => {
    const preview = document.querySelector('button.otio-preview-base');
    if (!(preview instanceof HTMLButtonElement)) return 'missing';
    preview.click();
    const started = Date.now();
    while (Date.now() - started < 4000) {
      const block = document.querySelector('button.otio-preview-block');
      if (block instanceof HTMLElement && !block.hidden) return 'restored';
      await new Promise((resolve) => { requestAnimationFrame(resolve); setTimeout(resolve, 50); });
    }
    return 'timeout';
  })()`);
  assert.equal(
    restored,
    'restored',
    `base preview did not restore: ${restored}`
  );
}

interface BlockedPreviewHitProbe {
  readonly x: number;
  readonly y: number;
  readonly owned: boolean;
  readonly tag: string | null;
  readonly className: string | null;
}

interface BlockedPreviewLineProbe {
  readonly rect: DomRectProbe;
  readonly contained: boolean;
  readonly clippingContained: boolean;
  readonly hits: readonly BlockedPreviewHitProbe[];
}

interface BlockedPreviewTextProbe {
  readonly text: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly rect: DomRectProbe | null;
  readonly contained: boolean;
  readonly clipping: readonly DomRectProbe[];
  readonly lines: readonly BlockedPreviewLineProbe[];
}
interface BlockedPreviewExposure {
  readonly target: string;
  readonly line: BlockedPreviewLineProbe;
  readonly scrollTop: number;
  readonly scopeStable: boolean;
  readonly readoutStable: boolean;
  readonly outerScrollStable: boolean;
}

interface BlockedPreviewProbe {
  readonly missing: readonly string[];
  readonly state: {
    readonly ready: string;
    readonly previewState: string;
    readonly buffering: string;
    readonly frame: string;
  };
  readonly scope: BlockedPreviewTextProbe;
  readonly scopeText: BlockedPreviewTextProbe;
  readonly diagnostics: readonly BlockedPreviewTextProbe[];
  readonly button: BlockedPreviewTextProbe;
  readonly scopeDiagnosticIntersections: number;
  readonly scopeButtonIntersections: number;
  readonly scopeStatusGap: number | null;
  readonly diagnosticButtonGap: number | null;
  readonly requiredGap: number;
  readonly exposures: readonly BlockedPreviewExposure[];
  readonly buttonCenterOwned: boolean;
  readonly scrollRange: number;
}

function assertBlockedPreviewReadable(
  probe: BlockedPreviewProbe,
  label: string,
  effectFrame: number
): void {
  assert.deepEqual(
    probe.missing,
    [],
    `${label} blocked preview nodes are missing`
  );
  assert.equal(
    probe.state.ready,
    'diagnostic',
    `${label} blocked preview is not diagnostic`
  );
  assert.equal(
    probe.state.previewState,
    'blocked',
    `${label} preview is not blocked`
  );
  assert.equal(
    probe.state.buffering,
    'false',
    `${label} blocked preview is buffering`
  );
  assert.equal(
    Number(probe.state.frame),
    effectFrame,
    `${label} blocked preview is not at the effect frame`
  );
  assert.ok(probe.scopeText.text.length > 0, `${label} scope text is empty`);
  assert.ok(probe.diagnostics.length > 0, `${label} has no blocked diagnostic`);
  assert.equal(
    probe.button.text,
    'Preview base media without unsupported effects',
    `${label} consent label is incomplete`
  );
  assert.equal(
    probe.scopeDiagnosticIntersections,
    0,
    `${label} scope banner overlaps blocked diagnostic text`
  );
  assert.equal(
    probe.scopeButtonIntersections,
    0,
    `${label} scope banner overlaps blocked consent button`
  );
  for (const node of [
    probe.scope,
    probe.scopeText,
    ...probe.diagnostics,
    probe.button,
  ]) {
    assert.equal(node.visible, true, `${label} text is hidden: ${node.text}`);
    assert.ok(node.opacity > 0, `${label} text is transparent: ${node.text}`);
    if (node === probe.scope || node === probe.scopeText) {
      assert.equal(
        node.contained,
        true,
        `${label} scope escapes preview: ${node.text}`
      );
    }
    assert.ok(
      node.lines.length > 0,
      `${label} has no text lines: ${node.text}`
    );
  }
  const expectedLines = [...probe.diagnostics, probe.button].reduce(
    (total, node) => total + node.lines.length,
    0
  );
  assert.equal(
    probe.exposures.length,
    expectedLines,
    `${label} did not expose every diagnostic and consent line`
  );
  for (const line of [...probe.scope.lines, ...probe.scopeText.lines]) {
    assert.ok(
      line.contained &&
        line.clippingContained &&
        line.hits.every((hit) => hit.owned),
      `${label} scope line is clipped or covered: ${JSON.stringify(line)}`
    );
  }
  for (const exposure of probe.exposures) {
    assert.ok(
      exposure.scopeStable &&
        exposure.readoutStable &&
        exposure.outerScrollStable,
      `${label} scrolling status moved surrounding controls: ${JSON.stringify(exposure)}`
    );
    assert.ok(
      exposure.line.contained &&
        exposure.line.clippingContained &&
        exposure.line.hits.every((hit) => hit.owned),
      `${label} status line is clipped or covered when exposed: ${JSON.stringify(exposure)}`
    );
  }
  assert.equal(
    probe.buttonCenterOwned,
    true,
    `${label} consent button cannot be hit when exposed`
  );
  assert.ok(
    probe.scopeStatusGap !== null && probe.scopeStatusGap >= probe.requiredGap,
    `${label} scope-to-status gap is ${probe.scopeStatusGap}px`
  );
  assert.ok(
    probe.diagnosticButtonGap !== null &&
      probe.diagnosticButtonGap >= probe.requiredGap,
    `${label} diagnostic-to-button gap is ${probe.diagnosticButtonGap}px`
  );
}

async function measureBlockedPreview(
  browser: ChromeSession
): Promise<BlockedPreviewProbe> {
  return browser.evaluate<BlockedPreviewProbe>(String.raw`(async () => {
    const root = document.querySelector('.otio-view');
    const stage = document.querySelector('.stage-wrap');
    const preview = document.querySelector('.otio-preview');
    const scope = document.querySelector('.otio-preview > .otio-preview-scope');
    const scopeText = document.querySelector('.otio-preview > .otio-preview-scope > span');
    const status = document.querySelector('.otio-preview > .otio-preview-status');
    const readout = document.querySelector('.otio-selection-readout');
    const diagnostics = status ? [...status.querySelectorAll(':scope > p')] : [];
    const button = status?.querySelector(':scope > button.otio-preview-base') ?? null;
    const missing = [];
    if (!root) missing.push('.otio-view');
    if (!stage) missing.push('.stage-wrap');
    if (!preview) missing.push('.otio-preview');
    if (!scope) missing.push('.otio-preview > .otio-preview-scope');
    if (!scopeText) missing.push('.otio-preview > .otio-preview-scope > span');
    if (!status) missing.push('.otio-preview > .otio-preview-status');
    if (!button) missing.push('.otio-preview > .otio-preview-status button.otio-preview-base');
    if (!readout) missing.push('.otio-selection-readout');
    const empty = {
      missing,
      state: {
        ready: root?.dataset.ready ?? '',
        previewState: root?.dataset.previewState ?? '',
        buffering: root?.dataset.buffering ?? '',
        frame: root?.dataset.frame ?? '',
      },
      scope: { text: '', visible: false, opacity: 0, rect: null, contained: false, clipping: [], lines: [] },
      scopeText: { text: '', visible: false, opacity: 0, rect: null, contained: false, clipping: [], lines: [] },
      diagnostics: [],
      button: { text: '', visible: false, opacity: 0, rect: null, contained: false, clipping: [], lines: [] },
      scopeDiagnosticIntersections: 0,
      scopeButtonIntersections: 0,
      scopeStatusGap: null,
      diagnosticButtonGap: null,
      requiredGap: 0,
      exposures: [],
      buttonCenterOwned: false,
      scrollRange: 0,
    };
    if (missing.length > 0) return empty;
    const originalStatusTop = status.scrollTop;
    status.scrollTop = 0;
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const stageContent = () => {
      const value = stage.getBoundingClientRect();
      const left = value.left + stage.clientLeft;
      const top = value.top + stage.clientTop;
      return {
        left,
        top,
        right: left + stage.clientWidth,
        bottom: top + stage.clientHeight,
        width: stage.clientWidth,
        height: stage.clientHeight,
      };
    };
    const viewport = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const within = (inner, outer) =>
      inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const intersects = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const visibility = (node) => {
      let current = node;
      let opacity = 1;
      let visible = true;
      const clipping = [];
      while (current instanceof HTMLElement) {
        const style = getComputedStyle(current);
        opacity *= Number(style.opacity);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
          visible = false;
        if (
          style.overflow !== 'visible' ||
          style.overflowX !== 'visible' ||
          style.overflowY !== 'visible'
        )
          clipping.push(rect(current));
        current = current.parentElement;
      }
      return { visible, opacity, clipping };
    };
    const textLines = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()]
        .filter((line) => line.width > 0 && line.height > 0)
        .map((line) => ({
          left: line.left,
          top: line.top,
          right: line.right,
          bottom: line.bottom,
          width: line.width,
          height: line.height,
        }));
    };
    const describe = (node, accepted) => {
      const own = rect(node);
      const state = visibility(node);
      const lines = textLines(node).map((line) => {
        const inset = Math.min(4, Math.max(1, line.width / 4));
        const points = [
          [line.left + inset, line.top + line.height / 2],
          [line.left + line.width / 2, line.top + line.height / 2],
          [line.right - inset, line.top + line.height / 2],
        ];
        return {
          rect: line,
          contained:
            within(line, rect(preview)) &&
            within(line, stageContent()) &&
            within(line, viewport),
          clippingContained: state.clipping.every((clip) => within(line, clip)),
          hits: points.map(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return {
              x,
              y,
              owned: accepted.some((owner) => owner === hit || owner.contains(hit)),
              tag: hit?.tagName ?? null,
              className: hit instanceof HTMLElement ? hit.className : null,
            };
          }),
        };
      });
      return {
        text: node.textContent?.trim() ?? '',
        visible: state.visible,
        opacity: state.opacity,
        rect: own,
        contained:
          within(own, rect(preview)) &&
          within(own, stageContent()) &&
          within(own, viewport) &&
          state.clipping.every((clip) => within(own, clip)),
        clipping: state.clipping,
        lines,
      };
    };
    const scopeProbe = describe(scope, [scope, scopeText]);
    const scopeTextProbe = describe(scopeText, [scope, scopeText]);
    const diagnosticProbes = diagnostics.map((diagnostic) =>
      describe(diagnostic, [diagnostic])
    );
    const buttonProbe = describe(button, [button]);
    const diagnosticLines = diagnosticProbes.flatMap((diagnostic) => diagnostic.lines);
    const buttonLines = buttonProbe.lines;
    const scopeRect = rect(scope);
    const firstStatusTop = Math.min(
      ...[
        ...diagnosticLines.map((line) => line.rect.top),
        ...buttonLines.map((line) => line.rect.top),
      ]
    );
    const lastDiagnosticBottom = diagnosticLines.length
      ? Math.max(...diagnosticLines.map((line) => line.rect.bottom))
      : null;
    const firstButtonTop = buttonLines.length
      ? Math.min(...buttonLines.map((line) => line.rect.top))
      : null;
    const requiredGap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.65;
    const readoutRect = rect(readout);
    const stageTop = stage.scrollTop;
    const documentX = window.scrollX, documentY = window.scrollY;
    const scrollRange = Math.max(0, status.scrollHeight - status.clientHeight);
    const stable = (a, b) => ['left', 'top', 'right', 'bottom'].every(key => Math.abs(a[key] - b[key]) <= 1);
    const frame = async () => {
      const { promise, resolve } = Promise.withResolvers();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 50);
      await promise;
    };
    const centerInStatus = async (targetRect) => {
      const statusRect = status.getBoundingClientRect();
      const center = statusRect.top + status.clientTop + status.clientHeight / 2;
      status.scrollTop += (targetRect.top + targetRect.bottom) / 2 - center;
      await frame();
    };
    const exposures = [];
    for (const [target, node] of [...diagnostics.map((node, index) => ['diagnostic-' + index, node]), ['consent', button]]) {
      const count = textLines(node).length;
      for (let index = 0; index < count; index++) {
        const current = textLines(node)[index];
        await centerInStatus(current);
        const line = describe(node, [node]).lines[index];
        exposures.push({ target, line, scrollTop: status.scrollTop,
          scopeStable: stable(scopeRect, rect(scope)),
          readoutStable: stable(readoutRect, rect(readout)),
          outerScrollStable: stage.scrollTop === stageTop && window.scrollX === documentX && window.scrollY === documentY });
      }
    }
    await centerInStatus(rect(button));
    const buttonRect = rect(button);
    const hit = document.elementFromPoint((buttonRect.left + buttonRect.right) / 2, (buttonRect.top + buttonRect.bottom) / 2);
    const buttonCenterOwned = (hit === button || button.contains(hit)) &&
      stable(scopeRect, rect(scope)) && stable(readoutRect, rect(readout)) &&
      stage.scrollTop === stageTop && window.scrollX === documentX && window.scrollY === documentY;
    status.scrollTop = originalStatusTop;
    await frame();
    return {
      missing,
      state: {
        ready: root.dataset.ready ?? '',
        previewState: root.dataset.previewState ?? '',
        buffering: root.dataset.buffering ?? '',
        frame: root.dataset.frame ?? '',
      },
      scope: scopeProbe,
      scopeText: scopeTextProbe,
      diagnostics: diagnosticProbes,
      button: buttonProbe,
      scopeDiagnosticIntersections: diagnosticLines.filter((line) =>
        intersects(scopeRect, line.rect)
      ).length,
      scopeButtonIntersections: buttonLines.filter((line) =>
        intersects(scopeRect, line.rect)
      ).length,
      scopeStatusGap: Number.isFinite(firstStatusTop) ? firstStatusTop - scopeRect.bottom : null,
      diagnosticButtonGap:
        lastDiagnosticBottom !== null && firstButtonTop !== null
          ? firstButtonTop - lastDiagnosticBottom
          : null,
      requiredGap,
      exposures,
      buttonCenterOwned,
      scrollRange,
    };
  })()`);
}

async function prepareBlockedPreview(
  browser: ChromeSession,
  effectFrame: number
): Promise<number> {
  const priorFrame = await browser.evaluate<number>(
    `Number(document.querySelector('.otio-view')?.dataset.frame ?? NaN)`
  );
  assert.ok(
    Number.isInteger(priorFrame) && priorFrame >= 0,
    `blocked preview has no restorable playback frame: ${priorFrame}`
  );
  await seekTo(browser, effectFrame);
  const exposed = await exposePreviewBase(browser);
  assertStageControlExposure(exposed, 'blocked preview consent');
  const state = await browser.evaluate<{
    readonly ready: string;
    readonly previewState: string;
    readonly buffering: string;
    readonly frame: number;
  }>(String.raw`(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 50); });
    const root = document.querySelector('.otio-view');
    return {
      ready: root?.dataset.ready ?? '',
      previewState: root?.dataset.previewState ?? '',
      buffering: root?.dataset.buffering ?? '',
      frame: Number(root?.dataset.frame ?? NaN),
    };
  })()`);
  assert.equal(state.ready, 'diagnostic', 'blocked preview is not diagnostic');
  assert.equal(state.previewState, 'blocked', 'preview state is not blocked');
  assert.equal(state.buffering, 'false', 'blocked preview is buffering');
  assert.equal(
    state.frame,
    effectFrame,
    'blocked preview left the effect frame'
  );
  return priorFrame;
}

async function exposeSelectionControl(
  browser: ChromeSession
): Promise<StageControlExposure> {
  return browser.evaluate<StageControlExposure>(String.raw`(async () => {
    const stage = document.querySelector('.stage-wrap');
    const control = document.querySelector('button.otio-comment-selection');
    const missing = [];
    if (!stage) missing.push('.stage-wrap');
    if (!(control instanceof HTMLElement)) missing.push('.otio-comment-selection');
    if (missing.length > 0) return { missing, visible: false, withinStage: false, rect: null };
    stage.scrollTop = stage.scrollHeight;
    await new Promise((resolve) => { requestAnimationFrame(resolve); setTimeout(resolve, 50); });
    const style = getComputedStyle(control);
    const rect = control.getBoundingClientRect();
    const host = stage.getBoundingClientRect();
    const left = host.left + stage.clientLeft;
    const top = host.top + stage.clientTop;
    const content = {
      left,
      top,
      right: left + stage.clientWidth,
      bottom: top + stage.clientHeight,
    };
    return {
      missing,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      withinStage: rect.left >= content.left - 1 && rect.right <= content.right + 1 &&
        rect.top >= content.top - 1 && rect.bottom <= content.bottom + 1,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    };
  })()`);
}

function asRange(value: unknown): TimeRange | null {
  if (!value || typeof value !== 'object') return null;
  const range = value as { start_time?: Rational; duration?: Rational };
  if (!range.start_time || !range.duration) return null;
  return { start_time: range.start_time, duration: range.duration };
}

async function readComments(
  relicId: string
): Promise<Array<Record<string, unknown>>> {
  const read = await callMcp('relic_read_comments', {
    relic_id: relicId,
    version: '*',
    resolve_anchors: true,
  });
  const comments = read['comments'];
  assert.ok(
    Array.isArray(comments),
    'fresh MCP process returned no comments array'
  );
  return comments as Array<Record<string, unknown>>;
}

function commentByBody(
  comments: Array<Record<string, unknown>>,
  body: string
): Record<string, unknown> {
  const found = comments.find((entry) => entry['body'] === body);
  assert.ok(found, `fresh MCP read did not return ${JSON.stringify(body)}`);
  return found;
}

function resolvedOf(comment: Record<string, unknown>): Record<string, unknown> {
  const resolved = comment['resolved'];
  assert.ok(
    resolved && typeof resolved === 'object',
    'MCP comment has no resolved source context'
  );
  return resolved as Record<string, unknown>;
}

interface DecoderClip {
  readonly id: string;
  readonly media: string;
  readonly source: TimeRange;
  readonly available: TimeRange;
}

function decoderTime(value: number, rate: number): Rational {
  return { value, rate };
}

function decoderRange(
  startValue: number,
  startRate: number,
  durationValue: number,
  durationRate = startRate
): TimeRange {
  return {
    start_time: decoderTime(startValue, startRate),
    duration: decoderTime(durationValue, durationRate),
  };
}

function decoderClip(
  id: string,
  media: string,
  source: TimeRange,
  available: TimeRange
): DecoderClip {
  return { id, media, source, available };
}

function otioRational(value: Rational): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    value: value.value,
    rate: value.rate,
  };
}

function otioRange(value: TimeRange): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: otioRational(value.start_time),
    duration: otioRational(value.duration),
  };
}

function decoderDocument(
  name: string,
  clips: readonly DecoderClip[],
  leadingGap?: TimeRange
): string {
  return `${JSON.stringify(
    {
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: `timeline-${name}` } },
      name: `Decoder timing ${name}`,
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: `stack-${name}` } },
        name: 'tracks',
        source_range: null,
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: `track-${name}` } },
            name: 'Packet timing',
            kind: 'Video',
            source_range: null,
            effects: [],
            markers: [],
            enabled: true,
            color: null,
            children: [
              ...(leadingGap === undefined
                ? []
                : [
                    {
                      OTIO_SCHEMA: 'Gap.1',
                      metadata: { relic: { id: `gap-${name}` } },
                      name: 'Timing lead-in',
                      source_range: otioRange(leadingGap),
                      effects: [],
                      markers: [],
                      enabled: true,
                      color: null,
                    },
                  ]),
              ...clips.map((clip) => ({
                OTIO_SCHEMA: 'Clip.2',
                metadata: { relic: { id: clip.id } },
                name: clip.id,
                source_range: otioRange(clip.source),
                effects: [],
                markers: [],
                enabled: true,
                color: null,
                media_references: {
                  DEFAULT_MEDIA: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    metadata: {},
                    name: '',
                    available_range: otioRange(clip.available),
                    available_image_bounds: null,
                    target_url: `media/${clip.media}`,
                  },
                },
                active_media_reference_key: 'DEFAULT_MEDIA',
              })),
            ],
          },
        ],
      },
    },
    null,
    2
  )}\n`;
}

async function publishDecoderDirectory(
  name: string,
  directory: string
): Promise<string> {
  const published = await callMcp('relic_publish', {
    path: directory,
    title: `OTIO timing proof ${name}`,
    cover: false,
  });
  const shareUrl = String(published['url'] ?? published['link'] ?? '');
  assert.ok(shareUrl.includes('#'), `${name} publish returned no keyed URL`);
  assert.ok(
    shareUrl.startsWith(origin),
    `${name} publish URL left loopback: ${shareUrl}`
  );
  return shareUrl;
}

async function publishDecoderDocument(
  name: string,
  document: string
): Promise<string> {
  const directory = join(scratch, `decoder-${name}.otiod`);
  await cp(decoderFixtureDir, directory, { recursive: true });
  await writeFile(join(directory, 'content.otio'), document);
  return publishDecoderDirectory(name, directory);
}

async function publishDecoderCase(
  name: string,
  clips: readonly DecoderClip[],
  leadingGap?: TimeRange
): Promise<string> {
  return publishDecoderDocument(name, decoderDocument(name, clips, leadingGap));
}

function selectedVideoSourceTime(
  name: string,
  documentText: string,
  time: Rational,
  nodeId: string
): Rational {
  const document = readOtioDocument(documentText);
  const result = evaluateOtioAt(document, `timeline-${name}`, time);
  assert.equal(
    result.video_contributions.length,
    1,
    `${name} at ${time.value}@${time.rate} has ${result.video_contributions.length} video contributions`
  );
  const contribution = result.video_contributions.find(
    (candidate) => candidate.node_id === nodeId
  );
  assert.ok(
    contribution,
    `${name} at ${time.value}@${time.rate} did not select ${nodeId}`
  );
  return contribution.source_time;
}

function assertRepresentationalZero(
  name: string,
  documentText: string,
  time: Rational,
  nodeId: string
): void {
  const sourceTime = selectedVideoSourceTime(name, documentText, time, nodeId);
  assert.ok(
    sourceTime.value < 0,
    `${name} source is not representationally negative: ${sourceTime.value}@${sourceTime.rate}`
  );
  assert.ok(
    compareRationalTimes(sourceTime, {
      value: 0,
      rate: sourceTime.rate,
    }) < 0,
    `${name} nonzero source is not strictly negative`
  );
  assert.ok(
    Math.abs(sourceTime.value) < 1e-7,
    `${name} source exceeds the decoder-local zero policy: ${sourceTime.value}@${sourceTime.rate}`
  );
}

function assertSelectedPositiveSource(
  name: string,
  documentText: string,
  time: Rational,
  nodeId: string,
  expected: Rational
): void {
  const sourceTime = selectedVideoSourceTime(name, documentText, time, nodeId);
  assert.ok(
    sourceTime.value > 0,
    `${name} second source is not positive: ${sourceTime.value}@${sourceTime.rate}`
  );
  assert.equal(
    sourceTime.rate,
    expected.rate,
    `${name} source rate ${sourceTime.rate} is not ${expected.rate}`
  );
  assert.equal(
    compareRationalTimes(sourceTime, expected),
    0,
    `${name} source does not match ${expected.value}@${expected.rate}`
  );
}

function assertStrictlyNegativeSource(
  name: string,
  documentText: string,
  time: Rational,
  nodeId: string
): void {
  const sourceTime = selectedVideoSourceTime(name, documentText, time, nodeId);
  assert.ok(
    compareRationalTimes(sourceTime, {
      value: 0,
      rate: sourceTime.rate,
    }) < 0,
    `${name} source is not truly negative: ${sourceTime.value}@${sourceTime.rate}`
  );
}

async function timingDiagnostics(browser: ChromeSession): Promise<string> {
  return browser.evaluate<string>(
    `document.querySelector('.otio-diagnostics')?.textContent ?? ''`
  );
}

async function recordPacketCanvasMeasurement(
  measurement: Record<string, unknown>
): Promise<void> {
  packetCanvasMeasurements.push(measurement);
  await writeFile(
    join(shotDir, 'packet-canvas-measurements.json'),
    `${JSON.stringify({ measurements: packetCanvasMeasurements }, null, 2)}\n`
  );
}

async function assertPacketCanvas(
  browser: ChromeSession,
  label: string,
  fileName: string,
  sourceSeconds: number,
  includeFinal = true
): Promise<PacketWindow> {
  const windows = await packetWindows(fileName, includeFinal);
  const expected = windowForSeconds(windows, sourceSeconds, label);
  const canvas = await sampleCanvas(browser, width, height);
  const correct = await extractFrame(
    join(decoderMediaDir, fileName),
    expected.frame,
    width,
    height
  );
  const neighbor =
    windows.find((window) => window.frame === expected.frame + 1) ??
    windows.find((window) => window.frame === expected.frame - 1);
  assert.ok(neighbor, `${label} needs an adjacent ffprobe presentation frame`);
  const wrong = await extractFrame(
    join(decoderMediaDir, fileName),
    neighbor.frame,
    width,
    height
  );
  const toCorrect = rmse(canvas, correct);
  const toWrong = rmse(canvas, wrong);
  const blackFrame = new Uint8Array(correct.length);
  for (let i = 0; i < blackFrame.length; i += 4) {
    blackFrame[i + 3] = 255;
  }
  const toBlack = rmse(canvas, blackFrame);
  const decoderCount = await browser.evaluate<number>(
    `document.querySelectorAll('.otio-video-decoders video').length`
  );
  await recordPacketCanvasMeasurement({
    label,
    file_name: fileName,
    source_seconds: sourceSeconds,
    expected_frame: expected.frame,
    neighbor_frame: neighbor.frame,
    decoder_count: decoderCount,
    canvas_black: isOpaqueBlack(canvas),
    reference_black: isOpaqueBlack(correct),
    rmse_correct: toCorrect,
    rmse_wrong: toWrong,
    rmse_black: toBlack,
  });
  assert.equal(
    isOpaqueBlack(correct),
    false,
    `${label} reference frame cannot distinguish decoded media from withheld black`
  );
  assert.equal(
    isOpaqueBlack(canvas),
    false,
    `${label} painted opaque black instead of decoded media`
  );
  assert.ok(
    rmse(correct, wrong) > 4,
    `${label} fixture frames ${expected.frame} and ${neighbor.frame} are not distinct`
  );
  assert.ok(
    toCorrect + 2 < toWrong,
    `${label} canvas is not ffprobe frame ${expected.frame} (correct ${toCorrect}, adjacent ${toWrong})`
  );
  assert.equal(
    (await timingDiagnostics(browser)).includes('invalid-timing'),
    false,
    `${label} used a diagnostic fallback instead of a certified packet window`
  );
  return expected;
}

async function assertInvalidTiming(
  browser: ChromeSession,
  label: string,
  reason?: RegExp
): Promise<string> {
  const text = await timingDiagnostics(browser);
  assert.match(text, /invalid-timing/, `${label} hid invalid timing`);
  if (reason) assert.match(text, reason, `${label} lost its timing reason`);
  return text;
}

async function clearMediaSeekTargets(browser: ChromeSession): Promise<void> {
  await browser.evaluate<void>(`(() => {
    globalThis.__relicOtioMediaSeekTargets = [];
    globalThis.__relicOtioVideoSeekTargets = [];
  })()`);
}

async function assertExactMediaTarget(
  browser: ChromeSession,
  expected: number,
  label: string
): Promise<void> {
  const targets = await browser.mediaSeekTargets();
  assert.ok(
    targets.some((target) => Math.abs(target - expected) < 1e-9),
    `${label} did not assign exact source seconds ${expected}: ${targets.join(', ')}`
  );
}

async function runDecoderTimingProof(sessionToken: string): Promise<void> {
  const knownUrl = await publishDecoderDirectory('known', decoderFixtureDir);
  const knownBrowser = await openBrowser(knownUrl, sessionToken, {
    blockWebCodecs: true,
    label: 'decoder-known',
  });
  try {
    assert.equal(
      await waitReady(knownBrowser),
      'true',
      'known packet-window fixture did not reach decoded ready state'
    );
    await knownBrowser.waitForWorkerHooks();
    const csp = knownBrowser.cspHeaders.find(
      (value) =>
        value.includes("default-src 'none'") &&
        value.includes("script-src 'self'") &&
        value.includes("media-src 'self' blob: data:")
    );
    assert.ok(csp, 'production viewer did not run under its real CSP');
    assert.deepEqual(
      knownBrowser.blocked,
      [],
      `decoder proof attempted non-loopback media: ${knownBrowser.blocked.join(', ')}`
    );
    assert.deepEqual(
      knownBrowser.continuedNonLoopback,
      [],
      `decoder proof continued non-loopback media: ${knownBrowser.continuedNonLoopback.join(', ')}`
    );
    assert.ok(
      knownBrowser.workerUrls.some((url) =>
        url.includes('/assets/otio-video-timing-worker.js')
      ),
      `production timing worker did not load: ${knownBrowser.workerUrls.join(', ')}`
    );
    pass('decoder-worker-csp');

    for (const item of [
      {
        label: '24fps MP4',
        frame: 4,
        file: 'fr24.mp4',
        seconds: 4 / 24,
      },
      {
        label: '60fps MP4 with 24-rate source',
        frame: 52,
        file: 'fr60.mp4',
        seconds: 4 / 24,
      },
      {
        label: 'rate-one source',
        frame: 100,
        file: 'fr24.mp4',
        seconds: 1 / 6,
      },
      {
        label: '29.97-rate source',
        frame: 148,
        file: 'fr24.mp4',
        seconds: 1 / 6,
      },
      {
        label: 'B-frame MP4',
        frame: 196,
        file: 'fr24b.mp4',
        seconds: 4 / 24,
      },
      {
        label: 'B-frame MOV',
        frame: 244,
        file: 'fr24b.mov',
        seconds: 4 / 24,
      },
      {
        label: 'VFR MP4',
        frame: 291,
        file: 'vfr.mp4',
        seconds: 3 / 24,
      },
    ] as const) {
      await seekTo(knownBrowser, item.frame);
      await assertPacketCanvas(
        knownBrowser,
        item.label,
        item.file,
        item.seconds
      );
    }
    pass('decoder-timing-windows');
  } finally {
    await knownBrowser.close();
  }

  const webmUrl = await publishDecoderCase('quantized-webm', [
    decoderClip(
      'quantized-webm',
      'fr30.webm',
      decoderRange(0, 30, 90),
      decoderRange(0, 30, 90)
    ),
  ]);
  const webmBrowser = await openBrowser(webmUrl, sessionToken, {
    recordMediaSeekTargets: true,
    label: 'decoder-webm',
  });
  try {
    assert.equal(await waitReady(webmBrowser), 'true');
    const webmWindows = await packetWindows('fr30.webm', false);
    assert.deepEqual(
      webmWindows.slice(0, 3).map((window) => Number(window.start.toFixed(3))),
      [0, 0.033, 0.067],
      'quantized WebM ffprobe PTS changed'
    );
    await clearMediaSeekTargets(webmBrowser);
    await seekTo(webmBrowser, 2);
    const selected = await assertPacketCanvas(
      webmBrowser,
      'quantized WebM 2/30',
      'fr30.webm',
      2 / 30,
      false
    );
    assert.equal(
      selected.frame,
      1,
      '2/30 must remain inside the actual [0.033, 0.067) WebM window'
    );
    await assertExactMediaTarget(
      webmBrowser,
      (33 + 67) / 2000,
      'quantized WebM 2/30'
    );
    pass('decoder-webm-quantization');
  } finally {
    await webmBrowser.close();
  }

  const r2398 = 24000 / 1001;
  const r2997 = 30000 / 1001;
  const nearZeroDocument = decoderDocument('near-zero', [
    decoderClip(
      'near-zero',
      'fr24.mp4',
      decoderRange(4, r2398, 48, 24),
      decoderRange(5, r2997, 48, 24)
    ),
  ]);
  assertRepresentationalZero(
    'near-zero',
    nearZeroDocument,
    { value: 0, rate: 24 },
    'near-zero'
  );
  const nearZeroUrl = await publishDecoderDocument(
    'near-zero',
    nearZeroDocument
  );
  const nearZeroBrowser = await openBrowser(nearZeroUrl, sessionToken, {
    label: 'near-zero-control',
  });
  try {
    const nearZeroReady = await waitReady(nearZeroBrowser);
    assert.equal(
      nearZeroReady,
      'true',
      nearZeroReady === 'true'
        ? ''
        : JSON.stringify(
            await nearZeroBrowser.evaluate(`(() => {
              const root = document.querySelector('.otio-view');
              const videos = Array.from(document.querySelectorAll('.otio-video-decoders video'));
              return {
                ready: root?.dataset.ready,
                previewState: root?.dataset.previewState,
                previewBlocked: root?.dataset.previewBlocked,
                diagnostics: Array.from(document.querySelectorAll('.otio-diagnostics'), element => element.textContent),
                nativeVideoCount: videos.length,
                videos: videos.map(video => ({
                  currentTime: video.currentTime,
                  readyState: video.readyState,
                  error: video.error ? { code: video.error.code, message: video.error.message } : null,
                })),
              };
            })()`)
          )
    );
    await seekTo(nearZeroBrowser, 0);
    const first = await assertPacketCanvas(
      nearZeroBrowser,
      'representational zero first frame',
      'fr24.mp4',
      0
    );
    assert.equal(first.frame, 0);
    const nearZeroDecoderCount = await nearZeroBrowser.evaluate<number>(
      `document.querySelectorAll('.otio-video-decoders video').length`
    );
    assert.ok(
      nearZeroDecoderCount > 0,
      'representational zero first frame created no native video decoder'
    );
    assert.equal(
      (await timingDiagnostics(nearZeroBrowser)).includes('missing-handles'),
      false,
      'representational zero was withheld as missing handles'
    );
  } finally {
    await nearZeroBrowser.close();
  }

  const strictNegativeDocument = decoderDocument('strict-negative', [
    decoderClip(
      'strict-negative',
      'fr24.mp4',
      decoderRange(3, r2398, 48, 24),
      decoderRange(5, r2997, 48, 24)
    ),
  ]);
  assertStrictlyNegativeSource(
    'strict-negative',
    strictNegativeDocument,
    { value: 0, rate: 24 },
    'strict-negative'
  );
  const strictNegativeUrl = await publishDecoderDocument(
    'strict-negative',
    strictNegativeDocument
  );
  const strictNegativeBrowser = await openBrowser(
    strictNegativeUrl,
    sessionToken,
    { label: 'strict-negative' }
  );
  try {
    assert.equal(await waitReady(strictNegativeBrowser), 'diagnostic');
    await seekTo(strictNegativeBrowser, 0);
    assert.match(
      await timingDiagnostics(strictNegativeBrowser),
      /missing-handles/,
      'truly negative source time was decoded instead of withheld'
    );
    assert.equal(
      isOpaqueBlack(await sampleCanvas(strictNegativeBrowser, width, height)),
      true,
      `truly negative source time painted media (${formatAlphaCensus()})`
    );
  } finally {
    await strictNegativeBrowser.close();
  }

  const availableOriginCutDocument = decoderDocument(
    'available-origin-cut',
    [
      decoderClip(
        'cut-c',
        'fr30.webm',
        decoderRange(56, 30, 60),
        decoderRange(56.00000000000001, 30, 60)
      ),
    ],
    decoderRange(0, 30, 56)
  );
  assertRepresentationalZero(
    'available-origin-cut',
    availableOriginCutDocument,
    { value: 56, rate: 30 },
    'cut-c'
  );
  // Nominal second frame: availability is exactly 56 + 2^-47 (one ulp above
  // 56), so the unnormalized raw source at 57@30 is exactly 1 - 2^-47.
  assertSelectedPositiveSource(
    'available-origin-cut',
    availableOriginCutDocument,
    { value: 57, rate: 30 },
    'cut-c',
    { value: 1 - 2 ** -47, rate: 30 }
  );
  const availableOriginCutUrl = await publishDecoderDocument(
    'available-origin-cut',
    availableOriginCutDocument
  );
  const availableOriginCutBrowser = await openBrowser(
    availableOriginCutUrl,
    sessionToken,
    { label: 'available-origin-cut' }
  );
  try {
    assert.equal(await waitReady(availableOriginCutBrowser), 'true');
    await seekTo(availableOriginCutBrowser, 55);
    assert.equal(
      isOpaqueBlack(
        await sampleCanvas(availableOriginCutBrowser, width, height)
      ),
      true,
      `available-origin/cut witness has media before cut-c (${formatAlphaCensus()})`
    );
    await seekTo(availableOriginCutBrowser, 56);
    assert.equal(
      (
        await assertPacketCanvas(
          availableOriginCutBrowser,
          'available-origin/cut witness first frame',
          'fr30.webm',
          0,
          false
        )
      ).frame,
      0
    );
    await seekTo(availableOriginCutBrowser, 57);
    assert.equal(
      (
        await assertPacketCanvas(
          availableOriginCutBrowser,
          'available-origin/cut witness second frame',
          'fr30.webm',
          1 / 30,
          false
        )
      ).frame,
      1
    );
    pass('decoder-near-zero');
  } finally {
    await availableOriginCutBrowser.close();
  }

  const editUrl = await publishDecoderCase('unsupported-edits', [
    decoderClip(
      'short-edit',
      'short-edit.mp4',
      decoderRange(0, 24, 48),
      decoderRange(0, 24, 48)
    ),
    decoderClip(
      'rate-edit',
      'rate-edit.mp4',
      decoderRange(0, 24, 48),
      decoderRange(0, 24, 48)
    ),
    decoderClip(
      'loop-edit',
      'loop-edit.mp4',
      decoderRange(0, 24, 48),
      decoderRange(0, 24, 48)
    ),
  ]);
  const editBrowser = await openBrowser(editUrl, sessionToken, {
    recordMediaSeekTargets: true,
    label: 'decoder-edit',
  });
  try {
    assert.equal(await waitReady(editBrowser), 'diagnostic');
    await clearMediaSeekTargets(editBrowser);
    await seekTo(editBrowser, 30);
    await assertInvalidTiming(
      editBrowser,
      'shortened rate-one edit',
      /edit-window-mismatch/
    );
    await assertExactMediaTarget(editBrowser, 30 / 24, 'shortened edit');
    for (const item of [
      { label: 'rate-two edit', frame: 48 },
      { label: 'multi-edit list', frame: 96 },
    ]) {
      await seekTo(editBrowser, item.frame);
      await assertInvalidTiming(
        editBrowser,
        item.label,
        /unsupported-edit-list|demux-warning/
      );
    }
    pass('decoder-edit-diagnostics');
  } finally {
    await editBrowser.close();
  }

  const noDurationUrl = await publishDecoderCase('no-duration', [
    decoderClip(
      'no-duration',
      'no-duration.webm',
      decoderRange(0, 1000, 3000),
      decoderRange(0, 1000, 3000)
    ),
  ]);
  const noDurationBrowser = await openBrowser(noDurationUrl, sessionToken, {
    recordMediaSeekTargets: true,
    label: 'decoder-no-duration',
  });
  try {
    assert.equal(await waitReady(noDurationBrowser), 'true');
    await seekTo(noDurationBrowser, 65);
    assert.equal(
      (
        await assertPacketCanvas(
          noDurationBrowser,
          'no-DefaultDuration earlier window',
          'no-duration.webm',
          65 / 1000,
          false
        )
      ).frame,
      1
    );
    const finalSeconds = await finalPacketStartSeconds('no-duration.webm');
    const finalFrame = Math.round(finalSeconds * 1000);
    assert.ok(
      Math.abs(finalFrame / 1000 - finalSeconds) < 1e-9,
      `final no-duration PTS ${finalSeconds} cannot be addressed exactly`
    );
    await clearMediaSeekTargets(noDurationBrowser);
    await seekTo(noDurationBrowser, finalFrame);
    await assertInvalidTiming(
      noDurationBrowser,
      'no-DefaultDuration final tail'
    );
    await assertExactMediaTarget(
      noDurationBrowser,
      finalSeconds,
      'no-DefaultDuration final tail'
    );
    pass('decoder-no-duration');
  } finally {
    await noDurationBrowser.close();
  }
}

class LayoutOnlyComplete extends Error {}
async function probeMobileInspector(
  browser: ChromeSession
): Promise<Record<string, unknown> & { failures: string[] }> {
  return browser.evaluate(String.raw`(async () => {
    const failures = [];
    const root = document.querySelector('.otio-view');
    const inspector = document.querySelector('.otio-inspector');
    const tabs = document.querySelector('.otio-inspector-tabs');
    const context = document.querySelector('.otio-context');
    const close = document.querySelector('.otio-inspector-close');
    const toggle = document.querySelector('.otio-inspector-toggle');
    const readout = document.querySelector('.otio-selection-readout');
    if (![root, inspector, tabs, context, toggle, readout].every(Boolean))
      return { failures: ['missing inspector disclosure control'] };
    if (!close) failures.push('missing inspector close');
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const contained = (r, bounds) => r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1;
    const hits = {};
    const controls = [...tabs.querySelectorAll('[role=tab]'), ...(close ? [close] : [])];
    for (const node of controls) {
      const r = rect(node);
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const owned = hit === node || node.contains(hit);
      hits[node.dataset.tab || 'close'] = { rect: r, owned };
      if (!owned || !r.width || !r.height) failures.push('obscured inspector ' + (node.dataset.tab || 'close'));
    }
    if (controls.length !== 4) failures.push('expected three tabs and close');
    const inspectorRect = rect(inspector), rootRect = rect(root), readoutBefore = rect(readout);
    const closeRect = close ? rect(close) : null;
    if (!contained(inspectorRect, rootRect) || inspectorRect.bottom > readoutBefore.top + 1)
      failures.push('inspector outside root or over readout');
    const inspectorTab = tabs.querySelector('[data-tab=inspector]');
    const markersTab = tabs.querySelector('[data-tab=markers]');
    const mediaTab = tabs.querySelector('[data-tab=media]');
    if (!inspectorTab || !markersTab || !mediaTab)
      return { failures: [...failures, 'missing inspector tabs'], hits };
    inspectorTab.click();
    context.scrollTop = 0;
    const style = getComputedStyle(context);
    const usableHeight = context.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (usableHeight < 128) failures.push('readable context height ' + usableHeight + ' < 128');
    const contentBounds = rect(context);
    const heading = context.querySelector('h3');
    const schema = context.querySelector('.otio-schema');
    const body = context.querySelector('dl dt, dl dd');
    const firstLine = (node, last = false) => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = range.getClientRects();
      const line = lines[last ? lines.length - 1 : 0];
      return line ? { left: line.left, right: line.right, top: line.top, bottom: line.bottom } : null;
    };
    const headingRect = heading ? rect(heading) : null;
    const schemaRect = schema ? rect(schema) : null;
    const bodyLine = firstLine(body);
    if (!headingRect || !schemaRect || !bodyLine || !contained(headingRect, contentBounds) || !contained(schemaRect, contentBounds) || !contained(bodyLine, contentBounds))
      failures.push('inspector heading, schema, and first body line are not fully visible');
    markersTab.click();
    if (markersTab.getAttribute('aria-selected') !== 'true') failures.push('markers tab did not select');
    mediaTab.click();
    if (mediaTab.getAttribute('aria-selected') !== 'true') failures.push('media tab did not select');
    context.scrollTop = 0;
    const mediaBefore = context.scrollTop;
    const mediaScrollHeight = context.scrollHeight;
    const mediaClientHeight = context.clientHeight;
    context.scrollTop = context.scrollHeight;
    const { promise, resolve } = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    await promise;
    const mediaAfter = context.scrollTop;
    const lastEntry = [...context.querySelectorAll('.otio-media-reference')].at(-1);
    const trailing = lastEntry?.querySelector('span:last-of-type');
    const trailingLine = firstLine(trailing, true);
    if (mediaScrollHeight > mediaClientHeight + 1) {
      if (mediaAfter <= mediaBefore) failures.push('media context did not scroll');
      if (!trailingLine || !contained(trailingLine, rect(context))) failures.push('last media entry trailing text not exposed');
    }
    const readoutAfter = rect(readout);
    for (const edge of ['left', 'top', 'right', 'bottom'])
      if (Math.abs(readoutAfter[edge] - readoutBefore[edge]) > 1) failures.push('readout moved during inspector scroll');
    const tabsRect = rect(tabs), contextRect = rect(context);
    close?.click();
    const collapsed = toggle.getAttribute('aria-expanded') === 'false';
    const focusRestored = document.activeElement === toggle;
    if (!collapsed || !focusRestored) failures.push('close did not collapse and restore toggle focus');
    return { failures, inspectorRect, rootRect, tabs: tabsRect, context: contextRect,
      close: closeRect, usableHeight, headingRect, schemaRect, bodyLine, hits,
      media: { before: mediaBefore, after: mediaAfter, scrollHeight: mediaScrollHeight,
        clientHeight: mediaClientHeight, trailingLine }, readoutBefore, readoutAfter,
      collapsed, focusRestored };
  })()`);
}

async function runLayoutMatrix(
  browser: ChromeSession,
  state = 'initial',
  plan?: Plan
): Promise<void> {
  const receipts: Array<Record<string, unknown>> = [];
  const layoutFailures: string[] = [];
  const reviewStateExpression = `(() => {
    const root = document.querySelector('.otio-view');
    const timeline = document.querySelector('.otio-timeline-scroll');
    return { frame: root.dataset.frame, playing: root.dataset.playing,
      track: document.querySelector('.otio-track-select').value,
      input: document.querySelector('.otio-selection-in').value,
      output: document.querySelector('.otio-selection-out').value,
      scrollTop: timeline.scrollTop, scrollLeft: timeline.scrollLeft };
  })()`;
  for (const [width, height] of [
    [1440, 900],
    [1440, 600],
    [390, 900],
    [390, 568],
    [320, 900],
    [320, 480],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      let closedGeometry: Record<string, DomRectProbe> | undefined;
      for (const inspectorOpen of width < 600 ? [false, true] : [false]) {
        const beforeReview = inspectorOpen
          ? await browser.evaluate<Record<string, unknown>>(
              reviewStateExpression
            )
          : undefined;
        await browser.evaluate<void>(`(async () => {
          const toggle = document.querySelector('.otio-inspector-toggle');
          if (toggle && (toggle.getAttribute('aria-expanded') === 'true') !== ${inspectorOpen}) toggle.click();
          const { promise, resolve } = Promise.withResolvers();
          requestAnimationFrame(() => requestAnimationFrame(resolve));
          await promise;
        })()`);
        const probe = await browser.evaluate<
          { failures: string[] } & Record<string, unknown>
        >(String.raw`(() => {
          const selectors = {
            stage: '.stage-wrap', root: '.otio-view', monitor: '.otio-monitor-row',
            transport: '.otio-transport', heading: '.otio-timeline-heading',
            timeline: '.otio-timeline-scroll', readout: '.otio-selection-readout',
            diagnostics: '.otio-diagnostics', preview: '.otio-preview', canvas: '.otio-canvas',
            inspector: '.otio-inspector', tabs: '.otio-inspector-tabs', context: '.otio-context',
          };
          const nodes = Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)]));
          const failures = [];
          for (const [key, node] of Object.entries(nodes)) if (!node) failures.push('missing ' + key);
          if (innerWidth !== ${width} || innerHeight !== ${height}) failures.push('viewport mismatch');
          const toggle = document.querySelector('.otio-inspector-toggle');
          if (${width < 600} && (toggle?.getAttribute('aria-expanded') === 'true') !== ${inspectorOpen}) failures.push('inspector state mismatch');
          if (failures.length) return { failures, viewport: [innerWidth, innerHeight] };
          const rect = node => {
            const r = node.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          };
          const rectangles = Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, rect(node)]));
          const { stage, root, monitor, transport, heading, timeline, readout, diagnostics, preview, canvas } = rectangles;
          const stageBottom = stage.top + nodes.stage.clientTop + nodes.stage.clientHeight;
          const near = (a, b, name) => { if (Math.abs(a - b) > 2) failures.push(name + ': ' + a + ' vs ' + b); };
          near(root.bottom, stageBottom, 'bottom fill');
          const diagnosticsVisible = nodes.diagnostics.children.length > 0 && diagnostics.height > 0;
          near(diagnosticsVisible ? diagnostics.bottom : readout.bottom, root.bottom, 'bottom stack');
          near(monitor.bottom, transport.top, 'monitor/transport adjacency');
          near(transport.bottom, heading.top, 'transport/heading adjacency');
          if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1) failures.push('document overflow');
          if (nodes.stage.scrollHeight > nodes.stage.clientHeight + 2) failures.push('stage vertical overflow');
          if (preview.width <= 0 || preview.height <= 0 || canvas.width <= 0 || canvas.height <= 0) failures.push('empty preview');
          if (canvas.left < preview.left - 2 || canvas.right > preview.right + 2 || canvas.top < preview.top - 2 || canvas.bottom > preview.bottom + 2) failures.push('canvas outside preview');
          const canvasStyle = getComputedStyle(nodes.canvas);
          if (canvasStyle.objectFit !== 'contain' && Math.abs(canvas.width / canvas.height - nodes.canvas.width / nodes.canvas.height) > 0.02) failures.push('preview aspect ratio');
          if (timeline.height > Math.min(240, root.height * 0.3) + 2) failures.push('timeline exceeds compact budget');
          const controls = {};
          for (const selector of ['.otio-selection-in', '.otio-selection-out', '.otio-comment-selection', '.otio-clear-selection']) {
            const node = document.querySelector(selector);
            if (!node) { failures.push('missing ' + selector); continue; }
            const r = rect(node), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
            const hit = document.elementFromPoint(x, y);
            controls[selector] = { rect: r, hit: hit?.tagName, owned: node === hit || node.contains(hit) };
            if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || !(node === hit || node.contains(hit))) failures.push('obscured ' + selector);
          }
          const scroll = Object.fromEntries(['stage', 'timeline', 'inspector'].map(key => {
            const node = nodes[key];
            return [key, { top: node.scrollTop, left: node.scrollLeft, height: node.scrollHeight, clientHeight: node.clientHeight, width: node.scrollWidth, clientWidth: node.clientWidth }];
          }));
          return { failures, viewport: [innerWidth, innerHeight], rectangles, scroll, controls, diagnosticsVisible, canvasStyle: { objectFit: canvasStyle.objectFit, intrinsic: [nodes.canvas.width, nodes.canvas.height] } };
        })()`);
        const name = `layout-${state}-${width}x${height}-${scheme}-${inspectorOpen ? 'inspector-open' : 'inspector-closed'}`;
        await browser.screenshot(name);
        const geometry = probe.rectangles as
          | Record<string, DomRectProbe>
          | undefined;
        if (!inspectorOpen) closedGeometry = geometry;
        let inspectorInteraction: Record<string, unknown> | undefined;
        if (inspectorOpen) {
          for (const key of ['preview', 'canvas']) {
            const before = closedGeometry?.[key],
              after = geometry?.[key];
            if (!before || !after) {
              probe.failures.push(`missing ${key} before/after inspector`);
              continue;
            }
            for (const edge of ['left', 'top', 'right', 'bottom'] as const)
              if (Math.abs(before[edge] - after[edge]) > 2)
                probe.failures.push(`inspector changed ${key} ${edge}`);
          }
          const interaction = await probeMobileInspector(browser);
          const afterReview = await browser.evaluate<Record<string, unknown>>(
            reviewStateExpression
          );
          inspectorInteraction = { ...interaction, beforeReview, afterReview };
          if (JSON.stringify(beforeReview) !== JSON.stringify(afterReview))
            probe.failures.push('inspector open/close changed review state');
          probe.failures.push(...interaction.failures);
        }
        receipts.push({
          name,
          requestedViewport: [width, height],
          scheme,
          inspectorOpen,
          inspectorInteraction,
          ...probe,
        });
        await writeFile(
          join(shotDir, `otio-layout-${state}-measurements.json`),
          `${JSON.stringify(receipts, null, 2)}\n`
        );
        if (probe.failures.length)
          layoutFailures.push(`${name}: ${probe.failures.join('; ')}`);
        if (
          state === 'initial' &&
          width === 390 &&
          height === 568 &&
          scheme === 'light' &&
          inspectorOpen &&
          layoutFailures.length === 0
        ) {
          assert.ok(
            plan,
            'inspector Comment proof requires the published fixture plan'
          );
          await selectTrack(
            browser,
            plan.duplicate_track_id,
            'range',
            plan.duplicate_frame,
            plan.duplicate_frame + 2
          );
          const before = await browser.evaluate<{
            frame: string | null;
            scrollTop: number;
            scrollLeft: number;
            input: string;
            output: string;
            x: number;
            y: number;
          }>(`(() => {
            const root = document.querySelector('.otio-view');
            const timeline = document.querySelector('.otio-timeline-scroll');
            const toggle = document.querySelector('.otio-inspector-toggle');
            toggle.click();
            const button = document.querySelector('.otio-comment-selection');
            const r = button.getBoundingClientRect();
            return { frame: root.dataset.frame ?? null, scrollTop: timeline.scrollTop, scrollLeft: timeline.scrollLeft,
              input: document.querySelector('.otio-selection-in').value,
              output: document.querySelector('.otio-selection-out').value,
              x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
          })()`);
          await clickWithRealPointer(browser, before.x, before.y);
          const result = await browser.evaluate<{
            open: boolean;
            collapsed: boolean;
            frame: string | null;
            scrollTop: number;
            scrollLeft: number;
            input: string;
            output: string;
          }>(`(async () => {
            const started = Date.now();
            while (!document.querySelector('.popover-card.is-otio-composer textarea.popover-field') && Date.now() - started < 4000) {
              const { promise, resolve } = Promise.withResolvers();
              setTimeout(resolve, 50);
              await promise;
            }
            const timeline = document.querySelector('.otio-timeline-scroll');
            return { open: !!document.querySelector('.popover-card.is-otio-composer textarea.popover-field'),
              collapsed: document.querySelector('.otio-inspector-toggle').getAttribute('aria-expanded') === 'false',
              frame: document.querySelector('.otio-view').dataset.frame ?? null,
              scrollTop: timeline.scrollTop, scrollLeft: timeline.scrollLeft,
              input: document.querySelector('.otio-selection-in').value,
              output: document.querySelector('.otio-selection-out').value };
          })()`);
          assert.ok(
            result.open && result.collapsed,
            `inspector Comment did not open composer and close inspector: ${JSON.stringify(result)}`
          );
          assert.equal(
            result.frame,
            before.frame,
            'inspector Comment changed playback position'
          );
          assert.equal(
            result.input,
            before.input,
            'inspector Comment changed selection in'
          );
          assert.equal(
            result.output,
            before.output,
            'inspector Comment changed selection out'
          );
          const composer = await measureComposer(browser);
          await browser.screenshot('layout-mobile-inspector-comment-composer');
          assertComposerProbe(
            composer,
            'mobile inspector Comment composer',
            false
          );
          receipts.push({
            state: 'inspector-comment',
            before,
            result,
            composer,
          });
          await writeFile(
            join(shotDir, `otio-layout-${state}-measurements.json`),
            `${JSON.stringify(receipts, null, 2)}\n`
          );
          await dismissComposer(browser);
        }
      }
    }
  }
  assert.deepEqual(
    layoutFailures,
    [],
    `OTIO layout failures: ${layoutFailures.join('\n')}`
  );
  await browser.evaluate<void>(`(() => {
    const toggle = document.querySelector('.otio-inspector-toggle');
    if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click();
  })()`);
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
}

try {
  await Bun.spawn(['mkdir', '-p', shotDir, mediaDir]).exited;
  const sessionToken = await createSession();

  const published = await callMcp('relic_publish', {
    path: fixtureDir,
    title: 'Relik Feature Editorial',
    cover: false,
  });
  const relicId = String(published['relic_id']);
  const shareUrl = String(published['url'] ?? published['link'] ?? '');
  assert.ok(relicId, 'publish returned no relic_id');
  assert.ok(shareUrl.includes('#'), 'publish returned no keyed link');
  assert.ok(
    shareUrl.startsWith(origin),
    `publish URL left loopback: ${shareUrl}`
  );
  console.log(`PUBLISHED relic_id=${relicId}`);
  pass('published');

  const stored = await storage.read(relicId);
  assert.ok(stored, 'nothing stored for the published relic');
  process.env['RELIC_PUBLISH_STATE'] = statePath;
  const localState = await loadPublishState(relicId);
  assert.ok(localState, 'local publish state missing');
  const key = decodeKey(localState.key);
  const opened = await openRelic(stored, key);
  const archivePath = join(scratch, 'published.otioz');
  await writeFile(archivePath, opened.content);
  const storedText = Buffer.from(stored).toString('latin1');
  assert.equal(
    storedText.includes('media/primary_a.mp4'),
    false,
    'relic ciphertext contains a source path'
  );
  assert.equal(
    storedText.includes('track-v1-main'),
    false,
    'relic ciphertext contains a track id'
  );
  pass('decrypted');

  const plan = JSON.parse(
    await oracle(['derive', archivePath, mediaDir])
  ) as Plan;
  assert.equal(plan.timeline_name, 'Relik Feature Editorial');
  assert.equal(plan.nested_inside, true);
  assert.equal(plan.nested_frame, 200);
  assert.notEqual(plan.duplicate_track_id, plan.duplicate_other_track_id);
  const scopedDocument = readOtioDocument(
    (await indexOtioZip(opened.content)).contentOtioBytes
  );
  const duplicateScope =
    scopedDocument.nodes[plan.duplicate_track_id]?.timeline_range;
  assert.ok(
    duplicateScope,
    'original duplicate track has no exposed core range'
  );
  assert.ok(
    plan.dissolve_spans.length >= 2,
    'official reader did not see both dissolve sources'
  );
  assert.ok(
    plan.audio.length >= 2,
    'official reader did not see simultaneous audio'
  );
  console.log(
    `OFFICIAL nested=${plan.nested_image_url} dissolve=${plan.dissolve_frame} audio=${plan.audio_frame}`
  );
  pass('official-archive');

  const wholeTrackBody = 'Duplicate Video 2 whole-track note, stable id.';
  const pointerBody =
    'Pointer re-aim retains this draft on the selected range.';
  const cancelledText = 'CANCEL SENTINEL never reaches storage';
  const editedDupRangeBody = 'Duplicate Video 2 edit stays on the same range.';
  const replyBody = 'Reply to the duplicate Video 2 range.';
  let reaimed: HeldComposerProbe | undefined;
  const browser = await openBrowser(shareUrl, sessionToken, {
    label: 'qualification',
    recordMediaSeekTargets: true,
    blockRequestVideoFrameCallback: Boolean(
      process.env.RELIC_OTIO_BLOCK_RVFC === '1'
    ),
  });
  try {
    await waitReady(browser);
    await runLayoutMatrix(browser, 'initial', plan);
    if (process.env.RELIC_OTIO_LAYOUT_ONLY === '1') {
      console.log('OTIO_LAYOUT_OK');
      throw new LayoutOnlyComplete();
    }
    const who = await browser.evaluate<{ email: string | null }>(
      `fetch('/api/auth/session', { credentials: 'same-origin' }).then((response) => response.json())`
    );
    assert.equal(
      who.email,
      'reader@example.test',
      'verified session cookie did not reach the composer'
    );

    const probe = await browser.evaluate<string>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const timer = setTimeout(() => resolve('timeout'), 4000);
      fetch('https://example.com/otio-path-probe', { mode: 'no-cors' }).then(() => {
        clearTimeout(timer);
        resolve('continued');
      }, () => {
        clearTimeout(timer);
        resolve('blocked');
      });
      return promise;
    })()`);
    assert.notEqual(
      probe,
      'continued',
      'headless Chrome continued a non-loopback request'
    );
    assert.equal(
      browser.continuedNonLoopback.length,
      0,
      `continued non-loopback: ${browser.continuedNonLoopback.join(',')}`
    );
    pass('network-block');

    assert.equal(
      plan.source_pixel_probes.length,
      3,
      'official reader did not derive three source-pixel probes'
    );
    for (const [index, sourceProbe] of plan.source_pixel_probes.entries()) {
      assert.equal(
        sourceProbe.timeline_frame,
        plan.primary_frame + index - 1,
        'official source-pixel probes are not consecutive timeline frames'
      );
      await seekTo(browser, sourceProbe.timeline_frame);
      const sourceRight = await extractFrame(
        join(mediaDir, sourceProbe.media),
        sourceProbe.file_frame,
        width,
        height
      );
      const sourceWrong = await extractFrame(
        join(mediaDir, sourceProbe.media),
        sourceProbe.wrong_file_frame,
        width,
        height
      );
      const rightBar = barColumn(sourceRight, width, height);
      const wrongBar = barColumn(sourceWrong, width, height);
      assert.ok(
        Math.abs(rightBar - wrongBar) >= 4,
        `fixture frames are not distinct enough to prove source offset at timeline frame ${sourceProbe.timeline_frame}`
      );
      const rightRow = await frameRowCenter(
        join(mediaDir, sourceProbe.media),
        sourceProbe.file_frame
      );
      const wrongRow = await frameRowCenter(
        join(mediaDir, sourceProbe.media),
        sourceProbe.wrong_file_frame
      );
      const canvasCenter = await canvasRowCenter(browser);
      const toRightPx =
        Math.abs(canvasCenter - rightRow.center) * rightRow.width;
      const toWrongPx =
        Math.abs(canvasCenter - wrongRow.center) * wrongRow.width;
      assert.ok(
        toRightPx <= 3,
        `canvas bar is ${toRightPx.toFixed(2)} source px from file frame ${sourceProbe.file_frame} at timeline frame ${sourceProbe.timeline_frame}`
      );
      assert.ok(
        toWrongPx >= 12,
        `canvas bar is ${toWrongPx.toFixed(2)} source px from wrong file frame ${sourceProbe.wrong_file_frame} at timeline frame ${sourceProbe.timeline_frame}`
      );
    }
    pass('pixels-offset');

    await seekTo(browser, 0);
    await clearMediaSeekTargets(browser);

    await browser.evaluate<void>(`(() => {
      globalThis.__otioObservedFrames = [];
      const root = document.querySelector('section.otio-view');
      if (root?.dataset?.frame != null) {
        globalThis.__otioObservedFrames.push(Number(root.dataset.frame));
      }
      const observer = new MutationObserver(() => {
        const view = document.querySelector('section.otio-view');
        if (view?.dataset?.frame != null) {
          globalThis.__otioObservedFrames.push(Number(view.dataset.frame));
        }
      });
      if (root) {
        observer.observe(root, { attributes: true, attributeFilter: ['data-frame'] });
      }
      globalThis.__otioFrameObserver = observer;
    })()`);

    // A label capture reads the first painted label at or past each target, so
    // a sample can land up to one label step past it. Linux CI measured the
    // largest step at 3.6 frames over 12 runs of this stage. The last target
    // stays at or below 44.999 minus twice that step, so a sample cannot cross
    // the frame-44 ceiling (the overlay ends at frame 48) on an ordinary step.
    await installLabelCapture(browser, width, height, {
      kind: 'targets',
      targets: [3, 8, 13, 18, 22, 27, 32, 37],
    });

    const playbackStarted = await browser.evaluate<boolean>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const btn = document.querySelector('button.otio-play');
      const root = document.querySelector('section.otio-view');
      if (!btn || !root) { resolve(false); return promise; }
      if (root.dataset.playing === 'true') { resolve(true); return promise; }
      btn.click();
      const start = Date.now();
      const check = () => {
        if (root.dataset.playing === 'true') resolve(true);
        else if (Date.now() - start > 4000) resolve(false);
        else setTimeout(check, 25);
      };
      check();
      return promise;
    })()`);
    assert.ok(playbackStarted, 'steady playback did not enter playing state');

    // Samples are captured in-page via MutationObserver when the clock first
    // reaches each target frame, all at or before frame 44. The Picture-in-Picture
    // layer ends at frame 48, where the drawn set changes and the exact resync
    // paints before the clock label updates.
    await waitLabelCaptures(browser, {
      count: 8,
      ceiling: 45,
      timeoutMs: 30_000,
      label: 'playback',
    });

    await browser.evaluate<void>(`(() => {
      const root = document.querySelector('section.otio-view');
      const btn = document.querySelector('button.otio-play');
      if (root?.dataset.playing === 'true' && btn instanceof HTMLButtonElement) {
        btn.click();
      }
      if (globalThis.__otioFrameObserver) {
        globalThis.__otioFrameObserver.disconnect();
      }
    })()`);

    const playbackSamples = await collectLabelCaptures(browser, width, height);
    const observedPlaybackFrames = await browser.evaluate<number[]>(`(() => {
      return (globalThis.__otioObservedFrames || []).slice();
    })()`);
    const seekTargets = await browser.evaluate<number[]>(`(() => {
      return (
        globalThis.__relicOtioVideoSeekTargets ??
        globalThis.__relicOtioMediaSeekTargets ??
        []
      ).slice();
    })()`);

    const minObserved =
      observedPlaybackFrames.length > 0
        ? Math.min(...observedPlaybackFrames)
        : (playbackSamples[0]?.dataFrame ?? 0);
    const maxObserved =
      observedPlaybackFrames.length > 0
        ? Math.max(...observedPlaybackFrames)
        : (playbackSamples[playbackSamples.length - 1]?.dataFrame ?? 72);
    const elapsedMediaFrames = Math.max(
      24,
      Math.round(maxObserved - minObserved)
    );

    const distinctFloors = new Set(
      observedPlaybackFrames.map((f) => Math.floor(f))
    );
    const floorProgressRatio = distinctFloors.size / elapsedMediaFrames;
    assert.ok(
      floorProgressRatio >= 0.6,
      `distinct floor(data-frame) progress ${distinctFloors.size}/${elapsedMediaFrames} (${(floorProgressRatio * 100).toFixed(1)}%) below 60% floor (frozen hold)`
    );

    const seekRatio = seekTargets.length / elapsedMediaFrames;
    assert.ok(
      seekRatio <= 0.1,
      `steady playback seek ratio ${(seekRatio * 100).toFixed(1)}% exceeded 10% ceiling (${seekTargets.length} seeks / ${elapsedMediaFrames} elapsed frames: ${seekTargets.slice(0, 10).join(', ')}...)`
    );

    for (const [idx, item] of playbackSamples.entries()) {
      const timelineFrame = Math.floor(item.dataFrame + 1e-4);
      assert.ok(
        timelineFrame <= 44,
        `playback sample ${idx + 1}/8 timeline frame ${timelineFrame} exceeded frame 44, the Picture-in-Picture layer ends at frame 48`
      );
      const expectedFileFrame =
        plan.primary_clip_frames?.[String(timelineFrame)] ??
        plan.primary_file_frame + (timelineFrame - plan.primary_frame);

      const expectedRow = await frameRowCenter(
        join(mediaDir, plan.primary_media),
        expectedFileFrame
      );
      const wrongRow = await frameRowCenter(
        join(mediaDir, plan.primary_media),
        expectedFileFrame + 2
      );

      const toExpectedPx =
        Math.abs(item.center - expectedRow.center) * expectedRow.width;
      const toWrongPx =
        Math.abs(item.center - wrongRow.center) * wrongRow.width;

      assert.ok(
        toExpectedPx <= 3,
        `playback sample ${idx + 1}/8 canvas bar is ${toExpectedPx.toFixed(2)} px from official file frame ${expectedFileFrame} at timeline frame ${timelineFrame}`
      );
      assert.ok(
        toWrongPx >= 12,
        `playback sample ${idx + 1}/8 canvas bar is ${toWrongPx.toFixed(2)} px from wrong file frame ${expectedFileFrame + 2} at timeline frame ${timelineFrame}`
      );

      const expectedFrame = await extractFrame(
        join(mediaDir, plan.primary_media),
        expectedFileFrame,
        width,
        height
      );
      const expectedBar = barColumn(expectedFrame, width, height);
      const actualBar = barColumn(item.sample, width, height);
      assert.ok(
        Math.abs(actualBar - expectedBar) <= 1,
        `playback sample ${idx + 1}/8 bar column ${actualBar} does not match official expected column ${expectedBar} at timeline frame ${timelineFrame}`
      );
    }
    pass('native-playback');
    // Parity oracle: determine shared-window intervals across parity layers.
    assert.equal(
      plan.parity_layers.length,
      2,
      'plan parity_layers must have exactly 2 layers'
    );

    const layerPackets: number[][] = [];
    for (const layer of plan.parity_layers) {
      const mediaFile = join(mediaDir, layer.media);
      const packets = await layerPacketStarts(mediaFile);
      layerPackets.push(packets);
    }

    interface ParityWindow {
      readonly frame: number;
      readonly span: number;
      readonly lo: number;
      readonly hi: number;
      readonly admitted: boolean;
    }

    const parityWindows: ParityWindow[] = [];
    for (let f = 20; f <= 44; f++) {
      let minSpan = 1;
      for (
        let layerIndex = 0;
        layerIndex < plan.parity_layers.length;
        layerIndex++
      ) {
        const layer = plan.parity_layers[layerIndex];
        assert.ok(layer !== undefined, 'parity layer missing');
        const s_f = layer.file_seconds[String(f)];
        const s_f1 = layer.file_seconds[String(f + 1)];
        assert.ok(
          s_f !== undefined && s_f1 !== undefined,
          `parity layer ${layer.media} missing file_seconds for frame ${f}`
        );
        const denom = s_f1 - s_f;
        assert.ok(
          denom > 0,
          `parity layer ${layer.media} invalid frame duration`
        );
        const packets = layerPackets[layerIndex];
        assert.ok(
          packets !== undefined,
          `parity layer ${layer.media} has no packet list`
        );
        const nextStart: number | undefined = packets.find(
          (pts) => pts > s_f + 1e-9
        );
        assert.ok(
          nextStart !== undefined,
          `parity layer ${layer.media} has no packet start after s(${f})=${s_f}`
        );
        const span = Math.min(1, (nextStart - s_f) / denom);
        if (span < minSpan) minSpan = span;
      }
      const lo = f;
      const hi = f + minSpan - 0.05;
      const admitted = hi - lo >= 0.1;
      parityWindows.push({ frame: f, span: minSpan, lo, hi, admitted });
    }

    console.log(
      'PARITY_WINDOWS ' +
        parityWindows.map((w) => `${w.frame}:${w.span.toFixed(3)}`).join(' ')
    );

    const admittedIntervals = parityWindows
      .filter((w) => w.admitted)
      .map((w) => ({
        frame: w.frame,
        lo: w.lo,
        hi: w.hi,
        span: w.span,
      }));

    assert.ok(
      admittedIntervals.length >= 2,
      'parity oracle produced fewer than 2 admitted intervals'
    );

    // Paint parity: the same timeline frame painted during native playback and
    // while paused must match. The Picture-in-Picture overlay media
    // (overlay_alpha.webm) is a 30 fps WebM with millisecond-quantized packet
    // presentation times (time_base=1/1000). On a 24 fps timeline, timeline frames
    // 28 and 40 sit at 1166.67 ms and 1666.67 ms, while overlay frames 35 and 50
    // start at 1167 ms and 1667 ms, a third of a millisecond later. Under the
    // half-open window doctrine [start, end), a playing sample at df in [28.008, 28.6)
    // displays overlay frame 35 whereas a paused seek to frame 28 displays frame 34.
    // Therefore, frames 28 and 40 have near-zero shared-window spans (0.008 frames)
    // and are excluded from the parity oracle. Only frames with shared-window
    // interval span at least 0.1 frames are admitted.
    await seekTo(browser, 16);
    await installLabelCapture(browser, width, height, {
      kind: 'intervals',
      intervals: admittedIntervals,
    });

    await browser.evaluate<void>(`(() => {
      const btn = document.querySelector('button.otio-play');
      const root = document.querySelector('section.otio-view');
      if (btn && root?.dataset.playing !== 'true') btn.click();
    })()`);

    await waitLabelCaptures(browser, {
      untilFrame: 45,
      timeoutMs: 15_000,
      label: 'paint parity',
    });

    await browser.evaluate<void>(`(() => {
      const btn = document.querySelector('button.otio-play');
      const root = document.querySelector('section.otio-view');
      if (btn && root?.dataset.playing === 'true') btn.click();
    })()`);

    const parityCaptures = await collectLabelCaptures(browser, width, height);

    assert.ok(
      parityCaptures.length >= 2,
      `paint parity captured ${parityCaptures.length} playback labels inside shared-window intervals on frames 20 to 44; need at least 2`
    );

    const chosenCaptures: LabelCaptureItem[] = [];
    if (parityCaptures.length <= 8) {
      chosenCaptures.push(...parityCaptures);
    } else {
      const stride = (parityCaptures.length - 1) / 7;
      for (let i = 0; i < 8; i++) {
        const pick = parityCaptures[Math.round(i * stride)];
        assert.ok(pick !== undefined, 'parity capture index out of range');
        chosenCaptures.push(pick);
      }
    }

    for (const item of chosenCaptures) {
      assert.ok(
        item.frame !== undefined && item.span !== undefined,
        'parity capture missing frame or span'
      );
      await seekTo(browser, item.frame);
      const pausedSample = await sampleCanvas(browser, width, height);
      const parityRmse = rmse(item.sample, pausedSample);
      console.log(
        `PARITY frame=${item.frame} span=${item.span.toFixed(3)} df=${item.dataFrame.toFixed(3)} rmse=${parityRmse.toFixed(3)}`
      );
      assert.ok(
        parityRmse <= 1,
        `paint parity RMSE ${parityRmse.toFixed(3)} exceeded 1 for frame ${item.frame} (playing label ${item.dataFrame.toFixed(3)}, shared-window span ${item.span.toFixed(3)})`
      );
    }
    pass('paint-parity');

    const lateBrowser = await openBrowser(shareUrl, sessionToken, {
      label: 'native-playback-late',
      recordMediaSeekTargets: true,
      rvfcBusyWaitMs: 60,
    });
    try {
      await waitReady(lateBrowser);
      await seekTo(lateBrowser, 0);
      await clearMediaSeekTargets(lateBrowser);

      await lateBrowser.evaluate<void>(`(() => {
        globalThis.__otioObservedFrames = [];
        const root = document.querySelector('section.otio-view');
        if (root?.dataset?.frame != null) {
          globalThis.__otioObservedFrames.push(Number(root.dataset.frame));
        }
        const observer = new MutationObserver(() => {
          const view = document.querySelector('section.otio-view');
          if (view?.dataset?.frame != null) {
            globalThis.__otioObservedFrames.push(Number(view.dataset.frame));
          }
        });
        if (root) {
          observer.observe(root, { attributes: true, attributeFilter: ['data-frame'] });
        }
        globalThis.__otioFrameObserver = observer;
      })()`);

      // Same rule as the native stage, with the step measured under the 60 ms
      // busy-wait: 4.97 frames at most over 48 Linux CI trials, so the last
      // target is at or below 44.999 minus twice that.
      await installLabelCapture(lateBrowser, width, height, {
        kind: 'targets',
        targets: [3, 8, 12, 17, 21, 26, 30, 35],
      });

      const latePlaybackStarted = await lateBrowser.evaluate<boolean>(`(() => {
        const { promise, resolve } = Promise.withResolvers();
        const btn = document.querySelector('button.otio-play');
        const root = document.querySelector('section.otio-view');
        if (!btn || !root) { resolve(false); return promise; }
        if (root.dataset.playing === 'true') { resolve(true); return promise; }
        btn.click();
        const start = Date.now();
        const check = () => {
          if (root.dataset.playing === 'true') resolve(true);
          else if (Date.now() - start > 4000) resolve(false);
          else setTimeout(check, 25);
        };
        check();
        return promise;
      })()`);
      assert.ok(
        latePlaybackStarted,
        'late playback did not enter playing state'
      );

      // Samples are captured in-page via MutationObserver when the clock first
      // reaches each target frame, all at or before frame 44, so none lands on
      // the frame-48 drawn-set change.
      await waitLabelCaptures(lateBrowser, {
        count: 8,
        ceiling: 45,
        timeoutMs: 30_000,
        label: 'late playback',
      });

      await lateBrowser.evaluate<void>(`(() => {
        const root = document.querySelector('section.otio-view');
        const btn = document.querySelector('button.otio-play');
        if (root?.dataset.playing === 'true' && btn instanceof HTMLButtonElement) {
          btn.click();
        }
        if (globalThis.__otioFrameObserver) {
          globalThis.__otioFrameObserver.disconnect();
        }
      })()`);

      const latePlaybackSamples = await collectLabelCaptures(
        lateBrowser,
        width,
        height
      );
      assert.equal(
        latePlaybackSamples.length,
        8,
        'late playback did not collect 8 samples'
      );

      for (const [idx, item] of latePlaybackSamples.entries()) {
        const timelineFrame = Math.floor(item.dataFrame + 1e-4);
        assert.ok(
          timelineFrame <= 44,
          `late playback sample ${idx + 1}/8 timeline frame ${timelineFrame} exceeded frame 44 ceiling`
        );
        const expectedFileFrame =
          plan.primary_clip_frames?.[String(timelineFrame)] ??
          plan.primary_file_frame + (timelineFrame - plan.primary_frame);

        const expectedRow = await frameRowCenter(
          join(mediaDir, plan.primary_media),
          expectedFileFrame
        );
        const wrongRow = await frameRowCenter(
          join(mediaDir, plan.primary_media),
          expectedFileFrame + 2
        );

        const toExpectedPx =
          Math.abs(item.center - expectedRow.center) * expectedRow.width;
        const toWrongPx =
          Math.abs(item.center - wrongRow.center) * wrongRow.width;

        assert.ok(
          toExpectedPx <= 3,
          `late playback sample ${idx + 1}/8 canvas bar is ${toExpectedPx.toFixed(2)} px from official file frame ${expectedFileFrame} at timeline frame ${timelineFrame}`
        );
        assert.ok(
          toWrongPx >= 12,
          `late playback sample ${idx + 1}/8 canvas bar is ${toWrongPx.toFixed(2)} px from wrong file frame ${expectedFileFrame + 2} at timeline frame ${timelineFrame}`
        );

        const expectedFrame = await extractFrame(
          join(mediaDir, plan.primary_media),
          expectedFileFrame,
          width,
          height
        );
        const expectedBar = barColumn(expectedFrame, width, height);
        const actualBar = barColumn(item.sample, width, height);
        assert.ok(
          Math.abs(actualBar - expectedBar) <= 1,
          `late playback sample ${idx + 1}/8 bar column ${actualBar} does not match official expected column ${expectedBar} at timeline frame ${timelineFrame}`
        );
      }
      pass('native-playback-late');
    } finally {
      await lateBrowser.close();
    }

    const negativeHead = plan.default_view_negative_head;
    assert.ok(
      negativeHead.timewarp_file_frame < 0,
      'official reader did not derive a negative authored timewarp file sample'
    );
    await assertTrackVisible(browser, negativeHead.timewarp_track_id);
    await seekTo(browser, negativeHead.timeline_frame);
    const negativeExpected = await extractFrame(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.underlying_file_frame,
      width,
      height
    );
    const negativeClamped = await extractFrame(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.clamped_file_frame,
      width,
      height
    );
    const expectedBar = barColumn(negativeExpected, width, height);
    const clampedBar = barColumn(negativeClamped, width, height);
    assert.ok(
      Math.abs(expectedBar - clampedBar) >= 48,
      'negative-head fixture frames cannot distinguish the V2 clamp substitute'
    );
    const expectedRow = await frameRowCenter(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.underlying_file_frame
    );
    const clampedRow = await frameRowCenter(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.clamped_file_frame
    );
    const canvasCenter = await canvasRowCenter(browser);
    const toExpectedPx =
      Math.abs(canvasCenter - expectedRow.center) * expectedRow.width;
    const toClampedPx =
      Math.abs(canvasCenter - clampedRow.center) * clampedRow.width;
    assert.ok(
      toExpectedPx <= 3,
      `default canvas bar is ${toExpectedPx.toFixed(2)} source px from underlying V1 file frame ${negativeHead.underlying_file_frame}`
    );
    assert.ok(
      toClampedPx >= 48,
      `default canvas bar is ${toClampedPx.toFixed(2)} source px from clamped V2 substitute file frame ${negativeHead.clamped_file_frame}`
    );
    pass('default-view-negative-head');

    await setTracksHidden(browser, plan.nested_occluders, true);
    await seekTo(browser, plan.nested_frame);
    const nestedCanvas = await sampleCanvas(browser, width, height);
    await setTracksHidden(browser, plan.nested_occluders, false);
    const plate = await extractFrame(
      join(mediaDir, plan.nested_image_file),
      0,
      width,
      height
    );
    const platePredecessor = await extractFrame(
      join(mediaDir, plan.nested_predecessor_file),
      0,
      width,
      height
    );
    const plateSuccessor = await extractFrame(
      join(mediaDir, plan.nested_successor_file),
      0,
      width,
      height
    );
    const plateBar = barColumn(plate, width, height);
    const nestedBar = barColumn(nestedCanvas, width, height);
    assert.ok(
      Math.abs(nestedBar - plateBar) <= 3,
      `nested frame 200 bar ${nestedBar} does not match ${plan.nested_image_url} bar ${plateBar}`
    );
    const toPlate = rmse(nestedCanvas, plate);
    const toPredecessor = rmse(nestedCanvas, platePredecessor);
    const toSuccessor = rmse(nestedCanvas, plateSuccessor);
    assert.ok(
      toPlate + 2 < toPredecessor && toPlate + 2 < toSuccessor,
      `nested frame ${plan.nested_frame} is not ${plan.nested_image_file} (plate ${toPlate}, before ${toPredecessor}, after ${toSuccessor})`
    );
    pass('nested-200');

    await seekTo(browser, plan.outside_frame);
    const outsideCanvas = await sampleCanvas(browser, width, height);
    assert.equal(
      plan.outside_kind,
      'gap',
      `frame before the nested exposure is ${plan.outside_kind}, not a gap`
    );
    assert.equal(
      isOpaqueBlack(outsideCanvas),
      true,
      `nested plate spilled outside its exposure (${formatAlphaCensus()})`
    );
    assert.ok(
      Math.abs(barColumn(outsideCanvas, width, height) - plateBar) > 3 ||
        isOpaqueBlack(outsideCanvas),
      `outside frame still shows the nested plate bar (${formatAlphaCensus()})`
    );
    pass('nested-no-spill');

    await setTracksHidden(browser, plan.dissolve_occluders, true);
    await seekTo(browser, plan.dissolve_frame);
    const dissolveCanvas = await sampleCanvas(browser, width, height);
    await setTracksHidden(browser, plan.dissolve_occluders, false);
    assert.ok(
      plan.dissolve_weights.length >= 2,
      'dissolve has fewer than two weighted sources'
    );
    const [first, second] = plan.dissolve_weights;
    assert.ok(
      first &&
        second &&
        first.media &&
        second.media &&
        first.file_frame !== null &&
        second.file_frame !== null
    );
    const frameA = await extractFrame(
      join(mediaDir, first.media),
      first.file_frame,
      width,
      height
    );
    const frameB = await extractFrame(
      join(mediaDir, second.media),
      second.file_frame,
      width,
      height
    );
    const mixed = blend(frameA, frameB, first.weight, second.weight);
    const toMix = rmse(dissolveCanvas, mixed);
    const toA = rmse(dissolveCanvas, frameA);
    const toB = rmse(dissolveCanvas, frameB);
    assert.ok(
      toMix + 2 < toA && toMix + 2 < toB,
      `dissolve pixels match a hard source (mix ${toMix}, A ${toA}, B ${toB})`
    );
    pass('dissolve-pixels');

    await seekTo(browser, plan.audio_frame);
    const audio = await browser.evaluate<{
      missing: boolean;
      rows: Array<{
        path: string;
        rms: number;
        bin: number;
        currentTime: number;
        active: boolean;
      }>;
    }>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const nodes = [...document.querySelectorAll('.otio-audio-graph audio[data-active="true"]')];
      if (nodes.length < 2) { resolve({ missing: true, rows: [] }); return promise; }
      Promise.all(nodes.map(async (node) => {
        const stream = node.captureStream();
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const seekedAt = node.currentTime;
        await node.play();
        await new Promise((done) => setTimeout(done, 300));
        const time = new Uint8Array(analyser.fftSize);
        const freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(time);
        analyser.getByteFrequencyData(freq);
        let acc = 0;
        for (const value of time) {
          const x = (value - 128) / 128;
          acc += x * x;
        }
        let peak = 0;
        let bin = 0;
        for (let i = 1; i < freq.length; i++) if (freq[i] > peak) { peak = freq[i]; bin = i; }
        node.pause();
        await ctx.close();
        return {
          path: node.dataset.bundlePath,
          rms: Math.sqrt(acc / time.length),
          bin,
          currentTime: seekedAt,
          active: node.dataset.active === 'true',
        };
      })).then((rows) => resolve({ missing: false, rows }), () => resolve({ missing: true, rows: [] }));
      return promise;
    })()`);
    assert.equal(
      audio.missing,
      false,
      'audio graph did not expose two active captureStream elements'
    );
    for (const expected of plan.audio) {
      const row = audio.rows.find((item) => item.path === expected.bundle_path);
      assert.ok(row, `no active audio element for ${expected.bundle_path}`);
      assert.ok(
        row.rms > 0.01,
        `${expected.bundle_path} produced no signal (rms ${row.rms})`
      );
      assert.ok(
        Math.abs(row.currentTime - expected.source_seconds) < 0.2,
        `${expected.bundle_path} currentTime ${row.currentTime} is not source ${expected.source_seconds}`
      );
    }
    const bins = plan.audio.map(
      (expected) =>
        audio.rows.find((item) => item.path === expected.bundle_path)?.bin ?? -1
    );
    assert.ok(
      Math.abs((bins[0] ?? 0) - (bins[1] ?? 0)) >= 2,
      `simultaneous audio spectra are not distinct: ${bins.join(',')}`
    );
    pass('audio-signal');

    await seekTo(browser, plan.gap_frame);
    const gapCanvas = await sampleCanvas(browser, width, height);
    assert.equal(
      isOpaqueBlack(gapCanvas),
      true,
      `gap frame is not opaque black (${formatAlphaCensus()})`
    );
    pass('state-gap-black');

    await seekTo(browser, plan.effect_frame);
    const withheld = await sampleCanvas(browser, width, height);
    const effectBase = await extractFrame(
      join(mediaDir, plan.effect_media),
      plan.effect_file_frame ?? 0,
      width,
      height
    );
    assert.ok(
      rmse(withheld, effectBase) > 8,
      'unsupported effect painted base media before consent'
    );
    const consented = await browser.evaluate<{
      clicked: boolean;
      ready: string;
      preview: string;
      scope: string;
    }>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const button = document.querySelector('button.otio-preview-base');
      if (!button) { resolve({ clicked: false, ready: '', preview: '', scope: '' }); return promise; }
      button.click();
      const start = Date.now();
      const tick = () => {
        const root = document.querySelector('.otio-view');
        const ready = root?.dataset.ready ?? '';
        const preview = root?.dataset.previewState ?? '';
        const scope = document.querySelector('.otio-preview-scope')?.textContent ?? '';
        if (preview === 'incomplete' && ready === 'diagnostic') resolve({ clicked: true, ready, preview, scope });
        else if (Date.now() - start > 4000) resolve({ clicked: true, ready, preview, scope });
        else setTimeout(tick, 50);
      };
      tick();
      return promise;
    })()`);
    assert.equal(
      consented.clicked,
      true,
      'base-media preview consent control is missing'
    );
    assert.equal(
      consented.preview,
      'incomplete',
      'opt-in did not stay an incomplete preview'
    );
    assert.equal(
      consented.ready,
      'diagnostic',
      'opt-in masqueraded as a decoded ready state'
    );
    assert.match(
      consented.scope,
      /incomplete/i,
      'preview scope dropped the incomplete label'
    );
    await seekTo(browser, plan.effect_frame);
    const consentedCanvas = await sampleCanvas(browser, width, height);
    const diagnostic = await browser.evaluate<string>(
      `document.querySelector('.otio-diagnostics')?.textContent ?? ''`
    );
    assert.ok(
      diagnostic.includes('unsupported-effect'),
      'unsupported-effect diagnostic disappeared after consent'
    );
    assert.ok(
      rmse(consentedCanvas, effectBase) + 4 < rmse(withheld, effectBase),
      'consent did not reveal the base frame'
    );
    pass('state-effect');

    const pointBody = 'Nested plate point is late.';
    const rangeBody = 'Nested plate range covers the local cut.';
    const dupPointBody = 'Duplicate Video 2 point, not the other track.';
    const dupRangeBody = 'Duplicate Video 2 range stays on this id.';
    const dissolveBody = 'Dissolve window needs both sources.';
    const primaryBody = 'Primary grade range, before the dissolve.';
    const primaryStart = plan.comment_source.editorial.start_time.value;
    const primaryEnd =
      primaryStart + plan.comment_source.editorial.duration.value;
    await selectTrack(
      browser,
      plan.nested_track_id,
      'point',
      plan.nested_frame,
      plan.nested_frame
    );
    await postComposer(browser, pointBody);
    pass('ui-point-nested');
    await selectTrack(
      browser,
      plan.nested_track_id,
      'range',
      plan.nested_frame,
      plan.nested_frame + 4
    );
    await postComposer(browser, rangeBody);
    pass('ui-range-nested');
    await selectTrack(
      browser,
      plan.duplicate_track_id,
      'point',
      plan.duplicate_frame,
      plan.duplicate_frame
    );
    await postComposer(browser, dupPointBody);
    pass('ui-point-duplicate');
    await selectTrack(
      browser,
      plan.duplicate_track_id,
      'range',
      plan.duplicate_range.start_time.value,
      plan.duplicate_range.start_time.value +
        plan.duplicate_range.duration.value
    );
    await postComposer(browser, dupRangeBody);
    pass('ui-range-duplicate');
    await selectTrack(
      browser,
      plan.dissolve_track_id,
      'range',
      primaryStart,
      primaryEnd
    );
    await postComposer(browser, primaryBody);
    const queryStart = plan.dissolve_query.start_time.value;
    const queryEnd = queryStart + plan.dissolve_query.duration.value;
    await selectTrack(
      browser,
      plan.dissolve_track_id,
      'range',
      queryStart,
      queryEnd
    );
    await postComposer(browser, dissolveBody);
    pass('ui-range-dissolve');
    await selectTrack(
      browser,
      plan.duplicate_track_id,
      'track',
      duplicateScope.start_time.value,
      duplicateScope.start_time.value + duplicateScope.duration.value
    );
    const wholeTrackMark = await browser.evaluate<{
      start: string;
      duration: string;
      rate: string;
    }>(
      `(() => { const mark = document.querySelector('.otio-selection'); return {
        start: mark?.dataset.start ?? '', duration: mark?.dataset.duration ?? '',
        rate: mark?.dataset.rate ?? ''
      }; })()`
    );
    assert.ok(
      rangeClose(
        {
          start_time: {
            value: Number(wholeTrackMark.start),
            rate: Number(wholeTrackMark.rate),
          },
          duration: {
            value: Number(wholeTrackMark.duration),
            rate: Number(wholeTrackMark.rate),
          },
        },
        duplicateScope
      ),
      'whole-track UI did not select the original document exposed-core range'
    );
    await postComposer(browser, wholeTrackBody);
    pass('ui-track-duplicate');
    const nativeControlMeasurements: Array<Record<string, unknown>> = [];

    for (const [shotWidth, scheme] of [
      [1440, 'light'],
      [390, 'light'],
      [320, 'light'],
      [1440, 'dark'],
      [390, 'dark'],
      [320, 'dark'],
    ] as const) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: shotWidth,
        height: 900,
        deviceScaleFactor: 1,
        mobile: shotWidth < 600,
      });
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      console.log('MATRIX', shotWidth, scheme);
      const closed = await measureClosedNativeControls(browser);
      assertClosedNativeControls(closed, `${shotWidth}px ${scheme} closed`);
      nativeControlMeasurements.push({
        state: 'closed',
        width: shotWidth,
        scheme,
        probe: closed,
      });
      await browser.screenshot(`${shotWidth}-${scheme}`);
      await clearPointerHover(browser);
      await openComposer(browser);
      const normalComposer = await measureComposer(browser);
      await browser.screenshot(`${shotWidth}-${scheme}-composer-open`);
      assertComposerProbe(
        normalComposer,
        `${shotWidth}px ${scheme} composer`,
        false
      );
      nativeControlMeasurements.push({
        state: 'composer-normal',
        width: shotWidth,
        scheme,
        probe: normalComposer,
      });
      await hoverComposerPost(browser);
      const hoveredComposer = await measureComposer(browser);
      await browser.screenshot(`${shotWidth}-${scheme}-composer-hover`);
      assertComposerProbe(
        hoveredComposer,
        `${shotWidth}px ${scheme} composer hover`,
        true
      );
      nativeControlMeasurements.push({
        state: 'composer-hover',
        width: shotWidth,
        scheme,
        probe: hoveredComposer,
      });
      await dismissComposer(browser);
      for (const mode of ['point', 'range', 'track'] as const) {
        await selectTrack(
          browser,
          plan.duplicate_track_id,
          mode,
          plan.duplicate_frame,
          plan.duplicate_frame + 2
        );
        await clearPointerHover(browser);
        await openComposer(browser);
        const measured = await measureComposer(browser);
        await browser.screenshot(`${shotWidth}-${scheme}-${mode}-composer`);
        assertComposerProbe(
          measured,
          `${shotWidth}x900 ${scheme} ${mode} composer`,
          false
        );
        nativeControlMeasurements.push({
          state: `composer-${mode}`,
          width: shotWidth,
          height: 900,
          scheme,
          probe: measured,
        });
        await dismissComposer(browser);
      }
      if (shotWidth === 1440) {
        const sidebar = await measureSidebar(browser);
        assertSidebar(sidebar, `${shotWidth}px ${scheme} sidebar`, false);
        nativeControlMeasurements.push({
          state: 'desktop-sidebar',
          width: shotWidth,
          scheme,
          probe: sidebar,
        });
      }
      if (shotWidth === 390) {
        const sidebar = await measureSidebar(browser);
        assertSidebar(sidebar, `${shotWidth}px ${scheme} sidebar`, true);
        nativeControlMeasurements.push({
          state: 'narrow-sidebar',
          width: shotWidth,
          scheme,
          probe: sidebar,
        });
      }
    }

    for (const [shotWidth, shotHeight] of [
      [320, 480],
      [390, 568],
      [1440, 600],
    ] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        await browser.send('Emulation.setDeviceMetricsOverride', {
          width: shotWidth,
          height: shotHeight,
          deviceScaleFactor: 1,
          mobile: shotWidth < 600,
        });
        await browser.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        });
        for (const mode of ['point', 'range', 'track'] as const) {
          console.log('COMPACT', shotWidth, shotHeight, scheme, mode);
          await selectTrack(
            browser,
            plan.duplicate_track_id,
            mode,
            plan.duplicate_frame,
            plan.duplicate_frame + 2
          );
          await clearPointerHover(browser);
          await openComposer(browser);
          const measured = await measureComposer(browser);
          await browser.screenshot(
            `${shotWidth}x${shotHeight}-${scheme}-${mode}-composer`
          );
          assertComposerProbe(
            measured,
            `${shotWidth}x${shotHeight} ${scheme} ${mode} compact composer`,
            false
          );
          nativeControlMeasurements.push({
            state: `compact-${mode}`,
            width: shotWidth,
            height: shotHeight,
            scheme,
            probe: measured,
          });
          await dismissComposer(browser);
        }
      }
    }

    const layoutPriorFrame = await prepareBlockedPreview(
      browser,
      plan.effect_frame
    );
    await runLayoutMatrix(browser, 'blocked');
    await restorePreviewBase(browser);
    await seekTo(browser, layoutPriorFrame);

    for (const [shotWidth, scheme] of [
      [390, 'light'],
      [1440, 'light'],
      [390, 'dark'],
      [1440, 'dark'],
    ] as const) {
      console.log('BLOCKED_PREVIEW', shotWidth, scheme);
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: shotWidth,
        height: 900,
        deviceScaleFactor: 1,
        mobile: shotWidth < 600,
      });
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await browser.evaluate<void>(
        `document.querySelector('.stage-wrap').scrollTop = 0`
      );
      const priorFrame = await prepareBlockedPreview(
        browser,
        plan.effect_frame
      );
      const blocked = await measureBlockedPreview(browser);
      assertBlockedPreviewReadable(
        blocked,
        `${shotWidth}px ${scheme}`,
        plan.effect_frame
      );
      nativeControlMeasurements.push({
        state: 'blocked-preview',
        width: shotWidth,
        scheme,
        prior_frame: priorFrame,
        effect_frame: plan.effect_frame,
        probe: blocked,
      });
      await browser.screenshot(
        `native-controls-${shotWidth}-${scheme}-blocked-preview`
      );
      await restorePreviewBase(browser);
      await seekTo(browser, priorFrame);
    }

    for (const scheme of ['light', 'dark'] as const) {
      console.log('SUPPLEMENTAL_320', scheme);
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await browser.evaluate<void>(
        `document.querySelector('.stage-wrap').scrollTop = 0`
      );
      const closed = await measureClosedNativeControls(browser);
      assertClosedNativeControls(closed, `320px ${scheme} closed`);
      nativeControlMeasurements.push({
        state: 'supplemental-closed',
        width: 320,
        scheme,
        probe: closed,
      });
      await browser.screenshot(`native-controls-320-${scheme}-closed`);
      await clearPointerHover(browser);
      await openComposer(browser);
      const normalComposer = await measureComposer(browser);
      await browser.screenshot(`native-controls-320-${scheme}-composer-open`);
      assertComposerProbe(normalComposer, `320px ${scheme} composer`, false);
      nativeControlMeasurements.push({
        state: 'supplemental-composer-normal',
        width: 320,
        scheme,
        probe: normalComposer,
      });
      await hoverComposerPost(browser);
      const hoveredComposer = await measureComposer(browser);
      await browser.screenshot(`native-controls-320-${scheme}-composer-hover`);
      assertComposerProbe(
        hoveredComposer,
        `320px ${scheme} composer hover`,
        true
      );
      nativeControlMeasurements.push({
        state: 'supplemental-composer-hover',
        width: 320,
        scheme,
        probe: hoveredComposer,
      });
      await dismissComposer(browser);
      const sidebar = await measureSidebar(browser);
      assertSidebar(sidebar, `320px ${scheme} sidebar`, true);
      nativeControlMeasurements.push({
        state: 'supplemental-narrow-sidebar',
        width: 320,
        scheme,
        probe: sidebar,
      });
      await browser.evaluate<void>(
        `document.querySelector('.stage-wrap').scrollTop = 0`
      );
      const priorFrame = await prepareBlockedPreview(
        browser,
        plan.effect_frame
      );
      const blocked = await measureBlockedPreview(browser);
      assertBlockedPreviewReadable(
        blocked,
        `320px ${scheme}`,
        plan.effect_frame
      );
      nativeControlMeasurements.push({
        state: 'blocked-preview',
        width: 320,
        scheme,
        prior_frame: priorFrame,
        effect_frame: plan.effect_frame,
        probe: blocked,
      });
      const previewBase: StageControlExposure = {
        missing: blocked.missing,
        visible: blocked.button.visible,
        withinStage: blocked.button.contained,
        rect: blocked.button.rect,
      };
      assertStageControlExposure(previewBase, `320px ${scheme} base preview`);
      nativeControlMeasurements.push({
        state: 'supplemental-preview-base',
        width: 320,
        scheme,
        probe: previewBase,
      });
      await browser.screenshot(`native-controls-320-${scheme}-preview-base`);
      await browser.screenshot(`native-controls-320-${scheme}-blocked-preview`);
      await restorePreviewBase(browser);
      await seekTo(browser, priorFrame);
      const commentSelection = await exposeSelectionControl(browser);
      assertStageControlExposure(
        commentSelection,
        `320px ${scheme} selection control`
      );
      nativeControlMeasurements.push({
        state: 'supplemental-selection-control',
        width: 320,
        scheme,
        probe: commentSelection,
      });
      await browser.screenshot(
        `native-controls-320-${scheme}-selection-controls`
      );
      await browser.evaluate<void>(
        `document.querySelector('.stage-wrap').scrollTop = 0`
      );
    }
    console.log('START_REAIM');
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await browser.evaluate<void>(
      `document.querySelector('.stage-wrap').scrollTop = 0`
    );
    await selectTrack(
      browser,
      plan.dissolve_track_id,
      'range',
      primaryStart,
      primaryStart + 2
    );
    await openComposer(browser);
    reaimed = await aimHeldDraftWithPointer(
      browser,
      plan.dissolve_track_id,
      pointerBody,
      primaryStart + 1,
      primaryStart + 5
    );
    assert.deepEqual(
      {
        sameField: reaimed.sameField,
        text: reaimed.text,
        focused: reaimed.focused,
        track: reaimed.track,
        moved: reaimed.moved,
        sidebarClosed: reaimed.sidebarClosed,
      },
      {
        sameField: true,
        text: pointerBody,
        focused: false,
        track: plan.dissolve_track_id,
        moved: true,
        sidebarClosed: true,
      },
      `pointer re-aim did not preserve draft, move panel, or keep sidebar closed: ${JSON.stringify(reaimed)}`
    );
    assert.ok(
      reaimed.duration > 0 && reaimed.start !== primaryStart,
      `pointer re-aim did not change the range: ${JSON.stringify(reaimed)}`
    );
    const reaimedProbe = await measureComposer(browser);
    assertComposerProbe(reaimedProbe, 're-aimed composer', false);
    console.log('REAIM_POSTING');
    await postHeldComposer(browser, pointerBody);

    console.log('CANCEL_TEST');
    const beforeCancel = (
      (await (
        await fetch(`${origin}/api/relics/${relicId}/comments`)
      ).json()) as unknown[]
    ).length;
    await openComposer(browser);
    await browser.evaluate<void>(`(() => {
      const field = document.querySelector('.popover-composer textarea');
      field.value = ${JSON.stringify(cancelledText)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await dismissComposer(browser);
    const afterCancel = (
      (await (
        await fetch(`${origin}/api/relics/${relicId}/comments`)
      ).json()) as unknown[]
    ).length;
    assert.equal(afterCancel, beforeCancel, 'Cancel wrote a comment event');
    await openComposer(browser);
    const reopened = await browser.evaluate<{
      text: string;
      track: string;
      start: string;
      duration: string;
    }>(`(() => {
      const mark = document.querySelector('.otio-selection');
      return {
        text: document.querySelector('.popover-composer textarea')?.value ?? '',
        track: mark?.dataset.trackId ?? '', start: mark?.dataset.start ?? '',
        duration: mark?.dataset.duration ?? '',
      };
    })()`);
    assert.equal(
      reopened.text,
      '',
      'Cancel retained typed sentinel on reopened composer'
    );
    assert.equal(
      reopened.track,
      reaimed.track,
      'Cancel cleared OTIO selection'
    );
    assert.equal(
      Number(reopened.start),
      reaimed.start,
      'Cancel restored an older selection'
    );
    assert.equal(Number(reopened.duration), reaimed.duration);
    await dismissComposer(browser);
    console.log('LOWER_TRACK_TEST');

    await selectTrack(
      browser,
      plan.nested_track_id,
      'range',
      plan.nested_frame,
      plan.nested_frame + 4
    );
    const lowerScroll = await browser.evaluate<{ stage: number; page: number }>(
      `(() => {
        const timeline = document.querySelector('.otio-timeline-scroll');
        timeline.scrollTop = timeline.scrollHeight;
        return { stage: timeline.scrollTop, page: window.scrollY };
      })()`
    );
    assert.ok(
      lowerScroll.stage > 0,
      'lower-track proof did not scroll the timeline'
    );
    await openComposer(browser);
    const revealed = await browser.evaluate<{ stage: number; page: number }>(
      `(() => ({ stage: document.querySelector('.otio-timeline-scroll').scrollTop, page: window.scrollY }))()`
    );
    assert.equal(
      revealed.page,
      lowerScroll.page,
      'lower-track reveal scrolled the page'
    );
    const lowerComposer = await measureComposer(browser);
    await browser.screenshot('1440-light-lower-track-composer-open');
    assertComposerProbe(
      lowerComposer,
      'lower track initial preview reveal',
      false
    );
    nativeControlMeasurements.push({
      state: 'lower-track-reveal',
      width: 1440,
      height: 900,
      scheme: 'light',
      probe: lowerComposer,
    });
    await dismissComposer(browser);
    console.log('POINTER_CASES_TEST');
    const clickReadback = await readComments(relicId);
    const finalPointerAim = reaimed;
    assert.ok(
      finalPointerAim,
      'pointer re-aim result is absent before comment-mark pointer proof'
    );
    const pointerRange: TimeRange = {
      start_time: {
        value: finalPointerAim.start,
        rate: finalPointerAim.rate,
      },
      duration: {
        value: finalPointerAim.duration,
        rate: finalPointerAim.rate,
      },
    };
    const pointerCases = [
      pointerCommentCase(
        clickReadback,
        'primary-range',
        primaryBody,
        plan.dissolve_track_id,
        plan.comment_source.editorial
      ),
      pointerCommentCase(
        clickReadback,
        'pointer-reaim',
        pointerBody,
        plan.dissolve_track_id,
        pointerRange
      ),
      pointerCommentCase(
        clickReadback,
        'duplicate-point',
        dupPointBody,
        plan.duplicate_track_id,
        {
          start_time: {
            value: plan.duplicate_frame,
            rate: plan.timeline_rate,
          },
          duration: {
            value: 0,
            rate: plan.timeline_rate,
          },
        }
      ),
      pointerCommentCase(
        clickReadback,
        'whole-track',
        wholeTrackBody,
        plan.duplicate_track_id,
        duplicateScope
      ),
    ];
    assert.equal(
      new Set(pointerCases.map((pointerCase) => pointerCase.expectedId)).size,
      pointerCases.length,
      'fresh comment readback reused a comment_id across pointer-proof bodies'
    );
    for (const pointerCase of pointerCases) {
      console.log('POINTER_CASE', pointerCase.caseName);
      await assertCommentMarkPointerClick(
        browser,
        pointerCase,
        nativeControlMeasurements
      );
    }
    console.log('RESIZE_TEST');

    await browser.evaluate<void>(
      `document.querySelector('.stage-wrap').scrollTop = 0`
    );
    await selectTrack(
      browser,
      plan.duplicate_track_id,
      'point',
      plan.duplicate_frame,
      plan.duplicate_frame
    );
    await openComposer(browser);
    const resizeDraft = 'Draft survives preview resize.';
    await browser.evaluate<void>(`(() => {
      const field = document.querySelector('.popover-composer textarea');
      field.value = ${JSON.stringify(resizeDraft)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      window.__otioResizeField = field;
    })()`);
    for (const [shotWidth, shotHeight] of [
      [320, 480],
      [390, 568],
      [1440, 900],
    ] as const) {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: shotWidth,
        height: shotHeight,
        deviceScaleFactor: 1,
        mobile: shotWidth < 600,
      });
      const settled = await browser.evaluate<{ same: boolean; text: string }>(
        `(() => {
          const { promise, resolve } = Promise.withResolvers();
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            const field = document.querySelector(
              '.popover-card.popover-composer.is-otio-composer textarea, .popover-composer textarea'
            );
            resolve({
              same: field === window.__otioResizeField,
              text: field?.value ?? '',
            });
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 50);
          return promise;
        })()`
      );
      assert.deepEqual(
        settled,
        { same: true, text: resizeDraft },
        `${shotWidth}x${shotHeight} resize rebuilt or cleared held editor`
      );
      const probe = await measureComposer(browser);
      await browser.screenshot(
        `${shotWidth}x${shotHeight}-light-resize-held-draft`
      );
      assertComposerProbe(
        probe,
        `${shotWidth}x${shotHeight} held draft resize`,
        false
      );
      nativeControlMeasurements.push({
        state: 'resize-held-draft',
        width: shotWidth,
        height: shotHeight,
        scheme: 'light',
        probe,
      });
    }
    await dismissComposer(browser);

    const editId = await browser.evaluate<string | null>(`(() => {
      const row = [...document.querySelectorAll('[data-comment-id]')].find(
        (node) => node.textContent?.includes('Duplicate Video 2 range stays on this id.'));
      const id = row?.getAttribute('data-comment-id');
      const mark = id && document.querySelector('.otio-comment-mark[data-comment-id="' + id + '"]');
      if (!(mark instanceof HTMLButtonElement)) return null;
      mark.click();
      const card = document.querySelector('.popover-card');
      return card?.getAttribute('data-comment-id') === id &&
        card.querySelector('.popover-reply') && card.querySelector('.popover-edit') &&
        card.querySelector('.popover-resolve') ? id : null;
    })()`);
    assert.ok(editId, 'OTIO mark card is missing reply, edit, or resolve');
    const replied = await browser.evaluate<string>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      document.querySelector('.popover-card .popover-reply')?.click();
      const field = document.querySelector('.popover-card .popover-composer textarea');
      const submit = document.querySelector('.popover-card .popover-composer .popover-action.is-primary');
      if (!(field instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
        resolve('missing'); return promise;
      }
      field.value = ${JSON.stringify(replyBody)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      submit.click();
      const start = Date.now();
      const check = () => {
        if (document.body.textContent.includes(${JSON.stringify(replyBody)})) resolve('replied');
        else if (Date.now() - start > 10000) resolve('timeout');
        else setTimeout(check, 50);
      };
      check();
      return promise;
    })()`);
    assert.equal(
      replied,
      'replied',
      `native OTIO mark reply did not land: ${replied}`
    );
    const edited = await browser.evaluate<string>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      document.querySelector('.otio-comment-mark[data-comment-id="${editId}"]')?.click();
      document.querySelector('.popover-card .popover-edit')?.click();
      const field = document.querySelector('.popover-card .popover-composer textarea');
      const submit = document.querySelector('.popover-card .popover-composer .popover-action.is-primary');
      if (!(field instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
        resolve('missing'); return promise;
      }
      field.value = ${JSON.stringify(editedDupRangeBody)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      submit.click();
      const start = Date.now();
      const check = () => {
        if (document.body.textContent.includes(${JSON.stringify(editedDupRangeBody)})) resolve('edited');
        else if (Date.now() - start > 10000) resolve('timeout');
        else setTimeout(check, 50);
      };
      check();
      return promise;
    })()`);
    assert.equal(
      edited,
      'edited',
      `native OTIO mark edit did not land: ${edited}`
    );
    const status = await browser.evaluate<string>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      document.querySelector('.otio-comment-mark[data-comment-id="${editId}"]')?.click();
      document.querySelector('.popover-card .popover-resolve')?.click();
      const start = Date.now();
      const check = () => {
        const action = document.querySelector('.popover-card .popover-resolve');
        if (action?.textContent === 'Reopen') {
          action.click();
          const again = () => {
            if (document.querySelector('.popover-card .popover-resolve')?.textContent === 'Resolve')
              resolve('reopened');
            else if (Date.now() - start > 10000) resolve('reopen-timeout');
            else setTimeout(again, 50);
          };
          again();
        } else if (Date.now() - start > 10000) resolve('resolve-timeout');
        else setTimeout(check, 50);
      };
      check();
      return promise;
    })()`);
    assert.equal(
      status,
      'reopened',
      `OTIO Resolve/Reopen path failed: ${status}`
    );
    await browser.evaluate<void>(
      `document.querySelector('.popover-card .popover-open-thread')?.click()`
    );

    await writeFile(
      join(shotDir, 'native-controls-measurements.json'),
      `${JSON.stringify(
        {
          capture_height: 900,
          old_capture_filenames: [
            '1440-light.png',
            '390-light.png',
            '1440-dark.png',
            '390-dark.png',
            '1440-light-composer-open.png',
            '390-light-composer-open.png',
            '1440-dark-composer-open.png',
            '390-dark-composer-open.png',
          ],
          measurements: nativeControlMeasurements,
        },
        null,
        2
      )}\n`
    );
    pass('screenshots');
  } finally {
    await browser.close();
  }

  await runDecoderTimingProof(sessionToken);

  const listed = (await (
    await fetch(`${origin}/api/relics/${relicId}/comments`)
  ).json()) as Array<Record<string, unknown>>;
  const listedText = JSON.stringify(listed);
  for (const label of plan.private_labels) {
    assert.equal(
      listedText.includes(label),
      false,
      `comment store contains private label ${label}`
    );
  }
  for (const body of [
    'Nested plate point is late.',
    'Nested plate range covers the local cut.',
    'Duplicate Video 2 point, not the other track.',
    'Duplicate Video 2 range stays on this id.',
    'Dissolve window needs both sources.',
    'Primary grade range, before the dissolve.',
    wholeTrackBody,
    pointerBody,
    editedDupRangeBody,
    replyBody,
  ]) {
    assert.equal(
      listedText.includes(body),
      false,
      'comment store contains plaintext body'
    );
  }
  assert.ok(
    listed.every((row) => typeof row['ciphertext'] === 'string'),
    'comment row is missing ciphertext'
  );
  pass('ciphertext');

  const original = await readComments(relicId);
  const dissolve = commentByBody(
    original,
    'Dissolve window needs both sources.'
  );
  const dissolveResolved = resolvedOf(dissolve);
  assert.equal(dissolveResolved['status'], 'resolved');
  const intersections = dissolveResolved['intersections'];
  assert.ok(
    Array.isArray(intersections),
    'MCP did not return dissolve intersections'
  );
  for (const expected of plan.dissolve_spans) {
    const hit: Record<string, unknown> | undefined = (
      intersections as Array<Record<string, unknown>>
    ).find(
      (row) =>
        row['bundle_path'] === expected.bundle_path ||
        row['name'] === expected.name
    );
    if (!hit) {
      assert.fail(
        `MCP dissolve context missed ${expected.bundle_path ?? expected.name}`
      );
    }
    const sourceRange = asRange(hit['source_range']);
    assert.equal(
      sourceRange === null,
      expected.source_range === null,
      `MCP source range nullness for ${expected.name} does not match the official reader`
    );
    if (expected.source_range !== null) {
      assert.ok(
        rangeClose(sourceRange, expected.source_range),
        `MCP source range for ${expected.name} does not match the official reader`
      );
    }
    const fileRelativeRange = asRange(hit['file_relative_source_range']);
    assert.equal(
      fileRelativeRange === null,
      expected.file_relative_source_range === null,
      `MCP file-relative range nullness for ${expected.name} does not match the official reader`
    );
    if (expected.file_relative_source_range !== null) {
      assert.ok(
        rangeClose(fileRelativeRange, expected.file_relative_source_range),
        `MCP file-relative range for ${expected.name} does not match the official reader`
      );
    }
  }
  const dup = commentByBody(
    original,
    'Duplicate Video 2 point, not the other track.'
  );
  const dupAnchor = dup['anchor'] as { track_id?: string };
  assert.equal(
    dupAnchor.track_id,
    plan.duplicate_track_id,
    'duplicate-name comment was stored on the other track'
  );
  assert.notEqual(dupAnchor.track_id, plan.duplicate_other_track_id);
  const nested = commentByBody(original, 'Nested plate point is late.');
  const nestedAnchor = nested['anchor'] as {
    track_id?: string;
    range?: TimeRange;
  };
  assert.equal(nestedAnchor.track_id, plan.nested_track_id);
  assert.equal(nestedAnchor.range?.duration.value, 0);
  assert.equal(
    JSON.stringify(original).includes(cancelledText),
    false,
    'cancelled sentinel reached fresh agent readback'
  );
  const wholeTrack = commentByBody(original, wholeTrackBody);
  const wholeAnchor = wholeTrack['anchor'] as {
    track_id?: string;
    range?: TimeRange;
  };
  assert.equal(
    wholeAnchor.track_id,
    plan.duplicate_track_id,
    'whole-track comment changed the duplicate-name track identity'
  );
  assert.notEqual(wholeAnchor.track_id, plan.duplicate_other_track_id);
  assert.ok(
    rangeClose(wholeAnchor.range, duplicateScope),
    'fresh original-source whole-track anchor differs from exposed-core scope'
  );
  assert.equal(
    resolvedOf(wholeTrack)['status'],
    'resolved',
    'fresh original-source whole-track readback is unresolved'
  );
  assert.ok(reaimed, 'pointer re-aim result is absent');
  const pointer = commentByBody(original, pointerBody);
  const pointerAnchor = pointer['anchor'] as {
    track_id?: string;
    range?: TimeRange;
  };
  assert.equal(pointerAnchor.track_id, plan.dissolve_track_id);
  assert.ok(
    rangeClose(pointerAnchor.range, {
      start_time: { value: reaimed.start, rate: reaimed.rate },
      duration: { value: reaimed.duration, rate: reaimed.rate },
    }),
    'fresh readback posted older coordinates instead of the final pointer aim'
  );
  const editedAnchor = commentByBody(original, editedDupRangeBody)[
    'anchor'
  ] as {
    track_id?: string;
    range?: TimeRange;
  };
  assert.equal(editedAnchor.track_id, plan.duplicate_track_id);
  assert.ok(
    rangeClose(editedAnchor.range, plan.duplicate_range),
    'editing the existing OTIO mark changed its original range'
  );
  assert.ok(
    JSON.stringify(original).includes(replyBody),
    'fresh agent readback omitted the OTIO mark reply'
  );
  pass('mcp-original');

  const insertDir = join(scratch, 'insert.otiod');
  const insertJson = await oracle([
    'mutate',
    'insert',
    fixtureDir,
    insertDir,
    JSON.stringify(plan.comment_source.source_range),
  ]);
  const insertExpect = JSON.parse(insertJson) as {
    status: string;
    mapped_range: TimeRange | null;
  };
  assert.equal(insertExpect.status, 'mapped');
  const insertRange = insertExpect.mapped_range;
  assert.ok(insertRange, 'insert projection missing');
  const reviewer = 'reader@example.test';
  const insertIds = original
    .filter((entry) => entry['body'] !== replyBody)
    .map((entry) => String(entry['comment_id']));
  assert.deepEqual(
    await store.listCommenters(relicId),
    ['reader@example.test'],
    'the stop record must cover every follower the acknowledgements notify'
  );
  // `notify: false` skips only the change notice. Addressed replies normally notify
  // the local reviewer, who has stopped email through the existing opt-out record.
  await store.putOptOut({
    relicId,
    addressHash: await sha256Hex(reviewer),
    at: fakeNow,
  });
  const inserted = await callMcp('relic_republish', {
    relic_id: relicId,
    path: insertDir,
    cover: false,
    notify: false,
    addresses: insertIds.map((comment_id) => ({
      comment_id,
      note: 'Shifted the retained clip.',
    })),
  });
  assert.ok(inserted['version'], 'insert republish did not land');
  const afterInsert = await readComments(relicId);
  const nestedAfterInsert = resolvedOf(
    commentByBody(afterInsert, 'Nested plate point is late.')
  );
  assert.equal(
    nestedAfterInsert['status'],
    'resolved',
    'original nested source context was lost after insert'
  );
  const moved = resolvedOf(
    commentByBody(afterInsert, 'Primary grade range, before the dissolve.')
  );
  const movedProjection = moved['current_projection'] as {
    status?: string;
    mapped_range?: TimeRange;
  };
  assert.equal(
    movedProjection.status,
    'mapped',
    `insert projection status ${movedProjection.status}`
  );
  assert.ok(
    rangeClose(movedProjection.mapped_range, insertExpect.mapped_range),
    'insert projection does not match the official shifted range'
  );
  assert.notEqual(movedProjection.status, 'same');
  const primaryAfterInsert = commentByBody(
    afterInsert,
    'Primary grade range, before the dissolve.'
  );
  const primaryCommentId = String(primaryAfterInsert['comment_id']);
  const insertedVersion = String(inserted['version']);
  const insertBrowser = await openBrowser(shareUrl, sessionToken, {
    label: 'version-insert',
  });
  try {
    await waitReady(insertBrowser);
    await insertBrowser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const projectedMark = await insertBrowser.evaluate<{
      readonly version: string;
      readonly projection: string;
      readonly start: string;
      readonly duration: string;
      readonly rate: string;
      readonly rowProjection: string;
    }>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const expectedVersion = ${JSON.stringify(String(inserted['version']))};
      const commentId = ${JSON.stringify(primaryCommentId)};
      const started = Date.now();
      const inspect = () => {
        const root = document.querySelector('.otio-view');
        const mark = [...document.querySelectorAll('.otio-comment-mark')].find(
          (node) => node.getAttribute('data-comment-id') === commentId
        );
        const row = [
          ...document.querySelectorAll('.otio-feedback-projection'),
        ].find(
          (node) =>
            node.closest('[data-comment-id]')?.getAttribute('data-comment-id') ===
            commentId
        );
        const state = {
          version: root?.getAttribute('data-version') ?? '',
          projection: mark?.getAttribute('data-projection') ?? '',
          start: mark?.getAttribute('data-start') ?? '',
          duration: mark?.getAttribute('data-duration') ?? '',
          rate: mark?.getAttribute('data-rate') ?? '',
          rowProjection: row?.getAttribute('data-projection-status') ?? '',
        };
        if (
          state.version === expectedVersion &&
          state.projection === 'mapped' &&
          state.rowProjection === 'mapped'
        ) {
          resolve(state);
          return;
        }
        if (Date.now() - started > 10000) {
          resolve(state);
          return;
        }
        setTimeout(inspect, 100);
      };
      inspect();
      return promise;
    })()`);
    assert.equal(
      projectedMark.version,
      insertedVersion,
      'viewer did not open the inserted revision'
    );
    assert.equal(projectedMark.projection, 'mapped');
    assert.equal(projectedMark.rowProjection, 'mapped');
    assert.equal(projectedMark.start, String(insertRange.start_time.value));
    assert.equal(projectedMark.duration, String(insertRange.duration.value));
    assert.equal(projectedMark.rate, String(insertRange.start_time.rate));
    const currentNotice = await insertBrowser.evaluate<string | null>(`(() => {
      const notice = document.querySelector('.stage-wrap .notice, .stage .notice');
      return notice?.textContent?.trim() ?? null;
    })()`);
    assert.equal(
      currentNotice,
      null,
      `current OTIO stage has unexpected comparison notice: ${currentNotice}`
    );
    await insertBrowser.screenshot('otio-version-current-no-notice');
    const domText = await insertBrowser.evaluate<string>(`(() => {
      return document.body.textContent ?? '';
    })()`);
    const downloadOnlyMatches = domText.toLowerCase().includes('download-only');
    assert.equal(
      downloadOnlyMatches,
      false,
      'OTIO relic at version 2 opens with "download-only" text in DOM'
    );
    console.log(
      `OTIO_V2_DOM_NO_DOWNLOAD_ONLY_OK downloadOnlyMatches=${downloadOnlyMatches}`
    );

    await insertBrowser.evaluate<void>(`(() => {
      const button = document.querySelector('[aria-label="Open an earlier version of this relic"]');
      if (button instanceof HTMLElement) button.click();
    })()`);

    const noticeInfo = await insertBrowser.evaluate<{
      count: number;
      text: string;
    }>(`(() => {
      const { promise, resolve } = Promise.withResolvers();
      const started = Date.now();
      const check = () => {
        const notices = [...document.querySelectorAll('.diff-single .notice')];
        if (notices.length > 0) {
          resolve({ count: notices.length, text: notices[0]?.textContent?.trim() ?? '' });
        } else if (Date.now() - started > 5000) {
          resolve({ count: 0, text: '' });
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      return promise;
    })()`);
    assert.equal(
      noticeInfo.count,
      1,
      `expected 1 notice in diff-single, found ${noticeInfo.count}`
    );
    const expectedNoticeText =
      'Relik cannot show version 1 of this timeline beside version 2. It is open here on its own.';
    assert.equal(
      noticeInfo.text,
      expectedNoticeText,
      `earlier version notice does not match expected timeline text: ${noticeInfo.text}`
    );
    await insertBrowser.screenshot('otio-version-earlier-notice');
  } finally {
    await insertBrowser.close();
  }
  pass('revision-insert');

  const trimDir = join(scratch, 'trim.otiod');
  await cp(insertDir, trimDir, { recursive: true });
  const trimJson = await oracle([
    'mutate',
    'trim',
    trimDir,
    trimDir,
    JSON.stringify(plan.comment_source.source_range),
  ]);
  const trimExpect = JSON.parse(trimJson) as {
    status: string;
    mapped_range: TimeRange | null;
  };
  assert.equal(trimExpect.status, 'partial');
  const trimmed = await callMcp('relic_republish', {
    relic_id: relicId,
    path: trimDir,
    cover: false,
    notify: false,
  });
  assert.ok(trimmed['version'], 'trim republish did not land');
  const afterTrim = await readComments(relicId);
  const trimResolved = resolvedOf(
    commentByBody(afterTrim, 'Primary grade range, before the dissolve.')
  );
  const trimAnchor = commentByBody(
    afterTrim,
    'Primary grade range, before the dissolve.'
  )['anchor'] as { range?: TimeRange };
  assert.ok(
    rangeClose(
      trimAnchor.range,
      asRange(
        (
          commentByBody(original, 'Primary grade range, before the dissolve.')[
            'anchor'
          ] as { range?: TimeRange }
        ).range
      )
    ),
    'trim rewrote the original interval'
  );
  const trimProjection = trimResolved['current_projection'] as {
    status?: string;
    mapped_range?: TimeRange;
  };
  assert.equal(trimProjection.status, 'partial');
  assert.ok(
    rangeClose(trimProjection.mapped_range, trimExpect.mapped_range),
    'partial projection does not match the surviving official range'
  );
  pass('revision-trim');

  const ambiguousDir = join(scratch, 'ambiguous.otiod');
  await cp(trimDir, ambiguousDir, { recursive: true });
  const ambiguousJson = await oracle([
    'mutate',
    'ambiguous',
    ambiguousDir,
    ambiguousDir,
    JSON.stringify(plan.comment_source.source_range),
  ]);
  const ambiguousExpect = JSON.parse(ambiguousJson) as {
    status: string;
    mapped_range: TimeRange | null;
  };
  assert.equal(ambiguousExpect.status, 'ambiguous');
  assert.equal(ambiguousExpect.mapped_range, null);
  const ambiguous = await callMcp('relic_republish', {
    relic_id: relicId,
    path: ambiguousDir,
    cover: false,
    notify: false,
  });
  assert.ok(ambiguous['version'], 'ambiguous republish did not land');
  const afterAmbiguous = await readComments(relicId);
  const ambiguousProjection = resolvedOf(
    commentByBody(afterAmbiguous, 'Primary grade range, before the dissolve.')
  )['current_projection'] as {
    status?: string;
    mapped_range?: TimeRange;
    mapped_start_seconds?: number | null;
  };
  assert.equal(ambiguousProjection.status, 'ambiguous');
  assert.equal(ambiguousProjection.mapped_range, undefined);
  assert.ok(
    ambiguousProjection.mapped_start_seconds == null,
    'ambiguous revision returned a guessed coordinate'
  );
  const stillOriginal = resolvedOf(
    commentByBody(afterAmbiguous, 'Primary grade range, before the dissolve.')
  );
  assert.equal(
    stillOriginal['status'],
    'resolved',
    'ambiguous revision replaced the original source context'
  );
  pass('revision-ambiguous');

  const stateDir = join(scratch, 'states.otiod');
  const stateJson = await oracle([
    'mutate',
    'states',
    fixtureDir,
    stateDir,
    JSON.stringify({ value: plan.nested_frame, rate: plan.timeline_rate }),
  ]);
  const statePlan = JSON.parse(stateJson) as {
    missing_file: string;
    black_frame: number;
    black_under: string;
    probe_track: string;
    codec_frame: number;
    codec_media: string;
  };
  assert.equal(statePlan.missing_file, plan.nested_image_file);
  const statePublished = await callMcp('relic_publish', {
    path: stateDir,
    title: 'OTIO state proof',
    cover: false,
  });
  const stateUrl = String(
    statePublished['url'] ?? statePublished['link'] ?? ''
  );
  const stateBrowser = await openBrowser(stateUrl, sessionToken, {
    label: 'state-occlusion',
  });
  try {
    await waitReady(stateBrowser);
    await setTracksHidden(stateBrowser, plan.nested_occluders, true);
    await seekTo(stateBrowser, plan.nested_frame);
    const held = await sampleCanvas(stateBrowser, width, height);
    const predecessor = await extractFrame(
      join(fixtureDir, plan.nested_predecessor_file),
      0,
      width,
      height
    );
    const missingPlate = await extractFrame(
      join(fixtureDir, plan.nested_image_file),
      0,
      width,
      height
    );
    assert.ok(
      rmse(held, predecessor) + 2 < rmse(held, missingPlate),
      'cold seek did not hold the predecessor frame'
    );
    await seekTo(stateBrowser, plan.nested_frame + 2);
    await seekTo(stateBrowser, plan.nested_frame);
    const heldAgain = await sampleCanvas(stateBrowser, width, height);
    assert.ok(
      rmse(heldAgain, predecessor) + 2 < rmse(heldAgain, missingPlate),
      'hold changed with seek order'
    );
    await setTracksHidden(stateBrowser, plan.nested_occluders, false);
    pass('state-hold');

    await setTracksHidden(stateBrowser, [statePlan.probe_track], true);
    await seekTo(stateBrowser, statePlan.black_frame);
    const beneath = await sampleCanvas(stateBrowser, width, height);
    assert.equal(
      isOpaqueBlack(beneath),
      false,
      `${statePlan.black_under} paints nothing under the black probe, so the policy check cannot fail (${formatAlphaCensus()})`
    );
    await setTracksHidden(stateBrowser, [statePlan.probe_track], false);
    await seekTo(stateBrowser, statePlan.black_frame);
    const black = await sampleCanvas(stateBrowser, width, height);
    assert.equal(
      isOpaqueBlack(black),
      true,
      `sequence black policy did not paint opaque black (${formatAlphaCensus()})`
    );
    pass('state-sequence-black');

    await seekTo(stateBrowser, statePlan.codec_frame);
    const codecCanvas = await sampleCanvas(stateBrowser, width, height);
    const codecText = await stateBrowser.evaluate<string>(
      `document.body.textContent ?? ''`
    );
    assert.ok(
      codecText.includes('unsupported-codec') ||
        codecText.includes('missing-media'),
      'undecodable media did not report an honest codec or missing-media state'
    );
    assert.equal(
      isOpaqueBlack(codecCanvas),
      true,
      `undecodable media painted a substitute frame (${formatAlphaCensus()})`
    );
    pass('state-codec');
  } finally {
    await stateBrowser.close();
  }
  await runAuxiliaryCoincidentCommentRevealScenario(plan);
  async function runNegativeControlAgainstMain(): Promise<void> {
    const originMainViewerDist =
      process.env['ORIGIN_MAIN_VIEWER_DIST'] ??
      '/Users/jwaldrip/.omp/wt/bootstrap-run-76269ed/packages/relic-viewer/dist';
    const hasOriginDist = await Bun.file(
      join(originMainViewerDist, 'viewer.js')
    ).exists();
    if (!hasOriginDist) {
      console.log(
        `[negative-control] skipped: ${originMainViewerDist} not found`
      );
      return;
    }

    const negApp = createApp({
      config: { ...app.config, serviceOrigin: origin },
      store,
      storage,
      now: () => loopbackNow,
      operatorTokens,
      assets: diskAssets(originMainViewerDist),
      mailer: { send: async () => {}, sendMail: async () => {} },
    });
    const oldHandler = handler;
    handler = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.pathname.startsWith('/__storage/upload/') &&
        request.method === 'PUT'
      ) {
        const relicId = url.pathname.slice('/__storage/upload/'.length);
        storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (
        url.pathname.startsWith('/__storage/o/') &&
        request.method === 'GET'
      ) {
        const relicId = url.pathname.slice('/__storage/o/'.length);
        const bytes = await storage.read(relicId);
        if (!bytes) return new Response('Not found', { status: 404 });
        return new Response(Buffer.from(bytes), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return negApp.fetch(request);
    };

    const negToken = `neg-token-${Math.random().toString(16).slice(2)}`;
    await store.putSession({
      tokenHash: await sha256Hex(negToken),
      email: 'reader@example.test',
      createdAt: loopbackNow,
      expiresAt: loopbackNow + app.config.sessionTtlSeconds * 1000,
    });

    const negBrowser = await openBrowser(shareUrl, negToken, {
      label: 'negative-control-76269ed5',
    });

    try {
      await waitReady(negBrowser);
      await negBrowser.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const receipt: {
        baseCommit: string;
        viewerDist: string;
        observations: Record<string, unknown>;
      } = {
        baseCommit: '76269ed5',
        viewerDist: originMainViewerDist,
        observations: {},
      };
      const pointingResult = await negBrowser.evaluate<{
        anchoredComposerOpen: boolean;
        sidebarOpen: boolean;
      }>(`(() => {
        const composer = document.querySelector('.popover-card.popover-composer[data-anchor-kind="otio"]');
        const thread = document.querySelector('.thread');
        return {
          anchoredComposerOpen: composer !== null,
          sidebarOpen: thread !== null && thread.classList.contains('is-open'),
        };
      })()`);

      receipt.observations['pointingGesture'] = pointingResult;
      assert.equal(
        pointingResult.anchoredComposerOpen,
        false,
        'anchored stage composer with data-anchor-kind="otio" unexpectedly found on 76269ed5'
      );

      await negBrowser.evaluate<void>(`(() => {
        const closer = document.querySelector('.thread-toggle');
        if (closer instanceof HTMLElement) closer.click();
      })()`);
      const { promise: p1, resolve: r1 } = Promise.withResolvers<void>();
      setTimeout(r1, 100);
      await p1;

      const markClickResult = await negBrowser.evaluate<{
        stageCardOpen: boolean;
        sidebarOpen: boolean;
      }>(`(() => {
        const mark = document.querySelector('.otio-comment-mark');
        if (mark instanceof HTMLElement) {
          mark.click();
        }
        const card = document.querySelector('.popover-card[data-anchor-kind="otio"]');
        const thread = document.querySelector('.thread');
        return {
          stageCardOpen: card !== null,
          sidebarOpen: thread !== null && thread.classList.contains('is-open'),
        };
      })()`);

      receipt.observations['markClick'] = markClickResult;
      assert.equal(
        markClickResult.stageCardOpen,
        false,
        'anchored stage card with data-anchor-kind="otio" unexpectedly opened on 76269ed5'
      );

      await negBrowser.evaluate<void>(`(() => {
        const closer = document.querySelector('.thread-toggle');
        if (closer instanceof HTMLElement) closer.click();
      })()`);
      const { promise: p2, resolve: r2 } = Promise.withResolvers<void>();
      setTimeout(r2, 100);
      await p2;

      const markHoverResult = await negBrowser.evaluate<{
        stageCardOpen: boolean;
      }>(`(() => {
        const { promise, resolve } = Promise.withResolvers();
        const mark = document.querySelector('.otio-comment-mark');
        if (mark instanceof HTMLElement) {
          mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
        setTimeout(() => {
          const card = document.querySelector('.popover-card[data-anchor-kind="otio"]');
          resolve({ stageCardOpen: card !== null });
        }, 300);
        return promise;
      })()`);

      receipt.observations['markHover'] = markHoverResult;
      assert.equal(
        markHoverResult.stageCardOpen,
        false,
        'hover on mark unexpectedly opened anchored stage card on 76269ed5'
      );

      const proofDir = fileURLToPath(
        new URL('../../../docs/plans/anchored-popover/proof', import.meta.url)
      );
      await mkdir(proofDir, { recursive: true });
      await writeFile(
        join(proofDir, 'negative-control-receipt.json'),
        JSON.stringify(receipt, null, 2)
      );
      console.log(
        `NEGATIVE_CONTROL_OK saved receipt to ${join(proofDir, 'negative-control-receipt.json')}`
      );
    } finally {
      await negBrowser.close();
      handler = oldHandler;
    }
  }
  await runNegativeControlAgainstMain();

  assert.equal(
    mails.length,
    0,
    `the proof captured ${mails.length} mail send(s): ${JSON.stringify(
      mails.map(({ to, mail }) => ({ to, subject: mail.subject }))
    )}`
  );
  pass('no-mail');

  const missing = REQUIRED.filter((stage) => !passed.has(stage));
  assert.deepEqual(missing, [], `stages not passed: ${missing.join(', ')}`);
  console.log('OTIO_PATH_OK');
} catch (error) {
  if (!(error instanceof LayoutOnlyComplete)) throw error;
} finally {
  for (const child of children) child.kill('SIGKILL');
  const kept =
    process.env['RELIC_OTIO_SHOTS_DIR'] ??
    (await mkdtemp(join(await realpath(tmpdir()), 'otio-path-shots-')));
  await mkdir(kept, { recursive: true });
  await cp(shotDir, kept, { recursive: true });
  console.log(`SHOTS ${kept}`);
  clearTimeout(watchdog);
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
