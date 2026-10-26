import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
  type BrowserHeadlessLaunch,
} from './browser-headless.ts';

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
}

export interface WindowDefinition {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly description?: string;
}

export interface RepetitionMetrics {
  readonly windowKey: 'W1' | 'W2' | 'W3';
  readonly repetitionIndex: number;
  readonly actualDurationSeconds: number;
  readonly compositesCount: number;
  readonly distinctFramesCount: number;
  readonly cadenceRatio: number;
  readonly gaps: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    readonly stutterCount: number;
  };
  readonly jumpedHistogram: Record<'0' | '1' | '2' | '3+', number>;
  readonly seeks: {
    readonly videoSeeksCount: number;
    readonly audioSeeksCount: number;
    readonly videoSeeksPerSecond: number;
    readonly audioSeeksPerSecond: number;
    readonly cumulativeLatencyMs: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
  };
  readonly audio: {
    readonly playCallsCount: number;
    readonly playCallsPerSecond: number;
  };
  readonly canvas: {
    readonly resetsCount: number;
    readonly resetsPerComposite: number;
    readonly visibleDrawCount: number;
    readonly visibleDrawsPerComposite: number;
    readonly offscreenDrawCount: number;
    readonly offscreenDrawsPerComposite: number;
  };
  readonly vsync: {
    readonly p50IntervalMs: number;
    readonly p95IntervalMs: number;
  };
  readonly mainThread: {
    readonly longTasksCount: number;
    readonly totalLongTaskDurationMs: number;
    readonly loafCount: number;
    readonly totalLoafBlockingMs: number;
    readonly totalLoafStyleLayoutMs: number;
  };
  readonly decoders: {
    readonly insertionsCount: number;
    readonly stuttersNearInsertions: number;
    readonly stuttersNearInsertionsPercent: number;
  };
}

