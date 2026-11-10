/**
 * Local program rendering in the publisher's own Chrome.
 *
 * Node owns everything the page must not: the browser process, the only
 * network the page may reach, the chunk transport, and the deadline. The page
 * (built from relic-viewer) owns the timeline evaluation and the encoding.
 * Nothing is sent to a service, and a Chrome or encoder that is missing is
 * reported per timeline, never replaced by a remote renderer.
 *
 * Plaintext stays in memory (docs/spec/publish.md §4.8), fail closed:
 * - the browser's profile and all its writes go to a private RAM volume on
 *   macOS, and the browser runs under a sandbox-exec profile that refuses any
 *   write outside that volume. A write probe must pass before any browser
 *   starts. Where that cannot be enforced (every platform but macOS today), no
 *   browser starts and every timeline is focus-only with the reason;
 * - the browser is closed before the volume is released; a failure to release
 *   is a refusal, never a quiet success;
 * - every render runs in a CDP browser context created with disposeOnDetach,
 *   and the HTTP cache is disabled for the page;
 * - the rendered MP4 and the source bytes are Uint8Arrays, never files.
 *
 * Reason messages are persisted into the encrypted manifest, which link holders
 * can read. They therefore never carry local paths, environment values, device
 * names, or raw tool output. Each one is a fixed sentence per reason code. The
 * detailed local error is discarded, not logged.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OtioMediaEntry, OtioProgramReasonCode } from '@relic/format';
import type { CdpEvent } from '../cover/cdp.ts';
import {
  discoverChrome,
  launchChrome,
  type RunningChrome,
} from '../cover/chrome.ts';
import {
  confinedEnv,
  confinementFlags,
  createConfinedPaths,
  launcherFor,
  verifyArguments,
  verifyLauncher,
} from './confine.ts';
import { acquireLinuxStorage } from './linux.ts';
import {
  PROGRAM_HEIGHT,
  PROGRAM_WIDTH,
  type ProgramProfileSource,
} from './policy.ts';
import {
  createPrivateRamVolume,
  ProgramStorageError,
  releasePrivateRamVolume,
} from './ramdisk.ts';
import type { ProgramReason } from './report.ts';

export const PROGRAM_VIRTUAL_ORIGIN = 'https://program.relic.invalid';
const PAGE_URL = `${PROGRAM_VIRTUAL_ORIGIN}/index.html`;
const MEDIA_PREFIX = `${PROGRAM_VIRTUAL_ORIGIN}/media/`;
const CHUNK_BINDING = '__relicProgramChunk';
const CHROME_STARTUP_TIMEOUT_MS = 10_000;
const PAGE_LOAD_TIMEOUT_MS = 10_000;

/**
 * Fixed sentences for every reason this module records. Each code keeps its
 * meaning; none of these embeds a path, an environment value, or tool output.
 */
export const RENDER_MESSAGES = {
  noBrowser:
    'no usable Chromium-based browser was found, so this timeline has no program',
  browserNotConfined:
    'the browser could not be confined to private memory storage, so this timeline has no program',
  storageUnverified:
    'no private memory storage could be verified, so this timeline has no program',
  pageMissing: 'the program page is not built for this publisher',
  pageBuildMismatch:
    'the program page is from a different build than this publisher',
  browserStartFailed: 'the browser could not be started',
  renderFailed: 'the browser failed while rendering this timeline',
  pageFailed: 'the program page failed while rendering this timeline',
  pageAnsweredOther:
    'the program page answered for a different document or timeline',
  chunkGaps: 'the program output arrived incomplete',
  lengthMismatch: 'the program output length did not match the page',
  digestMismatch: 'the program output did not match the page digest',
  noReason: 'the program page reported failure without a reason',
  deadlineBefore: 'the program deadline passed before this timeline rendered',
  deadlineDuring: 'the program deadline passed while this timeline rendered',
  noOutcome: 'the renderer returned no outcome for this timeline',
} as const;

