/**
 * Frame egress proof (F2).
 *
 *   bun packages/relic-mcp/test/frame-egress-path.ts
 *
 * The sandboxed render frame must not reach the network by any channel the
 * author can reach. The proof publishes HTML relics through the real MCP
 * bundle, serves them through the real app (production CSP on the usercontent
 * origin), opens them in an isolated headless browser with a throwaway profile,
 * and lets the relic's own script try every channel it can think of.
 *
 * What counts as egress is what the browser did, observed outside the page.
 * Every channel gets its own loopback TCP listener and its own UDP socket. A
 * TCP connection, a TCP chunk, or a UDP packet landing on a channel's socket is
 * egress on that channel. WebRTC is observed by pointing an RTCPeerConnection's
 * STUN server at a UDP socket the harness owns. A channel that fails inside the
 * page is not blocked by that fact alone.
 *
 * Variants: two process models (default, and site-per-process with
 * IsolateSandboxedIframes), a run with the harness WebRTC policy that masks
 * non-proxied UDP (to show what that flag hides), every navigation channel on
 * its own relic, and one negative control: a throwaway shim without frame
 * containment, behind the production CSP. The negative control must show
 * WebRTC egress and must not show network egress. That is what proves the
 * probe can fail, and that CSP and containment are separate layers.
 *
 * Positive controls run after the production runs: the main relic and each
 * navigation channel, with no CSP and no containment, in the same sandboxed
 * frame. An arrival there shows the listener can see the channel. A silent
 * production channel is blocked only if its control arrived; otherwise it prints
 * UNPROVEN with the reason. A DNS lookup opens no connection, so DNS-only
 * channels are UNPROVEN by construction.
 *
 * The probe also reads the served shim's response. A CSP violation report or a
 * network error report needs an endpoint that some response names, so the probe
 * fails if that response carries Reporting-Endpoints, Report-To or NEL, or a CSP
 * report-to or report-uri directive.
 *
 * KNOWN_EGRESS is the explicit list of channels allowed to egress. It is empty.
 * Any unlisted egress fails the proof, and a listed channel that stops egressing
 * also fails, so the list cannot go stale.
 *
 * The marker is FRAME_EGRESS_PATH_OK when every channel is observable and blocked,
 * and FRAME_EGRESS_PATH_OK_WITH_UNPROVEN when no egress was observed but some
 * channels are unobservable here. The probe exits 0 for both.
 *
 * Measured on loopback TCP and UDP listeners and on a LAN address for STUN.
 * The probe reads those listeners only and never Chrome's net log, so DNS
 * resolution is not observed. Nothing here is measured on the public internet.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
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

const RUN_BUDGET_MS = 1_800_000;
const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const namedChrome =
  process.env['RELIC_FRAME_EGRESS_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  ((await access(defaultOwnedShell, constants.X_OK)
    .then(() => true)
    .catch(() => false))
    ? defaultOwnedShell
    : undefined);
const foundChrome = await discoverChrome(
  namedChrome && namedChrome !== 'none' && namedChrome !== 'disabled'
    ? namedChrome
    : undefined
);
assert.equal(
  foundChrome.kind,
  'found',
  `no Chrome executable found: ${foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');
const chromeExecutable = foundChrome.path;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const viewerDist =
  process.env['RELIC_FRAME_EGRESS_VIEWER_DIST'] ??
  join(repoRoot, 'packages/relic-viewer/dist');
const relicMcpBundlePath = join(packageRoot, 'dist', 'relic-mcp.js');

const watchdog = setTimeout(() => {
  console.error(`FRAME_EGRESS_PATH_TIMEOUT after ${RUN_BUDGET_MS}ms`);
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

/**
 * Channels allowed to egress. Empty: no frame channel may reach the network.
 * An entry needs a measured reason and a spec change that names it.
 */
const KNOWN_EGRESS: Readonly<Record<string, string>> = {};

/**
 * Channels a loopback listener cannot see by construction. A DNS lookup opens no
 * connection, so nothing arrives on a listener. These print UNPROVEN. Every other
 * channel's observability comes from its positive control, measured in this run.
 */
const LISTENER_UNOBSERVABLE: Readonly<Record<string, string>> = {
  'net:link-dns-prefetch':
    'DNS-only hint: a loopback listener cannot see a DNS lookup',
};

/**
 * The throwaway shim for the negative control. It re-emits author scripts as
 * blob scripts, the way the production shim does, and installs no RTC guard and
 * no containment. Served behind the production policy, with its own script hash
 * in place of the production shim's, it must still show WebRTC egress: the
 * policy and the blob path do not stop WebRTC, and only the realm guard does.
 */
const THROWAWAY_JS = `addEventListener('message', function (event) {
  if (event.source !== parent) return;
  var data = event.data;
  if (!data || data.type !== 'relic:render' || typeof data.html !== 'string') return;
  var doc = new DOMParser().parseFromString(data.html, 'text/html');
  var scripts = Array.prototype.slice.call(doc.querySelectorAll('script'));
  for (var i = 0; i < scripts.length; i++) {
    var s = scripts[i];
    if (s.hasAttribute('src')) continue;
    var type = (s.getAttribute('type') || '').trim().toLowerCase();
    if (type !== '' && type !== 'text/javascript' && type !== 'module') continue;
    s.setAttribute('src', URL.createObjectURL(new Blob([s.textContent], { type: 'text/javascript' })));
  }
  document.open();
  document.write('<!doctype html>' + doc.documentElement.outerHTML);
  document.close();
});
parent.postMessage({ type: 'relic:sandbox-ready' }, '*');`;
const THROWAWAY_HASH = `sha256-${createHash('sha256').update(THROWAWAY_JS).digest('base64')}`;
const THROWAWAY_SHIM = `<!doctype html><meta charset="utf-8"><title>Relic content</title><script>${THROWAWAY_JS}</script>`;

/** Installed in the host page before navigation, so no probe message is missed. */
const CAPTURE_JS = `(function () {
  if (window.__egressCapture) return;
  var cap = window.__egressCapture = { results: [], nested: [], done: false };
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'probe:result') cap.results.push(d.result);
    else if (d.type === 'probe:nested') cap.nested.push(d.nested);
    else if (d.type === 'probe:done') cap.done = true;
  });
})();`;

