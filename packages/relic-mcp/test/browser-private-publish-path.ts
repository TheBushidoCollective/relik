import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { launchProofBrowser } from './decision-proof-steps.ts';

const chrome = process.env['RELIC_CHROME_PATH'];
if (!chrome)
  throw new Error('RELIC_CHROME_PATH must name an isolated headless shell');
const dist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const store = new MemoryStore();
const mails: Array<{ code?: string }> = [];
let handler: ((request: Request) => Promise<Response>) | undefined;
let grants = 0;
let puts = 0;
let nonces = 0;
let hideIdentity = false;
const grantBodies: Record<string, unknown>[] = [];
const putHeaders: Headers[] = [];
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    handler ? handler(request) : new Response('not ready', { status: 503 }),
});
const origin = `http://localhost:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  now: () => Date.now(),
  assets: diskAssets(dist),
  mailer: {
    send: async (_to, _link, code) => {
      mails.push(code === undefined ? {} : { code });
    },
    sendMail: async () => {},
  },
});
handler = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/api/attest/nonce') nonces++;
  if (url.pathname === '/api/identity' && hideIdentity)
    return Response.json({ identity: null, passkeys: [] });
  if (url.pathname === '/api/grant' && request.method === 'POST') {
    grants++;
    grantBodies.push((await request.clone().json()) as Record<string, unknown>);
  }
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    puts++;
    putHeaders.push(new Headers(request.headers));
    storage.put(
      url.pathname.slice('/__storage/upload/'.length),
      new Uint8Array(await request.arrayBuffer())
    );
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const bytes = await storage.read(
      url.pathname.slice('/__storage/o/'.length)
    );
    return bytes
      ? new Response(Buffer.from(bytes))
      : new Response(null, { status: 404 });
  }
  return app.fetch(request);
};
const browser = await launchProofBrowser(chrome, origin, { hasPrf: true });
const wait = async (expression: string): Promise<void> => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await browser.evaluate<boolean>(expression).catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`condition not reached: ${expression}`);
};
const click = async (selector: string): Promise<void> => {
  await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const point = await browser.evaluate<{ x: number; y: number }>(
    `(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await browser.cdp.send(
      'Input.dispatchMouseEvent',
      { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
      browser.sessionId
    );
};
const scratch = await mkdtemp(join(tmpdir(), 'relik-private-folder-'));
try {
  await browser.cdp.send(
    'Page.navigate',
    { url: `${origin}/publish` },
    browser.sessionId
  );
  await browser.waitForSelector('.pub-drop');
  await browser.evaluate<void>(
    `(() => { const d=new DataTransfer(); d.items.add(new File(['private browser payload'], 'private.txt')); document.querySelector('.pub-drop').dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true})); })()`
  );
  await browser.waitForSelector('.pub-private');
  await click('.pub-private');
  await browser.waitForSelector('.pub-setup-slot input[type=email]');
  await browser.evaluate<void>(
    `(() => { const e=document.querySelector('.pub-setup-slot input[type=email]'); e.value='owner+browser@example.test'; e.dispatchEvent(new Event('input',{bubbles:true})); })()`
  );
  await click('.pub-setup-slot label + button');
  const deadline = Date.now() + 20000;
  while (!mails.some((m) => m.code) && Date.now() < deadline)
    await Bun.sleep(50);
  const code = mails.find((m) => m.code)?.code;
  assert.ok(code, 'sign-in code not delivered to loopback mailer');
  await browser.evaluate<void>(
    `(() => { const e=document.querySelector('.pub-setup-slot input[autocomplete=one-time-code]'); e.value=${JSON.stringify(code)}; e.dispatchEvent(new Event('input',{bubbles:true})); })()`
  );
  await browser.evaluate<void>(
    `[...document.querySelectorAll('.pub-setup-slot button')].find(e=>e.textContent==='Sign in').click()`
  );
  await wait(
    `[...document.querySelectorAll('.pub-setup-slot button')].some(e=>e.textContent.includes('Set up private key') || e.textContent.includes('set up private key'))`
  );
  await browser.evaluate<void>(
    `[...document.querySelectorAll('.pub-setup-slot button')].find(e=>e.textContent.includes('Set up private key') || e.textContent.includes('set up private key')).click()`
  );
  await wait(`!document.querySelector('.pub-row .action.primary').disabled`);
  assert.match(
    await browser.evaluate<string>(
      `document.querySelector('.pub-setup').innerText`
    ),
    /Private owner: owner\+browser@example\.test/
  );
  const beforeMismatch = { nonces, grants, puts };
  hideIdentity = true;
  await click('.pub-row .action.primary');
  await wait(`document.body.innerText.includes('Your private owner changed')`);
  assert.deepEqual({ nonces, grants, puts }, beforeMismatch);
  assert.equal(
    await browser.evaluate<boolean>(
      `document.querySelector('.pub-row .action.primary').disabled`
    ),
    true,
    'identity change must invalidate the reviewed owner'
  );
  hideIdentity = false;
  await browser.evaluate<void>(
    `[...document.querySelectorAll('.pub-setup button')].find(e=>e.textContent.includes('Retry private setup')).click()`
  );
  await wait(`!document.querySelector('.pub-row .action.primary').disabled`);
  assert.match(
    await browser.evaluate<string>(
      `document.querySelector('.pub-setup').innerText`
    ),
    /Private owner: owner\+browser@example\.test/
  );
  await click('.pub-row .action.primary');
  try {
    await browser.waitForSelector('.pub-link', 30000);
  } catch (error) {
    console.error(
      'REVIEW_STATE',
      await browser.evaluate<string>('document.body.innerText')
    );
    throw error;
  }
  const link = await browser.evaluate<string>(
    `document.querySelector('.pub-link').value`
  );
  const url = new URL(link);
  assert.equal(url.hash, '');
  const row = await store.getRelic(url.pathname.slice(1));
  assert.equal(row?.access, 'private');
  assert.equal(row?.sealedVersion, 1);
  assert.ok(row?.expiresAt);
  assert.equal(row?.title, undefined);
  assert.equal(row?.cover, undefined);
  await browser.cdp.send('Page.navigate', { url: link }, browser.sessionId);
  await wait(
    `Boolean(document.querySelector('[data-private-state="unlock"]'))`
  );
  await click('[data-action="private-unlock"]');
  await wait(`document.body.innerText.includes('private browser payload')`);
  const folder = join(scratch, 'folder');
  await mkdir(folder);
  await writeFile(join(folder, 'README.md'), '# Private folder payload');
  await writeFile(join(folder, 'second.txt'), 'second private file');
  await browser.cdp.send(
    'Page.navigate',
    { url: `${origin}/publish` },
    browser.sessionId
  );
  await browser.waitForSelector('.pub-drop');
  const document = await browser.cdp.send(
    'DOM.getDocument',
    {},
    browser.sessionId
  );
  const root = document['root'] as { nodeId: number };
  const input = await browser.cdp.send(
    'DOM.querySelector',
    { nodeId: root.nodeId, selector: 'input[webkitdirectory]' },
    browser.sessionId
  );
  const beforeGrant = grants;
  const beforePut = puts;
  await browser.cdp.send(
    'DOM.setFileInputFiles',
    { nodeId: input['nodeId'], files: [folder] },
    browser.sessionId
  );
  await wait(`document.body.innerText.includes('2 files included')`);
  await click('.pub-private');
  await wait(`!document.querySelector('.pub-row .action.primary').disabled`);
  assert.equal(grants, beforeGrant, 'private setup must not reserve a relik');
  assert.equal(puts, beforePut, 'private setup must not upload');
  await click('.pub-row .action.primary');
  try {
    await browser.waitForSelector('.pub-link', 30000);
  } catch (error) {
    console.error(
      'FOLDER_REVIEW_STATE',
      await browser.evaluate<string>('document.body.innerText')
    );
    throw error;
  }
  const folderLink = await browser.evaluate<string>(
    `document.querySelector('.pub-link').value`
  );
  const folderUrl = new URL(folderLink);
  assert.equal(folderUrl.hash, '');
  const folderRow = await store.getRelic(folderUrl.pathname.slice(1));
  assert.equal(folderRow?.access, 'private');
  assert.equal(folderRow?.sealedVersion, 1);
  assert.equal(folderRow?.title, undefined);
  const grant = grantBodies.at(-1)!;
  assert.equal(grant['renderer_class'], 'folder');
  assert.equal(grant['access'], 'private');
  assert.equal(putHeaders.at(-1)?.has('x-goog-custom-time'), true);
  await browser.cdp.send(
    'Page.navigate',
    { url: folderLink },
    browser.sessionId
  );
  await wait(
    `Boolean(document.querySelector('[data-private-state="unlock"]'))`
  );
  await click('[data-action="private-unlock"]');
  await wait(`document.body.innerText.includes('Private folder payload')`);
  // A different signed-in account without an owner grant must not receive a wrap.
  const request = await fetch(`${origin}/api/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'other-reader@example.test' }),
  });
  assert.equal(request.status, 202);
  const pendingCookie = request.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
  const otherCode = mails.at(-1)?.code;
  assert.ok(otherCode);
  const verify = await fetch(`${origin}/api/auth/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: pendingCookie },
    body: JSON.stringify({ code: otherCode }),
  });
  assert.equal(verify.status, 200);
  const readerCookie = verify.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
  const denied = await fetch(
    `${origin}/api/relics/${folderUrl.pathname.slice(1)}/versions/1/key`,
    {
      method: 'POST',
      headers: { cookie: readerCookie, 'content-type': 'application/json' },
      body: '{}',
    }
  );
  assert.equal(
    denied.status,
    403,
    'an unrelated signed-in account must not receive the folder key'
  );
  console.log(
    'BROWSER_PRIVATE_FOLDER_PATH_OK fragment=absent sealed=1 owner_open=ok'
  );
  console.log(
    'BROWSER_PRIVATE_PUBLISH_PATH_OK fragment=absent sealed=1 owner_open=ok public_title=absent cover=absent'
  );
} finally {
  await browser.close().catch(() => {});
  service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
