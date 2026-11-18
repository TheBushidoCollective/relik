import {
  derivePresenceKeys,
  openPresence,
  sealPresence,
  type PresenceV1,
} from '@relic/format/presence';
import type { SourceSegment } from './markdown-source.ts';

export type PresenceRange = { readonly s: number; readonly e: number };
export type PresenceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unavailable';
export interface PresencePeer {
  readonly id: string;
  readonly state: PresenceV1;
}
export interface PresenceAccess {
  readonly signedIn: boolean;
  readonly rendererClass: string;
  readonly currentVersion: boolean;
}
export interface LocalPresence {
  readonly suggesting: boolean;
  readonly caret?: PresenceRange;
  readonly typing?: PresenceRange;
}

export interface PresenceSocket {
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(): void;
}
export interface PresenceEnvironment {
  readonly now: () => number;
  readonly random: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly socket: (url: string) => PresenceSocket;
  readonly visible: () => boolean;
  readonly onVisibility: (callback: () => void) => () => void;
  readonly onActivity: (callback: () => void) => () => void;
  readonly seal?: typeof sealPresence;
  readonly open?: typeof openPresence;
}

/** Browser dependencies are replaceable so the relay can be exercised without a browser. */
export function browserPresenceEnvironment(
  win: Window = window
): PresenceEnvironment {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, delay) => win.setTimeout(callback, delay),
    clearTimeout: (handle) => win.clearTimeout(handle as number),
    socket: (url) => new WebSocket(url),
    visible: () => win.document.visibilityState === 'visible',
    onVisibility: (callback) => {
      win.document.addEventListener('visibilitychange', callback);
      return () =>
        win.document.removeEventListener('visibilitychange', callback);
    },
    onActivity: (callback) => {
      const events = [
        'pointermove',
        'pointerdown',
        'keydown',
        'scroll',
      ] as const;
      for (const event of events) win.addEventListener(event, callback, true);
      return () => {
        for (const event of events)
          win.removeEventListener(event, callback, true);
      };
    },
  };
}

export interface PresenceClientOptions {
  readonly serviceOrigin: string;
  readonly relicId: string;
  /** The raw version key, not the derived comment key. */
  readonly keyBytes: Uint8Array;
  readonly version: number;
  readonly name: string | null;
  readonly color: number;
  readonly access: PresenceAccess;
  readonly environment?: PresenceEnvironment;
  readonly onChange: (
    peers: readonly PresencePeer[],
    status: PresenceStatus
  ) => void;
  readonly onPosted: (commentId: string) => void;
}

const SECOND = 1000;
const IDLE_MS = 10 * 60 * SECOND;
const PEER_MS = 5 * SECOND;
const POST_INTERVAL_MS = 5 * SECOND;
const SOCKET_OPEN = 1;
const PEER_ID = /^[A-Za-z0-9_-]{16}$/;

type Keys = { readonly seal: CryptoKey; readonly room: string };
type PeerRecord = { state: PresenceV1; receivedAt: number; timer: unknown };

/** One instance belongs to one displayed version and its raw key. */
export class PresenceClient {
  private readonly env: PresenceEnvironment;
  private access: PresenceAccess;
  private local: LocalPresence = { suggesting: false };
  private keys: Keys | undefined;
  private socket: PresenceSocket | undefined;
  private status: PresenceStatus = 'idle';
  private peers = new Map<string, PeerRecord>();
  private sequences = new Map<string, number>();
  private sequence = 0;
  private tickTimer: unknown;
  private retryTimer: unknown;
  private idleTimer: unknown;
  private postedTimer: unknown;
  private pendingPosted: string | undefined;
  private outgoingPosted: string | undefined;
  private lastPostedAt = -Infinity;
  private lastActivity: number;
  private attempt = 0;
  private epoch = 0;
  private started = false;
  private disposed = false;
  private unsubscribe: (() => void)[] = [];
  private self: string | undefined;

  constructor(private readonly options: PresenceClientOptions) {
    this.env = options.environment ?? browserPresenceEnvironment();
    this.access = options.access;
    this.lastActivity = this.env.now();
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribe = [
      this.env.onVisibility(() => this.reconcile()),
      this.env.onActivity(() => {
        this.lastActivity = this.env.now();
        this.reconcile();
      }),
    ];
    try {
      this.keys = await derivePresenceKeys(
        this.options.keyBytes,
        this.options.relicId
      );
      if (!this.disposed) this.reconcile();
    } catch {
      if (!this.disposed && this.eligible()) this.setStatus('unavailable');
    }
  }

