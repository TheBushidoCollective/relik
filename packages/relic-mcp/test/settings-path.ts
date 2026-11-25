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
import { identityFingerprint } from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { gcsStore } from '@relic/server/src/gcsstore.ts';
import { fakeGcs } from '../../relic-server/test/fake-gcs.ts';
import { sha256Hex } from '@relic/server/src/gcs.ts';
import { callMcp } from './decision-proof-steps.ts';
import {
  launchActor,
  approveDeviceFromProcess,
  bootstrapOwner,
  inPage,
  nodeSignIn,
  pageCreatePasskey,
  sessionCookieParams,
  waitForOpened,
  waitForState,
  stepsFourAndFive,
  stepSeven,
  goto,
  click,
  poll,
  type CapturedMail,
  type Actor,
  type PrivateShareEnv,
} from './private-shares-steps.ts';

const scratch = await mkdtemp(join(tmpdir(), 'relic-settings-path-'));
const statePath = join(scratch, 'state.json');
const bundle = fileURLToPath(new URL('../dist/relic-mcp.js', import.meta.url));
const viewer = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const fake = fakeGcs();
const store = gcsStore({
  bucket: 'settings-proof',
  host: 'https://gcs.test',
  fetch: fake.fetch,
  getAccessToken: async () => 'test',
  prefix: 'settings-proof/m',
  ciphertextPrefix: 'settings-proof/r',
});
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
const mails: CapturedMail[] = [];
const options = {
  config: { serviceOrigin: origin },
  store,
  storage,
  assets: diskAssets(viewer),
  now: () => clock,
  mailer: {
    send: async (to: string, link: string, code?: string) => {
      mails.push({
        to,
        subject: 'sign-in',
        text: link,
        link,
        ...(code === undefined ? {} : { code }),
      });
    },
    sendMail: async (to: string, mail: { subject: string; text: string }) => {
      mails.push({ to, ...mail });
    },
  },
};
const apps = [createApp(options), createApp(options)];
const pausedApp = createApp({
  ...options,
  config: { serviceOrigin: origin, killSwitchEngaged: true },
});
let pauseNextSettings = false;
let pausedRequest: Request | undefined;
let pausedStatus = 0;
handle = async (request) => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const key = url.pathname.slice('/__storage/upload/'.length);
    storage.put(key, new Uint8Array(await request.arrayBuffer()));
    const customTime = request.headers.get('x-goog-custom-time');
    fake.objects.set(`settings-proof/r/${key}`, {
      body: '{}',
      generation: 1,
      ...(customTime === null ? {} : { customTime }),
    });
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const data = await storage.read(url.pathname.slice('/__storage/o/'.length));
    return data
      ? new Response(Buffer.from(data))
      : new Response('not found', { status: 404 });
  }
  if (
    pauseNextSettings &&
    request.method === 'POST' &&
    /^\/api\/relics\/[^/]+\/settings$/.test(url.pathname)
  ) {
    pauseNextSettings = false;
    pausedRequest = request.clone();
    const response = await pausedApp.fetch(request);
    pausedStatus = response.status;
    return response;
  }
  const which = url.searchParams.get('instance') === 'b' ? 1 : 0;
  return apps[which]!.fetch(request);
};
const mcp = (name: string, args: Record<string, unknown>) =>
  callMcp(['node', bundle], scratch, statePath, origin, name, args);

