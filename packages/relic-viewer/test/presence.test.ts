import { describe, expect, test } from 'bun:test';
import {
  derivePresenceKeys,
  openPresence,
  sealPresence,
  type PresenceV1,
} from '@relic/format/presence';
import {
  codeSegments,
  renderMarkdownWithSource,
} from '../src/markdown-source.ts';
import {
  PresenceClient,
  PresenceView,
  presenceSourcePoint,
  type PresenceAccess,
  type PresenceEnvironment,
  type PresencePeer,
  type PresenceSocket,
  type PresenceStatus,
} from '../src/presence.ts';

const keyBytes = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);
const peerId = 'abcdefghijklmnop';
const selfId = 'qrstuvwxyzABCDEF';
const access: PresenceAccess = {
  signedIn: true,
  rendererClass: 'markdown',
  currentVersion: true,
};

class FakeSocket implements PresenceSocket {
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(value: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(value) })
    );
  }
  fail(): void {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

class FakeEnvironment implements PresenceEnvironment {
  time = Date.now();
  jitter = 0.5;
  isVisible = true;
  nextId = 1;
  readonly tasks = new Map<number, { at: number; callback: () => void }>();
  readonly sockets: FakeSocket[] = [];
  private readonly operations: Promise<unknown>[] = [];
  seal: typeof sealPresence = (key, room, frame) => {
    const result = sealPresence(key, room, frame);
    this.operations.push(result);
    return result;
  };
  open: typeof openPresence = (key, room, ciphertext) => {
    const result = openPresence(key, room, ciphertext);
    this.operations.push(result);
    return result;
  };
  async settle(): Promise<void> {
    while (this.operations.length > 0) {
      await Promise.all(this.operations.splice(0));
    }
  }
  private visibility = new Set<() => void>();
  private activity = new Set<() => void>();
  now = (): number => this.time;
  random = (): number => this.jitter;
  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.tasks.delete(id as number);
  };
  socket = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };
  visible = (): boolean => this.isVisible;
  onVisibility = (callback: () => void): (() => void) => {
    this.visibility.add(callback);
    return () => {
      this.visibility.delete(callback);
    };
  };
  onActivity = (callback: () => void): (() => void) => {
    this.activity.add(callback);
    return () => {
      this.activity.delete(callback);
    };
  };
  setVisible(value: boolean): void {
    this.isVisible = value;
    for (const callback of this.visibility) callback();
  }
  input(): void {
    for (const callback of this.activity) callback();
  }
  async advance(delay: number): Promise<void> {
    const end = this.time + delay;
    while (true) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.at <= end && task.at < nextAt) {
          nextId = id;
          nextAt = task.at;
        }
      }
      if (nextId === undefined) break;
      this.time = nextAt;
      const task = this.tasks.get(nextId)!;
      this.tasks.delete(nextId);
      task.callback();
      await this.settle();
    }
    this.time = end;
    await this.settle();
  }
}

async function makeClient(initial: PresenceAccess = access): Promise<{
  client: PresenceClient;
  env: FakeEnvironment;
  changes: { peers: readonly PresencePeer[]; status: PresenceStatus }[];
  posted: { id: string; at: number }[];
}> {
  const env = new FakeEnvironment();
  const changes: { peers: readonly PresencePeer[]; status: PresenceStatus }[] =
    [];
  const posted: { id: string; at: number }[] = [];
  const client = new PresenceClient({
    serviceOrigin: 'https://relik.test',
    relicId: 'relic-one',
    keyBytes,
    version: 4,
    name: 'Alice',
    color: 2,
    access: initial,
    environment: env,
    onChange: (peers, status) => changes.push({ peers, status }),
    onPosted: (id) => posted.push({ id, at: env.time }),
  });
  await client.start();
  return { client, env, changes, posted };
}

function latestPeers(
  changes: { peers: readonly PresencePeer[] }[]
): readonly PresencePeer[] {
  return changes.at(-1)?.peers ?? [];
}

async function forward(
  socket: FakeSocket,
  env: FakeEnvironment,
  patch: Partial<PresenceV1> = {}
): Promise<string> {
  const keys = await derivePresenceKeys(keyBytes, 'relic-one');
  const frame: PresenceV1 = {
    v: 1,
    t: env.now(),
    name: 'Priya',
    color: 1,
    version: 4,
    caret: { s: 1, e: 2 },
    ...patch,
  };
  const c = await sealPresence(keys.seal, keys.room, frame);
  socket.receive({ v: 1, f: peerId, c });
  await env.settle();
  return c;
}

