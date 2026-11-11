import type {
  CoverOutcome,
  CoverRenderResult,
  CoverSource,
} from '@relic/format/cover';
import {
  type ChromeDiscovery,
  discoverChrome,
  launchChrome,
  type RunningChrome,
} from './chrome.ts';
import { planCover } from './inputs.ts';
import { executeEncodeLadder } from './raster.ts';
import { setupVirtualOrigin } from './virtual-origin.ts';

export const CHROME_STARTUP_TIMEOUT_MS = 10_000;
export const PAGE_LOAD_TIMEOUT_MS = 10_000;
export const RENDER_TIMEOUT_MS = 20_000;
export const PAGE_SIDE_RENDER_TIMEOUT_MS = 15_000;
export const FRAME_SETTLE_MS = 1_000;
export const DEFAULT_DEADLINE_MS = 45_000;
export const COVER_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export interface CoverRendererOptions {
  readonly chromePath: string | undefined;
  readonly ffmpegPath: string | null | undefined;
  readonly assetDir: string;
  readonly deadlineMs: number;
}

export type CoverRenderer = (source: CoverSource) => Promise<CoverOutcome>;

export interface CoverRendererDeps {
  readonly discoverChrome?: (
    override: string | undefined
  ) => Promise<ChromeDiscovery>;
  readonly launchChrome?: (
    binaryPath: string,
    options: { readonly startupTimeoutMs: number }
  ) => Promise<RunningChrome>;
}