/** Served only with the page. Nothing from the page may reach the network. */
const PAGE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline'; img-src data: blob:; media-src blob:; " +
  "worker-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

export interface ProgramRenderJob {
  /** Exact content.otio text. */
  readonly contentText: string;
  readonly documentSha256: string;
  readonly timelineIds: readonly string[];
  /** Archive media index. Only these entries are ever served to the page. */
  readonly media: readonly OtioMediaEntry[];
  /** Reads one archive media entry, by bundle_path. */
  readonly readMedia: (bundlePath: string) => Promise<Uint8Array>;
  readonly maxBytes: number;
  readonly forceEncoderAbsent: boolean;
}

export type ProgramTimelineOutcome =
  | {
      readonly status: 'rendered';
      readonly timelineId: string;
      readonly program: {
        readonly frame_rate: { readonly num: number; readonly den: number };
        readonly frames: number;
        readonly width: number;
        readonly height: number;
        readonly video_codec: string;
        readonly video_bitrate: number;
        readonly audio_codec: string;
        readonly audio_rate: number;
        readonly channels: number;
        readonly audio_samples: number;
        readonly range: {
          readonly start_time: {
            readonly value: number;
            readonly rate: number;
          };
          readonly duration: { readonly value: number; readonly rate: number };
        };
      };
      readonly mp4: Uint8Array;
      readonly sha256: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reasons: readonly ProgramReason[];
    };

export interface ProgramRenderOutput {
  /** Browser product string, or "none" when no browser ran. */
  readonly browser: string;
  /** One outcome per timeline, in timeline_ids order. */
  readonly outcomes: readonly ProgramTimelineOutcome[];
}

/**
 * Resolves with one outcome per timeline. Throws only a ProgramStorageError for
 * storage this process made that could not be released. Every other failure is
 * an outcome.
 */
export type ProgramRenderer = (
  job: ProgramRenderJob
) => Promise<ProgramRenderOutput>;

export interface ChromeProgramOptions {
  readonly chromePath: string | undefined;
  readonly assetDir: string;
  readonly profile: ProgramProfileSource;
  readonly deadlineMs: number;
}

function unavailable(
  code: OtioProgramReasonCode,
  message: string
): ProgramTimelineOutcome {
  return { status: 'unavailable', reasons: [{ code, message }] };
}

function allUnavailable(
  timelineIds: readonly string[],
  code: OtioProgramReasonCode,
  message: string
): ProgramRenderOutput {
  return {
    browser: 'none',
    outcomes: timelineIds.map(() => unavailable(code, message)),
  };
}

const DEADLINE_HIT = 'program-deadline-hit';

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(DEADLINE_HIT)), ms);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

interface AcquiredProfile {
  readonly ok: true;
  /** Directory the browser and its confined writes live in. */
  readonly parent: string;
  /** Releases the storage. Throws a cleanupFailed ProgramStorageError on failure. */
  readonly release: () => Promise<void>;
}

type ProfileAcquisition =
  | AcquiredProfile
  | { readonly ok: false; readonly message: string };

/**
 * Obtains a private RAM volume for the browser, or says why it cannot. A
 * cleanup failure while creating one is rethrown, because storage this process
 * made may still be in use. The local error text is discarded here.
 */
async function acquireProfile(
  source: ProgramProfileSource
): Promise<ProfileAcquisition> {
  if (source.kind === 'directory') {
    const storage = await acquireLinuxStorage(source.dir);
    if (storage === undefined) {
      return { ok: false, message: RENDER_MESSAGES.storageUnverified };
    }
    return { ok: true, parent: storage.parent, release: storage.release };
  }
  try {
    const volume = await createPrivateRamVolume(source.sizeMiB);
    return {
      ok: true,
      parent: volume.mountPoint,
      release: () => releasePrivateRamVolume(volume),
    };
  } catch (error) {
    if (error instanceof ProgramStorageError && !error.cleanupFailed) {
      return { ok: false, message: RENDER_MESSAGES.storageUnverified };
    }
    throw error;
  }
}

