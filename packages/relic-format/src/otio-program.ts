/**
 * OpenTimelineIO program manifest, `relic.otio.program/1`.
 *
 * A publisher may render a timeline to one continuous MP4 before encryption.
 * The manifest records what was rendered and binds it to the exact OTIO
 * document and media bytes. A reader trusts a program only through
 * `readOtioProgramArchive`, which verifies every digest, size, ZIP method and
 * path. Anything inconsistent throws; no partial result is returned.
 *
 * Archive layout, appended after content.otio (which is never modified):
 *   relic/program.json               DEFLATE, the manifest
 *   relic/program/timeline-<i>.mp4   STORED, one per rendered timeline
 */

import { RelicFormatError } from './errors.ts';
import { isRecord } from './guards.ts';
import { parseOtioJson, stringifyOtioJson } from './otio-json.ts';
import type {
  OtioRationalTime,
  OtioTimeRange,
  OtioZipIndex,
} from './otio-types.ts';
import {
  MAX_EXPANDED_ZIP_BYTES,
  MAX_OTIO_BUNDLE_MEDIA_ENTRIES,
  sanitizeOtioBundlePath,
} from './otio-zip.ts';

export const OTIO_PROGRAM_SCHEMA = 'relic.otio.program/1' as const;
export const OTIO_PROGRAM_PROTOCOL = 1 as const;
export const OTIO_PROGRAM_MANIFEST_ENTRY = 'relic/program.json' as const;
export const OTIO_PROGRAM_AUDIO_CODEC = 'mp4a.40.2' as const;
export const OTIO_PROGRAM_AUDIO_RATE = 48000 as const;
export const OTIO_PROGRAM_CHANNELS = 2 as const;

/** Every archive entry under this prefix belongs to the program contract. */
const RESERVED_PREFIX = 'relic/program';
const PROGRAM_DIR = 'relic/program/';
const ZIP_STORED = 0;
const ZIP_DEFLATE = 8;

export const MAX_OTIO_PROGRAM_TIMELINES = 256;
export const MAX_OTIO_PROGRAM_REASONS = 64;
export const MAX_OTIO_PROGRAM_MANIFEST_BYTES = 1024 * 1024;
export const MAX_OTIO_PROGRAM_DIMENSION = 4096;
export const MAX_OTIO_PROGRAM_FPS = 240;
export const MAX_OTIO_PROGRAM_VIDEO_BITRATE = 100_000_000;
export const MAX_OTIO_RATIONAL_RATE = 1_000_000;

const MAX_STRING = 512;
const MAX_MEDIA_PATH = 1024;
const MAX_FRAMES = 2 ** 31 - 1;
const MAX_AUDIO_SAMPLES = 2 ** 40;
/** One AAC frame of priming and padding is the allowed drift in sample count. */
const AUDIO_SAMPLE_TOLERANCE = 2048;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const AVC_CODEC = /^avc1\.[0-9a-fA-F]{6}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const OTIO_PROGRAM_REASON_CODES = [
  'unsupported-effect',
  'unsupported-schema',
  'unsupported-codec',
  'unsupported-transition',
  'missing-media',
  'unsupported-browser',
  'invalid-timing',
  'encoder-unavailable',
  'render-failed',
  'size-cap-exceeded',
] as const;

export type OtioProgramReasonCode = (typeof OTIO_PROGRAM_REASON_CODES)[number];

export type OtioProgramErrorCode =
  | 'malformed-manifest'
  | 'unsafe-path'
  | 'archive-mismatch'
  | 'digest-mismatch'
  | 'size-cap-exceeded';

