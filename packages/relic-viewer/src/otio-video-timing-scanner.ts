import {
  CustomSource,
  EncodedPacketSink,
  Input,
  Logging,
  MP4,
  QTFF,
  WEBM,
} from 'mediabunny';
import type {
  OtioVideoTiming,
  OtioVideoTimingReason,
} from './otio-video-timing.ts';
import {
  IsoEditGateFailure,
  type IsoPresentationEdit,
  type OtioVideoTimingByteReader,
  readSafeIsoPresentationEdit,
} from './otio-video-timing-iso.ts';

export interface OtioVideoTimingLimits {
  readonly maxFileBytes: number;
  readonly maxSourceCacheBytes: number;
  readonly maxReadBytes: number;
  readonly maxTotalReadBytes: number;
  readonly maxReadCalls: number;
  readonly maxPackets: number;
  readonly maxIndexBytes: number;
}

export const OTIO_VIDEO_TIMING_LIMITS: OtioVideoTimingLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxSourceCacheBytes: 2 * 1024 * 1024,
  maxReadBytes: 8 * 1024 * 1024,
  maxTotalReadBytes: 100 * 1024 * 1024,
  maxReadCalls: 8192,
  maxPackets: 200_000,
  maxIndexBytes: 16 * 1024 * 1024,
};

const PACKET_OPTIONS = { metadataOnly: true, skipLiveWait: true } as const;

export interface OtioVideoTimingPacket {
  readonly timestamp: number;
  readonly duration: number;
}

interface TimingSourceOptions {
  readonly getSize: () => number;
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
  readonly dispose: () => void;
  readonly maxCacheSize: number;
  readonly prefetchProfile: 'none';
}

interface TimingSource {
  readonly options: TimingSourceOptions;
}

interface TimingVideoTrack {
  readonly id: number;
}

interface TimingInput {
  getFormat(): Promise<unknown>;
  getVideoTracks(): Promise<TimingVideoTrack[]>;
  dispose(): void;
}

interface TimingPacketSink {
  getFirstPacket(options: typeof PACKET_OPTIONS): Promise<OtioVideoTimingPacket | null>;
  getNextPacket(
    packet: OtioVideoTimingPacket,
    options: typeof PACKET_OPTIONS
  ): Promise<OtioVideoTimingPacket | null>;
}

export interface OtioVideoTimingDemuxApi {
  readonly CustomSource: new (options: TimingSourceOptions) => TimingSource;
  readonly Input: new (options: {
    readonly formats: readonly unknown[];
    readonly source: TimingSource;
  }) => TimingInput;
  readonly EncodedPacketSink: new (track: TimingVideoTrack) => TimingPacketSink;
  readonly Logging: {
    on(
      event: 'warn' | 'error',
      listener: (args: unknown[]) => unknown
    ): () => void;
  };
  readonly MP4: unknown;
  readonly QTFF: unknown;
  readonly WEBM: unknown;
}

/** Internal test seam. Production callers cannot supply resource limits. */
export interface OtioVideoTimingScannerTestOptions {
  readonly limits?: Partial<OtioVideoTimingLimits>;
}

export class OtioVideoTimingScanFailure extends Error {
  constructor(readonly reason: OtioVideoTimingReason) {
    super(reason);
    this.name = 'OtioVideoTimingScanFailure';
  }
}

class BudgetedBlobReader implements OtioVideoTimingByteReader {
  readonly size: number;
  private reads = 0;
  private bytes = 0;
  private disposed = false;

  constructor(
    private readonly blob: Blob,
    private readonly limits: OtioVideoTimingLimits
  ) {
    this.size = blob.size;
  }

  dispose(): void {
    this.disposed = true;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (this.disposed) throw new OtioVideoTimingScanFailure('cancelled');
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      !(start < end) ||
      end > this.size
    ) {
      throw new OtioVideoTimingScanFailure('unsupported-container');
    }

    const length = end - start;
    if (
      length > this.limits.maxReadBytes ||
      this.reads >= this.limits.maxReadCalls ||
      this.bytes > this.limits.maxTotalReadBytes - length
    ) {
      throw new OtioVideoTimingScanFailure('read-budget');
    }
    this.reads += 1;
    this.bytes += length;

    const bytes = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new OtioVideoTimingScanFailure('unsupported-container');
    }
    return bytes;
  }
}

