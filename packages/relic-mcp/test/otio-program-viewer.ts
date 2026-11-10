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
  close(): Promise<void>;
}

export interface OpenViewerOptions {
  readonly url: string;
  readonly origin: string;
  readonly sessionToken: string;
}

export async function openViewer(
  options: OpenViewerOptions
): Promise<ViewerPage> {
  const found = await discoverChrome(process.env['RELIC_OTIO_CHROME_PATH']);
  assert.equal(found.kind, 'found', 'no Chrome for the viewer proof');
  if (found.kind !== 'found') throw new Error('unreachable');
  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-viewer-'));
  const launch = createBrowserHeadlessLaunch(
    chromeArgs(found.path, profile),
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
  await cdp.send('Runtime.enable', {}, sessionId);
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
  await cdp.send('Page.navigate', { url: options.url }, sessionId);

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
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const snapshot = () =>
    evaluate<ViewerSnapshot>(`window.${VIEWER_CONTRACT.hook}.snapshot()`);

  return {
    evaluate,
    waitFor,
    snapshot,
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
    close: async () => {
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
  return page.evaluate<{
    rate: number;
    left: number[];
    right: number[];
  }>(`(async () => {
    const hook = window.${VIEWER_CONTRACT.hook};
    const video = document.querySelector('video');
    if (!video) throw new Error('no native program video to capture');
    if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable');
    const ctx = new AudioContext({ sampleRate: 48000 });
    const stream = video.captureStream();
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
    await hook.seek(0);
    await hook.play();
    await new Promise((resolve) => setTimeout(resolve, ${Math.round(seconds * 1000)}));
    await hook.pause();
    processor.disconnect();
    source.disconnect();
    const rate = ctx.sampleRate;
    await ctx.close();
    return { rate, left, right };
  })()`);
}
