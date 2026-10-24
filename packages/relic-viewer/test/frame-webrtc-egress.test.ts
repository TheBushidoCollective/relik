import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp, type RelicApp } from '../../relic-server/src/app.ts';
import { diskAssets } from '../../relic-server/src/assets.ts';
import { MemoryStore } from '../../relic-server/src/store.ts';
import {
  installSandboxContainment,
  sanitizeFrameHtml,
} from '../src/sandbox.ts';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const findChromeBinary = (): string | undefined => {
  for (const path of CHROME_PATHS) {
    if (existsSync(path)) return path;
  }
  return undefined;
};

describe('sanitizeFrameHtml', () => {
  test('strips nested iframe tags and srcdoc attributes', () => {
    const hostile =
      '<p>before</p><iframe src="about:blank"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe><p>after</p>';
    const cleaned = sanitizeFrameHtml(hostile);
    expect(cleaned).not.toContain('<iframe');
    expect(cleaned).not.toContain('</iframe>');
    expect(cleaned).toContain('<p>before</p>');
    expect(cleaned).toContain('<p>after</p>');
  });

  test('strips object and embed elements', () => {
    const hostile =
      '<object data="about:blank"></object><embed src="about:blank"><p>safe</p>';
    const cleaned = sanitizeFrameHtml(hostile);
    expect(cleaned).not.toContain('<object');
    expect(cleaned).not.toContain('</object>');
    expect(cleaned).not.toContain('<embed');
    expect(cleaned).toContain('<p>safe</p>');
  });

  test('strips frame elements with varied casing and whitespace', () => {
    const hostile =
      '<IFRAME   SRC="about:blank"></IFRAME><iframe/src="x"><frame src="about:blank"><portal src="x">';
    const cleaned = sanitizeFrameHtml(hostile);
    expect(cleaned).not.toMatch(/<iframe/i);
    expect(cleaned).not.toMatch(/<frame/i);
    expect(cleaned).not.toMatch(/<portal/i);
  });

  test('preserves valid markup and scripts', () => {
    const valid =
      '<main><h1>Title</h1><p>Text</p><script>console.log("ok");<\\/script></main>';
    const cleaned = sanitizeFrameHtml(valid);
    expect(cleaned).toBe(valid);
  });
});

