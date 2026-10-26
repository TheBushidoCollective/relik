import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../packages/relic-server/src/app.ts';
import { diskAssets } from '../packages/relic-server/src/assets.ts';
import { MemoryStorage } from '../packages/relic-server/src/storage.ts';
import { MemoryStore } from '../packages/relic-server/src/store.ts';

const inputPath = resolve(process.argv[2] ?? '');
const inputStat = await stat(inputPath);
if ((inputStat.mode & 0o077) !== 0)
  throw new Error('Private input must be mode 0600');
const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
  ciphertext: string;
  key: string;
};
const ciphertext = new Uint8Array(await readFile(input.ciphertext));
const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const store = new MemoryStore();
let handler: (request: Request) => Promise<Response>;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handler(request),
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
storage.put(id, ciphertext);
const object = await storage.stat(id);
if (!object) throw new Error('Replay ciphertext missing');
const now = Date.now();
await store.putRelic({
  id,
  publishIp: '127.0.0.1',
  grantedAt: now,
  expiresAt: undefined,
  rendererClass: 'otio',
  publishingClient: 'private-playback-profile',
  declaredSizeBytes: ciphertext.length,
  version: 1,
  publishTokenHash: '0'.repeat(64),
  publishedAt: now,
  objectLength: object.length,
  objectCrc32c: object.crc32c,
  mintsUsed: 0,
  title: 'Private playback profile',
});
const assets =
  process.env['RELIC_PERF_VIEWER_DIST'] ??
  resolve('packages/relic-viewer/dist');
const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  assets: diskAssets(assets),
});
handler = async (request) => {
  const url = new URL(request.url);
  if (url.hostname !== '127.0.0.1')
    return new Response('Loopback only', { status: 403 });
  if (request.method === 'GET' && url.pathname === `/__storage/o/${id}`) {
    return new Response(ciphertext, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  // Only the local mirror's read grant may mutate. No comments or content writes.
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    !(request.method === 'POST' && url.pathname === `/api/relics/${id}/mint`)
  ) {
    return new Response('Playback profile is read-only', { status: 405 });
  }
  return app.fetch(request);
};
await writeFile(
  join(dirname(inputPath), 'replay-url.txt'),
  `${origin}/${id}#${input.key}`,
  { mode: 0o600 }
);
console.log(`OTIO_PERF_REPLAY_READY ${origin}`);
