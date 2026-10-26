import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Script } from 'node:vm';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
  type BrowserHeadlessLaunch,
} from './browser-headless.ts';
import { scanOtioVideoTiming } from '../../relic-viewer/src/otio-video-timing-scanner.ts';
import type { OtioVideoTiming } from '../../relic-viewer/src/otio-video-timing.ts';

export interface WindowOption {
  readonly name: string;
  readonly start: number;
  readonly duration?: number;
}

export interface BenchmarkOptions {
  readonly urlFile?: string;
  readonly url?: string;
  readonly chromePath?: string;
  readonly durationSeconds?: number;
  readonly warmupSeconds?: number;
  readonly ceilingDurationSeconds?: number;
  readonly repetitions?: number;
  readonly outputJsonPath?: string;
  readonly format?: 'table' | 'json';
  readonly windows?: readonly WindowOption[];
  readonly cpuThrottle?: number;
  readonly mediaPaths?: readonly string[];
}

export interface WindowDefinition {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly description?: string;
}

export interface SeekMetricsByKind {
  readonly count: number;
  readonly perSecond: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyMaxMs: number;
  readonly supersededCount: number;
}

export interface GapsMetrics {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly startEdgeGapMs: number;
  readonly endEdgeGapMs: number;
  readonly stutterCount: number;
}
export interface BufferingMetrics {
  readonly totalBufferingMs: number;
  readonly resyncEpisodes: number;
}
export interface CanvasMetrics {
  readonly resetsCount: number;
  readonly resetsPerComposite: number;
  readonly visibleDrawCount: number;
  readonly visibleDrawsPerComposite: number;
  readonly offscreenDrawCount: number;
  readonly offscreenDrawsPerComposite: number;
  readonly liveElementDraws: number;
}
export interface MainThreadMetrics {
  readonly longTasksCount: number;
  readonly totalLongTaskDurationMs: number;
  readonly loafCount: number;
  readonly totalLoafBlockingMs: number;
  readonly totalLoafStyleLayoutMs: number;
}
export interface DecoderMetrics {
  readonly insertionsCount: number;
  readonly stuttersNearInsertions: number;
  readonly stuttersNearInsertionsPercent: number;
}
export interface CpuMetrics {
  readonly processCpuDeltaMs: number;
  readonly loadAvg: readonly number[];
}
export interface CallbackReadoutMetrics {
  readonly p50: number;
  readonly p95: number;
  readonly count: number;
}

export interface RepetitionMetrics {
  readonly windowKey: string;
  readonly repetitionIndex: number;
  readonly actualDurationSeconds: number;
  readonly measuredStart: number;
  readonly measuredEnd: number;
  readonly pausedSeekLatencyMs: number;
  readonly playToFirstFrameMs: number;
  readonly mediaInterval: {
    readonly start: number;
    readonly end: number;
    readonly duration: number;
  };
  readonly presentedMetricsAvailable: boolean;
  readonly wallCadence: number | 'n/a';
  readonly transportCadence: number | 'n/a';
  readonly clockCadence: number;
  readonly cadenceRatio: number;
  readonly compositesCount: number;
  readonly distinctFramesCount: number;
  readonly callbackReadoutMs: CallbackReadoutMetrics;
  readonly gaps: GapsMetrics;
  readonly buffering: BufferingMetrics;
  readonly jumpedHistogram: Record<'0' | '1' | '2' | '3+', number>;
  readonly seeks: {
    readonly videoSeeksCount: number;
    readonly audioSeeksCount: number;
    readonly videoSeeksPerSecond: number;
    readonly audioSeeksPerSecond: number;
    readonly cumulativeLatencyMs: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
    readonly video: SeekMetricsByKind;
    readonly audio: SeekMetricsByKind;
    readonly windowShare: number;
  };
  readonly audio: {
    readonly playCallsCount: number;
    readonly playCallsPerSecond: number;
  };
  readonly canvas: CanvasMetrics;
  readonly vsync: {
    readonly p50IntervalMs: number;
    readonly p95IntervalMs: number;
  };
  readonly mainThread: MainThreadMetrics;
  readonly decoders: DecoderMetrics;
  readonly cpu: CpuMetrics;
}

export interface AggregatedMetrics {
  readonly actualDurationSeconds: number;
  readonly measuredStart: number;
  readonly measuredEnd: number;
  readonly pausedSeekLatencyMs: number;
  readonly playToFirstFrameMs: number;
  readonly mediaInterval: {
    readonly start: number;
    readonly end: number;
    readonly duration: number;
  };
  readonly presentedMetricsAvailable: boolean;
  readonly wallCadence: number | 'n/a';
  readonly transportCadence: number | 'n/a';
  readonly clockCadence: number;
  readonly cadenceRatio: number;
  readonly compositesCount: number;
  readonly distinctFramesCount: number;
  readonly gaps: GapsMetrics;
  readonly callbackReadoutMs: CallbackReadoutMetrics;
  readonly buffering: BufferingMetrics;
  readonly seeks: {
    readonly videoSeeksCount: number;
    readonly audioSeeksCount: number;
    readonly videoSeeksPerSecond: number;
    readonly audioSeeksPerSecond: number;
    readonly cumulativeLatencyMs: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
    readonly video: SeekMetricsByKind;
    readonly audio: SeekMetricsByKind;
    readonly windowShare: number;
  };
  readonly audio: {
    readonly playCallsCount: number;
    readonly playCallsPerSecond: number;
  };
  readonly canvas: CanvasMetrics;
  readonly vsync: {
    readonly p50IntervalMs: number;
    readonly p95IntervalMs: number;
  };
  readonly mainThread: MainThreadMetrics;
  readonly decoders: DecoderMetrics;
  readonly cpu: CpuMetrics;
}

export type NativeCeilingResult =
  | {
      readonly available: true;
      readonly presentedFrames: number;
      readonly totalFrames: number;
      readonly droppedFrames: number;
      readonly elapsedSeconds: number;
      readonly nativeFps: number;
      readonly mediaFps: number;
      readonly ceilingRatio: number;
      readonly distinctWindowsPresented?: number;
      readonly windowsElapsed?: number;
      readonly skipsCount?: number;
      readonly nativeFrameHz?: number;
      readonly mediaSeconds?: number;
      readonly callbackFrames?: number;
      readonly wallMs?: number;
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly ceilingRatio: 'n/a';
    };

export interface BenchmarkReport {
  readonly timestamp: string;
  readonly environment: {
    readonly browserVersion: string;
    readonly platform: string;
    readonly cpuCores: number;
    readonly loadAvg: readonly number[];
    readonly commandLine: readonly string[];
    readonly gpuFeatures?: Record<string, unknown> | undefined;
    readonly nonLoopbackBlockedCount?: number;
  };
  readonly structure: {
    readonly durationSeconds: number;
    readonly timelineRate: number;
    readonly railsCount: number;
    readonly totalItems: number;
    readonly editPointsCount: number;
    readonly editPointsPerMinute: number;
    readonly medianItemLengthSeconds: number;
    readonly p10ItemLengthSeconds: number;
    readonly transitionCount: number;
    readonly diagnosticsByCode: Record<string, number>;
    readonly decodersCount: number;
  };
  readonly windows: Record<string, WindowDefinition>;
  readonly repetitions: Record<string, readonly RepetitionMetrics[]>;
  readonly medians: Record<string, AggregatedMetrics>;
  readonly nativeCeiling: NativeCeilingResult;
  readonly causeClassification: {
    readonly primaryCause:
      | 'Decoder seeks'
      | 'Controller or DOM work'
      | 'Compositor or GPU'
      | 'Edit points'
      | 'The environment itself'
      | 'Indeterminate';
    readonly observations: readonly string[];
  };
}