export class OtioProgramError extends RelicFormatError {
  override readonly name = 'OtioProgramError';
  constructor(
    readonly code: OtioProgramErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface OtioProgramFrameRate {
  readonly num: number;
  readonly den: number;
}

export interface OtioProgramDescriptor {
  /** Exactly `otioProgramEntryName(index)` for the owning timeline. */
  readonly entry: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly range: OtioTimeRange;
  readonly frame_rate: OtioProgramFrameRate;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly video_codec: string;
  readonly video_bitrate: number;
  readonly audio_codec: typeof OTIO_PROGRAM_AUDIO_CODEC;
  readonly audio_rate: typeof OTIO_PROGRAM_AUDIO_RATE;
  readonly channels: typeof OTIO_PROGRAM_CHANNELS;
  readonly audio_samples: number;
}

export interface OtioProgramReason {
  readonly code: OtioProgramReasonCode;
  readonly message: string;
  readonly node_id?: string;
  readonly time?: OtioRationalTime;
}

export type OtioProgramTimelineRecord =
  | {
      readonly timeline_id: string;
      readonly index: number;
      readonly status: 'rendered';
      readonly reasons: readonly [];
      readonly program: OtioProgramDescriptor;
    }
  | {
      readonly timeline_id: string;
      readonly index: number;
      readonly status: 'unavailable';
      readonly reasons: readonly OtioProgramReason[];
      readonly program?: never;
    };

export interface OtioProgramManifestV1 {
  readonly schema: typeof OTIO_PROGRAM_SCHEMA;
  readonly document_sha256: string;
  readonly renderer: {
    readonly client: string;
    readonly protocol: typeof OTIO_PROGRAM_PROTOCOL;
    readonly browser: string;
  };
  /** Archive path of each media file the renders read, to its sha256. */
  readonly media: Readonly<Record<string, string>>;
  readonly timelines: readonly OtioProgramTimelineRecord[];
}

export interface OtioProgramArchive {
  readonly manifest: OtioProgramManifestV1;
  /** Verified MP4 bytes of each rendered timeline, keyed by timeline index. */
  readonly programs: ReadonlyMap<number, Uint8Array>;
}

/** The only archive name a rendered timeline's MP4 may take. */
export function otioProgramEntryName(index: number): string {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= MAX_OTIO_PROGRAM_TIMELINES
  ) {
    throw new RangeError(`timeline index out of range: ${index}`);
  }
  return `${PROGRAM_DIR}timeline-${index}.mp4`;
}

function fail(message: string): never {
  throw new OtioProgramError('malformed-manifest', message);
}

function unsafe(message: string): never {
  throw new OtioProgramError('unsafe-path', message);
}

function mismatch(message: string): never {
  throw new OtioProgramError('archive-mismatch', message);
}

function expectRecord(
  value: unknown,
  where: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      fail(`${where} has unknown key ${JSON.stringify(key)}`);
  }
  return value;
}

function required(
  record: Record<string, unknown>,
  key: string,
  where: string
): unknown {
  if (!Object.hasOwn(record, key)) fail(`${where}.${key} is missing`);
  return record[key];
}

function expectString(
  value: unknown,
  where: string,
  min: number,
  max: number
): string {
  if (typeof value !== 'string') fail(`${where} must be a string`);
  if (value.length < min || value.length > max) {
    fail(`${where} must be ${min} to ${max} characters`);
  }
  if (CONTROL_CHARACTER.test(value))
    fail(`${where} contains a control character`);
  return value;
}

function expectInt(
  value: unknown,
  where: string,
  min: number,
  max: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${where} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function expectSha(value: unknown, where: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    fail(`${where} must be lowercase sha256 hex`);
  }
  return value;
}

function expectRational(value: unknown, where: string): OtioRationalTime {
  const record = expectRecord(value, where, ['value', 'rate']);
  const time = required(record, 'value', where);
  const rate = required(record, 'rate', where);
  if (
    typeof time !== 'number' ||
    !Number.isFinite(time) ||
    Math.abs(time) > Number.MAX_SAFE_INTEGER
  ) {
    fail(`${where}.value must be a finite number within 2^53`);
  }
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > MAX_OTIO_RATIONAL_RATE
  ) {
    fail(`${where}.rate must be in (0, ${MAX_OTIO_RATIONAL_RATE}]`);
  }
  return { value: time, rate };
}

function expectRange(value: unknown, where: string): OtioTimeRange {
  const record = expectRecord(value, where, ['start_time', 'duration']);
  const start_time = expectRational(
    required(record, 'start_time', where),
    `${where}.start_time`
  );
  const duration = expectRational(
    required(record, 'duration', where),
    `${where}.duration`
  );
  if (duration.value <= 0) fail(`${where}.duration must be positive`);
  return { start_time, duration };
}

