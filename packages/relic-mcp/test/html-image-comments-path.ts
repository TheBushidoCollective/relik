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
      `(async () => {
        const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!e) throw Error('missing frame control');
        e.scrollIntoView({block:'nearest',inline:'nearest'});
        // A scroll schedules image-row placement on the next animation frame.
        // Measure after that work paints, never synchronously against the old row.
        const { promise, resolve } = Promise.withResolvers();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        await promise;
        const r = e.getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2};
      })()`,
      context
    );
    const frame = await evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector('iframe.usercontent-frame').getBoundingClientRect(); return {x:r.left,y:r.top}; })()`
    );
    // The control only shows while the pointer is over its image.
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: frame.x + box.x,
      y: frame.y + box.y,
    });
    await Bun.sleep(60);
    const target = await evaluate<{ x: number; y: number; hit: boolean }>(
      `(() => {
        const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {x, y, hit: hit === e || e.contains(hit)};
      })()`,
      context
    );
    assert.equal(
      target.hit,
      true,
      `frame click target is not hit-testable inside the frame: ${selector}`
    );
    // The frame's own hit test cannot see parent UI drawn over the iframe, such
    // as a composer. The same viewport point must reach the iframe in the parent.
    const parentX = frame.x + target.x;
    const parentY = frame.y + target.y;
    const parentHit = await evaluate<{ hit: boolean; top: string | null }>(
      `(() => {
        const frame = document.querySelector('iframe.usercontent-frame');
        const top = document.elementFromPoint(${parentX}, ${parentY});
        return { hit: top === frame, top: top?.outerHTML.slice(0, 240) ?? null };
      })()`
    );
    assert.equal(
      parentHit.hit,
      true,
      `frame click target is covered in the parent: ${selector} ${parentHit.top}`
    );
    if (touch) {
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 1,
      });
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: frame.x + target.x, y: frame.y + target.y }],
      });
      await send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    } else {
      await click(frame.x + target.x, frame.y + target.y);
    }
  };
  const assertImageRows = async (label: string) => {
    const measured = await evaluate<{
      issues: string[];
      rows: unknown[];
    }>(
      `(() => {
      const issues = [], rows = [];
      for (const row of document.querySelectorAll('.relic-image-row:not([hidden])')) {
        const r = row.getBoundingClientRect();
        const buttons = [...row.querySelectorAll('button')].map(button => {
          const b = button.getBoundingClientRect(), s = getComputedStyle(button);
          if (Math.abs(b.width - 28) > .5 || Math.abs(b.height - 28) > .5)
            issues.push('not a 28px circle');
          if (s.borderRadius !== '50%') issues.push('not circular');
          const svg = button.querySelector('svg');
          if (!svg?.querySelector('path') || svg.getAttribute('viewBox') !== '0 0 512 512')
            issues.push('missing inline Font Awesome glyph');
          if (button.classList.contains('relic-image-mark') && button.textContent.includes('•'))
            issues.push('old dot marker remains');
          return { id: button.dataset.commentId ?? 'add', left: b.left, right: b.right,
            top: b.top, width: b.width, height: b.height };
        });
        for (let i = 1; i < buttons.length; i++) {
          if (Math.abs(buttons[i].top - buttons[0].top) > .5) issues.push('wrapped row');
          if (buttons[i].left - buttons[i-1].right < 9.5) issues.push('overlapping buttons');
        }
        if (r.left < -.5 || r.right > innerWidth + .5 ||
            r.top < -.5 || r.bottom > innerHeight + .5) issues.push('row outside viewport');
        rows.push({ left: r.left, top: r.top, width: r.width, height: r.height,
          scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, buttons });
      }
      return { issues, rows };
    })()`,
      frame
    );
    assert.deepEqual(
      measured.issues,
      [],
      `${label}: ${JSON.stringify(measured)}`
    );
    assert.ok(measured.rows.length > 0, `${label}: no visible image rows`);
    geometry.push({ label, ...measured });
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
  await wait(
    "window.__proofMessages.some(message => message.type === 'relic:tree')"
  );
  const tree = await evaluate<{ tag: string; children: unknown[] }>(
    "window.__proofMessages.find(message => message.type === 'relic:tree').tree"
  );
  const treeTags = (node: unknown): string[] => {
    const value = node as { tag: string; children: unknown[] };
    return [value.tag, ...value.children.flatMap(treeTags)];
  };
  assert.equal(treeTags(tree).filter((tag) => tag === 'img').length, 3);
  assert.ok(
    !treeTags(tree).includes('button'),
    'shim buttons entered comparison'
  );
  assert.equal(
    await evaluate(
      "document.body.contains(document.querySelector('.relic-image-layer'))",
      frame
    ),
    false,
    'shim layer must not enter later body snapshots'
  );
  await evaluate(
    `(() => {
    const scroll = document.querySelector('.scroll');
    const image = document.querySelector('#first');
    const clip = scroll.getBoundingClientRect();
    const rect = image.getBoundingClientRect();
    scroll.scrollTop += rect.bottom - clip.top - 15;
  })()`,
    frame
  );
  await wait(
    `(() => {
    const control = document.querySelectorAll('.relic-image-control')[0];
    const clip = document.querySelector('.scroll').getBoundingClientRect();
    const image = document.querySelector('#first').getBoundingClientRect();
    const rect = control.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // A fixed circle anchored to the visible corner, never squeezed into
    // the clipped sliver and never an oval.
    return !control.hidden && image.top < clip.top && image.bottom > clip.top &&
      Math.abs(rect.width - rect.height) < 0.5 &&
      cx >= image.left && cx <= image.right + 0.5 &&
      cy >= clip.top - 0.5 && cy <= image.bottom + 0.5;
  })()`,
    frame
  );
  await evaluate("document.querySelector('.scroll').scrollTop += 50", frame);
  await wait(
    "document.querySelectorAll('.relic-image-control')[0].hidden",
    frame
  );
  await evaluate("document.querySelector('.scroll').scrollTop = 0", frame);
  await wait(
    "!document.querySelectorAll('.relic-image-control')[0].hidden",
    frame
  );
  await evaluate(
    "document.querySelector('#first').style.transform = 'translateX(-5000px)'",
    frame
  );
  await wait(
    "document.querySelectorAll('.relic-image-control')[0].hidden",
    frame
  );
  await evaluate(
    "document.querySelector('#first').style.transform = ''",
    frame
  );
  await wait(
    "!document.querySelectorAll('.relic-image-control')[0].hidden",
    frame
  );
  // The control is hover-only: invisible and inert at rest, shown for the
  // hovered image alone, and always a circle.
  const controlStates = `[...document.querySelectorAll('.relic-image-control')].map(c => { const s = getComputedStyle(c); const r = c.getBoundingClientRect(); return { shown: c.classList.contains('is-shown'), opacity: s.opacity, events: s.pointerEvents, round: Math.abs(r.width - r.height) < 0.5 }; })`;
  await evaluate(
    "document.querySelector('#first').scrollIntoView({block:'center'})",
    frame
  );
  await Bun.sleep(150);
  const resting = await evaluate<
    { shown: boolean; opacity: string; events: string; round: boolean }[]
  >(controlStates, frame);
  assert.ok(
    resting.every(
      (state) =>
        !state.shown &&
        state.opacity === '0' &&
        state.events === 'none' &&
        state.round
    ),
    `controls must be hidden and inert at rest: ${JSON.stringify(resting)}`
  );
  const firstCenter = await evaluate<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('#first').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    frame
  );
  const frameOrigin = await evaluate<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('iframe.usercontent-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: frameOrigin.x + firstCenter.x,
    y: frameOrigin.y + firstCenter.y,
  });
  await Bun.sleep(300);
  const hovered = await evaluate<
    { shown: boolean; opacity: string; events: string; round: boolean }[]
  >(controlStates, frame);
  assert.deepEqual(
    hovered.map((state) => state.shown),
    [true, false, false],
    `only the hovered image shows its control: ${JSON.stringify(hovered)}`
  );
  assert.ok(
    hovered[0]?.opacity === '1' && hovered[0]?.events === 'auto',
    'the hovered control must be visible and interactive'
  );
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
    await wait(
      "document.querySelector('.relic-image-mark.is-pending')?.disabled === true",
      frame
    );
    await assertImageRows(`pending-${index}-${mode}`);
    await evaluate("document.querySelector('textarea.popover-field').focus()");
    await send('Input.insertText', { text: body });
    await evaluate(
      "document.querySelector('.popover-composer .popover-action.is-primary').click()"
    );
    if (body === 'First image comment') {
      await wait('window.__heldImagePlacements.length > 0');
      assert.equal(mutations, 0, 'must not post before image validation');
      assert.equal(
        await evaluate<boolean>(
          "document.querySelector('.popover-field').disabled"
        ),
        true
      );
      assert.doesNotMatch(
        await evaluate<string>(
          "document.querySelector('.popover-note').textContent"
        ),
        /unavailable/i
      );
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
  await evaluate(
    "document.querySelector('#first').style.display = 'none'",
    frame
  );
  // Hidden is recoverable concealment, not an invalid anchor. Preserve the
  // current visibility contract before exercising genuine target removal.
  await wait(
    "window.__heldImagePlacements.some(e => e.detail.status === 'concealed' && e.detail.concealment === 'hidden')"
  );
  assert.equal(mutations, beforeUnavailable);
  await evaluate(
    `(() => {
    window.__proofRemovedScroll = document.querySelector('.scroll');
    window.__proofRemovedScroll.remove();
  })()`,
    frame
  );
  await wait(
    "window.__heldImagePlacements.some(e => e.detail.status === 'unavailable')"
  );
  await evaluate('window.__releaseUnavailable()');
  await wait(
    "document.querySelector('.popover-note')?.textContent.includes('This image is unavailable')"
  );
  assert.equal(mutations, beforeUnavailable);
  assert.equal(
    await evaluate<string>("document.querySelector('.popover-field').value"),
    'Keep this unavailable draft'
  );
  assert.equal(
    await evaluate<boolean>(
      "document.querySelector('.popover-field').disabled"
    ),
    false
  );
  await evaluate(
    `(() => {
    document.body.appendChild(window.__proofRemovedScroll);
    delete window.__proofRemovedScroll;
    document.querySelector('#first').style.display = '';
  })()`,
    frame
  );
  await wait(
    "document.querySelectorAll('.relic-image-control').length === 3",
    frame
  );
  await evaluate(
    "document.querySelector('#second').scrollIntoView({block:'center'})",
    frame
  );
  // The restored composer can cover the second image's control in the parent,
  // so a pointer would land on the composer. Activate it with the keyboard and
  // prove the frame reported the second image while the draft guard held.
  const beforeRetarget = await evaluate<number>(
    'window.__proofMessages.length'
  );
  // Reattaching `.scroll` resets it to the top, where #second is clipped and
  // its control is correctly `hidden` (display:none, so unfocusable). The
  // scrollIntoView above only schedules the frame's next placement refresh;
  // focus must wait until that refresh has shown the control.
  await wait(
    `(() => {
      const control = document.querySelectorAll('.relic-image-control')[1];
      const image = document.querySelector('#second').getBoundingClientRect();
      const row = control?.parentElement;
      return !!control && !control.hidden && !row.hidden &&
        control.getClientRects().length > 0 &&
        Math.abs(control.getBoundingClientRect().top - (image.top + 8)) < .5;
    })()`,
    frame
  );
  await evaluate(
    "document.querySelectorAll('.relic-image-control')[1].focus()",
    frame
  );
  await wait(
    "document.activeElement === document.querySelectorAll('.relic-image-control')[1]",
    frame
  );
  await evaluate(
    "window.__retargetComposer = document.querySelector('.popover-composer')"
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
  await wait(
    `window.__proofMessages.slice(${beforeRetarget}).some(m =>
      m.type === 'relic:frame-image' &&
      m.anchor?.path?.at(-1)?.tag === 'img' &&
      m.anchor.path.at(-1).index === 1)`
  );
  // Product rule (main.ts compose guard): a framed image request never
  // redirects a composer holding unsaved text. The frame request above proves
  // the second image was activated; the guard must then leave the same
  // composer, its draft and the pending target untouched, with no second-row
  // pending mark. Let the parent and frame settle before checking absence.
  await evaluate(`(async () => {
    const { promise, resolve } = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
  })()`);
  await Bun.sleep(150);
  assert.equal(
    await evaluate<boolean>(
      "document.querySelector('.popover-composer') === window.__retargetComposer"
    ),
    true,
    'an image request must not replace a composer holding unsaved text'
  );
  assert.equal(
    await evaluate<boolean>(
      `(() => {
        const second = document.querySelectorAll('.relic-image-control')[1];
        return [...document.querySelectorAll('.relic-image-mark.is-pending')]
          .some(mark => mark.parentElement === second.parentElement);
      })()`,
      frame
    ),
    false,
    'an image request must not move the pending target under unsaved text'
  );
  assert.equal(
    await evaluate<string>("document.querySelector('.popover-field').value"),
    'Keep this unavailable draft'
  );
  assert.equal(mutations, beforeUnavailable);
  await evaluate(
    "document.querySelector('.popover-composer .popover-action.is-quiet').click()"
  );
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
        const control = mark.parentElement.querySelector('.relic-image-control').getBoundingClientRect();
        return Math.abs(mr.top - control.top) < .5 && Math.abs(mr.width - 28) < .5 &&
          Math.abs(mr.top - (ir.top + 8)) < .5 &&
          mr.left >= ir.left && mr.right <= ir.right;
      })()`,
      frame
    );
    await frameClick(`.relic-image-mark[data-comment-id="${id}"]`, frame);
    try {
      await wait(
        `document.querySelector('.popover-card[data-comment-id="${id}"]')`
      );
    } catch (error) {
      const state = await evaluate<unknown>(
        `(() => ({popover:document.querySelector('.popover')?.outerHTML, messages:window.__proofMessages.slice(-20), thread:document.querySelector('.thread')?.outerHTML.slice(0,2000)}))()`
      );
      const mark = await evaluate<unknown>(
        `(() => {const e=document.querySelector('.relic-image-mark[data-comment-id="${id}"]');const r=e?.getBoundingClientRect();return {html:e?.outerHTML,rect:r?.toJSON(),hit:r && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML};})()`,
        frame
      );
      throw new Error(
        `Mark reopen failed: ${JSON.stringify({ index, id, state, mark })}`,
        { cause: error }
      );
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
  await evaluate(
    "document.querySelector('#first').scrollIntoView({block:'center'})",
    frame
  );
  await wait(
    `!!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`,
    frame
  );
  await evaluate(
    "document.querySelector('.scroll').scrollTop = document.querySelector('.scroll').scrollHeight",
    frame
  );
  await wait(
    `!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`,
    frame
  );
  await evaluate(
    "document.querySelector('#first').scrollIntoView({block:'center'})",
    frame
  );
  await wait(
    `!!document.querySelector('.relic-image-mark[data-comment-id="${ids[0]}"]')`,
    frame
  );
  const beforeRow = mutations;
  await evaluate("document.querySelector('.thread-toggle').click()");
  await wait(`document.querySelector('.comment[data-comment-id="${ids[0]}"]')`);
  for (const id of ids) {
    await evaluate(
      `document.querySelector('${id === ids[1] ? '#second' : '#first'}').scrollIntoView({block:'center'})`,
      frame
    );
    await wait(
      `!!document.querySelector('.relic-image-mark[data-comment-id="${id}"]')`,
      frame
    );
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
    const state = await evaluate<unknown>(
      `(() => ({messages:window.__proofMessages.slice(-30), thread:document.querySelector('.thread')?.outerHTML, popover:document.querySelector('.popover')?.outerHTML}))()`
    );
    throw new Error(`Row reopen failed: ${JSON.stringify(state)}`, {
      cause: error,
    });
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
  // Stress the real sandbox protocol without creating extra stored comments.
  // The circles must not shrink, wrap, overlap or leave the viewport when the
  // image is tiny, clipped to a sliver, or has more comments than fit.
  // The thread is open from the row-reopen step. Below 44rem an open thread
  // owns the whole row by design, which leaves the stage, and so the frame,
  // 0px wide. Measure the frame with the thread closed, then restore it.
  assert.equal(
    await evaluate<boolean>(
      "document.querySelector('.thread').classList.contains('is-open')"
    ),
    true,
    'stress setup expects the thread opened by the row-reopen step'
  );
  await evaluate("document.querySelector('.thread-toggle').click()");
  await wait(
    "!document.querySelector('.thread').classList.contains('is-open')"
  );
  for (const width of [1440, 320]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(`innerWidth === ${width}`);
    await wait(
      `(() => {
        const frame = document.querySelector('iframe.usercontent-frame').getBoundingClientRect();
        return frame.width > 0 && frame.height > 0;
      })()`
    );
    for (const scenario of ['small', 'clipped']) {
      await evaluate(
        `(() => {
        const image = document.querySelector('#first');
        image.style.width = ${JSON.stringify('18px')};
        image.style.height = ${JSON.stringify('10px')};
        if (${JSON.stringify(scenario)} === 'clipped') {
          image.style.width = '220px'; image.style.height = '120px';
        }
        image.scrollIntoView({block:'center'});
      })()`,
        frame
      );
      if (scenario === 'clipped')
        await evaluate(
          `(() => {
          const scroll = document.querySelector('.scroll');
          const image = document.querySelector('#first').getBoundingClientRect();
          scroll.scrollTop += image.bottom - scroll.getBoundingClientRect().top - 15;
        })()`,
          frame
        );
      // A parent repaint (window resize, or the stage's ResizeObserver after
      // the frame's content height changes) clears every frame mark and
      // repaints only stored comments, with fresh request ids. Injected
      // protocol marks posted before that repaint lands are rightly wiped, so
      // wait until the parent's repaint stream is quiet before injecting.
      const realRequestIds = `Math.max(0, ...window.__proofMessages
        .filter(m => m?.type === 'relic:frame-image-placement' &&
          ${JSON.stringify(ids)}.includes(m.id))
        .map(m => m.requestId))`;
      let settledRequestId = -1;
      for (let stable = 0, n = 0; stable < 4; n++) {
        assert.ok(n < 100, 'parent mark repaints never settled');
        await evaluate(`(async () => {
          const { promise, resolve } = Promise.withResolvers();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          await promise;
        })()`);
        await Bun.sleep(150);
        const current = await evaluate<number>(realRequestIds);
        stable = current === settledRequestId ? stable + 1 : 0;
        settledRequestId = current;
      }
      const beforeStress = await evaluate<number>(
        'window.__proofMessages.length'
      );
      await evaluate(`(() => {
        const frame = document.querySelector('iframe.usercontent-frame');
        for (let i = 0; i < 12; i++) frame.contentWindow.postMessage({
          type: 'relic:paint-mark',
          mark: { ...${JSON.stringify(anchors[0])}, id: 'image-stress-' + i, requestId: 9000 + i }
        }, '*');
        frame.contentWindow.postMessage({ type: 'relic:paint-mark',
          mark: { ...${JSON.stringify(anchors[0])}, id: 'pending:target', requestId: 9100 } }, '*');
      })()`);
      try {
        await wait(
          'document.querySelectorAll(\'.relic-image-mark[data-comment-id^="image-stress-"]\').length === 12',
          frame
        );
      } catch (error) {
        const frameState = await evaluate<unknown>(
          `(() => {
          const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
          return {
            size: {innerWidth, innerHeight},
            first: rect(document.querySelector('#first')),
            firstStyle: document.querySelector('#first')?.getAttribute('style'),
            scroll: rect(document.querySelector('.scroll')),
            marks: [...document.querySelectorAll('.relic-image-mark')].map(e => ({id:e.dataset.commentId, rect:rect(e), row:rect(e.parentElement)})),
            rows: [...document.querySelectorAll('.relic-image-row')].map(r => ({hidden:r.hidden, rect:rect(r), children:r.children.length})),
            layer: !!document.querySelector('.relic-image-layer')?.isConnected,
          };
        })()`,
          frame
        );
        const messages = await evaluate<unknown>(
          `window.__proofMessages.slice(${beforeStress}).map(m => ({type:m?.type,id:m?.id,status:m?.status,concealment:m?.concealment,requestId:m?.requestId})).slice(-80)`
        );
        throw new Error(
          `Stress marks missing: ${JSON.stringify({ width, scenario, anchor: anchors[0], settledRequestId, latestRequestId: await evaluate<number>(realRequestIds), frameState, messages })}`,
          { cause: error }
        );
      }
      await wait(
        "document.querySelector('.relic-image-mark.is-pending')?.disabled",
        frame
      );
      await assertImageRows(`${width}-${scenario}-many`);
      const overflow = await evaluate<boolean>(
        `(() => {
        const row = document.querySelector('.relic-image-mark[data-comment-id="image-stress-0"]').parentElement;
        return row.scrollWidth > row.clientWidth;
      })()`,
        frame
      );
      assert.equal(
        overflow,
        true,
        'many comments must overflow into a scrollable row'
      );
      await evaluate(
        'document.querySelector(\'.relic-image-mark[data-comment-id="image-stress-0"]\').focus()',
        frame
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      await evaluate(
        'document.querySelector(\'.relic-image-mark[data-comment-id="image-stress-0"]\').focus()',
        frame
      );
      await wait(
        `(() => {
        const button = document.querySelector('.relic-image-mark[data-comment-id="image-stress-0"]');
        const b = button.getBoundingClientRect(), r = button.parentElement.getBoundingClientRect();
        return document.activeElement === button && button.matches(':focus-visible') &&
          b.left >= r.left + 5.5 && b.right <= r.right - 5.5;
      })()`,
        frame
      );
      await evaluate(`(() => {
        const frame = document.querySelector('iframe.usercontent-frame');
        frame.contentWindow.postMessage({type:'relic:active-mark', id:'image-stress-0'}, '*');
        frame.contentWindow.postMessage({type:'relic:quiet-marks', ids:['image-stress-1']}, '*');
      })()`);
      await wait(
        "document.querySelector('.relic-image-mark[data-comment-id=\"image-stress-0\"]').classList.contains('is-active') && document.querySelector('.relic-image-mark[data-comment-id=\"image-stress-1\"]').classList.contains('is-resolved')",
        frame
      );
      await assertImageRows(`${width}-${scenario}-focused`);
      assert.equal(
        await evaluate<number>(realRequestIds),
        settledRequestId,
        'parent repainted marks during the stress measurement'
      );
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        join(receipts, `markers-${width}-${scenario}.png`),
        Buffer.from(String(shot['data']), 'base64')
      );
      await evaluate(`(() => {
        const frame = document.querySelector('iframe.usercontent-frame');
        for (const id of [...Array.from({length:12}, (_, i) => 'image-stress-' + i), 'pending:target'])
          frame.contentWindow.postMessage({type:'relic:clear-mark', id}, '*');
        frame.contentWindow.postMessage({type:'relic:active-mark', id:null}, '*');
        frame.contentWindow.postMessage({type:'relic:quiet-marks', ids:[]}, '*');
      })()`);
      await wait(
        "!document.querySelector('.relic-image-mark[data-comment-id^=\"image-stress-\"]') && !document.querySelector('.relic-image-mark.is-pending')",
        frame
      );
    }
  }
  await evaluate(
    "document.querySelector('#first').removeAttribute('style')",
    frame
  );
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate("document.querySelector('.thread-toggle').click()");
  await wait("document.querySelector('.thread').classList.contains('is-open')");
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
  const beforeDraftActivation = await evaluate<number>(
    'window.__proofMessages.length'
  );
  await frameClick('.relic-image-control', frame, 0);
  await wait(
    `window.__proofMessages.slice(${beforeDraftActivation}).some(m => m.type === 'relic:frame-image')`
  );
  assert.equal(
    await evaluate<string>(
      "document.querySelector('.popover-card textarea.popover-field')?.value"
    ),
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
  await wait(
    "!document.querySelector('.thread').classList.contains('is-open')"
  );
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
        const state = await evaluate<unknown>(
          `(() => ({messages:window.__proofMessages.slice(-30), thread:document.querySelector('.thread')?.outerHTML}))()`
        );
        const frameState = await evaluate<unknown>(
          `(() => ({marks:[...document.querySelectorAll('.relic-image-mark')].map(e=>e.outerHTML), images:[...document.querySelectorAll('img')].map(e=>e.outerHTML)}))()`,
          frame
        );
        throw new Error(
          `Resize marks missing: ${JSON.stringify({ width, scheme, state, frameState })}`,
          { cause: error }
        );
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
      await assertImageRows(`${width}-${scheme}-posted`);
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
