/*
 * Local affected-path proof. Build the viewer and MCP bundle before running:
 * RELIC_PROOF_CHROME_PATH=/absolute/path/to/chrome-headless-shell \
 *   bun packages/relic-mcp/test/large-relic-path.ts
 *
 * All storage, sessions, comments and HTTP requests are loopback-only. No
 * share URL or key is written to output. Fixtures and browser data are removed.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeHeader,
  deriveKeys,
  encodeEnvelope,
  encryptRecord,
  encryptedSize,
  generateRelicId,
  HEADER_BYTES,
  parseFragment,
  recordCapacity,
  RECORD_SIZE,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  hashFile,
  memoryGrowth,
  memoryMeasurement,
  processRssBytes,
  ProofBrowser,
  type MemoryGrowth,
  type Page,
} from './large-relic-browser.ts';
import {
  CAP,
  MIB,
  PDF_BYTES,
  TEXT_BYTES,
  TEXT_END,
  TEXT_MIDDLE,
  TEXT_MIDDLE_LINE,
  TEXT_START,
  makeBaseVideo,
  makeLargeImage,
  makeLargePdf,
  makeLargeModel,
  makeLargeOtiod,
  makeTriangleLimitModel,
  makeWindowedText,
  padVideo,
} from './large-relic-fixtures.ts';

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const clientBundle = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const otioTemplate = fileURLToPath(
  new URL(
    '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/content.otio',
    import.meta.url
  )
);
const EXPECTED_CAP_OBJECT_BYTES = 524_489_608;
const clientNode = Bun.which('node');
assert.ok(clientNode, 'node must be available on PATH');
assert.ok(Bun.which('ffmpeg'), 'ffmpeg must be available on PATH');
const chromePath = process.env['RELIC_PROOF_CHROME_PATH'];
assert.ok(
  chromePath && isAbsolute(chromePath) && existsSync(chromePath),
  'set RELIC_PROOF_CHROME_PATH to an absolute headless Chromium executable'
);
assert.ok(existsSync(otioTemplate), 'OTIO template fixture is missing');
assert.ok(
  existsSync(join(viewerDist, 'viewer.js')),
  'build the viewer before running this path'
);
assert.ok(
  existsSync(clientBundle),
  'build the MCP bundle before running this path'
);
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'relic-large-path-'))
);

interface StorageRead {
  readonly key: string;
  sent: number;
  canceled: boolean;
  completed: boolean;
}
interface CallResult {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
  readonly peakRss: number;
  readonly diagnostic: string;
}
interface Published {
  readonly id: string;
  readonly url: string;
  readonly plaintextBytes: number;
  readonly objectBytes: number;
  readonly peakRss: number;
}

const reads: StorageRead[] = [];
const declared = new Map<string, { plain: number; cipher: number }>();
let grants = 0;
let activeHandler: ((request: Request) => Promise<Response>) | undefined;
let browser: ProofBrowser | undefined;
const contentService = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    return new Response('Not found', { status: 404 });
  },
});
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  maxRequestBodySize: 600 * MIB,
  async fetch(request) {
    if (!activeHandler) return new Response('Not ready', { status: 503 });
    return activeHandler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const store = new MemoryStore();
const storage = new MemoryStorage(`${origin}/__storage`);
const app = createApp({
  config: {
    serviceOrigin: origin,
    usercontentOrigin: `http://localhost:${contentService.port}`,
  },
  store,
  storage,
  assets: diskAssets(viewerDist),
});

activeHandler = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/sw.js' || url.pathname === '/assets/register-sw.js')
    return new Response(null, { status: 404 });
  if (url.pathname === '/api/grant' && request.method === 'POST') {
    grants += 1;
    const body: unknown = await request.clone().json();
    const response = await app.fetch(request);
    if (
      response.ok &&
      body &&
      typeof body === 'object' &&
      'relic_id' in body &&
      typeof body.relic_id === 'string' &&
      'declared_size_bytes' in body &&
      typeof body.declared_size_bytes === 'number' &&
      'declared_ciphertext_bytes' in body &&
      typeof body.declared_ciphertext_bytes === 'number'
    ) {
      declared.set(body.relic_id, {
        plain: body.declared_size_bytes,
        cipher: body.declared_ciphertext_bytes,
      });
    }
    return response;
  }
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const key = decodeURIComponent(
      url.pathname.slice('/__storage/upload/'.length)
    );
    const grant = declared.get(key);
    if (
      !grant ||
      request.headers.get('content-length') !== String(grant.cipher)
    ) {
      return new Response('signed length mismatch', { status: 400 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== grant.cipher)
      return new Response('body length mismatch', { status: 400 });
    storage.put(key, bytes);
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const key = decodeURIComponent(url.pathname.slice('/__storage/o/'.length));
    const bytes = await storage.read(key);
    if (!bytes) return new Response(null, { status: 404 });
    const receipt: StorageRead = {
      key,
      sent: 0,
      canceled: false,
      completed: false,
    };
    reads.push(receipt);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (receipt.canceled || request.signal.aborted) return;
        if (offset >= bytes.length) {
          receipt.completed = true;
          controller.close();
          return;
        }
        const end = Math.min(offset + 16 * 1024, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        receipt.sent += end - offset;
        offset = end;
        // Give the viewer a chance to authenticate record zero and cancel.
        if (offset <= 512 * 1024) await Bun.sleep(4);
      },
      cancel() {
        receipt.canceled = true;
      },
    });
    request.signal.addEventListener(
      'abort',
      () => {
        receipt.canceled = true;
      },
      { once: true }
    );
    return new Response(stream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    });
  }
  return app.fetch(request);
};

async function callMcp(
  name: string,
  args: Record<string, unknown>
): Promise<CallResult> {
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: scratch,
    TMPDIR: scratch,
    RELIC_SERVICE_ORIGIN: origin,
    RELIC_ORIGIN: origin,
    RELIC_PUBLISH_STATE: join(scratch, 'state.json'),
    RELIC_METADATA_CACHE: join(scratch, 'metadata-cache.json'),
    RELIC_CLIENT_NAME: 'relic-mcp/large-relic-path',
    RELIC_CHROME_PATH: 'none',
    RELIC_MCP_HTTP: '0',
  };
  const child = Bun.spawn([clientNode!, clientBundle], {
    cwd: scratch,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let peakRss = 0;
  let samples = 0;
  let sampling = false;
  let pending: Promise<void> = Promise.resolve();
  const sample = () => {
    if (sampling) return;
    sampling = true;
    pending = processRssBytes(child.pid, process.platform === 'linux')
      .then((bytes) => {
        peakRss = Math.max(peakRss, bytes);
        samples += 1;
      })
      .catch(() => {})
      .finally(() => {
        sampling = false;
      });
  };
  sample();
  const timer = setInterval(sample, 150);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearInterval(timer);
  clearTimeout(watchdog);
  await pending;
  assert.equal(exit, 0, `MCP process exited ${exit}: ${stderr}`);
  assert.ok(samples > 0, 'could not measure the MCP process RSS');
  const lines = stdout.trim().split('\n').filter(Boolean);
  const line = lines.at(-1);
  assert.ok(line, 'MCP process returned no JSON-RPC response');
  const response: unknown = JSON.parse(line);
  assert.ok(
    response &&
      typeof response === 'object' &&
      'result' in response &&
      response.result &&
      typeof response.result === 'object',
    'missing MCP result'
  );
  const result = response.result;
  assert.ok(
    'structuredContent' in result &&
      result.structuredContent &&
      typeof result.structuredContent === 'object' &&
      !Array.isArray(result.structuredContent),
    'missing MCP structured result'
  );
  const data = result.structuredContent as Record<string, unknown>;
  return {
    isError: 'isError' in result && result.isError === true,
    data,
    peakRss,
    diagnostic: JSON.stringify('content' in result ? result.content : []),
  };
}

async function publish(path: string): Promise<Published> {
  const result = await callMcp('relic_publish', {
    path,
    title: '',
    cover: false,
    ttl_days: 1,
    force_new: true,
  });
  assert.equal(result.isError, false, `publish refused: ${result.diagnostic}`);
  const id = result.data['relic_id'];
  const url = result.data['url'];
  assert.ok(
    typeof id === 'string' && typeof url === 'string',
    'publish returned no relic id or URL'
  );
  assert.equal(
    new URL(url).origin,
    origin,
    'publish returned an off-loopback URL'
  );
  const grant = declared.get(id);
  assert.ok(grant, 'publish returned without a captured grant');
  const object = await storage.stat(id);
  assert.ok(object, 'publish returned without a stored object');
  assert.equal(
    object.length,
    grant.cipher,
    'stored object differs from the signed length'
  );
  return {
    id,
    url,
    plaintextBytes: grant.plain,
    objectBytes: object.length,
    peakRss: result.peakRss,
  };
}

async function release(relic: Published): Promise<void> {
  await storage.delete(relic.id);
  declared.delete(relic.id);
  Bun.gc(true);
}

async function acceptPrompt(
  b: ProofBrowser,
  page: Page,
  bytes: number
): Promise<void> {
  const size = await b.waitFor<string>(
    page,
    `document.querySelector('[data-large-open][open]')?.getAttribute('data-large-open-bytes') || ''`,
    'large-file confirmation'
  );
  assert.equal(
    Number(size),
    bytes,
    'confirmation did not display the authenticated plaintext size'
  );
  const visible = await b.evaluate<{ text: string; visible: boolean }>(
    page,
    `(() => {
    const dialog=document.querySelector('[data-large-open][open]');
    if (!(dialog instanceof HTMLDialogElement)) return {text:'',visible:false};
    const box=dialog.getBoundingClientRect();
    return {text:dialog.innerText,visible:box.width>0 && box.height>0 && getComputedStyle(dialog).visibility !== 'hidden'};
  })()`
  );
  assert.ok(
    visible.visible &&
      visible.text.includes(`${(bytes / 1_000_000).toFixed(1)} MB`),
    'confirmation does not visibly disclose the size'
  );
  await b.evaluate(
    page,
    `(() => {
    const button = document.querySelector('[data-large-open-accept]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Open button missing');
    button.click();
  })()`
  );
}

const timingPrelude = `(() => {
  globalThis.__largeTiming = [];
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('otio-video-timing-worker')) this.addEventListener('message', (event) => {
        if (event.data?.type === 'result') globalThis.__largeTiming.push({kind: event.data.timing?.kind, reason: event.data.timing?.reason, count: event.data.timing?.starts?.length ?? 0});
      });
    }
  };
})()`;

/**
 * Record each range the pdf.js worker requests. Page 1 uses the first MiB,
 * supplied at open, and page 2 uses the final 64 KiB. Earlier requests read
 * the whitespace run between them.
 */