function expectFrameRate(value: unknown, where: string): OtioProgramFrameRate {
  const record = expectRecord(value, where, ['num', 'den']);
  const num = expectInt(
    required(record, 'num', where),
    `${where}.num`,
    1,
    MAX_OTIO_RATIONAL_RATE
  );
  const den = expectInt(
    required(record, 'den', where),
    `${where}.den`,
    1,
    MAX_OTIO_RATIONAL_RATE
  );
  if (num > MAX_OTIO_PROGRAM_FPS * den) {
    fail(`${where} exceeds ${MAX_OTIO_PROGRAM_FPS} frames per second`);
  }
  return { num, den };
}

function expectEvenDimension(value: unknown, where: string): number {
  const dimension = expectInt(value, where, 2, MAX_OTIO_PROGRAM_DIMENSION);
  if (dimension % 2 !== 0) fail(`${where} must be even`);
  return dimension;
}

function expectMediaPath(key: string): void {
  if (key.length > MAX_MEDIA_PATH || !key.startsWith('media/')) {
    unsafe(`media path must start with media/: ${JSON.stringify(key)}`);
  }
  if (key.includes('\\')) unsafe(`media path contains a backslash: ${key}`);
  let canonical: string;
  try {
    canonical = sanitizeOtioBundlePath(key);
  } catch {
    unsafe(`media path is not a safe bundle path: ${key}`);
  }
  if (canonical !== key) unsafe(`media path is not canonical: ${key}`);
}

function expectMedia(value: unknown): Record<string, string> {
  if (!isRecord(value)) fail('manifest.media must be an object');
  const keys = Object.keys(value);
  if (keys.length > MAX_OTIO_BUNDLE_MEDIA_ENTRIES) {
    fail(`manifest.media exceeds ${MAX_OTIO_BUNDLE_MEDIA_ENTRIES} entries`);
  }
  const media: Record<string, string> = Object.create(null);
  for (const key of keys) {
    expectMediaPath(key);
    media[key] = expectSha(
      value[key],
      `manifest.media[${JSON.stringify(key)}]`
    );
  }
  return media;
}

function expectDescriptor(
  value: unknown,
  where: string,
  entry: string
): OtioProgramDescriptor {
  const record = expectRecord(value, where, DESCRIPTOR_KEYS);
  const got = expectString(
    required(record, 'entry', where),
    `${where}.entry`,
    1,
    MAX_STRING
  );
  if (got !== entry) unsafe(`${where}.entry must be exactly ${entry}`);
  const sha256 = expectSha(
    required(record, 'sha256', where),
    `${where}.sha256`
  );
  const bytes = expectInt(
    required(record, 'bytes', where),
    `${where}.bytes`,
    1,
    MAX_EXPANDED_ZIP_BYTES
  );
  const range = expectRange(required(record, 'range', where), `${where}.range`);
  const frame_rate = expectFrameRate(
    required(record, 'frame_rate', where),
    `${where}.frame_rate`
  );
  const frames = expectInt(
    required(record, 'frames', where),
    `${where}.frames`,
    1,
    MAX_FRAMES
  );
  const width = expectEvenDimension(
    required(record, 'width', where),
    `${where}.width`
  );
  const height = expectEvenDimension(
    required(record, 'height', where),
    `${where}.height`
  );
  const videoCodec = required(record, 'video_codec', where);
  if (typeof videoCodec !== 'string' || !AVC_CODEC.test(videoCodec)) {
    fail(`${where}.video_codec must be an avc1.XXXXXX H.264 codec string`);
  }
  const video_bitrate = expectInt(
    required(record, 'video_bitrate', where),
    `${where}.video_bitrate`,
    1,
    MAX_OTIO_PROGRAM_VIDEO_BITRATE
  );
  if (required(record, 'audio_codec', where) !== OTIO_PROGRAM_AUDIO_CODEC) {
    fail(`${where}.audio_codec must be ${OTIO_PROGRAM_AUDIO_CODEC}`);
  }
  if (required(record, 'audio_rate', where) !== OTIO_PROGRAM_AUDIO_RATE) {
    fail(`${where}.audio_rate must be ${OTIO_PROGRAM_AUDIO_RATE}`);
  }
  if (required(record, 'channels', where) !== OTIO_PROGRAM_CHANNELS) {
    fail(`${where}.channels must be ${OTIO_PROGRAM_CHANNELS}`);
  }
  const audio_samples = expectInt(
    required(record, 'audio_samples', where),
    `${where}.audio_samples`,
    1,
    MAX_AUDIO_SAMPLES
  );

  const seconds = range.duration.value / range.duration.rate;
  const frameExact = (seconds * frame_rate.num) / frame_rate.den;
  if (!(Math.abs(frameExact - frames) < 1)) {
    fail(`${where}.frames disagrees with range.duration at frame_rate`);
  }
  const sampleExact = seconds * OTIO_PROGRAM_AUDIO_RATE;
  if (!(Math.abs(sampleExact - audio_samples) <= AUDIO_SAMPLE_TOLERANCE)) {
    fail(`${where}.audio_samples disagrees with range.duration at audio_rate`);
  }

  return {
    entry: got,
    sha256,
    bytes,
    range,
    frame_rate,
    frames,
    width,
    height,
    video_codec: videoCodec,
    video_bitrate,
    audio_codec: OTIO_PROGRAM_AUDIO_CODEC,
    audio_rate: OTIO_PROGRAM_AUDIO_RATE,
    channels: OTIO_PROGRAM_CHANNELS,
    audio_samples,
  };
}

