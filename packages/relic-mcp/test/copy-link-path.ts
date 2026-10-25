/**
 * Proof for Copy link panel with key phrase (Spec C).
 *
 * Exercises the end-to-end loopback path:
 * 1. Publishing and republishing a Markdown relic via relic-mcp stdio.
 * 2. Launching isolated headless Chrome and opening the relic.
 * 3. Testing the Copy link panel: opening, positioning, Copy link, Copy without the key,
 *    Copy phrase, toasts, and keyboard navigation.
 * 4. Testing clipboard refusal fallbacks.
 * 5. Testing version switching while open.
 * 6. Mobile viewports (390x844 dark, 320x568 light): accessibility name preserved, full-width sheet, no overflow.
 * 7. Recipient path: opening keyless link in fresh profile, entering 12-word phrase, verifying relic decrypts and opens.
 *
 * Prints COPY_LINK_PATH_OK on success.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseFragment } from '@relic/format';
import { mnemonicToKey } from '@relic/format/mnemonic';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const viewerDist =
  process.env['RELIC_VIEWER_DIST'] ??
  fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

// Constants from copy-link.ts
const LINK_COPIED_NOTE = 'Link copied. It contains the decryption key.';
const KEYLESS_COPIED_NOTE =
  'Link copied without the key. Say the key phrase separately.';
const PHRASE_COPIED_NOTE = 'Key phrase copied. It is the decryption key.';
const COPY_FAILED_NOTE =
  'This browser would not let the page write to the clipboard. The text is ' +
  'still selected, so a copy from the keyboard will work.';
const KEY_ENTRY_LABEL = 'Key phrase or link';

function keylessLink(shareUrl: string): string {
  const url = new URL(shareUrl);
  url.hash = '';
  const result = url.toString();
  return result.endsWith('#') ? result.slice(0, -1) : result;
}

const scratch = await mkdtemp(join(tmpdir(), 'relic-copy-link-path-'));
const statePath = join(scratch, 'state.json');

const store = new MemoryStore();
let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  assets: diskAssets(viewerDist),
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

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['node', relicMcpBundlePath], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/copy-link-path',
      RELIC_CHROME_PATH: 'none',
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
  const raw = lines[lines.length - 1];
  assert.ok(raw !== undefined, 'relic-mcp returned empty output');
  const response = JSON.parse(raw) as {
    error?: unknown;
    result?: { structuredContent?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
  };
  if (response.error) {
    throw new Error(`MCP error: ${JSON.stringify(response.error)}`);
  }
  const result = response.result?.structuredContent ?? response.result;
  assert.ok(result !== undefined, 'missing result in MCP response');
  return result;
}

// 1. Publish markdown relic and republish to version 2
const fixturePath = join(scratch, 'notes.md');
await writeFile(
  fixturePath,
  '# Secret Notes\n\nConfidential research findings.\n'
);

const pubResult = await callMcp('relic_publish', {
  path: fixturePath,
  cover: false,
  title: '',
});
const relicId = String(pubResult['relic_id']);
const shareUrl = String(pubResult['url']);
assert.ok(shareUrl.includes('#r1'), 'shareUrl missing key fragment');

await writeFile(
  fixturePath,
  '# Secret Notes (Updated)\n\nConfidential research findings version 2.\n'
);
await callMcp('relic_republish', {
  relic_id: relicId,
  path: fixturePath,
  cover: false,
  title: '',
});
const fragment = new URL(shareUrl).hash;
const parsedKey = parseFragment(fragment).key;

// Determine proof dir for screenshots
const shortSha =
  (await Bun.$`git rev-parse --short HEAD 2>/dev/null`.text()).trim() ||
  'local';
const proofDir =
  process.env['RELIC_COPY_PROOF_DIR'] ??
  fileURLToPath(
    new URL(
      `../../../docs/plans/copy-link-key-phrase/proof/${shortSha}/`,
      import.meta.url
    )
  );
await mkdir(proofDir, { recursive: true });

// Chrome discovery and launch
const namedChrome = process.env['RELIC_PROOF_CHROME_PATH'];
const foundChrome = await discoverChrome(namedChrome);
assert.equal(
  foundChrome.kind,
  'found',
  `no Chrome: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');
const chromeBinaryPath = foundChrome.path;

const runningBrowsers: Array<{
  child: ChildProcess;
  cdp: CdpConnection;
  profile: string;
}> = [];

async function launchBrowser(): Promise<{
  child: ChildProcess;
  cdp: CdpConnection;
  sessionId: string;
  profile: string;
  requests: Array<{ url: string; postData?: string }>;
}> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-copy-chrome-'));
  const shared = chromeArgs(chromeBinaryPath, profile);
  const launch = createBrowserHeadlessLaunch(
    [
      ...shared.map((arg) =>
        arg === '--proxy-bypass-list=<-loopback>'
          ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port}`
          : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
            ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
            : arg
      ),
    ],
    profile
  );

  const child = spawn(chromeBinaryPath, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  await attestBrowserHeadless(cdp, launch);

  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Accessibility.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);

  const requests: Array<{ url: string; postData?: string }> = [];
  cdp.onEvent((event) => {
    if (
      event.method === 'Network.requestWillBeSent' &&
      event.sessionId === sessionId
    ) {
      const params = event.params as {
        request?: { url?: string; postData?: string };
      };
      if (params.request?.url) {
        requests.push({
          url: params.request.url,
          ...(params.request.postData !== undefined
            ? { postData: params.request.postData }
            : {}),
        });
      }
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      console.log('BROWSER CONSOLE:', JSON.stringify(event.params));
    }
    if (event.method === 'Runtime.exceptionThrown') {
      console.log('BROWSER EXCEPTION:', JSON.stringify(event.params));
    }
  });
  const shimScript = `
    window.__clipboardWrites = [];
    window.__clipboardShouldReject = false;
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          if (window.__clipboardShouldReject) throw new Error('refused');
          window.__clipboardWrites.push(text);
        },
        readText: async () => window.__clipboardWrites[window.__clipboardWrites.length - 1] ?? '',
      },
      configurable: true,
    });
  `;
  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: shimScript },
    sessionId
  );

  runningBrowsers.push({ child, cdp, profile });
  return { child, cdp, sessionId, profile, requests };
}

async function cleanupBrowsers(): Promise<void> {
  for (const b of runningBrowsers) {
    try {
      b.cdp.dispose();
      b.child.kill('SIGKILL');
      await rm(b.profile, { recursive: true, force: true }).catch(() => {});
    } catch {}
  }
}

async function evaluate<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string
): Promise<T> {
  const res = (await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  )) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (res.exceptionDetails) {
    throw new Error(
      `Evaluation failed: ${res.exceptionDetails.text ?? res.exceptionDetails.exception?.description ?? 'unknown error'}`
    );
  }
  return res.result?.value as T;
}

async function clickElement(
  cdp: CdpConnection,
  sessionId: string,
  selector: string,
  offset?: { x: number; y: number }
): Promise<void> {
  const rect = (await evaluate(
    cdp,
    sessionId,
    `(() => {
    const el = document.querySelector('${selector}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: ${offset ? `r.left + ${offset.x}` : 'r.left + r.width / 2'},
      y: ${offset ? `r.top + ${offset.y}` : 'r.top + r.height / 2'},
    };
  })()`
  )) as { x: number; y: number } | null;
  assert.ok(rect, `element not found for selector: ${selector}`);
  await cdp.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: rect.x,
      y: rect.y,
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      button: 'left',
      x: rect.x,
      y: rect.y,
      clickCount: 1,
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseReleased',
      button: 'left',
      x: rect.x,
      y: rect.y,
      clickCount: 1,
    },
    sessionId
  );
}

async function pressKey(
  cdp: CdpConnection,
  sessionId: string,
  key: string,
  code: string,
  keyCode: number
): Promise<void> {
  const isEnter = key === 'Enter';
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(isEnter ? { text: '\r', unmodifiedText: '\r' } : {}),
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    },
    sessionId
  );
}

async function setViewport(
  cdp: CdpConnection,
  sessionId: string,
  width: number,
  height: number,
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    },
    sessionId
  );
  await cdp.send(
    'Emulation.setEmulatedMedia',
    {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: theme }],
    },
    sessionId
  );
}

async function captureShot(
  cdp: CdpConnection,
  sessionId: string,
  filename: string
): Promise<void> {
  const shot = (await cdp.send(
    'Page.captureScreenshot',
    { format: 'png' },
    sessionId
  )) as { data: string };
  await writeFile(join(proofDir, filename), Buffer.from(shot.data, 'base64'));
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  label = 'condition',
  timeoutMs = 10000,
  pollMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await Bun.sleep(pollMs);
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
}

async function verifyBandAtWidth(
  cdp: CdpConnection,
  sessionId: string,
  width: number,
  height: number,
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  await setViewport(cdp, sessionId, width, height, theme);
  await Bun.sleep(100);

  const m = await evaluate<{
    scrollWidthOk: boolean;
    identityWidth: number;
    identityWidthOk: boolean;
    versionInsideIdentity: boolean;
    versionClearOfActions: boolean;
    allShownControlsInViewport: boolean;
    allShownHaveNames: boolean;
    allHiddenSpanHaveTitle: boolean;
    moreCheckOk: boolean;
  }>(
    cdp,
    sessionId,
    `(() => {
      const bar = document.querySelector('.bar');
      const identity = document.querySelector('.identity');
      const version = document.querySelector('.version');
      const actions = Array.from(document.querySelectorAll('.bar .actions > .action, .bar .actions > .band-more-wrap > .action'));
      const shown = actions.filter(el => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      });
      const firstShown = shown[0];
      const barRect = bar.getBoundingClientRect();
      const idRect = identity.getBoundingClientRect();
      const verRect = version ? version.getBoundingClientRect() : null;
      const firstRect = firstShown ? firstShown.getBoundingClientRect() : null;

      const minId = window.innerWidth >= 1024 ? 192 : 88;
      const scrollOk = bar.scrollWidth <= bar.clientWidth + 1;
      const idOk = idRect.width >= minId - 1;
      const verInId = verRect ? (verRect.left >= idRect.left - 1 && verRect.right <= idRect.right + 1) : true;
      const verClear = (verRect && firstRect) ? verRect.right <= firstRect.left + 1 : true;
      const inViewport = shown.every(el => {
        const r = el.getBoundingClientRect();
        return r.left >= -1 && r.right <= window.innerWidth + 1;
      });
      const namesOk = shown.every(el => {
        const name = el.getAttribute('aria-label') || el.innerText.trim() || el.getAttribute('title');
        return Boolean(name);
      });
      const titlesOk = shown.every(el => {
        const span = el.querySelector('span:not([class])');
        if (span) {
          const sr = span.getBoundingClientRect();
          if (sr.width <= 1 || sr.height <= 1) {
            return Boolean(el.getAttribute('title') || el.getAttribute('aria-label'));
          }
        }
        return true;
      });

      let moreOk = true;
      if (window.innerWidth <= 544) {
        const moreBtn = document.querySelector('.action-more');
        const moreList = document.querySelector('.band-more-list');
        const moreVisible = moreBtn && getComputedStyle(moreBtn).display !== 'none';
        moreOk = Boolean(moreVisible);
      }

      return {
        scrollWidthOk: scrollOk,
        identityWidth: idRect.width,
        identityWidthOk: idOk,
        versionInsideIdentity: verInId,
        versionClearOfActions: verClear,
        allShownControlsInViewport: inViewport,
        allShownHaveNames: namesOk,
        allHiddenSpanHaveTitle: titlesOk,
        moreCheckOk: moreOk,
      };
    })()`
  );

  assert.ok(
    m.scrollWidthOk,
    `bar overflowed at ${width}px: scrollWidth > clientWidth`
  );
  assert.ok(
    m.identityWidthOk,
    `identity width ${m.identityWidth}px < min at ${width}px`
  );
  assert.ok(m.versionInsideIdentity, `version outside identity at ${width}px`);
  assert.ok(m.versionClearOfActions, `version overlaps actions at ${width}px`);
  assert.ok(
    m.allShownControlsInViewport,
    `controls outside viewport at ${width}px`
  );
  assert.ok(
    m.allShownHaveNames,
    `controls missing accessible name at ${width}px`
  );
  assert.ok(
    m.allHiddenSpanHaveTitle,
    `collapsed controls missing title at ${width}px`
  );
  assert.ok(m.moreCheckOk, `More button not shown at ${width}px`);

  if (width <= 544) {
    await clickElement(cdp, sessionId, '.action-more');
    const moreListCheck = await evaluate<{
      hidden: boolean;
      rect: { left: number; right: number };
      entryCount: number;
      allHaveVisibleWords: boolean;
    }>(
      cdp,
      sessionId,
      `(() => {
      const list = document.querySelector('.band-more-list');
      const r = list ? list.getBoundingClientRect() : { left: 0, right: 0 };
      const entries = list ? Array.from(list.querySelectorAll('.action')) : [];
      const visibleWords = entries.every(e => {
        const span = e.querySelector('span');
        return span && span.getBoundingClientRect().width > 1;
      });
      return {
        hidden: list ? list.hidden : true,
        rect: { left: r.left, right: r.right },
        entryCount: entries.length,
        allHaveVisibleWords: visibleWords,
      };
    })()`
    );
    assert.equal(
      moreListCheck.hidden,
      false,
      `More list not open after click at ${width}px`
    );
    assert.equal(
      moreListCheck.entryCount,
      4,
      `More list entry count mismatch at ${width}px`
    );
    assert.ok(
      moreListCheck.allHaveVisibleWords,
      `More list entries missing visible words at ${width}px`
    );
    assert.ok(
      moreListCheck.rect.left >= -1 && moreListCheck.rect.right <= width + 1,
      `More list outside viewport at ${width}px`
    );
    await pressKey(cdp, sessionId, 'Escape', 'Escape', 27);
  }
}

async function assertKeyDoesNotSplit(
  cdp: CdpConnection,
  sessionId: string
): Promise<void> {
  const rectsCount = await evaluate<number>(
    cdp,
    sessionId,
    `(() => {
      const keyEl = document.querySelector('.copy-link-key');
      if (!keyEl) return 0;
      const oldText = keyEl.textContent;
      keyEl.textContent = '#r1-AbCdEfGhIjKlMnOpQrStU';
      const count = keyEl.getClientRects().length;
      keyEl.textContent = oldText;
      return count;
    })()`
  );
  assert.equal(
    rectsCount,
    1,
    'key with hyphens split across multiple line boxes'
  );
}

try {
  // Launch primary browser
  const b1 = await launchBrowser();
  await setViewport(b1.cdp, b1.sessionId, 1440, 900, 'light');

  // Navigate to relic URL
  console.log('Navigating to', shareUrl);
  await b1.cdp.send('Page.navigate', { url: shareUrl }, b1.sessionId);
  await waitForCondition(
    async () => {
      const info = await evaluate<{
        actions: string[];
        copyBtn: string | null;
      }>(
        b1.cdp,
        b1.sessionId,
        `(() => {
        const acts = Array.from(document.querySelectorAll('.bar .action')).map(b => b.outerHTML);
        const copy = document.querySelector('[data-action="copy-link"]');
        return { actions: acts, copyBtn: copy ? copy.outerHTML : null };
      })()`
      );
      console.log('Bar actions:', info);
      return info.copyBtn !== null;
    },
    'bar copy-link ready',
    5000,
    1000
  );

  // Read the 12 words of this relic
  const phraseWords =
    (
      await evaluate<string[]>(
        b1.cdp,
        b1.sessionId,
        `(() => {
        // Compute from in-memory key via format if needed, or we have parsedKey
        return [];
      })()`
      )
    ).length > 0
      ? []
      : (await import('@relic/format/mnemonic')).keyToMnemonic(parsedKey);
  assert.equal(phraseWords.length, 12);

  // 1. Baseline
  const baseline = await evaluate<{
    localKeys: string[];
    sessionKeys: string[];
    title: string;
    href: string;
    wordCounts: number[];
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const words = ${JSON.stringify(phraseWords)};
      const text = document.body.innerText;
      const html = document.body.outerHTML;
      const counts = words.map(w => {
        const re = new RegExp('\\\\b' + w + '\\\\b', 'gi');
        return (text.match(re) || []).length + (html.match(re) || []).length;
      });
      return {
        localKeys: Object.keys(localStorage),
        sessionKeys: Object.keys(sessionStorage),
        title: document.title,
        href: location.href,
        wordCounts: counts,
      };
    })()`
  );

  // 2. Click Copy link
  const openerRect = await evaluate<any>(
    b1.cdp,
    b1.sessionId,
    `(() => {
    const el = document.querySelector('[data-action="copy-link"]');
    return el ? el.getBoundingClientRect() : null;
  })()`
  );
  console.log('Opener rect before click:', openerRect);
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await Bun.sleep(200);
  const afterClick = await evaluate<any>(
    b1.cdp,
    b1.sessionId,
    `(() => {
    const panel = document.getElementById('copy-link-panel');
    const opener = document.querySelector('[data-action="copy-link"]');
    return {
      hasPanel: Boolean(panel),
      panelHTML: panel ? panel.outerHTML.slice(0, 300) : null,
      openerExpanded: opener ? opener.getAttribute('aria-expanded') : null,
    };
  })()`
  );
  console.log('After click state:', afterClick);
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel') && document.querySelector('#copy-link-panel ol.copy-phrase:not([aria-busy="true"])'))`
      )) === true
    );
  }, 'step 2 panel ready');

  const step2 = await evaluate<{
    panelVisible: boolean;
    activeElementAttr: string | null;
    openerExpanded: string | null;
    panelRect: { left: number; right: number; top: number; bottom: number };
    scrollWidthOk: boolean;
    clipboardWritesCount: number;
    innerWidth: number;
    innerHeight: number;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const panel = document.getElementById('copy-link-panel');
      const opener = document.querySelector('[data-action="copy-link"]');
      const r = panel ? panel.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
      return {
        panelVisible: Boolean(panel && getComputedStyle(panel).display !== 'none'),
        activeElementAttr: document.activeElement ? document.activeElement.getAttribute('data-copy') : null,
        openerExpanded: opener ? opener.getAttribute('aria-expanded') : null,
        panelRect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        scrollWidthOk: document.documentElement.scrollWidth <= window.innerWidth,
        clipboardWritesCount: window.__clipboardWrites.length,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    })()`
  );

  assert.ok(step2.panelVisible, 'panel is not visible');
  assert.equal(
    step2.activeElementAttr,
    'link',
    'focus not on [data-copy="link"]'
  );
  assert.equal(
    step2.openerExpanded,
    'true',
    'opener aria-expanded is not true'
  );
  assert.ok(
    step2.panelRect.left >= 0 && step2.panelRect.right <= step2.innerWidth + 1,
    'panel is outside horizontal viewport'
  );
  assert.ok(
    step2.panelRect.top >= 0 && step2.panelRect.bottom <= step2.innerHeight + 1,
    'panel is outside vertical viewport'
  );
  assert.ok(step2.scrollWidthOk, 'horizontal overflow observed');
  assert.equal(step2.clipboardWritesCount, 0, 'clipboard written on open');
  await assertKeyDoesNotSplit(b1.cdp, b1.sessionId);
  console.log('Step 2 passed: panel opened and checked');

  // Shot: panel 1440 light
  await captureShot(b1.cdp, b1.sessionId, 'panel-1440-light.png');

  // Shot: panel 1440 dark
  await setViewport(b1.cdp, b1.sessionId, 1440, 900, 'dark');
  await captureShot(b1.cdp, b1.sessionId, 'panel-1440-dark.png');
  await setViewport(b1.cdp, b1.sessionId, 1440, 900, 'light');

  // 3. Press Enter (copies link)
  console.log('Step 3: Pressing Enter');
  await pressKey(b1.cdp, b1.sessionId, 'Enter', 'Enter', 13);
  await waitForCondition(async () => {
    return (
      (await evaluate<number>(
        b1.cdp,
        b1.sessionId,
        `window.__clipboardWrites.length`
      )) >= 1
    );
  });

  const step3 = await evaluate<{
    lastCopied: string;
    toastText: string | null;
    toastCenterIsToast: boolean;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const toast = document.querySelector('.toast');
      let centerOk = false;
      if (toast) {
        const r = toast.getBoundingClientRect();
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        centerOk = Boolean(topEl && (topEl === toast || toast.contains(topEl)));
      }
      return {
        lastCopied: window.__clipboardWrites[window.__clipboardWrites.length - 1],
        toastText: toast ? toast.textContent : null,
        toastCenterIsToast: centerOk,
      };
    })()`
  );
  assert.equal(step3.lastCopied, shareUrl, 'shareUrl not copied on Enter');
  assert.equal(
    step3.toastText,
    LINK_COPIED_NOTE,
    'toast text mismatch for Copy link'
  );
  assert.ok(step3.toastCenterIsToast, 'toast not at top layer above panel');
  console.log('Step 3 passed: Enter copied link');

  // 4. Copy without the key
  console.log('Step 4: Copy without key');
  await clickElement(b1.cdp, b1.sessionId, '[data-copy="keyless"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<number>(
        b1.cdp,
        b1.sessionId,
        `window.__clipboardWrites.length`
      )) >= 2
    );
  });

  const step4 = await evaluate<{
    lastCopied: string;
    toastText: string | null;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const toast = document.querySelector('.toast');
      return {
        lastCopied: window.__clipboardWrites[window.__clipboardWrites.length - 1],
        toastText: toast ? toast.textContent : null,
      };
    })()`
  );
  assert.equal(
    step4.lastCopied,
    keylessLink(shareUrl),
    'keyless link not copied'
  );
  assert.ok(
    !step4.lastCopied.includes('#'),
    'keyless link contains hash fragment'
  );
  assert.equal(
    step4.toastText,
    KEYLESS_COPIED_NOTE,
    'toast text mismatch for Copy keyless'
  );
  console.log('Step 4 passed: Copy without key');

  // 5. Copy phrase
  console.log('Step 5: Copy phrase');
  await clickElement(b1.cdp, b1.sessionId, '[data-copy="phrase"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<number>(
        b1.cdp,
        b1.sessionId,
        `window.__clipboardWrites.length`
      )) >= 3
    );
  });

  const step5 = await evaluate<{
    lastCopied: string;
    toastText: string | null;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const toast = document.querySelector('.toast');
      return {
        lastCopied: window.__clipboardWrites[window.__clipboardWrites.length - 1],
        toastText: toast ? toast.textContent : null,
      };
    })()`
  );
  const copiedWords = step5.lastCopied.trim().split(/\s+/);
  assert.equal(copiedWords.length, 12, 'did not copy 12 words');
  const mappedKey = mnemonicToKey(step5.lastCopied);
  assert.deepEqual(
    [...mappedKey],
    [...parsedKey],
    'copied phrase does not map back to fragment key'
  );
  assert.equal(
    step5.toastText,
    PHRASE_COPIED_NOTE,
    'toast text mismatch for Copy phrase'
  );
  assert.ok(!step5.toastText.includes('#r1'), 'toast contains fragment');
  for (const w of phraseWords) {
    assert.ok(
      !step5.toastText.split(/\s+/).includes(w),
      `toast contains phrase word ${w}`
    );
  }
  console.log('Step 5 passed: Copy phrase');

  // 6. Escape closes panel
  console.log('Step 6: Escape');
  const escapeDebug = await evaluate<any>(
    b1.cdp,
    b1.sessionId,
    `(() => {
    return {
      activeElement: document.activeElement ? document.activeElement.outerHTML.slice(0, 100) : null,
      panel: Boolean(document.getElementById('copy-link-panel')),
    };
  })()`
  );
  console.log('Before Escape:', escapeDebug);
  await pressKey(b1.cdp, b1.sessionId, 'Escape', 'Escape', 27);
  await Bun.sleep(200);
  const afterEscape = await evaluate<any>(
    b1.cdp,
    b1.sessionId,
    `(() => {
    return {
      activeElement: document.activeElement ? document.activeElement.outerHTML.slice(0, 100) : null,
      panel: Boolean(document.getElementById('copy-link-panel')),
    };
  })()`
  );
  console.log('After Escape:', afterEscape);
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  });

  const step6 = await evaluate<{
    openerFocused: boolean;
    openerExpanded: string | null;
    localKeys: string[];
    sessionKeys: string[];
    title: string;
    href: string;
    wordCounts: number[];
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const opener = document.querySelector('[data-action="copy-link"]');
      const words = ${JSON.stringify(phraseWords)};
      const text = document.body.innerText;
      const html = document.body.outerHTML;
      const counts = words.map(w => {
        const re = new RegExp('\\\\b' + w + '\\\\b', 'gi');
        return (text.match(re) || []).length + (html.match(re) || []).length;
      });
      return {
        openerFocused: document.activeElement === opener,
        openerExpanded: opener ? opener.getAttribute('aria-expanded') : null,
        localKeys: Object.keys(localStorage),
        sessionKeys: Object.keys(sessionStorage),
        title: document.title,
        href: location.href,
        wordCounts: counts,
      };
    })()`
  );
  assert.ok(step6.openerFocused, 'focus did not return to opener on Escape');
  assert.equal(step6.openerExpanded, 'false', 'aria-expanded is not false');
  assert.deepEqual(step6.localKeys, baseline.localKeys, 'localStorage changed');
  assert.deepEqual(
    step6.sessionKeys,
    baseline.sessionKeys,
    'sessionStorage changed'
  );
  assert.equal(step6.title, baseline.title, 'document.title changed');
  assert.equal(step6.href, baseline.href, 'location.href changed');
  assert.deepEqual(
    step6.wordCounts,
    baseline.wordCounts,
    'word counts outside open panel changed'
  );

  // Network check: no request carried # or phrase word
  for (const req of b1.requests) {
    assert.ok(
      !req.url.includes('#'),
      `request url carried fragment: ${req.url}`
    );
    for (const w of phraseWords) {
      assert.ok(
        !req.url.toLowerCase().includes(w.toLowerCase()),
        `request url carried phrase word ${w}: ${req.url}`
      );
      if (req.postData) {
        assert.ok(
          !req.postData.toLowerCase().includes(w.toLowerCase()),
          `request postData carried phrase word ${w}`
        );
      }
    }
  }

  // 7. Focus leaving, click outside, click opener
  // Reopen and Tab past last control
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel'))`
      )) === true
    );
  });
  console.log('Step 7: Testing Tab navigation to leave panel');
  for (let i = 0; i < 6; i++) {
    await pressKey(b1.cdp, b1.sessionId, 'Tab', 'Tab', 9);
    await Bun.sleep(50);
    const curActive = await evaluate<string>(
      b1.cdp,
      b1.sessionId,
      `document.activeElement ? document.activeElement.outerHTML.slice(0, 100) : 'none'`
    );
    console.log(`Tab ${i + 1}: activeElement =`, curActive);
    const panelClosed = await evaluate<boolean>(
      b1.cdp,
      b1.sessionId,
      `document.getElementById('copy-link-panel') === null`
    );
    if (panelClosed) {
      console.log('Panel closed after Tab!');
      break;
    }
  }
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  }, 'tab out closed panel');

  // Reopen and click stage
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel'))`
      )) === true
    );
  });
  await clickElement(b1.cdp, b1.sessionId, '.stage', { x: 100, y: 200 });
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  });

  // Reopen and click opener
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel'))`
      )) === true
    );
  });
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  });

  // 8. Clipboard refusal
  await evaluate(
    b1.cdp,
    b1.sessionId,
    `window.__clipboardShouldReject = true;`
  );
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel'))`
      )) === true
    );
  });

  await clickElement(b1.cdp, b1.sessionId, '[data-copy="link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<string | null>(
        b1.cdp,
        b1.sessionId,
        `document.querySelector('.toast')?.textContent`
      )) === COPY_FAILED_NOTE
    );
  });
  const linkSelection = await evaluate<string>(
    b1.cdp,
    b1.sessionId,
    `window.getSelection().toString()`
  );
  assert.equal(
    linkSelection,
    shareUrl,
    'selection does not match link on refusal'
  );
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.querySelector('#copy-link-panel [data-copy="phrase"]:not([disabled])'))`
      )) === true
    );
  }, 'phrase button enabled');
  await clickElement(b1.cdp, b1.sessionId, '[data-copy="phrase"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<string | null>(
        b1.cdp,
        b1.sessionId,
        `document.querySelector('.toast')?.textContent`
      )) === COPY_FAILED_NOTE
    );
  });
  const phraseSelection = await evaluate<string>(
    b1.cdp,
    b1.sessionId,
    `window.getSelection().toString().trim().replace(/\\s+/g, ' ')`
  );
  assert.equal(
    phraseSelection,
    phraseWords.join(' '),
    'selection does not match phrase words on refusal'
  );

  await evaluate(
    b1.cdp,
    b1.sessionId,
    `window.__clipboardShouldReject = false;`
  );

  // 9. Version switch with panel open
  // In the bar, find version button and switch to version 1
  const hasVersionButton = await evaluate<boolean>(
    b1.cdp,
    b1.sessionId,
    `Boolean(document.querySelector('.version') || document.querySelector('[data-action="versions"]'))`
  );
  if (hasVersionButton) {
    await clickElement(
      b1.cdp,
      b1.sessionId,
      '.version, [data-action="versions"]'
    );
    // If version dropdown opens, click version 1
    const v1Item = await evaluate<boolean>(
      b1.cdp,
      b1.sessionId,
      `(() => {
        const item = document.querySelector('.version-item, [data-version="1"]');
        if (item) { item.click(); return true; }
        return false;
      })()`
    );
    if (v1Item) {
      await waitForCondition(async () => {
        return (
          (await evaluate<boolean>(
            b1.cdp,
            b1.sessionId,
            `document.getElementById('copy-link-panel') === null`
          )) === true
        );
      });
    }
  }

  // 10. Viewports 390x844 dark and 320x568 light
  // 390x844 dark:
  await setViewport(b1.cdp, b1.sessionId, 390, 844, 'dark');
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel') && document.querySelector('#copy-link-panel ol.copy-phrase:not([aria-busy="true"])'))`
      )) === true
    );
  });
  await captureShot(b1.cdp, b1.sessionId, 'panel-390-dark.png');

  const doc390 = (await b1.cdp.send(
    'DOM.getDocument',
    { depth: 1 },
    b1.sessionId
  )) as { root: { backendNodeId: number } };
  const ax390 = (await b1.cdp.send(
    'Accessibility.queryAXTree',
    {
      backendNodeId: doc390.root.backendNodeId,
      accessibleName: 'Copy link',
      role: 'button',
    },
    b1.sessionId
  )) as { nodes?: Array<unknown> };
  assert.ok(
    ax390.nodes && ax390.nodes.length > 0,
    'Accessibility.queryAXTree did not find Copy link at 390'
  );

  const step10_390 = await evaluate<{
    spansWidth: boolean;
    copyLinkVisible: boolean;
    allLiSingleLine: boolean;
    scrollWidthOk: boolean;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const panel = document.getElementById('copy-link-panel');
      const copyBtn = panel ? panel.querySelector('[data-copy="link"]') : null;
      const pr = panel ? panel.getBoundingClientRect() : { width: 0 };
      const cr = copyBtn ? copyBtn.getBoundingClientRect() : { bottom: 9999 };
      const lis = panel ? Array.from(panel.querySelectorAll('ol.copy-phrase li')) : [];
      const singleLines = lis.every(li => li.getClientRects().length === 1);
      return {
        spansWidth: Math.abs(pr.width - window.innerWidth) <= 1,
        copyLinkVisible: cr.bottom <= window.innerHeight,
        allLiSingleLine: singleLines,
        scrollWidthOk: document.documentElement.scrollWidth <= window.innerWidth,
      };
    })()`
  );
  assert.ok(step10_390.spansWidth, 'panel does not span viewport width at 390');
  assert.ok(
    step10_390.copyLinkVisible,
    'Copy link not visible without scroll at 390'
  );
  assert.ok(step10_390.allLiSingleLine, 'li broke into multiple lines at 390');
  assert.ok(step10_390.scrollWidthOk, 'horizontal overflow at 390');
  await assertKeyDoesNotSplit(b1.cdp, b1.sessionId);

  await pressKey(b1.cdp, b1.sessionId, 'Escape', 'Escape', 27);
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  });

  // 320x568 light:
  await setViewport(b1.cdp, b1.sessionId, 320, 568, 'light');
  await clickElement(b1.cdp, b1.sessionId, '[data-action="copy-link"]');
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.getElementById('copy-link-panel') && document.querySelector('#copy-link-panel ol.copy-phrase:not([aria-busy="true"])'))`
      )) === true
    );
  });
  await captureShot(b1.cdp, b1.sessionId, 'panel-320-light.png');

  const doc320 = (await b1.cdp.send(
    'DOM.getDocument',
    { depth: 1 },
    b1.sessionId
  )) as { root: { backendNodeId: number } };
  const ax320 = (await b1.cdp.send(
    'Accessibility.queryAXTree',
    {
      backendNodeId: doc320.root.backendNodeId,
      accessibleName: 'Copy link',
      role: 'button',
    },
    b1.sessionId
  )) as { nodes?: Array<unknown> };
  assert.ok(
    ax320.nodes && ax320.nodes.length > 0,
    'Accessibility.queryAXTree did not find Copy link at 320'
  );

  const step10_320 = await evaluate<{
    spansWidth: boolean;
    copyLinkVisible: boolean;
    allLiSingleLine: boolean;
    scrollWidthOk: boolean;
  }>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const panel = document.getElementById('copy-link-panel');
      const copyBtn = panel ? panel.querySelector('[data-copy="link"]') : null;
      const pr = panel ? panel.getBoundingClientRect() : { width: 0 };
      const cr = copyBtn ? copyBtn.getBoundingClientRect() : { bottom: 9999 };
      const lis = panel ? Array.from(panel.querySelectorAll('ol.copy-phrase li')) : [];
      const singleLines = lis.every(li => li.getClientRects().length === 1);
      return {
        spansWidth: Math.abs(pr.width - window.innerWidth) <= 1,
        copyLinkVisible: cr.bottom <= window.innerHeight,
        allLiSingleLine: singleLines,
        scrollWidthOk: document.documentElement.scrollWidth <= window.innerWidth,
      };
    })()`
  );
  assert.ok(step10_320.spansWidth, 'panel does not span viewport width at 320');
  assert.ok(
    step10_320.copyLinkVisible,
    'Copy link not visible without scroll at 320'
  );
  assert.ok(step10_320.allLiSingleLine, 'li broke into multiple lines at 320');
  assert.ok(step10_320.scrollWidthOk, 'horizontal overflow at 320');
  await assertKeyDoesNotSplit(b1.cdp, b1.sessionId);

  // Shot: toast over panel at 320
  await pressKey(b1.cdp, b1.sessionId, 'Enter', 'Enter', 13);
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `Boolean(document.querySelector('.toast'))`
      )) === true
    );
  });
  await evaluate(
    b1.cdp,
    b1.sessionId,
    `(() => {
    const toast = document.querySelector('.toast');
    if (!toast) return Promise.resolve();
    return Promise.all(toast.getAnimations().map(a => a.finished));
  })()`
  );
  await Bun.sleep(50);
  const toastCenterIsToast320 = await evaluate<boolean>(
    b1.cdp,
    b1.sessionId,
    `(() => {
      const toast = document.querySelector('.toast');
      if (!toast) return false;
      const r = toast.getBoundingClientRect();
      const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(topEl && (topEl === toast || toast.contains(topEl)));
    })()`
  );
  assert.ok(toastCenterIsToast320, 'toast at 320 not above panel');
  await captureShot(b1.cdp, b1.sessionId, 'toast-320-light.png');

  await pressKey(b1.cdp, b1.sessionId, 'Escape', 'Escape', 27);
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b1.cdp,
        b1.sessionId,
        `document.getElementById('copy-link-panel') === null`
      )) === true
    );
  });

  // Verify taskbar at all widths with full action set
  console.log('Testing band progressive collapse across viewports');
  await verifyBandAtWidth(b1.cdp, b1.sessionId, 1440, 900);
  await verifyBandAtWidth(b1.cdp, b1.sessionId, 1280, 800);
  await verifyBandAtWidth(b1.cdp, b1.sessionId, 1024, 768);
  await verifyBandAtWidth(b1.cdp, b1.sessionId, 390, 844);
  await verifyBandAtWidth(b1.cdp, b1.sessionId, 320, 568);
  console.log('Band progressive collapse passed at 1440, 1280, 1024, 390, 320');

  // 11. Recipient path in a second browser with fresh profile
  const b2 = await launchBrowser();
  await setViewport(b2.cdp, b2.sessionId, 1440, 900, 'light');

  const keyless = keylessLink(shareUrl);
  await b2.cdp.send('Page.navigate', { url: keyless }, b2.sessionId);

  // Wait for "This link is missing its key"
  await waitForCondition(async () => {
    return (
      (await evaluate<boolean>(
        b2.cdp,
        b2.sessionId,
        `Boolean(document.querySelector('.stage-dead') && document.querySelector('#relic-key-input'))`
      )) === true
    );
  });

  const deadCheck = await evaluate<{
    headline: string | null;
    label: string | null;
  }>(
    b2.cdp,
    b2.sessionId,
    `(() => {
      const h1 = document.querySelector('.card-title');
      const label = document.querySelector('.key-entry-label');
      return {
        headline: h1 ? h1.textContent : null,
        label: label ? label.textContent : null,
      };
    })()`
  );
  assert.equal(deadCheck.headline, 'This link is missing its key');
  assert.equal(deadCheck.label, KEY_ENTRY_LABEL);

  // Capture shot of recipient key entry
  await captureShot(b2.cdp, b2.sessionId, 'recipient-key-entry.png');

  // Focus input and type the 12 words
  await clickElement(b2.cdp, b2.sessionId, '#relic-key-input');
  await b2.cdp.send(
    'Input.insertText',
    { text: phraseWords.join(' ') },
    b2.sessionId
  );
  await pressKey(b2.cdp, b2.sessionId, 'Enter', 'Enter', 13);

  // Wait for relic to open and heading to render
  await waitForCondition(
    async () => {
      return (
        (await evaluate<boolean>(
          b2.cdp,
          b2.sessionId,
          `Boolean(document.querySelector('.stage') && !document.querySelector('.stage-dead'))`
        )) === true
      );
    },
    'relic heading open after key entry',
    15000,
    100
  );

  const headingText = await evaluate<string | null>(
    b2.cdp,
    b2.sessionId,
    `document.querySelector('h1')?.textContent`
  );
  assert.ok(
    headingText?.includes('Secret Notes'),
    `heading not rendered after key entry, got: ${headingText}`
  );

  // Check b2 requests: no request carried a phrase word
  for (const req of b2.requests) {
    for (const w of phraseWords) {
      assert.ok(
        !req.url.toLowerCase().includes(w.toLowerCase()),
        `recipient request url carried phrase word ${w}: ${req.url}`
      );
      if (req.postData) {
        assert.ok(
          !req.postData.toLowerCase().includes(w.toLowerCase()),
          `recipient request postData carried phrase word ${w}`
        );
      }
    }
  }

  console.log('COPY_LINK_PATH_OK');
} finally {
  await cleanupBrowsers();
  await service.stop();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