describe('installSandboxContainment unit containment', () => {
  test('neutralizes WebRTC, Workers, and frame element prototypes', () => {
    function MockRTCPeerConnection() {}
    MockRTCPeerConnection.prototype = {
      createOffer: () => Promise.resolve({}),
      setLocalDescription: () => Promise.resolve(),
      createDataChannel: () => ({}),
    };

    function MockWorker() {}
    function MockSharedWorker() {}

    function MockHTMLIFrameElement() {}
    MockHTMLIFrameElement.prototype = {
      contentWindow: {},
      contentDocument: {},
    };

    function MockHTMLObjectElement() {}
    MockHTMLObjectElement.prototype = {
      contentWindow: {},
      contentDocument: {},
    };

    const mockElements: string[] = [];
    function MockDocument() {}
    MockDocument.prototype = {
      createElement(tag: string) {
        mockElements.push(tag);
        return { tagName: tag };
      },
      createElementNS(_ns: string | null, tag: string) {
        mockElements.push(tag);
        return { tagName: tag };
      },
    };

    let innerHtmlValue = '';
    function MockElement() {}
    MockElement.prototype = {};
    Object.defineProperty(MockElement.prototype, 'innerHTML', {
      get() {
        return innerHtmlValue;
      },
      set(val: string) {
        innerHtmlValue = val;
      },
      configurable: true,
    });

    const mockWindow = {
      RTCPeerConnection: MockRTCPeerConnection,
      webkitRTCPeerConnection: MockRTCPeerConnection,
      RTCIceGatherer: () => {},
      Worker: MockWorker,
      SharedWorker: MockSharedWorker,
      HTMLIFrameElement: MockHTMLIFrameElement,
      HTMLObjectElement: MockHTMLObjectElement,
      Document: MockDocument,
      Element: MockElement,
      Node: { ELEMENT_NODE: 1, prototype: {} },
    } as unknown as Window;

    installSandboxContainment(mockWindow);

    const winRecord = mockWindow as unknown as Record<string, unknown>;
    expect(winRecord['RTCPeerConnection']).toBeUndefined();
    expect(winRecord['webkitRTCPeerConnection']).toBeUndefined();
    expect(winRecord['RTCIceGatherer']).toBeUndefined();
    expect(winRecord['Worker']).toBeUndefined();
    expect(winRecord['SharedWorker']).toBeUndefined();

    // Verify property is locked
    expect(() => {
      winRecord['RTCPeerConnection'] = MockRTCPeerConnection;
    }).toThrow();

    // Only the frame global and real holders are locked. Inherited names on
    // shared prototypes stay writable, so ordinary code assigning a property
    // called Worker or RTCPeerConnection keeps working in strict mode, and
    // the caller's own realm is untouched.
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'Worker')).toBe(
      undefined
    );
    expect(
      Object.getOwnPropertyDescriptor(Object.prototype, 'RTCPeerConnection')
    ).toBe(undefined);
    const plain: Record<string, unknown> = {};
    plain['Worker'] = MockWorker;
    plain['RTCPeerConnection'] = MockRTCPeerConnection;
    expect(plain['Worker']).toBe(MockWorker);
    expect(plain['RTCPeerConnection']).toBe(MockRTCPeerConnection);
    expect(typeof (globalThis as Record<string, unknown>)['Worker']).toBe(
      'function'
    );

    // A prototype that owns a name is still locked there.
    const holder = { SharedWorker: MockSharedWorker };
    const inheritingWindow = Object.create(holder) as Record<string, unknown>;
    inheritingWindow['Node'] = { ELEMENT_NODE: 1, prototype: {} };
    installSandboxContainment(inheritingWindow as unknown as Window);
    expect(inheritingWindow['SharedWorker']).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(holder, 'SharedWorker')?.writable
    ).toBe(false);
    expect(holder.SharedWorker).toBeUndefined();

    // Verify prototype getters return null
    const iframeProto = MockHTMLIFrameElement.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(iframeProto['contentWindow']).toBeNull();
    expect(iframeProto['contentDocument']).toBeNull();

    // Verify createElement blocks frame tags
    const docProto = MockDocument.prototype;
    expect(() => docProto.createElement('iframe')).toThrow();
    expect(() => docProto.createElement('object')).toThrow();
    expect(() => docProto.createElementNS(null, 'iframe')).toThrow();
    expect(docProto.createElement('div')).toEqual({
      tagName: 'div',
    } as unknown as HTMLElement);

    // Verify innerHTML sanitizes
    const elProto = MockElement.prototype as unknown as { innerHTML: string };
    elProto.innerHTML = '<div><iframe src="about:blank"></iframe>Safe</div>';
    expect(innerHtmlValue).not.toContain('<iframe');
    expect(innerHtmlValue).toContain('<div>Safe</div>');
  });
});