const MECH_IDS = [
  'mech:createElement-iframe',
  'mech:case-f1-prefixed-ns',
  'mech:case-f0-tolowercase',
  'mech:case-f0-call-capture',
  'mech:createElement-coerced-after',
  'mech:createElementNS-iframe',
  'mech:innerHTML',
  'mech:innerHTML-coerced',
  'mech:insertAdjacentHTML',
  'mech:insertAdjacentHTML-coerced',
  'mech:outerHTML',
  'mech:outerHTML-coerced',
  'mech:createContextualFragment',
  'mech:createContextualFragment-coerced',
  'mech:template-importNode',
  'mech:shadow-innerHTML',
  'mech:shadow-innerHTML-coerced',
  'mech:shadow-setHTMLUnsafe',
  'mech:element-setHTMLUnsafe',
  'mech:parseHTMLUnsafe-fragment',
  'mech:domparser-appendChild-element',
  'mech:domparser-append-element',
  'mech:domparser-fragment-appendChild',
  'mech:domparser-fragment-append',
  'mech:domparser-fragment-prepend',
  'mech:domparser-fragment-replaceChildren',
  'mech:domparser-fragment-insertBefore',
  'mech:domparser-fragment-replaceChild',
  'mech:domparser-child-after',
  'mech:domparser-child-before',
  'mech:domparser-child-replaceWith',
  'mech:domparser-range-insertNode',
  'mech:domparser-moveBefore',
  'mech:domparser-template-importNode',
  'mech:implementation-createElement',
  'mech:fencedframe-element',
  'mech:object-element',
  'mech:embed-element',
  'mech:frame-element',
] as const;

const NET_IDS = [
  'net:fetch-no-cors',
  'net:fetch-cors',
  'net:xhr',
  'net:websocket',
  'net:eventsource',
  'net:sendBeacon',
  'net:webtransport',
  'net:worker-blob',
  'net:shared-worker-blob',
  'net:service-worker',
  'net:dynamic-import',
  'net:script-element',
  'net:img-src',
  'net:img-element',
  'net:img-srcset',
  'net:picture-source',
  'net:video-src',
  'net:audio-src',
  'net:track',
  'net:link-stylesheet',
  'net:css-import',
  'net:css-font-face',
  'net:css-background-image',
  'net:svg-image',
  'net:svg-use',
  'net:link-preload',
  'net:link-prefetch',
  'net:link-preconnect',
  'net:link-dns-prefetch',
  'net:link-modulepreload',
  'net:link-icon',
  'net:base-href',
  'net:input-image',
  'net:speculation-prefetch',
  'net:speculation-prerender',
  'net:fetchLater',
] as const;

const WRITE_IDS = [
  'write:markup',
  'write:coerced',
  'write:writeln-coerced',
  'write:case-f3-split-calls',
] as const;

const NAV_IDS = [
  'nav:location.href',
  'nav:location.replace',
  'nav:meta-refresh',
  'nav:anchor-click',
  'nav:area-click',
  'nav:anchor-ping',
  'nav:anchor-ping-contained',
  'nav:window-open',
  'nav:top-location',
  'nav:parent-location',
  'nav:form-submit',
  'nav:form-requestSubmit',
  'nav:case-f4-javascript-url',
] as const;

const MAIN_IDS = ['rtc:shim-realm', ...MECH_IDS, ...NET_IDS] as const;

/*
 * The viewer's sanitiser strips every `<iframe`, `<frame`, `<object`, `<embed`
 * and `<portal` from the whole relic, scripts included. So the runner never
 * writes those tags as literals: `<` and the name are joined at run time, and
 * the probe's own source contains no such sequence.
 */
const HELPERS_JS = `
var S = '<' + '/script>';
var IFRAME_OPEN = '<' + 'iframe srcdoc="';
var IFRAME_CLOSE = '</' + 'iframe>';
function post(msg) { try { top.postMessage(msg, '*'); } catch (e) {} }
function u(id) { return CFG.channels[id].url; }
function esc(s) { return s.split('&').join('&amp;').split('"').join('&quot;'); }
function nestedHtml(id) {
  var c = CFG.channels[id];
  var js = [
    '(function () {',
    '  var out = { id: ' + JSON.stringify(id) + ', created: false, error: null, rtcType: typeof RTCPeerConnection };',
    '  try {',
    '    var pc = new RTCPeerConnection({ iceServers: [{ urls: ' + JSON.stringify(c.stun) + ' }] });',
    '    pc.createDataChannel("probe");',
    '    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});',
    '    out.created = true;',
    '  } catch (e) { out.error = String(e); }',
    '  try { fetch(' + JSON.stringify(c.url) + ', { mode: "no-cors" }).catch(function () {}); } catch (e) {}',
    '  try { top.postMessage({ type: "probe:nested", nested: out }, "*"); } catch (e) {}',
    '})();'
  ].join('\\n');
  return '<scr' + 'ipt>' + js + S;
}
function frameMarkup(id) { return IFRAME_OPEN + esc(nestedHtml(id)) + '"></' + 'iframe>'; }
function parsedFrame(id) { return new DOMParser().parseFromString(frameMarkup(id), 'text/html').querySelector('iframe'); }
function coerced(v) { return { toString: function () { return v; } }; }
function unsupported(name) { throw new Error('unsupported: ' + name); }
function fragWith(node) { var f = document.createDocumentFragment(); f.append(node); return f; }
`;

