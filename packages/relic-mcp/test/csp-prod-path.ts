/**
 * Production proof for the CSP-first build (frame hardening).
 *
 *   bun packages/relic-mcp/test/csp-prod-path.ts
 *
 * Every relic is published through the built MCP bundle (`dist/relic-mcp.js`),
 * stored, and opened in the viewer served by the production app. The `production`
 * side is the production host page (its frame-src names the exact shim path) and
 * the built `sandbox.html`: the production policy, RTC removal and blob re-emission.
 *
 * The `control` side is the same relic bytes and origins, with two changes: the
 * host page loses its Content-Security-Policy, and the shim is a plain shim (a raw
 * write, no policy, no containment). It answers "could the listener see this
 * channel at all". A production BLOCKED verdict counts only when the same case's
 * control showed the channel, and the production script reached its start marker.
 *
 * Verdicts (per case, per process model):
 *   EGRESS(tcpN+udpN)   a loopback listener saw a TCP connection, data, or a UDP packet.
 *   BLOCKED(ran)        the author script started and nothing reached a listener.
 *   BLOCKED(no-start)   the control showed the channel but the production script never started.
 *   UNPROVEN(reason)    the control did not show the channel, so the row says nothing about the policy.
 *   RAN / NO-RUN        relic-content cases: the marker arrived, or did not.
 *   REPORTED / NO-REPORT structural cases: the value the author script read.
 *   SHOWN / NOT-SHOWN   text cases: whether the rendered page shows the text.
 *
 * Exit status: 1 when any production case egresses, a relic-content case does not
 * run, or a text case is not shown. Otherwise 0, with the unproven rows printed.
 *
 * Process models: default, and site-per-process with IsolateSandboxedIframes.
 * Each session is one isolated chrome-headless-shell on a private port with a
 * throwaway profile. The probe never launches a headed browser or Jason's Chrome.
 *
 * Not observed: DNS (a loopback listener cannot see a lookup), any host other than
 * the two loopback origins, the public internet, SharedWorker and service workers
 * (the browser refuses them before any control could show a channel).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const RUN_BUDGET_MS = 2_400_000;
const SESSION_MAX_MS = 7_000;
const SETTLE_MS = 1_500;
const SHELL =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const chromePath =
  process.env['RELIC_CSP_PROD_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  SHELL;
// A missing shell stops the run. The probe does not fall back to another browser.
if (
  !(await access(chromePath, constants.X_OK).then(
    () => true,
    () => false
  ))
) {
  console.error(`CSP_PROD_NO_CHROME: ${chromePath} is not executable`);
  process.exit(1);
}
const found = await discoverChrome(chromePath);
if (found.kind !== 'found') {
  console.error(`CSP_PROD_NO_CHROME: ${found.kind}`);
  process.exit(1);
}
const chromeExecutable = found.path;

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist = join(repoRoot, 'packages/relic-viewer/dist');
const relicMcpBundlePath = join(packageRoot, 'dist', 'relic-mcp.js');

const watchdog = setTimeout(() => {
  console.error(`CSP_PROD_TIMEOUT after ${RUN_BUDGET_MS}ms`);
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

// The viewer's sanitiser strips frame tags from relic content. The probe builds
// those tags at run time, so this source holds no literal frame or script tag
// sequence that a reader could mistake for a payload.
const OPEN = '<';
const IFRAME = `if${'rame'}`;
const SCRIPT = `scr${'ipt'}`;
function scriptTag(js: string): string {
  if (js.includes(`</${SCRIPT}`)) throw new Error('script text closes its tag');
  return `${OPEN}${SCRIPT}>${js}${OPEN}/${SCRIPT}>`;
}
function jsStr(s: string): string {
  return JSON.stringify(s).split('<').join('\\u003c');
}

// ---------------------------------------------------------------------------
// Channels. One TCP listener and one UDP socket per case.
// ---------------------------------------------------------------------------

interface Counter {
  tcpOpens: number;
  tcpData: number;
  udpPackets: number;
}
interface Channel {
  readonly tcp: string;
  readonly stun: string;
  readonly counter: Counter;
}
const listeners: Array<{ stop(): void }> = [];

async function listenUdp(
  onPacket: () => void
): Promise<{ port: number; stop(): void }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    port: number;
    stop(): void;
  }>();
  const socket = dgram.createSocket('udp4');
  socket.on('message', onPacket);
  socket.on('error', reject);
  socket.bind(0, '127.0.0.1', () => {
    const { port } = socket.address();
    resolve({ port, stop: () => socket.close() });
  });
  return promise;
}

async function allocateChannel(key: string): Promise<Channel> {
  const counter: Counter = { tcpOpens: 0, tcpData: 0, udpPackets: 0 };
  const tcp = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        counter.tcpOpens += 1;
      },
      data() {
        counter.tcpData += 1;
      },
      close() {},
      error() {},
    },
  });
  listeners.push({ stop: () => tcp.stop(true) });
  const udp = await listenUdp(() => {
    counter.udpPackets += 1;
  });
  listeners.push(udp);
  return {
    tcp: `http://127.0.0.1:${tcp.port}/${encodeURIComponent(key)}`,
    stun: `stun:127.0.0.1:${udp.port}`,
    counter,
  };
}

function arrivals(c: Counter): number {
  return c.tcpOpens + c.tcpData + c.udpPackets;
}
function arrivalText(c: Counter): string {
  return `tcp${c.tcpOpens + c.tcpData}+udp${c.udpPackets}`;
}
function resetCounter(c: Counter): void {
  c.tcpOpens = 0;
  c.tcpData = 0;
  c.udpPackets = 0;
}

// ---------------------------------------------------------------------------
// Author-side library. Every author script gets it, so each result comes back to
// the top window as a probe message. The probe reads messages, not the frame DOM.
// ---------------------------------------------------------------------------

interface Ch {
  readonly id: string;
  readonly tcp: string;
  readonly stun: string;
  readonly leaf: string;
  readonly hostLeaf: string;
}

function libJs(ch: Ch): string {
  return (
    `var CFG = ${JSON.stringify(ch)};` +
    "function report(v) { try { top.postMessage({ type: 'probe:result', result: v }, '*'); } catch (e) {} }" +
    "function done() { try { top.postMessage({ type: 'probe:done' }, '*'); } catch (e) {} }" +
    'function rtcWith(id, C) {' +
    '  var out = { id: id, rtc: typeof C, made: false, err: null };' +
    '  try { if (C) { var pc = new C({ iceServers: [{ urls: [CFG.stun] }] });' +
    "    pc.createDataChannel('probe');" +
    '    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});' +
    '    out.made = true; } } catch (e) { out.err = String(e); }' +
    '  report(out); }' +
    "function rtcAttempt(id) { rtcWith(id, typeof RTCPeerConnection === 'undefined' ? undefined : RTCPeerConnection); }" +
    "function fetchAttempt(id) { try { fetch(CFG.tcp, { mode: 'no-cors', keepalive: true }).catch(function () {}); } catch (e) {} report({ id: id, fetch: 'attempted' }); }"
  );
}

/** A complete document whose inline script runs the library and the attempt. */
function docWith(ch: Ch, js: string): string {
  // The script sits in a body: a script in the head runs before document.body
  // exists, so a DOM-created frame could never be appended (measured, see the run).
  return `<!doctype html><meta charset="utf-8"><body>${scriptTag(libJs(ch) + js)}`;
}
/** A leaf page, served with no CSP, reached by navigation. */
function leafHtml(ch: Ch, id: string): string {
  return docWith(
    ch,
    `rtcAttempt(${jsStr(id)}); fetchAttempt(${jsStr(id)}); done();`
  );
}
/** A worker's source: a TCP fetch and a WebRTC attempt. Workers cannot report to the page. */
function workerBody(ch: Ch): string {
  return (
    `var CFG = ${JSON.stringify(ch)};` +
    'try { fetch(CFG.tcp, { mode: "no-cors" }).catch(function () {}); } catch (e) {}' +
    'try { var C = typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection;' +
    ' if (C) { var pc = new C({ iceServers: [{ urls: [CFG.stun] }] }); pc.createDataChannel("x");' +
    ' pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {}); } } catch (e) {}'
  );
}

