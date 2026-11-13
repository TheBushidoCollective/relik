/**
 * Owned headless viewer for the rendered-program proofs. It attaches to Chrome over a debug pipe,
 * attests headless mode, sets the reader session cookie, and reads the viewer through the agreed
 * contract only: the state attributes on `.otio-view` and `window.__relicOtioPlayback`.
 * Nothing here scrapes markup or falls back when a name is absent; a missing name rejects.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

/** The viewer contract, as agreed with ProgramViewer. */
export const VIEWER_CONTRACT = {
  stateAttribute: 'data-otio-program-state',
  reasonAttribute: 'data-otio-program-reason',
  hook: '__relicOtioPlayback',
} as const;

/** The primer's state attribute on `.otio-view`. */
export const PRIMER_ATTRIBUTE = 'data-otio-audio-output';
/** Hidden leg: how long to wait for the viewer to read hidden, then how long it must stay hidden. */
const HIDE_VISIBLE_WAIT_MS = 1500;
const HIDE_SETTLE_MS = 1500;
const HIDE_POLL_MS = 50;

/** One timestamped entry from the hidden leg. Times are page-clock milliseconds. */
export interface HideEvent {
  readonly at: number;
  readonly kind: string;
  readonly value: string | null;
}

export interface HideLog {
  readonly visibility: string;
  readonly events: readonly HideEvent[];
}

/**
 * Installed before the freeze. Logs visibility changes, lifecycle freeze and resume, and every
 * change of the primer attribute. A frozen page cannot run its own listeners, so an entry logged
 * after resume shows what was delivered late, and the verdict uses those times as they are.
 */
const HIDE_INSTALL = `(() => {
  const log = [];
  window.__hideLog = log;
  const view = document.querySelector('.otio-view');
  if (!view) throw new Error('hideViewer: viewer missing');
  const attr = ${JSON.stringify(PRIMER_ATTRIBUTE)};
  const record = (kind, value) => log.push({ at: performance.now(), kind: kind, value: value });
  document.addEventListener('visibilitychange', () => record('visibilitychange', document.visibilityState));
  window.addEventListener('freeze', () => record('freeze', null));
  window.addEventListener('resume', () => record('resume', null));
  new MutationObserver(() => record('primer', view.getAttribute(attr))).observe(view, { attributes: true, attributeFilter: [attr] });
  record('primer', view.getAttribute(attr));
})()`;

/** Default Chrome trace categories for the viewer proofs. */
export const DEFAULT_TRACE_CATEGORIES =
  'devtools.timeline,disabled-by-default-devtools.timeline.frame,media,audio,gpu,viz,disabled-by-default-media,disabled-by-default-viz.debug';
/** The only extra Chrome switch the primer proof may add. Chrome's --mute-audio always stays. */
export const PRIMER_IMMEDIATE_PAUSE_ARG =
  '--enable-features=AudioRendererMixerImmediatePause' as const;
export type PrimerChromeArg = typeof PRIMER_IMMEDIATE_PAUSE_ARG;

export type ViewerState = 'program' | 'focus-track' | 'legacy' | 'unavailable';

export interface ViewerSnapshot {
  readonly mode: ViewerState;
  readonly reason: string | null;
  readonly timelineTimeSeconds: number | null;
  readonly mediaTimeSeconds: number | null;
  readonly playing: boolean;
}

export interface ViewerPage {
  evaluate<T>(expression: string): Promise<T>;
  /** Polls until the reader returns a value, or throws after the timeout. */
  waitFor<T>(
    description: string,
    read: () => Promise<T | undefined>,
    timeoutMs?: number
  ): Promise<T>;
  snapshot(): Promise<ViewerSnapshot>;
  /** A trusted pointer click at the centre of the first element matching the selector. */
  click(selector: string): Promise<void>;
  /** Reopen only this proof-owned page at its original keyed URL. */
  reopen(): Promise<void>;
  startPerformanceTrace(categories?: string): Promise<unknown>;
  /**
   * Hides this viewer by minimizing its own proof-owned browser window over CDP, then reads its
   * visibility and the timestamped log. The window is restored to normal afterward. Tab
   * activation was probed and does not hide the page; this mechanism does.
   */
  hideViewer(): Promise<HideLog>;
  stopPerformanceTrace(): Promise<{
    metrics: unknown;
    events: unknown[];
    truncated: boolean;
    dataLossOccurred: boolean | null;
  }>;
  close(): Promise<void>;
}

