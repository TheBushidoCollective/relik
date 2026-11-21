/**
 * Loopback proof for publishing from the /publish page.
 *
 *   bun run --cwd packages/relic-viewer build
 *   RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/browser-publish-path.ts
 *
 * Serves the real app on loopback with in-memory state, opens /publish in an
 * owned headless Chrome with a throwaway profile, drops a real file, and
 * follows the link it hands back. Every write targets the in-memory service.
 *
 * Not proven here: the upload is same-origin on loopback, so the browser's
 * cross-origin preflight to the real bucket is not exercised. That leg is the
 * post-deploy check named in PATH.md.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { launchProofBrowser } from './decision-proof-steps.ts';

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-publish-path-'));
async function resolveChrome(): Promise<string> {
  const fromEnv = process.env['RELIC_CHROME_PATH'];
  if (fromEnv && fromEnv !== 'none') return fromEnv;
  const found = await discoverChrome(undefined);
  if (found.kind === 'found') return found.path;
  throw new Error(
    'RELIC_CHROME_PATH must be set to an executable Chrome binary or headless shell'
  );
}

const chromePath = await resolveChrome();

const store = new MemoryStore();
let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    return handler
      ? handler(request)
      : new Response('Not ready', { status: 503 });
  },
});
const serviceOrigin = `http://localhost:${service.port}`;
const storage = new MemoryStorage(`${serviceOrigin}/__storage`);
const app = createApp({
  // A different host from the service, as in production, so the frame is a
  // real cross-origin document that loopback can still reach.
  config: {
    serviceOrigin,
    usercontentOrigin: `http://127.0.0.1:${service.port}`,
  },
  store,
  storage,
  now: () => Date.now(),
  assets: diskAssets(viewerDist),
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
      : new Response('Not found', { status: 404 });
  }
  return app.fetch(request);
};

/** The part of Network.requestWillBeSent this proof reads. */
interface RequestWillBeSent {
  readonly request?: {
    readonly url?: string;
    readonly method?: string;
    readonly postData?: string;
  };
}

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}
const seen: Seen[] = [];

const browser = await launchProofBrowser(chromePath, serviceOrigin);
browser.cdp.onEvent((event) => {
  if (
    event.method !== 'Network.requestWillBeSent' ||
    event.sessionId !== browser.sessionId
  ) {
    return;
  }
  // CDP event params arrive untyped; this names the one shape read below.
  const params = event.params as RequestWillBeSent;
  const request = params.request;
  if (request?.url === undefined || request.method === undefined) return;
  seen.push({
    method: request.method,
    url: request.url,
    body: request.postData ?? '',
  });
});

/** Keeps a screenshot when RELIC_PUBLISH_SHOTS_DIR is set, as the other proofs do. */
const shot = async (name: string): Promise<void> => {
  const dir = process.env['RELIC_PUBLISH_SHOTS_DIR'];
  if (dir === undefined) return;
  const taken = (await browser.cdp.send(
    'Page.captureScreenshot',
    { format: 'png' },
    browser.sessionId
  )) as { data: string };
  await Bun.write(join(dir, `${name}.png`), Buffer.from(taken.data, 'base64'));
};

const goto = async (url: string): Promise<void> => {
  await browser.cdp.send('Page.navigate', { url }, browser.sessionId);
};

