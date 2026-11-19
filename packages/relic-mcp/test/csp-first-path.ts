/**
 * CSP-first measurement (frame hardening).
 *
 *   bun packages/relic-mcp/test/csp-first-path.ts
 *
 * Measures which channels an author's script can use for WebRTC egress and
 * network egress inside the render frame, under four policies, on two process
 * models. It is a measurement, not a gate: it prints a table and exits 0 unless
 * the harness itself breaks.
 *
 * Columns:
 *   control    plain shim, no CSP, no containment. The positive control: the
 *              attempt must reach the listener here, or the case is UNPROVEN.
 *   production the viewer's built sandbox.html and the production headers,
 *              exactly as app.ts serves them (the status quo).
 *   csp        plain shim with the candidate CSP (no inline script, hash-only
 *              shim, blob: scripts, worker-src none, frame-src none). Isolates
 *              what the policy alone does.
 *   candidate  candidate shim (removes the RTCPeerConnection family from the
 *              author realm before author code runs) with the candidate CSP.
 *
 * Verdicts per case and process model:
 *   EGRESS      the attempt ran and a loopback listener saw a TCP connection,
 *               TCP data or a UDP packet.
 *   BLOCKED     the attempt ran and nothing reached a listener.
 *   BLOCKED-PRE the attempt never ran (CSP or the loader stopped it first).
 *   UNPROVEN    the control did not reach its listener, so the column says
 *               nothing about the policy.
 *
 * Every channel is a loopback address (127.0.0.1 for HTTP, TCP and UDP, and the
 * STUN server). The probe does not read Chrome's net log, so DNS is not observed.
 * Author markup is written raw to the shim, not through the viewer's sanitiser,
 * so frame tags reach the shim unfiltered: this is the worst case for the
 * sanitiser layer and it is not measured here.
 */

import { createHash } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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

const RUN_BUDGET_MS = 1_500_000;
const SETTLE_MS = 2000;
const CONCURRENCY = 8;
const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const chromePath =
  process.env['RELIC_CSP_FIRST_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  ((await access(defaultOwnedShell, constants.X_OK)
    .then(() => true)
    .catch(() => false))
    ? defaultOwnedShell
    : undefined);
const found = await discoverChrome(
  chromePath && chromePath !== 'none' && chromePath !== 'disabled'
    ? chromePath
    : undefined
);
if (found.kind !== 'found') {
  console.error(`CSP_FIRST_NO_CHROME: ${found.kind}`);
  process.exit(1);
}
const chromeExecutable = found.path;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist =
  process.env['RELIC_CSP_FIRST_VIEWER_DIST'] ??
  join(repoRoot, 'packages/relic-viewer/dist');

