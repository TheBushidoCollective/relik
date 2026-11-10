import {
  OTIO_PCM_MAX_BYTES,
  OTIO_PCM_MAX_HORIZON_SECONDS,
  OTIO_PCM_MAX_NODES,
  OTIO_PCM_MAX_STREAMS,
  OTIO_PCM_MIN_LEAD_FRAMES,
  OTIO_PCM_PULL_SCRATCH_BYTES,
  OTIO_PCM_PROTOCOL,
  type PcmWorkerRequest,
  type PcmWorkerResponse,
} from './otio-audio-pcm-protocol';
import type { WavePcmHeader } from './otio-wave-pcm';

/** Shared across the worker bridge and audio graph for one controller. */
export class OtioPcmBudget {
  private bytes = 0;
  private nodes = 0;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    const subscription = () => listener();
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }
  private notifyRelease(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (this.listeners.has(listener)) listener();
      });
    }
  }
  reserveBytes(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > OTIO_PCM_MAX_BYTES
    )
      throw new Error('PCM byte budget exceeded');
    this.bytes += bytes;
  }
  releaseBytes(bytes: number): void {
    this.bytes -= bytes;
    if (bytes > 0) this.notifyRelease();
  }
  reserveNodes(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      this.nodes + count > OTIO_PCM_MAX_NODES
    )
      throw new Error('PCM graph node limit exceeded');
    this.nodes += count;
  }
  releaseNodes(count: number): void {
    this.nodes -= count;
    if (count > 0) this.notifyRelease();
  }
  get usedBytes(): number {
    return this.bytes;
  }
  get usedNodes(): number {
    return this.nodes;
  }
}