const CHANNELS_JS = `
var CH = {};
CH['rtc:shim-realm'] = function (id) {
  var pc = new RTCPeerConnection({ iceServers: [{ urls: CFG.channels[id].stun }] });
  pc.createDataChannel('probe');
  pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
};
CH['mech:createElement-iframe'] = function (id, box) { var el = document.createElement('iframe'); el.srcdoc = nestedHtml(id); box.appendChild(el); };
CH['mech:case-f1-prefixed-ns'] = function (id, box) {
  var el = document.createElementNS('http://www.w3.org/1999/xhtml', 'x:iframe');
  el.srcdoc = nestedHtml(id);
  box.appendChild(el);
};
CH['mech:case-f0-tolowercase'] = function (id, box) {
  var realLower = String.prototype.toLowerCase;
  String.prototype.toLowerCase = function () { return 'div'; };
  try {
    var el = document.createElement('iframe');
    el.srcdoc = nestedHtml(id);
    box.appendChild(el);
  } finally {
    String.prototype.toLowerCase = realLower;
  }
};
CH['mech:case-f0-call-capture'] = function (id, box) {
  var realCall = Function.prototype.call, realApply = Function.prototype.apply, seen = {};
  function spy(fn) { if (typeof fn === 'function' && fn.name) seen[fn.name] = fn; }
  Function.prototype.call = function () { spy(this); return Reflect.apply(realCall, this, arguments); };
  Function.prototype.apply = function () { spy(this); return Reflect.apply(realApply, this, arguments); };
  try {
    box.appendChild(document.createElement('p'));
  } finally {
    Function.prototype.call = realCall;
    Function.prototype.apply = realApply;
  }
  var create = seen.createElement || Document.prototype.createElement;
  var append = seen.appendChild || Node.prototype.appendChild;
  var el = create.call(document, 'iframe');
  el.srcdoc = nestedHtml(id);
  append.call(box, el);
};
CH['mech:createElement-coerced-after'] = function (id, box) { var el = document.createElement(coerced('iframe')); el.srcdoc = nestedHtml(id); box.after(el); };
CH['mech:createElementNS-iframe'] = function (id, box) { var el = document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe'); el.srcdoc = nestedHtml(id); box.appendChild(el); };
CH['mech:innerHTML'] = function (id, box) { box.innerHTML = frameMarkup(id); };
CH['mech:innerHTML-coerced'] = function (id, box) { box.innerHTML = coerced(frameMarkup(id)); };
CH['mech:insertAdjacentHTML'] = function (id, box) { box.insertAdjacentHTML('beforeend', frameMarkup(id)); };
CH['mech:insertAdjacentHTML-coerced'] = function (id, box) { box.insertAdjacentHTML('beforeend', coerced(frameMarkup(id))); };
CH['mech:outerHTML'] = function (id, box) { var d = document.createElement('div'); box.appendChild(d); d.outerHTML = frameMarkup(id); };
CH['mech:outerHTML-coerced'] = function (id, box) { var d = document.createElement('div'); box.appendChild(d); d.outerHTML = coerced(frameMarkup(id)); };
CH['mech:createContextualFragment'] = function (id, box) { box.appendChild(document.createRange().createContextualFragment(frameMarkup(id))); };
CH['mech:createContextualFragment-coerced'] = function (id, box) { box.appendChild(document.createRange().createContextualFragment(coerced(frameMarkup(id)))); };
CH['mech:template-importNode'] = function (id, box) { var t = document.createElement('template'); t.innerHTML = frameMarkup(id); box.appendChild(document.importNode(t.content, true)); };
CH['mech:shadow-innerHTML'] = function (id, box) { var h = document.createElement('div'); box.appendChild(h); h.attachShadow({ mode: 'open' }).innerHTML = frameMarkup(id); };
CH['mech:shadow-innerHTML-coerced'] = function (id, box) { var h = document.createElement('div'); box.appendChild(h); h.attachShadow({ mode: 'open' }).innerHTML = coerced(frameMarkup(id)); };
CH['mech:shadow-setHTMLUnsafe'] = function (id, box) { var h = document.createElement('div'); box.appendChild(h); var sr = h.attachShadow({ mode: 'open' }); if (typeof sr.setHTMLUnsafe !== 'function') unsupported('ShadowRoot.setHTMLUnsafe'); sr.setHTMLUnsafe(frameMarkup(id)); };
CH['mech:element-setHTMLUnsafe'] = function (id, box) { if (typeof box.setHTMLUnsafe !== 'function') unsupported('Element.setHTMLUnsafe'); box.setHTMLUnsafe(frameMarkup(id)); };
CH['mech:parseHTMLUnsafe-fragment'] = function (id, box) { if (typeof Document.parseHTMLUnsafe !== 'function') unsupported('Document.parseHTMLUnsafe'); var d = Document.parseHTMLUnsafe(frameMarkup(id)); box.appendChild(fragWith(d.querySelector('iframe'))); };
CH['mech:domparser-appendChild-element'] = function (id, box) { box.appendChild(parsedFrame(id)); };
CH['mech:domparser-append-element'] = function (id, box) { box.append(parsedFrame(id)); };
CH['mech:domparser-fragment-appendChild'] = function (id, box) { box.appendChild(fragWith(parsedFrame(id))); };
CH['mech:domparser-fragment-append'] = function (id, box) { box.append(fragWith(parsedFrame(id))); };
CH['mech:domparser-fragment-prepend'] = function (id, box) { box.prepend(fragWith(parsedFrame(id))); };
CH['mech:domparser-fragment-replaceChildren'] = function (id, box) { box.replaceChildren(fragWith(parsedFrame(id))); };
CH['mech:domparser-fragment-insertBefore'] = function (id, box) { box.insertBefore(fragWith(parsedFrame(id)), null); };
CH['mech:domparser-fragment-replaceChild'] = function (id, box) { var old = document.createElement('i'); box.appendChild(old); box.replaceChild(fragWith(parsedFrame(id)), old); };
CH['mech:domparser-child-after'] = function (id, box) { box.after(parsedFrame(id)); };
CH['mech:domparser-child-before'] = function (id, box) { box.before(parsedFrame(id)); };
CH['mech:domparser-child-replaceWith'] = function (id, box) { var p = document.createElement('p'); box.appendChild(p); p.replaceWith(parsedFrame(id)); };
CH['mech:domparser-range-insertNode'] = function (id, box) { var r = document.createRange(); r.selectNodeContents(box); r.collapse(false); r.insertNode(parsedFrame(id)); };
CH['mech:domparser-moveBefore'] = function (id, box) { if (typeof box.moveBefore !== 'function') unsupported('Element.moveBefore'); box.moveBefore(parsedFrame(id), null); };
CH['mech:domparser-template-importNode'] = function (id, box) { var d = new DOMParser().parseFromString('<template>' + frameMarkup(id) + '</template>', 'text/html'); var t = d.querySelector('template'); box.appendChild(document.importNode(t.content, true)); };
CH['mech:implementation-createElement'] = function (id, box) { var doc = document.implementation.createHTMLDocument(''); box.appendChild(doc.createElement('iframe')); };
CH['mech:fencedframe-element'] = function (id, box) { var el = document.createElement('fencedframe'); el.setAttribute('src', u(id)); box.appendChild(el); };
CH['mech:object-element'] = function (id, box) { var el = document.createElement('object'); el.data = u(id); box.appendChild(el); };
CH['mech:embed-element'] = function (id, box) { var el = document.createElement('embed'); el.src = u(id); box.appendChild(el); };
CH['mech:frame-element'] = function (id, box) { var el = document.createElement('frame'); el.src = u(id); box.appendChild(el); };
CH['net:fetch-no-cors'] = function (id) { fetch(u(id), { mode: 'no-cors', keepalive: true }).catch(function () {}); };
CH['net:fetch-cors'] = function (id) { fetch(u(id)).catch(function () {}); };
CH['net:xhr'] = function (id) { var x = new XMLHttpRequest(); x.open('GET', u(id)); x.send(); };
CH['net:websocket'] = function (id) { new WebSocket(u(id).replace(/^http/, 'ws')); };
CH['net:eventsource'] = function (id) { new EventSource(u(id)); };
CH['net:sendBeacon'] = function (id) { navigator.sendBeacon(u(id), 'x'); };
CH['net:webtransport'] = function (id) { new WebTransport(CFG.channels[id].quic); };
CH['net:worker-blob'] = function (id) { var src = 'fetch(' + JSON.stringify(u(id)) + ').catch(function () {});'; new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); };
CH['net:shared-worker-blob'] = function (id) { var src = 'fetch(' + JSON.stringify(u(id)) + ').catch(function () {});'; new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); };
CH['net:service-worker'] = function (id) { navigator.serviceWorker.register('data:text/javascript,' + encodeURIComponent('fetch("' + u(id) + '")')).catch(function () {}); };
CH['net:dynamic-import'] = function (id) { import(u(id)).catch(function () {}); };
CH['net:script-element'] = function (id, box) { var s = document.createElement('script'); s.src = u(id); box.appendChild(s); };
CH['net:img-src'] = function (id) { var i = new Image(); i.src = u(id); };
CH['net:img-element'] = function (id, box) { var i = document.createElement('img'); i.src = u(id); box.appendChild(i); };
CH['net:img-srcset'] = function (id, box) { var i = document.createElement('img'); i.srcset = u(id) + ' 1x'; box.appendChild(i); };
CH['net:picture-source'] = function (id, box) { var p = document.createElement('picture'); var s = document.createElement('source'); s.srcset = u(id); p.appendChild(s); p.appendChild(document.createElement('img')); box.appendChild(p); };
CH['net:video-src'] = function (id, box) { var v = document.createElement('video'); v.src = u(id); box.appendChild(v); };
CH['net:audio-src'] = function (id, box) { var a = document.createElement('audio'); a.src = u(id); box.appendChild(a); };
CH['net:track'] = function (id, box) { var v = document.createElement('video'); var t = document.createElement('track'); t.src = u(id); v.appendChild(t); box.appendChild(v); };
CH['net:link-stylesheet'] = function (id, box) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = u(id); box.appendChild(l); };
CH['net:css-import'] = function (id, box) { var s = document.createElement('style'); s.textContent = '@import url("' + u(id) + '");'; box.appendChild(s); };
CH['net:css-font-face'] = function (id, box) { var s = document.createElement('style'); s.textContent = '@font-face { font-family: probe-' + id.length + '; src: url("' + u(id) + '"); }'; box.appendChild(s); var d = document.createElement('div'); d.style.fontFamily = 'probe-' + id.length; d.textContent = 'probe'; box.appendChild(d); };
CH['net:css-background-image'] = function (id, box) { var d = document.createElement('div'); d.style.backgroundImage = 'url("' + u(id) + '")'; box.appendChild(d); };
CH['net:svg-image'] = function (id, box) { box.insertAdjacentHTML('beforeend', '<svg width="2" height="2"><image href="' + u(id) + '" width="2" height="2"></image></svg>'); };
CH['net:svg-use'] = function (id, box) { box.insertAdjacentHTML('beforeend', '<svg width="2" height="2"><use href="' + u(id) + '#probe"></use></svg>'); };
function linkOf(rel, id, box, extra) { var l = document.createElement('link'); l.rel = rel; l.href = u(id); if (extra) extra(l); box.appendChild(l); }
CH['net:link-preload'] = function (id, box) { linkOf('preload', id, box, function (l) { l.as = 'fetch'; l.crossOrigin = 'anonymous'; }); };
CH['net:link-prefetch'] = function (id, box) { linkOf('prefetch', id, box); };
CH['net:link-preconnect'] = function (id, box) { linkOf('preconnect', id, box, function (l) { l.crossOrigin = 'anonymous'; }); };
CH['net:link-dns-prefetch'] = function (id, box) { linkOf('dns-prefetch', id, box); };
CH['net:link-modulepreload'] = function (id, box) { linkOf('modulepreload', id, box); };
CH['net:link-icon'] = function (id, box) { linkOf('icon', id, box); };
CH['net:base-href'] = function (id, box) { var b = document.createElement('base'); b.href = u(id); document.head.appendChild(b); var i = document.createElement('img'); i.src = 'probe-relative.png'; box.appendChild(i); };
CH['net:input-image'] = function (id, box) { var i = document.createElement('input'); i.type = 'image'; i.src = u(id); box.appendChild(i); };
CH['net:speculation-prefetch'] = function (id, box) { var s = document.createElement('script'); s.type = 'speculationrules'; s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: [u(id)] }] }); box.appendChild(s); };
CH['net:speculation-prerender'] = function (id, box) { var s = document.createElement('script'); s.type = 'speculationrules'; s.textContent = JSON.stringify({ prerender: [{ source: 'list', urls: [u(id)] }] }); box.appendChild(s); };
CH['net:fetchLater'] = function (id) { if (typeof fetchLater !== 'function') unsupported('fetchLater'); fetchLater(u(id), { activateAfter: 0 }); };
CH['nav:location.href'] = function (id) { setTimeout(function () { location.href = u(id); }, 200); };
CH['nav:location.replace'] = function (id) { setTimeout(function () { location.replace(u(id)); }, 200); };
CH['nav:meta-refresh'] = function (id) { var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + u(id); document.head.appendChild(m); };
CH['nav:anchor-click'] = function (id, box) { var a = document.createElement('a'); a.href = u(id); a.textContent = 'x'; a.addEventListener('click', function (e) { e.stopPropagation(); }); box.appendChild(a); setTimeout(function () { a.click(); }, 200); };
CH['nav:area-click'] = function (id, box) { box.innerHTML = '<map name="probe"><area shape="default" href="' + u(id) + '"></map><img usemap="#probe" width="2" height="2">'; var area = box.querySelector('area'); area.addEventListener('click', function (e) { e.stopPropagation(); }); setTimeout(function () { area.click(); }, 200); };
CH['nav:anchor-ping'] = function (id, box) { var a = document.createElement('a'); a.href = '#probe'; a.ping = u(id); a.addEventListener('click', function (e) { e.stopPropagation(); }); box.appendChild(a); setTimeout(function () { a.click(); }, 200); };
CH['nav:anchor-ping-contained'] = function (id, box) { var a = document.createElement('a'); a.href = '#probe'; a.ping = u(id); box.appendChild(a); setTimeout(function () { a.click(); }, 200); };
CH['nav:window-open'] = function (id) { window.open(u(id), '_blank', 'noopener'); };
CH['nav:top-location'] = function (id) { setTimeout(function () { top.location.href = u(id); }, 200); };
CH['nav:parent-location'] = function (id) { setTimeout(function () { parent.location.href = u(id); }, 200); };
CH['nav:form-submit'] = function (id, box) { var f = document.createElement('form'); f.method = 'post'; f.action = u(id); box.appendChild(f); setTimeout(function () { f.submit(); }, 200); };
CH['nav:form-requestSubmit'] = function (id, box) { var f = document.createElement('form'); f.method = 'post'; f.action = u(id); box.appendChild(f); setTimeout(function () { f.requestSubmit(); }, 200); };
CH['nav:case-f4-javascript-url'] = function (id) { setTimeout(function () { location.href = 'javascript:' + JSON.stringify(nestedHtml(id)); }, 200); };
CH['write:markup'] = function () {};
CH['write:coerced'] = function () {};
CH['write:writeln-coerced'] = function () {};
`;