function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
const req = (path: string, method: string, body: unknown, cookie?: string) =>
  fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}instance=b`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const chromePath = process.env['RELIC_CHROME_PATH'];
if (!chromePath || chromePath === 'none')
  throw new Error('RELIC_CHROME_PATH must name an owned headless shell');
const env: PrivateShareEnv = {
  serviceOrigin: origin,
  scratchDir: scratch,
  statePath,
  mcpCommand: ['node', bundle],
  chromePath,
  owner: 'owner+settings@example.test',
  reader: 'reader+settings@example.test',
  third: 'third+settings@example.test',
  noPrf: 'noprf+settings@example.test',
  store,
  storage,
  mailbox: {
    mark: () => mails.length,
    all: () => mails,
    async await(to, since, match, label) {
      return poll(label, 20000, async () =>
        mails
          .slice(since)
          .find(
            (mail) => mail.to.toLowerCase() === to.toLowerCase() && match(mail)
          )
      );
    },
  },
  receipt: () => {},
  defect: (id, evidence) => {
    throw new Error(`DEFECT ${id}: ${evidence}`);
  },
};
const actors: Actor[] = [];

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
  assert.equal(denied.status, 409, '01_COMMENTS_CLOSED reader status');
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
  clock = Date.now();
  const owner = await launchActor(env, 'owner', env.owner, true);
  actors.push(owner);
  const privateFile = join(scratch, 'private-proof.txt');
  await Bun.write(privateFile, 'Private live settings proof\n');
  const ownerCookie = await nodeSignIn(env, env.owner);
  await owner.browser.cdp.send(
    'Network.setCookie',
    sessionCookieParams(env, ownerCookie),
    owner.browser.sessionId
  );
  await goto(owner.browser, `${origin}/dashboard`);
  await inPage(owner.browser, pageCreatePasskey, { prf: true });
  const ownerKeys = await bootstrapOwner(env, owner, ownerCookie);
  const enrollment = await mcp('relic_enroll_device', {
    label: 'settings proof',
  });
  const enrollmentId = text(enrollment.enrollment_id);
  const deviceFingerprint = text(enrollment.device_fingerprint);
  await approveDeviceFromProcess(
    env,
    owner,
    ownerKeys,
    enrollmentId,
    deviceFingerprint
  );
  await mcp('relic_confirm_device', {
    owner_fingerprint: await identityFingerprint(
      ownerKeys.identityId,
      env.owner
    ),
  });
  const privatePublished = await mcp('relic_publish', {
    path: privateFile,
    private: true,
  });
  const privateRelik = {
    relicId: text(privatePublished.relic_id),
    relicUrl: text(privatePublished.url),
    ownerKeys,
  };
  await goto(owner.browser, privateRelik.relicUrl);
  await waitForState(owner.browser, ['unlock'], 'owner unlock');
  await click(owner.browser, '[data-action="private-unlock"]');
  await waitForOpened(owner.browser, 'owner');
  await mcp('relic_settings', {
    relic_id: privateRelik.relicId,
    notifications: false,
  });
  const readerActor = await launchActor(env, 'reader', env.reader, true);
  actors.push(readerActor);
  const request = await stepsFourAndFive(
    env,
    owner,
    readerActor,
    privateRelik.relicId,
    privateRelik.relicUrl,
    privateRelik.ownerKeys
  );
  await stepSeven(
    env,
    owner,
    readerActor,
    privateRelik.relicId,
    privateRelik.relicUrl,
    request
  );
  console.log(
    '03_NOTIFICATIONS follower_control=received change_notice=none request=received grant=received'
  );

  await goto(owner.browser, privateRelik.relicUrl);
  await click(owner.browser, '[data-action="private-unlock"]');
  await waitForOpened(owner.browser, 'owner settings');
  await owner.browser.waitForSelector('[data-action="open-settings"]', 25000);
  const suggestBefore = await owner.browser.evaluate<boolean>(
    `!!document.querySelector('[data-sg-suggesting]')`
  );
  assert.equal(
    suggestBefore,
    true,
    'suggest control absent before changing settings'
  );
  await owner.browser.evaluate(`(() => {
    window.__settingsCredentialRequests = 0;
    const original = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (...args) => { window.__settingsCredentialRequests++; return original(...args); };
  })()`);
  await click(owner.browser, '[data-action="open-settings"]');
  await owner.browser.evaluate(
    `document.querySelector('#settings-panel input[role="switch"]').click()`
  );
  await click(owner.browser, '#settings-panel button[type="submit"]');
  await poll('settings saved', 25000, async () =>
    (
      await owner.browser.evaluate<string>(
        `document.querySelector('#settings-panel [role="status"]')?.textContent ?? ''`
      )
    ).includes('Saved')
      ? true
      : undefined
  );
  const taps = await owner.browser.evaluate<number>(
    'window.__settingsCredentialRequests'
  );
  assert.equal(taps, 1, 'owner settings must request exactly one credential');
  assert.equal(
    await owner.browser.evaluate<boolean>(
      `!!document.querySelector('[data-sg-suggesting]')`
    ),
    false,
    'suggest control remains after save'
  );
  assert.equal(
    await readerActor.browser.evaluate<boolean>(
      `!!document.querySelector('[data-action="open-settings"]')`
    ),
    false,
    'reader sees Settings control'
  );
  assert.equal(typeof published.url, 'string');
  const plainReader = await launchActor(
    env,
    'plain-reader',
    'plain@example.test',
    true
  );
  actors.push(plainReader);
  await goto(plainReader.browser, text(published.url));
  await poll('plain public reader', 25000, async () =>
    (
      await plainReader.browser.evaluate<string>('document.body.innerText')
    ).includes('settings.txt')
      ? true
      : undefined
  );
  assert.equal(
    await plainReader.browser.evaluate<boolean>(
      `!!document.querySelector('[data-action="open-settings"]')`
    ),
    false,
    'plain reader sees Settings control'
  );
  console.log(
    '04_OWNER_SETTINGS taps=1 suggest_before=present suggest_after=absent reader_settings=absent'
  );
  pauseNextSettings = true;
  await owner.browser.evaluate(
    `document.querySelector('#settings-panel input[role="switch"]').click()`
  );
  await click(owner.browser, '#settings-panel button[type="submit"]');
  await poll('paused settings response', 25000, async () =>
    pausedStatus ? true : undefined
  );
  assert.equal(pausedStatus, 503, 'paused settings write was not refused');
  assert.ok(pausedRequest, 'paused write was not captured');
  const replay = await apps[0]!.fetch(pausedRequest);
  assert.equal(
    replay.status,
    200,
    `paused request consumed its challenge: ${await replay.clone().text()}`
  );

  const beforeExtend = [...fake.objects.keys()].filter((name) =>
    name.includes(privateRelik.relicId)
  );
  assert.ok(
    beforeExtend.some((name) => name.startsWith('settings-proof/r/')),
    'private ciphertext absent from fake GCS'
  );
  assert.ok(
    beforeExtend.some((name) => name.startsWith('settings-proof/m/')),
    'private metadata absent from fake GCS'
  );
  await mcp('relic_settings', { relic_id: privateRelik.relicId, ttl_days: 90 });
  const extendedRow = await store.getRelic(privateRelik.relicId);
  assert.ok(extendedRow?.expiresAt);
  const extendedTime = new Date(extendedRow.expiresAt).toISOString();
  for (const name of beforeExtend)
    assert.equal(
      fake.objects.get(name)?.customTime,
      extendedTime,
      `customTime not extended for ${name}`
    );
  await mcp('relic_settings', { relic_id: privateRelik.relicId, ttl_days: 1 });
  const shortened = await store.getRelic(privateRelik.relicId);
  assert.ok(shortened?.expiresAt);
  assert.ok(shortened.expiresAt < extendedRow.expiresAt);
  for (const name of [...fake.objects.keys()].filter((key) =>
    key.includes(privateRelik.relicId)
  ))
    assert.equal(
      fake.objects.get(name)?.customTime,
      extendedTime,
      `customTime moved backwards for ${name}`
    );
  clock = shortened.expiresAt + 1;
  const expired = await req(
    `/api/relics/${privateRelik.relicId}/mint`,
    'POST',
    {}
  );
  assert.equal(expired.status, 410, await expired.clone().text());
  console.log(
    `05_PRIVATE_LIFETIME prefix=nonempty objects=${beforeExtend.length} extended=true shortened=410 erasure=retained`
  );
  console.log('06_PAUSED_SETTINGS refused=503 same_challenge_after_resume=200');
  console.log('SETTINGS_PATH_OK');
} catch (error) {
  console.error(
    `SETTINGS_PATH_BLOCKED ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  for (const actor of actors) await actor.browser.close().catch(() => {});
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
