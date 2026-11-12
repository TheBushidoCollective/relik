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
 * RELIC_OTIO_DECODER_ONLY=1 runs the startup gate check and the decoder timing proof, then prints OTIO_DECODER_OK.
 */

import assert from 'node:assert/strict';
import {
  associateGateSequence,
  assertAssociatedSamples,
  type GateQuantum,
  type TapQuantum,
  staleStopDecision,
} from './otio-proof-clock.ts';
import { createHash } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  compareRationalTimes,
  decodeKey,
  encodeKey,
  deriveRendererClass,
  deriveShareProof,
  encryptRelic,
  evaluateOtioAt,
  generateKey,
  generateRelicId,
  indexOtioZip,
  OTIO_PROGRAM_MANIFEST_ENTRY,
  openRelic,
  readOtioDocument,
  relicUrl,
  shareVerifierFor,
  versionDigest,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { DEFAULT_CLOCK_POLICY } from '../../relic-viewer/src/otio-output-clock';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { nodeUploader } from '../src/upload.ts';
import { loadPublishState, savePublishState } from '../src/state.ts';
import { nodeFiles } from '../src/files.ts';
import {
  guessMimetype,
  postJson,
  type PublishDeps,
  putContainer,
  readSource,
  reportComplete,
} from '../src/publish.ts';
import {
  attestBrowserHeadless,
  type BrowserHeadlessLaunch,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { isOpaqueBlack } from './otio-path-pixels.ts';
import {
  otioProofTracePrelude,
  otioProofWorkletSource,
} from './otio-proof-trace.ts';
import {
  assertDescriptorBudgetRefusal,
  assertHeldReleaseBeforeSuccessor,
  assertShiftedBankRefusal,
  recoveryFrontierOvershoot,
  siteBridgeCommitLeadAfterHold,
  siteBridgeGapInfeasibleAfterHold,
} from './otio-recovery-checks.ts';

const clientMode = process.env['RELIC_OTIO_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');
const OTIO_PIN = 'opentimelineio==0.18.1';
// Natural stale-pair capture stops once this many cached-duplicate pairs exist.
// The gate's hard cap (proofStaleMaxPairs) is unchanged; overflow still fails closed.
const STALE_PAIR_QUOTA = 2;
const STALE_PAIR_CAP = 16;
const clockProofMode = process.env['RELIC_OTIO_CLOCK_PROOF'] ?? '';
if (
  clockProofMode !== '' &&
  clockProofMode !== 'focused' &&
  clockProofMode !== 'long'
)
  throw new Error(`Unknown OTIO clock proof mode: ${clockProofMode}`);

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
  'packet-gate-negative-controls',
  'decoder-timing-windows',
  'decoder-webm-quantization',
  'decoder-near-zero',
  'decoder-edit-diagnostics',
  'decoder-no-duration',
  'decoder-worker-csp',
  'screenshots',
  'focus-video',
  'focus-fallback',
  'focus-audio',
  'focus-special-items',
  'focus-comment',
  'focus-reveal',
  'focus-viewports',
  'resize-viewer',
  'post-gain-tap-calibration',
  'focused-nonzero-comment',
  'scheduled-pcm-playback',
  'scheduled-pcm-cold-start',
  'scheduled-pcm-starvation-cancel',
  'scheduled-pcm-starvation-recovery',
  'scheduled-pcm-schedule-clock-failures',
  'scheduled-pcm-bootstrap-restore',
  'scheduled-video-future-recovery',
  'scheduled-pcm-native-compatibility',
  'scheduled-video-reservation-invalidation',
  'scheduled-pcm-seek-scope-cancel',
  'scheduled-pcm-terminal-failure',
  'scheduled-pcm-mute-solo',
  // Default-mode stage: runs in the full run and is accounted at the end of it.
  'legacy-sixty-fps-cold-start',
  // Default-mode stage: a trusted restart during a held cold start, accounted at the end.
  'scheduled-pcm-restart-during-start',
  // Three-slot mode stage: runs in the proof-only three-slot build, which exits through
  // DecoderOnlyComplete right after this pass. Its success is that pass plus the
  // OTIO_THREE_SLOT_OK marker. It is never accounted by the default-mode check below.
  'legacy-three-slot-forced-refusal',
] as const;

const passed = new Set<string>();
function pass(stage: (typeof REQUIRED)[number]): void {
  passed.add(stage);
  console.log(`STAGE ${stage}`);
}

const fakeNow = Date.now();
const loopbackNow = fakeNow;
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

let proofWorkletRequests = 0;
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
    url.pathname === '/__proof/otio-audio-worklet.js' &&
    request.method === 'GET'
  ) {
    proofWorkletRequests++;
    console.log('OTIO_PROOF_WORKLET_REQUEST');
    return new Response(otioProofWorkletSource, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

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
    if op in ("boundary-insert", "boundary-trim", "boundary-ambiguous"):
        track = next(item for item in timeline.tracks if relic_id(item) == "boundary-lower")
        clip = next(item for item in track if relic_id(item) == "moving-b")
        if op == "boundary-insert":
            gap = otio.schema.Gap(name="Insert", source_range=otio.opentime.TimeRange(
                otio.opentime.RationalTime(0, 30), otio.opentime.RationalTime(30, 30)))
            track.insert(0, gap)
        elif op == "boundary-trim":
            clip.source_range = otio.opentime.TimeRange(
                otio.opentime.RationalTime(6, 30), otio.opentime.RationalTime(4, 30))
        else:
            copy = otio.adapters.read_from_string(otio.adapters.write_to_string(clip))
            track.insert(list(track).index(clip) + 1, copy)
        write_dir(timeline, dest)
        print(json.dumps(project(dest, "moving-b", json.loads(extra))))
        return
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
  startScreencast(): Promise<
    () => Promise<{ frames: Array<Record<string, unknown>>; overflow: boolean }>
  >;
  close(): Promise<void>;
  blocked: string[];
  continuedNonLoopback: string[];
  cspHeaders: string[];
  workerUrls: string[];
  readonly browserVersion: Record<string, unknown>;
  readonly executablePath: string;
  readonly launchFlags: readonly string[];
  label: string | null;
  getContextEvents?(): Promise<
    Array<{ type: string; timestamp: number; target: string | null }>
  >;
}
interface OpenBrowserOptions {
  readonly label?: string;
  // Cold-start proofs need Chrome's default autoplay policy so a fresh AudioContext is
  // suspended until a real user gesture; the general harness relaxes it.
  readonly defaultAutoplay?: boolean;
  readonly recordMediaSeekTargets?: boolean;
  readonly blockWebCodecs?: boolean;
  readonly blockRequestVideoFrameCallback?: boolean;
  readonly rvfcBusyWaitMs?: number;
  readonly recordDecoderPresentation?: boolean;
  readonly recordProofTrace?: boolean;
  readonly proofSampleRate?: 44100 | 48000;
  readonly proofBorrowed?: 'lease' | 'no-lease';
  readonly proofSerialExhaustion?: boolean;
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

const decoderPresentationPrelude = String.raw`(() => {
        const key = '__relicOtioPresentation';
        const entries = () => {
                let log = Reflect.get(globalThis, key);
                if (!Array.isArray(log)) {
                        log = [];
                        Reflect.set(globalThis, key, log);
                }
                return log;
        };
        const now = () => performance.timeOrigin + performance.now();
        const frameUsOf = (video) => {
                try {
                        const frame = new VideoFrame(video);
                        const timestamp = frame.timestamp;
                        frame.close();
                        return timestamp;
                } catch {
                        return null;
                }
        };
        const stateOf = (video) => ({
                currentTime: video.currentTime,
                seeking: video.seeking,
                readyState: video.readyState,
                frameUs: frameUsOf(video),
        });
        const watchPresentations = (video, remaining) => {
                video.requestVideoFrameCallback((_now, metadata) => {
                        entries().push({
                                kind: 'rvfc',
                                at: now(),
                                ...stateOf(video),
                                mediaTime: metadata.mediaTime,
                                presentedFrames: metadata.presentedFrames,
                        });
                        if (remaining > 1) watchPresentations(video, remaining - 1);
                });
        };
        document.addEventListener(
                'seeked',
                (event) => {
                        const video = event.target;
                        if (!(video instanceof HTMLVideoElement)) return;
                        if (!video.closest('.otio-video-decoders')) return;
                        entries().push({ kind: 'seeked', at: now(), ...stateOf(video) });
                        if (typeof video.requestVideoFrameCallback === 'function') {
                                watchPresentations(video, 3);
                        }
                },
                true
        );
})();`;

// Proof-traced warm browsers get real activation only after the graph is ready.
// Explicit defaultAutoplay browsers are cold/first-gesture proofs and are never pre-activated.
const warmProofActivation = new WeakSet<ChromeSession>();

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
        ...(options.defaultAutoplay || options.recordProofTrace
          ? []
          : ['--autoplay-policy=no-user-gesture-required']),
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
    const browserVersion = await cdp.send('Browser.getVersion');
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
      options.recordDecoderPresentation ? decoderPresentationPrelude : '',
      options.recordProofTrace
        ? `globalThis.__otioProofClockMode=${JSON.stringify(clockProofMode)}; globalThis.__otioProofSampleRate=${JSON.stringify(options.proofSampleRate ?? null)}; globalThis.__otioProofBorrowedMode=${JSON.stringify(options.proofBorrowed ?? null)}; globalThis.__otioProofClockSerialExhaustion=${options.proofSerialExhaustion === true};\n${otioProofTracePrelude}`
        : '',
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
    const browser: ChromeSession = {
      blocked,
      continuedNonLoopback,
      cspHeaders,
      workerUrls,
      label,
      browserVersion,
      executablePath: found.path,
      launchFlags: launch.args.map((arg) =>
        arg.startsWith('--user-data-dir=')
          ? '--user-data-dir=<owned-profile>'
          : arg
      ),
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
      async startScreencast() {
        const frames: Array<Record<string, unknown>> = [];
        let overflow = false;
        const unsubscribe = cdp.onEvent((event) => {
          if (
            event.sessionId !== sessionId ||
            event.method !== 'Page.screencastFrame'
          )
            return;
          if (frames.length < 900) frames.push(event.params);
          else overflow = true;
          void cdp
            .send(
              'Page.screencastFrameAck',
              { sessionId: event.params['sessionId'] },
              sessionId
            )
            .catch(() => {});
        });
        try {
          await cdp.send(
            'Page.startScreencast',
            { format: 'jpeg', quality: 90, everyNthFrame: 1 },
            sessionId
          );
        } catch (error) {
          unsubscribe();
          throw error;
        }
        return async () => {
          await cdp.send('Page.stopScreencast', {}, sessionId);
          unsubscribe();
          return { frames, overflow };
        };
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
          `page evaluation failed: ${exception?.exception?.description ?? exception?.text ?? JSON.stringify(res)}`
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
    if (options.recordProofTrace && !options.defaultAutoplay)
      warmProofActivation.add(browser);
    return browser;
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
  if (warmProofActivation.has(browser)) {
    const before = await browser.evaluate<{
      state: string;
      witness: boolean;
      anchor: number | null;
      contextTime: number;
    }>(`(async () => globalThis.__otioProofTrace.preactivationState())()`);
    assert.ok(
      before.state === 'suspended' &&
        before.witness &&
        Number.isSafeInteger(before.anchor),
      `warm proof cannot activate before a suspended graph and witness exist: ${JSON.stringify(before)}`
    );
    const target = await browser.evaluate<{
      x: number;
      y: number;
      tag: string;
    }>(`(() => {
      for (let y = 4; y < Math.min(innerHeight, 200); y += 8)
        for (let x = 4; x < Math.min(innerWidth, 400); x += 8) {
          const e = document.elementFromPoint(x,y);
          if (e && !e.closest('a,button,input,select,textarea,[role=button],[contenteditable],canvas,video,audio'))
            return {x,y,tag:e.tagName};
        }
      throw new Error('no non-interactive activation target');
    })()`);
    await clickWithRealPointer(browser, target.x, target.y);
    const activated = await browser.evaluate<boolean>(
      'navigator.userActivation.hasBeenActive'
    );
    assert.ok(
      activated,
      `trusted warm activation did not reach the page: ${JSON.stringify(target)}`
    );
    warmProofActivation.delete(browser);
  }
  return ready;
}

let coldSeekReceiptNumber = 0;

async function seekTo(browser: ChromeSession, frame: number): Promise<void> {
  const landed = await browser.evaluate<boolean>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const seek = document.querySelector('input.otio-seek');
    const root = document.querySelector('.otio-view');
    if (!(seek instanceof HTMLInputElement) || !(root instanceof HTMLElement)) { resolve(false); return promise; }
    const origin = Number(root.dataset.domainOrigin);
    if (!Number.isFinite(origin)) { resolve(false); return promise; }
    const ids = new WeakMap(), sources = new Map();
    let nextId = 0, overflow = false;
    const events = [];
    const snapshot = (node) => {
      if (!ids.has(node)) ids.set(node, nextId++);
      const source = node.currentSrc || node.src || '';
      if (source && !sources.has(source)) sources.set(source, sources.size);
      return {id:ids.get(node), sourceId:source ? sources.get(source) : null,
        bundlePath:node.dataset.bundlePath ?? null, tag:node.tagName,
        readyState:node.readyState, networkState:node.networkState,
        seeking:node.seeking, currentTime:node.currentTime, paused:node.paused,
        error:node.error?.code ?? null};
    };
    const nodes = () => [...document.querySelectorAll('.otio-video-decoders video,.otio-audio-graph audio')].map(snapshot);
    const before = nodes();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    if (!descriptor?.get || !descriptor.set || !descriptor.configurable) {
      resolve(false); return promise;
    }
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...descriptor,
      set(value) {
        const prior = descriptor.get.call(this);
        descriptor.set.call(this, value);
        if (events.length >= 10000) overflow = true;
        else events.push({type:'assigned-currentTime', timestamp:performance.now(),
          target:Number(value), prior, media:snapshot(this)});
      },
    });
    const onEvent = (event) => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      if (events.length >= 10000) {overflow = true; return;}
      events.push({type:event.type, timestamp:performance.now(), media:snapshot(event.target)});
    };
    const eventTypes = ['loadstart','loadedmetadata','loadeddata','canplay','seeking','seeked','waiting','playing','pause','error','abort','emptied'];
    for (const type of eventTypes) document.addEventListener(type, onEvent, true);
    const finish = (landed) => {
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', descriptor);
      for (const type of eventTypes) document.removeEventListener(type, onEvent, true);
      globalThis.__otioSeekEvidence = {before, after:nodes(), events, overflow, landed};
      resolve(landed);
    };
    seek.value = String(${frame} - origin);
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    const start = Date.now();
    const tick = () => {
      const root = document.querySelector('.otio-view');
      if (root && root.dataset.buffering === 'false' && Number(root.dataset.frame) === ${frame}) finish(true);
      else if (Date.now() - start > 12000) finish(false);
      else setTimeout(tick, 50);
    };
    tick();
    return promise;
  })()`);
  if (landed && browser.label === 'post-gain-calibration') {
    const evidence = await browser.evaluate<unknown>(
      'globalThis.__otioSeekEvidence ?? null'
    );
    await writeFile(
      join(shotDir, `seek-success-${++coldSeekReceiptNumber}.json`),
      JSON.stringify({ frame, evidence })
    );
  }
  if (!landed) {
    const state = await browser.evaluate<Record<string, unknown>>(`(() => {
      const root = document.querySelector('.otio-view');
      const seek = document.querySelector('input.otio-seek');
      return {dataset: root ? {...root.dataset} : null,
        seek: seek instanceof HTMLInputElement ? {value:seek.value, min:seek.min, max:seek.max} : null,
        status: document.querySelector('.otio-preview-status')?.textContent ?? null,
        seekEvidence: globalThis.__otioSeekEvidence ?? null};
    })()`);
    await writeFile(
      join(shotDir, 'seek-failure.json'),
      JSON.stringify({ frame, state })
    );
    await browser.screenshot('seek-failed');
    console.error('OTIO_SEEK_FAILURE', JSON.stringify({ frame, state }));
  }
  assert.equal(
    landed,
    true,
    `seek to frame ${frame} did not settle on a decoded frame`
  );
}

// Pauses playback from its own evaluate, after a capture's result has been returned. A capture
// returns tens of megabytes of trace. Serialising it blocks the page for longer than the
// transport closure watchdog, so a pause clicked just before that return is judged late and
// the viewer reports "transport gate closure was not acknowledged". Returns the diagnostics
// the reader sees once the pause has settled.
async function pausePlayback(browser: ChromeSession): Promise<string> {
  return browser.evaluate<string>(`(async () => {
    const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
    const root = document.querySelector('.otio-view');
    const button = document.querySelector('button.otio-play');
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('pause controls missing');
    if (root.dataset.playing === 'true') button.click();
    const deadline = performance.now() + 3000;
    while ((root.dataset.playing === 'true' || root.dataset.buffering === 'true') && performance.now() < deadline) await sleep(20);
    await sleep(250);
    return Array.from(document.querySelectorAll('.otio-diagnostic')).map(node => node.textContent ?? '').join(' ');
  })()`);
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

async function canvasMiddleRow(browser: ChromeSession): Promise<number[]> {
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
  return row;
}

async function canvasRowCenter(browser: ChromeSession): Promise<number> {
  const row = await canvasMiddleRow(browser);
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
  // Coincident marks live in the live timeline, so this is a legacy archive
  // too. Each legacy publish is a new relic.
  const shareUrl = await publishLegacyDirectory(
    fixtureDir,
    'OTIO coincident comment reveal proof'
  );
  const relicId = new URL(shareUrl).pathname.split('/').filter(Boolean).at(-1);
  assert.ok(relicId, 'auxiliary publish returned no relic_id');
  const initialClock = loopbackNow;
  let completedUiPosts = 0;
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
    await assertLegacyProgramState(browser, 'auxiliary-coincident-comment');
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
    for (const body of bodies) {
      await selectTrack(
        browser,
        plan.duplicate_track_id,
        'point',
        plan.duplicate_frame,
        plan.duplicate_frame
      );
      await postComposer(browser, body);
      completedUiPosts += 1;
    }
    assert.equal(
      loopbackNow,
      initialClock,
      'comment burst advanced server clock'
    );
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
            clock: { initialClock, finalNow: loopbackNow, completedUiPosts },
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

// Publishes a manifest-free legacy archive through the app's public challenge, grant,
// upload and complete endpoints. It repeats publish()'s legs without the program build,
// so this proof can produce the pre-program layout the viewer resolves as legacy. The
// absence of any program entry is checked on the bytes before anything is encrypted.
// The relic is then recorded in the MCP's publish state exactly as publish() records
// one, so the MCP can read its comments and republish it by relic_id.
async function publishLegacyDirectory(
  directory: string,
  title: string
): Promise<string> {
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    fetch: globalThis.fetch,
    upload: nodeUploader,
    clientName: 'relic-mcp/legacy-proof',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'legacy proof fixture',
    }),
  };
  const source = await readSource(directory, nodeFiles);
  const index = await indexOtioZip(source.bytes);
  for (const info of index.entries.values()) {
    assert.ok(
      info.name !== OTIO_PROGRAM_MANIFEST_ENTRY &&
        (info.isDirectory || !info.name.startsWith('relic/program')),
      `legacy fixture carries program entry ${info.name}; it is not a legacy archive`
    );
  }
  const challenge = await postJson(deps, `${origin}/api/challenge`, {});
  const sizeLimit = Number(challenge['size_limit_bytes']);
  assert.ok(
    source.bytes.length <= sizeLimit,
    'legacy fixture exceeds the app size cap'
  );
  const filename = source.basename;
  const rendererClass = deriveRendererClass(source.bytes, filename);
  const relicId = generateRelicId();
  const key = generateKey();
  const container = await encryptRelic({
    content: source.bytes,
    filename,
    mimetype: guessMimetype(filename, rendererClass),
    key,
  });
  const grant = await postJson(deps, `${origin}/api/grant`, {
    challenge_nonce: challenge['challenge_nonce'],
    relic_id: relicId,
    renderer_class: rendererClass,
    publishing_client: deps.clientName,
    declared_size_bytes: source.bytes.length,
    declared_ciphertext_bytes: container.length,
    title,
    share_verifier: await shareVerifierFor(await deriveShareProof(key)),
  });
  const publishToken = grant['publish_token'];
  assert.ok(
    typeof publishToken === 'string' && publishToken.length > 0,
    'legacy grant carried no publish token'
  );
  await putContainer(deps, relicId, String(grant['upload_url']), container);
  const complete = await reportComplete(deps, relicId);
  const serverDigest = complete?.['version_digest'];
  const localDigest = await versionDigest(container);
  assert.ok(
    typeof serverDigest !== 'string' || serverDigest === localDigest,
    'legacy archive version digest disagrees with the server'
  );
  const url = relicUrl(origin, relicId, key);
  assert.ok(
    url.startsWith(origin) && url.includes('#'),
    'legacy publish left loopback or lost its key'
  );
  process.env['RELIC_PUBLISH_STATE'] = statePath;
  await savePublishState(relicId, {
    key: encodeKey(key),
    publish_token: publishToken,
    version: 1,
    filename,
    published_at: new Date().toISOString(),
  });
  return url;
}

// Reads what the viewer resolved for this composition: the program state, its first
// reason, and the ready flag. Read only after waitReady has settled.
async function readProgramState(browser: ChromeSession): Promise<{
  state: string | null;
  reason: string | null;
  ready: string | null;
}> {
  return browser.evaluate<{
    state: string | null;
    reason: string | null;
    ready: string | null;
  }>(`(() => {
    const view = document.querySelector('.otio-view');
    return {
      state: view?.dataset.otioProgramState ?? null,
      reason: view?.dataset.otioProgramReason ?? null,
      ready: view?.dataset.ready ?? null,
    };
  })()`);
}

// The legacy fixture must reach the viewer as the legacy program state, so the original
// live-player and controller path is what the proof exercises.
async function assertLegacyProgramState(
  browser: ChromeSession,
  label: string
): Promise<void> {
  const observed = await readProgramState(browser);
  assert.equal(
    observed.state,
    'legacy',
    `${label} legacy fixture resolved to program state ${observed.state} (reason ${observed.reason})`
  );
}

// Media kinds of a document's external references. A timeline with a Video-kinded track
// can still carry only audio media: scheduled-audio's Video track holds clips that all
// point at a 48 kHz stereo WAV, while the timeline runs at 30 edit units per second. No
// video source means no certified video cadence, so the publisher's program is invalid
// timing. The focus-only check decides the macOS expectation from these media kinds, never
// from the observed state.
const AUDIO_MEDIA = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac)$/i;
function mediaTargets(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) mediaTargets(item, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (
    record['OTIO_SCHEMA'] === 'ExternalReference.1' &&
    typeof record['target_url'] === 'string'
  )
    out.push(record['target_url']);
  for (const value of Object.values(record)) mediaTargets(value, out);
  return out;
}
// True only when every referenced media is audio-only. A document with no media, or any
// non-audio media, is not audio-only, so the program expectation applies to it.
function isAudioOnlyDocument(document: unknown): boolean {
  const targets = mediaTargets(document);
  return (
    targets.length > 0 && targets.every((target) => AUDIO_MEDIA.test(target))
  );
}

// The real new-publish output, checked separately from the legacy fixture. On Linux the
// publisher cannot render a program, so the view must show the timeline unavailable with
// its reason. On macOS the publisher renders one, so the program must be playable. Both
// branches assert; neither skips.
async function runFocusOnlyPublishCheck(
  sessionToken: string,
  directory: string
): Promise<void> {
  const url = await publishNewDirectory('focus-only-publish', directory);
  const browser = await openBrowser(url, sessionToken, {
    label: 'focus-only-publish',
    recordProofTrace: false,
  });
  try {
    await waitReady(browser);
    const observed = await readProgramState(browser);
    if (process.platform === 'linux') {
      assert.equal(
        observed.state,
        'unavailable',
        `Linux publish was not focus-only: program state ${observed.state}`
      );
      assert.equal(
        observed.reason,
        'unsupported-browser',
        `Linux focus-only reason was ${observed.reason}`
      );
      assert.equal(
        observed.ready,
        'diagnostic',
        'Linux focus-only view did not render its diagnostic'
      );
    } else {
      const document = JSON.parse(
        await readFile(join(directory, 'content.otio'), 'utf8')
      ) as unknown;
      if (!isAudioOnlyDocument(document)) {
        assert.equal(
          observed.state,
          'program',
          `macOS publish of a video timeline did not render a playable program: ${observed.state} (${observed.reason})`
        );
      } else {
        // Characterized fixture: every referenced media is audio (48 kHz stereo WAV) on a
        // 30 edit-unit timeline. No video source means no certified video cadence, so the
        // publisher's truthful result is exactly unavailable with reason invalid-timing.
        // Any other state or reason fails. A document with video media still requires program.
        assert.equal(
          observed.state,
          'unavailable',
          `audio-only macOS publish resolved to ${observed.state} (${observed.reason}), not unavailable`
        );
        assert.equal(
          observed.reason,
          'invalid-timing',
          `audio-only macOS publish reason was ${observed.reason}, not invalid-timing`
        );
        console.log(
          'OTIO_FOCUS_AUDIO_ONLY_FALLBACK state=unavailable reason=invalid-timing'
        );
      }
    }
  } finally {
    await browser.close();
  }
}

// A real publish through the MCP, program build included.
async function publishNewDirectory(
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

// The decoder proofs time the live player's own decoders, which only a legacy
// archive reaches, so their fixtures are published without a program.
async function publishDecoderDirectory(
  name: string,
  directory: string
): Promise<string> {
  return publishLegacyDirectory(directory, `OTIO timing proof ${name}`);
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

interface PacketCanvasCase {
  readonly label: string;
  readonly file: string;
  readonly seconds: number;
  readonly includeFinal: boolean;
}

interface NearFrame {
  readonly frame: number;
  readonly rmse: number;
}

interface PacketCanvasVerdict {
  readonly failure: string | undefined;
  readonly toCorrect: number;
  readonly toWrong: number | null;
  readonly toBlack: number;
  readonly canvasBlack: boolean;
  readonly referenceBlack: boolean;
  readonly nearest: readonly NearFrame[];
  readonly nearestWrong: number | null;
}

interface DecoderSnapshot {
  readonly index: number;
  readonly currentTime: number;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly paused: boolean;
  readonly frameUs: number | null;
}

interface DecoderPresentationEntry {
  readonly kind: 'seeked' | 'rvfc';
  readonly at: number;
  readonly currentTime: number;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly frameUs: number | null;
  readonly mediaTime?: number;
  readonly presentedFrames?: number;
}

// The seven decoder items seeked and measured in the known-file browser.
const KNOWN_PACKET_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly frame: number;
  readonly file: string;
  readonly seconds: number;
}> = [
  { label: '24fps MP4', frame: 4, file: 'fr24.mp4', seconds: 4 / 24 },
  {
    label: '60fps MP4 with 24-rate source',
    frame: 52,
    file: 'fr60.mp4',
    seconds: 4 / 24,
  },
  { label: 'rate-one source', frame: 100, file: 'fr24.mp4', seconds: 1 / 6 },
  { label: '29.97-rate source', frame: 148, file: 'fr24.mp4', seconds: 1 / 6 },
  { label: 'B-frame MP4', frame: 196, file: 'fr24b.mp4', seconds: 4 / 24 },
  { label: 'B-frame MOV', frame: 244, file: 'fr24b.mov', seconds: 4 / 24 },
  { label: 'VFR MP4', frame: 291, file: 'vfr.mp4', seconds: 3 / 24 },
];

// Every packet-canvas assertion in the decoder proof, replayed by the startup gate check.
const PACKET_GATE_CASES: readonly PacketCanvasCase[] = [
  ...KNOWN_PACKET_ITEMS.map(({ label, file, seconds }) => ({
    label,
    file,
    seconds,
    includeFinal: true,
  })),
  {
    label: 'quantized WebM 2/30',
    file: 'fr30.webm',
    seconds: 2 / 30,
    includeFinal: false,
  },
  {
    label: 'representational zero first frame',
    file: 'fr24.mp4',
    seconds: 0,
    includeFinal: true,
  },
  {
    label: 'available-origin/cut witness first frame',
    file: 'fr30.webm',
    seconds: 0,
    includeFinal: false,
  },
  {
    label: 'available-origin/cut witness second frame',
    file: 'fr30.webm',
    seconds: 1 / 30,
    includeFinal: false,
  },
  {
    label: 'no-DefaultDuration earlier window',
    file: 'no-duration.webm',
    seconds: 65 / 1000,
    includeFinal: false,
  },
];

const PACKET_DISTINCT_RMSE = 4;
const PACKET_RIVAL_MARGIN = 2;

const DECODER_SNAPSHOT_EXPRESSION = String.raw`Array.from(document.querySelectorAll('.otio-video-decoders video'), (video, index) => {
        let frameUs = null;
        try {
                const frame = new VideoFrame(video);
                frameUs = frame.timestamp;
                frame.close();
        } catch {}
        return {
                index,
                currentTime: video.currentTime,
                seeking: video.seeking,
                readyState: video.readyState,
                paused: video.paused,
                frameUs,
        };
})`;

const decodedFixtureCache = new Map<string, Promise<readonly Uint8Array[]>>();

// Each fixture is decoded once; the result is one RGBA frame per decoded picture, in presentation order.
function cachedFixtureFrames(fileName: string): Promise<readonly Uint8Array[]> {
  let frames = decodedFixtureCache.get(fileName);
  if (!frames) {
    frames = decodeFixtureFrames(fileName);
    decodedFixtureCache.set(fileName, frames);
  }
  return frames;
}

async function decodeFixtureFrames(
  fileName: string
): Promise<readonly Uint8Array[]> {
  const oracle = await readDecoderTimingOracle();
  const expectedCount = oracle.files?.[fileName]?.frames?.length ?? 0;
  assert.ok(expectedCount > 0, `ffprobe oracle has no frames for ${fileName}`);
  const result = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(decoderMediaDir, fileName),
      '-vf',
      `scale=${width}:${height}:flags=neighbor`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 60000 }
  );
  assert.equal(
    result.exit,
    0,
    `ffmpeg could not decode ${fileName}: ${result.stderr}`
  );
  const frameBytes = width * height * 4;
  assert.equal(
    result.stdout.length % frameBytes,
    0,
    `${fileName} decoded to ${result.stdout.length} bytes, not whole frames`
  );
  const count = result.stdout.length / frameBytes;
  assert.equal(
    count,
    expectedCount,
    `${fileName} decoded ${count} frames; ffprobe oracle has ${expectedCount}`
  );
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    frames.push(
      new Uint8Array(
        result.stdout.buffer,
        result.stdout.byteOffset + index * frameBytes,
        frameBytes
      )
    );
  }
  return frames;
}

/**
 * Scores a canvas against every decoded frame. Each existing assertion keeps
 * its message and order; the first violated rule is returned as `failure`.
 * Rule b: for every frame f whose distance to the expected frame exceeds
 * PACKET_DISTINCT_RMSE, the canvas must sit at least PACKET_RIVAL_MARGIN
 * closer to the expected frame than to f.
 */
function scorePacketCanvas(input: {
  readonly label: string;
  readonly canvas: Uint8Array;
  readonly decoded: readonly Uint8Array[];
  readonly expectedFrame: number;
  readonly neighborFrame: number | undefined;
}): PacketCanvasVerdict {
  const { label, canvas, decoded, expectedFrame, neighborFrame } = input;
  const correct = decoded[expectedFrame];
  assert.ok(
    correct,
    `${label} expected frame ${expectedFrame} was never decoded`
  );
  const scores = decoded.map((pixels) => rmse(canvas, pixels));
  const toCorrect = scores[expectedFrame] as number;
  const wrong =
    neighborFrame === undefined ? undefined : decoded[neighborFrame];
  const toWrong =
    neighborFrame === undefined ? null : (scores[neighborFrame] as number);
  const blackFrame = new Uint8Array(correct.length);
  for (let i = 0; i < blackFrame.length; i += 4) {
    blackFrame[i + 3] = 255;
  }
  const toBlack = rmse(canvas, blackFrame);
  const canvasBlack = isOpaqueBlack(canvas);
  const referenceBlack = isOpaqueBlack(correct);
  const nearest = scores
    .map((score, frame) => ({ frame, rmse: score }))
    .sort((a, b) => a.rmse - b.rmse)
    .slice(0, 3);
  let rival: NearFrame | undefined;
  for (let frame = 0; frame < decoded.length; frame++) {
    const pixels = decoded[frame];
    if (!pixels || !(rmse(pixels, correct) > PACKET_DISTINCT_RMSE)) continue;
    const score = scores[frame] as number;
    if (rival === undefined || score < rival.rmse) {
      rival = { frame, rmse: score };
    }
  }
  let failure: string | undefined;
  if (referenceBlack) {
    failure = `${label} reference frame cannot distinguish decoded media from withheld black`;
  } else if (canvasBlack) {
    failure = `${label} painted opaque black instead of decoded media`;
  } else if (neighborFrame === undefined || wrong === undefined) {
    failure = `${label} needs an adjacent ffprobe presentation frame`;
  } else if (!(rmse(correct, wrong) > PACKET_DISTINCT_RMSE)) {
    failure = `${label} fixture frames ${expectedFrame} and ${neighborFrame} are not distinct`;
  } else if (!(toCorrect + PACKET_RIVAL_MARGIN < (toWrong as number))) {
    failure = `${label} canvas is not ffprobe frame ${expectedFrame} (correct ${toCorrect}, adjacent ${toWrong})`;
  } else if (
    rival !== undefined &&
    !(toCorrect + PACKET_RIVAL_MARGIN < rival.rmse)
  ) {
    failure = `${label} canvas is closer to ffprobe frame ${rival.frame} (${rival.rmse.toFixed(2)}) than to expected frame ${expectedFrame} (${toCorrect.toFixed(2)})`;
  }
  return {
    failure,
    toCorrect,
    toWrong,
    toBlack,
    canvasBlack,
    referenceBlack,
    nearest,
    nearestWrong: rival?.frame ?? neighborFrame ?? null,
  };
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
  const neighbor =
    windows.find((window) => window.frame === expected.frame + 1) ??
    windows.find((window) => window.frame === expected.frame - 1);
  const canvas = await sampleCanvas(browser, width, height);
  const decodersAtSample = await browser.evaluate<DecoderSnapshot[]>(
    DECODER_SNAPSHOT_EXPRESSION
  );
  const decoded = await cachedFixtureFrames(fileName);
  const verdict = scorePacketCanvas({
    label,
    canvas,
    decoded,
    expectedFrame: expected.frame,
    neighborFrame: neighbor?.frame,
  });
  // Chromium may repaint after `seeked`; a second sample one frame later records that as data.
  const resampled = await resampleCanvas(browser, width, height);
  const presentationLog = await readDecoderPresentation(browser);
  await recordPacketCanvasMeasurement({
    label,
    file_name: fileName,
    source_seconds: sourceSeconds,
    expected_frame: expected.frame,
    expected_start_us: expected.start * 1e6,
    neighbor_frame: neighbor?.frame ?? null,
    nearest_frames: verdict.nearest,
    decoder_count: decodersAtSample.length,
    decoders_at_sample: decodersAtSample,
    presentation_log: presentationLog,
    resample_rmse: rmse(canvas, resampled),
    canvas_black: verdict.canvasBlack,
    reference_black: verdict.referenceBlack,
    rmse_correct: verdict.toCorrect,
    rmse_wrong: verdict.toWrong,
    rmse_black: verdict.toBlack,
  });
  try {
    assert.equal(
      verdict.failure,
      undefined,
      verdict.failure ?? 'packet canvas mismatch'
    );
    await assertNoTimingFallback(browser, label);
  } catch (error) {
    await writePacketGateFailure({
      label,
      canvas,
      decoded,
      expectedFrame: expected.frame,
      nearestWrongFrame: verdict.nearestWrong,
    });
    throw error;
  }
  return expected;
}

async function assertNoTimingFallback(
  browser: ChromeSession,
  label: string
): Promise<void> {
  assert.equal(
    (await timingDiagnostics(browser)).includes('invalid-timing'),
    false,
    `${label} used a diagnostic fallback instead of a certified packet window`
  );
}

/**
 * Startup check with no browser: the gate must accept the true frame and reject
 * frame 0 and frames N-1 and N+1 for every packet-canvas assertion.
 */
async function assertPacketGateRejectsPlantedFrames(): Promise<void> {
  let rejected = 0;
  for (const item of PACKET_GATE_CASES) {
    const windows = await packetWindows(item.file, item.includeFinal);
    const expected = windowForSeconds(windows, item.seconds, item.label);
    const decoded = await cachedFixtureFrames(item.file);
    const neighbor =
      windows.find((window) => window.frame === expected.frame + 1) ??
      windows.find((window) => window.frame === expected.frame - 1);
    const correct = decoded[expected.frame];
    assert.ok(correct, `${item.label} expected frame was never decoded`);
    const control = scorePacketCanvas({
      label: `${item.label} control`,
      canvas: correct,
      decoded,
      expectedFrame: expected.frame,
      neighborFrame: neighbor?.frame,
    });
    assert.equal(
      control.failure,
      undefined,
      `startup gate rejected the correct frame: ${control.failure}`
    );
    const planted = new Set([0, expected.frame - 1, expected.frame + 1]);
    planted.delete(expected.frame);
    for (const frame of planted) {
      const pixels = decoded[frame];
      if (pixels === undefined) continue;
      const verdict = scorePacketCanvas({
        label: `${item.label} planted frame ${frame}`,
        canvas: pixels,
        decoded,
        expectedFrame: expected.frame,
        neighborFrame: neighbor?.frame,
      });
      assert.match(
        verdict.failure ?? '',
        /is not ffprobe frame|is closer to ffprobe frame/,
        `startup gate accepted planted frame ${frame} for ${item.label}`
      );
      rejected++;
    }
  }
  console.log(
    `PACKET_GATE_NEGATIVE_CONTROLS cases=${PACKET_GATE_CASES.length} rejected=${rejected}`
  );
}

async function clearDecoderPresentation(browser: ChromeSession): Promise<void> {
  await browser.evaluate<void>(`(() => {
                globalThis.__relicOtioPresentation = [];
        })()`);
}

async function readDecoderPresentation(
  browser: ChromeSession
): Promise<readonly DecoderPresentationEntry[]> {
  return browser.evaluate<DecoderPresentationEntry[]>(
    `(globalThis.__relicOtioPresentation ?? []).slice()`
  );
}

async function resampleCanvas(
  browser: ChromeSession,
  width: number,
  height: number
): Promise<SampledCanvas> {
  await browser.evaluate<boolean>(`new Promise((resolve) => {
                const timer = setTimeout(() => resolve(false), 1000);
                requestAnimationFrame(() => {
                        clearTimeout(timer);
                        resolve(true);
                });
        })`);
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 200);
  await promise;
  return sampleCanvas(browser, width, height);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC32_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  chunk.set(data, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length
  );
  return chunk;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  assert.equal(rgba.length, width * height * 4, 'PNG pixels are not RGBA');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

async function writePacketGateFailure(input: {
  readonly label: string;
  readonly canvas: Uint8Array;
  readonly decoded: readonly Uint8Array[];
  readonly expectedFrame: number;
  readonly nearestWrongFrame: number | null;
}): Promise<void> {
  try {
    await mkdir(shotDir, { recursive: true });
    const slug = input.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const wrong =
      input.nearestWrongFrame === null
        ? undefined
        : input.decoded[input.nearestWrongFrame];
    const shots: Array<[string, Uint8Array | undefined]> = [
      [`${slug}-canvas.png`, input.canvas],
      [
        `${slug}-expected-f${input.expectedFrame}.png`,
        input.decoded[input.expectedFrame],
      ],
      [`${slug}-nearest-wrong-f${input.nearestWrongFrame}.png`, wrong],
    ];
    for (const [name, pixels] of shots) {
      if (pixels) {
        await writeFile(join(shotDir, name), encodePng(width, height, pixels));
      }
    }
  } catch (error) {
    console.error(
      `could not write packet-canvas failure PNGs for ${input.label}: ${String(error)}`
    );
  }
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

async function assertQuantizedMovingOracle(): Promise<void> {
  const windows = await packetWindows('fr30.webm', false);
  const decoded = await decodeFixtureFrames('fr30.webm');
  const cases = [
    { seconds: 2 / 30, frame: 1 },
    { seconds: (3.995 + 6) / 30, frame: 10 },
    { seconds: 0.333 - 0.000003, frame: 9 },
    { seconds: 0.333, frame: 10 },
    { seconds: 0.333 + 0.000003, frame: 10 },
  ];
  for (const witness of cases) {
    const expected = windowForSeconds(
      windows,
      witness.seconds,
      'quantized witness'
    );
    assert.equal(
      expected.frame,
      witness.frame,
      `wrong packet for ${witness.seconds}`
    );
    const adjacent = witness.frame - 1;
    assert.ok(adjacent >= 0);
    const good = scorePacketCanvas({
      label: 'quantized witness',
      canvas: decoded[witness.frame]!,
      decoded,
      expectedFrame: expected.frame,
      neighborFrame: adjacent,
    });
    const stale = scorePacketCanvas({
      label: 'quantized stale control',
      canvas: decoded[adjacent]!,
      decoded,
      expectedFrame: expected.frame,
      neighborFrame: adjacent,
    });
    assert.equal(
      good.failure,
      undefined,
      `correct packet rejected at ${witness.seconds}: ${good.failure}`
    );
    assert.ok(stale.failure, `adjacent packet accepted at ${witness.seconds}`);
  }
  console.log(`OTIO_QUANTIZED_ORACLE_OK witnesses=${cases.length}`);
}

async function runDecoderTimingProof(sessionToken: string): Promise<void> {
  const knownUrl = await publishDecoderDirectory('known', decoderFixtureDir);
  const knownBrowser = await openBrowser(knownUrl, sessionToken, {
    blockWebCodecs: true,
    label: 'decoder-known',
    recordDecoderPresentation: true,
  });
  try {
    assert.equal(
      await waitReady(knownBrowser),
      'true',
      'known packet-window fixture did not reach decoded ready state'
    );
    await assertLegacyProgramState(knownBrowser, 'decoder-known');
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

    for (const item of KNOWN_PACKET_ITEMS) {
      await clearDecoderPresentation(knownBrowser);
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
    recordDecoderPresentation: true,
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
    await clearDecoderPresentation(webmBrowser);
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
    recordDecoderPresentation: true,
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
    await clearDecoderPresentation(nearZeroBrowser);
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
    { label: 'strict-negative', recordDecoderPresentation: true }
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
    { label: 'available-origin-cut', recordDecoderPresentation: true }
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
    await clearDecoderPresentation(availableOriginCutBrowser);
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
    await clearDecoderPresentation(availableOriginCutBrowser);
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
    recordDecoderPresentation: true,
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
    recordDecoderPresentation: true,
    label: 'decoder-no-duration',
  });
  try {
    assert.equal(await waitReady(noDurationBrowser), 'true');
    await clearDecoderPresentation(noDurationBrowser);
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
class DecoderOnlyComplete extends Error {}
class InteractionOnlyComplete extends Error {}
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
            divider: '.otio-resize-handle', transport: '.otio-transport', heading: '.otio-timeline-heading',
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
          const { stage, root, monitor, divider, transport, heading, timeline, readout, diagnostics, preview, canvas } = rectangles;
          const stageBottom = stage.top + nodes.stage.clientTop + nodes.stage.clientHeight;
          const near = (a, b, name) => { if (Math.abs(a - b) > 2) failures.push(name + ': ' + a + ' vs ' + b); };
          near(root.bottom, stageBottom, 'bottom fill');
          const diagnosticsVisible = nodes.diagnostics.children.length > 0 && diagnostics.height > 0;
          near(diagnosticsVisible ? diagnostics.bottom : readout.bottom, root.bottom, 'bottom stack');
          near(monitor.bottom, divider.top, 'monitor/divider adjacency');
          near(divider.bottom, transport.top, 'divider/transport adjacency');
          if (divider.height < 12) failures.push('divider hit target too small');
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
async function exerciseViewerResize(browser: ChromeSession): Promise<void> {
  type ResizeGeometry = {
    x: number;
    y: number;
    preview: number;
    tracks: number;
    role: string | null;
    label: string | null;
    overflow: boolean;
  };
  const measure = () =>
    browser.evaluate<ResizeGeometry>(`(() => {
      const handle = document.querySelector('.otio-resize-handle');
      const preview = document.querySelector('.otio-monitor-row');
      const tracks = document.querySelector('.otio-timeline-scroll');
      if (!(handle instanceof HTMLElement) || !(preview instanceof HTMLElement) ||
          !(tracks instanceof HTMLElement)) throw new Error('OTIO resize controls missing');
      const rect = handle.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        preview: preview.getBoundingClientRect().height,
        tracks: tracks.getBoundingClientRect().height,
        role: handle.getAttribute('role'), label: handle.getAttribute('aria-label'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
  for (const [width, height] of [
    [1440, 900],
    [320, 480],
  ] as const) {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await browser.evaluate<void>(`(async () => {
      const { promise, resolve } = Promise.withResolvers();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      await promise;
      document.querySelector('.otio-resize-handle')?.focus();
    })()`);
    for (const type of ['rawKeyDown', 'keyUp'])
      await browser.send('Input.dispatchKeyEvent', {
        type,
        key: 'End',
        code: 'End',
        windowsVirtualKeyCode: 35,
      });
    const before = await measure();
    assert.equal(
      before.role,
      'separator',
      'resize control must expose separator role'
    );
    assert.ok(before.label, 'resize control needs an accessible label');
    assert.equal(before.overflow, false, 'resize caused page overflow');
    const delta = height < 600 ? 35 : 100;
    if (width < 600) {
      await browser.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: before.x, y: before.y }],
      });
      await browser.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: before.x, y: before.y - delta }],
      });
      await browser.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    } else {
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: before.x,
        y: before.y,
        button: 'none',
      });
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: before.x,
        y: before.y,
        button: 'left',
        clickCount: 1,
      });
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: before.x,
        y: before.y - delta,
        button: 'left',
        buttons: 1,
      });
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: before.x,
        y: before.y - delta,
        button: 'left',
        clickCount: 1,
      });
    }
    const after = await measure();
    assert.ok(
      after.preview < before.preview - 5,
      `${width}px drag did not shrink preview: ${JSON.stringify({ before, after })}`
    );
    assert.ok(
      after.tracks > before.tracks + 5,
      `${width}px drag did not reveal more tracks: ${JSON.stringify({ before, after })}`
    );
    assert.equal(
      after.overflow,
      false,
      `${width}px resize caused page overflow`
    );
    await browser.screenshot(`resize-${width}-timeline`);
    const focused = await browser.evaluate<boolean>(`(() => {
      const handle = document.querySelector('.otio-resize-handle');
      if (!(handle instanceof HTMLElement)) return false;
      handle.focus(); return document.activeElement === handle;
    })()`);
    assert.ok(focused, `${width}px resize control cannot be focused`);
    for (const type of ['rawKeyDown', 'keyUp'])
      await browser.send('Input.dispatchKeyEvent', {
        type,
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
      });
    const keyboard = await measure();
    assert.ok(
      keyboard.preview > after.preview && keyboard.tracks < after.tracks,
      `${width}px keyboard resize did not restore preview space`
    );
  }
}

const focusedCommentBody = 'Focus the primary grade, not the overlay.';

async function focusItem(
  browser: ChromeSession,
  id: string,
  method: 'pointer' | 'Enter' | ' ' = 'pointer'
): Promise<void> {
  // A focused view draws only the focused clip and what it contains. A target
  // outside it is reached the way a reviewer reaches it: back to the
  // composition first.
  const outsideFocus = await browser.evaluate<boolean>(`(() => {
    const root = document.querySelector('.otio-view');
    const item = [...document.querySelectorAll('.otio-item')]
      .find(node => node.dataset.itemId === ${JSON.stringify(id)});
    return Boolean(root?.dataset.scopeNodeId) && item instanceof HTMLElement &&
      item.getClientRects().length === 0;
  })()`);
  if (outsideFocus) await leaveFocus(browser);
  const target = await browser.evaluate<{
    x: number;
    y: number;
    hit: string;
    rect: { left: number; right: number; top: number; bottom: number };
  } | null>(`(() => {
    const item = [...document.querySelectorAll('.otio-item')]
      .find(node => node.dataset.itemId === ${JSON.stringify(id)});
    if (!(item instanceof HTMLButtonElement)) return null;
    item.scrollIntoView({block: 'center', inline: 'center'});
    item.focus({preventScroll: true});
    const rect = item.getBoundingClientRect();
    const bounds = {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
    for (const fy of [.5, .7, .3, .85, .15]) {
      for (const fx of [.5, .25, .75, .1, .9]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit === item || item.contains(hit)) return {x, y, hit: hit?.outerHTML ?? '', rect: bounds};
      }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      hit: hit?.outerHTML?.slice(0, 500) ?? '', rect: bounds};
  })()`);
  assert.ok(target, `focus target ${id} missing`);
  assert.ok(
    target.hit.includes('data-item-id=') && target.hit.includes(id),
    `focus target ${id} is occluded: ${JSON.stringify(target)}`
  );
  await browser.evaluate<void>(`(() => {
    const events = [];
    const handler = event => events.push({
      type: event.type, trusted: event.isTrusted,
      target: event.target?.outerHTML?.slice(0, 300) ?? '',
      x: event.clientX, y: event.clientY
    });
    window.__otioFocusEvents = events;
    window.__otioFocusEventHandler = handler;
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, handler, true);
  })()`);
  if (method === 'pointer')
    await clickWithRealPointer(browser, target.x, target.y);
  else {
    const code = method === ' ' ? 'Space' : 'Enter';
    const keyCode = method === ' ' ? 32 : 13;
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: method,
      code,
      text: method === 'Enter' ? '\r' : ' ',
      windowsVirtualKeyCode: keyCode,
    });
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: method,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }
  const state = await browser.evaluate<{
    id: string;
    pressed: string;
    title: string;
  }>(`(async () => {
    const start = Date.now();
    while (Date.now() - start < 12000) {
      const root = document.querySelector('.otio-view');
      const item = [...document.querySelectorAll('.otio-item')]
        .find(node => node.dataset.itemId === ${JSON.stringify(id)});
      if (root?.dataset.scopeNodeId === ${JSON.stringify(id)} &&
          root.dataset.buffering === 'false') return {
        id: root.dataset.scopeNodeId,
        pressed: item?.getAttribute('aria-pressed') ?? '',
        title: document.querySelector('.otio-focus-title')?.textContent ?? '',
      };
      const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
    }
    return {id: document.querySelector('.otio-view')?.dataset.scopeNodeId ?? '',
      pressed: '', title: ''};
  })()`);
  const events = await browser.evaluate<unknown[]>(`(() => {
    for (const type of ['pointerdown', 'pointerup', 'click'])
      document.removeEventListener(type, window.__otioFocusEventHandler, true);
    return window.__otioFocusEvents ?? [];
  })()`);
  if (state.id !== id) {
    await browser.screenshot('focus-activation-failure');
    console.error(
      `FOCUS_ACTIVATION ${JSON.stringify({ id, method, target, state, events })}`
    );
  }
  assert.equal(state.id, id, `focus did not settle on ${id}`);
  assert.equal(state.pressed, 'true', `${id} has no accessible active state`);
  assert.ok(state.title.trim(), `${id} has no focus title`);
}

async function leaveFocus(browser: ChromeSession): Promise<void> {
  const cleared = await browser.evaluate<boolean>(`(async () => {
    const button = document.querySelector('button.otio-back-composition');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    const start = Date.now();
    while (Date.now() - start < 12000) {
      const root = document.querySelector('.otio-view');
      if (root && !root.dataset.scopeNodeId && root.dataset.buffering === 'false') return true;
      const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
    }
    return false;
  })()`);
  assert.ok(cleared, 'back to composition did not clear focus');
}

async function assertFocusedWheelZoom(
  browser: ChromeSession,
  measure = false
): Promise<Record<string, unknown> | null> {
  const before = await browser.evaluate<{
    x: number;
    y: number;
    fraction: number;
    scale: number;
    trackId: string;
    frame: string;
    rect: {
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
    };
  } | null>(`(() => {
    const scroller = document.querySelector('.otio-timeline-scroll');
    const root = document.querySelector('.otio-view');
    if (!(scroller instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
    const rail = [...root.querySelectorAll('.otio-track-rail')].find(node => {
      if (!(node instanceof HTMLElement)) return false;
      const r = node.getBoundingClientRect(), s = scroller.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > s.left && r.left < s.right &&
        r.bottom > s.top && r.top < s.bottom;
    });
    if (!(rail instanceof HTMLElement)) return null;
    const r = rail.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    const left = Math.max(r.left, s.left), right = Math.min(r.right, s.right);
    if (right <= left || r.width <= 0) return null;
    const x = left + (right - left) * .5, y = r.top + r.height * .5;
    return {x, y, trackId:rail.dataset.trackId ?? '', fraction: (x - r.left) / r.width,
      scale: Number(scroller.dataset.pixelsPerFrame), frame: root.dataset.frame ?? '',
      rect:{x:left, y:Math.max(0,r.top,s.top), width:right-left,
        height:Math.min(innerHeight,r.bottom,s.bottom)-Math.max(0,r.top,s.top), scale:devicePixelRatio}};
  })()`);
  assert.ok(
    before && Number.isFinite(before.scale) && before.scale > 0,
    'wheel zoom geometry unavailable'
  );
  const stopCast = measure ? await browser.startScreencast() : null;
  if (measure) {
    await browser.evaluate(`(() => {
      const scroller=document.querySelector('.otio-timeline-scroll');
      if (!(scroller instanceof HTMLElement)) throw new Error('wheel monitor has no scroller');
      const trace={wheel:null, raf:[], active:true, origin:performance.timeOrigin};
      globalThis.__otioWheelMeasurement=trace;
      scroller.addEventListener('wheel', event => {
        trace.wheel={timeStamp:event.timeStamp, received:performance.now(), trusted:event.isTrusted,
          deltaX:event.deltaX, deltaY:event.deltaY};
      }, {capture:true,once:true,passive:true});
      const tick=now => { if (!trace.active) return;
        trace.raf.push({now,scale:Number(scroller.dataset.pixelsPerFrame)}); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    await Bun.sleep(100);
  }
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: before.x,
    y: before.y,
    deltaX: 0,
    deltaY: -250,
  });
  const after = await browser.evaluate<{
    fraction: number;
    scale: number;
    frame: string;
    mode: string;
  } | null>(`(async () => {
    const {promise, resolve} = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(resolve)); await promise;
    const rail = [...document.querySelectorAll('.otio-track-rail')]
      .find(node => node.dataset.trackId === ${JSON.stringify(before.trackId)});
    const scroller = document.querySelector('.otio-timeline-scroll');
    const root = document.querySelector('.otio-view');
    if (!(rail instanceof HTMLElement) || !(scroller instanceof HTMLElement) ||
        !(root instanceof HTMLElement)) return null;
    const r = rail.getBoundingClientRect();
    return {fraction: (${before.x} - r.left) / r.width,
      scale: Number(scroller.dataset.pixelsPerFrame), frame: root.dataset.frame ?? '',
      mode: scroller.dataset.zoomMode ?? ''};
  })()`);
  assert.ok(after, 'wheel zoom lost timeline');
  assert.equal(after.mode, 'manual', 'wheel did not select manual zoom');
  assert.ok(
    after.scale > before.scale,
    'wheel did not increase timeline scale'
  );
  assert.ok(
    Math.abs(after.fraction - before.fraction) < 0.01,
    'wheel zoom moved time under pointer'
  );
  assert.equal(after.frame, before.frame, 'wheel zoom sought playback');
  if (!measure || !stopCast) return null;
  await Bun.sleep(250);
  const observation = await browser.evaluate<{
    wheel: {
      timeStamp: number;
      received: number;
      trusted: boolean;
      deltaX: number;
      deltaY: number;
    } | null;
    raf: Array<{ now: number; scale: number }>;
    origin: number;
  }>(
    `(() => {const trace=globalThis.__otioWheelMeasurement; trace.active=false; return trace;})()`
  );
  const cast = await stopCast();
  assert.ok(
    observation.wheel?.trusted,
    'wheel monitor did not capture the trusted input event'
  );
  const eventTime = observation.origin + observation.wheel.timeStamp;
  const frames = await decodeScreencastFrames(cast, before.rect);
  const baseline = frames.filter((frame) => frame.timestamp < eventTime).at(-1);
  const final = frames.at(-1);
  assert.ok(
    baseline && final && final.timestamp > eventTime,
    'wheel screencast lacks a before/after pair'
  );
  const distance = (a: Uint8Array, b: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4)
      sum +=
        Math.abs(a[i]! - b[i]!) +
        Math.abs(a[i + 1]! - b[i + 1]!) +
        Math.abs(a[i + 2]! - b[i + 2]!);
    return sum / ((a.length / 4) * 3 * 255);
  };
  const difference = distance(baseline.pixels, final.pixels);
  const presented =
    difference > 0.005
      ? frames.find(
          (frame) =>
            frame.timestamp >= eventTime &&
            distance(frame.pixels, final.pixels) <
              distance(frame.pixels, baseline.pixels)
        )
      : undefined;
  const postRaf = observation.raf.filter(
    (sample) => observation.origin + sample.now >= eventTime
  );
  const changedRaf = postRaf.find((sample) => sample.scale !== before.scale);
  const rafGaps = postRaf
    .slice(1)
    .map((sample, i) => sample.now - postRaf[i]!.now);
  return {
    before,
    after,
    observation,
    rawScreencast: cast,
    baselinePixelDifference: difference,
    firstChangedRailFrameTimestamp: presented?.timestamp ?? null,
    inputToChangedRailFrameMs: presented
      ? presented.timestamp - eventTime
      : null,
    inputToChangedLayoutRafMs: changedRaf
      ? observation.origin + changedRaf.now - eventTime
      : null,
    rafGaps,
    maxRafGapMs: rafGaps.length ? Math.max(...rafGaps) : null,
    limit:
      'Browser screencast and RAF observations; not physical display latency.',
  };
}

async function assertFocusedPlaybackBound(
  browser: ChromeSession,
  start: number,
  end: number
): Promise<void> {
  await seekTo(browser, end - 8);
  const result = await browser.evaluate<{
    frames: number[];
    stopped: boolean;
  }>(`(async () => {
    const root = document.querySelector('.otio-view');
    const button = document.querySelector('button.otio-play');
    if (!root || !(button instanceof HTMLButtonElement)) return {frames: [], stopped: false};
    const frames = [Number(root.dataset.frame)];
    const observer = new MutationObserver(() => frames.push(Number(root.dataset.frame)));
    observer.observe(root, {attributes: true, attributeFilter: ['data-frame']});
    button.click();
    let started = false;
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (root.dataset.playing === 'true') started = true;
      if (started && root.dataset.playing === 'false' && root.dataset.buffering === 'false') break;
      const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 25); await promise;
    }
    observer.disconnect();
    return {frames, stopped: started && root.dataset.playing === 'false'};
  })()`);
  assert.ok(result.stopped, 'focused playback did not start and stop');
  assert.ok(
    result.frames.some((frame) => frame > end - 8),
    'focused playback did not advance'
  );
  assert.ok(
    result.frames.every((frame) => frame >= start && frame < end),
    `focused playback escaped [${start}, ${end}): ${result.frames.join(', ')}`
  );
}

interface AudioClockBridge {
  before: number;
  after: number;
  currentBefore: number;
  currentAfter: number;
  output: { contextTime: number; performanceTime: number } | null;
}

interface MovingTrace {
  start: {
    timestamp: number;
    frame: number;
    sampleFrame: number;
    bridge: AudioClockBridge;
  };
  playEdge?: { timestamp: number; frame: number; bridge: AudioClockBridge };
  warm?: {
    timestamp: number;
    frame: number;
    sampleCount: number;
    changes: number;
  };
  trace: {
    timestamp: number;
    frame: number;
    sampleFrame: number;
    contextState: string;
    staleCaptureId: number | null;
    bridge: AudioClockBridge;
    audioOverflow: boolean;
    visualOverflow: boolean;
    eventsOverflow: boolean;
    bank: Array<{ timestamp: number; value: Record<string, unknown> }>;
    bankOverflow: boolean;
    events: Array<{
      kind: string;
      timestamp: number;
      value?: unknown;
      mediaType?: string | null;
    }>;
    visual: Array<{
      timestamp: number;
      frame: string | null;
      pixels16?: number[];
      error?: string;
    }>;
    audio: Array<{
      sampleFrame: number;
      channels: number[][];
      witness?: number[][];
      marker?: number[];
      sequence?: number;
      quantumFrames?: number[];
      quantumLengths?: number[];
      quantumOrdinals?: number[];
      quantumOffsets?: number[];
    }>;
    witness?: {
      anchor: number;
      laterAnchor: number | null;
      frozenAnchor: number;
      length: number;
      gateInitialFrame: number;
      clockEpoch: number;
    } | null;
    sampleRate: number;
  };
}

// Clock evidence. The audit reads only what the proof wrapper recorded from the native output
// clock, so a viewer bridge, hold or clock error is checked against reads Chromium returned.
// Injected reads (I5) are counted and are never native evidence. A pair whose two reads straddle
// a clock epoch spans two clock sessions, so it is counted, not classified. A shot with no native
// clock reads must name why; an unnamed absence is a violation.
const CLOCK_PAIR_EPS_US = 1e-3;
const CLOCK_HOLD_LIMIT_US = 200;
interface ClockStamp {
  contextTime: number;
  performanceTime: number;
}
interface ClockEvidence {
  nativeReads: number;
  injectedReads: number;
  epochs: number;
  pairs: number;
  crossEpochPairs: number;
  identical: number;
  contextOnly: number;
  performanceOnly: number;
  bothAdvance: number;
  regressions: number;
  maxContextOnlyUs: number;
  maxPerformanceOnlyUs: number;
  maxContextAdvanceUs: number;
  clockHolds: number;
  holdsMatched: number;
  epochBridges: number;
  clockErrors: number;
  siteUses: number;
  siteHoldsConsumed: number;
  futureSkipReads: number;
  futureSkips: number;
  violations: string[];
}
function clockStamp(value: unknown): ClockStamp | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const contextTime = record['contextTime'];
  const performanceTime = record['performanceTime'];
  if (typeof contextTime !== 'number' || typeof performanceTime !== 'number')
    return null;
  if (!Number.isFinite(contextTime) || !Number.isFinite(performanceTime))
    return null;
  return { contextTime, performanceTime };
}
function sameClockStamp(a: ClockStamp, b: ClockStamp): boolean {
  return (
    a.contextTime === b.contextTime && a.performanceTime === b.performanceTime
  );
}
function auditClockEvidence(
  trace: Pick<MovingTrace['trace'], 'events'> | null
): ClockEvidence {
  const violations: string[] = [];
  const native: Array<ClockStamp & { timestamp: number }> = [];
  const observed: ClockStamp[] = [];
  const pcmEvents: Array<Record<string, unknown>> = [];
  const epochTimes: number[] = [];
  let injectedReads = 0;
  for (const entry of trace?.events ?? []) {
    if (
      entry.kind === 'audio-output-timestamp-observed' &&
      entry.value &&
      typeof entry.value === 'object'
    ) {
      const value = entry.value as Record<string, unknown>;
      const injected = value['injected'] === true;
      if (injected) injectedReads++;
      const output = clockStamp(value['output']);
      if (!output) continue;
      observed.push(output);
      if (!injected) native.push({ ...output, timestamp: entry.timestamp });
    } else if (
      entry.kind === 'scheduled-pcm' &&
      entry.value &&
      typeof entry.value === 'object'
    ) {
      const value = entry.value as Record<string, unknown>;
      pcmEvents.push(value);
      if (value['event'] === 'epoch') epochTimes.push(entry.timestamp);
    }
  }
  if (native.length === 0) violations.push('no-native-clock-reads');
  let identical = 0,
    contextOnly = 0,
    performanceOnly = 0,
    bothAdvance = 0,
    regressions = 0,
    crossEpochPairs = 0;
  let maxContextOnlyUs = 0,
    maxPerformanceOnlyUs = 0,
    maxContextAdvanceUs = 0;
  for (let i = 1; i < native.length; i++) {
    const a = native[i - 1]!,
      b = native[i]!;
    if (epochTimes.some((time) => time > a.timestamp && time <= b.timestamp)) {
      crossEpochPairs++;
      continue;
    }
    const dContextUs = (b.contextTime - a.contextTime) * 1e6;
    const dPerformanceUs = (b.performanceTime - a.performanceTime) * 1e3;
    if (
      dContextUs < -CLOCK_PAIR_EPS_US ||
      dPerformanceUs < -CLOCK_PAIR_EPS_US
    ) {
      regressions++;
      continue;
    }
    maxContextAdvanceUs = Math.max(maxContextAdvanceUs, dContextUs);
    const contextMoved = dContextUs > CLOCK_PAIR_EPS_US;
    const performanceMoved = dPerformanceUs > CLOCK_PAIR_EPS_US;
    if (!contextMoved && !performanceMoved) identical++;
    else if (!performanceMoved) {
      contextOnly++;
      maxContextOnlyUs = Math.max(maxContextOnlyUs, dContextUs);
      if (dContextUs >= CLOCK_HOLD_LIMIT_US)
        violations.push(
          `context-only-advance-${Math.round(dContextUs)}us@pair-${i}`
        );
    } else if (!contextMoved) {
      performanceOnly++;
      maxPerformanceOnlyUs = Math.max(maxPerformanceOnlyUs, dPerformanceUs);
      if (b.contextTime > 0)
        violations.push(
          `performance-only-advance-${Math.round(dPerformanceUs)}us-with-context@pair-${i}`
        );
    } else bothAdvance++;
  }
  let clockHolds = 0,
    holdsMatched = 0,
    epochBridges = 0,
    clockErrors = 0,
    siteUses = 0,
    futureSkipReads = 0;
  const skippedStamps: ClockStamp[] = [];
  pcmEvents.forEach((value, index) => {
    if (value['event'] === 'clock-hold') {
      clockHolds++;
      const label = `clock-hold#${index}`;
      const held = clockStamp(value);
      const last = clockStamp(value['lastAccepted']);
      const deltaUs = value['deltaUs'];
      if (
        typeof deltaUs !== 'number' ||
        !Number.isFinite(deltaUs) ||
        deltaUs < 0 ||
        deltaUs >= CLOCK_HOLD_LIMIT_US
      )
        violations.push(`${label}:delta-out-of-band`);
      if (!held) violations.push(`${label}:held-read-missing`);
      if (!last) violations.push(`${label}:last-accepted-missing`);
      else if (!native.some((stamp) => sameClockStamp(stamp, last)))
        violations.push(`${label}:last-accepted-unobserved`);
      if (held) {
        if (observed.some((stamp) => sameClockStamp(stamp, held)))
          holdsMatched++;
        else violations.push(`${label}:held-read-unobserved`);
      }
      if (held && last) {
        const heldDeltaUs = (held.contextTime - last.contextTime) * 1e6;
        if (held.performanceTime !== last.performanceTime)
          violations.push(`${label}:performance-moved`);
        if (heldDeltaUs < 0 || heldDeltaUs >= CLOCK_HOLD_LIMIT_US)
          violations.push(`${label}:context-out-of-band`);
        // deltaUs is rounded to whole microseconds by the viewer, so half a microsecond is the bound.
        if (
          typeof deltaUs === 'number' &&
          Math.abs(heldDeltaUs - deltaUs) > 0.5
        )
          violations.push(`${label}:delta-mismatch`);
      }
    }
    if (value['event'] === 'epoch' && 'bridge' in value) {
      const label = `epoch#${index}`;
      const bridge = clockStamp(value['bridge']);
      if (!bridge) violations.push(`${label}:bridge-malformed`);
      else {
        epochBridges++;
        if (!native.some((stamp) => sameClockStamp(stamp, bridge))) {
          violations.push(
            observed.some((stamp) => sameClockStamp(stamp, bridge))
              ? `${label}:bridge-is-injected-read`
              : `${label}:bridge-unobserved`
          );
        }
      }
    }
    if (value['event'] === 'error') {
      const code = String(value['code'] ?? '');
      if (
        value['stage'] === 'clock' ||
        code.startsWith('audio output clock interrupted')
      ) {
        clockErrors++;
        const label = `clock-error#${index}:${code}`;
        if (!('lastAccepted' in value))
          violations.push(`${label}:evidence-missing`);
        else if (value['lastAccepted'] !== null) {
          const last = clockStamp(value['lastAccepted']);
          if (!last) violations.push(`${label}:last-accepted-malformed`);
          else if (!native.some((stamp) => sameClockStamp(stamp, last)))
            violations.push(`${label}:last-accepted-unobserved`);
        }
      }
    }
    if (value['event'] === 'clock-future-skip') {
      // One future stamp is skipped, never used: it must be a recorded read, it must really lead
      // the read past the policy bound, and the pair that stands must be a native accepted pair.
      futureSkipReads++;
      const label = `clock-future-skip#${index}`;
      const skipped = clockStamp(value);
      if (!skipped) violations.push(`${label}:stamp-malformed`);
      else {
        if (!skippedStamps.some((stamp) => sameClockStamp(stamp, skipped)))
          skippedStamps.push(skipped);
        if (!observed.some((stamp) => sameClockStamp(stamp, skipped)))
          violations.push(`${label}:stamp-unobserved`);
      }
      const leadMs = Number(value['leadMs']);
      const contextLeadMs = Number(value['contextLeadMs']);
      if (
        !(leadMs > DEFAULT_CLOCK_POLICY.futureToleranceMs) &&
        !(contextLeadMs > DEFAULT_CLOCK_POLICY.futureToleranceMs)
      )
        violations.push(`${label}:not-future`);
      if (value['lastAccepted'] !== null) {
        const last = clockStamp(value['lastAccepted']);
        if (!last) violations.push(`${label}:last-accepted-malformed`);
        else if (!native.some((stamp) => sameClockStamp(stamp, last)))
          violations.push(`${label}:last-accepted-unobserved`);
      }
    }
    if (value['event'] === 'clock-site' && value['phase'] === 'use') {
      siteUses++;
      const label = `site-${String(value['site'])}#${index}`;
      const used = clockStamp(value['usedStamp']);
      const last = clockStamp(value['lastAccepted']);
      if (!used) violations.push(`${label}:used-stamp-malformed`);
      else {
        if (!native.some((stamp) => sameClockStamp(stamp, used)))
          violations.push(
            observed.some((stamp) => sameClockStamp(stamp, used))
              ? `${label}:used-held-read`
              : `${label}:used-unobserved`
          );
        if (!last) violations.push(`${label}:last-accepted-missing`);
        else if (!sameClockStamp(used, last))
          violations.push(`${label}:used-not-last-accepted`);
      }
    }
  });
  return {
    nativeReads: native.length,
    injectedReads,
    epochs: epochTimes.length,
    pairs: Math.max(0, native.length - 1),
    crossEpochPairs,
    identical,
    contextOnly,
    performanceOnly,
    bothAdvance,
    regressions,
    maxContextOnlyUs,
    maxPerformanceOnlyUs,
    maxContextAdvanceUs,
    clockHolds,
    holdsMatched,
    epochBridges,
    clockErrors,
    siteUses,
    siteHoldsConsumed: (trace?.events ?? []).filter(
      (entry) => entry.kind === 'clock-site-hold-consumed'
    ).length,
    futureSkipReads,
    futureSkips: skippedStamps.length,
    violations,
  };
}
function assertClockAudit(audit: ClockEvidence, label: string): void {
  assert.deepEqual(
    audit.violations,
    [],
    `${label} clock evidence failed audit: ${audit.violations.join(', ')}`
  );
}
interface ClockShot extends ClockEvidence {
  label: string;
  noDataReason: string | null;
}
// Every scheduled-pcm shot carries its clock audit. A shot with no native clock reads must name
// the reason; a declared reason is recorded and withdraws only the zero-read violation.
function clockShot(
  label: string,
  trace: Pick<MovingTrace['trace'], 'events'> | null,
  declaredNoData: string | null = null
): ClockShot {
  const audit = auditClockEvidence(trace);
  const noDataReason =
    audit.nativeReads === 0
      ? (declaredNoData ?? 'no native output-clock reads; no reason declared')
      : null;
  const violations =
    declaredNoData === null || audit.nativeReads > 0
      ? audit.violations
      : audit.violations.filter(
          (violation) => violation !== 'no-native-clock-reads'
        );
  return { ...audit, violations, label, noDataReason };
}
async function writeClockShot(
  path: string,
  body: Record<string, unknown>,
  label: string,
  trace: Pick<MovingTrace['trace'], 'events'> | null,
  declaredNoData: string | null = null
): Promise<ClockShot> {
  const clockAudit = clockShot(label, trace, declaredNoData);
  await writeFile(path, JSON.stringify({ ...body, clockAudit }));
  assertClockAudit(clockAudit, label);
  return clockAudit;
}
const BORROWED_NO_LEASE_REASON =
  'the borrowed audio context has no exclusive clock bootstrap lease';
const BORROWED_NO_LEASE_NO_CLOCK =
  'native compatibility for a borrowed context without a clock lease: the viewer never reads its output clock';
function noLeaseClockViolations(
  events: MovingTrace['trace']['events']
): string[] {
  const violations: string[] = [];
  const pcm = events.filter((entry) => entry.kind === 'scheduled-pcm');
  if (pcm.length === 0) violations.push('no-backend-selection');
  pcm.forEach((entry, index) => {
    const value = (entry.value ?? {}) as Record<string, unknown>;
    if (
      value['event'] !== 'backend' ||
      value['backend'] !== 'native' ||
      value['reason'] !== BORROWED_NO_LEASE_REASON
    )
      violations.push(
        `scheduled-pcm#${index}:${String(value['event'])}:${String(value['backend'])}:${String(value['reason'])}`
      );
  });
  const reads = events.filter(
    (entry) => entry.kind === 'audio-output-timestamp-observed'
  ).length;
  if (reads > 0) violations.push(`output-clock-reads-${reads}`);
  return violations;
}
function assertNoLeaseClockControls(): void {
  type Event = MovingTrace['trace']['events'][number];
  const backend = (kind: string, reason: string): Event => ({
    kind: 'scheduled-pcm',
    timestamp: 1,
    value: { event: 'backend', backend: kind, reason },
  });
  const read = (injected: boolean, time: number): Event => ({
    kind: 'audio-output-timestamp-observed',
    timestamp: 2,
    value: { injected, output: { contextTime: time, performanceTime: time } },
  });
  const selected = backend('native', BORROWED_NO_LEASE_REASON);
  assert.deepEqual(noLeaseClockViolations([selected]), []);
  const shot = clockShot(
    'no-lease-control',
    { events: [selected] },
    BORROWED_NO_LEASE_NO_CLOCK
  );
  assert.deepEqual(shot.violations, []);
  assert.equal(shot.noDataReason, BORROWED_NO_LEASE_NO_CLOCK);
  const rejected: Array<[string, Event[]]> = [
    ['native read', [selected, read(false, 1)]],
    ['injected read', [selected, read(true, 1)]],
    ['non-finite read', [selected, read(false, Number.NaN)]],
    ['missing selection', []],
    [
      'other native reason',
      [backend('native', 'audio format is not supported by scheduled PCM')],
    ],
    ['scheduled backend', [backend('pcm', BORROWED_NO_LEASE_REASON)]],
    [
      'clock session',
      [
        selected,
        {
          kind: 'scheduled-pcm',
          timestamp: 3,
          value: { event: 'epoch', f0: 0 },
        },
      ],
    ],
  ];
  for (const [label, events] of rejected)
    assert.ok(
      noLeaseClockViolations(events).length > 0,
      `no-lease clock premise accepted ${label}`
    );
  assert.deepEqual(
    clockShot(
      'no-lease-nan-control',
      { events: [selected, read(false, Number.NaN)] },
      BORROWED_NO_LEASE_NO_CLOCK
    ).violations,
    []
  );
  assert.deepEqual(clockShot('lease-control', { events: [] }).violations, [
    'no-native-clock-reads',
  ]);
}
// Every continuity fault in the capture window, each with its code. The first fault alone hides
// the cause: a clock interrupt is followed by its underflow cancel, so every fault is named.
function describeContinuityFaults(
  events: MovingTrace['trace']['events'],
  playMs: number
): string[] {
  return events
    .filter((entry) => {
      if (entry.kind !== 'scheduled-pcm') return false;
      const value = entry.value as Record<string, unknown>;
      return (
        value['event'] === 'error' ||
        (value['event'] === 'cancel' && value['reason'] === 'underflow')
      );
    })
    .map((entry) => {
      const value = entry.value as Record<string, unknown>;
      const parts = [String(value['event'])];
      if (value['stage'] !== undefined)
        parts.push(`stage=${String(value['stage'])}`);
      parts.push(`code=${String(value['code'] ?? value['reason'])}`);
      parts.push(`at ${Math.round(entry.timestamp - playMs)} ms after play`);
      if ('lastAccepted' in value)
        parts.push(`lastAccepted=${JSON.stringify(value['lastAccepted'])}`);
      if ('lastRejection' in value)
        parts.push(`lastRejection=${JSON.stringify(value['lastRejection'])}`);
      return parts.join(' ');
    });
}

// A cold capture whose audio lead ran out on a loaded runner, and whose recovery then had no
// frame to continue on. The exact signature: the gate closed at its frontier with no fault
// injected, and the three faults that follow are the visual refusal, the underflow cancel and
// the schedule refusal, in that order. Returns the evidence, or null for anything else.
function coldFrontierStarvation(
  events: MovingTrace['trace']['events'],
  playMs: number
): string | null {
  const faults = events.filter((entry) => {
    if (entry.kind !== 'scheduled-pcm') return false;
    const value = entry.value as Record<string, unknown>;
    return (
      value['event'] === 'error' ||
      (value['event'] === 'cancel' && value['reason'] === 'underflow')
    );
  });
  if (faults.length !== 3) return null;
  const shape = faults.map((entry) => {
    const value = entry.value as Record<string, unknown>;
    return `${String(value['event'])}:${String(value['stage'] ?? '')}:${String(value['code'] ?? value['reason'])}`;
  });
  if (
    shape.join('|') !==
    'error:visual:recovery-frame-unavailable|cancel::underflow|error:schedule:committed recovery frame is unavailable'
  )
    return null;
  if (
    events.some(
      (entry) =>
        entry.kind === 'scheduled-pcm' &&
        (entry.value as Record<string, unknown>)['event'] === 'recovery-fault'
    )
  )
    return null;
  const closes = events.filter(
    (entry) =>
      entry.kind === 'scheduled-pcm' &&
      (entry.value as Record<string, unknown>)['event'] === 'gate-close' &&
      (entry.value as Record<string, unknown>)['reason'] === 'frontier' &&
      entry.timestamp < faults[0]!.timestamp
  );
  const close = closes.at(-1);
  if (!close) return null;
  const extend = events
    .filter(
      (entry) =>
        entry.kind === 'transport-command' &&
        (entry.value as Record<string, unknown> | null)?.['type'] ===
          'extend' &&
        entry.timestamp < close.timestamp
    )
    .at(-1);
  const last = extend?.value as
    | { throughFrame: number; expectedThroughFrame: number }
    | undefined;
  return `frontier closed at ${Math.round(close.timestamp - playMs)} ms after play, last extension at ${
    extend ? Math.round(extend.timestamp - playMs) : 'none'
  } ms${last ? ` (+${last.throughFrame - last.expectedThroughFrame} frames)` : ''}, refusal at ${Math.round(faults[0]!.timestamp - playMs)} ms`;
}

class ColdFrontierStarvation extends Error {
  constructor(
    readonly evidence: string,
    readonly trace: MovingTrace['trace']
  ) {
    super(`cold playback ran out of audio lead: ${evidence}`);
  }
}
function assertPcmSequence(
  start: number,
  end: number,
  chunks: Array<{
    sampleFrame: number;
    channels: number[][];
    quantumFrames?: number[];
    quantumLengths?: number[];
    quantumOrdinals?: number[];
    quantumOffsets?: number[];
    sequence?: number;
  }>,
  rawFrameAuthority = true
): void {
  assert.ok(
    chunks.length > 0 && end > start,
    'post-gain PCM capture has no coverage'
  );
  if (rawFrameAuthority)
    assert.equal(
      chunks[0]!.sampleFrame,
      start,
      'post-gain PCM is missing its leading samples'
    );
  let ordinal = 0;
  let offset = 0;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    assert.ok(
      chunk.quantumFrames &&
        chunk.quantumLengths &&
        chunk.quantumOrdinals &&
        chunk.quantumOffsets,
      'missing quantum provenance'
    );
    assert.equal(chunk.sequence, chunkIndex, 'PCM chunk sequence gap');
    assert.equal(chunk.channels.length, 2, 'PCM capture is not stereo');
    assert.equal(
      chunk.channels[0]!.length,
      chunk.channels[1]!.length,
      'PCM channel length mismatch'
    );
    for (const channel of chunk.channels)
      assert.ok(channel.every(Number.isFinite), 'non-finite captured PCM');
    assert.equal(
      chunk.quantumFrames.length,
      chunk.quantumLengths.length,
      'quantum provenance length mismatch'
    );
    assert.equal(
      chunk.quantumOrdinals.length,
      chunk.quantumLengths.length,
      'quantum ordinal length mismatch'
    );
    assert.equal(
      chunk.quantumOffsets.length,
      chunk.quantumLengths.length,
      'quantum offset length mismatch'
    );
    let frame = chunk.sampleFrame;
    for (let i = 0; i < chunk.quantumFrames.length; i++) {
      assert.ok(
        Number.isSafeInteger(chunk.quantumFrames[i]),
        'invalid raw callback label'
      );
      if (rawFrameAuthority)
        assert.equal(
          chunk.quantumFrames[i],
          frame,
          'post-gain PCM has a missing or overlapping quantum'
        );
      const count: number = chunk.quantumLengths[i]!;
      assert.equal(
        chunk.quantumOrdinals[i],
        ordinal++,
        'missing or reordered PCM callback'
      );
      assert.equal(
        chunk.quantumOffsets[i],
        offset,
        'PCM callback offset mismatch'
      );
      offset += count;
      assert.ok(
        Number.isSafeInteger(count) && count > 0,
        'invalid PCM quantum length'
      );
      frame += count;
    }
    assert.equal(
      frame,
      chunk.sampleFrame + chunk.channels[0]!.length,
      'quantum provenance does not cover its PCM chunk'
    );
  }
  if (rawFrameAuthority)
    for (let i = 1; i < chunks.length; i++) {
      const prior = chunks[i - 1]!;
      assert.ok(prior.channels[0], 'post-gain PCM channel missing');
      assert.equal(
        chunks[i]!.sampleFrame,
        prior.sampleFrame + prior.channels[0].length,
        'post-gain PCM has a missing or overlapping chunk'
      );
    }
  const last = chunks[chunks.length - 1]!;
  assert.ok(last.channels[0], 'post-gain PCM final channel missing');
  if (rawFrameAuthority)
    assert.equal(
      last.sampleFrame + last.channels[0].length,
      end,
      'post-gain PCM is missing its trailing samples'
    );
}

// The carrier encodes absolute source position, independent of gate decisions.
function carrierFrame(
  chunk: MovingTrace['trace']['audio'][number],
  i: number,
  witness: { anchor: number; laterAnchor: number | null; length: number }
): number | null {
  const highRaw = chunk.witness?.[0]?.[i],
    lowRaw = chunk.witness?.[1]?.[i];
  if (
    typeof highRaw !== 'number' ||
    typeof lowRaw !== 'number' ||
    !Number.isFinite(highRaw) ||
    !Number.isFinite(lowRaw)
  )
    return null;
  // Float32 carrier lanes can differ from an integer by float residue (for example
  // a 16-bit boundary reads 5.8e-11 for 0). The runtime decoder accepts |x-round|
  // <= 0.125; a corrupted integer is still off by at least one and is rejected.
  const high = Math.round(highRaw),
    low = Math.round(lowRaw);
  if (Math.abs(highRaw - high) > 0.125 || Math.abs(lowRaw - low) > 0.125)
    return null;
  if (high < 1 || low < 0 || low >= 65536) return null;
  const frame = (high - 1) * 65536 + low;
  if (!Number.isSafeInteger(frame)) return null;
  const inInitial =
    frame >= witness.anchor && frame < witness.anchor + witness.length;
  const inLater =
    witness.laterAnchor !== null &&
    frame >= witness.laterAnchor &&
    frame < witness.laterAnchor + witness.length;
  if (!inInitial && !inLater) return null;
  return frame;
}
// Required quantum metadata. A chunk without quantumFrames, quantumLengths or quantumOffsets is
// a capture that cannot prove identity or clock continuity, so it fails here rather than being
// skipped.
function requireQuantumArrays(
  chunk: MovingTrace['trace']['audio'][number],
  label: string
): { frames: number[]; lengths: number[]; offsets: number[] } {
  const frames = chunk.quantumFrames;
  const lengths = chunk.quantumLengths;
  const offsets = chunk.quantumOffsets;
  assert.ok(
    Array.isArray(frames) && Array.isArray(lengths) && Array.isArray(offsets),
    `${label}: chunk seq ${chunk.sequence} lacks quantum metadata; identity and clock unproven`
  );
  assert.equal(
    frames.length,
    lengths.length,
    `${label}: chunk seq ${chunk.sequence} quantum frame and length counts differ`
  );
  assert.equal(
    offsets.length,
    lengths.length,
    `${label}: chunk seq ${chunk.sequence} quantum offset and length counts differ`
  );
  return { frames, lengths, offsets };
}

// Carrier identity, checked on every epoch. The processor's own sample counter (quantumOffsets
// plus position in the quantum) advances by exactly the quantum length on every process call.
// The carrier must advance with that counter: carrier minus counter is one constant over every
// decodable sample, anchored at the first decodable sample. The engine's reported currentFrame is
// not used here; raw labels are separately reported by reportEngineFrameClock. Samples without a
// decodable carrier are not counted as evidence.
function assertCarrierIdentity(
  trace: Pick<MovingTrace['trace'], 'audio' | 'witness'>,
  label: string
): number {
  let anchor: number | null = null;
  let decoded = 0;
  const mismatches: string[] = [];
  for (const chunk of trace.audio) {
    const quanta = requireQuantumArrays(chunk, label);
    let cursor = 0;
    for (let k = 0; k < quanta.lengths.length; k++) {
      const length = quanta.lengths[k]!;
      const base = quanta.offsets[k]!;
      for (let j = 0; j < length; j++) {
        const index = cursor + j;
        if (index >= (chunk.channels[0]?.length ?? 0)) break;
        const carrier = carrierFrame(chunk, index, trace.witness!);
        if (carrier === null) continue;
        const counter = base + j;
        decoded++;
        if (anchor === null) anchor = carrier - counter;
        else if (carrier - counter !== anchor && mismatches.length < 8)
          mismatches.push(
            `seq ${chunk.sequence} sample ${index} carrier ${carrier} counter ${counter} offset ${carrier - counter} (anchor ${anchor})`
          );
      }
      cursor += length;
    }
  }
  assert.ok(
    decoded > 0,
    `${label}: no decodable carrier samples; identity unproven`
  );
  assert.equal(
    mismatches.length,
    0,
    `${label}: carrier does not advance with the processor sample counter (${mismatches.join('; ')}; decoded ${decoded})`
  );
  return decoded;
}

// Raw cached currentFrame conformance is reported separately from playback proof.
// Labels are unchanged and are inspected across chunk boundaries.
function reportEngineFrameClock(
  trace: MovingTrace['trace'],
  label: string
): void {
  let previous: { frame: number; length: number } | undefined;
  const defects: Array<Record<string, unknown>> = [];
  for (const chunk of trace.audio) {
    const q = requireQuantumArrays(chunk, label);
    let cursor = 0;
    for (let k = 0; k < q.frames.length; k++) {
      const frame = q.frames[k]!,
        length = q.lengths[k]!;
      if (previous && frame !== previous.frame + previous.length) {
        const carrier = trace.witness
          ? carrierFrame(chunk, cursor, trace.witness)
          : null;
        defects.push({
          sequence: chunk.sequence,
          ordinal: chunk.quantumOrdinals?.[k],
          offset: q.offsets[k],
          label: frame,
          expected: previous.frame + previous.length,
          carrier,
        });
      }
      previous = { frame, length };
      cursor += length;
    }
  }
  console.log(
    'OTIO_RAW_CLOCK_CONFORMANCE',
    JSON.stringify({ label, conformant: defects.length === 0, defects })
  );
}

function assertIndependentCarrier(
  trace: Pick<MovingTrace['trace'], 'audio' | 'witness'>,
  first: number,
  end: number
): void {
  const witness = trace.witness;
  assert.ok(
    witness &&
      Number.isSafeInteger(witness.anchor) &&
      Number.isSafeInteger(witness.length) &&
      witness.length > 0,
    'independent frozen-origin carrier unavailable'
  );
  // Proof carrier W may be earlier than the first verified sample but never later:
  // a W after F0 leaves the first samples without independent identity, so fail closed.
  assert.ok(
    witness.anchor <= first,
    `proof carrier origin ${witness.anchor} starts after the verified sample ${first}`
  );
  let seen = 0;
  let previous: number | null = null;
  for (const chunk of trace.audio) {
    assert.ok(chunk.witness?.length === 2, 'carrier channels missing');
    assert.equal(
      chunk.witness[0]!.length,
      chunk.channels[0]!.length,
      'carrier length mismatch'
    );
    assert.equal(
      chunk.witness[1]!.length,
      chunk.channels[0]!.length,
      'carrier length mismatch'
    );
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null) {
        assert.equal(
          previous,
          null,
          'independent carrier disappeared or was corrupt'
        );
        continue;
      }
      if (previous !== null)
        assert.equal(
          frame,
          previous + 1,
          'independent carrier skipped or repeated a sample'
        );
      previous = frame;
      if (frame >= first && frame < end) seen++;
    }
  }
  assert.equal(
    seen,
    end - first,
    'independent carrier does not cover scheduled PCM'
  );
}

// Carrier decode controls. The sub-LSB tolerance must accept float residue at a
// real frame boundary, reject a lane perturbed by 0.125 or more, and let a
// one-frame skip or repeat fail the independent carrier integrity check.
function assertCarrierDecodeControls(): void {
  const witness = {
    anchor: 458000,
    laterAnchor: null,
    frozenAnchor: 458000,
    length: 2000,
    gateInitialFrame: 458000,
    clockEpoch: 1,
  };
  const laneTrace = (highs: number[], lows: number[]) => ({
    witness,
    audio: [
      {
        sampleFrame: 0,
        channels: [
          new Array<number>(highs.length).fill(0),
          new Array<number>(highs.length).fill(0),
        ],
        witness: [highs, lows],
      },
    ],
  });
  const decodeAt = (highs: number[], lows: number[], index: number) => {
    const trace = laneTrace(highs, lows);
    return carrierFrame(trace.audio[0]!, index, witness);
  };
  // Exact recorded boundary: high 8 with float residue 5.82e-11 is frame 458752.
  assert.equal(
    decodeAt([8], [5.820766091346741e-11], 0),
    458752,
    'carrier boundary residue did not decode to the exact frame'
  );
  // A lane perturbed just beyond 0.125 must be rejected, not rounded into a frame.
  assert.equal(
    decodeAt([7], [65535.126], 0),
    null,
    'perturbed low lane was accepted'
  );
  assert.equal(
    decodeAt([7.126], [65535], 0),
    null,
    'perturbed high lane was accepted'
  );
  // A consecutive run across the boundary passes the integrity check.
  assert.doesNotThrow(() =>
    assertIndependentCarrier(
      laneTrace([7, 7, 8], [65534, 65535, 5.820766091346741e-11]),
      458750,
      458753
    )
  );
  // A one-frame skip and a one-frame repeat must each fail contiguity.
  assert.throws(
    () =>
      assertIndependentCarrier(
        laneTrace([7, 7, 8], [65534, 65535, 1]),
        458750,
        458753
      ),
    /skipped or repeated/,
    'a one-frame carrier skip passed'
  );
  assert.throws(
    () =>
      assertIndependentCarrier(
        laneTrace([7, 7, 7], [65534, 65535, 65535]),
        458750,
        458753
      ),
    /skipped or repeated/,
    'a one-frame carrier repeat passed'
  );
}

// Raw currentFrame labels are retained for diagnostics only. Coverage is
// authenticated by every independently encoded carrier sample and by the
// callback sequence and cumulative offsets, including across chunk boundaries.
function assertPcmCoverage(
  start: number,
  end: number,
  chunks: MovingTrace['trace']['audio'],
  witness: MovingTrace['trace']['witness']
): void {
  assert.ok(witness, 'independent native carrier unavailable');
  assertPcmSequence(start, end, chunks, false);
  assertIndependentCarrier({ audio: chunks, witness }, start, end);
}

function assertPcmSilence(
  trace: MovingTrace['trace'],
  start: number,
  end: number,
  label: string
): void {
  const witness = trace.witness;
  assertPcmCoverage(start, end, trace.audio, witness);
  assert.ok(witness, 'independent native carrier unavailable');
  let observed = 0;
  for (const chunk of trace.audio)
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null || frame < start || frame >= end) continue;
      assert.ok(
        Math.abs(chunk.channels[0]![i]!) < 0.001 &&
          Math.abs(chunk.channels[1]![i]!) < 0.001,
        label
      );
      observed++;
    }
  assert.equal(observed, end - start, `${label}: incomplete observation`);
}

function lastCarrierEnd(trace: MovingTrace['trace']): number {
  const witness = trace.witness;
  assert.ok(witness, 'independent native carrier unavailable');
  for (let c = trace.audio.length - 1; c >= 0; c--) {
    const chunk = trace.audio[c]!;
    for (let i = chunk.channels[0]!.length - 1; i >= 0; i--) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame !== null) return frame + 1;
    }
  }
  throw new Error('independent native carrier absent from capture');
}

// Legacy ring evidence, measured from the viewer's own cold-controller records
// (OTIO_PROOF_COLD, trace kind 'cold-controller'). 'solver' samples carry the
// resident slot count and the phase interval in wall ms. 'clock-selection' carries
// the 512-frame guard and the causal epoch. 'ring-refused' is an explicit refusal:
// any refusal in a normal legacy run fails here and never passes silently. Nothing
// is computed from the proof's own formula.
// Recorded shapes, measured from the viewer's own trace (not assumed):
//   cold-controller 'solver': { event, wall, samples: [{ dL, iL0Plus1Start, sourceT0Seconds,
//     rL, wMinSeconds, residentSlots }], intervalLower, intervalUpper, phaseLowerMs,
//     phaseUpperMs, chosenAnchor, spreadAcceptable }
//   scheduled-pcm 'clock-selection': { event, guardFrames, contextFrame, epochWall, ... }
//   cold-controller 'ring-refused': { event, code, decoder, slots, requiredSlots, capPixels, usedPixels }
// residentSlots is per sample, never on the solver record itself.
interface LegacyRingSample {
  residentSlots: number;
}
interface LegacyRingSolver {
  event: 'solver';
  samples: LegacyRingSample[];
  phaseLowerMs: number;
  phaseUpperMs: number;
}
const LEGACY_RING_GUARD_FRAMES = 512;

function legacyColdValues(
  trace: MovingTrace['trace']
): Array<Record<string, unknown>> {
  return trace.events
    .filter((entry) => entry.kind === 'cold-controller')
    .map((entry) => entry.value as Record<string, unknown>);
}

function legacyScheduledValues(
  trace: MovingTrace['trace']
): Array<Record<string, unknown>> {
  return trace.events
    .filter((entry) => entry.kind === 'scheduled-pcm')
    .map((entry) => entry.value as Record<string, unknown>);
}

// `requireSolver` is set only on the cold start path, the only path that emits 'solver'
// records. Phase bounds are absolute performance-timeline ms, the same origin as
// performance.now(), so callers compare them with absolute wall times.
function assertLegacyRingEvidence(
  trace: MovingTrace['trace'],
  requireSolver: boolean
): LegacyRingSolver[] {
  const cold = legacyColdValues(trace);
  const refused = cold.filter((value) => value['event'] === 'ring-refused');
  assert.equal(
    refused.length,
    0,
    `legacy ring refused playback: ${JSON.stringify(refused[0])}`
  );
  // An unplaced epoch is not a ring refusal, but a normal legacy run must place one, so it
  // fails here with its reason rather than passing or being misread as a ring shortage.
  const unplaceable = cold.filter(
    (value) => value['event'] === 'epoch-unplaceable'
  );
  assert.equal(
    unplaceable.length,
    0,
    `legacy epoch unplaceable: ${JSON.stringify(unplaceable[0])}`
  );
  const solvers = cold.filter(
    (value) => value['event'] === 'solver'
  ) as unknown as LegacyRingSolver[];
  if (requireSolver)
    assert.ok(
      solvers.length > 0,
      'legacy cold run recorded no ring solver state'
    );
  for (const solver of solvers) {
    assert.ok(
      Array.isArray(solver.samples) && solver.samples.length > 0,
      'legacy phase solve carries no samples'
    );
    for (const sample of solver.samples)
      assert.ok(
        Number.isSafeInteger(sample.residentSlots) && sample.residentSlots >= 2,
        'legacy phase solve sample has fewer than two resident slots'
      );
    assert.ok(
      Number.isFinite(solver.phaseLowerMs) &&
        Number.isFinite(solver.phaseUpperMs) &&
        solver.phaseLowerMs <= solver.phaseUpperMs,
      'legacy phase interval is empty or non-finite'
    );
  }
  const scheduled = legacyScheduledValues(trace);
  const selections = scheduled.filter(
    (value) => value['event'] === 'clock-selection'
  );
  assert.ok(selections.length > 0, 'legacy run recorded no clock selection');
  const epochs = scheduled
    .filter((value) => value['event'] === 'epoch')
    .map((value) => Number(value['f0']));
  for (const selection of selections)
    assert.equal(
      selection['guardFrames'],
      LEGACY_RING_GUARD_FRAMES,
      'legacy clock selection does not use the 512-frame guard'
    );
  // A committed selection names the epoch frame it chose, which the scheduler must have
  // committed. A refused selection has no frame and is not evidence of playback.
  const committed = selections.filter(
    (value) => typeof value['contextFrame'] === 'number'
  );
  assert.ok(committed.length > 0, 'legacy run committed no clock selection');
  for (const selection of committed)
    assert.ok(
      epochs.includes(Number(selection['contextFrame'])),
      'legacy clock selection frame was never committed by the scheduler'
    );
  return solvers;
}

function assertAnchorEvidence(
  trace: MovingTrace['trace']
): Record<string, unknown> {
  const witness = trace.witness;
  assert.ok(
    witness &&
      Number.isSafeInteger(witness.frozenAnchor) &&
      Number.isSafeInteger(witness.gateInitialFrame) &&
      witness.frozenAnchor % 128 === 0,
    'independent proof carrier origin or production anchor missing'
  );
  const layout = trace.events.find((event) => event.kind === 'transport-layout')
    ?.value as Record<string, unknown> | undefined;
  const productionCarrier = trace.events.find(
    (event) => event.kind === 'production-anchor-carrier-connected'
  )?.value as Record<string, unknown> | undefined;
  assert.ok(
    layout?.['inputs'] === 3 &&
      layout['outputs'] === 1 &&
      layout['channelCount'] === 2 &&
      layout['channelCountMode'] === 'explicit' &&
      layout['channelInterpretation'] === 'speakers' &&
      Array.isArray(layout['outputChannels']) &&
      layout['outputChannels'][0] === 2,
    'authored gate channel layout changed'
  );
  assert.ok(
    productionCarrier?.['clockEpoch'] === witness.clockEpoch &&
      productionCarrier['input'] === 1 &&
      productionCarrier['frames'] === 8192 &&
      productionCarrier['channels'] === 2 &&
      productionCarrier['rate'] === trace.sampleRate &&
      productionCarrier['channelCount'] === 2 &&
      productionCarrier['channelCountMode'] === 'explicit' &&
      productionCarrier['channelInterpretation'] === 'discrete',
    'native anchor carrier routing is not isolated stereo'
  );
  const sourceStart = trace.events.find(
    (event) => event.kind === 'production-anchor-start-request'
  )?.value as Record<string, unknown> | undefined;
  assert.ok(
    sourceStart?.['clockEpoch'] === witness.clockEpoch &&
      sourceStart['offset'] === 0 &&
      sourceStart['playbackRate'] === 1 &&
      sourceStart['detune'] === 0 &&
      sourceStart['loop'] === false &&
      typeof sourceStart['when'] === 'number' &&
      Math.abs(
        sourceStart['when'] * trace.sampleRate - witness.gateInitialFrame
      ) <=
        1 / 1024,
    'native anchor carrier did not start at the frozen origin with unit rate'
  );
  const messages = trace.events
    .filter((event) => event.kind === 'transport-message')
    .map((event) => event.value as Record<string, unknown>);
  const anchor = messages.find(
    (message) => message?.['type'] === 'anchor-certified'
  );
  assert.ok(
    anchor &&
      anchor['clockEpoch'] === witness.clockEpoch &&
      anchor['firstFrame'] === witness.gateInitialFrame &&
      anchor['callbackOrdinal'] === 2 &&
      Number.isSafeInteger(anchor['sampleCount']) &&
      Number.isSafeInteger(anchor['quantumLength']) &&
      Number(anchor['quantumLength']) >= 2 &&
      Number(anchor['quantumLength']) <= 2048 &&
      Number.isSafeInteger(anchor['bankSerial']) &&
      anchor['lastCertifiedEnd'] ===
        witness.gateInitialFrame + Number(anchor['sampleCount']) &&
      anchor['clockCoverageEnd'] === witness.gateInitialFrame + 65536 - 2048,
    'anchor certificate lacks exact production-anchor provenance'
  );
  const boot = trace.events
    .filter((event) => event.kind === 'transport-bootstrap-clock')
    .map((event) => event.value as Record<string, unknown>)
    .filter((record) => record['clockEpoch'] === witness.clockEpoch)
    .slice(0, 2);
  assert.equal(
    boot.length,
    2,
    'first two certified native parameter callbacks missing'
  );
  let expected = witness.gateInitialFrame,
    total = 0;
  for (let q = 0; q < 2; q++) {
    const record = boot[q]!,
      values = record['clockFrameA'],
      tags = record['clockTagA'];
    assert.ok(
      Array.isArray(values) &&
        values.length >= 2 &&
        values.length <= 2048 &&
        Array.isArray(tags) &&
        (tags.length === 1 || tags.length === values.length) &&
        record['callbackOrdinal'] === q + 1 &&
        record['sampleCount'] === total &&
        record['certifiedFrame'] === expected,
      'bootstrap bank provenance invalid'
    );
    for (let i = 0; i < values.length; i++) {
      const value: number = values[i];
      assert.ok(
        Number.isFinite(value) &&
          Math.abs(value - Math.round(value)) < 1 / 16 &&
          witness.gateInitialFrame + Math.round(value) === expected + i &&
          tags[tags.length === 1 ? 0 : i] === anchor['bankSerial'],
        'bootstrap bank sample disagrees with production anchor'
      );
    }
    expected += values.length;
    total += values.length;
  }
  assert.equal(
    expected,
    anchor['lastCertifiedEnd'],
    'anchor boundary differs from actual callbacks'
  );
  assert.equal(
    total,
    anchor['sampleCount'],
    'anchor count differs from actual callbacks'
  );
  assertPcmSilence(
    trace,
    witness.gateInitialFrame,
    expected,
    'authored PCM escaped before anchor certification'
  );
  return anchor;
}

function associateBootstrapClock(trace: MovingTrace['trace'], f0: number) {
  const witness = trace.witness;
  assert.ok(witness, 'bootstrap association lacks witness');
  const tap: TapQuantum[] = [];
  for (const chunk of trace.audio) {
    const q = requireQuantumArrays(chunk, 'bootstrap association');
    const ordinals = chunk.quantumOrdinals;
    assert.ok(
      ordinals && ordinals.length === q.lengths.length,
      'bootstrap tap ordinals missing'
    );
    let cursor = 0;
    for (let i = 0; i < q.lengths.length; i++) {
      const length = q.lengths[i]!;
      const carrier = Array.from({ length }, (_, j) =>
        carrierFrame(chunk, cursor + j, witness)
      );
      tap.push({
        label: q.frames[i]!,
        length,
        ordinal: ordinals[i]!,
        offset: q.offsets[i]!,
        carrier,
      });
      cursor += length;
    }
    assert.equal(
      cursor,
      chunk.channels[0]?.length,
      'bootstrap tap chunk length mismatch'
    );
  }
  const raw = trace.events
    .filter((event) => event.kind === 'transport-bootstrap-clock')
    .map((event) => event.value as Record<string, unknown>)
    .filter((record) => record['clockEpoch'] === witness.clockEpoch);
  const gate: GateQuantum[] = raw.map((record) => {
    const active = record['active'] as {
      bank: number;
      startFrame: number;
      endFrame: number;
      serial: number;
      clockEpoch: number;
    };
    assert.ok(
      active &&
        (active.bank === 0 || active.bank === 1) &&
        active.clockEpoch === witness.clockEpoch,
      'bootstrap active bank invalid'
    );
    const suffix = active.bank === 0 ? 'A' : 'B';
    const frames = record['clockFrame' + suffix];
    const tags = record['clockTag' + suffix];
    assert.ok(
      Array.isArray(frames) && Array.isArray(tags),
      'bootstrap native samples missing'
    );
    return {
      clockEpoch: Number(record['clockEpoch']),
      cachedCurrentFrame: Number(record['cachedCurrentFrame']),
      callbackOrdinal: Number(record['callbackOrdinal']),
      sampleCount: Number(record['sampleCount']),
      certifiedFrame: Number(record['certifiedFrame']),
      startFrame: active.startFrame,
      endFrame: active.endFrame,
      serial: active.serial,
      frames,
      tags,
    };
  });
  const association = associateGateSequence(tap, gate, witness.clockEpoch);
  // Bootstrap starts before the witness; only its actual covered suffix is compared.
  // Require the committed first frame and do not infer placement from the carrier.
  const last = gate[gate.length - 1]!;
  const end = Math.min(
    last.certifiedFrame + last.frames.length,
    witness.frozenAnchor + witness.length
  );
  assert.ok(
    f0 >= witness.frozenAnchor && end > f0,
    'bootstrap evidence does not cover committed frame'
  );
  assertAssociatedSamples(tap, gate, association.start, f0, end);
  return { tap, gate, offset: association.offset };
}

function assertGateClockEvidence(
  trace: MovingTrace['trace'],
  crossing = false
): number {
  const witness = trace.witness;
  assert.ok(witness, 'independent carrier provenance missing');
  assert.ok(
    Number.isSafeInteger(witness.gateInitialFrame) &&
      Number.isSafeInteger(witness.frozenAnchor),
    'gate origin or independent carrier origin missing'
  );
  const messages = trace.events
    .filter((event) => event.kind === 'transport-message')
    .map((event) => event.value as Record<string, unknown>);
  assert.ok(
    !messages.some((message) => message['type'] === 'clock-trace-overflow'),
    'gate parameter trace overflow'
  );
  const records = messages.filter(
    (message) =>
      message['type'] === 'clock-trace' &&
      message['clockEpoch'] === witness.clockEpoch
  );
  assert.ok(records.length >= 2, 'actual gate parameter samples missing');
  if (crossing) {
    const first = Number(records[0]!['certifiedFrame']);
    const last = records[records.length - 1]!;
    const active = last['active'];
    assert.ok(
      active && typeof active === 'object' && 'bank' in active,
      'large-frame trace active bank missing'
    );
    const frames = last[active.bank === 0 ? 'clockFrameA' : 'clockFrameB'];
    assert.ok(
      Array.isArray(frames) &&
        first < 2 ** 24 &&
        Number(last['certifiedFrame']) + frames.length > 2 ** 24,
      'native parameter capture did not span the large-frame boundary'
    );
  }
  const quanta: Array<{
    label: number;
    count: number;
    chunk: MovingTrace['trace']['audio'][number];
    offset: number;
    sampleOffset: number;
    ordinal: number;
  }> = [];
  for (const chunk of trace.audio) {
    assert.ok(
      chunk.quantumFrames &&
        chunk.quantumLengths &&
        chunk.quantumOffsets &&
        chunk.quantumOrdinals &&
        chunk.quantumFrames.length === chunk.quantumLengths.length &&
        chunk.quantumFrames.length === chunk.quantumOffsets.length &&
        chunk.quantumFrames.length === chunk.quantumOrdinals.length,
      'raw callback labels and offsets missing'
    );
    let offset = 0;
    for (let i = 0; i < chunk.quantumFrames.length; i++) {
      quanta.push({
        label: chunk.quantumFrames[i]!,
        count: chunk.quantumLengths[i]!,
        chunk,
        offset,
        sampleOffset: chunk.quantumOffsets[i]!,
        ordinal: chunk.quantumOrdinals[i]!,
      });
      offset += chunk.quantumLengths[i]!;
    }
  }
  for (let i = 1; i < quanta.length; i++) {
    assert.equal(
      quanta[i]!.ordinal,
      quanta[i - 1]!.ordinal + 1,
      'tap callback ordinal gap'
    );
    assert.equal(
      quanta[i]!.sampleOffset,
      quanta[i - 1]!.sampleOffset + quanta[i - 1]!.count,
      'tap callback offset gap'
    );
  }
  const candidates = quanta.flatMap((_, start) =>
    records.every((record, i) => {
      const active = record['active'];
      if (
        !active ||
        typeof active !== 'object' ||
        !('bank' in active) ||
        (active.bank !== 0 && active.bank !== 1)
      )
        return false;
      const frames = record[active.bank === 0 ? 'clockFrameA' : 'clockFrameB'];
      return (
        Array.isArray(frames) &&
        quanta[start + i]?.label === record['cachedCurrentFrame'] &&
        quanta[start + i]?.count === frames.length
      );
    })
      ? [start]
      : []
  );
  assert.equal(
    candidates.length,
    1,
    'gate and tap callback sequence cannot be uniquely aligned'
  );
  const associationOffset =
    quanta[candidates[0]!]!.sampleOffset - Number(records[0]!['sampleCount']);
  for (let r = 0; r < records.length; r++) {
    const record = records[r]!,
      quantum = quanta[candidates[0]! + r]!;
    assert.equal(
      quantum.sampleOffset - Number(record['sampleCount']),
      associationOffset,
      'gate/tap sample offset changed'
    );
    const active = record['active'] as {
      bank: 0 | 1;
      serial: number;
      startFrame: number;
      endFrame: number;
      clockEpoch: number;
    };
    assert.ok(
      active &&
        (active.bank === 0 || active.bank === 1) &&
        Number.isSafeInteger(active.startFrame) &&
        Number.isSafeInteger(active.endFrame) &&
        Number.isSafeInteger(active.serial) &&
        active.clockEpoch === record['clockEpoch'] &&
        active.clockEpoch === witness.clockEpoch &&
        Number.isSafeInteger(record['callbackOrdinal']) &&
        Number.isSafeInteger(record['sampleCount']),
      'gate active descriptor missing'
    );
    const suffix = active.bank === 0 ? 'A' : 'B';
    const frames = record['clockFrame' + suffix] as number[];
    const tags = record['clockTag' + suffix] as number[];
    assert.ok(
      Array.isArray(frames) &&
        frames.length === quantum.count &&
        Array.isArray(tags) &&
        (tags.length === 1 || tags.length === quantum.count),
      'actual gate parameter array missing'
    );
    if (r > 0) {
      const prior = records[r - 1]!,
        priorQuantum = quanta[candidates[0]! + r - 1]!;
      assert.equal(
        Number(record['callbackOrdinal']),
        Number(prior['callbackOrdinal']) + 1,
        'gate trace callback sequence gap'
      );
      assert.equal(
        Number(record['sampleCount']),
        Number(prior['sampleCount']) + priorQuantum.count,
        'gate trace cumulative offset gap'
      );
    }
    for (let i = 0; i < quantum.count; i++) {
      const actual = carrierFrame(quantum.chunk, quantum.offset + i, witness);
      const relative = frames[i]!;
      assert.ok(
        actual !== null &&
          Number.isFinite(relative) &&
          Math.abs(relative - Math.round(relative)) < 1 / 16 &&
          tags[tags.length === 1 ? 0 : i] === active.serial,
        'native clock parameter or independent carrier invalid'
      );
      assert.equal(
        active.startFrame + Math.round(relative),
        actual,
        'gate parameter and independent carrier disagree'
      );
      assert.ok(actual < active.endFrame, 'gate parameter exceeds active bank');
      if (i === 0)
        assert.equal(
          record['certifiedFrame'],
          actual,
          'gate certified wrong frame'
        );
      const warming = record['warming'] as {
        bank: 0 | 1;
        serial: number;
        startFrame: number;
        endFrame: number;
        clockEpoch: number;
      } | null;
      if (
        warming &&
        actual - i >= warming.startFrame &&
        actual + (quantum.count - i) <= warming.endFrame
      ) {
        const warmSuffix = warming.bank === 0 ? 'A' : 'B';
        const warmFrames = record['clockFrame' + warmSuffix],
          warmTags = record['clockTag' + warmSuffix];
        assert.ok(
          warming.bank !== active.bank &&
            warming.clockEpoch === active.clockEpoch &&
            Array.isArray(warmFrames) &&
            warmFrames.length === quantum.count &&
            Array.isArray(warmTags) &&
            (warmTags.length === 1 || warmTags.length === quantum.count),
          'warming bank evidence missing'
        );
        const warm = warmFrames[i];
        assert.ok(
          Number.isFinite(warm) &&
            Math.abs(warm - Math.round(warm)) < 1 / 16 &&
            warmTags[warmTags.length === 1 ? 0 : i] === warming.serial &&
            warming.startFrame + Math.round(warm) === actual,
          'warming bank disagrees with independent carrier'
        );
      }
    }
  }
  return associationOffset;
}

// Names the terminal clock fault recorded by the real gate, if any. Read-only
// evidence for a failure message; it never changes what the assertions accept.
function describeClockFault(trace: MovingTrace['trace']): string {
  const fault = trace.events.find(
    (event) =>
      event.kind === 'scheduled-pcm' &&
      event.value !== null &&
      typeof event.value === 'object' &&
      (event.value as Record<string, unknown>)['event'] ===
        'clock-fault-diagnostic'
  );
  const gate = trace.events.find(
    (event) =>
      event.kind === 'transport-message' &&
      event.value !== null &&
      typeof event.value === 'object' &&
      ['clock-fault', 'anchor-late'].includes(
        String((event.value as Record<string, unknown>)['type'])
      )
  );
  const skipped = trace.events.find(
    (event) => event.kind === 'clock-stale-stop-skipped'
  );
  return [
    `gate clock-fault: ${gate ? JSON.stringify(gate.value) : 'none'}`,
    `fault diagnostic: ${fault ? JSON.stringify(fault.value) : 'none'}`,
    `stop skipped: ${skipped ? JSON.stringify(skipped.value) : 'no'}`,
  ].join('; ');
}

// A rare cached-global duplicate is evidence only when the real production
// gate observed it and both quanta agree with the separately scheduled carrier
// and source PCM. This is deliberately separate from the steady trace window.
function assertNaturalStaleWitness(
  trace: MovingTrace['trace'],
  f0: number,
  expected: readonly [Float32Array, Float32Array],
  associationOffset: number
): void {
  const witness = trace.witness;
  assert.ok(witness, 'independent stale-event carrier unavailable');
  const messages = trace.events
    .filter((event) => event.kind === 'transport-message')
    .map((event) => event.value as Record<string, unknown>);
  const captureId = trace.staleCaptureId;
  assert.ok(
    Number.isSafeInteger(captureId) && Number(captureId) > 0,
    'stale capture id missing'
  );
  assert.ok(
    !messages.some(
      (message) =>
        message?.['type'] === 'clock-stale-overflow' ||
        message?.['type'] === 'clock-stale-control-error'
    ) &&
      !trace.events.some(
        (event) => event.kind === 'clock-stale-control-timeout'
      ),
    'stale-pair recorder overflow or control failure'
  );
  const starts = messages.filter(
    (message) =>
      message?.['type'] === 'clock-stale-started' &&
      message['clockEpoch'] === witness.clockEpoch &&
      message['captureId'] === captureId
  );
  const stops = messages.filter(
    (message) =>
      message?.['type'] === 'clock-stale-stopped' &&
      message['clockEpoch'] === witness.clockEpoch &&
      message['captureId'] === captureId
  );
  assert.equal(
    starts.length,
    1,
    'stale capture start acknowledgment missing or duplicated'
  );
  assert.equal(
    stops.length,
    1,
    `stale capture stop acknowledgment missing or duplicated; ${describeClockFault(trace)}`
  );
  assert.ok(
    Number.isSafeInteger(starts[0]!['afterCallbackOrdinal']) &&
      Number.isSafeInteger(stops[0]!['lastCallbackOrdinal']) &&
      stops[0]!['overflow'] === false,
    'stale capture boundary or overflow invalid'
  );
  const pairs = messages.filter(
    (message) =>
      message?.['type'] === 'clock-stale-pair' &&
      message['clockEpoch'] === witness.clockEpoch &&
      message['captureId'] === captureId
  );
  assert.equal(
    pairs.length,
    stops[0]!['pairs'],
    'stale capture pair count mismatch'
  );
  const startIndex = messages.indexOf(starts[0]!),
    stopIndex = messages.indexOf(stops[0]!);
  assert.ok(
    startIndex < stopIndex &&
      pairs.every((pair) => {
        const index = messages.indexOf(pair);
        return index > startIndex && index < stopIndex;
      }),
    'stale-pair messages are outside their acknowledged capture window'
  );
  assert.ok(
    pairs.length > 0,
    'no actual cached-global duplicate observed by the production gate'
  );
  const quanta: Array<{
    label: number;
    count: number;
    chunk: MovingTrace['trace']['audio'][number];
    offset: number;
    sampleOffset: number;
  }> = [];
  for (const chunk of trace.audio) {
    assert.ok(
      chunk.quantumFrames && chunk.quantumLengths && chunk.quantumOffsets,
      'tap callback provenance missing'
    );
    let offset = 0;
    for (let i = 0; i < chunk.quantumFrames.length; i++) {
      quanta.push({
        label: chunk.quantumFrames[i]!,
        count: chunk.quantumLengths[i]!,
        chunk,
        offset,
        sampleOffset: chunk.quantumOffsets[i]!,
      });
      offset += chunk.quantumLengths[i]!;
    }
  }
  let audiblePairs = 0;
  for (const pair of pairs) {
    const previous = pair['previous'] as Record<string, unknown> | undefined;
    const current = pair['current'] as Record<string, unknown> | undefined;
    assert.ok(
      previous &&
        current &&
        pair['clockEpoch'] === witness.clockEpoch &&
        previous['cachedCurrentFrame'] === current['cachedCurrentFrame'] &&
        Number(current['callbackOrdinal']) ===
          Number(previous['callbackOrdinal']) + 1 &&
        Number(current['sampleCount']) ===
          Number(previous['sampleCount']) + Number(previous['quantumLength']) &&
        Number(previous['callbackOrdinal']) >
          Number(starts[0]!['afterCallbackOrdinal']) &&
        Number(current['callbackOrdinal']) <=
          Number(stops[0]!['lastCallbackOrdinal']),
      'stale recorder did not retain adjacent actual gate callbacks'
    );
    const indices = quanta.flatMap((quantum, index) =>
      quantum.sampleOffset ===
        Number(previous['sampleCount']) + associationOffset &&
      quanta[index + 1]?.sampleOffset ===
        Number(current['sampleCount']) + associationOffset &&
      quantum.label === previous['cachedCurrentFrame'] &&
      quanta[index + 1]?.label === current['cachedCurrentFrame'] &&
      quantum.count === previous['quantumLength'] &&
      quanta[index + 1]?.count === current['quantumLength']
        ? [index]
        : []
    );
    assert.equal(
      indices.length,
      1,
      'stale gate callbacks cannot be uniquely correlated with independent tap'
    );
    let precedingEnd: number | null = null,
      inside = true,
      energy = 0;
    for (const [record, index] of [
      [previous, indices[0]!],
      [current, indices[0]! + 1],
    ] as const) {
      const quantum = quanta[index]!;
      const active = record['active'] as {
        bank: 0 | 1;
        serial: number;
        startFrame: number;
        endFrame: number;
        clockEpoch: number;
      };
      assert.ok(
        active &&
          (active.bank === 0 || active.bank === 1) &&
          active.clockEpoch === witness.clockEpoch &&
          Number.isSafeInteger(active.serial) &&
          Number.isSafeInteger(active.startFrame) &&
          Number.isSafeInteger(active.endFrame),
        'stale-pair bank descriptor invalid'
      );
      const suffix = active.bank === 0 ? 'A' : 'B';
      const frames = record['clockFrame' + suffix],
        tags = record['clockTag' + suffix];
      assert.ok(
        Array.isArray(frames) &&
          frames.length === quantum.count &&
          Array.isArray(tags) &&
          (tags.length === 1 || tags.length === quantum.count),
        'stale-pair native parameter samples unavailable'
      );
      for (let i = 0; i < quantum.count; i++) {
        const sourceFrame = carrierFrame(
            quantum.chunk,
            quantum.offset + i,
            witness
          ),
          value: number = frames[i];
        assert.ok(
          sourceFrame !== null &&
            Number.isFinite(value) &&
            Math.abs(value - Math.round(value)) < 1 / 16 &&
            tags[tags.length === 1 ? 0 : i] === active.serial &&
            active.startFrame + Math.round(value) === sourceFrame &&
            sourceFrame < active.endFrame,
          'stale-pair bank disagrees with independent source carrier'
        );
        if (i === 0) {
          assert.equal(
            record['certifiedFrame'],
            sourceFrame,
            'stale-pair certified frame mismatch'
          );
        }
        if (precedingEnd !== null)
          assert.equal(
            sourceFrame,
            precedingEnd,
            'stale-pair repeated or omitted source samples'
          );
        precedingEnd = sourceFrame + 1;
        const n = sourceFrame - f0;
        if (n < 0 || n >= expected[0].length || n >= expected[1].length) {
          inside = false;
          continue;
        }
        for (let ch = 0; ch < 2; ch++) {
          const actual = quantum.chunk.channels[ch]![quantum.offset + i]!,
            reference = expected[ch]![n]!;
          assert.ok(
            Number.isFinite(actual) &&
              Number.isFinite(reference) &&
              Math.abs(actual - reference) <= 0.003,
            'stale-pair source PCM mismatch'
          );
          energy += reference * reference;
        }
      }
    }
    if (inside && energy > 1e-8) audiblePairs++;
  }
  assert.ok(
    audiblePairs > 0,
    'no stale-pair covered audible independently referenced player PCM'
  );
}

function assertStaleWitnessControls(
  trace: MovingTrace['trace'],
  f0: number,
  expected: readonly [Float32Array, Float32Array],
  associationOffset: number
): void {
  const witness = trace.witness;
  assert.ok(witness, 'independent stale-control witness missing');
  const chosen = trace.events.find((event) => {
    if (
      event.kind !== 'transport-message' ||
      !event.value ||
      typeof event.value !== 'object' ||
      !('type' in event.value) ||
      event.value.type !== 'clock-stale-pair' ||
      !('current' in event.value) ||
      !event.value.current ||
      typeof event.value.current !== 'object' ||
      !('certifiedFrame' in event.value.current) ||
      !('quantumLength' in event.value.current) ||
      !('previous' in event.value) ||
      !event.value.previous ||
      typeof event.value.previous !== 'object' ||
      !('certifiedFrame' in event.value.previous)
    )
      return false;
    const frame = Number(event.value.current.certifiedFrame);
    return (
      Number(event.value.previous.certifiedFrame) >= f0 &&
      frame + Number(event.value.current.quantumLength) <=
        f0 + expected[0].length
    );
  });
  assert.ok(chosen, 'no actual source-bound stale event for negative controls');
  const pair = chosen.value as { current: { certifiedFrame: number } };
  const targetFrame = pair.current.certifiedFrame;
  for (const kind of [
    'missing-pair',
    'missing-stop',
    'stop-short',
    'overflow',
    'foreign-capture',
    'shifted-bank',
    'corrupt-carrier',
    'corrupt-pcm',
  ] as const) {
    const corrupt = structuredClone(trace);
    if (kind === 'missing-pair') {
      corrupt.events = corrupt.events.filter(
        (event) =>
          !(
            event.kind === 'transport-message' &&
            event.value &&
            typeof event.value === 'object' &&
            'type' in event.value &&
            event.value.type === 'clock-stale-pair'
          )
      );
    } else if (kind === 'overflow') {
      corrupt.events.push({
        kind: 'transport-message',
        timestamp: chosen.timestamp,
        value: { type: 'clock-stale-overflow' },
      });
    } else if (kind === 'foreign-capture') {
      const event = corrupt.events.find(
        (entry) =>
          entry.kind === 'transport-message' &&
          entry.value &&
          typeof entry.value === 'object' &&
          'type' in entry.value &&
          entry.value.type === 'clock-stale-pair'
      );
      assert.ok(
        event?.value &&
          typeof event.value === 'object' &&
          'captureId' in event.value,
        'stale pair capture id unavailable'
      );
      event.value.captureId = Number(event.value.captureId) + 1;
    } else if (kind === 'shifted-bank') {
      const event = corrupt.events.find(
        (entry) =>
          entry.kind === 'transport-message' &&
          entry.value &&
          typeof entry.value === 'object' &&
          'type' in entry.value &&
          entry.value.type === 'clock-stale-pair'
      );
      assert.ok(
        event?.value &&
          typeof event.value === 'object' &&
          'current' in event.value,
        'bank corruption did not reach a stale event'
      );
      const current = event.value.current as Record<string, unknown>;
      const active = current['active'] as { bank: number };
      const frames = current[active.bank === 0 ? 'clockFrameA' : 'clockFrameB'];
      assert.ok(
        Array.isArray(frames) && frames.length > 0,
        'stale bank samples missing'
      );
      frames[0] = Number(frames[0]) + 1;
    } else if (kind === 'missing-stop') {
      corrupt.events = corrupt.events.filter(
        (event) =>
          !(
            event.kind === 'transport-message' &&
            event.value &&
            typeof event.value === 'object' &&
            'type' in event.value &&
            event.value.type === 'clock-stale-stopped'
          )
      );
    } else if (kind === 'stop-short') {
      const event = corrupt.events.find(
        (entry) =>
          entry.kind === 'transport-message' &&
          entry.value &&
          typeof entry.value === 'object' &&
          'type' in entry.value &&
          entry.value.type === 'clock-stale-stopped'
      );
      assert.ok(
        event?.value &&
          typeof event.value === 'object' &&
          'pairs' in event.value,
        'stale stop record unavailable'
      );
      event.value.pairs = Number(event.value.pairs) - 1;
    } else {
      let injected = false;
      for (const chunk of corrupt.audio) {
        for (let i = 0; i < chunk.channels[0]!.length; i++) {
          if (carrierFrame(chunk, i, witness) !== targetFrame) continue;
          if (kind === 'corrupt-carrier') {
            assert.ok(chunk.witness?.[1], 'stale carrier channel missing');
            chunk.witness[1][i] = (chunk.witness[1][i]! + 1) % 65536;
          } else chunk.channels[0]![i] = chunk.channels[0]![i]! + 0.1;
          injected = true;
          break;
        }
        if (injected) break;
      }
      assert.ok(injected, `${kind} did not reach the stale callback`);
    }
    const verify = () =>
      assertNaturalStaleWitness(corrupt, f0, expected, associationOffset);
    if (kind === 'corrupt-carrier')
      assert.throws(verify, /stale-pair bank disagrees/);
    else
      assert.throws(verify, `${kind} stale-event corruption passed admission`);
  }
}
interface ScheduledPcmComparison {
  sampleCount: number;
  rmse: [number, number];
  shiftedRmse: [number, number];
  swappedRmse: [number, number];
  mutedPrefixRmse: [number, number];
}

function assertLatestRecoveryFrame(
  trace: MovingTrace['trace'],
  selection: Record<string, unknown>,
  boundary: number,
  rate: number,
  audioOnly: boolean
): void {
  const generation = selection['generation'];
  const request = trace.events.find(
    (event) =>
      event.kind === 'scheduled-pcm' &&
      (event.value as Record<string, unknown>)?.['event'] ===
        'recovery-request' &&
      (event.value as Record<string, unknown>)?.['boundaryFrame'] ===
        boundary &&
      (event.value as Record<string, unknown>)?.['generation'] ===
        selection['oldGeneration']
  );
  const inputsEvent = trace.events.find(
    (event) =>
      event.kind === 'scheduled-pcm' &&
      (event.value as Record<string, unknown>)?.['event'] ===
        'recovery-selection-inputs' &&
      (event.value as Record<string, unknown>)?.['generation'] === generation
  );
  assert.ok(
    request && inputsEvent,
    'missing independent recovery request or inputs'
  );
  const origin = request.value as Record<string, unknown>,
    input = inputsEvent.value as Record<string, unknown>;
  const before = Number(origin['requestPerformanceBefore']),
    after = Number(origin['requestPerformanceAfter']);
  const requestWall = Number(selection['requestWall']),
    deadline = Number(selection['deadline']);
  assert.ok(
    Number.isFinite(before) &&
      Number.isFinite(after) &&
      before <= requestWall &&
      requestWall <= after &&
      after <= request.timestamp &&
      deadline === requestWall + 350,
    'recovery reset its original request deadline'
  );
  assert.ok(
    input['boundaryFrame'] === boundary &&
      input['sampleRate'] === rate &&
      input['guardFrames'] === 512 &&
      input['compositionStartFrame'] === selection['compositionStartFrame'] &&
      Array.isArray(input['phaseSamples']),
    'invalid raw recovery bounds'
  );
  const bridge = input['bridge'] as {
    contextTime: number;
    performanceTime: number;
    mappingAllowanceMs: number;
  };
  const vsync = Number(input['vsyncSeconds']),
    contextNow = Number(input['contextAfterSeconds']);
  const firstBatch = Number(input['firstBatchFrames']),
    coverage = Number(input['clockCoverageEnd']);
  const horizon = Number(input['horizonSeconds']),
    scheduled = Number(input['scheduledThrough']);
  const visual = input['visualThrough'] as { value: number; rate: number };
  assert.ok(
    bridge &&
      [
        bridge.contextTime,
        bridge.performanceTime,
        bridge.mappingAllowanceMs,
        vsync,
        contextNow,
        horizon,
      ].every(Number.isFinite) &&
      bridge.mappingAllowanceMs >= 0 &&
      vsync > 0 &&
      Number.isSafeInteger(firstBatch) &&
      firstBatch > 0 &&
      Number.isSafeInteger(coverage) &&
      Number.isSafeInteger(scheduled) &&
      visual &&
      Number.isFinite(visual.value) &&
      Number.isFinite(visual.rate) &&
      visual.rate > 0,
    'invalid native recovery bounds'
  );
  assert.equal(
    horizon,
    0.5,
    'recovery horizon differs from the PCM scheduling policy'
  );
  const firstScheduled = trace.events
    .filter(
      (event) =>
        event.kind === 'scheduled-pcm' &&
        event.value &&
        typeof event.value === 'object' &&
        'event' in event.value &&
        event.value.event === 'scheduled' &&
        'generation' in event.value &&
        event.value.generation === generation &&
        'contextStartFrame' in event.value &&
        event.value.contextStartFrame === selection['f0']
    )
    .map((event) => event.value as Record<string, unknown>);
  assert.ok(
    firstScheduled.length > 0 &&
      Math.max(
        ...firstScheduled.map(
          (event) =>
            Number(event['contextEndFrame']) -
            Number(event['contextStartFrame'])
        )
      ) === firstBatch,
    'first-batch horizon is not supported by the real scheduled sources'
  );
  const coverageEvents = trace.events.filter(
    (event) =>
      event.kind === 'transport-message' &&
      event.timestamp <= inputsEvent.timestamp &&
      event.value &&
      typeof event.value === 'object' &&
      'type' in event.value &&
      (event.value.type === 'anchor-certified' ||
        event.value.type === 'clock-promoted') &&
      'clockEpoch' in event.value &&
      event.value.clockEpoch === selection['clockEpoch'] &&
      'clockCoverageEnd' in event.value
  );
  const lastCoverage = coverageEvents.at(-1)?.value as
    | Record<string, unknown>
    | undefined;
  assert.equal(
    lastCoverage?.['clockCoverageEnd'],
    coverage,
    'coverage upper bound did not come from the accepted carrier bank'
  );
  const native = trace.events.find(
    (event) =>
      event.kind === 'audio-output-timestamp-observed' &&
      event.value &&
      typeof event.value === 'object' &&
      'output' in event.value &&
      event.value.output &&
      typeof event.value.output === 'object' &&
      'contextTime' in event.value.output &&
      'performanceTime' in event.value.output &&
      event.value.output.contextTime === bridge.contextTime &&
      event.value.output.performanceTime === bridge.performanceTime &&
      'injected' in event.value &&
      event.value.injected === false &&
      event.timestamp <= inputsEvent.timestamp
  );
  assert.ok(
    native,
    'recovery bridge was not read from the native output clock'
  );
  const band = recoveryPhaseBand(
    input['phaseSamples'] as Record<string, unknown>[],
    vsync,
    audioOnly
  );
  const phaseUpper = band.upper;
  const phaseLower = band.lower;
  const wallUpper = Math.floor(
    (bridge.contextTime +
      (Math.min(phaseUpper - bridge.mappingAllowanceMs, deadline) -
        bridge.performanceTime) /
        1000) *
      rate
  );
  const horizonUpper = Math.floor((contextNow + horizon) * rate) - firstBatch;
  const latest = Math.min(
    boundary + Math.floor(0.02 * rate),
    wallUpper,
    horizonUpper,
    coverage - 1
  );
  const frame = Number(selection['f0']);
  const safeWall = Math.max(
    phaseLower + bridge.mappingAllowanceMs,
    requestWall,
    Number(input['readEndWallMs'])
  );
  const earliest = Math.max(
    boundary,
    Math.ceil(contextNow * rate) + 512,
    Math.ceil(
      (bridge.contextTime + (safeWall - bridge.performanceTime) / 1000) * rate
    )
  );
  assert.ok(
    Number.isSafeInteger(frame) &&
      frame >= earliest &&
      frame <= latest &&
      Math.min(scheduled, Math.floor((visual.value * rate) / visual.rate)) >
        Number(input['compositionStartFrame']),
    'selected recovery frame is outside independent feasibility bounds'
  );
  assert.ok(
    Number.isSafeInteger(latest) && frame === latest,
    `recovery F1 is not latest independently feasible frame: ${frame} vs ${latest}`
  );
}

// Independent lookahead invariant. Runtime frontier events carry two coordinates:
// contextFrameThrough is the gate/context frame, while preparedThrough, scopeEndFrame,
// decodedCap and descriptorCoverageEnd are composition frames at the sample rate.
// The lookahead gap is therefore measured on compositionThrough.value (the
// composition frame of the gate frontier), never on the context coordinate.
const LOOKAHEAD_FRAMES = 4096;
function assertLookaheadFrontiers(
  events: readonly Record<string, unknown>[],
  rate: number
): number {
  let checked = 0;
  for (const event of events) {
    if (event['event'] !== 'frontier') continue;
    const composition = event['compositionThrough'] as
      | { value?: unknown; rate?: unknown }
      | undefined;
    assert.ok(
      composition &&
        Number.isSafeInteger(composition.value) &&
        composition.rate === rate,
      'frontier lacks a composition-coordinate frontier'
    );
    const B = Number(composition.value);
    const P = Number(event['preparedThrough']);
    const S = Number(event['scopeEndFrame']);
    const K = Number(event['reserveFrames']);
    const E = Number(event['descriptorCoverageEnd']);
    const cap = Number(event['decodedCap']);
    assert.ok(
      [B, P, S, K, E, cap].every(Number.isSafeInteger) &&
        typeof event['descriptorReady'] === 'boolean',
      'frontier lacks independent lookahead evidence'
    );
    // Successor handoff frontiers are governed by assertSuccessorPolicy (planner
    // decision): they are exempt from the ordinary I1 gap, not from its window.
    if (event['frontierKind'] === 'handoff') {
      checked++;
      continue;
    }
    const terminal = P === S;
    if (!terminal)
      assert.ok(
        P - B >= LOOKAHEAD_FRAMES,
        `frontier ${B} is within ${P - B} decoded frames of P=${P}, below K=${LOOKAHEAD_FRAMES}`
      );
    assert.equal(
      K,
      terminal ? 0 : LOOKAHEAD_FRAMES,
      'frontier used a non-policy lookahead'
    );
    assert.equal(
      cap,
      terminal ? S : P - LOOKAHEAD_FRAMES,
      'decoded cap disagrees with the lookahead invariant'
    );
    assert.ok(B <= cap, 'frontier exceeds the decoded horizon');
    if (terminal) {
      // Scope end: no successor exists, readiness is vacuous, and the half-open
      // frontier may equal the coverage end.
      assert.ok(
        B === E && B <= S,
        'terminal frontier does not end at its descriptor coverage'
      );
    } else {
      // Readiness is enforced at closure (assertSuccessorPolicy). An ordinary
      // frontier only must not pass the descriptor coverage it was accepted against.
      assert.ok(B <= E, 'nonterminal frontier exceeds its descriptor coverage');
    }
    checked++;
  }
  return checked;
}

// Successor policy (planner decision). A successor's first arm may only follow a
// predecessor closure that reported descriptorReady, and it must land inside that
// predecessor's descriptor window (B_old, min(B_old+K, E)]. In a healthy-decode run it
// must additionally keep the full reserve P-B >= K. A closure that was not ready
// must never be followed by a successor epoch.
function assertSuccessorPolicy(
  events: readonly Record<string, unknown>[],
  healthy: boolean
): number {
  let closure: Record<string, unknown> | null = null;
  let checked = 0;
  for (const event of events) {
    if (event['event'] === 'recovery-render-closed') {
      const stop = event['compositionStop'] as { value?: unknown } | undefined;
      assert.ok(
        typeof event['descriptorReady'] === 'boolean' &&
          Number.isSafeInteger(Number(event['preparedThrough'])) &&
          Number.isSafeInteger(Number(event['descriptorCoverageEnd'])) &&
          Number.isSafeInteger(Number(stop?.value)),
        'closure lacks the P, B and readiness receipt'
      );
      closure = event;
      continue;
    }
    if (event['event'] === 'frontier' && event['frontierKind'] === 'handoff') {
      if (closure === null)
        throw new Error('successor handoff has no predecessor closure');
      const predecessor: Record<string, unknown> = closure;
      assert.equal(
        predecessor['descriptorReady'],
        true,
        'successor emitted after a non-ready closure'
      );
      const stop = predecessor['compositionStop'] as { value: unknown };
      assert.ok(
        Number.isSafeInteger(stop.value),
        'predecessor closure lacks a composition frontier'
      );
      const Bold = Number(stop.value);
      const E = Number(predecessor['descriptorCoverageEnd']);
      const composition = event['compositionThrough'] as { value: number };
      const Bnew = Number(composition.value);
      const P = Number(event['preparedThrough']);
      assert.ok(
        Bnew > Bold && Bnew <= Math.min(Bold + LOOKAHEAD_FRAMES, E),
        `successor ${Bnew} outside predecessor window (${Bold}, ${Math.min(Bold + LOOKAHEAD_FRAMES, E)}]`
      );
      if (healthy)
        assert.ok(
          P - Bnew >= LOOKAHEAD_FRAMES,
          `healthy successor ${Bnew} lacks its reserve below P=${P}`
        );
      closure = null;
      checked++;
    }
  }
  return checked;
}

// Compare each sample against independent source planes without fitting offsets.
function assertSourcePcmSamples(
  trace: MovingTrace['trace'],
  f0: number,
  expected: readonly [Float32Array, Float32Array],
  first: number,
  end: number
): void {
  const witness = trace.witness;
  assert.ok(
    witness &&
      Number.isSafeInteger(f0) &&
      Number.isSafeInteger(first) &&
      Number.isSafeInteger(end) &&
      first >= 0 &&
      end > first &&
      end <= expected[0].length &&
      end <= expected[1].length,
    'invalid pointwise PCM reference'
  );
  assertPcmCoverage(f0 + first, f0 + end, trace.audio, witness);
  let seen = 0;
  for (const chunk of trace.audio)
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null) continue;
      const index = frame - f0;
      if (index < first || index >= end) continue;
      for (let ch = 0; ch < 2; ch++) {
        const actual = chunk.channels[ch]![i]!,
          reference = expected[ch]![index]!;
        assert.ok(
          Number.isFinite(actual) &&
            Number.isFinite(reference) &&
            Math.abs(actual - reference) <= 0.003,
          `source-bound PCM sample mismatch at ${index}, channel ${ch}`
        );
      }
      seen++;
    }
  assert.equal(
    seen,
    end - first,
    'pointwise PCM reference interval incomplete'
  );
}

// Context frame F0 owns expected sample zero in both channels.
function compareScheduledPcm(
  chunks: MovingTrace['trace']['audio'],
  f0: number,
  expected: readonly [Float32Array, Float32Array],
  first: number,
  end: number,
  witness: MovingTrace['trace']['witness']
): ScheduledPcmComparison {
  assert.ok(
    Number.isSafeInteger(f0) &&
      Number.isSafeInteger(first) &&
      Number.isSafeInteger(end)
  );
  assert.ok(
    first >= 0 &&
      end > first &&
      end <= expected[0].length &&
      end <= expected[1].length
  );
  assert.ok(
    chunks.length > 0 && chunks[chunks.length - 1]!.channels[0],
    'scheduled PCM capture is empty'
  );
  assertPcmCoverage(f0 + first, f0 + end, chunks, witness);
  assert.ok(witness, 'independent native carrier unavailable');
  const sums = [0, 0],
    shifted = [0, 0],
    mutedPrefix = [0, 0],
    swapped = [0, 0];
  let count = 0;
  const prefixEnd = Math.min(end, first + 960);
  for (const chunk of chunks) {
    assert.equal(
      chunk.channels.length,
      2,
      'scheduled output must capture stereo'
    );
    assert.equal(
      chunk.channels[0]!.length,
      chunk.channels[1]!.length,
      'stereo capture length mismatch'
    );
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null) continue;
      const index = frame - f0;
      if (index < first || index >= end) continue;
      for (let ch = 0; ch < 2; ch++) {
        const actual = chunk.channels[ch]![i]!;
        const reference = expected[ch]![index]!;
        assert.ok(
          Number.isFinite(actual) && Number.isFinite(reference),
          'non-finite PCM'
        );
        sums[ch]! += (actual - reference) ** 2;
        const oneSampleLate = index > first ? expected[ch]![index - 1]! : 0;
        shifted[ch]! += (oneSampleLate - reference) ** 2;
        swapped[ch]! += (expected[1 - ch]![index]! - reference) ** 2;
        if (index < prefixEnd) mutedPrefix[ch]! += reference ** 2;
      }
      count++;
    }
  }
  assert.equal(
    count,
    end - first,
    'scheduled PCM does not cover the complete expected frame range'
  );
  const metric = (values: number[]): [number, number] => [
    Math.sqrt(values[0]! / count),
    Math.sqrt(values[1]! / count),
  ];
  return {
    sampleCount: count,
    rmse: metric(sums),
    shiftedRmse: metric(shifted),
    swappedRmse: metric(swapped),
    mutedPrefixRmse: [
      Math.sqrt(mutedPrefix[0]! / (prefixEnd - first)),
      Math.sqrt(mutedPrefix[1]! / (prefixEnd - first)),
    ],
  };
}

async function comparePostGainPcm(
  capture: MovingTrace,
  referenceCache: Map<number, Float32Array>,
  healthyRms: number,
  mutedRms: number,
  requireSustainedAgreement = true,
  sourceActiveFrame?: number
): Promise<{
  offset: number;
  correlation: number;
  gain: number;
  longestDropoutMs: number;
  agreement: Array<{ start: number; observed: number; repeated: number }>;
  agreementFloor: number | null;
  repeatedCeiling: number | null;
}> {
  const trace = capture.trace;
  // A scheduled capture carries the independent carrier, which authenticates
  // coverage where the engine repeats a cached currentFrame label. A native
  // capture has no carrier, so its raw labels are the only authority.
  const carried = trace.witness !== null && trace.witness !== undefined;
  if (carried)
    assertPcmCoverage(
      capture.start.sampleFrame,
      trace.sampleFrame,
      trace.audio,
      trace.witness
    );
  else
    assertPcmSequence(
      capture.start.sampleFrame,
      trace.sampleFrame,
      trace.audio
    );
  const rate = trace.sampleRate;
  assert.ok(Number.isFinite(rate) && rate > 0, 'invalid PCM sample rate');
  let reference = referenceCache.get(rate);
  if (!reference) {
    const decoded = await runChild(
      [
        'ffmpeg',
        '-v',
        'error',
        '-i',
        join(fixtureDir, 'media', 'mx_bed.wav'),
        '-af',
        'pan=mono|c0=c0',
        '-ar',
        String(rate),
        '-f',
        'f32le',
        'pipe:1',
      ],
      { timeoutMs: 30000 }
    );
    assert.equal(
      decoded.exit,
      0,
      `source audio decode failed: ${decoded.stderr}`
    );
    assert.equal(decoded.stdout.length % 4, 0, 'source PCM is truncated');
    reference = new Float32Array(decoded.stdout.length / 4);
    for (let i = 0; i < reference.length; i++)
      reference[i] = decoded.stdout.readFloatLE(i * 4);
    referenceCache.set(rate, reference);
  }
  assert.ok(
    trace.audio.length > 0 && !trace.audioOverflow,
    'post-gain PCM unavailable'
  );
  for (let i = 1; !carried && i < trace.audio.length; i++) {
    const previous = trace.audio[i - 1]!;
    assert.ok(previous.channels[0], 'post-gain PCM channel missing');
    assert.equal(
      trace.audio[i]!.sampleFrame,
      previous.sampleFrame + previous.channels[0].length,
      'post-gain PCM has a missing chunk'
    );
  }
  const captured = trace.audio.flatMap((chunk) => chunk.channels[0] ?? []);
  const n = Math.min(Math.floor(rate * 0.5), captured.length);
  assert.ok(n >= rate * 0.25, 'post-gain PCM too short to align');
  const maxOffset = Math.min(Math.floor(rate), reference.length - n);
  const minOffset = -Math.min(Math.floor(rate), n - Math.ceil(rate * 0.25));
  assert.ok(maxOffset > 0, 'source PCM too short to align');
  const stride = Math.max(1, Math.floor(rate / 1000));
  const score = (offset: number): { correlation: number; gain: number } => {
    let cross = 0,
      sourceEnergy = 0,
      capturedEnergy = 0;
    for (let i = 0; i < n; i += stride) {
      const sourceIndex = offset + i;
      if (sourceIndex < 0 || sourceIndex >= reference!.length) continue;
      const source = reference![sourceIndex]!,
        actual = captured[i]!;
      cross += source * actual;
      sourceEnergy += source * source;
      capturedEnergy += actual * actual;
    }
    return {
      correlation: cross / Math.sqrt(sourceEnergy * capturedEnergy),
      gain: cross / sourceEnergy,
    };
  };
  const coarseCandidates: Array<{ offset: number; correlation: number }> = [];
  for (let candidate = minOffset; candidate <= maxOffset; candidate += stride) {
    const correlation = score(candidate).correlation;
    if (Number.isFinite(correlation))
      coarseCandidates.push({ offset: candidate, correlation });
  }
  coarseCandidates.sort((a, b) => b.correlation - a.correlation);
  let offset = 0,
    best = -Infinity;
  for (const coarse of coarseCandidates.slice(0, 16))
    for (
      let candidate = Math.max(minOffset, coarse.offset - stride);
      candidate <= Math.min(maxOffset, coarse.offset + stride);
      candidate++
    ) {
      const current = score(candidate).correlation;
      if (Number.isFinite(current) && current > best) {
        best = current;
        offset = candidate;
      }
    }
  const aligned = score(offset);
  assert.ok(
    aligned.correlation > 0 && aligned.gain > 0,
    'post-gain PCM could not be correlated to source'
  );
  const window = Math.max(1, Math.round(rate * 0.005));
  const threshold = Math.max(mutedRms * 2, healthyRms * 0.01);
  let run = 0,
    longest = sourceActiveFrame === undefined ? Math.max(0, -offset) : 0;
  assert.ok(
    reference.length - offset >= captured.length,
    'source PCM does not cover the full capture'
  );
  const length = captured.length;
  const sourceSample = (index: number) => (index < 0 ? 0 : reference![index]!);
  let sourceEnergy = 0,
    actualEnergy = 0;
  for (let i = 0; i < Math.min(window, length); i++) {
    sourceEnergy += (sourceSample(offset + i) * aligned.gain) ** 2;
    actualEnergy += captured[i]! ** 2;
  }
  for (let start = 0; start + window <= length; start++) {
    if (start > 0) {
      sourceEnergy +=
        (sourceSample(offset + start + window - 1) * aligned.gain) ** 2 -
        (sourceSample(offset + start - 1) * aligned.gain) ** 2;
      actualEnergy +=
        captured[start + window - 1]! ** 2 - captured[start - 1]! ** 2;
    }
    if (
      sourceActiveFrame !== undefined &&
      capture.start.sampleFrame + start < sourceActiveFrame
    )
      continue;
    const expected = Math.sqrt(Math.max(0, sourceEnergy) / window);
    const actual = Math.sqrt(Math.max(0, actualEnergy) / window);
    if (expected > threshold && actual <= threshold) {
      run = run === 0 ? window : run + 1;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  const agreement: Array<{
    start: number;
    observed: number;
    repeated: number;
  }> = [];
  const segment = Math.floor(rate * 0.25);
  const replayLength = Math.floor(rate * 0.5);
  for (let start = replayLength; start + segment <= length; start += segment) {
    let cross = 0,
      replayCross = 0,
      sourcePower = 0,
      power = 0,
      replayPower = 0;
    for (let i = 0; i < segment; i += stride) {
      const expected = sourceSample(offset + start + i);
      const actual = captured[start + i]!;
      const replay = captured[(start + i) % replayLength]!;
      cross += expected * actual;
      replayCross += expected * replay;
      sourcePower += expected * expected;
      power += actual * actual;
      replayPower += replay * replay;
    }
    if (Math.sqrt(power / Math.ceil(segment / stride)) <= threshold) continue;
    const observed = cross / Math.sqrt(sourcePower * power);
    const repeated = replayCross / Math.sqrt(sourcePower * replayPower);
    assert.ok(
      Number.isFinite(observed) && Number.isFinite(repeated),
      'audio agreement window is undefined'
    );
    agreement.push({ start, observed, repeated });
  }
  if (requireSustainedAgreement)
    assert.ok(agreement.length > 0, 'no sustained audio agreement windows');
  const agreementFloor = agreement.length
    ? Math.min(...agreement.map((entry) => entry.observed))
    : null;
  const repeatedCeiling = agreement.length
    ? Math.max(...agreement.map((entry) => entry.repeated))
    : null;
  return {
    offset,
    correlation: aligned.correlation,
    gain: aligned.gain,
    agreement,
    agreementFloor,
    repeatedCeiling,
    longestDropoutMs: (longest * 1000) / rate,
  };
}

async function decodeScreencastFrames(
  cast: { frames: Array<Record<string, unknown>>; overflow: boolean },
  rect: { x: number; y: number; width: number; height: number; scale: number }
): Promise<Array<{ timestamp: number; pixels: Uint8Array }>> {
  assert.equal(
    rect.scale,
    1,
    'screencast calibration requires unit device scale'
  );
  const frames = cast.frames.map((frame) => {
    const metadata = frame['metadata'] as { timestamp?: number } | undefined;
    assert.ok(
      typeof frame['data'] === 'string' && Number.isFinite(metadata?.timestamp),
      'screencast frame missing image or timestamp'
    );
    return {
      data: Buffer.from(frame['data'] as string, 'base64'),
      timestamp: metadata!.timestamp! * 1000,
    };
  });
  assert.ok(
    frames.length >= 2 && !cast.overflow,
    'screencast capture unavailable or overflowed'
  );
  const x = Math.round(rect.x),
    y = Math.round(rect.y);
  const width = Math.floor(rect.width),
    height = Math.floor(rect.height);
  assert.ok(
    x >= 0 && y >= 0 && width > 0 && height > 0,
    'canvas outside screencast viewport'
  );
  const output = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      // Convert to RGBA before cropping: on yuvj420p input ffmpeg rounds an odd crop origin or
      // width to even, which moves the crop one column off the canvas.
      `format=rgba,crop=${width}:${height}:${x}:${y},scale=64:36:flags=neighbor`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    {
      input: Buffer.concat(frames.map((frame) => frame.data)),
      timeoutMs: 30000,
    }
  );
  assert.equal(
    output.exit,
    0,
    `screencast JPEG decode failed: ${output.stderr}`
  );
  const frameBytes = 64 * 36 * 4;
  assert.equal(
    output.stdout.length,
    frames.length * frameBytes,
    'screencast decoder dropped frames'
  );
  return frames.map((frame, i) => ({
    timestamp: frame.timestamp,
    pixels: output.stdout.subarray(i * frameBytes, (i + 1) * frameBytes),
  }));
}

// Odd-x decode controls on real encoded JPEGs, run through the production decoder. The canvas
// sits at x = 220.609, which rounds to 221: an odd origin. ffmpeg snaps an odd crop origin on
// 4:2:0 input to an even one, so the default crop reads one column off the canvas. The stages
// are composed in RGBA and placed with pad, because overlay snaps odd offsets the same way.
const SCREENCAST_STAGE = { width: 780, height: 437 };
const SCREENCAST_CONTROL_RECT = {
  x: 220.609375,
  y: 54.0625,
  width: 101,
  height: 56.8125,
  scale: 1,
};

// Splits an MJPEG stream at its start-of-image markers. Entropy-coded data stuffs every 0xFF
// with 0x00, so a start marker cannot occur inside a frame.
function splitJpegStream(stream: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let i = 0; i + 1 < stream.length; i++)
    if (stream[i] === 0xff && stream[i + 1] === 0xd8) starts.push(i);
  return starts.map((start, i) =>
    stream.subarray(start, starts[i + 1] ?? stream.length)
  );
}

// One JPEG per source frame: the frame is drawn as its 64x36 bitmap, shown at the canvas size
// with nearest-neighbour sampling, and placed at the canvas origin on a black stage.
async function encodeScreencastStages(
  source: string,
  frames: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<Buffer[]> {
  const place = `pad=${SCREENCAST_STAGE.width}:${SCREENCAST_STAGE.height}:${Math.round(rect.x)}:${Math.round(rect.y)}:color=black`;
  const output = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      source,
      '-filter_complex',
      `[0:v]scale=64:36:flags=neighbor,scale=${rect.width}:${Math.floor(rect.height)}:flags=neighbor,format=rgba,${place},format=yuvj420p[out]`,
      '-map',
      '[out]',
      '-frames:v',
      String(frames),
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    output.exit,
    0,
    `screencast stage encode failed: ${output.stderr}`
  );
  return splitJpegStream(output.stdout);
}

// A single-colour JPEG at the canvas size and origin, on the same black stage.
async function encodeSolidStage(
  color: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
  const place = `pad=${SCREENCAST_STAGE.width}:${SCREENCAST_STAGE.height}:${Math.round(rect.x)}:${Math.round(rect.y)}:color=black`;
  const output = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${rect.width}x${Math.floor(rect.height)}:d=0.04`,
      '-vf',
      `format=rgba,${place},format=yuvj420p`,
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    output.exit,
    0,
    `unrelated stage encode failed: ${output.stderr}`
  );
  return output.stdout;
}

// Decode-path controls. Every one of the 36 odd-x stages must classify as its own source frame
// through decodeScreencastFrames; the default crop must fail on the same JPEGs; and black, white
// and grey stages must classify as no source frame at all.
async function assertScreencastDecodeControls(
  references: readonly Uint8Array[]
): Promise<void> {
  const rect = SCREENCAST_CONTROL_RECT;
  const stages = await encodeScreencastStages(
    join(decoderMediaDir, 'fr30.webm'),
    references.length,
    rect
  );
  assert.equal(
    stages.length,
    references.length,
    'odd-x control stage count mismatch'
  );
  const decoded = await decodeScreencastFrames(
    {
      frames: stages.map((jpeg, i) => ({
        data: jpeg.toString('base64'),
        metadata: { timestamp: i / 30 },
      })),
      overflow: false,
    },
    rect
  );
  for (let n = 0; n < references.length; n++) {
    const cls = classifyVideoFrame(decoded[n]!.pixels, references);
    assert.equal(
      cls,
      n,
      `odd-x decode classified stage ${n} as ${String(cls)}`
    );
  }

  const frameBytes = 64 * 36 * 4;
  const defaultCrop = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      `crop=${rect.width}:${Math.floor(rect.height)}:${Math.round(rect.x)}:${Math.round(rect.y)},scale=64:36:flags=neighbor`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { input: Buffer.concat(stages), timeoutMs: 30000 }
  );
  assert.equal(
    defaultCrop.exit,
    0,
    `default crop control decode failed: ${defaultCrop.stderr}`
  );
  let defaultCorrect = 0;
  for (let n = 0; n < references.length; n++) {
    const pixels = defaultCrop.stdout.subarray(
      n * frameBytes,
      (n + 1) * frameBytes
    );
    if (classifyVideoFrame(pixels, references) === n) defaultCorrect++;
  }
  assert.ok(
    defaultCorrect < references.length,
    `the default crop classified all ${references.length} odd-x stages correctly; the control does not discriminate`
  );

  for (const color of ['black', 'white', '0x808080']) {
    const solid = await encodeSolidStage(color, rect);
    const [frame] = await decodeScreencastFrames(
      {
        frames: [0, 1].map((i) => ({
          data: solid.toString('base64'),
          metadata: { timestamp: i / 30 },
        })),
        overflow: false,
      },
      rect
    );
    assert.equal(
      classifyVideoFrame(frame!.pixels, references),
      null,
      `unrelated ${color} stage was classified as a source frame`
    );
  }
}

async function proofProvenance(
  browser: ChromeSession
): Promise<Record<string, unknown>> {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const revision = await runChild(['git', 'rev-parse', 'HEAD'], {
    cwd: repository,
    timeoutMs: 10000,
  });
  assert.equal(revision.exit, 0, 'cannot identify proof source revision');
  const tracked = await runChild(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: repository,
      timeoutMs: 10000,
    }
  );
  assert.equal(tracked.exit, 0, 'cannot enumerate tracked proof source');
  const sourceHash = createHash('sha256');
  for (const path of tracked.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()) {
    sourceHash.update(path).update('\0');
    try {
      sourceHash.update(await readFile(join(repository, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      sourceHash.update('<deleted>');
    }
    sourceHash.update('\0');
  }
  const assets: Record<string, string> = {};
  for (const name of (await readdir(viewerDist)).sort()) {
    try {
      assets[name] = createHash('sha256')
        .update(await readFile(join(viewerDist, name)))
        .digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    }
  }
  const media: Record<string, string> = {};
  for (const [name, path] of [
    ['fr30.webm', join(decoderMediaDir, 'fr30.webm')],
    ...[
      'secondary_b.mp4',
      'plate_1001.png',
      'plate_1002.png',
      'mx_bed.wav',
    ].map((file) => [file, join(fixtureDir, 'media', file)] as const),
    ['timing-oracle.json', join(decoderMediaDir, 'timing-oracle.json')],
    [
      'boundary.otio',
      fileURLToPath(
        new URL(
          '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
          import.meta.url
        )
      ),
    ],
  ] as const)
    media[name] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const viewport = await browser.evaluate<Record<string, unknown>>(
    '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})'
  );
  return {
    revision: revision.stdout.toString('utf8').trim(),
    workingTreeSha256: sourceHash.digest('hex'),
    builtAssets: assets,
    media,
    browser: browser.browserVersion,
    browserExecutable: browser.executablePath,
    launchFlags: browser.launchFlags,
    viewport,
    capture: {
      canvasGrid: [64, 36],
      screencast: { format: 'jpeg', quality: 90, everyNthFrame: 1 },
      audio:
        'post-master-gain stereo with independent frozen-origin carrier; raw currentFrame labels retained',
      maxSamples: 3000,
    },
  };
}

async function calibrateCaptureOverhead(
  browser: ChromeSession,
  provenance: Record<string, unknown>
): Promise<void> {
  const geometry = await browser.evaluate<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    timeOrigin: number;
  }>(`(() => {
    const canvas = document.querySelector('canvas.otio-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas missing');
    const r = canvas.getBoundingClientRect();
    const width = Math.min(r.width, r.height * canvas.width / canvas.height);
    const height = Math.min(r.height, r.width * canvas.height / canvas.width);
    return {x:r.left + (r.width - width)/2, y:r.top + (r.height - height)/2,
      width, height, scale:devicePixelRatio, timeOrigin:performance.timeOrigin};
  })()`);
  const records: Array<Record<string, unknown>> = [];
  for (const [mode, fault] of [
    ['light', 'none'],
    ['full', 'none'],
    ['light', 'freeze'],
    ['full', 'freeze'],
    ['light', 'stall'],
    ['full', 'stall'],
  ] as const) {
    await seekTo(browser, 0);
    const stopCast = await browser.startScreencast();
    const result = await browser.evaluate<{
      start: { timestamp: number; frame: number };
      trace: {
        timestamp: number;
        frame: number;
        visual?: Array<{ sampleDuration?: number }>;
        samples?: unknown[];
      };
      clock: { samples: number[]; overflow: boolean; timestamp: number };
    }>(`(async () => {
      const delay = ms => {const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise;};
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!root || !(button instanceof HTMLButtonElement)) throw new Error('proof playback control missing');
      globalThis.__otioProofTrace.setFault(${JSON.stringify(fault)});
      globalThis.__otioProofTrace.startClockCalibration();
      const start = ${mode === 'full' ? 'await globalThis.__otioProofTrace.start()' : 'globalThis.__otioProofTrace.startLightweight()'};
      button.click();
      await delay(250);
      const first = {timestamp:performance.now(), frame:Number(root.dataset.frame),
        buffering:root.dataset.buffering, playing:root.dataset.playing};
      await delay(750);
      const trace = ${mode === 'full' ? 'await globalThis.__otioProofTrace.stop()' : 'globalThis.__otioProofTrace.stopLightweight()'};
      const clock = globalThis.__otioProofTrace.stopClockCalibration();
      globalThis.__otioProofTrace.setFault('none');
      if (root.dataset.playing === 'true') button.click();
      return {start, trace, clock, first};
    })()`);
    const cast = await stopCast();
    const decoded = await decodeScreencastFrames(cast, geometry);
    const samples = decoded.filter((frame) => {
      const timestamp = frame.timestamp - geometry.timeOrigin;
      return (
        timestamp >= result.start.timestamp &&
        timestamp <= result.trace.timestamp
      );
    });
    const states: Array<{ timestamp: number; pixels: Uint8Array }> = [];
    for (const sample of samples) {
      const previous = states[states.length - 1];
      if (!previous || rmse(sample.pixels, previous.pixels) > 2)
        states.push({ timestamp: sample.timestamp, pixels: sample.pixels });
    }
    const startMs = result.start.timestamp + geometry.timeOrigin;
    const endMs = result.trace.timestamp + geometry.timeOrigin;
    const gaps = [
      states.length ? states[0]!.timestamp - startMs : endMs - startMs,
    ];
    for (let i = 1; i < states.length; i++)
      gaps.push(states[i]!.timestamp - states[i - 1]!.timestamp);
    if (states.length) gaps.push(endMs - states[states.length - 1]!.timestamp);
    gaps.sort((a, b) => a - b);
    const frameGaps = result.clock.samples
      .slice(1)
      .map((time, i) => time - result.clock.samples[i]!);
    const first250FrameGaps = result.clock.samples
      .slice(1)
      .filter((time) => time <= result.start.timestamp + 250)
      .map((time, i) => time - result.clock.samples[i]!);
    const sampleCosts =
      result.trace.visual?.flatMap((sample) =>
        typeof sample.sampleDuration === 'number' ? [sample.sampleDuration] : []
      ) ?? [];
    const receipt = {
      provenance,
      mode,
      fault,
      geometry,
      result,
      cast,
      stateTimes: states.map((state) => state.timestamp),
      frameGaps,
      sampleCosts,
      p95: gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))],
      max: gaps[gaps.length - 1],
      first250FrameGaps,
    };
    await writeFile(
      join(shotDir, `capture-overhead-${mode}-${fault}.json`),
      JSON.stringify(receipt)
    );
    assert.ok(
      !result.clock.overflow && !cast.overflow,
      'capture-overhead sample overflow'
    );
    records.push(receipt);
  }
  for (const mode of ['light', 'full']) {
    const healthy = records.find(
      (r) => r['mode'] === mode && r['fault'] === 'none'
    )!;
    for (const fault of ['freeze', 'stall']) {
      const bad = records.find(
        (r) => r['mode'] === mode && r['fault'] === fault
      )!;
      assert.ok(
        Number(bad['max']) > Number(healthy['max']),
        `${mode} screencast did not distinguish ${fault} from healthy`
      );
    }
  }
}

interface ColdPresentationMetrics {
  changes: Array<{ timestamp: number; sourceFrame: number }>;
  duration: number;
  initialMs: number;
  p95: number;
  max: number;
}

function coldPresentationMetrics(
  samples: Array<{ timestamp: number; sourceFrame: number }>,
  playTimestamp: number,
  warmTimestamp: number
): ColdPresentationMetrics {
  const changes: Array<{ timestamp: number; sourceFrame: number }> = [];
  for (const sample of samples)
    if (
      !changes.length ||
      changes[changes.length - 1]!.sourceFrame !== sample.sourceFrame
    )
      changes.push(sample);
  const initialMs =
    changes.length > 1 ? changes[1]!.timestamp - playTimestamp : Infinity;
  const intervals: number[] = [];
  for (let i = 2; i < changes.length; i++)
    intervals.push(changes[i]!.timestamp - changes[i - 1]!.timestamp);
  if (changes.length > 1)
    intervals.push(warmTimestamp - changes[changes.length - 1]!.timestamp);
  intervals.sort((a, b) => a - b);
  return {
    changes,
    duration: warmTimestamp - playTimestamp,
    initialMs,
    p95:
      intervals[
        Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))
      ] ?? Infinity,
    max: intervals[intervals.length - 1] ?? Infinity,
  };
}

function passesColdPresentation(metrics: ColdPresentationMetrics): boolean {
  return (
    metrics.changes.length >= 2 &&
    metrics.initialMs <= 350 &&
    metrics.p95 <= 50 &&
    metrics.max <= 100
  );
}

function assertColdPresentationGateControls(): void {
  const samples = (times: number[]) =>
    times.map((timestamp, sourceFrame) => ({ timestamp, sourceFrame }));
  assert.ok(
    passesColdPresentation(
      coldPresentationMetrics(samples([0, 350, 383]), 0, 416)
    )
  );
  assert.ok(
    !passesColdPresentation(
      coldPresentationMetrics(samples([0, 351, 384]), 0, 417)
    )
  );
  assert.ok(
    !passesColdPresentation(
      coldPresentationMetrics(samples([0, 300, 351]), 0, 384)
    )
  );
  assert.ok(
    !passesColdPresentation(coldPresentationMetrics(samples([0]), 0, 400))
  );
}

async function assessMovingWindowControls(
  browser: ChromeSession,
  healthyRms: number,
  mutedRms: number,
  provenance: Record<string, unknown>,
  focused = false
): Promise<void> {
  assertColdPresentationGateControls();
  const decoded = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(decoderMediaDir, 'fr30.webm'),
      '-vf',
      'scale=64:36:flags=neighbor',
      '-frames:v',
      '36',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(decoded.exit, 0, `reference decoding failed: ${decoded.stderr}`);
  const frameBytes = 64 * 36 * 4;
  assert.equal(
    decoded.stdout.length,
    36 * frameBytes,
    'independent reference frame count mismatch'
  );
  const windows = await packetWindows('fr30.webm', false);
  const fixture = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
          import.meta.url
        )
      ),
      'utf8'
    )
  ) as {
    tracks: {
      children: Array<{
        children: Array<{
          metadata?: { relic?: { id?: string } };
          source_range?: { start_time: { value: number; rate: number } };
          media_references?: Record<
            string,
            {
              available_range?: { start_time: { value: number; rate: number } };
            }
          >;
          active_media_reference_key?: string;
        }>;
      }>;
    };
  };
  const itemId = focused ? 'moving-a' : 'upper-video-a';
  const item = fixture.tracks.children
    .flatMap((track) => track.children)
    .find((candidate) => candidate.metadata?.relic?.id === itemId);
  const source = item?.source_range?.start_time;
  const available =
    item?.media_references?.[item.active_media_reference_key ?? '']
      ?.available_range?.start_time;
  assert.ok(
    source && available && source.rate > 0 && available.rate > 0,
    `fixture mapping unavailable for ${itemId}`
  );
  const sourceOffsetSeconds =
    source.value / source.rate - available.value / available.rate;
  assert.equal(
    sourceOffsetSeconds,
    focused ? 0 : 6 / 30,
    'fixture mapping changed; update the reference span'
  );
  const sourceOffset = Math.round(sourceOffsetSeconds * 30);
  const references = Array.from({ length: 30 }, (_, i) =>
    decoded.stdout.subarray(
      (i + sourceOffset) * frameBytes,
      (i + sourceOffset + 1) * frameBytes
    )
  );
  const wrongSourcePixels = await extractFrame(
    join(fixtureDir, 'media', 'secondary_b.mp4'),
    5,
    64,
    36
  );
  const classifyPixels = (pixels: Uint8Array, composition: number) => {
    const matches = references
      .map((reference, i) => ({
        frame: i + sourceOffset,
        error: rmse(pixels, reference),
      }))
      .sort((a, b) => a.error - b.error);
    const best = matches[0]!,
      next = matches[1]!;
    return {
      best,
      ambiguous: best.error >= 12 || best.error >= next.error,
      wrongSource:
        !Number.isFinite(composition) ||
        best.frame !==
          windowForSeconds(
            windows,
            composition / 30 + sourceOffsetSeconds,
            'moving-window'
          ).frame,
    };
  };
  const receipts: Array<Record<string, unknown>> = [];
  const coldReferenceAudio = new Map<number, Float32Array>();
  for (const [name, fault] of [
    ['healthy-1', 'none'],
    ['healthy-2', 'none'],
    ['healthy-3', 'none'],
    ['frozen', 'freeze'],
    ['stalled', 'stall'],
  ] as const) {
    await seekTo(browser, 0);
    const geometry = await browser.evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
      timeOrigin: number;
    }>(`(() => {
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas missing');
      const r = canvas.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)
        throw new Error('canvas is clipped in screencast viewport');
      const width = Math.min(r.width, r.height * canvas.width / canvas.height);
      const height = Math.min(r.height, r.width * canvas.height / canvas.width);
      return {x:r.left + (r.width - width) / 2, y:r.top + (r.height - height) / 2, width, height,
        scale:devicePixelRatio, timeOrigin:performance.timeOrigin};
    })()`);
    const stopCast = await browser.startScreencast();
    const capture = await browser.evaluate<MovingTrace>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!root || !(button instanceof HTMLButtonElement)) throw new Error('missing playback controls');
      if (root.dataset.playing === 'true') throw new Error('cold capture began while playback was running');
      globalThis.__otioProofTrace.setFault('none');
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      button.click();
      const until = performance.now() + 12000;
      while (root.dataset.playing !== 'true' && performance.now() < until) await sleep(10);
      if (root.dataset.playing !== 'true') throw new Error('playback did not start');
      const warm = await globalThis.__otioProofTrace.waitForPresentedChanges(3, 5000);
      globalThis.__otioProofTrace.setFault(${JSON.stringify(fault)});
      await sleep(500);
      const trace = await globalThis.__otioProofTrace.stop();
      globalThis.__otioProofTrace.setFault('none');
      return {start, playEdge, warm, trace};
    })()`);
    const cast = await stopCast();
    const paused = await pausePlayback(browser);
    if (fault === 'none')
      assert.doesNotMatch(
        paused,
        /Scheduled audio stopped:/,
        `pause after the ${name} capture failed`
      );
    assert.ok(capture.warm, 'warm presentation readiness not recorded');
    assert.ok(capture.playEdge, 'play request edge not recorded');
    const samples = capture.trace.visual.filter(
      (sample) => sample.timestamp >= capture.warm!.timestamp
    );
    const issues: string[] = [];
    if (
      capture.trace.visualOverflow ||
      capture.trace.audioOverflow ||
      capture.trace.eventsOverflow ||
      cast.overflow
    )
      issues.push('trace overflow');
    if (
      samples.length === 0 ||
      samples.some(
        (sample) => sample.error || sample.pixels16?.length !== frameBytes
      )
    )
      issues.push('missing canvas pixels');
    const identified: Array<{ timestamp: number; sourceFrame: number }> = [];
    let staleControl: {
      expectedFrame: number;
      injectedFrame: number;
      detected: boolean;
    } | null = null;
    let wrongSourceControl: { distance: number; detected: boolean } | null =
      null;
    for (const sample of samples) {
      if (!sample.pixels16 || sample.pixels16.length !== frameBytes) continue;
      const pixels = Uint8Array.from(sample.pixels16);
      const composition = Number(sample.frame);
      const result = classifyPixels(pixels, composition);
      const best = result.best;
      if (result.ambiguous)
        issues.push('unresolved or ambiguous source pixels');
      if (result.wrongSource)
        issues.push('source pixels disagree with composition frame');
      const expectedFrame = windowForSeconds(
        windows,
        composition / 30 + sourceOffsetSeconds,
        'moving-window control'
      ).frame;
      const staleIndex = expectedFrame - sourceOffset - 1;
      if (
        !staleControl &&
        !result.ambiguous &&
        !result.wrongSource &&
        staleIndex >= 0
      ) {
        const planted = classifyPixels(references[staleIndex]!, composition);
        staleControl = {
          expectedFrame,
          injectedFrame: staleIndex + sourceOffset,
          detected: !planted.ambiguous && planted.wrongSource,
        };
      }
      if (!wrongSourceControl && !result.ambiguous && !result.wrongSource) {
        const distance = rmse(
          wrongSourcePixels,
          references[expectedFrame - sourceOffset]!
        );
        const planted = classifyPixels(wrongSourcePixels, composition);
        wrongSourceControl = {
          distance,
          detected:
            distance >= 12 && (planted.ambiguous || planted.wrongSource),
        };
      }
      const previous = identified[identified.length - 1];
      if (previous && best.frame < previous.sourceFrame)
        issues.push('source pixels moved backward');
      if (!previous || previous.sourceFrame !== best.frame)
        identified.push({
          timestamp: sample.timestamp,
          sourceFrame: best.frame,
        });
    }
    const elapsedMs = capture.trace.timestamp - capture.warm.timestamp;
    // The first observed state is left-censored. Charge the entire known
    // capture edge through its first change, not two artificially short gaps.
    const gaps = [
      identified.length > 1
        ? identified[1]!.timestamp - capture.warm.timestamp
        : elapsedMs,
    ];
    for (let i = 2; i < identified.length; i++)
      gaps.push(identified[i]!.timestamp - identified[i - 1]!.timestamp);
    if (identified.length > 1)
      gaps.push(
        capture.trace.timestamp - identified[identified.length - 1]!.timestamp
      );
    gaps.sort((a, b) => a - b);
    const coverage =
      new Set(identified.map((entry) => entry.sourceFrame)).size /
      ((elapsedMs * 30) / 1000);
    const progress =
      (capture.trace.frame - capture.warm.frame) / ((elapsedMs * 30) / 1000);
    const p95 =
      gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] ??
      Infinity;
    const max = gaps[gaps.length - 1] ?? Infinity;
    if (
      !(
        coverage >= 0.95 &&
        progress >= 0.95 &&
        progress <= 1.05 &&
        p95 <= 50 &&
        max <= 100
      )
    )
      issues.push('moving-window thresholds');
    const screen = await decodeScreencastFrames(cast, geometry);
    const coldCanvas = capture.trace.visual
      .filter(
        (sample) =>
          sample.timestamp >= capture.playEdge!.timestamp &&
          sample.timestamp < capture.warm!.timestamp
      )
      .map((sample) => {
        if (
          !sample.pixels16 ||
          sample.pixels16.length !== frameBytes ||
          sample.error
        )
          throw new Error('cold canvas sample lacks pixel provenance');
        const classified = classifyPixels(
          Uint8Array.from(sample.pixels16),
          Number(sample.frame)
        );
        if (classified.ambiguous || classified.wrongSource)
          issues.push('cold canvas source provenance');
        return {
          timestamp: sample.timestamp,
          sourceFrame: classified.best.frame,
        };
      });
    const coldScreen = screen
      .filter((sample) => {
        const time = sample.timestamp - geometry.timeOrigin;
        return (
          time >= capture.playEdge!.timestamp && time < capture.warm!.timestamp
        );
      })
      .map((sample) => {
        const matches = references
          .map((reference, i) => ({
            frame: i + sourceOffset,
            error: rmse(sample.pixels, reference),
          }))
          .sort((a, b) => a.error - b.error);
        const best = matches[0]!,
          next = matches[1]!;
        if (best.error >= 12 || best.error >= next.error)
          issues.push('cold screencast source provenance');
        return {
          timestamp: sample.timestamp - geometry.timeOrigin,
          sourceFrame: best.frame,
        };
      });
    // Charge the left-censored initial state through the first observed
    // change, then assess subsequent intervals against the steady gate.
    const coldCanvasMetrics = coldPresentationMetrics(
      coldCanvas,
      capture.playEdge.timestamp,
      capture.warm.timestamp
    );
    const coldScreenMetrics = coldPresentationMetrics(
      coldScreen,
      capture.playEdge.timestamp,
      capture.warm.timestamp
    );
    if (
      !passesColdPresentation(coldCanvasMetrics) ||
      !passesColdPresentation(coldScreenMetrics)
    )
      issues.push('cold presentation thresholds');
    const screenStates: Array<{
      timestamp: number;
      sourceFrame: number;
      error: number;
    }> = [];
    for (const sample of screen) {
      const timestamp = sample.timestamp - geometry.timeOrigin;
      if (
        timestamp < capture.warm.timestamp ||
        timestamp > capture.trace.timestamp
      )
        continue;
      const matches = references
        .map((reference, i) => ({
          frame: i + sourceOffset,
          error: rmse(sample.pixels, reference),
        }))
        .sort((a, b) => a.error - b.error);
      const best = matches[0]!,
        next = matches[1]!;
      if (best.error >= 12 || best.error >= next.error)
        issues.push('screencast pixels lack unambiguous source provenance');
      const closest = identified.reduce<(typeof identified)[number] | null>(
        (prior, entry) =>
          !prior ||
          Math.abs(entry.timestamp - timestamp) <
            Math.abs(prior.timestamp - timestamp)
            ? entry
            : prior,
        null
      );
      if (
        !closest ||
        Math.abs(closest.timestamp - timestamp) > 50 ||
        Math.abs(closest.sourceFrame - best.frame) > 1
      )
        issues.push('screencast and canvas traces disagree');
      const previous = screenStates[screenStates.length - 1];
      if (!previous || previous.sourceFrame !== best.frame)
        screenStates.push({
          timestamp,
          sourceFrame: best.frame,
          error: best.error,
        });
    }
    const screenGaps = [
      screenStates.length > 1
        ? screenStates[1]!.timestamp - capture.warm.timestamp
        : elapsedMs,
    ];
    for (let i = 2; i < screenStates.length; i++)
      screenGaps.push(
        screenStates[i]!.timestamp - screenStates[i - 1]!.timestamp
      );
    if (screenStates.length > 1)
      screenGaps.push(
        capture.trace.timestamp -
          screenStates[screenStates.length - 1]!.timestamp
      );
    screenGaps.sort((a, b) => a - b);
    const screenCoverage =
      new Set(screenStates.map((entry) => entry.sourceFrame)).size /
      ((elapsedMs * 30) / 1000);
    const screenP95 =
      screenGaps[
        Math.min(screenGaps.length - 1, Math.floor(screenGaps.length * 0.95))
      ] ?? Infinity;
    const screenMax = screenGaps[screenGaps.length - 1] ?? Infinity;
    if (!(screenCoverage >= 0.95 && screenP95 <= 50 && screenMax <= 100))
      issues.push('screencast moving-window thresholds');
    const audio = capture.trace.audio;
    if (!focused && !audio.length) issues.push('missing controller audio');
    for (let i = 1; i < audio.length; i++) {
      const previous = audio[i - 1]!;
      const current = audio[i]!;
      const previousLast = previous.quantumOrdinals?.at(-1);
      const currentFirst = current.quantumOrdinals?.[0];
      // The renderer reports a cached currentFrame, so a chunk label can repeat one quantum and
      // skip the next while every callback is present. When callback ordinals exist they decide
      // whether a callback is missing. Without them the labels are all there is.
      const contiguous =
        previousLast !== undefined && currentFirst !== undefined
          ? currentFirst === previousLast + 1
          : previous.channels[0] !== undefined &&
            current.sampleFrame ===
              previous.sampleFrame + previous.channels[0].length;
      if (!contiguous) issues.push('missing controller audio chunk');
    }
    const channel = audio.flatMap((chunk) => chunk.channels[0] ?? []);
    const pcmEpoch = capture.trace.events.find(
      (entry) =>
        entry.kind === 'scheduled-pcm' &&
        entry.value &&
        typeof entry.value === 'object' &&
        'event' in entry.value &&
        entry.value.event === 'epoch'
    )?.value as
      | {
          f0?: number;
          c0?: number;
          bridge?: {
            contextTime: number;
            performanceTime: number;
            mappingAllowanceMs: number;
          };
          bridgeMappingAllowanceMs?: number;
        }
      | undefined;
    const sourceActiveFrame = Number.isSafeInteger(pcmEpoch?.f0)
      ? pcmEpoch!.f0
      : undefined;
    const activeChannel =
      sourceActiveFrame === undefined
        ? channel
        : channel.slice(
            Math.max(0, sourceActiveFrame - capture.start.sampleFrame)
          );
    const windowSize = Math.ceil(capture.trace.sampleRate * 0.02);
    const silenceThreshold = Math.max(mutedRms * 2, healthyRms * 0.01);
    let longestSilentSamples = 0,
      silentSamples = 0,
      energy = 0;
    for (let i = 0; i < Math.min(windowSize, activeChannel.length); i++)
      energy += activeChannel[i]! ** 2;
    for (
      let offset = 0;
      offset + windowSize <= activeChannel.length;
      offset++
    ) {
      if (offset > 0)
        energy +=
          activeChannel[offset + windowSize - 1]! ** 2 -
          activeChannel[offset - 1]! ** 2;
      if (Math.sqrt(Math.max(0, energy) / windowSize) <= silenceThreshold) {
        silentSamples = silentSamples === 0 ? windowSize : silentSamples + 1;
        longestSilentSamples = Math.max(longestSilentSamples, silentSamples);
      } else silentSamples = 0;
    }
    if (!focused && longestSilentSamples > capture.trace.sampleRate * 0.02)
      issues.push('post-gain silence exceeds 20ms');
    let coldAudio: { offset: number; longestDropoutMs: number } | null = null;
    let clockEvidence: Record<string, unknown> | null = null;
    if (!focused) {
      coldAudio = await comparePostGainPcm(
        capture,
        coldReferenceAudio,
        healthyRms,
        mutedRms,
        false,
        sourceActiveFrame
      );
      const solver = capture.trace.events.find(
        (entry) =>
          entry.kind === 'cold-controller' &&
          (entry.value as { event?: string } | null)?.event === 'solver'
      )?.value as
        | {
            chosenAnchor?: number;
            intervalLower?: number;
            intervalUpper?: number;
          }
        | undefined;
      const bridges = [
        capture.start.bridge,
        capture.playEdge.bridge,
        capture.trace.bridge,
      ];
      const offsets = bridges.map((bridge) =>
        bridge.output
          ? bridge.output.performanceTime - bridge.output.contextTime * 1000
          : NaN
      );
      const anchor =
        sourceActiveFrame !== undefined &&
        pcmEpoch?.bridge &&
        Number.isFinite(pcmEpoch.c0)
          ? pcmEpoch.bridge.performanceTime +
            (pcmEpoch.c0! - pcmEpoch.bridge.contextTime) * 1000
          : solver?.chosenAnchor;
      if (
        !Number.isFinite(anchor) ||
        offsets.some((value) => !Number.isFinite(value))
      ) {
        issues.push('cold audio clock bridge or solver anchor unavailable');
      } else {
        const bridgeOffset = offsets[1]!;
        const measuredSpreadMs = Math.max(...offsets) - Math.min(...offsets);
        const maxReadMs = Math.max(
          ...bridges.map((bridge) => bridge.after - bridge.before)
        );
        const observedMappingAllowanceMs =
          measuredSpreadMs +
          maxReadMs +
          (128 * 1000) / capture.trace.sampleRate;
        const expectedOffset =
          capture.start.sampleFrame -
          ((anchor! - bridgeOffset) / 1000) * capture.trace.sampleRate;
        const offsetErrorMs =
          ((coldAudio.offset - expectedOffset) * 1000) /
          capture.trace.sampleRate;
        const clockLimitMs = (2 * 1000) / 30;
        const controls: Array<{
          kind: string;
          fittedOffset: number;
          offsetErrorMs: number;
          dropoutMs: number;
          rejected: boolean;
        }> = [];
        if (fault === 'none') {
          const shift = Math.round(capture.trace.sampleRate * 0.1);
          for (const [kind, direction] of [
            ['lost-prefix', 1],
            ['delayed-audio', -1],
          ] as const) {
            let position = 0;
            const shifted = audio.map((chunk) => {
              const channels = chunk.channels.map((samples) =>
                samples.map((_, i) => {
                  const sourceIndex = position + i + direction * shift;
                  if (sourceIndex < 0 || sourceIndex >= channel.length)
                    return 0;
                  // The fixture is mono; both worklet channels carry that source.
                  return channel[sourceIndex]!;
                })
              );
              position += chunk.channels[0]?.length ?? 0;
              return { ...chunk, channels };
            });
            const planted = await comparePostGainPcm(
              { ...capture, trace: { ...capture.trace, audio: shifted } },
              coldReferenceAudio,
              healthyRms,
              mutedRms,
              false,
              sourceActiveFrame
            );
            const plantedErrorMs =
              ((planted.offset - expectedOffset) * 1000) /
              capture.trace.sampleRate;
            const rejected =
              plantedErrorMs > observedMappingAllowanceMs ||
              Math.abs(plantedErrorMs) + observedMappingAllowanceMs >
                clockLimitMs ||
              planted.longestDropoutMs > 20;
            controls.push({
              kind,
              fittedOffset: planted.offset,
              offsetErrorMs: plantedErrorMs,
              dropoutMs: planted.longestDropoutMs,
              rejected,
            });
            if (
              !rejected ||
              Math.abs(planted.offset - coldAudio.offset) <=
                (2 * capture.trace.sampleRate) / 30
            )
              issues.push(
                `cold ${kind} negative control was not distinguished`
              );
          }
        }
        // A common bias in the reported output timestamps and the anchor
        // derived from them cancels from this browser-observable comparison.
        // This synthetic control models a possible physical timing error; it
        // does not claim that the actual device has that error.
        const timestampBiasMs = 100;
        const biasedExpectedOffset =
          capture.start.sampleFrame -
          ((anchor! + timestampBiasMs - (bridgeOffset + timestampBiasMs)) /
            1000) *
            capture.trace.sampleRate;
        const biasedErrorMs =
          ((coldAudio.offset - biasedExpectedOffset) * 1000) /
          capture.trace.sampleRate;
        assert.ok(
          Math.abs(biasedErrorMs - offsetErrorMs) < 1e-7 &&
            timestampBiasMs > clockLimitMs,
          'common timestamp bias control did not expose the physical-output blind spot'
        );
        clockEvidence = {
          anchor,
          intervalLower: solver?.intervalLower,
          intervalUpper: solver?.intervalUpper,
          playRequest: capture.playEdge.timestamp,
          bridges,
          measuredSpreadMs,
          maxReadMs,
          observedMappingAllowanceMs,
          measurement:
            'browser-estimated output timing, not physical speaker/display timing',
          timestampBiasControl: {
            timestampBiasMs,
            biasedErrorMs,
            detected: false,
            hypothetical: true,
          },
          signedFittedOffset: coldAudio.offset,
          expectedOffset,
          offsetErrorMs,
          controls,
        };
        if (anchor! < capture.playEdge.timestamp)
          issues.push('cold anchor precedes play request');
        if (offsetErrorMs > observedMappingAllowanceMs)
          issues.push('cold audio source begins ahead of the canonical clock');
        if (
          observedMappingAllowanceMs >= (2 * 1000) / 30 ||
          Math.abs(offsetErrorMs) + observedMappingAllowanceMs > (2 * 1000) / 30
        )
          issues.push(
            'cold browser-estimated audio epoch exceeds two-frame bound'
          );
      }
      if (coldAudio.longestDropoutMs > 20)
        issues.push('source-aware cold PCM dropout exceeds 20ms');
    }
    const receipt = {
      name,
      fault,
      elapsedMs,
      coverage,
      progress,
      p95,
      max,
      screenStates,
      screenCoverage,
      screenP95,
      coldCanvasMetrics,
      coldScreenMetrics,
      coldAudio,
      clockEvidence,
      screenMax,
      initialCanvasCensoredMs:
        identified.length > 1
          ? identified[1]!.timestamp - capture.warm.timestamp
          : elapsedMs,
      initialScreenCensoredMs:
        screenStates.length > 1
          ? screenStates[1]!.timestamp - capture.warm.timestamp
          : elapsedMs,
      longestSilentSamples,
      silenceThreshold,
      issues,
      identified,
      staleControl,
      wrongSourceControl,
      provenance,
      capture,
      geometry,
      cast,
    };
    await writeFile(
      join(
        shotDir,
        `${focused ? 'focused' : 'composition'}-moving-window-${name}.json`
      ),
      JSON.stringify(receipt)
    );
    receipts.push(receipt);
  }
  if (!focused) {
    const stillA = await extractFrame(
      join(fixtureDir, 'media', 'plate_1001.png'),
      0,
      64,
      36
    );
    const stillB = await extractFrame(
      join(fixtureDir, 'media', 'plate_1002.png'),
      0,
      64,
      36
    );
    assert.ok(
      rmse(stillA, stillB) > 0,
      'still reference pixels cannot distinguish the fixture images'
    );
    const oraclePath = fileURLToPath(
      new URL(
        '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries-oracle.json',
        import.meta.url
      )
    );
    const timingOracle = JSON.parse(await readFile(oraclePath, 'utf8')) as {
      fixture: {
        evaluations_at_time: Array<{
          time: { value: number };
          contributions: Array<{ node_id: string; transition_weight: number }>;
        }>;
      };
    };
    for (const [frame, ids] of [
      [30, ['upper-video-a', 'upper-video-b']],
      [60, ['moving-a', 'moving-b', 'upper-video-b', 'boundary-gap-a']],
      [150, ['upper-video-c', 'upper-video-d']],
    ] as const) {
      const sample = timingOracle.fixture.evaluations_at_time.find(
        (item) => item.time.value === frame
      );
      assert.ok(sample, `official transition sample ${frame} missing`);
      for (const id of ids)
        assert.ok(
          sample.contributions.some(
            (part) => part.node_id === id && part.transition_weight === 0.5
          ),
          `official transition weight missing for ${id} at ${frame}`
        );
    }
    const readVideo = (frame: number) =>
      extractFrame(join(decoderMediaDir, 'fr30.webm'), frame, 64, 36);
    const readSecondary = (frame: number) =>
      extractFrame(join(fixtureDir, 'media', 'secondary_b.mp4'), frame, 64, 36);
    const videoFrameNumbers = [36, 37, 60, 61, 6, 7, 21, 22];
    const videoFrames = new Map<number, Uint8Array>();
    await Promise.all(
      videoFrameNumbers.map(async (frame) => {
        videoFrames.set(frame, await readVideo(frame));
      })
    );
    const [b30, b31, upper60, upper61] = await Promise.all([
      readSecondary(4),
      readSecondary(5),
      readSecondary(28),
      readSecondary(29),
    ]);
    const transitions = [30, 60, 150];
    function transitionComparison(
      frame: number,
      time: number,
      pixels: Uint8Array
    ) {
      const u = (time - (frame - 3)) / 6;
      const secondaryIndex = Math.floor(
        ((time - (frame === 60 ? 24 : frame - 6)) * 24) / 30
      );
      const incoming = secondaryIndex === 4 ? b30 : b31;
      let expected: Uint8Array;
      let hardCuts: Uint8Array[];
      if (frame === 60) {
        const lowerAIndex = windowForSeconds(
          windows,
          time / 30,
          'dissolve lower outgoing'
        ).frame;
        const lowerBIndex = windowForSeconds(
          windows,
          (time - 54) / 30,
          'dissolve lower incoming'
        ).frame;
        const lowerA = videoFrames.get(lowerAIndex);
        const lowerB = videoFrames.get(lowerBIndex);
        assert.ok(
          lowerA && lowerB,
          `missing independently decoded dissolve frames ${lowerAIndex}/${lowerBIndex}`
        );
        const upper = secondaryIndex === 28 ? upper60 : upper61;
        const lower = blend(lowerA, lowerB, 1 - u, u);
        expected = blend(lower, upper, u, 1 - u);
        hardCuts = [
          upper,
          lower,
          blend(lowerA, upper, u, 1 - u),
          blend(lowerB, upper, u, 1 - u),
        ];
      } else {
        const index = windowForSeconds(
          windows,
          (time - (frame === 30 ? -6 : 129)) / 30,
          'dissolve upper outgoing'
        ).frame;
        const outgoing = videoFrames.get(index);
        assert.ok(
          outgoing,
          `missing independently decoded dissolve frame ${index}`
        );
        expected = blend(outgoing, incoming, 1 - u, u);
        hardCuts = [outgoing, incoming];
      }
      return {
        time,
        expected: rmse(pixels, expected),
        hardCuts: hardCuts.map((alternative) => rmse(pixels, alternative)),
      };
    }
    const referenceAudio = new Map<number, Float32Array>();
    for (let repetition = 1; repetition <= 5; repetition++) {
      await seekTo(browser, 0);
      const geometry = await browser.evaluate<{
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
        timeOrigin: number;
      }>(`(() => {
        const canvas = document.querySelector('canvas.otio-canvas');
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas missing');
        const r = canvas.getBoundingClientRect();
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)
          throw new Error('canvas is clipped in screencast viewport');
        const width = Math.min(r.width, r.height * canvas.width / canvas.height);
        const height = Math.min(r.height, r.width * canvas.height / canvas.width);
        return {x:r.left + (r.width - width) / 2, y:r.top + (r.height - height) / 2, width, height,
          scale:devicePixelRatio, timeOrigin:performance.timeOrigin};
      })()`);
      const stopCast = await browser.startScreencast();
      const capture = await browser.evaluate<MovingTrace>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!root || !(button instanceof HTMLButtonElement)) throw new Error('missing playback controls');
      if (root.dataset.playing !== 'true') button.click();
      const deadline = performance.now() + 12000;
      while (root.dataset.playing !== 'true' && performance.now() < deadline) await sleep(10);
      if (root.dataset.playing !== 'true') throw new Error('playback did not start');
      // Scheduled audio starts at its epoch, some tens of milliseconds after the play request
      // that sets data-playing. This capture is of playback under way, so it waits for the
      // composition to move. The startup lead has its own budget in the cold-start stages
      // and is not a dropout.
      while (!(Number(root.dataset.frame) >= 1) && performance.now() < deadline) await sleep(5);
      if (!(Number(root.dataset.frame) >= 1)) throw new Error('playback did not advance');
      await sleep(40);
      globalThis.__otioProofTrace.setFault(${JSON.stringify(repetition === 4 ? 'skip-still' : 'none')});
      const start = await globalThis.__otioProofTrace.start();
      if (${repetition === 5}) {
        await sleep(2200);
        const muted = globalThis.__otioProofTrace.mute();
        await sleep(300);
        globalThis.__otioProofTrace.restore(muted.value);
        await sleep(3100);
      } else await sleep(5600);
      const trace = await globalThis.__otioProofTrace.stop();
      globalThis.__otioProofTrace.setFault('none');
      return {start, trace};
    })()`);
      const cast = await stopCast();
      const paused = await pausePlayback(browser);
      assert.doesNotMatch(
        paused,
        /Scheduled audio stopped:/,
        `pause after sustained capture ${repetition} failed`
      );
      const elapsedMs = capture.trace.timestamp - capture.start.timestamp;
      const progress =
        (capture.trace.frame - capture.start.frame) / ((elapsedMs * 30) / 1000);
      const stills = [
        { from: 75, to: 90, reference: stillA, other: stillB },
        { from: 90, to: 105, reference: stillB, other: stillA },
        { from: 105, to: 120, reference: stillA, other: stillB },
      ].map(({ from, to, reference, other }) => {
        const matches = capture.trace.visual.filter((sample) => {
          const frame = Number(sample.frame);
          return (
            frame >= from &&
            frame < to &&
            sample.pixels16?.length === frameBytes
          );
        });
        const errors = matches.map((sample) => {
          const pixels = Uint8Array.from(sample.pixels16!);
          return {
            expected: rmse(pixels, reference),
            other: rmse(pixels, other),
          };
        });
        return { from, to, errors };
      });
      const screen = await decodeScreencastFrames(cast, geometry);
      const matchPresentedCanvas = (timestamp: number, pixels: Uint8Array) => {
        let best: (typeof capture.trace.visual)[number] | null = null;
        let error = Infinity;
        for (const sample of capture.trace.visual) {
          if (
            Math.abs(sample.timestamp - timestamp) > 50 ||
            sample.pixels16?.length !== frameBytes
          )
            continue;
          const candidate = rmse(pixels, Uint8Array.from(sample.pixels16));
          if (
            candidate < error ||
            (candidate === error &&
              (!best || sample.timestamp > best.timestamp))
          ) {
            best = sample;
            error = candidate;
          }
        }
        return error < 12 ? best : null;
      };
      const unmatchedScreenFrames = screen.filter((sample) => {
        const timestamp = sample.timestamp - geometry.timeOrigin;
        return (
          timestamp >= capture.start.timestamp + 50 &&
          timestamp <= capture.trace.timestamp &&
          !matchPresentedCanvas(timestamp, sample.pixels)
        );
      }).length;
      const screenStills = [
        { from: 75, to: 90, reference: stillA, other: stillB },
        { from: 90, to: 105, reference: stillB, other: stillA },
        { from: 105, to: 120, reference: stillA, other: stillB },
      ].map(({ from, to, reference, other }) => {
        const errors: Array<{ expected: number; other: number; skew: number }> =
          [];
        for (const frame of screen) {
          const timestamp = frame.timestamp - geometry.timeOrigin;
          const closest = matchPresentedCanvas(timestamp, frame.pixels);
          if (!closest) continue;
          const composition = Number(closest.frame);
          if (composition >= from && composition < to)
            errors.push({
              expected: rmse(frame.pixels, reference),
              other: rmse(frame.pixels, other),
              skew: Math.abs(closest.timestamp - timestamp),
            });
        }
        return { from, to, errors };
      });
      const transitionChecks = transitions.map((frame) => {
        const canvas = capture.trace.visual
          .filter(
            (sample) =>
              Number(sample.frame) >= frame &&
              Number(sample.frame) < frame + 1 &&
              sample.pixels16?.length === frameBytes
          )
          .map((sample) =>
            transitionComparison(
              frame,
              Number(sample.frame),
              Uint8Array.from(sample.pixels16!)
            )
          );
        const compositor = screen.flatMap((sample) => {
          const timestamp = sample.timestamp - geometry.timeOrigin;
          const closest = matchPresentedCanvas(timestamp, sample.pixels);
          if (
            !closest ||
            Number(closest.frame) < frame ||
            Number(closest.frame) >= frame + 1
          )
            return [];
          return [
            transitionComparison(frame, Number(closest.frame), sample.pixels),
          ];
        });
        return { frame, canvas, compositor };
      });
      const audio = await comparePostGainPcm(
        capture,
        referenceAudio,
        healthyRms,
        mutedRms
      );
      await writeFile(
        join(shotDir, `boundary-sustained-${repetition}.json`),
        JSON.stringify({
          provenance,
          capture,
          cast,
          geometry,
          elapsedMs,
          progress,
          stills,
          screenStills,
          transitionChecks,
          unmatchedScreenFrames,
          audio,
        })
      );
      assert.ok(
        audio.agreementFloor !== null &&
          audio.repeatedCeiling !== null &&
          audio.agreementFloor > audio.repeatedCeiling &&
          audio.agreementFloor > 0,
        `audio source agreement is not separated from repeated-audio control: ${audio.agreementFloor} vs ${audio.repeatedCeiling}`
      );
      if (repetition === 5)
        assert.ok(
          audio.longestDropoutMs > 20,
          'controller mute control was not detected'
        );
      else
        assert.ok(
          audio.longestDropoutMs <= 20,
          `post-gain dropout ${audio.longestDropoutMs}ms`
        );
      assert.ok(
        !capture.trace.visualOverflow &&
          !capture.trace.audioOverflow &&
          !capture.trace.eventsOverflow &&
          !cast.overflow,
        'boundary trace overflow'
      );
      assert.equal(
        unmatchedScreenFrames,
        0,
        'screencast frames lack a matching recent canvas presentation'
      );
      assert.ok(
        progress >= 0.95 && progress <= 1.05,
        `boundary wall progress ratio ${progress}`
      );
      for (const still of stills) {
        assert.ok(
          still.errors.length > 0,
          `skipped still interval [${still.from}, ${still.to})`
        );
        const matched = still.errors.every(
          (error) => error.expected < 12 && error.expected < error.other
        );
        if (repetition === 4 && still.from === 90)
          assert.equal(
            matched,
            false,
            'skipped-still control was not detected'
          );
        else
          assert.ok(
            matched,
            `wrong still pixels in [${still.from}, ${still.to})`
          );
      }
      for (const still of screenStills) {
        assert.ok(
          still.errors.length > 0,
          `missing screencast still interval [${still.from}, ${still.to})`
        );
        const matched = still.errors.every(
          (error) => error.expected < 12 && error.expected < error.other
        );
        if (repetition === 4 && still.from === 90)
          assert.equal(
            matched,
            false,
            'screencast accepted skipped-still control'
          );
        else
          assert.ok(
            matched,
            `wrong screencast still pixels in [${still.from}, ${still.to})`
          );
      }
      for (const transition of transitionChecks) {
        for (const [surface, values] of [
          ['canvas', transition.canvas],
          ['compositor', transition.compositor],
        ] as const) {
          assert.ok(
            values.length > 0,
            `${surface} missing dissolve midpoint ${transition.frame}`
          );
          assert.ok(
            values.every(
              (value) =>
                value.expected < 12 &&
                value.hardCuts.every((hardCut) => value.expected < hardCut)
            ),
            `${surface} failed dissolve or accepted hard-cut control at ${transition.frame}`
          );
        }
      }
    }
  }
  for (const receipt of receipts) {
    const issues = receipt['issues'] as string[];
    if (receipt['fault'] === 'none') {
      assert.deepEqual(
        issues,
        [],
        `healthy moving window failed: ${receipt['name']}`
      );
      const stale = receipt['staleControl'] as { detected: boolean } | null;
      assert.ok(
        stale?.detected,
        'independently decoded stale source-frame control was not rejected'
      );
      const wrong = receipt['wrongSourceControl'] as {
        detected: boolean;
      } | null;
      assert.ok(
        wrong?.detected,
        'independently decoded wrong-media control was not rejected'
      );
    } else {
      assert.ok(
        issues.includes('moving-window thresholds'),
        `moving-window gate did not detect ${receipt['name']}`
      );
      assert.ok(
        issues.includes('screencast moving-window thresholds'),
        `screencast gate did not detect ${receipt['name']}`
      );
      if (receipt['fault'] === 'freeze')
        assert.ok(
          (receipt['progress'] as number) >= 0.95,
          'freeze control did not advance the composition clock'
        );
    }
  }
}

async function assertVideoReservationInvalidation(
  browser: ChromeSession,
  provenance: Record<string, unknown>
): Promise<void> {
  await seekTo(browser, 0);
  const capture = await browser.evaluate<
    MovingTrace & { playing: string; diagnostic: string }
  >(`(async () => {
    const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
    const root = document.querySelector('.otio-view');
    const button = document.querySelector('button.otio-play');
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('reservation proof controls missing');
    const start = await globalThis.__otioProofTrace.start();
    globalThis.__otioProofPcmFault = 'invalidate-next-reserved-tag';
    const playEdge = globalThis.__otioProofTrace.playRequest();
    button.click();
    await sleep(2500);
    const trace = await globalThis.__otioProofTrace.stop();
    globalThis.__otioProofPcmFault = null;
    const playing = root.dataset.playing ?? '';
    const diagnostic = Array.from(document.querySelectorAll('.otio-diagnostic')).map(node => node.textContent ?? '').join(' ');
    return {start, playEdge, trace, playing, diagnostic};
  })()`);
  await pausePlayback(browser);
  await writeFile(
    join(shotDir, 'video-reservation-invalidated.json'),
    JSON.stringify({ provenance, capture })
  );
  const events = capture.trace.events.filter(
    (entry) => entry.kind === 'scheduled-pcm'
  );
  const faultIndex = events.findIndex((entry) => {
    const value = entry.value;
    return (
      value &&
      typeof value === 'object' &&
      'event' in value &&
      value.event === 'fault' &&
      'code' in value &&
      value.code === 'reserved-frame-invalidated'
    );
  });
  assert.ok(faultIndex >= 0, 'reserved-frame invalidation was not applied');
  const closure = events.slice(faultIndex + 1).find((entry) => {
    const value = entry.value;
    return (
      value &&
      typeof value === 'object' &&
      'event' in value &&
      value.event === 'gate-close' &&
      'contextStopFrame' in value
    );
  });
  const closureValue = closure?.value;
  assert.ok(
    closureValue &&
      typeof closureValue === 'object' &&
      'contextStopFrame' in closureValue &&
      'compositionStop' in closureValue &&
      'generation' in closureValue,
    'invalidated frame did not close the audio frontier'
  );
  const gateFrame = Number(closureValue.contextStopFrame);
  assert.ok(
    Number.isSafeInteger(gateFrame),
    'invalidated frontier gate is not a context frame'
  );
  const interruption = events.slice(faultIndex + 1).find((entry) => {
    const value = entry.value as { event?: string; stage?: string } | null;
    return value?.event === 'error' && value.stage === 'visual';
  });
  assert.ok(
    interruption,
    'loss of committed pixels did not report a visual interruption'
  );
  assert.equal(
    capture.playing,
    'false',
    'loss of committed pixels left playback active'
  );
  assert.match(
    capture.diagnostic,
    /Scheduled audio stopped:/,
    'visual interruption was not visible'
  );
  assert.ok(
    !events
      .slice(faultIndex + 1)
      .some(
        (entry) => (entry.value as { event?: string } | null)?.event === 'epoch'
      ),
    'loss of committed pixels silently resumed without reacquiring them'
  );
  assertPcmSilence(
    capture.trace,
    gateFrame,
    lastCarrierEnd(capture.trace),
    'audio continued past invalidated video frontier'
  );
  pass('scheduled-video-reservation-invalidation');
  await seekTo(browser, 0);
  const future = await browser.evaluate<
    MovingTrace & {
      sawHeld: boolean;
      handoffBeforeRelease: boolean;
    }
  >(`(async () => {
    const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
    const root = document.querySelector('.otio-view');
    const button = document.querySelector('button.otio-play');
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('future-video controls missing');
    const start = await globalThis.__otioProofTrace.start();
    globalThis.__otioProofTrace.enableRecoveryMarker();
    globalThis.__otioProofHoldOldDrain = true;
    const playEdge = globalThis.__otioProofTrace.playRequest();
    button.click();
    await sleep(500);
    globalThis.__otioProofTrace.withholdFutureVideoUntil('recovery-render-closed');
    const liftDeadline = performance.now() + 4000;
    while (!globalThis.__otioProofTrace.hasTraceEvent('pcm-fault-lift') && performance.now() < liftDeadline) await sleep(10);
    globalThis.__otioProofPcmFault = null;
    const handoffDeadline=performance.now()+500;
    while ((!globalThis.__otioProofTrace.hasPcmEvent('recovery-handoff') ||
            !globalThis.__otioProofTrace.hasPcmEvent('recovery-old-drain-held')) &&
           performance.now()<handoffDeadline) await sleep(10);
    const sawHeld=globalThis.__otioProofTrace.hasPcmEvent('recovery-old-drain-held');
    const handoffBeforeRelease=globalThis.__otioProofTrace.hasPcmEvent('recovery-handoff');
    globalThis.__otioProofHoldOldDrain = false;
    await sleep(700);
    const trace = await globalThis.__otioProofTrace.stop();
    return {start, playEdge, trace, sawHeld, handoffBeforeRelease};
  })()`);
  await pausePlayback(browser);
  await writeFile(
    join(shotDir, 'video-future-starvation.json'),
    JSON.stringify({ provenance, capture: future })
  );
  const faultLifts = future.trace.events.flatMap((entry, index) =>
    entry.kind === 'pcm-fault-lift' ? [index] : []
  );
  const firstClosureAt = future.trace.events.findIndex(
    (entry) =>
      entry.kind === 'scheduled-pcm' &&
      (entry.value as { event?: string } | null)?.event ===
        'recovery-render-closed'
  );
  assert.ok(
    faultLifts.length === 1 &&
      firstClosureAt >= 0 &&
      (
        future.trace.events[faultLifts[0]!]!.value as {
          triggerIndex?: number | null;
        } | null
      )?.triggerIndex === firstClosureAt,
    'withheld future video was not lifted at the first recovery-render-closed'
  );
  const sawBuffering = future.trace.events.some(
    (entry) =>
      entry.kind === 'buffering-change' &&
      entry.value !== null &&
      typeof entry.value === 'object' &&
      (entry.value as { current?: unknown }).current === 'true'
  );
  assert.ok(sawBuffering, 'withholding future video did not reach buffering');
  const futureEvents = future.trace.events
    .filter((entry) => entry.kind === 'scheduled-pcm')
    .map((entry) => entry.value as Record<string, unknown>);
  const firstEpoch = futureEvents.find((event) => event['event'] === 'epoch');
  const closedIndex = futureEvents.findIndex(
    (event) => event['event'] === 'gate-close' && event['reason'] === 'frontier'
  );
  assert.ok(
    firstEpoch && closedIndex >= 0,
    'future video starvation lacks an epoch or render gate expiry'
  );
  const closed = futureEvents[closedIndex]!;
  const resumed = futureEvents
    .slice(closedIndex + 1)
    .find((event) => event['event'] === 'epoch');
  assert.ok(
    resumed,
    'future video starvation did not produce a replacement epoch'
  );
  assert.notEqual(
    firstEpoch['generation'],
    resumed['generation'],
    'future video recovery reused an expired generation'
  );
  const stop = closed['compositionStop'] as { value: number; rate: number };
  const restart = resumed['compositionT0'] as { value: number; rate: number };
  const sampleRate = Number(resumed['contextSampleRate']);
  const closeFrame = Number(closed['contextStopFrame']);
  const resumeFrame = Number(resumed['f0']);
  const originalStart = firstEpoch['compositionT0'] as {
    value: number;
    rate: number;
  };
  const originalFrame = Number(firstEpoch['f0']);
  const originalRate = Number(firstEpoch['contextSampleRate']);
  assert.equal(
    originalRate,
    sampleRate,
    'recovery changed the context sample rate'
  );
  assert.equal(
    closed['generation'],
    firstEpoch['generation'],
    'frontier closure belongs to another generation'
  );
  assert.ok(originalStart?.rate > 0 && Number.isSafeInteger(originalFrame));
  const committedSeconds =
    originalStart.value / originalStart.rate +
    (closeFrame - originalFrame) / originalRate;
  assert.ok(
    stop?.rate > 0 &&
      restart?.rate > 0 &&
      Number.isFinite(sampleRate) &&
      sampleRate > 0
  );
  assert.ok(
    Number.isSafeInteger(closeFrame) &&
      Number.isSafeInteger(resumeFrame) &&
      resumeFrame >= closeFrame &&
      resumeFrame - closeFrame <= Math.floor(sampleRate * 0.02),
    'future-video recovery gap exceeds the 20ms sample bound'
  );
  const videoSelection = futureEvents.find(
    (event) =>
      event['event'] === 'recovery-selection' &&
      event['generation'] === resumed['generation'] &&
      event['boundaryFrame'] === closeFrame
  );
  assert.ok(
    videoSelection && videoSelection['f0'] === resumeFrame,
    'video recovery lacks its selected frame'
  );
  assertLatestRecoveryFrame(
    future.trace,
    videoSelection,
    closeFrame,
    sampleRate,
    false // This fixture draws video and requires phase samples.
  );
  assert.ok(
    assertSuccessorPolicy(futureEvents, true) > 0,
    'healthy video recovery produced no checked successor handoff'
  );
  const heldDrain = futureEvents.find(
    (event) =>
      event['event'] === 'recovery-old-drain-held' &&
      event['boundaryFrame'] === closeFrame
  );
  const releasedDrain = futureEvents.find(
    (event) =>
      event['event'] === 'recovery-old-drain-released' &&
      event['boundaryFrame'] === closeFrame
  );
  const videoHandoff = futureEvents.find(
    (event) =>
      event['event'] === 'recovery-handoff' &&
      event['boundaryFrame'] === closeFrame
  );
  assert.ok(
    future.sawHeld &&
      future.handoffBeforeRelease &&
      heldDrain &&
      releasedDrain &&
      videoHandoff &&
      videoHandoff['oldDrainObserved'] === false &&
      Number(videoHandoff['wallMs']) <= Number(releasedDrain['wallMs']),
    'video successor did not start before releasing held old drain'
  );
  const videoDrain = future.trace.events.find(
    (event) =>
      event.kind === 'recovery-old-drain-native-read' &&
      event.value &&
      typeof event.value === 'object' &&
      'boundaryFrame' in event.value &&
      event.value.boundaryFrame === closeFrame
  );
  assert.ok(
    videoDrain?.value &&
      typeof videoDrain.value === 'object' &&
      'state' in videoDrain.value &&
      videoDrain.value.state === 'running' &&
      'output' in videoDrain.value &&
      videoDrain.value.output &&
      typeof videoDrain.value.output === 'object' &&
      'contextTime' in videoDrain.value.output &&
      'performanceTime' in videoDrain.value.output &&
      'after' in videoDrain.value &&
      'renderAfter' in videoDrain.value &&
      Number.isFinite(Number(videoDrain.value.output.contextTime)) &&
      Number.isFinite(Number(videoDrain.value.output.performanceTime)) &&
      Number(videoDrain.value.output.contextTime) * sampleRate >= closeFrame &&
      Number(videoDrain.value.output.contextTime) <=
        Number(videoDrain.value.renderAfter) +
          DEFAULT_CLOCK_POLICY.futureToleranceMs / 1000 &&
      Number(videoDrain.value.output.performanceTime) > 0 &&
      Number(videoDrain.value.output.performanceTime) <=
        Number(videoDrain.value.after) +
          DEFAULT_CLOCK_POLICY.futureToleranceMs &&
      Number(videoDrain.value.after) -
        Number(videoDrain.value.output.performanceTime) <=
        DEFAULT_CLOCK_POLICY.freshnessMs,
    'video old drain lacked a fresh native output timestamp at D'
  );
  const videoArmClock = future.trace.events.find(
    (event) =>
      event.kind === 'audio-arm-native-output' &&
      event.value &&
      typeof event.value === 'object' &&
      'generation' in event.value &&
      event.value.generation === resumed['generation']
  );
  assert.ok(
    videoArmClock?.value &&
      typeof videoArmClock.value === 'object' &&
      'output' in videoArmClock.value &&
      videoArmClock.value.output &&
      typeof videoArmClock.value.output === 'object' &&
      'contextTime' in videoArmClock.value.output &&
      'performanceTime' in videoArmClock.value.output &&
      Number(videoArmClock.value.output.contextTime) * sampleRate <
        closeFrame &&
      Number(videoArmClock.value.output.performanceTime) > 0,
    'video successor was not armed with real output still before D'
  );
  const exactCommittedSample =
    (originalStart.value * sampleRate) / originalStart.rate +
    closeFrame -
    originalFrame;
  assert.ok(
    Number.isSafeInteger(exactCommittedSample) &&
      (restart.value * sampleRate) / restart.rate === exactCommittedSample &&
      (stop.value * sampleRate) / stop.rate === exactCommittedSample,
    'future video recovery did not preserve the independently calculated committed sample'
  );
  if (resumeFrame > closeFrame)
    assertPcmSilence(
      future.trace,
      closeFrame,
      resumeFrame,
      'audio crossed the closed future-video gate'
    );
  assert.ok(
    !futureEvents.some(
      (event) => event['event'] === 'error' && event['stage'] === 'visual'
    ),
    'withholding future frames was misreported as lost committed pixels'
  );
  assert.ok(
    !future.trace.audioOverflow &&
      !future.trace.visualOverflow &&
      !future.trace.eventsOverflow,
    'future recovery trace overflow'
  );
  assert.ok(
    !futureEvents
      .slice(closedIndex + 1)
      .some((event) => event['event'] === 'error'),
    'future recovery ended in an interruption'
  );
  const sourceAudio = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(fixtureDir, 'media', 'mx_bed.wav'),
      '-ar',
      String(sampleRate),
      '-af',
      'pan=stereo|c0=c0|c1=c0',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { timeoutMs: 30000 }
  );
  assert.equal(
    sourceAudio.exit,
    0,
    `future recovery source audio decode failed: ${sourceAudio.stderr}`
  );
  const committedSample = Math.round(committedSeconds * sampleRate);
  assert.ok(
    Math.abs(committedSample / sampleRate - committedSeconds) < 1e-9,
    'committed position is off the sample lattice'
  );
  const windowFrames = Math.round(sampleRate * 0.02);
  const compareFrames = windowFrames * 10;
  assert.ok(
    (committedSample + compareFrames) * 8 <= sourceAudio.stdout.length,
    'future recovery reference audio is too short'
  );
  assertPcmCoverage(
    resumeFrame,
    resumeFrame + compareFrames,
    future.trace.audio,
    future.trace.witness
  );
  const planes: [Float32Array, Float32Array] = [
    new Float32Array(committedSample + compareFrames),
    new Float32Array(committedSample + compareFrames),
  ];
  for (let n = committedSample; n < committedSample + compareFrames; n++)
    for (let channel = 0; channel < 2; channel++)
      planes[channel]![n] = sourceAudio.stdout.readFloatLE(n * 8 + channel * 4);
  const videoOldArm = future.trace.events.find(
    (event) =>
      event.kind === 'transport-command' &&
      event.value &&
      typeof event.value === 'object' &&
      'type' in event.value &&
      event.value.type === 'arm' &&
      'generation' in event.value &&
      event.value.generation === firstEpoch['generation']
  );
  const videoNewArm = future.trace.events.find(
    (event) =>
      event.kind === 'transport-command' &&
      event.value &&
      typeof event.value === 'object' &&
      'type' in event.value &&
      event.value.type === 'arm' &&
      'generation' in event.value &&
      event.value.generation === resumed['generation']
  );
  assert.ok(
    videoOldArm?.value &&
      videoNewArm?.value &&
      typeof videoOldArm.value === 'object' &&
      typeof videoNewArm.value === 'object' &&
      'slot' in videoOldArm.value &&
      'slot' in videoNewArm.value &&
      (videoOldArm.value.slot === 0 || videoOldArm.value.slot === 1) &&
      (videoNewArm.value.slot === 0 || videoNewArm.value.slot === 1) &&
      videoOldArm.value.slot !== videoNewArm.value.slot,
    'video recovery did not use isolated old and successor slots'
  );
  assert.ok(
    future.trace.events.some(
      (event) =>
        event.kind === 'recovery-old-marker-scheduled' &&
        event.value &&
        typeof event.value === 'object' &&
        'frame' in event.value &&
        event.value.frame === closeFrame &&
        'late' in event.value &&
        event.value.late === false
    ),
    'video recovery old-slot marker was not armed before closure'
  );
  const videoWitness = future.trace.witness;
  assert.ok(videoWitness, 'video recovery independent carrier missing');
  let videoMarkerSamples = 0;
  for (const chunk of future.trace.audio) {
    assert.ok(
      chunk.marker && chunk.marker.length === chunk.channels[0]!.length,
      'video recovery old-slot marker capture missing'
    );
    for (let i = 0; i < chunk.marker.length; i++) {
      const frame = carrierFrame(chunk, i, videoWitness);
      if (frame === null || frame < resumeFrame || frame >= resumeFrame + 128)
        continue;
      assert.ok(
        Math.abs(chunk.marker[i]! - 0.375) < 0.00001,
        'old-slot marker not present during video recovery'
      );
      for (let ch = 0; ch < 2; ch++)
        assert.ok(
          Math.abs(
            chunk.channels[ch]![i]! -
              planes[ch]![committedSample + frame - resumeFrame]!
          ) <= 0.003,
          'old-slot marker leaked into video recovery PCM'
        );
      videoMarkerSamples++;
    }
  }
  assert.equal(
    videoMarkerSamples,
    128,
    'video recovery marker overlap not captured'
  );
  for (
    let first = committedSample;
    first < committedSample + compareFrames;
    first += windowFrames
  ) {
    const comparison = compareScheduledPcm(
      future.trace.audio,
      resumeFrame - committedSample,
      planes,
      first,
      first + windowFrames,
      future.trace.witness
    );
    assert.ok(
      comparison.rmse.every((value) => value <= 0.003),
      `future video recovery PCM mismatch or 20ms dropout at ${first}`
    );
  }
  const referenceVideo = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(decoderMediaDir, 'fr30.webm'),
      '-vf',
      'scale=64:36:flags=neighbor',
      '-frames:v',
      '36',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 30000 }
  );
  assert.equal(
    referenceVideo.exit,
    0,
    `future recovery source video decode failed: ${referenceVideo.stderr}`
  );
  const frameBytes = 64 * 36 * 4;
  assert.equal(referenceVideo.stdout.length, frameBytes * 36);
  const bridge = resumed['bridge'] as {
    contextTime: number;
    performanceTime: number;
  };
  assert.ok(
    Number.isFinite(bridge?.contextTime) &&
      Number.isFinite(bridge?.performanceTime),
    'future recovery output estimate missing'
  );
  const presentationStart =
    bridge.performanceTime +
    (resumeFrame / sampleRate - bridge.contextTime) * 1000;
  const identified: Array<{ frame: number; timestamp: number }> = [];
  for (const visual of future.trace.visual) {
    const seconds =
      committedSeconds + (visual.timestamp - presentationStart) / 1000;
    if (
      seconds < committedSeconds ||
      seconds >= Math.min(0.9, committedSeconds + 0.5)
    )
      continue;
    assert.ok(
      !visual.error && visual.pixels16?.length === frameBytes,
      'future recovery pixels unavailable'
    );
    let best = -1,
      bestError = Infinity;
    for (let frame = 6; frame < 36; frame++) {
      const error = rmse(
        Uint8Array.from(visual.pixels16!),
        referenceVideo.stdout.subarray(
          frame * frameBytes,
          (frame + 1) * frameBytes
        )
      );
      if (error < bestError) {
        bestError = error;
        best = frame;
      }
    }
    assert.ok(
      bestError < 12 && Math.abs((best - 6) / 30 - seconds) <= 2 / 30,
      'future recovery pixels disagree with independent source and browser-estimated timing'
    );
    if (identified.at(-1)?.frame !== best)
      identified.push({ frame: best, timestamp: visual.timestamp });
  }
  assert.ok(
    identified.length >= 4,
    'future recovery lacks independently identified advancing pixels'
  );
  const intervals = identified
    .slice(1)
    .map((sample, index) => sample.timestamp - identified[index]!.timestamp)
    .sort((a, b) => a - b);
  assert.ok(
    intervals[Math.ceil(intervals.length * 0.95) - 1]! <= 50 &&
      intervals.at(-1)! <= 100,
    'future recovery exceeded steady presentation gates'
  );
  pass('scheduled-video-future-recovery');
}

// Publishes the authored playback-boundaries document (fr30.webm video and mx_bed.wav
// audio) for the cold-start scenario, using the same media copies as the boundary proof.
// The 44.1 kHz document carries a loopback-only PCM16 mx_bed converted from the 48 kHz source.
// Scheduled admission refuses a WAV whose rate differs from the context's and falls back to
// native compatibility, which never reads the output clock, so the 44.1 kHz cold run needs a
// WAV at the context rate to exercise the scheduled path.
function coldBoundaryDirectory(rate: 44100 | 48000): string {
  return join(
    scratch,
    rate === 48000
      ? 'cold-playback-boundaries.otiod'
      : 'cold-playback-boundaries-44100.otiod'
  );
}

async function publishColdBoundaryDocument(
  rate: 44100 | 48000 = 48000
): Promise<string> {
  const directory = coldBoundaryDirectory(rate);
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  await cp(
    fileURLToPath(
      new URL(
        '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
        import.meta.url
      )
    ),
    join(directory, 'content.otio')
  );
  await cp(join(decoderMediaDir, 'fr30.webm'), join(media, 'fr30.webm'));
  for (const name of ['plate_1001.png', 'plate_1002.png', 'secondary_b.mp4'])
    await cp(join(fixtureDir, 'media', name), join(media, name));
  if (rate === 48000) {
    await cp(
      join(fixtureDir, 'media', 'mx_bed.wav'),
      join(media, 'mx_bed.wav')
    );
  } else {
    const converted = await runChild(
      [
        'ffmpeg',
        '-v',
        'error',
        '-y',
        '-i',
        join(fixtureDir, 'media', 'mx_bed.wav'),
        '-ar',
        '44100',
        '-acodec',
        'pcm_s16le',
        join(media, 'mx_bed.wav'),
      ],
      { timeoutMs: 30000 }
    );
    assert.equal(converted.exit, 0, converted.stderr);
  }
  return publishLegacyDirectory(
    directory,
    rate === 48000
      ? 'OTIO legacy cold boundaries'
      : 'OTIO legacy cold boundaries 44100'
  );
}

// Independent references for the cold document, decoded by ffmpeg and never taken from
// the player: the 64x36 fr30 frames (same scale as the screencast crop), the expected
// authored frame from the boundary oracle (upper track at composition time 0), and the
// mx_bed.wav stereo PCM at the context rate, starting at source time 0.
const AUTHORED_PCM_FRAMES = 4096;
async function buildColdVideoOracle(
  rate: number,
  fps = 30,
  mediaPath = join(decoderMediaDir, 'fr30.webm'),
  audioPath = join(fixtureDir, 'media', 'mx_bed.wav')
): Promise<{
  references: Uint8Array[];
  expectedIndex: number;
  audio: Float32Array;
  audioSha256: string;
}> {
  const frameCount = (36 * fps) / 30;
  const video = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      mediaPath,
      '-vf',
      'scale=64:36:flags=neighbor',
      '-frames:v',
      String(frameCount),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(video.exit, 0, `reference video decode failed: ${video.stderr}`);
  const frameBytes = 64 * 36 * 4;
  assert.equal(
    video.stdout.length,
    frameCount * frameBytes,
    'reference frame count mismatch'
  );
  const references = Array.from({ length: frameCount }, (_, i) =>
    Uint8Array.from(video.stdout.subarray(i * frameBytes, (i + 1) * frameBytes))
  );
  const oracle = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries-oracle.json',
          import.meta.url
        )
      ),
      'utf8'
    )
  ) as {
    fixture: {
      evaluations_at_time: Array<{
        time: { value: number; rate: number };
        contributions: Array<{
          node_id: string;
          bundle_path: string;
          kind: string;
          library_source_time: { value: number; rate: number };
        }>;
      }>;
    };
  };
  const atZero = oracle.fixture.evaluations_at_time.find(
    (entry) => entry.time.value === 0
  );
  const upper = atZero?.contributions.find(
    (entry) => entry.node_id === 'upper-video-a' && entry.kind === 'Video'
  );
  assert.ok(
    upper && upper.bundle_path === 'media/fr30.webm',
    'oracle upper video contribution missing at time 0'
  );
  const expectedIndex = Math.round(
    (upper.library_source_time.value / upper.library_source_time.rate) * fps
  );
  const audioDecode = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      audioPath,
      '-t',
      String(AUTHORED_PCM_FRAMES / rate),
      '-f',
      'f32le',
      '-af',
      'pan=stereo|c0=c0|c1=c0',
      '-ar',
      String(rate),
      'pipe:1',
    ],
    { timeoutMs: 20000 }
  );
  assert.equal(
    audioDecode.exit,
    0,
    `reference audio decode failed: ${audioDecode.stderr}`
  );
  const audioSha256 = createHash('sha256')
    .update(audioDecode.stdout)
    .digest('hex');
  const bytes = Uint8Array.from(audioDecode.stdout);
  const audio = new Float32Array(bytes.buffer.slice(0, bytes.byteLength));
  assert.ok(
    audio.length >= 2 * AUTHORED_PCM_FRAMES,
    'reference audio too short'
  );
  // mx_bed.wav is mono. The authored clip has weight 1.0 and no pan law, so each output
  // channel must equal the mono sample at unity. The proof asserts that premise on the
  // decoded reference instead of assuming it.
  for (let k = 0; k < AUTHORED_PCM_FRAMES; k++)
    assert.equal(
      audio[2 * k],
      audio[2 * k + 1],
      'mx_bed reference is not mono; the unity-per-channel oracle does not apply'
    );
  return { references, expectedIndex, audio, audioSha256 };
}

// The 60 fps document is the boundary fixture with every 30 fps RationalTime rescaled to
// 60 fps (rate 60, value doubled), so the same seconds of timeline play at twice the
// rate. Its video is the fixture's own fr30 source re-timed to 60 fps by ffmpeg, and the
// independent oracle decodes that shipped file, never a value taken from the player.
function scaleRationalTimes(
  node: unknown,
  from: number,
  to: number,
  counter: { scaled: number }
): unknown {
  if (Array.isArray(node))
    return node.map((item) => scaleRationalTimes(item, from, to, counter));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record))
    out[key] = scaleRationalTimes(value, from, to, counter);
  if (record['OTIO_SCHEMA'] === 'RationalTime.1' && record['rate'] === from) {
    assert.equal(
      typeof record['value'],
      'number',
      'RationalTime lacks a numeric value'
    );
    out['rate'] = to;
    out['value'] = (record['value'] as number) * (to / from);
    counter.scaled += 1;
  }
  return out;
}

async function publishSixtyFpsDocument(): Promise<string> {
  const directory = join(scratch, 'sixty-fps-boundaries.otiod');
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  const source = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
          import.meta.url
        )
      ),
      'utf8'
    )
  ) as unknown;
  const counter = { scaled: 0 };
  const scaled = scaleRationalTimes(source, 30, 60, counter);
  assert.ok(
    counter.scaled > 0,
    'boundary fixture has no 30 fps RationalTime to rescale'
  );
  const text = JSON.stringify(scaled, null, 2);
  assert.ok(
    text.includes('media/fr30.webm'),
    'boundary fixture lost its fr30 reference'
  );
  await writeFile(
    join(directory, 'content.otio'),
    text.replaceAll('media/fr30.webm', 'media/fr60.webm')
  );
  const retimed = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-i',
      join(decoderMediaDir, 'fr30.webm'),
      '-vf',
      'fps=60',
      '-an',
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
      '-deadline',
      'realtime',
      join(media, 'fr60.webm'),
    ],
    { timeoutMs: 240000 }
  );
  assert.equal(retimed.exit, 0, `60 fps retime failed: ${retimed.stderr}`);
  await cp(join(fixtureDir, 'media', 'mx_bed.wav'), join(media, 'mx_bed.wav'));
  for (const name of ['plate_1001.png', 'plate_1002.png', 'secondary_b.mp4'])
    await cp(join(fixtureDir, 'media', name), join(media, name));
  return publishLegacyDirectory(directory, 'OTIO legacy 60fps boundaries');
}

// Index of the first stereo frame where the independent reference is nonzero in either
// channel. mx_bed opens on a zero sample, so the first audible output frame is the
// committed start plus this index, not the start itself.
function firstReferenceNonzero(reference: Float32Array): number {
  for (let k = 0; 2 * k + 1 < reference.length; k++)
    if (reference[2 * k] !== 0 || reference[2 * k + 1] !== 0) return k;
  throw new Error(
    'independent reference is silent; first audible frame unproven'
  );
}

// Authored PCM comparator: actual[k] must match reference frame k in both channels
// within 0.003, and every frame must be present. An absent frame is never accepted.
function compareAuthoredPcm(
  actual: Array<[number, number] | undefined>,
  reference: Float32Array,
  frames: number
): boolean {
  for (let k = 0; k < frames; k++) {
    const pair = actual[k];
    if (!pair) return false;
    if (Math.abs(pair[0] - reference[2 * k]!) > 0.003) return false;
    if (Math.abs(pair[1] - reference[2 * k + 1]!) > 0.003) return false;
  }
  return true;
}

// A reference is usable only when it carries real audible content.
function referenceIsAudible(reference: Float32Array, frames: number): boolean {
  let sum = 0;
  for (let i = 0; i < 2 * frames; i++) sum += reference[i]! * reference[i]!;
  return Math.sqrt(sum / (2 * frames)) > 1e-3;
}

// Controls for the authored comparator: the reference matches itself, a one-frame shift
// and silent output are rejected, and a silent reference is not usable.
function assertAuthoredPcmControls(): void {
  const frames = 8;
  const reference = new Float32Array(2 * frames);
  for (let i = 0; i < reference.length; i++) reference[i] = 0.1 + 0.01 * i;
  const self: Array<[number, number] | undefined> = [];
  for (let k = 0; k < frames; k++)
    self.push([reference[2 * k]!, reference[2 * k + 1]!]);
  assert.ok(
    compareAuthoredPcm(self, reference, frames),
    'authored comparator rejected the reference itself'
  );
  const shifted: Array<[number, number] | undefined> = [];
  for (let k = 0; k < frames; k++) {
    const j = Math.min(k + 1, frames - 1);
    shifted.push([reference[2 * j]!, reference[2 * j + 1]!]);
  }
  assert.ok(
    !compareAuthoredPcm(shifted, reference, frames),
    'one-frame shift was accepted'
  );
  const silent: Array<[number, number] | undefined> = [];
  for (let k = 0; k < frames; k++) silent.push([0, 0]);
  assert.ok(
    !compareAuthoredPcm(silent, reference, frames),
    'silent output was accepted'
  );
  assert.ok(
    !referenceIsAudible(new Float32Array(2 * frames), frames),
    'silent reference counted as audible'
  );
}

// Collects the carrier-identified output frames [f0, f0+frames) in order.
function collectAuthoredPcm(
  trace: MovingTrace['trace'],
  f0: number,
  frames: number
): Array<[number, number] | undefined> {
  const witness = trace.witness;
  assert.ok(witness, 'authored PCM comparison lacks the independent carrier');
  const out: Array<[number, number] | undefined> = new Array(frames).fill(
    undefined
  );
  for (const chunk of trace.audio) {
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null) continue;
      const k = frame - f0;
      if (k < 0 || k >= frames) continue;
      out[k] = [chunk.channels[0]![i]!, chunk.channels[1]![i]!];
    }
  }
  return out;
}

async function calibratePostGainTap(
  sessionToken: string,
  interactionOnly = false
): Promise<void> {
  const directory = join(scratch, 'playback-boundaries.otiod');
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  await cp(
    fileURLToPath(
      new URL(
        '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
        import.meta.url
      )
    ),
    join(directory, 'content.otio')
  );
  await cp(join(decoderMediaDir, 'fr30.webm'), join(media, 'fr30.webm'));
  for (const name of [
    'plate_1001.png',
    'plate_1002.png',
    'mx_bed.wav',
    'secondary_b.mp4',
  ])
    await cp(join(fixtureDir, 'media', name), join(media, name));
  let url: string;
  if (interactionOnly) {
    const published = await callMcp('relic_publish', {
      path: directory,
      title: 'OTIO playback boundary proof',
      cover: false,
    });
    url = String(published['url'] ?? published['link'] ?? '');
    assert.ok(
      url.startsWith(origin) && url.includes('#'),
      'boundary fixture publish failed'
    );
  } else {
    url = await publishLegacyDirectory(
      directory,
      'OTIO playback boundary proof'
    );
  }
  const relicId = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  assert.ok(relicId, 'boundary fixture relic ID missing');
  // The fixture is 48 kHz. A context at any other rate makes the viewer play natively with the
  // reason "sample-rate conversion is required", and the dropout and agreement checks below are
  // claims about scheduled audio only. Linux headless Chrome defaults to 44.1 kHz, so the rate is
  // pinned as it is for every other scheduled stage, and the capture's rate is asserted.
  const browser = await openBrowser(url, sessionToken, {
    label: interactionOnly ? 'interaction-only' : 'post-gain-calibration',
    recordProofTrace: !interactionOnly,
    ...(interactionOnly ? {} : { proofSampleRate: 48000 as const }),
  });
  try {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitReady(browser);
    if (!interactionOnly)
      await assertLegacyProgramState(browser, 'post-gain-calibration');
    const provenance = await proofProvenance(browser);
    if (!interactionOnly) {
      const stopCast = await browser.startScreencast();
      const capture = await browser.evaluate<{
        start: {
          sampleRate: number;
          contextState: string;
          sampleFrame: number;
        };
        mute: { value: number; sampleFrame: number };
        restored: number;
        trace: {
          sampleRate: number;
          sampleFrame: number;
          contextState: string;
          audioOverflow: boolean;
          visualOverflow: boolean;
          eventsOverflow: boolean;
          audio: MovingTrace['trace']['audio'];
          witness: MovingTrace['trace']['witness'];
          visual: Array<{ timestamp: number; error?: string }>;
        };
      }>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const button = document.querySelector('button.otio-play');
      const root = document.querySelector('.otio-view');
      if (!(button instanceof HTMLButtonElement) || !root) throw new Error('playback controls missing');
      button.click();
      const deadline = performance.now() + 12000;
      while (root.dataset.playing !== 'true' && performance.now() < deadline) await sleep(25);
      if (root.dataset.playing !== 'true') throw new Error('playback did not start');
      await sleep(600);
      const start = await globalThis.__otioProofTrace.start();
      await sleep(600);
      const mute = globalThis.__otioProofTrace.mute();
      await sleep(600);
      const restored = globalThis.__otioProofTrace.restore(mute.value);
      await sleep(600);
      const trace = await globalThis.__otioProofTrace.stop();
      return {start, mute, restored, trace};
    })()`);
      const cast = await stopCast();
      await pausePlayback(browser);
      await writeFile(
        join(shotDir, 'post-gain-calibration.json'),
        JSON.stringify({ provenance, capture, cast })
      );
      assert.ok(
        proofWorkletRequests > 0,
        'same-origin proof worklet was not requested'
      );
      assert.equal(
        capture.start.contextState,
        'running',
        'audio context not running'
      );
      assert.equal(
        capture.start.sampleRate,
        48000,
        'post-gain calibration context is not at the fixture rate, so audio was not scheduled'
      );
      assert.equal(
        capture.trace.audioOverflow,
        false,
        'post-gain PCM capture overflow'
      );
      assert.equal(
        capture.trace.visualOverflow,
        false,
        'canvas capture overflow'
      );
      assert.equal(
        capture.trace.eventsOverflow,
        false,
        'audio event capture overflow'
      );
      assert.equal(cast.overflow, false, 'screencast capture overflow');
      assert.ok(
        cast.frames.length >= 2,
        'screencast returned fewer than two frames'
      );
      assert.ok(
        capture.trace.visual.length >= 2 &&
          capture.trace.visual.every((s) => !s.error),
        'canvas trace unavailable'
      );
      const chunks = capture.trace.audio;
      // This stage plays scheduled audio at the fixture rate, where the engine
      // repeats a cached currentFrame label now and then. As in the scheduled
      // stages, the independent carrier and the callback sequence authenticate
      // coverage and give every sample its frame. Raw labels stay diagnostic.
      const witness = capture.trace.witness;
      assertPcmCoverage(
        capture.start.sampleFrame,
        capture.trace.sampleFrame,
        chunks,
        witness
      );
      assert.ok(witness, 'independent native carrier unavailable');
      assert.ok(chunks.length > 2, 'post-gain PCM tap produced no chunks');
      const rms = (from: number, to: number): number => {
        let sum = 0,
          count = 0;
        for (const chunk of chunks)
          for (const channel of chunk.channels)
            for (let i = 0; i < channel.length; i++) {
              const frame = carrierFrame(chunk, i, witness);
              if (frame !== null && frame >= from && frame < to) {
                sum += channel[i]! ** 2;
                count++;
              }
            }
        assert.ok(count > 0, 'audio calibration window has no PCM');
        return Math.sqrt(sum / count);
      };
      const guard = Math.ceil(capture.trace.sampleRate * 0.15);
      const before = rms(
        capture.start.sampleFrame + guard,
        capture.mute.sampleFrame - guard
      );
      const muted = rms(
        capture.mute.sampleFrame + guard,
        capture.restored - guard
      );
      assert.ok(
        before > 0.0001,
        `post-gain source was silent before mute: ${before}`
      );
      assert.ok(
        muted < before * 0.01,
        `master-gain mute did not silence the tapped signal: ${before} -> ${muted}`
      );
      pass('post-gain-tap-calibration');
      await assessMovingWindowControls(browser, before, muted, provenance);
      await assertVideoReservationInvalidation(browser, provenance);
      await calibrateCaptureOverhead(browser, provenance);
      await focusItem(browser, 'moving-a');
      await assessMovingWindowControls(
        browser,
        before,
        muted,
        provenance,
        true
      );
      await leaveFocus(browser);
    }
    await focusItem(browser, 'moving-b');
    if (interactionOnly) {
      const matrix: Array<Record<string, unknown>> = [];
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
        const fit = await browser.evaluate<boolean>(`(() => {
          const button=document.querySelector('.otio-zoom-fit');
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click(); return true;
        })()`);
        assert.ok(fit, 'focused Fit control missing');
        await openComposer(browser);
        const seeded = await browser.evaluate<boolean>(`(() => {
          const field=document.querySelector('.popover-composer textarea.popover-field');
          if (!(field instanceof HTMLTextAreaElement)) return false;
          field.value='Draft survives zoom.';
          field.dispatchEvent(new Event('input',{bubbles:true}));
          globalThis.__interactionDraft=field; return true;
        })()`);
        assert.ok(seeded, 'focused draft unavailable');
        const wheel = await assertFocusedWheelZoom(browser, true);
        const draftKept = await browser.evaluate<boolean>(`(() => {
          const field=document.querySelector('.popover-composer textarea.popover-field');
          return field === globalThis.__interactionDraft && field?.value === 'Draft survives zoom.';
        })()`);
        assert.ok(draftKept, 'wheel zoom lost focused draft');
        const geometry = await measureComposer(browser);
        assertComposerProbe(
          geometry,
          `${width}px ${scheme} interaction composer`,
          false
        );
        await browser.screenshot(`interaction-${width}-${scheme}`);
        matrix.push({ width, scheme, geometry, wheel });
        await dismissComposer(browser);
      }
      await writeFile(
        join(shotDir, 'interaction-layout.json'),
        JSON.stringify({ provenance, matrix })
      );
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const local = await browser.evaluate<{
      origin: number;
      rate: number;
      start: string;
      end: string;
    } | null>(`(() => {
      const root = document.querySelector('.otio-view');
      const input = document.querySelector('.otio-selection-in');
      const output = document.querySelector('.otio-selection-out');
      const range = document.querySelector('button[data-otio-mode="range"]');
      if (!(root instanceof HTMLElement) || !(input instanceof HTMLInputElement) ||
          !(output instanceof HTMLInputElement) || !(range instanceof HTMLButtonElement)) return null;
      range.click();
      input.value = '2'; input.dispatchEvent(new Event('change', {bubbles:true}));
      output.value = '6'; output.dispatchEvent(new Event('change', {bubbles:true}));
      return {origin: Number(root.dataset.domainOrigin), rate: Number(root.dataset.domainRate),
        start: input.value, end: output.value};
    })()`);
    assert.ok(
      local && local.origin === 60 && local.rate === 30,
      `wrong focus origin: ${JSON.stringify(local)}`
    );
    assert.equal(local.start, '2');
    assert.equal(local.end, '6');
    const body = 'Check the second moving occurrence.';
    await postComposer(browser, body);
    const comment = commentByBody(await readComments(relicId), body);
    if (interactionOnly)
      await writeFile(
        join(shotDir, 'interaction-original-comment.json'),
        JSON.stringify({ provenance, comment })
      );
    const anchor = comment['anchor'] as {
      item_id?: string;
      track_id?: string;
      relic_version?: number;
      range?: TimeRange;
    };
    assert.equal(anchor.item_id, 'moving-b');
    assert.equal(anchor.track_id, 'boundary-lower');
    assert.equal(anchor.relic_version, 1);
    assert.ok(
      rangeClose(anchor.range, {
        start_time: { value: 62, rate: 30 },
        duration: { value: 4, rate: 30 },
      }),
      'local range was not persisted in composition coordinates'
    );
    const resolved = resolvedOf(comment);
    const spans = resolved['intersections'] as Array<Record<string, unknown>>;
    assert.equal(resolved['status'], 'resolved');
    assert.ok(Array.isArray(spans), 'focused comment has no source spans');
    const span = spans.find((item) => item['node_id'] === 'moving-b');
    assert.ok(
      span &&
        rationalClose(asRange(span['source_range'])?.start_time, {
          value: 8,
          rate: 30,
        }),
      'focused comment resolved to the wrong source interval'
    );
    assert.ok(
      rationalClose(asRange(span['file_relative_source_range'])?.start_time, {
        value: 8,
        rate: 30,
      }),
      'focused comment resolved to the wrong file-relative interval'
    );
    const encrypted = JSON.stringify(
      await (await fetch(`${origin}/api/relics/${relicId}/comments`)).json()
    );
    assert.ok(
      !encrypted.includes(body) && !encrypted.includes('moving-b'),
      'focused comment leaked plaintext'
    );
    const commentId = String(comment['comment_id'] ?? '');
    assert.ok(commentId, 'focused comment has no ID');
    const reopened = await openBrowser(url, sessionToken, {
      label: 'nonzero-focus-reload',
    });
    try {
      await waitReady(reopened);
      const clicked = await reopened.evaluate<boolean>(`(async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const mark = [...document.querySelectorAll('.otio-comment-mark')]
            .find(node => node.dataset.commentId === ${JSON.stringify(commentId)});
          if (mark instanceof HTMLButtonElement) { mark.click(); return true; }
          const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
        }
        return false;
      })()`);
      assert.ok(clicked, 'focused comment was not revealed after reload');
      const revealed = await reopened.evaluate<boolean>(`(async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const root = document.querySelector('.otio-view');
          if (root?.dataset.scopeNodeId === 'moving-b') return true;
          const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
        }
        return false;
      })()`);
      assert.ok(
        revealed,
        'reload reveal did not restore the original focused item'
      );
    } finally {
      await reopened.close();
    }
    if (interactionOnly)
      assert.equal(
        mails.length,
        0,
        `interaction comment unexpectedly invoked mailer: ${JSON.stringify(mails.map(({ to, mail }) => ({ to, subject: mail.subject })))}`
      );
    // An addressed reply normally emails the reviewer. The reviewer has stopped
    // email for this relic, in the full path as in the interaction-only run,
    // so the republishes below send nothing.
    await store.putOptOut({
      relicId,
      addressHash: await sha256Hex('reader@example.test'),
      at: fakeNow,
    });
    const sourceRange: TimeRange = {
      start_time: { value: 8, rate: 30 },
      duration: { value: 4, rate: 30 },
    };
    let revisionDir = directory;
    for (const [operation, status] of [
      ['boundary-insert', 'mapped'],
      ['boundary-trim', 'partial'],
      ['boundary-ambiguous', 'ambiguous'],
    ] as const) {
      const nextDir = join(scratch, `${operation}.otiod`);
      const result = JSON.parse(
        await oracle([
          'mutate',
          operation,
          revisionDir,
          nextDir,
          JSON.stringify(sourceRange),
        ])
      ) as { status: string; mapped_range: TimeRange | null };
      assert.equal(result.status, status, `official ${operation} oracle`);
      const updated = await callMcp('relic_republish', {
        relic_id: relicId,
        path: nextDir,
        cover: false,
        notify: false,
        ...(operation === 'boundary-insert'
          ? {
              addresses: [
                { comment_id: commentId, note: 'Retained the clip.' },
              ],
            }
          : {}),
      });
      assert.ok(updated['version'], `${operation} did not republish`);
      const after = commentByBody(await readComments(relicId), body);
      const originalAnchor = after['anchor'] as {
        item_id?: string;
        track_id?: string;
        range?: TimeRange;
      };
      assert.equal(originalAnchor.item_id, 'moving-b');
      assert.equal(originalAnchor.track_id, 'boundary-lower');
      assert.ok(
        rangeClose(originalAnchor.range, anchor.range),
        `${operation} rewrote original anchor`
      );
      const projection = resolvedOf(after)['current_projection'] as {
        status?: string;
        mapped_range?: TimeRange;
        mapped_start_seconds?: number | null;
      };
      assert.equal(projection.status, status, `${operation} projection status`);
      if (status === 'ambiguous') {
        assert.equal(projection.mapped_range, undefined);
        assert.ok(
          projection.mapped_start_seconds == null,
          'ambiguous projection guessed a coordinate'
        );
      } else {
        assert.ok(
          rangeClose(projection.mapped_range, result.mapped_range),
          `${operation} projection disagrees with official reader`
        );
      }
      revisionDir = nextDir;
      if (interactionOnly)
        await writeFile(
          join(shotDir, `interaction-${operation}.json`),
          JSON.stringify({ provenance, oracle: result, comment: after })
        );
    }
    if (interactionOnly) {
      assert.deepEqual(
        browser.blocked,
        [],
        'interaction proof attempted non-loopback network'
      );
      assert.deepEqual(
        browser.continuedNonLoopback,
        [],
        'interaction proof continued non-loopback network'
      );
    }
    if (!interactionOnly) pass('focused-nonzero-comment');
  } finally {
    await browser.close();
  }
}
async function runNativeAudioCompatibilityProof(
  sessionToken: string
): Promise<void> {
  const source = fileURLToPath(
    new URL(
      '../../relic-format/test/fixtures/otio/scheduled-audio.otiod/',
      import.meta.url
    )
  );
  const directory = join(scratch, 'scheduled-native.otiod');
  await cp(source, directory, { recursive: true });
  const compressed = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(source, 'media', 'indexed-stereo.wav'),
      '-f',
      'mp3',
      'pipe:1',
    ],
    { timeoutMs: 30000 }
  );
  assert.equal(
    compressed.exit,
    0,
    `native compatibility fixture conversion failed: ${compressed.stderr}`
  );
  assert.ok(compressed.stdout.length > 0);
  await writeFile(
    join(directory, 'media', 'indexed-stereo.mp3'),
    compressed.stdout
  );
  const document = await readFile(join(directory, 'content.otio'), 'utf8');
  assert.ok(
    document.includes('media/indexed-stereo.wav'),
    'native compatibility source reference missing'
  );
  await writeFile(
    join(directory, 'content.otio'),
    document.replaceAll('media/indexed-stereo.wav', 'media/indexed-stereo.mp3')
  );
  const url = await publishLegacyDirectory(
    directory,
    'OTIO legacy native-compatibility'
  );
  const browser = await openBrowser(url, sessionToken, {
    label: 'native-audio-compatibility',
    recordProofTrace: true,
  });
  try {
    await waitReady(browser);
    await assertLegacyProgramState(browser, 'native-compatibility');
    const provenance = await proofProvenance(browser);
    const capture = await browser.evaluate<MovingTrace>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const button = document.querySelector('button.otio-play');
      const root = document.querySelector('.otio-view');
      if (!(button instanceof HTMLButtonElement) || !(root instanceof HTMLElement)) throw new Error('native compatibility controls missing');
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      button.click();
      await sleep(1500);
      const trace = await globalThis.__otioProofTrace.stop();
      if (root.dataset.playing === 'true') button.click();
      return {start, playEdge, trace};
    })()`);
    await writeFile(
      join(shotDir, 'native-audio-compatibility.json'),
      JSON.stringify({ provenance, capture })
    );
    const backends = capture.trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>)
      .filter((event) => event['event'] === 'backend');
    const backend = backends.at(-1);
    assert.equal(
      backend?.['backend'],
      'native',
      'compressed audio did not select native compatibility'
    );
    assert.ok(
      typeof backend?.['reason'] === 'string' && backend['reason'].length > 0,
      'native compatibility reason missing'
    );
    assert.ok(
      capture.trace.events.some(
        (entry) => entry.kind === 'play' && entry.mediaType === 'AUDIO'
      ),
      'native compatibility did not play an audio element'
    );
    const samples = capture.trace.audio.flatMap(
      (chunk) => chunk.channels[0] ?? []
    );
    assert.ok(
      samples.length > 0 && samples.some((value) => Math.abs(value) > 0.001),
      'native compatibility output was silent'
    );
    assert.ok(
      !capture.trace.audioOverflow && !capture.trace.eventsOverflow,
      'native compatibility trace overflow'
    );
    pass('scheduled-pcm-native-compatibility');
  } finally {
    await browser.close();
  }
}
// Pure cold-start verdict. The thresholds are the unchanged original 350 ms budget
// for both first audible source-correct output and first visual presentation, at
// least two native promotions, and no suspend request after the play edge.
function coldStartVerdict(input: {
  audibleMs: number;
  visualMs: number;
  promotions: number;
  suspendsAfterPlay: number;
}): boolean {
  return (
    input.audibleMs <= 350 &&
    input.visualMs <= 350 &&
    input.promotions >= 2 &&
    input.suspendsAfterPlay === 0
  );
}

// First nonzero output at or after f0, using only carrier-identified samples. Returns
// null when no nonzero sample exists, so absent output is never inferred.
function firstNonzeroFrame(
  trace: MovingTrace['trace'],
  f0: number
): { frame: number } | null {
  const witness = trace.witness;
  assert.ok(witness, 'cold audible measurement lacks the independent carrier');
  let best: number | null = null;
  for (const chunk of trace.audio) {
    for (let i = 0; i < chunk.channels[0]!.length; i++) {
      const frame = carrierFrame(chunk, i, witness);
      if (frame === null || frame < f0) continue;
      const left = chunk.channels[0]![i]!,
        right = chunk.channels[1]![i]!;
      if (Math.abs(left) > 1e-6 || Math.abs(right) > 1e-6) {
        if (best === null || frame < best) best = frame;
      }
    }
  }
  return best === null ? null : { frame: best };
}

// Maps a committed frame to wall time with the nearest prior native output
// observation (getOutputTimestamp). The bound is the read duration plus the
// extrapolation distance, reported rather than hidden.
function mapFrameToWall(
  observations: Array<{
    before: number;
    after: number;
    contextTime: number;
    performanceTime: number;
  }>,
  frame: number,
  rate: number
): { wallMs: number; boundMs: number } | null {
  let chosen: (typeof observations)[number] | null = null;
  for (const obs of observations) {
    if (
      obs.contextTime * rate <= frame &&
      (chosen === null || obs.contextTime > chosen.contextTime)
    )
      chosen = obs;
  }
  if (chosen === null) return null;
  const extrapolationMs = (frame / rate - chosen.contextTime) * 1000;
  return {
    wallMs: chosen.performanceTime + extrapolationMs,
    boundMs: chosen.after - chosen.before + extrapolationMs,
  };
}

// Synthetic controls for the cold measurement: an observation after the frame must
// not be used, and the mapping must follow the nearest prior observation.
function assertColdMeasurementControls(): void {
  const obs = [
    { before: 0, after: 1, contextTime: 0.0, performanceTime: 1000 },
    { before: 50, after: 51, contextTime: 0.5, performanceTime: 1500 },
  ];
  // Frame 12000 at 48 kHz is 0.25 s: nearest prior observation is the first one, so the
  // wall time is 1000 ms plus 250 ms of extrapolation.
  const quarter = mapFrameToWall(obs, 12000, 48000);
  assert.ok(
    quarter !== null && Math.abs(quarter.wallMs - 1250) < 1e-9,
    'cold mapping did not extrapolate from the nearest prior observation'
  );
  // Frame 24000 at 48 kHz is exactly the second observation (0.5 s), which counts as prior.
  const exact = mapFrameToWall(obs, 24000, 48000);
  assert.ok(
    exact !== null && Math.abs(exact.wallMs - 1500) < 1e-9,
    'cold mapping did not use the exact prior observation'
  );
  assert.equal(
    mapFrameToWall(obs.slice(1), 100, 48000),
    null,
    'mapping used an observation after the frame'
  );
}

// First screencast frame whose pixels differ from the baseline. Returns -1 when none
// differ, so an unchanged capture is never reported as presentation.
function firstChangedScreencastIndex(
  baseline: Uint8Array,
  frames: Array<Uint8Array>
): number {
  return frames.findIndex(
    (pixels) =>
      pixels.length !== baseline.length ||
      pixels.some((value, i) => value !== baseline[i])
  );
}

// Negative controls for the screencast comparator: identical frames never count as a
// change, and a single differing byte does.
function assertScreencastComparatorControls(): void {
  const base = new Uint8Array([1, 2, 3, 4]);
  assert.equal(
    firstChangedScreencastIndex(base, [new Uint8Array([1, 2, 3, 4])]),
    -1,
    'identical screencast frame counted as presentation'
  );
  assert.equal(
    firstChangedScreencastIndex(base, [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([1, 2, 3, 5]),
    ]),
    1,
    'single changed byte was not detected'
  );
}
// Source-matched presentation: a frame is accepted only when it is the expected
// authored video frame, within the existing classifier's error bound and clearly
// closer to it than to any other reference. A mere byte difference never qualifies.
function matchesExpectedVideoFrame(
  pixels: Uint8Array,
  references: readonly Uint8Array[],
  expected: number
): boolean {
  const ranked = references
    .map((reference, index) => ({ index, error: rmse(pixels, reference) }))
    .sort((a, b) => a.error - b.error);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || !next || best.index !== expected) return false;
  return best.error < 12 && best.error < next.error;
}

// Cells of the 64x36 crop that a viewer overlay covers. A cell touching any overlay is
// excluded from the comparison; the threshold stays 12, and at least 80% of cells must remain.
function overlayCellMask(
  crop: { x: number; y: number; width: number; height: number },
  overlays: ReadonlyArray<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>
): Uint8Array {
  const mask = new Uint8Array(64 * 36).fill(1);
  for (let row = 0; row < 36; row++)
    for (let col = 0; col < 64; col++) {
      const x0 = crop.x + (col * crop.width) / 64;
      const x1 = crop.x + ((col + 1) * crop.width) / 64;
      const y0 = crop.y + (row * crop.height) / 36;
      const y1 = crop.y + ((row + 1) * crop.height) / 36;
      if (
        overlays.some(
          (o) =>
            x1 > o.x && x0 < o.x + o.width && y1 > o.y && y0 < o.y + o.height
        )
      )
        mask[row * 64 + col] = 0;
    }
  const kept = mask.reduce((sum, value) => sum + value, 0);
  assert.ok(
    kept >= 0.8 * 64 * 36,
    `overlay mask removed too much of the frame (${kept} of ${64 * 36} cells kept)`
  );
  return mask;
}

// RMSE over the unmasked cells only; the same arithmetic as rmse() on the full frame.
function maskedRmse(
  pixels: Uint8Array,
  reference: Uint8Array,
  mask: Uint8Array
): number {
  let sum = 0;
  let count = 0;
  for (let cell = 0; cell < mask.length; cell++) {
    if (mask[cell] === 0) continue;
    for (let channel = 0; channel < 4; channel++) {
      const i = cell * 4 + channel;
      const d = pixels[i]! - reference[i]!;
      sum += d * d;
      count++;
    }
  }
  return Math.sqrt(sum / count);
}

// Classifies a screencast crop against the independent fr30 references with the same
// rule as matchesExpectedVideoFrame. Returns null when the frame is noise or ambiguous,
// so no frame is assigned a source it does not clearly match.
function classifyVideoFrame(
  pixels: Uint8Array,
  references: readonly Uint8Array[],
  mask?: Uint8Array
): number | null {
  const ranked = references
    .map((reference, index) => ({
      index,
      error: mask
        ? maskedRmse(pixels, reference, mask)
        : rmse(pixels, reference),
    }))
    .sort((a, b) => a.error - b.error);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || !next) return null;
  return best.error < 12 && best.error < next.error ? best.index : null;
}

// Selects the first post-play presentation of a later source-correct frame. The paused view
// must show a classified source frame: with no pre-play class the result is -1, so movement is
// never attributed to a view nothing classified. The pre-play class is excluded, not required
// absent. A frame is accepted only when it is at or after the expected source frame and no
// further ahead than the elapsed timeline allows (one source frame per 1/30 s at speed 1, plus
// one frame of rounding). Returns the index or -1.
function selectPresentedFrame(
  preplay: number | null,
  frames: Array<{ elapsedMs: number; cls: number | null }>,
  expected: number
): number {
  if (preplay === null) return -1;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || frame.cls === null) continue;
    if (frame.cls === preplay || frame.cls < expected) continue;
    const elapsedSourceFrames = (frame.elapsedMs * 30) / 1000;
    if (frame.cls - expected > Math.floor(elapsedSourceFrames) + 1) continue;
    return i;
  }
  return -1;
}

// Phase band from independent per-sample inputs. Each sample carries its own resident slot
// count K. The viewer's band for a leaf is [dL + 1000*(v - offset), dL + 1000*((K-1)*w -
// offset)] in absolute ms, where offset = (iL0Plus1Start - sourceT0Seconds) / rL, w is the
// leaf's minimum window and v the vsync. The phase is the intersection over leaves. K is
// required per sample: a missing or sub-3 count fails, it is never assumed. With K = 3 this
// is exactly the former two-window band, so the fixed-3 case is a special case, not the rule.
function phaseBandFromSamples(
  samples: Record<string, unknown>[],
  vsync: number
): { lower: number; upper: number } {
  let upper = Infinity;
  let lower = -Infinity;
  for (const raw of samples) {
    const dL = Number(raw['dL']),
      start = Number(raw['iL0Plus1Start']),
      source = Number(raw['sourceT0Seconds']),
      r = Number(raw['rL']),
      width = Number(raw['wMinSeconds']),
      slots = raw['residentSlots'];
    assert.ok(
      [dL, start, source, r, width].every(Number.isFinite) &&
        r > 0 &&
        width >= vsync,
      'invalid independent phase input'
    );
    assert.ok(
      typeof slots === 'number' && Number.isSafeInteger(slots) && slots >= 3,
      `phase sample lacks a resident slot count of at least three: ${String(slots)}`
    );
    const offsetMs = (1000 * (start - source)) / r;
    lower = Math.max(lower, dL + 1000 * vsync - offsetMs);
    upper = Math.min(upper, dL + 1000 * (slots - 1) * width - offsetMs);
  }
  assert.ok(
    Number.isFinite(lower) && Number.isFinite(upper),
    'phase band has no samples'
  );
  return { lower, upper };
}

// Only an independently classified audio-only document has no video phase.
function recoveryPhaseBand(
  samples: Record<string, unknown>[],
  vsync: number,
  audioOnly: boolean
): { lower: number; upper: number } {
  if (!audioOnly) return phaseBandFromSamples(samples, vsync);
  assert.equal(
    samples.length,
    0,
    'audio-only recovery recorded a video phase sample'
  );
  return { lower: -Infinity, upper: Infinity };
}

// Controls for the per-sample phase band. The band must grow with K (a fixed-3 oracle would
// not), must equal the former two-window band at K = 3, and must refuse a missing count.
function assertPhaseBandControls(): void {
  const sample = (slots: number | undefined, width: number) => ({
    dL: 100,
    iL0Plus1Start: 0.05,
    sourceT0Seconds: 0,
    rL: 1,
    wMinSeconds: width,
    residentSlots: slots,
  });
  const vsync = 1 / 60;
  const width = 0.033;
  const three = phaseBandFromSamples([sample(3, width)], vsync);
  const formerUpper = 100 + 1000 * (2 * width) - 50;
  const formerLower = 100 + 1000 * vsync - 50;
  assert.ok(
    Math.abs(three.upper - formerUpper) < 1e-9 &&
      Math.abs(three.lower - formerLower) < 1e-9,
    'K = 3 band disagrees with the former two-window band'
  );
  const five = phaseBandFromSamples([sample(5, width)], vsync);
  assert.ok(
    five.upper > three.upper + 1000 * width,
    'K = 5 band did not widen: the oracle ignores the actual slot count'
  );
  const mixed = phaseBandFromSamples(
    [sample(5, width), sample(3, width)],
    vsync
  );
  assert.ok(
    Math.abs(mixed.upper - three.upper) < 1e-9,
    'the intersection took the wider leaf instead of the narrower one'
  );
  assert.throws(
    () => phaseBandFromSamples([sample(undefined, width)], vsync),
    /resident slot count/,
    'a sample without a slot count was accepted instead of refused'
  );
  assert.throws(
    () => phaseBandFromSamples([sample(2, width)], vsync),
    /resident slot count/,
    'a two-slot sample was accepted below the three-slot floor'
  );
  assert.deepEqual(recoveryPhaseBand([], vsync, true), {
    lower: -Infinity,
    upper: Infinity,
  });
  assert.throws(
    () => recoveryPhaseBand([sample(3, width)], vsync, true),
    /audio-only recovery recorded a video phase sample/
  );
  assert.throws(
    () => recoveryPhaseBand([], vsync, false),
    /phase band has no samples/
  );
  assert.deepEqual(recoveryPhaseBand([sample(3, width)], vsync, false), three);
  const reference = (target_url: string) => ({
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url,
  });
  assert.equal(
    isAudioOnlyDocument([reference('media/a.wav'), reference('media/b.mp3')]),
    true
  );
  assert.equal(
    isAudioOnlyDocument([reference('media/a.wav'), reference('media/v.webm')]),
    false
  );
  assert.equal(isAudioOnlyDocument([]), false);
}

// Controls: a paused view already showing the expected frame must not block the
// movement; a later frame is selected; an identical pre-play frame is skipped; a
// frame ahead of the timeline is rejected.
function assertFrameSelectionControls(): void {
  assert.equal(
    selectPresentedFrame(
      6,
      [
        { elapsedMs: 10, cls: 6 },
        { elapsedMs: 40, cls: 7 },
      ],
      6
    ),
    1,
    'paused expected frame blocked the later frame'
  );
  assert.equal(
    selectPresentedFrame(null, [{ elapsedMs: 10, cls: 6 }], 6),
    -1,
    'a frame was selected with no classified pre-play frame; movement is unattributable'
  );
  assert.equal(
    selectPresentedFrame(6, [{ elapsedMs: 10, cls: 20 }], 6),
    -1,
    'frame ahead of the timeline was accepted'
  );
}

// Controls for the overlay mask (overlayCellMask, maskedRmse, classifyVideoFrame with a
// mask). Each control uses a synthetic 64x36 RGBA source with exact expectations, so a
// mask that quietly hides a real difference fails a named control. The threshold, the
// 80% floor and the selector's timing rule are the production ones, not relaxed here.
function syntheticFrame(seed: number): Uint8Array {
  const frame = new Uint8Array(64 * 36 * 4);
  for (let i = 0; i < frame.length; i++)
    frame[i] = (seed * 37 + i * 13 + (i >> 2) * 7) % 251;
  return frame;
}

function assertOverlayMaskControls(): void {
  const crop = { x: 0, y: 0, width: 64, height: 36 };
  const refs = [1, 2, 3].map(syntheticFrame);
  const label = [{ x: 0, y: 0, width: 10, height: 10 }];
  const mask = overlayCellMask(crop, label);
  // A scope label drawn over the top-left cells: those bytes change, nothing else does.
  const withLabel = (
    source: Uint8Array,
    labelSource: Uint8Array
  ): Uint8Array => {
    const out = Uint8Array.from(source);
    for (let row = 0; row < 10; row++)
      for (let col = 0; col < 10; col++)
        for (let c = 0; c < 4; c++) {
          const i = (row * 64 + col) * 4 + c;
          out[i] = labelSource[i]!;
        }
    return out;
  };
  const inverted = (source: Uint8Array): Uint8Array =>
    Uint8Array.from(source, (value) => 255 - value);

  // 1. Unchanged frame: the paused source frame with only the label changed is still that
  // source, and a frame equal to the pre-play class never counts as movement.
  const unchanged = withLabel(refs[0]!, inverted(refs[0]!));
  assert.equal(
    classifyVideoFrame(unchanged, refs, mask),
    0,
    'unchanged source frame with a label was not classified as its own source'
  );
  assert.notEqual(
    classifyVideoFrame(unchanged, refs),
    0,
    'unmasked comparison accepted the labelled frame: the label control is vacuous'
  );
  assert.equal(
    selectPresentedFrame(0, [{ elapsedMs: 300, cls: 0 }], 0),
    -1,
    'an unchanged paused frame was counted as movement'
  );

  // 2. Wrong frame: a different source is never accepted as the expected one, even when its
  // differences sit under the label and the label cells are hidden.
  const wrong = withLabel(refs[1]!, refs[0]!);
  assert.equal(
    classifyVideoFrame(wrong, refs, mask),
    1,
    'a wrong source frame hidden under the label was not classified as its own source'
  );
  assert.equal(
    matchesExpectedVideoFrame(refs[1]!, refs, 0),
    false,
    'a wrong source frame was accepted as the expected frame'
  );
  const wrongOutside = withLabel(refs[2]!, refs[0]!);
  assert.equal(
    classifyVideoFrame(wrongOutside, refs, mask),
    2,
    'a wrong source whose differences lie outside the label was not classified as that source'
  );

  // 3. Obscured over 20 percent: 7 covered rows (19.4% of cells) pass, 8 rows (22.2%) fail.
  assert.doesNotThrow(
    () => overlayCellMask(crop, [{ x: 0, y: 0, width: 64, height: 7 }]),
    'a 19% overlay was rejected, but the floor is 20%'
  );
  assert.throws(
    () => overlayCellMask(crop, [{ x: 0, y: 0, width: 64, height: 8 }]),
    /removed too much/,
    'a 22% overlay was accepted: the mask hid more than 20% of the frame'
  );

  // 4. Timing: at 10 ms only one source frame of advance is allowed (rounding included).
  assert.equal(
    selectPresentedFrame(35, [{ elapsedMs: 10, cls: 1 }], 0),
    0,
    'the frame at the timeline bound was rejected'
  );
  assert.equal(
    selectPresentedFrame(35, [{ elapsedMs: 10, cls: 2 }], 0),
    -1,
    'a frame two source frames ahead of 10 ms was accepted'
  );
}

// Controls: the expected frame passes; a noise-only frame and a wrong-source frame
// are rejected; a single-byte difference from the expected frame still matches.
function assertSourceMatchControls(): void {
  const frameA = new Uint8Array(16).fill(10);
  const frameB = new Uint8Array(16).fill(100);
  const frameC = new Uint8Array(16).fill(200);
  const refs = [frameA, frameB, frameC];
  assert.ok(
    matchesExpectedVideoFrame(frameB, refs, 1),
    'expected authored frame rejected'
  );
  const noise = new Uint8Array(16).map((_, i) => (i % 2 === 0 ? 0 : 255));
  assert.ok(
    !matchesExpectedVideoFrame(noise, refs, 1),
    'noise-only frame accepted as presentation'
  );
  assert.ok(
    !matchesExpectedVideoFrame(frameC, refs, 1),
    'wrong-source frame accepted'
  );
  const oneByte = Uint8Array.from(frameB);
  oneByte[0] = 101;
  assert.ok(
    matchesExpectedVideoFrame(oneByte, refs, 1),
    'single-byte difference rejected from expected frame'
  );
}

// Real over-cap control, with no production hook. Retained ring slots are sized to the
// viewer canvas, not the media, so the canvas is set to 4096x4096 (16.8 Mi pixels per
// slot) before playback: two slots fit the 32 Mi-pixel total cap exactly and the
// default three-slot ring cannot be admitted. The viewer must refuse through its own
// admission path with ring-cap-exhausted, start no playback, and commit no causal epoch.
const OVERCAP_SIZE = 4096;

async function publishOverCapDocument(rate: 44100 | 48000): Promise<string> {
  const directory = join(scratch, `overcap-boundaries-${rate}.otiod`);
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  const content = await readFile(
    fileURLToPath(
      new URL(
        '../../relic-format/test/fixtures/otio/edge-cases/playback-boundaries.otio',
        import.meta.url
      )
    ),
    'utf8'
  );
  assert.ok(
    content.includes('media/fr30.webm'),
    'boundary fixture no longer references media/fr30.webm'
  );
  await writeFile(
    join(directory, 'content.otio'),
    content.replaceAll('media/fr30.webm', 'media/overcap.webm')
  );
  const encoded = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${OVERCAP_SIZE}x${OVERCAP_SIZE}:rate=30`,
      '-t',
      '1',
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '2M',
      '-deadline',
      'realtime',
      join(media, 'overcap.webm'),
    ],
    { cwd: scratch, timeoutMs: 240000 }
  );
  assert.equal(encoded.exit, 0, 'over-cap fixture encode failed');
  for (const name of ['plate_1001.png', 'plate_1002.png', 'secondary_b.mp4'])
    await cp(join(fixtureDir, 'media', name), join(media, name));
  if (rate === 48000) {
    await cp(
      join(fixtureDir, 'media', 'mx_bed.wav'),
      join(media, 'mx_bed.wav')
    );
  } else {
    const converted = await runChild(
      [
        'ffmpeg',
        '-v',
        'error',
        '-y',
        '-i',
        join(fixtureDir, 'media', 'mx_bed.wav'),
        '-ar',
        '44100',
        '-acodec',
        'pcm_s16le',
        join(media, 'mx_bed.wav'),
      ],
      { timeoutMs: 30000 }
    );
    assert.equal(converted.exit, 0, converted.stderr);
  }
  return publishLegacyDirectory(directory, 'OTIO legacy over-cap');
}

async function runOverCapRefusal(
  sessionToken: string,
  rate: 44100 | 48000
): Promise<void> {
  const url = await publishOverCapDocument(rate);
  const isolated = await openBrowser(url, sessionToken, {
    label: `overcap-refusal-${rate}`,
    defaultAutoplay: true,
    recordProofTrace: true,
    proofSampleRate: rate,
  });
  try {
    await waitReady(isolated);
    await assertLegacyProgramState(isolated, 'over-cap');
    const provenance = await proofProvenance(isolated);
    const button = await isolated.evaluate<{ x: number; y: number }>(`(() => {
      const control = document.querySelector('button.otio-play');
      if (!(control instanceof HTMLButtonElement)) throw new Error('over-cap play control missing');
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    // Ring slots are sized to the canvas (outputSize), so the proof sets the canvas to
    // the over-cap size before play and reads it back, rather than trusting the setter.
    const canvasSize = await isolated.evaluate<{
      width: number;
      height: number;
    }>(`(() => {
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('over-cap canvas missing');
      canvas.width = ${OVERCAP_SIZE};
      canvas.height = ${OVERCAP_SIZE};
      return { width: canvas.width, height: canvas.height };
    })()`);
    assert.deepEqual(
      canvasSize,
      { width: OVERCAP_SIZE, height: OVERCAP_SIZE },
      'over-cap canvas did not take the cap-sized dimensions'
    );
    // Full 4096px readbacks compete with the startup deadline; this control
    // verifies ring admission from viewer events rather than canvas pixels.
    await isolated.evaluate(
      `(async () => globalThis.__otioProofTrace.start({canvasReadback:false}))()`
    );
    await isolated.evaluate(
      `(() => globalThis.__otioProofTrace.playRequest())()`
    );
    await clickWithRealPointer(isolated, button.x, button.y);
    const settled = Promise.withResolvers<void>();
    setTimeout(settled.resolve, 2500);
    await settled.promise;
    const result = await isolated.evaluate<{
      playing: string;
      trace: MovingTrace['trace'];
    }>(`(async () => {
      const root = document.querySelector('.otio-view'), control = document.querySelector('button.otio-play');
      const playing = root?.dataset.playing ?? '';
      const trace = await globalThis.__otioProofTrace.stop();
      if (playing === 'true' && control instanceof HTMLButtonElement) control.click();
      return { playing, trace };
    })()`);
    await writeFile(
      join(shotDir, `overcap-refusal-${rate}.json`),
      JSON.stringify({ provenance, capture: result })
    );
    assert.ok(
      !result.trace.audioOverflow && !result.trace.eventsOverflow,
      'over-cap proof trace overflow'
    );
    assert.equal(
      result.trace.visual.length,
      0,
      'over-cap capture read back the cap-sized canvas'
    );
    const refusals = legacyColdValues(result.trace).filter(
      (value) => value['event'] === 'ring-refused'
    );
    assert.ok(
      refusals.length > 0 &&
        refusals.every((value) => value['code'] === 'ring-cap-exhausted'),
      `over-cap archive was not refused only by the cap: ${JSON.stringify(refusals)}`
    );
    // Admission, not decode failure: the refusal must follow real decoded frames of the
    // over-cap video, and the cap it reports must be the viewer's 32 Mi-pixel total.
    const refusalEntry = result.trace.events.find(
      (entry) =>
        entry.kind === 'cold-controller' &&
        (entry.value as Record<string, unknown>)['event'] === 'ring-refused' &&
        (entry.value as Record<string, unknown>)['code'] ===
          'ring-cap-exhausted'
    );
    assert.ok(refusalEntry, 'cap refusal event missing from the trace');
    const refusal = refusalEntry.value as Record<string, unknown>;
    assert.equal(
      refusal['capPixels'],
      32 * 1024 * 1024,
      'cap refusal reports a cap other than 32 Mi pixels'
    );
    // The ring requested requiredSlots canvases at the canvas size. Its refusal is
    // justified only when the pixels it already holds plus that request exceed the cap.
    // The held pixels must themselves stay within the cap, so no budget is violated.
    const requested = refusal['requiredSlots'];
    const held = refusal['slots'];
    const usedPixels = refusal['usedPixels'];
    assert.ok(
      Number.isSafeInteger(requested) && (requested as number) >= 3,
      `cap refusal requested fewer than the three-slot floor: ${String(requested)}`
    );
    assert.ok(
      Number.isSafeInteger(held) &&
        (held as number) >= 0 &&
        (held as number) < (requested as number),
      `cap refusal holds ${String(held)} slots, not below the request ${String(requested)}`
    );
    assert.ok(
      Number.isSafeInteger(usedPixels) &&
        (usedPixels as number) >= 0 &&
        (usedPixels as number) <= 32 * 1024 * 1024,
      `budget violation: admitted pixels ${String(usedPixels)} exceed the 32 Mi cap`
    );
    assert.ok(
      (usedPixels as number) +
        (requested as number) * OVERCAP_SIZE * OVERCAP_SIZE >
        32 * 1024 * 1024,
      'cap refusal is not explained: the requested canvases fit within the cap'
    );
    assert.notEqual(
      result.playing,
      'true',
      'over-cap archive started playback after its cap refusal'
    );
    const epochs = result.trace.events.filter(
      (entry) =>
        entry.kind === 'scheduled-pcm' &&
        (entry.value as Record<string, unknown> | undefined)?.['event'] ===
          'epoch'
    );
    assert.equal(
      epochs.length,
      0,
      'over-cap archive committed a causal epoch after refusing'
    );
  } finally {
    await isolated.close();
  }
}

// Native output observations (performance.now() ms paired with AudioContext time), the
// same records the cold start maps frames through.
function nativeOutputObservations(trace: MovingTrace['trace']): Array<{
  before: number;
  after: number;
  contextTime: number;
  performanceTime: number;
}> {
  return trace.events
    .filter((entry) => entry.kind === 'audio-output-timestamp-observed')
    .map((entry) => entry.value as Record<string, unknown>)
    .filter(
      (value) =>
        value['injected'] === false &&
        value['output'] !== null &&
        typeof value['output'] === 'object'
    )
    .map((value) => {
      const output = value['output'] as {
        contextTime: number;
        performanceTime: number;
      };
      return {
        before: Number(value['before']),
        after: Number(value['after']),
        contextTime: output.contextTime,
        performanceTime: output.performanceTime,
      };
    })
    .filter(
      (obs) =>
        Number.isFinite(obs.contextTime) &&
        Number.isFinite(obs.performanceTime) &&
        obs.contextTime > 0
    );
}

// Pre-play canvas baseline. The trace sampler records canvas readbacks only after a tick,
// so the proof waits, in the page and under a deadline, until one sample exists while the
// context is still suspended. Only then is the play request issued. The baseline is a real
// readback taken before play, never a fabricated or post-play frame.
async function awaitPreplayVisualBaseline(
  browser: ChromeSession
): Promise<number> {
  const count = await browser.evaluate<number>(`(async () => {
    const deadline = performance.now() + 3000;
    while (globalThis.__otioProofTrace.visualSampleCount() < 1 && performance.now() < deadline) {
      const {promise, resolve} = Promise.withResolvers();
      setTimeout(resolve, 10);
      await promise;
    }
    return globalThis.__otioProofTrace.visualSampleCount();
  })()`);
  assert.ok(
    count >= 1,
    'no pre-play canvas sample was recorded before the play request'
  );
  return count;
}

// Shared cold-start driver: a fresh suspended context, one trusted click, and the
// viewer's own trace over the playback window. Every legacy-cold proof uses it.
async function driveFreshLegacyClick(
  browser: ChromeSession
): Promise<{ playEdge: { timestamp: number }; trace: MovingTrace['trace'] }> {
  const button = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const control = document.querySelector('button.otio-play');
    if (!(control instanceof HTMLButtonElement)) throw new Error('legacy play control missing');
    const rect = control.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const start = await browser.evaluate<{ contextState: string }>(
    `(async () => globalThis.__otioProofTrace.start())()`
  );
  assert.equal(
    start.contextState,
    'suspended',
    'legacy proof context was not fresh and suspended before the click'
  );
  await awaitPreplayVisualBaseline(browser);
  const playEdge = await browser.evaluate<{ timestamp: number }>(
    `(() => globalThis.__otioProofTrace.playRequest())()`
  );
  await clickWithRealPointer(browser, button.x, button.y);
  const settled = Promise.withResolvers<void>();
  setTimeout(settled.resolve, 2500);
  await settled.promise;
  const outcome = await browser.evaluate<{
    trace: MovingTrace['trace'];
  }>(`(async () => {
    const root = document.querySelector('.otio-view'), control = document.querySelector('button.otio-play');
    const trace = await globalThis.__otioProofTrace.stop();
    if (root?.dataset.playing === 'true' && control instanceof HTMLButtonElement) control.click();
    return { trace };
  })()`);
  return { playEdge, trace: outcome.trace };
}

// 60 fps cold start. The document is the boundary fixture rescaled to 60 fps and its video is
// the fixture's fr30 source re-timed by ffmpeg. The independent oracle decodes the shipped fr60
// file and mx_bed.wav with ffmpeg; expected frame indexes are seconds multiplied by 60.
//
// The viewer schedules audio only when every video frame lasts at least one display refresh. WebM
// stores whole milliseconds, so fr60 has 16 ms frames, and until the viewer has measured the
// display it assumes 60 Hz (16.7 ms). It therefore refuses scheduled audio for this document and
// plays it natively. Jason decided on 2026-11-12 to keep that behaviour and to have this stage
// assert what the viewer did. A native run must carry that exact refusal, with the shortest frame
// checked against ffprobe, and must still play audibly and show the expected frame. A scheduled
// run keeps every scheduled check: the ring comes from the viewer's own records, and the audible
// wall time must lie inside the solved phase interval (absolute performance.now() ms). Scheduled
// audio at 60 fps is unproven while every run takes the native branch, and the log line says which.
async function runSixtyFpsColdProof(
  sessionToken: string,
  rate: 48000
): Promise<void> {
  const url = await publishSixtyFpsDocument();
  const oracle = await buildColdVideoOracle(
    rate,
    60,
    join(scratch, 'sixty-fps-boundaries.otiod', 'media', 'fr60.webm')
  );
  assert.ok(
    referenceIsAudible(oracle.audio, AUTHORED_PCM_FRAMES),
    '60 fps independent mx_bed reference is silent; audible output unproven'
  );
  const browser = await openBrowser(url, sessionToken, {
    label: `sixty-fps-cold-${rate}`,
    defaultAutoplay: true,
    recordProofTrace: true,
    proofSampleRate: rate,
  });
  try {
    await waitReady(browser);
    await assertLegacyProgramState(browser, 'sixty-fps-cold');
    const provenance = await proofProvenance(browser);
    const { playEdge, trace } = await driveFreshLegacyClick(browser);
    await writeFile(
      join(shotDir, `sixty-fps-cold-${rate}.json`),
      JSON.stringify({
        provenance,
        playEdge,
        trace,
        expectedIndex: oracle.expectedIndex,
      })
    );
    assert.ok(
      !trace.audioOverflow && !trace.eventsOverflow,
      '60 fps proof trace overflow'
    );
    const scheduledEvents = trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>);
    const backend = scheduledEvents
      .filter((value) => value['event'] === 'backend')
      .at(-1);
    assert.ok(backend, '60 fps run selected no audio backend');
    const frameBytes = 64 * 36 * 4;
    // ffmpeg's fps=60 shows every fr30 picture twice, so decoded frames 2k and 2k+1 are the same
    // picture and no frame can be closer to one than to the other. The premise is checked on the
    // decoded references, and frames are then matched against the distinct pictures.
    assert.ok(
      oracle.references.length % 2 === 0 &&
        oracle.references.every(
          (reference, index) =>
            index % 2 === 0 ||
            Buffer.compare(reference, oracle.references[index - 1]!) === 0
        ),
      '60 fps references are not doubled fr30 pictures; the picture oracle does not apply'
    );
    const pictures = oracle.references.filter((_, index) => index % 2 === 0);
    const expectedPicture = Math.floor(oracle.expectedIndex / 2);
    const usable = trace.visual.filter(
      (sample) =>
        !sample.error &&
        sample.pixels16 !== undefined &&
        sample.pixels16.length === frameBytes
    );
    const presentedExpectedFrame = (): boolean =>
      usable.some((sample) =>
        matchesExpectedVideoFrame(
          Uint8Array.from(sample.pixels16!),
          pictures,
          expectedPicture
        )
      );
    if (backend['backend'] === 'native') {
      assert.equal(
        backend['reason'],
        'video timing cannot be certified',
        '60 fps native playback was not the video timing refusal'
      );
      const refusal = scheduledEvents.find(
        (value) => value['event'] === 'video-timing-uncertified'
      );
      assert.ok(refusal, '60 fps timing refusal carries no evidence');
      const packetStarts = await layerPacketStarts(
        join(scratch, 'sixty-fps-boundaries.otiod', 'media', 'fr60.webm')
      );
      let shortestFrame = Number.POSITIVE_INFINITY;
      for (let i = 1; i < packetStarts.length; i++)
        shortestFrame = Math.min(
          shortestFrame,
          packetStarts[i]! - packetStarts[i - 1]!
        );
      const minWindow = refusal['minWindowSeconds'];
      const vsync = refusal['vsyncSeconds'];
      assert.ok(
        refusal['timingKind'] === 'windows' &&
          refusal['videoRate'] === 1 &&
          typeof minWindow === 'number' &&
          Math.abs(minWindow - shortestFrame) < 1e-6,
        `60 fps refusal's shortest frame ${String(minWindow)} s is not ffprobe's ${shortestFrame} s`
      );
      assert.ok(
        typeof vsync === 'number' && vsync > 0 && minWindow < vsync,
        `60 fps refusal's shortest frame ${minWindow} s is not under its refresh interval ${String(vsync)} s`
      );
      assert.ok(
        !scheduledEvents.some(
          (value) => value['event'] === 'error' || value['event'] === 'epoch'
        ),
        '60 fps native playback raised a scheduled error or committed an epoch'
      );
      assert.ok(
        !legacyColdValues(trace).some(
          (value) =>
            value['event'] === 'ring-refused' ||
            value['event'] === 'epoch-unplaceable'
        ),
        '60 fps native playback recorded a ring refusal'
      );
      assert.ok(
        trace.events.some(
          (entry) => entry.kind === 'play' && entry.mediaType === 'AUDIO'
        ),
        '60 fps native playback did not play an audio element'
      );
      const output = trace.audio.flatMap((chunk) => chunk.channels[0] ?? []);
      assert.ok(
        output.length > 0 && output.some((value) => Math.abs(value) > 0.001),
        '60 fps native playback output was silent'
      );
      // The paused view shows the authored picture. After the click the pictures only move
      // forward, start inside the 350 ms budget, and are never ahead of the timeline (one fr30
      // picture per 1/30 s plus one of rounding). Unclassified frames are skipped, not assumed.
      // The top clip, upper-video-a, spans the first second of the composition (30 frames at
      // 30 fps in the fixture) and a later clip reuses the same media from an earlier picture,
      // so only the first second after the click is judged. Wall time never leads composition time.
      const TOP_CLIP_MS = 1000;
      const classified = usable.flatMap((sample) => {
        const picture = classifyVideoFrame(
          Uint8Array.from(sample.pixels16!),
          pictures
        );
        return picture === null
          ? []
          : [{ elapsedMs: sample.timestamp - playEdge.timestamp, picture }];
      });
      assert.equal(
        classified.filter((entry) => entry.elapsedMs <= 0).at(-1)?.picture,
        expectedPicture,
        `60 fps paused view did not show the expected authored frame ${oracle.expectedIndex}`
      );
      const played = classified.filter(
        (entry) => entry.elapsedMs > 0 && entry.elapsedMs <= TOP_CLIP_MS
      );
      for (let i = 0; i < played.length; i++) {
        const entry = played[i]!;
        assert.ok(
          entry.picture >= (played[i - 1]?.picture ?? expectedPicture),
          `60 fps native presentation moved backwards to picture ${entry.picture} at ${entry.elapsedMs} ms`
        );
        assert.ok(
          entry.picture - expectedPicture <=
            Math.floor((entry.elapsedMs * 30) / 1000) + 1,
          `60 fps native presentation showed picture ${entry.picture} ahead of the timeline at ${entry.elapsedMs} ms`
        );
      }
      const firstMoved = played.find(
        (entry) => entry.picture > expectedPicture
      );
      assert.ok(
        firstMoved && firstMoved.elapsedMs <= 350,
        `60 fps native presentation first moved at ${String(firstMoved?.elapsedMs)} ms, past the 350 ms start budget`
      );
      const distinctPlayed = new Set(played.map((entry) => entry.picture));
      assert.ok(
        distinctPlayed.size >= 10,
        `60 fps native presentation showed only ${distinctPlayed.size} source pictures`
      );
      console.log(
        `OTIO_SIXTY_FPS backend=native reason="video timing cannot be certified" shortestFrameSeconds=${minWindow} refreshSeconds=${vsync} scheduled=unproven`
      );
      pass('legacy-sixty-fps-cold-start');
      return;
    }
    const solvers = assertLegacyRingEvidence(trace, true);
    const epoch = trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>)
      .find((value) => value['event'] === 'epoch');
    assert.ok(
      epoch,
      '60 fps cold start never committed an epoch; output unproven'
    );
    const f0 = Number(epoch['f0']);
    assert.ok(
      Number.isSafeInteger(f0),
      '60 fps epoch lacks its committed frame'
    );
    assertIndependentCarrier(trace, f0, f0 + rate);
    assert.ok(
      compareAuthoredPcm(
        collectAuthoredPcm(trace, f0, AUTHORED_PCM_FRAMES),
        oracle.audio,
        AUTHORED_PCM_FRAMES
      ),
      '60 fps output differs from the independent mx_bed reference at the committed start'
    );
    const firstOut = firstNonzeroFrame(trace, f0);
    assert.ok(
      firstOut,
      '60 fps cold start produced no nonzero source-correct output'
    );
    assert.equal(
      firstOut.frame,
      f0 + firstReferenceNonzero(oracle.audio),
      '60 fps first nonzero output is not the committed start plus the reference first nonzero sample'
    );
    const mapped = mapFrameToWall(nativeOutputObservations(trace), f0, rate);
    assert.ok(
      mapped,
      '60 fps no native output timestamp precedes the first source frame'
    );
    const phase = solvers.at(-1);
    if (!phase) throw new Error('60 fps cold start has no phase solve');
    assert.ok(
      mapped.wallMs + mapped.boundMs >= phase.phaseLowerMs &&
        mapped.wallMs - mapped.boundMs <= phase.phaseUpperMs,
      `60 fps audible wall ${mapped.wallMs}ms (±${mapped.boundMs}ms) lies outside the phase interval [${phase.phaseLowerMs}, ${phase.phaseUpperMs}]ms`
    );
    assert.ok(
      presentedExpectedFrame(),
      `60 fps presentation never showed the expected authored frame ${oracle.expectedIndex}`
    );
    console.log('OTIO_SIXTY_FPS backend=pcm');
    pass('legacy-sixty-fps-cold-start');
  } finally {
    await browser.close();
  }
}

// Restart during a held cold start: a trusted play whose PCM response is held (the hold is
// asserted, so the run exists), a trusted pause that must cancel that run ('pause' cancel
// carrying its generation), the held responses released, then a trusted restart. Proven:
// the cancel happened, the restarted run commits an epoch of a newer generation, its output
// at that epoch matches the independent source from composition time 0 (the paused frame
// must read 0), and its first audible frame is the reference's first nonzero sample.
// NOT proven: that output from the cancelled generation was excluded. Audio chunks carry no
// generation, and a restart that commits the same f0 yields identical samples, so no
// comparison here can separate stale from fresh output. Stale exclusion needs the run
// generation in every PCM batch's marker lane (a viewer change), and is not claimed.
async function runRestartDuringStart(
  sessionToken: string,
  rate: 48000
): Promise<void> {
  const url = await publishColdBoundaryDocument();
  const videoOracle = await buildColdVideoOracle(rate);
  const browser = await openBrowser(url, sessionToken, {
    label: `restart-during-start-${rate}`,
    defaultAutoplay: true,
    recordProofTrace: true,
    proofSampleRate: rate,
  });
  try {
    await waitReady(browser);
    await assertLegacyProgramState(browser, 'restart-during-start');
    const provenance = await proofProvenance(browser);
    const button = await browser.evaluate<{ x: number; y: number }>(`(() => {
      const control = document.querySelector('button.otio-play');
      if (!(control instanceof HTMLButtonElement)) throw new Error('restart play control missing');
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const start = await browser.evaluate<{ contextState: string }>(
      `(async () => globalThis.__otioProofTrace.start())()`
    );
    assert.equal(
      start.contextState,
      'suspended',
      'restart proof context was not fresh and suspended before the first click'
    );
    await browser.evaluate<void>(
      `globalThis.__otioProofTrace.holdPcmResponses(true)`
    );
    const firstPlay = await browser.evaluate<{ timestamp: number }>(
      `(() => globalThis.__otioProofTrace.playRequest())()`
    );
    await clickWithRealPointer(browser, button.x, button.y);
    const held = await browser.evaluate<number>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const deadline = performance.now() + 3000;
      while (!globalThis.__otioProofTrace.heldPcmCount() && performance.now() < deadline) await sleep(10);
      return globalThis.__otioProofTrace.heldPcmCount();
    })()`);
    assert.ok(held > 0, 'first start held no PCM response to supersede');
    const beforePause = await browser.evaluate<{
      playing: string | null;
    }>(
      `(() => ({playing: document.querySelector('.otio-view')?.dataset.playing ?? null}))()`
    );
    assert.equal(
      beforePause.playing,
      'true',
      `held start is not in a playing state before the pause (${beforePause.playing})`
    );
    await clickWithRealPointer(browser, button.x, button.y);
    const cancelled = await browser.evaluate<boolean>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const deadline = performance.now() + 3000;
      while (!globalThis.__otioProofTrace.hasPcmCancel('pause') && performance.now() < deadline) await sleep(10);
      return globalThis.__otioProofTrace.hasPcmCancel('pause');
    })()`);
    assert.ok(cancelled, 'pause did not cancel the held start');
    const released = await browser.evaluate<number>(
      `globalThis.__otioProofTrace.holdPcmResponses(false)`
    );
    const paused = await browser.evaluate<{
      frame: string | null;
    }>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      await sleep(300);
      return {frame: document.querySelector('.otio-view')?.dataset.frame ?? null};
    })()`);
    assert.equal(
      Number(paused.frame),
      0,
      `restart proof: the paused frame was ${paused.frame}, not 0; the restart is not from the start`
    );
    const secondPlay = await browser.evaluate<{ timestamp: number }>(
      `(() => globalThis.__otioProofTrace.playRequest())()`
    );
    await clickWithRealPointer(browser, button.x, button.y);
    const outcome = await browser.evaluate<{
      trace: MovingTrace['trace'];
      playing: string;
    }>(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      await sleep(2500);
      const playing = document.querySelector('.otio-view')?.dataset.playing ?? '';
      const trace = await globalThis.__otioProofTrace.stop();
      if (playing === 'true') document.querySelector('button.otio-play').click();
      return { trace, playing };
    })()`);
    await writeFile(
      join(shotDir, `restart-during-start-${rate}.json`),
      JSON.stringify({
        provenance,
        firstPlay,
        secondPlay,
        held,
        released,
        outcome,
      })
    );
    const trace = outcome.trace;
    assert.ok(
      !trace.audioOverflow && !trace.eventsOverflow,
      'restart proof trace overflow'
    );
    const scheduled = trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>);
    const cancel = scheduled.find(
      (value) => value['event'] === 'cancel' && value['reason'] === 'pause'
    );
    assert.ok(cancel, 'restart proof has no pause cancel record');
    const restarted = scheduled.filter(
      (value) =>
        value['event'] === 'epoch' &&
        Number(value['wallMs']) >= secondPlay.timestamp
    );
    assert.ok(
      restarted.length > 0,
      'restarted run committed no epoch after the restart'
    );
    assert.notEqual(
      restarted[0]!['generation'],
      cancel['generation'],
      'restarted epoch belongs to the cancelled generation'
    );
    const f0 = Number(restarted[0]!['f0']);
    assert.ok(Number.isSafeInteger(f0), 'restarted epoch lacks its frame');
    assertIndependentCarrier(trace, f0, f0 + rate);
    assert.ok(
      compareAuthoredPcm(
        collectAuthoredPcm(trace, f0, AUTHORED_PCM_FRAMES),
        videoOracle.audio,
        AUTHORED_PCM_FRAMES
      ),
      'restarted output differs from the independent source at its committed start'
    );
    const firstOut = firstNonzeroFrame(trace, f0);
    assert.ok(
      firstOut,
      'restarted run produced no nonzero source-correct output'
    );
    assert.equal(
      firstOut.frame,
      f0 + firstReferenceNonzero(videoOracle.audio),
      'restarted first audible frame is not the committed start plus the reference first nonzero sample'
    );
    pass('scheduled-pcm-restart-during-start');
  } finally {
    await browser.close();
  }
}

// Forced three-slot control. The proof-only viewer build (RELIC_VIEWER_DIST, produced by
// proof-viewer-three-slot.ts) pins the retained requirement to the old fixed ring. On the
// measured high-latency cold boundary the viewer must refuse explicitly with
// ring-slots-insufficient, every solve must report three slots, and no epoch may commit.
async function runThreeSlotControl(sessionToken: string): Promise<void> {
  const url = await publishColdBoundaryDocument();
  const browser = await openBrowser(url, sessionToken, {
    label: 'three-slot-forced-48000',
    defaultAutoplay: true,
    recordProofTrace: true,
    proofSampleRate: 48000,
  });
  try {
    await waitReady(browser);
    await assertLegacyProgramState(browser, 'three-slot');
    const provenance = await proofProvenance(browser);
    const { trace } = await driveFreshLegacyClick(browser);
    await writeFile(
      join(shotDir, 'three-slot-forced-48000.json'),
      JSON.stringify({ provenance, trace })
    );
    assert.ok(
      !trace.audioOverflow && !trace.eventsOverflow,
      'three-slot proof trace overflow'
    );
    const values = legacyColdValues(trace);
    const refusals = values.filter(
      (value) => value['event'] === 'ring-refused'
    );
    assert.ok(
      refusals.length > 0 &&
        refusals.every((value) => value['code'] === 'ring-slots-insufficient'),
      `forced three-slot ring was not refused only as insufficient: ${JSON.stringify(refusals)}`
    );
    // The forced control's only acceptable outcome is the band refusal. A clock or input
    // failure, or any other unplaced epoch, is a different failure and fails the control.
    const unplacedEpochs = values.filter(
      (value) => value['event'] === 'epoch-unplaceable'
    );
    assert.equal(
      unplacedEpochs.length,
      0,
      `forced three-slot control failed for a non-band reason: ${JSON.stringify(unplacedEpochs[0])}`
    );
    const solvers = values.filter(
      (value) => value['event'] === 'solver'
    ) as unknown as LegacyRingSolver[];
    assert.ok(solvers.length > 0, 'forced three-slot run recorded no solve');
    for (const solver of solvers) {
      assert.ok(
        Array.isArray(solver.samples) && solver.samples.length > 0,
        'forced three-slot solve carries no samples'
      );
      for (const sample of solver.samples)
        assert.equal(
          sample.residentSlots,
          3,
          'forced run did not hold three resident slots in every sample'
        );
    }
    assert.equal(
      trace.events.filter(
        (entry) =>
          entry.kind === 'scheduled-pcm' &&
          (entry.value as Record<string, unknown> | undefined)?.['event'] ===
            'epoch'
      ).length,
      0,
      'forced three-slot run committed a causal epoch after refusing'
    );
    pass('legacy-three-slot-forced-refusal');
  } finally {
    await browser.close();
  }
}

// Fresh suspended context: a real trusted click is the first gesture. Audible output
// is the first nonzero carrier-identified sample mapped through native output
// timestamps; visual presentation is the first changed canvas pixel and the first
// screencast frame that matches the expected authored video frame.
async function runColdStartProof(
  url: string,
  sessionToken: string,
  rate: 44100 | 48000
): Promise<void> {
  assertColdMeasurementControls();
  assertScreencastComparatorControls();
  assertSourceMatchControls();
  assertFrameSelectionControls();
  assertOverlayMaskControls();
  assertPhaseBandControls();
  assertAuthoredPcmControls();
  const videoOracle = await buildColdVideoOracle(
    rate,
    30,
    join(decoderMediaDir, 'fr30.webm'),
    join(coldBoundaryDirectory(rate), 'media', 'mx_bed.wav')
  );
  await assertScreencastDecodeControls(videoOracle.references);
  assert.ok(
    referenceIsAudible(videoOracle.audio, AUTHORED_PCM_FRAMES),
    'independent mx_bed reference is silent; audible output unproven'
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: 350,
      visualMs: 350,
      promotions: 2,
      suspendsAfterPlay: 0,
    }),
    true
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: 351,
      visualMs: 350,
      promotions: 2,
      suspendsAfterPlay: 0,
    }),
    false
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: 350,
      visualMs: 351,
      promotions: 2,
      suspendsAfterPlay: 0,
    }),
    false
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: 350,
      visualMs: 350,
      promotions: 1,
      suspendsAfterPlay: 0,
    }),
    false
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: 350,
      visualMs: 350,
      promotions: 2,
      suspendsAfterPlay: 1,
    }),
    false
  );
  assert.equal(
    coldStartVerdict({
      audibleMs: Number.NaN,
      visualMs: 350,
      promotions: 2,
      suspendsAfterPlay: 0,
    }),
    false
  );

  const isolated = await openBrowser(url, sessionToken, {
    label: `cold-start-${rate}`,
    defaultAutoplay: true,
    recordProofTrace: true,
    proofSampleRate: rate,
  });
  try {
    await waitReady(isolated);
    await assertLegacyProgramState(isolated, 'cold-start');
    const provenance = await proofProvenance(isolated);
    const canvasGeometry = await isolated.evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
      timeOrigin: number;
    }>(`(() => {
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('cold start canvas missing');
      const r = canvas.getBoundingClientRect();
      // The viewer draws the frame contained in the element box (object-fit contain), so the
      // crop is the drawn frame, not the letterboxed element. Same formula as the other stage.
      const width = Math.min(r.width, r.height * canvas.width / canvas.height);
      const height = Math.min(r.height, r.width * canvas.height / canvas.width);
      return { x: r.left + (r.width - width) / 2, y: r.top + (r.height - height) / 2, width, height, scale: devicePixelRatio, timeOrigin: performance.timeOrigin };
    })()`);
    const stopCast = await isolated.startScreencast();
    const button = await isolated.evaluate<{ x: number; y: number }>(`(() => {
      const control = document.querySelector('button.otio-play');
      if (!(control instanceof HTMLButtonElement)) throw new Error('cold start play control missing');
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const start = await isolated.evaluate<{
      contextState: string;
      sampleRate: number;
    }>(`(async () => globalThis.__otioProofTrace.start())()`);
    assert.equal(
      start.contextState,
      'suspended',
      'cold-start context was not fresh and suspended before the click'
    );
    assert.equal(
      start.sampleRate,
      rate,
      'cold-start context rate differs from the fixture rate'
    );
    await awaitPreplayVisualBaseline(isolated);
    const playEdge = await isolated.evaluate<{ timestamp: number }>(
      `(() => globalThis.__otioProofTrace.playRequest())()`
    );
    await clickWithRealPointer(isolated, button.x, button.y);
    await new Promise<void>((resolve) => setTimeout(resolve, 2500));
    const outcome = await isolated.evaluate<{
      trace: MovingTrace['trace'];
      playing: string;
    }>(`(async () => {
      const root = document.querySelector('.otio-view'), control = document.querySelector('button.otio-play');
      const playing = root?.dataset.playing ?? '';
      const trace = await globalThis.__otioProofTrace.stop();
      if (root?.dataset.playing === 'true' && control instanceof HTMLButtonElement) control.click();
      return { trace, playing };
    })()`);
    await writeFile(
      join(shotDir, `scheduled-pcm-cold-start-${rate}.json`),
      JSON.stringify({
        provenance,
        start,
        playEdge,
        outcome,
        clockAudit: auditClockEvidence(outcome.trace),
        fixtureHash: videoOracle.audioSha256,
      })
    );
    const playMs = playEdge.timestamp;
    const trace = outcome.trace;
    assertCarrierIdentity(trace, 'cold start epoch');
    // Continuity, asserted before the promotion count. A fault or an underflow cancel inside
    // the window is the reason a later native promotion never happens, so it is named here.
    // Nothing is excused: a faulted or stopped run fails with its own record.
    // Bank records (schedule-cancel, schedule-set, worklet-message incl. proof-promotion-tags)
    // are kept in their own array. An overflow here would drop a promotion record, so it fails.
    assert.ok(
      !trace.bankOverflow,
      'bank marker records overflowed; a promotion record may be missing'
    );
    const frontierStarvation = coldFrontierStarvation(trace.events, playMs);
    if (frontierStarvation !== null)
      throw new ColdFrontierStarvation(frontierStarvation, trace);
    const continuityFaults = describeContinuityFaults(trace.events, playMs);
    assert.equal(
      continuityFaults.length,
      0,
      `cold playback faulted inside the capture window: ${continuityFaults.join(' | ')}`
    );
    assertClockAudit(auditClockEvidence(trace), 'cold start');
    assert.equal(
      outcome.playing,
      'true',
      'cold playback was not running at the end of the capture window'
    );
    // The legacy cold boundary's retained ring, measured from the viewer's own records.
    const ringSolvers = assertLegacyRingEvidence(trace, true);
    const events = trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>);
    const firstEpoch = events.find((event) => event['event'] === 'epoch');
    assert.ok(
      firstEpoch,
      'cold start never committed an epoch; output unproven'
    );
    const f0 = Number(firstEpoch['f0']);
    assert.ok(
      Number.isSafeInteger(f0),
      'cold start epoch lacks its committed frame'
    );
    reportEngineFrameClock(trace, 'cold start epoch');
    associateBootstrapClock(trace, f0);
    assertIndependentCarrier(trace, f0, f0 + rate);
    assert.ok(
      compareAuthoredPcm(
        collectAuthoredPcm(trace, f0, AUTHORED_PCM_FRAMES),
        videoOracle.audio,
        AUTHORED_PCM_FRAMES
      ),
      'cold output differs from the independently decoded mx_bed reference at the committed start'
    );
    const firstOut = firstNonzeroFrame(trace, f0);
    assert.ok(
      firstOut,
      'cold start produced no nonzero source-correct output; audible unproven'
    );
    assert.equal(
      firstOut.frame,
      f0 + firstReferenceNonzero(videoOracle.audio),
      `first nonzero output at frame ${firstOut.frame} is not the committed start ${f0} plus the reference's first nonzero sample`
    );
    const observations = trace.events
      .filter((entry) => entry.kind === 'audio-output-timestamp-observed')
      .map((entry) => entry.value as Record<string, unknown>)
      .filter(
        (value) =>
          value['injected'] === false &&
          value['output'] !== null &&
          typeof value['output'] === 'object'
      )
      .map((value) => {
        const output = value['output'] as {
          contextTime: number;
          performanceTime: number;
        };
        return {
          before: Number(value['before']),
          after: Number(value['after']),
          contextTime: output.contextTime,
          performanceTime: output.performanceTime,
        };
      })
      .filter(
        (obs) =>
          Number.isFinite(obs.contextTime) &&
          Number.isFinite(obs.performanceTime) &&
          obs.contextTime > 0
      );
    const mapped = mapFrameToWall(observations, f0, rate);
    assert.ok(
      mapped,
      'no native output timestamp precedes the first source frame; audible unproven'
    );
    const audibleMs = mapped.wallMs - playMs;
    // Causal check: the measured output wall time (absolute performance.now() ms, the
    // viewer's origin) must overlap the phase interval solved from the resident slots.
    // Bounds are absolute: do not subtract the play request from them.
    const phase = ringSolvers.at(-1);
    if (!phase) throw new Error('legacy cold start has no phase solve');
    assert.ok(
      mapped.wallMs + mapped.boundMs >= phase.phaseLowerMs &&
        mapped.wallMs - mapped.boundMs <= phase.phaseUpperMs,
      `measured output wall ${mapped.wallMs}ms (±${mapped.boundMs}ms) lies outside the resident phase interval [${phase.phaseLowerMs}, ${phase.phaseUpperMs}]ms`
    );
    const audibleUpperMs = audibleMs + mapped.boundMs;
    const canvas = trace.visual.filter(
      (sample) => sample.pixels16 && !sample.error
    );
    const baseline = [...canvas]
      .reverse()
      .find((sample) => sample.timestamp < playMs);
    if (!baseline || !baseline.pixels16)
      throw new Error('no pre-play rendered pixel baseline; visual unproven');
    const basePixels = baseline.pixels16;
    const changed = canvas.find(
      (sample) =>
        sample.timestamp >= playMs &&
        sample.pixels16 !== undefined &&
        sample.pixels16.some((value, i) => value !== basePixels[i])
    );
    assert.ok(changed, 'no rendered pixel change after play; visual unproven');
    const canvasVisualMs = changed.timestamp - playMs;
    // Source-correct presentation movement. The paused view must already show a classified
    // source frame (the pre-play class): without one nothing is attributable, and the proof
    // fails as visual unproven. Presentation is the first post-play frame that classifies as a
    // later source frame, within the timeline bound (selectPresentedFrame). Its time is the
    // conservative upper bound. The lower bound is the frame before it, which must differ from
    // it in both pixels and class, so the lower bound is always a real frame time.
    const cast = await stopCast();
    const screen = await decodeScreencastFrames(cast, canvasGeometry);
    const screenTime = (sample: { timestamp: number }) =>
      sample.timestamp - canvasGeometry.timeOrigin;
    // The viewer draws its scope label (.otio-preview-scope) over the frame, inside the crop.
    // Real screenshot evidence (screencast-first) shows the label; masking its cells keeps every
    // other cell of the frame in the comparison, and the threshold is unchanged.
    const overlays = await isolated.evaluate<
      Array<{ x: number; y: number; width: number; height: number }>
    >(`(() => Array.from(document.querySelectorAll('.otio-preview-scope'))
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => { const q = element.getBoundingClientRect(); return {x: q.left, y: q.top, width: q.width, height: q.height}; }))()`);
    const screenMask = overlayCellMask(canvasGeometry, overlays);
    const classOf = (pixels: Uint8Array) =>
      classifyVideoFrame(pixels, videoOracle.references, screenMask);
    const screenBefore = screen.filter((sample) => screenTime(sample) < playMs);
    const lastBefore = screenBefore[screenBefore.length - 1];
    const preplayClass = lastBefore ? classOf(lastBefore.pixels) : null;
    if (preplayClass === null)
      throw new Error(
        `no classified pre-play screencast frame; visual unproven (pre-play frames ${screenBefore.length})`
      );
    const screenAfter = screen.filter((sample) => screenTime(sample) >= playMs);
    const selectionInput = screenAfter.map((sample) => ({
      elapsedMs: screenTime(sample) - playMs,
      cls: classOf(sample.pixels),
    }));
    const presentedIndex = selectPresentedFrame(
      preplayClass,
      selectionInput,
      videoOracle.expectedIndex
    );
    if (presentedIndex < 0) {
      // Real screenshot evidence for the crop: the geometry used, and the first screencast
      // JPEG exactly as Chrome delivered it, so the crop can be checked against the image.
      await writeFile(
        join(shotDir, `screencast-geometry-${rate}.json`),
        JSON.stringify(canvasGeometry, null, 1)
      );
      const firstFrame = cast.frames[0];
      if (firstFrame && typeof firstFrame['data'] === 'string')
        await writeFile(
          join(shotDir, `screencast-first-${rate}.jpg`),
          Buffer.from(firstFrame['data'] as string, 'base64')
        );
      // Diagnostic receipt, written before the failure: every post-play screencast frame's
      // best and runner-up independent references under the same mask, so the next run shows
      // what the selector saw.
      const detail = screenAfter.map((sample, i) => {
        const ranked = videoOracle.references
          .map((reference, index) => ({
            index,
            error: maskedRmse(sample.pixels, reference, screenMask),
          }))
          .sort((a, b) => a.error - b.error);
        return {
          elapsedMs: selectionInput[i]!.elapsedMs,
          best: ranked[0]?.index ?? null,
          bestError: ranked[0]?.error ?? null,
          nextError: ranked[1]?.error ?? null,
          cls: selectionInput[i]!.cls,
        };
      });
      await writeFile(
        join(shotDir, `screencast-classification-${rate}.json`),
        JSON.stringify(
          {
            expectedIndex: videoOracle.expectedIndex,
            preplayClass,
            screenBeforeCount: screenBefore.length,
            screenAfterCount: screenAfter.length,
            frames: detail,
          },
          null,
          1
        )
      );
      const classified = selectionInput.filter(
        (frame) => frame.cls !== null
      ).length;
      throw new Error(
        `no post-play screencast frame presented a later source-correct video frame; visual unproven (screencast after play ${screenAfter.length}, classified ${classified}, pre-play class ${preplayClass}; see screencast-classification-${rate}.json)`
      );
    }
    const screenChanged = screenAfter[presentedIndex];
    if (!screenChanged) throw new Error('screencast selection index invalid');
    // The frame before the presented one: the last pre-play frame when the presented frame is
    // the first after play. Its time is the lower bound, and it must be a distinct frame.
    const priorFrame =
      presentedIndex > 0 ? screenAfter[presentedIndex - 1] : lastBefore;
    if (!priorFrame)
      throw new Error(
        'no frame before the presented screencast frame; visual unproven'
      );
    const presentedClass = selectionInput[presentedIndex]!.cls;
    const priorClass =
      presentedIndex > 0
        ? selectionInput[presentedIndex - 1]!.cls
        : preplayClass;
    assert.notEqual(
      priorClass,
      presentedClass,
      'screencast presentation kept the source class of the frame before it'
    );
    assert.ok(
      priorFrame.pixels.some((value, i) => value !== screenChanged.pixels[i]),
      'screencast presentation is pixel-identical to the frame before it'
    );
    const screenVisualLowerMs = screenTime(priorFrame) - playMs;
    const visualMs = screenTime(screenChanged) - playMs;
    assert.ok(
      canvasVisualMs <= 350,
      `canvas readback changed at ${canvasVisualMs} ms (budget 350)`
    );
    assert.ok(
      Number.isFinite(screenVisualLowerMs) && screenVisualLowerMs < visualMs,
      'screencast change did not follow a distinct prior frame'
    );
    const promotions = trace.events.filter(
      (entry) =>
        entry.kind === 'transport-message' &&
        (entry.value as Record<string, unknown>)['type'] === 'clock-promoted'
    ).length;
    const suspendsAfterPlay = trace.events.filter(
      (entry) =>
        entry.kind === 'audio-suspend-request' && entry.timestamp >= playMs
    ).length;
    assert.ok(
      audibleUpperMs <= 350,
      `cold audible bound ${audibleUpperMs} ms exceeds 350 (estimate ${audibleMs} ms, bound ${mapped.boundMs} ms)`
    );
    assert.ok(
      visualMs <= 350,
      `cold visual presentation took ${visualMs} ms (budget 350)`
    );
    assert.ok(
      promotions >= 2,
      `cold start produced ${promotions} promotions (need 2)`
    );
    assert.equal(
      suspendsAfterPlay,
      0,
      'cold start suspended the context after the play request'
    );
    assert.ok(
      coldStartVerdict({
        audibleMs: audibleUpperMs,
        visualMs,
        promotions,
        suspendsAfterPlay,
      }),
      'cold-start verdict failed'
    );
    pass('scheduled-pcm-cold-start');
  } finally {
    await isolated.close();
  }
}

async function runScheduledPcmProof(
  sessionToken: string,
  rate: 44100 | 48000 = 48000
): Promise<void> {
  assertNoLeaseClockControls();
  const originalDirectory = fileURLToPath(
    new URL(
      '../../relic-format/test/fixtures/otio/scheduled-audio.otiod/',
      import.meta.url
    )
  );
  const directory =
    rate === 48000
      ? originalDirectory
      : join(scratch, 'scheduled-audio-44100.otiod');
  if (rate === 44100) {
    await cp(originalDirectory, directory, { recursive: true });
    const converted = await runChild(
      [
        'ffmpeg',
        '-v',
        'error',
        '-y',
        '-i',
        join(originalDirectory, 'media', 'indexed-stereo.wav'),
        '-ar',
        '44100',
        '-acodec',
        'pcm_s16le',
        join(directory, 'media', 'indexed-stereo.wav'),
      ],
      { timeoutMs: 30000 }
    );
    assert.equal(converted.exit, 0, converted.stderr);
  }
  const oracle = JSON.parse(
    await readFile(join(directory, 'media', 'sample-oracle.json'), 'utf8')
  ) as {
    sample_rate: number;
    channels: number;
    frames: number;
    pcm_sha256: string;
  };
  assert.equal(oracle.sample_rate, 48000);
  assert.equal(oracle.channels, 2);
  // Derive the expectation from published media kinds, never from the trace.
  const audioOnly = isAudioOnlyDocument(
    JSON.parse(await readFile(join(directory, 'content.otio'), 'utf8'))
  );
  const decoded = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      join(directory, 'media', 'indexed-stereo.wav'),
      '-f',
      's16le',
      'pipe:1',
    ],
    { timeoutMs: 30000 }
  );
  assert.equal(decoded.exit, 0, decoded.stderr);
  assert.equal(
    decoded.stdout.length % 4,
    0,
    'scheduled fixture PCM is not stereo PCM16'
  );
  const decodedHash = createHash('sha256').update(decoded.stdout).digest('hex');
  if (rate === 48000) {
    assert.equal(decoded.stdout.length, oracle.frames * 4);
    assert.equal(
      decodedHash,
      oracle.pcm_sha256,
      'scheduled fixture PCM hash mismatch'
    );
  } else {
    oracle.sample_rate = rate;
    oracle.frames = decoded.stdout.length / 4;
    oracle.pcm_sha256 = decodedHash;
  }
  const formula = (channel: number, frame: number): number =>
    (((frame * (channel === 0 ? 109 : 257) + (channel === 0 ? 12345 : 5345)) %
      16001) -
      8000) /
    32768;
  const source = (channel: number, frame: number): number =>
    decoded.stdout.readInt16LE(frame * 4 + channel * 2) / 32768;
  if (rate === 48000)
    for (let n = 0; n < oracle.frames; n++)
      for (let ch = 0; ch < 2; ch++)
        assert.equal(
          source(ch, n),
          formula(ch, n),
          `fixture formula disagrees at ${n}/${ch}`
        );
  const length = 3 * oracle.sample_rate;
  const expected: [Float32Array, Float32Array] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const unit = oracle.sample_rate / 30;
  const ramp = (t: number, from: number, to: number) =>
    Math.max(0, Math.min(1, (t - from) / (to - from)));
  for (let n = 0; n < length; n++) {
    const t = n / unit;
    const outer = ramp(t, 56, 62),
      a = ramp(t, 53, 58),
      b = ramp(t, 61, 66);
    for (let ch = 0; ch < 2; ch++) {
      let sum = 0;
      if (t < 58) sum += source(ch, 30 * unit + n) * (1 - a) * (1 - outer);
      if (t >= 53 && t < 62)
        sum += source(ch, 100 * unit + n - 56 * unit) * a * (1 - outer);
      if (t >= 56 && t < 66)
        sum += source(ch, 20 * unit + n - 60 * unit) * (1 - b) * outer;
      if (t >= 61) sum += source(ch, 50 * unit + n - 64 * unit) * b * outer;
      if (t < 30) sum += source(ch, 10 * unit + n);
      else if (t < 60) sum += source(ch, 60 * unit + n - 30 * unit);
      expected[ch]![n] = sum;
    }
  }
  const url = await publishLegacyDirectory(
    directory,
    `OTIO legacy scheduled-pcm ${rate}`
  );
  const coldUrl = await publishColdBoundaryDocument(rate);
  // Linux focus-only publish is asserted once, at the top of the composition stages.
  // A cold capture can lose its audio lead on a loaded runner: the frontier closes with no
  // extension in flight, and the recovery has no frame to continue on (CI run 43279024045,
  // 1347 ms after play). Only that exact signature (coldFrontierStarvation) is rerun, in a fresh
  // browser, at most three times, the same shape Jason approved on 2026-11-12 for the 44.1 kHz
  // frontier overshoot. He has not approved this signature; it is reported as a judgement call.
  // Every other failure is rethrown unchanged and each rerun keeps the refused trace.
  const COLD_FRONTIER_RERUNS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await runColdStartProof(coldUrl, sessionToken, rate);
      break;
    } catch (error) {
      if (!(error instanceof ColdFrontierStarvation)) throw error;
      await writeFile(
        join(
          shotDir,
          `scheduled-pcm-cold-start-${rate}-frontier-starvation-attempt${attempt}.json`
        ),
        JSON.stringify({
          attempt,
          evidence: error.evidence,
          trace: error.trace,
        })
      );
      if (attempt > COLD_FRONTIER_RERUNS)
        throw new Error(
          `cold start ${rate}: ${attempt}/${attempt} attempts ran out of audio lead (${error.evidence})`,
          { cause: error }
        );
      console.log(
        `OTIO_COLD_FRONTIER_STARVATION rate=${rate} attempt=${attempt} ${error.evidence}`
      );
    }
  }
  const browser = await openBrowser(url, sessionToken, {
    label: `scheduled-pcm-${rate}`,
    recordProofTrace: true,
    proofSampleRate: rate,
  });
  try {
    await waitReady(browser);
    await assertLegacyProgramState(browser, 'scheduled-pcm');
    const provenance = await proofProvenance(browser);
    // Chrome on a 10 ms sink renders 384 or 512 frames per callback. When the burst that closes
    // a starved run overshoots its frontier far enough, overshoot plus the guard passes the 20 ms
    // gap at the first recovery check and the viewer refuses truthfully. Jason approved, on
    // 2026-11-12, rerunning only that exact signature in a fresh browser, at most three times.
    // Every other failure is rethrown unchanged, and each rerun keeps the refused trace.
    const FRONTIER_OVERSHOOT_RERUNS = 3;
    // The frontier is the epoch start plus the PCM prepared when the pulls are withheld, and a
    // fresh browser tends to repeat both: one control refused four times out of four at frontier
    // 39424 in CI run 43179069879. A rerun at the same instant is not another attempt. Each rerun
    // withholds one PCM batch later (4096 frames, about 93 ms), which moves the frontier to
    // another place in the sink's burst pattern.
    const starveAfterMs = (attempt: number): number =>
      600 + 100 * (attempt - 1);
    const recoveryCapture: { trace: MovingTrace['trace'] | null } = {
      trace: null,
    };
    // Read through a call: the units assign the capture, which the compiler cannot see here.
    const refusedCapture = (): MovingTrace['trace'] | null =>
      recoveryCapture.trace;
    const rerunFrontierOvershoot = async (
      label: string,
      unit: (attempt: number) => Promise<void>
    ): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        recoveryCapture.trace = null;
        try {
          await unit(attempt);
          return;
        } catch (error) {
          const refused = refusedCapture();
          const evidence =
            refused === null
              ? null
              : recoveryFrontierOvershoot(refused.events, rate);
          if (evidence === null) throw error;
          await writeFile(
            join(shotDir, `${label}-frontier-overshoot-attempt${attempt}.json`),
            JSON.stringify({ label, attempt, evidence, trace: refused })
          );
          if (attempt > FRONTIER_OVERSHOOT_RERUNS)
            throw new Error(
              `${label}: ${attempt}/${attempt} attempts overshot the frontier (${evidence})`,
              { cause: error }
            );
          console.log(
            `OTIO_RECOVERY_FRONTIER_OVERSHOOT label=${label} attempt=${attempt} ${evidence}`
          );
        }
      }
    };
    let longEpoch: number | undefined;
    let warmAnchor: Record<string, unknown> | undefined;
    if (clockProofMode === 'long') {
      const warmup = await browser.evaluate<{
        identity: {
          clockEpoch: number;
          contextState: string;
          sampleFrame: number;
          sampleRate: number;
        };
        trace: MovingTrace['trace'];
      }>(`(async () => {
        const {promise, resolve} = Promise.withResolvers();
        const button = document.querySelector('button.otio-play');
        if (!(button instanceof HTMLButtonElement)) throw new Error('long proof play button missing');
        await globalThis.__otioProofTrace.start();
        globalThis.__otioProofTrace.playRequest();
        button.click();
        setTimeout(resolve, 700);
        await promise;
        const identity = globalThis.__otioProofTrace.clockIdentity();
        const trace = await globalThis.__otioProofTrace.stop();
        if (document.querySelector('.otio-view')?.dataset.playing === 'true') button.click();
        return {identity,trace};
      })()`);
      await writeClockShot(
        join(shotDir, 'scheduled-clock-long-bootstrap.json'),
        { provenance, capture: warmup },
        'scheduled-clock-long-bootstrap',
        warmup.trace
      );
      warmAnchor = assertAnchorEvidence(warmup.trace);
      const initial = warmup.identity;
      assert.equal(
        initial.contextState,
        'running',
        'long proof context is not running'
      );
      longEpoch = initial.clockEpoch;
      await seekTo(browser, 0);
      let current = initial;
      const target = 2 ** 24 - Math.floor(initial.sampleRate * 0.6);
      while (current.sampleFrame < target) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const remainingMs =
          ((target - current.sampleFrame) * 1000) / initial.sampleRate;
        setTimeout(resolve, Math.max(10, Math.min(2000, remainingMs / 2)));
        await promise;
        current = await browser.evaluate<typeof initial>(
          'globalThis.__otioProofTrace.clockIdentity()'
        );
        assert.equal(
          current.contextState,
          'running',
          'long proof context stopped'
        );
        assert.equal(
          current.clockEpoch,
          initial.clockEpoch,
          'long proof clock session changed'
        );
      }
      await writeClockShot(
        join(shotDir, 'scheduled-clock-long-checkpoint.json'),
        { provenance, initial, current },
        'scheduled-clock-long-checkpoint',
        null,
        'identity checkpoint only; the clock trace is in scheduled-clock-long-bootstrap'
      );
    }
    const capture = await browser.evaluate<
      MovingTrace & {
        staleStop: { pairsAtStop: number; msFromWindow: number } | null;
      }
    >(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('scheduled proof controls missing');
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      button.click();
      await sleep(${clockProofMode === 'long' ? 100 : 600});
      await globalThis.__otioProofTrace.awaitClockTraceReady(8000);
      globalThis.__otioProofTrace.clockTrace('start');
      const staleBegin = performance.now();
      const staleQuota = ${STALE_PAIR_QUOTA}, staleCap = ${STALE_PAIR_CAP};
      const decideStale = ${staleStopDecision.toString()};
      let staleStop = null;
      const tryStaleStop = async () => {
        if (staleStop) return;
        const pairs = globalThis.__otioProofTrace.stalePairCount();
        const decision = decideStale({pairs, quota: staleQuota, cap: staleCap,
          elapsedMs: performance.now() - staleBegin, deadlineMs: 800 + 3000});
        if (decision !== 'stop') return;
        staleStop = {pairsAtStop: pairs, msFromWindow: performance.now() - staleBegin};
        await globalThis.__otioProofTrace.stopStaleWindow();
      };
      while (performance.now() - staleBegin < 800) { await tryStaleStop(); await sleep(10); }
      globalThis.__otioProofTrace.clockTrace('stop');
      while (!staleStop) { await tryStaleStop(); if (!staleStop) await sleep(10); }
      await sleep(${clockProofMode === 'long' ? 2800 : 2300});
      const trace = await globalThis.__otioProofTrace.stop();
      if (root.dataset.playing === 'true') button.click();
      return {start, playEdge, trace, staleStop};
    })()`);
    const provenanceAfter = await proofProvenance(browser);
    await writeClockShot(
      join(shotDir, `scheduled-pcm-${rate}.json`),
      { provenance, provenanceAfter, capture, fixtureHash: oracle.pcm_sha256 },
      `scheduled-pcm-${rate}`,
      capture.trace
    );
    assert.equal(
      provenanceAfter['workingTreeSha256'],
      provenance['workingTreeSha256'],
      'proof source changed during capture'
    );
    assert.deepEqual(
      provenanceAfter['builtAssets'],
      provenance['builtAssets'],
      'viewer assets changed during capture'
    );
    assert.ok(
      !capture.trace.audioOverflow && !capture.trace.eventsOverflow,
      'scheduled proof trace overflow'
    );
    // The legacy fixture's phase intervals and resident slots are measured from the
    // viewer's cold-controller records; any explicit refusal fails the capture here.
    await runOverCapRefusal(sessionToken, rate);
    // Planner rule: a running context is never suspended after the play request.
    // A suspend here is the cold-start cause, so it fails the capture rather than
    // being excused as bootstrap.
    const playEdge = capture.playEdge;
    if (playEdge === undefined)
      throw new Error('scheduled capture lacks its play edge');
    const suspendsAfterPlay = capture.trace.events.filter(
      (entry) =>
        entry.kind === 'audio-suspend-request' &&
        entry.timestamp >= playEdge.timestamp
    );
    assert.equal(
      suspendsAfterPlay.length,
      0,
      `playback suspended the context after the play request (${suspendsAfterPlay.length} suspend requests)`
    );
    const pcmEvents = capture.trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>);
    const backend = pcmEvents
      .filter((event) => event['event'] === 'backend')
      .at(-1);
    assert.equal(
      backend?.['backend'],
      'pcm',
      'scheduled fixture did not select the PCM backend'
    );
    const epochs = pcmEvents.filter((event) => event['event'] === 'epoch');
    assert.equal(
      epochs.length,
      1,
      'scheduled proof requires one observed playback epoch'
    );
    const epoch = epochs[0]!;
    const f0 = Number(epoch['f0']),
      c0 = Number(epoch['c0']);
    if (clockProofMode === 'long') {
      const identity = await browser.evaluate<{
        clockEpoch: number;
        contextState: string;
        sampleFrame: number;
      }>('globalThis.__otioProofTrace.clockIdentity()');
      assert.ok(
        f0 < 2 ** 24 && f0 + length > 2 ** 24,
        'scheduled PCM did not cross the large-frame boundary'
      );
      assert.equal(
        identity.clockEpoch,
        longEpoch,
        'scheduled PCM used a different clock session'
      );
      assert.equal(
        identity.contextState,
        'running',
        'long proof context stopped during capture'
      );
    }
    const t0 = epoch['compositionT0'] as { value: number; rate: number };
    assert.equal(Number(epoch['contextSampleRate']), oracle.sample_rate);
    assert.equal(
      c0,
      f0 / oracle.sample_rate,
      'scheduled epoch does not own an integral context frame'
    );
    assert.equal(
      t0.value,
      0,
      'scheduled proof did not start at composition zero'
    );
    assert.ok(t0.rate > 0);
    const bridge = epoch['bridge'] as {
      contextTime: number;
      performanceTime: number;
      mappingAllowanceMs: number;
    };
    assert.ok(
      Number.isFinite(bridge?.contextTime) &&
        Number.isFinite(bridge?.performanceTime),
      'scheduled output clock bridge missing'
    );
    assert.ok(
      Number.isFinite(bridge.mappingAllowanceMs) &&
        bridge.mappingAllowanceMs >= 0,
      'scheduled epoch observed mapping allowance missing'
    );
    assert.equal(
      epoch['bridgeMappingAllowanceMs'],
      bridge.mappingAllowanceMs,
      'scheduled epoch mapping allowance disagrees with its bridge'
    );
    const outputStartMs =
      bridge.performanceTime + (c0 - bridge.contextTime) * 1000;
    assert.ok(
      capture.playEdge &&
        outputStartMs >= capture.playEdge.timestamp &&
        outputStartMs - capture.playEdge.timestamp <= 350,
      'scheduled audio epoch must be causal and within the initial budget'
    );
    const gateMessages = capture.trace.events
      .filter((entry) => entry.kind === 'transport-message')
      .map((entry) => entry.value as Record<string, unknown>)
      .filter(Boolean);
    const anchor =
      clockProofMode === 'long'
        ? warmAnchor
        : assertAnchorEvidence(capture.trace);
    assert.ok(anchor, 'initial native anchor evidence unavailable');
    const promotions = gateMessages.filter(
      (message) => message['type'] === 'clock-promoted'
    );
    assert.ok(
      promotions.length >= 2,
      'two native bank promotions not observed'
    );
    assert.ok(
      promotions.every(
        (message) =>
          message['clockEpoch'] === anchor['clockEpoch'] &&
          Number.isSafeInteger(message['boundary']) &&
          Number.isSafeInteger(message['clockCoverageEnd'])
      ),
      'invalid bank promotion provenance'
    );
    assertIndependentCarrier(capture.trace, f0, f0 + length);
    const gateAssociationOffset = assertGateClockEvidence(
      capture.trace,
      clockProofMode === 'long'
    );
    assertNaturalStaleWitness(
      capture.trace,
      f0,
      expected,
      gateAssociationOffset
    );
    assertStaleWitnessControls(
      capture.trace,
      f0,
      expected,
      gateAssociationOffset
    );
    const nativeWitness = capture.trace.witness;
    assert.ok(nativeWitness, 'native carrier metadata missing');
    const carrierControl = {
      ...capture.trace,
      audio: capture.trace.audio.map((chunk) => ({
        ...chunk,
        ...(chunk.witness
          ? { witness: chunk.witness.map((channel) => channel.slice()) }
          : {}),
      })),
    };
    let carrierInjected = false;
    for (const chunk of carrierControl.audio) {
      if (carrierInjected) break;
      for (let i = 0; i < chunk.channels[0]!.length; i++) {
        if (carrierFrame(chunk, i, nativeWitness) === f0) {
          assert.ok(chunk.witness?.[1], 'carrier control has no low channel');
          chunk.witness[1][i] = (chunk.witness[1][i]! + 1) % 65536;
          carrierInjected = true;
          break;
        }
      }
    }
    assert.ok(
      carrierInjected,
      'shifted carrier did not reach the source epoch'
    );
    assert.throws(
      () => assertIndependentCarrier(carrierControl, f0, f0 + length),
      'shifted captured carrier passed admission'
    );
    await writeClockShot(
      join(shotDir, `scheduled-carrier-control-${rate}.json`),
      {
        provenance,
        control: 'one-sample-carrier-shift',
        injected: true,
        boundary: f0,
        admission: 'rejected',
      },
      `scheduled-carrier-control-${rate}`,
      capture.trace
    );
    const comparison = compareScheduledPcm(
      capture.trace.audio,
      f0,
      expected,
      0,
      length,
      nativeWitness
    );
    for (let ch = 0; ch < 2; ch++) {
      assert.ok(
        comparison.rmse[ch]! <= 0.003,
        `scheduled PCM channel ${ch} RMSE ${comparison.rmse[ch]}`
      );
      assert.ok(
        comparison.shiftedRmse[ch]! > 0.003,
        `one-sample negative control did not fail for channel ${ch}`
      );
      assert.ok(
        comparison.mutedPrefixRmse[ch]! > 0.003,
        `muted-prefix negative control did not fail for channel ${ch}`
      );
      assert.ok(
        comparison.swappedRmse[ch]! > 0.003,
        `stereo swap or duplication control did not fail for channel ${ch}`
      );
    }
    for (const [first, end] of [
      [30 * unit - unit, 30 * unit + unit],
      [53 * unit, 66 * unit],
    ] as const) {
      const region = compareScheduledPcm(
        capture.trace.audio,
        f0,
        expected,
        first,
        end,
        nativeWitness
      );
      assert.ok(
        region.rmse.every((value) => value <= 0.003),
        `scheduled cut or dissolve RMSE ${region.rmse}`
      );
    }
    // Every 20 ms source-active window must agree, so a localized dropout
    // cannot disappear inside a passing whole-run average.
    const windowFrames = Math.floor(rate * 0.02);
    for (let first = 0; first + windowFrames <= length; first += windowFrames) {
      const window = compareScheduledPcm(
        capture.trace.audio,
        f0,
        expected,
        first,
        first + windowFrames,
        nativeWitness
      );
      assert.ok(
        window.rmse.every((value) => value <= 0.003),
        `scheduled 20ms PCM window failed at ${first}: ${window.rmse}`
      );
    }
    assert.ok(
      capture.trace.audio.length > 2,
      'not enough PCM records for sequence controls'
    );
    for (const control of [
      'missing',
      'reordered',
      'duplicate',
      'offset',
    ] as const) {
      const corrupt = capture.trace.audio.map((chunk) => ({
        ...chunk,
        ...(chunk.quantumOffsets
          ? { quantumOffsets: chunk.quantumOffsets.slice() }
          : {}),
      }));
      if (control === 'missing') corrupt.splice(1, 1);
      if (control === 'reordered')
        [corrupt[1], corrupt[2]] = [corrupt[2]!, corrupt[1]!];
      if (control === 'duplicate') corrupt.splice(1, 0, corrupt[1]!);
      if (control === 'offset') {
        assert.ok(
          corrupt[1]!.quantumOffsets?.length,
          'offset control has no callback'
        );
        corrupt[1]!.quantumOffsets![0]!++;
      }
      assert.throws(
        () => assertPcmCoverage(f0, f0 + length, corrupt, nativeWitness),
        `${control} PCM provenance passed admission`
      );
    }
    {
      const labeled = capture.trace.audio.map((chunk) => ({
        ...chunk,
        ...(chunk.quantumFrames
          ? { quantumFrames: chunk.quantumFrames.slice() }
          : {}),
      }));
      const target = labeled.find(
        (chunk) =>
          (chunk.quantumFrames?.length ?? 0) >= 2 &&
          (carrierFrame(chunk, 0, nativeWitness) ?? -1) >= f0
      );
      assert.ok(
        target?.quantumFrames,
        'raw-label negative control lacks two callbacks'
      );
      target.quantumFrames[1] = target.quantumFrames[0]!;
      const boundaryIndex = labeled.findIndex(
        (chunk, index) =>
          index > 0 &&
          (chunk.quantumFrames?.length ?? 0) > 0 &&
          (labeled[index - 1]!.quantumFrames?.length ?? 0) > 0 &&
          (carrierFrame(chunk, 0, nativeWitness) ?? -1) >= f0
      );
      assert.ok(
        boundaryIndex > 0,
        'raw cross-chunk label control has no boundary'
      );
      const prior = labeled[boundaryIndex - 1]!.quantumFrames!;
      const boundary = labeled[boundaryIndex]!;
      boundary.sampleFrame = prior[prior.length - 1]!;
      boundary.quantumFrames![0] = boundary.sampleFrame;
      assertPcmCoverage(f0, f0 + length, labeled, nativeWitness);
      const result = compareScheduledPcm(
        labeled,
        f0,
        expected,
        0,
        length,
        nativeWitness
      );
      assert.ok(
        result.rmse.every((value) => value <= 0.003),
        'cached-label repetition changed source-bound PCM qualification'
      );
    }
    {
      const missing = capture.trace.audio.map((chunk) => ({
        ...chunk,
        channels: chunk.channels.map((channel) => channel.slice()),
        ...(chunk.witness
          ? { witness: chunk.witness.map((channel) => channel.slice()) }
          : {}),
        ...(chunk.quantumFrames
          ? { quantumFrames: chunk.quantumFrames.slice() }
          : {}),
        ...(chunk.quantumLengths
          ? { quantumLengths: chunk.quantumLengths.slice() }
          : {}),
        ...(chunk.quantumOrdinals
          ? { quantumOrdinals: chunk.quantumOrdinals.slice() }
          : {}),
        ...(chunk.quantumOffsets
          ? { quantumOffsets: chunk.quantumOffsets.slice() }
          : {}),
      }));
      const target = missing.find(
        (chunk) =>
          (chunk.quantumLengths?.length ?? 0) >= 2 &&
          (carrierFrame(chunk, 0, nativeWitness) ?? -1) >= f0
      );
      assert.ok(
        target?.quantumLengths &&
          target.quantumFrames &&
          target.quantumOrdinals &&
          target.quantumOffsets &&
          target.witness,
        'single-quantum control lacks provenance'
      );
      const begin = target.quantumLengths[0]!,
        size = target.quantumLengths[1]!;
      for (const channel of [...target.channels, ...target.witness])
        channel.splice(begin, size);
      target.quantumFrames.splice(1, 1);
      target.quantumLengths.splice(1, 1);
      target.quantumOrdinals.splice(1, 1);
      target.quantumOffsets.splice(1, 1);
      assert.throws(
        () => assertPcmCoverage(f0, f0 + length, missing, nativeWitness),
        'missing single captured quantum passed carrier/offset admission'
      );
    }
    // Corrupt the captured output, then invoke the same source comparison used
    // for admission. Reference-only sensitivity figures cannot prove rejection.
    for (const control of ['shift', 'dropout', 'swap', 'mono'] as const) {
      const corrupted = capture.trace.audio.map((chunk) => ({
        ...chunk,
        channels: chunk.channels.map((channel) => channel.slice()),
      }));
      let previous = [0, 0];
      let injected = 0;
      for (const chunk of corrupted) {
        for (let i = 0; i < chunk.channels[0]!.length; i++) {
          const frame = carrierFrame(chunk, i, nativeWitness);
          const left = chunk.channels[0]![i]!,
            right = chunk.channels[1]![i]!;
          if (frame !== null && frame >= f0 && frame < f0 + length) {
            if (control === 'shift') {
              chunk.channels[0]![i] = previous[0]!;
              chunk.channels[1]![i] = previous[1]!;
            } else if (control === 'dropout' && frame < f0 + windowFrames) {
              chunk.channels[0]![i] = 0;
              chunk.channels[1]![i] = 0;
            } else if (control === 'swap') {
              chunk.channels[0]![i] = right;
              chunk.channels[1]![i] = left;
            } else if (control === 'mono') {
              chunk.channels[1]![i] = left;
            }
            if (control !== 'dropout' || frame < f0 + windowFrames) injected++;
          }
          previous = [left, right];
        }
      }
      assert.ok(injected > 0, `${control} control did not reach captured PCM`);
      assert.throws(() => {
        const result = compareScheduledPcm(
          corrupted,
          f0,
          expected,
          0,
          control === 'dropout' ? windowFrames : length,
          nativeWitness
        );
        assert.ok(
          result.rmse.every((value) => value <= 0.003),
          `${control} captured PCM rejected: ${result.rmse}`
        );
      }, `${control} corrupted capture passed PCM admission`);
    }
    assert.ok(
      pcmEvents.some((event) => event['event'] === 'frontier'),
      'scheduled readiness frontier missing'
    );
    const checkedFrontiers = assertLookaheadFrontiers(pcmEvents, rate);
    assert.ok(
      checkedFrontiers > 0,
      'no committed frontier carried lookahead evidence'
    );
    const forgedFrontier = pcmEvents.find(
      (event) => event['event'] === 'frontier'
    )!;
    const forgedComposition = forgedFrontier['compositionThrough'] as {
      value: number;
      rate: number;
    };
    const forgedB = Number(forgedComposition.value);
    const forgedP = forgedB + LOOKAHEAD_FRAMES - 1;
    // Cross-coordinate control: the context coordinate is made to look safe while
    // the composition frontier violates P-B >= K. A checker that measured the gap
    // on contextFrameThrough would accept this; the composition checker must not.
    assert.throws(
      () =>
        assertLookaheadFrontiers(
          [
            {
              ...forgedFrontier,
              preparedThrough: forgedP,
              decodedCap: forgedP - LOOKAHEAD_FRAMES,
              scopeEndFrame: forgedP + 1,
              reserveFrames: LOOKAHEAD_FRAMES,
              descriptorCoverageEnd: forgedP,
              descriptorReady: true,
              contextFrameThrough: forgedP - LOOKAHEAD_FRAMES - 5000,
            },
          ],
          rate
        ),
      /below K=/,
      'checker measured the lookahead gap on the context coordinate'
    );
    assert.throws(
      () =>
        assertLookaheadFrontiers(
          [
            {
              ...forgedFrontier,
              compositionThrough: { value: forgedB, rate: rate + 1 },
            },
          ],
          rate
        ),
      /composition-coordinate/,
      'checker accepted a frontier in another sample rate'
    );
    assertCarrierDecodeControls();
    // Successor-policy controls (synthetic, deterministic). The planner rule is
    // exercised on every polarity: a valid successor, one beyond B_old+K, one after
    // a non-ready closure, a healthy successor without reserve, and an ordinary
    // extension below K.
    const syntheticB = 100000;
    const syntheticClosure = (ready: boolean): Record<string, unknown> => ({
      event: 'recovery-render-closed',
      compositionStop: { value: syntheticB, rate },
      preparedThrough: syntheticB + LOOKAHEAD_FRAMES + 500,
      descriptorCoverageEnd: syntheticB + LOOKAHEAD_FRAMES + 200,
      descriptorReady: ready,
    });
    const syntheticHandoff = (
      offset: number,
      reserve: number
    ): Record<string, unknown> => ({
      event: 'frontier',
      frontierKind: 'handoff',
      compositionThrough: { value: syntheticB + offset, rate },
      contextFrameThrough: syntheticB + offset,
      preparedThrough: syntheticB + offset + reserve,
      scopeEndFrame: syntheticB + 10 * LOOKAHEAD_FRAMES,
      reserveFrames: LOOKAHEAD_FRAMES,
      decodedCap: syntheticB + offset + reserve - LOOKAHEAD_FRAMES,
      descriptorCoverageEnd: syntheticB + LOOKAHEAD_FRAMES + 200,
      descriptorReady: true,
    });
    assert.equal(
      assertSuccessorPolicy(
        [syntheticClosure(true), syntheticHandoff(100, LOOKAHEAD_FRAMES + 50)],
        true
      ),
      1,
      'valid successor rejected'
    );
    assert.throws(
      () =>
        assertSuccessorPolicy(
          [
            syntheticClosure(true),
            syntheticHandoff(LOOKAHEAD_FRAMES + 1, LOOKAHEAD_FRAMES + 50),
          ],
          false
        ),
      /predecessor window/,
      'successor beyond B_old+K was accepted'
    );
    assert.throws(
      () =>
        assertSuccessorPolicy(
          [
            syntheticClosure(false),
            syntheticHandoff(100, LOOKAHEAD_FRAMES + 50),
          ],
          false
        ),
      /non-ready closure/,
      'successor after a non-ready closure was accepted'
    );
    assert.throws(
      () =>
        assertSuccessorPolicy(
          [syntheticClosure(true), syntheticHandoff(100, LOOKAHEAD_FRAMES - 1)],
          true
        ),
      /lacks its reserve/,
      'healthy successor without reserve was accepted'
    );
    assert.throws(
      () =>
        assertLookaheadFrontiers(
          [
            {
              event: 'frontier',
              frontierKind: 'extension',
              compositionThrough: { value: syntheticB, rate },
              contextFrameThrough: syntheticB,
              preparedThrough: syntheticB + LOOKAHEAD_FRAMES - 1,
              scopeEndFrame: syntheticB + 10 * LOOKAHEAD_FRAMES,
              reserveFrames: LOOKAHEAD_FRAMES,
              decodedCap: syntheticB - 1,
              descriptorCoverageEnd: syntheticB + LOOKAHEAD_FRAMES,
              descriptorReady: true,
            },
          ],
          rate
        ),
      /below K=/,
      'ordinary extension below K was accepted'
    );
    // Ordinary extensions may be staged without a ready descriptor (readiness is
    // enforced at closure); a transient false is not an I1 failure.
    assert.equal(
      assertLookaheadFrontiers(
        [
          {
            event: 'frontier',
            frontierKind: 'extension',
            compositionThrough: { value: syntheticB, rate },
            contextFrameThrough: syntheticB,
            preparedThrough: syntheticB + LOOKAHEAD_FRAMES + 100,
            scopeEndFrame: syntheticB + 10 * LOOKAHEAD_FRAMES,
            reserveFrames: LOOKAHEAD_FRAMES,
            decodedCap: syntheticB + 100,
            descriptorCoverageEnd: syntheticB + LOOKAHEAD_FRAMES,
            descriptorReady: false,
          },
        ],
        rate
      ),
      1,
      'ordinary extension with transient descriptorReady=false was rejected'
    );
    assert.ok(
      pcmEvents.filter((event) => event['event'] === 'scheduled').length > 1,
      'scheduled queue did not replenish'
    );
    const scheduled = pcmEvents.filter(
      (event) => event['event'] === 'scheduled'
    );
    for (const span of scheduled) {
      const sourceStart = Number(span['sourceStartFrame']);
      const sourceEnd = Number(span['sourceEndFrame']);
      const contextStart = Number(span['contextStartFrame']);
      const contextEnd = Number(span['contextEndFrame']);
      assert.ok(
        [sourceStart, sourceEnd, contextStart, contextEnd].every(
          Number.isSafeInteger
        ),
        'scheduled ownership is not integral'
      );
      assert.ok(
        sourceStart >= 0 && sourceEnd > sourceStart && contextStart >= f0,
        'invalid scheduled ownership interval'
      );
      assert.equal(
        sourceEnd - sourceStart,
        contextEnd - contextStart,
        'scheduled source and context frame counts differ'
      );
      assert.equal(
        span['generation'],
        epoch['generation'],
        'scheduled frame belongs to another generation'
      );
      assert.equal(
        span['sampleRate'],
        oracle.sample_rate,
        'scheduled sample rate changed'
      );
    }
    assert.ok(
      !capture.trace.events.some(
        (event) => event.kind === 'play' && event.mediaType === 'AUDIO'
      ),
      'scheduled mode played a native audio element'
    );
    assert.deepEqual(
      browser.blocked,
      [],
      'scheduled proof attempted a non-loopback request'
    );
    pass('scheduled-pcm-playback');
    if (clockProofMode === 'long') return;
    async function runRecoveryProof(
      session: ChromeSession,
      sessionProvenance: unknown,
      starveMs = 600
    ): Promise<void> {
      const recoveryWindowFrames = Math.floor(oracle.sample_rate * 0.02);
      assert.ok(recoveryWindowFrames > 0, 'invalid recovery sample rate');
      await seekTo(session, 0);
      const recovery = await session.evaluate<
        MovingTrace & {
          held: number;
          released: number;
          sawHeld: boolean;
          handoffBeforeRelease: boolean;
          sawBuffering: boolean;
          pcmReleasedAt: number;
          drainFlagClearedAt: number;
        }
      >(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('recovery controls missing');
      const start = await globalThis.__otioProofTrace.start();
      globalThis.__otioProofTrace.enableRecoveryMarker();
      globalThis.__otioProofHoldOldDrain = true;
      const playEdge = globalThis.__otioProofTrace.playRequest();
      button.click();
      await sleep(${starveMs});
      globalThis.__otioProofTrace.holdPcmResponses(true);
      const closeDeadline = performance.now() + 4000;
      while (!globalThis.__otioProofTrace.hasPcmEvent('recovery-render-closed') &&
             performance.now() < closeDeadline) await sleep(5);
      const held = globalThis.__otioProofTrace.heldPcmCount();
      const pcmReleasedAt = performance.now();
      const released = globalThis.__otioProofTrace.holdPcmResponses(false);
      const handoffDeadline = performance.now() + 1000;
      while ((!globalThis.__otioProofTrace.hasPcmEvent('recovery-handoff') ||
              !globalThis.__otioProofTrace.hasPcmEvent('recovery-old-drain-held')) &&
             performance.now() < handoffDeadline) await sleep(5);
      const sawHeld = globalThis.__otioProofTrace.hasPcmEvent('recovery-old-drain-held');
      const handoffBeforeRelease = globalThis.__otioProofTrace.hasPcmEvent('recovery-handoff');
      const drainFlagClearedAt = performance.now();
      globalThis.__otioProofHoldOldDrain = false;
      const releaseDeadline = performance.now() + 1000;
      while (!globalThis.__otioProofTrace.hasPcmEvent('recovery-old-drain-released') &&
             performance.now() < releaseDeadline) await sleep(5);
      await sleep(300);
      const trace = await globalThis.__otioProofTrace.stop();
      const sawBuffering = trace.events.some((event) =>
        event.kind === 'buffering-change' &&
        event.value !== null &&
        typeof event.value === 'object' &&
        event.value.current === 'true');
      if (root.dataset.playing === 'true') button.click();
      return { start, playEdge, trace, held, released, sawHeld, handoffBeforeRelease, sawBuffering, pcmReleasedAt, drainFlagClearedAt };
    })()`);
      recoveryCapture.trace = recovery.trace;
      await writeClockShot(
        join(shotDir, `scheduled-pcm-starvation-recovery-${rate}.json`),
        { provenance: sessionProvenance, capture: recovery },
        `scheduled-pcm-starvation-recovery-${rate}`,
        recovery.trace
      );
      assert.ok(
        recovery.held > 0 && recovery.released === recovery.held,
        'recovery did not withhold and release future PCM'
      );
      const recoveryEvents = recovery.trace.events
        .filter((entry) => entry.kind === 'scheduled-pcm')
        .map((entry) => entry.value as Record<string, unknown>);
      assert.ok(
        assertLookaheadFrontiers(recoveryEvents, rate) > 0,
        'recovery run committed no lookahead-checked frontier'
      );
      assert.ok(
        assertSuccessorPolicy(recoveryEvents, false) > 0,
        'audio recovery produced no checked successor handoff'
      );
      const firstEpoch = recoveryEvents.find(
        (event) => event['event'] === 'epoch'
      );
      const gateIndex = recoveryEvents.findIndex(
        (event) => event['event'] === 'gate-close'
      );
      assert.ok(
        firstEpoch && gateIndex >= 0,
        'starvation lacks original epoch or actual gate closure'
      );
      const gate = recoveryEvents[gateIndex]!;
      const resumed = recoveryEvents
        .slice(gateIndex + 1)
        .find((event) => event['event'] === 'epoch');
      assert.ok(resumed, 'starvation did not produce a replacement epoch');
      assert.notEqual(
        resumed['generation'],
        firstEpoch['generation'],
        'starvation reused expired generation'
      );
      const stopFrame = Number(gate['contextStopFrame']);
      const resumeFrame = Number(resumed['f0']);
      const stop = gate['compositionStop'] as { value: number; rate: number };
      const resume = resumed['compositionT0'] as {
        value: number;
        rate: number;
      };
      const originalStart = firstEpoch['compositionT0'] as {
        value: number;
        rate: number;
      };
      const originalFrame = Number(firstEpoch['f0']);
      assert.equal(
        gate['generation'],
        firstEpoch['generation'],
        'PCM closure belongs to another generation'
      );
      assert.equal(Number(firstEpoch['contextSampleRate']), oracle.sample_rate);
      assert.ok(originalStart?.rate > 0 && Number.isSafeInteger(originalFrame));
      const committedSample =
        (originalStart.value * oracle.sample_rate) / originalStart.rate +
        stopFrame -
        originalFrame;
      assert.ok(
        Number.isSafeInteger(stopFrame) &&
          Number.isSafeInteger(resumeFrame) &&
          resumeFrame >= stopFrame &&
          resumeFrame - stopFrame <= recoveryWindowFrames,
        'recovery gap exceeds the 20ms sample bound'
      );
      const traceEvents = recovery.trace.events;
      const findArm = (generation: unknown) =>
        traceEvents.find(
          (event) =>
            event.kind === 'transport-command' &&
            event.value &&
            typeof event.value === 'object' &&
            'type' in event.value &&
            event.value.type === 'arm' &&
            'generation' in event.value &&
            event.value.generation === generation
        );
      const oldArm = findArm(firstEpoch['generation']),
        newArm = findArm(resumed['generation']);
      assert.ok(
        oldArm?.value &&
          newArm?.value &&
          typeof oldArm.value === 'object' &&
          typeof newArm.value === 'object' &&
          'slot' in oldArm.value &&
          'slot' in newArm.value &&
          (oldArm.value.slot === 0 || oldArm.value.slot === 1) &&
          (newArm.value.slot === 0 || newArm.value.slot === 1) &&
          oldArm.value.slot !== newArm.value.slot,
        'old and replacement generations did not occupy separate authored gate slots'
      );
      const markerConnection = traceEvents.find(
        (event) => event.kind === 'recovery-old-marker-connected'
      );
      assert.ok(
        markerConnection?.value &&
          typeof markerConnection.value === 'object' &&
          'generation' in markerConnection.value &&
          'slot' in markerConnection.value &&
          markerConnection.value.generation === firstEpoch['generation'] &&
          markerConnection.value.slot === oldArm.value.slot,
        'old-generation marker was not attached to the old physical slot'
      );
      assert.ok(
        traceEvents.some(
          (event) =>
            event.kind === 'recovery-old-marker-scheduled' &&
            event.value &&
            typeof event.value === 'object' &&
            'frame' in event.value &&
            event.value.frame === stopFrame &&
            'late' in event.value &&
            event.value.late === false
        ),
        'old-slot marker was not armed before the real closure boundary'
      );
      const closure = traceEvents.find(
        (event) =>
          event.kind === 'transport-message' &&
          event.value &&
          typeof event.value === 'object' &&
          'generation' in event.value &&
          event.value.generation === firstEpoch['generation'] &&
          'closedFrame' in event.value &&
          event.value.closedFrame === stopFrame &&
          'accepted' in event.value &&
          event.value.accepted === true
      );
      assert.ok(
        closure && closure.timestamp <= newArm.timestamp,
        'successor arm was submitted before acknowledged old render closure'
      );
      const startedSources = traceEvents.filter(
        (event) =>
          event.kind === 'scheduled-pcm' &&
          event.value &&
          typeof event.value === 'object' &&
          'event' in event.value &&
          event.value.event === 'scheduled' &&
          'generation' in event.value &&
          event.value.generation === resumed['generation']
      );
      assert.ok(
        startedSources.length > 0 &&
          startedSources.some(
            (event) =>
              event.value &&
              typeof event.value === 'object' &&
              'contextStartFrame' in event.value &&
              event.value.contextStartFrame === resumeFrame
          ),
        'no actually started successor source begins at selected F1'
      );
      for (const event of startedSources) {
        assert.ok(
          event.value &&
            typeof event.value === 'object' &&
            'contextStartFrame' in event.value &&
            Number.isSafeInteger(event.value.contextStartFrame) &&
            Number(event.value.contextStartFrame) >= resumeFrame &&
            event.timestamp >= closure.timestamp,
          'successor source started before closure or was rebased after scheduling'
        );
      }
      const actualArm = traceEvents.find(
        (event) =>
          event.kind === 'audio-arm-native-output' &&
          event.value &&
          typeof event.value === 'object' &&
          'generation' in event.value &&
          event.value.generation === resumed['generation']
      );
      assert.ok(
        actualArm?.value &&
          typeof actualArm.value === 'object' &&
          'output' in actualArm.value &&
          actualArm.value.output &&
          typeof actualArm.value.output === 'object' &&
          'contextTime' in actualArm.value.output &&
          'performanceTime' in actualArm.value.output &&
          'contextBefore' in actualArm.value &&
          'contextAfter' in actualArm.value &&
          'before' in actualArm.value &&
          'after' in actualArm.value &&
          'state' in actualArm.value,
        'successor arm lacks a real output-timestamp observation'
      );
      const outputContext = Number(actualArm.value.output.contextTime);
      const outputPerformance = Number(actualArm.value.output.performanceTime);
      assert.ok(
        Number.isFinite(outputContext) &&
          outputContext > 0 &&
          Number.isFinite(outputPerformance) &&
          outputPerformance > 0 &&
          actualArm.value.state === 'running' &&
          Number(actualArm.value.before) <= Number(actualArm.value.after) &&
          Number(actualArm.value.contextBefore) <=
            Number(actualArm.value.contextAfter) &&
          outputPerformance <=
            Number(actualArm.value.after) +
              DEFAULT_CLOCK_POLICY.futureToleranceMs &&
          Number(actualArm.value.after) - outputPerformance <=
            DEFAULT_CLOCK_POLICY.freshnessMs &&
          outputContext <=
            Number(actualArm.value.contextAfter) +
              DEFAULT_CLOCK_POLICY.futureToleranceMs / 1000 &&
          outputContext * rate < stopFrame,
        'successor arm was not observed while real output remained before D'
      );
      const stamps = traceEvents
        .filter(
          (event) =>
            event.kind === 'audio-output-timestamp-observed' &&
            event.value &&
            typeof event.value === 'object' &&
            'output' in event.value &&
            event.value.output &&
            typeof event.value.output === 'object' &&
            'contextTime' in event.value.output &&
            'performanceTime' in event.value.output &&
            'injected' in event.value &&
            event.value.injected === false
        )
        .map((event) => ({
          timestamp: event.timestamp,
          value: event.value as {
            output: { contextTime: number; performanceTime: number };
          },
        }))
        .filter(
          (entry) =>
            Number.isFinite(entry.value.output.contextTime) &&
            Number.isFinite(entry.value.output.performanceTime) &&
            entry.value.output.contextTime > 0 &&
            entry.value.output.performanceTime > 0
        );
      const prior = stamps
        .filter((entry) => entry.timestamp <= actualArm.timestamp)
        .at(-1);
      const after = stamps.find(
        (entry) =>
          entry.timestamp > actualArm.timestamp &&
          entry.value.output.contextTime > outputContext &&
          entry.value.output.performanceTime > outputPerformance
      );
      assert.ok(
        prior &&
          after &&
          prior.value.output.contextTime <= outputContext &&
          prior.value.output.performanceTime <= outputPerformance,
        'real output timestamp was not continuously advancing across handoff'
      );
      const bracket = traceEvents.filter(
        (event) =>
          event.kind === 'audio-output-timestamp-observed' &&
          event.timestamp >= prior.timestamp &&
          event.timestamp <= after.timestamp
      );
      let lastContext = 0,
        lastPerformance = 0;
      for (const observed of bracket) {
        const value = observed.value as {
          injected?: boolean;
          output?: { contextTime?: number; performanceTime?: number };
        };
        const contextTime = Number(value?.output?.contextTime),
          performanceTime = Number(value?.output?.performanceTime);
        assert.ok(
          value?.injected === false &&
            Number.isFinite(contextTime) &&
            Number.isFinite(performanceTime) &&
            contextTime > 0 &&
            performanceTime > 0 &&
            contextTime >= lastContext &&
            performanceTime >= lastPerformance &&
            performanceTime <=
              observed.timestamp + DEFAULT_CLOCK_POLICY.futureToleranceMs &&
            observed.timestamp - performanceTime <=
              DEFAULT_CLOCK_POLICY.freshnessMs,
          'output mapping was invalid or regressed inside the handoff bracket'
        );
        lastContext = contextTime;
        lastPerformance = performanceTime;
      }
      assert.ok(stop?.rate > 0 && resume?.rate > 0);
      const resumeSample = committedSample;
      assert.ok(
        Number.isSafeInteger(resumeSample) &&
          resumeSample >= recoveryWindowFrames &&
          resumeSample + recoveryWindowFrames <= length,
        'replacement epoch lacks a comparable sample interval'
      );
      assert.equal(
        (stop.value * oracle.sample_rate) / stop.rate,
        committedSample,
        'closure changed the exact committed composition sample'
      );
      assert.equal(
        (resume.value * oracle.sample_rate) / resume.rate,
        committedSample,
        'replacement skipped or replayed a committed source sample'
      );
      const candidate = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-candidate-ready' &&
          event['oldGeneration'] === firstEpoch['generation'] &&
          event['boundaryFrame'] === stopFrame
      );
      const renderClosed = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-render-closed' &&
          event['boundaryFrame'] === stopFrame
      );
      const selection = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-selection' &&
          event['oldGeneration'] === firstEpoch['generation']
      );
      const finalGuard = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-final-guard' &&
          event['oldGeneration'] === firstEpoch['generation']
      );
      const handoff = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-handoff' &&
          event['oldGeneration'] === firstEpoch['generation']
      );
      assert.ok(
        candidate && renderClosed && selection && finalGuard && handoff,
        'two-phase handoff provenance incomplete'
      );
      const heldDrain = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-old-drain-held' &&
          event['boundaryFrame'] === stopFrame
      );
      const releasedDrain = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-old-drain-released' &&
          event['boundaryFrame'] === stopFrame
      );
      assert.ok(
        recovery.sawBuffering &&
          recovery.sawHeld &&
          recovery.handoffBeforeRelease &&
          heldDrain &&
          releasedDrain &&
          Number(handoff['wallMs']) <= Number(releasedDrain['wallMs']) &&
          Number(heldDrain['wallMs']) <= Number(releasedDrain['wallMs']),
        `successor was not armed before release of an actually held old drain (sawHeld=${recovery.sawHeld}, handoffBeforeRelease=${recovery.handoffBeforeRelease}, heldDrain=${heldDrain ? Number(heldDrain['wallMs']) : 'none'}, releasedDrain=${releasedDrain ? Number(releasedDrain['wallMs']) : 'none'}, handoff=${Number(handoff['wallMs'])}, pcmReleasedAt=${recovery.pcmReleasedAt}, drainFlagClearedAt=${recovery.drainFlagClearedAt})`
      );
      // The release must land after the held drain and inside the runtime's
      // 1000 ms drain window, not at a sampled DOM moment.
      assert.ok(
        Number(releasedDrain['wallMs']) - Number(heldDrain['wallMs']) >= 0 &&
          Number(releasedDrain['wallMs']) - Number(heldDrain['wallMs']) <= 1000,
        `old-drain release fell outside its 1000 ms window (held=${Number(heldDrain['wallMs'])}, released=${Number(releasedDrain['wallMs'])})`
      );
      assert.ok(
        Number(candidate['wallMs']) <= Number(renderClosed['wallMs']) &&
          Number(renderClosed['wallMs']) <= Number(selection['wallMs']) &&
          Number(selection['wallMs']) <= Number(finalGuard['wallMs']) &&
          Number(finalGuard['wallMs']) <= Number(handoff['wallMs']),
        'handoff phases are not ordered around render closure'
      );
      assert.equal(
        candidate['boundaryFrame'],
        stopFrame,
        'staged candidate targets another closure'
      );
      assert.equal(
        candidate['compositionStart'],
        committedSample,
        'staged candidate did not reserve the exact committed sample'
      );
      assert.equal(
        candidate['slot'],
        newArm.value.slot,
        'staged candidate used wrong successor slot'
      );
      assert.ok(
        candidate['generation'] === resumed['generation'] &&
          selection['generation'] === resumed['generation'] &&
          finalGuard['generation'] === resumed['generation'] &&
          handoff['generation'] === resumed['generation'],
        'staged or committed handoff provenance belongs to another generation'
      );
      assert.equal(
        renderClosed['oldSlot'],
        oldArm.value.slot,
        'render closure identified wrong old slot'
      );
      assert.equal(
        renderClosed['clockEpoch'],
        selection['clockEpoch'],
        'handoff crossed clock sessions'
      );
      assert.equal(
        selection['boundaryFrame'],
        stopFrame,
        'handoff selection targets another closure'
      );
      assert.equal(
        selection['compositionStartFrame'],
        committedSample,
        'handoff source origin changed'
      );
      assert.equal(
        selection['f0'],
        resumeFrame,
        'handoff selection was rebased'
      );
      assert.equal(
        selection['slot'],
        newArm.value.slot,
        'handoff selected the wrong input slot'
      );
      assertLatestRecoveryFrame(
        recovery.trace,
        selection,
        stopFrame,
        rate,
        audioOnly
      );
      assert.ok(
        Number.isSafeInteger(selection['feasibleLower']) &&
          Number.isSafeInteger(selection['feasibleUpper']) &&
          Number(selection['feasibleLower']) <= resumeFrame &&
          selection['feasibleUpper'] === resumeFrame &&
          resumeFrame <= stopFrame + recoveryWindowFrames &&
          (selection['phaseLower'] === null ||
            (Number.isSafeInteger(selection['phaseLower']) &&
              Number(selection['phaseLower']) <= resumeFrame)) &&
          (selection['phaseUpper'] === null ||
            (Number.isSafeInteger(selection['phaseUpper']) &&
              resumeFrame <= Number(selection['phaseUpper']))),
        'F1 was not the latest feasible in-band sample'
      );
      const recoveryBridge = resumed['bridge'] as {
        contextTime: number;
        performanceTime: number;
      };
      const mappedF1 =
        recoveryBridge.performanceTime +
        (resumeFrame / rate - recoveryBridge.contextTime) * 1000;
      assert.ok(
        Number.isFinite(selection['requestWall']) &&
          Number.isFinite(selection['deadline']) &&
          Number(selection['deadline']) ===
            Number(selection['requestWall']) + 350 &&
          Number.isFinite(selection['epochWall']) &&
          Math.abs(Number(selection['epochWall']) - mappedF1) <= 1e-6 &&
          mappedF1 <= Number(selection['deadline']),
        'handoff reset its original deadline or changed the selected output mapping'
      );
      assert.ok(
        Number(selection['guardFrames']) === 512 &&
          resumeFrame - Number(selection['contextFrame']) >= 512,
        'handoff selection violated the 512-frame guard'
      );
      assert.ok(
        finalGuard['boundaryFrame'] === stopFrame &&
          finalGuard['f0'] === resumeFrame &&
          finalGuard['slot'] === newArm.value.slot &&
          finalGuard['guardFrames'] === 512 &&
          Number.isSafeInteger(finalGuard['contextFrame']) &&
          resumeFrame - Number(finalGuard['contextFrame']) >= 512 &&
          finalGuard['clockEpoch'] === selection['clockEpoch'] &&
          Number(finalGuard['wallMs']) >=
            Math.min(...startedSources.map((event) => event.timestamp)),
        'post-start handoff guard or epoch did not remain valid'
      );
      assert.ok(
        handoff['f0'] === resumeFrame &&
          handoff['boundaryFrame'] === stopFrame &&
          handoff['slot'] === newArm.value.slot &&
          handoff['clockEpoch'] === selection['clockEpoch'] &&
          handoff['oldDrainObserved'] === false,
        'handoff waited for old output drain or changed the staged epoch'
      );
      const originalSample =
        (originalStart.value * oracle.sample_rate) / originalStart.rate;
      assert.ok(
        Number.isSafeInteger(originalSample),
        'old epoch origin is not a sample'
      );
      const oldPrefix = compareScheduledPcm(
        recovery.trace.audio,
        originalFrame - originalSample,
        expected,
        committedSample - recoveryWindowFrames,
        committedSample,
        recovery.trace.witness
      );
      assert.ok(
        oldPrefix.rmse.every((value) => value <= 0.003),
        'old generation lost or mixed source PCM before render closure'
      );
      assertSourcePcmSamples(
        recovery.trace,
        originalFrame - originalSample,
        expected,
        committedSample - recoveryWindowFrames,
        committedSample
      );
      if (resumeFrame > stopFrame)
        assertPcmSilence(
          recovery.trace,
          stopFrame,
          resumeFrame,
          'new or stale PCM crossed the closed gate before successor F1'
        );
      const recovered = compareScheduledPcm(
        recovery.trace.audio,
        resumeFrame - resumeSample,
        expected,
        resumeSample,
        resumeSample + recoveryWindowFrames,
        recovery.trace.witness
      );
      assert.ok(
        recovered.rmse.every((value) => value <= 0.003),
        'replacement epoch did not restart at the exact post-gain stereo sample'
      );
      assertSourcePcmSamples(
        recovery.trace,
        resumeFrame - resumeSample,
        expected,
        resumeSample,
        resumeSample + recoveryWindowFrames
      );
      const witness = recovery.trace.witness;
      assert.ok(witness, 'recovery marker lacks independent carrier');
      const probeCount = Math.min(128, recoveryWindowFrames);
      let markerSamples = 0;
      for (const chunk of recovery.trace.audio) {
        assert.ok(
          chunk.marker && chunk.marker.length === chunk.channels[0]!.length,
          'old-slot marker capture unavailable'
        );
        for (let i = 0; i < chunk.marker.length; i++) {
          const frame = carrierFrame(chunk, i, witness);
          if (
            frame === null ||
            frame < resumeFrame ||
            frame >= resumeFrame + probeCount
          )
            continue;
          assert.ok(
            Math.abs(chunk.marker[i]! - 0.375) < 0.00001,
            'delayed old-slot marker was not present during replacement PCM'
          );
          const sample = resumeSample + (frame - resumeFrame);
          for (let ch = 0; ch < 2; ch++)
            assert.ok(
              Math.abs(chunk.channels[ch]![i]! - expected[ch]![sample]!) <=
                0.003,
              'old-slot marker leaked into replacement PCM'
            );
          markerSamples++;
        }
      }
      assert.equal(
        markerSamples,
        probeCount,
        'old-slot marker overlap was not fully captured'
      );
      const drained = recoveryEvents.find(
        (event) =>
          event['event'] === 'recovery-old-drained' &&
          event['boundaryFrame'] === stopFrame
      );
      const drainRead = traceEvents.find(
        (event) =>
          event.kind === 'recovery-old-drain-native-read' &&
          event.value &&
          typeof event.value === 'object' &&
          'boundaryFrame' in event.value &&
          event.value.boundaryFrame === stopFrame
      );
      assert.ok(
        drained &&
          drainRead?.value &&
          typeof drainRead.value === 'object' &&
          'renderBefore' in drainRead.value &&
          'renderAfter' in drainRead.value &&
          'before' in drainRead.value &&
          'after' in drainRead.value &&
          'output' in drainRead.value &&
          drainRead.value.output &&
          typeof drainRead.value.output === 'object' &&
          'contextTime' in drainRead.value.output &&
          'performanceTime' in drainRead.value.output &&
          'state' in drainRead.value &&
          drainRead.value.state === 'running' &&
          Number.isFinite(Number(drainRead.value.output.contextTime)) &&
          Number.isFinite(Number(drainRead.value.output.performanceTime)) &&
          Number(drainRead.value.output.contextTime) * rate >= stopFrame &&
          Number(drainRead.value.output.performanceTime) > 0 &&
          Number(drainRead.value.before) <= Number(drainRead.value.after) &&
          Number(drainRead.value.renderBefore) <=
            Number(drainRead.value.renderAfter) &&
          Number(drainRead.value.output.contextTime) <=
            Number(drainRead.value.renderAfter) +
              DEFAULT_CLOCK_POLICY.futureToleranceMs / 1000 &&
          Number(drainRead.value.output.performanceTime) <=
            Number(drainRead.value.after) +
              DEFAULT_CLOCK_POLICY.futureToleranceMs &&
          Number(drainRead.value.after) -
            Number(drainRead.value.output.performanceTime) <=
            DEFAULT_CLOCK_POLICY.freshnessMs &&
          Number(drained['wallMs']) >= Number(handoff['wallMs']),
        'old output drain did not occur after successor handoff'
      );
      const postDrainFrame = Math.max(
        resumeFrame,
        Math.ceil(Number(drainRead.value.renderAfter) * rate) + 128
      );
      const postDrainSample = resumeSample + postDrainFrame - resumeFrame;
      assert.ok(
        Number.isSafeInteger(postDrainFrame) &&
          Number.isSafeInteger(postDrainSample) &&
          postDrainSample >= 0 &&
          postDrainSample + recoveryWindowFrames <= length,
        'no source-bound post-drain observation window'
      );
      const afterOldDrain = compareScheduledPcm(
        recovery.trace.audio,
        resumeFrame - resumeSample,
        expected,
        postDrainSample,
        postDrainSample + recoveryWindowFrames,
        recovery.trace.witness
      );
      assert.ok(
        afterOldDrain.rmse.every((value) => value <= 0.003),
        'late old-drain completion altered successor PCM'
      );
      assertSourcePcmSamples(
        recovery.trace,
        resumeFrame - resumeSample,
        expected,
        postDrainSample,
        postDrainSample + recoveryWindowFrames
      );
      assert.ok(
        !recoveryEvents.some(
          (event) =>
            Number(event['wallMs']) > Number(handoff['wallMs']) &&
            event['generation'] === resumed['generation'] &&
            (event['event'] === 'cancel' || event['event'] === 'error')
        ),
        'late old-drain completion canceled the successor generation'
      );
      pass('scheduled-pcm-starvation-recovery');
    }
    async function runRecoveryFaults(): Promise<void> {
      for (const fault of [
        'recovery-phase-mismatch',
        'recovery-impossible-guard',
        'recovery-excess-work',
        'recovery-earlier-feasible',
        'recovery-delayed-staging',
        'descriptor-budget',
      ] as const)
        await rerunFrontierOvershoot(`${fault}-${rate}`, (attempt) =>
          runRecoveryFault(fault, starveAfterMs(attempt))
        );
    }
    async function runRecoveryFault(
      fault:
        | 'recovery-phase-mismatch'
        | 'recovery-impossible-guard'
        | 'recovery-excess-work'
        | 'recovery-earlier-feasible'
        | 'recovery-delayed-staging'
        | 'descriptor-budget',
      starveMs: number
    ): Promise<void> {
      {
        const isolated = await openBrowser(url, sessionToken, {
          label: `${fault}-${rate}`,
          recordProofTrace: true,
          proofSampleRate: rate,
        });
        try {
          await waitReady(isolated);
          // The descriptor fault is consumed during candidate staging, before closure.
          const result = await isolated.evaluate<
            MovingTrace & {
              held: number;
              released: number;
              playing: string;
              buffering: string;
              diagnostic: string;
            }
          >(`(async()=>{
            const sleep=ms=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,ms);return promise;};
            const root=document.querySelector('.otio-view'),button=document.querySelector('button.otio-play');
            if(!(root instanceof HTMLElement)||!(button instanceof HTMLButtonElement)) throw new Error('recovery fault controls missing');
            const start=await globalThis.__otioProofTrace.start(),playEdge=globalThis.__otioProofTrace.playRequest();
            if (${JSON.stringify(fault)}==='descriptor-budget') globalThis.__otioProofPcmFault='descriptor-budget';
            button.click(); await sleep(${starveMs});
            if (${JSON.stringify(fault)}==='recovery-excess-work') globalThis.__otioProofTrace.injectRecoveryOverrun();
            else globalThis.__otioProofPcmFault=${JSON.stringify(fault)};
            globalThis.__otioProofTrace.holdPcmResponses(true);
            const waitUntil=performance.now()+4000;
            while((!globalThis.__otioProofTrace.heldPcmCount()||root.dataset.buffering!=='true')&&performance.now()<waitUntil) await sleep(10);
            const held=globalThis.__otioProofTrace.heldPcmCount();
            const released=globalThis.__otioProofTrace.holdPcmResponses(false);
            const faultDeadline=performance.now()+1000;
            while(!globalThis.__otioProofTrace.hasPcmEvent('recovery-fault') &&
              !globalThis.__otioProofTrace.hasTraceEvent('recovery-overrun-injected') &&
              performance.now()<faultDeadline) await sleep(10);
            await sleep(${JSON.stringify(fault)}==='recovery-delayed-staging' ? 700 : 300);
            const playing=root.dataset.playing ?? '', buffering=root.dataset.buffering ?? '';
            const diagnostic=Array.from(document.querySelectorAll('.otio-diagnostic'))
              .filter(node=>{const style=getComputedStyle(node); return node.getClientRects().length>0 &&
                style.visibility!=='hidden' && style.display!=='none' && Number(style.opacity)>0;})
              .map(node=>node.textContent ?? '').join(' ');
            globalThis.__otioProofPcmFault=null;
            const trace=await globalThis.__otioProofTrace.stop();
            if(root.dataset.playing==='true') button.click();
            return {start,playEdge,trace,held,released,playing,buffering,diagnostic};
          })()`);
          recoveryCapture.trace = result.trace;
          await writeFile(
            join(shotDir, `${fault}-${rate}.json`),
            JSON.stringify({ provenance, capture: result })
          );
          assert.ok(
            result.held > 0 &&
              result.held === result.released &&
              !result.trace.audioOverflow &&
              !result.trace.eventsOverflow,
            `${fault} control did not hold and release real PCM cleanly`
          );
          if (fault !== 'recovery-earlier-feasible') {
            assert.equal(
              result.playing,
              'false',
              `${fault} left playback active`
            );
            assert.equal(
              result.buffering,
              'false',
              `${fault} left playback buffering`
            );
            assert.match(
              result.diagnostic,
              /Scheduled audio stopped:/,
              `${fault} did not render its interruption diagnostic`
            );
          }
          const events = result.trace.events
            .filter((event) => event.kind === 'scheduled-pcm')
            .map((event) => event.value as Record<string, unknown>);
          const closedIndex = events.findIndex(
            (event) => event['event'] === 'gate-close'
          );
          assert.ok(
            closedIndex >= 0,
            `${fault} never acknowledged the old render closure`
          );
          const boundary = Number(events[closedIndex]!['contextStopFrame']);
          assert.ok(
            events
              .slice(0, closedIndex)
              .some((event) => event['event'] === 'epoch'),
            `${fault} never established an old media epoch`
          );
          if (fault === 'recovery-earlier-feasible') {
            assert.ok(
              events.some(
                (event) =>
                  event['event'] === 'recovery-fault' &&
                  event['code'] === fault &&
                  event['boundaryFrame'] === boundary
              ),
              'earlier-feasible control did not actually run'
            );
            const selected = events.find(
              (event) =>
                event['event'] === 'recovery-selection' &&
                event['boundaryFrame'] === boundary
            );
            assert.ok(
              selected,
              'earlier-feasible control never selected a real successor'
            );
            assert.throws(
              () =>
                assertLatestRecoveryFrame(
                  result.trace,
                  selected,
                  boundary,
                  rate,
                  audioOnly
                ),
              /recovery F1 is not latest independently feasible frame/,
              'latest-feasible proof accepted the deliberately earlier actual selection'
            );
            return;
          }
          if (fault === 'recovery-excess-work') {
            const injection = result.trace.events.find(
              (event) => event.kind === 'recovery-overrun-injected'
            );
            assert.ok(
              injection?.value &&
                typeof injection.value === 'object' &&
                'sourceStarted' in injection.value &&
                injection.value.sourceStarted === true &&
                'crossedBeforeDeadline' in injection.value &&
                injection.value.crossedBeforeDeadline === true &&
                'f1' in injection.value &&
                'contextFrame' in injection.value &&
                Number(injection.value.contextFrame) + 512 >
                  Number(injection.value.f1),
              'post-start work did not actually consume the unchanged guard within the original deadline'
            );
            assert.ok(
              events.some(
                (event) =>
                  event['event'] === 'scheduled' &&
                  Number(event['wallMs']) >= injection.timestamp
              ),
              'overrun control did not start a real successor source'
            );
            assert.ok(
              !result.trace.events.some(
                (event) =>
                  event.kind === 'transport-command' &&
                  event.timestamp >= injection.timestamp &&
                  event.value &&
                  typeof event.value === 'object' &&
                  'type' in event.value &&
                  event.value.type === 'arm'
              ),
              'overrun started or rebased a successor after the guard was consumed'
            );
            assert.ok(
              events.some(
                (event) =>
                  event['event'] === 'error' &&
                  Number(event['wallMs']) >= injection.timestamp &&
                  (event['code'] === 'PCM scheduling deadline missed' ||
                    event['code'] === 'recovery final guard exceeded' ||
                    event['code'] ===
                      'recovery final clock or visual guard failed')
              ),
              'post-start guard overrun did not interrupt'
            );
          } else if (fault === 'descriptor-budget') {
            assertDescriptorBudgetRefusal(events, closedIndex, boundary);
            assert.match(
              result.diagnostic,
              /Scheduled audio stopped: descriptor-budget-exhausted/,
              'descriptor budget refusal did not render its cause'
            );
            const closure = result.trace.events.filter(
              (event) => event.kind === 'scheduled-pcm'
            )[closedIndex]!;
            assert.ok(
              !result.trace.events.some(
                (event) =>
                  event.kind === 'transport-command' &&
                  event.timestamp >= closure.timestamp &&
                  event.value &&
                  typeof event.value === 'object' &&
                  'type' in event.value &&
                  event.value.type === 'arm'
              ),
              'descriptor budget refusal still armed a successor'
            );
          } else {
            const injectionIndex = events.findIndex(
              (event, index) =>
                index > closedIndex &&
                event['event'] === 'recovery-fault' &&
                event['code'] === fault &&
                event['boundaryFrame'] === boundary
            );
            assert.ok(
              injectionIndex > closedIndex,
              `${fault} did not reach the real post-closure solver`
            );
            assert.ok(
              events
                .slice(injectionIndex + 1)
                .some(
                  (event) =>
                    event['event'] === 'error' &&
                    event['code'] ===
                      (fault === 'recovery-phase-mismatch'
                        ? 'video recovery phase has no causal audio epoch'
                        : fault === 'recovery-delayed-staging'
                          ? 'PCM recovery deadline expired'
                          : 'recovery render handoff has no feasible frame')
                ),
              `${fault} did not produce a visible interruption`
            );
          }
          if (fault === 'recovery-delayed-staging') {
            const request = result.trace.events.find(
              (event) =>
                event.kind === 'scheduled-pcm' &&
                (event.value as Record<string, unknown>)?.['event'] ===
                  'recovery-request' &&
                (event.value as Record<string, unknown>)?.['boundaryFrame'] ===
                  boundary
            );
            const timeout = events.find(
              (event) =>
                event['event'] === 'recovery-timeout' &&
                event['boundaryFrame'] === boundary
            );
            assert.ok(
              request && timeout,
              'delayed staging lacked the original request or deadline timeout'
            );
            const origin = request.value as Record<string, unknown>;
            const before = Number(origin['requestPerformanceBefore']),
              after = Number(origin['requestPerformanceAfter']);
            const original = Number(timeout['requestWall']),
              deadline = Number(timeout['deadline']);
            assert.ok(
              Number.isFinite(before) &&
                Number.isFinite(after) &&
                before <= original &&
                original <= after &&
                after <= request.timestamp &&
                deadline === original + 350 &&
                Number(timeout['observedWall']) > deadline,
              'delayed staging reset the original recovery deadline'
            );
            assert.ok(
              !events.some(
                (event) =>
                  event['event'] === 'recovery-selection' &&
                  event['boundaryFrame'] === boundary
              ),
              'delayed staging selected a successor after expiry'
            );
          }
          assert.ok(
            !events
              .slice(closedIndex + 1)
              .some((event) => event['event'] === 'epoch'),
            `${fault} admitted a successor epoch`
          );
          assert.ok(
            !events.some(
              (event) =>
                event['event'] === 'backend' && event['backend'] === 'native'
            ),
            `${fault} silently switched backend`
          );
          assertPcmSilence(
            result.trace,
            boundary,
            lastCarrierEnd(result.trace),
            `${fault} emitted PCM after the rejected handoff`
          );
        } finally {
          await isolated.close();
        }
      }
    }
    async function runHeldPullSequences(): Promise<void> {
      const runHeld = async (
        label: string,
        releaseAfterClosure: boolean,
        starveMs: number
      ) => {
        const isolated = await openBrowser(url, sessionToken, {
          label: `${label}-${rate}`,
          recordProofTrace: true,
          proofSampleRate: rate,
        });
        try {
          await waitReady(isolated);
          const result = await isolated.evaluate<
            MovingTrace & {
              held: number;
              released: number;
              releaseAt: number;
              playing: string;
              buffering: string;
              diagnostic: string;
            }
          >(`(async()=>{
            const sleep=ms=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,ms);return promise;};
            const root=document.querySelector('.otio-view'),button=document.querySelector('button.otio-play');
            if(!(root instanceof HTMLElement)||!(button instanceof HTMLButtonElement)) throw new Error('held-pull controls missing');
            const proof=globalThis.__otioProofTrace;
            const start=await proof.start(),playEdge=proof.playRequest();
            button.click(); await sleep(${starveMs});
            proof.holdPcmResponses(true);
            ${releaseAfterClosure ? "proof.releasePcmResponsesOn('recovery-render-closed');" : ''}
            const until=performance.now()+4000;
            while(!proof.hasPcmEvent('recovery-render-closed') && performance.now()<until) await sleep(10);
            ${
              releaseAfterClosure
                ? "while(!proof.hasTraceEvent('pcm-hold-release') && performance.now()<until) await sleep(10); await sleep(1500);"
                : 'const held=proof.heldPcmCount(); await sleep(2500); const releaseAt=performance.now(); const released=proof.holdPcmResponses(false); await sleep(400);'
            }
            const playing=root.dataset.playing ?? '', buffering=root.dataset.buffering ?? '';
            const diagnostic=Array.from(document.querySelectorAll('.otio-diagnostic'))
              .filter(node=>{const style=getComputedStyle(node); return node.getClientRects().length>0 &&
                style.visibility!=='hidden' && style.display!=='none' && Number(style.opacity)>0;})
              .map(node=>node.textContent ?? '').join(' ');
            const captured=await proof.stop();
            ${releaseAfterClosure ? "const release=captured.events.find(e=>e.kind==='pcm-hold-release'); const held=release?.value?.released ?? 0, released=held, releaseAt=release?.timestamp ?? NaN;" : ''}
            if(root.dataset.playing==='true') button.click();
            return {start,playEdge,trace:captured,held,released,releaseAt,playing,buffering,diagnostic};
          })()`);
          recoveryCapture.trace = result.trace;
          await writeFile(
            join(shotDir, `${label}-${rate}.json`),
            JSON.stringify({ provenance, capture: result })
          );
          assert.ok(
            result.held > 0 &&
              !result.trace.audioOverflow &&
              !result.trace.eventsOverflow,
            `${label} did not hold real PCM responses`
          );
          assert.ok(
            result.trace.witness,
            `${label} lacks the independent carrier witness`
          );
          const events: Record<string, unknown>[] = result.trace.events
            .filter((entry) => entry.kind === 'scheduled-pcm')
            .map(
              (entry): Record<string, unknown> => ({
                ...(entry.value as Record<string, unknown>),
                timestamp: entry.timestamp,
              })
            );
          const closures = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => event['event'] === 'recovery-render-closed');
          assert.ok(
            closures.length >= 1,
            `${label} never acknowledged a render closure`
          );
          const first = closures[0]!;
          assert.equal(
            first.event['descriptorReady'],
            true,
            `${label} first closure was not ready`
          );
          const handoffAt = events.findIndex(
            (event, index) =>
              index > first.index &&
              event['event'] === 'frontier' &&
              event['frontierKind'] === 'handoff'
          );
          assert.ok(
            handoffAt > first.index,
            `${label} produced no successor handoff`
          );
          assertSuccessorPolicy(events, false);
          assertLookaheadFrontiers(events, rate);
          if (!releaseAfterClosure) {
            assert.ok(
              closures.length >= 2,
              'continued hold did not reach a second closure'
            );
            const second = closures[1]!;
            assert.ok(
              events
                .slice(first.index + 1, second.index)
                .filter((event) => event['event'] === 'epoch').length === 1,
              'first ready recovery did not admit exactly one successor epoch'
            );
            assert.equal(
              second.event['descriptorReady'],
              false,
              'second closure claimed a ready descriptor'
            );
            const refusal = events.findIndex(
              (event, index) =>
                index > second.index &&
                event['event'] === 'recovery-candidate-failed' &&
                event['code'] === 'descriptor-not-ready'
            );
            assert.ok(
              refusal > second.index,
              'no-reserve closure was not visibly refused'
            );
            assert.ok(
              !events
                .slice(second.index + 1)
                .some((event) => event['event'] === 'epoch'),
              'no-reserve closure admitted a second epoch'
            );
            assert.ok(
              events
                .slice(refusal + 1)
                .some((event) => event['event'] === 'error'),
              'no-reserve refusal did not stop playback visibly'
            );
            assert.equal(
              result.playing,
              'false',
              'no-reserve refusal left playback active'
            );
            assert.match(
              result.diagnostic,
              /Scheduled audio stopped:/,
              'no-reserve refusal was not rendered'
            );
            assertPcmSilence(
              result.trace,
              Number(second.event['boundaryFrame']),
              lastCarrierEnd(result.trace),
              `${label} emitted PCM after the no-reserve refusal`
            );
          } else {
            assertHeldReleaseBeforeSuccessor(result.trace.events);
            assert.ok(
              !events.some(
                (event) =>
                  event['event'] === 'recovery-candidate-failed' &&
                  event['code'] === 'descriptor-not-ready'
              ),
              'released run still refused a descriptor'
            );
            assert.ok(
              !events.some((event) => event['event'] === 'error'),
              'released run stopped playback'
            );
            assert.equal(
              result.playing,
              'true',
              'released run did not keep playing'
            );
            assert.ok(
              events
                .slice(handoffAt + 1)
                .some(
                  (event) =>
                    event['event'] === 'frontier' &&
                    event['frontierKind'] === 'extension'
                ),
              'no ordinary I1 extension followed the released successor'
            );
          }
        } finally {
          await isolated.close();
        }
      };
      await rerunFrontierOvershoot(
        `held-first-ready-then-no-reserve-${rate}`,
        (attempt) =>
          runHeld(
            'held-first-ready-then-no-reserve',
            false,
            starveAfterMs(attempt)
          )
      );
      await rerunFrontierOvershoot(
        `held-released-before-successor-${rate}`,
        (attempt) =>
          runHeld(
            'held-released-before-successor',
            true,
            starveAfterMs(attempt)
          )
      );
    }
    async function runAnchorControls(): Promise<void> {
      for (const kind of [
        'source-offset',
        'start-time',
        'missing-first-quantum',
        'missing',
        'truncated',
        'held-bank',
        'shift-bank',
        'stale-epoch',
      ] as const) {
        const isolated = await openBrowser(url, sessionToken, {
          label: `scheduled-anchor-${rate}-${kind}`,
          recordProofTrace: true,
          proofSampleRate: rate,
        });
        try {
          await waitReady(isolated);
          const outcome = await isolated.evaluate<
            MovingTrace & {
              credits: {
                gateReservations: number;
                carrierReservations: number;
                bytes: number;
                nodes: number;
              };
            }
          >(`(async () => {
          const sleep = ms => {const {promise,resolve}=Promise.withResolvers(); setTimeout(resolve,ms); return promise;};
          const button=document.querySelector('button.otio-play');
          if (!(button instanceof HTMLButtonElement)) throw new Error('anchor proof play button missing');
          const start=await globalThis.__otioProofTrace.start();
          globalThis.__otioProofTrace.nextAnchorControl(${JSON.stringify(kind)});
          const playEdge=globalThis.__otioProofTrace.playRequest();
          button.click(); await sleep(1200);
          const trace=await globalThis.__otioProofTrace.stop();
          if(document.querySelector('.otio-view')?.dataset.playing==='true') button.click();
          const credits=globalThis.__otioProofPcmSnapshot();
          return {start,playEdge,trace,credits};
        })()`);
          await writeClockShot(
            join(shotDir, `scheduled-anchor-${rate}-${kind}.json`),
            { provenance, capture: outcome },
            `scheduled-anchor-${rate}-${kind}`,
            outcome.trace
          );
          assert.ok(
            !outcome.trace.audioOverflow && !outcome.trace.eventsOverflow,
            `${kind} anchor control capture overflow`
          );
          assert.equal(
            outcome.trace.events.filter(
              (event) => event.kind === 'witness-attach'
            ).length,
            kind === 'shift-bank' ? 2 : 1,
            `${kind} used an unexpected number of anchor gates`
          );
          const injectionKind =
            kind === 'stale-epoch'
              ? 'anchor-stale-epoch-injected'
              : kind === 'held-bank' || kind === 'shift-bank'
                ? 'anchor-bank-control-injected'
                : 'anchor-carrier-control-injected';
          assert.ok(
            outcome.trace.events.some((event) => event.kind === injectionKind),
            `${kind} control did not reach the actual anchor boundary`
          );
          assert.ok(
            !outcome.trace.events.some(
              (event) =>
                event.kind === 'scheduled-pcm' &&
                event.value &&
                typeof event.value === 'object' &&
                'event' in event.value &&
                event.value.event === 'epoch'
            ),
            `${kind} admitted a media epoch`
          );
          assert.ok(
            !outcome.trace.events.some(
              (event) =>
                event.kind === 'transport-message' &&
                event.value &&
                typeof event.value === 'object' &&
                'type' in event.value &&
                event.value.type === 'anchor-certified'
            ),
            `${kind} unexpectedly certified an anchor`
          );
          if (kind === 'stale-epoch') {
            assert.ok(
              outcome.trace.events.some(
                (event) =>
                  event.kind === 'scheduled-pcm' &&
                  event.value &&
                  typeof event.value === 'object' &&
                  'event' in event.value &&
                  event.value.event === 'error'
              ),
              'stale anchor epoch was not rejected by the client'
            );
          } else if (kind === 'shift-bank') {
            assertShiftedBankRefusal(outcome.trace.events);
            assert.equal(outcome.credits.gateReservations, 0);
            assert.equal(outcome.credits.carrierReservations, 0);
          } else {
            assert.ok(
              outcome.trace.events.some(
                (event) =>
                  event.kind === 'transport-message' &&
                  event.value &&
                  typeof event.value === 'object' &&
                  'type' in event.value &&
                  event.value.type === 'clock-fault'
              ),
              `${kind} never reached native render-clock rejection`
            );
          }
          if (kind === 'truncated') {
            const witness = outcome.trace.events.find(
              (event) => event.kind === 'witness-attach'
            );
            const initial = (
              witness?.value as Record<string, unknown> | undefined
            )?.['gateInitialFrame'];
            assert.ok(
              typeof initial === 'number' && Number.isSafeInteger(initial)
            );
            assert.ok(
              outcome.trace.events.some(
                (event) =>
                  event.kind === 'transport-message' &&
                  (event.value as Record<string, unknown> | null)?.['type'] ===
                    'clock-fault' &&
                  (event.value as Record<string, unknown> | null)?.[
                    'expectedFrame'
                  ] ===
                    initial + 128
              ),
              'truncated carrier did not fail on the second anchor quantum'
            );
          }
          for (const chunk of outcome.trace.audio)
            for (const channel of chunk.channels)
              assert.ok(
                channel.every(
                  (sample) =>
                    Number.isFinite(sample) && Math.abs(sample) < 0.001
                ),
                `${kind} emitted authored PCM before anchor`
              );
          if (kind === 'missing' && outcome.trace.contextState !== 'closed')
            assert.ok(
              outcome.credits.carrierReservations >= 1 &&
                outcome.credits.bytes >= 65536 &&
                outcome.credits.nodes >= 1,
              'unended native anchor carrier released its budget'
            );
        } finally {
          await isolated.close();
        }
      }
    }
    if (rate === 44100) {
      // Nothing after this uses the shared browser at 44.1 kHz, so a rerun may take a fresh one.
      await rerunFrontierOvershoot(
        `scheduled-pcm-starvation-recovery-${rate}`,
        async (attempt) => {
          if (attempt === 1) {
            await runRecoveryProof(browser, provenance);
            return;
          }
          const fresh = await openBrowser(url, sessionToken, {
            label: `scheduled-pcm-starvation-recovery-${rate}-rerun${attempt - 1}`,
            recordProofTrace: true,
            proofSampleRate: rate,
          });
          try {
            await waitReady(fresh);
            await runRecoveryProof(
              fresh,
              await proofProvenance(fresh),
              starveAfterMs(attempt)
            );
          } finally {
            await fresh.close();
          }
        }
      );
      await runRecoveryFaults();
      await runHeldPullSequences();
      await runAnchorControls();
      return;
    }
    await seekTo(browser, 0);
    const tracks = await browser.evaluate<
      MovingTrace & { edges: number[] }
    >(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      const button = document.querySelector('button.otio-play');
      const mute = document.querySelector('[data-track-toggle="scheduled-cuts"]');
      const solo = document.querySelector('[data-track-solo="scheduled-cuts"]');
      if (!(button instanceof HTMLButtonElement) || !(mute instanceof HTMLButtonElement) || !(solo instanceof HTMLButtonElement)) throw new Error('track mute/solo controls missing');
      button.click();
      await sleep(400);
      const edges = [];
      for (const control of [mute, mute, solo, solo]) {
        edges.push(globalThis.__otioProofTrace.audioFrame());
        control.click();
        await sleep(300);
      }
      const trace = await globalThis.__otioProofTrace.stop();
      if (document.querySelector('.otio-view')?.dataset.playing === 'true') button.click();
      return {start, playEdge, trace, edges};
    })()`);
    await writeClockShot(
      join(shotDir, 'scheduled-pcm-track-controls.json'),
      { provenance, capture: tracks },
      'scheduled-pcm-track-controls',
      tracks.trace
    );
    const trackEpochs = tracks.trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>)
      .filter((event) => event['event'] === 'epoch');
    assert.equal(
      trackEpochs.length,
      1,
      'track controls restarted the scheduled epoch'
    );
    const trackF0 = Number(trackEpochs[0]!['f0']);
    const trackWitness = tracks.trace.witness;
    assert.ok(trackWitness, 'track controls lack independent carrier');
    assertCarrierIdentity(tracks.trace, 'track controls epoch');
    reportEngineFrameClock(tracks.trace, 'track controls epoch');
    associateBootstrapClock(tracks.trace, trackF0);
    for (let phase = 0; phase < 4; phase++) {
      const from = tracks.edges[phase]! + 4800;
      const to =
        (tracks.edges[phase + 1] ?? lastCarrierEnd(tracks.trace)) - 2400;
      assertPcmCoverage(from, to, tracks.trace.audio, trackWitness);
      let count = 0;
      const errors = [0, 0];
      for (const chunk of tracks.trace.audio)
        for (let i = 0; i < (chunk.channels[0]?.length ?? 0); i++) {
          const frame = carrierFrame(chunk, i, trackWitness);
          if (frame === null) continue;
          const n = frame - trackF0;
          if (frame < from || frame >= to || n < 0 || n >= length) continue;
          const t = n / unit;
          for (let ch = 0; ch < 2; ch++) {
            const cut =
              t < 30
                ? source(ch, 10 * unit + n)
                : t < 60
                  ? source(ch, 60 * unit + n - 30 * unit)
                  : 0;
            const nested = expected[ch]![n]! - cut;
            const reference =
              phase === 0 ? nested : phase === 2 ? cut : expected[ch]![n]!;
            errors[ch]! += (chunk.channels[ch]![i]! - reference) ** 2;
          }
          count++;
        }
      assert.ok(count > 0, `track control phase ${phase} has no PCM`);
      assert.ok(
        errors.every((sum) => Math.sqrt(sum / count) <= 0.003),
        `mute/solo phase ${phase} has wrong PCM`
      );
    }
    pass('scheduled-pcm-mute-solo');
    // The stages below reuse this browser, so the 48 kHz pass runs once. Its gap holds 384 + 512.
    await runRecoveryProof(browser, provenance);
    await seekTo(browser, 0);
    const interrupted = await browser.evaluate<
      MovingTrace & { held: number; released: number; releaseFrame: number }
    >(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const root = document.querySelector('.otio-view');
      const button = document.querySelector('button.otio-play');
      if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('starvation controls missing');
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      button.click();
      await sleep(600);
      globalThis.__otioProofTrace.holdPcmResponses(true);
      const deadline = performance.now() + 4000;
      while ((globalThis.__otioProofTrace.heldPcmCount() === 0 || root.dataset.buffering !== 'true') && performance.now() < deadline) await sleep(20);
      const held = globalThis.__otioProofTrace.heldPcmCount();
      if (root.dataset.playing === 'true') button.click();
      await sleep(100);
      const releaseFrame = globalThis.__otioProofTrace.audioFrame();
      const released = globalThis.__otioProofTrace.holdPcmResponses(false);
      await sleep(350);
      const trace = await globalThis.__otioProofTrace.stop();
      return {start, playEdge, trace, held, released, releaseFrame};
    })()`);
    await writeClockShot(
      join(shotDir, 'scheduled-pcm-starvation.json'),
      { provenance, capture: interrupted },
      'scheduled-pcm-starvation',
      interrupted.trace
    );
    assert.ok(
      interrupted.held > 0 && interrupted.released === interrupted.held,
      'starvation control did not withhold and release PCM'
    );
    assert.ok(
      interrupted.trace.events.some(
        (entry) =>
          entry.kind === 'buffering-change' &&
          (entry.value as { current?: string })?.current === 'true'
      ),
      'real PCM starvation did not expose buffering'
    );
    assert.ok(
      interrupted.trace.events.some(
        (entry) =>
          entry.kind === 'scheduled-pcm' &&
          (entry.value as { event?: string })?.event === 'cancel'
      ),
      'starvation did not cancel the active generation'
    );
    assertPcmSilence(
      interrupted.trace,
      interrupted.releaseFrame + 256,
      lastCarrierEnd(interrupted.trace),
      'released stale PCM produced sound after cancellation'
    );
    pass('scheduled-pcm-starvation-cancel');
    for (const action of ['seek', 'scope'] as const) {
      await seekTo(browser, 0);
      const setup = await browser.evaluate<{
        start: MovingTrace['start'];
        held: number;
        precondition: Record<string, string | null>;
        state: Record<string, string | null>;
        trace: MovingTrace['trace'] | null;
      }>(`(async () => {
        const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
        const root = document.querySelector('.otio-view'), button = document.querySelector('button.otio-play');
        if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('seek setup controls missing');
        const precondition = {playing: root.dataset.playing ?? null, frame: root.dataset.frame ?? null, buffering: root.dataset.buffering ?? null};
        if (root.dataset.playing === 'true') {
          button.click();
          const pauseDeadline = performance.now() + 3000;
          while (root.dataset.playing === 'true' && performance.now() < pauseDeadline) await sleep(10);
        }
        const start = await globalThis.__otioProofTrace.start();
        button.click();
        await sleep(500);
        globalThis.__otioProofTrace.holdPcmResponses(true);
        const deadline = performance.now() + 3000;
        while (!globalThis.__otioProofTrace.heldPcmCount() && performance.now() < deadline) await sleep(10);
        const held = globalThis.__otioProofTrace.heldPcmCount();
        const state = {playing: root.dataset.playing ?? null, frame: root.dataset.frame ?? null, buffering: root.dataset.buffering ?? null};
        if (held > 0) return {start, held, precondition, state, trace: null};
        globalThis.__otioProofTrace.holdPcmResponses(false);
        const trace = await globalThis.__otioProofTrace.stop();
        if (root.dataset.playing === 'true') button.click();
        return {start, held, precondition, state, trace};
      })()`);
      await writeClockShot(
        join(shotDir, `scheduled-${action}-setup.json`),
        { provenance, ...setup },
        `scheduled-${action}-setup`,
        setup.trace,
        setup.trace === null
          ? 'setup held PCM before stop; its clock evidence is in the cancel shot'
          : null
      );
      assert.ok(
        setup.held > 0,
        `seek/scope setup held no PCM response; precondition=${JSON.stringify(setup.precondition)} state=${JSON.stringify(setup.state)}`
      );
      const start = setup.start;
      await browser.evaluate<void>(`(() => {
        if (${JSON.stringify(action)} === 'seek') {
          const input = document.querySelector('input.otio-seek');
          const root = document.querySelector('.otio-view');
          if (!(input instanceof HTMLInputElement) || !(root instanceof HTMLElement)) throw new Error('seek control missing');
          input.value = String(30 - Number(root.dataset.domainOrigin));
          input.dispatchEvent(new Event('input', {bubbles:true}));
          input.dispatchEvent(new Event('change', {bubbles:true}));
        } else {
          const item = [...document.querySelectorAll('.otio-item')].find(node => node.dataset.itemId === 'scheduled-cut-b');
          if (!(item instanceof HTMLButtonElement)) throw new Error('scope control missing');
          item.click();
        }
      })()`);
      const outcome = await browser.evaluate<{
        trace: MovingTrace['trace'];
        released: number;
        releaseFrame: number;
        paused: {
          playing: string | null;
          frame: string | null;
          timestamp: number;
        } | null;
        resumePlayEdge: { timestamp: number } | null;
      }>(`(async () => {
        const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
        const deadline = performance.now() + 3000;
        while (!globalThis.__otioProofTrace.hasPcmCancel(${JSON.stringify(action)}) && performance.now() < deadline) await sleep(10);
        if (!globalThis.__otioProofTrace.hasPcmCancel(${JSON.stringify(action)})) throw new Error('no cancellation before stale release');
        const releaseFrame = globalThis.__otioProofTrace.audioFrame();
        const released = globalThis.__otioProofTrace.holdPcmResponses(false);
        let paused=null, resumePlayEdge=null;
        if (${JSON.stringify(action)} === 'seek') {
          const root=document.querySelector('.otio-view'), button=document.querySelector('button.otio-play');
          if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('seek replay controls missing');
          const targetDeadline=performance.now()+350;
          while ((root.dataset.playing!=='false' || Number(root.dataset.frame)!==30) && performance.now()<targetDeadline) await sleep(10);
          paused={playing:root.dataset.playing ?? null, frame:root.dataset.frame ?? null, timestamp:performance.now()};
          await sleep(100);
          resumePlayEdge=globalThis.__otioProofTrace.playRequest();
          button.click();
        }
        await sleep(500);
        const trace = await globalThis.__otioProofTrace.stop();
        const root = document.querySelector('.otio-view');
        if (root?.dataset.playing === 'true') document.querySelector('button.otio-play').click();
        return {trace, released, releaseFrame, paused, resumePlayEdge};
      })()`);
      await writeClockShot(
        join(shotDir, `scheduled-${action}-cancel.json`),
        { provenance, start, ...outcome },
        `scheduled-${action}-cancel`,
        outcome.trace
      );
      assert.ok(
        outcome.released > 0,
        `${action} did not release a stale response`
      );
      const events = outcome.trace.events
        .filter((entry) => entry.kind === 'scheduled-pcm')
        .map((entry) => entry.value as Record<string, unknown>);
      const cancellation = events.findIndex(
        (event) => event['event'] === 'cancel' && event['reason'] === action
      );
      assert.ok(
        cancellation >= 0,
        `${action} did not cancel its prior generation`
      );
      const generation = events[cancellation]!['generation'];
      assert.ok(
        !events
          .slice(cancellation + 1)
          .some(
            (event) =>
              event['event'] === 'scheduled' &&
              event['generation'] === generation
          ),
        `${action} accepted a stale PCM result after cancellation`
      );
      const nextEpoch = events
        .slice(cancellation + 1)
        .find((event) => event['event'] === 'epoch');
      if (action === 'seek') {
        assert.ok(
          outcome.paused?.playing === 'false' &&
            Number(outcome.paused.frame) === 30,
          'UI seek did not settle paused at the selected frame'
        );
        assert.ok(
          outcome.resumePlayEdge,
          'explicit replay request was not captured'
        );
        assert.ok(
          !events
            .slice(cancellation + 1)
            .some(
              (event) =>
                event['event'] === 'epoch' &&
                Number(event['wallMs']) < outcome.resumePlayEdge!.timestamp
            ),
          'paused UI seek resumed before the user requested playback'
        );
        assert.ok(
          nextEpoch,
          'explicit play after paused seek did not produce a replacement epoch'
        );
        assert.notEqual(
          nextEpoch['generation'],
          generation,
          'seek replay reused the canceled generation'
        );
        const origin = nextEpoch['compositionT0'] as {
          value: number;
          rate: number;
        };
        const sourceSample = (origin.value * oracle.sample_rate) / origin.rate;
        assert.equal(
          sourceSample,
          30 * unit,
          'seek replay did not retain the requested composition sample'
        );
        const bridge = nextEpoch['bridge'] as {
          contextTime: number;
          performanceTime: number;
        };
        const outputStart =
          bridge.performanceTime +
          (Number(nextEpoch['c0']) - bridge.contextTime) * 1000;
        assert.ok(
          Number.isFinite(outputStart) &&
            outputStart >= outcome.resumePlayEdge.timestamp &&
            outputStart - outcome.resumePlayEdge.timestamp <= 350,
          'seek replay missed the original explicit play-request budget'
        );
        const reference = compareScheduledPcm(
          outcome.trace.audio,
          Number(nextEpoch['f0']) - sourceSample,
          expected,
          sourceSample,
          sourceSample + 960,
          outcome.trace.witness
        );
        assert.ok(
          reference.rmse.every((value) => value <= 0.003),
          'seek replay changed or skipped the requested source PCM prefix'
        );
      } else {
        assert.equal(
          nextEpoch,
          undefined,
          'scope replacement unexpectedly resumed'
        );
      }
      const nextFrame = nextEpoch
        ? Number(nextEpoch['f0'])
        : lastCarrierEnd(outcome.trace);
      assert.ok(
        Number.isSafeInteger(nextFrame),
        `${action} has no integral observation boundary`
      );
      const quietStart = outcome.releaseFrame + 256;
      assert.ok(
        nextFrame > quietStart,
        `${action} left no observation window for stale output`
      );
      assertPcmSilence(
        outcome.trace,
        quietStart,
        nextFrame,
        `${action} stale response produced audible PCM`
      );
      if (action === 'scope') await leaveFocus(browser);
    }
    pass('scheduled-pcm-seek-scope-cancel');
    await seekTo(browser, 0);
    const failure = await browser.evaluate<
      MovingTrace & { playing: string; diagnostic: string }
    >(`(async () => {
      const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
      const start = await globalThis.__otioProofTrace.start();
      const playEdge = globalThis.__otioProofTrace.playRequest();
      document.querySelector('button.otio-play').click();
      await sleep(500);
      globalThis.__otioProofTrace.failNextPcm();
      await sleep(1800);
      const trace = await globalThis.__otioProofTrace.stop();
      const root = document.querySelector('.otio-view');
      const playing = root?.dataset.playing ?? '';
      const diagnostic = Array.from(document.querySelectorAll('.otio-diagnostic')).map(node => node.textContent ?? '').join(' ');
      if (root?.dataset.playing === 'true') document.querySelector('button.otio-play').click();
      return {start, playEdge, trace, playing, diagnostic};
    })()`);
    await writeClockShot(
      join(shotDir, 'scheduled-pcm-terminal-failure.json'),
      { provenance, capture: failure },
      'scheduled-pcm-terminal-failure',
      failure.trace
    );
    const failureEvents = failure.trace.events
      .filter((entry) => entry.kind === 'scheduled-pcm')
      .map((entry) => entry.value as Record<string, unknown>);
    const providerErrorIndex = failureEvents.findIndex(
      (event) => event['event'] === 'error' && event['stage'] === 'provider'
    );
    assert.ok(
      providerErrorIndex >= 0,
      'injected worker failure did not produce a provider error'
    );
    const providerGeneration = failureEvents[providerErrorIndex]!['generation'];
    assert.ok(
      providerGeneration !== undefined,
      'provider error has no generation'
    );
    const providerClosure = failureEvents
      .slice(providerErrorIndex + 1)
      .find(
        (event) =>
          event['event'] === 'gate-close' &&
          event['generation'] === providerGeneration
      );
    assert.ok(
      providerClosure,
      'provider failure did not acknowledge closure of its generation'
    );
    const providerBoundary = Number(providerClosure['contextStopFrame']);
    assert.ok(
      Number.isSafeInteger(providerBoundary),
      'provider gate has no render-frame boundary'
    );
    const finalProviderChunk = failure.trace.audio.at(-1);
    assert.ok(
      finalProviderChunk?.channels[0] && finalProviderChunk.channels[1],
      'provider capture lacks stereo PCM'
    );
    const providerEnd = lastCarrierEnd(failure.trace);
    assert.ok(
      providerEnd > providerBoundary,
      'provider capture ends before the gate boundary'
    );
    assertPcmSilence(
      failure.trace,
      providerBoundary,
      providerEnd,
      'provider emitted PCM after gate closure'
    );
    assert.equal(
      failure.playing,
      'false',
      'terminal provider failure left playback active'
    );
    assert.match(
      failure.diagnostic,
      /Scheduled audio stopped:/,
      'provider failure was not visible to the reader'
    );
    assert.ok(
      !failureEvents.some(
        (event) => event['event'] === 'backend' && event['backend'] === 'native'
      ),
      'terminal provider failure silently switched backend'
    );
    pass('scheduled-pcm-terminal-failure');
    for (const stage of ['schedule', 'clock'] as const) {
      await seekTo(browser, 0);
      const fault = await browser.evaluate<
        MovingTrace & { playing: string; diagnostic: string }
      >(`(async () => {
        const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
        const root = document.querySelector('.otio-view');
        const button = document.querySelector('button.otio-play');
        if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('fault controls missing');
        const start = await globalThis.__otioProofTrace.start();
        const playEdge = globalThis.__otioProofTrace.playRequest();
        button.click();
        await sleep(500);
        if (${JSON.stringify(stage)} === 'schedule') globalThis.__otioProofTrace.failNextSourceStart();
        else globalThis.__otioProofTrace.setInvalidControllerClock(true);
        await sleep(1500);
        globalThis.__otioProofTrace.setInvalidControllerClock(false);
        const trace = await globalThis.__otioProofTrace.stop();
        const playing = root.dataset.playing ?? '';
        const diagnostic = Array.from(document.querySelectorAll('.otio-diagnostic')).map(node => node.textContent ?? '').join(' ');
        if (root.dataset.playing === 'true') button.click();
        return {start, playEdge, trace, playing, diagnostic};
      })()`);
      await writeFile(
        join(shotDir, `scheduled-pcm-${stage}-failure.json`),
        JSON.stringify({
          provenance,
          capture: fault,
          clockAudit: auditClockEvidence(fault.trace),
        })
      );
      assertClockAudit(auditClockEvidence(fault.trace), `${stage} fault`);
      const faultEvents = fault.trace.events
        .filter((entry) => entry.kind === 'scheduled-pcm')
        .map((entry) => entry.value as Record<string, unknown>);
      assert.ok(
        faultEvents.some((event) => event['event'] === 'epoch'),
        `${stage} fault occurred before playback epoch`
      );
      if (stage === 'schedule')
        assert.ok(
          fault.trace.events.some(
            (entry) => entry.kind === 'source-start-fault'
          ),
          'scheduled node fault was not injected'
        );
      const errorIndex = faultEvents.findIndex(
        (event) => event['event'] === 'error' && event['stage'] === stage
      );
      assert.ok(errorIndex >= 0, `${stage} failure was not reported`);
      const failedGeneration = faultEvents[errorIndex]!['generation'];
      assert.ok(
        failedGeneration !== undefined,
        `${stage} error has no generation`
      );
      const closure = faultEvents
        .slice(errorIndex + 1)
        .find(
          (event) =>
            event['event'] === 'gate-close' &&
            event['generation'] === failedGeneration
        );
      assert.ok(
        closure,
        `${stage} failure did not acknowledge the failing generation gate closure`
      );
      const boundary = Number(closure['contextStopFrame']);
      assert.ok(
        Number.isSafeInteger(boundary),
        `${stage} gate has no render-frame boundary`
      );
      const end = fault.trace.audio.at(-1);
      assert.ok(
        end?.channels[0] && end.channels[1],
        `${stage} capture lacks stereo PCM`
      );
      const endFrame = lastCarrierEnd(fault.trace);
      assert.ok(
        endFrame > boundary,
        `${stage} capture ends before the gate boundary`
      );
      assertPcmSilence(
        fault.trace,
        boundary,
        endFrame,
        `${stage} emitted PCM after gate closure`
      );
      assert.equal(
        fault.playing,
        'false',
        `${stage} failure left playback active`
      );
      assert.match(
        fault.diagnostic,
        /Scheduled audio stopped:/,
        `${stage} failure was not visible`
      );
      assert.ok(
        !faultEvents.some(
          (event) =>
            event['event'] === 'backend' && event['backend'] === 'native'
        ),
        `${stage} failure silently switched backend`
      );
    }
    await runRecoveryFaults();
    await runHeldPullSequences();
    await runAnchorControls();
    for (const kind of ['hold', 'wrong-tag'] as const) {
      const isolated = await openBrowser(url, sessionToken, {
        label: `scheduled-clock-${kind}`,
        recordProofTrace: true,
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const fault = await isolated.evaluate<
          MovingTrace & { injected: unknown }
        >(`(async () => {
          const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
          const root = document.querySelector('.otio-view');
          const button = document.querySelector('button.otio-play');
          if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('missing controls');
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click();
          await sleep(600);
          await globalThis.__otioProofTrace.awaitClockTraceReady(8000);
          globalThis.__otioProofTrace.clockTrace('start');
          await sleep(100);
          const injected = globalThis.__otioProofTrace.corruptClock(${JSON.stringify(kind)});
          await sleep(500);
          const trace = await globalThis.__otioProofTrace.stop();
          if (root.dataset.playing === 'true') button.click();
          return {start, playEdge, trace, injected};
        })()`);
        await writeFile(
          join(shotDir, `scheduled-clock-${kind}.json`),
          JSON.stringify({
            provenance,
            capture: fault,
            clockAudit: auditClockEvidence(fault.trace),
          })
        );
        assert.ok(
          fault.injected &&
            !fault.trace.audioOverflow &&
            !fault.trace.eventsOverflow,
          `${kind} control was not injected or its capture overflowed`
        );
        assertClockAudit(
          auditClockEvidence(fault.trace),
          `scheduled-clock-${kind}`
        );
        const failure = fault.trace.events.find(
          (entry) =>
            entry.kind === 'transport-message' &&
            entry.value &&
            typeof entry.value === 'object' &&
            'type' in entry.value &&
            entry.value.type === 'clock-fault'
        );
        assert.ok(
          failure?.value &&
            typeof failure.value === 'object' &&
            'expectedFrame' in failure.value &&
            Number.isSafeInteger(failure.value.expectedFrame),
          `${kind} did not reach a render-thread clock fault`
        );
        const boundary = Number(failure.value.expectedFrame);
        const witness = fault.trace.witness;
        assert.ok(witness, `${kind} carrier missing`);
        const margin = Math.floor(fault.trace.sampleRate / 10);
        assertIndependentCarrier(
          fault.trace,
          boundary - margin,
          boundary + margin
        );
        let beforeEnergy = 0,
          beforeCount = 0,
          afterCount = 0;
        for (const chunk of fault.trace.audio)
          for (let i = 0; i < chunk.channels[0]!.length; i++) {
            const frame = carrierFrame(chunk, i, witness);
            if (frame === null) continue;
            if (frame >= boundary - margin && frame < boundary - 128) {
              beforeEnergy +=
                chunk.channels[0]![i]! ** 2 + chunk.channels[1]![i]! ** 2;
              beforeCount += 2;
            }
            if (frame >= boundary && frame < boundary + margin) {
              assert.ok(
                Math.abs(chunk.channels[0]![i]!) < 0.001 &&
                  Math.abs(chunk.channels[1]![i]!) < 0.001,
                `${kind} emitted PCM after clock fault`
              );
              afterCount++;
            }
          }
        assert.ok(
          beforeCount > 0 && beforeEnergy / beforeCount > 1e-8,
          `${kind} had no audible prefix`
        );
        assert.equal(
          afterCount,
          margin,
          `${kind} silent fault suffix incomplete`
        );
      } finally {
        await isolated.close();
      }
    }
    for (const kind of [
      'withhold',
      'late-install',
      'late-origin',
      'late-arm',
      'stale-serial',
      'delay-ack',
    ] as const) {
      const isolated = await openBrowser(url, sessionToken, {
        label: `scheduled-bank-${kind}`,
        recordProofTrace: true,
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const outcome = await isolated.evaluate<MovingTrace>(`(async () => {
          const sleep = ms => {const {promise,resolve} = Promise.withResolvers(); setTimeout(resolve,ms); return promise;};
          const button = document.querySelector('button.otio-play');
          if (!(button instanceof HTMLButtonElement)) throw new Error('bank control play button missing');
          const start = await globalThis.__otioProofTrace.start();
          globalThis.__otioProofTrace.nextClockBankControl(${JSON.stringify(kind)});
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click();
          await sleep(300);
          await globalThis.__otioProofTrace.awaitClockTraceReady(8000);
          globalThis.__otioProofTrace.clockTrace('start');
          await sleep(800);
          globalThis.__otioProofTrace.clockTrace('stop');
          await sleep(500);
          const trace = await globalThis.__otioProofTrace.stop();
          if (document.querySelector('.otio-view')?.dataset.playing === 'true') button.click();
          return {start, playEdge, trace};
        })()`);
        await writeClockShot(
          join(shotDir, `scheduled-bank-${kind}.json`),
          { provenance, capture: outcome },
          `scheduled-bank-${kind}`,
          outcome.trace
        );
        assert.ok(
          !outcome.trace.audioOverflow && !outcome.trace.eventsOverflow,
          `${kind} capture overflowed`
        );
        const injected = outcome.trace.events.find(
          (event) =>
            event.kind ===
            (kind === 'late-arm'
              ? 'clock-late-arm-injected'
              : kind === 'delay-ack'
                ? 'clock-promotion-ack-held'
                : 'clock-bank-control-injected')
        );
        assert.ok(
          injected?.value && typeof injected.value === 'object',
          `${kind} did not reach the gate command path`
        );
        const requestId =
          'requestId' in injected.value ? injected.value.requestId : undefined;
        const messages = outcome.trace.events
          .filter((event) => event.kind === 'transport-message')
          .map((event) => event.value as Record<string, unknown>);
        if (kind === 'delay-ack') {
          const released = outcome.trace.events.find(
            (event) => event.kind === 'clock-promotion-ack-released'
          );
          assert.ok(
            released?.value &&
              typeof released.value === 'object' &&
              'requestId' in released.value &&
              released.value.requestId === requestId &&
              released.timestamp > injected.timestamp,
            'delayed promotion acknowledgment was not released'
          );
          assert.ok(
            'retired' in injected.value &&
              injected.value.retired &&
              typeof injected.value.retired === 'object' &&
              'endFrame' in injected.value.retired &&
              Number.isSafeInteger(injected.value.retired.endFrame),
            'retired bank boundary missing'
          );
          const oldCoverage = Number(injected.value.retired.endFrame) - 2048;
          for (const event of outcome.trace.events) {
            if (
              event.kind !== 'transport-command' ||
              event.timestamp < injected.timestamp ||
              event.timestamp >= released.timestamp ||
              !event.value ||
              typeof event.value !== 'object' ||
              !('type' in event.value) ||
              (event.value.type !== 'arm' && event.value.type !== 'extend')
            )
              continue;
            assert.ok(
              'throughFrame' in event.value &&
                Number(event.value.throughFrame) <= oldCoverage,
              'pending promotion acknowledgment expanded media coverage'
            );
          }
          assert.ok(
            messages.some(
              (message) =>
                message?.['type'] === 'clock-promoted' &&
                message['requestId'] === requestId
            ),
            'released promotion was not observed'
          );
        } else if (kind === 'late-arm') {
          assert.ok(
            outcome.trace.events.some(
              (event) => event.kind === 'clock-late-arm-submitted'
            ),
            'late arm was not submitted'
          );
          assert.ok(
            messages.some(
              (message) =>
                message?.['type'] === 'arm' &&
                message['accepted'] === false &&
                message['reason'] === 'invalid or late arm'
            ),
            'late arm was not rejected by the render gate'
          );
          for (const chunk of outcome.trace.audio)
            for (const channel of chunk.channels)
              assert.ok(
                channel.every(
                  (sample) =>
                    Number.isFinite(sample) && Math.abs(sample) < 0.001
                ),
                'late arm emitted audio'
              );
        } else if (kind === 'stale-serial') {
          assert.ok(
            outcome.trace.events.some(
              (event) => event.kind === 'clock-stale-serial-submitted'
            ),
            'stale serial was not submitted'
          );
          assert.ok(
            messages.some(
              (message) =>
                message?.['type'] === 'bank-rejected' &&
                message['requestId'] === requestId
            ),
            'stale serial was not rejected'
          );
        } else if (kind === 'late-install') {
          assert.ok(
            outcome.trace.events.some(
              (event) => event.kind === 'clock-bank-late-submitted'
            ),
            'late installation was not submitted'
          );
          assert.ok(
            messages.some(
              (message) =>
                message?.['type'] === 'bank-rejected' &&
                message['requestId'] === requestId
            ),
            'late installation was not rejected'
          );
        } else if (kind === 'withhold') {
          const closed = messages.find(
            (message) =>
              message?.['type'] === 'closed' &&
              message['accepted'] === true &&
              Number.isSafeInteger(message['closedFrame'])
          );
          assert.ok(
            closed,
            'withheld renewal did not close at its committed frontier'
          );
          const scheduledEpoch = outcome.trace.events.find(
            (event) =>
              event.kind === 'scheduled-pcm' &&
              event.value &&
              typeof event.value === 'object' &&
              'event' in event.value &&
              event.value.event === 'epoch'
          );
          assert.ok(
            scheduledEpoch?.value &&
              typeof scheduledEpoch.value === 'object' &&
              'f0' in scheduledEpoch.value,
            'withheld renewal has no scheduled epoch'
          );
          const startFrame = Number(scheduledEpoch.value.f0),
            closeFrame = Number(closed['closedFrame']);
          const prefixLength = closeFrame - startFrame,
            witness = outcome.trace.witness;
          assert.ok(
            witness &&
              Number.isSafeInteger(prefixLength) &&
              prefixLength > 0 &&
              prefixLength <= length,
            'invalid withheld frontier'
          );
          const margin = Math.floor(outcome.trace.sampleRate / 10);
          assertIndependentCarrier(
            outcome.trace,
            startFrame,
            closeFrame + margin
          );
          const prefix = compareScheduledPcm(
            outcome.trace.audio,
            startFrame,
            expected,
            0,
            prefixLength,
            witness
          );
          assert.ok(
            prefix.rmse.every((value) => value <= 0.003),
            'withheld frontier lost or changed source samples'
          );
          let suffix = 0;
          for (const chunk of outcome.trace.audio)
            for (let i = 0; i < chunk.channels[0]!.length; i++) {
              const frame = carrierFrame(chunk, i, witness);
              if (
                frame !== null &&
                frame >= closeFrame &&
                frame < closeFrame + margin
              ) {
                assert.ok(
                  Math.abs(chunk.channels[0]![i]!) < 0.001 &&
                    Math.abs(chunk.channels[1]![i]!) < 0.001,
                  'withheld frontier emitted a suffix'
                );
                suffix++;
              }
            }
          assert.equal(suffix, margin, 'withheld frontier suffix not captured');
        } else {
          assert.ok(
            messages.some((message) => message?.['type'] === 'clock-fault'),
            'late-origin ramp was not rejected by the render gate'
          );
          const failed = messages.find(
            (message) =>
              message?.['type'] === 'clock-trace' &&
              message['certifiedFrame'] === null &&
              message['warming']
          );
          assert.ok(failed, 'late-origin ramp did not reach a traced handoff');
          const active = failed['active'] as {
            bank: number;
            startFrame: number;
          };
          const warming = failed['warming'] as {
            bank: number;
            startFrame: number;
            serial: number;
          };
          const a = failed[active.bank === 0 ? 'clockFrameA' : 'clockFrameB'];
          const b = failed[warming.bank === 0 ? 'clockFrameA' : 'clockFrameB'];
          const tag = failed[warming.bank === 0 ? 'clockTagA' : 'clockTagB'];
          assert.ok(
            Array.isArray(a) &&
              Array.isArray(b) &&
              Array.isArray(tag) &&
              b.length >= 2 &&
              b[1] - b[0] === 1 &&
              tag[0] === warming.serial &&
              active.startFrame + Math.round(a[0]) !==
                warming.startFrame + Math.round(b[0]),
            'late-origin control lacked locally advancing, wrong-origin native evidence'
          );
        }
      } finally {
        await isolated.close();
      }
    }
    {
      const isolated = await openBrowser(url, sessionToken, {
        label: 'scheduled-clock-serial-exhaustion',
        recordProofTrace: true,
        proofSampleRate: 48000,
        proofSerialExhaustion: true,
      });
      try {
        await waitReady(isolated);
        const outcome = await isolated.evaluate<MovingTrace>(`(async () => {
          const sleep = ms => {const {promise,resolve} = Promise.withResolvers(); setTimeout(resolve,ms); return promise;};
          const button = document.querySelector('button.otio-play');
          if (!(button instanceof HTMLButtonElement)) throw new Error('serial proof play button missing');
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click(); await sleep(600);
          await globalThis.__otioProofTrace.awaitClockTraceReady(8000);
          globalThis.__otioProofTrace.clockTrace('start');
          await sleep(400);
          globalThis.__otioProofTrace.clockTrace('stop');
          await sleep(700);
          const trace = await globalThis.__otioProofTrace.stop();
          if (document.querySelector('.otio-view')?.dataset.playing === 'true') button.click();
          return {start, playEdge, trace};
        })()`);
        await writeClockShot(
          join(shotDir, 'scheduled-clock-serial-exhaustion.json'),
          { provenance, capture: outcome },
          'scheduled-clock-serial-exhaustion',
          outcome.trace
        );
        const messages = outcome.trace.events
          .filter((event) => event.kind === 'transport-message')
          .map((event) => event.value as Record<string, unknown>);
        assert.ok(
          outcome.trace.events.some(
            (event) =>
              event.kind === 'scheduled-pcm' &&
              event.value &&
              typeof event.value === 'object' &&
              'event' in event.value &&
              event.value.event === 'clock-renewal-unavailable'
          ),
          'exhausted serial did not reject renewal'
        );
        assert.ok(
          !outcome.trace.events.some(
            (event) =>
              event.kind === 'transport-command' &&
              event.value &&
              typeof event.value === 'object' &&
              'type' in event.value &&
              event.value.type === 'install-bank'
          ),
          'exhausted serial attempted or wrapped a bank installation'
        );
        assert.ok(
          messages.some((message) => {
            if (message?.['type'] !== 'clock-trace') return false;
            const active = message['active'];
            return (
              !!active &&
              typeof active === 'object' &&
              'serial' in active &&
              active.serial === 2 ** 24 - 1 &&
              message['certifiedFrame'] !== null
            );
          }),
          'maximum serial did not render under the actual gate'
        );
        const closed = messages.find(
          (message) =>
            message?.['type'] === 'closed' &&
            message['accepted'] === true &&
            Number.isSafeInteger(message['closedFrame'])
        );
        const epoch = outcome.trace.events.find(
          (event) =>
            event.kind === 'scheduled-pcm' &&
            event.value &&
            typeof event.value === 'object' &&
            'event' in event.value &&
            event.value.event === 'epoch'
        );
        assert.ok(
          closed &&
            epoch?.value &&
            typeof epoch.value === 'object' &&
            'f0' in epoch.value &&
            outcome.trace.witness,
          'exhausted session lacks a committed prefix and closure'
        );
        const f0 = Number(epoch.value.f0),
          end = Number(closed['closedFrame']);
        assert.ok(
          end > f0 && end - f0 <= length,
          'invalid exhausted clock frontier'
        );
        assertIndependentCarrier(outcome.trace, f0, end);
        const prefix = compareScheduledPcm(
          outcome.trace.audio,
          f0,
          expected,
          0,
          end - f0,
          outcome.trace.witness
        );
        assert.ok(
          prefix.rmse.every((value) => value <= 0.003),
          'exhausted clock lost committed PCM'
        );
        const margin = Math.floor(outcome.trace.sampleRate / 10);
        assertIndependentCarrier(outcome.trace, end, end + margin);
        let silent = 0;
        for (const chunk of outcome.trace.audio)
          for (let i = 0; i < chunk.channels[0]!.length; i++) {
            const frame = carrierFrame(chunk, i, outcome.trace.witness);
            if (frame !== null && frame >= end && frame < end + margin) {
              assert.ok(
                Math.abs(chunk.channels[0]![i]!) < 0.001 &&
                  Math.abs(chunk.channels[1]![i]!) < 0.001,
                'exhausted clock emitted beyond frontier'
              );
              silent++;
            }
          }
        assert.equal(
          silent,
          margin,
          'exhausted clock silent suffix incomplete'
        );
      } finally {
        await isolated.close();
      }
    }
    {
      const isolated = await openBrowser(url, sessionToken, {
        label: 'borrowed-failed-retirement',
        recordProofTrace: true,
        proofBorrowed: 'lease',
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const result = await isolated.evaluate<
          MovingTrace & {
            prepareError: string | null;
            before: {
              nodes: number;
              bytes: number;
              gateReservations: number;
              activeSession: boolean;
            };
            after: {
              nodes: number;
              bytes: number;
              gateReservations: number;
              activeSession: boolean;
              otherGateReservations: number;
            };
          }
        >(`(async () => {
          const sleep = ms => {const {promise,resolve} = Promise.withResolvers(); setTimeout(resolve,ms); return promise;};
          await globalThis.__otioProofTrace.resumeBorrowed();
          const button = document.querySelector('button.otio-play');
          if (!(button instanceof HTMLButtonElement)) throw new Error('retirement proof play button missing');
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click(); await sleep(700);
          const before = globalThis.__otioProofPcmSnapshot();
          globalThis.__otioProofTrace.withholdRetirement();
          let prepareError = null;
          try { await globalThis.__otioProofBorrowedAudio.controller.prepareAudioContextChange(); }
          catch (error) { prepareError = String(error); }
          await sleep(300);
          const after = globalThis.__otioProofPcmSnapshot();
          const trace = await globalThis.__otioProofTrace.stop();
          return {start, playEdge, trace, before, after, prepareError};
        })()`);
        await writeClockShot(
          join(shotDir, 'borrowed-failed-retirement.json'),
          { provenance, capture: result },
          'borrowed-failed-retirement',
          result.trace
        );
        assert.equal(
          result.prepareError,
          null,
          'preparing the borrowed audio context failed'
        );
        assert.ok(
          result.before.activeSession && result.before.gateReservations >= 1,
          'retirement control did not begin with an active gate reservation'
        );
        assert.ok(
          result.trace.events.some(
            (event) => event.kind === 'clock-dispose-withheld'
          ),
          'retirement control did not withhold the actual dispose command'
        );
        assert.ok(
          !result.after.activeSession &&
            result.after.otherGateReservations >= 1 &&
            result.after.gateReservations >= 1 &&
            result.after.nodes >= 2 &&
            result.after.bytes >= 32768,
          'unacknowledged gate retirement released its resource credits'
        );
      } finally {
        await isolated.close();
      }
    }
    for (const ownership of ['lease', 'no-lease'] as const) {
      const isolated = await openBrowser(url, sessionToken, {
        label: `borrowed-context-${ownership}`,
        recordProofTrace: true,
        proofBorrowed: ownership,
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const result = await isolated.evaluate<
          MovingTrace & {
            lifecycle: {
              state: string;
              before: number;
              after: number;
              events: Array<{ name: string; actor: string }>;
            };
          }
        >(`(async () => {
          const sleep = ms => {const {promise,resolve} = Promise.withResolvers(); setTimeout(resolve,ms); return promise;};
          await globalThis.__otioProofTrace.resumeBorrowed();
          const button = document.querySelector('button.otio-play');
          if (!(button instanceof HTMLButtonElement)) throw new Error('borrowed proof play button missing');
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click(); await sleep(1500);
          const trace = await globalThis.__otioProofTrace.stop();
          const lifecycle = await globalThis.__otioProofTrace.disposeBorrowed();
          return {start, playEdge, trace, lifecycle};
        })()`);
        const noLeaseViolations =
          ownership === 'no-lease'
            ? noLeaseClockViolations(result.trace.events)
            : null;
        const clockAudit = await writeClockShot(
          join(shotDir, `borrowed-context-${ownership}.json`),
          { provenance, capture: result, noLeaseViolations },
          `borrowed-context-${ownership}`,
          result.trace,
          ownership === 'no-lease' ? BORROWED_NO_LEASE_NO_CLOCK : null
        );
        assert.equal(
          result.lifecycle.state,
          'running',
          `${ownership} borrowed context was stopped`
        );
        assert.ok(
          result.lifecycle.after > result.lifecycle.before,
          `${ownership} borrowed context did not remain usable`
        );
        assert.ok(
          !result.lifecycle.events.some((event) => event.name === 'close'),
          `${ownership} borrowed context was closed`
        );
        assert.ok(
          !result.lifecycle.events.some(
            (event) => event.name === 'suspend' && event.actor !== 'lease'
          ),
          `${ownership} borrowed context was suspended without its owner's lease`
        );
        const backends = result.trace.events
          .filter(
            (event) =>
              event.kind === 'scheduled-pcm' &&
              event.value &&
              typeof event.value === 'object' &&
              'event' in event.value &&
              event.value.event === 'backend'
          )
          .map((event) => event.value as Record<string, unknown>);
        if (ownership === 'no-lease') {
          assert.ok(
            !result.lifecycle.events.some((event) => event.name === 'suspend'),
            'no-lease context was suspended'
          );
          assert.deepEqual(
            noLeaseViolations,
            [],
            'no-lease clock premise failed'
          );
          assert.ok(
            result.trace.events.some(
              (entry) => entry.kind === 'play' && entry.mediaType === 'AUDIO'
            ),
            'no-lease native compatibility did not play an audio element'
          );
          assert.ok(
            result.trace.audio
              .flatMap((chunk) => chunk.channels[0] ?? [])
              .some((value) => Math.abs(value) > 0.001),
            'no-lease native compatibility output was silent'
          );
          assert.ok(
            !result.trace.audioOverflow && !result.trace.eventsOverflow,
            'no-lease trace overflow'
          );
        } else {
          assert.ok(
            clockAudit.nativeReads > 0 && clockAudit.noDataReason === null,
            'owner-leased borrowed context recorded no native clock read'
          );
          assert.ok(
            result.lifecycle.events.some((event) => event.name === 'acquire') &&
              result.lifecycle.events.some((event) => event.name === 'release'),
            'borrowed owner lease was not acquired and released'
          );
          assert.ok(
            !result.lifecycle.events.some((event) => event.name === 'suspend'),
            'running owner-leased context was suspended'
          );
          assert.ok(
            backends.some((backend) => backend['backend'] === 'pcm'),
            'owner-leased context did not select scheduled PCM'
          );
          const epoch = result.trace.events.find(
            (event) =>
              event.kind === 'scheduled-pcm' &&
              event.value &&
              typeof event.value === 'object' &&
              'event' in event.value &&
              event.value.event === 'epoch'
          );
          assert.ok(
            epoch?.value &&
              typeof epoch.value === 'object' &&
              'f0' in epoch.value &&
              result.trace.witness,
            'owner-leased scheduled epoch or carrier missing'
          );
          const boundary = Number(epoch.value.f0);
          assertIndependentCarrier(result.trace, boundary, boundary + 960);
          const prefix = compareScheduledPcm(
            result.trace.audio,
            boundary,
            expected,
            0,
            960,
            result.trace.witness
          );
          assert.ok(
            prefix.rmse.every((value) => value <= 0.003),
            'owner-leased context changed source PCM'
          );
        }
      } finally {
        await isolated.close();
      }
    }
    {
      // Refuse the leased bootstrap at its anchor after resume. The owner
      // receives its context suspended before the failed lease is released.
      const isolated = await openBrowser(url, sessionToken, {
        label: 'borrowed-bootstrap-restore',
        recordProofTrace: true,
        proofBorrowed: 'lease',
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const provenance = await proofProvenance(isolated);
        const button = await isolated.evaluate<{
          x: number;
          y: number;
        }>(`(() => {
          const control = document.querySelector('button.otio-play');
          if (!(control instanceof HTMLButtonElement)) throw new Error('bootstrap restore play control missing');
          const rect = control.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        const armed = await isolated.evaluate<{
          start: { contextState: string };
          playEdge: { timestamp: number };
        }>(`(async () => {
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          globalThis.__otioProofTrace.nextAnchorControl('source-offset');
          return { start, playEdge };
        })()`);
        assert.equal(
          armed.start.contextState,
          'suspended',
          'bootstrap restore context was not fresh and suspended before the click'
        );
        await clickWithRealPointer(isolated, button.x, button.y);
        const settled = Promise.withResolvers<void>();
        setTimeout(settled.resolve, 2500);
        await settled.promise;
        const outcome = await isolated.evaluate<{
          state: string;
          trace: MovingTrace['trace'];
        }>(`(async () => {
          const root = document.querySelector('.otio-view'), control = document.querySelector('button.otio-play');
          const context = globalThis.__otioProofBorrowedAudio?.context;
          if (!context) throw new Error('bootstrap restore context missing');
          const state = context.state;
          const trace = await globalThis.__otioProofTrace.stop();
          if (root?.dataset.playing === 'true' && control instanceof HTMLButtonElement) control.click();
          return { state, trace };
        })()`);
        const lifecycle = await isolated.evaluate<{
          state: string;
          events: Array<{ name: string; actor: string }>;
        }>(`(async () => globalThis.__otioProofTrace.disposeBorrowed())()`);
        await writeClockShot(
          join(shotDir, 'borrowed-bootstrap-restore.json'),
          { provenance, capture: { armed, outcome, lifecycle } },
          'borrowed-bootstrap-restore',
          outcome.trace
        );
        const pcm = outcome.trace.events
          .filter((event) => event.kind === 'scheduled-pcm')
          .map((event) => (event.value ?? {}) as Record<string, unknown>);
        const transport = outcome.trace.events
          .filter((event) => event.kind === 'transport-message')
          .map((event) => (event.value ?? {}) as Record<string, unknown>);
        assert.ok(
          outcome.trace.events.some(
            (event) => event.kind === 'anchor-carrier-control-injected'
          ),
          'bootstrap restore fault did not reach the anchor carrier'
        );
        assert.ok(
          transport.some((message) => message['type'] === 'clock-fault') &&
            !transport.some(
              (message) => message['type'] === 'anchor-certified'
            ),
          'bootstrap restore clock was not refused before anchor certification'
        );
        assert.ok(
          !pcm.some((value) => value['event'] === 'epoch') &&
            pcm.some(
              (value) =>
                value['event'] === 'error' &&
                String(value['code'] ?? '').startsWith(
                  'PCM preparation failed:'
                )
            ),
          'bootstrap restore did not fail inside the leased clock bootstrap'
        );
        assert.equal(
          pcm.filter((value) => value['event'] === 'borrowed-context-restored')
            .length,
          1,
          'borrowed context restore was not reported exactly once'
        );
        assert.ok(
          !pcm.some(
            (value) => value['event'] === 'borrowed-context-restore-failed'
          ),
          'borrowed context restore failed'
        );
        const leaseIndex = (name: string) =>
          lifecycle.events.findIndex(
            (event) => event.name === name && event.actor === 'lease'
          );
        const acquired = leaseIndex('acquire');
        const resumed = leaseIndex('resume');
        const suspended = leaseIndex('suspend');
        const released = leaseIndex('release');
        assert.ok(
          acquired >= 0 &&
            resumed > acquired &&
            suspended > resumed &&
            released > suspended,
          `bootstrap restore lease order was ${lifecycle.events
            .map((event) => `${event.name}:${event.actor}`)
            .join(' ')}`
        );
        assert.ok(
          !lifecycle.events.some(
            (event) => event.name === 'suspend' && event.actor !== 'lease'
          ),
          "bootstrap restore context was suspended without its owner's lease"
        );
        assert.ok(
          !lifecycle.events.some((event) => event.name === 'close'),
          'bootstrap restore context was closed'
        );
        assert.equal(
          outcome.state,
          'suspended',
          'failed bootstrap did not restore the fresh context to suspended'
        );
        pass('scheduled-pcm-bootstrap-restore');
      } finally {
        await isolated.close();
      }
    }
    // Clock-hold controls (I5), injected through the proof wrapper after playback is steady.
    // An 86 us context hold is sub-resolution and must play through. A 200 us context hold and a
    // performance-only hold must interrupt with partial-advance. Each injected read is marked
    // injected, so the audit still certifies every native read and every bridge.
    for (const control of [
      { label: 'clock-hold-86', hold: { deltaUs: 86 }, expect: 'playing' },
      {
        label: 'clock-hold-200',
        hold: { deltaUs: 200 },
        expect: 'partial-advance',
      },
      {
        label: 'clock-perf-only',
        hold: { perfUs: 100 },
        expect: 'partial-advance',
      },
    ]) {
      const isolated = await openBrowser(url, sessionToken, {
        label: control.label,
        recordProofTrace: true,
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const provenance = await proofProvenance(isolated);
        const fault = await isolated.evaluate<{
          start: { contextState: string };
          playEdge: { timestamp: number };
          hold: { kind: string; deltaUs: number | null; perfUs: number | null };
          trace: MovingTrace['trace'];
          playing: string;
        }>(`(async () => {
          const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
          const root = document.querySelector('.otio-view');
          const button = document.querySelector('button.otio-play');
          if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('clock hold controls missing');
          const start = await globalThis.__otioProofTrace.start();
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click();
          await sleep(800);
          const hold = globalThis.__otioProofTrace.setClockHold(${JSON.stringify(control.hold)});
          await sleep(1500);
          globalThis.__otioProofTrace.setClockHold(null);
          const trace = await globalThis.__otioProofTrace.stop();
          const playing = root.dataset.playing ?? '';
          if (root.dataset.playing === 'true') button.click();
          return {start, playEdge, hold, trace, playing};
        })()`);
        const clockAudit = auditClockEvidence(fault.trace);
        await writeFile(
          join(shotDir, `scheduled-${control.label}.json`),
          JSON.stringify({ provenance, capture: { ...fault, clockAudit } })
        );
        assert.ok(
          !fault.trace.audioOverflow && !fault.trace.eventsOverflow,
          `${control.label} capture overflowed`
        );
        assertClockAudit(clockAudit, control.label);
        assert.ok(
          clockAudit.injectedReads > 0,
          `${control.label} injected no reads`
        );
        const faultValues = fault.trace.events
          .filter((entry) => entry.kind === 'scheduled-pcm')
          .map((entry) => entry.value as Record<string, unknown>);
        const errorCodes = faultValues
          .filter((value) => value['event'] === 'error')
          .map((value) => String(value['code']));
        if (control.expect === 'playing') {
          assert.equal(
            fault.playing,
            'true',
            `${control.label} stopped playback under a sub-resolution hold`
          );
          assert.deepEqual(
            errorCodes,
            [],
            `${control.label} faulted: ${errorCodes.join(', ')}`
          );
          assert.ok(
            clockAudit.clockHolds > 0 &&
              clockAudit.holdsMatched === clockAudit.clockHolds,
            `${control.label} clock-hold events ${clockAudit.holdsMatched}/${clockAudit.clockHolds} matched recorded reads`
          );
        } else {
          assert.equal(
            fault.playing,
            'false',
            `${control.label} left playback active`
          );
          assert.ok(
            errorCodes.includes(
              `audio output clock interrupted: ${control.expect}`
            ),
            `${control.label} did not report ${control.expect}: ${errorCodes.join(', ')}`
          );
        }
      } finally {
        await isolated.close();
      }
    }
    // Per-site clock controls. A one-shot 86 us hold lands on the single read that one site makes.
    // The hold is that site clock's lastAccepted +86 us at its performanceTime, and it is held through
    // that performanceTime. The site's consumed stamp must equal lastAccepted and must be native. A
    // raw-stamp substitution makes the consumed stamp the held read, which the audit fails as used-held-read.
    // The recovery control starves PCM so the gate closes at its prepared frontier, releases held pulls only
    // after the selection, and never uses the video-withholding fault: readiness refuses within the 20 ms gap
    // before any poll could lift that fault. The hold lasts until the sink stamps again, which on a
    // 10 ms sink comes with a render burst, so the hold can spend the gap in two ways: the fresh read
    // is already past it, or the burst lands between the selection and the commit. Only those two
    // exact signatures are rerun, in a fresh browser that starves one PCM batch later, and the control
    // gets three attempts in all. Every other outcome fails.
    const captureSiteControl = async (
      control: {
        label: string;
        site: string;
        recovery: boolean;
      },
      starveMs: number
    ) => {
      const isolated = await openBrowser(url, sessionToken, {
        label: control.label,
        recordProofTrace: true,
        proofSampleRate: 48000,
      });
      try {
        await waitReady(isolated);
        const provenance = await proofProvenance(isolated);
        const fault = await isolated.evaluate<{
          armed: { site: string; kind: string; deltaUs: number | null };
          trace: MovingTrace['trace'];
          playing: string;
        }>(`(async () => {
          const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
          const root = document.querySelector('.otio-view');
          const button = document.querySelector('button.otio-play');
          if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('site hold controls missing');
          const recovery = ${JSON.stringify(control.recovery)};
          const start = await globalThis.__otioProofTrace.start();
          const armed = globalThis.__otioProofTrace.setSiteClockHold({site: ${JSON.stringify(control.site)}, deltaUs: 86});
          const playEdge = globalThis.__otioProofTrace.playRequest();
          button.click();
          await sleep(${control.recovery ? starveMs : 500});
          if (recovery) {
            globalThis.__otioProofTrace.holdPcmResponses(true);
            globalThis.__otioProofTrace.releasePcmResponsesOn('recovery-selection');
            const deadline = performance.now() + 4000;
            while (!globalThis.__otioProofTrace.hasTraceEvent('pcm-hold-release') && !globalThis.__otioProofTrace.hasPcmEvent('error') && performance.now() < deadline) await sleep(10);
          }
          await sleep(${control.recovery ? 1200 : 1500});
          const trace = await globalThis.__otioProofTrace.stop();
          const playing = root.dataset.playing ?? '';
          if (root.dataset.playing === 'true') button.click();
          return {start, armed, playEdge, trace, playing};
        })()`);
        return { provenance, fault };
      } finally {
        await isolated.close();
      }
    };
    for (const control of [
      { label: 'site-select-epoch', site: 'select-epoch', recovery: false },
      { label: 'site-commit', site: 'commit', recovery: false },
      {
        label: 'site-recovery-bridge',
        site: 'recovery-bridge',
        recovery: true,
      },
    ] as const) {
      const attempts = control.recovery ? 3 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const { provenance, fault } = await captureSiteControl(
          control,
          starveAfterMs(attempt)
        );
        const events = fault.trace.events;
        assert.ok(
          !fault.trace.audioOverflow && !fault.trace.eventsOverflow,
          `${control.label} capture overflowed`
        );
        const evidence = control.recovery
          ? (siteBridgeGapInfeasibleAfterHold(events, rate) ??
            siteBridgeCommitLeadAfterHold(events, rate))
          : null;
        if (evidence !== null) {
          // The receipt keeps this attempt's audit. The verdict is the classified signature.
          await writeClockShot(
            join(shotDir, `scheduled-${control.label}-attempt${attempt}.json`),
            { provenance, capture: fault },
            control.label,
            fault.trace
          );
          if (attempt < attempts) {
            console.log(
              `OTIO_SITE_RECOVERY_GAP_INFEASIBLE attempt=${attempt} ${evidence}`
            );
            continue;
          }
          throw new Error(
            `${control.label}: ${attempts}/${attempts} attempts hit the 20 ms gap after the hold (${evidence})`
          );
        }
        await writeClockShot(
          join(shotDir, `scheduled-${control.label}.json`),
          { provenance, capture: fault },
          control.label,
          fault.trace
        );
        assert.ok(
          !fault.trace.audioOverflow && !fault.trace.eventsOverflow,
          `${control.label} capture overflowed`
        );
        assert.equal(
          fault.playing,
          'true',
          `${control.label}: playback stopped under the one-shot hold at ${control.site}`
        );
        assert.ok(
          !events.some(
            (entry) =>
              entry.kind === 'scheduled-pcm' &&
              (entry.value as { event?: string } | null)?.event === 'error'
          ),
          `${control.label}: scheduled PCM raised an error`
        );
        const consumedAt = events.flatMap((entry, index) =>
          entry.kind === 'clock-site-hold-consumed' &&
          (entry.value as { site?: string } | null)?.site === control.site
            ? [index]
            : []
        );
        assert.ok(
          consumedAt.length >= 1,
          `${control.label}: the one-shot hold never reached a ${control.site} read`
        );
        assert.ok(
          consumedAt.length === 1,
          `${control.label}: the one-shot hold was consumed ${consumedAt.length} times`
        );
        const at = consumedAt[0]!;
        const consumedValue = events[at]!.value as Record<string, unknown>;
        const held = clockStamp(consumedValue);
        const anchor = clockStamp(consumedValue['anchor']);
        const marker = (events[at - 1]?.value ?? null) as Record<
          string,
          unknown
        > | null;
        const observed = (events[at + 1]?.value ?? null) as Record<
          string,
          unknown
        > | null;
        const markerLast = clockStamp(marker?.['lastAccepted']);
        const observedOutput = clockStamp(observed?.['output']);
        assert.ok(
          events[at - 1]?.kind === 'scheduled-pcm' &&
            marker?.['event'] === 'clock-site' &&
            marker?.['site'] === control.site &&
            marker?.['phase'] === 'read' &&
            markerLast !== null &&
            anchor !== null &&
            sameClockStamp(markerLast, anchor) &&
            events[at + 1]?.kind === 'audio-output-timestamp-observed' &&
            observed?.['injected'] === true &&
            observed?.['site'] === control.site &&
            held !== null &&
            observedOutput !== null &&
            sameClockStamp(observedOutput, held),
          `${control.label}: the hold did not land on the ${control.site} read that named its anchor`
        );
        const pcm = events
          .filter((entry) => entry.kind === 'scheduled-pcm')
          .map((entry) => entry.value as Record<string, unknown>);
        assert.ok(
          held !== null &&
            anchor !== null &&
            pcm.some((value) => {
              const stamp = clockStamp(value);
              const last = clockStamp(value['lastAccepted']);
              return (
                value['event'] === 'clock-hold' &&
                stamp !== null &&
                last !== null &&
                sameClockStamp(stamp, held) &&
                sameClockStamp(last, anchor)
              );
            }),
          `${control.label}: the ${control.site} read was not judged a held read of its last accepted pair`
        );
        assert.ok(
          pcm.some(
            (value) =>
              value['event'] === 'clock-site' &&
              value['phase'] === 'use' &&
              value['site'] === control.site
          ),
          `${control.label}: ${control.site} never reported the stamp it consumed`
        );
        if (control.recovery) {
          const payload = (index: number): Record<string, unknown> =>
            (events[index]?.value ?? {}) as Record<string, unknown>;
          const pcmAt = (index: number, name: string): boolean =>
            events[index]?.kind === 'scheduled-pcm' &&
            payload(index)['event'] === name;
          const bridgeAt = (index: number, phase: string): boolean =>
            pcmAt(index, 'clock-site') &&
            payload(index)['site'] === 'recovery-bridge' &&
            payload(index)['phase'] === phase;
          const closureAt = events.findIndex((_, index) =>
            pcmAt(index, 'recovery-render-closed')
          );
          assert.ok(
            closureAt >= 0 &&
              payload(closureAt)['descriptorReady'] === true &&
              events.findIndex(
                (_, index) => index > closureAt && bridgeAt(index, 'read')
              ) ===
                at - 1,
            `${control.label}: the PCM-hold closure was not ready before its bridge read`
          );
          const useAt = events.findIndex(
            (_, index) => index > at && bridgeAt(index, 'use')
          );
          const boundaryFrame = payload(closureAt)['boundaryFrame'];
          const selectionAt = events.findIndex(
            (_, index) =>
              index > useAt &&
              pcmAt(index, 'recovery-selection') &&
              payload(index)['boundaryFrame'] === boundaryFrame
          );
          const selectedFrame = payload(selectionAt)['f0'];
          const gapFrames = Math.floor(0.02 * rate);
          assert.ok(
            useAt >= 0 &&
              selectionAt > useAt &&
              typeof boundaryFrame === 'number' &&
              typeof selectedFrame === 'number' &&
              selectedFrame >= boundaryFrame &&
              selectedFrame <= boundaryFrame + gapFrames,
            `${control.label}: recovery never selected a successor within the 20 ms gap after the held bridge read`
          );
          assert.ok(
            !events.some(
              (_, index) =>
                index > closureAt &&
                index < selectionAt &&
                (pcmAt(index, 'recovery-clock-observation-rejected') ||
                  pcmAt(index, 'error'))
            ),
            `${control.label}: recovery refused its bridge before selecting a successor`
          );
          const releaseAt = events.flatMap((entry, index) =>
            entry.kind === 'pcm-hold-release' ? [index] : []
          );
          const release =
            releaseAt.length === 1 ? payload(releaseAt[0]!) : null;
          const released = release === null ? 0 : Number(release['released']);
          assert.ok(
            release !== null &&
              release['trigger'] === 'recovery-selection' &&
              release['triggerIndex'] === selectionAt &&
              released >= 1 &&
              releaseAt[0]! > selectionAt,
            `${control.label}: held PCM was not released at its recovery selection`
          );
        }
        break;
      }
    }
    pass('scheduled-pcm-schedule-clock-failures');
  } finally {
    await browser.close();
  }
}

try {
  await Bun.spawn(['mkdir', '-p', shotDir, mediaDir]).exited;
  if (process.env['RELIC_OTIO_INTERACTION_ONLY'] === '1') {
    const token = await createSession();
    await calibratePostGainTap(token, true);
    assert.equal(mails.length, 0, 'interaction proof emitted external mail');
    console.log('OTIO_INTERACTION_ONLY_OK');
    throw new InteractionOnlyComplete();
  }
  await assertPacketGateRejectsPlantedFrames();
  pass('packet-gate-negative-controls');
  await assertQuantizedMovingOracle();
  if (process.env['RELIC_OTIO_PACKET_ORACLE_ONLY'] === '1')
    throw new DecoderOnlyComplete();
  const sessionToken = await createSession();
  if (process.env['RELIC_OTIO_DECODER_ONLY'] === '1') {
    await runDecoderTimingProof(sessionToken);
    console.log('OTIO_DECODER_OK');
    throw new DecoderOnlyComplete();
  }
  // Real new-publish output, asserted before any composition proof: on Linux it must be
  // focus-only with its reason; on macOS it must be playable. Neither branch skips.
  await runFocusOnlyPublishCheck(
    sessionToken,
    fileURLToPath(
      new URL(
        '../../relic-format/test/fixtures/otio/scheduled-audio.otiod/',
        import.meta.url
      )
    )
  );
  const proofViewerManifest =
    process.env['RELIC_OTIO_PROOF_VIEWER_MANIFEST'] ?? '';
  if (proofViewerManifest !== '') {
    const manifest = JSON.parse(
      await readFile(proofViewerManifest, 'utf8')
    ) as {
      kind?: string;
      outdir?: string;
      landmarkCount?: number;
    };
    assert.equal(
      manifest.kind,
      'three-slot',
      'proof viewer manifest is not the three-slot build'
    );
    assert.equal(
      manifest.landmarkCount,
      1,
      'three-slot manifest does not record exactly one landmark'
    );
    assert.equal(
      String(manifest.outdir).replace(/\/$/, ''),
      viewerDist.replace(/\/$/, ''),
      'RELIC_VIEWER_DIST is not the three-slot build named by its manifest'
    );
    await runThreeSlotControl(sessionToken);
    console.log('OTIO_THREE_SLOT_OK');
    throw new DecoderOnlyComplete();
  }
  await runNativeAudioCompatibilityProof(sessionToken);
  await runScheduledPcmProof(sessionToken);
  if (clockProofMode !== 'long')
    await runScheduledPcmProof(sessionToken, 44100);
  if (clockProofMode === '') await runSixtyFpsColdProof(sessionToken, 48000);
  if (clockProofMode === '') await runRestartDuringStart(sessionToken, 48000);
  if (clockProofMode === 'long') {
    console.log('OTIO_CLOCK_LONG_OK');
    throw new DecoderOnlyComplete();
  }
  if (clockProofMode === 'focused') {
    console.log('OTIO_CLOCK_FOCUSED_OK');
    throw new DecoderOnlyComplete();
  }
  await calibratePostGainTap(sessionToken);

  // The qualification, revision and state stages below exercise the live player, which
  // only a legacy archive reaches: a new publish of this fixture carries a program the
  // viewer plays or refuses as a whole. New publishes are proven by the focus-only
  // publish check and by the separate program proof.
  const shareUrl = await publishLegacyDirectory(
    fixtureDir,
    'Relik Feature Editorial'
  );
  const relicId = new URL(shareUrl).pathname.split('/').filter(Boolean).at(-1);
  assert.ok(relicId, 'publish returned no relic_id');
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
    await assertLegacyProgramState(browser, 'qualification');
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
    const assertionRow = await canvasMiddleRow(browser);
    const canvasCenter = rowCenter(
      Uint8Array.from(assertionRow),
      assertionRow.length / 4
    );
    const toExpectedPx =
      Math.abs(canvasCenter - expectedRow.center) * expectedRow.width;
    const toClampedPx =
      Math.abs(canvasCenter - clampedRow.center) * clampedRow.width;
    if (toExpectedPx > 3 || toClampedPx < 48) {
      const receipt: Record<string, unknown> = {
        requestedTimelineFrame: negativeHead.timeline_frame,
        expectedFileFrame: negativeHead.underlying_file_frame,
        clampedFileFrame: negativeHead.clamped_file_frame,
        row: assertionRow,
        canvasCenter,
        expectedRow,
        clampedRow,
        signedExpectedSourcePixels:
          (canvasCenter - expectedRow.center) * expectedRow.width,
        signedClampedSourcePixels:
          (canvasCenter - clampedRow.center) * clampedRow.width,
      };
      const receiptPath = join(shotDir, 'negative-head-seek-failure.json');
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      try {
        receipt['stateAfterSample'] = await browser.evaluate(`(() => {
          const root = document.querySelector('.otio-view');
          const canvas = document.querySelector('canvas.otio-canvas');
          const ctx = canvas?.getContext('2d');
          return {
            root: root ? {...root.dataset} : null,
            canvas: canvas ? {width: canvas.width, height: canvas.height,
              contextLost: typeof ctx?.isContextLost === 'function' ? ctx.isContextLost() : null} : null,
            videos: Array.from(document.querySelectorAll('.otio-video-decoders video'), video => ({
              currentSrc: video.currentSrc, currentTime: video.currentTime,
              seeking: video.seeking, readyState: video.readyState,
            })),
          };
        })()`);
        const frames = [
          ...new Set(
            [
              negativeHead.underlying_file_frame - 4,
              negativeHead.underlying_file_frame - 1,
              negativeHead.underlying_file_frame,
              negativeHead.underlying_file_frame + 1,
              negativeHead.clamped_file_frame,
            ].filter((frame) => frame >= 0)
          ),
        ];
        receipt['references'] = await Promise.all(
          frames.map(async (frame) => {
            const reference = await frameRowCenter(
              join(mediaDir, negativeHead.underlying_media),
              frame
            );
            return {
              frame,
              ...reference,
              signedSourcePixels:
                (canvasCenter - reference.center) * reference.width,
            };
          })
        );
      } catch (error) {
        receipt['additionalCaptureError'] = String(error);
      }
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    assert.ok(
      toExpectedPx <= 3,
      `default canvas bar is ${toExpectedPx.toFixed(2)} source px from underlying V1 file frame ${negativeHead.underlying_file_frame}`
    );
    assert.ok(
      toClampedPx >= 48,
      `default canvas bar is ${toClampedPx.toFixed(2)} source px from clamped V2 substitute file frame ${negativeHead.clamped_file_frame}`
    );
    // Independently decode the suspected preceding frame and the expected frame.
    // These controls exercise the same row-center and distance calculation.
    const controlStale = await frameRowCenter(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.underlying_file_frame - 4
    );
    const controlExpected = await frameRowCenter(
      join(mediaDir, negativeHead.underlying_media),
      negativeHead.underlying_file_frame
    );
    assert.ok(
      Math.abs(controlStale.center - expectedRow.center) * expectedRow.width >
        3,
      'negative-head pixel oracle accepted the preceding frame'
    );
    assert.ok(
      Math.abs(controlExpected.center - expectedRow.center) *
        expectedRow.width <=
        3,
      'negative-head pixel oracle rejected the independently decoded expected frame'
    );
    assert.ok(
      Math.abs(controlExpected.center - clampedRow.center) * clampedRow.width >=
        48,
      'negative-head pixel oracle did not exclude the clamped control'
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
      // Opening a comment focuses its clip, and a focused view shows only that
      // clip's marks. Each case starts from the whole composition, reached the
      // way a reviewer returns to it.
      const focused = await browser.evaluate<boolean>(
        `Boolean(document.querySelector('.otio-view')?.dataset.scopeNodeId)`
      );
      if (focused) await leaveFocus(browser);
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
    // The resizes below shrink the timeline to a row or two. A row left at the
    // bottom of a tall timeline is clipped by any shorter one whatever the
    // viewer does, so the reviewer's row starts at the top of the timeline and
    // the viewer has to keep it there.
    const rowAtTop = await browser.evaluate<{
      rowTop: number;
      viewportTop: number;
    } | null>(`(async () => {
      const scroll = document.querySelector('.otio-timeline-scroll');
      const row = document.querySelector('.otio-selection')?.closest('.otio-track-row');
      if (!(scroll instanceof HTMLElement) || !(row instanceof HTMLElement)) return null;
      const viewportTop = () => scroll.getBoundingClientRect().top + scroll.clientTop;
      scroll.scrollTop += row.getBoundingClientRect().top - viewportTop();
      const { promise, resolve } = Promise.withResolvers();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 100);
      await promise;
      return { rowTop: row.getBoundingClientRect().top, viewportTop: viewportTop() };
    })()`);
    assert.ok(
      rowAtTop && Math.abs(rowAtTop.rowTop - rowAtTop.viewportTop) <= 1,
      `the selected row could not be scrolled to the top of the timeline: ${JSON.stringify(rowAtTop)}`
    );
    for (const [shotWidth, shotHeight] of [
      [320, 480],
      [390, 568],
      [1440, 900],
    ] as const) {
      await browser.evaluate(`(() => {
        const field = window.__otioResizeField;
        const unchanged = innerWidth === ${shotWidth} && innerHeight === ${shotHeight};
        const { promise, resolve } = Promise.withResolvers();
        let finished = false;
        const complete = (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          removeEventListener('resize', onResize);
          resolve(result);
        };
        const frames = (mode) => requestAnimationFrame(() => requestAnimationFrame(() => {
          complete({ mode, width: innerWidth, height: innerHeight,
            same: document.querySelector('.popover-composer textarea') === field,
            focused: document.activeElement === field, text: field?.value ?? '' });
        }));
        const onResize = () => {
          if (innerWidth !== ${shotWidth} || innerHeight !== ${shotHeight}) return;
          removeEventListener('resize', onResize);
          frames('resize');
        };
        const timeout = setTimeout(() => complete({ error: 'resize or render frames not observed', width: innerWidth, height: innerHeight }), 10000);
        window.__otioResizeSettled = promise;
        if (unchanged) frames('unchanged');
        else addEventListener('resize', onResize);
      })()`);
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: shotWidth,
        height: shotHeight,
        deviceScaleFactor: 1,
        mobile: shotWidth < 600,
      });
      // Force a headless paint so resize and animation-frame callbacks can run.
      await browser.screenshot(`${shotWidth}x${shotHeight}-resize-paint`);
      const settled = await browser.evaluate<{
        mode?: string;
        width: number;
        height: number;
        same?: boolean;
        focused?: boolean;
        text?: string;
        error?: string;
      }>('window.__otioResizeSettled');
      assert.equal(
        settled.error,
        undefined,
        `${shotWidth}x${shotHeight}: ${settled.error}`
      );
      assert.ok(
        settled.mode === 'resize' || settled.mode === 'unchanged',
        'resize completion has no event or unchanged-viewport proof'
      );
      assert.equal(settled.width, shotWidth);
      assert.equal(settled.height, shotHeight);
      assert.deepEqual(
        settled,
        {
          mode: settled.mode,
          width: shotWidth,
          height: shotHeight,
          same: true,
          focused: true,
          text: resizeDraft,
        },
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
  const resizeBrowser = await openBrowser(shareUrl, sessionToken, {
    label: 'resize-viewer',
  });
  try {
    await waitReady(resizeBrowser);
    await exerciseViewerResize(resizeBrowser);
    pass('resize-viewer');
  } finally {
    await resizeBrowser.close();
  }

  // A separate owned browser keeps focused playback from changing the
  // composition-mode evidence above. Both publication and comments use the
  // same loopback-only server and fresh MCP process as the rest of this path.
  let focusedCommentId = '';
  const focused = await openBrowser(shareUrl, sessionToken, {
    label: 'focused-item',
  });
  try {
    await waitReady(focused);
    await seekTo(focused, 12);
    const composition = await sampleCanvas(focused, width, height);
    await focusItem(focused, plan.comment_source.relic_id);
    await seekTo(focused, 12);
    const isolated = await sampleCanvas(focused, width, height);
    const expected = await extractFrame(
      join(mediaDir, plan.primary_media),
      36,
      width,
      height
    );
    assert.ok(
      rmse(isolated, expected) + 2 < rmse(composition, expected),
      'focused primary pixels do not exclude the composition overlay'
    );
    assert.ok(
      rmse(isolated, expected) < 12,
      'focused primary does not match decoded source frame 36'
    );
    const primary = scopedDocument.nodes[plan.comment_source.relic_id];
    assert.ok(primary?.timeline_range, 'primary focus has no editorial range');
    const primaryEnd = Math.round(
      (primary.timeline_range.start_time.value /
        primary.timeline_range.start_time.rate +
        primary.timeline_range.duration.value /
          primary.timeline_range.duration.rate) *
        plan.timeline_rate
    );
    await assertFocusedPlaybackBound(focused, 0, primaryEnd);
    await leaveFocus(focused);
    await focusItem(focused, plan.comment_source.relic_id, 'Enter');
    await leaveFocus(focused);
    await focusItem(focused, plan.comment_source.relic_id, ' ');
    pass('focus-video');

    // The official reader derives both the expected source interval and the
    // file-relative one. Keep the explicit item while narrowing its range.
    const focusedEditorial: TimeRange = {
      start_time: { value: 12, rate: 24 },
      duration: { value: 8, rate: 24 },
    };
    const focusedSource: TimeRange = {
      start_time: {
        value:
          plan.comment_source.source_range.start_time.value +
          (4 * plan.comment_source.source_range.start_time.rate) /
            plan.timeline_rate,
        rate: plan.comment_source.source_range.start_time.rate,
      },
      duration: plan.comment_source.source_range.duration,
    };
    assert.ok(rationalClose(focusedSource.start_time, { value: 60, rate: 24 }));
    const adjusted = await focused.evaluate<boolean>(`(() => {
      const input = document.querySelector('.otio-selection-in');
      const output = document.querySelector('.otio-selection-out');
      const range = document.querySelector('button[data-otio-mode="range"]');
      if (!(input instanceof HTMLInputElement) || !(output instanceof HTMLInputElement) ||
          !(range instanceof HTMLButtonElement)) return false;
      const root = document.querySelector('.otio-view');
      if (!(root instanceof HTMLElement)) return false;
      const origin = Number(root.dataset.domainOrigin);
      if (!Number.isFinite(origin)) return false;
      range.click();
      input.value = String(12 - origin); input.dispatchEvent(new Event('change', {bubbles:true}));
      output.value = String(20 - origin); output.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    })()`);
    assert.ok(adjusted, 'focus range controls are missing');
    await postComposer(focused, focusedCommentBody);

    const comments = await readComments(relicId);
    const comment = commentByBody(comments, focusedCommentBody);
    const anchor = comment['anchor'] as {
      item_id?: string;
      track_id?: string;
      timeline_id?: string;
      relic_version?: number;
      document_sha256?: string;
      range?: TimeRange;
    };
    assert.equal(
      anchor.item_id,
      plan.comment_source.relic_id,
      'focused anchor lost its explicit item'
    );
    assert.equal(anchor.track_id, plan.dissolve_track_id);
    assert.equal(anchor.relic_version, 1);
    assert.equal(anchor.document_sha256, scopedDocument.document_sha256);
    assert.equal(anchor.timeline_id, scopedDocument.timeline_ids[0]);
    assert.ok(
      rangeClose(anchor.range, focusedEditorial),
      'focused anchor changed editorial coordinates'
    );
    const resolved = resolvedOf(comment);
    const spans = resolved['intersections'] as Array<Record<string, unknown>>;
    assert.equal(resolved['status'], 'resolved');
    assert.ok(Array.isArray(spans), 'focused comment has no source spans');
    const span = spans.find(
      (row) => row['node_id'] === plan.comment_source.relic_id
    );
    assert.ok(span, 'focused comment lost primary source mapping');
    assert.ok(rangeClose(asRange(span['source_range']), focusedSource));
    assert.ok(
      rationalClose(asRange(span['file_relative_source_range'])?.start_time, {
        value: 36,
        rate: 24,
      }),
      'focused comment has wrong file-relative source'
    );
    const commentId = String(comment['comment_id']);
    assert.ok(commentId && commentId !== 'undefined');
    focusedCommentId = commentId;
    const ciphertextRows = JSON.stringify(
      await (await fetch(`${origin}/api/relics/${relicId}/comments`)).json()
    );
    assert.ok(
      !ciphertextRows.includes(focusedCommentBody) &&
        !ciphertextRows.includes(plan.comment_source.relic_id),
      'focused comment leaked plaintext'
    );
    pass('focus-comment');

    const matrix: Array<Record<string, unknown>> = [];
    for (const [shotWidth, scheme] of [
      [1440, 'light'],
      [390, 'light'],
      [320, 'light'],
      [1440, 'dark'],
      [390, 'dark'],
      [320, 'dark'],
    ] as const) {
      await focused.send('Emulation.setDeviceMetricsOverride', {
        width: shotWidth,
        height: 900,
        deviceScaleFactor: 1,
        mobile: shotWidth < 600,
      });
      await focused.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await focusItem(focused, plan.comment_source.relic_id);
      const fit = await focused.evaluate<boolean>(`(() => {
        const button = document.querySelector('.otio-zoom-fit');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click(); return true;
      })()`);
      assert.ok(fit, 'focus fit control missing');
      await openComposer(focused);
      const draftSet = await focused.evaluate<boolean>(`(() => {
        const field = document.querySelector('.popover-composer textarea.popover-field');
        if (!(field instanceof HTMLTextAreaElement)) return false;
        field.value = 'Draft survives timeline zoom.';
        field.dispatchEvent(new Event('input', {bubbles:true}));
        globalThis.__zoomDraft = field;
        return true;
      })()`);
      assert.ok(draftSet, 'focused draft missing before zoom');
      await assertFocusedWheelZoom(focused);
      const draftKept = await focused.evaluate<boolean>(`(() => {
        const field = document.querySelector('.popover-composer textarea.popover-field');
        return field === globalThis.__zoomDraft && field?.value === 'Draft survives timeline zoom.';
      })()`);
      assert.ok(draftKept, 'timeline zoom discarded the open draft');
      const geometry = await measureComposer(focused);
      assertComposerProbe(
        geometry,
        `${shotWidth}px ${scheme} focused composer`,
        false
      );
      await focused.screenshot(`focus-${shotWidth}-${scheme}-composer`);
      matrix.push({ width: shotWidth, scheme, geometry });
      await dismissComposer(focused);
    }
    await writeFile(
      join(shotDir, 'focus-viewport-measurements.json'),
      `${JSON.stringify(matrix, null, 2)}\n`
    );
    pass('focus-viewports');

    await focused.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await focusItem(focused, 'clip-a1-interview');
    await seekTo(focused, plan.audio_frame);
    const audioFocus = await focused.evaluate<{
      paths: string[];
      rms: number;
    }>(`(async () => {
      const nodes = [...document.querySelectorAll('.otio-audio-graph audio[data-active="true"]')];
      if (nodes.length !== 1) return {paths: nodes.map(node => node.dataset.bundlePath), rms: 0};
      const node = nodes[0]; const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(node.captureStream());
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
      await node.play();
      const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 300); await promise;
      const data = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data);
      let sum = 0; for (const value of data) sum += ((value - 128) / 128) ** 2;
      node.pause(); await ctx.close();
      return {paths: nodes.map(item => item.dataset.bundlePath), rms: Math.sqrt(sum / data.length)};
    })()`);
    assert.deepEqual(
      audioFocus.paths,
      ['media/dx_mic1.wav'],
      'focused audio did not isolate dialogue'
    );
    assert.ok(audioFocus.rms > 0.01, 'focused dialogue produced no signal');
    await leaveFocus(focused);
    await seekTo(focused, plan.audio_frame);
    const restoredAudio = await focused.evaluate<string[]>(
      `[...document.querySelectorAll('.otio-audio-graph audio[data-active="true"]')].map(node => node.dataset.bundlePath)`
    );
    for (const expectedAudio of plan.audio)
      assert.ok(
        restoredAudio.includes(expectedAudio.bundle_path),
        `composition lost ${expectedAudio.bundle_path}`
      );
    pass('focus-audio');

    await focusItem(focused, 'gap-v1-slug');
    await seekTo(focused, plan.gap_frame);
    assert.ok(
      isOpaqueBlack(await sampleCanvas(focused, width, height)),
      'focused gap is not black'
    );
    await focusItem(focused, 'trans-v1-dissolve-1');
    await seekTo(focused, plan.dissolve_frame);
    const focusedDissolve = await sampleCanvas(focused, width, height);
    const [a, b] = plan.dissolve_weights;
    assert.ok(a && b, 'dissolve oracle lacks branches');
    const frameA = await extractFrame(
      join(mediaDir, a.media),
      a.file_frame,
      width,
      height
    );
    const frameB = await extractFrame(
      join(mediaDir, b.media),
      b.file_frame,
      width,
      height
    );
    const mixture = blend(frameA, frameB, a.weight, b.weight);
    assert.ok(
      rmse(focusedDissolve, mixture) + 2 < rmse(focusedDissolve, frameA) &&
        rmse(focusedDissolve, mixture) + 2 < rmse(focusedDissolve, frameB),
      'focused transition did not retain both weighted branches'
    );
    // The compound contains both the plate and its FX Glow descendant. Its
    // oracle is the ordinary composition with only outside layers hidden, not
    // the isolated plate used by the separate nested image-sequence proof.
    await leaveFocus(focused);
    const outsideOccluders = plan.nested_occluders.filter(
      (id) => id !== 'track-nested-fx-glow'
    );
    await setTracksHidden(focused, outsideOccluders, true);
    await seekTo(focused, plan.nested_frame);
    const nestedExpected = await sampleCanvas(focused, width, height);
    await setTracksHidden(focused, outsideOccluders, false);
    await focusItem(focused, 'stack-vfx-submaster');
    await seekTo(focused, plan.nested_frame);
    const nestedFocused = await sampleCanvas(focused, width, height);
    assert.ok(
      rmse(nestedFocused, nestedExpected) <= 1,
      'focused nested stack did not retain its descendant composition'
    );
    await focusItem(focused, 'clip-v2-duplicate-disabled');
    assert.ok(
      isOpaqueBlack(await sampleCanvas(focused, width, height)),
      'disabled clip painted media'
    );
    const marker = await focused.evaluate<{
      clicked: boolean;
      scope: string;
      start: number;
      duration: number;
    }>(`(async () => {
      const mark = [...document.querySelectorAll('.otio-timeline-marker')]
        .find(node => node.dataset.ownerId === ${JSON.stringify(plan.comment_source.relic_id)} &&
          node.getAttribute('aria-label')?.includes('In Trim Note'));
      if (!(mark instanceof HTMLButtonElement)) return {clicked: false, scope: '', start: -1, duration: -1};
      mark.click();
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const root = document.querySelector('.otio-view');
        const selection = document.querySelector('.otio-selection');
        if (root?.dataset.scopeNodeId === ${JSON.stringify(plan.comment_source.relic_id)} && selection)
          return {clicked: true, scope: root.dataset.scopeNodeId,
            start: Number(selection.dataset.start), duration: Number(selection.dataset.duration)};
        const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
      }
      return {clicked: true, scope: '', start: -1, duration: -1};
    })()`);
    assert.ok(
      marker.clicked && marker.scope === plan.comment_source.relic_id,
      'marker did not focus owner'
    );
    assert.equal(
      marker.start,
      36,
      'marker moved from its mapped editorial position'
    );
    assert.equal(
      marker.duration,
      0,
      'point marker acquired a positive duration'
    );
    pass('focus-special-items');

    await leaveFocus(focused);
    const markClicked = await focused.evaluate<boolean>(`(() => {
      const mark = [...document.querySelectorAll('.otio-comment-mark')]
        .find(node => node.dataset.commentId === ${JSON.stringify(commentId)});
      if (!(mark instanceof HTMLButtonElement)) return false;
      mark.click(); return true;
    })()`);
    assert.ok(markClicked, 'focused comment mark missing');
    assert.equal(
      await focused.evaluate<string>(`(async () => {
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const id = document.querySelector('.otio-view')?.dataset.scopeNodeId ?? '';
          if (id) return id;
          const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
        }
        return '';
      })()`),
      plan.comment_source.relic_id,
      'comment reveal did not restore item focus'
    );
  } finally {
    await focused.close();
  }
  const reopened = await openBrowser(shareUrl, sessionToken, {
    label: 'focused-reload',
  });
  try {
    await waitReady(reopened);
    const revealed = await reopened.evaluate<boolean>(`(async () => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const mark = [...document.querySelectorAll('.otio-comment-mark')]
          .find(node => node.dataset.commentId === ${JSON.stringify(focusedCommentId)});
        if (mark instanceof HTMLButtonElement) { mark.click(); return true; }
        const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
      }
      return false;
    })()`);
    assert.ok(revealed, 'reloaded comment mark did not appear');
    const scope = await reopened.evaluate<string>(`(async () => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const id = document.querySelector('.otio-view')?.dataset.scopeNodeId ?? '';
        if (id) return id;
        const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 50); await promise;
      }
      return '';
    })()`);
    assert.equal(
      scope,
      plan.comment_source.relic_id,
      'reloaded comment did not reveal its item'
    );
    pass('focus-reveal');
  } finally {
    await reopened.close();
  }
  const fallback = await openBrowser(shareUrl, sessionToken, {
    label: 'focused-fallback',
    blockRequestVideoFrameCallback: true,
  });
  try {
    await waitReady(fallback);
    await focusItem(fallback, plan.comment_source.relic_id);
    await assertFocusedPlaybackBound(fallback, 0, 72);
    pass('focus-fallback');
  } finally {
    await fallback.close();
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
    focusedCommentBody,
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
  // Track hiding, the held predecessor and the black-probe policy are live-player
  // behavior, so this fixture is published as a legacy archive too.
  const stateUrl = await publishLegacyDirectory(stateDir, 'OTIO state proof');
  const stateBrowser = await openBrowser(stateUrl, sessionToken, {
    label: 'state-occlusion',
  });
  try {
    await waitReady(stateBrowser);
    await assertLegacyProgramState(stateBrowser, 'state-occlusion');
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

  // The three-slot stage is accounted only by the proof-only three-slot run (see REQUIRED).
  const missing = REQUIRED.filter(
    (stage) =>
      stage !== 'legacy-three-slot-forced-refusal' && !passed.has(stage)
  );
  assert.deepEqual(missing, [], `stages not passed: ${missing.join(', ')}`);
  console.log('OTIO_PATH_OK');
} catch (error) {
  if (
    !(
      error instanceof LayoutOnlyComplete ||
      error instanceof DecoderOnlyComplete ||
      error instanceof InteractionOnlyComplete
    )
  )
    throw error;
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