describe('presence client', () => {
  test('connects only for signed-in visible current markdown or code and derives the room from the raw key', async () => {
    const { client, env } = await makeClient({ ...access, signedIn: false });
    expect(env.sockets).toHaveLength(0);
    client.setAccess({ ...access, rendererClass: 'html' });
    expect(env.sockets).toHaveLength(0);
    client.setAccess({ ...access, rendererClass: 'jsx' });
    expect(env.sockets).toHaveLength(0);
    client.setAccess({ ...access, currentVersion: false });
    expect(env.sockets).toHaveLength(0);
    env.setVisible(false);
    client.setAccess({ ...access, rendererClass: 'code' });
    expect(env.sockets).toHaveLength(0);
    env.setVisible(true);
    expect(env.sockets).toHaveLength(1);
    const keys = await derivePresenceKeys(keyBytes, 'relic-one');
    expect(env.sockets[0]!.url).toBe(
      `wss://relik.test/api/presence/${keys.room}`
    );
    env.setVisible(false);
    expect(env.sockets[0]!.readyState).toBe(3);
    env.setVisible(true);
    expect(env.sockets).toHaveLength(2);
    client.dispose();
    env.setVisible(false);
    env.setVisible(true);
    expect(env.sockets).toHaveLength(2);
  });

  test('uses ws for an http service origin (loopback or dev) and wss for https', async () => {
    const keys = await derivePresenceKeys(keyBytes, 'relic-one');
    for (const [origin, scheme] of [
      ['http://127.0.0.1:4001', 'ws'],
      ['https://relik.test', 'wss'],
    ] as const) {
      const env = new FakeEnvironment();
      const client = new PresenceClient({
        serviceOrigin: origin,
        relicId: 'relic-one',
        keyBytes,
        version: 4,
        name: 'Alice',
        color: 2,
        access,
        environment: env,
        onChange: () => {},
        onPosted: () => {},
      });
      await client.start();
      const host = new URL(origin).host;
      expect(env.sockets[0]!.url).toBe(
        `${scheme}://${host}/api/presence/${keys.room}`
      );
      client.dispose();
    }
  });

  test('sends one equally sized sealed frame each second only while suggesting and visible', async () => {
    const { client, env } = await makeClient();
    const socket = env.sockets[0]!;
    socket.open();
    await env.advance(3000);
    expect(socket.sent).toHaveLength(0);
    client.setLocalState({
      suggesting: true,
      caret: { s: 3, e: 5 },
      typing: { s: 1, e: 4 },
    });
    await env.advance(999);
    expect(socket.sent).toHaveLength(0);
    await env.advance(1);
    client.announcePosted('comment-1');
    await env.advance(2000);
    expect(socket.sent).toHaveLength(3);
    expect(new Set(socket.sent.map((s) => s.length)).size).toBe(1);
    const keys = await derivePresenceKeys(keyBytes, 'relic-one');
    const frames = await Promise.all(
      socket.sent.map(async (s) => {
        const envelope = JSON.parse(s) as { v: number; c: string };
        expect(Object.keys(envelope).sort()).toEqual(['c', 'v']);
        expect(envelope.v).toBe(1);
        return openPresence(keys.seal, keys.room, envelope.c);
      })
    );
    expect(frames[0]).toMatchObject({
      caret: { s: 3, e: 5 },
      typing: { s: 1, e: 4 },
      name: 'Alice',
      version: 4,
    });
    expect(frames[1]?.posted).toBe('comment-1');
    expect(frames[2]?.posted).toBeUndefined();
    client.setLocalState({ suggesting: false });
    await env.advance(2000);
    expect(socket.sent).toHaveLength(3);
    client.setLocalState({ suggesting: true });
    env.setVisible(false);
    await env.advance(2000);
    expect(socket.sent).toHaveLength(3);
    client.dispose();
  });

  test('idle reading disconnects after ten minutes and input reconnects; suggesting does not idle out', async () => {
    const { client, env } = await makeClient();
    env.sockets[0]!.open();
    await env.advance(599_999);
    expect(env.sockets[0]!.readyState).toBe(1);
    await env.advance(1);
    expect(env.sockets[0]!.readyState).toBe(3);
    env.input();
    expect(env.sockets).toHaveLength(2);
    const socket = env.sockets[1]!;
    socket.open();
    client.setLocalState({ suggesting: true });
    // No open socket is needed to prove the idle timer is absent in this mode.
    socket.readyState = 0;
    await env.advance(600_001);
    expect(env.sockets).toHaveLength(2);
    client.setLocalState({ suggesting: false });
    expect(socket.readyState).toBe(3);
    client.dispose();
  });

  test('retries with exponential backoff bounded by jitter and thirty seconds', async () => {
    const { client, env } = await makeClient();
    env.jitter = 0;
    for (const delay of [800, 1600, 3200, 6400, 12800, 24000, 24000]) {
      const socket = env.sockets.at(-1)!;
      const count = env.sockets.length;
      socket.fail();
      await env.advance(delay - 1);
      expect(env.sockets).toHaveLength(count);
      await env.advance(1);
      expect(env.sockets).toHaveLength(count + 1);
    }
    client.dispose();
    const other = await makeClient();
    other.env.jitter = 1;
    for (const delay of [1200, 2400, 4800, 9600, 19200, 30000, 30000]) {
      const socket = other.env.sockets.at(-1)!;
      const count = other.env.sockets.length;
      socket.fail();
      await other.env.advance(delay - 1);
      expect(other.env.sockets).toHaveLength(count);
      await other.env.advance(1);
      expect(other.env.sockets).toHaveLength(count + 1);
    }
    other.client.dispose();
  });

  test('handles hello, authenticated frames and gone; invalid or other-room frames never appear', async () => {
    const { client, env, changes } = await makeClient();
    const socket = env.sockets[0]!;
    socket.open();
    socket.receive({ v: 1, hello: { self: selfId, peers: 1 } });
    const keys = await derivePresenceKeys(keyBytes, 'relic-one');
    const foreign = await derivePresenceKeys(keyBytes, 'another-relic');
    const frame: PresenceV1 = {
      v: 1,
      t: env.now(),
      name: 'Priya',
      color: 1,
      version: 4,
    };
    const foreignCipher = await sealPresence(foreign.seal, foreign.room, frame);
    socket.receive({ v: 1, f: peerId, c: foreignCipher });
    await env.settle();
    expect(latestPeers(changes)).toHaveLength(0);
    const good = await sealPresence(keys.seal, keys.room, frame);
    const index = 30;
    const tampered =
      good.slice(0, index) +
      (good[index] === 'A' ? 'B' : 'A') +
      good.slice(index + 1);
    socket.receive({ v: 1, f: peerId, c: tampered });
    socket.receive({ v: 1, f: selfId, c: good });
    await env.settle();
    expect(latestPeers(changes)).toHaveLength(0);
    await forward(socket, env);
    expect(latestPeers(changes)[0]).toMatchObject({
      id: peerId,
      state: { name: 'Priya', caret: { s: 1, e: 2 } },
    });
    socket.receive({ v: 1, f: peerId, gone: true });
    expect(latestPeers(changes)).toHaveLength(0);
    await forward(socket, env, { version: 3 });
    expect(latestPeers(changes)).toHaveLength(0);
    client.dispose();
  });

  test('expires each peer exactly five seconds after its latest frame', async () => {
    const { client, env, changes } = await makeClient();
    const socket = env.sockets[0]!;
    socket.open();
    await forward(socket, env);
    await env.advance(4000);
    await forward(socket, env, { caret: { s: 2, e: 3 } });
    await env.advance(4999);
    expect(latestPeers(changes)).toHaveLength(1);
    await env.advance(1);
    expect(latestPeers(changes)).toHaveLength(0);
    client.dispose();
  });

  test('coalesces posted pings and refetches at most once per five seconds with zero to two seconds jitter', async () => {
    const { client, env, posted } = await makeClient();
    env.jitter = 1;
    const socket = env.sockets[0]!;
    socket.open();
    await forward(socket, env, { posted: 'first' });
    await env.advance(1999);
    expect(posted).toHaveLength(0);
    await env.advance(1);
    expect(posted.map((x) => x.id)).toEqual(['first']);
    await forward(socket, env, { posted: 'second' });
    await forward(socket, env, { posted: 'third' });
    await env.advance(6999);
    expect(posted).toHaveLength(1);
    await env.advance(1);
    expect(posted.map((x) => x.id)).toEqual(['first', 'third']);
    expect(posted[1]!.at - posted[0]!.at).toBe(7000);
    env.jitter = 0;
    await forward(socket, env, { posted: 'fourth' });
    await env.advance(4999);
    expect(posted).toHaveLength(2);
    await env.advance(1);
    expect(posted[2]!.id).toBe('fourth');
    client.dispose();
  });
});

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  constructor(
    readonly data: string,
    readonly x = 0,
    readonly y = 0
  ) {}
}
class FakeElement {
  readonly nodeType = 1;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
  };
  parentElement: FakeElement | null = null;
  className = '';
  title = '';
  clientWidth = 500;
  offsetHeight = 12;
  offsetWidth = 60;
  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string
  ) {
    const style: Record<string, string> = {};
    this.style = Object.assign(style, {
      setProperty: (name: string, value: string) => {
        style[name] = value;
      },
    });
  }
  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }
  get textContent(): string {
    return this.children
      .map((child) =>
        child instanceof FakeText ? child.data : child.textContent
      )
      .join('');
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...children: (FakeElement | FakeText)[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: (FakeElement | FakeText)[]): void {
    this.children.length = 0;
    this.append(...children);
  }
  remove(): void {
    if (this.parentElement === null) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  querySelector(selector: string): FakeElement | null {
    const id = /^\[data-seg="(\d+)"\]$/.exec(selector)?.[1];
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (id !== undefined && child.attributes.get('data-seg') === id)
        return child;
      const found = child.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  }
  matches(selector: string): boolean {
    return (
      selector === 'pre.code-body' &&
      this.tagName === 'pre' &&
      this.className === 'code-body'
    );
  }
  closest(selector: string): FakeElement | null {
    if (
      selector === 'ins, [data-sg-chip]' &&
      (this.tagName === 'ins' || this.attributes.has('data-sg-chip'))
    )
      return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  getBoundingClientRect(): DOMRect {
    return {
      left: 100,
      top: 50,
      right: 600,
      bottom: 450,
      width: 500,
      height: 400,
    } as DOMRect;
  }
}
class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return this.createElement(tag);
  }
  createTreeWalker(root: FakeElement): { nextNode: () => FakeText | null } {
    const texts: FakeText[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child instanceof FakeText) texts.push(child);
        else visit(child);
      }
    };
    visit(root);
    let index = 0;
    return { nextNode: () => texts[index++] ?? null };
  }
  createRange(): {
    setStart: (node: FakeText, offset: number) => void;
    setEnd: (node: FakeText, offset: number) => void;
    getClientRects: () => DOMRect[];
  } {
    let start: FakeText | undefined;
    let end: FakeText | undefined;
    let startOffset = 0;
    let endOffset = 0;
    return {
      setStart: (node, offset) => {
        start = node;
        startOffset = offset;
      },
      setEnd: (node, offset) => {
        end = node;
        endOffset = offset;
      },
      getClientRects: () => {
        if (start === undefined || end === undefined) return [];
        const left = start.x + startOffset * 10;
        const right = end.x + endOffset * 10;
        return [
          {
            left,
            right,
            top: start.y,
            bottom: start.y + 16,
            width: right - left,
            height: 16,
          } as DOMRect,
        ];
      },
    };
  }
}
function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) =>
    child instanceof FakeElement ? [child, ...descendants(child)] : []
  );
}

