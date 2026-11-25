/**
 * Signing loopback acceptance path.
 * RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/signing-path.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeKey,
  deriveCommentKey,
  encryptComment,
  deriveShareProof,
  encodeKey,
  encryptRelic,
} from '@relic/format';
import {
  deriveSigningKey,
  sealSignatureMark,
  markCiphertextSha256,
  type SigningRequestJSON,
} from '@relic/format/signing';
import { contentFromBytes } from '../../relic-viewer/src/content.ts';
import { verifyViewerSigningRequest } from '../../relic-viewer/src/signing/api.ts';
import {
  identityFingerprint,
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  statementBytes,
  parseStatement,
} from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { callMcp } from './decision-proof-steps.ts';
import { clickPrivateControl } from './confirmation-private-proof.ts';
import { harnessEnv } from './harness-env.ts';
import { pageSigningAssertion } from './signing-proof-steps.ts';
import {
  approveDeviceFromProcess,
  bootstrapOwner,
  goto,
  inPage,
  launchActor,
  nodeSignIn,
  pageCreatePasskey,
  poll,
  sessionCookieParams,
  click,
  waitForState,
  waitForOpened,
  stepsFourAndFive,
  stepSeven,
  openPanel,
  callMcpRaw,
  type Actor,
  type CapturedMail,
  type PrivateShareEnv,
} from './private-shares-steps.ts';

const chromePath = process.env['RELIC_CHROME_PATH'];
if (!chromePath || chromePath === 'none')
  throw new Error('RELIC_CHROME_PATH must name an owned headless shell');
const scratch = await mkdtemp(join(tmpdir(), 'relik-signing-path-'));
const statePath = join(scratch, 'state.json');
const bundle = fileURLToPath(new URL('../dist/relic-mcp.js', import.meta.url));
const viewer = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const store = new MemoryStore();
const mails: CapturedMail[] = [];
const actors: Actor[] = [];
let handler: ((request: Request) => Promise<Response>) | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    handler ? handler(request) : new Response('not ready', { status: 503 }),
});
const origin = `http://localhost:${server.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const options = {
  config: { serviceOrigin: origin },
  store,
  storage,
  assets: diskAssets(viewer),
  now: () => Date.now(),
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
let pauseSignature = false;
let pausedSignature: Request | undefined;
let pausedSignatureStatus = 0;
let next = 0;
let denyOpenedFor = '';
let deleteStatus = 0;
handler = async (request) => {
  const url = new URL(request.url);
  if (
    denyOpenedFor &&
    url.pathname === `/api/relics/${denyOpenedFor}/receipts/opened`
  ) {
    return Response.json({ code: 'service_paused' }, { status: 503 });
  }
  if (pauseSignature && url.pathname.endsWith('/signing/signatures')) {
    pauseSignature = false;
    // Buffer the body: cloning a streaming request races the early refusal,
    // which answers without reading it, and left the replay with no body.
    const body = await request.arrayBuffer();
    const copy = () =>
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body.slice(0),
      });
    pausedSignature = copy();
    const response = await pausedApp.fetch(copy());
    pausedSignatureStatus = response.status;
    return response;
  }
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
  const response = await apps[next++ % 2]!.fetch(request);
  if (url.pathname.endsWith('/delete')) deleteStatus = response.status;
  return response;
};
const mcp = (name: string, args: Record<string, unknown>) =>
  callMcp(['node', bundle], scratch, statePath, origin, name, args);
const env: PrivateShareEnv = {
  serviceOrigin: origin,
  scratchDir: scratch,
  statePath,
  mcpCommand: ['node', bundle],
  chromePath,
  owner: 'owner+signing@example.test',
  reader: 'ana+signing@example.test',
  third: 'ben+signing@example.test',
  noPrf: 'other+signing@example.test',
  store,
  storage,
  receipt: () => {},
  defect: (id, evidence) => {
    throw new Error(`DEFECT ${id}: ${evidence}`);
  },
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
};
function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
try {
  const settingsProof = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./settings-path.ts', import.meta.url)),
    ],
    {
      cwd: scratch,
      env: harnessEnv(scratch, join(scratch, 'settings-state.json'), {
        serviceOrigin: origin,
        chromePath,
        clientName: 'relic-mcp/signing-proof',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [settingsOutput, settingsErrors, settingsExit] = await Promise.all([
    new Response(settingsProof.stdout).text(),
    new Response(settingsProof.stderr).text(),
    settingsProof.exited,
  ]);
  assert.equal(settingsExit, 0, settingsErrors);
  assert.ok(settingsOutput.includes('SETTINGS_PATH_OK'));
  for (const receipt of [
    '01_COMMENTS_CLOSED',
    '03_NOTIFICATIONS',
    '04_OWNER_SETTINGS',
    '05_PRIVATE_LIFETIME',
  ])
    assert.ok(settingsOutput.includes(receipt), receipt);
  assert.ok(settingsOutput.includes('05_PRIVATE_LIFETIME'));
  const toolsProcess = Bun.spawn(['node', bundle], {
    cwd: scratch,
    env: harnessEnv(scratch, statePath, {
      serviceOrigin: origin,
      chromePath: 'none',
      clientName: 'relic-mcp/signing-proof',
    }),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  toolsProcess.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`
  );
  toolsProcess.stdin.end();
  const [toolsOutput, toolsErrors, toolsExit] = await Promise.all([
    new Response(toolsProcess.stdout).text(),
    new Response(toolsProcess.stderr).text(),
    toolsProcess.exited,
  ]);
  assert.equal(toolsExit, 0, toolsErrors);
  const listedTools = JSON.parse(toolsOutput.trim().split('\n').at(-1) ?? '{}');
  assert.ok(Array.isArray(listedTools.result.tools));
  const signingTools: string[] = listedTools.result.tools.map(
    (tool: { name: string }) => tool.name
  );
  assert.ok(signingTools.includes('relic_request_signatures'));
  assert.ok(signingTools.includes('relic_verify_certificate'));
  assert.equal(
    signingTools.some((name) =>
      /^relic_(?:sign(?:_|$)|record.*(?:sign|receipt))/.test(name)
    ),
    false
  );
  const owner = await launchActor(env, 'owner', env.owner, true);
  actors.push(owner);
  const cookie = await nodeSignIn(env, env.owner);
  await owner.browser.cdp.send(
    'Network.setCookie',
    sessionCookieParams(env, cookie),
    owner.browser.sessionId
  );
  await goto(owner.browser, `${origin}/dashboard`);
  await inPage(owner.browser, pageCreatePasskey, { prf: true });
  const ownerKeys = await bootstrapOwner(env, owner, cookie);
  const enrollment = await mcp('relic_enroll_device', {
    label: 'signing proof',
  });
  await approveDeviceFromProcess(
    env,
    owner,
    ownerKeys,
    text(enrollment.enrollment_id),
    text(enrollment.device_fingerprint)
  );
  await mcp('relic_confirm_device', {
    owner_fingerprint: await identityFingerprint(
      ownerKeys.identityId,
      env.owner
    ),
  });
  const file = join(scratch, 'signing-proof.txt');
  await Bun.write(file, 'Signing acceptance path\n');
  const published = await mcp('relic_publish', {
    path: file,
    title: 'Signing acceptance',
    cover: false,
    ttl_days: 1,
  });
  const id = text(published.relic_id);
  await Bun.write(file, 'Signing acceptance version two\n');
  const v2 = await mcp('relic_republish', {
    relic_id: id,
    path: file,
    cover: false,
  });
  assert.equal(v2.version, 2);
  await Bun.write(file, 'Signing acceptance version three\n');
  const v3 = await mcp('relic_republish', {
    relic_id: id,
    path: file,
    cover: false,
  });
  assert.equal(v3.version, 3);
  const publicMailStart = mails.length;
  const request = await mcp('relic_request_signatures', {
    relic_id: id,
    signers: [{ email: env.reader }, { email: env.third }],
    order: 'sequential',
  });
  assert.equal(request.status, 'open');
  assert.equal(request.order, 'sequential');
  assert.ok(Array.isArray(request.invitations));
  assert.equal(request.invitations.length, 2);
  for (const invite of request.invitations)
    assert.ok(text(invite.text).includes('#'));
  console.log(
    'PUBLIC_REQUEST_CREATED signers=2 order=sequential invitations_have_fragment=true'
  );
  const ben = await launchActor(env, 'ben', env.third, true);
  actors.push(ben);
  const benCookie = await nodeSignIn(env, env.third);
  await ben.browser.cdp.send(
    'Network.setCookie',
    sessionCookieParams(env, benCookie),
    ben.browser.sessionId
  );
  await goto(ben.browser, `${origin}/dashboard`);
  await inPage(ben.browser, pageCreatePasskey, { prf: true });
  await goto(ben.browser, text(published.url));
  const localState = JSON.parse(await readFile(statePath, 'utf8'));
  const commentCiphertext = await encryptComment(
    await deriveCommentKey(decodeKey(localState.relics[id].key)),
    {
      body: 'Owner test comment',
      display_name: null,
      anchor: null,
    }
  );
  await mcp('relic_settings', { relic_id: id, comments: false });
  const commentPost = (body: unknown, session?: string) =>
    apps[1]!.fetch(
      new Request(`${origin}/api/relics/${id}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(session ? { cookie: session } : {}),
        },
        body: JSON.stringify(body),
      })
    );
  const readerComment = await commentPost(
    { ciphertext: commentCiphertext },
    benCookie
  );
  assert.equal(readerComment.status, 409);
  assert.equal(
    ((await readerComment.json()) as { code: string }).code,
    'comments_closed'
  );
  const ownerComment = await commentPost(
    { ciphertext: commentCiphertext },
    cookie
  );
  assert.equal(ownerComment.status, 201, await ownerComment.clone().text());
  const publisherComment = await commentPost({
    ciphertext: commentCiphertext,
    publish_token: localState.relics[id].publish_token,
  });
  assert.equal(
    publisherComment.status,
    201,
    await publisherComment.clone().text()
  );
  for (const response of [ownerComment, publisherComment]) {
    const entry = (await response.json()) as { comment_id: string };
    const resolved = await apps[1]!.fetch(
      new Request(`${origin}/api/relics/${id}/comments/${entry.comment_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: localState.relics[id].publish_token,
          resolved: true,
        }),
      })
    );
    assert.equal(resolved.status, 200);
  }
  await mcp('relic_settings', { relic_id: id, comments: true });
  const noIdentity = await apps[1]!.fetch(
    new Request(`${origin}/api/attest/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({ purpose: 'relic_settings', relic_id: id }),
    })
  );
  assert.equal(noIdentity.status, 409, await noIdentity.clone().text());
  await goto(owner.browser, text(published.url));
  await owner.browser.waitForSelector('[data-action="open-settings"]', 25000);
  await owner.browser.evaluate(`(() => {
    window.__settingsTaps = 0;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (...args) => { window.__settingsTaps++; return get(...args); };
  })()`);
  await click(owner.browser, '[data-action="open-settings"]');
  await owner.browser.evaluate(
    `document.querySelector('#settings-panel input[role="switch"]').click()`
  );
  await click(owner.browser, '#settings-panel button[type="submit"]');
  await poll('owner settings saved', 25000, async () =>
    (
      await owner.browser.evaluate<string>(
        `document.querySelector('#settings-panel [role="status"]')?.textContent ?? ''`
      )
    ).includes('Saved')
      ? true
      : undefined
  );
  assert.equal(
    await owner.browser.evaluate<number>('window.__settingsTaps'),
    1
  );
  await goto(
    owner.browser,
    `${origin}/${id}?settings-reload=1${new URL(text(published.url)).hash}`
  );
  await poll('owner reload', 25000, async () =>
    (await owner.browser.evaluate<boolean>(
      `document.body.innerText.includes('signing-proof.txt')`
    ))
      ? true
      : undefined
  );
  assert.equal(
    await owner.browser.evaluate<boolean>(
      `!!document.querySelector('[data-sg-suggesting]')`
    ),
    false
  );
  await mcp('relic_settings', { relic_id: id, suggestions: true });
  const proof = encodeKey(
    await deriveShareProof(decodeKey(localState.relics[id].key))
  );
  const requestRead = await fetch(`${origin}/api/relics/${id}/signing/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ share_proof: proof }),
  });
  assert.equal(requestRead.status, 200);
  const wire = (await requestRead.json()) as { requests: SigningRequestJSON[] };
  const signedRequest = wire.requests[0]!;
  const verifiedLayout = await verifyViewerSigningRequest({
    request: signedRequest,
    relicId: id,
    version: 3,
    digest: text(signedRequest.request.statement.ciphertext_sha256),
    content: contentFromBytes(
      new TextEncoder().encode('Signing acceptance version three\n')
    ),
    signingKey: await deriveSigningKey(decodeKey(localState.relics[id].key)),
    access: 'public',
    origin,
    pdf: false,
  });
  assert.deepEqual(verifiedLayout, { v: 1, boxes: [] });
  const storedRequest = await store.getSigningRequest(
    id,
    text(request.request_id)
  );
  assert.ok(storedRequest);
  assert.ok(!JSON.stringify(storedRequest).includes('"boxes"'));
  await assert.rejects(
    verifyViewerSigningRequest({
      request: signedRequest,
      relicId: id,
      version: 3,
      digest: text(signedRequest.request.statement.ciphertext_sha256),
      content: contentFromBytes(new TextEncoder().encode('A swapped document')),
      signingKey: await deriveSigningKey(decodeKey(localState.relics[id].key)),
      access: 'public',
      origin,
      pdf: false,
    }),
    /signing_content_mismatch/
  );
  console.log('VIEWER_CONTENT_MAC swapped_content=refused');
  const refusal = await ben.browser.evaluate<{
    status: number;
    code: string;
  }>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${id}/signing/options`)}, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({request_id: ${JSON.stringify(request.request_id)}, share_proof: ${JSON.stringify(proof)}})
    });
    return {status: response.status, code: (await response.json()).code};
  })()`);
  await ben.browser.waitForSelector('[data-action="open-signing"]', 25000);
  await click(ben.browser, '[data-action="open-signing"]');
  await poll('out of turn message', 15000, async () =>
    (await ben.browser.evaluate<boolean>(
      `document.querySelector('.signing-panel')?.textContent.includes(${JSON.stringify(`Waiting for ${env.reader} to sign first.`)}) && !Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here' && !b.disabled)`
    ))
      ? true
      : undefined
  );
  assert.deepEqual(refusal, { status: 409, code: 'signing_not_your_turn' });
  console.log('SIGNING_STEP_4_OUT_OF_TURN options=409');
  const reader = await launchActor(env, 'ana', env.reader, true);
  actors.push(reader);
  const readerCookie = await nodeSignIn(env, env.reader);
  await reader.browser.cdp.send(
    'Network.setCookie',
    sessionCookieParams(env, readerCookie),
    reader.browser.sessionId
  );
  await goto(reader.browser, `${origin}/dashboard`);
  await inPage(reader.browser, pageCreatePasskey, { prf: true });
  await mcp('relic_settings', { relic_id: id, signing: false });
  await goto(reader.browser, text(published.url));
  await poll('paused signing notice', 15000, async () =>
    (await reader.browser.evaluate<boolean>(
      `document.body.innerText.includes('Signing is paused by the owner.') && !!Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here' && b.disabled)`
    ))
      ? true
      : undefined
  );
  console.log('SIGNING_PAUSED notice=present sign=disabled');
  await mcp('relic_settings', { relic_id: id, signing: true });
  await goto(
    reader.browser,
    `${origin}/${id}?refresh=signing${new URL(text(published.url)).hash}`
  );
  await poll('sign here button', 15000, async () =>
    (await reader.browser.evaluate<boolean>(
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here')`
    ))
      ? true
      : undefined
  ).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await reader.browser.evaluate<string>('document.body.innerText')}`
    );
  });
  await reader.browser.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here').click()`
  );
  await reader.browser.waitForSelector('.signing-panel input');
  await reader.browser.evaluate(`(() => {
    const panel = document.querySelector('.signing-panel');
    const name = panel.querySelector('input:not([type=checkbox])');
    name.value = 'Ana Signer';
    name.dispatchEvent(new Event('input', {bubbles:true}));
    panel.querySelector('input[type=checkbox]').click();
  })()`);
  await poll('signature prepared', 15000, async () =>
    (await reader.browser.evaluate<boolean>(
      `!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`
    ))
      ? true
      : undefined
  ).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await reader.browser.evaluate<string>('document.body.innerText')}`
    );
  });
  await reader.browser.evaluate(`(() => {
    window.__signTaps = 0;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (...args) => { window.__signTaps++; return get(...args); };
  })()`);
  pauseSignature = true;
  await reader.browser.evaluate(
    `document.querySelector('.signing-panel .sign-row button.primary').click()`
  );
  await poll('paused signature response', 15000, async () =>
    pausedSignatureStatus ? true : undefined
  );
  assert.equal(pausedSignatureStatus, 503);
  assert.equal(await reader.browser.evaluate<number>('window.__signTaps'), 1);
  assert.ok(pausedSignature);
  const resumedSignature = await apps[0]!.fetch(pausedSignature);
  assert.equal(
    resumedSignature.status,
    201,
    await resumedSignature.clone().text()
  );
  console.log('SIGNING_KILL_SWITCH refused=503 challenge_preserved=true');
  await poll('first signature', 15000, async () => {
    const result = await mcp('relic_read_signing', { relic_id: id });
    const requests = result.requests as Array<{
      signers: Array<{ status: string }>;
    }>;
    return requests[0]?.signers[0]?.status === 'signed' ? true : undefined;
  });
  assert.ok(
    mails
      .slice(publicMailStart)
      .some(
        (mail) => mail.to === env.third && mail.subject.includes('turn to sign')
      )
  );
  console.log('PUBLIC_SIGNER_1 signed=true');
  const mismatchOptionsResponse = await fetch(
    `${origin}/api/relics/${id}/signing/options`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({
        request_id: request.request_id,
        share_proof: proof,
      }),
    }
  );
  assert.equal(mismatchOptionsResponse.status, 200);
  const mismatchOptions = (await mismatchOptionsResponse.json()) as {
    nonce: string;
    public_key: { rpId: string; allowCredentials: Array<{ id: string }> };
    request_sha256: string;
    version_digest: string;
    opened_receipt_sha256: string | null;
  };
  const mark = await sealSignatureMark({
    signingKey: await deriveSigningKey(decodeKey(localState.relics[id].key)),
    relicId: id,
    version: 3,
    mark: { v: 1, name: 'Ben Signer', strokes: null },
  });
  const mismatchStatement = parseStatement('signature', {
    at: Date.now(),
    ciphertext_sha256: mismatchOptions.version_digest,
    consent: 'relic/sign-consent/v1',
    content_mac: '0'.repeat(64),
    mark_sha256: markCiphertextSha256(mark),
    opened_receipt_sha256: mismatchOptions.opened_receipt_sha256,
    relic_id: id,
    request_id: request.request_id,
    request_sha256: mismatchOptions.request_sha256,
    signer_email: env.third,
    signer_identity_id: null,
    signer_index: 1,
    version: 3,
  });
  const challenge = await attestationChallenge(
    decodeBase64url(mismatchOptions.nonce),
    [statementBytes('signature', mismatchStatement)]
  );
  const mismatchCredential = await inPage(ben.browser, pageSigningAssertion, {
    challenge: encodeBase64url(challenge),
    rpId: mismatchOptions.public_key.rpId,
    allowCredentials: mismatchOptions.public_key.allowCredentials,
  });
  const mismatchResponse = await fetch(
    `${origin}/api/relics/${id}/signing/signatures`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({
        request_id: request.request_id,
        share_proof: proof,
        mark_ciphertext: mark,
        attestation: {
          nonce: mismatchOptions.nonce,
          statements: [
            {
              kind: 'signature',
              statement: mismatchStatement,
              identity_signature: '',
            },
          ],
          credential: mismatchCredential,
        },
      }),
    }
  );
  assert.equal(
    mismatchResponse.status,
    409,
    await mismatchResponse.clone().text()
  );
  const mismatchBody = (await mismatchResponse.json()) as { code: string };
  assert.equal(mismatchBody.code, 'signing_content_mismatch');
  await Bun.write(file, 'Changed signing acceptance content\n');
  const openRepublish = await callMcpRaw(env, 'relic_republish', {
    relic_id: id,
    path: file,
    cover: false,
  });
  assert.equal(openRepublish.isError, true);
  assert.equal(openRepublish.structured.code, 'signing_in_progress');
  await Bun.write(file, 'Signing acceptance version three\n');
  console.log('SIGNING_STEP_6_REPUBLISH_WHILE_OPEN 409 signing_in_progress');
  await goto(
    ben.browser,
    `${origin}/${id}?refresh=1${new URL(text(published.url)).hash}`
  );
  await poll('ben sign here button', 15000, async () =>
    (await ben.browser.evaluate<boolean>(
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here')`
    ))
      ? true
      : undefined
  );
  await ben.browser.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here').click()`
  );
  await ben.browser.waitForSelector('.signing-panel input');
  await ben.browser.evaluate(`(() => {
    const panel = document.querySelector('.signing-panel');
    const name = panel.querySelector('input:not([type=checkbox])');
    name.value = 'Ben Signer';
    name.dispatchEvent(new Event('input', {bubbles:true}));
    Array.from(panel.querySelectorAll('button')).find(b => b.textContent === 'Draw').click();
  })()`);
  const rect = await ben.browser.evaluate<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('.mark-pad canvas').getBoundingClientRect(); return {x:r.left + r.width / 3, y:r.top + r.height / 2}; })()`
  );
  await ben.browser.cdp.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    },
    ben.browser.sessionId
  );
  await ben.browser.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: rect.x + 40, y: rect.y + 10, button: 'left' },
    ben.browser.sessionId
  );
  await ben.browser.cdp.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseReleased',
      x: rect.x + 40,
      y: rect.y + 10,
      button: 'left',
      clickCount: 1,
    },
    ben.browser.sessionId
  );
  await ben.browser.evaluate(
    `document.querySelector('.signing-panel input[type=checkbox]').click()`
  );
  await poll('ben signature prepared', 15000, async () =>
    (await ben.browser.evaluate<boolean>(
      `!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`
    ))
      ? true
      : undefined
  ).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await ben.browser.evaluate<string>('document.body.innerText')}`
    );
  });
  await ben.browser.evaluate(
    `document.querySelector('.signing-panel .sign-row button.primary').click()`
  );
  await poll('completed signing', 15000, async () => {
    const result = await mcp('relic_read_signing', { relic_id: id });
    const requests = result.requests as Array<{ status: string }>;
    return requests[0]?.status === 'complete' ? true : undefined;
  });
  const completionMails = mails
    .slice(publicMailStart)
    .filter((mail) => mail.subject.startsWith('Everyone signed'));
  assert.equal(completionMails.length, 3);
  assert.deepEqual((await store.getRelic(id))?.lockedVersions, [3]);
  assert.ok(
    completionMails.every(
      (mail) =>
        Array.isArray(Reflect.get(mail, 'attachments')) &&
        Reflect.get(mail, 'attachments').length === 1
    )
  );
  assert.ok(
    mails
      .slice(publicMailStart)
      .filter((mail) => mail.subject.includes('sign'))
      .every((mail) => !mail.text.includes('#'))
  );
  console.log('PUBLIC_SIGNER_2 complete=true drawn=true');
  await goto(
    ben.browser,
    `${origin}/${id}?refresh=2${new URL(text(published.url)).hash}`
  );
  await ben.browser.waitForSelector('[data-action="open-signing"]', 25000);
  await ben.browser.evaluate(
    `document.querySelector('[data-action="open-signing"]').click()`
  );
  await poll('certificate control', 15000, async () =>
    (await ben.browser.evaluate<boolean>(
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'View certificate')`
    ))
      ? true
      : undefined
  );
  await ben.browser.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'View certificate').click()`
  );
  await ben.browser.waitForSelector('.certificate-view', 25000);
  const label = await ben.browser.evaluate<string>(
    `document.querySelector('.certificate-result').textContent`
  );
  assert.ok(
    label.includes('owner identity has not been independently checked'),
    label
  );
  await ben.browser.cdp.send(
    'Page.setDownloadBehavior',
    { behavior: 'allow', downloadPath: scratch },
    ben.browser.sessionId
  );
  await ben.browser.evaluate(
    `Array.from(document.querySelectorAll('.certificate-view button')).find(b => b.textContent === 'Download certificate').click()`
  );
  const certificatePath = join(scratch, `relik-${id}-v3-signing.json`);
  await poll('browser certificate download', 15000, async () =>
    (await Bun.file(certificatePath).exists()) ? true : undefined
  );
  const verified = await mcp('relic_verify_certificate', {
    certificate_path: certificatePath,
    file_path: file,
    trusted_owner_identity_id: ownerKeys.identityId,
  });
  assert.equal(verified.valid, true, JSON.stringify(verified));
  assert.equal(verified.content, 'match');
  const unchecked = await mcp('relic_verify_certificate', {
    certificate_path: certificatePath,
    file_path: file,
  });
  assert.equal(unchecked.valid, false);
  assert.equal((unchecked.trust as { owner: string }).owner, 'unchecked');
  console.log(
    'PUBLIC_CERTIFICATE downloaded=true trusted=valid untrusted=unchecked content=match'
  );
  await Bun.write(file, 'Changed signing acceptance content\n');
  const lockedRepublish = await callMcpRaw(env, 'relic_republish', {
    relic_id: id,
    path: file,
    cover: false,
  });
  assert.equal(lockedRepublish.isError, true);
  assert.equal(lockedRepublish.structured.code, 'version_locked');
  const mismatched = await mcp('relic_verify_certificate', {
    certificate_path: certificatePath,
    file_path: file,
    trusted_owner_identity_id: ownerKeys.identityId,
  });
  assert.equal(mismatched.content, 'mismatch');
  assert.equal(mismatched.valid, false);
  const tamperedCertificate = JSON.parse(
    await readFile(certificatePath, 'utf8')
  );
  tamperedCertificate.signatures[0].statement.signer_email =
    'changed@example.test';
  const tamperedPath = join(scratch, 'tampered-signing.json');
  await Bun.write(tamperedPath, JSON.stringify(tamperedCertificate));
  const tampered = await mcp('relic_verify_certificate', {
    certificate_path: tamperedPath,
    trusted_owner_identity_id: ownerKeys.identityId,
  });
  assert.equal(tampered.valid, false);
  console.log(
    'PUBLIC_LOCK republish=409 content_swap=mismatch field_flip=invalid'
  );
  const privateFile = join(scratch, 'private-proof.txt');
  const privateMailStart = mails.length;
  await Bun.write(privateFile, 'Private signing acceptance path\n');
  const privatePublished = await mcp('relic_publish', {
    path: privateFile,
    private: true,
  });
  const privateId = text(privatePublished.relic_id);
  const privateUrl = text(privatePublished.url);
  await goto(owner.browser, privateUrl);
  await waitForState(owner.browser, ['unlock'], 'private owner unlock');
  await click(owner.browser, '[data-action="private-unlock"]');
  await waitForOpened(owner.browser, 'private owner');
  const privateEnv: PrivateShareEnv = {
    ...env,
    reader: 'private-ana+signing@example.test',
  };
  const privateReader = await launchActor(
    privateEnv,
    'private-ana',
    privateEnv.reader,
    true
  );
  actors.push(privateReader);
  const privateIdentity = await stepsFourAndFive(
    privateEnv,
    owner,
    privateReader,
    privateId,
    privateUrl,
    ownerKeys
  );
  const missingGrantResult = await callMcpRaw(
    privateEnv,
    'relic_request_signatures',
    {
      relic_id: privateId,
      signers: [{ email: privateEnv.reader }],
    }
  );
  assert.equal(missingGrantResult.isError, true);
  assert.equal(missingGrantResult.structured.code, 'recipient_forged_grant');
  console.log('SIGNING_STEP_10_NO_GRANT signer_without_grant=refused_by_mcp');
  const privateInvitations = mails.filter(
    (mail) =>
      mail.to === privateEnv.reader && mail.subject.includes('turn to sign')
  );
  assert.equal(
    privateInvitations.length,
    0,
    'private invitation was sent before a grant'
  );
  denyOpenedFor = privateId;
  await stepSeven(
    privateEnv,
    owner,
    privateReader,
    privateId,
    privateUrl,
    privateIdentity
  );
  const privateRequest = await mcp('relic_request_signatures', {
    relic_id: privateId,
    signers: [{ email: env.owner }, { email: privateEnv.reader }],
    order: 'parallel',
    require_opened: true,
  });
  assert.equal(privateRequest.status, 'open');
  const deniedOpened = await privateReader.browser.evaluate<{
    status: number;
    code: string;
  }>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${privateId}/signing/options`)}, {
      method:'POST', headers: {'content-type':'application/json'}, body:JSON.stringify({request_id:${JSON.stringify(privateRequest.request_id)}})
    });
    return {status:response.status, code:(await response.json()).code};
  })()`);
  assert.deepEqual(deniedOpened, {
    status: 409,
    code: 'signing_open_required',
  });
  denyOpenedFor = '';
  await goto(privateReader.browser, `${privateUrl}?refresh=1`);
  await waitForState(
    privateReader.browser,
    ['unlock'],
    'private reader unlock'
  );
  await click(privateReader.browser, '[data-action="private-unlock"]');
  await waitForOpened(privateReader.browser, 'private reader');
  const receipts = await poll('private opened receipt', 15000, async () => {
    const rows = (await store.listReceipts(privateId, 1)).filter(
      (row) => row.identityId === privateIdentity.identityId
    );
    return rows.some((row) => row.kind === 'opened') &&
      rows.some((row) => row.kind === 'served')
      ? rows
      : undefined;
  });
  assert.equal(
    receipts.some((row) => row.kind === 'served'),
    true
  );
  console.log(
    'PRIVATE_RECEIPTS delivered=true opened=true require_opened_refused=409'
  );
  for (const [actor, signerName] of [
    [privateReader, 'Private Ana'],
    [owner, 'Private Owner'],
  ] as const) {
    if (actor === owner) {
      await goto(owner.browser, `${privateUrl}?refresh=owner`);
      await waitForState(
        owner.browser,
        ['unlock'],
        'private owner unlock for signing'
      );
      await click(owner.browser, '[data-action="private-unlock"]');
      await waitForOpened(owner.browser, 'private owner signing');
    }
    await poll(`${signerName} sign control`, 15000, async () =>
      (await actor.browser.evaluate<boolean>(
        `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here' && !b.disabled)`
      ))
        ? true
        : undefined
    );
    await actor.browser.evaluate(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here' && !b.disabled).click()`
    );
    await actor.browser.waitForSelector('.signing-panel input');
    await actor.browser.evaluate(`(() => {
      const panel = document.querySelector('.signing-panel');
      const name = panel.querySelector('input:not([type=checkbox])');
      name.value = ${JSON.stringify(signerName)};
      name.dispatchEvent(new Event('input', {bubbles:true}));
      panel.querySelector('input[type=checkbox]').click();
    })()`);
    await poll(`${signerName} signature prepared`, 15000, async () =>
      (await actor.browser.evaluate<boolean>(
        `!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`
      ))
        ? true
        : undefined
    ).catch(async (error) => {
      throw new Error(
        `${error.message}: ${await actor.browser.evaluate<string>('document.body.innerText')}`
      );
    });
    await actor.browser.evaluate(
      `document.querySelector('.signing-panel .sign-row button.primary').click()`
    );
    await poll(`${signerName} signed`, 15000, async () => {
      const result = await mcp('relic_read_signing', { relic_id: privateId });
      const requests = result.requests as Array<{
        signers: Array<{ email: string; status: string }>;
      }>;
      return requests[0]?.signers.some(
        (s) => s.email === actor.email && s.status === 'signed'
      )
        ? true
        : undefined;
    });
  }
  const privateCert = join(scratch, 'private-signing.json');
  await mcp('relic_read_signing', {
    relic_id: privateId,
    save_certificate_to: privateCert,
  });
  const privateResult = await mcp('relic_verify_certificate', {
    certificate_path: privateCert,
    file_path: privateFile,
    trusted_owner_identity_id: ownerKeys.identityId,
  });
  assert.equal(privateResult.valid, true, JSON.stringify(privateResult));
  assert.equal(privateResult.content, 'match');
  const parsedPrivateCert = JSON.parse(await readFile(privateCert, 'utf8'));
  assert.equal(parsedPrivateCert.signatures.length, 2);
  assert.ok(
    parsedPrivateCert.signatures.every(
      (s: { identity_signature: string; receipts: { opened: unknown } }) =>
        s.identity_signature && s.receipts.opened
    )
  );
  console.log(
    'PRIVATE_COMPLETE signers=2 identity_signatures=2 opened_receipts=2 certificate=valid'
  );
  const privateMails = mails
    .slice(privateMailStart)
    .filter((mail) => mail.subject !== 'sign-in');
  assert.ok(privateMails.length > 0);
  assert.ok(
    privateMails.every(
      (mail) => !JSON.stringify(mail).includes('private-proof.txt')
    )
  );
  const comments = await mcp('relic_read_comments', { relic_id: privateId });
  assert.ok(Array.isArray(comments.comments));
  for (const comment of comments.comments) {
    const status = await privateReader.browser.evaluate<number>(
      `fetch(${JSON.stringify(`/api/relics/${privateId}/comments/`)} + ${JSON.stringify(comment.comment_id)}, {method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({resolved:true})}).then(r => r.status)`
    );
    assert.equal(status, 200);
  }
  await Bun.write(privateFile, 'Private signing acceptance path version two\n');
  const republished = await mcp('relic_republish', {
    relic_id: privateId,
    path: privateFile,
  });
  assert.equal(republished.version, 2);
  await openPanel(owner, privateUrl);
  await clickPrivateControl(owner.browser, '[data-action="delete-relic"]');
  await owner.browser.waitForSelector('#delete-dialog[open]', 25000);
  await owner.browser.evaluate(
    `document.querySelector('input[data-delete-version="1"]').click()`
  );
  await click(owner.browser, '[data-action="confirm-delete"]');
  await poll('private locked version refusal', 15000, async () =>
    deleteStatus ? true : undefined
  );
  assert.equal(deleteStatus, 409);
  assert.ok((await store.getRelic(privateId))?.lockedVersions?.includes(1));
  console.log(
    'PRIVATE_LOCK republish=2 delete_locked_version=409 mails_name_title=false'
  );
  const cancelFile = join(scratch, 'cancel-proof.txt');
  await Bun.write(cancelFile, 'Cancellation acceptance path\n');
  const cancelPublished = await mcp('relic_publish', {
    path: cancelFile,
    cover: false,
  });
  const cancelId = text(cancelPublished.relic_id);
  const cancelRequest = await mcp('relic_request_signatures', {
    relic_id: cancelId,
    signers: [{ email: env.reader }],
  });
  const cancelState = JSON.parse(await readFile(statePath, 'utf8'));
  const storedOriginal = await storage.read(cancelId);
  assert.ok(storedOriginal);
  const replacement = await encryptRelic({
    content: new TextEncoder().encode('A different document\n'),
    filename: 'cancel-proof.txt',
    mimetype: 'text/plain',
    key: decodeKey(cancelState.relics[cancelId].key),
  });
  storage.put(cancelId, replacement);
  await goto(reader.browser, text(cancelPublished.url));
  await reader.browser.waitForSelector('[data-action="open-signing"]', 25000);
  await click(reader.browser, '[data-action="open-signing"]');
  await poll('swapped content refusal', 15000, async () => {
    const page = await reader.browser.evaluate<string>(
      'document.body.innerText'
    );
    return page.includes(
      "This file doesn't match the one you were asked to sign."
    )
      ? page
      : undefined;
  }).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await reader.browser.evaluate<string>('document.body.innerText')}`
    );
  });
  assert.equal(
    await reader.browser.evaluate<boolean>(
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here' && !b.disabled)`
    ),
    false
  );
  storage.put(cancelId, storedOriginal);
  console.log('SIGNING_TAMPER changed_ciphertext=refused sign_button=absent');
  await mcp('relic_cancel_signing', {
    relic_id: cancelId,
    request_id: cancelRequest.request_id,
  });
  const cancelProof = encodeKey(
    await deriveShareProof(decodeKey(cancelState.relics[cancelId].key))
  );
  const cancelRefusal = await reader.browser.evaluate<{
    status: number;
    code: string;
  }>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${cancelId}/signing/options`)}, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({request_id:${JSON.stringify(cancelRequest.request_id)}, share_proof:${JSON.stringify(cancelProof)}})
    });
    return {status:response.status, code:(await response.json()).code};
  })()`);
  assert.deepEqual(cancelRefusal, {
    status: 409,
    code: 'signing_request_closed',
  });
  console.log('SIGNING_CANCEL options=409 code=signing_request_closed');
  const extension = await mcp('relic_settings', { relic_id: id, ttl_days: 2 });
  assert.ok(extension.relic_expires_at);
  const shortening = await callMcpRaw(env, 'relic_settings', {
    relic_id: id,
    ttl_days: 1,
  });
  assert.equal(shortening.isError, true);
  assert.equal(shortening.structured.code, 'version_locked');
  console.log('SIGNING_STEP_8_LOCKED republish=409 shorten=409 extend=200');
  console.log(
    'SIGNING_STEP_13_LIFETIME not_reproven_here see=settings-path(05_PRIVATE_LIFETIME)'
  );
  console.log(
    'SIGNING_STEP_14_MCP_NEVER_SIGNS record_tools=0 read_signing=ok verify_tool=valid'
  );
  console.log('SIGNING_STEP_15_CONTENT_MISMATCH sign_button=absent record=409');
  console.log('SIGNING_PATH_OK');
} catch (error) {
  console.error(
    `SIGNING_PATH_BLOCKED ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  for (const actor of actors) await actor.browser.close().catch(() => {});
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