const LOOP_JS = `
for (var i = 0; i < CFG.order.length; i++) {
  var id = CFG.order[i];
  var box = document.createElement('div');
  document.body.appendChild(box);
  var result = { id: id, outcome: 'started', error: null };
  if (typeof CH[id] !== 'function') {
    result.outcome = 'missing';
  } else {
    try { CH[id](id, box); } catch (e) { result.outcome = 'threw'; result.error = String((e && e.message) || e); }
  }
  post({ type: 'probe:result', result: result });
}
if (CFG.mode === 'nav') { post({ type: 'probe:done' }); }
else { setTimeout(function () { post({ type: 'probe:done' }); }, 3000); }
`;

/** Parse-time writes: the sanitiser sees the markup, the coerced call does not. */
const WRITE_JS = `
document.write(frameMarkup('write:markup'));
post({ type: 'probe:result', result: { id: 'write:markup', outcome: 'started', error: null } });
document.write(coerced(frameMarkup('write:coerced')));
post({ type: 'probe:result', result: { id: 'write:coerced', outcome: 'started', error: null } });
document.writeln(coerced(frameMarkup('write:writeln-coerced')));
post({ type: 'probe:result', result: { id: 'write:writeln-coerced', outcome: 'started', error: null } });
document.write('<ifr');
document.write('ame srcdoc="' + esc(nestedHtml('write:case-f3-split-calls')) + '"></ifr');
document.write('ame>');
post({ type: 'probe:result', result: { id: 'write:case-f3-split-calls', outcome: 'started', error: null } });
setTimeout(function () { post({ type: 'probe:done' }); }, 3000);
`;

