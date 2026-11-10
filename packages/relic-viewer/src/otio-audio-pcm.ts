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
        !['ready', 'pcm', 'closed', 'eos', 'failed'].includes(m.kind) ||
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
  close(streamId: string): Promise<void> {
    if (!streamId) return Promise.reject(new Error('Invalid PCM stream'));
    if (this.closed) {
      this.headers.delete(streamId);
      return Promise.resolve();
    }
    return this.enqueue(streamId, async () => {
      this.headers.delete(streamId);
      const requestId = this.nextId++;
      const response = await this.request({
        protocol: OTIO_PCM_PROTOCOL,
        kind: 'close',
        generation: this.generation,
        streamId,
        requestId,
      });
      if (response.kind !== 'closed')
        throw new Error('Invalid PCM worker close response');
    });
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
  charge: PcmByteCharge;
  started: boolean;
  firstFrame: number;
  naturalEnd: number;
}

export interface OtioPcmPrepared {
  start(
    firstContextFrame: number,
    gainFactors: readonly OtioPcmGainFactor[]
  ): number;
  /**
   * Makes this source's retained block permanent: retirement will then free it
   * once no source or unstarted descriptor still holds it. commit() does not
   * remove a block. Throws if the source retained nothing or its retention is
   * gone. Idempotent.
   */
  commit(): void;
  /**
   * Stops or releases the source. If it retained PCM that was never committed,
   * that uncommitted block and its byte charge are removed. Committed retention
   * is untouched.
   */
  cancel(): void;
}

/** Frames copied exactly at one composition boundary by restage. */
export const OTIO_PCM_BOUNDARY_COPY_FRAMES = 4096;

/**
 * Byte credit held by a set of holders. A source holds its buffer while it is
 * audible, and a ledger holds it while it is retained. The bytes are freed only
 * when no holder remains, so a superseded holder's late release changes nothing
 * it no longer holds.
 */
class PcmByteCharge {
  private readonly holders = new Set<object>();
  private held: number;

  constructor(
    private readonly budget: OtioPcmBudget,
    bytes: number,
    owner: object
  ) {
    this.holders.add(owner);
    this.held = bytes;
  }

  /** Adds a holder to a charge that is still held. */
  add(holder: object): void {
    if (this.holders.size === 0)
      throw new Error('PCM byte charge already released');
    this.holders.add(holder);
  }

  /** Replaces one holder with another without changing the charged bytes. */
  move(from: object, to: object): void {
    if (!this.holders.has(from))
      throw new Error('PCM byte charge owner mismatch');
    this.holders.delete(from);
    this.holders.add(to);
  }

  /** The ledger currently holding this charge, if any. */
  get ledgerHolder(): OtioPcmLedger | undefined {
    for (const holder of this.holders)
      if (holder instanceof OtioPcmLedger) return holder;
    return undefined;
  }

  release(by: object): void {
    if (!this.holders.delete(by) || this.holders.size > 0) return;
    const bytes = this.held;
    this.held = 0;
    this.budget.releaseBytes(bytes);
  }
}

interface RetainedPcm {
  readonly start: number;
  readonly end: number;
  readonly buffer: AudioBuffer;
  readonly charge: PcmByteCharge;
  committed: boolean;
}

interface RetainedLane {
  blocks: RetainedPcm[];
  channels: number;
}

function blocksOverlap(
  blocks: readonly RetainedPcm[],
  start: number,
  end: number
): boolean {
  return blocks.some((block) => start < block.end && block.start < end);
}

/**
 * Decoded PCM kept per ledger key and composition frame. A key is one plan
 * occurrence: overlap is rejected only within a key, so distinct plans may share
 * composition frames. Blocks outlive the sources that played them, so a
 * successor restages from audio already decoded rather than decoding it again.
 * Each block's byte charge is shared with any source playing the same buffer,
 * and is freed only when the last holder releases it.
 */
class OtioPcmLedger {
  private lanes = new Map<string, RetainedLane>();
  private closed = false;

  get released(): boolean {
    return this.closed;
  }

  channelCount(ledgerKey: string): number {
    return this.lanes.get(ledgerKey)?.channels ?? 0;
  }

  retain(
    ledgerKey: string,
    start: number,
    buffer: AudioBuffer,
    charge: PcmByteCharge
  ): void {
    const count = buffer.length;
    const channels = buffer.numberOfChannels;
    const end = start + count;
    const existing = this.lanes.get(ledgerKey);
    if (
      this.closed ||
      ledgerKey === '' ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(end) ||
      count <= 0 ||
      channels < 1 ||
      channels > 2 ||
      (existing !== undefined && channels !== existing.channels) ||
      (existing !== undefined && blocksOverlap(existing.blocks, start, end))
    )
      throw new Error('Invalid PCM ledger block');
    charge.add(this);
    const lane = existing ?? { blocks: [], channels };
    const at = lane.blocks.findIndex((other) => other.start > start);
    lane.blocks.splice(at === -1 ? lane.blocks.length : at, 0, {
      start,
      end,
      buffer,
      charge,
      committed: false,
    });
    this.lanes.set(ledgerKey, lane);
  }

