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
 *   headless Chrome in RELIC_OTIO_CHROME_PATH, or RELIC_CHROME_PATH when that
 *   names an executable. A headed browser is refused.
 *
 * RELIC_OTIO_PATH_CLIENT selects the MCP client: `source` (the built bundle)
 * or `npx:<version>` for a published package. Both run the full path.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  cp,
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

const clientMode = process.env['RELIC_OTIO_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');
const OTIO_PIN = 'opentimelineio==0.18.1';

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
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: { to: string; mail: OutboundMail }[] = [];
const children = new Set<ChildProcess>();

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
  return app.fetch(request);
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
  } finally {
    clearTimeout(timer);
    child.kill();
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
    (Path(out_dir) / primary_media).parent.mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / primary_media).write_bytes(zf.read(primary_media))

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

async function oracle(args: string[], input?: string): Promise<string> {
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
      'rgb24',
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
    width * height * 3,
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
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    const lum = (rgb[i] ?? 0) + (rgb[i + 1] ?? 0) + (rgb[i + 2] ?? 0);
    if (lum > best) {
      best = lum;
      bestX = x;
    }
  }
  return bestX;
}

function isOpaqueBlack(rgb: Uint8Array): boolean {
  let peak = 0;
  for (const value of rgb) peak = Math.max(peak, value);
  return peak <= 8;
}

/** Luminance-weighted centre of the above-half-peak run, as a fraction of row width. */
function rowCenter(rgb: Uint8Array, rowWidth: number): number {
  const lum: number[] = [];
  for (let x = 0; x < rowWidth; x++) {
    const i = x * 3;
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
}

interface OpenBrowserOptions {
  readonly recordMediaSeekTargets?: boolean;
  readonly blockWebCodecs?: boolean;
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
    `no headless Chrome: ${found.kind === 'not_found' ? found.detail : found.kind}`
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
  const args = [
    ...shared.map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port}`
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    ),
    '--autoplay-policy=no-user-gesture-required',
  ];
  const child = spawn(found.path, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  children.add(child);
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
  const cdp = connectPipe(toChrome, fromChrome);
  const blocked: string[] = [];
  const continuedNonLoopback: string[] = [];
  const cspHeaders: string[] = [];
  const workerUrls: string[] = [];
  const workerHookErrors: Error[] = [];
  const workerHooks = new Set<Promise<void>>();
  let stopWorkerAttach: (() => void) | undefined;
  const documentUrl = url.split('#')[0] ?? url;
  const version = await cdp.send('Browser.getVersion');
  const product = String(version['product'] ?? '');
  assert.ok(
    /headless/i.test(product) || found.path.includes('headless'),
    `browser is not headless: ${product}`
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
    if (params.response?.url !== documentUrl) return;
    for (const [name, value] of Object.entries(params.response.headers ?? {})) {
      if (name.toLowerCase() === 'content-security-policy')
        cspHeaders.push(String(value));
    }
  });
  const stopEvents = cdp.onEvent((event) => {
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== sessionId)
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
  })()`;
  const pagePrelude = [
    options.recordMediaSeekTargets
      ? String.raw`(() => {
          const key = '__relicOtioMediaSeekTargets';
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
              descriptor.set.call(this, value);
            },
          });
        })()`
      : '',
    options.blockWebCodecs ? webCodecsTrap : '',
  ]
    .filter(Boolean)
    .join('\n');
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
    origin,
    'browser did not land on the service origin'
  );
  return {
    blocked,
    continuedNonLoopback,
    cspHeaders,
    workerUrls,
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
      await cdp.send('Browser.close').catch(() => {});
      child.kill('SIGKILL');
      children.delete(child);
      cdp.dispose();
      await rm(profile, { recursive: true, force: true });
    },
  };
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

async function sampleCanvas(
  browser: ChromeSession,
  width: number,
  height: number
): Promise<Uint8Array> {
  const values = await browser.evaluate<number[]>(`(() => {
    const canvas = document.querySelector('canvas.otio-canvas');
    if (!canvas) return null;
    const src = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const out = [];
    for (let y = 0; y < ${height}; y++) {
      const sy = Math.min(canvas.height - 1, Math.floor(y * canvas.height / ${height}));
      for (let x = 0; x < ${width}; x++) {
        const sx = Math.min(canvas.width - 1, Math.floor(x * canvas.width / ${width}));
        const i = (sy * canvas.width + sx) * 4;
        out.push(src[i], src[i + 1], src[i + 2]);
      }
    }
    return out;
  })()`);
  assert.ok(
    values && values.length === width * height * 3,
    'canvas sample missing'
  );
  return Uint8Array.from(values);
}