export interface AggregatedMetrics {
  readonly actualDurationSeconds: number;
  readonly compositesCount: number;
  readonly distinctFramesCount: number;
  readonly cadenceRatio: number;
  readonly gaps: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    readonly stutterCount: number;
  };
  readonly seeks: {
    readonly videoSeeksCount: number;
    readonly audioSeeksCount: number;
    readonly videoSeeksPerSecond: number;
    readonly audioSeeksPerSecond: number;
    readonly cumulativeLatencyMs: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
  };
  readonly audio: {
    readonly playCallsCount: number;
    readonly playCallsPerSecond: number;
  };
  readonly canvas: {
    readonly resetsCount: number;
    readonly resetsPerComposite: number;
    readonly visibleDrawCount: number;
    readonly visibleDrawsPerComposite: number;
    readonly offscreenDrawCount: number;
    readonly offscreenDrawsPerComposite: number;
  };
  readonly vsync: {
    readonly p50IntervalMs: number;
    readonly p95IntervalMs: number;
  };
  readonly mainThread: {
    readonly longTasksCount: number;
    readonly totalLongTaskDurationMs: number;
    readonly loafCount: number;
    readonly totalLoafBlockingMs: number;
    readonly totalLoafStyleLayoutMs: number;
  };
  readonly decoders: {
    readonly insertionsCount: number;
    readonly stuttersNearInsertions: number;
    readonly stuttersNearInsertionsPercent: number;
  };
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
    readonly gpuFeatures?: Record<string, unknown> | undefined;
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
  readonly windows: {
    readonly W1: WindowDefinition;
    readonly W2: WindowDefinition;
    readonly W3: WindowDefinition;
  };
  readonly repetitions: {
    readonly W1: readonly RepetitionMetrics[];
    readonly W2: readonly RepetitionMetrics[];
    readonly W3: readonly RepetitionMetrics[];
  };
  readonly medians: {
    readonly W1: AggregatedMetrics;
    readonly W2: AggregatedMetrics;
    readonly W3: AggregatedMetrics;
  };
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
  ) {
    return true;
  }
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
  if (process.platform !== 'win32') {
    const mode = fileStat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Insecure URL file permissions: ${filePath} has mode 0o${mode.toString(8)}, expected 0600 (owner-only access)`
      );
    }
  }
  const content = await readFile(filePath, 'utf-8');
  const url = content.trim();
  if (!url) {
    throw new Error(`URL file is empty: ${filePath}`);
  }
  if (!loopbackUrl(url)) {
    throw new Error('Non-loopback URL refused in replay URL file');
  }
  return url;
}

export function createOtioPageProfilerScript(): string {
  return `(() => {
    if (globalThis.__relicOtioProfilerInstalled) return;
    globalThis.__relicOtioProfilerInstalled = true;

    // 1. WebCodecs trap (contract requirement)
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

    // State collections
    const activeSeeks = [];
    const completedSeeks = [];
    const audioPlays = [];
    let visibleDrawCount = 0;
    let offscreenDrawCount = 0;
    let canvasResetsCount = 0;
    const compositeFrames = [];
    const decoderInsertions = [];
    const longTasks = [];
    const loaves = [];
    const vsyncIntervals = [];
    let lastVsyncTime = null;
    let isRecording = false;
    let recordingStartTime = 0;

    // 2. currentTime setter trap on HTMLMediaElement
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      if (desc && desc.set && desc.get) {
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          configurable: true,
          enumerable: desc.enumerable,
          get() {
            return desc.get.call(this);
          },
          set(targetVal) {
            const now = performance.now();
            const fromVal = desc.get.call(this);
            const numTarget = Number(targetVal);
            const isVideo = this instanceof HTMLVideoElement || this.tagName === 'VIDEO';
            const isAudio = this instanceof HTMLAudioElement || this.tagName === 'AUDIO';
            const kind = isVideo ? 'video' : isAudio ? 'audio' : 'other';
            const paused = Boolean(this.paused);
            const dist = Math.abs(numTarget - fromVal);

            if (isRecording) {
              const seekRecord = {
                kind,
                paused,
                from: fromVal,
                to: numTarget,
                distance: dist,
                startTime: now,
                latency: null,
              };
              activeSeeks.push(seekRecord);

              const onSeeked = () => {
                this.removeEventListener('seeked', onSeeked);
                this.removeEventListener('error', onSeeked);
                seekRecord.latency = performance.now() - now;
                completedSeeks.push(seekRecord);
              };
              this.addEventListener('seeked', onSeeked, { once: true });
              this.addEventListener('error', onSeeked, { once: true });
            }

            desc.set.call(this, targetVal);
          },
        });
      }
    } catch (e) {
      console.error('[Profiler] currentTime trap failed', e);
    }

    // 3. play() call trap on audio elements
    try {
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) {
        if (isRecording && (this instanceof HTMLAudioElement || this.tagName === 'AUDIO')) {
          audioPlays.push({ timestamp: performance.now() });
        }
        return origPlay.apply(this, args);
      };
    } catch (e) {
      console.error('[Profiler] play trap failed', e);
    }

    // 4. drawImage trap on 2D context
    try {
      const origDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(...args) {
        if (isRecording) {
          const isVisible = Boolean(
            this.canvas &&
            ((this.canvas.matches && this.canvas.matches('canvas.otio-canvas')) ||
             (this.canvas.classList && this.canvas.classList.contains('otio-canvas')))
          );
          if (isVisible) {
            visibleDrawCount++;
          } else {
            offscreenDrawCount++;
          }
        }
        return origDraw.apply(this, args);
      };
    } catch (e) {
      console.error('[Profiler] drawImage trap failed', e);
    }

    // 5. width / height setters trap on HTMLCanvasElement
    try {
      for (const prop of ['width', 'height']) {
        const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
        if (desc && desc.set && desc.get) {
          Object.defineProperty(HTMLCanvasElement.prototype, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
              return desc.get.call(this);
            },
            set(val) {
              if (isRecording) {
                canvasResetsCount++;
              }
              desc.set.call(this, val);
            },
          });
        }
      }
    } catch (e) {
      console.error('[Profiler] canvas reset trap failed', e);
    }

    // 6. PerformanceObserver for longtask & long-animation-frame
    try {
      const longTaskObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (isRecording) {
            longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        }
      });
      longTaskObs.observe({ type: 'longtask', buffered: true });
    } catch {}

    try {
      const loafObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (isRecording) {
            loaves.push({
              startTime: entry.startTime,
              duration: entry.duration,
              blockingDuration: entry.blockingDuration,
              styleAndLayoutDuration: entry.styleAndLayoutDuration,
            });
          }
        }
      });
      loafObs.observe({ type: 'long-animation-frame', buffered: true });
    } catch {}

    // 7. Vsync rAF loop
    function onVsync(now) {
      if (lastVsyncTime !== null) {
        const delta = now - lastVsyncTime;
        if (isRecording) {
          vsyncIntervals.push(delta);
        }
      }
      lastVsyncTime = now;
      requestAnimationFrame(onVsync);
    }
    requestAnimationFrame(onVsync);

    // 8. MutationObserver on root section.otio-view for data-frame
    let otioViewObserver = null;
    function attachViewObserver(root) {
      if (otioViewObserver) otioViewObserver.disconnect();
      otioViewObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'data-frame') {
            const frameStr = root.dataset.frame;
            if (frameStr !== undefined && frameStr !== null) {
              const frameNum = Number(frameStr);
              if (isRecording) {
                compositeFrames.push({
                  frame: frameNum,
                  timestamp: performance.now(),
                  buffering: root.dataset.buffering === 'true',
                });
              }
            }
          }
        }
      });
      otioViewObserver.observe(root, {
        attributes: true,
        attributeFilter: ['data-frame', 'data-buffering', 'data-playing'],
      });
    }

    // 9. MutationObserver on .otio-video-decoders for new decoders
    let decoderObserver = null;
    function attachDecoderObserver(host) {
      if (decoderObserver) decoderObserver.disconnect();
      decoderObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLVideoElement || node.tagName === 'VIDEO') {
              const now = performance.now();
              const record = {
                insertionTime: now,
                loadedDataLatency: null,
              };
              decoderInsertions.push(record);
              const onLoaded = () => {
                node.removeEventListener('loadeddata', onLoaded);
                node.removeEventListener('error', onLoaded);
                record.loadedDataLatency = performance.now() - now;
              };
              if (node.readyState >= 2) {
                record.loadedDataLatency = 0;
              } else {
                node.addEventListener('loadeddata', onLoaded, { once: true });
                node.addEventListener('error', onLoaded, { once: true });
              }
            }
          }
        }
      });
      decoderObserver.observe(host, { childList: true });
    }

    // Global profiler helper interface
    globalThis.__relicOtioProfiler = {
      async waitForMount(timeoutMs = 30000) {
        const delay = (ms) => {
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, ms);
          return promise;
        };
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
          const root = document.querySelector('section.otio-view');
          const seek = document.querySelector('input.otio-seek');
          const play = document.querySelector('button.otio-play');
          const decoders = document.querySelector('.otio-video-decoders');
          if (root && seek && play) {
            attachViewObserver(root);
            if (decoders) attachDecoderObserver(decoders);
            if (root.dataset.buffering === 'false') {
              return { mounted: true };
            }
          }
          await delay(100);
        }
        throw new Error('OTIO viewer mount timeout');
      },

      getTimelineStructure() {
        const root = document.querySelector('section.otio-view');
        if (!root) throw new Error('section.otio-view not found');
        const items = [...document.querySelectorAll('.otio-item')];
        const rails = [...document.querySelectorAll('.otio-track-row, .otio-rail')];
        const diagnostics = [...document.querySelectorAll('.otio-diagnostic')];
        const decoders = [...document.querySelectorAll('.otio-video-decoders video')];
        const audios = [...document.querySelectorAll('audio')];

        const diagCodes = {};
        for (const d of diagnostics) {
          const text = (d.textContent || '').trim();
          const code = text.split(' · ')[0] || 'unknown';
          diagCodes[code] = (diagCodes[code] || 0) + 1;
        }

        let maxEnd = 0;
        let timelineRate = 24;
        const boundaries = new Set();
        const parsedItems = [];
        let transitionCount = 0;

        for (const item of items) {
          const startVal = Number(item.dataset.start ?? 0);
          const durVal = Number(item.dataset.duration ?? 0);
          const rateVal = Number(item.dataset.rate ?? 24);
          if (rateVal > 0) timelineRate = rateVal;
          const startSec = startVal / rateVal;
          const endSec = (startVal + durVal) / rateVal;
          if (endSec > maxEnd) maxEnd = endSec;
          boundaries.add(startSec);
          boundaries.add(endSec);
          const isTransition = item.classList.contains('is-transition');
          if (isTransition) transitionCount++;
          parsedItems.push({
            startSec,
            endSec,
            durationSec: durVal / rateVal,
            isTransition,
            isGap: item.classList.contains('is-gap'),
          });
        }

        const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
        const itemLengths = parsedItems.map((i) => i.durationSec).sort((a, b) => a - b);
        const medianLength = itemLengths.length ? itemLengths[Math.floor(itemLengths.length / 2)] : 0;
        const p10Length = itemLengths.length ? itemLengths[Math.floor(itemLengths.length * 0.1)] : 0;

        // Discover W1: longest stretch with no clip boundaries across all video rails
        let w1Best = { start: 0, end: Math.min(maxEnd, 6), duration: Math.min(maxEnd, 6) };
        let maxGap = 0;
        for (let i = 0; i < sortedBoundaries.length - 1; i++) {
          const gap = sortedBoundaries[i + 1] - sortedBoundaries[i];
          if (gap > maxGap) {
            maxGap = gap;
            w1Best = {
              start: sortedBoundaries[i],
              end: sortedBoundaries[i + 1],
              duration: gap,
            };
          }
        }
        if (maxGap < 6 && maxEnd >= 6) {
          w1Best = { start: 0, end: Math.min(maxEnd, 15), duration: Math.min(maxEnd, 15) };
        }

        // Discover W2: 20s window with the most boundaries
        const windowSize = Math.min(maxEnd, 20);
        let w2Best = { start: 0, end: windowSize, count: 0 };
        for (let t = 0; t <= Math.max(0, maxEnd - windowSize); t += 0.5) {
          const count = sortedBoundaries.filter((b) => b >= t && b <= t + windowSize).length;
          if (count > w2Best.count) {
            w2Best = { start: t, end: t + windowSize, count };
          }
        }

        // Discover W3: 20s window with most transitions or highest active layers
        let w3Best = { start: 0, end: windowSize, score: 0 };
        for (let t = 0; t <= Math.max(0, maxEnd - windowSize); t += 0.5) {
          let score = 0;
          for (const item of parsedItems) {
            if (item.startSec <= t + windowSize && item.endSec >= t) {
              score += item.isTransition ? 5 : 1;
            }
          }
          if (score > w3Best.score) {
            w3Best = { start: t, end: t + windowSize, score };
          }
        }

        const editPointsPerMin = maxEnd > 0 ? (sortedBoundaries.length / (maxEnd / 60)) : 0;

        return {
          durationSeconds: maxEnd,
          timelineRate,
          railsCount: rails.length,
          totalItems: items.length,
          editPointsCount: sortedBoundaries.length,
          editPointsPerMinute: editPointsPerMin,
          medianItemLengthSeconds: medianLength,
          p10ItemLengthSeconds: p10Length,
          transitionCount,
          diagnosticsByCode: diagCodes,
          decodersCount: decoders.length,
          audioCount: audios.length,
          windows: {
            W1: { start: w1Best.start, end: w1Best.end, duration: w1Best.duration, description: 'Longest continuous stretch with no boundaries' },
            W2: { start: w2Best.start, end: w2Best.end, duration: windowSize, description: '20s with highest clip boundary density' },
            W3: { start: w3Best.start, end: w3Best.end, duration: windowSize, description: '20s with most active layers / transitions' },
          },
        };
      },

      async runWindowRepetition({ windowKey, startSeconds, durationSeconds = 15, warmupSeconds = 2 }) {
        const delay = (ms) => {
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, ms);
          return promise;
        };
        const root = document.querySelector('section.otio-view');
        const seekInput = document.querySelector('input.otio-seek');
        const playBtn = document.querySelector('button.otio-play');
        if (!root || !seekInput || !playBtn) throw new Error('Viewer controls missing');

        if (root.dataset.playing === 'true') {
          playBtn.click();
          await delay(200);
        }

        const rateStr = root.dataset.rate || '24';
        const rate = Number(rateStr) || 24;
        const targetFrame = Math.round(startSeconds * rate);

        seekInput.value = String(targetFrame);
        seekInput.dispatchEvent(new Event('input', { bubbles: true }));

        const seekStart = performance.now();
        while (performance.now() - seekStart < 10000) {
          if (root.dataset.buffering === 'false') break;
          await delay(50);
        }

        playBtn.click();
        await delay(warmupSeconds * 1000);

        activeSeeks.length = 0;
        completedSeeks.length = 0;
        audioPlays.length = 0;
        visibleDrawCount = 0;
        offscreenDrawCount = 0;
        canvasResetsCount = 0;
        compositeFrames.length = 0;
        decoderInsertions.length = 0;
        longTasks.length = 0;
        loaves.length = 0;
        vsyncIntervals.length = 0;

        isRecording = true;
        recordingStartTime = performance.now();

        await delay(durationSeconds * 1000);
        isRecording = false;
        const recordingEndTime = performance.now();
        const actualDurationSeconds = (recordingEndTime - recordingStartTime) / 1000;

        if (root.dataset.playing === 'true') {
          playBtn.click();
        }

        const distinctFrames = new Set(compositeFrames.map((c) => c.frame));
        const framesElapsed = actualDurationSeconds * rate;
        const cadenceRatio = framesElapsed > 0 ? (distinctFrames.size / framesElapsed) : 0;

        const frameGaps = [];
        const jumpedHistogram = { '0': 0, '1': 0, '2': 0, '3+': 0 };
        for (let i = 0; i < compositeFrames.length - 1; i++) {
          const delta = compositeFrames[i + 1].frame - compositeFrames[i].frame;
          frameGaps.push(delta);
          if (delta === 0) jumpedHistogram['0']++;
          else if (delta === 1) jumpedHistogram['1']++;
          else if (delta === 2) jumpedHistogram['2']++;
          else jumpedHistogram['3+']++;
        }

        const sortedGaps = [...frameGaps].sort((a, b) => a - b);
        const p50Gap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length * 0.5)] : 0;
        const p95Gap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length * 0.95)] : 0;
        const p99Gap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length * 0.99)] : 0;
        const maxGap = sortedGaps.length ? sortedGaps[sortedGaps.length - 1] : 0;
        const stutterCount = sortedGaps.filter((g) => g > 1.5).length;

        const videoSeeks = completedSeeks.filter((s) => s.kind === 'video');
        const audioSeeks = completedSeeks.filter((s) => s.kind === 'audio');
        const videoSeeksPerSec = actualDurationSeconds > 0 ? (videoSeeks.length / actualDurationSeconds) : 0;
        const audioSeeksPerSec = actualDurationSeconds > 0 ? (audioSeeks.length / actualDurationSeconds) : 0;

        const allLatencies = completedSeeks.map((s) => s.latency).filter((l) => typeof l === 'number').sort((a, b) => a - b);
        const cumSeekLatency = allLatencies.reduce((sum, l) => sum + l, 0);
        const p50Latency = allLatencies.length ? allLatencies[Math.floor(allLatencies.length * 0.5)] : 0;
        const p95Latency = allLatencies.length ? allLatencies[Math.floor(allLatencies.length * 0.95)] : 0;

        const sortedVsync = [...vsyncIntervals].sort((a, b) => a - b);
        const p50Vsync = sortedVsync.length ? sortedVsync[Math.floor(sortedVsync.length * 0.5)] : 0;
        const p95Vsync = sortedVsync.length ? sortedVsync[Math.floor(sortedVsync.length * 0.95)] : 0;

        const numComposites = compositeFrames.length || 1;
        const resetsPerComposite = canvasResetsCount / numComposites;
        const visibleDrawsPerComposite = visibleDrawCount / numComposites;
        const offscreenDrawsPerComposite = offscreenDrawCount / numComposites;

        const totalLongTaskDuration = longTasks.reduce((acc, t) => acc + t.duration, 0);
        const totalLoafBlocking = loaves.reduce((acc, l) => acc + (l.blockingDuration || 0), 0);
        const totalLoafStyleLayout = loaves.reduce((acc, l) => acc + (l.styleAndLayoutDuration || 0), 0);

        let stuttersNearInsertions = 0;
        if (stutterCount > 0 && decoderInsertions.length > 0) {
          for (let i = 0; i < compositeFrames.length - 1; i++) {
            const delta = compositeFrames[i + 1].frame - compositeFrames[i].frame;
            if (delta > 1.5) {
              const stutterTime = compositeFrames[i].timestamp;
              const near = decoderInsertions.some((d) => Math.abs(d.insertionTime - stutterTime) <= 250);
              if (near) stuttersNearInsertions++;
            }
          }
        }
        const stuttersNearInsertionsPercent = stutterCount > 0 ? (stuttersNearInsertions / stutterCount) * 100 : 0;

        return {
          windowKey,
          actualDurationSeconds,
          compositesCount: compositeFrames.length,
          distinctFramesCount: distinctFrames.size,
          cadenceRatio,
          gaps: {
            p50: p50Gap,
            p95: p95Gap,
            p99: p99Gap,
            max: maxGap,
            stutterCount,
          },
          jumpedHistogram,
          seeks: {
            videoSeeksCount: videoSeeks.length,
            audioSeeksCount: audioSeeks.length,
            videoSeeksPerSecond: videoSeeksPerSec,
            audioSeeksPerSecond: audioSeeksPerSec,
            cumulativeLatencyMs: cumSeekLatency,
            latencyP50Ms: p50Latency,
            latencyP95Ms: p95Latency,
          },
          audio: {
            playCallsCount: audioPlays.length,
            playCallsPerSecond: actualDurationSeconds > 0 ? (audioPlays.length / actualDurationSeconds) : 0,
          },
          canvas: {
            resetsCount: canvasResetsCount,
            resetsPerComposite,
            visibleDrawCount,
            visibleDrawsPerComposite,
            offscreenDrawCount,
            offscreenDrawsPerComposite,
          },
          vsync: {
            p50IntervalMs: p50Vsync,
            p95IntervalMs: p95Vsync,
          },
          mainThread: {
            longTasksCount: longTasks.length,
            totalLongTaskDurationMs: totalLongTaskDuration,
            loafCount: loaves.length,
            totalLoafBlockingMs: totalLoafBlocking,
            totalLoafStyleLayoutMs: totalLoafStyleLayout,
          },
          decoders: {
            insertionsCount: decoderInsertions.length,
            stuttersNearInsertions,
            stuttersNearInsertionsPercent,
          },
        };
      },

      async measureNativeCeiling(durationSeconds = 10) {
        const decoders = [...document.querySelectorAll('.otio-video-decoders video')];
        if (decoders.length === 0) {
          return {
            available: false,
            reason: 'No video decoders in timeline (images or audio-only)',
            ceilingRatio: 'n/a',
          };
        }

        const sourceVideo = decoders[0];
        const src = sourceVideo.src;
        if (!src) {
          return {
            available: false,
            reason: 'No src attribute on video decoder',
            ceilingRatio: 'n/a',
          };
        }

        const host = document.querySelector('.otio-video-decoders') || document.body;
        const testVid = document.createElement('video');
        testVid.muted = true;
        testVid.playsInline = true;
        testVid.preload = 'auto';
        testVid.src = src;
        testVid.style.display = 'none';
        host.appendChild(testVid);

        try {
          const delay = (ms) => {
            const { promise, resolve } = Promise.withResolvers();
            setTimeout(resolve, ms);
            return promise;
          };
          if (testVid.readyState < 2) {
            const { promise: loadedPromise, resolve: onLoaded } = Promise.withResolvers();
            testVid.addEventListener('loadeddata', onLoaded, { once: true });
            testVid.addEventListener('error', onLoaded, { once: true });
            await loadedPromise;
          }

          let presentedFrames = 0;
          let running = true;
          function onFrame() {
            if (!running) return;
            presentedFrames++;
            if ('requestVideoFrameCallback' in testVid) {
              testVid.requestVideoFrameCallback(onFrame);
            }
          }
          if ('requestVideoFrameCallback' in testVid) {
            testVid.requestVideoFrameCallback(onFrame);
          }

          const start = performance.now();
          await testVid.play();
          await delay(durationSeconds * 1000);
          running = false;
          testVid.pause();
          const elapsedSec = (performance.now() - start) / 1000;

          let droppedFrames = 0;
          let totalFrames = presentedFrames;
          if (typeof testVid.getVideoPlaybackQuality === 'function') {
            const quality = testVid.getVideoPlaybackQuality();
            droppedFrames = quality.droppedVideoFrames || 0;
            totalFrames = quality.totalVideoFrames || presentedFrames;
          }

          const nativeFps = elapsedSec > 0 ? (presentedFrames / elapsedSec) : 0;
          const root = document.querySelector('section.otio-view');
          const mediaFps = Number(root?.dataset?.rate || '24') || 24;
          const ceilingRatio = mediaFps > 0 ? (nativeFps / mediaFps) : 0;

          return {
            available: true,
            presentedFrames,
            totalFrames,
            droppedFrames,
            elapsedSeconds: elapsedSec,
            nativeFps,
            mediaFps,
            ceilingRatio,
          };
        } finally {
          testVid.remove();
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
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    },
    sessionId
  );
  const exception = res['exceptionDetails'] as
    | { text?: string; exception?: { description?: string } }
    | undefined;
  if (exception) {
    throw new Error(
      `Page evaluation failed: ${exception.text ?? exception.exception?.description ?? 'unknown error'}`
    );
  }
  const result = res['result'] as { value?: T } | undefined;
  return result?.value as T;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function aggregateRepetitions(
  reps: readonly RepetitionMetrics[]
): AggregatedMetrics {
  const getMedian = (getter: (r: RepetitionMetrics) => number) =>
    median(reps.map(getter));

  return {
    actualDurationSeconds: getMedian((r) => r.actualDurationSeconds),
    compositesCount: getMedian((r) => r.compositesCount),
    distinctFramesCount: getMedian((r) => r.distinctFramesCount),
    cadenceRatio: getMedian((r) => r.cadenceRatio),
    gaps: {
      p50: getMedian((r) => r.gaps.p50),
      p95: getMedian((r) => r.gaps.p95),
      p99: getMedian((r) => r.gaps.p99),
      max: getMedian((r) => r.gaps.max),
      stutterCount: getMedian((r) => r.gaps.stutterCount),
    },
    seeks: {
      videoSeeksCount: getMedian((r) => r.seeks.videoSeeksCount),
      audioSeeksCount: getMedian((r) => r.seeks.audioSeeksCount),
      videoSeeksPerSecond: getMedian((r) => r.seeks.videoSeeksPerSecond),
      audioSeeksPerSecond: getMedian((r) => r.seeks.audioSeeksPerSecond),
      cumulativeLatencyMs: getMedian((r) => r.seeks.cumulativeLatencyMs),
      latencyP50Ms: getMedian((r) => r.seeks.latencyP50Ms),
      latencyP95Ms: getMedian((r) => r.seeks.latencyP95Ms),
    },
    audio: {
      playCallsCount: getMedian((r) => r.audio.playCallsCount),
      playCallsPerSecond: getMedian((r) => r.audio.playCallsPerSecond),
    },
    canvas: {
      resetsCount: getMedian((r) => r.canvas.resetsCount),
      resetsPerComposite: getMedian((r) => r.canvas.resetsPerComposite),
      visibleDrawCount: getMedian((r) => r.canvas.visibleDrawCount),
      visibleDrawsPerComposite: getMedian(
        (r) => r.canvas.visibleDrawsPerComposite
      ),
      offscreenDrawCount: getMedian((r) => r.canvas.offscreenDrawCount),
      offscreenDrawsPerComposite: getMedian(
        (r) => r.canvas.offscreenDrawsPerComposite
      ),
    },
    vsync: {
      p50IntervalMs: getMedian((r) => r.vsync.p50IntervalMs),
      p95IntervalMs: getMedian((r) => r.vsync.p95IntervalMs),
    },
    mainThread: {
      longTasksCount: getMedian((r) => r.mainThread.longTasksCount),
      totalLongTaskDurationMs: getMedian(
        (r) => r.mainThread.totalLongTaskDurationMs
      ),
      loafCount: getMedian((r) => r.mainThread.loafCount),
      totalLoafBlockingMs: getMedian((r) => r.mainThread.totalLoafBlockingMs),
      totalLoafStyleLayoutMs: getMedian(
        (r) => r.mainThread.totalLoafStyleLayoutMs
      ),
    },
    decoders: {
      insertionsCount: getMedian((r) => r.decoders.insertionsCount),
      stuttersNearInsertions: getMedian(
        (r) => r.decoders.stuttersNearInsertions
      ),
      stuttersNearInsertionsPercent: getMedian(
        (r) => r.decoders.stuttersNearInsertionsPercent
      ),
    },
  };
}

