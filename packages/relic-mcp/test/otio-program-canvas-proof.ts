/**
 * Synthetic, test-only pre-encode renderer differential. This is NOT a probe of the separately
 * published programs: it runs the same renderer source in a dedicated instrumented page and
 * fresh isolated headless browsers, using the exact synthetic fixture input. No hook or binding
 * is added to any production publisher or renderer bundle.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexOtioZip, otioBundleMediaIndex } from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import { bundleOtiod } from '../src/otio-bundle.ts';
import { type CdpEvent, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { PROGRAM } from './otio-program-reference.ts';

const PAGE_ORIGIN = 'https://program.relic.invalid';
const PAGE_URL = `${PAGE_ORIGIN}/index.html`;
const LANDMARK = 'await videoSource.add(start, frameSeconds);';
const RENDER_FILE = fileURLToPath(
  new URL('../../relic-viewer/src/program-render/render.ts', import.meta.url)
);
const PAGE_FILE = fileURLToPath(
  new URL('../../relic-viewer/src/program-render/page.ts', import.meta.url)
);

/** Build only in memory. A changed/duplicated insertion landmark is a hard proof failure. */
async function buildInstrumentedPage(): Promise<string> {
  const original = await readFile(RENDER_FILE, 'utf8');
  assert.equal(
    original.split(LANDMARK).length,
    2,
    'canvas proof injection landmark is missing or duplicated'
  );
  const injection = `{
    const pixels = outputContext.getImageData(0, 0, width, height).data;
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(pixels));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    window.__relicProgramCanvasHash(String(n) + ':' + hash);
  }\n      ${LANDMARK}`;
  let injections = 0;
  const result = await Bun.build({
    entrypoints: [PAGE_FILE],
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    plugins: [
      {
        name: 'synthetic-canvas-proof',
        setup(build) {
          build.onLoad(
            { filter: /program-render\/render\.ts$/ },
            async (args) => {
              assert.equal(
                args.path,
                RENDER_FILE,
                'unexpected renderer file path'
              );
              injections++;
              return {
                contents: original.replace(LANDMARK, injection),
                loader: 'ts',
              };
            }
          );
        },
      },
    ],
  });
  if (!result.success)
    throw new Error(
      `synthetic renderer build failed: ${result.logs.map((l) => l.message).join('\n')}`
    );
  assert.equal(
    injections,
    1,
    'synthetic renderer was not instrumented exactly once'
  );
  assert.ok(result.outputs[0], 'synthetic renderer produced no page script');
  return result.outputs[0].text();
}

