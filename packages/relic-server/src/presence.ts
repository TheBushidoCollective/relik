import { clientIp } from './app.ts';
import type { RelicConfig } from './config.ts';

const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const FRAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_FRAME_BYTES = 1024;
const MAX_ROOM_SOCKETS = 64;
const MAX_IP_SOCKETS = 16;
const WINDOW_MS = 5000;
const MAX_FRAMES_PER_WINDOW = 15;
const PING_MS = 30_000;

interface Room {
  readonly sockets: Set<Bun.ServerWebSocket<PresenceSocketData>>;
  reservations: number;
}

export interface PresenceSocketData {
  readonly id: string;
  readonly roomId: string;
  readonly ip: string;
  readonly room: Room | undefined;
  readonly frames: number[];
  readonly excess: number[];
  timer?: NodeJS.Timeout;
}

/** A relay owns only live sockets and never touches relic storage. */
export function createPresenceRelay(config: RelicConfig): {
  fetch(
    request: Request,
    server: Bun.Server<PresenceSocketData>
  ): Response | undefined;
  websocket: Bun.WebSocketHandler<PresenceSocketData>;
} {
  const rooms = new Map<string, Room>();
  const byIp = new Map<string, number>();
  const serviceOrigin = new URL(config.serviceOrigin).origin;

  function release(data: PresenceSocketData): void {
    if (data.room === undefined) return;
    data.room.reservations -= 1;
    if (data.room.reservations === 0) rooms.delete(data.roomId);
    const remaining = (byIp.get(data.ip) ?? 1) - 1;
    if (remaining === 0) byIp.delete(data.ip);
    else byIp.set(data.ip, remaining);
  }

  return {
    fetch(request, server) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      const path = new URL(request.url).pathname;
      const roomId = path.slice('/api/presence/'.length);
      if (!ROOM_PATTERN.test(roomId)) {
        return new Response('Not found', { status: 404 });
      }
      if (request.headers.get('origin') !== serviceOrigin) {
        return new Response('Forbidden', { status: 403 });
      }
      const ip = clientIp(request, config);
      let room = rooms.get(roomId);
      const full =
        (room?.reservations ?? 0) >= MAX_ROOM_SOCKETS ||
        (byIp.get(ip) ?? 0) >= MAX_IP_SOCKETS;
      if (!full) {
        if (room === undefined) {
          room = { sockets: new Set(), reservations: 0 };
          rooms.set(roomId, room);
        }
        room.reservations += 1;
        byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
      }
      const random = crypto.getRandomValues(new Uint8Array(12));
      const id = btoa(String.fromCharCode(...random))
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const data: PresenceSocketData = {
        id,
        roomId,
        ip,
        room: full ? undefined : room,
        frames: [],
        excess: [],
      };
      if (server.upgrade(request, { data })) return undefined;
      release(data);
      return new Response('WebSocket upgrade required', { status: 400 });
    },
    websocket: {
      // Bun rejects frames above this transport bound. The application limit
      // below sends 1009 for any message above 1024 bytes that reaches it.
      maxPayloadLength: 64 * 1024,
      idleTimeout: 0,
      backpressureLimit: 64 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        const { room, id } = ws.data;
        if (room === undefined) {
          ws.close(1013, 'Presence capacity reached');
          return;
        }
        const peers = room.sockets.size;
        room.sockets.add(ws);
        ws.send(JSON.stringify({ v: 1, hello: { self: id, peers } }));
        ws.data.timer = setInterval(() => ws.ping(), PING_MS);
      },
      message(ws, message) {
        const size =
          typeof message === 'string'
            ? Buffer.byteLength(message)
            : message.byteLength;
        if (size > MAX_FRAME_BYTES) {
          ws.close(1009, 'Presence frame too large');
          return;
        }
        const { room, frames, excess, id } = ws.data;
        if (room === undefined) return;
        const now = Date.now();
        while (frames.length > 0 && (frames[0] ?? now) <= now - WINDOW_MS) {
          frames.shift();
        }
        while (excess.length > 0 && (excess[0] ?? now) <= now - WINDOW_MS) {
          excess.shift();
        }
        if (frames.length >= MAX_FRAMES_PER_WINDOW) {
          excess.push(now);
          if (excess.length >= MAX_FRAMES_PER_WINDOW) {
            ws.close(1008, 'Presence rate exceeded');
          }
          return;
        }
        frames.push(now);
        if (typeof message !== 'string') {
          ws.close(1008, 'Invalid presence frame');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          ws.close(1008, 'Invalid presence frame');
          return;
        }
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 2 ||
          !('v' in parsed) ||
          parsed.v !== 1 ||
          !('c' in parsed) ||
          typeof parsed.c !== 'string' ||
          !FRAME_PATTERN.test(parsed.c)
        ) {
          ws.close(1008, 'Invalid presence frame');
          return;
        }
        const outbound = JSON.stringify({ v: 1, f: id, c: parsed.c });
        for (const peer of room.sockets) {
          if (peer !== ws) peer.send(outbound);
        }
      },
      close(ws) {
        clearInterval(ws.data.timer);
        const { room, id } = ws.data;
        if (room === undefined) return;
        const joined = room.sockets.delete(ws);
        release(ws.data);
        if (joined) {
          const gone = JSON.stringify({ v: 1, f: id, gone: true });
          for (const peer of room.sockets) peer.send(gone);
        }
      },
    },
  };
}