const LEAF_PREFIX = '/__probe/leaf/';
const leaves = new Map<string, string>();

// ---------------------------------------------------------------------------
// Cases. `expect`: 'egress' (a channel the control must show), 'ran' (relic
// content whose marker must arrive), 'report' (a structural value read), or
// 'text' (what the rendered page shows).
// ---------------------------------------------------------------------------

type Kind = 'html' | 'markdown' | 'jsx' | 'svg';
type Expect = 'egress' | 'ran' | 'report' | 'text';
interface CaseDef {
  readonly id: string;
  readonly group: string;
  readonly what: string;
  readonly expect: Expect;
  readonly kind?: Kind;
  /** For 'text': a string the rendered page body must contain. */
  readonly needle?: string;
  /** A trusted mouse click on the element the script armed, not a script click. */
  readonly trigger?: 'click';
  /** The relic's whole source, given the channel addresses. */
  readonly source: (ch: Ch) => string;
}

/**
 * A script case. The top-level script reports `phase: 'start'` before anything
 * else, so a silent control or production row reads as "the script never ran"
 * (no start) or "it ran and the attempt went nowhere" (start, no egress).
 */
function scriptCase(
  id: string,
  group: string,
  what: string,
  expect: Expect,
  js: (ch: Ch) => string,
  trigger?: 'click'
): CaseDef {
  const start =
    `report({ id: ${jsStr(id)}, phase: 'start' });` +
    `setTimeout(function () { report({ id: ${jsStr(id)}, phase: 'dom', frames: document.querySelectorAll('iframe').length, srcdoc: document.querySelectorAll('iframe[srcdoc]').length, scripts: document.scripts.length, blob: Array.prototype.filter.call(document.scripts, function (s) { return (s.src || '').indexOf('blob:') === 0; }).length }); }, 500);`;
  return {
    id,
    group,
    what,
    expect,
    trigger,
    source: (ch) => docWith(ch, start + js(ch)),
  };
}