  setAccess(access: PresenceAccess): void {
    this.access = access;
    this.reconcile();
  }

  setLocalState(local: LocalPresence): void {
    if (this.local.suggesting && !local.suggesting) {
      this.epoch++;
      this.outgoingPosted = undefined;
    }
    this.local = local;
    this.reconcile();
  }

  /** Announce a saved, edited or deleted comment on the next suggesting tick. */
  announcePosted(commentId: string): void {
    if (this.local.suggesting) this.outgoingPosted = commentId;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
    this.disconnect();
    this.clear('postedTimer');
    this.pendingPosted = undefined;
    this.status = 'idle';
  }

  private clear(
    name: 'tickTimer' | 'retryTimer' | 'idleTimer' | 'postedTimer'
  ): void {
    const handle = this[name];
    if (handle !== undefined) this.env.clearTimeout(handle);
    this[name] = undefined;
  }

  private eligible(): boolean {
    return (
      this.access.signedIn &&
      this.access.currentVersion &&
      (this.access.rendererClass === 'markdown' ||
        this.access.rendererClass === 'code') &&
      this.env.visible() &&
      (this.local.suggesting || this.env.now() - this.lastActivity < IDLE_MS)
    );
  }

  private emit(): void {
    this.options.onChange(
      [...this.peers].map(([id, peer]) => ({ id, state: peer.state })),
      this.status
    );
  }

  private setStatus(status: PresenceStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.emit();
  }

  private reconcile(): void {
    if (!this.started || this.disposed) return;
    this.clear('idleTimer');
    if (!this.eligible()) {
      this.disconnect();
      this.setStatus('idle');
      return;
    }
    if (!this.local.suggesting) {
      const remaining = Math.max(
        0,
        IDLE_MS - (this.env.now() - this.lastActivity)
      );
      this.idleTimer = this.env.setTimeout(() => {
        this.idleTimer = undefined;
        this.reconcile();
      }, remaining);
    }
    if (this.keys === undefined) return;
    if (this.socket === undefined && this.retryTimer === undefined)
      this.connect();
    if (this.socket?.readyState === SOCKET_OPEN && this.local.suggesting)
      this.scheduleTick();
    else this.clear('tickTimer');
  }

