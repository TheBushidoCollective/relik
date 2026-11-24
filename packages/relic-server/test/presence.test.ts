import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import { startRelicServer, type RelicRole } from '../src/index.ts';
import type { PresenceSocketData } from '../src/presence.ts';
import type { RelicStore } from '../src/store.ts';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ROOM = 'BBBBBBBBBBBBBBBBBBBBBB';
const ORIGIN = 'https://relic.example';
const frame = JSON.stringify({
  v: 1,
  c: Buffer.alloc(540, 7).toString('base64url'),
});

// Bun accepts headers on its WebSocket client; lib.dom omits that overload.
const SocketWithHeaders = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions
) => WebSocket;

interface Peer {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<CloseEvent>;
  readonly received: unknown[];
  next(): Promise<unknown>;
}

let sockets: WebSocket[] = [];
let servers: Bun.Server<PresenceSocketData>[] = [];

function launch(role?: RelicRole, throwingStore = false) {
  const store = throwingStore
    ? new Proxy({} as RelicStore, {
        get() {
          throw new Error('The relay accessed the store');
        },
      })
    : undefined;
  const app = createApp({
    config: {
      serviceOrigin: ORIGIN,
      usercontentOrigin: 'https://usercontent.example',
      trustedProxyHops: 2,
    },
    ...(store === undefined ? {} : { store }),
  });
  const server = startRelicServer({
    port: 0,
    config: app.config,
    app,
    ...(role === undefined ? {} : { role }),
  });
  servers.push(server);
  if (server.port === null) throw new Error('Expected a TCP port');
  return { server, app, base: `http://127.0.0.1:${server.port}` };
}

function connect(base: string, room = ROOM, ip = '198.51.100.1'): Peer {
  const socket = new SocketWithHeaders(
    `${base.replace('http:', 'ws:')}/api/presence/${room}`,
    {
      headers: { origin: ORIGIN, 'x-forwarded-for': `${ip}, 130.211.0.1` },
    }
  );
  sockets.push(socket);
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('WebSocket failed')),
      { once: true }
    );
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
  });
  const queue: unknown[] = [];
  const received: unknown[] = [];
  const waiters: Array<(item: unknown) => void> = [];
  socket.addEventListener('message', (event) => {
    const item: unknown = JSON.parse(String(event.data));
    received.push(item);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(item);
    else waiter(item);
  });
  return {
    socket,
    opened,
    closed,
    received,
    next() {
      const item = queue.shift();
      return item === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(item);
    },
  };
}

async function hello(peer: Peer): Promise<{ self: string; peers: number }> {
  await peer.opened;
  const message = await peer.next();
  const parsed = message as {
    v: number;
    hello: { self: string; peers: number };
  };
  expect(parsed.v).toBe(1);
  expect(typeof parsed.hello.self).toBe('string');
  expect(typeof parsed.hello.peers).toBe('number');
  expect(parsed.hello.self).toMatch(/^[A-Za-z0-9_-]{16}$/);
  return parsed.hello;
}

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  await Promise.all(servers.map((server) => server.stop(true)));
  servers = [];
});