  /** Exclusive end of contiguous retained coverage for a key, from `from`. */
  coveredThrough(ledgerKey: string, from: number): number {
    const lane = this.lanes.get(ledgerKey);
    if (this.closed || lane === undefined) return from;
    let cursor = from;
    for (const block of lane.blocks) {
      if (block.end <= cursor) continue;
      if (block.start > cursor) break;
      cursor = block.end;
    }
    return cursor;
  }

  covers(ledgerKey: string, start: number, end: number): boolean {
    return this.coveredThrough(ledgerKey, start) >= end;
  }

  /** Exact frame-for-frame copy of a window that must be fully retained. */
  copy(ledgerKey: string, start: number, frameCount: number): Float32Array[] {
    if (this.closed) throw new Error('PCM ledger released');
    const lane = this.lanes.get(ledgerKey);
    const end = start + frameCount;
    if (lane === undefined || !this.covers(ledgerKey, start, end))
      throw new Error('PCM ledger coverage short');
    const out = Array.from(
      { length: lane.channels },
      () => new Float32Array(frameCount)
    );
    let cursor = start;
    for (const block of lane.blocks) {
      if (cursor === end) break;
      if (block.end <= cursor) continue;
      const take = Math.min(block.end, end) - cursor;
      const from = cursor - block.start;
      out.forEach((plane, channel) => {
        block.buffer.copyFromChannel(
          plane.subarray(cursor - start, cursor - start + take),
          channel,
          from
        );
      });
      cursor += take;
    }
    return out;
  }

  /** Moves every key's blocks and charges to `next` in one step. */
  handOffTo(next: OtioPcmLedger): void {
    if (this.closed || next.closed)
      throw new Error('PCM ledger handoff on a released ledger');
    for (const [key, lane] of this.lanes) {
      const target = next.lanes.get(key);
      if (target === undefined) continue;
      if (target.channels !== lane.channels)
        throw new Error('PCM ledger channel mismatch');
      for (const block of lane.blocks)
        if (blocksOverlap(target.blocks, block.start, block.end))
          throw new Error('PCM ledger overlap on handoff');
    }
    for (const lane of this.lanes.values())
      for (const block of lane.blocks) block.charge.move(this, next);
    for (const [key, lane] of this.lanes) {
      const target = next.lanes.get(key);
      if (target === undefined) next.lanes.set(key, lane);
      else
        target.blocks = [...target.blocks, ...lane.blocks].sort(
          (a, b) => a.start - b.start
        );
    }
    this.lanes = new Map();
    this.closed = true;
  }

  release(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lane of this.lanes.values())
      for (const block of lane.blocks) block.charge.release(this);
    this.lanes = new Map();
  }

  /**
   * Frees this key's COMMITTED blocks that end at or before `frame`. Uncommitted
   * blocks are skipped; they are withdrawn only by their handle's cancel() or by
   * rollbackRetained(), or when the holding ledger is released.
   */
  retireBefore(ledgerKey: string, frame: number): void {
    const lane = this.lanes.get(ledgerKey);
    if (this.closed || lane === undefined) return;
    const kept: RetainedPcm[] = [];
    for (const block of lane.blocks) {
      if (block.committed && block.end <= frame) block.charge.release(this);
      else kept.push(block);
    }
    lane.blocks = kept;
  }

  /** Makes one retained block permanent. Throws if no such block is retained. */
  commitBlock(ledgerKey: string, start: number): void {
    const block = this.lanes
      .get(ledgerKey)
      ?.blocks.find((candidate) => candidate.start === start);
    if (this.closed || block === undefined)
      throw new Error('PCM block is not retained');
    block.committed = true;
  }

  /**
   * Removes one uncommitted block and releases its charge. Returns false when
   * there is nothing uncommitted to remove, including for a committed block.
   */
  rollbackUncommitted(ledgerKey: string, start: number): boolean {
    const lane = this.lanes.get(ledgerKey);
    if (this.closed || lane === undefined) return false;
    const at = lane.blocks.findIndex(
      (block) => block.start === start && !block.committed
    );
    if (at === -1) return false;
    const [block] = lane.blocks.splice(at, 1);
    block!.charge.release(this);
    return true;
  }
}

export class OtioPcmScheduler {
  private readonly sources = new Set<PcmOwnedSource>();
  private readonly ledger = new OtioPcmLedger();
  private closed = false;
  private retirementNotified = false;
  private drain: {
    frame: number;
    ended: Promise<void>;
    resolve: () => void;
  } | null = null;
  constructor(
    readonly context: AudioContext,
    readonly masterGain: AudioNode,
    readonly generation: number,
    readonly budget = new OtioPcmBudget(),
    readonly onRetired: () => void = () => {}
  ) {}

