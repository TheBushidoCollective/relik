import type {
  OtioVideoTiming,
  OtioVideoTimingReason,
} from './otio-video-timing.ts';

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAX_QUEUED_JOBS = 16;

const TIMING_REASONS: Record<OtioVideoTimingReason, true> = {
  'file-too-large': true,
  'unsupported-container': true,
  'ambiguous-video-track': true,
  'unsupported-edit-list': true,
  'edit-window-mismatch': true,
  'demux-warning': true,
  'read-budget': true,
  'packet-budget': true,
  'index-budget': true,
  'invalid-packet-timing': true,
  'unknown-duration': true,
  timeout: true,
  cancelled: true,
  'worker-unavailable': true,
  'worker-budget': true,
};

type WorkerMessageListener = (event: MessageEvent<unknown>) => void;
type WorkerErrorListener = (event: Event) => void;

export interface OtioVideoTimingWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', listener: WorkerMessageListener): void;
  addEventListener(type: 'error' | 'messageerror', listener: WorkerErrorListener): void;
  removeEventListener(type: 'message', listener: WorkerMessageListener): void;
  removeEventListener(
    type: 'error' | 'messageerror',
    listener: WorkerErrorListener
  ): void;
}

export interface OtioVideoTimingScheduler {
  read(
    blob: Blob,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<OtioVideoTiming>;
  dispose(): void;
}

/** Test-only construction seam. It is intentionally not re-exported by the bridge. */
export interface OtioVideoTimingSchedulerOptions {
  readonly createWorker: () => OtioVideoTimingWorkerLike;
  readonly deadlineMs?: number;
  readonly maxQueuedJobs?: number;
}

type JobState = 'queued' | 'active' | 'finished';

interface Job {
  readonly id: number;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (timing: OtioVideoTiming) => void;
  abort: () => void;
  state: JobState;
  worker: OtioVideoTimingWorkerLike | undefined;
  clearDeadline: () => void;
  onMessage: WorkerMessageListener | undefined;
  onError: WorkerErrorListener | undefined;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  return (
    Promise as PromiseConstructor & {
      withResolvers<Result>(): Deferred<Result>;
    }
  ).withResolvers<Value>();
}

function unknown(reason: OtioVideoTimingReason): OtioVideoTiming {
  return { kind: 'unknown', reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCertifiedWindows(value: unknown): value is Extract<
  OtioVideoTiming,
  { kind: 'windows' }
> {
  if (!isObject(value) || value.kind !== 'windows') return false;
  if (
    !(value.starts instanceof Float64Array) ||
    !(value.ends instanceof Float64Array) ||
    value.starts.length !== value.ends.length ||
    value.starts.length === 0
  ) {
    return false;
  }

  let previousEnd = -Infinity;
  for (let index = 0; index < value.starts.length; index += 1) {
    const start = value.starts[index];
    const end = value.ends[index];
    if (
      start === undefined ||
      end === undefined ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !(start < end) ||
      start < previousEnd
    ) {
      return false;
    }
    previousEnd = end;
  }

  return true;
}

function decodeWorkerTiming(value: unknown): OtioVideoTiming {
  if (!isObject(value)) return unknown('invalid-packet-timing');
  if (isCertifiedWindows(value)) return value;
  if (
    value.kind === 'unknown' &&
    typeof value.reason === 'string' &&
    TIMING_REASONS[value.reason as OtioVideoTimingReason] === true
  ) {
    return unknown(value.reason as OtioVideoTimingReason);
  }
  return unknown('invalid-packet-timing');
}

function isResultFor(
  value: unknown,
  id: number
): value is { readonly type: 'result'; readonly id: number; readonly timing: unknown } {
  return (
    isObject(value) &&
    value.type === 'result' &&
    typeof value.id === 'number' &&
    value.id === id &&
    'timing' in value
  );
}

/**
 * A one-worker scheduler. Each active file gets its own worker realm so the
 * Mediabunny global warning logger cannot cross-contaminate another scan.
 */
export function createOtioVideoTimingScheduler(
  options: OtioVideoTimingSchedulerOptions
): OtioVideoTimingScheduler {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxQueuedJobs = options.maxQueuedJobs ?? DEFAULT_MAX_QUEUED_JOBS;

  let disposed = false;
  let nextId = 1;
  let active: Job | undefined;
  const queued: Job[] = [];

  function removeAbortListener(job: Job): void {
    job.signal?.removeEventListener('abort', job.abort);
  }

  function settleQueued(job: Job, timing: OtioVideoTiming): void {
    if (job.state === 'finished') return;
    job.state = 'finished';
    removeAbortListener(job);
    job.resolve(timing);
  }

  function detachWorker(job: Job): void {
    const worker = job.worker;
    if (!worker) return;
    if (job.onMessage) worker.removeEventListener('message', job.onMessage);
    if (job.onError) {
      worker.removeEventListener('error', job.onError);
      worker.removeEventListener('messageerror', job.onError);
    }
    try {
      worker.terminate();
    } catch {
      // Termination is best effort after a result, error, timeout, or abort.
    }
    job.worker = undefined;
    job.onMessage = undefined;
    job.onError = undefined;
  }

  function startNext(): void {
    if (active || disposed) return;
    const next = queued.shift();
    if (!next) return;
    if (next.signal?.aborted) {
      settleQueued(next, unknown('cancelled'));
      startNext();
      return;
    }
    start(next);
  }

  function settleActive(job: Job, timing: OtioVideoTiming): void {
    if (job.state !== 'active' || active !== job) return;
    job.state = 'finished';
    job.clearDeadline();
    job.clearDeadline = () => {};
    detachWorker(job);
    removeAbortListener(job);
    active = undefined;
    job.resolve(timing);
    startNext();
  }

  function start(job: Job): void {
    if (disposed) {
      settleQueued(job, unknown('cancelled'));
      return;
    }

    let worker: OtioVideoTimingWorkerLike;
    try {
      worker = options.createWorker();
    } catch {
      settleQueued(job, unknown('worker-unavailable'));
      startNext();
      return;
    }

    job.state = 'active';
    job.worker = worker;
    active = job;
    job.onMessage = (event) => {
      if (!isResultFor(event.data, job.id)) return;
      settleActive(
        job,
        job.signal?.aborted
          ? unknown('cancelled')
          : decodeWorkerTiming(event.data.timing)
      );
    };
    job.onError = () => {
      settleActive(job, unknown('unsupported-container'));
    };

    try {
      worker.addEventListener('message', job.onMessage);
      worker.addEventListener('error', job.onError);
      worker.addEventListener('messageerror', job.onError);
      const timeout = setTimeout(() => {
        settleActive(job, unknown('timeout'));
      }, deadlineMs);
      job.clearDeadline = () => clearTimeout(timeout);
      worker.postMessage({
        type: 'scan',
        id: job.id,
        blob: job.blob,
        mimeType: job.mimeType,
      });
    } catch {
      settleActive(job, unknown('worker-unavailable'));
    }
  }

  function abort(job: Job): void {
    if (job.state === 'finished') return;
    if (job.state === 'active') {
      settleActive(job, unknown('cancelled'));
      return;
    }
    const index = queued.indexOf(job);
    if (index >= 0) queued.splice(index, 1);
    settleQueued(job, unknown('cancelled'));
  }

  return {
    read(
      blob: Blob,
      mimeType: string,
      signal?: AbortSignal
    ): Promise<OtioVideoTiming> {
      if (disposed || signal?.aborted) {
        return Promise.resolve(unknown('cancelled'));
      }
      if (active && queued.length >= maxQueuedJobs) {
        return Promise.resolve(unknown('worker-budget'));
      }

      const { promise, resolve } = deferred<OtioVideoTiming>();
      const job: Job = {
        id: nextId,
        blob,
        mimeType,
        signal,
        resolve,
        abort: () => {},
        state: 'queued',
        worker: undefined,
        clearDeadline: () => {},
        onMessage: undefined,
        onError: undefined,
      };
      nextId += 1;
      job.abort = () => abort(job);
      signal?.addEventListener('abort', job.abort, { once: true });

      if (active) {
        queued.push(job);
      } else {
        start(job);
      }
      return promise;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (active) settleActive(active, unknown('cancelled'));
      while (queued.length > 0) {
        const job = queued.shift();
        if (job) settleQueued(job, unknown('cancelled'));
      }
    },
  };
}