  private connect(): void {
    if (this.keys === undefined || !this.eligible() || this.disposed) return;
    this.setStatus('connecting');
    const url = new URL(
      `/api/presence/${this.keys.room}`,
      this.options.serviceOrigin
    );
    // An http origin is the loopback test or dev service; production is https.
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    let socket: PresenceSocket;
    try {
      socket = this.env.socket(url.toString());
    } catch {
      this.setStatus('unavailable');
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus('connected');
      if (this.local.suggesting) this.scheduleTick();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === 'string') {
        this.receive(socket, event.data);
      }
    };
    socket.onclose = () => this.lost(socket);
    socket.onerror = () => this.lost(socket);
  }

  private lost(socket: PresenceSocket): void {
    if (this.socket !== socket) return;
    this.disconnectSocket();
    this.setStatus('unavailable');
    this.retry();
  }

  private retry(): void {
    if (!this.eligible() || this.disposed || this.retryTimer !== undefined)
      return;
    const base = Math.min(30_000, SECOND * 2 ** Math.min(this.attempt++, 5));
    const factor = 0.8 + 0.4 * Math.max(0, Math.min(1, this.env.random()));
    const delay = Math.min(30_000, Math.round(base * factor));
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = undefined;
      this.reconcile();
    }, delay);
  }

  private disconnectSocket(): void {
    this.epoch++;
    this.clear('tickTimer');
    const socket = this.socket;
    this.socket = undefined;
    this.self = undefined;
    if (socket !== undefined) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    for (const peer of this.peers.values()) this.env.clearTimeout(peer.timer);
    const changed = this.peers.size > 0;
    this.peers.clear();
    this.sequences.clear();
    if (changed) this.emit();
  }

  private disconnect(): void {
    this.clear('retryTimer');
    this.clear('idleTimer');
    this.clear('postedTimer');
    this.pendingPosted = undefined;
    this.disconnectSocket();
    this.attempt = 0;
  }

  private scheduleTick(): void {
    if (this.tickTimer !== undefined) return;
    this.tickTimer = this.env.setTimeout(() => {
      this.tickTimer = undefined;
      const socket = this.socket;
      const keys = this.keys;
      if (
        socket === undefined ||
        keys === undefined ||
        socket.readyState !== SOCKET_OPEN ||
        !this.local.suggesting ||
        !this.eligible()
      )
        return;
      const epoch = this.epoch;
      const local = this.local;
      const posted = this.outgoingPosted;
      const frame: PresenceV1 = {
        v: 1,
        t: this.env.now(),
        name: this.options.name,
        color: this.options.color,
        version: this.options.version,
        ...(local.caret === undefined ? {} : { caret: local.caret }),
        ...(local.typing === undefined ? {} : { typing: local.typing }),
        ...(posted === undefined ? {} : { posted }),
      };
      this.scheduleTick();
      void (this.env.seal ?? sealPresence)(keys.seal, keys.room, frame)
        .then((ciphertext) => {
          if (
            this.socket !== socket ||
            this.epoch !== epoch ||
            !this.local.suggesting ||
            !this.eligible() ||
            socket.readyState !== SOCKET_OPEN
          )
            return;
          try {
            socket.send(JSON.stringify({ v: 1, c: ciphertext }));
            if (posted !== undefined && this.outgoingPosted === posted)
              this.outgoingPosted = undefined;
          } catch {
            this.lost(socket);
          }
        })
        .catch(() => {
          // Invalid local state must never leak into an unsealed frame.
        });
    }, SECOND);
  }

  private receive(socket: PresenceSocket, data: string): void {
    if (data.length > 1024) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return;
    const message = value as Record<string, unknown>;
    if (message['v'] !== 1) return;
    const hello = message['hello'];
    if (typeof hello === 'object' && hello !== null && !Array.isArray(hello)) {
      const info = hello as Record<string, unknown>;
      if (
        typeof info['self'] === 'string' &&
        PEER_ID.test(info['self']) &&
        Number.isSafeInteger(info['peers']) &&
        (info['peers'] as number) >= 0
      ) {
        this.self = info['self'];
      }
      return;
    }
    const id = message['f'];
    if (typeof id !== 'string' || !PEER_ID.test(id) || id === this.self) return;
    const sequence = ++this.sequence;
    this.sequences.set(id, sequence);
    if (message['gone'] === true) {
      this.removePeer(id);
      return;
    }
    if (typeof message['c'] !== 'string' || this.keys === undefined) return;
    const keys = this.keys;
    const receivedAt = this.env.now();
    void (this.env.open ?? openPresence)(
      keys.seal,
      keys.room,
      message['c']
    ).then((state) => {
      if (
        this.socket !== socket ||
        this.sequences.get(id) !== sequence ||
        state === undefined ||
        this.env.now() - receivedAt >= PEER_MS
      )
        return;
      if (state.version !== this.options.version) {
        this.removePeer(id);
        return;
      }
      const previous = this.peers.get(id);
      if (previous !== undefined) this.env.clearTimeout(previous.timer);
      const timer = this.env.setTimeout(
        () => {
          const peer = this.peers.get(id);
          if (peer?.receivedAt === receivedAt) this.removePeer(id);
        },
        Math.max(0, PEER_MS - (this.env.now() - receivedAt))
      );
      this.peers.set(id, { state, receivedAt, timer });
      this.emit();
      if (state.posted !== undefined) this.schedulePosted(state.posted);
    });
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (peer === undefined) return;
    this.env.clearTimeout(peer.timer);
    this.peers.delete(id);
    this.emit();
  }

  private schedulePosted(id: string): void {
    this.pendingPosted = id;
    if (this.postedTimer !== undefined) return;
    const wait = Math.max(
      0,
      this.lastPostedAt + POST_INTERVAL_MS - this.env.now()
    );
    const jitter = Math.floor(
      Math.max(0, Math.min(1, this.env.random())) * 2000
    );
    this.postedTimer = this.env.setTimeout(() => {
      this.postedTimer = undefined;
      const pending = this.pendingPosted;
      this.pendingPosted = undefined;
      if (pending === undefined || this.disposed || !this.eligible()) return;
      this.lastPostedAt = this.env.now();
      this.options.onPosted(pending);
    }, wait + jitter);
  }
}

export interface SourcePoint {
  readonly segment: number;
  readonly offset: number;
}