const watchdog = setTimeout(() => {
  console.error(`CSP_FIRST_TIMEOUT after ${RUN_BUDGET_MS}ms`);
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

// The viewer's sanitiser strips frame tags from relic content, and the shim
// receives this markup raw. Tags are assembled at run time so this source file
// contains no literal frame or script tag sequence.
const OPEN = '<';
const IFRAME = 'if' + 'rame';
const SCRIPT = 'scr' + 'ipt';
function scriptTag(js: string): string {
  if (js.includes('</' + SCRIPT)) throw new Error('script text closes its tag');
  return OPEN + SCRIPT + '>' + js + OPEN + '/' + SCRIPT + '>';
}
/** A JavaScript string literal that is safe inside an HTML script element. */
function jsStr(s: string): string {
  return JSON.stringify(s).split('<').join('\\u003c');
}

// ---------------------------------------------------------------------------
// Author-side library. Every author script gets this, so a result always comes
// back to the top window as a probe message.
// ---------------------------------------------------------------------------

interface Cfg {
  readonly tcp: string;
  readonly stun: string;
  readonly leaf: string;
  readonly hostLeaf: string;
}

const LIB = `
function report(v) { try { top.postMessage({ type: 'probe', v: v }, '*'); } catch (e) {} }
function rtcWith(id, C, G) {
  var out = { k: 'egress', id: id, rtc: typeof C, made: false, err: null };
  try {
    var pc = new C({ iceServers: [{ urls: [CFG.stun] }] });
    pc.createDataChannel('probe');
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
    out.made = true;
  } catch (e) { out.err = String(e); }
  if (typeof C !== 'undefined' && G) {
    try { G.fetch(CFG.tcp, { mode: 'no-cors', keepalive: true }).catch(function () {}); } catch (e) {}
  }
  report(out);
}
function rtcAttempt(id) { rtcWith(id, typeof RTCPeerConnection === 'undefined' ? undefined : RTCPeerConnection, window); }
`;

function libJs(c: Cfg): string {
  return 'var CFG = ' + JSON.stringify(c) + ';' + LIB;
}
function callRtc(id: string): string {
  return 'rtcAttempt(' + JSON.stringify(id) + ');';
}
/** A complete nested document whose inline script runs the attempt. */
function nestedDoc(c: Cfg, inner: string): string {
  return '<!doctype html><meta charset="utf-8">' + scriptTag(libJs(c) + inner);
}
/** Leaf page served from the frame origin with no CSP, reached by URL. */
function leafDoc(c: Cfg, id: string): string {
  return nestedDoc(c, callRtc(id));
}
function srcdocFrame(html: string, nestedSandbox: boolean): string {
  return (
    "var f = document.createElement('iframe'); f.srcdoc = " +
    jsStr(html) +
    ';' +
    (nestedSandbox ? " f.setAttribute('sandbox', 'allow-scripts');" : '') +
    ' document.body.appendChild(f);'
  );
}
function jsUrl(c: Cfg, id: string): string {
  return 'javascript:(function () {' + libJs(c) + callRtc(id) + '})()';
}

const WORKER_BODY = (c: Cfg, id: string): string => `
var out = { k: 'egress', id: ${JSON.stringify(id)}, rtc: typeof RTCPeerConnection, made: false, err: null };
try {
  var pc = new RTCPeerConnection({ iceServers: [{ urls: [${JSON.stringify(c.stun)}] }] });
  pc.createDataChannel('probe');
  pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
  out.made = true;
} catch (e) { out.err = String(e); }
try { fetch(${JSON.stringify(c.tcp)}, { mode: 'no-cors' }).catch(function () {}); } catch (e) {}
`;

// ---------------------------------------------------------------------------
// Shim documents.
// ---------------------------------------------------------------------------

/**
 * The render path the candidate and the control share. Each author script is
 * moved to a blob: URL and written back in parser order, so it runs as a
 * same-realm classic script without inline script. The shim's own script is
 * named by hash in the CSP.
 */
const RENDER_JS = `
addEventListener('message', function (event) {
  if (event.source !== parent) return;
  var data = event.data;
  if (!data || data.type !== 'relic:render' || typeof data.html !== 'string') return;
  var doc = new DOMParser().parseFromString(data.html, 'text/html');
  var scripts = doc.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var url = URL.createObjectURL(new Blob([scripts[i].textContent], { type: 'text/javascript' }));
    scripts[i].textContent = '';
    scripts[i].src = url;
  }
  document.open();
  document.write('<!doctype html>' + doc.documentElement.outerHTML);
});
parent.postMessage({ type: 'relic:sandbox-ready' }, '*');
`;

const REMOVE_RTC_JS = `
(function () {
  var names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
    'RTCSessionDescription', 'RTCIceCandidate', 'RTCIceGatherer', 'RTCIceTransport',
    'RTCDtlsTransport', 'RTCSctpTransport', 'RTCRtpSender', 'RTCRtpReceiver',
    'RTCRtpTransceiver', 'RTCPeerConnectionIceEvent', 'RTCDataChannelEvent',
    'RTCTrackEvent', 'RTCDTMFSender', 'RTCStatsReport', 'RTCError', 'RTCErrorEvent'];
  for (var i = 0; i < names.length; i++) {
    try { delete window[names[i]]; } catch (e) {}
    try { Object.defineProperty(window, names[i], { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
})();
`;

const PLAIN_JS = RENDER_JS;
const CANDIDATE_JS = REMOVE_RTC_JS + RENDER_JS;

function shimHash(js: string): string {
  return 'sha256-' + createHash('sha256').update(js).digest('base64');
}
/** The candidate CSP for a shim whose only inline script is `js`. */
function candidateCsp(js: string, host: string): string {
  return [
    "default-src 'none'",
    `script-src '${shimHash(js)}' blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts',
    `frame-ancestors ${host}`,
  ].join('; ');
}

function shimDocument(js: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>Relic content</title>' +
    scriptTag(js)
  );
}

// ---------------------------------------------------------------------------
// Loopback servers. The host page and the frame origin differ, so the frame is
// cross-origin to the host, as in production.
// ---------------------------------------------------------------------------

interface Channel {
  readonly tcp: string;
  readonly stun: string;
  readonly counters: { tcpOpens: number; tcpData: number; udpPackets: number };
  stop(): void;
}

async function openChannel(): Promise<Channel> {
  const counters = { tcpOpens: 0, tcpData: 0, udpPackets: 0 };
  const tcp = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        counters.tcpOpens += 1;
      },
      data() {
        counters.tcpData += 1;
      },
      close() {},
      error() {},
    },
  });
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => {
    counters.udpPackets += 1;
  });
  udp.on('error', () => {});
  const {
    promise: bound,
    resolve: onBound,
    reject: onError,
  } = Promise.withResolvers<number>();
  udp.once('error', onError);
  udp.bind(0, '127.0.0.1', () => onBound(udp.address().port));
  const udpPort = await bound;
  return {
    tcp: `http://127.0.0.1:${tcp.port}/probe`,
    stun: `stun:127.0.0.1:${udpPort}`,
    counters,
    stop: () => {
      tcp.stop(true);
      udp.close();
    },
  };
}

interface Run {
  readonly id: string;
  readonly column: Column;
  readonly cfg: Cfg;
  readonly author: string;
  readonly shim: 'production' | 'plain' | 'candidate';
  readonly csp: string | null;
  readonly channel: Channel;
  readonly settle: number;
}

type Column =
  | 'control'
  | 'production'
  | 'csp'
  | 'candidate'
  | 'navigate'
  | 'prodcsp';
const COLUMNS: readonly Column[] = [
  'control',
  'production',
  'csp',
  'candidate',
  'navigate',
  'prodcsp',
];

const runs = new Map<string, Run>();
const store = new MemoryStore();
let hostOrigin = '';
let frameOrigin = '';

const hostServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/leaf/')) {
      const run = runs.get(url.pathname.slice('/leaf/'.length));
      if (run === undefined) return new Response('Not found', { status: 404 });
      return new Response(leafDoc(run.cfg, 'leaf'), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    const run = runs.get(url.pathname.slice('/run/'.length));
    if (!url.pathname.startsWith('/run/') || run === undefined) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(hostDocument(run), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});
hostOrigin = `http://127.0.0.1:${hostServer.port}`;

const frameServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/sandbox.html') {
      return liveApp.fetch(new Request(`${frameOrigin}/sandbox.html`));
    }
    if (url.pathname.startsWith('/leaf/')) {
      const run = runs.get(url.pathname.slice('/leaf/'.length));
      if (run === undefined) return new Response('Not found', { status: 404 });
      return new Response(leafDoc(run.cfg, 'leaf'), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname.startsWith('/frame/')) {
      const run = runs.get(url.pathname.slice('/frame/'.length));
      if (run === undefined) return new Response('Not found', { status: 404 });
      if (run.shim === 'production') {
        return liveApp.fetch(new Request(`${frameOrigin}/sandbox.html`));
      }
      const js = run.shim === 'candidate' ? CANDIDATE_JS : PLAIN_JS;
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      };
      if (run.csp !== null) headers['content-security-policy'] = run.csp;
      return new Response(shimDocument(js), { headers });
    }
    return new Response('Not found', { status: 404 });
  },
});
frameOrigin = `http://127.0.0.1:${frameServer.port}`;