function expectReason(value: unknown, where: string): OtioProgramReason {
  const record = expectRecord(value, where, REASON_KEYS);
  const code = required(record, 'code', where);
  if (
    typeof code !== 'string' ||
    !(OTIO_PROGRAM_REASON_CODES as readonly string[]).includes(code)
  ) {
    fail(`${where}.code is not a known reason code`);
  }
  const message = expectString(
    required(record, 'message', where),
    `${where}.message`,
    1,
    MAX_STRING
  );
  const reason: {
    code: OtioProgramReasonCode;
    message: string;
    node_id?: string;
    time?: OtioRationalTime;
  } = { code: code as OtioProgramReasonCode, message };
  if (Object.hasOwn(record, 'node_id')) {
    reason.node_id = expectString(
      record.node_id,
      `${where}.node_id`,
      1,
      MAX_STRING
    );
  }
  if (Object.hasOwn(record, 'time')) {
    reason.time = expectRational(record.time, `${where}.time`);
  }
  return reason;
}

function expectStatus(
  value: unknown,
  where: string
): 'rendered' | 'unavailable' {
  if (value === 'rendered') return 'rendered';
  if (value === 'unavailable') return 'unavailable';
  fail(`${where}.status must be rendered or unavailable`);
}

function expectTimeline(
  value: unknown,
  where: string,
  position: number
): OtioProgramTimelineRecord {
  const record = expectRecord(value, where, TIMELINE_KEYS);
  const timeline_id = expectString(
    required(record, 'timeline_id', where),
    `${where}.timeline_id`,
    1,
    MAX_STRING
  );
  const index = expectInt(
    required(record, 'index', where),
    `${where}.index`,
    0,
    MAX_OTIO_PROGRAM_TIMELINES - 1
  );
  if (index !== position) fail(`${where}.index must be ${position}`);
  const status = expectStatus(required(record, 'status', where), where);
  const reasons = required(record, 'reasons', where);
  if (!Array.isArray(reasons)) fail(`${where}.reasons must be an array`);

  if (status === 'rendered') {
    if (reasons.length !== 0)
      fail(`${where}: a rendered timeline has no reasons`);
    if (Object.hasOwn(record, 'program') === false) {
      fail(`${where}.program is missing for a rendered timeline`);
    }
    const program = expectDescriptor(
      record.program,
      `${where}.program`,
      otioProgramEntryName(index)
    );
    return { timeline_id, index, status, reasons: [], program };
  }

  if (Object.hasOwn(record, 'program')) {
    fail(`${where}: an unavailable timeline must not carry a program`);
  }
  if (reasons.length < 1 || reasons.length > MAX_OTIO_PROGRAM_REASONS) {
    fail(
      `${where}: an unavailable timeline needs 1 to ${MAX_OTIO_PROGRAM_REASONS} reasons`
    );
  }
  return {
    timeline_id,
    index,
    status,
    reasons: reasons.map((item, i) =>
      expectReason(item, `${where}.reasons[${i}]`)
    ),
  };
}