/** Map UTF-16 source positions to rendered segments, including collapsed joins. */
export function presenceSourcePoint(
  segments: readonly SourceSegment[],
  sourceOffset: number,
  bias: 'forward' | 'backward' = 'forward'
): SourcePoint | undefined {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) return undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (sourceOffset < segment.start) {
      if (bias === 'backward' && i > 0) {
        const prior = segments[i - 1];
        if (prior !== undefined)
          return { segment: i - 1, offset: prior.text.length };
      }
      return { segment: i, offset: 0 };
    }
    if (sourceOffset <= segment.end) {
      const offset =
        segment.kind === 'join'
          ? sourceOffset <= segment.start
            ? 0
            : sourceOffset >= segment.end
              ? segment.text.length
              : bias === 'forward'
                ? segment.text.length
                : 0
          : Math.min(segment.text.length, sourceOffset - segment.start);
      return { segment: i, offset };
    }
  }
  return undefined;
}

export interface PresenceViewOptions {
  /** A positioned stage containing the rendered root and the overlay. */
  readonly stage: HTMLElement;
  readonly root: HTMLElement;
  /** A dedicated slot in the mode bar. */
  readonly chip: HTMLElement;
  readonly segments: readonly SourceSegment[];
}

/** Paint only overlays, never peer text or markup into the document. */
export class PresenceView {
  private readonly layer: HTMLElement;
  private peers: readonly PresencePeer[] = [];
  private status: PresenceStatus = 'idle';
  private signedIn = false;
  private root: HTMLElement;
  private segments: readonly SourceSegment[];

  constructor(private readonly options: PresenceViewOptions) {
    this.root = options.root;
    this.segments = options.segments;
    this.layer = options.stage.ownerDocument.createElement('div');
    this.layer.className = 'presence-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    options.stage.append(this.layer);
  }

  setDocument(root: HTMLElement, segments: readonly SourceSegment[]): void {
    this.root = root;
    this.segments = segments;
    this.refresh();
  }

  render(
    peers: readonly PresencePeer[],
    status: PresenceStatus,
    signedIn: boolean
  ): void {
    this.peers = peers;
    this.status = status;
    this.signedIn = signedIn;
    this.refresh();
  }

  /** Call again after layout, scroll, or a local document repaint. */
  refresh(): void {
    this.layer.replaceChildren();
    this.options.chip.replaceChildren();
    if (!this.signedIn) return;
    const doc = this.options.stage.ownerDocument;
    if (this.status === 'unavailable') {
      const chip = doc.createElement('span');
      chip.className = 'sg-presence is-off';
      chip.title =
        'The presence relay did not answer. Suggestions still post; other readers’ cursors return when it reconnects.';
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        'M2 2l12 12M5 9.5a4 4 0 016 0M2.5 6.5a8 8 0 0111 0M8 12.5v.5'
      );
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-linecap', 'round');
      svg.append(path);
      chip.append(svg);
      const text = doc.createElement('span');
      text.textContent = 'Live presence unavailable';
      chip.append(text);
      this.options.chip.append(chip);
      return;
    }
    if (this.status !== 'connected' || this.peers.length === 0) return;
    const chip = doc.createElement('span');
    chip.className = 'sg-presence';
    const names = this.peers.map(({ state }) => peerName(state));
    chip.title = `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} suggesting on this relic`;
    for (const peer of this.peers) {
      const dot = doc.createElement('span');
      dot.className = 'peer-dot';
      dot.style.setProperty('--c', peerColor(peer.state.color));
      dot.textContent = Array.from(peerName(peer.state))[0] ?? 'R';
      chip.append(dot);
    }
    const text = doc.createElement('span');
    text.textContent = `${names.join(', ')} suggesting`;
    chip.append(text);
    this.options.chip.append(chip);