const CASES: readonly CaseDef[] = [
  // (a) The four Review2 routes, as the frame-egress probe reproduced them.
  scriptCase(
    'a-r1-call-capture',
    'a',
    'Review2 route 1: capture native createElement and appendChild through call and apply',
    'egress',
    (ch) => {
      const nested = docWith(ch, 'rtcAttempt("a-r1-call-capture"); done();');
      return (
        'var realCall = Function.prototype.call, realApply = Function.prototype.apply, seen = {};' +
        ' function spy(fn) { if (typeof fn === "function" && fn.name) seen[fn.name] = fn; }' +
        ' Function.prototype.call = function () { spy(this); return Reflect.apply(realCall, this, arguments); };' +
        ' Function.prototype.apply = function () { spy(this); return Reflect.apply(realApply, this, arguments); };' +
        ' try { document.body.appendChild(document.createElement("p")); }' +
        ' finally { Function.prototype.call = realCall; Function.prototype.apply = realApply; }' +
        ' var create = seen.createElement || Document.prototype.createElement;' +
        ' var append = seen.appendChild || Node.prototype.appendChild;' +
        ` var el = create.call(document, '${IFRAME}'); el.srcdoc = ${jsStr(nested)}; append.call(document.body, el);`
      );
    }
  ),
  scriptCase(
    'a-r2-tolowercase',
    'a',
    'Review2 route 1b: String.prototype.toLowerCase overridden while a frame is created',
    'egress',
    (ch) => {
      const nested = docWith(ch, 'rtcAttempt("a-r2-tolowercase"); done();');
      return (
        'var realLower = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return "div"; };' +
        ` try { var el = document.createElement("${IFRAME}"); el.srcdoc = ${jsStr(nested)}; document.body.appendChild(el); }` +
        ' finally { String.prototype.toLowerCase = realLower; }'
      );
    }
  ),
  scriptCase(
    'a-r3-createElementNS-xiframe',
    'a',
    'Review2 route 2: createElementNS with an XHTML x:iframe and srcdoc',
    'egress',
    (ch) =>
      `var el = document.createElementNS('http://www.w3.org/1999/xhtml', 'x:' + '${IFRAME}');` +
      ` el.srcdoc = ${jsStr(docWith(ch, 'rtcAttempt("a-r3-createElementNS-xiframe"); done();'))}; document.body.appendChild(el);`
  ),
  scriptCase(
    'a-r4-docwrite-split',
    'a',
    'Review2 route 4: a frame tag split across two document.write calls',
    'egress',
    (ch) => {
      const nested = docWith(ch, 'rtcAttempt("a-r4-docwrite-split"); done();')
        .split('"')
        .join('&quot;');
      return `document.write('<' + 'if'); document.write('rame srcdoc="' + ${jsStr(nested)} + '"></' + 'iframe>');`;
    }
  ),

  // (b) Self-navigation of the frame.
  scriptCase(
    'b-vi2-href-same-origin',
    'b',
    'frame sets location.href to a leaf on the frame origin',
    'egress',
    (ch) =>
      `setTimeout(function () { location.href = ${jsStr(ch.leaf)}; }, 200); setTimeout(done, 4000);`
  ),
  scriptCase(
    'b-vi4-href-data',
    'b',
    'frame sets location.href to a data: HTML leaf',
    'egress',
    (ch) =>
      `setTimeout(function () { location.href = 'data:text/html,' + encodeURIComponent(${jsStr(leafHtml(ch, 'b-vi4-href-data'))}); }, 200); setTimeout(done, 4000);`
  ),
  scriptCase(
    'b-vi5-href-blob',
    'b',
    'frame sets location.href to a blob: HTML leaf',
    'egress',
    (ch) =>
      `setTimeout(function () { location.href = URL.createObjectURL(new Blob([${jsStr(leafHtml(ch, 'b-vi5-href-blob'))}], { type: 'text/html' })); }, 200); setTimeout(done, 4000);`
  ),
  scriptCase(
    'b-vi6-replace-same-origin',
    'b',
    'frame calls location.replace on a leaf on the frame origin',
    'egress',
    (ch) =>
      `setTimeout(function () { location.replace(${jsStr(ch.leaf)}); }, 200); setTimeout(done, 4000);`
  ),
  scriptCase(
    'b-vi7-href-host-origin',
    'b',
    'frame sets location.href to a leaf on the host origin (cross origin to the frame)',
    'egress',
    (ch) =>
      `setTimeout(function () { location.href = ${jsStr(ch.hostLeaf)}; }, 200); setTimeout(done, 4000);`
  ),

  // (c) WebRTC constructors and the regain routes the probe could reach.
  scriptCase(
    'c-v0-author-realm',
    'c',
    'typeof RTCPeerConnection in the author realm, then an attempt through it',
    'egress',
    () =>
      "report({ id: 'c-v0', names: ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].map(function (n) { return n + '=' + typeof window[n]; }) });" +
      ' rtcAttempt("c-v0-author-realm"); done();'
  ),
  scriptCase(
    'c-v4-reflect-scan',
    'c',
    'Reflect.get and a scan of own global names for RTC constructors, then an attempt through the one found',
    'egress',
    () =>
      'var names = Object.getOwnPropertyNames(window).filter(function (n) { return /RTC/.test(n); });' +
      " report({ id: 'c-v4', names: names, reflect: typeof Reflect.get(window, 'RTCPeerConnection') });" +
      ' rtcWith("c-v4-reflect-scan", Reflect.get(window, "RTCPeerConnection")); done();'
  ),
  scriptCase(
    'c-v6-document-open',
    'c',
    'document.open() and document.close(), then the global read back, then an attempt',
    'egress',
    () =>
      'document.open(); document.close();' +
      " report({ id: 'c-v6', after: typeof RTCPeerConnection });" +
      ' rtcAttempt("c-v6-document-open"); done();'
  ),
  scriptCase(
    'c-v3-createHTMLDocument',
    'c',
    'document.implementation.createHTMLDocument and its defaultView',
    'report',
    () =>
      "var d = document.implementation.createHTMLDocument('x');" +
      " report({ id: 'c-v3', defaultView: typeof d.defaultView, rtc: d.defaultView ? typeof d.defaultView.RTCPeerConnection : 'no-window' }); done();"
  ),
  scriptCase(
    'c-v5-structuredClone',
    'c',
    'structuredClone of the constructor (a function cannot be cloned)',
    'report',
    () =>
      "try { structuredClone(typeof RTCPeerConnection === 'undefined' ? {} : RTCPeerConnection); report({ id: 'c-v5', cloned: true }); }" +
      " catch (e) { report({ id: 'c-v5', cloned: false, err: String(e && e.name) }); } done();"
  ),
  scriptCase(
    'c-v1-iframe-contentWindow',
    'c',
    'contentWindow of a same-origin about:blank child, read for its RTC constructor',
    'report',
    () =>
      `var f = document.createElement('${IFRAME}'); document.body.appendChild(f);` +
      " var w = null; try { w = f.contentWindow; } catch (e) { report({ id: 'c-v1', access: 'refused', err: String(e && e.name) }); }" +
      " if (w) { try { report({ id: 'c-v1', access: 'ok', rtc: typeof w.RTCPeerConnection }); } catch (e) { report({ id: 'c-v1', access: 'refused', err: String(e && e.name) }); } }" +
      ' done();'
  ),
  scriptCase(
    'c-v2-window-open',
    'c',
    'window.open with about:blank (the viewer sandbox has no allow-popups)',
    'report',
    () =>
      "var w = window.open('about:blank'); report({ id: 'c-v2', opened: w !== null }); done();"
  ),

  // (d) Workers.
  scriptCase(
    'd-worker-blob',
    'd',
    'dedicated worker from a blob URL: a TCP fetch and a WebRTC attempt',
    'egress',
    (ch) =>
      `var body = ${jsStr(workerBody(ch))};` +
      " try { var w = new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))); w.onerror = function () { report({ id: 'd-worker-blob', error: 'worker error' }); }; report({ id: 'd-worker-blob', made: true }); }" +
      " catch (e) { report({ id: 'd-worker-blob', made: false, err: String(e && e.name) }); } done();"
  ),
  scriptCase(
    'd-worker-data',
    'd',
    'dedicated worker from a data: URL: a TCP fetch and a WebRTC attempt',
    'egress',
    (ch) =>
      `var body = ${jsStr(workerBody(ch))};` +
      " try { var w = new Worker('data:text/javascript,' + encodeURIComponent(body)); w.onerror = function () { report({ id: 'd-worker-data', error: 'worker error' }); }; report({ id: 'd-worker-data', made: true }); }" +
      " catch (e) { report({ id: 'd-worker-data', made: false, err: String(e && e.name) }); } done();"
  ),

  // (e) Navigation. The anchor is armed and clicked by a trusted mouse event from
  // the probe: a script click in a sandboxed frame is not a gesture, and its
  // control stays silent in this build. The form and window.open rows run under
  // the viewer's sandbox attribute, which has no allow-forms or allow-popups, so
  // their controls are expected to stay silent, and those rows read UNPROVEN.
  scriptCase(
    'e-anchor-external',
    'e',
    'anchor to an external http URL, clicked by a trusted mouse event',
    'egress',
    (ch) =>
      `var a = document.createElement('a'); a.href = ${jsStr(`${ch.tcp}/anchor`)}; a.textContent = 'open'; a.style.display = 'block'; a.style.padding = '20px'; document.body.appendChild(a);` +
      " a.addEventListener('click', function () { report({ id: 'e-anchor-external', phase: 'clicked' }); });" +
      " var r = a.getBoundingClientRect(); report({ id: 'e-anchor-external', phase: 'armed', x: r.left + r.width / 2, y: r.top + r.height / 2 }); setTimeout(done, 6000);",
    'click'
  ),
  scriptCase(
    'e-form-submit-external',
    'e',
    'form submit to an external http URL (the sandbox has no allow-forms)',
    'egress',
    (ch) =>
      `var f = document.createElement('form'); f.method = 'post'; f.action = ${jsStr(`${ch.tcp}/form`)};` +
      " var i = document.createElement('input'); i.name = 'x'; i.value = 'y'; f.appendChild(i); document.body.appendChild(f);" +
      " setTimeout(function () { try { f.submit(); } catch (e) { report({ id: 'e-form-submit-external', submit: String(e && e.name) }); } }, 200); setTimeout(done, 4000);"
  ),
  scriptCase(
    'e-window-open-external',
    'e',
    'window.open to an external http URL (the sandbox has no allow-popups)',
    'egress',
    (ch) =>
      `setTimeout(function () { var w = window.open(${jsStr(`${ch.tcp}/open`)}); report({ id: 'e-window-open-external', opened: w !== null }); }, 200); setTimeout(done, 4000);`
  ),

  // (i)-(ii) Frames and script delivery.
  scriptCase(
    'i-iframe-src-same-origin-leaf',
    'i',
    'child frame whose src is a leaf on the frame origin',
    'egress',
    (ch) =>
      `var f = document.createElement('${IFRAME}'); f.src = ${jsStr(ch.leaf)}; document.body.appendChild(f); setTimeout(done, 4000);`
  ),
  scriptCase(
    'i-iframe-blob-html',
    'i',
    'child frame whose src is a blob: HTML leaf',
    'egress',
    (ch) =>
      `var f = document.createElement('${IFRAME}'); f.src = URL.createObjectURL(new Blob([${jsStr(leafHtml(ch, 'i-iframe-blob-html'))}], { type: 'text/html' })); document.body.appendChild(f); setTimeout(done, 4000);`
  ),
  scriptCase(
    'ii-blob-script-rtc',
    'ii',
    'blob: script element with an RTC attempt in its realm',
    'egress',
    (ch) =>
      "var s = document.createElement('script');" +
      ` s.src = URL.createObjectURL(new Blob([${jsStr(libJs(ch) + 'rtcAttempt("ii-blob-script-rtc"); fetchAttempt("ii-blob-script-rtc"); done();')}], { type: 'text/javascript' }));` +
      ' document.body.appendChild(s);'
  ),
  scriptCase(
    'ii-inline-injected',
    'ii',
    'script element created by script with inline text',
    'egress',
    (ch) =>
      "var s = document.createElement('script');" +
      ` s.textContent = ${jsStr(libJs(ch) + 'rtcAttempt("ii-inline-injected"); fetchAttempt("ii-inline-injected"); done();')};` +
      ' document.body.appendChild(s);'
  ),
  scriptCase(
    'ii-eval',
    'ii',
    'eval of an attempt',
    'egress',
    (ch) =>
      `eval(${jsStr(libJs(ch) + 'rtcAttempt("ii-eval"); fetchAttempt("ii-eval"); done();')});`
  ),
  scriptCase(
    'ii-new-function',
    'ii',
    'new Function of an attempt',
    'egress',
    (ch) =>
      `new Function(${jsStr(libJs(ch) + 'rtcAttempt("ii-new-function"); fetchAttempt("ii-new-function"); done();')})();`
  ),

  // (f) Real relic content: the scripts run, or the text is shown.
  {
    id: 'f1-html-inline-script',
    group: 'f',
    what: 'HTML relic: an inline script that changes the DOM and reports',
    expect: 'ran',
    kind: 'html',
    source: () =>
      `<!doctype html><meta charset="utf-8"><title>f1</title><p id="p">before</p>` +
      scriptTag(
        "var p = document.getElementById('p'); p.textContent = 'after';" +
          " top.postMessage({ type: 'probe:result', result: { id: 'f1', ran: 'html', text: p.textContent } }, '*');" +
          " top.postMessage({ type: 'probe:done' }, '*');"
      ),
  },
  {
    id: 'f2-markdown-raw-script',
    group: 'f',
    what: 'Markdown relic with a raw HTML script block: the viewing origin escapes raw HTML, so the script does not run and the heading shows',
    expect: 'text',
    kind: 'markdown',
    needle: 'Markdown relic',
    source: () =>
      '# Markdown relic\n\nA paragraph.\n\n' +
      scriptTag(
        "top.postMessage({ type: 'probe:result', result: { id: 'f2', ran: 'markdown' } }, '*');"
      ) +
      '\n',
  },
  {
    id: 'f3-jsx-component',
    group: 'f',
    what: 'JSX relic: a component whose effect reports after it mounts',
    expect: 'ran',
    kind: 'jsx',
    source: () =>
      'export default function App() {\n' +
      "  React.useEffect(function () { var el = document.getElementById('x'); top.postMessage({ type: 'probe:result', result: { id: 'f3', ran: 'jsx', text: el ? el.textContent : null } }, '*'); top.postMessage({ type: 'probe:done' }, '*'); }, []);\n" +
      '  return <h1 id="x">jsx ok</h1>;\n' +
      '}\n',
  },
  {
    id: 'f4-svg-script',
    group: 'f',
    what: 'SVG relic with an inline script that reports',
    expect: 'ran',
    kind: 'svg',
    source: () =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="20">svg</text>' +
      scriptTag(
        "top.postMessage({ type: 'probe:result', result: { id: 'f4', ran: 'svg' } }, '*'); top.postMessage({ type: 'probe:done' }, '*');"
      ) +
      '</svg>',
  },

  // Behaviour the design stops. Observed, not claimed as a security result.
  {
    id: 'g-inline-onclick',
    group: 'g',
    what: 'inline event handler attribute, clicked by script (expected to stop working)',
    expect: 'ran',
    kind: 'html',
    source: () =>
      "<!doctype html><meta charset=\"utf-8\"><button id=\"b\" onclick=\"top.postMessage({ type: 'probe:result', result: { id: 'g-onclick', ran: 'onclick' } }, '*')\">x</button>" +
      scriptTag(
        "setTimeout(function () { document.getElementById('b').click(); top.postMessage({ type: 'probe:done' }, '*'); }, 200);"
      ),
  },
  {
    id: 'g-javascript-url',
    group: 'g',
    what: 'javascript: anchor clicked by script (expected to stop working)',
    expect: 'ran',
    kind: 'html',
    source: () =>
      "<!doctype html><meta charset=\"utf-8\"><a id=\"a\" href=\"javascript:top.postMessage({ type: 'probe:result', result: { id: 'g-js-url', ran: 'javascript-url' } }, '*')\">x</a>" +
      scriptTag(
        "setTimeout(function () { document.getElementById('a').click(); setTimeout(function () { top.postMessage({ type: 'probe:done' }, '*'); }, 800); }, 200);"
      ),
  },
];