function classifyCauses(
  medians: {
    W1: AggregatedMetrics;
    W2: AggregatedMetrics;
    W3: AggregatedMetrics;
  },
  ceiling: NativeCeilingResult
): {
  primaryCause: BenchmarkReport['causeClassification']['primaryCause'];
  observations: readonly string[];
} {
  const observations: string[] = [];

  // Check 1: Environment ceiling
  if (
    ceiling.available &&
    typeof ceiling.ceilingRatio === 'number' &&
    ceiling.ceilingRatio < 0.9
  ) {
    observations.push(
      `Native video decoding ceiling (${ceiling.nativeFps.toFixed(1)} fps, ratio ${ceiling.ceilingRatio.toFixed(2)}) is below 0.9: headless browser cannot decode media in real time.`
    );
    return { primaryCause: 'The environment itself', observations };
  }

  // Check 2: Decoder seeks dominate
  const w1SeekWaitMs = medians.W1.seeks.cumulativeLatencyMs;
  const w1TotalTimeMs = medians.W1.actualDurationSeconds * 1000;
  const seekWaitShare = w1TotalTimeMs > 0 ? w1SeekWaitMs / w1TotalTimeMs : 0;
  if (
    medians.W1.vsync.p95IntervalMs <= 20 &&
    (seekWaitShare >= 0.5 || medians.W1.seeks.videoSeeksPerSecond >= 10)
  ) {
    observations.push(
      `Steady vsync (p95: ${medians.W1.vsync.p95IntervalMs.toFixed(1)} ms) with high seek rate (${medians.W1.seeks.videoSeeksPerSecond.toFixed(1)} seeks/s) and seek wait accounting for ${(seekWaitShare * 100).toFixed(1)}% of duration.`
    );
    return { primaryCause: 'Decoder seeks', observations };
  }

  // Check 3: Edit points (decoder insertions)
  if (medians.W2.decoders.stuttersNearInsertionsPercent >= 30) {
    observations.push(
      `${medians.W2.decoders.stuttersNearInsertionsPercent.toFixed(1)}% of stutters in W2 occurred within ±250ms of a new decoder insertion.`
    );
    return { primaryCause: 'Edit points', observations };
  }

  // Check 4: Controller or DOM work
  const frameBudgetMs = 1000 / 24;
  const mainThreadPerFrame =
    medians.W1.mainThread.totalLoafStyleLayoutMs /
    Math.max(1, medians.W1.compositesCount);
  if (mainThreadPerFrame >= 0.15 * frameBudgetMs) {
    observations.push(
      `Main-thread style/layout per composite (${mainThreadPerFrame.toFixed(2)} ms) exceeds 15% of frame budget (${(0.15 * frameBudgetMs).toFixed(2)} ms).`
    );
    return { primaryCause: 'Controller or DOM work', observations };
  }

  // Check 5: Compositor or GPU
  if (medians.W1.vsync.p95IntervalMs > 25 && seekWaitShare < 0.3) {
    observations.push(
      `Vsync interval unstable (p95: ${medians.W1.vsync.p95IntervalMs.toFixed(1)} ms) while seek wait is low (${(seekWaitShare * 100).toFixed(1)}%).`
    );
    return { primaryCause: 'Compositor or GPU', observations };
  }

  observations.push(
    'Metrics do not decisively match a single dominant cause threshold.'
  );
  return { primaryCause: 'Indeterminate', observations };
}