export function chromeProgramRenderer(
  options: ChromeProgramOptions
): ProgramRenderer {
  return async (job: ProgramRenderJob): Promise<ProgramRenderOutput> => {
    const deadline = Date.now() + options.deadlineMs;
    const ids = job.timelineIds;

    // Fail closed before any browser exists: no confined storage, no render.
    const profile = await acquireProfile(options.profile);
    if (!profile.ok) {
      return allUnavailable(ids, 'unsupported-browser', profile.message);
    }

    let output: ProgramRenderOutput;
    try {
      output = await renderWithProfile(options, job, profile.parent, deadline);
    } finally {
      // Runs after renderWithProfile has closed the browser. A failure here is
      // a ProgramStorageError that propagates, so the publish refuses.
      await profile.release();
    }
    return output;
  };
}

async function renderWithProfile(
  options: ChromeProgramOptions,
  job: ProgramRenderJob,
  profileParent: string,
  deadline: number
): Promise<ProgramRenderOutput> {
  const ids = job.timelineIds;

  let pages: { readonly html: Uint8Array; readonly js: Uint8Array };
  try {
    pages = {
      html: new Uint8Array(
        await readFile(join(options.assetDir, 'index.html'))
      ),
      js: new Uint8Array(await readFile(join(options.assetDir, 'index.js'))),
    };
  } catch {
    return allUnavailable(ids, 'render-failed', RENDER_MESSAGES.pageMissing);
  }

  const discovery = await discoverChrome(options.chromePath);
  if (discovery.kind !== 'found') {
    return allUnavailable(
      ids,
      'unsupported-browser',
      RENDER_MESSAGES.noBrowser
    );
  }

  // The launcher's write probe must pass before the browser starts under it.
  const launcher = launcherFor(profileParent);
  if (
    launcher === undefined ||
    !(await verifyLauncher(launcher, profileParent)).ok
  ) {
    return allUnavailable(
      ids,
      'unsupported-browser',
      RENDER_MESSAGES.browserNotConfined
    );
  }

  const paths = await createConfinedPaths(profileParent);
  let running: RunningChrome;
  try {
    running = await launchChrome(discovery.path, {
      startupTimeoutMs: CHROME_STARTUP_TIMEOUT_MS,
      profileParent,
      launcher,
      extraArgs: confinementFlags(paths),
      env: confinedEnv(paths),
    });
  } catch {
    return allUnavailable(
      ids,
      'render-failed',
      RENDER_MESSAGES.browserStartFailed
    );
  }

  // The browser's arguments must carry the confinement flags. Otherwise it is
  // not the browser we configured, and it is closed without rendering.
  const argv = await verifyArguments(running.pid, paths);
  if (!argv.ok) {
    await running.close().catch(() => {});
    return allUnavailable(
      ids,
      'unsupported-browser',
      RENDER_MESSAGES.browserNotConfined
    );
  }

  try {
    return await renderInBrowser(running, pages, job, deadline);
  } catch {
    return allUnavailable(ids, 'render-failed', RENDER_MESSAGES.renderFailed);
  } finally {
    // Awaited, so the browser has exited before its profile storage is released.
    await running.close().catch(() => {});
  }
}