  private notifyRetired(): void {
    if (this.retirementNotified) return;
    this.retirementNotified = true;
    this.onRetired();
  }

  prepare(request: {
    generation: number;
    planes: Float32Array[];
    gainFactorCount: number;
    destination?: AudioNode;
    /** When set, the decoded planes are retained under this key and range. */
    retain?: { ledgerKey: string; compositionStartFrame: number };
  }): OtioPcmPrepared {
    const { planes, gainFactorCount, retain } = request;
    const count = planes[0]?.length ?? 0,
      rate = this.context.sampleRate;
    if (
      this.closed ||
      request.generation !== this.generation ||
      !Number.isSafeInteger(gainFactorCount) ||
      gainFactorCount < 0 ||
      (retain !== undefined &&
        (retain.ledgerKey === '' ||
          !Number.isSafeInteger(retain.compositionStartFrame) ||
          retain.compositionStartFrame < 0)) ||
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
    this.budget.reserveBytes(bytes);
    return this.admit({
      planes,
      bytes,
      gainFactorCount,
      destination: request.destination,
      retain,
    });
  }

  /**
   * Copies an exact window of one key's retained PCM into an unstarted source
   * owned by `target`. This scheduler may be the predecessor, so a successor can
   * restage from a ledger it has not yet inherited. Throws, with no budget
   * change, if the window is not fully retained or the budgets differ.
   */
  restage(request: {
    target: OtioPcmScheduler;
    generation: number;
    ledgerKey: string;
    compositionStartFrame: number;
    frameCount: number;
    gainFactorCount: number;
    destination?: AudioNode;
  }): OtioPcmPrepared {
    const {
      target,
      ledgerKey,
      compositionStartFrame: start,
      frameCount,
      gainFactorCount,
    } = request;
    if (
      target.closed ||
      request.generation !== target.generation ||
      target.budget !== this.budget ||
      ledgerKey === '' ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(frameCount) ||
      frameCount <= 0 ||
      frameCount > OTIO_PCM_BOUNDARY_COPY_FRAMES ||
      !Number.isSafeInteger(gainFactorCount) ||
      gainFactorCount < 0
    )
      throw new Error('Invalid PCM restage request');
    if (this.ledger.released) throw new Error('PCM ledger released');
    if (!this.ledger.covers(ledgerKey, start, start + frameCount))
      throw new Error('PCM ledger coverage short');
    const bytes = frameCount * this.ledger.channelCount(ledgerKey) * 4;
    this.budget.reserveBytes(bytes);
    let planes: Float32Array[];
    try {
      planes = this.ledger.copy(ledgerKey, start, frameCount);
    } catch (error) {
      this.budget.releaseBytes(bytes);
      throw error;
    }
    return target.admit({
      planes,
      bytes,
      gainFactorCount,
      destination: request.destination,
      retain: undefined,
    });
  }

  /**
   * Moves this scheduler's retained PCM and byte charges, for every ledger key,
   * to `successor`. Requires this scheduler closed by seal or stopAtFrame. Blocks
   * move in whatever state they are: uncommitted blocks stay uncommitted and are
   * withdrawn only through their original handle's cancel(), by rollbackRetained()
   * on the successor, or when the successor's ledger is released. A cancelled
   * ledger is already released and cannot be handed off.
   */
  handOffLedger(successor: OtioPcmScheduler): void {
    if (
      successor === this ||
      successor.closed ||
      successor.generation <= this.generation
    )
      throw new Error('Invalid PCM ledger successor');
    if (!this.closed)
      throw new Error('PCM ledger handoff before predecessor closure');
    this.ledger.handOffTo(successor.ledger);
  }

  /**
   * Closes admission without scheduling a stop. Live sources keep playing to
   * their natural end, and their charges stay owned by whoever holds them.
   */
  seal(): void {
    this.closed = true;
  }

  /**
   * Frees this key's COMMITTED retained PCM that ends at or before
   * `compositionFrame`. Uncommitted blocks are never freed here.
   */
  retireRetainedBefore(ledgerKey: string, compositionFrame: number): void {
    this.ledger.retireBefore(ledgerKey, compositionFrame);
  }

  /** Makes one uncommitted retained block permanent, by key and start frame. */
  commitRetained(ledgerKey: string, startFrame: number): void {
    this.ledger.commitBlock(ledgerKey, startFrame);
  }

  /**
   * Removes one uncommitted retained block and releases its charge, by key and
   * start frame. Returns false when nothing uncommitted is there to remove.
   */
  rollbackRetained(ledgerKey: string, startFrame: number): boolean {
    return this.ledger.rollbackUncommitted(ledgerKey, startFrame);
  }

  /** Exclusive end of contiguous retained PCM for `ledgerKey` from `startFrame`. */
  coveredThrough(ledgerKey: string, startFrame: number): number {
    return this.ledger.coveredThrough(ledgerKey, startFrame);
  }

  /**
   * Builds the audio graph for planes whose bytes were already reserved by the
   * caller. On failure the caller's reservation is returned.
   */
  private admit(args: {
    planes: readonly Float32Array[];
    bytes: number;
    gainFactorCount: number;
    destination: AudioNode | undefined;
    retain: { ledgerKey: string; compositionStartFrame: number } | undefined;
  }): OtioPcmPrepared {
    const { planes, bytes, gainFactorCount, destination } = args;
    const count = planes[0]?.length ?? 0,
      rate = this.context.sampleRate;
    let nodesReserved = false;
    let source: AudioBufferSourceNode | undefined;
    let charge: PcmByteCharge | undefined;
    const nodes: GainNode[] = [];
    let owned: PcmOwnedSource;
    let retainedRef:
      | { ledgerKey: string; start: number; charge: PcmByteCharge }
      | undefined;
    try {
      this.budget.reserveNodes(1 + gainFactorCount);
      nodesReserved = true;
      const buffer = this.context.createBuffer(planes.length, count, rate);
      planes.forEach((plane, channel) => {
        buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, channel);
      });
      source = this.context.createBufferSource();
      source.buffer = buffer;
      charge = new PcmByteCharge(this.budget, bytes, source);
      let previous: AudioNode = source;
      for (let i = 0; i < gainFactorCount; i++) {
        const gain = this.context.createGain();
        nodes.push(gain);
        previous.connect(gain);
        previous = gain;
      }
      previous.connect(destination ?? this.masterGain);
      owned = {
        source,
        nodes,
        charge,
        started: false,
        firstFrame: 0,
        naturalEnd: 0,
      };
      if (args.retain !== undefined) {
        this.ledger.retain(
          args.retain.ledgerKey,
          args.retain.compositionStartFrame,
          buffer,
          charge
        );
        retainedRef = {
          ledgerKey: args.retain.ledgerKey,
          start: args.retain.compositionStartFrame,
          charge,
        };
      }
      this.sources.add(owned);
      const record = owned;
      source.onended = () => this.release(record);
    } catch (error) {
      source?.disconnect();
      for (const node of nodes) node.disconnect();
      if (charge && source) charge.release(source);
      else this.budget.releaseBytes(bytes);
      if (nodesReserved) this.budget.releaseNodes(1 + gainFactorCount);
      throw error;
    }
    return {
      start: (firstContextFrame, factors) => {
        if (!this.sources.has(owned) || owned.started)
          throw new Error('PCM prepared source is closed');
        if (this.closed) {
          // A sealed scheduler never plays this descriptor. Release its nodes and
          // this source's hold; bytes stay charged while a ledger still holds the block.
          this.release(owned);
          throw new Error('PCM prepared source is closed');
        }
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
        if (this.sources.has(owned)) {
          if (!owned.started) this.release(owned);
          else {
            try {
              owned.source.stop();
            } catch {}
          }
        }
        // Uncommitted retention is withdrawn; committed retention stays.
        if (retainedRef !== undefined) {
          const holder = retainedRef.charge.ledgerHolder;
          if (holder !== undefined)
            holder.rollbackUncommitted(
              retainedRef.ledgerKey,
              retainedRef.start
            );
        }
      },
      commit: () => {
        if (retainedRef === undefined)
          throw new Error('PCM prepared source retained no PCM');
        const holder = retainedRef.charge.ledgerHolder;
        if (holder === undefined)
          throw new Error('PCM retained block is released');
        holder.commitBlock(retainedRef.ledgerKey, retainedRef.start);
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
    owned.charge.release(owned.source);
    this.budget.releaseNodes(1 + owned.nodes.length);
    if (this.sources.size === 0) {
      this.drain?.resolve();
      if (this.closed) this.notifyRetired();
    }
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
    if (this.sources.size === 0) {
      resolve();
      this.notifyRetired();
    }
    return this.drain;
  }

  cancel(): void {
    this.closed = true;
    this.ledger.release();
    for (const owned of this.sources) {
      if (!owned.started) this.release(owned);
      else {
        try {
          owned.source.stop();
        } catch {}
      }
    }
    if (this.sources.size === 0) this.notifyRetired();
  }
  /** Caller must have observed successful closure of this scheduler's owned context. */
  contextClosed(): void {
    this.closed = true;
    this.ledger.release();
    for (const owned of this.sources) this.release(owned);
    this.notifyRetired();
  }
  dispose(): void {
    this.cancel();
  }
}
