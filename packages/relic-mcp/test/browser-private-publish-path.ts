import assert from 'node:assert/strict';
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
  console.log(
    'BROWSER_PRIVATE_PUBLISH_PATH_OK fragment=absent sealed=1 owner_open=ok public_title=absent cover=absent'
  );
} finally {
  await browser.close().catch(() => {});
  service.stop(true);
}