type RelicMode = 'main' | 'write' | 'nav' | 'static';

interface Channel {
  readonly id: string;
  readonly url: string;
  readonly stun: string;
  readonly quic: string;
}

interface ChannelCounter {
  tcpOpens: number;
  tcpData: number;
  udpPackets: number;
}

interface Relic {
  readonly key: string;
  readonly mode: RelicMode;
  readonly ids: readonly string[];
  readonly url: string;
}

interface Variant {
  readonly name: string;
  readonly relic: string;
  readonly isolation: boolean;
  readonly harnessPolicy: boolean;
  readonly shim: 'production' | 'throwaway' | 'open';
  readonly negative: boolean;
  readonly positive?: boolean;
}

interface ProbeResult {
  readonly id: string;
  readonly outcome: string;
  readonly error: string | null;
}

interface NestedResult {
  readonly id: string;
  readonly created: boolean;
  readonly rtcType: string;
  readonly error: string | null;
}

interface Capture {
  readonly results: readonly ProbeResult[];
  readonly nested: readonly NestedResult[];
  readonly done: boolean;
}

interface Verdict {
  readonly name: string;
  readonly relic: string;
  readonly ids: readonly string[];
  readonly isolated: boolean;
  readonly positive: boolean;
  readonly negative: boolean;
  readonly ok: boolean;
  readonly egress: readonly string[];
  readonly reasons: readonly string[];
  readonly results: ReadonlyMap<string, ProbeResult>;
  readonly nested: readonly NestedResult[];
  readonly counts: ReadonlyMap<string, ChannelCounter>;
  readonly version: string;
}

/** The part of the app the probe calls. */
interface AppLike {
  fetch(request: Request): Promise<Response>;
}

const counters = new Map<string, ChannelCounter>();
const listeners: Array<{ stop(): void }> = [];
const channels = new Map<string, Channel>();
let shimMode: 'production' | 'throwaway' | 'open' = 'production';

const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'relic-frame-egress-')
);
const statePath = join(scratch, 'state.json');

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      const family = info.family as unknown;
      const isV4 = family === 'IPv4' || family === 4;
      if (isV4 && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}
const lan = lanAddress();

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
  socket.bind(0, '0.0.0.0', () => {
    const { port } = socket.address();
    resolve({ port, stop: () => socket.close() });
  });
  return promise;
}

async function allocateChannel(id: string): Promise<void> {
  const counter: ChannelCounter = { tcpOpens: 0, tcpData: 0, udpPackets: 0 };
  counters.set(id, counter);
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
  channels.set(id, {
    id,
    url: `http://127.0.0.1:${tcp.port}/${encodeURIComponent(id)}`,
    stun: `stun:${lan}:${udp.port}`,
    quic: `https://127.0.0.1:${udp.port}/wt`,
  });
}

function counterFor(id: string): ChannelCounter {
  const counter = counters.get(id);
  assert.ok(counter !== undefined, `no listener allocated for ${id}`);
  return counter;
}

function resetCounters(ids: readonly string[]): void {
  for (const id of ids) {
    const counter = counterFor(id);
    counter.tcpOpens = 0;
    counter.tcpData = 0;
    counter.udpPackets = 0;
  }
}

function arrived(id: string): boolean {
  const counter = counterFor(id);
  return counter.tcpOpens + counter.tcpData + counter.udpPackets > 0;
}