const productionDemuxApi: OtioVideoTimingDemuxApi = {
  CustomSource: CustomSource as unknown as OtioVideoTimingDemuxApi['CustomSource'],
  Input: Input as unknown as OtioVideoTimingDemuxApi['Input'],
  EncodedPacketSink:
    EncodedPacketSink as unknown as OtioVideoTimingDemuxApi['EncodedPacketSink'],
  Logging: Logging as unknown as OtioVideoTimingDemuxApi['Logging'],
  MP4,
  QTFF,
  WEBM,
};

function unknown(reason: OtioVideoTimingReason): OtioVideoTiming {
  return { kind: 'unknown', reason };
}

function scanFailure(reason: OtioVideoTimingReason): never {
  throw new OtioVideoTimingScanFailure(reason);
}

function resolvedLimits(
  overrides: Partial<OtioVideoTimingLimits> | undefined
): OtioVideoTimingLimits {
  return { ...OTIO_VIDEO_TIMING_LIMITS, ...overrides };
}

function validatePacket(packet: OtioVideoTimingPacket): void {
  if (
    !Number.isFinite(packet.timestamp) ||
    !Number.isFinite(packet.duration) ||
    packet.duration < 0
  ) {
    scanFailure('invalid-packet-timing');
  }
}

function finalPacketEnd(packet: OtioVideoTimingPacket): number | null {
  if (!(packet.duration > 0)) return null;
  const end = packet.timestamp + packet.duration;
  if (!Number.isFinite(end) || !(packet.timestamp < end)) {
    scanFailure('invalid-packet-timing');
  }
  return end;
}

function validateEditExtent(
  edit: IsoPresentationEdit | null,
  packets: readonly OtioVideoTimingPacket[]
): void {
  if (!edit || packets.length === 0) return;
  if (
    !Number.isFinite(edit.start) ||
    !Number.isFinite(edit.end) ||
    !Number.isFinite(edit.movieTimescale) ||
    edit.start < 0 ||
    !(edit.start < edit.end) ||
    edit.movieTimescale <= 0
  ) {
    scanFailure('unsupported-edit-list');
  }

  const finalPacket = packets[packets.length - 1];
  if (!finalPacket) return;
  if (!(finalPacket.timestamp < edit.end)) {
    scanFailure('edit-window-mismatch');
  }

  const finalEnd = finalPacketEnd(finalPacket);
  if (finalEnd === null) return;
  const oneMovieTick = 1 / edit.movieTimescale;
  if (!Number.isFinite(oneMovieTick) || oneMovieTick <= 0) {
    scanFailure('unsupported-edit-list');
  }
  if (edit.end - finalEnd > oneMovieTick) {
    scanFailure('edit-window-mismatch');
  }
}

/**
 * Builds only packet-PTS intervals that can be certified without inferring an
 * ideal cadence. The final zero-duration packet stays uncovered rather than
 * inventing a final window.
 */
export function windowsFromOtioVideoPackets(
  packets: readonly OtioVideoTimingPacket[],
  edit: IsoPresentationEdit | null,
  maxIndexBytes = OTIO_VIDEO_TIMING_LIMITS.maxIndexBytes
): OtioVideoTiming {
  try {
    if (packets.length === 0) return unknown('unknown-duration');
    if (
      !Number.isSafeInteger(maxIndexBytes) ||
      maxIndexBytes < 0 ||
      packets.length >
        Math.floor(maxIndexBytes / (Float64Array.BYTES_PER_ELEMENT * 2))
    ) {
      return unknown('index-budget');
    }

    for (const packet of packets) validatePacket(packet);
    const sorted = packets
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const packet = sorted[index];
      if (!previous || !packet || !(previous.timestamp < packet.timestamp)) {
        return unknown('invalid-packet-timing');
      }
    }

    validateEditExtent(edit, sorted);
    const visibleStart = Math.max(0, edit?.start ?? 0);
    const visibleEnd = edit?.end ?? Infinity;
    const starts: number[] = [];
    const ends: number[] = [];

    for (let index = 0; index < sorted.length; index += 1) {
      const packet = sorted[index];
      if (!packet) return unknown('invalid-packet-timing');
      const next = sorted[index + 1];
      let end: number | null;

      if (next) {
        if (!(packet.timestamp < next.timestamp)) {
          return unknown('invalid-packet-timing');
        }
        end = next.timestamp;
        const reportedEnd = finalPacketEnd(packet);
        if (reportedEnd !== null) end = Math.min(end, reportedEnd);
      } else {
        end = finalPacketEnd(packet);
      }

      if (end === null) continue;
      const start = Math.max(packet.timestamp, visibleStart);
      const clippedEnd = Math.min(end, visibleEnd);
      if (!Number.isFinite(start) || !Number.isFinite(clippedEnd)) {
        return unknown('invalid-packet-timing');
      }
      if (start < clippedEnd) {
        starts.push(start);
        ends.push(clippedEnd);
      }
    }

    if (starts.length === 0) return unknown('unknown-duration');
    if (
      starts.length >
      Math.floor(maxIndexBytes / (Float64Array.BYTES_PER_ELEMENT * 2))
    ) {
      return unknown('index-budget');
    }
    return {
      kind: 'windows',
      starts: new Float64Array(starts),
      ends: new Float64Array(ends),
    };
  } catch (error) {
    if (error instanceof OtioVideoTimingScanFailure) return unknown(error.reason);
    throw error;
  }
}