export function loopbackUrl(value: string): boolean {
  if (
    value.startsWith('blob:') ||
    value.startsWith('data:') ||
    value.startsWith('about:')
  )
    return true;
  try {
    const host = new URL(value).hostname;
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export async function readUrlFromProtectedFile(
  filePath: string
): Promise<string> {
  const fileStat = await stat(filePath);
  if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
    throw new Error(
      `Insecure URL file permissions: ${filePath} has mode 0o${(fileStat.mode & 0o777).toString(8)}, expected 0600`
    );
  }
  const content = await readFile(filePath, 'utf-8');
  const url = content.trim();
  if (!url) throw new Error(`URL file is empty: ${filePath}`);
  if (!loopbackUrl(url))
    throw new Error('Non-loopback URL refused in replay URL file');
  return url;
}

export function createOtioPageProfilerScript(): string {
  return `(() => {
    if (globalThis.__relicOtioProfilerInstalled) return;
    globalThis.__relicOtioProfilerInstalled = true;
    for (const name of ['VideoDecoder', 'AudioDecoder']) {
      const c = Reflect.get(globalThis, name);
      if (typeof c === 'function') {
        Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('__RELIC_OTIO_WEB_CODECS__ ' + name); } });
      }
    }
    let activeTimingWorkers = 0;
    const origWorker = globalThis.Worker;
    if (typeof origWorker === 'function') {
      globalThis.Worker = function(...args) {
        const w = new origWorker(...args);
        const urlStr = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].href ? args[0].href : '');
        if (urlStr.includes('timing-worker')) {
          activeTimingWorkers++;
          const done = () => { w.removeEventListener('message', done); w.removeEventListener('error', done); activeTimingWorkers = Math.max(0, activeTimingWorkers - 1); };
          w.addEventListener('message', done); w.addEventListener('error', done);
          const origTerm = w.terminate;
          w.terminate = function() { done(); return origTerm.apply(this, arguments); };
        }
        return w;
      };
    }
    const MAX_BUFFER = 10000;
    let bufferOverflow = false;
    function pushBounded(arr, item, limit = MAX_BUFFER) {
      if (arr.length < limit) arr.push(item);
      else bufferOverflow = true;
    }
    const activeSeeks = []; const completedSeeks = []; const activeElementSeeks = new WeakMap();
    const audioPlays = []; const visiblePresents = []; const compositeFrames = []; const decoderInsertions = [];
    const longTasks = []; const loaves = []; const vsyncIntervals = []; const callbackReadoutDurations = [];
    let visibleDrawCount = 0; let offscreenDrawCount = 0; let canvasResetsCount = 0; let liveElementDraws = 0;
    let lastVsyncTime = null; let isRecording = false; let recordingStartTime = 0;
    let totalBufferingMs = 0; let bufferingStartTime = null; let resyncEpisodes = 0;
    const decoderOrdinals = new WeakMap();
    let nextDecoderOrdinal = 0;
    function getDecoderOrdinal(video) {
      let ord = decoderOrdinals.get(video);
      if (ord === undefined) { ord = nextDecoderOrdinal++; decoderOrdinals.set(video, ord); }
      return ord;
    }
    const videoFrameOrdinals = new WeakMap();
    const OrigVideoFrame = globalThis.VideoFrame;
    if (typeof OrigVideoFrame === 'function') {
      try {
        class WrappedVideoFrame extends OrigVideoFrame {
          constructor(...args) {
            super(...args);
            try {
              const src = args[0];
              if (src instanceof HTMLVideoElement || (src && src.tagName === 'VIDEO')) {
                const ord = getDecoderOrdinal(src);
                videoFrameOrdinals.set(this, ord);
              }
            } catch {}
          }
        }
        if (typeof OrigVideoFrame.prototype.clone === 'function') {
          const origClone = OrigVideoFrame.prototype.clone;
          OrigVideoFrame.prototype.clone = function(...args) {
            const cloned = origClone.apply(this, args);
            try {
              const ord = videoFrameOrdinals.get(this);
              if (ord !== undefined) videoFrameOrdinals.set(cloned, ord);
            } catch {}
            return cloned;
          };
        }
        globalThis.VideoFrame = WrappedVideoFrame;
        if (typeof window !== 'undefined') window.VideoFrame = WrappedVideoFrame;
      } catch {}
    }
    const canvasUnresolved = new WeakMap();
    const canvasKeySets = new WeakMap();
    function getCanvasKeys(c) {
      let s = canvasKeySets.get(c);
      if (!s) { s = new Set(); canvasKeySets.set(c, s); }
      return s;
    }
    function clearCanvasKeys(c) { const s = canvasKeySets.get(c); if (s) s.clear(); canvasUnresolved.delete(c); }
    const activeCallbackMediaTimes = new WeakMap();
    try {
      const origRVFC = HTMLVideoElement.prototype.requestVideoFrameCallback;
      if (typeof origRVFC === 'function') {
        HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
          const self = this;
          return origRVFC.call(this, (now, metadata) => {
            const prev = activeCallbackMediaTimes.get(self);
            activeCallbackMediaTimes.set(self, (metadata && typeof metadata.mediaTime === 'number') ? metadata.mediaTime : null);
            const t0 = performance.now();
            try { return callback(now, metadata); }
            finally {
              const cbDuration = performance.now() - t0;
              if (isRecording) pushBounded(callbackReadoutDurations, cbDuration, MAX_BUFFER);
              if (prev !== undefined) activeCallbackMediaTimes.set(self, prev);
              else activeCallbackMediaTimes.delete(self);
            }
          });
        };
      }
    } catch {}
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      if (desc && desc.set && desc.get) {
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          configurable: true, enumerable: desc.enumerable,
          get() { return desc.get.call(this); },
          set(targetVal) {
            const now = performance.now();
            const fromVal = desc.get.call(this);
            const numTarget = Number(targetVal);
            const isVideo = this instanceof HTMLVideoElement || this.tagName === 'VIDEO';
            const isAudio = this instanceof HTMLAudioElement || this.tagName === 'AUDIO';
            const kind = isVideo ? 'video' : isAudio ? 'audio' : 'other';
            if (isRecording) {
              const prevSeek = activeElementSeeks.get(this);
              if (prevSeek && !prevSeek.settled) prevSeek.superseded = true;
              const seekRecord = {
                kind, paused: Boolean(this.paused), from: fromVal, to: numTarget,
                distance: Math.abs(numTarget - fromVal), startTime: now, latency: null,
                superseded: false, settled: false,
              };
              activeElementSeeks.set(this, seekRecord);
              pushBounded(activeSeeks, seekRecord, 5000);
              const onSeeked = () => {
                this.removeEventListener('seeked', onSeeked);
                this.removeEventListener('error', onSeeked);
                seekRecord.settled = true;
                seekRecord.latency = performance.now() - now;
                if (isRecording && seekRecord.startTime >= recordingStartTime) {
                  pushBounded(completedSeeks, seekRecord, 5000);
                }
              };
              this.addEventListener('seeked', onSeeked, { once: true });
              this.addEventListener('error', onSeeked, { once: true });
            }
            desc.set.call(this, targetVal);
          },
        });
      }
    } catch {}
    try {
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) {
        if (isRecording && (this instanceof HTMLAudioElement || this.tagName === 'AUDIO')) {
          pushBounded(audioPlays, { timestamp: performance.now() }, 5000);
        }
        return origPlay.apply(this, args);
      };
    } catch {}
    try {
      for (const prop of ['width', 'height']) {
        const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
        if (desc && desc.set && desc.get) {
          Object.defineProperty(HTMLCanvasElement.prototype, prop, {
            configurable: true, enumerable: desc.enumerable,
            get() { return desc.get.call(this); },
            set(val) { clearCanvasKeys(this); if (isRecording) canvasResetsCount++; desc.set.call(this, val); },
          });
        }
      }
    } catch {}
    try {
      const origClearRect = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function(x, y, w, h) {
        if (this.canvas && x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) {
          clearCanvasKeys(this.canvas);
          if (isRecording) canvasResetsCount++;
        }
        return origClearRect.apply(this, arguments);
      };
      const origFillRect = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
        if (this.canvas && x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) {
          clearCanvasKeys(this.canvas);
          if (isRecording) canvasResetsCount++;
        }
        return origFillRect.apply(this, arguments);
      };
    } catch {}
    try {
      const origDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
        if (this.canvas) {
          const destKeys = getCanvasKeys(this.canvas);
          const isVideoFrame = Boolean(
            image && (
              (typeof globalThis.VideoFrame === 'function' && image instanceof globalThis.VideoFrame) ||
              (typeof OrigVideoFrame === 'function' && image instanceof OrigVideoFrame) ||
              Object.prototype.toString.call(image) === '[object VideoFrame]'
            )
          );
          if (image instanceof HTMLVideoElement || (image && image.tagName === 'VIDEO')) {
            const ord = getDecoderOrdinal(image);
            const cbMedia = activeCallbackMediaTimes.get(image);
            let frameKey;
            if (cbMedia !== undefined && cbMedia !== null) {
              frameKey = cbMedia;
            } else if (image.paused) {
              frameKey = image.currentTime;
            } else {
              liveElementDraws++;
              frameKey = image.currentTime;
            }
            destKeys.add(ord + ':' + frameKey);
          } else if (isVideoFrame) {
            const ord = videoFrameOrdinals.get(image);
            if (ord !== undefined && typeof image.timestamp === 'number' && Number.isFinite(image.timestamp)) {
              destKeys.add(ord + ':' + (image.timestamp / 1e6));
            } else {
              canvasUnresolved.set(this.canvas, true);
              destKeys.clear();
            }
          } else if (image instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) || (image && image.tagName === 'CANVAS')) {
            if (canvasUnresolved.get(image)) {
              canvasUnresolved.set(this.canvas, true);
              destKeys.clear();
            } else {
              const srcKeys = canvasKeySets.get(image);
              if (srcKeys) { for (const k of srcKeys) destKeys.add(k); }
            }
          }
          const isVisible = Boolean(
            (this.canvas.matches && this.canvas.matches('canvas.otio-canvas')) ||
            (this.canvas.classList && this.canvas.classList.contains('otio-canvas'))
          );
          if (isVisible) {
            visibleDrawCount++;
            if (isRecording) {
              const keys = canvasUnresolved.get(this.canvas) ? [] : Array.from(destKeys).sort();
              pushBounded(visiblePresents, { t: performance.now(), keys }, MAX_BUFFER);
            }
          } else {
            offscreenDrawCount++;
          }
        }
        return origDraw.apply(this, [image, ...args]);
      };
      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        const origOffscreenDraw = OffscreenCanvasRenderingContext2D.prototype.drawImage;
        OffscreenCanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
          if (this.canvas) {
            const destKeys = getCanvasKeys(this.canvas);
            const isVideoFrame = Boolean(
              image && (
                (typeof globalThis.VideoFrame === 'function' && image instanceof globalThis.VideoFrame) ||
                (typeof OrigVideoFrame === 'function' && image instanceof OrigVideoFrame) ||
                Object.prototype.toString.call(image) === '[object VideoFrame]'
              )
            );
            if (image instanceof HTMLVideoElement || (image && image.tagName === 'VIDEO')) {
              const ord = getDecoderOrdinal(image);
              const cbMedia = activeCallbackMediaTimes.get(image);
              let frameKey;
              if (cbMedia !== undefined && cbMedia !== null) {
                frameKey = cbMedia;
              } else if (image.paused) {
                frameKey = image.currentTime;
              } else {
                liveElementDraws++;
                frameKey = image.currentTime;
              }
              destKeys.add(ord + ':' + frameKey);
            } else if (isVideoFrame) {
              const ord = videoFrameOrdinals.get(image);
              if (ord !== undefined && typeof image.timestamp === 'number' && Number.isFinite(image.timestamp)) {
                destKeys.add(ord + ':' + (image.timestamp / 1e6));
              } else {
                canvasUnresolved.set(this.canvas, true);
                destKeys.clear();
              }
            } else if (image instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) || (image && image.tagName === 'CANVAS')) {
              if (canvasUnresolved.get(image)) {
                canvasUnresolved.set(this.canvas, true);
                destKeys.clear();
              } else {
                const srcKeys = canvasKeySets.get(image);
                if (srcKeys) { for (const k of srcKeys) destKeys.add(k); }
              }
            }
          }
          return origOffscreenDraw.apply(this, [image, ...args]);
        };
        const origOffscreenClearRect = OffscreenCanvasRenderingContext2D.prototype.clearRect;
        OffscreenCanvasRenderingContext2D.prototype.clearRect = function(x, y, w, h) {
          if (this.canvas && x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) {
            clearCanvasKeys(this.canvas);
            if (isRecording) canvasResetsCount++;
          }
          return origOffscreenClearRect.apply(this, arguments);
        };
      }
    } catch {}
    try {
      new PerformanceObserver((list) => {
        if (!isRecording) return;
        for (const e of list.getEntries()) pushBounded(longTasks, { startTime: e.startTime, duration: e.duration }, 2000);
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        if (!isRecording) return;
        for (const e of list.getEntries()) {
          pushBounded(loaves, {
            startTime: e.startTime, duration: e.duration,
            blockingDuration: e.blockingDuration, styleAndLayoutDuration: e.styleAndLayoutDuration,
          }, 2000);
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {}
    function onVsync(now) {
      if (lastVsyncTime !== null && isRecording) pushBounded(vsyncIntervals, now - lastVsyncTime, MAX_BUFFER);
      lastVsyncTime = now;
      requestAnimationFrame(onVsync);
    }
    requestAnimationFrame(onVsync);
    let otioViewObserver = null;
    function attachViewObserver(root) {
      if (otioViewObserver) otioViewObserver.disconnect();
      otioViewObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type !== 'attributes') continue;
          if (m.attributeName === 'data-frame' && isRecording) {
            const f = Number(root.dataset.frame);
            if (Number.isFinite(f)) {
              pushBounded(compositeFrames, { frame: f, timestamp: performance.now(), buffering: root.dataset.buffering === 'true' }, MAX_BUFFER);
            }
          } else if (m.attributeName === 'data-buffering' && isRecording) {
            const now = performance.now();
            if (root.dataset.buffering === 'true') {
              resyncEpisodes++; bufferingStartTime = now;
            } else if (bufferingStartTime !== null) {
              totalBufferingMs += (now - bufferingStartTime); bufferingStartTime = null;
            }
          }
        }
      });
      otioViewObserver.observe(root, { attributes: true, attributeFilter: ['data-frame', 'data-buffering', 'data-playing'] });
    }
    let decoderObserver = null;
    function attachDecoderObserver(host) {
      if (decoderObserver) decoderObserver.disconnect();
      decoderObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLVideoElement || node.tagName === 'VIDEO') {
              const ord = getDecoderOrdinal(node);
              const now = performance.now();
              const rec = { ordinal: ord, insertionTime: now, loadedDataLatency: null };
              pushBounded(decoderInsertions, rec, 2000);
              const onLoaded = () => {
                node.removeEventListener('loadeddata', onLoaded);
                node.removeEventListener('error', onLoaded);
                rec.loadedDataLatency = performance.now() - now;
              };
              if (node.readyState >= 2) rec.loadedDataLatency = 0;
              else {
                node.addEventListener('loadeddata', onLoaded, { once: true });
                node.addEventListener('error', onLoaded, { once: true });
              }
            }
          }
        }
      });
      decoderObserver.observe(host, { childList: true });
    }
    function getAuthoritativeTimelineRate() {
      const ruler = document.querySelector('.otio-ruler-label');
      if (ruler && ruler.textContent) {
        const m = ruler.textContent.trim().match(/^([\\d.]+)\\s*fps$/i);
        if (m && Number(m[1]) > 0) return Number(m[1]);
      }
      const clock = document.querySelector('output.otio-time, .otio-time');
      if (clock && Number(clock.dataset.rate) > 0) return Number(clock.dataset.rate);
      const root = document.querySelector('section.otio-view, .otio-view');
      if (root && Number(root.dataset.rate) > 0) return Number(root.dataset.rate);
      throw new Error('Authoritative timeline rate missing from DOM metadata');
    }
    globalThis.__relicOtioProfiler = {
      async waitForReady(timeoutMs = 30000) {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
          const root = document.querySelector('section.otio-view');
          const seek = document.querySelector('input.otio-seek');
          const play = document.querySelector('button.otio-play');
          const decoders = document.querySelector('.otio-video-decoders');
          if (root && seek && play && decoders) {
            if (!otioViewObserver) attachViewObserver(root);
            if (!decoderObserver) attachDecoderObserver(decoders);
            const isReady = root.dataset.ready === 'true' || root.dataset.ready === 'diagnostic';
            if (isReady && root.dataset.buffering === 'false' && activeTimingWorkers === 0) {
              return { mounted: true, ready: true };
            }
          }
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, 50);
          await promise;
        }
        throw new Error('OTIO viewer wait for ready/timing-worker timeout');
      },
      waitForMount(timeoutMs = 30000) { return this.waitForReady(timeoutMs); },
      getTimelineStructure() {
        const root = document.querySelector('section.otio-view');
        if (!root) throw new Error('section.otio-view not found');
        const items = [...document.querySelectorAll('.otio-item')];
        const rails = [...document.querySelectorAll('.otio-track-row')];
        const diagnostics = [...document.querySelectorAll('.otio-diagnostic')];
        const decoders = [...document.querySelectorAll('.otio-video-decoders video')];
        const audios = [...document.querySelectorAll('audio')];
        const diagCodes = {};
        for (const d of diagnostics) {
          const text = (d.textContent || '').trim();
          const code = (text.includes(' · ') && /^[a-zA-Z0-9_-]{1,64}$/.test(text.split(' · ')[0].trim()))
            ? text.split(' · ')[0].trim() : 'diagnostic';
          diagCodes[code] = (diagCodes[code] || 0) + 1;
        }
        const timelineRate = getAuthoritativeTimelineRate();
        let maxEnd = 0; let transitionCount = 0; const boundaries = [];
        for (const item of items) {
          if (!item.dataset.start || !item.dataset.duration) continue;
          const s = Number(item.dataset.start); const d = Number(item.dataset.duration);
          const r = Number(item.dataset.rate) || timelineRate;
          if (r > 0) {
            const endSec = (s + d) / r;
            if (endSec > maxEnd) maxEnd = endSec;
            boundaries.push(s / r, endSec);
            if (item.classList.contains('is-transition')) transitionCount++;
          }
        }
        const seekInput = document.querySelector('input.otio-seek');
        if (seekInput && seekInput.max && Number(seekInput.max) > 0 && timelineRate > 0) {
          const seekDur = (Number(seekInput.max) + 1) / timelineRate;
          if (seekDur > maxEnd) maxEnd = seekDur;
        }
        if (maxEnd <= 0) throw new Error('Timeline duration could not be determined');
        boundaries.sort((a, b) => a - b);
        return {
          durationSeconds: maxEnd, timelineRate, railsCount: rails.length, totalItems: items.length,
          editPointsCount: boundaries.length, editPointsPerMinute: maxEnd > 0 ? (boundaries.length / (maxEnd / 60)) : 0,
          medianItemLengthSeconds: 0, p10ItemLengthSeconds: 0, transitionCount,
          diagnosticsByCode: diagCodes, decodersCount: decoders.length, audioCount: audios.length,
        };
      },
      async getDecodersMedia(includeBytes = true) {
        const decoders = [...document.querySelectorAll('.otio-video-decoders video')];
        const list = []; const seenSrcs = new Set();
        for (const v of decoders) {
          const src = v.src;
          if (!src || seenSrcs.has(src)) continue;
          seenSrcs.add(src);
          let base64 = null; let mimeType = 'video/mp4';
          if (includeBytes) try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            mimeType = blob.type || (src.includes('.webm') ? 'video/webm' : 'video/mp4');
            const buf = await blob.arrayBuffer();
            let binary = ''; const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.byteLength; i += 8192) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.byteLength)));
            }
            base64 = btoa(binary);
          } catch {}
          list.push({
            ordinal: getDecoderOrdinal(v), src, duration: v.duration || 0,
            videoWidth: v.videoWidth || 0, videoHeight: v.videoHeight || 0, mimeType, base64,
          });
        }
        return list;
      },
      async runWindowRepetition({ windowKey, startSeconds, durationSeconds = 15, warmupSeconds = 2, isCutWindow = false, isLayeredWindow = false }) {
        const sleep = (ms) => {
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, ms);
          return promise;
        };
        const root = document.querySelector('section.otio-view');
        const seekInput = document.querySelector('input.otio-seek');
        const playBtn = document.querySelector('button.otio-play');
        if (!root || !seekInput || !playBtn) throw new Error('Viewer controls missing');
        if (root.dataset.playing === 'true') { playBtn.click(); await sleep(200); }
        const rate = getAuthoritativeTimelineRate();
        const targetFrame = Math.round(Math.max(0, startSeconds - warmupSeconds) * rate);
        const scrubStart = performance.now();
        seekInput.value = String(targetFrame);
        seekInput.dispatchEvent(new Event('input', { bubbles: true }));
        let seekSettled = false; let lastObservedFrame = null;
        await sleep(50);
        while (performance.now() - scrubStart < 10000) {
          if (root.dataset.frame !== undefined && root.dataset.frame !== null) {
            lastObservedFrame = Number(root.dataset.frame);
          }
          if (root.dataset.buffering === 'false' && lastObservedFrame !== null && Number.isFinite(lastObservedFrame) && Math.abs(Math.floor(lastObservedFrame) - Math.floor(targetFrame)) <= 1) {
            seekSettled = true; break;
          }
          await sleep(50);
        }
        const pausedSeekLatencyMs = performance.now() - scrubStart;
        if (!seekSettled) throw new Error('Seek to target frame ' + targetFrame + ' failed to settle');
        const playStart = performance.now();
        const startFrame = Number(root.dataset.frame);
        playBtn.click();
        let playToFirstFrameMs = 0;
        while (performance.now() - playStart < 5000) {
          if (Number(root.dataset.frame) > startFrame) { playToFirstFrameMs = performance.now() - playStart; break; }
          await sleep(10);
        }
        if (playToFirstFrameMs === 0) playToFirstFrameMs = performance.now() - playStart;
        const remainingWarmup = Math.max(0, warmupSeconds * 1000 - playToFirstFrameMs);
        if (remainingWarmup > 0) await sleep(remainingWarmup);
        activeSeeks.length = 0; completedSeeks.length = 0; audioPlays.length = 0;
        visibleDrawCount = 0; offscreenDrawCount = 0; canvasResetsCount = 0; liveElementDraws = 0;
        visiblePresents.length = 0; compositeFrames.length = 0; decoderInsertions.length = 0;
        longTasks.length = 0; loaves.length = 0; vsyncIntervals.length = 0; callbackReadoutDurations.length = 0;
        totalBufferingMs = 0; bufferingStartTime = null; resyncEpisodes = 0; bufferOverflow = false;
        isRecording = true;
        recordingStartTime = performance.now();
        await sleep(durationSeconds * 1000);
        isRecording = false;
        const recordingEndTime = performance.now();
        const actualDurationSeconds = (recordingEndTime - recordingStartTime) / 1000;
        if (bufferingStartTime !== null) { totalBufferingMs += (recordingEndTime - bufferingStartTime); bufferingStartTime = null; }
        if (root.dataset.playing === 'true') playBtn.click();
        if (bufferOverflow) throw new Error('Profiler buffer overflow: max samples exceeded');
        if (isCutWindow) {
          let changes = 0; let lastOrd = null;
          for (const p of visiblePresents) {
            for (const k of p.keys) {
              const ord = k.split(':')[0];
              if (lastOrd !== null && ord !== lastOrd) changes++;
              lastOrd = ord;
            }
          }
          if (changes < 2) throw new Error('Cut-window check failed: fewer than 2 decoder changes (' + changes + ')');
        }
        if (isLayeredWindow) {
          const hasLayered = visiblePresents.some((p) => new Set(p.keys.map((k) => k.split(':')[0])).size >= 2);
          if (!hasLayered) throw new Error('Layered-window check failed: no present contained >= 2 decoders');
        }
        let distinctFramesCount = 0; const distinctPresents = []; let prevKeyStr = null;
        let unresolvedPresents = 0; let minMt = Infinity; let maxMt = -Infinity;
        for (const p of visiblePresents) {
          if (p.keys.length === 0) unresolvedPresents++;
          for (const k of p.keys) {
            const mt = Number(k.split(':')[1]);
            if (Number.isFinite(mt)) { if (mt < minMt) minMt = mt; if (mt > maxMt) maxMt = mt; }
          }
          const keyStr = p.keys.join(',');
          if (keyStr !== prevKeyStr) { distinctFramesCount++; distinctPresents.push(p); prevKeyStr = keyStr; }
        }
        const mediaInterval = {
          start: Number.isFinite(minMt) ? minMt : 0, end: Number.isFinite(maxMt) ? maxMt : 0,
          duration: (Number.isFinite(minMt) && Number.isFinite(maxMt)) ? Math.max(0, maxMt - minMt) : 0,
        };
        const measuredStart = compositeFrames.length > 0 ? (compositeFrames[0].frame / rate) : startSeconds;
        const measuredEnd = compositeFrames.length > 0 ? (compositeFrames[compositeFrames.length - 1].frame / rate) : (startSeconds + actualDurationSeconds);
        const wallGapsMs = [];
        const startEdge = distinctPresents.length > 0 ? (distinctPresents[0].t - recordingStartTime) : actualDurationSeconds * 1000;
        const endEdge = distinctPresents.length > 0 ? (recordingEndTime - distinctPresents[distinctPresents.length - 1].t) : 0;
        wallGapsMs.push(startEdge);
        for (let i = 0; i < distinctPresents.length - 1; i++) wallGapsMs.push(distinctPresents[i + 1].t - distinctPresents[i].t);
        wallGapsMs.push(endEdge);
        wallGapsMs.sort((a, b) => a - b);
        const p50Gap = wallGapsMs.length ? wallGapsMs[Math.floor(wallGapsMs.length * 0.5)] : 0;
        const p95Gap = wallGapsMs.length ? wallGapsMs[Math.floor(wallGapsMs.length * 0.95)] : 0;
        const p99Gap = wallGapsMs.length ? wallGapsMs[Math.floor(wallGapsMs.length * 0.99)] : 0;
        const maxGap = wallGapsMs.length ? wallGapsMs[wallGapsMs.length - 1] : 0;
        const stutterCount = wallGapsMs.filter((g) => g > 1.5 * (1000 / rate)).length;
        const jumpedHistogram = { '0': 0, '1': 0, '2': 0, '3+': 0 };
        for (let i = 0; i < compositeFrames.length - 1; i++) {
          const step = Math.max(0, Math.floor(compositeFrames[i + 1].frame) - Math.floor(compositeFrames[i].frame));
          if (step === 0) jumpedHistogram['0']++; else if (step === 1) jumpedHistogram['1']++;
          else if (step === 2) jumpedHistogram['2']++; else jumpedHistogram['3+']++;
        }
        const inWindowSeeks = completedSeeks.filter((s) => s.startTime >= recordingStartTime);
        const videoSeeks = inWindowSeeks.filter((s) => s.kind === 'video');
        const audioSeeks = inWindowSeeks.filter((s) => s.kind === 'audio');
        const calcStats = (list) => {
          const lats = list.map((s) => s.latency).filter((l) => typeof l === 'number').sort((a, b) => a - b);
          return {
            count: list.length, perSecond: actualDurationSeconds > 0 ? list.length / actualDurationSeconds : 0,
            latencyP50Ms: lats.length ? lats[Math.floor(lats.length * 0.5)] : 0,
            latencyP95Ms: lats.length ? lats[Math.floor(lats.length * 0.95)] : 0,
            latencyMaxMs: lats.length ? lats[lats.length - 1] : 0,
            supersededCount: list.filter((s) => s.superseded).length,
          };
        };
        const videoStats = calcStats(videoSeeks);
        const audioStats = calcStats(audioSeeks);
        const vIntervals = videoSeeks.filter((s) => s.latency !== null)
          .map((s) => [Math.max(recordingStartTime, s.startTime), Math.min(recordingEndTime, s.startTime + s.latency)])
          .filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
        let unionMs = 0;
        if (vIntervals.length > 0) {
          let [curS, curE] = vIntervals[0];
          for (let i = 1; i < vIntervals.length; i++) {
            const [s, e] = vIntervals[i];
            if (s <= curE) curE = Math.max(curE, e);
            else { unionMs += (curE - curS); curS = s; curE = e; }
          }
          unionMs += (curE - curS);
        }
        const seekWindowShare = actualDurationSeconds > 0 ? Math.min(1.0, unionMs / (actualDurationSeconds * 1000)) : 0;
        const allLats = inWindowSeeks.map((s) => s.latency).filter((l) => typeof l === 'number');
        const cumSeekLatency = allLats.reduce((sum, l) => sum + l, 0);
        const sortedVsync = [...vsyncIntervals].sort((a, b) => a - b);
        const p50Vsync = sortedVsync.length ? sortedVsync[Math.floor(sortedVsync.length * 0.5)] : 0;
        const p95Vsync = sortedVsync.length ? sortedVsync[Math.floor(sortedVsync.length * 0.95)] : 0;
        const sortedCbReadout = [...callbackReadoutDurations].sort((a, b) => a - b);
        const p50CbReadout = sortedCbReadout.length ? sortedCbReadout[Math.floor(sortedCbReadout.length * 0.5)] : 0;
        const p95CbReadout = sortedCbReadout.length ? sortedCbReadout[Math.floor(sortedCbReadout.length * 0.95)] : 0;
        const callbackReadoutMs = {
          p50: p50CbReadout,
          p95: p95CbReadout,
          count: sortedCbReadout.length,
        };
        let stuttersNearInsertions = 0;
        if (stutterCount > 0 && decoderInsertions.length > 0) {
          for (let i = 0; i < compositeFrames.length - 1; i++) {
            if (compositeFrames[i + 1].frame - compositeFrames[i].frame > 1.5) {
              const t = compositeFrames[i].timestamp;
              if (decoderInsertions.some((d) => Math.abs(d.insertionTime - t) <= 250)) stuttersNearInsertions++;
            }
          }
        }
        const distinctTf = new Set(compositeFrames.map((c) => Math.floor(c.frame)));
        const clockCadence = (actualDurationSeconds * rate > 0) ? (distinctTf.size / (actualDurationSeconds * rate)) : 0;
        const presentedDecoderOrdinals = Array.from(new Set(visiblePresents.flatMap((p) => p.keys.map((k) => Number(k.split(':')[0])))));
        return {
          windowKey, actualDurationSeconds, measuredStart, measuredEnd, pausedSeekLatencyMs, playToFirstFrameMs,
          mediaInterval, distinctFramesCount, compositesCount: compositeFrames.length, clockCadence,
          unresolvedPresents, liveElementDraws, presentedDecoderOrdinals,
          callbackReadoutMs,
          gaps: { p50: p50Gap, p95: p95Gap, p99: p99Gap, max: maxGap, startEdgeGapMs: startEdge, endEdgeGapMs: endEdge, stutterCount },
          buffering: { totalBufferingMs, resyncEpisodes }, jumpedHistogram,
          seeks: {
            videoSeeksCount: videoSeeks.length, audioSeeksCount: audioSeeks.length,
            videoSeeksPerSecond: videoStats.perSecond, audioSeeksPerSecond: audioStats.perSecond,
            cumulativeLatencyMs: cumSeekLatency, latencyP50Ms: videoStats.latencyP50Ms, latencyP95Ms: videoStats.latencyP95Ms,
            video: videoStats, audio: audioStats, windowShare: seekWindowShare,
          },
          audio: { playCallsCount: audioPlays.length, playCallsPerSecond: actualDurationSeconds > 0 ? (audioPlays.length / actualDurationSeconds) : 0 },
          canvas: {
            resetsCount: canvasResetsCount, resetsPerComposite: compositeFrames.length > 0 ? canvasResetsCount / compositeFrames.length : 0,
            visibleDrawCount, visibleDrawsPerComposite: compositeFrames.length > 0 ? visibleDrawCount / compositeFrames.length : 0,
            offscreenDrawCount, offscreenDrawsPerComposite: compositeFrames.length > 0 ? offscreenDrawCount / compositeFrames.length : 0,
            liveElementDraws,
          },
          vsync: { p50IntervalMs: p50Vsync, p95IntervalMs: p95Vsync },
          mainThread: {
            longTasksCount: longTasks.length, totalLongTaskDurationMs: longTasks.reduce((acc, t) => acc + t.duration, 0),
            loafCount: loaves.length, totalLoafBlockingMs: loaves.reduce((acc, l) => acc + (l.blockingDuration || 0), 0),
            totalLoafStyleLayoutMs: loaves.reduce((acc, l) => acc + (l.styleAndLayoutDuration || 0), 0),
          },
          decoders: {
            insertionsCount: decoderInsertions.length, stuttersNearInsertions,
            stuttersNearInsertionsPercent: stutterCount > 0 ? (stuttersNearInsertions / stutterCount) * 100 : 0,
          },
        };
      },
      async measureNativeCeiling(durationSeconds = 10) {
        const decoders = [...document.querySelectorAll('.otio-video-decoders video')];
        if (decoders.length === 0) return { available: false, reason: 'No video decoders in timeline', ceilingRatio: 'n/a' };
        const src = decoders[0].src;
        if (!src) return { available: false, reason: 'No src attribute on video decoder', ceilingRatio: 'n/a' };
        const parent = document.querySelector('section.otio-view') || document.body;
        const host = document.createElement('div');
        host.className = 'otio-native-ceiling-host';
        host.setAttribute('aria-hidden', 'true');
        host.style.position = 'absolute';
        host.style.width = '1px';
        host.style.height = '1px';
        host.style.overflow = 'hidden';
        host.style.clipPath = 'inset(50%)';
        host.style.pointerEvents = 'none';
        parent.appendChild(host);
        const testVid = document.createElement('video');
        testVid.muted = true; testVid.playsInline = true; testVid.preload = 'auto'; testVid.src = src;
        testVid.style.width = '1px'; testVid.style.height = '1px'; testVid.style.opacity = '1'; testVid.style.pointerEvents = 'none';
        host.appendChild(testVid);
        try {
          const sleep = (ms) => {
            const { promise, resolve } = Promise.withResolvers();
            setTimeout(resolve, ms);
            return promise;
          };
          if (typeof testVid.requestVideoFrameCallback !== 'function') {
            return { available: false, reason: 'requestVideoFrameCallback not supported', ceilingRatio: 'n/a' };
          }
          if (testVid.readyState < 2) {
            const { promise, resolve } = Promise.withResolvers();
            const onLoaded = () => { testVid.removeEventListener('loadeddata', onLoaded); resolve(); };
            testVid.addEventListener('loadeddata', onLoaded, { once: true });
            testVid.addEventListener('error', onLoaded, { once: true });
            await promise;
          }
          const samples = [];
          let running = true;
          function onFrame(now, metadata) {
            if (!running) return;
            samples.push({
              now, mediaTime: metadata && typeof metadata.mediaTime === 'number' ? metadata.mediaTime : null,
              presentedFrames: metadata && typeof metadata.presentedFrames === 'number' ? metadata.presentedFrames : samples.length + 1,
            });
            if (running && typeof testVid.requestVideoFrameCallback === 'function') {
              testVid.requestVideoFrameCallback(onFrame);
            }
          }
          testVid.requestVideoFrameCallback(onFrame);
          const start = performance.now();
          await testVid.play();
          await sleep(durationSeconds * 1000);
          running = false;
          testVid.pause();
          const elapsedSec = (performance.now() - start) / 1000;
          let droppedFrames = 0; let totalFrames = samples.length;
          if (typeof testVid.getVideoPlaybackQuality === 'function') {
            const q = testVid.getVideoPlaybackQuality();
            droppedFrames = q.droppedVideoFrames || 0;
            totalFrames = q.totalVideoFrames || samples.length;
          }
          return {
            available: true, src, duration: testVid.duration || 0,
            videoWidth: testVid.videoWidth || 0, videoHeight: testVid.videoHeight || 0,
            samples, droppedFrames, totalFrames, elapsedSeconds: elapsedSec,
          };
        } finally {
          try { testVid.pause(); testVid.removeAttribute('src'); testVid.load(); } catch {}
          testVid.remove(); host.remove();
        }
      },
    };
  })();`;
}

async function evaluate<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string
): Promise<T> {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, timeout: 60000 },
    sessionId
  );
  const exception = res['exceptionDetails'] as
    | { text?: string; exception?: { description?: string } }
    | undefined;
  if (exception) {
    const rawError =
      exception.text ?? exception.exception?.description ?? 'unknown error';
    const safeError = rawError.replace(
      /(?:https?|blob|file|data):\/\/[^\s"']+/gi,
      '[URL]'
    );
    throw new Error(`Page evaluation failed: ${safeError}`);
  }
  return (res['result'] as { value?: T } | undefined)?.value as T;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function aggregateRepetitions(
  reps: readonly RepetitionMetrics[]
): AggregatedMetrics {
  if (reps.length === 0)
    throw new Error('Cannot aggregate 0 repetitions: missing metric samples');
  const getMed = (getter: (r: RepetitionMetrics) => number) =>
    median(reps.map(getter));
  const allAvailable = reps.every((r) => r.presentedMetricsAvailable);
  return {
    actualDurationSeconds: getMed((r) => r.actualDurationSeconds),
    measuredStart: getMed((r) => r.measuredStart),
    measuredEnd: getMed((r) => r.measuredEnd),
    pausedSeekLatencyMs: getMed((r) => r.pausedSeekLatencyMs),
    playToFirstFrameMs: getMed((r) => r.playToFirstFrameMs),
    mediaInterval: {
      start: getMed((r) => r.mediaInterval.start),
      end: getMed((r) => r.mediaInterval.end),
      duration: getMed((r) => r.mediaInterval.duration),
    },
    presentedMetricsAvailable: allAvailable,
    wallCadence: allAvailable
      ? getMed((r) => (typeof r.wallCadence === 'number' ? r.wallCadence : 0))
      : 'n/a',
    transportCadence: allAvailable
      ? getMed((r) =>
          typeof r.transportCadence === 'number' ? r.transportCadence : 0
        )
      : 'n/a',
    clockCadence: getMed((r) => r.clockCadence),
    cadenceRatio: getMed((r) => r.cadenceRatio),
    compositesCount: getMed((r) => r.compositesCount),
    distinctFramesCount: getMed((r) => r.distinctFramesCount),
    callbackReadoutMs: {
      p50: getMed((r) => r.callbackReadoutMs.p50),
      p95: getMed((r) => r.callbackReadoutMs.p95),
      count: getMed((r) => r.callbackReadoutMs.count),
    },
    gaps: {
      p50: getMed((r) => r.gaps.p50),
      p95: getMed((r) => r.gaps.p95),
      p99: getMed((r) => r.gaps.p99),
      max: getMed((r) => r.gaps.max),
      startEdgeGapMs: getMed((r) => r.gaps.startEdgeGapMs),
      endEdgeGapMs: getMed((r) => r.gaps.endEdgeGapMs),
      stutterCount: getMed((r) => r.gaps.stutterCount),
    },
    buffering: {
      totalBufferingMs: getMed((r) => r.buffering.totalBufferingMs),
      resyncEpisodes: getMed((r) => r.buffering.resyncEpisodes),
    },
    seeks: {
      videoSeeksCount: getMed((r) => r.seeks.videoSeeksCount),
      audioSeeksCount: getMed((r) => r.seeks.audioSeeksCount),
      videoSeeksPerSecond: getMed((r) => r.seeks.videoSeeksPerSecond),
      audioSeeksPerSecond: getMed((r) => r.seeks.audioSeeksPerSecond),
      cumulativeLatencyMs: getMed((r) => r.seeks.cumulativeLatencyMs),
      latencyP50Ms: getMed((r) => r.seeks.latencyP50Ms),
      latencyP95Ms: getMed((r) => r.seeks.latencyP95Ms),
      video: {
        count: getMed((r) => r.seeks.video.count),
        perSecond: getMed((r) => r.seeks.video.perSecond),
        latencyP50Ms: getMed((r) => r.seeks.video.latencyP50Ms),
        latencyP95Ms: getMed((r) => r.seeks.video.latencyP95Ms),
        latencyMaxMs: getMed((r) => r.seeks.video.latencyMaxMs),
        supersededCount: getMed((r) => r.seeks.video.supersededCount),
      },
      audio: {
        count: getMed((r) => r.seeks.audio.count),
        perSecond: getMed((r) => r.seeks.audio.perSecond),
        latencyP50Ms: getMed((r) => r.seeks.audio.latencyP50Ms),
        latencyP95Ms: getMed((r) => r.seeks.audio.latencyP95Ms),
        latencyMaxMs: getMed((r) => r.seeks.audio.latencyMaxMs),
        supersededCount: getMed((r) => r.seeks.audio.supersededCount),
      },
      windowShare: getMed((r) => r.seeks.windowShare),
    },
    audio: {
      playCallsCount: getMed((r) => r.audio.playCallsCount),
      playCallsPerSecond: getMed((r) => r.audio.playCallsPerSecond),
    },
    canvas: {
      resetsCount: getMed((r) => r.canvas.resetsCount),
      resetsPerComposite: getMed((r) => r.canvas.resetsPerComposite),
      visibleDrawCount: getMed((r) => r.canvas.visibleDrawCount),
      visibleDrawsPerComposite: getMed(
        (r) => r.canvas.visibleDrawsPerComposite
      ),
      offscreenDrawCount: getMed((r) => r.canvas.offscreenDrawCount),
      offscreenDrawsPerComposite: getMed(
        (r) => r.canvas.offscreenDrawsPerComposite
      ),
      liveElementDraws: getMed((r) => r.canvas.liveElementDraws),
    },
    vsync: {
      p50IntervalMs: getMed((r) => r.vsync.p50IntervalMs),
      p95IntervalMs: getMed((r) => r.vsync.p95IntervalMs),
    },
    mainThread: {
      longTasksCount: getMed((r) => r.mainThread.longTasksCount),
      totalLongTaskDurationMs: getMed(
        (r) => r.mainThread.totalLongTaskDurationMs
      ),
      loafCount: getMed((r) => r.mainThread.loafCount),
      totalLoafBlockingMs: getMed((r) => r.mainThread.totalLoafBlockingMs),
      totalLoafStyleLayoutMs: getMed(
        (r) => r.mainThread.totalLoafStyleLayoutMs
      ),
    },
    decoders: {
      insertionsCount: getMed((r) => r.decoders.insertionsCount),
      stuttersNearInsertions: getMed((r) => r.decoders.stuttersNearInsertions),
      stuttersNearInsertionsPercent: getMed(
        (r) => r.decoders.stuttersNearInsertionsPercent
      ),
    },
    cpu: {
      processCpuDeltaMs: getMed((r) => r.cpu.processCpuDeltaMs),
      loadAvg: [
        getMed((r) => r.cpu.loadAvg[0] ?? 0),
        getMed((r) => r.cpu.loadAvg[1] ?? 0),
        getMed((r) => r.cpu.loadAvg[2] ?? 0),
      ],
    },
  };
}

function classifyCauses(
  medians: Record<string, AggregatedMetrics>,
  ceiling: NativeCeilingResult,
  timelineRate = 30
): {
  primaryCause: BenchmarkReport['causeClassification']['primaryCause'];
  observations: readonly string[];
} {
  const observations: string[] = [];
  const w1 = medians['W1'] ?? Object.values(medians)[0];
  if (!w1)
    return {
      primaryCause: 'Indeterminate',
      observations: ['No window metrics available'],
    };

  if (
    ceiling.available &&
    typeof ceiling.ceilingRatio === 'number' &&
    ceiling.ceilingRatio < 0.9
  ) {
    observations.push(
      `Native video decoding ceiling (${ceiling.nativeFps.toFixed(1)} fps, scanner ratio ${ceiling.ceilingRatio.toFixed(2)}) is below 0.9`
    );
    return { primaryCause: 'The environment itself', observations };
  }

  const seekWaitShare = w1.seeks.windowShare;
  if (
    w1.vsync.p95IntervalMs <= 20 &&
    (seekWaitShare >= 0.5 || w1.seeks.video.perSecond >= 10)
  ) {
    observations.push(
      `Steady vsync (${w1.vsync.p95IntervalMs.toFixed(1)} ms) with high seek rate (${w1.seeks.video.perSecond.toFixed(1)}/s) and seek wait ${(seekWaitShare * 100).toFixed(1)}% of duration.`
    );
    return { primaryCause: 'Decoder seeks', observations };
  }

  const w2 = medians['W2'];
  if (w2 && w2.decoders.stuttersNearInsertionsPercent >= 30) {
    observations.push(
      `${w2.decoders.stuttersNearInsertionsPercent.toFixed(1)}% of stutters in W2 occurred within ±250ms of decoder insertion.`
    );
    return { primaryCause: 'Edit points', observations };
  }

  const frameBudgetMs = 1000 / Math.max(1, timelineRate);
  const mainThreadPerFrame =
    w1.mainThread.totalLoafStyleLayoutMs / Math.max(1, w1.compositesCount);
  if (mainThreadPerFrame >= 0.15 * frameBudgetMs) {
    observations.push(
      `Main-thread style/layout per composite (${mainThreadPerFrame.toFixed(2)} ms) exceeds 15% of frame budget.`
    );
    return { primaryCause: 'Controller or DOM work', observations };
  }

  if (w1.vsync.p95IntervalMs > 25 && seekWaitShare < 0.3) {
    observations.push(
      `Vsync interval unstable (${w1.vsync.p95IntervalMs.toFixed(1)} ms) while seek wait is low (${(seekWaitShare * 100).toFixed(1)}%).`
    );
    return { primaryCause: 'Compositor or GPU', observations };
  }

  observations.push(
    'Metrics do not decisively match a single dominant cause threshold.'
  );
  return { primaryCause: 'Indeterminate', observations };
}

function sanitizeReport(report: BenchmarkReport): BenchmarkReport {
  const json = JSON.stringify(report);
  const urlPattern = /(?:https?|blob|file|data):\/\/[^\s"'\\]+/gi;
  if (urlPattern.test(json)) {
    return JSON.parse(
      json.replace(urlPattern, '[REDACTED_URL]')
    ) as BenchmarkReport;
  }
  return report;
}

export async function runOtioPlaybackBenchmark(
  options: BenchmarkOptions
): Promise<BenchmarkReport> {
  let targetUrl: string;
  if (options.urlFile)
    targetUrl = await readUrlFromProtectedFile(options.urlFile);
  else if (options.url) {
    if (!loopbackUrl(options.url)) throw new Error('Non-loopback URL refused');
    targetUrl = options.url;
  } else {
    const envUrlFile =
      process.env['RELIC_OTIO_URL_FILE'] ??
      process.env['RELIC_OTIO_REPLAY_URL_FILE'];
    if (envUrlFile) targetUrl = await readUrlFromProtectedFile(envUrlFile);
    else
      throw new Error(
        'Replay URL must be provided via --url-file, --url, or RELIC_OTIO_URL_FILE'
      );
  }

  const profilerScript = createOtioPageProfilerScript();
  new Script(profilerScript, { filename: 'otio-profiler-injected.js' });

  const durationSeconds = options.durationSeconds ?? 15;
  const warmupSeconds = options.warmupSeconds ?? 2;
  const ceilingDurationSeconds = options.ceilingDurationSeconds ?? 10;
  const repetitionsCount = options.repetitions ?? 3;

  const namedChrome =
    options.chromePath ??
    process.env['RELIC_OTIO_CHROME_PATH'] ??
    process.env['RELIC_CHROME_PATH'];
  const foundChrome = await discoverChrome(
    namedChrome && namedChrome !== 'none' && namedChrome !== 'disabled'
      ? namedChrome
      : undefined
  );
  if (foundChrome.kind !== 'found')
    throw new Error(
      `Chrome discovery failed: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
    );

  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-bench-'));
  const shared = chromeArgs(foundChrome.path, profile);
  let launch: BrowserHeadlessLaunch;
  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;

  try {
    launch = createBrowserHeadlessLaunch(
      [
        ...shared.map((a) =>
          a === '--proxy-bypass-list=<-loopback>'
            ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
            : a === '--host-resolver-rules=MAP * ~NOTFOUND'
              ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
              : a
        ),
        '--autoplay-policy=no-user-gesture-required',
      ],
      profile
    );

    child = spawn(foundChrome.path, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
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

    cdp = connectPipe(toChrome, fromChrome);
    const attestation = await attestBrowserHeadless(cdp, launch);

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

    let nonLoopbackBlockedCount = 0;
    cdp.onEvent((event) => {
      if (
        event.method !== 'Fetch.requestPaused' ||
        event.sessionId !== sessionId
      )
        return;
      const params = event.params as {
        requestId?: string;
        request?: { url?: string };
      };
      const reqUrl = params.request?.url ?? '';
      const reqId = params.requestId;
      if (!reqId) return;
      if (loopbackUrl(reqUrl)) {
        void cdp
          ?.send('Fetch.continueRequest', { requestId: reqId }, sessionId)
          .catch(() => {});
        return;
      }
      nonLoopbackBlockedCount++;
      void cdp
        ?.send(
          'Fetch.failRequest',
          { requestId: reqId, errorReason: 'BlockedByClient' },
          sessionId
        )
        .catch(() => {});
    });

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    if (options.cpuThrottle && options.cpuThrottle > 1) {
      await cdp.send(
        'Emulation.setCPUThrottlingRate',
        { rate: options.cpuThrottle },
        sessionId
      );
    }
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: profilerScript },
      sessionId
    );

    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    await evaluate<{ mounted: boolean; ready: boolean }>(
      cdp,
      sessionId,
      'window.__relicOtioProfiler.waitForReady(30000)'
    );

    let gpuFeatures: Record<string, unknown> | undefined;
    try {
      const sysInfo = (await cdp.send('SystemInfo.getInfo')) as {
        gpu?: { featureStatus?: Record<string, unknown> };
      };
      gpuFeatures = sysInfo?.gpu?.featureStatus;
    } catch {}

    const structure = await evaluate<{
      durationSeconds: number;
      timelineRate: number;
      railsCount: number;
      totalItems: number;
      editPointsCount: number;
      editPointsPerMinute: number;
      medianItemLengthSeconds: number;
      p10ItemLengthSeconds: number;
      transitionCount: number;
      diagnosticsByCode: Record<string, number>;
      decodersCount: number;
    }>(cdp, sessionId, 'window.__relicOtioProfiler.getTimelineStructure()');

    const decodersMedia = await evaluate<
      Array<{
        ordinal: number;
        src: string;
        duration: number;
        videoWidth: number;
        videoHeight: number;
        mimeType: string;
        base64: string | null;
      }>
    >(cdp, sessionId, 'window.__relicOtioProfiler.getDecodersMedia()');

    const scannedMediaList: Array<{
      duration: number;
      videoWidth: number;
      videoHeight: number;
      timing: OtioVideoTiming;
    }> = [];
    for (const item of decodersMedia) {
      if (item.base64) {
        const buf = Buffer.from(item.base64, 'base64');
        const blob = new Blob([buf], { type: item.mimeType });
        const timing = await scanOtioVideoTiming(blob, item.mimeType);
        scannedMediaList.push({
          duration: item.duration,
          videoWidth: item.videoWidth,
          videoHeight: item.videoHeight,
          timing,
        });
      }
    }
    for (const mediaPath of options.mediaPaths ?? []) {
      const mimeType = mediaPath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
      const timing = await scanOtioVideoTiming(
        new Blob([await readFile(mediaPath)], { type: mimeType }),
        mimeType
      );
      const probeText = await new Promise<string>(
        (resolveProbe, rejectProbe) => {
          const child = spawn('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height:format=duration',
            '-of',
            'json',
            mediaPath,
          ]);
          let out = '';
          child.stdout.on('data', (chunk) => {
            out += chunk;
          });
          child.on('error', rejectProbe);
          child.on('close', (code) =>
            code === 0
              ? resolveProbe(out)
              : rejectProbe(new Error(`ffprobe exited ${code}`))
          );
        }
      );
      const probe = JSON.parse(probeText) as {
        streams?: Array<{ width?: number; height?: number }>;
        format?: { duration?: string };
      };
      scannedMediaList.push({
        duration: Number(probe.format?.duration),
        videoWidth: probe.streams?.[0]?.width ?? 0,
        videoHeight: probe.streams?.[0]?.height ?? 0,
        timing,
      });
    }

    let configuredWindows: WindowOption[] = [];
    if (options.windows && options.windows.length > 0) {
      configuredWindows = [...options.windows];
    } else if (structure.durationSeconds >= 480) {
      configuredWindows = [
        { name: 'start', start: 24, duration: durationSeconds },
        { name: 'middle', start: 240, duration: durationSeconds },
        { name: 'tail', start: 460, duration: durationSeconds },
      ];
    } else {
      const winDur = Math.min(
        durationSeconds,
        Math.max(1, Math.floor(structure.durationSeconds / 3))
      );
      configuredWindows = [
        { name: 'start', start: 0, duration: winDur },
        { name: 'middle', start: winDur, duration: winDur },
        { name: 'tail', start: 2 * winDur, duration: winDur },
      ];
    }

    const resolvedWindows: Record<string, WindowDefinition> = {};
    const winKeys = ['W1', 'W2', 'W3'] as const;
    const sortedWindows = configuredWindows
      .map((w, idx) => ({
        key: winKeys[idx] ?? `W${idx + 1}`,
        name: w.name,
        start: w.start,
        duration: w.duration ?? durationSeconds,
      }))
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < sortedWindows.length; i++) {
      const w = sortedWindows[i]!;
      assert.ok(
        w.start >= 0,
        `Window ${w.name} start must be non-negative: ${w.start}`
      );
      assert.ok(
        w.start + w.duration <= structure.durationSeconds + 0.05,
        `Window ${w.name} extends past timeline duration (${w.start + w.duration} > ${structure.durationSeconds})`
      );
      if (i > 0) {
        const prev = sortedWindows[i - 1]!;
        assert.ok(
          prev.start + prev.duration <= w.start + 0.05,
          `Windows ${prev.name} and ${w.name} overlap`
        );
      }
      resolvedWindows[w.key] = {
        name: w.name,
        start: w.start,
        end: w.start + w.duration,
        duration: w.duration,
        description: `Window ${w.name} at ${w.start}s`,
      };
    }

    const repetitionResults: Record<string, RepetitionMetrics[]> = {};
    for (const key of Object.keys(resolvedWindows)) repetitionResults[key] = [];

    for (const [key, win] of Object.entries(resolvedWindows)) {
      const isCutWindow = win.name.toLowerCase().includes('cut');
      const isLayeredWindow = win.name.toLowerCase().includes('layer');

      for (let rep = 0; rep < repetitionsCount; rep++) {
        await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
        await evaluate<{ mounted: boolean; ready: boolean }>(
          cdp,
          sessionId,
          'window.__relicOtioProfiler.waitForReady(30000)'
        );

        let cpuStart = 0;
        try {
          const sysProc = (await cdp.send('SystemInfo.getProcessInfo')) as {
            processInfo?: Array<{ cpuTime?: number }>;
          };
          cpuStart = (sysProc?.processInfo ?? []).reduce(
            (acc, p) => acc + (p.cpuTime ?? 0),
            0
          );
        } catch {}

        const raw = await evaluate<
          Omit<
            RepetitionMetrics,
            'wallCadence' | 'transportCadence' | 'cadenceRatio' | 'cpu'
          > & {
            unresolvedPresents: number;
            liveElementDraws: number;
            presentedDecoderOrdinals: number[];
          }
        >(
          cdp,
          sessionId,
          `window.__relicOtioProfiler.runWindowRepetition(${JSON.stringify({
            windowKey: key,
            startSeconds: win.start,
            durationSeconds: win.duration,
            warmupSeconds,
            isCutWindow,
            isLayeredWindow,
          })})`
        );

        let cpuEnd = 0;
        try {
          const sysProc = (await cdp.send('SystemInfo.getProcessInfo')) as {
            processInfo?: Array<{ cpuTime?: number }>;
          };
          cpuEnd = (sysProc?.processInfo ?? []).reduce(
            (acc, p) => acc + (p.cpuTime ?? 0),
            0
          );
        } catch {}
        const processCpuDeltaMs = Math.max(0, cpuEnd - cpuStart);

        let presentedMetricsAvailable =
          raw.unresolvedPresents === 0 && raw.liveElementDraws === 0;
        const liveDecoders = await evaluate<typeof decodersMedia>(
          cdp,
          sessionId,
          'window.__relicOtioProfiler.getDecodersMedia(false)'
        );
        for (const ord of raw.presentedDecoderOrdinals) {
          const decoderMeta = liveDecoders.find((d) => d.ordinal === ord);
          if (!decoderMeta) {
            presentedMetricsAvailable = false;
            break;
          }
          const matches = scannedMediaList.filter(
            (m) =>
              Math.abs(m.duration - decoderMeta.duration) < 0.1 &&
              m.videoWidth === decoderMeta.videoWidth &&
              m.videoHeight === decoderMeta.videoHeight
          );
          if (matches.length !== 1 || matches[0]?.timing.kind !== 'windows') {
            presentedMetricsAvailable = false;
            break;
          }
        }

        let wallCadence: number | 'n/a' = 'n/a';
        let transportCadence: number | 'n/a' = 'n/a';
        if (presentedMetricsAvailable) {
          const wallElapsed =
            raw.actualDurationSeconds * structure.timelineRate;
          wallCadence =
            wallElapsed > 0 ? raw.distinctFramesCount / wallElapsed : 0;
          const transportElapsed =
            Math.abs(raw.measuredEnd - raw.measuredStart) *
            structure.timelineRate;
          transportCadence =
            transportElapsed > 0
              ? raw.distinctFramesCount / transportElapsed
              : 0;
        }

        repetitionResults[key]!.push({
          windowKey: key,
          repetitionIndex: rep + 1,
          actualDurationSeconds: raw.actualDurationSeconds,
          measuredStart: raw.measuredStart,
          measuredEnd: raw.measuredEnd,
          pausedSeekLatencyMs: raw.pausedSeekLatencyMs,
          playToFirstFrameMs: raw.playToFirstFrameMs,
          mediaInterval: raw.mediaInterval,
          presentedMetricsAvailable,
          wallCadence,
          transportCadence,
          clockCadence: raw.clockCadence,
          cadenceRatio:
            typeof wallCadence === 'number' ? wallCadence : raw.clockCadence,
          compositesCount: raw.compositesCount,
          distinctFramesCount: raw.distinctFramesCount,
          callbackReadoutMs: raw.callbackReadoutMs,
          gaps: raw.gaps,
          buffering: raw.buffering,
          jumpedHistogram: raw.jumpedHistogram,
          seeks: raw.seeks,
          audio: raw.audio,
          canvas: raw.canvas,
          vsync: raw.vsync,
          mainThread: raw.mainThread,
          decoders: raw.decoders,
          cpu: { processCpuDeltaMs, loadAvg: os.loadavg() },
        });
      }
    }

    const rawCeiling = await evaluate<
      | { available: false; reason: string; ceilingRatio: 'n/a' }
      | {
          available: true;
          src: string;
          duration: number;
          videoWidth: number;
          videoHeight: number;
          samples: Array<{
            now: number;
            mediaTime: number | null;
            presentedFrames: number;
          }>;
          droppedFrames: number;
          totalFrames: number;
          elapsedSeconds: number;
        }
    >(
      cdp,
      sessionId,
      `window.__relicOtioProfiler.measureNativeCeiling(${ceilingDurationSeconds})`
    );

    let nativeCeiling: NativeCeilingResult;
    if (!rawCeiling.available) {
      nativeCeiling = rawCeiling;
    } else {
      const matchedMedia = scannedMediaList.find(
        (m) =>
          Math.abs(m.duration - rawCeiling.duration) < 0.1 &&
          m.videoWidth === rawCeiling.videoWidth &&
          m.videoHeight === rawCeiling.videoHeight
      );
      if (!matchedMedia || matchedMedia.timing.kind !== 'windows') {
        nativeCeiling = {
          available: false,
          reason: 'Media scanner timing unavailable for ceiling video',
          ceilingRatio: 'n/a',
        };
      } else {
        const starts = matchedMedia.timing.starts;
        const ends = matchedMedia.timing.ends;
        const matchedWindows = new Set<number>();
        let skipsCount = 0;
        let lastWinIdx = -1;
        const findWin = (t: number) => {
          for (let i = 0; i < starts.length; i++) {
            if (t >= (starts[i] ?? 0) - 1e-6 && t <= (ends[i] ?? 0) + 1e-6)
              return i;
          }
          return -1;
        };
        const validSamples = rawCeiling.samples.filter(
          (
            s
          ): s is { now: number; mediaTime: number; presentedFrames: number } =>
            typeof s.mediaTime === 'number'
        );
        for (const s of validSamples) {
          const w = findWin(s.mediaTime);
          if (w >= 0) {
            matchedWindows.add(w);
            if (lastWinIdx >= 0 && w > lastWinIdx + 1)
              skipsCount += w - lastWinIdx - 1;
            lastWinIdx = Math.max(lastWinIdx, w);
          }
        }
        const firstMt = validSamples[0]?.mediaTime ?? 0;
        const lastMt = validSamples[validSamples.length - 1]?.mediaTime ?? 0;
        const firstWin = findWin(firstMt);
        const lastWin = findWin(lastMt);
        const windowsElapsed =
          firstWin >= 0 && lastWin >= 0 && lastWin >= firstWin
            ? lastWin - firstWin + 1
            : 0;
        const distinctWindows = matchedWindows.size;
        const ceilingRatio =
          windowsElapsed > 0 ? distinctWindows / windowsElapsed : 0;
        const nativeFps =
          rawCeiling.elapsedSeconds > 0
            ? distinctWindows / rawCeiling.elapsedSeconds
            : 0;
        const mediaFps =
          lastMt > firstMt && windowsElapsed > 0
            ? windowsElapsed / (lastMt - firstMt)
            : structure.timelineRate;

        nativeCeiling = {
          available: true,
          presentedFrames: distinctWindows,
          totalFrames: rawCeiling.totalFrames,
          droppedFrames: rawCeiling.droppedFrames,
          elapsedSeconds: rawCeiling.elapsedSeconds,
          nativeFps,
          mediaFps,
          ceilingRatio,
          distinctWindowsPresented: distinctWindows,
          windowsElapsed,
          skipsCount,
          nativeFrameHz: nativeFps,
          mediaSeconds: Math.max(0, lastMt - firstMt),
          callbackFrames: validSamples.length,
          wallMs: rawCeiling.elapsedSeconds * 1000,
        };
      }
    }

    const medians: Record<string, AggregatedMetrics> = {};
    for (const [k, reps] of Object.entries(repetitionResults))
      medians[k] = aggregateRepetitions(reps);

    const causeClassification = classifyCauses(
      medians,
      nativeCeiling,
      structure.timelineRate
    );
    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      environment: {
        browserVersion: String(attestation.version['product'] ?? 'unknown'),
        platform: process.platform,
        cpuCores:
          (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
          8,
        loadAvg: os.loadavg(),
        commandLine: launch.args,
        gpuFeatures,
        nonLoopbackBlockedCount,
      },
      structure: {
        durationSeconds: structure.durationSeconds,
        timelineRate: structure.timelineRate,
        railsCount: structure.railsCount,
        totalItems: structure.totalItems,
        editPointsCount: structure.editPointsCount,
        editPointsPerMinute: structure.editPointsPerMinute,
        medianItemLengthSeconds: structure.medianItemLengthSeconds,
        p10ItemLengthSeconds: structure.p10ItemLengthSeconds,
        transitionCount: structure.transitionCount,
        diagnosticsByCode: structure.diagnosticsByCode,
        decodersCount: structure.decodersCount,
      },
      windows: resolvedWindows,
      repetitions: repetitionResults,
      medians,
      nativeCeiling,
      causeClassification,
    };

    const sanitizedReport = sanitizeReport(report);
    if (options.outputJsonPath) {
      await writeFile(
        options.outputJsonPath,
        JSON.stringify(sanitizedReport, null, 2),
        'utf-8'
      );
    }
    return sanitizedReport;
  } finally {
    if (child !== undefined) {
      await cleanupOwnedBrowserStartup({
        child,
        connection: cdp,
        forgetChild: undefined,
        profile,
        removeProfile: undefined,
      });
    } else {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function formatReportSummary(report: BenchmarkReport): string {
  const cleanReport = sanitizeReport(report);
  const lines: string[] = [];
  lines.push('=== OTIO PLAYBACK PERFORMANCE BENCHMARK REPORT ===');
  lines.push(`Timestamp: ${cleanReport.timestamp}`);
  lines.push(
    `Browser: ${cleanReport.environment.browserVersion} (${cleanReport.environment.platform})`
  );
  lines.push(
    `Timeline: ${cleanReport.structure.durationSeconds.toFixed(1)}s, ${cleanReport.structure.timelineRate} fps, ${cleanReport.structure.totalItems} items, ${cleanReport.structure.railsCount} rails, ${cleanReport.structure.editPointsPerMinute.toFixed(1)} edit pts/min`
  );
  lines.push(
    `Network: loopback only (blocked non-loopback requests: ${cleanReport.environment.nonLoopbackBlockedCount ?? 0})`
  );
  lines.push('');
  lines.push('--- MEASUREMENT WINDOWS ---');
  for (const [k, win] of Object.entries(report.windows)) {
    lines.push(
      `  ${k} (${win.name}): [${win.start.toFixed(1)}s - ${win.end.toFixed(1)}s] (${win.duration.toFixed(1)}s)`
    );
  }
  lines.push('');

  const keys = Object.keys(report.medians);
  const headerCols = keys.map((k) => k.padEnd(11)).join(' | ');
  lines.push(`--- MEDIAN STEADY-STATE METRICS (${keys.length} WINDOWS) ---`);
  lines.push(`Metric                               | ${headerCols}`);
  lines.push(
    `-------------------------------------+${keys.map(() => '-------------').join('+')}`
  );

  const formatRow = (
    label: string,
    getter: (m: AggregatedMetrics) => string
  ) => {
    const vals = keys.map((k) => getter(report.medians[k]!).padEnd(11));
    return `${label.padEnd(36)} | ${vals.join(' | ')}`;
  };

  const rowSpecs: Array<[string, (m: AggregatedMetrics) => string]> = [
    [
      'M1 Wall Cadence (paint/wall)',
      (m) =>
        typeof m.wallCadence === 'number' ? m.wallCadence.toFixed(3) : 'n/a',
    ],
    [
      'M1 Transport Cadence (paint/trans)',
      (m) =>
        typeof m.transportCadence === 'number'
          ? m.transportCadence.toFixed(3)
          : 'n/a',
    ],
    ['M1 Clock Cadence (data-frame parity)', (m) => m.clockCadence.toFixed(3)],
    ['M2 Frame Gap p50 (ms)', (m) => m.gaps.p50.toFixed(1)],
    ['M2 Frame Gap p95 (ms)', (m) => m.gaps.p95.toFixed(1)],
    ['M2 Stutters Count (> 1.5 frame)', (m) => String(m.gaps.stutterCount)],
    [
      'Paused Seek Latency (host proxy ms)',
      (m) => m.pausedSeekLatencyMs.toFixed(1),
    ],
    ['Play to First Frame (ms)', (m) => m.playToFirstFrameMs.toFixed(1)],
    ['M3 Video Seeks / sec', (m) => m.seeks.video.perSecond.toFixed(1)],
    [
      'M3 Video Seek Latency p50 (ms)',
      (m) => m.seeks.video.latencyP50Ms.toFixed(1),
    ],
    [
      'M3 Video Seek Latency p95 (ms)',
      (m) => m.seeks.video.latencyP95Ms.toFixed(1),
    ],
    [
      'M3 Seek Window Share (%)',
      (m) => `${(m.seeks.windowShare * 100).toFixed(1)}%`,
    ],
    [
      'M4 Buffering Duration (ms)',
      (m) => m.buffering.totalBufferingMs.toFixed(1),
    ],
    ['M4 Resync Episodes', (m) => String(m.buffering.resyncEpisodes)],
    ['M5 Vsync Interval p50 (ms)', (m) => m.vsync.p50IntervalMs.toFixed(1)],
    ['M5 Vsync Interval p95 (ms)', (m) => m.vsync.p95IntervalMs.toFixed(1)],
    [
      'M6 Canvas Resets / composite',
      (m) => m.canvas.resetsPerComposite.toFixed(2),
    ],
    [
      'M7 Visible Draws / composite',
      (m) => m.canvas.visibleDrawsPerComposite.toFixed(2),
    ],
    [
      'M7 Live Video Draws (must be 0)',
      (m) => String(m.canvas.liveElementDraws),
    ],
    ['rVFC Readout p50 (ms)', (m) => m.callbackReadoutMs.p50.toFixed(2)],
    ['rVFC Readout p95 (ms)', (m) => m.callbackReadoutMs.p95.toFixed(2)],
    ['M8 Decoder Insertions', (m) => String(m.decoders.insertionsCount)],
    [
      'M9 Audio play() calls / sec',
      (m) => m.audio.playCallsPerSecond.toFixed(1),
    ],
    ['M10 Long Tasks Count', (m) => String(m.mainThread.longTasksCount)],
  ];
  for (const [label, getter] of rowSpecs) lines.push(formatRow(label, getter));

  lines.push('');
  lines.push('--- NATIVE SPEED LIMIT (CEILING) ---');
  if (cleanReport.nativeCeiling.available) {
    lines.push(
      `  Native Presented FPS: ${cleanReport.nativeCeiling.nativeFps.toFixed(1)} Hz / ${cleanReport.nativeCeiling.mediaFps.toFixed(1)} media fps`
    );
    lines.push(
      `  Scanner Ceiling Ratio: ${cleanReport.nativeCeiling.ceilingRatio.toFixed(3)} (Windows: ${cleanReport.nativeCeiling.distinctWindowsPresented ?? cleanReport.nativeCeiling.presentedFrames}/${cleanReport.nativeCeiling.windowsElapsed ?? '?'}, Skips: ${cleanReport.nativeCeiling.skipsCount ?? 0}, Dropped: ${cleanReport.nativeCeiling.droppedFrames} / ${cleanReport.nativeCeiling.totalFrames})`
    );
  } else {
    lines.push(`  Ceiling: n/a (${cleanReport.nativeCeiling.reason})`);
  }

  lines.push('');
  lines.push('--- CAUSE CLASSIFICATION ---');
  lines.push(
    `  Primary Identified Cause: ${report.causeClassification.primaryCause}`
  );
  for (const obs of report.causeClassification.observations)
    lines.push(`  - ${obs}`);
  lines.push('==================================================');
  return lines
    .join('\n')
    .replace(/(?:https?|blob|file|data):\/\/[^\s"'\\]+/gi, '[REDACTED_URL]');
}

function parseCliArgs(argv: readonly string[]): BenchmarkOptions {
  let urlFile: string | undefined;
  let url: string | undefined;
  let chromePath: string | undefined;
  let outputJsonPath: string | undefined;
  let durationSeconds: number | undefined;
  let warmupSeconds: number | undefined;
  let ceilingDurationSeconds: number | undefined;
  let repetitions: number | undefined;
  let format: 'table' | 'json' = 'table';
  let cpuThrottle: number | undefined;
  const mediaPaths: string[] = [];
  const rawWindowArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = () => argv[++i] ?? '';
    const val = (pre: string) =>
      a.startsWith(pre) ? a.slice(pre.length) : next();
    if (a === '--url-file' || a.startsWith('--url-file='))
      urlFile = val('--url-file=');
    else if (a === '--url' || a.startsWith('--url=')) url = val('--url=');
    else if (a === '--chrome-path' || a.startsWith('--chrome-path='))
      chromePath = val('--chrome-path=');
    else if (a === '--output' || a.startsWith('--output='))
      outputJsonPath = val('--output=');
    else if (a === '--duration' || a.startsWith('--duration='))
      durationSeconds = Number(val('--duration='));
    else if (a === '--warmup' || a.startsWith('--warmup='))
      warmupSeconds = Number(val('--warmup='));
    else if (a === '--ceiling-duration' || a.startsWith('--ceiling-duration='))
      ceilingDurationSeconds = Number(val('--ceiling-duration='));
    else if (a === '--repetitions' || a.startsWith('--repetitions='))
      repetitions = Number(val('--repetitions='));
    else if (a === '--format' || a.startsWith('--format=')) {
      const f = val('--format=');
      if (f === 'json' || f === 'table') format = f;
    } else if (a === '--window' || a.startsWith('--window='))
      rawWindowArgs.push(val('--window='));
    else if (a === '--media' || a.startsWith('--media='))
      mediaPaths.push(val('--media='));
    else if (a === '--cpu-throttle' || a.startsWith('--cpu-throttle='))
      cpuThrottle = Number(val('--cpu-throttle='));
    else if (
      a === '--cpu-throttling-rate' ||
      a.startsWith('--cpu-throttling-rate=')
    )
      cpuThrottle = Number(val('--cpu-throttling-rate='));
  }

  const windows: WindowOption[] = [];
  for (const raw of rawWindowArgs) {
    for (const p of raw.split(',')) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      if (trimmed.includes('=')) {
        const [name, valStr] = trimmed.split('=');
        const start = Number(valStr);
        if (name && Number.isFinite(start))
          windows.push({ name: name.trim(), start });
      } else {
        const start = Number(trimmed);
        if (Number.isFinite(start))
          windows.push({ name: `W${windows.length + 1}`, start });
      }
    }
  }

  return {
    format,
    ...(urlFile !== undefined ? { urlFile } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(chromePath !== undefined ? { chromePath } : {}),
    ...(outputJsonPath !== undefined ? { outputJsonPath } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(warmupSeconds !== undefined ? { warmupSeconds } : {}),
    ...(ceilingDurationSeconds !== undefined ? { ceilingDurationSeconds } : {}),
    ...(repetitions !== undefined ? { repetitions } : {}),
    ...(windows.length > 0 ? { windows } : {}),
    ...(cpuThrottle !== undefined ? { cpuThrottle } : {}),
    ...(mediaPaths.length > 0 ? { mediaPaths } : {}),
  };
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('otio-playback-bench.ts')
) {
  const options = parseCliArgs(process.argv.slice(2));
  runOtioPlaybackBenchmark(options)
    .then((report) => {
      if (options.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatReportSummary(report));
      }
      process.exit(0);
    })
    .catch((error) => {
      const raw = error instanceof Error ? error.message : String(error);
      const clean = raw.replace(
        /(?:https?|blob|file|data):\/\/[^\s"']+/gi,
        '[URL]'
      );
      console.error(`Benchmark failed: ${clean}`);
      process.exit(1);
    });
}
