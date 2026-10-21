// Investigation only. Imports an unmodified copy of the exact published package.
// No decoders, encoders, sample sinks, network sources, or codec configuration.
import {
  CustomSource,
  EncodedPacketSink,
  Input,
  Logging,
  MP4,
  QTFF,
  WEBM,
} from '../../../probe/vendor-scratch/package/dist/modules/src/index.js';

const MAX_FILE = 100 * 1024 * 1024;
const MAX_READ = 8 * 1024 * 1024;
const MAX_READ_TOTAL = 100 * 1024 * 1024;
const MAX_READ_CALLS = 8192;
const MAX_PACKETS = 200000;

function decodeIndex(video: HTMLVideoElement): number | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no canvas context');
  context.drawImage(video, 0, 0, 64, 16);
  const data = context.getImageData(0, 0, 64, 16).data;
  if (data[(8 * 64 + 4) * 4] < 128) return null;
  let index = 0;
  for (let bit = 0; bit < 7; bit += 1) {
    if (data[(8 * 64 + (bit + 1) * 8 + 4) * 4] > 128) index |= 1 << bit;
  }
  return index;
}

function event(target: EventTarget, name: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  target.addEventListener(name, () => resolve(), { once: true });
  return promise;
}

async function probeDemux(
  path: string,
  sampleTimes: number[]
): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`probe transport ${response.status}: ${path}`);
  const blob = await response.blob();
  if (blob.size > MAX_FILE) throw new Error('file-byte-cap');
  let reads = 0;
  let readBytes = 0;
  let largestRead = 0;
  let disposed = false;
  const source = new CustomSource({
    getSize: () => blob.size,
    maxCacheSize: 2 * 1024 * 1024,
    prefetchProfile: 'none',
    read: async (start: number, end: number) => {
      const length = end - start;
      reads += 1;
      if (
        reads > MAX_READ_CALLS ||
        length > MAX_READ ||
        readBytes + length > MAX_READ_TOTAL
      )
        throw new Error('read-budget');
      readBytes += length;
      largestRead = Math.max(largestRead, length);
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
    dispose: () => {
      disposed = true;
    },
  });
  const warnings: string[][] = [];
  const stopWarnings = Logging.on('warn', (args: unknown[]) => { warnings.push(args.map(String)); });
  const input = new Input({ formats: [MP4, QTFF, WEBM], source });
  const packets: {
    timestamp: number;
    duration: number;
    sequence: number;
    byteLength: number;
    dataBytes: number;
    metadataOnly: boolean;
  }[] = [];
  let format: string | null = null;
  let resolution: number | null = null;
  try {
    format = (await input.getFormat()).name;
    const tracks = await input.getVideoTracks();
    if (tracks.length !== 1) throw new Error('ambiguous-track');
    const track = tracks[0];
    resolution = await track.getTimeResolution();
    const sink = new EncodedPacketSink(track);
    let packet = await sink.getFirstPacket({
      metadataOnly: true,
      skipLiveWait: true,
    });
    while (packet) {
      if (packets.length >= MAX_PACKETS) throw new Error('packet-cap');
      packets.push({
        timestamp: packet.timestamp,
        duration: packet.duration,
        sequence: packet.sequenceNumber,
        byteLength: packet.byteLength,
        dataBytes: packet.data.byteLength,
        metadataOnly: packet.isMetadataOnly,
      });
      packet = await sink.getNextPacket(packet, {
        metadataOnly: true,
        skipLiveWait: true,
      });
    }
  } finally {
    input.dispose();
    stopWarnings();
  }
  const inDecodeOrder = packets.map((p) => p.timestamp);
  packets.sort((a, b) => a.timestamp - b.timestamp);
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  document.body.appendChild(video);
  const loaded = event(video, 'loadeddata');
  video.src = url;
  await loaded;
  const rows: unknown[] = [];
  for (const time of sampleTimes) {
    let index = -1;
    for (let i = 0; i < packets.length; i += 1) {
      if (packets[i].timestamp <= time) index = i;
      else break;
    }
    if (index < 0) {
      rows.push({ time, window: null });
      continue;
    }
    const start = packets[index].timestamp;
    const end =
      index + 1 < packets.length
        ? packets[index + 1].timestamp
        : start + packets[index].duration;
    if (!(start <= time && time < end && end > start)) {
      rows.push({ time, window: null });
      continue;
    }
    const target = start + (end - start) / 2;
    const seeked = event(video, 'seeked');
    video.currentTime = target;
    await seeked;
    rows.push({
      time,
      window: [start, end],
      target,
      presentedIndex: decodeIndex(video),
      actualCurrentTime: video.currentTime,
      packetOrdinal: index,
    });
  }
  video.remove();
  URL.revokeObjectURL(url);
  return {
    path,
    blobBytes: blob.size,
    format,
    resolution,
    packetCount: packets.length,
    readCalls: reads,
    readBytes,
    largestRead,
    sourceDisposed: disposed,
    videoDuration: video.duration,
    warnings,
    allMetadataOnly: packets.every((p) => p.metadataOnly && p.dataBytes === 0),
    firstPackets: packets.slice(0, 6),
    lastPacket: packets.at(-1),
    decodeOrderFirst: inDecodeOrder.slice(0, 8),
    presentationOrderFirst: packets.slice(0, 8).map((p) => p.timestamp),
    rows,
  };
}
Object.assign(window, { probeDemux, demuxProbeReady: true });