    const stageRect = this.options.stage.getBoundingClientRect();
    for (const peer of this.peers) {
      const { state } = peer;
      const color = peerColor(state.color);
      const name = peerName(state);
      const rects =
        state.typing === undefined ? [] : this.typingRects(state.typing);
      for (const rect of rects) {
        const mark = doc.createElement('div');
        mark.className = 'peer-typing';
        mark.style.setProperty('--c', color);
        mark.style.left = `${rect.left - stageRect.left - 2}px`;
        mark.style.top = `${rect.top - stageRect.top - 1}px`;
        mark.style.width = `${rect.width + 4}px`;
        mark.style.height = `${rect.height + 2}px`;
        this.layer.append(mark);
      }
      const caret =
        state.caret === undefined ? undefined : this.caretRect(state.caret.e);
      const firstRect =
        rects[0] ?? (state.typing !== undefined ? caret : undefined);
      if (firstRect !== undefined) {
        const tag = doc.createElement('div');
        tag.className = 'peer-typing-tag';
        tag.style.setProperty('--c', color);
        tag.textContent = `${name} is suggesting…`;
        this.layer.append(tag);
        tag.style.top = `${firstRect.top - stageRect.top - tag.offsetHeight - 2}px`;
        tag.style.left = `${Math.max(4, Math.min(firstRect.left - stageRect.left - 2, this.options.stage.clientWidth - 8 - tag.offsetWidth))}px`;
      }
      if (caret === undefined) continue;
      const mark = doc.createElement('div');
      mark.className = 'peer-caret';
      mark.style.setProperty('--c', color);
      mark.style.left = `${caret.left - stageRect.left - 1}px`;
      mark.style.top = `${caret.top - stageRect.top}px`;
      mark.style.height = `${caret.height}px`;
      if (state.typing === undefined) {
        const flag = doc.createElement('span');
        flag.className = 'peer-flag';
        flag.textContent = name;
        mark.append(flag);
      }
      this.layer.append(mark);
    }
  }

  dispose(): void {
    this.layer.remove();
    this.options.chip.replaceChildren();
  }

  private nodeAt(
    point: SourcePoint
  ): { node: Text; offset: number } | undefined {
    const segment = this.segments[point.segment];
    if (segment === undefined) return undefined;
    const node =
      this.root.querySelector(`[data-seg="${point.segment}"]`) ??
      (this.segments.length === 1 &&
      segment.kind === 'code' &&
      this.root.matches('pre.code-body')
        ? this.root
        : null);
    if (node === null) return undefined;
    const walker = this.root.ownerDocument.createTreeWalker(node, 4);
    let remaining = point.offset;
    let last: Text | undefined;
    for (
      let next = walker.nextNode();
      next !== null;
      next = walker.nextNode()
    ) {
      const text = next as Text;
      if (text.parentElement?.closest('ins, [data-sg-chip]')) continue;
      last = text;
      if (remaining <= text.data.length)
        return { node: text, offset: remaining };
      remaining -= text.data.length;
    }
    return last !== undefined && remaining === 0
      ? { node: last, offset: last.data.length }
      : undefined;
  }

  private caretRect(
    sourceOffset: number
  ): Pick<DOMRect, 'left' | 'top' | 'height'> | undefined {
    const point = presenceSourcePoint(this.segments, sourceOffset, 'backward');
    const position = point === undefined ? undefined : this.nodeAt(point);
    if (position === undefined || position.node.data.length === 0)
      return undefined;
    const range = this.root.ownerDocument.createRange();
    const atEnd = position.offset === position.node.data.length;
    range.setStart(
      position.node,
      atEnd ? position.offset - 1 : position.offset
    );
    range.setEnd(position.node, atEnd ? position.offset : position.offset + 1);
    const rect = range.getClientRects()[0];
    if (rect === undefined) return undefined;
    return atEnd
      ? { left: rect.right, top: rect.top, height: rect.height }
      : rect;
  }

  private typingRects(typing: PresenceRange): DOMRect[] {
    const result: DOMRect[] = [];
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      if (
        segment === undefined ||
        typing.s >= segment.end ||
        typing.e <= segment.start
      )
        continue;
      const start = presenceSourcePoint(
        [segment],
        Math.max(typing.s, segment.start),
        'backward'
      );
      const end = presenceSourcePoint(
        [segment],
        Math.min(typing.e, segment.end),
        'forward'
      );
      if (start === undefined || end === undefined) continue;
      const a = this.nodeAt({ segment: i, offset: start.offset });
      const b = this.nodeAt({ segment: i, offset: end.offset });
      if (a === undefined || b === undefined) continue;
      const range = this.root.ownerDocument.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      for (const rect of range.getClientRects())
        if (rect.width > 0.5) result.push(rect);
    }
    return result;
  }
}

function peerName(state: PresenceV1): string {
  return state.name?.trim() || 'Reader';
}

function peerColor(color: number): string {
  const index = ((((Math.trunc(color) - 1) % 4) + 4) % 4) + 1;
  return `var(--peer-${index})`;
}