export function chromeCoverRenderer(
  options: CoverRendererOptions,
  deps: CoverRendererDeps = {}
): CoverRenderer {
  const doDiscoverChrome = deps.discoverChrome ?? discoverChrome;
  const doLaunchChrome = deps.launchChrome ?? launchChrome;
  const deadlineMs =
    options.deadlineMs > 0 ? options.deadlineMs : DEFAULT_DEADLINE_MS;

  return async (source: CoverSource): Promise<CoverOutcome> => {
    if (source.bytes.length > COVER_MAX_SOURCE_BYTES) {
      return {
        status: 'skipped',
        reason: 'over_render_ceiling',
        detail: `Cover source exceeds ${COVER_MAX_SOURCE_BYTES} bytes; using the generic cover`,
      };
    }

    let running: RunningChrome | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let deadlineTimedOut = false;

    const deadlinePromise = new Promise<CoverOutcome>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineTimedOut = true;
        if (running) {
          const r = running;
          running = undefined;
          try {
            r.kill?.();
          } catch {
            // Best effort
          }
          r.close().catch(() => {});
        }
        resolve({
          status: 'skipped',
          reason: 'render_timeout',
          detail: `Cover rendering timed out after ${deadlineMs}ms`,
        });
      }, deadlineMs);
    });

    const execute = async (): Promise<CoverOutcome> => {
      // 1. Plan input and check if this class/content can be rendered
      const plan = await planCover(source, {
        ffmpegPath: options.ffmpegPath,
      });

      if (plan.kind === 'skip') {
        return plan.outcome;
      }

      if (deadlineTimedOut) {
        return {
          status: 'skipped',
          reason: 'render_timeout',
          detail: `Cover rendering timed out after ${deadlineMs}ms`,
        };
      }

      // 2. Discover Chrome
      const discovery = await doDiscoverChrome(options.chromePath);
      if (discovery.kind === 'disabled') {
        return {
          status: 'skipped',
          reason: 'browser_disabled',
          detail: discovery.detail,
        };
      }
      if (discovery.kind === 'not_found') {
        return {
          status: 'skipped',
          reason: 'browser_not_found',
          detail: discovery.detail,
        };
      }

      if (deadlineTimedOut) {
        return {
          status: 'skipped',
          reason: 'render_timeout',
          detail: `Cover rendering timed out after ${deadlineMs}ms`,
        };
      }

      // 3. Render in Chrome
      try {
        running = await doLaunchChrome(discovery.path, {
          startupTimeoutMs: CHROME_STARTUP_TIMEOUT_MS,
        });

        if (deadlineTimedOut) {
          const r = running;
          running = undefined;
          try {
            r.kill?.();
          } catch {
            // Best effort
          }
          r.close().catch(() => {});
          return {
            status: 'skipped',
            reason: 'render_timeout',
            detail: `Cover rendering timed out after ${deadlineMs}ms`,
          };
        }

        const cdp = running.cdp;

        // Target.createTarget
        const createTargetRes = (await cdp.send('Target.createTarget', {
          url: 'about:blank',
        })) as { targetId: string };
        const targetId = createTargetRes.targetId;

        // Target.attachToTarget
        const attachRes = (await cdp.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        })) as { sessionId: string };
        const sessionId = attachRes.sessionId;

        // Setup virtual origin
        const removeListener = setupVirtualOrigin(cdp, sessionId, {
          assetDir: options.assetDir,
          inputBytes: plan.inputBytes,
          inputMimetype: plan.request.input?.mimetype,
        });

        try {
          // Enable domains on session
          await cdp.send(
            'Fetch.enable',
            { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
            sessionId
          );
          await cdp.send('Page.enable', {}, sessionId);
          await cdp.send('Runtime.enable', {}, sessionId);

          // Device metrics override
          await cdp.send(
            'Emulation.setDeviceMetricsOverride',
            {
              width: 600,
              height: 315,
              deviceScaleFactor: 2,
              mobile: false,
            },
            sessionId
          );

          // Emulated media
          await cdp.send(
            'Emulation.setEmulatedMedia',
            {
              features: [
                { name: 'prefers-color-scheme', value: 'light' },
                { name: 'prefers-reduced-motion', value: 'reduce' },
              ],
            },
            sessionId
          );

          // Navigate
          const loadPromise = cdp.waitForEvent('Page.loadEventFired', {
            sessionId,
            timeoutMs: PAGE_LOAD_TIMEOUT_MS,
          });
          await cdp.send(
            'Page.navigate',
            { url: 'https://cover.relic.invalid/index.html' },
            sessionId
          );
          await loadPromise;

          // Protocol check
          const protoCheck = (await cdp.send(
            'Runtime.evaluate',
            {
              expression: 'window.__relicCover && window.__relicCover.protocol',
              returnByValue: true,
            },
            sessionId
          )) as { result?: { value?: unknown } };

          if (protoCheck.result?.value !== 1) {
            return {
              status: 'skipped',
              reason: 'render_failed',
              detail: 'cover renderer assets are from a different build',
            };
          }

          // Evaluate render on page
          let evaluateTimer: NodeJS.Timeout | undefined;
          const evaluateTimeoutPromise = new Promise<never>((_, reject) => {
            evaluateTimer = setTimeout(() => {
              reject(
                new Error(
                  `Render evaluate timed out after ${RENDER_TIMEOUT_MS}ms`
                )
              );
            }, RENDER_TIMEOUT_MS);
          });

          let renderEvalRes: { result?: { value?: CoverRenderResult } };
          try {
            renderEvalRes = (await Promise.race([
              cdp.send(
                'Runtime.evaluate',
                {
                  expression: `window.__relicCover.render(${JSON.stringify(
                    plan.request
                  )})`,
                  awaitPromise: true,
                  returnByValue: true,
                },
                sessionId
              ),
              evaluateTimeoutPromise,
            ])) as { result?: { value?: CoverRenderResult } };
          } finally {
            clearTimeout(evaluateTimer);
          }

          const pageResult = renderEvalRes.result?.value;
          if (!pageResult || !pageResult.ok) {
            const reason = pageResult?.reason;
            if (reason === 'empty') {
              return {
                status: 'skipped',
                reason: 'empty_content',
                detail: pageResult?.detail ?? 'Content was empty',
              };
            }
            if (reason === 'timeout') {
              return {
                status: 'skipped',
                reason: 'render_timeout',
                detail: pageResult?.detail ?? 'Page render timed out',
              };
            }
            return {
              status: 'skipped',
              reason: 'render_failed',
              detail: pageResult?.detail ?? 'Cover rendering failed on page',
            };
          }

          // Capture screenshot through encode ladder
          const capture = async (opts: {
            format: 'png' | 'jpeg';
            quality?: number;
          }): Promise<Uint8Array> => {
            const params: Record<string, unknown> = {
              format: opts.format,
              captureBeyondViewport: false,
            };
            if (opts.quality !== undefined) {
              params['quality'] = opts.quality;
            }
            const res = (await cdp.send(
              'Page.captureScreenshot',
              params,
              sessionId
            )) as { data: string };
            return new Uint8Array(Buffer.from(res.data, 'base64'));
          };

          return await executeEncodeLadder(capture, plan.request.kind);
        } finally {
          removeListener();
        }
      } finally {
        if (running) {
          const r = running;
          running = undefined;
          r.close().catch(() => {});
        }
      }
    };

    try {
      return await Promise.race([execute(), deadlinePromise]);
    } catch (err) {
      return {
        status: 'skipped',
        reason: 'render_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(deadlineTimer);
    }
  };
}