export async function runOtioPlaybackBenchmark(
  options: BenchmarkOptions
): Promise<BenchmarkReport> {
  let targetUrl: string;
  if (options.urlFile) {
    targetUrl = await readUrlFromProtectedFile(options.urlFile);
  } else if (options.url) {
    if (!loopbackUrl(options.url)) {
      throw new Error(`Non-loopback URL refused: ${options.url}`);
    }
    targetUrl = options.url;
  } else {
    const envUrlFile =
      process.env['RELIC_OTIO_URL_FILE'] ??
      process.env['RELIC_OTIO_REPLAY_URL_FILE'];
    if (envUrlFile) {
      targetUrl = await readUrlFromProtectedFile(envUrlFile);
    } else {
      throw new Error(
        'Replay URL must be provided via --url-file <path>, --url <loopback-url>, or RELIC_OTIO_URL_FILE'
      );
    }
  }

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
  if (foundChrome.kind !== 'found') {
    throw new Error(
      `Chrome discovery failed: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
    );
  }

  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-bench-'));
  const shared = chromeArgs(foundChrome.path, profile);
  let launch: BrowserHeadlessLaunch;
  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;

  try {
    launch = createBrowserHeadlessLaunch(
      [
        ...shared.map((arg) =>
          arg === '--proxy-bypass-list=<-loopback>'
            ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
            : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
              ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
              : arg
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

    cdp.onEvent((event) => {
      if (
        event.method !== 'Fetch.requestPaused' ||
        event.sessionId !== sessionId
      ) {
        return;
      }
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
      {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId
    );

    const profilerScript = createOtioPageProfilerScript();
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: profilerScript },
      sessionId
    );

    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);

    await evaluate<{ mounted: boolean }>(
      cdp,
      sessionId,
      'window.__relicOtioProfiler.waitForMount(30000)'
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
      windows: {
        W1: WindowDefinition;
        W2: WindowDefinition;
        W3: WindowDefinition;
      };
    }>(cdp, sessionId, 'window.__relicOtioProfiler.getTimelineStructure()');

    const repetitionResults: {
      W1: RepetitionMetrics[];
      W2: RepetitionMetrics[];
      W3: RepetitionMetrics[];
    } = {
      W1: [],
      W2: [],
      W3: [],
    };

    const windowKeys = ['W1', 'W2', 'W3'] as const;
    for (const key of windowKeys) {
      const win = structure.windows[key];
      const winDuration = Math.min(win.duration, durationSeconds);

      for (let rep = 0; rep < repetitionsCount; rep++) {
        const repMetrics = await evaluate<
          Omit<RepetitionMetrics, 'repetitionIndex'>
        >(
          cdp,
          sessionId,
          `window.__relicOtioProfiler.runWindowRepetition(${JSON.stringify({
            windowKey: key,
            startSeconds: win.start,
            durationSeconds: winDuration,
            warmupSeconds,
          })})`
        );
        repetitionResults[key].push({
          ...repMetrics,
          repetitionIndex: rep + 1,
        });
      }
    }

    const nativeCeiling = await evaluate<NativeCeilingResult>(
      cdp,
      sessionId,
      `window.__relicOtioProfiler.measureNativeCeiling(${ceilingDurationSeconds})`
    );

    const medians = {
      W1: aggregateRepetitions(repetitionResults.W1),
      W2: aggregateRepetitions(repetitionResults.W2),
      W3: aggregateRepetitions(repetitionResults.W3),
    };

    const causeClassification = classifyCauses(medians, nativeCeiling);

    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      environment: {
        browserVersion: String(attestation.version['product'] ?? 'unknown'),
        platform: process.platform,
        cpuCores:
          (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
          8,
        gpuFeatures,
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
      windows: structure.windows,
      repetitions: repetitionResults,
      medians,
      nativeCeiling,
      causeClassification,
    };

    if (options.outputJsonPath) {
      await writeFile(
        options.outputJsonPath,
        JSON.stringify(report, null, 2),
        'utf-8'
      );
    }

    return report;
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
  const lines: string[] = [];
  lines.push('=== OTIO PLAYBACK PERFORMANCE BENCHMARK REPORT ===');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(
    `Browser: ${report.environment.browserVersion} (${report.environment.platform})`
  );
  lines.push(
    `Timeline: ${report.structure.durationSeconds.toFixed(1)}s, ${report.structure.timelineRate} fps, ${report.structure.totalItems} items, ${report.structure.railsCount} rails, ${report.structure.editPointsPerMinute.toFixed(1)} edit pts/min`
  );
  lines.push('');
  lines.push('--- MEASUREMENT WINDOWS ---');
  for (const [k, win] of Object.entries(report.windows)) {
    lines.push(
      `  ${k}: [${win.start.toFixed(1)}s - ${win.end.toFixed(1)}s] (${win.duration.toFixed(1)}s) ${win.description ?? ''}`
    );
  }
  lines.push('');
  lines.push('--- MEDIAN STEADY-STATE METRICS (3 REPETITIONS) ---');
  lines.push(
    'Metric                               | W1 (Steady) | W2 (Cuts)   | W3 (Layers) '
  );
  lines.push(
    '-------------------------------------+-------------+-------------+-------------'
  );

  const formatRow = (label: string, v1: string, v2: string, v3: string) =>
    `${label.padEnd(36)} | ${v1.padEnd(11)} | ${v2.padEnd(11)} | ${v3.padEnd(11)}`;

  const m = report.medians;
  lines.push(
    formatRow(
      'M1 Cadence Ratio (shown/elapsed)',
      m.W1.cadenceRatio.toFixed(3),
      m.W2.cadenceRatio.toFixed(3),
      m.W3.cadenceRatio.toFixed(3)
    )
  );
  lines.push(
    formatRow(
      'M2 Frame Gap p50 (timeline frames)',
      m.W1.gaps.p50.toFixed(2),
      m.W2.gaps.p50.toFixed(2),
      m.W3.gaps.p50.toFixed(2)
    )
  );
  lines.push(
    formatRow(
      'M2 Frame Gap p95 (timeline frames)',
      m.W1.gaps.p95.toFixed(2),
      m.W2.gaps.p95.toFixed(2),
      m.W3.gaps.p95.toFixed(2)
    )
  );
  lines.push(
    formatRow(
      'M2 Stutters Count (gaps > 1.5)',
      String(m.W1.gaps.stutterCount),
      String(m.W2.gaps.stutterCount),
      String(m.W3.gaps.stutterCount)
    )
  );
  lines.push(
    formatRow(
      'M4 Video Seeks / sec',
      m.W1.seeks.videoSeeksPerSecond.toFixed(1),
      m.W2.seeks.videoSeeksPerSecond.toFixed(1),
      m.W3.seeks.videoSeeksPerSecond.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M4 Audio Seeks / sec',
      m.W1.seeks.audioSeeksPerSecond.toFixed(1),
      m.W2.seeks.audioSeeksPerSecond.toFixed(1),
      m.W3.seeks.audioSeeksPerSecond.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M4 Seek Latency p50 (ms)',
      m.W1.seeks.latencyP50Ms.toFixed(1),
      m.W2.seeks.latencyP50Ms.toFixed(1),
      m.W3.seeks.latencyP50Ms.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M4 Seek Latency p95 (ms)',
      m.W1.seeks.latencyP95Ms.toFixed(1),
      m.W2.seeks.latencyP95Ms.toFixed(1),
      m.W3.seeks.latencyP95Ms.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M6 Vsync Interval p50 (ms)',
      m.W1.vsync.p50IntervalMs.toFixed(1),
      m.W2.vsync.p50IntervalMs.toFixed(1),
      m.W3.vsync.p50IntervalMs.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M6 Vsync Interval p95 (ms)',
      m.W1.vsync.p95IntervalMs.toFixed(1),
      m.W2.vsync.p95IntervalMs.toFixed(1),
      m.W3.vsync.p95IntervalMs.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M7 Canvas Resets / composite',
      m.W1.canvas.resetsPerComposite.toFixed(2),
      m.W2.canvas.resetsPerComposite.toFixed(2),
      m.W3.canvas.resetsPerComposite.toFixed(2)
    )
  );
  lines.push(
    formatRow(
      'M7 Draws / composite',
      (
        m.W1.canvas.visibleDrawsPerComposite +
        m.W1.canvas.offscreenDrawsPerComposite
      ).toFixed(2),
      (
        m.W2.canvas.visibleDrawsPerComposite +
        m.W2.canvas.offscreenDrawsPerComposite
      ).toFixed(2),
      (
        m.W3.canvas.visibleDrawsPerComposite +
        m.W3.canvas.offscreenDrawsPerComposite
      ).toFixed(2)
    )
  );
  lines.push(
    formatRow(
      'M8 Stutters Near Decoder Insert %',
      `${m.W1.decoders.stuttersNearInsertionsPercent.toFixed(0)}%`,
      `${m.W2.decoders.stuttersNearInsertionsPercent.toFixed(0)}%`,
      `${m.W3.decoders.stuttersNearInsertionsPercent.toFixed(0)}%`
    )
  );
  lines.push(
    formatRow(
      'M9 Audio play() calls / sec',
      m.W1.audio.playCallsPerSecond.toFixed(1),
      m.W2.audio.playCallsPerSecond.toFixed(1),
      m.W3.audio.playCallsPerSecond.toFixed(1)
    )
  );
  lines.push(
    formatRow(
      'M10 Long Tasks Count',
      String(m.W1.mainThread.longTasksCount),
      String(m.W2.mainThread.longTasksCount),
      String(m.W3.mainThread.longTasksCount)
    )
  );

  lines.push('');
  lines.push('--- NATIVE SPEED LIMIT (CEILING) ---');
  if (report.nativeCeiling.available) {
    lines.push(
      `  Native Presented FPS: ${report.nativeCeiling.nativeFps.toFixed(1)} / ${report.nativeCeiling.mediaFps} fps`
    );
    lines.push(
      `  Ceiling Ratio: ${report.nativeCeiling.ceilingRatio.toFixed(3)} (Dropped: ${report.nativeCeiling.droppedFrames} / ${report.nativeCeiling.totalFrames})`
    );
  } else {
    lines.push(`  Ceiling: n/a (${report.nativeCeiling.reason})`);
  }

  lines.push('');
  lines.push('--- CAUSE CLASSIFICATION ---');
  lines.push(
    `  Primary Identified Cause: ${report.causeClassification.primaryCause}`
  );
  for (const obs of report.causeClassification.observations) {
    lines.push(`  - ${obs}`);
  }
  lines.push('==================================================');
  return lines.join('\n');
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

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url-file' && i + 1 < argv.length) {
      urlFile = argv[++i];
    } else if (arg?.startsWith('--url-file=')) {
      urlFile = arg.slice('--url-file='.length);
    } else if (arg === '--url' && i + 1 < argv.length) {
      url = argv[++i];
    } else if (arg?.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg === '--chrome-path' && i + 1 < argv.length) {
      chromePath = argv[++i];
    } else if (arg?.startsWith('--chrome-path=')) {
      chromePath = arg.slice('--chrome-path='.length);
    } else if (arg === '--output' && i + 1 < argv.length) {
      outputJsonPath = argv[++i];
    } else if (arg?.startsWith('--output=')) {
      outputJsonPath = arg.slice('--output='.length);
    } else if (arg === '--duration' && i + 1 < argv.length) {
      durationSeconds = Number(argv[++i]);
    } else if (arg?.startsWith('--duration=')) {
      durationSeconds = Number(arg.slice('--duration='.length));
    } else if (arg === '--warmup' && i + 1 < argv.length) {
      warmupSeconds = Number(argv[++i]);
    } else if (arg?.startsWith('--warmup=')) {
      warmupSeconds = Number(arg.slice('--warmup='.length));
    } else if (arg === '--ceiling-duration' && i + 1 < argv.length) {
      ceilingDurationSeconds = Number(argv[++i]);
    } else if (arg?.startsWith('--ceiling-duration=')) {
      ceilingDurationSeconds = Number(arg.slice('--ceiling-duration='.length));
    } else if (arg === '--repetitions' && i + 1 < argv.length) {
      repetitions = Number(argv[++i]);
    } else if (arg?.startsWith('--repetitions=')) {
      repetitions = Number(arg.slice('--repetitions='.length));
    } else if (arg === '--format' && i + 1 < argv.length) {
      const f = argv[++i];
      if (f === 'json' || f === 'table') format = f;
    } else if (arg?.startsWith('--format=')) {
      const f = arg.slice('--format='.length);
      if (f === 'json' || f === 'table') format = f;
    }
  }

  return {
    urlFile,
    url,
    chromePath,
    outputJsonPath,
    durationSeconds,
    warmupSeconds,
    ceilingDurationSeconds,
    repetitions,
    format,
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
      console.error(
        `Benchmark failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    });
}