// ---------------------------------------------------------------------------
// Servers. One app serves both origins, as production routes by host. The side
// is a switch read per request; sessions run one at a time, so it is exact.
// ---------------------------------------------------------------------------

type Side = 'production' | 'control';
let side: Side = 'production';

const store = new MemoryStore();
let mcpHandler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  fetch(request) {
    if (!mcpHandler) return new Response('Not ready', { status: 503 });
    return mcpHandler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

const CONTROL_SHIM = `<!doctype html><meta charset="utf-8"><title>Relic content</title><script>
addEventListener('message', function (event) {
  if (event.source !== parent) return;
  var data = event.data;
  if (data && data.type === 'relic:render' && typeof data.html === 'string') {
    document.open(); document.write(data.html); document.close();
  }
});
parent.postMessage({ type: 'relic:sandbox-ready' }, '*');
</script>`;

function leaf(url: URL): Response {
  const body = leaves.get(url.pathname.slice(LEAF_PREFIX.length));
  if (body === undefined) return new Response('no leaf', { status: 404 });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

let app: { fetch(request: Request): Promise<Response> } | undefined;
const usercontent = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!app) return new Response('Not ready', { status: 503 });
    const url = new URL(request.url);
    if (url.pathname.startsWith(LEAF_PREFIX)) return leaf(url);
    if (side === 'control' && url.pathname === '/sandbox.html') {
      return new Response(CONTROL_SHIM, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return app.fetch(request);
  },
});
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;