export interface OpenViewerOptions {
  readonly url: string;
  readonly origin: string;
  readonly sessionToken: string;
  /** Only for a separately built test-only viewer graph with the emit recorder. */
  readonly instrumentEmits?: boolean;
  /** Extra Chrome switches. Only the primer wrap check may name one. */
  readonly extraArgs?: readonly PrimerChromeArg[];
  /**
   * Runs after the page target exists and before its navigation. The primer proof starts its
   * trace and reads the output here. Throwing closes the owned browser and rethrows.
   */
  readonly beforeNavigate?: (page: ViewerPage) => Promise<void>;
}

export async function openViewer(
  options: OpenViewerOptions
): Promise<ViewerPage> {
  const requested = process.env['RELIC_OTIO_CHROME_PATH'];
  if (!requested)
    throw new Error(
      'RELIC_OTIO_CHROME_PATH must name the owned chrome-headless-shell; the proof never falls back to an installed Chrome'
    );
  const found = await discoverChrome(requested);
  assert.equal(found.kind, 'found', 'no Chrome for the viewer proof');
  if (found.kind !== 'found') throw new Error('unreachable');
  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-viewer-'));
  // chromeArgs routes even loopback through a deliberately dead proxy. This
  // proof needs only its own 127.0.0.1 service, matching otio-path.ts; every
  // other host remains denied. Do not use the user's browser or profile.
  const shared = chromeArgs(found.path, profile);
  assert.deepEqual(
    shared.filter(
      (arg) =>
        arg.startsWith('--proxy-bypass-list=') ||
        arg.startsWith('--host-resolver-rules=')
    ),
    [
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-bypass-list=<-loopback>',
    ],
    'Chrome network isolation flags changed; re-evaluate the loopback exception'
  );
  const launch = createBrowserHeadlessLaunch(
    [...shared, ...(options.extraArgs ?? [])].map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    ),
    profile
  );
  const child: ChildProcess = spawn(found.path, [...launch.args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  assert.ok(toChrome && fromChrome, 'Chrome debug pipes are missing');
  const cdp: CdpConnection = connectPipe(
    toChrome as NodeJS.WritableStream,
    fromChrome as NodeJS.ReadableStream
  );
  await attestBrowserHeadless(cdp, launch);
  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as {
    targetId: string;
  };
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  if (options.instrumentEmits) {
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: 'window.__relicProofEmits = [];',
      },
      sessionId
    );
  }
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  const diagnosticEvents: string[] = [];
  const fragment = new URL(options.url).hash;
  const redact = (value: string) =>
    fragment ? value.replaceAll(fragment, '#[redacted]') : value;
  const recordDiagnostic = (value: string) => {
    if (diagnosticEvents.length < 30)
      diagnosticEvents.push(redact(value).slice(0, 500));
  };
  const removeDiagnostics = cdp.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === 'Network.loadingFailed')
      recordDiagnostic(
        `network failure: ${String(event.params['errorText'] ?? 'unknown')}`
      );
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params['exceptionDetails'] as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      recordDiagnostic(
        `runtime exception: ${details?.exception?.description ?? details?.text ?? 'unknown'}`
      );
    }
    if (
      event.method === 'Runtime.consoleAPICalled' &&
      event.params['type'] === 'error'
    ) {
      const args = event.params['args'] as
        | Array<{ value?: unknown; description?: string }>
        | undefined;
      recordDiagnostic(
        `console error: ${args?.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ') ?? ''}`
      );
    }
  });
  await cdp.send(
    'Network.setCookie',
    {
      name: 'relic_session',
      value: options.sessionToken,
      url: options.origin,
      httpOnly: true,
      path: '/',
    },
    sessionId
  );

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = (await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    )) as { result: { value?: T }; exceptionDetails?: unknown };
    assert.equal(
      response.exceptionDetails,
      undefined,
      `viewer evaluation threw: ${JSON.stringify(response.exceptionDetails)}`
    );
    return response.result.value as T;
  };

  const waitFor = async <T>(
    description: string,
    read: () => Promise<T | undefined>,
    timeoutMs = 20_000
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) {
        // Never log location.hash: it contains the relic key.
        const state = await evaluate<unknown>(
          `({path: location.pathname, readyState: document.readyState, title: document.title, body: document.body?.innerText?.slice(0, 1200), otioView: !!document.querySelector('.otio-view'), hook: typeof window.${VIEWER_CONTRACT.hook}})`
        ).catch((error: unknown) => ({ diagnosticError: String(error) }));
        throw new Error(
          `timed out waiting for ${description}; page=${redact(JSON.stringify(state))}; events=${JSON.stringify(diagnosticEvents)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const traceEvents: unknown[] = [];
  let traceTruncated = false;
  let tracing = false;
  // Preserve numeric media/clock counters without copying URLs, keys, titles or
  // arbitrary strings from trace arguments into the proof transcript.
  const numericTraceArgs = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value;
    if (!value || typeof value !== 'object' || depth >= 3) return undefined;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 24)) {
      const kept = numericTraceArgs(child, depth + 1);
      if (kept !== undefined) output[key.slice(0, 80)] = kept;
    }
    return output;
  };
  const removeTrace = cdp.onEvent((event) => {
    if (event.method !== 'Tracing.dataCollected') return;
    const values = event.params['value'];
    if (!Array.isArray(values)) return;
    for (const raw of values) {
      if (!raw || typeof raw !== 'object') continue;
      const event = raw as Record<string, unknown>;
      const name = String(event['name'] ?? '');
      const category = String(event['cat'] ?? '');
      if (
        !/media|audio|gpu|viz|user_timing/i.test(category) &&
        !/RunTask|DrawFrame|BeginFrame|Commit|Composite|UpdateLayerTree|EventDispatch|Layout|Paint|Animation|FramePresented/.test(
          name
        )
      )
        continue;
      if (traceEvents.length < 50000)
        traceEvents.push({
          name,
          cat: event['cat'],
          ph: event['ph'],
          ts: event['ts'],
          dur: event['dur'],
          pid: event['pid'],
          tid: event['tid'],
          args: numericTraceArgs(event['args']),
        });
      else traceTruncated = true;
    }
  });

  const snapshot = () =>
    evaluate<ViewerSnapshot>(`window.${VIEWER_CONTRACT.hook}.snapshot()`);

  const page: ViewerPage = {
    evaluate,
    waitFor,
    snapshot,
    reopen: async () => {
      // Viewer strips the key fragment via history.replaceState. Re-navigating
      // to its keyed URL can therefore be same-document and emit no load event.
      // Navigate this owned proof tab to about:blank first, then back to the
      // original keyed URL. Register each waiter before its cross-document
      // navigation, and verify a genuinely new viewer document was created.
      const previousOrigin = await evaluate<number>('performance.timeOrigin');
      for (const url of ['about:blank', options.url]) {
        const loaded = cdp.waitForEvent('Page.loadEventFired', {
          sessionId,
          timeoutMs: 30000,
        });
        const navigation = await cdp.send('Page.navigate', { url }, sessionId);
        assert.equal(
          navigation['errorText'],
          undefined,
          `viewer reopen navigation failed: ${String(navigation['errorText'])}`
        );
        assert.ok(
          navigation['loaderId'],
          'viewer reopen did not start a cross-document navigation'
        );
        await loaded;
      }
      const nextOrigin = await evaluate<number>('performance.timeOrigin');
      assert.notEqual(
        nextOrigin,
        previousOrigin,
        'viewer reopen did not create a new document'
      );
    },
    startPerformanceTrace: async (categories?: string) => {
      await cdp.send('Performance.enable', {}, sessionId);
      await cdp.send('Tracing.start', {
        categories: categories ?? DEFAULT_TRACE_CATEGORIES,
        transferMode: 'ReportEvents',
      });
      tracing = true;
      return cdp.send('Performance.getMetrics', {}, sessionId);
    },
    stopPerformanceTrace: async () => {
      assert.ok(tracing, 'performance trace was not started');
      const completion = cdp.waitForEvent('Tracing.tracingComplete', {
        timeoutMs: 30000,
      });
      await cdp.send('Tracing.end');
      const done = await completion;
      tracing = false;
      const metrics = await cdp.send('Performance.getMetrics', {}, sessionId);
      const dataLoss = done.params['dataLossOccurred'];
      return {
        metrics,
        events: traceEvents,
        truncated: traceTruncated,
        dataLossOccurred: typeof dataLoss === 'boolean' ? dataLoss : null,
      };
    },
    click: async (selector: string) => {
      const target = await evaluate<{
        x: number;
        y: number;
        hittable: boolean;
      } | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const hittable = box.width > 0 && box.height > 0 && !!hit && (hit === el || el.contains(hit));
        return { x: x, y: y, hittable: hittable };
      })()`);
      assert.ok(target, `no element for trusted click: ${selector}`);
      if (!target.hittable)
        throw new Error(`trusted click target not hittable: ${selector}`);
      for (const type of [
        'mouseMoved',
        'mousePressed',
        'mouseReleased',
      ] as const)
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type, x: target.x, y: target.y, button: 'left', clickCount: 1 },
          sessionId
        );
    },
    hideViewer: async (): Promise<HideLog> => {
      await evaluate<void>(HIDE_INSTALL);
      const owned = (await cdp.send('Browser.getWindowForTarget', {
        targetId: created.targetId,
      })) as { windowId: number };
      try {
        await evaluate<void>(
          `window.__hideLog.push({ at: performance.now(), kind: 'minimize-sent', value: null })`
        );
        await cdp.send('Browser.setWindowBounds', {
          windowId: owned.windowId,
          bounds: { windowState: 'minimized' },
        });
        const hiddenUntil = Date.now() + HIDE_VISIBLE_WAIT_MS;
        while (Date.now() < hiddenUntil) {
          const value = await evaluate<string>('document.visibilityState');
          if (value === 'hidden') break;
          await Bun.sleep(HIDE_POLL_MS);
        }
        await Bun.sleep(HIDE_SETTLE_MS);
        return await evaluate<HideLog>(
          `({ visibility: document.visibilityState, events: window.__hideLog })`
        );
      } finally {
        await cdp
          .send('Browser.setWindowBounds', {
            windowId: owned.windowId,
            bounds: { windowState: 'normal' },
          })
          .catch(() => {});
      }
    },
    close: async () => {
      if (tracing) await cdp.send('Tracing.end').catch(() => {});
      removeTrace();
      removeDiagnostics();
      await cleanupOwnedBrowserStartup({
        child,
        connection: cdp,
        forgetChild: undefined,
        profile,
        removeProfile: async (dir: string) => {
          await rm(dir, { recursive: true, force: true });
        },
      });
    },
  };
  if (options.beforeNavigate) {
    try {
      await options.beforeNavigate(page);
    } catch (error) {
      await page.close();
      throw error;
    }
  }
  const navigation = await cdp.send(
    'Page.navigate',
    { url: options.url },
    sessionId
  );
  assert.equal(
    navigation['errorText'],
    undefined,
    `viewer navigation failed: ${String(navigation['errorText'])}`
  );
  return page;
}
