/**
 * End-to-end change emails and sharing path proof.
 *
 *   bun packages/relic-mcp/test/notify-path.ts
 *
 * Exercises publishing, sharing, republishing with change notices,
 * one-click unsubscribe, opted-out recipient skipping, notify: false,
 * unlanded republishes, and operator deletion.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeKey,
  deriveCommentKey,
  deriveShareProof,
  encryptComment,
  encryptedSize,
  shareVerifierFor,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { loadPublishState } from '../src/state.ts';

const clientMode = process.env['RELIC_NOTIFY_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-notify-path-'));
const statePath = join(scratch, 'state.json');

// --- App server setup with MemoryStore and MemoryStorage -----------------
let fakeNow = Date.now();
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: { to: string; mail: OutboundMail }[] = [];

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;

const storage = new MemoryStorage(`${origin}/__storage`);

const app = createApp({
  config: {
    serviceOrigin: origin,
  },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async (to, mail) => {
      mails.push({ to, mail });
    },
  },
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    const bytes = new Uint8Array(await request.arrayBuffer());
    storage.put(relicId, bytes);
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
};

// --- Fresh Node stdio process caller -------------------------------------
function resolveCommand(): string[] {
  if (isNpxMode) {
    const pkg = clientMode.slice(4);
    return ['npx', '-y', `relic-mcp@${pkg}`];
  }
  return ['node', relicMcpBundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cmd = resolveCommand();
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CHROME_PATH: 'none',
      RELIC_CLIENT_NAME: 'relic-mcp/notify-path',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(exit, 0, `relic-mcp exited with code ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 0, 'no JSON-RPC response from relic-mcp');
  const response = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<
    string,
    unknown
  >;
  assert.ok(
    !response['error'],
    `JSON-RPC error from ${toolName}: ${JSON.stringify(response['error'])}`
  );
  const result = response['result'] as Record<string, unknown>;
  assert.ok(
    !result['isError'],
    `tool error from ${toolName}: ${JSON.stringify(result['content'])}`
  );
  return (result['structuredContent'] ?? {}) as Record<string, unknown>;
}
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function createSession(
  email = 'reader@example.test',
  expiresAt = fakeNow + 3600 * 1000
): Promise<string> {
  const token = `notify-path-token-${Math.random()}`;
  const tokenHash = await sha256Hex(token);
  await store.putSession({
    tokenHash,
    email,
    createdAt: fakeNow,
    expiresAt,
  });
  return `relic_session=${token}`;
}

const fixturePath = join(scratch, 'notify-doc.md');

try {
  // 1. Publish
  await writeFile(fixturePath, '# Notify Path Document\n');
  const pubRes = await callMcp('relic_publish', {
    path: fixturePath,
    title: 'Notify Path Doc',
    cover: false,
  });
  const relicId = String(pubRes['relic_id']);
  assert.ok(relicId, 'publish returned no relic_id');
  console.log(`PUBLISHED relic_id=${relicId}`);

  // Verify server stored the share_verifier the client sent
  process.env['RELIC_PUBLISH_STATE'] = statePath;
  const localState = await loadPublishState(relicId);
  assert.ok(localState, 'local state missing');
  const key = decodeKey(localState.key);

  if (!isNpxMode) {
    const relicRow = await store.getRelic(relicId);
    assert.ok(relicRow, 'relik row not found in store');
    const expectedVerifier = await shareVerifierFor(
      await deriveShareProof(key)
    );
    assert.equal(
      relicRow.shareVerifier,
      expectedVerifier,
      'server did not store the share_verifier the client sent'
    );
    console.log('SHARE_VERIFIER stored=true');
  }

  // 2. Seed a session for reader@example.test and post a readable comment
  const cookie = await createSession('reader@example.test');
  const commentKey = await deriveCommentKey(key);
  const ciphertext = await encryptComment(commentKey, {
    body: 'Reader comment on notify path doc',
    display_name: null,
    anchor: null,
  });
  const commentRes = await fetch(`${origin}/api/relics/${relicId}/comments`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.12',
    },
    body: JSON.stringify({ ciphertext }),
  });
  assert.equal(commentRes.status, 201, 'post comment failed');
  const commentData = (await commentRes.json()) as { comment_id: string };
  const readerCommentId = commentData.comment_id;
  assert.ok(readerCommentId, 'comment_id missing from post response');

  if (isNpxMode) {
    // In npx:<v> mode, run only steps 1, 2 and 4 without sharing and expecting 1 recipient
    mails.length = 0;
    await writeFile(fixturePath, '# Notify Path Document v2\n');
    await callMcp('relic_republish', {
      relic_id: relicId,
      path: fixturePath,
      cover: false,
      addresses: [{ comment_id: readerCommentId, note: 'Addressed comment' }],
    });
    assert.equal(mails.length, 1);
    assert.equal(mails[0]?.to, 'reader@example.test');
    console.log('NOTIFY_PATH_TODAYS_CLIENT_OK');
    process.exit(0);
  }

  // 3. relic_share(['Ada@Example.test', 'grace@example.test'])
  const shareRes = await callMcp('relic_share', {
    relic_id: relicId,
    emails: ['Ada@Example.test', 'grace@example.test'],
  });
  const registered = (shareRes['registered'] as string[]) ?? [];
  assert.equal(registered.length, 2);
  assert.equal(registered[0], 'ada@example.test');
  assert.equal(registered[1], 'grace@example.test');
  const emailObj = (shareRes['email'] as { text: string }) ?? { text: '' };
  const linkHasFragment = emailObj.text.includes(`/${relicId}#`);
  assert.ok(linkHasFragment, 'share email does not contain link with fragment');
  const mailtoUrl = String(shareRes['mailto_url']);
  assert.ok(
    mailtoUrl.startsWith('mailto:ada@example.test,grace@example.test?')
  );

  const sharesInStore = await store.listShares(relicId);
  assert.equal(sharesInStore.length, 2);
  assert.ok(!JSON.stringify(sharesInStore).includes('#'));

  console.log(`SHARED registered=2 link_has_fragment=${linkHasFragment}`);

  // 4. Republish v2 with addresses
  mails.length = 0;
  await writeFile(fixturePath, '# Notify Path Document v2\n');
  const repubRes = await callMcp('relic_republish', {
    relic_id: relicId,
    path: fixturePath,
    cover: false,
    addresses: [{ comment_id: readerCommentId, note: 'Addressed comment' }],
  });
  assert.equal(Number(repubRes['version']), 2);
  assert.equal(mails.length, 3);

  const keyless = mails.every(
    (m) => !m.mail.text.includes('#') && !m.mail.html.includes('#')
  );
  assert.ok(keyless, 'change notice email contained # key fragment');

  const listUnsubscribe = mails.every(
    (m) =>
      Boolean(m.mail.headers?.['List-Unsubscribe']) &&
      m.mail.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'
  );
  assert.ok(listUnsubscribe, 'List-Unsubscribe headers missing or invalid');

  const readerMailsCount = mails.filter(
    (m) => m.to === 'reader@example.test'
  ).length;
  assert.equal(readerMailsCount, 1);

  console.log(
    `CHANGE_NOTICES version=2 recipients=${mails.length} keyless=${keyless} list_unsubscribe=${listUnsubscribe} reader_mails=${readerMailsCount}`
  );

  // 5. GET Ada's stop link, then POST List-Unsubscribe=One-Click with no cookie
  const adaMail = mails.find((m) => m.to === 'ada@example.test');
  assert.ok(adaMail, "Ada's mail missing");
  const rawUnsub = adaMail.mail.headers?.['List-Unsubscribe'] ?? '';
  const unsubMatch = rawUnsub.match(/<([^>]+)>/);
  assert.ok(unsubMatch, 'stop link missing from List-Unsubscribe header');
  const stopUrl = unsubMatch[1] ?? '';

  const stopGetRes = await fetch(stopUrl);
  const stopGetText = await stopGetRes.text();
  assert.equal(stopGetRes.status, 200);
  assert.ok(stopGetText.includes('<form'));

  const stopPostRes = await fetch(stopUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
  });
  assert.equal(stopPostRes.status, 200);
  const redirect = Boolean(stopPostRes.headers.get('location'));
  assert.ok(!redirect, 'POST unsubscribe responded with redirect');

  console.log(
    `STOPPED get=${stopGetRes.status} post=${stopPostRes.status} redirect=${redirect}`
  );

  // 6. Add 11 minutes to fakeNow and republish v3
  fakeNow += 11 * 60 * 1000;
  mails.length = 0;
  await writeFile(fixturePath, '# Notify Path Document v3\n');
  const repubV3 = await callMcp('relic_republish', {
    relic_id: relicId,
    path: fixturePath,
    cover: false,
  });
  assert.equal(Number(repubV3['version']), 3);
  assert.equal(mails.length, 2);
  const recipientsV3 = mails.map((m) => m.to).sort();
  assert.deepEqual(recipientsV3, ['grace@example.test', 'reader@example.test']);

  console.log(
    `CHANGE_NOTICES version=3 recipients=${mails.length} opted_out_skipped=1`
  );

  // 7. Add 11 minutes and republish v4 with notify: false
  fakeNow += 11 * 60 * 1000;
  mails.length = 0;
  await writeFile(fixturePath, '# Notify Path Document v4\n');
  const repubV4 = await callMcp('relic_republish', {
    relic_id: relicId,
    path: fixturePath,
    cover: false,
    notify: false,
  });
  assert.equal(Number(repubV4['version']), 4);
  assert.equal(mails.length, 0);

  console.log(`NOTIFY_FALSE version=4 recipients=${mails.length}`);

  // 7b. Eleven minutes on, a second reader comments. Everyone on the list
  //     hears about it except the author and the address that used its stop
  //     link: the first commenter and the shared address still following.
  fakeNow += 11 * 60 * 1000;
  mails.length = 0;
  const linCookie = await createSession('lin@example.test');
  const linComment = await fetch(`${origin}/api/relics/${relicId}/comments`, {
    method: 'POST',
    headers: {
      cookie: linCookie,
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.13',
    },
    body: JSON.stringify({
      ciphertext: await encryptComment(commentKey, {
        body: 'Second reader comment',
        display_name: null,
        anchor: null,
      }),
    }),
  });
  assert.equal(linComment.status, 201, 'second comment failed');
  const commentRecipients = mails.map((m) => m.to).sort();
  assert.deepEqual(commentRecipients, [
    'grace@example.test',
    'reader@example.test',
  ]);
  const namesCommenter = mails.every((m) =>
    m.mail.text.includes('lin@example.test')
  );
  assert.ok(namesCommenter, 'comment email did not name the commenter');
  const commentKeyless = mails.every(
    (m) => !m.mail.text.includes('#') && !m.mail.html.includes('#')
  );
  assert.ok(commentKeyless, 'comment email contained # key fragment');
  assert.ok(
    mails.every((m) => Boolean(m.mail.headers?.['List-Unsubscribe'])),
    'comment email had no List-Unsubscribe header'
  );
  console.log(
    `COMMENT_NOTICES recipients=${mails.length} names_commenter=${namesCommenter} keyless=${commentKeyless}`
  );

  // 7c. The publisher answers at once through relic_comment. The two people
  //     emailed a moment ago are inside their 10-minute window and hear
  //     nothing more; the second reader, who was the author last time, gets
  //     one email naming the publisher.
  mails.length = 0;
  await callMcp('relic_comment', {
    relic_id: relicId,
    body: 'Publisher answer on the notify path doc',
  });
  assert.deepEqual(
    mails.map((m) => m.to),
    ['lin@example.test']
  );
  assert.ok(
    mails[0]?.mail.text.includes('The publisher'),
    'publisher comment email did not name the publisher'
  );
  console.log(`PUBLISHER_COMMENT recipients=${mails.length} collapsed=2`);

  // 8. Start a raw HTTP republish with no upload; completion answers 409
  mails.length = 0;
  const rawRepubRes = await fetch(`${origin}/api/relics/${relicId}/republish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publish_token: localState.publish_token,
      renderer_class: 'markdown',
      declared_size_bytes: 10,
      declared_ciphertext_bytes: encryptedSize(10),
      title: 'Unlanded Republish',
    }),
  });
  assert.equal(rawRepubRes.status, 200);

  // Do NOT upload ciphertext. Call complete:
  const completeRes = await fetch(`${origin}/api/relics/${relicId}/complete`, {
    method: 'POST',
  });
  assert.equal(completeRes.status, 409, 'unuploaded complete did not fail 409');
  assert.equal(mails.length, 0);

  console.log(`UNLANDED recipients=${mails.length}`);

  // 9. Operator DELETE
  const deleteRes = await fetch(
    `${origin}/api/relics/${relicId}?reason=operator_error`,
    {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-operator-secret' },
    }
  );
  assert.equal(deleteRes.status, 200, 'operator delete failed');
  const deleteData = (await deleteRes.json()) as Record<string, unknown>;
  const sharesDeleted = Number(deleteData['shares_deleted']);
  const optOutsDeleted = Number(deleteData['opt_outs_deleted']);
  assert.equal(sharesDeleted, 2);
  assert.equal(optOutsDeleted, 1);

  console.log(
    `DELETED shares_deleted=${sharesDeleted} opt_outs_deleted=${optOutsDeleted}`
  );
  console.log('NOTIFY_PATH_OK');
} finally {
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