const waitForText = async (text: string, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await browser
      .evaluate<boolean>(
        `document.body.innerText.includes(${JSON.stringify(text)})`
      )
      .catch(() => false);
    if (found) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for text: ${text}`);
};

/** A real drop event over the zone, carrying a real File. */
const dropFile = (name: string, text: string, size?: number): Promise<void> =>
  browser.evaluate<void>(`(() => {
    const file = new File([${JSON.stringify(text)}], ${JSON.stringify(name)});
    ${size === undefined ? '' : `Object.defineProperty(file, 'size', { value: ${size} });`}
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector('.pub-drop').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  })()`);

const apiRequests = (): Seen[] =>
  seen.filter((request) => new URL(request.url).pathname.startsWith('/api/'));

try {
  // 1. The page is the publish view and carries the terms before anything is dropped.
  await goto(`${serviceOrigin}/publish`);
  await browser.waitForSelector('.pub-drop');
  const terms = await browser.evaluate<string>(
    `document.querySelector('.pub-terms').innerText`
  );
  assert.match(terms, /contains the decryption key/);
  assert.match(terms, /cannot be updated later/);
  console.log('PUBLISH_STEP_1_PAGE terms=shown');

  // 2. A drop reviews the file and sends nothing.
  const content = '# Dropped notes\n\nEncrypted in the page, then uploaded.\n';
  await dropFile('dropped-notes.md', content);
  await browser.waitForSelector('.pub-title');
  const titleDefault = await browser.evaluate<string>(
    `document.querySelector('.pub-title').value`
  );
  assert.equal(titleDefault, 'dropped-notes.md');
  assert.equal(apiRequests().length, 0, 'a drop must not contact the service');
  console.log('PUBLISH_STEP_2_REVIEW title=filename api_requests=0');

  // 3. Publishing runs challenge, grant, the PUT and complete, and hands back a link.
  await browser.clickSelector('.pub-row .action.primary');
  await browser.waitForSelector('.pub-link');
  const link = await browser.evaluate<string>(
    `document.querySelector('.pub-link').value`
  );
  const url = new URL(link);
  assert.equal(url.origin, serviceOrigin);
  const relicId = url.pathname.slice(1);
  const encodedKey = url.hash.slice(1 + 'r1'.length);
  const calls = seen.map((r) => `${r.method} ${new URL(r.url).pathname}`);
  for (const expected of [
    'POST /api/challenge',
    'POST /api/grant',
    `PUT /__storage/upload/${relicId}`,
    `POST /api/relics/${relicId}/complete`,
  ]) {
    assert.ok(calls.includes(expected), `missing request: ${expected}`);
  }
  const grantBody = seen.find((r) => r.url.endsWith('/api/grant'))?.body ?? '';
  assert.match(grantBody, /"title":"dropped-notes\.md"/);
  assert.match(grantBody, /"share_verifier":"[0-9a-f]{64}"/);
  assert.match(grantBody, /"publishing_client":"relik-web"/);
  for (const request of seen) {
    assert.ok(
      !request.body.includes(encodedKey) && !request.url.includes(encodedKey),
      `the key reached the service in ${request.method} ${request.url}`
    );
  }
  const row = await store.getRelic(relicId);
  assert.equal(row?.title, 'dropped-notes.md');
  assert.equal(row?.publishingClient, 'relik-web');
  const stored = await storage.read(relicId);
  assert.ok(stored && stored.length > 0);
  assert.ok(
    !Buffer.from(stored).includes('Encrypted in the page'),
    'the stored object holds plaintext'
  );
  console.log(
    `PUBLISH_STEP_3_PUBLISHED relic_id=${relicId} key_in_requests=false plaintext_at_rest=false`
  );

  // 4. The link opens, in the same browser, to the file that was dropped.
  await goto(link);
  await waitForText('Dropped notes');
  await waitForText('Encrypted in the page, then uploaded.');
  console.log('PUBLISH_STEP_4_OPENS content=decrypted');

  // 5. A cleared title sends no title and no filename.
  await goto(`${serviceOrigin}/publish`);
  await browser.waitForSelector('.pub-drop');
  seen.length = 0;
  await dropFile('payroll-2026.csv', 'name,amount\nA,1\n');
  await browser.waitForSelector('.pub-title');
  await browser.evaluate<void>(
    `(() => { const t = document.querySelector('.pub-title'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`
  );
  await browser.clickSelector('.pub-row .action.primary');
  await browser.waitForSelector('.pub-link');
  for (const request of seen) {
    assert.ok(
      !request.body.includes('payroll'),
      `the filename reached the service in ${request.method} ${request.url}`
    );
  }
  const cleared = new URL(
    await browser.evaluate<string>(`document.querySelector('.pub-link').value`)
  );
  assert.equal(
    (await store.getRelic(cleared.pathname.slice(1)))?.title,
    undefined
  );
  console.log(
    'PUBLISH_STEP_5_CLEARED_TITLE filename_sent=false title_stored=false'
  );

  // 6. Refusals happen before anything is read or granted.
  await goto(`${serviceOrigin}/publish`);
  await browser.waitForSelector('.pub-drop');
  seen.length = 0;
  await dropFile('huge.bin', 'x', 101 * 1024 * 1024);
  await browser.waitForSelector('.pub-title');
  await browser.clickSelector('.pub-row .action.primary');
  await browser.waitForSelector('.notice');
  const oversize = await browser.evaluate<string>(
    `document.querySelector('.notice').innerText`
  );
  assert.match(oversize, /This page publishes files up to 100\.0 MB/);
  assert.ok(
    !apiRequests().some((r) => r.url.endsWith('/api/grant')),
    'an oversize file must not reach the grant'
  );

  seen.length = 0;
  await browser.evaluate<void>(`(() => {
    const file = new File(['# Report'], 'README.md');
    const child = { name: 'README.md', isFile: true, isDirectory: false, file: done => done(file) };
    const entry = { name: 'reports', isDirectory: true, isFile: false, createReader() {
      let read = false;
      return { readEntries(done) { done(read ? [] : [child]); read = true; } };
    } };
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [file], items: [{ webkitGetAsEntry: () => entry }] },
    });
    document.querySelector('.pub-drop').dispatchEvent(event);
  })()`);
  await waitForText('Opens first: README.md');
  assert.equal(
    apiRequests().length,
    0,
    'a folder review must not contact the service'
  );
  console.log(
    'PUBLISH_STEP_6_REFUSALS oversize=refused folder=reviewed grants=0'
  );

  // 7. A file dropped on any other page opens the same publisher over it.
  await goto(link);
  await waitForText('Encrypted in the page, then uploaded.');
  seen.length = 0;
  const curtainFor = (file: boolean): Promise<boolean> =>
    browser.evaluate<boolean>(`(() => {
      const dt = new DataTransfer();
      ${file ? "dt.items.add(new File(['x'], 'dragged.md'));" : "dt.setData('text/plain', 'just text');"}
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return Boolean(document.querySelector('[data-file-curtain]'));
    })()`);
  assert.equal(
    await curtainFor(false),
    false,
    'a text drag raised the curtain'
  );
  assert.equal(
    await curtainFor(true),
    true,
    'a file drag did not raise the curtain'
  );
  await browser.evaluate<void>(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# From a relic page\\n\\nDropped over another relic.\\n'], 'second.md'));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await browser.waitForSelector('dialog.pub-dialog .pub-title');
  await shot('dialog-over-relic');
  assert.equal(
    await browser.evaluate<boolean>(
      `!document.querySelector('[data-file-curtain]')`
    ),
    true,
    'the curtain outlived the drop'
  );
  assert.equal(
    apiRequests().length,
    0,
    'a drop over a relic must not contact the service'
  );
  await browser.clickSelector('dialog.pub-dialog .pub-row .action.primary');
  await browser.waitForSelector('dialog.pub-dialog .pub-link');
  const second = new URL(
    await browser.evaluate<string>(
      `document.querySelector('dialog.pub-dialog .pub-link').value`
    )
  );
  assert.notEqual(
    second.pathname.slice(1),
    relicId,
    'the drop did not make a new relic'
  );
  await browser.clickSelector('dialog.pub-dialog .pub-card > .action');
  await Bun.sleep(150);
  assert.equal(
    await browser.evaluate<boolean>(
      `!document.querySelector('dialog.pub-dialog')`
    ),
    true,
    'the dialog did not close'
  );
  await waitForText('Encrypted in the page, then uploaded.');
  console.log(
    `PUBLISH_STEP_7_DROP_ANYWHERE text_drag=ignored file_drag=curtain dialog=opened new_relic=${second.pathname.slice(1)} page_behind=kept`
  );

  // 8. A real drag over a relic that fills the page with a sandboxed frame,
  //    which the page cannot see on its own.
  const openHtmlRelic = async (name: string, html: string): Promise<void> => {
    await goto(`${serviceOrigin}/publish`);
    await browser.waitForSelector('.pub-drop');
    await dropFile(name, html);
    await browser.waitForSelector('.pub-title');
    await browser.clickSelector('.pub-row .action.primary');
    await browser.waitForSelector('.pub-link');
    await goto(
      await browser.evaluate<string>(
        `document.querySelector('.pub-link').value`
      )
    );
    await browser.waitForSelector('iframe');
  };
  const frameCentre = (): Promise<{ x: number; y: number }> =>
    browser.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('iframe').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
  const sendDrag = async (
    type: string,
    x: number,
    y: number,
    path: string
  ): Promise<void> => {
    await browser.cdp.send(
      'Input.dispatchDragEvent',
      {
        type,
        x,
        y,
        data: { items: [], files: [path], dragOperationsMask: 1 },
      },
      browser.sessionId
    );
  };
  /**
   * Resolves once the page has finished loading, which is after every module
   * script has run. The homepage and the relic's loading bar draw their Upload
   * link in the HTML, so the link is on screen before the script that arms it,
   * and a drop or a click in that gap goes to nothing.
   */
  const waitLoaded = (): Promise<void> =>
    browser.evaluate<void>(`new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', () => resolve(), { once: true });
    })`);
  const waitInPage = (selector: string): Promise<void> =>
    browser.evaluate<void>(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const look = () => {
        if (document.querySelector(${JSON.stringify(selector)})) return resolve();
        if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + ${JSON.stringify(selector)}));
        setTimeout(look, 50);
      };
      look();
    })`);
  const draggedFile = async (name: string): Promise<string> => {
    const path = join(scratch, name);
    await Bun.write(path, '# A real drag\n\nFrom the operating system.\n');
    return path;
  };
  /** Drops a real file, waiting for the curtain between moves as a hand would. */
  const realDrag = async (
    name: string,
    x: number,
    y: number
  ): Promise<void> => {
    const path = await draggedFile(name);
    await sendDrag('dragEnter', x, y, path);
    await sendDrag('dragOver', x, y, path);
    await waitInPage('[data-file-curtain]');
    await sendDrag('dragOver', x, y, path);
    await sendDrag('drop', x, y, path);
  };
  const dialogTitle = (): Promise<string | undefined> =>
    browser.evaluate<string | undefined>(
      `document.querySelector('dialog.pub-dialog .pub-title')?.value`
    );
  const dialogClosed = async (): Promise<void> => {
    await browser.clickSelector(
      'dialog.pub-dialog .pub-row .action:not(.primary)'
    );
    // Real time: the dialog removes itself on its close event.
    await Bun.sleep(150);
  };

  await openHtmlRelic(
    'framed.html',
    '<!doctype html><title>Framed</title><body style="margin:0"><h1>Framed page</h1></body>'
  );
  const frame = await frameCentre();

  // The control: a real drag over the page's own bar. If this does not open
  // the dialog the drag mechanism is what failed, not the frame.
  await realDrag('over-the-bar.md', 300, 20);
  await waitInPage('dialog.pub-dialog .pub-title');
  assert.equal(await dialogTitle(), 'over-the-bar.md');
  await dialogClosed();

  await realDrag('over-the-frame.md', frame.x, frame.y);
  await waitInPage('dialog.pub-dialog .pub-title');
  assert.equal(await dialogTitle(), 'over-the-frame.md');
  console.log(
    'PUBLISH_STEP_8_REAL_DRAG over_bar=caught over_sandboxed_frame=caught'
  );

  // 9. A relic that takes file drops itself keeps them: the page does not
  //    raise its curtain over a drag the relic claimed.
  await openHtmlRelic(
    'claims-drops.html',
    `<!doctype html><title>Claims</title><body style="margin:0"><h1>Drop a file here</h1><script>
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => { e.preventDefault(); parent.postMessage({ type: 'relic-got-file' }, '*'); });
    </script></body>`
  );
  const claimed = await frameCentre();
  await browser.evaluate<void>(
    `window.__got = []; window.addEventListener('message', (e) => window.__got.push(e.data && e.data.type));`
  );
  const claimedPath = await draggedFile('claimed.md');
  await sendDrag('dragEnter', claimed.x, claimed.y, claimedPath);
  await sendDrag('dragOver', claimed.x, claimed.y, claimedPath);
  // Real time: the shim decides after the relic's listeners have run, so the
  // absence of a curtain can only be shown by letting that moment pass.
  await Bun.sleep(1500);
  assert.equal(
    await browser.evaluate<boolean>(
      `!document.querySelector('[data-file-curtain]')`
    ),
    true,
    'the page took a drag the relic had claimed'
  );
  await sendDrag('dragOver', claimed.x, claimed.y, claimedPath);
  await sendDrag('drop', claimed.x, claimed.y, claimedPath);
  await Bun.sleep(300);
  assert.ok(
    (await browser.evaluate<string[]>(`window.__got`)).includes(
      'relic-got-file'
    ),
    'the relic did not receive its own drop'
  );
  assert.equal(
    await browser.evaluate<boolean>(
      `!document.querySelector('dialog.pub-dialog')`
    ),
    true,
    'a publish dialog opened over a relic that took the file'
  );
  console.log(
    'PUBLISH_STEP_9_RELIC_CLAIMS curtain=none relic_got_drop=true dialog=none'
  );

  // 10. The homepage, which loads no viewer, takes a drop and shows a styled dialog.
  await goto(`${serviceOrigin}/`);
  await waitForText('Share a file we can');
  await waitLoaded();
  const homeScripts = await browser.evaluate<string[]>(
    `[...document.querySelectorAll('script')].map((s) => s.getAttribute('src'))`
  );
  assert.deepEqual(homeScripts, ['/assets/landing.js']);
  seen.length = 0;
  await browser.evaluate<void>(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# From the homepage\\n\\nDropped on /.\\n'], 'home-drop.md'));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await waitInPage('dialog.pub-dialog .pub-title');
  assert.equal(await dialogTitle(), 'home-drop.md');
  await shot('dialog-on-homepage');
  assert.equal(
    apiRequests().length,
    0,
    'a drop on the homepage sent something'
  );
  // The homepage has none of the viewer's stylesheet, so a dialog that looks
  // like a button only does because the base sheet came with it.
  const homeButton = await browser.evaluate<{
    background: string;
    padding: string;
  }>(`(() => {
    const s = getComputedStyle(document.querySelector('dialog.pub-dialog .pub-row .action.primary'));
    return { background: s.backgroundColor, padding: s.paddingLeft };
  })()`);
  assert.notEqual(
    homeButton.background,
    'rgba(0, 0, 0, 0)',
    'the dialog button has no fill'
  );
  assert.notEqual(
    homeButton.padding,
    '0px',
    'the dialog button has no padding'
  );
  await browser.clickSelector('dialog.pub-dialog .pub-row .action.primary');
  await waitInPage('dialog.pub-dialog .pub-link');
  const homeLink = new URL(
    await browser.evaluate<string>(
      `document.querySelector('dialog.pub-dialog .pub-link').value`
    )
  );
  assert.equal(homeLink.origin, serviceOrigin);
  const homeKey = homeLink.hash.slice(1 + 'r1'.length);
  assert.ok(
    seen.every((r) => !r.body.includes(homeKey) && !r.url.includes(homeKey)),
    'the key reached the service from the homepage'
  );
  console.log(
    `PUBLISH_STEP_10_HOMEPAGE scripts=1 dialog=styled published=${homeLink.pathname.slice(1)} key_in_requests=false`
  );

  // 11. The Upload button opens a real file chooser, from a real click.
  const chooserNodes: number[] = [];
  browser.cdp.onEvent((event) => {
    if (
      event.method === 'Page.fileChooserOpened' &&
      event.sessionId === browser.sessionId
    ) {
      const node = event.params['backendNodeId'];
      if (typeof node === 'number') chooserNodes.push(node);
    }
  });
  await browser.cdp.send(
    'Page.setInterceptFileChooserDialog',
    { enabled: true },
    browser.sessionId
  );
  /** A click the browser treats as the visitor's own, which a chooser requires. */
  const trustedClick = async (selector: string): Promise<void> => {
    const at = await browser.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'left', clickCount: 1 },
        browser.sessionId
      );
    }
  };
  const chooseViaUpload = async (
    selector: string,
    name: string
  ): Promise<void> => {
    const before = chooserNodes.length;
    await trustedClick(selector);
    const deadline = Date.now() + 10000;
    while (chooserNodes.length === before && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    assert.ok(
      chooserNodes.length > before,
      `no file chooser opened from ${selector}`
    );
    await browser.cdp.send(
      'DOM.setFileInputFiles',
      {
        files: [await draggedFile(name)],
        backendNodeId: chooserNodes[chooserNodes.length - 1],
      },
      browser.sessionId
    );
  };
  await goto(`${serviceOrigin}/`);
  await waitForText('Share a file we can');
  await waitLoaded();
  await chooseViaUpload('header a[data-upload]', 'chosen-on-home.md');
  await waitInPage('dialog.pub-dialog .pub-title');
  assert.equal(await dialogTitle(), 'chosen-on-home.md');
  await dialogClosed();

  await goto(link);
  await waitForText('Encrypted in the page, then uploaded.');
  await waitInPage('header.bar .action-upload');
  await waitLoaded();
  await chooseViaUpload('header.bar .action-upload', 'chosen-on-relic.md');
  await waitInPage('dialog.pub-dialog .pub-title');
  assert.equal(await dialogTitle(), 'chosen-on-relic.md');
  await dialogClosed();
  console.log(
    'PUBLISH_STEP_11_UPLOAD_BUTTON chooser=opened homepage=dialog relic_page=dialog'
  );

  // 12. Every page's bar ends in Upload, and it stays on the row down to 320px.
  const lastAction = (): Promise<string | null> =>
    browser.evaluate<string | null>(`(() => {
      const row = document.querySelector('header.bar .actions');
      return row && row.lastElementChild ? (row.lastElementChild.getAttribute('aria-label') || row.lastElementChild.textContent.trim()) : null;
    })()`);
  const pages: ReadonlyArray<readonly [string, string, string]> = [
    ['relic', link, 'header.bar .action-upload'],
    ['dashboard', `${serviceOrigin}/dashboard`, 'header.bar .action-upload'],
    ['policy', `${serviceOrigin}/policy`, 'header.bar .action-upload'],
    ['publish', `${serviceOrigin}/publish`, 'header.bar .actions .action'],
    ['unopenable', `${serviceOrigin}/${relicId}`, 'header.bar .action-upload'],
  ];
  const fit: string[] = [];
  for (const width of [1280, 390, 320]) {
    await browser.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 800, deviceScaleFactor: 1, mobile: false },
      browser.sessionId
    );
    for (const [name, url, selector] of pages) {
      await goto(url);
      await waitInPage(selector);
      assert.match(
        (await lastAction()) ?? '',
        /Upload/,
        `${name} at ${width}px does not end its bar with Upload`
      );
      const box = await browser.evaluate<{
        right: number;
        width: number;
        scroll: number;
      }>(`(() => {
        const r = document.querySelector('header.bar .actions').lastElementChild.getBoundingClientRect();
        return { right: Math.round(r.right), width: window.innerWidth, scroll: document.documentElement.scrollWidth };
      })()`);
      assert.ok(
        box.right <= box.width,
        `${name} at ${width}px: the Upload button is off the right edge (${box.right} > ${box.width})`
      );
      assert.ok(
        box.scroll <= box.width,
        `${name} at ${width}px scrolls sideways (${box.scroll} > ${box.width})`
      );
      await shot(`${name}-${width}`);
    }
    fit.push(String(width));
  }
  await browser.cdp.send(
    'Emulation.clearDeviceMetricsOverride',
    {},
    browser.sessionId
  );
  console.log(
    `PUBLISH_STEP_12_EVERY_BAR pages=${pages.map(([n]) => n).join(',')} last_action=Upload widths=${fit.join(',')} overflow=none`
  );

  console.log('BROWSER_PUBLISH_PATH_OK');
} finally {
  await browser.close().catch(() => {});
  service.stop();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