function expectRenderer(value: unknown): OtioProgramManifestV1['renderer'] {
  const record = expectRecord(value, 'manifest.renderer', RENDERER_KEYS);
  const client = expectString(
    required(record, 'client', 'manifest.renderer'),
    'manifest.renderer.client',
    1,
    128
  );
  if (
    required(record, 'protocol', 'manifest.renderer') !== OTIO_PROGRAM_PROTOCOL
  ) {
    fail(`manifest.renderer.protocol must be ${OTIO_PROGRAM_PROTOCOL}`);
  }
  const browser = expectString(
    required(record, 'browser', 'manifest.renderer'),
    'manifest.renderer.browser',
    1,
    128
  );
  return { client, protocol: OTIO_PROGRAM_PROTOCOL, browser };
}

const MANIFEST_KEYS = [
  'schema',
  'document_sha256',
  'renderer',
  'media',
  'timelines',
] as const;
const RENDERER_KEYS = ['client', 'protocol', 'browser'] as const;
const TIMELINE_KEYS = [
  'timeline_id',
  'index',
  'status',
  'reasons',
  'program',
] as const;
const DESCRIPTOR_KEYS = [
  'entry',
  'sha256',
  'bytes',
  'range',
  'frame_rate',
  'frames',
  'width',
  'height',
  'video_codec',
  'video_bitrate',
  'audio_codec',
  'audio_rate',
  'channels',
  'audio_samples',
] as const;
const REASON_KEYS = ['code', 'message', 'node_id', 'time'] as const;

function expectManifest(value: unknown): OtioProgramManifestV1 {
  const record = expectRecord(value, 'manifest', MANIFEST_KEYS);
  if (required(record, 'schema', 'manifest') !== OTIO_PROGRAM_SCHEMA) {
    fail(`manifest.schema must be ${OTIO_PROGRAM_SCHEMA}`);
  }
  const document_sha256 = expectSha(
    required(record, 'document_sha256', 'manifest'),
    'manifest.document_sha256'
  );
  const renderer = expectRenderer(required(record, 'renderer', 'manifest'));
  const media = expectMedia(required(record, 'media', 'manifest'));
  const timelinesValue = required(record, 'timelines', 'manifest');
  if (
    !Array.isArray(timelinesValue) ||
    timelinesValue.length < 1 ||
    timelinesValue.length > MAX_OTIO_PROGRAM_TIMELINES
  ) {
    fail(
      `manifest.timelines must hold 1 to ${MAX_OTIO_PROGRAM_TIMELINES} records`
    );
  }
  const timelines = timelinesValue.map((item, i) =>
    expectTimeline(item, `manifest.timelines[${i}]`, i)
  );
  if (new Set(timelines.map((t) => t.timeline_id)).size !== timelines.length) {
    fail('manifest.timelines has a duplicate timeline_id');
  }
  return {
    schema: OTIO_PROGRAM_SCHEMA,
    document_sha256,
    renderer,
    media,
    timelines,
  };
}

/**
 * Parses and validates manifest bytes against the schema alone. It checks the
 * structure, bounds, paths and internal consistency, but not the archive. Use
 * `readOtioProgramArchive` before trusting any render.
 */
