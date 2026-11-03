/* Real iframe image-comment path. Run against built viewer and MCP bundles. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist =
  process.env['RELIC_IMAGE_VIEWER_DIST'] ??
  join(root, 'packages/relic-viewer/dist');
const scratch = await mkdtemp(join(tmpdir(), 'relic-image-path-'));
const receipts =
  process.env['RELIC_IMAGE_SHOTS_DIR'] ?? join(scratch, 'receipts');
await mkdir(receipts, { recursive: true });
const now = Date.now();
const store = new MemoryStore();
let handler: (request: Request) => Promise<Response> = async () =>
  new Response('Not ready', { status: 503 });
const service = Bun.serve({ port: 0, fetch: (request) => handler(request) });
const usercontent = Bun.serve({
  port: 0,
  fetch: (request) => handler(request),
});
const origin = `http://127.0.0.1:${service.port}`;
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store,
  storage,
  now: () => now,
  operatorTokens: new Map([['operator-token', 'test-operator-secret']]),
  assets: diskAssets(viewerDist),
});
let mutations = 0;
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
      ? new Response(Buffer.from(bytes), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      : new Response('Not found', { status: 404 });
  }
  if (url.pathname.includes('/comments') && request.method !== 'GET')
    mutations++;
  return app.fetch(request);
};

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=';
const fixture = join(scratch, 'image-comments.html');
await writeFile(
  fixture,
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:24px;font:18px sans-serif}.scroll{height:260px;overflow:auto;border:1px solid}.spacer{height:100px}img{width:min(220px,70vw);height:120px;object-fit:fill;display:block;margin:25px 0}</style></head><body><p>Select this actual text to make a comment.</p><div class="scroll"><div class="spacer"></div><img id="first" src="${image}" alt="First"><img id="second" src="${image}" alt="Second"><a href="https://example.invalid/image"><img id="linked" src="${image}" alt="Linked"></a><div class="spacer"></div></div></body></html>`
);

async function mcp(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(
    ['node', join(root, 'packages/relic-mcp/dist/relic-mcp.js')],
    {
      cwd: scratch,
      env: {
        ...process.env,
        RELIC_SERVICE_ORIGIN: origin,
        RELIC_PUBLISH_STATE: join(scratch, 'state.json'),
        RELIC_CHROME_PATH: 'none',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`
  );
  child.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, err);
  const response = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.notEqual(
    response.result?.isError,
    true,
    JSON.stringify(response.result)
  );
  assert.ok(
    response.result?.structuredContent,
    'MCP returned no structured content'
  );
  return response.result.structuredContent;
}

const sessionToken = 'image-proof-session';
const hash = await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(sessionToken)
);
await store.putSession({
  tokenHash: Buffer.from(hash).toString('hex'),
  email: 'image-proof@example.test',
  createdAt: now,
  expiresAt: now + 3600000,
});
const published = await mcp('relic_publish', {
  path: fixture,
  title: 'Image comment proof',
  cover: false,
});
const url = String(published['url'] ?? published['link'] ?? '');
assert.ok(
  url.startsWith(origin) && url.includes('#'),
  'publish must return keyed loopback URL'
);
const relicId = published['relic_id'];
assert.ok(
  typeof relicId === 'string' && relicId.length > 0,
  'publish must return a relic ID'
);
const shell =
  process.env['RELIC_CHROME_PATH'] ??
  join(
    homedir(),
    '.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  );
const found = await discoverChrome(shell);
assert.equal(found.kind, 'found', 'headless browser executable not found');
if (found.kind !== 'found') throw new Error('unreachable');
assert.equal(
  basename(found.path),
  'chrome-headless-shell',
  'proof must use the isolated headless shell'
);
const profile = join(scratch, 'profile');
const args = chromeArgs(found.path, profile).map((arg) =>
  arg === '--host-resolver-rules=MAP * ~NOTFOUND'
    ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
    : arg === '--proxy-bypass-list=<-loopback>'
      ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
      : arg
);
const launch = createBrowserHeadlessLaunch(args, profile);
const browser = spawn(found.path, launch.args, {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
const cdp = connectPipe(
  browser.stdio[3] as Writable,
  browser.stdio[4] as Readable
);
let sid = '';
const blocked: string[] = [];
const geometry: unknown[] = [];
try {
  await attestBrowserHeadless(cdp, launch);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target['targetId'],
    flatten: true,
  });
  sid = String(attached['sessionId']);
  const send = (method: string, params: Record<string, unknown> = {}) =>
    cdp.send(method, params, sid);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__proofMessages=[]; window.__proofOpened=[];
      window.addEventListener('message', event => {
        const frame=document.querySelector('iframe.usercontent-frame');
        if (frame && event.source===frame.contentWindow) window.__proofMessages.push(event.data);
      });
      window.open=(url)=>{window.__proofOpened.push(String(url)); return null;};`,
  });
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  cdp.onEvent((event) => {
    if (event.method !== 'Fetch.requestPaused') return;
    const p = event.params as { requestId: string; request: { url: string } };
    const allowed =
      p.request.url.startsWith(`${origin}/`) ||
      p.request.url.startsWith(`${usercontentOrigin}/`) ||
      /^(data:|blob:|about:blank)/.test(p.request.url);
    if (!allowed) blocked.push(p.request.url);
    void cdp.send(
      allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      allowed
        ? { requestId: p.requestId }
        : { requestId: p.requestId, errorReason: 'BlockedByClient' },
      event.sessionId ?? sid
    );
  });
  await send('Network.setCookie', {
    name: 'relic_session',
    value: sessionToken,
    url: origin,
    httpOnly: true,
    sameSite: 'Lax',
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async <T>(
    expression: string,
    contextId?: number
  ): Promise<T> => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    assert.equal(
      result['exceptionDetails'],
      undefined,
      JSON.stringify(result['exceptionDetails'])
    );
    return (result['result'] as { value: T }).value;
  };
  const wait = async (expression: string, contextId?: number) => {
    for (let n = 0; n < 300; n++) {
      if (await evaluate<boolean>(`Boolean(${expression})`, contextId)) return;
      await Bun.sleep(50);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const frameContext = async (): Promise<number> => {
    const tree = await send('Page.getFrameTree');
    const frame = (
      tree['frameTree'] as { childFrames?: Array<{ frame: { id: string } }> }
    ).childFrames?.[0];
    assert.ok(frame, 'real usercontent frame missing');
    const world = await send('Page.createIsolatedWorld', {
      frameId: frame.frame.id,
      worldName: 'image-path-proof',
    });
    return Number(world['executionContextId']);
  };
  const click = async (x: number, y: number) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  };
  const dismissCard = async () => {
    const point = await evaluate<{ x: number; y: number }>(
      `(() => {const r=document.querySelector('.popover-card .popover-dismiss').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`
    );
    await click(point.x, point.y);
  };
  const frameClick = async (
    selector: string,
    context: number,
    index = 0,
    touch = false
  ) => {
    const box = await evaluate<{ x: number; y: number }>(
      `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) throw Error('missing frame control'); e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
      context
    );
    const frame = await evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector('iframe.usercontent-frame').getBoundingClientRect(); return {x:r.left,y:r.top}; })()`
    );
    if (touch) {
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 1,
      });
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: frame.x + box.x, y: frame.y + box.y }],
      });
      await send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    } else {
      await click(frame.x + box.x, frame.y + box.y);
    }
  };
  const navigate = async () => {
    await send('Page.navigate', { url });
    await wait("document.querySelector('iframe.usercontent-frame')");
  };
  await navigate();
  let frame = await frameContext();
  await wait("document.querySelectorAll('img').length === 3", frame);
  await wait(
    "[...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0)",
    frame
  );
  await wait(
    "document.querySelectorAll('.relic-image-control').length === 3",
    frame
  );
  // The controls must track the visible intersection, not the image's
  // unclipped box, and shim UI must not become comparison content.
  await wait("window.__proofMessages.some(message => message.type === 'relic:tree')");
  const tree = await evaluate<{ tag: string; children: unknown[] }>(
    "window.__proofMessages.find(message => message.type === 'relic:tree').tree"
  );
  const treeTags = (node: unknown): string[] => {
    const value = node as { tag: string; children: unknown[] };
    return [value.tag, ...value.children.flatMap(treeTags)];
  };
  assert.equal(treeTags(tree).filter((tag) => tag === 'img').length, 3);
  assert.ok(!treeTags(tree).includes('button'), 'shim buttons entered comparison');
  assert.equal(
    await evaluate("document.body.contains(document.querySelector('.relic-image-layer'))", frame),
    false,
    'shim layer must not enter later body snapshots'
  );
  await evaluate(`(() => {
    const scroll = document.querySelector('.scroll');
    const image = document.querySelector('#first');
    const clip = scroll.getBoundingClientRect();
    const rect = image.getBoundingClientRect();
    scroll.scrollTop += rect.bottom - clip.top - 15;
  })()`, frame);
  await wait(`(() => {
    const control = document.querySelectorAll('.relic-image-control')[0];
    const clip = document.querySelector('.scroll').getBoundingClientRect();
    const image = document.querySelector('#first').getBoundingClientRect();
    const rect = control.getBoundingClientRect();
    return !control.hidden && image.top < clip.top && image.bottom > clip.top &&
      rect.top >= clip.top && rect.bottom <= image.bottom + 0.5 &&
      rect.left >= image.left && rect.right <= image.right + 0.5;
  })()`, frame);
  await evaluate("document.querySelector('.scroll').scrollTop += 50", frame);
  await wait("document.querySelectorAll('.relic-image-control')[0].hidden", frame);
  await evaluate("document.querySelector('.scroll').scrollTop = 0", frame);
  await wait("!document.querySelectorAll('.relic-image-control')[0].hidden", frame);
  await evaluate(
    "document.querySelector('#first').style.transform = 'translateX(-5000px)'",
    frame
  );
  await wait("document.querySelectorAll('.relic-image-control')[0].hidden", frame);
  await evaluate("document.querySelector('#first').style.transform = ''", frame);
  await wait("!document.querySelectorAll('.relic-image-control')[0].hidden", frame);
  await evaluate(
    `(() => {
    window.__proofInputEvents = [];
    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'focusin']) {
      document.addEventListener(type, event => {
        const target = event.target;
        window.__proofInputEvents.push({
          type, trusted: event.isTrusted, key: event.key ?? null,
          target: target instanceof Element ? target.outerHTML.slice(0, 240) : null,
          active: document.activeElement?.outerHTML.slice(0, 240) ?? null
        });
      }, true);
    }
  })()`,
    frame
  );
  const sandbox = await evaluate<string>(
    "document.querySelector('iframe.usercontent-frame').getAttribute('sandbox')"
  );
  assert.ok(!sandbox.includes('allow-same-origin'), 'frame must remain opaque');
  const sandboxResponse = await fetch(`${usercontentOrigin}/sandbox.html`);
  assert.match(
    sandboxResponse.headers.get('content-security-policy') ?? '',
    /default-src 'none'/
  );
  assert.match(
    sandboxResponse.headers.get('content-security-policy') ?? '',
    /img-src data: blob:/
  );

  const ids: string[] = [];
  for (const [index, body] of [
    [0, 'First image comment'],
    [1, 'Second image comment'],
    [0, 'Another first image comment'],
  ] as const) {
    await evaluate(
      `document.querySelectorAll('img')[${index}].scrollIntoView({block:'center'})`,
      frame
    );
    await Bun.sleep(150);
    const mode =
      body === 'Another first image comment'
        ? 'keyboard'
        : index === 1
          ? 'touch'
          : 'pointer';
    const before = await evaluate<unknown>(
      `(() => {
      const control=document.querySelectorAll('.relic-image-control')[${index}];
      const image=document.querySelectorAll('img')[${index}];
      const rect=control.getBoundingClientRect();
      const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return {control:control.outerHTML, image:image.outerHTML, rect:rect.toJSON(), hit:hit?.outerHTML.slice(0,240), active:document.activeElement?.outerHTML.slice(0,240)};
    })()`,
      frame
    );
    if (body === 'First image comment') {
      await evaluate(`(() => {
        const frame = document.querySelector('iframe.usercontent-frame');
        const dispatch = frame.dispatchEvent;
        window.__releaseImagePlacement = () => {
          frame.dispatchEvent = dispatch;
          for (const event of window.__heldImagePlacements) dispatch.call(frame, event);
        };
        window.__heldImagePlacements = [];
        frame.dispatchEvent = function(event) {
          if (event.type === 'relic:frame-image-placement' && event.detail.id === 'pending:target') {
            window.__heldImagePlacements.push(event);
            return true;
          }
          return dispatch.call(this, event);
        };
      })()`);
    }
    console.log('IMAGE_ACTIVATION', JSON.stringify({ index, mode, before }));
    if (body === 'Another first image comment') {
      await evaluate(
        `document.querySelectorAll('.relic-image-control')[${index}].focus()`,
        frame
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
        nativeVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } else {
      await frameClick('.relic-image-control', frame, index, index === 1);
    }
    try {
      await wait(
        "document.querySelector('.popover-card.popover-composer textarea.popover-field')"
      );
    } catch (error) {
      const frameState = await evaluate<{
        rect?: { left: number; top: number; width: number; height: number };
        hit?: string;
        active?: string;
        events?: unknown[];
      }>(
        `(() => {
        const control=document.querySelectorAll('.relic-image-control')[${index}];
        const rect=control?.getBoundingClientRect();
        const hit=rect && document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        return {rect:rect?.toJSON(), hit:hit?.outerHTML.slice(0,240), active:document.activeElement?.outerHTML.slice(0,240), events:window.__proofInputEvents};
      })()`,
        frame
      );
      const parentState = await evaluate<unknown>(`(() => {
        const frame=document.querySelector('iframe.usercontent-frame');
        const rect=frame?.getBoundingClientRect();
        const thread=document.querySelector('.thread');
        const childRect=${JSON.stringify(frameState.rect ?? null)};
        const x=rect && childRect ? rect.left+childRect.left+childRect.width/2 : null;
        const y=rect && childRect ? rect.top+childRect.top+childRect.height/2 : null;
        const hit=x !== null && y !== null ? document.elementFromPoint(x,y) : null;
        return {frame:rect?.toJSON(), point:{x,y}, hit:hit?.outerHTML.slice(0,240),
          active:document.activeElement?.outerHTML.slice(0,240),
          popover:document.querySelector('.popover')?.outerHTML.slice(0,1200),
          sidebar:thread?.outerHTML.slice(0,1200),
          messages:(window.__proofMessages ?? []).map(m => ({type:m?.type, status:m?.status}))};
      })()`);
      throw new Error(
        'Image activation failed: ' +
          JSON.stringify({ index, mode, before, frameState, parentState }),
        { cause: error }
      );
    }
    // Submit without waiting for placement. The first case holds the actual
    // placement event so this exercises the in-flight state deterministically.
    assert.match(
      await evaluate<string>(
        "document.querySelector('.popover-composer .popover-target').textContent"
      ),
      /Commenting on an image/
    );
    await evaluate("document.querySelector('textarea.popover-field').focus()");
    await send('Input.insertText', { text: body });
    await evaluate(
      "document.querySelector('.popover-composer .popover-action.is-primary').click()"
    );
    if (body === 'First image comment') {
      await wait('window.__heldImagePlacements.length > 0');
      assert.equal(mutations, 0, 'must not post before image validation');
      assert.equal(await evaluate<boolean>("document.querySelector('.popover-field').disabled"), true);
      assert.doesNotMatch(await evaluate<string>("document.querySelector('.popover-note').textContent"), /unavailable/i);
      await evaluate('window.__releaseImagePlacement()');
      console.log('IMAGE_EARLY_SUBMIT_WAITED_FOR_PLACEMENT');
    }
    try {
      await wait(
        `document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)')?.textContent.includes(${JSON.stringify(body)})`
      );
    } catch (error) {
      const parentState = await evaluate<unknown>(`(() => ({
        popover:document.querySelector('.popover')?.outerHTML.slice(0,3000),
        sidebar:document.querySelector('.thread')?.outerHTML.slice(0,3000),
        messages:(window.__proofMessages ?? []).map(m=>({type:m?.type,status:m?.status,id:m?.id,requestId:m?.requestId}))
      }))()`);
      const frameState = await evaluate<unknown>(
        `(() => ({
        marks:[...document.querySelectorAll('.relic-image-mark')].map(e=>({id:e.dataset.commentId,html:e.outerHTML})),
        events:window.__proofInputEvents
      }))()`,
        frame
      );
      const rows = await store.listComments(relicId);
      throw new Error(
        `Post did not reopen saved card: ${JSON.stringify({ index, mode, parentState, frameState, rows, mutations })}`,
        { cause: error }
      );
    }
    const id = await evaluate<string>(
      "document.querySelector('.popover-card[data-comment-id]').dataset.commentId"
    );
    assert.ok(id && !ids.includes(id));
    ids.push(id);
    await dismissCard();
    await wait("!document.querySelector('.popover-card[data-comment-id]')");
  }
  // A target that disappears while validation is in flight must not post or
  // discard the draft, even if an earlier placed reply was delayed.
  await evaluate(`(() => {
    const frame = document.querySelector('iframe.usercontent-frame');
    const dispatch = frame.dispatchEvent;
    window.__heldImagePlacements = [];
    window.__releaseUnavailable = () => {
      frame.dispatchEvent = dispatch;
      for (const event of window.__heldImagePlacements.filter(e => e.detail.status === 'unavailable')) dispatch.call(frame, event);
    };
    frame.dispatchEvent = function(event) {
      if (event.type === 'relic:frame-image-placement' && event.detail.id === 'pending:target') {
        window.__heldImagePlacements.push(event);
        return true;
      }
      return dispatch.call(this, event);
    };
  })()`);
  await frameClick('.relic-image-control', frame, 0);
  await wait("document.querySelector('.popover-composer textarea')");
  const beforeUnavailable = mutations;
  await evaluate(`(() => {
    const field = document.querySelector('.popover-composer textarea');
    field.value = 'Keep this unavailable draft';
    field.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('.popover-composer .popover-action.is-primary').click();
  })()`);
  await evaluate("document.querySelector('#first').style.display = 'none'", frame);
  await wait("window.__heldImagePlacements.some(e => e.detail.status === 'unavailable')");
  await evaluate('window.__releaseUnavailable()');
  await wait("document.querySelector('.popover-note')?.textContent.includes('This image is unavailable')");
  assert.equal(mutations, beforeUnavailable);
  assert.equal(await evaluate<string>("document.querySelector('.popover-field').value"), 'Keep this unavailable draft');
  assert.equal(await evaluate<boolean>("document.querySelector('.popover-field').disabled"), false);
  await evaluate("document.querySelector('#first').style.display = ''", frame);
  await evaluate("document.querySelector('#second').scrollIntoView({block:'center'})", frame);
  await frameClick('.relic-image-control', frame, 1);
  assert.equal(await evaluate<string>("document.querySelector('.popover-field').value"), 'Keep this unavailable draft');
  assert.equal(mutations, beforeUnavailable);
  await evaluate("document.querySelector('.popover-composer .popover-action.is-quiet').click()");
  await wait("!document.querySelector('.popover-composer')");
  console.log('IMAGE_UNAVAILABLE_DRAFT_PRESERVED');
  const rows = await store.listComments(relicId);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.version, 1);
    assert.ok(row.ciphertext.length > 20);
    assert.ok(!row.ciphertext.includes('image comment'));
  }
  await navigate();
  frame = await frameContext();
  await wait(
    `document.querySelectorAll('.relic-image-control').length === 3`,
    frame
  );
  for (const [index, id] of ids.entries()) {
    const before = mutations;
    await evaluate(
      `document.querySelectorAll('img')[${index === 1 ? 1 : 0}].scrollIntoView({block:'center'})`,
      frame
    );
    await wait(
      `(() => {
        const mark = document.querySelector('.relic-image-mark[data-comment-id="${id}"]');
        const image = document.querySelectorAll('img')[${index === 1 ? 1 : 0}];
        if (!mark || !image) return false;
        const mr = mark.getBoundingClientRect(), ir = image.getBoundingClientRect();
        return Math.abs(mr.top - ir.top) < 1 && mr.left >= ir.left && mr.right <= ir.right;
      })()`,
      frame
    );
    await frameClick(`.relic-image-mark[data-comment-id="${id}"]`, frame);
    try {
      await wait(
        `document.querySelector('.popover-card[data-comment-id="${id}"]')`
      );
    } catch (error) {
      const state = await evaluate<unknown>(`(() => ({popover:document.querySelector('.popover')?.outerHTML, messages:window.__proofMessages.slice(-20), thread:document.querySelector('.thread')?.outerHTML.slice(0,2000)}))()`);
      const mark = await evaluate<unknown>(`(() => {const e=document.querySelector('.relic-image-mark[data-comment-id="${id}"]');const r=e?.getBoundingClientRect();return {html:e?.outerHTML,rect:r?.toJSON(),hit:r && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML};})()`, frame);
      throw new Error(`Mark reopen failed: ${JSON.stringify({index,id,state,mark})}`, {cause:error});
    }
    assert.ok(
      (
        await evaluate<string>(
          `document.querySelector('.popover-card[data-comment-id="${id}"]').textContent`
        )
      ).includes(
        [
          'First image comment',
          'Second image comment',
          'Another first image comment',
        ][index] ?? ''
      )
    );
    await dismissCard();
    await wait("!document.querySelector('.popover-card[data-comment-id]')");
    assert.equal(mutations, before, 'dismissal must not mutate comments');
  }
  console.log('IMAGE_MARK_REOPEN_COMPLETE');
  await evaluate("document.querySelector('#first').scrollIntoView({block:'center'})", frame);
  await wait(`!!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`, frame);
  await evaluate("document.querySelector('.scroll').scrollTop = document.querySelector('.scroll').scrollHeight", frame);
  await wait(`!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`, frame);
  await evaluate("document.querySelector('#first').scrollIntoView({block:'center'})", frame);
  await wait(`!!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`, frame);
  const beforeRow = mutations;
  await evaluate("document.querySelector('.thread-toggle').click()");
  await wait(`document.querySelector('.comment[data-comment-id="${ids[0]}"]')`);
  for (const id of ids) {
    await evaluate(
      `document.querySelector('${id === ids[1] ? '#second' : '#first'}').scrollIntoView({block:'center'})`,
      frame
    );
    await wait(`!!document.querySelector('.relic-image-mark[data-comment-id="${id}"]')`, frame);
  }
  await Bun.sleep(300);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await evaluate(
    `document.querySelector('.comment[data-comment-id="${ids[0]}"]').click()`
  );
  try {
    await wait(
      `document.querySelector('.popover-card[data-comment-id="${ids[0]}"]')`
    );
  } catch (error) {
    const state = await evaluate<unknown>(`(() => ({messages:window.__proofMessages.slice(-30), thread:document.querySelector('.thread')?.outerHTML, popover:document.querySelector('.popover')?.outerHTML}))()`);
    throw new Error(`Row reopen failed: ${JSON.stringify(state)}`, {cause:error});
  }
  await dismissCard();
  await wait("!document.querySelector('.popover-card[data-comment-id]')");
  assert.equal(
    mutations,
    beforeRow,
    'reopening and dismissal must not mutate comments'
  );
  assert.equal((await store.listComments(relicId)).length, 3);
  console.log('IMAGE_ROW_REOPEN_COMPLETE');
  await evaluate(
    "document.querySelector('#linked').scrollIntoView({block:'center'})",
    frame
  );
  await Bun.sleep(150);
  await frameClick('#linked', frame);
  await wait("window.__proofOpened.includes('https://example.invalid/image')");
  assert.equal(
    (await store.listComments(relicId)).length,
    3,
    'a linked-image click must not create a comment'
  );
  await evaluate(
    `window.postMessage({type:'relic:frame-image',anchor:{kind:'image',path:[],source_sha256:'0'.repeat(64)},box:{left:1,top:1,width:10,height:10}},'*')`
  );
  await Bun.sleep(150);
  assert.equal(
    await evaluate<boolean>("!!document.querySelector('.popover-composer')"),
    false,
    'wrong-source frame message opened a composer'
  );
  const messages = await evaluate<string>(
    'JSON.stringify(window.__proofMessages)'
  );
  assert.ok(
    !messages.includes(new URL(url).hash.slice(1)),
    'fragment key leaked to frame messages'
  );
  for (const body of [
    'First image comment',
    'Second image comment',
    'Another first image comment',
  ]) {
    assert.ok(
      !messages.includes(body),
      'comment body leaked to frame messages'
    );
  }
  const readback = await mcp('relic_read_comments', {
    relic_id: relicId,
    version: 1,
  });
  const readText = JSON.stringify(readback);
  for (const body of [
    'First image comment',
    'Second image comment',
    'Another first image comment',
  ])
    assert.ok(readText.includes(body), `MCP readback missing ${body}`);
  assert.ok(
    Array.isArray(readback['comments']),
    'MCP readback must contain comments'
  );
  const opened = readback['comments'] as Array<{
    comment_id: string;
    body: string;
    anchor: { kind: string; path: unknown; source_sha256: string };
  }>;
  const anchors = ids.map((id) => {
    const comment = opened.find((entry) => entry.comment_id === id);
    assert.ok(
      comment && comment.anchor?.kind === 'image',
      `missing image anchor for ${id}`
    );
    assert.match(comment.anchor.source_sha256, /^[0-9a-f]{64}$/);
    return comment.anchor;
  });
  assert.deepEqual(
    anchors[0],
    anchors[2],
    'comments on the same image must carry the same locator'
  );
  assert.notDeepEqual(
    anchors[0]?.path,
    anchors[1]?.path,
    'duplicate sources must retain distinct paths'
  );
  assert.equal(
    anchors[0]?.source_sha256,
    anchors[1]?.source_sha256,
    'identical authored sources must have identical fingerprints'
  );
  await evaluate(
    "document.querySelector('#first').scrollIntoView({block:'center'})",
    frame
  );
  await Bun.sleep(150);
  await frameClick(`.relic-image-mark[data-comment-id="${ids[0]}"]`, frame);
  await wait("document.querySelector('.popover-card .popover-edit')");
  await evaluate(
    "document.querySelector('.popover-card .popover-edit').click()"
  );
  await wait("document.querySelector('.popover-card textarea.popover-field')");
  await evaluate(
    `(() => { const field=document.querySelector('.popover-card textarea.popover-field'); field.value='Edited first image comment'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`
  );
  const beforeDraftActivation = await evaluate<number>('window.__proofMessages.length');
  await frameClick('.relic-image-control', frame, 0);
  await wait(`window.__proofMessages.slice(${beforeDraftActivation}).some(m => m.type === 'relic:frame-image')`);
  assert.equal(
    await evaluate<string>("document.querySelector('.popover-card textarea.popover-field')?.value"),
    'Edited first image comment',
    'image activation must not replace an edit draft'
  );
  console.log('IMAGE_EDIT_DRAFT_PRESERVED');
  await evaluate(
    "document.querySelector('.popover-card .popover-action.is-primary').click()"
  );
  await wait(
    `document.querySelector('.popover-card[data-comment-id="${ids[0]}"]')?.textContent.includes('Edited first image comment')`
  );
  const editedReadback = await mcp('relic_read_comments', {
    relic_id: relicId,
    version: 1,
  });
  assert.ok(Array.isArray(editedReadback['comments']));
  const edited = (editedReadback['comments'] as typeof opened).find(
    (entry) => entry.comment_id === ids[0]
  );
  assert.equal(edited?.body, 'Edited first image comment');
  assert.deepEqual(
    edited?.anchor,
    anchors[0],
    'editing must reseal the original locator'
  );
  await dismissCard();
  await wait("!document.querySelector('.popover-card[data-comment-id]')");
  await evaluate("document.querySelector('.thread-toggle').click()");
  await wait("!document.querySelector('.thread').classList.contains('is-open')");
  for (const width of [1440, 390, 320])
    for (const scheme of ['light', 'dark']) {
      console.log('IMAGE_GEOMETRY', width, scheme);
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await Bun.sleep(100);
      await evaluate(
        "document.querySelector('#first').scrollIntoView({block:'center'})",
        frame
      );
      await Bun.sleep(150);
      try {
        await wait(
          `document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`,
          frame
        );
      } catch (error) {
        const state = await evaluate<unknown>(`(() => ({messages:window.__proofMessages.slice(-30), thread:document.querySelector('.thread')?.outerHTML}))()`);
        const frameState = await evaluate<unknown>(`(() => ({marks:[...document.querySelectorAll('.relic-image-mark')].map(e=>e.outerHTML), images:[...document.querySelectorAll('img')].map(e=>e.outerHTML)}))()`, frame);
        throw new Error(`Resize marks missing: ${JSON.stringify({width,scheme,state,frameState})}`, {cause:error});
      }
      await frameClick(`.relic-image-mark[data-comment-id="${ids[0]}"]`, frame);
      await wait(
        `document.querySelector('.popover-card[data-comment-id="${ids[0]}"]')`
      );
      const card = await evaluate<{
        left: number;
        right: number;
        top: number;
        bottom: number;
        width: number;
        height: number;
      }>(
        `(() => { const r=document.querySelector('.popover-card').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; })()`
      );
      assert.ok(
        card.width > 0 &&
          card.height > 0 &&
          card.left >= 0 &&
          card.right <= width &&
          card.top >= 0 &&
          card.bottom <= 900,
        'comment card must fit the viewport'
      );
      const data = await evaluate<{
        images: Array<{ x: number; y: number; width: number; height: number }>;
        marks: Array<{
          id: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
        outlines: Array<{
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
      }>(
        `(() => { const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}; return {images:[...document.querySelectorAll('img')].map(rect), marks:[...document.querySelectorAll('.relic-image-mark')].map(e=>({id:e.dataset.commentId,...rect(e)})), outlines:[...document.querySelectorAll('.relic-image-outline')].map(rect)}; })()`,
        frame
      );
      assert.equal(
        data.marks.length,
        3,
        'all comment marks must remain placed'
      );
      for (const [index, id] of ids.entries()) {
        const mark = data.marks.find((item) => item.id === id);
        const imageRect = data.images[index === 1 ? 1 : 0];
        assert.ok(mark && imageRect, `missing geometry for ${id}`);
        const x = mark.x + mark.width / 2;
        const y = mark.y + mark.height / 2;
        assert.ok(
          x >= imageRect.x - 48 &&
            x <= imageRect.x + imageRect.width + 48 &&
            y >= imageRect.y - 48 &&
            y <= imageRect.y + imageRect.height + 48,
          `mark ${id} is not adjacent to its own image`
        );
      }
      if (width === 1440 && scheme === 'light') {
        const displaced = await evaluate<{ x: number; y: number }>(
          `(() => {
          const mark=document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]');
          const target=document.querySelector('#second').getBoundingClientRect();
          const left=mark.style.left, top=mark.style.top;
          mark.style.left=(target.left+target.width/2-mark.offsetWidth/2)+'px'; mark.style.top=(target.top+target.height/2-mark.offsetHeight/2)+'px';
          const r=mark.getBoundingClientRect();
          mark.style.left=left; mark.style.top=top;
          return {x:r.left+r.width/2,y:r.top+r.height/2};
        })()`,
          frame
        );
        const first = data.images[0];
        assert.ok(first);
        assert.throws(
          () =>
            assert.ok(
              displaced.x >= first.x - 48 &&
                displaced.x <= first.x + first.width + 48 &&
                displaced.y >= first.y - 48 &&
                displaced.y <= first.y + first.height + 48
            ),
          'identity/geometry check must reject the mark displaced to the duplicate image'
        );
      }
      geometry.push({ width, scheme, data, card });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        join(receipts, `${width}-${scheme}.png`),
        Buffer.from(String(shot['data']), 'base64')
      );
      await dismissCard();
      await wait("!document.querySelector('.popover-card[data-comment-id]')");
    }
  await evaluate(
    "document.querySelector('#first').setAttribute('src', document.querySelector('#first').getAttribute('src') + '#changed')",
    frame
  );
  await wait(
    `!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]') && !document.querySelector('.relic-image-mark[data-comment-id="${ids[2]}"]')`,
    frame
  );
  await wait(
    `document.querySelector('.comment[data-comment-id="${ids[0]}"] .comment-unplaceable')`
  );
  assert.ok(
    await evaluate<boolean>(
      `document.querySelector('.comment[data-comment-id="${ids[0]}"]').textContent.includes('Edited first image comment')`
    ),
    'unplaceable comment body must remain readable'
  );
  assert.ok(
    await evaluate<boolean>(
      `!!document.querySelector('.relic-image-mark[data-comment-id="${ids[1]}"]')`,
      frame
    ),
    'changed image must not steal or remove the duplicate image mark'
  );
  assert.equal((await store.listComments(relicId)).length, 3);
  await writeFile(
    join(receipts, 'rectangles.json'),
    JSON.stringify(geometry, null, 2)
  );
  assert.equal(
    blocked.length,
    0,
    `unexpected external requests: ${blocked.join(', ')}`
  );
  console.log(`Receipts: ${receipts}`);
  console.log('HTML_IMAGE_COMMENTS_PATH_OK');
} finally {
  cdp.dispose();
  browser.kill('SIGKILL');
  service.stop();
  usercontent.stop();
  // The default receipts directory is kept so a failed or successful run can be inspected.
  if (process.env['RELIC_IMAGE_SHOTS_DIR'])
    await rm(scratch, { recursive: true, force: true });
}