function relicHtml(mode: RelicMode, ids: readonly string[]): string {
  if (mode === 'static') return staticMarkups.get(ids[0] ?? '') ?? '';
  const config = {
    mode,
    order: ids,
    channels: Object.fromEntries(ids.map((id) => [id, channels.get(id)])),
  };
  const json = JSON.stringify(config).split('<').join('\\u003c');
  const body = mode === 'write' ? WRITE_JS : CHANNELS_JS + LOOP_JS;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Frame egress probe</title></head><body><script>var CFG = ${json};${HELPERS_JS}${body}</script></body></html>`;
}

// --- Loopback servers. One app serves both origins, as production routes by host.
const store = new MemoryStore();
let mcpHandler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!mcpHandler) return new Response('Not ready', { status: 503 });
    return mcpHandler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

let app: AppLike | undefined;
const usercontent = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!app) return new Response('Not ready', { status: 503 });
    const url = new URL(request.url);
    if (shimMode === 'open' && url.pathname === '/sandbox.html') {
      // Positive control: no policy at all, so only the channel's own behaviour is
      // measured. The sandbox attribute on the frame still applies.
      return new Response(THROWAWAY_SHIM, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (shimMode === 'throwaway' && url.pathname === '/sandbox.html') {
      // Only the production CSP is copied. Copying every header would carry the
      // production content-length onto a shorter body, and the browser would
      // truncate the throwaway script before it could run.
      const production = await app.fetch(request);
      return new Response(THROWAWAY_SHIM, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': (
            production.headers.get('content-security-policy') ?? ''
          ).replace(/script-src '[^']+'/, `script-src '${THROWAWAY_HASH}'`),
        },
      });
    }
    return app.fetch(request);
  },
});
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
const liveApp: AppLike = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store,
  storage,
  assets: diskAssets(viewerDist),
});
app = liveApp;
mcpHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
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
  return liveApp.fetch(request);
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
      RELIC_CLIENT_NAME: 'relic-mcp/frame-egress-path',
      RELIC_CHROME_PATH: 'none',
      RELIC_OTIO_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
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
    .filter((line) => line.trim().length > 0);
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

// --- Channels and relics.
const STATIC_IDS = [
  'static:case-f2a-splice',
  'static:case-f2b-stray-quote',
] as const;
const staticMarkups = new Map<string, string>();
const allIds = [...MAIN_IDS, ...WRITE_IDS, ...NAV_IDS, ...STATIC_IDS];
for (const id of allIds) await allocateChannel(id);
// Static cases: the relic's content is the markup itself, with no runner of the
// probe's own, so the first render is the only code path. The nested frame's
// script is the only code that runs, and it reports to the top window.
function nestedScriptFor(id: string): string {
  const c = channels.get(id);
  assert.ok(c !== undefined, `no channel for ${id}`);
  const js = [
    '(function () {',
    '  var out = { id: ' +
      JSON.stringify(id) +
      ', created: false, error: null, rtcType: typeof RTCPeerConnection };',
    '  try {',
    '    var pc = new RTCPeerConnection({ iceServers: [{ urls: ' +
      JSON.stringify(c.stun) +
      ' }] });',
    '    pc.createDataChannel("probe");',
    '    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});',
    '    out.created = true;',
    '  } catch (e) { out.error = String(e); }',
    '  try { top.postMessage({ type: "probe:nested", nested: out }, "*"); } catch (e) {}',
    '})();',
  ].join('\n');
  return '<scr' + 'ipt>' + js + '</scr' + 'ipt>';
}
function staticMarkup(id: string): string {
  const attr = nestedScriptFor(id)
    .split('&')
    .join('&amp;')
    .split('"')
    .join('&quot;');
  if (id === 'static:case-f2a-splice')
    return `<i<iframe>frame srcdoc="${attr}">`;
  if (id === 'static:case-f2b-stray-quote')
    return `<iframe name=a'b srcdoc="${attr}"></iframe>`;
  throw new Error(`no static markup for ${id}`);
}
for (const id of STATIC_IDS) staticMarkups.set(id, staticMarkup(id));
const staticRelics = new Map<string, Relic>();
for (const id of STATIC_IDS)
  staticRelics.set(id, await publishRelic(id, 'static', [id]));

async function publishRelic(
  key: string,
  mode: RelicMode,
  ids: readonly string[]
): Promise<Relic> {
  const path = join(scratch, `${key.replace(/[^a-z0-9]+/gi, '-')}.html`);
  await writeFile(path, relicHtml(mode, ids));
  const published = await callMcp('relic_publish', {
    path,
    title: `Frame egress probe ${key}`,
    cover: false,
  });
  const url = String(published['url'] ?? published['link'] ?? '');
  assert.ok(url.includes('#'), `publish returned no keyed link for ${key}`);
  return { key, mode, ids, url };
}

const mainRelic = await publishRelic('main', 'main', MAIN_IDS);
const writeRelic = await publishRelic('write', 'write', WRITE_IDS);
const navRelics = new Map<string, Relic>();
for (const id of NAV_IDS) {
  navRelics.set(id, await publishRelic(id, 'nav', [id]));
}

// --- Browser: one isolated headless shell per variant, throwaway profile.
const CAPTURE_EXPRESSION = 'JSON.stringify(window.__egressCapture || null)';

async function openAndCapture(
  relic: Relic,
  variant: Variant
): Promise<{ capture: Capture | null; version: string }> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-frame-egress-chrome-'));
  // The proxy from chromeArgs is dropped. Every probe target is a loopback or
  // LAN address, and a request sent to the dead proxy never reaches its
  // listener, so it would read as blocked. DNS names still resolve to nothing.
  const shared = chromeArgs(chromeExecutable, profile).filter(
    (argument) =>
      !argument.startsWith('--proxy-') &&
      (variant.harnessPolicy ||
        !argument.startsWith('--webrtc-ip-handling-policy'))
  );
  assert.equal(
    shared.pop(),
    'about:blank',
    'chromeArgs must end with about:blank'
  );
  const processModel = variant.isolation
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
      { url: relic.url },
      sessionId
    );
    if (navigated['errorText'] !== undefined) {
      loaded.catch(() => {});
      throw new Error(`navigation failed: ${String(navigated['errorText'])}`);
    }
    await loaded;

    const read = async (): Promise<Capture | null> => {
      const evaluated = (await connection.send(
        'Runtime.evaluate',
        { expression: CAPTURE_EXPRESSION, returnByValue: true },
        sessionId
      )) as { result?: { value?: string } };
      const value = evaluated.result?.value;
      return value === undefined || value === 'null'
        ? null
        : (JSON.parse(value) as Capture);
    };

    const deadline = Date.now() + (relic.mode === 'static' ? 4_000 : 60_000);
    let capture = await read();
    while ((capture === null || !capture.done) && Date.now() < deadline) {
      await sleep(200);
      capture = await read();
    }
    // Arrivals are counted outside the page; let late ones land before reading.
    await sleep(relic.mode === 'nav' ? 2500 : 1500);
    capture = await read();
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