describe('WebRTC STUN egress headless browser regression', () => {
  const chromeBinary = findChromeBinary();

  test.skipIf(!chromeBinary)(
    'closed egress blocks STUN packet transmission across all bypass vectors',
    async () => {
      // 1. Local loopback UDP collector
      const udpSocket = dgram.createSocket('udp4');
      const packets: Buffer[] = [];
      const { promise: bound, resolve: resolveBound } =
        Promise.withResolvers<number>();
      udpSocket.bind(0, '127.0.0.1', () =>
        resolveBound(udpSocket.address().port)
      );
      const udpPort = await bound;

      udpSocket.on('message', (msg) => {
        packets.push(msg);
      });

      const { promise: rendered, resolve: resolveRendered } =
        Promise.withResolvers<void>();
      const vectorReports: Record<string, string> = {};

      let getParentHtml: () => string = () => '';
      const serviceServer = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/get-payload') {
            return Response.json({ payload: hostilePayload });
          }
          if (url.pathname === '/rendered' && req.method === 'POST') {
            resolveRendered();
            return new Response('OK');
          }
          if (url.pathname === '/report' && req.method === 'POST') {
            try {
              const d = (await req.json()) as { id: string; detail: string };
              vectorReports[d.id] = d.detail;
              if (d.id === 'test:finished' || d.id === 'direct') {
                resolveRendered();
              }
            } catch {}
            return new Response('OK');
          }
          return new Response(getParentHtml(), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      });

      const serviceOrigin = `http://127.0.0.1:${serviceServer.port}`;

      let appRef: RelicApp | undefined;
      const usercontentServer = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          if (!appRef) throw new Error('App not initialized');
          return appRef.fetch(req);
        },
      });

      const usercontentOrigin = `http://127.0.0.1:${usercontentServer.port}`;
      const distPath = new URL('../dist', import.meta.url).pathname;
      appRef = createApp({
        config: {
          serviceOrigin,
          usercontentOrigin,
        },
        store: new MemoryStore(),
        assets: diskAssets(distPath),
      });
      // 3. Multi-vector hostile payload attempting all bypasses
      const hostilePayload =
        `<!DOCTYPE html>
<html>
<head><title>Hostile Egress</title></head>
<body>
<iframe id="ifr1" src="about:blank"></iframe>
<iframe id="ifr2" srcdoc="<script>
  try {
    const pc = new (window.RTCPeerConnection || window.webkitRTCPeerConnection)({
      iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }]
    });
    pc.createDataChannel('leak-srcdoc');
    pc.createOffer().then(o => pc.setLocalDescription(o));
  } catch (e) {}
<` +
        `/script>"></iframe>
<object data="about:blank"></object>
<script>
  function reportVector(id, detail) {
    window.parent.postMessage({ type: 'vector:report', id, detail }, '*');
  }
  function tryLeak(PC, id) {
    if (!PC) {
      reportVector(id, 'undefined');
      return;
    }
    try {
      const pc = new PC({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
      pc.createDataChannel('leak');
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
      reportVector(id, 'instantiated');
    } catch (e) {
      reportVector(id, 'threw: ' + e.message);
    }
  }

  // Direct and alias
  tryLeak(window.RTCPeerConnection, 'direct');
  tryLeak(window.webkitRTCPeerConnection, 'webkit');

  // Prototype chain walking
  {
    let foundPC = null;
    let cur = globalThis;
    while (cur) {
      if (cur.RTCPeerConnection && typeof cur.RTCPeerConnection === 'function') {
        foundPC = cur.RTCPeerConnection;
        break;
      }
      try {
        cur = Object.getPrototypeOf(cur);
      } catch {
        break;
      }
    }
    tryLeak(foundPC, 'protoChain');
  }
  // createElement iframe
  try {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    tryLeak(f.contentWindow && f.contentWindow.RTCPeerConnection, 'createElement');
  } catch (e) {
    reportVector('createElement', 'blocked: ' + e.message);
  }

  // createElementNS iframe
  try {
    const f = document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
    document.body.appendChild(f);
    tryLeak(f.contentWindow && f.contentWindow.RTCPeerConnection, 'createElementNS');
  } catch (e) {
    reportVector('createElementNS', 'blocked: ' + e.message);
  }

  // createHTMLDocument
  try {
    const foreignDoc = document.implementation.createHTMLDocument('aux');
    const ifr = foreignDoc.createElement('iframe');
    const adopted = document.adoptNode(ifr);
    document.body.appendChild(adopted);
    tryLeak(adopted.contentWindow && adopted.contentWindow.RTCPeerConnection, 'createHTMLDoc');
  } catch (e) {
    reportVector('createHTMLDoc', 'blocked: ' + e.message);
  }

  // postwrite document.write
  try {
    document.write('<iframe id="post-ifr" srcdoc="<script>new RTCPeerConnection()<\\/script>"></iframe>');
    const ifr = document.getElementById('post-ifr');
    reportVector('postWrite', ifr ? 'written' : 'sanitized');
  } catch (e) {
    reportVector('postWrite', 'blocked: ' + e.message);
  }
  // innerHTML iframe
  try {
    const d = document.createElement('div');
    document.body.appendChild(d);
    d.innerHTML = '<iframe src="about:blank"></iframe>';
    const ifr = d.querySelector('iframe');
    tryLeak(ifr && ifr.contentWindow && ifr.contentWindow.RTCPeerConnection, 'innerHTML');
  } catch (e) {
    reportVector('innerHTML', 'blocked: ' + e.message);
  }

  // window[0] indexed frame
  for (let i = 0; i < window.length; i++) {
    tryLeak(window[i] && window[i].RTCPeerConnection, 'windowIndex' + i);
  }

  // Workers
  try { new Worker('data:application/javascript,'); reportVector('worker', 'created'); } catch (e) { reportVector('worker', 'blocked'); }
  try { new SharedWorker('data:application/javascript,'); reportVector('sharedWorker', 'created'); } catch (e) { reportVector('sharedWorker', 'blocked'); }
  window.parent.postMessage({ type: 'test:finished' }, '*');
<` +
        `/script>
</body>
</html>`;

      getParentHtml = () =>
        `<!DOCTYPE html>
<html>
<head>
<script>
  let renderedSent = false;
  function sendRender(frame) {
    if (!frame || !frame.contentWindow) return;
    fetch('/get-payload').then(r => r.json()).then(data => {
      frame.contentWindow.postMessage({
        type: 'relic:render',
        html: data.payload
      }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    const frame = document.getElementById('frame');
    if (event.data && event.data.type === 'relic:sandbox-ready') {
      sendRender(frame);
    } else if (event.data && event.data.type === 'vector:report') {
      renderedSent = true;
      fetch('/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event.data)
      });
    } else if (event.data && (event.data.type === 'relic:tree' || event.data.type === 'test:finished')) {
      renderedSent = true;
      fetch('/rendered', { method: 'POST' });
    }
  });
<` +
        `/script>
</head>
<body>
<iframe id="frame" class="usercontent-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${usercontentOrigin}/sandbox.html"></iframe>
<script>
  const frame = document.getElementById('frame');
  frame.addEventListener('load', () => {
    sendRender(frame);
  });
<` +
        `/script>
</body>
</html>`;

      // 4. Run headless Chrome
      const binary = chromeBinary;
      if (!binary) throw new Error('Chrome binary not found');
      const userDataDir = path.join(
        os.tmpdir(),
        `chrome-test-reg-${Date.now()}`
      );
      const chromeProcess = spawn(
        binary,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          `--user-data-dir=${userDataDir}`,
          serviceOrigin,
        ],
        { stdio: 'ignore' }
      );

      try {
        // Await event-driven completion from rendered callback
        await rendered;

        // Allow a brief turn for any asynchronous network packets that were in flight
        // to hit the loopback UDP interface before asserting. This integration check
        // explicitly exercises real-time OS socket transport against headless Chrome.
        const { promise: settleTimer, resolve: resolveSettle } =
          Promise.withResolvers<void>();
        setTimeout(resolveSettle, 500);
        await settleTimer;

        // Zero packets must have arrived at the collector
        expect(packets.length).toBe(0);
        // Verification that the probe actually executed
        expect(vectorReports['direct']).toBeDefined();
        expect(vectorReports['protoChain']).toBeDefined();
        expect(vectorReports['createElementNS']).toBeDefined();
        expect(vectorReports['createHTMLDoc']).toBeDefined();
        expect(vectorReports['postWrite']).toBeDefined();
      } finally {
        chromeProcess.kill();
        serviceServer.stop(true);
        usercontentServer.stop(true);
        udpSocket.close();
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    45000
  );
});
