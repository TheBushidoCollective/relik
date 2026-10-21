// Runs inside headless Chrome. Two probes:
// raw(): seeks a bare <video> like seekElement() does, then reads the frame
//        index painted by drawImage after 'seeked' (the viewer's read path).
// viewer(): drives the real createOtioPlayback against a synthetic OTIO
//        document and reads the composed output canvas.
import { compareRationalTimes, readOtioDocument } from '@relic/format';
import { createOtioPlayback } from '../src/otio-playback.ts';

const W = 64;
const H = 16;

function decode(ctx: CanvasRenderingContext2D): number | null {
  const d = ctx.getImageData(0, 0, W, H).data;
  const red = (x: number): number => d[(8 * W + x) * 4] ?? 0;
  if (red(4) < 128) return null;
  let n = 0;
  for (let b = 0; b < 7; b += 1) if (red(8 * (b + 1) + 4) > 128) n |= 1 << b;
  return n;
}

// Verbatim copy of otio-playback.ts videoDecoderTime at bf48a31.
function videoDecoderTime(sourceTime: { value: number; rate: number }): number {
  const floor = Math.floor(sourceTime.value);
  const next = { value: floor + 1, rate: sourceTime.rate };
  const frame = compareRationalTimes(next, sourceTime) <= 0 ? floor + 1 : floor;
  return (frame + 0.5) / sourceTime.rate;
}

async function blobUrl(path: string): Promise<string> {
  const response = await fetch(path);
  return URL.createObjectURL(await response.blob());
}

function once(target: EventTarget, name: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  target.addEventListener(name, () => resolve(), { once: true });
  return promise;
}

function presented(
  video: HTMLVideoElement,
  ms: number
): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof video.requestVideoFrameCallback !== 'function') {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    video.requestVideoFrameCallback((_now, meta) => {
      clearTimeout(timer);
      resolve(meta.mediaTime);
    });
  });
}

interface RawCase {
  readonly name: string;
  readonly path: string;
  readonly fps: number;
  readonly samples: readonly {
    readonly value: number;
    readonly rate: number;
  }[];
  readonly hidden?: boolean;
}

async function raw(cases: readonly RawCase[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of cases) {
    const url = await blobUrl(c.path);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    const host = document.createElement('div');
    if (c.hidden) {
      host.style.position = 'absolute';
      host.style.width = '1px';
      host.style.height = '1px';
      host.style.overflow = 'hidden';
      host.style.clipPath = 'inset(50%)';
    }
    host.appendChild(video);
    document.body.appendChild(host);
    const loaded = once(video, 'loadeddata');
    video.src = url;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    const rows: unknown[] = [];
    for (const sample of c.samples) {
      const exact = sample.value / sample.rate;
      const mid = videoDecoderTime(sample);
      const read = async (target: number) => {
        const frame = presented(video, 250);
        const seeked = once(video, 'seeked');
        video.currentTime = target;
        await seeked;
        ctx.drawImage(video, 0, 0, W, H);
        const index = decode(ctx);
        return { index, mediaTime: await frame };
      };
      const atExact = await read(exact);
      const atMid = await read(mid);
      const frameTime = { value: exact * c.fps, rate: c.fps };
      const naturalMid = videoDecoderTime(frameTime);
      const atNaturalMid = await read(naturalMid);
      rows.push({ sample, exact, mid, naturalMid, atExact, atMid, atNaturalMid });
    }
    host.remove();
    URL.revokeObjectURL(url);
    out.push({ name: c.name, path: c.path, rows });
  }
  return out;
}

interface ViewerCase {
  readonly name: string;
  readonly otio: string;
  readonly media: Readonly<Record<string, string>>;
  readonly times: readonly { readonly value: number; readonly rate: number }[];
}

async function viewer(cases: readonly ViewerCase[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of cases) {
    const doc = readOtioDocument(c.otio);
    const timelineId = doc.timeline_ids[0];
    if (!timelineId) throw new Error(`${c.name}: no timeline`);
    const urls = new Map<string, string>();
    for (const [entry, path] of Object.entries(c.media)) {
      urls.set(entry, await blobUrl(path));
    }
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    const playback = createOtioPlayback({
      document: doc,
      timelineId,
      canvas,
      resolveMedia: async (entry) => urls.get(entry) ?? null,
    });
    const rows: unknown[] = [];
    for (const time of c.times) {
      await playback.seek(time);
      const state = playback.getState();
      rows.push({
        time,
        index: decode(ctx),
        diagnostics: state.diagnostics.map((d) => d.code),
      });
    }
    playback.dispose();
    canvas.remove();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    out.push({ name: c.name, rows });
  }
  return out;
}

async function rvfcInHiddenHost(path: string): Promise<unknown> {
  const url = await blobUrl(path);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.width = '1px';
  host.style.height = '1px';
  host.style.overflow = 'hidden';
  host.style.clipPath = 'inset(50%)';
  host.appendChild(video);
  document.body.appendChild(host);
  const loaded = once(video, 'loadeddata');
  video.src = url;
  await loaded;
  const frame = presented(video, 1000);
  const seeked = once(video, 'seeked');
  video.currentTime = 0.5;
  await seeked;
  const mediaTime = await frame;
  host.remove();
  return {
    hasApi: typeof video.requestVideoFrameCallback === 'function',
    mediaTimeAfterSeek: mediaTime,
  };
}

Object.assign(window, {
  probeRaw: raw,
  probeViewer: viewer,
  rvfcInHiddenHost,
  probeReady: true,
});
