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
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKey, openRelic } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe, type CdpConnection } from '../src/cover/cdp.ts';
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

const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-path-'));
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
  'screenshots',
] as const;

const passed = new Set<string>();
function pass(stage: (typeof REQUIRED)[number]): void {
  passed.add(stage);
  console.log(`STAGE ${stage}`);
}

let fakeNow = Date.now();
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
  readonly outside_frame: number;
  readonly outside_kind: string;
  readonly primary_frame: number;
  readonly primary_file_frame: number;
  readonly primary_wrong_file_frame: number;
  readonly primary_media: string;
  readonly dissolve_frame: number;
  readonly dissolve_query: TimeRange;
  readonly dissolve_spans: readonly SpanExpect[];
  readonly dissolve_weights: readonly {
    readonly media: string;
    readonly file_frame: number;
    readonly weight: number;
  }[];
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
    scaled = relative.rescaled_to(source.rate)
    if abs(scaled.value - round(scaled.value)) > 1e-3:
        return None
    return int(round(scaled.value))

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
    duplicates = {name: rows for name, rows in by_name.items() if len(rows) > 1}
    if not duplicates:
        raise SystemExit("fixture has no duplicate track name")
    dup_name = sorted(duplicates)[0]
    dup_tracks = duplicates[dup_name]
    dup = dup_tracks[-1]
    other = dup_tracks[0]
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
    zf = zipfile.ZipFile(archive)
    for needed in (url, predecessor):
        if needed not in zf.namelist():
            raise SystemExit("bundle is missing %s" % needed)
        target = Path(out_dir) / needed
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(zf.read(needed))

    outside = exposure_start - 1
    outside_t = otio.opentime.RationalTime(outside, rate)
    outside_hits = [item for item in walk(timeline) if isinstance(item, otio.schema.Clip) and overlaps(item.trimmed_range_in_parent(), outside_t)]
    outside_kind = "gap" if not any(isinstance(item, otio.schema.Clip) and relic_id(item) == "clip-nested-plate" and overlaps(item.trimmed_range_in_parent(), outside_t) for item in walk(timeline)) else "plate"

    primary = next(item for item in walk(timeline) if relic_id(item) == "clip-v1-primary-a")
    primary_range = primary.trimmed_range_in_parent()
    primary_frame = frame_number(primary_range.start_time, rate) + 8
    primary_t = otio.opentime.RationalTime(primary_frame, rate)
    primary_span = span_for(timeline, primary, primary_t)
    if primary_span["file_frame"] is None:
        raise SystemExit("primary file frame is not an integer")
    primary_media = primary_span["bundle_path"]
    if primary_media not in zf.namelist():
        raise SystemExit("bundle is missing %s" % primary_media)
    (Path(out_dir) / primary_media).parent.mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / primary_media).write_bytes(zf.read(primary_media))

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
        pre, post = v1.handles_of_child(clip)
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

    dup_clip = next(item for item in walk(dup) if isinstance(item, otio.schema.Clip))
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
    effect_frame = frame_number(effect_range.start_time, rate)
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
        "outside_frame": outside,
        "outside_kind": outside_kind,
        "primary_frame": primary_frame,
        "primary_file_frame": primary_span["file_frame"],
        "primary_wrong_file_frame": primary_span["file_frame"] + 2,
        "primary_media": primary_media,
        "dissolve_frame": mid,
        "dissolve_query": range_json(query),
        "dissolve_spans": window_spans,
        "dissolve_weights": weights,
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
    have = clip.source_range
    if have is None:
        return {"status": "missing", "mapped_range": None}
    overlap_start = max(wanted.start_time, have.start_time)
    overlap_end = min(wanted.end_time_exclusive(), have.end_time_exclusive())
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
        clip_start = clip.source_range.start_time
        clip.source_range = otio.opentime.TimeRange(clip_start, midpoint - clip_start.rescaled_to(midpoint.rate))
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
        print(json.dumps({"status": "ambiguous", "mapped_range": None}))
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
        black_ref.missing_frame_policy = "black"
        black = otio.schema.Clip(name="Black Policy Probe", media_reference=black_ref, source_range=otio.opentime.TimeRange(
            otio.opentime.RationalTime(0, 24), otio.opentime.RationalTime(1, 24)))
        black.metadata["relic"] = {"id": "clip-black-policy-probe"}
        duration = timeline.duration()
        track = otio.schema.Track(name="Black Policy", kind=otio.schema.TrackKind.Video)
        track.metadata["relic"] = {"id": "track-black-policy-probe"}
        track.append(otio.schema.Gap(source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, duration.rate), duration)))
        track.append(black)
        timeline.tracks.append(track)
        codec = next(item for item in walk(timeline) if relic_id(item) == "clip-v2-freeze")
        prores = "media/unsupported_prores.mov"
        if not (Path(dest) / prores).exists():
            prores = "media/secondary_b_prores.mov"
        codec.media_reference = otio.schema.ExternalReference(target_url=prores)
        codec.active_media_reference_key = "DEFAULT_MEDIA"
        write_dir(timeline, dest)
        black_range = black.trimmed_range_in_parent()
        codec_range = codec.trimmed_range_in_parent()
        print(json.dumps({
            "missing_file": missing,
            "black_frame": frame_number(black_range.start_time, 24),
            "codec_frame": frame_number(codec_range.start_time, 24),
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

interface ChromeSession {
  evaluate<T>(expression: string): Promise<T>;
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  screenshot(label: string): Promise<void>;
  close(): Promise<void>;
  blocked: string[];
  continuedNonLoopback: string[];
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
  sessionToken: string
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
  const args = [
    ...chromeArgs(found.path, profile),
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
  await cdp.send('Network.setCookie', {
    name: 'relic_session',
    value: sessionToken,
    url: origin,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  });
  const loaded = cdp.waitForEvent('Page.loadEventFired', {
    sessionId,
    timeoutMs: 20000,
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  return {
    blocked,
    continuedNonLoopback,
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

    await seekTo(browser, plan.primary_frame);
    const primaryCanvas = await sampleCanvas(browser, width, height);
    const primaryRight = await extractFrame(
      join(mediaDir, plan.primary_media),
      plan.primary_file_frame,
      width,
      height
    );
    const primaryWrong = await extractFrame(
      join(mediaDir, plan.primary_media),
      plan.primary_wrong_file_frame,
      width,
      height
    );
    const rightBar = barColumn(primaryRight, width, height);
    const wrongBar = barColumn(primaryWrong, width, height);
    const canvasBar = barColumn(primaryCanvas, width, height);
    assert.ok(
      Math.abs(rightBar - wrongBar) >= 4,
      'fixture frames are not distinct enough to prove a source offset'
    );
    assert.ok(
      Math.abs(canvasBar - rightBar) <= 3,
      `canvas bar ${canvasBar} does not match source frame ${plan.primary_file_frame} bar ${rightBar}`
    );
    assert.ok(
      Math.abs(canvasBar - wrongBar) >= 4,
      `canvas matches the wrong source frame ${plan.primary_wrong_file_frame}`
    );
    pass('pixels-offset');

    await seekTo(browser, plan.nested_frame);
    const nestedCanvas = await sampleCanvas(browser, width, height);
    const plate = await extractFrame(
      join(mediaDir, plan.nested_image_file),
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

    await seekTo(browser, plan.dissolve_frame);
    const dissolveCanvas = await sampleCanvas(browser, width, height);
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
          currentTime: node.currentTime,
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
      await browser.screenshot(`${shotWidth}-${scheme}`);
    }
    pass('screenshots');
  } finally {
    await browser.close();
  }

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
  const insertIds = original.map((entry) => String(entry['comment_id']));
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
  const primaryAfterInsert = commentByBody(afterInsert, primaryBody);
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
    pass('state-hold');

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
    `the proof captured ${mails.length} mail send(s)`
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