const pdfRangePrelude = `(() => {
  globalThis.__pdfRanges = [];
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('pdf.worker')) this.addEventListener('message', (event) => {
        if (event.data?.action === 'GetRangeReader') globalThis.__pdfRanges.push([event.data.data.begin, event.data.data.end]);
      });
    }
  };
})()`;
const pdfRunGuard = `if ((globalThis.__pdfRanges ?? []).some(([begin]) => begin < ${PDF_BYTES - MIB})) throw new Error('PDF preview requested the whitespace run: ' + JSON.stringify(globalThis.__pdfRanges.filter(([begin]) => begin < ${PDF_BYTES - MIB}).slice(0, 3)));`;

function rendererMemoryReceipt(growth: MemoryGrowth): string {
  return `renderer_growth=${growth.footprint} renderer_rss_growth=${growth.rss} measurement=${memoryMeasurement()} added=${JSON.stringify(growth.added)} exited=${JSON.stringify(growth.exited)}`;
}

function memoryControlReceipt(label: string, growth: MemoryGrowth): string {
  return `${label}_growth=${growth.footprint} ${label}_rss_growth=${growth.rss} ${label}_added=${JSON.stringify(growth.added)} ${label}_exited=${JSON.stringify(growth.exited)}`;
}

try {
  assert.equal(app.config.downloadCap, 200, 'download cap changed');
  const base = await makeBaseVideo(scratch);
  const mediaPath = join(scratch, 'large.mp4');
  await padVideo(base, mediaPath, CAP);
  const media = await publish(mediaPath);
  assert.equal(media.plaintextBytes, CAP);
  assert.equal(encryptedSize(CAP), EXPECTED_CAP_OBJECT_BYTES);
  assert.equal(media.objectBytes, EXPECTED_CAP_OBJECT_BYTES);
  assert.ok(
    media.peakRss <= 1_400_000_000,
    `MCP peak RSS exceeded budget: ${media.peakRss}`
  );
  console.log(
    `LARGE_STEP_1_PUBLISH_OK bytes=${media.plaintextBytes} object_length=${media.objectBytes} client_peak_rss=${media.peakRss} measurement=${process.platform === 'linux' ? 'sampled_vmhwm' : 'sampled_rss'}`
  );

  const tooLarge = join(scratch, 'over-cap.mp4');
  await writeFile(tooLarge, '');
  await truncate(tooLarge, CAP + 1);
  const beforeGrants = grants;
  const refused = await callMcp('relic_publish', {
    path: tooLarge,
    title: '',
    cover: false,
    force_new: true,
  });
  assert.equal(refused.isError, true, 'over-cap MCP publish succeeded');
  assert.equal(refused.data['code'], 'local_size_precheck_failed');
  assert.equal(refused.data['size_limit_bytes'], CAP);
  assert.equal(grants, beforeGrants, 'local size refusal sent a grant');
  const challenge = await fetch(`${origin}/api/challenge`, { method: 'POST' });
  assert.equal(challenge.status, 200);
  const challengeBody: unknown = await challenge.json();
  assert.ok(
    challengeBody &&
      typeof challengeBody === 'object' &&
      'challenge_nonce' in challengeBody &&
      typeof challengeBody.challenge_nonce === 'string'
  );
  const over = await fetch(`${origin}/api/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge_nonce: challengeBody.challenge_nonce,
      relic_id: generateRelicId(),
      renderer_class: 'media',
      publishing_client: 'large-path',
      declared_size_bytes: CAP + 1,
      declared_ciphertext_bytes: encryptedSize(CAP + 1),
    }),
  });
  const overBody: unknown = await over.json();
  assert.equal(over.status, 413);
  assert.ok(
    overBody &&
      typeof overBody === 'object' &&
      'code' in overBody &&
      overBody.code === 'size_over_cap' &&
      'size_limit_bytes' in overBody &&
      overBody.size_limit_bytes === CAP
  );
  console.log(
    `LARGE_STEP_2_OVER_CAP_REFUSED local=local_size_precheck_failed size_limit_bytes=${CAP} server=${over.status}`
  );

  browser = await ProofBrowser.start(
    scratch,
    service.port!,
    contentService.port!
  );
  const calibration = await browser.page('about:blank');
  const calibrated = await browser.memoryNegativeControl(calibration);
  await browser.closePage(calibration);
  console.log(
    `LARGE_MEMORY_NEG_OK allocation_bytes=${512 * MIB} detected_growth=${calibrated.allocation.footprint} ${memoryControlReceipt('allocation', calibrated.allocation)} ${memoryControlReceipt('retained', calibrated.retained)} ${memoryControlReceipt('churn', calibrated.churn)} measurement=${memoryMeasurement()} browser_process_storage=not_gated transient_renderer_peak=not_gated`
  );
  const canceled = await browser.page(media.url);
  await browser.waitFor(
    canceled,
    `!!document.querySelector('[data-large-open][open]')`,
    'media confirmation'
  );
  await Bun.sleep(500);
  const prefixReads = reads.filter((entry) => entry.key === media.id);
  assert.ok(prefixReads.length > 0, 'no authenticated prefix was fetched');
  const beforeOpenBytes = prefixReads.reduce(
    (sum, entry) => sum + entry.sent,
    0
  );
  assert.ok(
    beforeOpenBytes < 2 * MIB,
    `confirmation downloaded too much ciphertext: ${beforeOpenBytes}`
  );
  assert.equal(
    await browser.evaluate<number>(
      canceled,
      `Number(document.querySelector('[data-large-open]')?.getAttribute('data-large-open-bytes'))`
    ),
    CAP
  );
  const confirmation = await browser.evaluate<{
    text: string;
    visible: boolean;
  }>(
    canceled,
    `(() => {
    const dialog=document.querySelector('[data-large-open][open]');
    if (!(dialog instanceof HTMLDialogElement)) return {text:'',visible:false};
    const box=dialog.getBoundingClientRect();
    return {text:dialog.innerText,visible:box.width>0 && box.height>0};
  })()`
  );
  assert.ok(
    confirmation.visible &&
      confirmation.text.includes('large.mp4') &&
      confirmation.text.includes('video/mp4') &&
      confirmation.text.includes('524.3 MB'),
    'confirmation did not visibly identify the file, type and size'
  );
  await browser.evaluate(
    canceled,
    `(() => {
    const button=document.querySelector('[data-large-open-decline]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Cancel button missing');
    button.click();
  })()`
  );
  await browser.waitFor(
    canceled,
    `!document.querySelector('[data-large-open]')`,
    'confirmation dismissal'
  );
  await Bun.sleep(500);
  const readsAfterDecline = reads.filter((entry) => entry.key === media.id);
  assert.equal(
    readsAfterDecline.length,
    prefixReads.length,
    'decline started another object fetch'
  );
  assert.ok(
    readsAfterDecline.reduce((sum, entry) => sum + entry.sent, 0) < 2 * MIB &&
      readsAfterDecline.every((entry) => !entry.completed),
    'decline completed the full fetch'
  );
  await browser.closePage(canceled);

  const mediaPage = await browser.page(media.url);
  await browser.waitFor(
    mediaPage,
    `!!document.querySelector('[data-large-open][open]')`,
    'media confirmation'
  );
  await browser.pressure(mediaPage);
  const mediaBaseline = await browser.rendererMemory();
  await acceptPrompt(browser, mediaPage, CAP);
  await browser.waitFor(
    mediaPage,
    `(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); })()`,
    'video metadata',
    900_000
  );
  await browser.pressure(mediaPage);
  const mediaGrowth = memoryGrowth(
    mediaBaseline,
    await browser.rendererMemory()
  );
  assert.ok(
    mediaGrowth.footprint < 64 * MIB,
    `renderer grew beyond budget before playback: ${rendererMemoryReceipt(mediaGrowth)}`
  );
  const advance = await browser.evaluate<number>(
    mediaPage,
    `(async () => {
    const v = document.querySelector('video'); if (!v) throw new Error('video missing');
    const start = v.currentTime; await v.play();
    const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 1200); await promise;
    const delta = v.currentTime - start; v.pause(); return delta;
  })()`
  );
  assert.ok(advance > 0.2, `video did not advance: ${advance}`);
  await browser.evaluate(
    mediaPage,
    `(() => { const v = document.querySelector('video'); if (!v) throw new Error('video missing'); v.currentTime = v.duration - 1.5; })()`
  );
  const seek = await browser.waitFor<{
    time: number;
    duration: number;
    ready: number;
  }>(
    mediaPage,
    `(() => {
    const v = document.querySelector('video');
    return v && !v.seeking && v.readyState >= 3 && v.currentTime >= v.duration - 2 ? {time:v.currentTime,duration:v.duration,ready:v.readyState} : null;
  })()`,
    'seek near video end'
  );
  await browser.evaluate(
    mediaPage,
    `(() => { const v = document.querySelector('video'); v.pause(); v.removeAttribute('src'); v.load(); })()`
  );
  await browser.pressure(mediaPage);
  const releasedGrowth = memoryGrowth(
    mediaBaseline,
    await browser.rendererMemory()
  );
  assert.ok(
    releasedGrowth.footprint < 128 * MIB,
    `renderer grew beyond budget after release: ${rendererMemoryReceipt(releasedGrowth)}`
  );
  console.log(
    `LARGE_STEP_3_MEDIA_PLAYED prefix_bytes=${beforeOpenBytes} ${rendererMemoryReceipt(mediaGrowth)} ${memoryControlReceipt('released', releasedGrowth)} advanced=${advance} seek=${seek.time} duration=${seek.duration} ready=${seek.ready}`
  );
  const downloaded = await browser.download(mediaPage);
  const sourceHash = await hashFile(mediaPath);
  const downloadHash = await hashFile(downloaded);
  assert.equal(
    downloadHash,
    sourceHash,
    'download differs from original media'
  );
  assert.notEqual(
    await hashFile(downloaded, true),
    sourceHash,
    'download hash negative control missed a changed byte'
  );
  assert.equal((await stat(downloaded)).size, CAP);
  console.log(
    'LARGE_STEP_4_DOWNLOAD_SAVED sha256_match=true flipped_byte_detected=true'
  );
  await browser.closePage(mediaPage);

  // Deliberately inject an authenticated over-cap envelope at the storage seam.
  // This is a negative fixture; the real publish above remains within the cap.
  {
    const object = await storage.read(media.id);
    assert.ok(object);
    const header = decodeHeader(object);
    const { key, version } = parseFragment(new URL(media.url).hash);
    const keys = await deriveKeys(key, header.salt);
    const envelope = encodeEnvelope({
      version,
      entries: [
        {
          filename: 'large.mp4',
          mimetype: 'video/mp4',
          offset: 0,
          length: CAP + 1,
        },
      ],
    });
    const first = await encryptRecord(
      keys,
      0,
      envelope,
      false,
      recordCapacity(header.rs)
    );
    assert.equal(first.length, header.rs);
    object.set(first, HEADER_BYTES);
    storage.put(media.id, object);
  }
  const alarmReadStart = reads.length;
  const alarmPage = await browser.page(media.url);
  await browser.waitFor(
    alarmPage,
    `document.querySelector('main.stage-dead .accession')?.textContent?.trim() === 'too_large'`,
    'authenticated over-cap alarm'
  );
  assert.equal(
    await browser.evaluate<boolean>(
      alarmPage,
      `!!document.querySelector('[data-dead-action="report"]')`
    ),
    true,
    'over-cap alarm has no report action'
  );
  await Bun.sleep(500);
  const alarmReads = reads
    .slice(alarmReadStart)
    .filter((entry) => entry.key === media.id);
  const alarmBytes = alarmReads.reduce((sum, entry) => sum + entry.sent, 0);
  assert.ok(
    alarmReads.length > 0 &&
      alarmBytes < 2 * MIB &&
      alarmReads.every((entry) => !entry.completed),
    'over-cap alarm fetched the full object'
  );
  await browser.closePage(alarmPage);
  console.log(
    `LARGE_OVER_CAP_ALARM_OK authenticated_size=${CAP + 1} fetched_bytes=${alarmBytes}`
  );

  let row = await store.getRelic(media.id);
  assert.ok(row, 'published row disappeared');
  while (row.mintsUsed < 199) {
    await store.consumeMint(media.id);
    row = await store.getRelic(media.id);
    assert.ok(row);
  }
  assert.equal(row.mintsUsed, 199);
  const lastMint = await fetch(`${origin}/api/relics/${media.id}/mint`, {
    method: 'POST',
  });
  assert.equal(lastMint.status, 200, '200th mint refused');
  const exhausted = await fetch(`${origin}/api/relics/${media.id}/mint`, {
    method: 'POST',
  });
  const exhaustedBody: unknown = await exhausted.json();
  assert.equal(exhausted.status, 410);
  assert.ok(
    exhaustedBody &&
      typeof exhaustedBody === 'object' &&
      'code' in exhaustedBody &&
      exhaustedBody.code === 'download_cap_exhausted' &&
      'download_cap' in exhaustedBody &&
      exhaustedBody.download_cap === 200
  );
  console.log('LARGE_DOWNLOAD_CAP_OK seeded=199 mint_200=200 mint_201=410');
  await release(media);
  await rm(downloaded);

  const thresholdPath = join(scratch, 'threshold.mp4');
  await padVideo(base, thresholdPath, 100 * MIB);
  const threshold = await publish(thresholdPath);
  assert.equal(threshold.plaintextBytes, 100 * MIB);
  const thresholdPage = await browser.page(
    threshold.url,
    undefined,
    `(() => {
    globalThis.__largePromptSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-large-open]')) globalThis.__largePromptSeen = true;
    }).observe(document, { childList:true, subtree:true });
  })()`
  );
  await browser.waitFor(
    thresholdPage,
    `(() => {
    const video=document.querySelector('video'); return video && video.readyState >= 2;
  })()`,
    '100 MiB video preview',
    900_000
  );
  assert.equal(
    await browser.evaluate<boolean>(
      thresholdPage,
      'globalThis.__largePromptSeen'
    ),
    false,
    '100 MiB video prompted for confirmation'
  );
  console.log(
    `LARGE_CONFIRM_BOUNDARY_OK bytes=${100 * MIB} prompted=false preview=true`
  );
  await browser.closePage(thresholdPage);
  await release(threshold);

  const token = randomBytes(24).toString('hex');
  await store.putSession({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    email: 'large-proof@example.test',
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  const otioDirectory = await makeLargeOtiod(base, scratch, otioTemplate);
  const otio = await publish(otioDirectory);
  assert.ok(
    otio.plaintextBytes >= 498 * MIB && otio.plaintextBytes <= CAP,
    `unexpected OTIO archive size: ${otio.plaintextBytes}`
  );
  const otioPage = await browser.page(otio.url, token, timingPrelude);
  await browser.waitFor(
    otioPage,
    `!!document.querySelector('[data-large-open][open]')`,
    'OTIO confirmation'
  );
  await browser.pressure(otioPage);
  const otioBaseline = await browser.rendererMemory();
  await acceptPrompt(browser, otioPage, otio.plaintextBytes);
  await browser.waitFor(
    otioPage,
    `!!document.querySelector('.otio-view[data-ready="true"]')`,
    'large OTIO preview',
    900_000
  );
  const timing = await browser.waitFor<{ kind: string; count: number }>(
    otioPage,
    `globalThis.__largeTiming?.find(entry => entry.kind === 'windows' && entry.count > 0) || null`,
    'OTIO packet timing windows',
    60_000
  );
  await browser.pressure(otioPage);
  const otioGrowth = memoryGrowth(otioBaseline, await browser.rendererMemory());
  assert.ok(
    otioGrowth.footprint < 128 * MIB,
    `OTIO renderer grew beyond budget before playback: ${rendererMemoryReceipt(otioGrowth)}`
  );
  await browser.evaluate(
    otioPage,
    `(() => {
    const play=document.querySelector('button.otio-play');
    if (!(play instanceof HTMLButtonElement)) throw new Error('OTIO Play missing');
    play.click();
  })()`
  );
  const playedFrame = await browser.waitFor<number>(
    otioPage,
    `(() => {
    const frame=Number(document.querySelector('.otio-view')?.getAttribute('data-frame'));
    return Number.isFinite(frame) && frame > 2 ? frame : 0;
  })()`,
    'large OTIO playback'
  );
  await browser.evaluate(
    otioPage,
    `(() => {
    const root=document.querySelector('.otio-view');
    const play=document.querySelector('button.otio-play');
    if (root?.getAttribute('data-playing') === 'true' && play instanceof HTMLButtonElement) play.click();
  })()`
  );
  await browser.evaluate(
    otioPage,
    `(() => { const s = document.querySelector('input.otio-seek'); if (!(s instanceof HTMLInputElement)) throw new Error('OTIO seek missing'); s.value='24'; s.dispatchEvent(new Event('input',{bubbles:true})); })()`
  );
  const leaf = await browser.waitFor<{ frame: number; time: number }>(
    otioPage,
    `(() => {
    const root=document.querySelector('.otio-view'); const videos=[...document.querySelectorAll('.otio-video-decoders video')];
    const v=videos.find(video => Math.abs(video.currentTime - 1) < 0.2 && video.readyState >= 2);
    return root?.dataset.buffering === 'false' && Number(root.dataset.frame) === 24 && v ? {frame:24,time:v.currentTime} : null;
  })()`,
    'large OTIO seek'
  );
  const comment = 'Large OTIO point comment';
  await browser.evaluate(
    otioPage,
    `(() => {
    const select=document.querySelector('select.otio-track-select'); const mode=document.querySelector('button[data-otio-mode="point"]');
    const input=document.querySelector('.otio-selection-in');
    if (!(select instanceof HTMLSelectElement) || !(mode instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) throw new Error('OTIO selection controls missing');
    const option=[...select.options].find(item => item.value); if (!option) throw new Error('no OTIO track');
    select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); mode.click();
    input.value='24'; input.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('button.otio-comment-selection')?.click();
  })()`
  );
  await browser.waitFor(
    otioPage,
    `!!document.querySelector('.popover-card.popover-composer.is-otio-composer textarea.popover-field')`,
    'OTIO comment composer'
  );
  await browser.evaluate(
    otioPage,
    `(() => {
    const field=document.querySelector('.popover-card.popover-composer.is-otio-composer textarea.popover-field');
    const button=document.querySelector('.popover-card.popover-composer.is-otio-composer button.popover-action.is-primary');
    if (!(field instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) throw new Error('OTIO comment fields missing');
    field.value=${JSON.stringify(comment)}; field.dispatchEvent(new Event('input',{bubbles:true})); button.click();
  })()`
  );
  await browser.waitFor(
    otioPage,
    `document.body.textContent.includes(${JSON.stringify(comment)})`,
    'posted OTIO comment'
  );
  assert.equal(
    (await store.listComments(otio.id)).length,
    1,
    'OTIO comment was not stored'
  );
  const placed = await browser.waitFor<{
    id: string;
    start: number;
    rate: number;
    duration: number;
  }>(
    otioPage,
    `(() => {
    const mark=document.querySelector('.otio-comment-mark[data-comment-id]');
    if (!(mark instanceof HTMLElement)) return null;
    return {id:mark.dataset.commentId,start:Number(mark.dataset.start),rate:Number(mark.dataset.rate),duration:Number(mark.dataset.duration)};
  })()`,
    'placed OTIO comment'
  );
  assert.ok(
    Math.abs(placed.start / placed.rate - 1) < 0.01 && placed.duration === 0,
    'OTIO comment landed at the wrong time'
  );
  await browser.closePage(otioPage);
  const reopenedOtio = await browser.page(otio.url, token);
  await acceptPrompt(browser, reopenedOtio, otio.plaintextBytes);
  await browser.waitFor(
    reopenedOtio,
    `!!document.querySelector('.otio-view[data-ready="true"]') && !!document.querySelector('.otio-comment-mark[data-comment-id]')`,
    'OTIO comment after reload',
    900_000
  );
  const restored = await browser.evaluate<{
    id: string;
    start: number;
    rate: number;
    duration: number;
  }>(
    reopenedOtio,
    `(() => {
    const mark=document.querySelector('.otio-comment-mark[data-comment-id]');
    if (!(mark instanceof HTMLElement)) throw new Error('OTIO marker missing');
    return {id:mark.dataset.commentId,start:Number(mark.dataset.start),rate:Number(mark.dataset.rate),duration:Number(mark.dataset.duration)};
  })()`
  );
  assert.deepEqual(
    restored,
    placed,
    'OTIO comment placement changed after reload'
  );
  console.log(
    `LARGE_STEP_5_OTIO_REVIEWED archive_bytes=${otio.plaintextBytes} timing=${timing.kind} windows=${timing.count} played_frame=${playedFrame} leaf_time=${leaf.time} comment_reload=true ${rendererMemoryReceipt(otioGrowth)}`
  );
  await browser.closePage(reopenedOtio);
  await release(otio);

  const pdfPath = join(scratch, 'large.pdf');
  await makeLargePdf(pdfPath);
  const pdf = await publish(pdfPath);
  assert.equal(pdf.plaintextBytes, PDF_BYTES);
  const pdfPage = await browser.page(pdf.url, undefined, pdfRangePrelude);
  await browser.waitFor(
    pdfPage,
    `!!document.querySelector('[data-large-open][open]')`,
    'PDF confirmation'
  );
  await browser.pressure(pdfPage);
  const pdfBaseline = await browser.rendererMemory(true);
  await acceptPrompt(browser, pdfPage, PDF_BYTES);
  await browser.waitFor(
    pdfPage,
    `(() => {
    ${pdfRunGuard}
    const c=document.querySelector('canvas.relic-page');
    if (!(c instanceof HTMLCanvasElement) || c.dataset.pageNumber !== '1' || !c.width || !c.height) return false;
    const p=c.getContext('2d')?.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;
    return !!p && p[0]>200 && p[2]<40;
  })()`,
    'first rendered PDF page',
    900_000
  );
  await browser.evaluate(
    pdfPage,
    `(() => {
    const button=[...document.querySelectorAll('.pdf-toolbar button')].find(item => item.textContent === 'Next');
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('PDF Next missing');
    button.click();
  })()`
  );
  await browser.waitFor(
    pdfPage,
    `(() => {
    ${pdfRunGuard}
    const c=document.querySelector('canvas.relic-page');
    if (!(c instanceof HTMLCanvasElement) || c.dataset.pageNumber !== '2' || !c.width || !c.height) return false;
    const p=c.getContext('2d')?.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;
    return !!p && p[2]>200 && p[0]<40;
  })()`,
    'last rendered PDF page'
  );
  const pdfRanges = await browser.evaluate<Array<[number, number]> | undefined>(
    pdfPage,
    'globalThis.__pdfRanges'
  );
  assert.ok(pdfRanges?.length, 'PDF range instrumentation recorded nothing');
  assert.ok(
    pdfRanges.every(([begin]) => begin >= PDF_BYTES - MIB),
    `PDF preview requested the whitespace run: ${JSON.stringify(pdfRanges)}`
  );
  await browser.pressure(pdfPage);
  const pdfGrowth = memoryGrowth(
    pdfBaseline,
    await browser.rendererMemory(true)
  );
  assert.ok(
    pdfGrowth.footprint < 128 * MIB,
    `PDF renderer and utility processes grew beyond budget: ${rendererMemoryReceipt(pdfGrowth)}`
  );
  const pdfDownload = await browser.download(pdfPage);
  assert.equal(
    await hashFile(pdfDownload),
    await hashFile(pdfPath),
    'PDF download differs after rendering'
  );
  console.log(
    `LARGE_STEP_6_PDF_PAGES rendered=first,last bytes=${PDF_BYTES} worker_ranges=${pdfRanges.length} renderer_utility_growth=${pdfGrowth.footprint} ${rendererMemoryReceipt(pdfGrowth)} sha256_match=true`
  );
  await browser.closePage(pdfPage);
  await release(pdf);
  await rm(pdfDownload);

  const textPath = join(scratch, 'large.txt');
  await makeWindowedText(textPath);
  const text = await publish(textPath);
  assert.equal(text.plaintextBytes, TEXT_BYTES);
  const textPage = await browser.page(text.url);
  await acceptPrompt(browser, textPage, TEXT_BYTES);
  await browser.waitFor(
    textPage,
    `document.querySelector('.text-window-page')?.textContent?.includes(${JSON.stringify(TEXT_START)})`,
    'first source window',
    900_000
  );
  await browser.evaluate(
    textPage,
    `(() => {
    const field=document.querySelector('.text-window-tools input[aria-label="Line"]');
    const form=document.querySelector('.text-window-tools');
    if (!(field instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) throw new Error('line navigation missing');
    field.value='${TEXT_MIDDLE_LINE}'; form.requestSubmit();
  })()`
  );
  await browser.waitFor(
    textPage,
    `document.querySelector('.text-window-page')?.textContent?.includes(${JSON.stringify(TEXT_MIDDLE)})`,
    'middle source window'
  );
  await browser.evaluate(
    textPage,
    `(() => {
    const page=document.querySelector('.text-window-page');
    if (!(page instanceof HTMLElement)) throw new Error('source window missing');
    page.focus(); page.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}));
  })()`
  );
  await browser.waitFor(
    textPage,
    `document.querySelector('.text-window-page')?.textContent?.includes(${JSON.stringify(TEXT_END)})`,
    'last source window'
  );
  const visibleRows = await browser.evaluate<number>(
    textPage,
    `document.querySelectorAll('.text-window-row').length`
  );
  assert.ok(
    visibleRows > 0 && visibleRows <= 80,
    `source view mounted ${visibleRows} rows`
  );
  const textDownload = await browser.download(textPage);
  assert.equal(
    await hashFile(textDownload),
    await hashFile(textPath),
    'windowed text download differs from the source'
  );
  console.log(
    `LARGE_STEP_7_TEXT bytes=${TEXT_BYTES} source_windows=first,middle,last sha256_match=true`
  );
  await browser.closePage(textPage);
  await release(text);
  await rm(textDownload);

  const imagePath = join(scratch, 'large.png');
  await makeLargeImage(imagePath);
  const image = await publish(imagePath);
  assert.ok(image.plaintextBytes > 16 * MIB);
  const imagePage = await browser.page(image.url);
  await browser.waitFor(
    imagePage,
    `(() => {
    const img=document.querySelector('.doc-image img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1 && img.naturalHeight === 1;
  })()`,
    'large image preview'
  );
  console.log(
    `LARGE_STEP_8_IMAGE_RENDERED bytes=${image.plaintextBytes} width=1 height=1`
  );
  await browser.closePage(imagePage);
  await release(image);

  const modelPath = join(scratch, 'large.obj');
  await makeLargeModel(modelPath);
  const model = await publish(modelPath);
  const modelPage = await browser.page(model.url);
  await browser.waitFor(
    modelPage,
    `!!document.querySelector('.model-view[data-model-state="limit-exceeded"]')`,
    'model limit card'
  );
  assert.equal(
    await browser.evaluate<boolean>(
      modelPage,
      `!!document.querySelector('button.action-download')`
    ),
    true,
    'oversize model has no download'
  );
  await browser.closePage(modelPage);
  await release(model);
  const trianglePath = join(scratch, 'many-triangles.obj');
  await makeTriangleLimitModel(trianglePath);
  const triangleModel = await publish(trianglePath);
  assert.ok(triangleModel.plaintextBytes < 16 * MIB);
  const trianglePage = await browser.page(triangleModel.url);
  await browser.waitFor(
    trianglePage,
    `!!document.querySelector('.model-view[data-model-state="limit-exceeded"]')`,
    'model triangle limit card'
  );
  assert.equal(
    await browser.evaluate<boolean>(
      trianglePage,
      `!!document.querySelector('button.action-download')`
    ),
    true
  );
  console.log(
    'LARGE_STEP_9_MODEL_LIMIT bytes=17MiB triangles=250001 error=limit-exceeded download=true'
  );
  await browser.closePage(trianglePage);
  await release(triangleModel);

  const damagedPath = join(scratch, 'damaged.txt');
  await writeFile(damagedPath, Buffer.alloc(2 * MIB, 0x61));
  const damaged = await publish(damagedPath);
  const ciphertext = await storage.read(damaged.id);
  assert.ok(ciphertext, 'missing ciphertext for damage negative control');
  const flip = HEADER_BYTES + RECORD_SIZE + 10;
  assert.ok(flip < ciphertext.length);
  ciphertext[flip] = (ciphertext[flip] ?? 0) ^ 1;
  storage.put(damaged.id, ciphertext);
  const damagedPage = await browser.page(damaged.url);
  await browser.waitFor(
    damagedPage,
    `document.querySelector('main.stage-dead .accession')?.textContent?.trim() === 'content_damaged'`,
    'damaged content refusal'
  );
  console.log('LARGE_DAMAGE_NEG_OK content_damaged=true');
  await browser.closePage(damagedPage);
  await release(damaged);

  console.log(`LARGE_RELIC_PATH_OK measurement=${memoryMeasurement()}`);
} finally {
  if (browser) await browser.close();
  service.stop(true);
  contentService.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
