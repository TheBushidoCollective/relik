import {
  createOtioVideoTimingScheduler,
  type OtioVideoTimingScheduler,
  type OtioVideoTimingWorkerLike,
} from './otio-video-timing-scheduler.ts';

export type OtioVideoTimingReason =
  | 'file-too-large'
  | 'unsupported-container'
  | 'ambiguous-video-track'
  | 'unsupported-edit-list'
  | 'edit-window-mismatch'
  | 'demux-warning'
  | 'read-budget'
  | 'packet-budget'
  | 'index-budget'
  | 'invalid-packet-timing'
  | 'unknown-duration'
  | 'timeout'
  | 'cancelled'
  | 'worker-unavailable'
  | 'worker-budget';

export type OtioVideoTiming =
  | {
      readonly kind: 'windows';
      readonly starts: Float64Array;
      readonly ends: Float64Array;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: OtioVideoTimingReason;
    };

const OTIO_VIDEO_TIMING_WORKER_URL = '/assets/otio-video-timing-worker.js';

let defaultScheduler: OtioVideoTimingScheduler | undefined;

function unknown(reason: OtioVideoTimingReason): OtioVideoTiming {
  return { kind: 'unknown', reason };
}

function browserWorkerFactory(): OtioVideoTimingWorkerLike {
  return new Worker(OTIO_VIDEO_TIMING_WORKER_URL, {
    type: 'module',
  }) as unknown as OtioVideoTimingWorkerLike;
}

function scheduler(): OtioVideoTimingScheduler {
  defaultScheduler ??= createOtioVideoTimingScheduler({
    createWorker: browserWorkerFactory,
  });
  return defaultScheduler;
}

/**
 * Reads certified packet-presentation windows for one local OTIO media Blob.
 *
 * The bridge intentionally has no demuxer import and constructs no Worker until
 * this function is called. The explicit worker asset is built separately from
 * the eager viewer shell.
 */
export function readOtioVideoTiming(
  blob: Blob,
  mimeType: string,
  signal?: AbortSignal
): Promise<OtioVideoTiming> {
  if (signal?.aborted) return Promise.resolve(unknown('cancelled'));
  if (typeof Worker === 'undefined') {
    return Promise.resolve(unknown('worker-unavailable'));
  }

  return scheduler().read(blob, mimeType, signal);
}