async function renderInBrowser(
  running: RunningChrome,
  pages: { readonly html: Uint8Array; readonly js: Uint8Array },
  job: ProgramRenderJob,
  deadline: number
): Promise<ProgramRenderOutput> {
  const cdp = running.cdp;
  const ids = job.timelineIds;
  const mediaByPath = new Map(job.media.map((m) => [m.bundle_path, m]));
  const mediaCache = new Map<string, Uint8Array>();
  const outcomes: ProgramTimelineOutcome[] = [];

  const versionRes = await cdp.send('Browser.getVersion');
  const browser = String(versionRes['product'] ?? 'unknown');

  // A memory-only context: created over CDP with disposeOnDetach, so it is
  // discarded with the target and writes no profile data of its own.
  const context = (await cdp.send('Target.createBrowserContext', {
    disposeOnDetach: true,
  })) as { browserContextId: string };
  const targetRes = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  })) as { targetId: string };
  const attachRes = (await cdp.send('Target.attachToTarget', {
    targetId: targetRes.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attachRes.sessionId;

  // Chunk buffer for the timeline currently rendering.
  let chunks: Array<{ seq: number; data: Buffer }> = [];

  const respond = (
    requestId: string,
    body: Uint8Array,
    contentType: string,
    csp?: string
  ) => {
    const headers = [{ name: 'content-type', value: contentType }];
    if (csp !== undefined)
      headers.push({ name: 'content-security-policy', value: csp });
    return cdp.send(
      'Fetch.fulfillRequest',
      {
        requestId,
        responseCode: 200,
        responseHeaders: headers,
        body: Buffer.from(body).toString('base64'),
      },
      sessionId
    );
  };
  const refuse = (requestId: string) =>
    cdp.send(
      'Fetch.failRequest',
      { requestId, errorReason: 'BlockedByClient' },
      sessionId
    );

  async function handlePaused(event: CdpEvent): Promise<void> {
    const requestId = event.params['requestId'] as string | undefined;
    const url = (event.params['request'] as { url?: string } | undefined)?.url;
    if (!requestId) return;
    if (url === undefined) {
      await refuse(requestId);
      return;
    }
    if (url === PAGE_URL) {
      await respond(
        requestId,
        pages.html,
        'text/html; charset=utf-8',
        PAGE_CSP
      );
      return;
    }
    if (url === `${PROGRAM_VIRTUAL_ORIGIN}/index.js`) {
      await respond(requestId, pages.js, 'text/javascript; charset=utf-8');
      return;
    }
    if (url.startsWith(MEDIA_PREFIX)) {
      let name: string;
      try {
        name = decodeURIComponent(url.slice(MEDIA_PREFIX.length));
      } catch {
        await refuse(requestId);
        return;
      }
      const entry = mediaByPath.get(name);
      if (entry === undefined) {
        await refuse(requestId);
        return;
      }
      let bytes = mediaCache.get(name);
      if (bytes === undefined) {
        try {
          bytes = await job.readMedia(name);
        } catch {
          await refuse(requestId);
          return;
        }
        mediaCache.set(name, bytes);
      }
      await respond(
        requestId,
        bytes,
        entry.mime_type ?? 'application/octet-stream'
      );
      return;
    }
    await refuse(requestId);
  }

  const removeListener = cdp.onEvent((event: CdpEvent) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === 'Fetch.requestPaused') {
      handlePaused(event).catch(() => {});
      return;
    }
    if (
      event.method === 'Runtime.bindingCalled' &&
      event.params['name'] === CHUNK_BINDING
    ) {
      // One string: `${seq}:${base64}`. The base64 alphabet has no colon.
      const payload = String(event.params['payload'] ?? '');
      const colon = payload.indexOf(':');
      if (colon <= 0) return;
      const seq = Number(payload.slice(0, colon));
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      chunks.push({
        seq,
        data: Buffer.from(payload.slice(colon + 1), 'base64'),
      });
    }
  });

  try {
    await cdp.send('Network.enable', {}, sessionId);
    // Fail closed: if the cache cannot be switched off, nothing renders.
    await cdp.send(
      'Network.setCacheDisabled',
      { cacheDisabled: true },
      sessionId
    );
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Runtime.addBinding', { name: CHUNK_BINDING }, sessionId);

    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId,
      timeoutMs: PAGE_LOAD_TIMEOUT_MS,
    });
    await cdp.send('Page.navigate', { url: PAGE_URL }, sessionId);
    await loaded;

    const protoRes = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: 'window.__relicProgram && window.__relicProgram.protocol',
        returnByValue: true,
      },
      sessionId
    )) as { result?: { value?: unknown } };
    if (protoRes.result?.value !== 1) {
      return allUnavailable(
        ids,
        'render-failed',
        RENDER_MESSAGES.pageBuildMismatch
      );
    }

    for (let i = 0; i < ids.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        outcomes.push(
          unavailable('render-failed', RENDER_MESSAGES.deadlineBefore)
        );
        continue;
      }
      chunks = [];
      const request = {
        protocol: 1,
        timeline_index: i,
        content: job.contentText,
        media: job.media,
        width: PROGRAM_WIDTH,
        height: PROGRAM_HEIGHT,
        max_bytes: job.maxBytes,
        ...(job.forceEncoderAbsent ? { force_encoder_absent: true } : {}),
      };
      let evaluated: Record<string, unknown>;
      try {
        evaluated = await withDeadline(
          cdp.send(
            'Runtime.evaluate',
            {
              expression: `window.__relicProgram.render(${JSON.stringify(request)})`,
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId
          ),
          remaining
        );
      } catch (error) {
        if ((error as Error).message === DEADLINE_HIT) {
          // The page is still running and cannot be stopped safely. The
          // browser is closed by the caller; every remaining timeline is
          // reported as timed out.
          outcomes.push(
            unavailable('render-failed', RENDER_MESSAGES.deadlineDuring)
          );
          for (let j = i + 1; j < ids.length; j++) {
            outcomes.push(
              unavailable('render-failed', RENDER_MESSAGES.deadlineBefore)
            );
          }
          return { browser, outcomes };
        }
        outcomes.push(unavailable('render-failed', RENDER_MESSAGES.pageFailed));
        continue;
      }
      outcomes.push(await settleTimeline(evaluated, ids[i]!, job, chunks));
    }
    return { browser, outcomes };
  } finally {
    removeListener();
  }
}

