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
      if (
        !pending ||
        !m ||
        m.protocol !== OTIO_PCM_PROTOCOL ||
        m.generation !== this.generation ||
        m.requestId !== pending.id ||
        m.streamId !== pending.streamId
      )
        return;
      this.pending = null;
      if (m.kind === 'failed') pending.reject(new Error(m.reason));
      else pending.resolve(m);
    };
    this.worker.onerror = () => {
      this.pending?.reject(new Error('PCM worker failed'));
      this.pending = null;
      this.closed = true;
    };
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
    } catch (error) {
      this.pending = null;
      reject(error);
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
        frameCount <= 0 ||
        firstFrame + frameCount > h.totalFrames ||
        frameCount > Math.floor(h.sampleRate * OTIO_PCM_MAX_HORIZON_SECONDS)
      )
        throw new Error('Invalid PCM frame range');
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
          response.planes.length !== h.channels ||
          response.planes.some(
            (plane) =>
              !(plane instanceof Float32Array) || plane.length !== frameCount
          )
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
    if (!this.closed)
      this.worker.postMessage({
        protocol: OTIO_PCM_PROTOCOL,
        kind: 'cancel',
        generation: this.generation,
        streamId,
      } satisfies PcmWorkerRequest);
  }
  dispose(): void {
    this.closed = true;
    this.worker.terminate();
    this.pending?.reject(new Error('PCM provider disposed'));
    this.pending = null;
    for (const bytes of this.allocations.values())
      this.budget.releaseBytes(bytes);
    this.allocations.clear();
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
export class OtioPcmScheduler {
  private readonly sources = new Set<{
    source: AudioBufferSourceNode;
    nodes: AudioNode[];
    bytes: number;
  }>();
  private closed = false;
  constructor(
    readonly context: AudioContext,
    readonly masterGain: AudioNode,
    readonly generation: number,
    readonly budget = new OtioPcmBudget()
  ) {}
  schedule(request: OtioPcmScheduleRequest): number {
    const { firstContextFrame, planes, gainFactors } = request;
    const count = planes[0]?.length ?? 0,
      rate = this.context.sampleRate;
    if (
      this.closed ||
      request.generation !== this.generation ||
      !Number.isSafeInteger(firstContextFrame) ||
      firstContextFrame < Math.ceil(this.context.currentTime * rate) ||
      count <= 0 ||
      count > Math.floor(rate * OTIO_PCM_MAX_HORIZON_SECONDS) ||
      planes.length < 1 ||
      planes.length > 2 ||
      planes.some((p) => !(p instanceof Float32Array) || p.length !== count)
    )
      throw new Error('Invalid or late PCM scheduling request');
    if (
      firstContextFrame + count >
      Math.floor(
        (this.context.currentTime + OTIO_PCM_MAX_HORIZON_SECONDS) * rate
      )
    )
      throw new Error('PCM scheduling horizon exceeded');
    for (const f of gainFactors)
      if (
        ![f.startFrame, f.endFrame, f.startGain, f.endGain].every(
          Number.isFinite
        ) ||
        f.endFrame <= f.startFrame ||
        f.startGain < 0 ||
        f.endGain < 0
      )
        throw new Error('Invalid PCM gain factor');
    const bytes = count * planes.length * 4;
    this.budget.reserveNodes(1 + gainFactors.length);
    try {
      this.budget.reserveBytes(bytes);
    } catch (error) {
      this.budget.releaseNodes(1 + gainFactors.length);
      throw error;
    }
    let source: AudioBufferSourceNode | undefined;
    const nodes: AudioNode[] = [];
    try {
      const buffer = this.context.createBuffer(planes.length, count, rate);
      planes.forEach((plane, channel) => buffer.copyToChannel(plane, channel));
      source = this.context.createBufferSource();
      source.buffer = buffer;
      let previous: AudioNode = source;
      for (const factor of gainFactors) {
        const gain = this.context.createGain();
        nodes.push(gain);
        previous.connect(gain);
        previous = gain;
        const valueAtStart =
          factor.startGain +
          (factor.endGain - factor.startGain) *
            Math.max(
              0,
              Math.min(
                1,
                (firstContextFrame - factor.startFrame) /
                  (factor.endFrame - factor.startFrame)
              )
            );
        gain.gain.setValueAtTime(valueAtStart, firstContextFrame / rate);
        if (
          factor.endFrame > firstContextFrame &&
          factor.startFrame < firstContextFrame + count
        ) {
          if (factor.startFrame > firstContextFrame)
            gain.gain.setValueAtTime(
              factor.startGain,
              factor.startFrame / rate
            );
          gain.gain.linearRampToValueAtTime(
            factor.endGain,
            factor.endFrame / rate
          );
        }
      }
      previous.connect(request.destination ?? this.masterGain);
      const owned = { source, nodes, bytes };
      if (
        firstContextFrame <
        Math.ceil(this.context.currentTime * rate) + OTIO_PCM_MIN_LEAD_FRAMES
      )
        throw new Error('PCM scheduling deadline missed');
      source.start(firstContextFrame / rate);
      this.sources.add(owned);
      source.onended = () => this.release(owned);
      return firstContextFrame + count;
    } catch (error) {
      source?.disconnect();
      for (const node of nodes) node.disconnect();
      this.budget.releaseBytes(bytes);
      this.budget.releaseNodes(1 + gainFactors.length);
      throw error;
    }
  }
  private release(owned: {
    source: AudioBufferSourceNode;
    nodes: AudioNode[];
    bytes: number;
  }): void {
    if (!this.sources.delete(owned)) return;
    owned.source.onended = null;
    owned.source.disconnect();
    for (const node of owned.nodes) node.disconnect();
    this.budget.releaseBytes(owned.bytes);
    this.budget.releaseNodes(1 + owned.nodes.length);
  }
  cancel(): void {
    for (const owned of this.sources) {
      try {
        owned.source.stop();
      } catch {}
      this.release(owned);
    }
    this.closed = true;
  }
  dispose(): void {
    this.cancel();
  }
}