app = createApp({
  // One run publishes about 40 relics from one loopback address. The production
  // default (60 an hour) would refuse the later ones, so this app alone is raised.
  config: {
    serviceOrigin: origin,
    usercontentOrigin,
    publishRateLimit: { limit: 1000, windowSeconds: 3600 },
  },
  store,
  storage,
  assets: diskAssets(viewerDist),
});

mcpHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith(LEAF_PREFIX)) return leaf(url);
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
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  const response = await app?.fetch(request);
  if (response === undefined) return new Response('Not ready', { status: 503 });
  if (
    side === 'control' &&
    (response.headers.get('content-type') ?? '').startsWith('text/html')
  ) {
    // The control host page loses its policy and keeps everything else.
    const headers = new Headers(response.headers);
    headers.delete('content-security-policy');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
};

// ---------------------------------------------------------------------------
// Publishing through the real MCP bundle.
// ---------------------------------------------------------------------------

const scratch = await mkdtemp(join(tmpdir(), 'relic-csp-prod-'));
const statePath = join(scratch, 'state.json');

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
      RELIC_CLIENT_NAME: 'relic-mcp/csp-prod-path',
      RELIC_CHROME_PATH: 'none',
      RELIC_OTIO_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`relic-mcp exited ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const response = JSON.parse(lines[lines.length - 1] ?? '{}') as {
    error?: unknown;
    result?: { structuredContent?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
  };
  if (response.error)
    throw new Error(`MCP error: ${JSON.stringify(response.error)}`);
  return response.result?.structuredContent ?? response.result ?? {};
}

const EXTENSION: Record<Kind, string> = {
  html: 'html',
  markdown: 'md',
  jsx: 'jsx',
  svg: 'svg',
};

interface Published {
  readonly def: CaseDef;
  readonly url: string;
  readonly channel: Channel;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Browser sessions: one isolated headless shell per session, throwaway profile.
// ---------------------------------------------------------------------------

const CAPTURE_JS = `(function () {
  if (window.__probe) return;
  var cap = window.__probe = { results: [], done: false, errors: [] };
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'probe:result') cap.results.push(d.result);
    else if (d.type === 'probe:done') cap.done = true;
  });
  window.addEventListener('error', function (event) {
    var message = String(event && event.message).slice(0, 200);
    cap.errors.push(message);
    // A frame's own error never reaches the top window's listener, so forward it.
    if (window !== top) {
      try { top.postMessage({ type: 'probe:result', result: { phase: 'error', message: message } }, '*'); } catch (e) {}
    }
  });
})();`;

interface Capture {
  results: unknown[];
  done: boolean;
  /** Uncaught errors in the top document: a script that died is not a script that was blocked. */
  errors: string[];
  /** The top document's rendered text, for relics whose proof is what the page shows. */
  text: string;
  /** Frames and scripts in the top document: whether the author's element exists at all. */
  dom?: {
    frames: number;
    scripts: number;
    blobScripts: number;
    srcdocFrames: number;
  };
}

function emptyCapture(): Capture {
  return { results: [], done: false, errors: [], text: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCapture(
  connection: CdpConnection,
  sessionId: string
): Promise<Capture> {
  const evaluated = (await connection.send(
    'Runtime.evaluate',
    {
      expression:
        '(function () { var c = window.__probe || { results: [], done: false, errors: [] }; ' +
        'var s = Array.prototype.slice.call(document.scripts); ' +
        'var f = Array.prototype.slice.call(document.querySelectorAll("iframe")); ' +
        'return JSON.stringify({ results: c.results, done: c.done, errors: c.errors, ' +
        'text: document.body ? document.body.innerText.slice(0, 2000) : "", ' +
        'dom: { frames: f.length, scripts: s.length, blobScripts: s.filter(function (x) { return (x.src || "").indexOf("blob:") === 0; }).length, ' +
        'srcdocFrames: f.filter(function (x) { return x.hasAttribute("srcdoc"); }).length } }); })()',
      returnByValue: true,
    },
    sessionId
  )) as { result?: { value?: string } };
  const value = evaluated.result?.value;
  return value === undefined ? emptyCapture() : (JSON.parse(value) as Capture);
}

/**
 * Clicks the element a case armed, with a trusted mouse event. The armed report
 * gives the element's centre inside the frame; the frame's position in the top
 * page is added. A click that never reaches the element shows as no `clicked`
 * report, so a missed click reads differently from a blocked one.
 */
async function trustedClick(
  connection: CdpConnection,
  sessionId: string
): Promise<void> {
  const armedBy = Date.now() + SESSION_MAX_MS;
  let point: { x: number; y: number } | undefined;
  while (point === undefined && Date.now() < armedBy) {
    await sleep(200);
    const capture = await readCapture(connection, sessionId);
    const armed = capture.results.find(
      (r) => (r as { phase?: string }).phase === 'armed'
    ) as { x?: number; y?: number } | undefined;
    if (armed?.x !== undefined && armed.y !== undefined) {
      point = { x: armed.x, y: armed.y };
    }
  }
  if (point === undefined) return;
  const offset = (await connection.send(
    'Runtime.evaluate',
    {
      expression:
        "(function () { var f = document.querySelector('iframe.usercontent-frame'); if (!f) return '{}'; var r = f.getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top }); })()",
      returnByValue: true,
    },
    sessionId
  )) as { result?: { value?: string } };
  const frame = JSON.parse(offset.result?.value ?? '{}') as {
    x?: number;
    y?: number;
  };
  const x = point.x + (frame.x ?? 0);
  const y = point.y + (frame.y ?? 0);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await connection.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1 },
      sessionId
    );
  }
}

const MODELS = ['default', 'isolated'] as const;
type Model = (typeof MODELS)[number];

async function session(
  url: string,
  model: Model,
  trigger?: 'click'
): Promise<{ capture: Capture; version: string }> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-csp-prod-chrome-'));
  // The proxy and the WebRTC masking flag go. The probe's listeners are loopback,
  // and masking non-proxied UDP would hide the channel the probe counts.
  const shared = chromeArgs(chromeExecutable, profile).filter(
    (argument) =>
      !argument.startsWith('--proxy-') &&
      !argument.startsWith('--webrtc-ip-handling-policy')
  );
  if (shared.pop() !== 'about:blank') {
    throw new Error('chromeArgs must end with about:blank');
  }
  const processModel =
    model === 'isolated'
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
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  const connection: CdpConnection = connectPipe(toChrome, fromChrome);
  try {
    const attestation = await attestBrowserHeadless(connection, launch);
    const created = (await connection.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const attached = (await connection.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: CAPTURE_JS },
      sessionId
    );
    const loaded = connection.waitForEvent('Page.loadEventFired', {
      sessionId,
      timeoutMs: 30_000,
    });
    const navigated = await connection.send(
      'Page.navigate',
      { url },
      sessionId
    );
    if (navigated['errorText'] !== undefined) {
      loaded.catch(() => {});
      throw new Error(`navigation failed: ${String(navigated['errorText'])}`);
    }
    await loaded.catch(() => {});
    const deadline = Date.now() + SESSION_MAX_MS;
    if (trigger === 'click') await trustedClick(connection, sessionId);
    let capture = await readCapture(connection, sessionId);
    while (!capture.done && Date.now() < deadline) {
      await sleep(200);
      capture = await readCapture(connection, sessionId);
    }
    await sleep(SETTLE_MS);
    capture = await readCapture(connection, sessionId);
    return {
      capture,
      version: String(attestation.version['product'] ?? 'unknown'),
    };
  } finally {
    connection.dispose();
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Observations and verdicts.
// ---------------------------------------------------------------------------

interface Observation {
  readonly capture: Capture;
  readonly arrived: number;
  readonly text: string;
  readonly version: string;
}

function summarize(result: unknown): string {
  return JSON.stringify(result).slice(0, 160);
}

function started(capture: Capture, id: string): boolean {
  return capture.results.some(
    (r) =>
      (r as { id?: string }).id === id &&
      (r as { phase?: string }).phase === 'start'
  );
}

function errorsOf(capture: Capture): string {
  return capture.errors.join(' | ') || 'none';
}

/**
 * The verdict for one case and model. EGRESS in production fails the run. BLOCKED
 * needs a control that showed the channel in this run, and a production script
 * that reached its start marker. Anything else is UNPROVEN, with the reason.
 */
function judge(def: CaseDef, prod: Observation, ctrl: Observation): string {
  if (def.expect === 'text') {
    return prod.capture.text.includes(def.needle ?? '')
      ? 'SHOWN'
      : `NOT-SHOWN (text: ${JSON.stringify(prod.capture.text.slice(0, 80))})`;
  }
  if (def.expect === 'ran') {
    return prod.capture.results.length > 0
      ? `RAN ${summarize(prod.capture.results[0])}`
      : `NO-RUN (errors: ${errorsOf(prod.capture)})`;
  }
  if (def.expect === 'report') {
    const reports = prod.capture.results.filter(
      (r) => (r as { phase?: string }).phase !== 'start'
    );
    return reports.length > 0
      ? `REPORTED ${reports.map(summarize).join(' | ')}`
      : `NO-REPORT (errors: ${errorsOf(prod.capture)})`;
  }
  if (prod.arrived > 0) return `EGRESS(${prod.text})`;
  if (ctrl.arrived === 0) {
    const reason = started(ctrl.capture, def.id)
      ? `control ran and no channel reached (errors: ${errorsOf(ctrl.capture)})`
      : `control script never started (errors: ${errorsOf(ctrl.capture)})`;
    return `UNPROVEN(${reason})`;
  }
  if (!started(prod.capture, def.id)) return 'BLOCKED(no-start)';
  const clicked = prod.capture.results.some(
    (r) => (r as { phase?: string }).phase === 'clicked'
  );
  if (def.trigger === 'click' && !clicked) {
    return 'UNPROVEN(production trusted click did not reach the element)';
  }
  return 'BLOCKED(ran)';
}

async function observe(
  item: Published,
  model: Model,
  which: Side
): Promise<Observation> {
  side = which;
  resetCounter(item.channel.counter);
  const { capture, version } = await session(item.url, model, item.def.trigger);
  side = 'production';
  return {
    capture,
    arrived: arrivals(item.channel.counter),
    text: arrivalText(item.channel.counter),
    version,
  };
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const published: Published[] = [];
// RELIC_CSP_PROD_ONLY=id,id runs a subset, for diagnosis. The default run is every case.
const only = process.env['RELIC_CSP_PROD_ONLY']?.split(',');
const selected = CASES.filter((c) => only === undefined || only.includes(c.id));
for (const def of selected) {
  const channel = await allocateChannel(def.id);
  const ch: Ch = {
    id: def.id,
    tcp: channel.tcp,
    stun: channel.stun,
    leaf: `${usercontentOrigin}${LEAF_PREFIX}${def.id}`,
    hostLeaf: `${origin}${LEAF_PREFIX}${def.id}`,
  };
  leaves.set(def.id, leafHtml(ch, def.id));
  const kind: Kind = def.kind ?? 'html';
  const path = join(scratch, `${def.id}.${EXTENSION[kind]}`);
  await writeFile(path, def.source(ch));
  const result = await callMcp('relic_publish', {
    path,
    title: `CSP prod probe ${def.id}`,
    cover: false,
  });
  const url = String(result['url'] ?? result['link'] ?? '');
  published.push({
    def,
    url,
    channel,
    error: url.includes('#')
      ? undefined
      : `no keyed link: ${JSON.stringify(result).slice(0, 200)}`,
  });
}

const shell = await fetch(`${usercontentOrigin}/sandbox.html`);
const reportingHeaders = ['reporting-endpoints', 'report-to', 'nel'].filter(
  (name) => shell.headers.has(name)
);
console.log(
  `CSP_PROD_SHELL_REPORTING ${reportingHeaders.length === 0 ? 'none' : reportingHeaders.join(',')}`
);

const failures: string[] = [];
const unproven: string[] = [];
let version = 'unknown';
for (const item of published) {
  if (item.error !== undefined) {
    failures.push(`${item.def.id}: ${item.error}`);
    console.log(
      `CSP_PROD ${item.def.id} [${item.def.group}] ERROR ${item.error}`
    );
    continue;
  }
  console.log(`CSP_PROD ${item.def.id} [${item.def.group}] ${item.def.what}`);
  for (const model of MODELS) {
    const prod = await observe(item, model, 'production');
    version = prod.version;
    // Every case gets a control, the relic cases too, so a NO-RUN has a reference.
    const ctrl = await observe(item, model, 'control');
    const verdict = judge(item.def, prod, ctrl);
    console.log(`  ${model}: production=${verdict}`);
    const domText = (c: Capture): string => {
      const dom = c.results.find(
        (r) =>
          (r as { id?: string; phase?: string }).id === item.def.id &&
          (r as { phase?: string }).phase === 'dom'
      );
      return dom === undefined
        ? 'frame-dom=none'
        : `frame-dom=${JSON.stringify(dom)}`;
    };
    const ctrlText =
      ctrl.arrived > 0
        ? `EGRESS(${ctrl.text}) ${domText(ctrl.capture)}`
        : `silent(ran=${started(ctrl.capture, item.def.id)}, reports=${ctrl.capture.results.length}, errors=${ctrl.capture.errors.length}) ${domText(ctrl.capture)}`;
    console.log(`  ${model}: control=${ctrlText}`);
    console.log(`  ${model}: production-${domText(prod.capture)}`);
    if (verdict.startsWith('EGRESS')) {
      failures.push(`${item.def.id} (${model}): ${verdict}`);
    }
    // A relic-content case must run. The g rows are the behaviour the design stops,
    // so their NO-RUN is the expected result and does not fail the proof.
    if (
      item.def.group === 'f' &&
      item.def.expect === 'ran' &&
      verdict.startsWith('NO-RUN')
    ) {
      failures.push(`${item.def.id} (${model}): ${verdict}`);
    }
    if (item.def.expect === 'text' && verdict.startsWith('NOT-SHOWN')) {
      failures.push(`${item.def.id} (${model}): ${verdict}`);
    }
    if (verdict.startsWith('UNPROVEN')) {
      unproven.push(`${item.def.id} (${model}): ${verdict}`);
    }
  }
}

console.log(`CSP_PROD_CHROME ${chromeExecutable} ${version}`);
console.log(
  `CSP_PROD_UNPROVEN ${unproven.length === 0 ? 'none' : unproven.join('\n  ')}`
);

for (const listener of listeners) listener.stop();
service.stop(true);
usercontent.stop(true);
await rm(scratch, { recursive: true, force: true }).catch(() => {});

if (failures.length > 0) {
  console.log('CSP_PROD_FAIL');
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
console.log('CSP_PROD_OK');
process.exit(0);