export function parseOtioProgramManifest(
  bytes: Uint8Array
): OtioProgramManifestV1 {
  if (bytes.byteLength > MAX_OTIO_PROGRAM_MANIFEST_BYTES) {
    throw new OtioProgramError(
      'size-cap-exceeded',
      `manifest exceeds ${MAX_OTIO_PROGRAM_MANIFEST_BYTES} bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = parseOtioJson(bytes);
  } catch (err) {
    fail(`manifest is not valid JSON: ${(err as Error).message}`);
  }
  return expectManifest(parsed);
}

/**
 * Serializes a manifest as canonical JSON. It refuses to emit a manifest that
 * `parseOtioProgramManifest` would reject.
 */
export function stringifyOtioProgramManifest(
  manifest: OtioProgramManifestV1
): Uint8Array {
  const bytes = new TextEncoder().encode(stringifyOtioJson(manifest));
  parseOtioProgramManifest(bytes);
  return bytes;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const input =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? (bytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Verifies the program contract against an indexed archive. It returns null
 * when the archive carries no program, which means focus-only. Otherwise every
 * check must pass, or it throws `OtioProgramError`:
 *
 * - the manifest is DEFLATE and parses under `parseOtioProgramManifest`;
 * - its document and timeline ids match the OTIO document and content.otio;
 * - no `relic/program` entry exists beyond the manifest and the rendered MP4s;
 * - each rendered MP4 is STORED, matches its size, and matches its sha256;
 * - each media entry is present and matches its sha256;
 * - the expanded total stays within the archive cap.
 *
 * `document` comes from `readOtioDocument(zip.contentOtioBytes)`.
 */
export async function readOtioProgramArchive(
  zip: OtioZipIndex,
  document: {
    readonly document_sha256: string;
    readonly timeline_ids: readonly string[];
  }
): Promise<OtioProgramArchive | null> {
  const reserved = [...zip.entries.values()].filter(
    (info) => !info.isDirectory && info.name.startsWith(RESERVED_PREFIX)
  );
  const manifestInfo = zip.entries.get(OTIO_PROGRAM_MANIFEST_ENTRY);
  if (!manifestInfo) {
    if (reserved.length > 0) {
      mismatch(`program entries exist without ${OTIO_PROGRAM_MANIFEST_ENTRY}`);
    }
    return null;
  }
  if (manifestInfo.isDirectory || manifestInfo.method !== ZIP_DEFLATE) {
    mismatch(`${OTIO_PROGRAM_MANIFEST_ENTRY} must be a DEFLATE file`);
  }
  if (manifestInfo.uncompressedSize > MAX_OTIO_PROGRAM_MANIFEST_BYTES) {
    throw new OtioProgramError(
      'size-cap-exceeded',
      `${OTIO_PROGRAM_MANIFEST_ENTRY} exceeds ${MAX_OTIO_PROGRAM_MANIFEST_BYTES} bytes`
    );
  }
  const manifest = parseOtioProgramManifest(
    await zip.readEntry(OTIO_PROGRAM_MANIFEST_ENTRY)
  );

  if (
    manifest.document_sha256 !== document.document_sha256 ||
    document.document_sha256 !== zip.contentSha256
  ) {
    mismatch('manifest is not bound to this content.otio');
  }
  if (manifest.timelines.length !== document.timeline_ids.length) {
    mismatch('manifest timeline count differs from the document');
  }

  const expectedEntries = new Set<string>();
  let expandedBytes = manifestInfo.uncompressedSize;
  manifest.timelines.forEach((record, i) => {
    if (record.timeline_id !== document.timeline_ids[i]) {
      mismatch(`timeline ${i} does not match the document`);
    }
    if (record.status === 'rendered') {
      expectedEntries.add(record.program.entry);
      expandedBytes += record.program.bytes;
    }
  });
  if (expandedBytes > MAX_EXPANDED_ZIP_BYTES) {
    throw new OtioProgramError(
      'size-cap-exceeded',
      `program bytes exceed ${MAX_EXPANDED_ZIP_BYTES} bytes`
    );
  }

  for (const info of zip.entries.values()) {
    if (info.isDirectory || !info.name.startsWith(RESERVED_PREFIX)) continue;
    if (info.name === OTIO_PROGRAM_MANIFEST_ENTRY) continue;
    if (!expectedEntries.has(info.name)) {
      mismatch(`unexpected program archive entry ${info.name}`);
    }
  }

  const programs = new Map<number, Uint8Array>();
  for (const record of manifest.timelines) {
    if (record.status !== 'rendered') continue;
    const { entry, bytes: size, sha256 } = record.program;
    const info = zip.entries.get(entry);
    if (!info || info.isDirectory) mismatch(`missing program entry ${entry}`);
    if (
      info.method !== ZIP_STORED ||
      info.compressedSize !== info.uncompressedSize
    ) {
      mismatch(`${entry} must be STORED without compression`);
    }
    if (info.uncompressedSize !== size) {
      mismatch(`${entry} size differs from the manifest`);
    }
    const bytes = await zip.readEntry(entry);
    if (bytes.byteLength !== size) mismatch(`${entry} read length differs`);
    if ((await digestHex(bytes)) !== sha256) {
      throw new OtioProgramError('digest-mismatch', `${entry} sha256 mismatch`);
    }
    programs.set(record.index, bytes);
  }

  for (const [path, sha] of Object.entries(manifest.media)) {
    const info = zip.entries.get(path);
    if (!info || info.isDirectory)
      mismatch(`media ${path} is not in the archive`);
    if ((await digestHex(await zip.readEntry(path))) !== sha) {
      throw new OtioProgramError(
        'digest-mismatch',
        `media ${path} sha256 mismatch`
      );
    }
  }

  return { manifest, programs };
}
