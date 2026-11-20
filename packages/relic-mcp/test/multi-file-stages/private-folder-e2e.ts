import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKey, openAnyRelic, openFolder } from '@relic/format';
import { kemKeyIdOf, unwrapVersionKey } from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import { clickPrivateControl } from '../confirmation-private-proof.ts';
import {
  callMcpRaw,
  click,
  currentVersion,
  goto,
  launchActor,
  localPrivateState,
  openPanel,
  pageStatus,
  poll,
  stepsFourAndFive,
  stepsOneToThree,
  stepSeven,
  waitForState,
  type CapturedMail,
  type Mailbox,
  type PrivateShareEnv,
} from '../private-shares-steps.ts';

const chromePath = findHeadlessShell();
if (!chromePath) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  console.log(
    'MULTI_FILE_STAGE private-folder-e2e SKIP (headless shell missing)'
  );
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'relic-private-folder-e2e-'));
  const previousDevice = process.env.RELIC_DEVICE_KEYS;
  const previousState = process.env.RELIC_PUBLISH_STATE;
  const root = join(scratch, 'folder');
  await mkdir(root);
  const files = [
    {
      path: 'README.md',
      bytes: Buffer.from('# Private folder end to end\n\nReadable markdown.\n'),
    },
    { path: 'data.json', bytes: Buffer.from('{"private":true}\n') },
    { path: 'private-proof.txt', bytes: Buffer.from('third file\n') },
  ];
  for (const file of files) await writeFile(join(root, file.path), file.bytes);
  const store = new MemoryStore();
  const mails: CapturedMail[] = [];
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const service = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      handler ? handler(request) : new Response('Not ready', { status: 503 }),
  });
  const serviceOrigin = `http://localhost:${service.port}`;
  const storage = new MemoryStorage(`${serviceOrigin}/__storage`);
  const app = createApp({
    config: { serviceOrigin },
    store,
    storage,
    now: () => Date.now(),
    operatorTokens: new Map([['operator-token', 'test-operator-secret']]),
    assets: diskAssets(
      fileURLToPath(new URL('../../../relic-viewer/dist/', import.meta.url))
    ),
    mailer: {
      send: async (to, link, code) => {
        mails.push({
          to,
          subject: 'sign-in',
          text: link,
          link,
          ...(code === undefined ? {} : { code }),
        });
      },
      sendMail: async (to, mail) => {
        mails.push({ to, subject: mail.subject, text: mail.text });
      },
    },
  });
  handler = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__storage/upload/') && request.method === 'PUT') {
      storage.put(
        path.slice('/__storage/upload/'.length),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, { status: 200 });
    }
    if (path.startsWith('/__storage/o/') && request.method === 'GET') {
      const bytes = await storage.read(path.slice('/__storage/o/'.length));
      return bytes
        ? new Response(Buffer.from(bytes), { status: 200 })
        : new Response('Not found', { status: 404 });
    }
    return app.fetch(request);
  };
  const mailbox: Mailbox = {
    mark: () => mails.length,
    all: () => mails,
    async await(to, since, match, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const found = mails
          .slice(since)
          .find(
            (mail) => mail.to.toLowerCase() === to.toLowerCase() && match(mail)
          );
        if (found) return found;
        await Bun.sleep(50);
      }
      throw new Error(`${label} for ${to} did not arrive`);
    },
  };
  const env: PrivateShareEnv = {
    serviceOrigin,
    scratchDir: scratch,
    statePath: join(scratch, 'state.json'),
    mcpCommand: [
      'node',
      fileURLToPath(new URL('../../dist/relic-mcp.js', import.meta.url)),
    ],
    chromePath,
    owner: 'owner+e2e@example.test',
    reader: 'revoked+e2e@example.test',
    third: 'survivor+e2e@example.test',
    noPrf: 'noprf+e2e@example.test',
    mailbox,
    store,
    storage,
    receipt: (_step, line) => console.log(line),
    defect: (id, evidence) => {
      throw new Error(`${id}: ${evidence}`);
    },
  };
  const owner = await launchActor(env, 'owner-e2e', env.owner, true);
  const revoked = await launchActor(env, 'revoked-e2e', env.reader, true);
  const survivor = await launchActor(env, 'survivor-e2e', env.third, true);
  try {
    for (const actor of [owner, revoked, survivor])
      await actor.browser.cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        actor.browser.sessionId
      );
    const controlDir = join(scratch, 'single-control');
    await mkdir(controlDir);
    const controlPath = join(controlDir, 'private-proof.txt');
    await writeFile(controlPath, 'single file control\n');
    const controlEnv = {
      ...env,
      scratchDir: controlDir,
      statePath: join(controlDir, 'state.json'),
      owner: 'owner+single-control@example.test',
      reader: 'reader+single-control@example.test',
    };
    const controlOwner = await launchActor(
      controlEnv,
      'single-owner',
      controlEnv.owner,
      true
    );
    const controlReader = await launchActor(
      controlEnv,
      'single-reader',
      controlEnv.reader,
      true
    );
    try {
      const single = await stepsOneToThree(
        controlEnv,
        controlOwner,
        controlPath
      );
      const identity = await stepsFourAndFive(
        controlEnv,
        controlOwner,
        controlReader,
        single.relicId,
        single.relicUrl,
        single.ownerKeys
      );
      await stepSeven(
        controlEnv,
        controlOwner,
        controlReader,
        single.relicId,
        single.relicUrl,
        identity
      );
      await openPanel(controlOwner, single.relicUrl);
      await clickPrivateControl(
        controlOwner.browser,
        `button[data-action="revoke"][aria-label="Revoke ${controlEnv.reader}"]`
      );
      await controlOwner.browser.waitForSelector('#revoke-dialog[open]', 25000);
      await click(controlOwner.browser, '[data-action="confirm-revoke"]');
      await controlOwner.browser.waitForSelector(
        '#rekey[data-rekey-state="done"]',
        90000
      );
      assert.equal(
        await currentVersion(controlOwner.browser, single.relicId),
        2
      );
      const result = await callMcpRaw(controlEnv, 'relic_republish', {
        relic_id: single.relicId,
        path: controlPath,
      });
      assert.equal(result.isError, true);
      assert.match(result.text, /duplicate_version/);
      console.log(
        'PRIVATE_SINGLE_CONTROL revoke_version=2 unchanged_republish=duplicate_version'
      );
    } finally {
      await controlOwner.browser.close().catch(() => {});
      await controlReader.browser.close().catch(() => {});
    }
    const first = await stepsOneToThree(env, owner, root);
    const initialState = await localPrivateState(env, first.relicId);
    const initialKey = decodeKey(initialState.keys[0]!);
    const revokedIdentity = await stepsFourAndFive(
      env,
      owner,
      revoked,
      first.relicId,
      first.relicUrl,
      first.ownerKeys
    );
    await stepSeven(
      env,
      owner,
      revoked,
      first.relicId,
      first.relicUrl,
      revokedIdentity
    );
    const survivorEnv = { ...env, reader: env.third };
    const survivorIdentity = await stepsFourAndFive(
      survivorEnv,
      owner,
      survivor,
      first.relicId,
      first.relicUrl,
      first.ownerKeys
    );
    await stepSeven(
      survivorEnv,
      owner,
      survivor,
      first.relicId,
      first.relicUrl,
      survivorIdentity
    );
    await poll('reader sees folder markdown and tree', 25000, async () =>
      (await survivor.browser.evaluate<boolean>(
        `document.body.innerText.includes('Private folder end to end') && document.body.innerText.includes('data.json')`
      ))
        ? true
        : undefined
    );
    await openPanel(owner, first.relicUrl);
    await clickPrivateControl(
      owner.browser,
      `button[data-action="revoke"][aria-label="Revoke ${env.reader}"]`
    );
    await owner.browser.waitForSelector('#revoke-dialog[open]', 25000);
    await click(owner.browser, '[data-action="confirm-revoke"]');
    await owner.browser.waitForSelector(
      '#rekey[data-rekey-state="done"]',
      90000
    );
    const version = await currentVersion(owner.browser, first.relicId);
    assert.equal(version, 2);
    await goto(survivor.browser, first.relicUrl);
    await waitForState(survivor.browser, ['unlock'], 'survivor after revoke');
    await click(survivor.browser, '[data-action="private-unlock"]');
    await poll('survivor opens rekeyed markdown', 25000, async () =>
      (await survivor.browser.evaluate<boolean>(
        `document.body.innerText.includes('Private folder end to end')`
      ))
        ? true
        : undefined
    );
    const ownerId = Buffer.from(
      await kemKeyIdOf(first.ownerKeys.keys.kemPublicKey)
    ).toString('hex');
    const wrap = (await store.listWraps(first.relicId, version)).find(
      (item) => item.recipientKeyId === ownerId
    );
    if (!wrap) throw new Error('owner wrap missing');
    const key = await unwrapVersionKey({
      recipient: {
        publicKey: first.ownerKeys.keys.kemPublicKey,
        dh: async (peer) => {
          const publicKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(peer),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
          );
          return new Uint8Array(
            await crypto.subtle.deriveBits(
              { name: 'ECDH', public: publicKey },
              first.ownerKeys.keys.kem.privateKey,
              256
            )
          );
        },
      },
      relicId: first.relicId,
      version,
      enc: wrap.enc,
      ct: wrap.ct,
    });
    const stored = await storage.read(`${first.relicId}/v${version}`);
    if (!stored) throw new Error('rekeyed object missing');
    const folder = openFolder(
      await openAnyRelic(stored, key, { admitted: [1, 2] })
    );
    assert.deepEqual(
      folder.manifest.entries.map((entry) => entry.path),
      files.map((file) => file.path)
    );
    for (let i = 0; i < files.length; i++)
      assert.deepEqual(Buffer.from(folder.entryBytes(i)), files[i]!.bytes);
    await assert.rejects(
      () => openAnyRelic(stored, initialKey, { admitted: [1, 2] }),
      { name: 'DecryptFailedError' }
    );
    const tampered = new Uint8Array(stored);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await assert.rejects(
      () => openAnyRelic(tampered, key, { admitted: [1, 2] }),
      { name: 'DecryptFailedError' }
    );
    storage.put(`${first.relicId}/v${version}`, tampered);
    try {
      await goto(survivor.browser, first.relicUrl);
      await waitForState(
        survivor.browser,
        ['unlock'],
        'tampered version unlock'
      );
      await click(survivor.browser, '[data-action="private-unlock"]');
      await waitForState(
        survivor.browser,
        ['seal-mismatch'],
        'tampered version refused'
      );
    } finally {
      storage.put(`${first.relicId}/v${version}`, stored);
    }
    await goto(survivor.browser, first.relicUrl);
    await waitForState(survivor.browser, ['unlock'], 'restored version unlock');
    await click(survivor.browser, '[data-action="private-unlock"]');
    await poll('restored version opens', 25000, async () =>
      (await survivor.browser.evaluate<boolean>(
        `document.body.innerText.includes('Private folder end to end')`
      ))
        ? true
        : undefined
    );
    assert.equal(
      await pageStatus(
        revoked.browser,
        'POST',
        `/api/relics/${first.relicId}/mint`,
        '{}'
      ),
      403
    );
    console.log(
      'PRIVATE_FOLDER_E2E_NEGATIVE revoked=403 old_key=DecryptFailedError tampered=seal-mismatch restored=open'
    );
    const unchanged = await callMcpRaw(env, 'relic_republish', {
      relic_id: first.relicId,
      path: root,
    });
    assert.equal(unchanged.isError, true);
    assert.match(unchanged.text, /duplicate_version/);
    const changed = Buffer.from('{"private":true,"version":3}\n');
    await writeFile(join(root, 'data.json'), changed);
    const republished = await callMcpRaw(env, 'relic_republish', {
      relic_id: first.relicId,
      path: root,
    });
    assert.equal(
      republished.isError,
      false,
      `private folder republish: ${republished.text}`
    );
    assert.equal(republished.structured['version'], 3);
    const finalState = await localPrivateState(env, first.relicId);
    const finalKey = decodeKey(finalState.keys[finalState.keys.length - 1]!);
    assert.notDeepEqual(finalKey, initialKey);
    assert.notDeepEqual(finalKey, key);
    const finalStored = await storage.read(`${first.relicId}/v3`);
    if (!finalStored) throw new Error('republished object missing');
    const finalFolder = openFolder(
      await openAnyRelic(finalStored, finalKey, { admitted: [1, 2] })
    );
    assert.deepEqual(
      finalFolder.manifest.entries.map((entry) => entry.path),
      files.map((file) => file.path)
    );
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(
        Buffer.from(finalFolder.entryBytes(i)),
        files[i]!.path === 'data.json' ? changed : files[i]!.bytes
      );
    }
    assert.equal(
      await pageStatus(
        revoked.browser,
        'POST',
        `/api/relics/${first.relicId}/mint`,
        '{}'
      ),
      403
    );
    console.log(
      'PRIVATE_FOLDER_REPUBLISH version=3 fresh_key=yes files=3 revoked=403'
    );
    await goto(survivor.browser, first.relicUrl);
    await waitForState(
      survivor.browser,
      ['unlock'],
      'survivor after republish'
    );
    await click(survivor.browser, '[data-action="private-unlock"]');
    await poll('survivor opens republished markdown', 25000, async () =>
      (await survivor.browser.evaluate<boolean>(
        `document.body.innerText.includes('Private folder end to end')`
      ))
        ? true
        : undefined
    );
    console.log('MULTI_FILE_STAGE private-folder-e2e OK');
  } finally {
    for (const actor of [owner, revoked, survivor])
      await actor.browser.close().catch(() => {});
    service.stop(true);
    if (previousDevice === undefined) delete process.env.RELIC_DEVICE_KEYS;
    else process.env.RELIC_DEVICE_KEYS = previousDevice;
    if (previousState === undefined) delete process.env.RELIC_PUBLISH_STATE;
    else process.env.RELIC_PUBLISH_STATE = previousState;
    await rm(scratch, { recursive: true, force: true });
  }
}