async function captureCanvasHashes(
  fixture: string,
  pageScript: string
): Promise<string[]> {
  const bundled = await bundleOtiod(fixture, nodeFiles);
  const zip = await indexOtioZip(bundled.bytes);
  const mediaIndex = await otioBundleMediaIndex(zip);
  const media = Object.values(mediaIndex);
  const mediaBytes = new Map<string, { bytes: Buffer; mime: string }>();
  for (const entry of media) {
    const bytes = await readFile(join(fixture, entry.bundle_path));
    mediaBytes.set(entry.bundle_path, {
      bytes,
      mime: entry.mime_type ?? 'application/octet-stream',
    });
  }
  const content = await readFile(join(fixture, 'content.otio'), 'utf8');
  const found = await discoverChrome(process.env['RELIC_OTIO_CHROME_PATH']);
  assert.equal(found.kind, 'found', 'no Chrome for isolated canvas proof');
  if (found.kind !== 'found') throw new Error('unreachable');
  const profile = await mkdtemp(join(tmpdir(), 'relic-canvas-proof-'));
  const launch = createBrowserHeadlessLaunch(
    chromeArgs(found.path, profile),
    profile
  );
  const child = spawn(found.path, [...launch.args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const to = child.stdio[3];
  const from = child.stdio[4];
  assert.ok(to && from, 'canvas proof Chrome debug pipes missing');
  const cdp = connectPipe(
    to as NodeJS.WritableStream,
    from as NodeJS.ReadableStream
  );
  let removeListener: (() => void) | undefined;
  try {
    await attestBrowserHeadless(cdp, launch);
    const created = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: created['targetId'],
      flatten: true,
    });
    const session = String(attached['sessionId']);
    assert.ok(
      session && session !== 'undefined',
      'canvas proof session missing'
    );
    const hashes: string[] = [];
    const chunks: Buffer[] = [];
    const faults: string[] = [];
    const requests = new Set<Promise<void>>();
    const respond = async (event: CdpEvent) => {
      const id = String(event.params['requestId'] ?? '');
      const request = event.params['request'] as { url?: string } | undefined;
      const url = request?.url ?? '';
      let data: Buffer | undefined;
      let mime = 'application/octet-stream';
      if (url === PAGE_URL) {
        data = Buffer.from(
          '<!doctype html><meta charset="utf-8"><script type="module" src="./index.js"></script>'
        );
        mime = 'text/html; charset=utf-8';
      } else if (url === `${PAGE_ORIGIN}/index.js`) {
        data = Buffer.from(pageScript);
        mime = 'text/javascript; charset=utf-8';
      } else if (url.startsWith(`${PAGE_ORIGIN}/media/`)) {
        const name = decodeURIComponent(
          url.slice(`${PAGE_ORIGIN}/media/`.length)
        );
        const entry = mediaBytes.get(name);
        data = entry?.bytes;
        mime = entry?.mime ?? mime;
      }
      if (!data) {
        faults.push(`blocked unexpected request ${url}`);
        await cdp.send(
          'Fetch.failRequest',
          { requestId: id, errorReason: 'BlockedByClient' },
          session
        );
      } else {
        await cdp.send(
          'Fetch.fulfillRequest',
          {
            requestId: id,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: mime }],
            body: data.toString('base64'),
          },
          session
        );
      }
    };
    removeListener = cdp.onEvent((event) => {
      if (event.sessionId !== session) return;
      if (event.method === 'Fetch.requestPaused') {
        const pending = respond(event).catch((error: unknown) => {
          faults.push(String(error));
        });
        requests.add(pending);
        void pending.finally(() => requests.delete(pending));
      } else if (event.method === 'Runtime.bindingCalled') {
        const name = event.params['name'];
        const payload = String(event.params['payload'] ?? '');
        const match = /^(\d+):(.+)$/.exec(payload);
        if (name === '__relicProgramCanvasHash') {
          if (
            !match ||
            Number(match[1]) !== hashes.length ||
            !/^[0-9a-f]{64}$/.test(match[2] ?? '')
          )
            faults.push('malformed, duplicate or out-of-order canvas hash');
          else hashes.push(match[2]!);
        } else if (name === '__relicProgramChunk') {
          if (!match || Number(match[1]) !== chunks.length)
            faults.push('malformed or out-of-order MP4 chunk');
          else chunks.push(Buffer.from(match[2]!, 'base64'));
        }
      }
    });
    await cdp.send('Network.enable', {}, session);
    await cdp.send(
      'Network.setCacheDisabled',
      { cacheDisabled: true },
      session
    );
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      session
    );
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send(
      'Runtime.addBinding',
      { name: '__relicProgramCanvasHash' },
      session
    );
    await cdp.send(
      'Runtime.addBinding',
      { name: '__relicProgramChunk' },
      session
    );
    await Promise.all([
      cdp.waitForEvent('Page.loadEventFired', {
        sessionId: session,
        timeoutMs: 30000,
      }),
      cdp.send('Page.navigate', { url: PAGE_URL }, session),
    ]);
    const request = {
      protocol: 1,
      timeline_index: 0,
      content,
      media,
      width: PROGRAM.width,
      height: PROGRAM.height,
      max_bytes: 100 * 1024 * 1024,
    };
    const response = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `window.__relicProgram.render(${JSON.stringify(request)})`,
        awaitPromise: true,
        returnByValue: true,
      },
      session
    );
    const value = (
      response['result'] as
        | { value?: { ok?: boolean; reasons?: unknown; byte_length?: number } }
        | undefined
    )?.value;
    assert.equal(
      value?.ok,
      true,
      `isolated canvas render failed: ${JSON.stringify(response)}`
    );
    await Promise.all([...requests]);
    assert.deepEqual(faults, [], 'canvas proof transport failed');
    assert.equal(
      hashes.length,
      PROGRAM.frames,
      'missing pre-encode canvas hashes'
    );
    assert.equal(
      chunks.reduce((total, chunk) => total + chunk.length, 0),
      value?.byte_length,
      'canvas proof MP4 chunk length'
    );
    return hashes;
  } finally {
    removeListener?.();
    await cleanupOwnedBrowserStartup({
      child,
      connection: cdp,
      forgetChild: undefined,
      profile,
      removeProfile: undefined,
    });
    await rm(profile, { recursive: true, force: true });
  }
}

/** Compares three separate synthetic renderer invocations before H.264 encoding. */
export async function compareSyntheticCanvases(
  positiveFixture: string,
  globalFixture: string
): Promise<void> {
  const page = await buildInstrumentedPage();
  const positive = await captureCanvasHashes(positiveFixture, page);
  const repeat = await captureCanvasHashes(positiveFixture, page);
  const globalStart = await captureCanvasHashes(globalFixture, page);
  const repeatDifferent = repeat.flatMap((hash, frame) =>
    hash === positive[frame] ? [] : [frame]
  );
  const globalDifferent = globalStart.flatMap((hash, frame) =>
    hash === positive[frame] ? [] : [frame]
  );
  console.log(
    `SYNTHETIC_PREENCODE_CANVAS_DIFFERENCES ${JSON.stringify({ repeatDifferent, globalDifferent })}`
  );
  assert.deepEqual(
    repeatDifferent,
    [],
    'synthetic same-input pre-encode canvas changed'
  );
  assert.deepEqual(
    globalDifferent,
    [],
    'synthetic global-start pre-encode canvas changed'
  );
}