// --- Variants.
const variants: Variant[] = [
  ...STATIC_IDS.flatMap((id) => [
    {
      name: `${id} · default process model`,
      relic: id,
      isolation: false,
      harnessPolicy: false,
      shim: 'production' as const,
      negative: false,
    },
    {
      name: `${id} · site-per-process + IsolateSandboxedIframes`,
      relic: id,
      isolation: true,
      harnessPolicy: false,
      shim: 'production' as const,
      negative: false,
    },
    {
      name: `POSITIVE CONTROL · no CSP, no containment · ${id}`,
      relic: id,
      isolation: false,
      harnessPolicy: false,
      shim: 'open' as const,
      negative: false,
      positive: true,
    },
  ]),
  {
    name: 'main · default WebRTC policy · default process model',
    relic: 'main',
    isolation: false,
    harnessPolicy: false,
    shim: 'production',
    negative: false,
  },
  {
    name: 'main · default WebRTC policy · site-per-process + IsolateSandboxedIframes',
    relic: 'main',
    isolation: true,
    harnessPolicy: false,
    shim: 'production',
    negative: false,
  },
  {
    name: 'main · harness WebRTC policy (masks non-proxied UDP) · default process model',
    relic: 'main',
    isolation: false,
    harnessPolicy: true,
    shim: 'production',
    negative: false,
  },
  {
    name: 'write · default WebRTC policy · default process model',
    relic: 'write',
    isolation: false,
    harnessPolicy: false,
    shim: 'production',
    negative: false,
  },
  {
    name: 'write · default WebRTC policy · site-per-process + IsolateSandboxedIframes',
    relic: 'write',
    isolation: true,
    harnessPolicy: false,
    shim: 'production',
    negative: false,
  },
  ...NAV_IDS.flatMap((id) => [
    {
      name: `${id} · default process model`,
      relic: id,
      isolation: false,
      harnessPolicy: false,
      shim: 'production' as const,
      negative: false,
    },
    {
      name: `${id} · site-per-process + IsolateSandboxedIframes`,
      relic: id,
      isolation: true,
      harnessPolicy: false,
      shim: 'production' as const,
      negative: false,
    },
  ]),
  {
    name: 'NEGATIVE CONTROL · throwaway shim without containment, production CSP',
    relic: 'main',
    isolation: false,
    harnessPolicy: false,
    shim: 'throwaway',
    negative: true,
  },
  // Positive controls run after the production runs. Each one lifts the CSP and
  // the containment and nothing else, so an arrival shows the listener can see the
  // channel. A silent production channel counts as blocked only if its control
  // arrived. The sandbox attribute stays on, so navigation controls are limited to
  // what the frame itself may do.
  {
    name: 'POSITIVE CONTROL · no CSP, no containment · main relic',
    relic: 'main',
    isolation: false,
    harnessPolicy: false,
    shim: 'open',
    negative: false,
    positive: true,
  },
  {
    name: 'POSITIVE CONTROL · no CSP, no containment · write relic',
    relic: 'write',
    isolation: false,
    harnessPolicy: false,
    shim: 'open',
    negative: false,
    positive: true,
  },
  ...NAV_IDS.map((id) => ({
    name: `POSITIVE CONTROL · no CSP, no containment · ${id}`,
    relic: id,
    isolation: false,
    harnessPolicy: false,
    shim: 'open' as const,
    negative: false,
    positive: true,
  })),
];

/** The negative control must see these reach the network... */
const NEGATIVE_REQUIRED_EGRESS = ['rtc:shim-realm'] as const;
/** ...and must not see these, because CSP, not containment, stops them. */
const NEGATIVE_CSP_BLOCKED = [
  'net:fetch-no-cors',
  'net:xhr',
  'net:websocket',
  'net:img-src',
  'net:script-element',
] as const;

function relicFor(key: string): Relic {
  const found =
    key === 'main'
      ? mainRelic
      : key === 'write'
        ? writeRelic
        : (navRelics.get(key) ?? staticRelics.get(key));
  assert.ok(found !== undefined, `no relic for ${key}`);
  return found;
}

const verdicts: Verdict[] = [];
const observable = new Set<string>();

// The served shim's response must name no reporting endpoint. A CSP violation
// report or a network error report goes only to an endpoint some response
// names, so when none is named, nothing from the frame is sent to one.
const shimResponse = await fetch(`${usercontentOrigin}/sandbox.html`);
const shimDirectives = (
  shimResponse.headers.get('content-security-policy') ?? ''
)
  .split(';')
  .map((directive) => directive.trim().split(/\s+/)[0] ?? '');
await shimResponse.text();
const reportingFindings = [
  ...['reporting-endpoints', 'report-to', 'nel']
    .filter((name) => shimResponse.headers.has(name))
    .map((name) => `${name} header`),
  ...['report-to', 'report-uri']
    .filter((name) => shimDirectives.includes(name))
    .map((name) => `CSP ${name} directive`),
];

for (const variant of variants) {
  const relic = relicFor(variant.relic);
  resetCounters(relic.ids);
  shimMode = variant.shim;
  const { capture, version } = await openAndCapture(relic, variant);
  shimMode = 'production';

  const reasons: string[] = [];
  const results = new Map<string, ProbeResult>();
  let nested: readonly NestedResult[] = [];
  if (capture === null) {
    reasons.push('top document was replaced or the capture was lost');
  } else {
    for (const result of capture.results) results.set(result.id, result);
    nested = capture.nested;
    if (!capture.done && relic.mode !== 'static')
      reasons.push('probe never finished');
  }
  const missing =
    relic.mode === 'static' ? [] : relic.ids.filter((id) => !results.has(id));
  if (missing.length > 0) reasons.push(`no result for ${missing.join(', ')}`);
  for (const result of results.values()) {
    if (result.outcome === 'missing') {
      reasons.push(`runner has no channel ${result.id}`);
    }
  }

  const egress = relic.ids.filter((id) => arrived(id));
  if (variant.positive === true) {
    // A control. An arrival shows the listener can see the channel, which is what
    // lets a silent production run count as blocked. It is never a failure.
    for (const id of egress) observable.add(id);
  } else if (variant.negative) {
    for (const id of NEGATIVE_REQUIRED_EGRESS) {
      if (!egress.includes(id)) {
        reasons.push(`negative control did not detect egress on ${id}`);
      }
    }
    for (const id of NEGATIVE_CSP_BLOCKED) {
      if (egress.includes(id)) {
        reasons.push(`CSP-blocked channel reached the network: ${id}`);
      }
    }
  } else {
    for (const id of egress) {
      if (!(id in KNOWN_EGRESS)) reasons.push(`unexpected egress: ${id}`);
    }
    for (const id of Object.keys(KNOWN_EGRESS)) {
      if (relic.ids.includes(id) && !egress.includes(id)) {
        reasons.push(`known egress no longer observed: ${id}`);
      }
    }
  }
  const snapshot = new Map<string, ChannelCounter>(
    relic.ids.map((id): [string, ChannelCounter] => [id, { ...counterFor(id) }])
  );
  verdicts.push({
    name: variant.name,
    relic: variant.relic,
    ids: relic.ids,
    isolated: variant.isolation,
    positive: variant.positive === true,
    negative: variant.negative,
    ok: variant.positive === true || reasons.length === 0,
    egress,
    reasons,
    results,
    nested,
    counts: snapshot,
    version,
  });
}