function errorTiming(error: unknown, warned: boolean): OtioVideoTiming {
  if (warned) return unknown('demux-warning');
  if (error instanceof OtioVideoTimingScanFailure) return unknown(error.reason);
  if (error instanceof IsoEditGateFailure) return unknown(error.reason);
  return unknown('unsupported-container');
}

/**
 * Scanner used only inside the dedicated metadata worker. The optional limits
 * seam is test-only; production always uses the fixed values above.
 */
export async function scanOtioVideoTimingWithApi(
  blob: Blob,
  mimeType: string,
  api: OtioVideoTimingDemuxApi,
  options: OtioVideoTimingScannerTestOptions = {}
): Promise<OtioVideoTiming> {
  void mimeType;
  const limits = resolvedLimits(options.limits);
  if (!Number.isFinite(blob.size) || blob.size < 0) {
    return unknown('unsupported-container');
  }
  if (blob.size > limits.maxFileBytes) return unknown('file-too-large');

  const reader = new BudgetedBlobReader(blob, limits);
  let warned = false;
  let stopWarn: (() => void) | undefined;
  let stopError: (() => void) | undefined;
  let input: TimingInput | undefined;

  try {
    stopWarn = api.Logging.on('warn', () => {
      warned = true;
    });
    stopError = api.Logging.on('error', () => {
      warned = true;
    });

    const source = new api.CustomSource({
      getSize: () => reader.size,
      maxCacheSize: limits.maxSourceCacheBytes,
      prefetchProfile: 'none',
      read: (start, end) => reader.read(start, end),
      dispose: () => reader.dispose(),
    });
    input = new api.Input({ formats: [api.MP4, api.QTFF, api.WEBM], source });

    const format = await input.getFormat();
    if (warned) return unknown('demux-warning');
    if (format !== api.MP4 && format !== api.QTFF && format !== api.WEBM) {
      return unknown('unsupported-container');
    }
    const tracks = await input.getVideoTracks();
    if (warned) return unknown('demux-warning');
    if (tracks.length !== 1) return unknown('ambiguous-video-track');
    const track = tracks[0];
    if (!track) return unknown('ambiguous-video-track');

    const edit =
      format === api.MP4 || format === api.QTFF
        ? await readSafeIsoPresentationEdit(reader, track.id)
        : null;
    if (warned) return unknown('demux-warning');

    const sink = new api.EncodedPacketSink(track);
    const packets: OtioVideoTimingPacket[] = [];
    let packet = await sink.getFirstPacket(PACKET_OPTIONS);
    if (warned) return unknown('demux-warning');
    while (packet) {
      if (packets.length >= limits.maxPackets) return unknown('packet-budget');
      validatePacket(packet);
      packets.push({ timestamp: packet.timestamp, duration: packet.duration });
      packet = await sink.getNextPacket(packet, PACKET_OPTIONS);
      if (warned) return unknown('demux-warning');
    }

    return windowsFromOtioVideoPackets(packets, edit, limits.maxIndexBytes);
  } catch (error) {
    return errorTiming(error, warned);
  } finally {
    try {
      input?.dispose();
    } catch {
      // The worker realm is being discarded either way; cleanup still continues.
    }
    reader.dispose();
    stopError?.();
    stopWarn?.();
  }
}

export function scanOtioVideoTiming(
  blob: Blob,
  mimeType: string
): Promise<OtioVideoTiming> {
  return scanOtioVideoTimingWithApi(blob, mimeType, productionDemuxApi);
}