describe('presence relay', () => {
  test('forwards only to other sockets in the room without using the store', async () => {
    const previous = process.env['RELIC_ROLE'];
    process.env['RELIC_ROLE'] = 'all';
    let base: string;
    try {
      base = launch(undefined, true).base;
    } finally {
      if (previous === undefined) delete process.env['RELIC_ROLE'];
      else process.env['RELIC_ROLE'] = previous;
    }
    const a = connect(base, ROOM, '198.51.100.1');
    const aHello = await hello(a);
    const b = connect(base, ROOM, '198.51.100.2');
    expect((await hello(b)).peers).toBe(1);
    const c = connect(base, OTHER_ROOM, '198.51.100.3');
    expect((await hello(c)).peers).toBe(0);
    a.socket.send(frame);
    expect(await b.next()).toEqual({
      v: 1,
      f: aHello.self,
      c: JSON.parse(frame).c,
    });
    a.socket.close();
    expect(await b.next()).toEqual({ v: 1, f: aHello.self, gone: true });
    expect(a.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
  });

  test('refuses a bad Origin and a malformed room before upgrading', async () => {
    const { base } = launch('all', true);
    const badOrigin = await fetch(`${base}/api/presence/${ROOM}`, {
      headers: { origin: 'https://other.example' },
    });
    expect(badOrigin.status).toBe(403);
    const missingOrigin = await fetch(`${base}/api/presence/${ROOM}`);
    expect(missingOrigin.status).toBe(403);
    const badRoom = await fetch(`${base}/api/presence/not-a-room`, {
      headers: { origin: ORIGIN },
    });
    expect(badRoom.status).toBe(404);
  });

  test('forwards a valid message at the 1024-byte boundary', async () => {
    const { base } = launch('all', true);
    const sender = connect(base, ROOM, '198.51.100.1');
    const senderHello = await hello(sender);
    const receiver = connect(base, ROOM, '198.51.100.2');
    await hello(receiver);
    const overhead = Buffer.byteLength(JSON.stringify({ v: 1, c: '' }));
    const ciphertext = 'A'.repeat(1024 - overhead);
    const message = JSON.stringify({ v: 1, c: ciphertext });
    expect(Buffer.byteLength(message)).toBe(1024);
    sender.socket.send(message);
    expect(await receiver.next()).toEqual({
      v: 1,
      f: senderHello.self,
      c: ciphertext,
    });
  });

  test('closes messages over 1024 bytes with 1009', async () => {
    const { base } = launch('all', true);
    const peer = connect(base);
    await hello(peer);
    peer.socket.send('x'.repeat(1025));
    expect((await peer.closed).code).toBe(1009);
  });

  test('drops excess frames and closes persistent excess with 1008', async () => {
    const { base } = launch('all', true);
    const sender = connect(base, ROOM, '198.51.100.1');
    const senderHello = await hello(sender);
    const receiver = connect(base, ROOM, '198.51.100.2');
    await hello(receiver);
    for (let i = 0; i < 15; i += 1) sender.socket.send(frame);
    for (let i = 0; i < 15; i += 1) {
      expect(await receiver.next()).toEqual({
        v: 1,
        f: senderHello.self,
        c: JSON.parse(frame).c,
      });
    }
    for (let i = 0; i < 15; i += 1) sender.socket.send(frame);
    expect((await sender.closed).code).toBe(1008);
    expect(await receiver.next()).toEqual({
      v: 1,
      f: senderHello.self,
      gone: true,
    });
    expect(receiver.received).toHaveLength(17);
  });

  test('refuses a 65th socket in a room with 1013 and frees the slot on close', async () => {
    const { base } = launch('all', true);
    const peers: Peer[] = [];
    for (let i = 1; i <= 64; i += 1) {
      const peer = connect(base, ROOM, `198.51.100.${i}`);
      expect((await hello(peer)).peers).toBe(i - 1);
      peers.push(peer);
    }
    const overflow = connect(base, ROOM, '198.51.100.100');
    await overflow.opened;
    expect((await overflow.closed).code).toBe(1013);
    const first = peers[0];
    if (first === undefined) throw new Error('No first peer');
    first.socket.close();
    await first.closed;
    const replacement = connect(base, ROOM, '198.51.100.100');
    expect((await hello(replacement)).peers).toBe(63);
  }, 20_000);

  test('refuses a 17th socket from one IP across rooms with 1013', async () => {
    const { base } = launch('all', true);
    for (let i = 0; i < 16; i += 1) {
      const room = String(i).padStart(22, 'A');
      await hello(connect(base, room, '198.51.100.12'));
    }
    const overflow = connect(base, ROOM, '198.51.100.12');
    await overflow.opened;
    expect((await overflow.closed).code).toBe(1013);
    expect((await hello(connect(base, ROOM, '198.51.100.13'))).peers).toBe(0);
  }, 20_000);

  test('rejects malformed envelopes without forwarding', async () => {
    const { base } = launch('all', true);
    const peer = connect(base);
    await hello(peer);
    peer.socket.send(JSON.stringify({ v: 2, c: 'opaque' }));
    expect((await peer.closed).code).toBe(1008);
  });

  test('the default service role does not expose presence', async () => {
    const previous = process.env['RELIC_ROLE'];
    delete process.env['RELIC_ROLE'];
    let base: string;
    try {
      base = launch().base;
    } finally {
      if (previous !== undefined) process.env['RELIC_ROLE'] = previous;
    }
    const response = await fetch(`${base}/api/presence/${ROOM}`, {
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(404);
  });

  test('relay-only mode serves health and no application routes', async () => {
    const { base } = launch('presence', true);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: 'ok',
    });
    expect((await fetch(`${base}/policy`)).status).toBe(404);
    expect((await hello(connect(base))).peers).toBe(0);
  });

  test('the viewer CSP and policy disclose presence', async () => {
    const { base } = launch('all', true);
    const viewer = await fetch(`${base}/policy`, {
      headers: { accept: 'text/html' },
    });
    expect(viewer.headers.get('content-security-policy')).toContain(
      'wss://relic.example'
    );
    const policy = await (await fetch(`${base}/policy?raw=1`)).text();
    expect(policy).toContain('## Live presence while suggesting');
    expect(policy).toContain(
      "a key derived from the relik's key (the link for a public relik, the version key you were granted for a private one)"
    );
    expect(policy).toContain("The room's name is derived from that key");
  });
});