/** Turn one evaluate response and its chunks into an outcome, verifying every byte. */
async function settleTimeline(
  evaluated: Record<string, unknown>,
  timelineId: string,
  job: ProgramRenderJob,
  chunks: Array<{ seq: number; data: Buffer }>
): Promise<ProgramTimelineOutcome> {
  // The page's own exception text is not recorded: it is not ours to publish.
  const result = (evaluated['result'] as { value?: unknown } | undefined)
    ?.value as Record<string, unknown> | undefined;
  if (result === undefined) {
    return unavailable('render-failed', RENDER_MESSAGES.pageFailed);
  }
  if (result['ok'] !== true) {
    const reasons = Array.isArray(result['reasons'])
      ? (result['reasons'] as ProgramReason[])
      : [];
    if (reasons.length === 0) {
      return unavailable('render-failed', RENDER_MESSAGES.noReason);
    }
    return { status: 'unavailable', reasons };
  }

  if (
    result['document_sha256'] !== job.documentSha256 ||
    result['timeline_id'] !== timelineId
  ) {
    return unavailable('render-failed', RENDER_MESSAGES.pageAnsweredOther);
  }
  const byteLength = Number(result['byte_length']);
  const expectedSha = String(result['sha256']);

  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  for (let k = 0; k < ordered.length; k++) {
    if (ordered[k]!.seq !== k) {
      return unavailable('render-failed', RENDER_MESSAGES.chunkGaps);
    }
  }
  const mp4 = new Uint8Array(Buffer.concat(ordered.map((c) => c.data)));
  if (mp4.length !== byteLength) {
    return unavailable('render-failed', RENDER_MESSAGES.lengthMismatch);
  }
  if (createHash('sha256').update(mp4).digest('hex') !== expectedSha) {
    return unavailable('render-failed', RENDER_MESSAGES.digestMismatch);
  }
  return {
    status: 'rendered',
    timelineId,
    program: result['program'] as Extract<
      ProgramTimelineOutcome,
      { status: 'rendered' }
    >['program'],
    mp4,
    sha256: expectedSha,
  };
}