const liveApp = createApp({
  config: { serviceOrigin: hostOrigin, usercontentOrigin: frameOrigin },
  store,
  storage: new MemoryStorage(`${hostOrigin}/__storage`),
  assets: diskAssets(viewerDist),
});

/** Production shim headers, read from the app the same way it serves them. */
const productionShim = await liveApp.fetch(
  new Request(`${frameOrigin}/sandbox.html`)
);
const productionCsp = productionShim.headers.get('content-security-policy');
if (productionCsp === null) {
  console.error('CSP_FIRST_NO_PRODUCTION_CSP');
  process.exit(1);
}
await productionShim.arrayBuffer();

function hostDocument(run: Run): string {
  const frame =
    OPEN +
    IFRAME +
    ` id="f" sandbox="allow-scripts" src="${frameOrigin}/frame/${run.id}"></` +
    IFRAME +
    '>';
  const js = `
var AUTHOR = ${jsStr(run.author)};
var frame = document.getElementById('f');
var sent = false;
window.__probe = { results: [], done: false, shim: ${jsStr(run.column)} };
addEventListener('message', function (e) {
  var d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'relic:sandbox-ready' && e.source === frame.contentWindow && !sent) {
    sent = true;
    frame.contentWindow.postMessage({ type: 'relic:render', html: AUTHOR }, '*');
    setTimeout(function () { window.__probe.done = true; }, ${run.settle});
  }
  if (d.type === 'probe') window.__probe.results.push(d.v);
});`;
  return (
    '<!doctype html><meta charset="utf-8"><title>host</title>' +
    frame +
    scriptTag(js)
  );
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

interface CaseDef {
  readonly id: string;
  readonly group: string;
  readonly what: string;
  readonly build: (c: Cfg) => string;
}

const CASES: readonly CaseDef[] = [
  // (i) Frame creation under frame-src none.
  {
    id: 'i1-srcdoc-nosb',
    group: 'i',
    what: 'srcdoc iframe, nested frame without sandbox',
    build: (c) => srcdocFrame(nestedDoc(c, callRtc('i1-srcdoc-nosb')), false),
  },
  {
    id: 'i2-srcdoc-sandboxed',
    group: 'i',
    what: 'srcdoc iframe, nested frame with sandbox=allow-scripts',
    build: (c) =>
      srcdocFrame(nestedDoc(c, callRtc('i2-srcdoc-sandboxed')), true),
  },
  {
    id: 'i3-aboutblank-write',
    group: 'i',
    what: 'about:blank iframe, inline script written into it',
    build: (c) =>
      `var f = document.createElement('iframe'); document.body.appendChild(f);` +
      ` var d = f.contentDocument; d.open(); d.write(${jsStr(nestedDoc(c, callRtc('i3-aboutblank-write')))}); d.close();`,
  },
  {
    id: 'i4-src-http-leaf',
    group: 'i',
    what: 'iframe src = same-run leaf page on the frame origin (no CSP)',
    build: (c) =>
      `var f = document.createElement('iframe'); f.src = ${jsStr(c.leaf)}; document.body.appendChild(f);`,
  },
  {
    id: 'i5-src-blob-html',
    group: 'i',
    what: 'iframe src = blob: URL of an HTML leaf',
    build: (c) =>
      `var f = document.createElement('iframe');` +
      ` f.src = URL.createObjectURL(new Blob([${jsStr(leafDoc(c, 'i5-src-blob-html'))}], { type: 'text/html' }));` +
      ' document.body.appendChild(f);',
  },
  {
    id: 'i6-src-data-html',
    group: 'i',
    what: 'iframe src = data:text/html URL of an HTML leaf',
    build: (c) =>
      `var f = document.createElement('iframe');` +
      ` f.src = 'data:text/html,' + encodeURIComponent(${jsStr(leafDoc(c, 'i6-src-data-html'))});` +
      ' document.body.appendChild(f);',
  },
  {
    id: 'i7-object-leaf',
    group: 'i',
    what: 'object element data = leaf page',
    build: (c) =>
      `var o = document.createElement('object'); o.data = ${jsStr(c.leaf)}; document.body.appendChild(o);`,
  },
  {
    id: 'i8-embed-leaf',
    group: 'i',
    what: 'embed element src = leaf page',
    build: (c) =>
      `var e = document.createElement('embed'); e.src = ${jsStr(c.leaf)}; document.body.appendChild(e);`,
  },

  // (ii) blob: and data: script, and inline script injected at run time.
  {
    id: 'ii1-srcdoc-data-script',
    group: 'ii',
    what: 'srcdoc iframe whose script src is a data: URL',
    build: (c) => {
      const dataJs =
        'data:text/javascript,' +
        encodeURIComponent(libJs(c) + callRtc('ii1-srcdoc-data-script'));
      const html =
        '<!doctype html><meta charset="utf-8">' +
        OPEN +
        SCRIPT +
        ' src="' +
        dataJs +
        '"></' +
        SCRIPT +
        '>';
      return srcdocFrame(html, false);
    },
  },
  {
    id: 'ii2-srcdoc-blob-script',
    group: 'ii',
    what: 'srcdoc iframe whose script src is a blob: URL made by the author',
    build: (c) =>
      `var bu = URL.createObjectURL(new Blob([${jsStr(libJs(c) + callRtc('ii2-srcdoc-blob-script'))}], { type: 'text/javascript' }));` +
      ` var f = document.createElement('iframe');` +
      ` f.srcdoc = '<!doctype html><meta charset="utf-8"><' + 'script src="' + bu + '"></' + 'script>';` +
      ' document.body.appendChild(f);',
  },
  {
    id: 'ii3-top-blob-script',
    group: 'ii',
    what: 'author realm: script element with a blob: src',
    build: (c) =>
      `var s = document.createElement('script');` +
      ` s.src = URL.createObjectURL(new Blob([${jsStr(libJs(c) + callRtc('ii3-top-blob-script'))}], { type: 'text/javascript' }));` +
      ' document.head.appendChild(s);',
  },
  {
    id: 'ii4-top-data-script',
    group: 'ii',
    what: 'author realm: script element with a data: src',
    build: (c) =>
      `var s = document.createElement('script');` +
      ` s.src = 'data:text/javascript,' + encodeURIComponent(${jsStr(libJs(c) + callRtc('ii4-top-data-script'))});` +
      ' document.head.appendChild(s);',
  },
  {
    id: 'ii5-top-inline-injected',
    group: 'ii',
    what: 'author realm: inline script element created at run time',
    build: (c) =>
      `var s = document.createElement('script');` +
      ` s.textContent = ${jsStr(libJs(c) + callRtc('ii5-top-inline-injected'))};` +
      ' document.head.appendChild(s);',
  },
  {
    id: 'ii6-eval',
    group: 'ii',
    what: 'indirect eval of attempt source',
    build: (c) =>
      `try { (0, eval)(${jsStr(libJs(c) + callRtc('ii6-eval'))}); }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'ii6-eval', err: String(e) }); }`,
  },
  {
    id: 'ii7-new-function',
    group: 'ii',
    what: 'new Function of attempt source',
    build: (c) =>
      `try { new Function(${jsStr(libJs(c) + callRtc('ii7-new-function'))})(); }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'ii7-new-function', err: String(e) }); }`,
  },
  {
    id: 'ii8-dynamic-import-blob',
    group: 'ii',
    what: 'dynamic import() of a blob: module containing the attempt',
    build: (c) =>
      `var m = URL.createObjectURL(new Blob([${jsStr(libJs(c) + callRtc('ii8-dynamic-import-blob'))}], { type: 'text/javascript' }));` +
      ` import(m).catch(function (e) { report({ k: 'attempt-error', id: 'ii8-dynamic-import-blob', err: String(e) }); });`,
  },

  // (iii) Workers: dedicated, shared, service.
  {
    id: 'iii1-worker-blob',
    group: 'iii',
    what: 'dedicated Worker from blob: URL',
    build: (c) =>
      `var u = URL.createObjectURL(new Blob([${jsStr(WORKER_BODY(c, 'iii1-worker-blob') + 'postMessage(out);')}], { type: 'text/javascript' }));` +
      ` try { var w = new Worker(u); w.onmessage = function (e) { report(e.data); };` +
      ` w.onerror = function (e) { report({ k: 'attempt-error', id: 'iii1-worker-blob', err: 'worker error' }); }; }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'iii1-worker-blob', err: String(e) }); }`,
  },
  {
    id: 'iii2-worker-data',
    group: 'iii',
    what: 'dedicated Worker from data: URL',
    build: (c) =>
      `try { var w = new Worker('data:text/javascript,' + encodeURIComponent(${jsStr(WORKER_BODY(c, 'iii2-worker-data') + 'postMessage(out);')}));` +
      ` w.onmessage = function (e) { report(e.data); };` +
      ` w.onerror = function (e) { report({ k: 'attempt-error', id: 'iii2-worker-data', err: 'worker error' }); }; }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'iii2-worker-data', err: String(e) }); }`,
  },
  {
    id: 'iii3-sharedworker-blob',
    group: 'iii',
    what: 'SharedWorker from blob: URL',
    build: (c) =>
      `var u = URL.createObjectURL(new Blob([${jsStr('self.onconnect = function (ev) { var port = ev.ports[0];' + WORKER_BODY(c, 'iii3-sharedworker-blob') + 'port.postMessage(out); };')}], { type: 'text/javascript' }));` +
      ` try { var sw = new SharedWorker(u); sw.port.onmessage = function (e) { report(e.data); }; sw.port.start(); }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'iii3-sharedworker-blob', err: String(e) }); }`,
  },
  {
    id: 'iii4-serviceworker',
    group: 'iii',
    what: 'service worker registration from a data: script',
    build: (c) =>
      `try { navigator.serviceWorker.register('data:text/javascript,' + encodeURIComponent(${jsStr("self.addEventListener('install', function () { fetch(" + JSON.stringify(c.tcp) + ", { mode: 'no-cors' }).catch(function () {}); });")}))` +
      `.then(function () { report({ k: 'egress', id: 'iii4-serviceworker', rtc: 'not-checked', made: true, err: null }); },` +
      ` function (e) { report({ k: 'egress', id: 'iii4-serviceworker', rtc: 'not-checked', made: false, err: String(e) }); });` +
      ` } catch (e) { report({ k: 'egress', id: 'iii4-serviceworker', rtc: 'not-checked', made: false, err: String(e) }); }`,
  },

  // (iv) javascript: navigation, with script-src lacking unsafe-inline.
  {
    id: 'iv1-anchor-javascript',
    group: 'iv',
    what: 'a href="javascript:" clicked from script',
    build: (c) =>
      `var a = document.createElement('a'); a.href = ${jsStr(jsUrl(c, 'iv1-anchor-javascript'))};` +
      ` document.body.appendChild(a); setTimeout(function () { a.click(); }, 200);`,
  },
  {
    id: 'iv2-location-href-javascript',
    group: 'iv',
    what: 'location.href = "javascript:"',
    build: (c) =>
      `setTimeout(function () { location.href = ${jsStr(jsUrl(c, 'iv2-location-href-javascript'))}; }, 200);`,
  },
  {
    id: 'iv3-location-assign-javascript',
    group: 'iv',
    what: 'location.assign("javascript:")',
    build: (c) =>
      `setTimeout(function () { location.assign(${jsStr(jsUrl(c, 'iv3-location-assign-javascript'))}); }, 200);`,
  },
  {
    id: 'iv4-form-action-javascript',
    group: 'iv',
    what: 'form action="javascript:" submitted',
    build: (c) =>
      `var f = document.createElement('form'); f.method = 'get'; f.action = ${jsStr(jsUrl(c, 'iv4-form-action-javascript'))};` +
      ` document.body.appendChild(f); setTimeout(function () { f.submit(); }, 200);`,
  },
  {
    id: 'iv5-meta-refresh-javascript',
    group: 'iv',
    what: 'meta refresh to a javascript: URL',
    build: (c) =>
      `var m = document.createElement('meta'); m.httpEquiv = 'refresh';` +
      ` m.content = '0;url=' + ${jsStr(jsUrl(c, 'iv5-meta-refresh-javascript'))}; document.head.appendChild(m);`,
  },
  {
    id: 'iv6-iframe-src-javascript',
    group: 'iv',
    what: 'iframe src="javascript:"',
    build: (c) =>
      `var f = document.createElement('iframe'); f.src = ${jsStr(jsUrl(c, 'iv6-iframe-src-javascript'))}; document.body.appendChild(f);`,
  },
  {
    id: 'iv7-window-open-javascript',
    group: 'iv',
    what: 'window.open("javascript:") (popup opened or not is reported)',
    build: (c) =>
      `var w = window.open(${jsStr(jsUrl(c, 'iv7-window-open-javascript'))}, '_blank');` +
      ` report({ k: 'attempt-error', id: 'iv7-window-open-javascript', err: 'opened=' + (w !== null) });`,
  },

  // (v) Regaining RTCPeerConnection after the author realm had it removed.
  {
    id: 'v0-author-realm',
    group: 'v',
    what: 'author realm as it stands before any regain attempt',
    build: (c) =>
      `report({ k: 'globals', id: 'v0-author-realm', names: ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].filter(function (n) { return typeof window[n] !== 'undefined'; }) });` +
      callRtc('v0-author-realm'),
  },
  {
    id: 'v1-iframe-contentWindow',
    group: 'v',
    what: 'same-origin about:blank iframe: contentWindow.RTCPeerConnection',
    build: (c) =>
      `var f = document.createElement('iframe'); document.body.appendChild(f); var W = f.contentWindow;` +
      ` report({ k: 'globals', id: 'v1-iframe-contentWindow', names: W ? ['RTCPeerConnection'].filter(function (n) { return typeof W[n] !== 'undefined'; }) : ['no-window'] });` +
      ` rtcWith('v1-iframe-contentWindow', W ? W.RTCPeerConnection : undefined, W);`,
  },
  {
    id: 'v2-window-open-about-blank',
    group: 'v',
    what: 'window.open("about:blank"): constructor from the new window',
    build: (c) =>
      `var w = window.open('about:blank', '_blank');` +
      ` report({ k: 'globals', id: 'v2-window-open-about-blank', names: [w ? 'opened' : 'null'] });` +
      ` rtcWith('v2-window-open-about-blank', w ? w.RTCPeerConnection : undefined, w);`,
  },
  {
    id: 'v3-createHTMLDocument',
    group: 'v',
    what: 'document.implementation.createHTMLDocument: defaultView constructor',
    build: (c) =>
      `var d = document.implementation.createHTMLDocument('');` +
      ` report({ k: 'globals', id: 'v3-createHTMLDocument', names: [d.defaultView ? 'view' : 'no-view'] });` +
      ` rtcWith('v3-createHTMLDocument', d.defaultView ? d.defaultView.RTCPeerConnection : undefined, d.defaultView);`,
  },
  {
    id: 'v4-reflect-scan',
    group: 'v',
    what: 'Reflect and descriptor lookups, and a scan of own global names',
    build: (c) =>
      `var C = Reflect.get(window, 'RTCPeerConnection') || Reflect.get(window, 'webkitRTCPeerConnection');` +
      ` var D = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');` +
      ` if (!C && D) C = D.value;` +
      ` report({ k: 'globals', id: 'v4-reflect-scan', names: Object.getOwnPropertyNames(window).filter(function (n) { return /RTC/.test(n); }) });` +
      ` rtcWith('v4-reflect-scan', C, window);`,
  },
  {
    id: 'v5-structuredClone',
    group: 'v',
    what: 'structuredClone of the constructor (a function cannot be cloned)',
    build: (c) =>
      `var C; try { C = structuredClone(window.RTCPeerConnection); }` +
      ` catch (e) { report({ k: 'attempt-error', id: 'v5-structuredClone', err: String(e) }); }` +
      ` rtcWith('v5-structuredClone', C, window);`,
  },
  {
    id: 'v6-document-open-reinstate',
    group: 'v',
    what: 'document.open() then document.write: does the removed global return?',
    build: (c) =>
      `var before = typeof RTCPeerConnection; document.open(); document.write('<p>x</p>'); document.close();` +
      ` report({ k: 'globals', id: 'v6-document-open-reinstate', names: ['before=' + before, 'after=' + typeof RTCPeerConnection] });` +
      callRtc('v6-document-open-reinstate'),
  },

  // (vi) Customized built-ins and navigation that replaces the realm.
  {
    id: 'vi1-customized-builtin-iframe',
    group: 'vi',
    what: 'customized built-in iframe (is= option), nested srcdoc script',
    build: (c) =>
      `customElements.define('x-probe-vi1', class extends HTMLIFrameElement {}, { extends: 'iframe' });` +
      ` var f = document.createElement('iframe', { is: 'x-probe-vi1' });` +
      ` f.srcdoc = ${jsStr(nestedDoc(c, callRtc('vi1-customized-builtin-iframe')))};` +
      ' document.body.appendChild(f);',
  },
  {
    id: 'vi2-self-nav-href-leaf',
    group: 'vi',
    what: 'frame navigates itself (location.href) to the leaf page',
    build: (c) =>
      `setTimeout(function () { location.href = ${jsStr(c.leaf)}; }, 200);`,
  },
  {
    id: 'vi3-document-open-inline',
    group: 'vi',
    what: 'document.open() then an inline script written in',
    build: (c) =>
      `document.open(); document.write(${jsStr('<!doctype html>' + scriptTag(libJs(c) + callRtc('vi3-document-open-inline')))}); document.close();`,
  },
  {
    id: 'vi4-self-nav-data-leaf',
    group: 'vi',
    what: 'frame navigates itself to a data: HTML leaf',
    build: (c) =>
      `setTimeout(function () { location.href = 'data:text/html,' + encodeURIComponent(${jsStr(leafDoc(c, 'vi4-self-nav-data-leaf'))}); }, 200);`,
  },
  {
    id: 'vi5-self-nav-blob-leaf',
    group: 'vi',
    what: 'frame navigates itself to a blob: HTML leaf',
    build: (c) =>
      `setTimeout(function () { location.href = URL.createObjectURL(new Blob([${jsStr(leafDoc(c, 'vi5-self-nav-blob-leaf'))}], { type: 'text/html' })); }, 200);`,
  },
  {
    id: 'vi6-self-replace-leaf',
    group: 'vi',
    what: 'frame replaces itself (location.replace) with the leaf page',
    build: (c) =>
      `setTimeout(function () { location.replace(${jsStr(c.leaf)}); }, 200);`,
  },
  {
    id: 'vi7-self-nav-cross-origin-leaf',
    group: 'vi',
    what: 'frame navigates itself to a leaf on the host origin (cross-origin to the frame)',
    build: (c) =>
      `setTimeout(function () { location.href = ${jsStr(c.hostLeaf)}; }, 200);`,
  },

  // Review2 routes against the production containment (baseline reproduction).
  {
    id: 'r1-call-capture-iframe',
    group: 'r',
    what: 'Review2 route 1: capture native createElement/appendChild via call/apply',
    build: (c) => {
      const nested = nestedDoc(c, callRtc('r1-call-capture-iframe'));
      return (
        'var realCall = Function.prototype.call, realApply = Function.prototype.apply, seen = {};' +
        ' function spy(fn) { if (typeof fn === "function" && fn.name) seen[fn.name] = fn; }' +
        ' Function.prototype.call = function () { spy(this); return Reflect.apply(realCall, this, arguments); };' +
        ' Function.prototype.apply = function () { spy(this); return Reflect.apply(realApply, this, arguments); };' +
        ' try { document.body.appendChild(document.createElement("p")); }' +
        ' finally { Function.prototype.call = realCall; Function.prototype.apply = realApply; }' +
        ' var create = seen.createElement || Document.prototype.createElement;' +
        ' var append = seen.appendChild || Node.prototype.appendChild;' +
        ` var el = create.call(document, 'iframe'); el.srcdoc = ${jsStr(nested)}; append.call(document.body, el);`
      );
    },
  },
  {
    id: 'r2-tolowercase-iframe',
    group: 'r',
    what: 'Review2 route 1b: String.prototype.toLowerCase overridden during createElement',
    build: (c) => {
      const nested = nestedDoc(c, callRtc('r2-tolowercase-iframe'));
      return (
        'var realLower = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return "div"; };' +
        ' try { var el = document.createElement("iframe"); el.srcdoc = ' +
        jsStr(nested) +
        '; document.body.appendChild(el); }' +
        ' finally { String.prototype.toLowerCase = realLower; }'
      );
    },
  },
  {
    id: 'r3-createElementNS-xiframe',
    group: 'r',
    what: 'Review2 route 2: createElementNS XHTML x:iframe with srcdoc',
    build: (c) =>
      `var el = document.createElementNS('http://www.w3.org/1999/xhtml', 'x:' + 'iframe');` +
      ` el.srcdoc = ${jsStr(nestedDoc(c, callRtc('r3-createElementNS-xiframe')))}; document.body.appendChild(el);`,
  },
  {
    id: 'r4-docwrite-split',
    group: 'r',
    what: 'Review2 route 4: frame tag split across two document.write calls',
    build: (c) => {
      const nested = nestedDoc(c, callRtc('r4-docwrite-split'))
        .split('"')
        .join('&quot;');
      return `document.write('<' + 'if'); document.write('rame srcdoc="' + ${jsStr(nested)} + '"></' + 'iframe>');`;
    },
  },
];

// ---------------------------------------------------------------------------
// Preparing and driving runs.
// ---------------------------------------------------------------------------

async function prepareRun(
  def: CaseDef,
  column: Column,
  index: number
): Promise<Run> {
  const channel = await openChannel();
  const id = `${index}-${column}`;
  const cfg: Cfg = {
    tcp: channel.tcp,
    stun: channel.stun,
    leaf: `${frameOrigin}/leaf/${id}`,
    hostLeaf: `${hostOrigin}/leaf/${id}`,
  };
  const body = def.build(cfg);
  const top =
    libJs(cfg) +
    "report({ k: 'top', ran: true }); try {" +
    body +
    "\n} catch (e) { report({ k: 'attempt-error', id: 'top', err: String(e) }); }";
  const author =
    '<!doctype html><meta charset="utf-8"><title>probe</title><body>' +
    scriptTag(top);
  const shim: Run['shim'] =
    column === 'production'
      ? 'production'
      : column === 'candidate' || column === 'navigate'
        ? 'candidate'
        : 'plain';
  const js =
    column === 'candidate' || column === 'navigate' ? CANDIDATE_JS : PLAIN_JS;
  const csp =
    column === 'control' || column === 'production'
      ? null
      : column === 'prodcsp'
        ? productionCsp
        : column === 'navigate'
          ? `${candidateCsp(js, hostOrigin)}; navigate-to 'none'`
          : candidateCsp(js, hostOrigin);
  const run: Run = {
    id,
    column,
    cfg,
    author,
    shim,
    csp,
    channel,
    settle: def.group === 'vi' || def.group === 'iv' ? 6000 : SETTLE_MS,
  };
  runs.set(id, run);
  return run;
}

interface Observed {
  readonly markers: readonly Record<string, unknown>[];
  readonly done: boolean;
  readonly tcp: number;
  readonly udp: number;
}

async function launchBrowser(isolation: boolean) {
  const profile = await mkdtemp(join(tmpdir(), 'relic-csp-first-chrome-'));
  // The proxy and the WebRTC IP policy are removed. The policy masks non-proxied
  // UDP, which would hide the STUN packets this probe counts.
  const shared = chromeArgs(chromeExecutable, profile).filter(
    (argument) =>
      !argument.startsWith('--proxy-') &&
      !argument.startsWith('--webrtc-ip-handling-policy')
  );
  if (shared.pop() !== 'about:blank') throw new Error('chromeArgs shape');
  const processModel = isolation
    ? ['--site-per-process', '--enable-features=IsolateSandboxedIframes']
    : [];
  const argv = [
    ...shared.map((argument) =>
      argument === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : argument
    ),
    ...processModel,
    'about:blank',
  ];
  const launch = createBrowserHeadlessLaunch(argv, profile);
  const child: ChildProcess = spawn(chromeExecutable, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const connection: CdpConnection = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  const attestation = await attestBrowserHeadless(connection, launch);
  return {
    child,
    connection,
    profile,
    version: String(attestation.version['product'] ?? 'unknown'),
  };
}

async function drive(connection: CdpConnection, run: Run): Promise<Observed> {
  const created = (await connection.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  try {
    const attached = (await connection.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send(
      'Page.navigate',
      { url: `${hostOrigin}/run/${run.id}` },
      sessionId
    );
    const deadline = Date.now() + 20_000;
    let probe: { results: Record<string, unknown>[]; done: boolean } | null =
      null;
    while (Date.now() < deadline) {
      const evaluated = (await connection.send(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify(window.__probe || null)',
          returnByValue: true,
        },
        sessionId
      )) as { result?: { value?: string } };
      const value = evaluated.result?.value;
      probe =
        value === undefined || value === 'null'
          ? null
          : (JSON.parse(value) as typeof probe);
      if (probe !== null && probe.done) break;
      await Bun.sleep(150);
    }
    await Bun.sleep(800);
    const finalRead = (await connection.send(
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify(window.__probe || null)',
        returnByValue: true,
      },
      sessionId
    )) as { result?: { value?: string } };
    const finalValue = finalRead.result?.value;
    const finalProbe =
      finalValue === undefined || finalValue === 'null'
        ? null
        : (JSON.parse(finalValue) as {
            results: Record<string, unknown>[];
            done: boolean;
          });
    return {
      markers: finalProbe?.results ?? [],
      done: finalProbe?.done ?? false,
      tcp: run.channel.counters.tcpOpens + run.channel.counters.tcpData,
      udp: run.channel.counters.udpPackets,
    };
  } finally {
    await connection
      .send('Target.closeTarget', { targetId: created.targetId })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Verdicts.
// ---------------------------------------------------------------------------

type Code = 'EGRESS' | 'BLOCKED' | 'BLOCKED-PRE' | 'UNPROVEN';

interface Cell {
  readonly code: Code;
  readonly detail: string;
}

function classify(obs: Observed): { label: string; detail: string } {
  const attempts = obs.markers.filter((m) => m['k'] === 'egress');
  const errors = obs.markers
    .filter((m) => m['k'] === 'attempt-error')
    .map((m) => String(m['err']));
  const channel = [
    obs.tcp > 0 ? `tcp${obs.tcp}` : '',
    obs.udp > 0 ? `udp${obs.udp}` : '',
  ]
    .filter(Boolean)
    .join('+');
  const made = attempts
    .map((m) => `rtc=${String(m['rtc'])} made=${String(m['made'])}`)
    .join(' ');
  if (attempts.length === 0) {
    return {
      label: channel ? 'EGRESS-NO-ATTEMPT' : 'BLOCKED-PRE',
      detail:
        [channel, errors.join(' | ')].filter(Boolean).join(' ') ||
        'attempt never ran',
    };
  }
  if (channel) return { label: 'EGRESS', detail: `${channel} ${made}` };
  return { label: 'BLOCKED', detail: made };
}

function toCell(label: string, detail: string, control: string): Cell {
  if (control !== 'EGRESS') {
    return {
      code: 'UNPROVEN',
      detail: `control ${control}`,
    };
  }
  if (label === 'EGRESS') return { code: 'EGRESS', detail };
  if (label === 'BLOCKED-PRE') return { code: 'BLOCKED-PRE', detail };
  if (label === 'BLOCKED') return { code: 'BLOCKED', detail };
  return { code: 'EGRESS', detail: `${label} ${detail}` };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index] as T);
      }
    })
  );
  return out;
}