export interface OtioPcmBlock {
  firstFrame: number;
  frameCount: number;
  planes: Float32Array[];
}
export class OtioPcmProvider {
  private readonly worker: Worker;
  private readonly headers = new Map<string, WavePcmHeader>();
  private readonly versions = new Map<string, number>();
  private readonly allocations = new Map<Float32Array[], number>();
  private serial: Promise<unknown> = Promise.resolve();
  private pending: {
    id: number;
    streamId: string;
    resolve: (message: PcmWorkerResponse) => void;
    reject: (error: Error) => void;
  } | null = null;
  private nextId = 1;
  private closed = false;
  constructor(
    readonly generation: number,
    readonly budget = new OtioPcmBudget(),
    worker?: Worker
  ) {
    this.worker =
      worker ??
      new Worker('/assets/otio-audio-pcm-worker.js', { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PcmWorkerResponse>) => {
      const m = event.data,
        pending = this.pending;
      if (!pending) return;
      // Ignore unrelated stale messages, but reject a malformed matching response.
      if (!m || typeof m !== 'object') {
        this.fail('Invalid PCM worker response');
        return;
      }
      if (m.requestId !== pending.id) return;
      if (
        Number.isSafeInteger(m.generation) &&
        m.generation !== this.generation
      )
        return;
      if (
        m.generation !== this.generation ||
        m.protocol !== OTIO_PCM_PROTOCOL ||
        m.streamId !== pending.streamId ||
        !['ready', 'pcm', 'eos', 'failed'].includes(m.kind) ||
        (m.kind === 'failed' && typeof m.reason !== 'string')
      ) {
        this.fail('Invalid PCM worker response');
        return;
      }
      this.pending = null;
      if (m.kind === 'failed') pending.reject(new Error(m.reason));
      else pending.resolve(m);
    };
    this.worker.onerror = () => this.fail('PCM worker failed');
    this.worker.onmessageerror = () => this.fail('PCM worker message error');
  }
  private fail(reason: string): void {
    if (!this.closed) this.worker.terminate();
    this.closed = true;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(reason));
  }
  private enqueue<T>(
    streamId: string,
    operation: (version: number) => Promise<T>
  ): Promise<T> {
    const version = this.versions.get(streamId) ?? 0;
    const result = this.serial.then(() => {
      if (this.closed || (this.versions.get(streamId) ?? 0) !== version)
        throw new Error('PCM stream cancelled');
      return operation(version);
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  private request(
    message: PcmWorkerRequest & { requestId: number }
  ): Promise<PcmWorkerResponse> {
    const { promise, resolve, reject } =
      Promise.withResolvers<PcmWorkerResponse>();
    this.pending = {
      id: message.requestId,
      streamId: message.streamId,
      resolve,
      reject,
    };
    try {
      this.worker.postMessage(message);
    } catch {
      this.fail('PCM worker post failed');
    }
    return promise;
  }
  open(streamId: string, blob: Blob, header: WavePcmHeader): Promise<void> {
    return this.enqueue(streamId, async (version) => {
      if (
        !streamId ||
        this.headers.has(streamId) ||
        this.headers.size >= OTIO_PCM_MAX_STREAMS
      )
        throw new Error('Invalid PCM stream');
      const scratch = 256 * 1024;
      this.budget.reserveBytes(scratch);
      try {
        const response = await this.request({
          protocol: OTIO_PCM_PROTOCOL,
          kind: 'open',
          generation: this.generation,
          streamId,
          requestId: this.nextId++,
          blob,
          header,
        });
        if ((this.versions.get(streamId) ?? 0) !== version || this.closed)
          throw new Error('PCM stream cancelled');
        if (
          response.kind !== 'ready' ||
          JSON.stringify(response.header) !== JSON.stringify(header)
        )
          throw new Error('Invalid PCM worker readiness');
        this.headers.set(streamId, header);
      } finally {
        this.budget.releaseBytes(scratch);
      }
    });
  }
  pull(
    streamId: string,
    firstFrame: number,
    frameCount: number
  ): Promise<OtioPcmBlock> {
    return this.enqueue(streamId, async (version) => {
      const h = this.headers.get(streamId);
      if (
        !h ||
        !Number.isSafeInteger(firstFrame) ||
        !Number.isSafeInteger(frameCount) ||
        firstFrame < 0 ||
        frameCount < 0 ||
        firstFrame + frameCount > h.totalFrames ||
        frameCount > Math.floor(h.sampleRate * OTIO_PCM_MAX_HORIZON_SECONDS)
      )
        throw new Error('Invalid PCM frame range');
      if (frameCount === 0) return { firstFrame, frameCount, planes: [] };
      const bytes = frameCount * h.channels * 4;
      // Covers bridged reads, packet assembly and transient conversion copies.
      const scratch = OTIO_PCM_PULL_SCRATCH_BYTES;
      this.budget.reserveBytes(bytes + scratch);
      let retained = false;
      try {
        const response = await this.request({
          protocol: OTIO_PCM_PROTOCOL,
          kind: 'pull',
          generation: this.generation,
          streamId,
          requestId: this.nextId++,
          firstFrame,
          frameCount,
        });
        if ((this.versions.get(streamId) ?? 0) !== version || this.closed)
          throw new Error('PCM stream cancelled');
        if (
          response.kind !== 'pcm' ||
          response.firstFrame !== firstFrame ||
          response.frameCount !== frameCount ||
          !Array.isArray(response.planes) ||
          response.planes.length !== h.channels ||
          response.planes.some(
            (plane) =>
              !(plane instanceof Float32Array) ||
              plane.length !== frameCount ||
              !(plane.buffer instanceof ArrayBuffer) ||
              plane.byteOffset !== 0 ||
              plane.buffer.byteLength !== plane.byteLength ||
              plane.some((sample) => !Number.isFinite(sample))
          ) ||
          new Set(response.planes.map((plane) => plane.buffer)).size !==
            h.channels
        )
          throw new Error('Invalid PCM worker response');
        this.allocations.set(response.planes, bytes);
        retained = true;
        return { firstFrame, frameCount, planes: response.planes };
      } finally {
        this.budget.releaseBytes(scratch + (retained ? 0 : bytes));
      }
    });
  }
  release(planes: Float32Array[]): void {
    const bytes = this.allocations.get(planes);
    if (bytes !== undefined) {
      this.allocations.delete(planes);
      this.budget.releaseBytes(bytes);
    }
  }
  cancel(streamId: string): void {
    this.versions.set(streamId, (this.versions.get(streamId) ?? 0) + 1);
    this.headers.delete(streamId);
    if (this.pending) {
      this.fail('PCM stream cancelled');
    } else if (!this.closed) {
      try {
        this.worker.postMessage({
          protocol: OTIO_PCM_PROTOCOL,
          kind: 'cancel',
          generation: this.generation,
          streamId,
        } satisfies PcmWorkerRequest);
      } catch {
        this.fail('PCM worker post failed');
      }
    }
  }
  dispose(): void {
    this.fail('PCM provider disposed');
    this.headers.clear();
  }
}

export interface OtioPcmGainFactor {
  startFrame: number;
  endFrame: number;
  startGain: number;
  endGain: number;
}
export interface OtioPcmScheduleRequest {
  generation: number;
  firstContextFrame: number;
  planes: Float32Array[];
  gainFactors: readonly OtioPcmGainFactor[];
  destination?: AudioNode;
}
interface PcmOwnedSource {
  source: AudioBufferSourceNode;
  nodes: GainNode[];
  bytes: number;
  started: boolean;
  firstFrame: number;
  naturalEnd: number;
}

export interface OtioPcmPrepared {
  start(
    firstContextFrame: number,
    gainFactors: readonly OtioPcmGainFactor[]
  ): number;
  cancel(): void;
}

export class OtioPcmScheduler {
  private readonly sources = new Set<PcmOwnedSource>();
  private closed = false;
  private drain: {
    frame: number;
    ended: Promise<void>;
    resolve: () => void;
  } | null = null;
  constructor(
    readonly context: AudioContext,
    readonly masterGain: AudioNode,
    readonly generation: number,
    readonly budget = new OtioPcmBudget()
  ) {}

  prepare(request: {
    generation: number;
    planes: Float32Array[];
    gainFactorCount: number;
    destination?: AudioNode;
  }): OtioPcmPrepared {
    const { planes, gainFactorCount } = request;
    const count = planes[0]?.length ?? 0,
      rate = this.context.sampleRate;
    if (
      this.closed ||
      request.generation !== this.generation ||
      !Number.isSafeInteger(gainFactorCount) ||
      gainFactorCount < 0 ||
      count <= 0 ||
      count > Math.floor(rate * OTIO_PCM_MAX_HORIZON_SECONDS) ||
      planes.length < 1 ||
      planes.length > 2 ||
      planes.some(
        (p) =>
          !(p instanceof Float32Array) ||
          !(p.buffer instanceof ArrayBuffer) ||
          p.length !== count ||
          p.some((value) => !Number.isFinite(value))
      )
    )
      throw new Error('Invalid PCM preparation request');
    const bytes = count * planes.length * 4;
    this.budget.reserveNodes(1 + gainFactorCount);
    try {
      this.budget.reserveBytes(bytes);
    } catch (error) {
      this.budget.releaseNodes(1 + gainFactorCount);
      throw error;
    }
    let source: AudioBufferSourceNode | undefined;
    const nodes: GainNode[] = [];
    let owned: PcmOwnedSource;
    try {
      const buffer = this.context.createBuffer(planes.length, count, rate);
      planes.forEach((plane, channel) => {
        buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, channel);
      });
      source = this.context.createBufferSource();
      source.buffer = buffer;
      let previous: AudioNode = source;
      for (let i = 0; i < gainFactorCount; i++) {
        const gain = this.context.createGain();
        nodes.push(gain);
        previous.connect(gain);
        previous = gain;
      }
      previous.connect(request.destination ?? this.masterGain);
      owned = {
        source,
        nodes,
        bytes,
        started: false,
        firstFrame: 0,
        naturalEnd: 0,
      };
      this.sources.add(owned);
      source.onended = () => this.release(owned);
    } catch (error) {
      source?.disconnect();
      for (const node of nodes) node.disconnect();
      this.budget.releaseBytes(bytes);
      this.budget.releaseNodes(1 + gainFactorCount);
      throw error;
    }
    return {
      start: (firstContextFrame, factors) => {
        if (!this.sources.has(owned) || owned.started || this.closed)
          throw new Error('PCM prepared source is closed');
        try {
          if (
            !Number.isSafeInteger(firstContextFrame) ||
            firstContextFrame <
              Math.ceil(this.context.currentTime * rate) +
                OTIO_PCM_MIN_LEAD_FRAMES
          )
            throw new Error('PCM scheduling deadline missed');
          if (
            firstContextFrame + count >
            Math.floor(
              (this.context.currentTime + OTIO_PCM_MAX_HORIZON_SECONDS) * rate
            )
          )
            throw new Error('PCM scheduling horizon exceeded');
          if (factors.length !== nodes.length)
            throw new Error('Invalid PCM gain factor count');
          factors.forEach((factor, i) => {
            if (
              ![
                factor.startFrame,
                factor.endFrame,
                factor.startGain,
                factor.endGain,
              ].every(Number.isFinite) ||
              factor.endFrame <= factor.startFrame ||
              factor.startGain < 0 ||
              factor.endGain < 0
            )
              throw new Error('Invalid PCM gain factor');
            const gain = nodes[i]!.gain;
            const fraction = Math.max(
              0,
              Math.min(
                1,
                (firstContextFrame - factor.startFrame) /
                  (factor.endFrame - factor.startFrame)
              )
            );
            const initialGain =
              factor.startGain + (factor.endGain - factor.startGain) * fraction;
            // A frame/rate timestamp can round just above the frame boundary.
            // Keep the node's pre-automation value correct at that boundary too.
            gain.value = initialGain;
            gain.setValueAtTime(initialGain, firstContextFrame / rate);
            if (
              factor.endFrame > firstContextFrame &&
              factor.startFrame < firstContextFrame + count
            ) {
              if (factor.startFrame > firstContextFrame)
                gain.setValueAtTime(factor.startGain, factor.startFrame / rate);
              gain.linearRampToValueAtTime(
                factor.endGain,
                factor.endFrame / rate
              );
            }
          });
          if (
            firstContextFrame <
            Math.ceil(this.context.currentTime * rate) +
              OTIO_PCM_MIN_LEAD_FRAMES
          )
            throw new Error('PCM scheduling deadline missed');
          owned.firstFrame = firstContextFrame;
          owned.naturalEnd = firstContextFrame + count;
          owned.started = true;
          try {
            owned.source.start(firstContextFrame / rate);
          } catch (error) {
            owned.started = false;
            throw error;
          }
          return owned.naturalEnd;
        } catch (error) {
          if (!owned.started) this.release(owned);
          throw error;
        }
      },
      cancel: () => {
        if (!this.sources.has(owned)) return;
        if (!owned.started) this.release(owned);
        else {
          try {
            owned.source.stop();
          } catch {}
        }
      },
    };
  }

  schedule(request: OtioPcmScheduleRequest): number {
    return this.prepare({
      generation: request.generation,
      planes: request.planes,
      gainFactorCount: request.gainFactors.length,
      ...(request.destination ? { destination: request.destination } : {}),
    }).start(request.firstContextFrame, request.gainFactors);
  }

  private release(owned: PcmOwnedSource): void {
    if (!this.sources.delete(owned)) return;
    owned.source.onended = null;
    owned.source.disconnect();
    for (const node of owned.nodes) node.disconnect();
    this.budget.releaseBytes(owned.bytes);
    this.budget.releaseNodes(1 + owned.nodes.length);
    if (this.sources.size === 0) this.drain?.resolve();
  }

  stopAtFrame(frame: number): { frame: number; ended: Promise<void> } {
    if (this.drain) {
      if (this.drain.frame !== frame)
        throw new Error('Conflicting PCM stop frame');
      return this.drain;
    }
    const rate = this.context.sampleRate;
    if (
      this.closed ||
      !Number.isSafeInteger(frame) ||
      frame <
        Math.ceil(this.context.currentTime * rate) + OTIO_PCM_MIN_LEAD_FRAMES
    )
      throw new Error('PCM stop deadline missed');
    this.closed = true;
    try {
      for (const owned of this.sources) {
        if (!owned.started) {
          this.release(owned);
          continue;
        }
        if (
          frame <
          Math.ceil(this.context.currentTime * rate) + OTIO_PCM_MIN_LEAD_FRAMES
        )
          throw new Error('PCM stop deadline missed');
        if (frame < owned.naturalEnd) owned.source.stop(frame / rate);
      }
    } catch (error) {
      this.cancel();
      throw error;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.drain = { frame, ended: promise, resolve };
    if (this.sources.size === 0) resolve();
    return this.drain;
  }

  cancel(): void {
    this.closed = true;
    for (const owned of this.sources) {
      if (!owned.started) this.release(owned);
      else {
        try {
          owned.source.stop();
        } catch {}
      }
    }
  }
  dispose(): void {
    this.cancel();
  }
}