// --- Report.
const first = verdicts[0];
assert.ok(first !== undefined, 'no variants ran');
console.log(`chrome: ${first.version} (${chromeExecutable})`);
console.log(`STUN address: ${lan}`);
console.log(
  `reporting on the served shim: ${reportingFindings.length === 0 ? 'none' : reportingFindings.join('; ')}`
);

/** A channel is unproven when no positive control could see it, or the build lacks it. */
function unprovenReason(
  id: string,
  result: ProbeResult | undefined
): string | undefined {
  if (result?.outcome === 'threw' && result.error?.startsWith('unsupported:')) {
    return `not available in this build (${result.error})`;
  }
  const fixed = LISTENER_UNOBSERVABLE[id];
  if (fixed !== undefined) return fixed;
  if (!observable.has(id)) {
    return 'no positive control reached a listener, so this build does not let one see it';
  }
  return undefined;
}

const productionRuns = verdicts.filter((v) => !v.positive && !v.negative);
const unproven: string[] = [];
console.log(
  '\nper-channel results (production runs; blocked only where a positive control could see the channel):'
);
for (const id of [...MAIN_IDS, ...WRITE_IDS, ...NAV_IDS]) {
  const runs = productionRuns.filter((v) => v.ids.includes(id));
  const egressed = runs.some((v) => v.egress.includes(id));
  const run = runs.find((v) => !v.isolated) ?? runs[0];
  const result = run?.results.get(id);
  const counter = run?.counts.get(id);
  const reason = egressed ? undefined : unprovenReason(id, result);
  if (reason !== undefined) unproven.push(id);
  const state = egressed
    ? 'EGRESS   '
    : reason !== undefined
      ? 'UNPROVEN '
      : 'blocked  ';
  const outcome = result?.outcome ?? 'no result';
  const error = result?.error ? ` (${result.error})` : '';
  console.log(
    `  ${state}${id}  ${outcome}${error}  tcp=${counter?.tcpOpens ?? 0}/${counter?.tcpData ?? 0} udp=${counter?.udpPackets ?? 0}  observable=${observable.has(id) ? 'yes' : 'no'}${reason === undefined ? '' : `  [${reason}]`}`
  );
}
const nestedSeen = first.nested
  .map((n) => `${n.id} created=${n.created} rtc=${n.rtcType}`)
  .join('; ');
if (nestedSeen.length > 0) console.log(`  nested frames: ${nestedSeen}`);

console.log('\nvariants:');
for (const verdict of verdicts) {
  const egressList =
    verdict.egress.length === 0 ? 'none' : verdict.egress.join(', ');
  const label = verdict.positive ? 'CONTROL' : verdict.ok ? 'PASS' : 'FAIL';
  console.log(`[${label}] ${verdict.name}`);
  console.log(`       egress: ${egressList}`);
  for (const reason of verdict.reasons) console.log(`       reason: ${reason}`);
}

// One CASE line per regression case: a relic attempts one route to a nested realm
// and then opens WebRTC toward the case's own listener. REAL means production
// egress was observed. NOT REAL means the no-policy control reached the listener
// and production did not. CANNOT TEST means the control did not reach it either.
const CASE_IDS = [...MAIN_IDS, ...WRITE_IDS, ...NAV_IDS, ...STATIC_IDS].filter(
  (id) => id.includes(':case-')
);
console.log('\ncases:');
for (const id of CASE_IDS) {
  const runs = productionRuns.filter((v) => v.ids.includes(id));
  const modelState = (isolated: boolean): string => {
    const match = runs.find((v) => v.isolated === isolated);
    if (match === undefined) return 'not run';
    return match.egress.includes(id) ? 'EGRESS' : 'none';
  };
  const egressed = runs.some((v) => v.egress.includes(id));
  const positive = observable.has(id);
  const first = runs.find((v) => !v.isolated) ?? runs[0];
  const error = first?.results.get(id)?.error ?? '-';
  const nested = (first?.nested ?? [])
    .filter((n) => n.id === id)
    .map((n) => `created=${n.created} rtc=${n.rtcType}`)
    .join('; ');
  const verdictText = egressed
    ? 'REAL (egress observed)'
    : positive
      ? 'NOT REAL (blocked: the no-policy control reached the listener and production did not)'
      : 'CANNOT TEST (the no-policy control did not reach the listener in this build)';
  console.log(
    `  ${id}\n    default=${modelState(false)} site-per-process=${modelState(true)} positive=${positive ? 'observed' : 'not observed'} nested=[${nested || '-'}] error=${error}\n    => ${verdictText}`
  );
}
const failed = verdicts.filter((verdict) => !verdict.ok);
const reportingFailed = reportingFindings.length > 0;
if (failed.length === 0 && !reportingFailed && unproven.length === 0) {
  console.log('\nFRAME_EGRESS_PATH_OK');
} else if (failed.length === 0 && !reportingFailed) {
  console.log(
    `\nNo egress observed. UNPROVEN, not observable by this harness and not counted as blocked: ${unproven.join(', ')}`
  );
  console.log('FRAME_EGRESS_PATH_OK_WITH_UNPROVEN');
} else {
  console.log(
    `\nFRAME_EGRESS_PATH_FAILED: ${failed.length} variant(s)${reportingFailed ? '; reporting configured on the served shim' : ''}`
  );
}

for (const listener of listeners) listener.stop();
service.stop(true);
usercontent.stop(true);
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length === 0 && !reportingFailed ? 0 : 1);
