/**
 * Live settings loopback acceptance path.
 * RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/settings-path.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { sha256Hex } from '@relic/server/src/gcs.ts';
import { callMcp } from './decision-proof-steps.ts';

const scratch = await mkdtemp(join(tmpdir(), 'relic-settings-path-'));
const statePath = join(scratch, 'state.json');
const bundle = fileURLToPath(new URL('../dist/relic-mcp.js', import.meta.url));
const viewer = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const store = new MemoryStore();
let handle: ((request: Request) => Promise<Response>) | undefined;
let clock = Date.now();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (r) =>
    handle ? handle(r) : new Response('not ready', { status: 503 }),
});
const origin = `http://localhost:${server.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const mails: { to: string; subject: string; text: string }[] = [];
const options = {
  config: { serviceOrigin: origin },
  store,
  storage,
  assets: diskAssets(viewer),
  now: () => clock,
  mailer: {
    send: async (to: string, link: string) => {
      mails.push({ to, subject: 'sign-in', text: link });
    },
    sendMail: async (to: string, mail: { subject: string; text: string }) => {
      mails.push({ to, ...mail });
    },
  },
};
const apps = [createApp(options), createApp(options)];
handle = async (request) => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    storage.put(
      url.pathname.slice('/__storage/upload/'.length),
      new Uint8Array(await request.arrayBuffer())
    );
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const data = await storage.read(url.pathname.slice('/__storage/o/'.length));
    return data
      ? new Response(Buffer.from(data))
      : new Response('not found', { status: 404 });
  }
  const which = url.searchParams.get('instance') === 'b' ? 1 : 0;
  return apps[which]!.fetch(request);
};
const mcp = (name: string, args: Record<string, unknown>) =>
  callMcp(['node', bundle], scratch, statePath, origin, name, args);
const req = (path: string, method: string, body: unknown, cookie?: string) =>
  fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}instance=b`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

try {
  const file = join(scratch, 'settings.txt');
  await Bun.write(file, 'Settings path proof\n');
  const published = await mcp('relic_publish', {
    path: file,
    title: '',
    cover: false,
    ttl_days: 1,
  });
  const id = published['relic_id'];
  assert.equal(typeof id, 'string');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const token = state.relics[id as string].publish_token as string;
  const ciphertext = await encryptComment(
    await deriveCommentKey(decodeKey(state.relics[id as string].key)),
    { body: 'Reader feedback', display_name: null, anchor: null }
  );
  const reader = 'settings-path-reader';
  const now = Date.now();
  await store.putSession({
    tokenHash: await sha256Hex(reader),
    email: 'reader@example.test',
    createdAt: now,
    expiresAt: now + 3600000,
  });
  const cookie = `relic_session=${reader}`;
  const comments = `/api/relics/${id}/comments`;
  const first = await req(comments, 'POST', { ciphertext }, cookie);
  assert.equal(first.status, 201, await first.clone().text());
  const firstComment = (await first.json()) as { comment_id: string };
  await mcp('relic_settings', { relic_id: id, comments: false });
  const denied = await req(comments, 'POST', { ciphertext }, cookie);
  assert.equal(denied.status, 409);
  assert.equal(
    ((await denied.json()) as { code: string }).code,
    'comments_closed'
  );
  const publisher = await req(comments, 'POST', {
    ciphertext: 'abcd',
    publish_token: token,
  });
  assert.equal(publisher.status, 201, await publisher.clone().text());
  const comment = (await publisher.json()) as { comment_id: string };
  const resolve = await req(`${comments}/${comment.comment_id}`, 'PATCH', {
    publish_token: token,
    resolved: true,
  });
  assert.equal(resolve.status, 200, await resolve.clone().text());
  const deleted = await req(`${comments}/${comment.comment_id}`, 'DELETE', {
    publish_token: token,
  });
  assert.equal(deleted.status, 204, await deleted.clone().text());
  console.log(
    '01_COMMENTS_CLOSED reader=409 code=comments_closed publisher=201 resolve=200 delete=204 instance=b'
  );
  let negativeFailed = false;
  try {
    assert.equal(denied.status, 201);
  } catch {
    negativeFailed = true;
  }
  assert.ok(negativeFailed, 'wrong comment expectation passed');
  console.log('01_NEGATIVE wrong_status=rejected');
  await mcp('relic_settings', { relic_id: id, comments: true });
  const reopened = await req(comments, 'POST', { ciphertext }, cookie);
  assert.equal(reopened.status, 201, await reopened.clone().text());
  const reopenedComment = (await reopened.json()) as { comment_id: string };
  for (const commentId of [
    firstComment.comment_id,
    reopenedComment.comment_id,
  ]) {
    const settled = await req(
      `${comments}/${commentId}`,
      'PATCH',
      { resolved: true },
      cookie
    );
    assert.equal(settled.status, 200, await settled.clone().text());
  }
  console.log('02_COMMENTS_REOPENED reader=201 instance=b');
  clock += 15 * 60_000;
  await Bun.write(file, 'Settings path proof version two\n');
  const baseline = mails.length;
  await mcp('relic_republish', {
    relic_id: id,
    path: file,
    title: '',
    cover: false,
  });
  assert.ok(
    mails.slice(baseline).some((mail) => mail.to === 'reader@example.test'),
    'positive control: follower received no change notice'
  );
  await mcp('relic_settings', { relic_id: id, notifications: false });
  clock += 15 * 60_000;
  await Bun.write(file, 'Settings path proof version three\n');
  const disabled = mails.length;
  await mcp('relic_republish', {
    relic_id: id,
    path: file,
    title: '',
    cover: false,
  });
  assert.equal(
    mails.slice(disabled).filter((mail) => mail.to === 'reader@example.test')
      .length,
    0
  );
  console.log(
    '03_NOTIFICATION_CHANGE_NOTICE follower_control=received disabled=none'
  );
  throw new Error(
    'UNPROVEN: notification delivery, owner browser settings, private lifetime, paused challenge and their negative controls are not implemented'
  );
} catch (error) {
  console.error(
    `SETTINGS_PATH_BLOCKED ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