async function canvasRowCenter(browser: ChromeSession): Promise<number> {
  const row = await browser.evaluate<number[] | null>(`(() => {
    const canvas = document.querySelector('canvas.otio-canvas');
    if (!canvas) return null;
    const data = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
    const out = [];
    for (let x = 0; x < canvas.width; x++) out.push(data[x * 4], data[x * 4 + 1], data[x * 4 + 2]);
    return out;
  })()`);
  assert.ok(
    row && row.length > 0 && row.length % 3 === 0,
    'canvas row missing'
  );
  return rowCenter(Uint8Array.from(row), row.length / 3);
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
  mode: 'point' | 'range',
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
}

async function postComposer(
  browser: ChromeSession,
  body: string
): Promise<void> {
  const posted = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    document.querySelector('button.otio-comment-selection').click();
    const start = Date.now();
    const tick = () => {
      const field = document.querySelector('.popover-composer textarea.popover-field');
      const submit = [...document.querySelectorAll('.popover-composer button.popover-action.is-primary')]
        .find((button) => button.textContent === 'Post');
      if (field && submit) {
        field.value = ${JSON.stringify(body)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
        submit.click();
        const wait = Date.now();
        const done = () => {
          if (document.body.textContent.includes(${JSON.stringify(body)})) resolve('posted');
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
  assert.equal(
    posted,
    'posted',
    `native composer did not submit ${JSON.stringify(body)}: ${posted}`
  );
}

async function openComposer(browser: ChromeSession): Promise<void> {
  const opened = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    document.querySelector('button.otio-comment-selection')?.click();
    const started = Date.now();
    const tick = () => {
      if (document.querySelector('.popover-composer textarea.popover-field')) {
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
    const cancel = [...document.querySelectorAll('.popover-composer button')]
      .find((button) => button.textContent === 'Cancel');
    cancel?.click();
    const started = Date.now();
    const tick = () => {
      if (!document.querySelector('.popover-composer')) {
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
}

interface DomRectProbe {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
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
}

interface ComposerProbe {
  readonly missing: readonly string[];
  readonly stageContent: DomRectProbe | null;
  readonly viewportWidth: number;
  readonly documentOverflow: number;
  readonly bodyOverflow: number;
  readonly stageOverflow: number;
  readonly timelineOverflow: number;
  readonly components: readonly ComposerElementProbe[];
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

function assertComposerProbe(
  probe: ComposerProbe,
  label: string,
  expectHovered: boolean
): void {
  assert.deepEqual(probe.missing, [], `${label} composer controls are missing`);
  assert.ok(probe.stageContent, `${label} has no stage content bounds`);
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
    assert.equal(
      component.withinStage,
      true,
      `${label} composer component escapes its stage: ${component.name}`
    );
  }
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
  return browser.evaluate<ComposerProbe>(String.raw`(() => {
    const stage = document.querySelector('.stage-wrap');
    const card = document.querySelector('.popover-card');
    const missing = [];
    if (!stage) missing.push('.stage-wrap');
    if (!card) missing.push('.popover-card');
    const empty = {
      missing,
      stageContent: null,
      viewportWidth: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
      stageOverflow: 0,
      timelineOverflow: 0,
      components: [],
      post: { hovered: false, foreground: null, background: null, contrast: null },
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
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        value.width > 0 && value.height > 0;
    };
    const within = (inner, outer) =>
      inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
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
    const post = document.querySelector('.popover-card .popover-action.is-primary');
    const cancel = [...card.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel') ?? null;
    const parts = [
      ['card', card],
      ['context', card.querySelector('.popover-target')],
      ['textarea', card.querySelector('textarea.popover-field')],
      ['Post', post],
      ['Cancel', cancel],
      ['disclosure', card.querySelector('.popover-disclosure')],
    ];
    const content = contentRect();
    const components = parts.map(([name, node]) => {
      const isVisible = visible(node);
      const value = isVisible ? rect(node) : null;
      return {
        name,
        present: node !== null,
        visible: isVisible,
        withinStage: value !== null && within(value, content),
        rect: value,
      };
    });
    const style = post instanceof HTMLElement ? getComputedStyle(post) : null;
    const timeline = document.querySelector('.otio-timeline-scroll');
    return {
      missing,
      stageContent: content,
      viewportWidth: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
      stageOverflow: stage.scrollWidth - stage.clientWidth,
      timelineOverflow: timeline ? timeline.scrollWidth - timeline.clientWidth : 0,
      components,
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
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
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
    `new Promise((resolve) => requestAnimationFrame(resolve))`
  );
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
      await new Promise((resolve) => requestAnimationFrame(resolve));
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
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return 'timeout';
  })()`);
  assert.equal(
    restored,
    'restored',
    `base preview did not restore: ${restored}`
  );
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
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
  assert.equal(
    compareRationalTimes(sourceTime, {
      value: 0,
      rate: sourceTime.rate,
    }),
    0,
    `${name} source is not compare-equal to zero`
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
  await browser.evaluate<void>(`globalThis.__relicOtioMediaSeekTargets = []`);
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
  const nearZeroBrowser = await openBrowser(nearZeroUrl, sessionToken);
  try {
    assert.equal(await waitReady(nearZeroBrowser), 'true');
    await seekTo(nearZeroBrowser, 0);
    const first = await assertPacketCanvas(
      nearZeroBrowser,
      'representational zero first frame',
      'fr24.mp4',
      0
    );
    assert.equal(first.frame, 0);
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
    sessionToken
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
      'truly negative source time painted media'
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
  assertSelectedPositiveSource(
    'available-origin-cut',
    availableOriginCutDocument,
    { value: 57, rate: 30 },
    'cut-c',
    { value: 1, rate: 30 }
  );
  const availableOriginCutUrl = await publishDecoderDocument(
    'available-origin-cut',
    availableOriginCutDocument
  );
  const availableOriginCutBrowser = await openBrowser(
    availableOriginCutUrl,
    sessionToken
  );
  try {
    assert.equal(await waitReady(availableOriginCutBrowser), 'true');
    await seekTo(availableOriginCutBrowser, 55);
    assert.equal(
      isOpaqueBlack(
        await sampleCanvas(availableOriginCutBrowser, width, height)
      ),
      true,
      'available-origin/cut witness has media before cut-c'
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

  const browser = await openBrowser(shareUrl, sessionToken);
  try {
    await waitReady(browser);
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
      'nested plate spilled outside its exposure'
    );
    assert.ok(
      Math.abs(barColumn(outsideCanvas, width, height) - plateBar) > 3 ||
        isOpaqueBlack(outsideCanvas),
      'outside frame still shows the nested plate bar'
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
      'gap frame is not opaque black'
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
    const nativeControlMeasurements: Array<Record<string, unknown>> = [];

    for (const [shotWidth, scheme] of [
      [1440, 'light'],
      [390, 'light'],
      [1440, 'dark'],
      [390, 'dark'],
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
      await browser.screenshot(`${shotWidth}-${scheme}-composer-open`);
      await hoverComposerPost(browser);
      const hoveredComposer = await measureComposer(browser);
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

    for (const scheme of ['light', 'dark'] as const) {
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
      assertComposerProbe(normalComposer, `320px ${scheme} composer`, false);
      nativeControlMeasurements.push({
        state: 'supplemental-composer-normal',
        width: 320,
        scheme,
        probe: normalComposer,
      });
      await browser.screenshot(`native-controls-320-${scheme}-composer-open`);
      await hoverComposerPost(browser);
      const hoveredComposer = await measureComposer(browser);
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
      const priorFrame = await browser.evaluate<number>(
        `Number(document.querySelector('.otio-view')?.dataset.frame ?? NaN)`
      );
      assert.ok(
        Number.isInteger(priorFrame) && priorFrame >= 0,
        `320px ${scheme} has no restorable playback frame: ${priorFrame}`
      );
      await seekTo(browser, plan.effect_frame);
      nativeControlMeasurements.push({
        state: 'supplemental-preview-context',
        width: 320,
        scheme,
        prior_frame: priorFrame,
        effect_frame: plan.effect_frame,
      });
      const previewBase = await exposePreviewBase(browser);
      assertStageControlExposure(previewBase, `320px ${scheme} base preview`);
      nativeControlMeasurements.push({
        state: 'supplemental-preview-base',
        width: 320,
        scheme,
        probe: previewBase,
      });
      await browser.screenshot(`native-controls-320-${scheme}-preview-base`);
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
  const insertIds = original.map((entry) => String(entry['comment_id']));
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
  const insertBrowser = await openBrowser(shareUrl, sessionToken);
  try {
    await waitReady(insertBrowser);
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
  const stateBrowser = await openBrowser(stateUrl, sessionToken);
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
      `${statePlan.black_under} paints nothing under the black probe, so the policy check cannot fail`
    );
    await setTracksHidden(stateBrowser, [statePlan.probe_track], false);
    await seekTo(stateBrowser, statePlan.black_frame);
    const black = await sampleCanvas(stateBrowser, width, height);
    assert.equal(
      isOpaqueBlack(black),
      true,
      'sequence black policy did not paint opaque black'
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
      'undecodable media painted a substitute frame'
    );
    pass('state-codec');
  } finally {
    await stateBrowser.close();
  }

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
} finally {
  for (const child of children) child.kill('SIGKILL');
  const kept = join(process.cwd(), 'otio-path-shots');
  await rm(kept, { recursive: true, force: true }).catch(() => {});
  await Bun.spawn(['cp', '-R', shotDir, kept]).exited.catch(() => 1);
  console.log(`SHOTS ${kept}`);
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
