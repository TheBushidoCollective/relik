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
  /** Activates a second tab this proof opens, then reports whether the viewer became hidden. */
  foregroundOtherTab(): Promise<{ hidden: boolean; visibility: string }>;
  stopPerformanceTrace(): Promise<{
    metrics: unknown;
    events: unknown[];
    truncated: boolean;
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

  return {
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
      await completion;
      tracing = false;
      const metrics = await cdp.send('Performance.getMetrics', {}, sessionId);
      return { metrics, events: traceEvents, truncated: traceTruncated };
    },
    click: async (selector: string) => {
      const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const box = el.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()`);
      assert.ok(rect, `no element for trusted click: ${selector}`);
      for (const type of [
        'mouseMoved',
        'mousePressed',
        'mouseReleased',
      ] as const)
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
          sessionId
        );
    },
    foregroundOtherTab: async () => {
      const other = (await cdp.send('Target.createTarget', {
        url: 'about:blank',
      })) as { targetId: string };
      try {
        await cdp.send('Target.activateTarget', { targetId: other.targetId });
        const visibility = await waitFor<string>(
          'viewer hidden by a second proof-owned tab',
          async () => {
            const value = await evaluate<string>('document.visibilityState');
            return value === 'hidden' ? value : undefined;
          },
          1500
        ).catch(() => evaluate<string>('document.visibilityState'));
        return { hidden: visibility === 'hidden', visibility };
      } finally {
        await cdp
          .send('Target.activateTarget', { targetId: created.targetId })
          .catch(() => {});
        await cdp
          .send('Target.closeTarget', { targetId: other.targetId })
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
}

/**
 * Records the audio the native program element actually outputs while it plays from 0 s.
 * captureStream() taps the element's own output, so the samples include its decode, scheduling
 * and any gaps. Returns the channels and the context rate the capture ran at.
 */
export async function captureElementAudio(
  page: ViewerPage,
  seconds: number
): Promise<{ rate: number; left: number[]; right: number[] }> {
  await page.evaluate(`(async () => {
    const hook = window.${VIEWER_CONTRACT.hook};
    const video = document.querySelector('video.otio-program-video');
    const play = document.querySelector('button.otio-play');
    if (!video || !play || play.disabled) throw new Error('program Play control unavailable');
    if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable');
    await hook.seek(0);
    const ctx = new AudioContext({ sampleRate: 48000 });
    const stream = video.captureStream();
    if (!stream.getAudioTracks().length) throw new Error('program captureStream has no audio track');
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 2, 2);
    const left = [];
    const right = [];
    processor.onaudioprocess = (event) => {
      const l = event.inputBuffer.getChannelData(0);
      const r = event.inputBuffer.numberOfChannels > 1
        ? event.inputBuffer.getChannelData(1) : l;
      for (let i = 0; i < l.length; i++) { left.push(l[i]); right.push(r[i]); }
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    window.__programAudioProof = new Promise((resolve, reject) => {
      play.addEventListener('pointerdown', (event) => {
        if (!event.isTrusted) { reject(new Error('audio Play pointerdown was not trusted')); return; }
        // Resume is requested synchronously inside trusted activation, not via
        // an autoplay override or a programmatic click.
        ctx.resume().then(() => {
          setTimeout(async () => {
            try {
              await hook.pause();
              processor.disconnect();
              source.disconnect();
              const rate = ctx.sampleRate;
              await ctx.close();
              resolve({ rate, left, right });
            } catch (error) { reject(error); }
          }, ${Math.round(seconds * 1000)});
        }, reject);
      }, { once: true });
    });
  })()`);
  await page.click('button.otio-play');
  return page.evaluate<{ rate: number; left: number[]; right: number[] }>(
    'window.__programAudioProof'
  );
}