describe('presence rendering', () => {
  test('maps offsets through markdown segments, collapsed joins, and code', () => {
    const source = 'Before **bold** and\n  next';
    const segments = renderMarkdownWithSource(source).segments;
    const bold = segments.findIndex((segment) => segment.text === 'bold');
    expect(presenceSourcePoint(segments, source.indexOf('bold') + 2)).toEqual({
      segment: bold,
      offset: 2,
    });
    const join = segments.findIndex((segment) => segment.kind === 'join');
    expect(join).toBeGreaterThanOrEqual(0);
    const joinSegment = segments[join]!;
    expect(
      presenceSourcePoint(segments, joinSegment.start + 1, 'backward')
    ).toEqual({ segment: join, offset: 0 });
    expect(
      presenceSourcePoint(segments, joinSegment.start + 1, 'forward')
    ).toEqual({ segment: join, offset: 1 });
    expect(presenceSourcePoint(codeSegments('hello\nworld'), 8)).toEqual({
      segment: 0,
      offset: 8,
    });
    expect(presenceSourcePoint(segments, 10_000)).toBeUndefined();
  });

  test('paints ranges and caret at segment geometry, with hostile names only as text nodes', () => {
    const doc = new FakeDocument();
    const stage = doc.createElement('div');
    const root = doc.createElement('article');
    const chip = doc.createElement('div');
    stage.append(root);
    const first = doc.createElement('span');
    first.setAttribute('data-seg', '0');
    first.append(new FakeText('hello', 120, 80));
    const second = doc.createElement('span');
    second.setAttribute('data-seg', '1');
    second.append(new FakeText('world', 200, 80));
    root.append(first, second);
    const segments = [
      { text: 'hello', start: 0, end: 5, block: 0, kind: 'text' as const },
      { text: 'world', start: 9, end: 14, block: 0, kind: 'text' as const },
    ];
    const view = new PresenceView({
      stage: stage as unknown as HTMLElement,
      root: root as unknown as HTMLElement,
      chip: chip as unknown as HTMLElement,
      segments,
    });
    const hostile = '<img src=x onerror=1>';
    const peer: PresencePeer = {
      id: peerId,
      state: {
        v: 1,
        t: Date.now(),
        name: hostile,
        color: 2,
        version: 4,
        caret: { s: 11, e: 11 },
      },
    };
    view.render([peer], 'connected', true);
    expect(chip.textContent).toContain(`${hostile} suggesting`);
    const caret = descendants(stage).find(
      (element) => element.className === 'peer-caret'
    )!;
    expect(caret.style.left).toBe('119px');
    expect(caret.style.top).toBe('30px');
    expect(caret.children[0]).toBeInstanceOf(FakeElement);
    const flag = caret.children[0] as FakeElement;
    expect(flag.textContent).toBe(hostile);
    expect(flag.children[0]).toBeInstanceOf(FakeText);
    expect(
      descendants(stage)
        .concat(descendants(chip))
        .some((element) => element.tagName === 'img')
    ).toBe(false);
    view.render(
      [{ ...peer, state: { ...peer.state, typing: { s: 1, e: 12 } } }],
      'connected',
      true
    );
    const marks = descendants(stage).filter(
      (element) => element.className === 'peer-typing'
    );
    expect(marks.map((mark) => mark.style.left)).toEqual(['28px', '98px']);
    expect(
      descendants(stage).find(
        (element) => element.className === 'peer-typing-tag'
      )?.textContent
    ).toBe(`${hostile} is suggesting…`);
    view.render([], 'unavailable', true);
    expect(chip.textContent).toBe('Live presence unavailable');
    view.render([peer], 'connected', false);
    expect(chip.textContent).toBe('');
    view.dispose();
  });

  test('maps a plain code segment across syntax-highlighted text nodes', () => {
    const doc = new FakeDocument();
    const stage = doc.createElement('div');
    const root = doc.createElement('pre');
    root.className = 'code-body';
    const chip = doc.createElement('div');
    const a = doc.createElement('span');
    a.append(new FakeText('abc', 110, 80));
    const b = doc.createElement('span');
    b.append(new FakeText('def', 140, 80));
    root.append(a, b);
    stage.append(root);
    const view = new PresenceView({
      stage: stage as unknown as HTMLElement,
      root: root as unknown as HTMLElement,
      chip: chip as unknown as HTMLElement,
      segments: codeSegments('abcdef'),
    });
    view.render(
      [
        {
          id: peerId,
          state: {
            v: 1,
            t: Date.now(),
            name: 'Priya',
            color: 1,
            version: 4,
            caret: { s: 5, e: 5 },
          },
        },
      ],
      'connected',
      true
    );
    expect(
      descendants(stage).find((element) => element.className === 'peer-caret')
        ?.style.left
    ).toBe('59px');
    view.dispose();
  });
});