const MODELS = [
  { name: 'default process model', isolation: false },
  { name: 'site-per-process + IsolateSandboxedIframes', isolation: true },
] as const;

interface Table {
  readonly model: string;
  readonly version: string;
  readonly cells: ReadonlyMap<string, Record<Column, Cell>>;
}

const tables: Table[] = [];
const started = Date.now();

for (const model of MODELS) {
  const browser = await launchBrowser(model.isolation);
  try {
    const only = process.env['CSP_FIRST_ONLY']?.split(',');
    const jobs = CASES.map((def, caseIndex) => ({ def, caseIndex }))
      .filter(({ def }) => only === undefined || only.includes(def.id))
      .flatMap(({ def, caseIndex }) =>
        COLUMNS.map((column) => ({ def, column, caseIndex }))
      );
    const observed = await mapPool(jobs, CONCURRENCY, async (job) => {
      const run = await prepareRun(job.def, job.column, job.caseIndex);
      try {
        const obs = await drive(browser.connection, run);
        if (process.env['CSP_FIRST_DEBUG'] !== undefined) {
          console.log(
            JSON.stringify({ id: job.def.id, column: job.column, obs })
          );
        }
        return { job, obs };
      } finally {
        run.channel.stop();
        runs.delete(run.id);
      }
    });
    const cells = new Map<string, Record<Column, Cell>>();
    for (const def of CASES.filter((d) =>
      observed.some((o) => o.job.def.id === d.id)
    )) {
      const per = {} as Record<Column, Cell>;
      const controlEntry = observed.find(
        (o) => o.job.def.id === def.id && o.job.column === 'control'
      );
      const controlClass = controlEntry
        ? classify(controlEntry.obs)
        : { label: 'MISSING', detail: '' };
      for (const column of COLUMNS) {
        const entry = observed.find(
          (o) => o.job.def.id === def.id && o.job.column === column
        );
        if (entry === undefined) throw new Error(`missing ${def.id} ${column}`);
        const cls = classify(entry.obs);
        per[column] =
          column === 'control'
            ? {
                code: controlClass.label === 'EGRESS' ? 'EGRESS' : 'UNPROVEN',
                detail: `${controlClass.label} ${controlClass.detail}`.trim(),
              }
            : toCell(
                cls.label,
                cls.detail,
                controlClass.label === 'EGRESS' ? 'EGRESS' : controlClass.label
              );
      }
      cells.set(def.id, per);
    }
    tables.push({ model: model.name, version: browser.version, cells });
  } finally {
    browser.connection.dispose();
    browser.child.kill('SIGKILL');
    await rm(browser.profile, { recursive: true, force: true }).catch(() => {});
  }
}

// Report.
for (const table of tables) {
  console.log(`\n## ${table.model} (${table.version})`);
  console.log(`| case | group | ${COLUMNS.join(' | ')} |`);
  console.log(`| --- | --- | ${COLUMNS.map(() => '---').join(' | ')} |`);
  for (const def of CASES) {
    const per = table.cells.get(def.id);
    if (per === undefined) continue;
    const cell = (c: Cell) =>
      `${c.code} ${c.detail}`.trim().replace(/\|/g, '/');
    console.log(
      `| ${def.id} | ${def.group} | ${COLUMNS.map((column) => cell(per[column])).join(' | ')} |`
    );
  }
}

console.log(`\nproduction CSP: ${productionCsp}`);
console.log(
  `candidate CSP (plain shim): ${candidateCsp(PLAIN_JS, hostOrigin)}`
);
console.log(
  `candidate CSP (candidate shim): ${candidateCsp(CANDIDATE_JS, hostOrigin)}`
);
console.log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
console.log('CSP_FIRST_MEASURED');

for (const server of [hostServer, frameServer]) server.stop(true);
process.exit(0);
