/**
 * Local headless proof for Relic loading progress and early key cancellation.
 * Written for Spec B (§5.P).
 *
 * Runs file fixtures across viewports and dark/light modes, exercising:
 * 1. Progress phases (opening, fetching, decrypting, rendering/ready)
 * 2. Meter aria-valuenow progression on multi-chunk downloads
 * 3. Static plate from first paint (no blank frames)
 * 4. Early cancellation on wrong key (< 262,144 bytes) and key-entry recovery
 * 5. Mid-stream abort and Try again in place (no reload, no new mint)
 * 6. Damaged card on tag failure after record 0 (content_damaged)
 * 7. Damaged card on truncated container
 * 8. Noscript plate and hidden loading stage when scripts disabled
 * 9. Static plate when viewer.js is blocked
 * 10. Version switching preserving stage until ready
 * 11. JSX component relic: rendered frame, comparison, and compiler-load recovery (run with --only=jsx)
 *
 * Output: prints LOAD_PROGRESS_PATH_OK with the fixture and run counts.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Readable, Writable } from 'node:stream';

import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const execFileAsync = promisify(execFile);

// --- Configuration & Paths --------------------------------------------------

const CHUNK_SIZE = 16384;
const CHUNK_DELAY_MS = Number(
  process.env['RELIC_LOAD_PROOF_CHUNK_DELAY_MS'] ?? 25
);
// Allow the headless browser time to paint between the first chunks even
// when software WebGL is enabled. Later chunks keep larger fixtures moving.
const PACED_CHUNKS = 8;
const PACED_CHUNK_DELAY_MS = 200;

const viewerDist =
  process.env['RELIC_VIEWER_DIST'] ??
  fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
const otioFixtureDir = fileURLToPath(
  new URL(
    '../../relic-format/test/fixtures/otio/standard-sample.otiod/',
    import.meta.url
  )
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-load-proof-'));
const statePath = join(scratch, 'state.json');

// Discover git HEAD for proof output directory
let shortSha = 'test';
try {
  const { stdout } = await execFileAsync('git', [
    'rev-parse',
    '--short',
    'HEAD',
  ]);
  shortSha = stdout.trim();
} catch {}

const proofDir =
  process.env['RELIC_LOAD_PROOF_DIR'] ??
  fileURLToPath(
    new URL(
      `../../../docs/plans/load-progress/proof/${shortSha}/`,
      import.meta.url
    )
  );

await mkdir(proofDir, { recursive: true });

// --- Loopback App & Storage Setup -------------------------------------------

let serverMintCount = 0;
const relicMintCounts = new Map<string, number>();

interface StorageRequestLog {
  readonly id: string;
  readonly relicId: string;
  enqueuedBytes: number;
  cancelled: boolean;
  completed: boolean;
  aborted: boolean;
  cancelReason?: unknown;
}

const storageLogs: StorageRequestLog[] = [];
const activeAbortAfterBytes = new Map<string, number>();

const usercontentService = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/sandbox.html') {
      return new Response(Bun.file(join(viewerDist, 'sandbox.html')), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        },
      });
    }
    if (url.pathname === '/sandbox.js') {
      return new Response(Bun.file(join(viewerDist, 'sandbox.js')), {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      });
    }
    const assetPath = join(viewerDist, url.pathname.slice(1));
    if (existsSync(assetPath)) {
      return new Response(Bun.file(assetPath));
    }
    return new Response('Not found', { status: 404 });
  },
});
const usercontentOrigin = `http://127.0.0.1:${usercontentService.port}`;

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const storage = new MemoryStorage(`${origin}/__storage`);

const app = createApp({
  config: {
    serviceOrigin: origin,
    usercontentOrigin,
  },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens,
  assets: diskAssets(viewerDist),
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/sw.js' || url.pathname === '/assets/register-sw.js') {
    return new Response(null, { status: 404 });
  }
  if (request.method === 'POST' && url.pathname.includes('/mint')) {
    serverMintCount++;
    const parts = url.pathname.split('/');
    const rIdx = parts.indexOf('relics');
    if (rIdx !== -1 && parts[rIdx + 2] === 'mint') {
      const id = parts[rIdx + 1]!;
      relicMintCounts.set(id, (relicMintCounts.get(id) ?? 0) + 1);
    }
    await Bun.sleep(100);
  }

  // Storage upload
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const objectKey = decodeURIComponent(
      url.pathname.slice('/__storage/upload/'.length).split('?')[0] ?? ''
    );
    const bytes = new Uint8Array(await request.arrayBuffer());
    storage.put(objectKey, bytes);
    return new Response(null, { status: 200 });
  }

  // Storage download (chunked with tracking and abort capability)
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const objectKey = decodeURIComponent(
      url.pathname.slice('/__storage/o/'.length).split('?')[0] ?? ''
    );
    const bytes = await storage.read(objectKey);
    if (!bytes) return new Response('Not found', { status: 404 });

    const reqId = `${objectKey}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const log: StorageRequestLog = {
      id: reqId,
      relicId: objectKey,
      enqueuedBytes: 0,
      cancelled: false,
      completed: false,
      aborted: false,
    };
    storageLogs.push(log);

    const abortAfter = activeAbortAfterBytes.get(objectKey);

    const stream = new ReadableStream({
      async start(controller) {
        let offset = 0;
        let sentChunks = 0;
        while (offset < bytes.length) {
          if (request.signal.aborted || log.cancelled) {
            log.cancelled = true;
            return;
          }
          if (abortAfter !== undefined && offset >= abortAfter) {
            log.aborted = true;
            controller.error(new Error('Simulated mid-stream abort'));
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, bytes.length);
          const chunk = bytes.subarray(offset, end);
          controller.enqueue(chunk);
          log.enqueuedBytes += chunk.length;
          offset = end;
          sentChunks += 1;
          const delay =
            sentChunks <= PACED_CHUNKS
              ? Math.max(CHUNK_DELAY_MS, PACED_CHUNK_DELAY_MS)
              : CHUNK_DELAY_MS;
          if (offset < bytes.length && delay > 0) {
            await Bun.sleep(delay);
          }
        }
        log.completed = true;
        controller.close();
      },
      cancel(reason) {
        log.cancelled = true;
        log.cancelReason = reason;
      },
    });

    request.signal.addEventListener('abort', () => {
      log.cancelled = true;
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    });
  }

  return app.fetch(request);
};

// --- Fresh Node stdio MCP caller --------------------------------------------

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
      RELIC_CLIENT_NAME: 'relic-mcp/load-progress-path',
      RELIC_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
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
    .filter((l) => l.trim().length > 0);
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

// --- Fixture Generators -----------------------------------------------------

function buildPngBuffer(width = 200, height = 150): Buffer {
  function makeChunk(type: string, data: Buffer): Buffer {
    const len = data.length;
    const chunk = Buffer.alloc(4 + 4 + len + 4);
    chunk.writeUInt32BE(len, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    let c = 0xffffffff;
    const sub = chunk.subarray(4, 8 + len);
    for (let i = 0; i < sub.length; i++) {
      c ^= sub[i]!;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + len);
    return chunk;
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const raw = Buffer.alloc(height * (1 + width * 3));
  const rand = randomBytes(height * width * 3);
  let rIdx = 0;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 3);
    raw[rowOffset] = 0;
    rand.copy(raw, rowOffset + 1, rIdx, rIdx + width * 3);
    rIdx += width * 3;
  }
  const idat = makeChunk('IDAT', deflateSync(raw));
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idat, iend]);
}

function buildPdfBuffer(numPages = 15): Buffer {
  let out = '%PDF-1.4\n';
  const offsets = [0];
  offsets.push(out.length);
  out += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  offsets.push(out.length);
  const kids: string[] = [];
  for (let p = 0; p < numPages; p++) kids.push(`${3 + p * 2} 0 R`);
  out += `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${numPages} >>\nendobj\n`;
  for (let p = 0; p < numPages; p++) {
    const pageObjNum = 3 + p * 2;
    const contentObjNum = pageObjNum + 1;
    offsets.push(out.length);
    out += `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>\nendobj\n`;
    let pageText = 'BT /F1 14 Tf 16 TL 50 750 Td ';
    for (let l = 0; l < 50; l++) {
      pageText += `(Page ${p + 1} Line ${l}: Relik PDF progressive loading proof verification text line.) ' `;
    }
    pageText += 'ET';
    offsets.push(out.length);
    out += `${contentObjNum} 0 obj\n<< /Length ${pageText.length} >>\nstream\n${pageText}\nendstream\nendobj\n`;
  }
  const xrefOffset = out.length;
  const totalObjs = 2 + numPages * 2;
  out += `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out);
}

function makeWavBuffer(numSeconds = 1.5, sampleRate = 44100): Buffer {
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const numSamples = Math.floor(numSeconds * sampleRate);
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0x7fff;
    buf.writeInt16LE(sample, 44 + i * 4);
    buf.writeInt16LE(sample, 44 + i * 4 + 2);
  }
  return buf;
}

// --- Pixel Non-Uniformity Checker -------------------------------------------

function isRegionNonUniform(
  pngBuffer: Buffer,
  minY: number,
  maxY: number
): boolean {
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  let pos = 8;
  const idats: Buffer[] = [];
  while (pos < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(pos);
    const type = pngBuffer.subarray(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') idats.push(pngBuffer.subarray(pos + 8, pos + 8 + len));
    pos += 8 + len + 4;
  }
  const decompressed = inflateSync(Buffer.concat(idats));
  const rowBytes = 1 + width * 4;
  const vals = new Set<number>();
  for (let y = minY; y < Math.min(maxY, height); y++) {
    const rowOffset = y * rowBytes + 1;
    for (let x = 0; x < width * 4; x += 4) {
      const r = decompressed[rowOffset + x]!;
      const g = decompressed[rowOffset + x + 1]!;
      const b = decompressed[rowOffset + x + 2]!;
      vals.add((r << 16) | (g << 8) | b);
      if (vals.size > 1) return true;
    }
  }
  return vals.size > 1;
}

// --- Isolated World Recorder Script -----------------------------------------

const RECORDER_SOURCE = `(() => {
  const samples = [];
  const renderEvents = [];
  const progressEvents = [];
  let sampling = true;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function recordNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches?.('.render-status, [data-render-status]') || node.querySelector?.('.render-status, [data-render-status]')) {
      const pill = node.matches?.('.render-status, [data-render-status]') ? node : node.querySelector?.('.render-status, [data-render-status]');
      renderEvents.push({ kind: 'pill', text: (pill?.textContent || '').trim(), time: performance.now() });
    }
    const stage = node.matches?.('main.stage, .stage') ? node : node.querySelector?.('main.stage, .stage');
    if (stage) {
      const state = stage.getAttribute('data-render-state');
      if (state) {
        renderEvents.push({ kind: 'state', state, time: performance.now() });
      }
    }
    const dead = node.matches?.('main.stage-dead .card, .stage.stage-dead .card, main.stage-dead, .card.dead-card')
      ? node
      : node.querySelector?.('main.stage-dead .card, .stage.stage-dead .card, main.stage-dead, .card.dead-card');
    if (dead) {
      renderEvents.push({ kind: 'dead', time: performance.now() });
    }
    const plate = node.matches?.('[data-load-plate]') ? node : node.querySelector?.('[data-load-plate]');
    if (plate) {
      const phase = plate.getAttribute('data-load-phase');
      if (phase) {
        progressEvents.push({ kind: 'phase', phase, time: performance.now() });
      }
    }
    const meter = node.matches?.('.load-meter, [role="progressbar"]') ? node : node.querySelector?.('.load-meter, [role="progressbar"]');
    if (meter) {
      const valuenow = meter.getAttribute('aria-valuenow');
      const valuetext = meter.getAttribute('aria-valuetext');
      if (valuenow !== null) {
        progressEvents.push({ kind: 'valuenow', valuenow, valuetext, time: performance.now() });
      }
      if (valuetext !== null) {
        progressEvents.push({ kind: 'valuetext', valuenow, valuetext, time: performance.now() });
      }
    }
    const custody = node.matches?.('[data-load-custody], header.bar .identity .filename')
      ? node
      : node.querySelector?.('[data-load-custody], header.bar .identity .filename');
    if (custody) {
      const text = (custody.textContent || '').trim();
      if (text.length > 0) {
        progressEvents.push({ kind: 'custody', text, time: performance.now() });
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(recordNode);
        if (m.target && m.target.nodeType === 1) {
          if (m.target.matches?.('.render-status, [data-render-status]')) {
            renderEvents.push({ kind: 'pill', text: (m.target.textContent || '').trim(), time: performance.now() });
          }
          if (m.target.matches?.('[data-load-custody], header.bar .identity .filename')) {
            const text = (m.target.textContent || '').trim();
            if (text.length > 0) {
              progressEvents.push({ kind: 'custody', text, time: performance.now() });
            }
          }
        }
      } else if (m.type === 'attributes') {
        const el = m.target;
        if (!el || el.nodeType !== 1) continue;

        if (m.attributeName === 'data-render-state') {
          const state = el.getAttribute('data-render-state');
          if (state) {
            renderEvents.push({ kind: 'state', state, time: performance.now() });
          }
        } else if (m.attributeName === 'data-render-status') {
          renderEvents.push({ kind: 'pill', text: (el.textContent || '').trim(), time: performance.now() });
        } else if (m.attributeName === 'class') {
          if (el.matches?.('.render-status, [data-render-status]')) {
            renderEvents.push({ kind: 'pill', text: (el.textContent || '').trim(), time: performance.now() });
          }
          if (el.matches?.('main.stage-dead, .stage.stage-dead')) {
            renderEvents.push({ kind: 'dead', time: performance.now() });
          }
        } else if (m.attributeName === 'aria-valuenow') {
          const valuenow = el.getAttribute('aria-valuenow');
          const valuetext = el.getAttribute('aria-valuetext');
          progressEvents.push({
            kind: 'valuenow',
            valuenow,
            valuetext,
            time: performance.now(),
          });
        } else if (m.attributeName === 'aria-valuetext') {
          const valuenow = el.getAttribute('aria-valuenow');
          const valuetext = el.getAttribute('aria-valuetext');
          progressEvents.push({
            kind: 'valuetext',
            valuenow,
            valuetext,
            time: performance.now(),
          });
        } else if (m.attributeName === 'data-load-phase') {
          const phase = el.getAttribute('data-load-phase');
          if (phase) {
            progressEvents.push({
              kind: 'phase',
              phase,
              time: performance.now(),
            });
          }
        }
      } else if (m.type === 'characterData') {
        const parent = m.target.parentElement;
        if (parent?.matches?.('.render-status, [data-render-status]')) {
          renderEvents.push({ kind: 'pill', text: (parent.textContent || '').trim(), time: performance.now() });
        }
        if (parent?.matches?.('[data-load-custody], header.bar .identity .filename')) {
          const text = (parent.textContent || '').trim();
          if (text.length > 0) {
            progressEvents.push({ kind: 'custody', text, time: performance.now() });
          }
        }
      }
    }
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: [
      'data-render-state',
      'data-render-status',
      'class',
      'aria-valuenow',
      'aria-valuetext',
      'data-load-phase',
    ],
  });

  if (document.documentElement) {
    recordNode(document.documentElement);
  }
  function doSample() {
    if (window.top !== window) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      if (sampling) requestAnimationFrame(doSample);
      return;
    }
    const body = document.body;
    if (body) {
      const bar = document.querySelector('header.bar');
      const plate = document.querySelector('[data-load-plate]');
      const meter = plate ? plate.querySelector('.load-meter, [role="progressbar"]') : null;
      const custody = document.querySelector('[data-load-custody], header.bar .identity .filename');
      const pill = document.querySelector('.render-status, [data-render-status]');
      const contentStage = document.querySelector('main.stage:not(.stage-loading):not(.stage-dead), .stage-wrap');
      const deadCard = document.querySelector('main.stage-dead .card, .stage.stage-dead .card, main.stage-dead');

      samples.push({
        time: performance.now(),
        bodyPresent: true,
        barVisible: isVisible(bar),
        plateVisible: isVisible(plate),
        platePhase: plate ? (plate.getAttribute('data-load-phase') || null) : null,
        meterValuenow: meter ? meter.getAttribute('aria-valuenow') : null,
        custodyText: custody ? (custody.textContent || '').trim() : null,
        renderPillVisible: isVisible(pill),
        renderPillText: pill ? (pill.textContent || '').trim() : null,
        contentStageVisible: isVisible(contentStage),
        deadCardVisible: isVisible(deadCard),
        scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
        innerWidth: window.innerWidth,
        url: location.href,
      });
    } else {
      samples.push({
        time: performance.now(),
        bodyPresent: false,
        barVisible: false,
        plateVisible: false,
        platePhase: null,
        meterValuenow: null,
        custodyText: null,
        renderPillVisible: false,
        renderPillText: null,
        contentStageVisible: false,
        deadCardVisible: false,
        scrollWidth: 0,
        innerWidth: window.innerWidth,
      });
    }

    if (sampling) {
      requestAnimationFrame(doSample);
    }
  }

  doSample();
  window.__relicLoadSamples = samples;
  window.__relicRenderEvents = renderEvents;
  window.__relicProgressEvents = progressEvents;
  window.__stopRelicLoadSampling = () => {
    sampling = false;
    observer.disconnect();
    return { samples, renderEvents, progressEvents };
  };
})();`;

// --- Fixture Publishing -----------------------------------------------------

interface FixtureInfo {
  readonly classKey: string;
  readonly filename: string;
  readonly path: string;
  relicId: string;
  key: string;
  shareUrl: string;
  bytesLength: number;
}

const fixtures: FixtureInfo[] = [
  {
    classKey: 'md',
    filename: 'report.md',
    path: join(scratch, 'report.md'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'ts',
    filename: 'sample.ts',
    path: join(scratch, 'sample.ts'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'png',
    filename: 'image.png',
    path: join(scratch, 'image.png'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'svg',
    filename: 'logo.svg',
    path: join(scratch, 'logo.svg'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'html',
    filename: 'page.html',
    path: join(scratch, 'page.html'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'jsx',
    filename: 'Widget.jsx',
    path: join(scratch, 'Widget.jsx'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'pdf',
    filename: 'doc.pdf',
    path: join(scratch, 'doc.pdf'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'mp4',
    filename: 'clip.mp4',
    path: join(scratch, 'clip.mp4'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'wav',
    filename: 'tone.wav',
    path: join(scratch, 'tone.wav'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'otio',
    filename: 'standard-sample.otiod',
    path: otioFixtureDir,
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'zip',
    filename: 'bundle.zip',
    path: join(scratch, 'bundle.zip'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'bin',
    filename: 'blob.bin',
    path: join(scratch, 'blob.bin'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'obj',
    filename: 'model.obj',
    path: join(scratch, 'model.obj'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'stl',
    filename: 'model.stl',
    path: join(scratch, 'model.stl'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
  {
    classKey: 'binary-stl',
    filename: 'binary.stl',
    path: join(scratch, 'binary.stl'),
    relicId: '',
    key: '',
    shareUrl: '',
    bytesLength: 0,
  },
];

console.log('Generating test fixtures...');

// 1. md
const mdLines = [
  '# Relik Load Progress Report\n\nExecutive summary of loading telemetry.\n',
];
for (let i = 0; i < 2000; i++) {
  mdLines.push(
    `## Heading ${i}\nParagraph of text describing report metrics and progress testing content for verification.\n`
  );
}
await writeFile(fixtures[0]!.path, mdLines.join('\n'));

// 2. ts
const tsLines = ['export function computeMetrics() {\n'];
for (let i = 0; i < 1500; i++) {
  tsLines.push(
    `  const metric_${i} = ${i} * 42;\n  console.log(metric_${i});\n`
  );
}
tsLines.push('}\n');
await writeFile(fixtures[1]!.path, tsLines.join('\n'));

// 3. png
await writeFile(fixtures[2]!.path, buildPngBuffer(200, 150));

// 4. svg
const svgLines = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900">\n<rect width="100%" height="100%" fill="#161b22"/>\n',
];
for (let i = 0; i < 500; i++) {
  svgLines.push(
    `<circle cx="${(i * 17) % 1400}" cy="${(i * 23) % 850}" r="${(i % 30) + 5}" fill="hsl(${i % 360}, 70%, 50%)"/>\n`
  );
}
svgLines.push('</svg>\n');
await writeFile(fixtures[3]!.path, svgLines.join('\n'));

// 5. html
const htmlLines = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>HTML Document</title></head><body><h1>Loaded HTML Document</h1>\n',
];
for (let i = 0; i < 1000; i++) {
  htmlLines.push(
    `<p>Section ${i}: Standard sandboxed HTML document content for progressive loading proof.</p>\n`
  );
}
htmlLines.push('</body></html>\n');
await writeFile(fixtures[4]!.path, htmlLines.join('\n'));

// 6. jsx
const jsxLines = [
  'export default function Widget() {\n  return (\n    <div style={{ padding: "32px", fontFamily: "sans-serif" }}>\n      <h1>Interactive JSX Component</h1>\n',
];
for (let i = 0; i < 1000; i++) {
  jsxLines.push(
    `      <div key={${i}}>Item ${i}: Detailed description of widget item.</div>\n`
  );
}
jsxLines.push('    </div>\n  );\n}\n');
await writeFile(fixtures[5]!.path, jsxLines.join('\n'));

// 7. pdf
await writeFile(fixtures[6]!.path, buildPdfBuffer(15));

// 8. mp4
await execFileAsync('ffmpeg', [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x240:rate=10',
  '-t',
  '2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixtures[7]!.path,
]);

// 9. wav
await writeFile(fixtures[8]!.path, makeWavBuffer(1.5, 44100));

// 10. otio (uses otioFixtureDir)

// 11. zip
const zipDir = join(scratch, 'zip-src');
await mkdir(join(zipDir, 'dir'), { recursive: true });
for (let i = 0; i < 50; i++) {
  await writeFile(
    join(zipDir, 'dir', `file-${i}.txt`),
    `File ${i} contents with padding text to make the zip bundle sufficiently sized for progress.\n`.repeat(
      20
    )
  );
}
await execFileAsync('zip', ['-q', '-r', fixtures[10]!.path, '.'], {
  cwd: zipDir,
});

// 12. bin
await writeFile(fixtures[11]!.path, randomBytes(65536));

await writeFile(
  fixtures[12]!.path,
  'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 3 1 4\n'
);
await writeFile(
  fixtures[13]!.path,
  'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n'
);
const binaryStl = Buffer.alloc(134);
binaryStl.writeUInt32LE(1, 80);
binaryStl.writeFloatLE(1, 104);
binaryStl.writeFloatLE(1, 120);
await writeFile(fixtures[14]!.path, binaryStl);

// 6 MB random bin for early cancel measurement
const sixMbBinPath = join(scratch, 'large.bin');
await writeFile(sixMbBinPath, randomBytes(6 * 1024 * 1024));

console.log('Publishing 15 fixtures through stdio relic-mcp...');
for (const fix of fixtures) {
  const res = await callMcp('relic_publish', {
    path: fix.path,
    cover: false,
    title: '',
  });
  const relicId = String(res['relic_id'] ?? '');
  const rawUrl = String(res['url'] ?? res['share_url'] ?? '');
  fix.relicId = relicId;
  fix.shareUrl = rawUrl;
  const hashIdx = rawUrl.indexOf('#');
  fix.key = hashIdx !== -1 ? rawUrl.slice(hashIdx + 1) : '';
  const stored = await storage.read(fix.relicId);
  fix.bytesLength = stored ? stored.length : 0;
}

// Publish 6 MB bin
console.log('Publishing 6 MB bin...');
const sixMbRes = await callMcp('relic_publish', {
  path: sixMbBinPath,
  cover: false,
  title: '',
});
const sixMbRawUrl = String(sixMbRes['url'] ?? sixMbRes['share_url'] ?? '');
const sixMbInfo = {
  relicId: String(sixMbRes['relic_id'] ?? ''),
  shareUrl: sixMbRawUrl,
  key: sixMbRawUrl.split('#')[1] ?? '',
  bytesLength: 6 * 1024 * 1024,
};

// Republish md to version 2
console.log('Republishing md to version 2...');
const mdV2Content =
  '# Version 2 Document\n\nUpdated contents for version switch proof.\n' +
  'New paragraph text for second edition.\n'.repeat(4000);
await writeFile(fixtures[0]!.path, mdV2Content);
const repubRes = await callMcp('relic_republish', {
  path: fixtures[0]!.path,
  relic_id: fixtures[0]!.relicId,
  notify: false,
  cover: false,
});
assert.equal(repubRes['version'], 2, 'md republish must advance to version 2');

// JSX comparison relic, kept outside `fixtures` (the run 1-9 set). v2 is
// published by republishing the same file, so both versions share one link.
const compareDir = join(scratch, 'compare-src');
await mkdir(compareDir, { recursive: true });
const comparePath = join(compareDir, 'Compare.jsx');
const compareJsx = (heading: string, items: string[]): string =>
  [
    'export default function Compare() {',
    '  return (',
    '    <div style={{ padding: "32px", fontFamily: "sans-serif" }}>',
    `      <h1>${heading}</h1>`,
    '      <ul>',
    ...items.map((item) => `        <li>${item}</li>`),
    '      </ul>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
await writeFile(
  comparePath,
  compareJsx('Relik JSX version one', ['Alpha', 'Beta'])
);
const compareRes = await callMcp('relic_publish', {
  path: comparePath,
  cover: false,
  title: '',
});
const compareRelicId = String(compareRes['relic_id'] ?? '');
const compareUrl = String(compareRes['url'] ?? compareRes['share_url'] ?? '');
assert.ok(
  compareRelicId !== '' && compareUrl.includes('#'),
  'JSX compare publish must return a relic id and key'
);
await writeFile(
  comparePath,
  compareJsx('Relik JSX version two', ['Alpha', 'Gamma'])
);
const compareRepub = await callMcp('relic_republish', {
  path: comparePath,
  relic_id: compareRelicId,
  notify: false,
  cover: false,
});
assert.equal(
  compareRepub['version'],
  2,
  'JSX compare republish must advance to version 2'
);

// --- Chrome Launch ----------------------------------------------------------

const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const chromeCandidate =
  process.env['RELIC_PROOF_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  (existsSync(defaultOwnedShell) ? defaultOwnedShell : undefined);

const foundChrome = await discoverChrome(chromeCandidate);
assert.equal(
  foundChrome.kind,
  'found',
  `Could not find headless Chrome: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');

const profileDir = await mkdtemp(join(tmpdir(), 'relic-load-chrome-'));
const sharedArgs = chromeArgs(foundChrome.path, profileDir);
const launch = createBrowserHeadlessLaunch(
  [
    ...sharedArgs.map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port};127.0.0.1:${usercontentService.port}`
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    ),
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-service-workers',
  ],
  profileDir
);

const child = spawn(foundChrome.path, launch.args, {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
const cdp = connectPipe(
  child.stdio[3] as unknown as Writable,
  child.stdio[4] as unknown as Readable
);
await attestBrowserHeadless(cdp, launch);

// A request rule for the browser proof. `times` fails the first N matching
// requests, or every matching request with 'all'. `hold` keeps a failing
// response unanswered until releaseHeld, so a proof can act while it waits.
interface BlockRule {
  urlPattern: string;
  times: number | 'all';
  hold?: boolean;
}

// Glob match for Fetch patterns, where `*` matches any run of characters.
function urlMatches(pattern: string, url: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(url);
}

// Helper to open a page session with recorder and assertions
interface OpenRunOptions {
  viewport?: { width: number; height: number; mobile?: boolean };
  colorScheme?: 'light' | 'dark';
  disableScripts?: boolean;
  blockViewerJs?: boolean;
  blocks?: BlockRule[];
  fixedWait?: boolean;
  bypassServiceWorker?: boolean;
  onBeforeNavigate?: (sessionId: string) => Promise<void>;
}
interface RenderEvent {
  kind: 'pill' | 'state' | 'dead';
  state?: string;
  text?: string;
  time: number;
}

interface ProgressEvent {
  kind: 'valuenow' | 'valuetext' | 'phase' | 'custody';
  valuenow?: string | null;
  valuetext?: string | null;
  phase?: string;
  text?: string;
  time: number;
}

interface Sample {
  time: number;
  bodyPresent: boolean;
  barVisible: boolean;
  plateVisible: boolean;
  platePhase: string | null;
  meterValuenow: string | null;
  custodyText: string | null;
  renderPillVisible: boolean;
  renderPillText: string | null;
  contentStageVisible: boolean;
  deadCardVisible: boolean;
  scrollWidth: number;
  innerWidth: number;
}

interface RunOutcome {
  targetId: string;
  sessionId: string;
  samples: Sample[];
  renderEvents: RenderEvent[];
  progressEvents: ProgressEvent[];
  firstProgressShot: Buffer | null;
  readyShot: Buffer | null;
  storageRequest: {
    requestId?: string | undefined;
    requestWillBeSent: boolean;
    responseReceived: boolean;
    dataReceivedBytes: number;
    encodedDataLength: number;
    loadingFinished: boolean;
    loadingFailed?: { errorText: string; canceled: boolean } | undefined;
  };
  blocks: Record<string, number>;
  navigationUrls: string[];
  setBlocks: (next: BlockRule[]) => void;
  releaseHeld: () => void;
  close: () => Promise<void>;
}

async function runRelicPage(
  url: string,
  options: OpenRunOptions = {}
): Promise<RunOutcome> {
  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const targetId = created.targetId;
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);
  await cdp.send('CSS.enable', {}, sessionId);
  await cdp.send(
    'Network.setCacheDisabled',
    { cacheDisabled: true },
    sessionId
  );
  if (options.bypassServiceWorker) {
    await cdp.send(
      'Network.setBypassServiceWorker',
      { bypass: true },
      sessionId
    );
  }

  const vp = options.viewport ?? { width: 1440, height: 900, mobile: false };
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.mobile ?? false,
    },
    sessionId
  );

  await cdp.send(
    'Emulation.setEmulatedMedia',
    {
      media: 'screen',
      features: [
        {
          name: 'prefers-color-scheme',
          value: options.colorScheme ?? 'light',
        },
      ],
    },
    sessionId
  );

  if (options.disableScripts) {
    await cdp.send(
      'Emulation.setScriptExecutionDisabled',
      { value: true },
      sessionId
    );
  }

  if (options.blockViewerJs) {
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*viewer.js*', requestStage: 'Request' }] },
      sessionId
    );
    cdp.onEvent((e) => {
      if (e.method === 'Fetch.requestPaused' && e.sessionId === sessionId) {
        const reqId = (e.params as { requestId: string }).requestId;
        void cdp
          .send(
            'Fetch.failRequest',
            { requestId: reqId, errorReason: 'BlockedByClient' },
            sessionId
          )
          .catch(() => {});
      }
    });
  }

  // Network rules fail matching requests and count what was really failed.
  // setBlocks swaps the rules mid-page; Fetch patterns stay as enabled here.
  let activeRules: BlockRule[] = options.blocks ?? [];
  const remaining = new Map<string, number | 'all'>();
  const resetRules = (next: BlockRule[]): void => {
    activeRules = next;
    remaining.clear();
    for (const rule of next) remaining.set(rule.urlPattern, rule.times);
  };
  resetRules(activeRules);
  const blocks: Record<string, number> = {};
  for (const rule of activeRules) blocks[rule.urlPattern] = 0;
  if (activeRules.length > 0) {
    await cdp.send(
      'Fetch.enable',
      {
        patterns: activeRules.map((rule) => ({
          urlPattern: rule.urlPattern,
          requestStage: 'Request',
        })),
      },
      sessionId
    );
  }
  const heldAnswers: Array<() => void> = [];
  const stopBlock = cdp.onEvent((e) => {
    if (e.method !== 'Fetch.requestPaused' || e.sessionId !== sessionId) return;
    const params = e.params as { requestId: string; request: { url: string } };
    const rule = activeRules.find((r) =>
      urlMatches(r.urlPattern, params.request.url)
    );
    const left =
      rule === undefined ? undefined : remaining.get(rule.urlPattern);
    const failIt = left === 'all' || (typeof left === 'number' && left > 0);
    if (rule !== undefined && failIt) {
      if (typeof left === 'number') remaining.set(rule.urlPattern, left - 1);
      blocks[rule.urlPattern] = (blocks[rule.urlPattern] ?? 0) + 1;
    }
    const answer = (): void => {
      void cdp
        .send(
          failIt ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          failIt
            ? { requestId: params.requestId, errorReason: 'BlockedByClient' }
            : { requestId: params.requestId },
          sessionId
        )
        .catch(() => {});
    };
    if (failIt && rule?.hold === true) heldAnswers.push(answer);
    else answer();
  });
  const releaseHeld = (): void => {
    for (const answer of heldAnswers.splice(0)) answer();
  };

  // Every main-frame navigation, so a proof counts reloads and checks what each
  // reloaded URL carried.
  const navigationUrls: string[] = [];
  const stopNav = cdp.onEvent((e) => {
    if (e.method !== 'Page.frameNavigated' || e.sessionId !== sessionId) return;
    const frame = (e.params as { frame: { url: string; parentId?: string } })
      .frame;
    if (frame.parentId === undefined && frame.url !== 'about:blank') {
      navigationUrls.push(frame.url);
    }
  });

  let isolatedContextId: number | undefined;
  const stopContextListener = cdp.onEvent((e) => {
    if (
      e.method === 'Runtime.executionContextCreated' &&
      e.sessionId === sessionId
    ) {
      const ctx = (e.params as { context: { id: number; name: string } })
        .context;
      if (ctx.name === 'relic-load-proof' && isolatedContextId === undefined) {
        isolatedContextId = ctx.id;
      }
    }
  });

  const storageReq = {
    requestId: undefined as string | undefined,
    requestWillBeSent: false,
    responseReceived: false,
    dataReceivedBytes: 0,
    encodedDataLength: 0,
    loadingFinished: false,
    loadingFailed: undefined as
      | { errorText: string; canceled: boolean }
      | undefined,
  };

  const stopNetListener = cdp.onEvent((e) => {
    if (e.sessionId !== sessionId) return;
    const params = e.params;
    if (!params || typeof params !== 'object') return;

    if (e.method === 'Network.requestWillBeSent') {
      if (
        'request' in params &&
        params.request &&
        typeof params.request === 'object' &&
        'url' in params.request
      ) {
        const reqUrl = String(params.request.url);
        if (reqUrl.includes('/__storage/o/')) {
          storageReq.requestId = String(params['requestId']);
          storageReq.requestWillBeSent = true;
        }
      }
    }
    if (e.method === 'Network.responseReceived') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.responseReceived = true;
      }
    }
    if (e.method === 'Network.dataReceived') {
      if (params['requestId'] === storageReq.requestId) {
        const dLen =
          typeof params['dataLength'] === 'number' ? params['dataLength'] : 0;
        const eLen =
          typeof params['encodedDataLength'] === 'number'
            ? params['encodedDataLength']
            : 0;
        storageReq.dataReceivedBytes += dLen || eLen;
        storageReq.encodedDataLength += eLen || dLen;
      }
    }
    if (e.method === 'Network.loadingFinished') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.loadingFinished = true;
      }
    }
    if (e.method === 'Network.loadingFailed') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.loadingFailed = {
          errorText: String(params['errorText'] ?? ''),
          canceled: params['canceled'] === true,
        };
      }
    }
  });

  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: RECORDER_SOURCE, worldName: 'relic-load-proof' },
    sessionId
  );

  if (options.onBeforeNavigate) {
    await options.onBeforeNavigate(sessionId);
  }

  console.log(`[DEBUG] Navigating to: ${url}`);
  const navRes = await cdp.send('Page.navigate', { url }, sessionId);
  console.log(`[DEBUG] Nav result:`, navRes);
  let firstProgressShot: Buffer | null = null;
  let readyShot: Buffer | null = null;

  // Poll for completion or settling
  if (!options.disableScripts && !options.blockViewerJs && !options.fixedWait) {
    const start = Date.now();
    let _settled = false;

    while (Date.now() - start < 30_000) {
      await Bun.sleep(25);
      if (isolatedContextId === undefined) continue;

      const evalRes = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const s = window.__relicLoadSamples || [];
              const latest = s[s.length - 1];
              const pe = window.__relicProgressEvents || [];
              return {
                len: s.length,
                hasValuenow: s.some(x => x.meterValuenow !== null) || pe.some(x => x.kind === 'valuenow' && x.valuenow !== null),
                latest
              };
            })()`,
            contextId: isolatedContextId,
            returnByValue: true,
          },
          sessionId
        )
        .catch(() => null)) as {
        result?: {
          value?: { len: number; hasValuenow: boolean; latest?: Sample };
        };
      } | null;

      const state = evalRes?.result?.value;
      if (!state?.latest) continue;

      // Capture first progress shot
      if (
        !firstProgressShot &&
        (state.hasValuenow || state.latest.platePhase === 'fetching')
      ) {
        const shot = (await cdp
          .send('Page.captureScreenshot', { format: 'png' }, sessionId)
          .catch(() => null)) as { data: string } | null;
        if (shot) firstProgressShot = Buffer.from(shot.data, 'base64');
      }

      // Check if ready or dead card
      if (
        (state.latest.contentStageVisible && !state.latest.renderPillVisible) ||
        state.latest.deadCardVisible
      ) {
        await Bun.sleep(100);
        const shot = (await cdp
          .send('Page.captureScreenshot', { format: 'png' }, sessionId)
          .catch(() => null)) as { data: string } | null;
        if (shot) readyShot = Buffer.from(shot.data, 'base64');
        _settled = true;
        break;
      }
    }
    if (!readyShot) {
      const shot = (await cdp
        .send('Page.captureScreenshot', { format: 'png' }, sessionId)
        .catch(() => null)) as { data: string } | null;
      if (shot) readyShot = Buffer.from(shot.data, 'base64');
    }
  } else {
    // For noscript or blocked viewer.js, let page load for 400ms
    await Bun.sleep(400);
    const shot = (await cdp
      .send('Page.captureScreenshot', { format: 'png' }, sessionId)
      .catch(() => null)) as { data: string } | null;
    if (shot) readyShot = Buffer.from(shot.data, 'base64');
  }

  // Retrieve samples, render events, and progress events
  let samples: Sample[] = [];
  let renderEvents: RenderEvent[] = [];
  let progressEvents: ProgressEvent[] = [];
  if (isolatedContextId !== undefined) {
    const rawResult = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            if (window.__stopRelicLoadSampling) {
              const res = window.__stopRelicLoadSampling();
              return Array.isArray(res)
                ? { samples: res, renderEvents: window.__relicRenderEvents || [], progressEvents: window.__relicProgressEvents || [] }
                : res;
            }
            return {
              samples: window.__relicLoadSamples || [],
              renderEvents: window.__relicRenderEvents || [],
              progressEvents: window.__relicProgressEvents || []
            };
          })()`,
          contextId: isolatedContextId,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => null)) as {
      result?: {
        value?:
          | {
              samples?: Sample[];
              renderEvents?: RenderEvent[];
              progressEvents?: ProgressEvent[];
            }
          | Sample[];
      };
    } | null;
    const val = rawResult?.result?.value;
    if (Array.isArray(val)) {
      samples = val;
    } else if (val) {
      samples = val.samples ?? [];
      renderEvents = val.renderEvents ?? [];
      progressEvents = val.progressEvents ?? [];
    }
  }

  return {
    targetId,
    sessionId,
    samples,
    renderEvents,
    progressEvents,
    firstProgressShot,
    readyShot,
    storageRequest: storageReq,
    blocks,
    navigationUrls,
    setBlocks: resetRules,
    releaseHeld,
    close: async () => {
      stopContextListener();
      stopBlock();
      stopNetListener();
      stopNav();
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };
}

// Evaluates in the page's main world and fails loudly on a script error.
async function evalMain<T = unknown>(
  sessionId: string,
  expression: string
): Promise<T> {
  const res = (await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId
  )) as { result?: { value?: T }; exceptionDetails?: unknown };
  assert.equal(
    res.exceptionDetails,
    undefined,
    `evaluate failed: ${expression.slice(0, 120)}`
  );
  return res.result?.value as T;
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Text of each usercontent frame inside `container`, read from an isolated
// world the way html-image-comments-path.ts does. Frames outside the container
// are ignored, so a stale frame cannot satisfy a check.
async function usercontentTexts(
  sessionId: string,
  container: string
): Promise<string[]> {
  const tree = (await cdp.send('Page.getFrameTree', {}, sessionId)) as {
    frameTree: { childFrames?: Array<{ frame: { id: string } }> };
  };
  const texts: string[] = [];
  for (const child of tree.frameTree.childFrames ?? []) {
    const frameId = child.frame.id;
    const owner = (await cdp
      .send('DOM.getFrameOwner', { frameId }, sessionId)
      .catch(() => null)) as { backendNodeId: number } | null;
    if (!owner) continue;
    const resolved = (await cdp
      .send(
        'DOM.resolveNode',
        { backendNodeId: owner.backendNodeId },
        sessionId
      )
      .catch(() => null)) as { object?: { objectId?: string } } | null;
    const objectId = resolved?.object?.objectId;
    if (!objectId) continue;
    const inside = (await cdp
      .send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function () { return this.closest(${JSON.stringify(container)}) !== null; }`,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => null)) as { result?: { value?: boolean } } | null;
    if (inside?.result?.value !== true) continue;
    const world = (await cdp.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'jsx-component-proof' },
      sessionId
    )) as { executionContextId: number };
    const read = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: 'document.body ? document.body.textContent || "" : ""',
          contextId: world.executionContextId,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => null)) as { result?: { value?: string } } | null;
    texts.push(read?.result?.value ?? '');
  }
  return texts;
}

// The one dist chunk carrying the lazily loaded compiler. Its markers are
// Sucrase option names; the shell-budget test asserts they sit in one chunk.
async function findCompilerChunk(dir: string): Promise<string> {
  const carriers: string[] = [];
  for (const name of await readdir(dir)) {
    if (!/^chunk-[^/]+\.js$/.test(name)) continue;
    const text = await readFile(join(dir, name), 'utf8');
    if (
      text.includes('enableLegacyTypeScriptModuleInterop') &&
      text.includes('jsxFragmentPragma')
    ) {
      carriers.push(name);
    }
  }
  assert.equal(
    carriers.length,
    1,
    `expected one compiler chunk in ${dir}, found ${carriers.length}`
  );
  return carriers[0]!;
}

// Check filtering args
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyFilter = onlyArg ? onlyArg.slice('--only='.length) : undefined;

let runsExecuted = 0;
const runSummary: Array<{
  name: string;
  durationMs: number;
  status: string;
  details?: unknown;
}> = [];

try {
  // =========================================================================
  // RUN 1: 15 fixtures at 1440x900 light
  // =========================================================================
  if (
    !onlyFilter ||
    onlyFilter === '1' ||
    onlyFilter === 'run1' ||
    onlyFilter === 'no-blank'
  ) {
    console.log('\n--- Run 1: 15 fixtures at 1440x900 light ---');

    for (const fix of fixtures) {
      const t0 = Date.now();
      const outcome = await runRelicPage(fix.shareUrl, {
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      runsExecuted++;

      const samples = outcome.samples;
      assert.ok(
        samples.length > 0,
        `Run 1 (${fix.classKey}): no samples recorded`
      );

      // 1. No blank frames
      for (const s of samples) {
        if (s.bodyPresent) {
          if (!s.barVisible) {
            console.log(
              `[DEBUG FAIL SAMPLE] (${fix.classKey}):`,
              JSON.stringify(s)
            );
          }
          assert.ok(
            s.barVisible,
            `no-blank check failed (${fix.classKey}): sample at t=${s.time.toFixed(1)} has body present but bar is not visible`
          );
          assert.ok(
            s.plateVisible ||
              s.contentStageVisible ||
              s.renderPillVisible ||
              s.deadCardVisible,
            `no-blank check failed (${fix.classKey}): sample at t=${s.time.toFixed(1)} has body present but neither plate, stage, pill, nor dead card is visible`
          );
        }
      }

      // 2. Phases arrive in order
      const recordedPhases: string[] = [];
      for (const e of outcome.progressEvents) {
        if (
          e.kind === 'phase' &&
          e.phase &&
          recordedPhases[recordedPhases.length - 1] !== e.phase
        ) {
          recordedPhases.push(e.phase);
        }
      }
      const samplePhases: string[] = [];
      for (const s of samples) {
        if (
          s.platePhase &&
          samplePhases[samplePhases.length - 1] !== s.platePhase
        ) {
          samplePhases.push(s.platePhase);
        }
      }
      const phases = recordedPhases.length > 0 ? recordedPhases : samplePhases;
      for (let i = 0; i < phases.length; i++) {
        if (i > 0) {
          const prev = phases[i - 1];
          const curr = phases[i];
          if (prev === 'decrypting' && curr === 'fetching') {
            assert.fail(
              `Phases out of order in ${fix.classKey}: ${phases.join(' -> ')}`
            );
          }
          if (prev === 'fetching' && curr === 'opening') {
            assert.fail(
              `Phases out of order in ${fix.classKey}: ${phases.join(' -> ')}`
            );
          }
        }
      }

      // 3. Multi-chunk distinct aria-valuenow
      if (fix.bytesLength >= 3 * CHUNK_SIZE) {
        const recordedValuenows = outcome.progressEvents
          .filter(
            (e) =>
              e.kind === 'valuenow' &&
              e.valuenow !== null &&
              e.valuenow !== undefined
          )
          .map((e) => e.valuenow as string);
        const sampleValuenows = samples
          .map((s) => s.meterValuenow)
          .filter((v): v is string => v !== null);
        const valuenows = new Set([...recordedValuenows, ...sampleValuenows]);
        assert.ok(
          valuenows.size >= 3,
          `Objects of 3+ chunks (${fix.classKey}, ${fix.bytesLength} B) must show >= 3 distinct aria-valuenow, saw ${valuenows.size}`
        );
      }
      // 4. Custody swaps to filename
      const recordedCustody = outcome.progressEvents
        .filter((e) => e.kind === 'custody' && !!e.text)
        .map((e) => e.text as string);
      const sampleCustody = samples
        .map((s) => s.custodyText)
        .filter((t): t is string => t !== null && t.length > 0);
      const custodyTexts =
        recordedCustody.length > 0 ? recordedCustody : sampleCustody;
      assert.ok(
        custodyTexts.length > 0 || sampleCustody.length > 0,
        `No custody text observed in ${fix.classKey}`
      );
      const allCustody = [...sampleCustody, ...recordedCustody];
      const initialCustody = sampleCustody[0] ?? recordedCustody[0];
      assert.ok(
        initialCustody?.includes('Opening') ||
          initialCustody?.includes(fix.filename),
        `Initial custody text unexpected: ${initialCustody}`
      );
      // Final custody text should include filename
      const expectedName = fix.filename.endsWith('.otiod')
        ? fix.filename.replace(/\.otiod$/, '.otioz')
        : fix.filename;
      const finalCustody = allCustody[allCustody.length - 1];
      assert.ok(
        finalCustody?.includes(expectedName) ||
          finalCustody?.includes(fix.filename),
        `Final custody text must be filename ${expectedName}, got: ${finalCustody}`
      );
      // 5. Rendering classes show the pill at least once before ready
      const renderingClasses = [
        'png',
        'svg',
        'html',
        'jsx',
        'pdf',
        'mp4',
        'wav',
        'otio',
        'obj',
        'stl',
        'binary-stl',
      ];
      if (renderingClasses.includes(fix.classKey)) {
        const sawPillInSamples = samples.some((s) => s.renderPillVisible);
        const sawPillInEvents = outcome.renderEvents.some(
          (e) => e.kind === 'pill'
        );
        const renderingObserved = outcome.renderEvents.some(
          (e) => e.kind === 'state' && e.state === 'rendering'
        );
        const sawPill =
          sawPillInSamples || sawPillInEvents || renderingObserved;
        assert.ok(
          sawPill,
          `Rendering class ${fix.classKey} must show the render pill at least once before ready`
        );
      }

      // 6. Screenshot pixel checks
      if (outcome.firstProgressShot) {
        await writeFile(
          join(proofDir, `01-${fix.classKey}-first-progress.png`),
          outcome.firstProgressShot
        );
        assert.ok(
          isRegionNonUniform(outcome.firstProgressShot, 0, 50),
          `first progress screenshot bar region must not be uniform (${fix.classKey})`
        );
        assert.ok(
          isRegionNonUniform(outcome.firstProgressShot, 60, 800),
          `first progress screenshot stage region must not be uniform (${fix.classKey})`
        );
      }
      assert.ok(
        outcome.readyShot,
        `Ready screenshot required for ${fix.classKey}`
      );
      await writeFile(
        join(proofDir, `01-${fix.classKey}-ready.png`),
        outcome.readyShot
      );
      assert.ok(
        isRegionNonUniform(outcome.readyShot, 0, 50),
        `ready screenshot bar region must not be uniform (${fix.classKey})`
      );
      assert.ok(
        isRegionNonUniform(outcome.readyShot, 60, 800),
        `ready screenshot stage region must not be uniform (${fix.classKey})`
      );

      if (['obj', 'stl', 'binary-stl'].includes(fix.classKey)) {
        const check = (await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const root = document.querySelector('.model-view[data-model-state]');
              const canvas = root?.querySelector('canvas');
              return { state: root?.getAttribute('data-model-state'), ready: root?.getAttribute('data-ready'), width: canvas?.width, height: canvas?.height, triangles: root?.querySelector('.model-measures')?.textContent };
            })()`,
            returnByValue: true,
          },
          outcome.sessionId
        )) as {
          result?: {
            value?: {
              state?: string;
              ready?: string;
              width?: number;
              height?: number;
              triangles?: string;
            };
          };
        };
        const model = check.result?.value;
        assert.equal(
          model?.ready,
          'true',
          `${fix.classKey}: model failed to draw: ${JSON.stringify(model)}`
        );
        assert.ok(
          (model?.width ?? 0) > 1 && (model?.height ?? 0) > 1,
          `${fix.classKey}: model canvas has no backing pixels`
        );
        assert.ok(
          model?.triangles?.includes('triangles'),
          `${fix.classKey}: mesh statistics missing`
        );
        if (fix.classKey === 'obj') {
          const boxResult = (await cdp.send(
            'Runtime.evaluate',
            {
              expression: `(() => { const r = document.querySelector('.model-canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()`,
              returnByValue: true,
            },
            outcome.sessionId
          )) as {
            result: {
              value: {
                x: number;
                y: number;
                width: number;
                height: number;
                scale: number;
              };
            };
          };
          const clip = boxResult.result.value;
          const capture = async () =>
            (await cdp.send(
              'Page.captureScreenshot',
              { format: 'png', clip },
              outcome.sessionId
            )) as { data: string };
          const before = await capture();
          const click = async (label: string) => {
            await cdp.send(
              'Runtime.evaluate',
              {
                expression: `new Promise(resolve => { document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}).click(); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`,
                awaitPromise: true,
              },
              outcome.sessionId
            );
          };
          await click('Orbit right');
          const rotated = await capture();
          assert.notEqual(
            rotated.data,
            before.data,
            'Orbit must change the rendered model pixels'
          );
          await click('Wireframe');
          const wireframe = await capture();
          assert.notEqual(
            wireframe.data,
            rotated.data,
            'Wireframe must change the rendered model pixels'
          );
          await click('Reset');
          await click('Solid');
          const reset = await capture();
          assert.equal(
            reset.data,
            before.data,
            'Reset and Solid must restore the original model view'
          );
        }
      }

      await outcome.close();
      const dur = Date.now() - t0;
      runSummary.push({
        name: `Run 1: ${fix.classKey} 1440x900 light`,
        durationMs: dur,
        status: 'pass',
      });
      console.log(
        `  ✓ ${fix.classKey.padEnd(5)} (${dur}ms, ${samples.length} frames, phases: ${phases.join('->') || 'synced'})`
      );
    }
  }

  // =========================================================================
  // RUN 2: documents, models and media at narrow viewport widths
  // =========================================================================
  if (!onlyFilter || onlyFilter === '2' || onlyFilter === 'run2') {
    console.log('\n--- Run 2: Mobile responsive viewports & themes ---');
    const run2Classes = [
      'md',
      'png',
      'pdf',
      'html',
      'otio',
      'bin',
      'obj',
      'stl',
      'binary-stl',
    ];
    const run2Fixtures = fixtures.filter((f) =>
      run2Classes.includes(f.classKey)
    );

    const configurations = [
      {
        name: '390-dark',
        viewport: { width: 390, height: 844, mobile: true },
        colorScheme: 'dark' as const,
      },
      {
        name: '320-light',
        viewport: { width: 320, height: 568, mobile: true },
        colorScheme: 'light' as const,
      },
    ];

    for (const cfg of configurations) {
      for (const fix of run2Fixtures) {
        const t0 = Date.now();
        const outcome = await runRelicPage(fix.shareUrl, {
          viewport: cfg.viewport,
          colorScheme: cfg.colorScheme,
        });
        runsExecuted++;

        const samples = outcome.samples;
        assert.ok(
          samples.length > 0,
          `Run 2 (${fix.classKey} ${cfg.name}): no samples recorded`
        );

        // No-blank rule
        for (const s of samples) {
          if (s.bodyPresent) {
            assert.ok(
              s.barVisible,
              `no-blank failed (${fix.classKey} ${cfg.name}): bar not visible`
            );
            assert.ok(
              s.plateVisible ||
                s.contentStageVisible ||
                s.renderPillVisible ||
                s.deadCardVisible,
              `no-blank failed (${fix.classKey} ${cfg.name}): neither plate nor stage visible`
            );
          }
        }

        // documentElement.scrollWidth <= innerWidth
        for (const s of samples) {
          if (s.scrollWidth > 0 && s.innerWidth > 0) {
            assert.ok(
              s.scrollWidth <= s.innerWidth,
              `Horizontal overflow defect in ${fix.classKey} at ${cfg.name}: scrollWidth=${s.scrollWidth} > innerWidth=${s.innerWidth}`
            );
          }
        }

        assert.ok(
          outcome.readyShot,
          `Ready screenshot missing for ${fix.classKey} ${cfg.name}`
        );
        await writeFile(
          join(proofDir, `02-${fix.classKey}-${cfg.name}.png`),
          outcome.readyShot
        );

        await outcome.close();
        const dur = Date.now() - t0;
        runSummary.push({
          name: `Run 2: ${fix.classKey} ${cfg.name}`,
          durationMs: dur,
          status: 'pass',
        });
        console.log(
          `  ✓ ${fix.classKey.padEnd(5)} ${cfg.name} (${dur}ms, no overflow)`
        );
      }
    }
  }

  // =========================================================================
  // RUN 3: Wrong key on 6 MB bin (early cancel & recovery)
  // =========================================================================
  if (
    !onlyFilter ||
    onlyFilter === '3' ||
    onlyFilter === 'run3' ||
    onlyFilter === 'wrong-key'
  ) {
    console.log(
      '\n--- Run 3: Wrong key on 6 MB bin (< 262,144 bytes cancel) ---'
    );
    const t0 = Date.now();

    // Invert one character of key (preserving r1 prefix if present)
    const rightKey = sixMbInfo.key;
    assert.ok(
      rightKey.startsWith('r1')
        ? rightKey.length === 24
        : rightKey.length === 22,
      `rightKey must have valid format, got length ${rightKey.length}`
    );
    const charIdx = rightKey.startsWith('r1') ? 2 : 0;
    const targetChar = rightKey[charIdx]!;
    const wrongChar = targetChar === 'A' ? 'B' : 'A';
    const wrongKey =
      rightKey.slice(0, charIdx) + wrongChar + rightKey.slice(charIdx + 1);
    const wrongUrl = `${origin}/${sixMbInfo.relicId}#${wrongKey}`;

    const _mintCountBefore = serverMintCount;
    const _storageGetsBefore = storageLogs.length;

    const outcome = await runRelicPage(wrongUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    runsExecuted++;

    // 1. could-not-be-opened card appeared
    const deadCardSaw =
      outcome.samples.some((s) => s.deadCardVisible) ||
      outcome.renderEvents.some((e) => e.kind === 'dead');
    assert.ok(
      deadCardSaw,
      'could-not-be-opened dead card must appear on wrong key'
    );

    // 2. Server storage log: request cancelled <= 262,144 bytes
    const serverLog = storageLogs[storageLogs.length - 1];
    assert.ok(serverLog, 'Server must have logged storage request');
    assert.ok(
      serverLog.cancelled,
      `Storage request must be cancelled on wrong key (server saw cancelled=${serverLog.cancelled})`
    );
    assert.ok(
      serverLog.enqueuedBytes <= 262_144,
      `wrong-key early cancel check failed: server enqueued ${serverLog.enqueuedBytes} bytes (expected <= 262144), client received ${outcome.storageRequest.dataReceivedBytes} bytes`
    );

    // 3. CDP Network.loadingFailed with canceled: true
    assert.ok(
      outcome.storageRequest.loadingFailed?.canceled,
      `CDP Network.loadingFailed must have canceled: true on wrong key, got: ${JSON.stringify(outcome.storageRequest.loadingFailed)}`
    );

    // 4. Client dataReceived byte sum <= 262,144
    const clientBytes =
      outcome.storageRequest.dataReceivedBytes ||
      outcome.storageRequest.encodedDataLength;
    assert.ok(
      clientBytes <= 262_144,
      `client dataReceived sum must be <= 262144 bytes, received ${clientBytes}`
    );

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '03-wrong-key-card.png'),
        outcome.readyShot
      );
    }

    // 5. Type right key in #relic-key-input and submit
    const mintBeforeSubmit = serverMintCount;
    const getsBeforeSubmit = storageLogs.length;

    await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const input = document.querySelector('#relic-key-input');
          if (!input) throw new Error('#relic-key-input not found');
          input.value = ${JSON.stringify(rightKey)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const form = document.querySelector('.key-entry-form');
          if (!form) throw new Error('.key-entry-form not found');
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`,
      },
      outcome.sessionId
    );

    // Wait for ready view to open
    let reopened = false;
    const reopenStart = Date.now();
    while (Date.now() - reopenStart < 30_000) {
      await Bun.sleep(50);
      const readyCheck = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const stage = document.querySelector('main.stage:not(.stage-loading):not(.stage-dead)');
              const download = document.querySelector('.doc-download');
              return !!(stage && download);
            })()`,
            returnByValue: true,
          },
          outcome.sessionId
        )
        .catch(() => null)) as { result?: { value?: boolean } } | null;

      if (readyCheck?.result?.value) {
        reopened = true;
        break;
      }
    }
    assert.ok(
      reopened,
      'Relic must open successfully after submitting right key'
    );

    // 6. Server mint count unchanged
    assert.equal(
      serverMintCount,
      mintBeforeSubmit,
      `server mint count must be unchanged after key entry submit (was ${mintBeforeSubmit}, now ${serverMintCount})`
    );

    // 7. Exactly 1 more storage GET
    assert.equal(
      storageLogs.length,
      getsBeforeSubmit + 1,
      `Must make exactly 1 more storage GET after key entry submit`
    );

    const reopenedShot = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      outcome.sessionId
    )) as { data: string };
    await writeFile(
      join(proofDir, '03-wrong-key-reopened.png'),
      Buffer.from(reopenedShot.data, 'base64')
    );

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 3: Wrong key early cancel & reopen',
      durationMs: dur,
      status: 'pass',
      details: {
        serverEnqueuedBytes: serverLog.enqueuedBytes,
        clientDataReceivedBytes: clientBytes,
      },
    });
    console.log(
      `  ✓ Cancelled at ${serverLog.enqueuedBytes} bytes, reopened on key entry (${dur}ms)`
    );
  }

  // =========================================================================
  // RUN 4: Mid-stream abort after 100 KB on md
  // =========================================================================
  if (!onlyFilter || onlyFilter === '4' || onlyFilter === 'run4') {
    console.log(
      '\n--- Run 4: Mid-stream abort on md (> 100 KB) & Try again ---'
    );
    const t0 = Date.now();
    const mdRelicId = fixtures[0]!.relicId;

    // Configure server abort after 100 KB on both v1 and v2 objectKeys
    activeAbortAfterBytes.set(mdRelicId, 100 * 1024);
    activeAbortAfterBytes.set(`${mdRelicId}/v2`, 100 * 1024);
    const outcome = await runRelicPage(fixtures[0]!.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    runsExecuted++;

    // Assert cut-short card appeared
    const deadCardSaw =
      outcome.samples.some((s) => s.deadCardVisible) ||
      outcome.renderEvents.some((e) => e.kind === 'dead');
    assert.ok(deadCardSaw, 'cut-short dead card must appear on aborted stream');

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '04-cut-short-card.png'),
        outcome.readyShot
      );
    }

    // Monitor for Page.frameNavigated (must NOT navigate)
    let frameNavigated = false;
    const stopNavListener = cdp.onEvent((e) => {
      if (
        e.method === 'Page.frameNavigated' &&
        e.sessionId === outcome.sessionId
      ) {
        frameNavigated = true;
      }
    });

    const mintBeforeRetry = serverMintCount;

    // Clear abort configuration so retry succeeds
    activeAbortAfterBytes.delete(mdRelicId);
    activeAbortAfterBytes.delete(`${mdRelicId}/v2`);
    // Click Try again
    await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const btn = document.querySelector('[data-dead-action="retry"]');
          if (!btn) throw new Error('retry button not found');
          btn.click();
        })()`,
      },
      outcome.sessionId
    );

    // Wait for Markdown stage to render
    let retriedReady = false;
    const retryStart = Date.now();
    while (Date.now() - retryStart < 15_000) {
      await Bun.sleep(50);
      const check = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const stage = document.querySelector('main.stage:not(.stage-loading):not(.stage-dead)');
              const doc = document.querySelector('.doc');
              return !!(stage && doc);
            })()`,
            returnByValue: true,
          },
          outcome.sessionId
        )
        .catch(() => null)) as { result?: { value?: boolean } } | null;

      if (check?.result?.value) {
        retriedReady = true;
        break;
      }
    }
    assert.ok(retriedReady, 'Markdown relic must render after Try again');
    assert.equal(
      frameNavigated,
      false,
      'Try again must NOT trigger Page.frameNavigated'
    );
    assert.equal(
      serverMintCount,
      mintBeforeRetry,
      'Try again must reuse URL and NOT make a new mint'
    );

    stopNavListener();
    const retryShot = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      outcome.sessionId
    )) as { data: string };
    await writeFile(
      join(proofDir, '04-cut-short-retried-ready.png'),
      Buffer.from(retryShot.data, 'base64')
    );

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 4: Mid-stream abort & Try again in place',
      durationMs: dur,
      status: 'pass',
    });
    console.log(
      `  ✓ Stream aborted at 100 KB, retried in place without navigation (${dur}ms)`
    );
  }

  // =========================================================================
  // RUN 5: Byte flipped in record 2 of stored object (content_damaged)
  // =========================================================================
  if (!onlyFilter || onlyFilter === '5' || onlyFilter === 'run5') {
    console.log('\n--- Run 5: Byte flipped in record 2 (content_damaged) ---');
    const t0 = Date.now();

    // Use tone.wav which has > 3 records
    const wavRelicId = fixtures[8]!.relicId;
    const rawStored = await storage.read(wavRelicId);
    assert.ok(rawStored, 'wav relic bytes must be stored');
    const originalBytes = new Uint8Array(rawStored);
    const corrupted = new Uint8Array(originalBytes);
    // Flip byte in record 2 (record 0 = 21..65557, record 1 = 65557..131093, record 2 = 131093..)
    const flipIdx = 21 + 2 * 65536 + 10;
    corrupted[flipIdx] = (corrupted[flipIdx] ?? 0) ^ 0x01;
    storage.put(wavRelicId, corrupted);

    const outcome = await runRelicPage(fixtures[8]!.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    runsExecuted++;

    // Restore original bytes
    storage.put(wavRelicId, originalBytes);

    const cardDetails = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const card = document.querySelector('main.stage-dead .card');
          const accession = document.querySelector('main.stage-dead .card .accession')?.textContent;
          const retryBtn = document.querySelector('[data-dead-action="retry"]');
          const reportLink = document.querySelector('[data-dead-action="report"]');
          const keyEntry = document.querySelector('.key-entry');
          return {
            hasCard: !!card,
            accession,
            hasRetry: !!retryBtn,
            hasReport: !!reportLink,
            hasKeyEntry: !!keyEntry
          };
        })()`,
        returnByValue: true,
      },
      outcome.sessionId
    )) as {
      result?: {
        value?: {
          hasCard: boolean;
          accession?: string;
          hasRetry: boolean;
          hasReport: boolean;
          hasKeyEntry: boolean;
        };
      };
    };

    const details = cardDetails.result?.value;
    assert.ok(details?.hasCard, 'Damaged card must be visible');
    assert.equal(
      details?.accession,
      'content_damaged',
      `Accession code must be content_damaged, got: ${details?.accession}`
    );
    assert.equal(details?.hasRetry, true, 'Retry action must be present');
    assert.equal(details?.hasReport, true, 'Report action must be present');
    assert.equal(
      details?.hasKeyEntry,
      false,
      'Key entry must NOT be present on content_damaged'
    );

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '05-damaged-flipped-byte-card.png'),
        outcome.readyShot
      );
    }

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 5: Byte flipped in record 2',
      durationMs: dur,
      status: 'pass',
    });
    console.log(
      `  ✓ Damaged card correctly rendered with content_damaged (${dur}ms)`
    );
  }

  // =========================================================================
  // RUN 6: Stored object missing last record (content_damaged)
  // =========================================================================
  if (!onlyFilter || onlyFilter === '6' || onlyFilter === 'run6') {
    console.log(
      '\n--- Run 6: Stored object missing last record (content_damaged) ---'
    );
    const t0 = Date.now();

    const wavRelicId = fixtures[8]!.relicId;
    const rawStored = await storage.read(wavRelicId);
    assert.ok(rawStored, 'wav relic bytes must be stored');
    const originalBytes = new Uint8Array(rawStored);
    const truncated = originalBytes.subarray(0, originalBytes.length - 65536);
    storage.put(wavRelicId, truncated);

    const outcome = await runRelicPage(fixtures[8]!.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    runsExecuted++;

    // Restore original bytes
    storage.put(wavRelicId, originalBytes);

    const cardDetails = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const card = document.querySelector('main.stage-dead .card');
          const accession = document.querySelector('main.stage-dead .card .accession')?.textContent;
          return { hasCard: !!card, accession };
        })()`,
        returnByValue: true,
      },
      outcome.sessionId
    )) as { result?: { value?: { hasCard: boolean; accession?: string } } };

    assert.ok(
      cardDetails.result?.value?.hasCard,
      'Damaged card must appear on truncated object'
    );
    assert.equal(
      cardDetails.result?.value?.accession,
      'content_damaged',
      'Truncated container must yield content_damaged card'
    );

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '06-damaged-truncated-card.png'),
        outcome.readyShot
      );
    }

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 6: Missing last record truncated container',
      durationMs: dur,
      status: 'pass',
    });
    console.log(`  ✓ Truncated object refused with damaged card (${dur}ms)`);
  }

  // =========================================================================
  // RUN 7: Emulation.setScriptExecutionDisabled({ value: true })
  // =========================================================================
  if (!onlyFilter || onlyFilter === '7' || onlyFilter === 'run7') {
    console.log('\n--- Run 7: Script execution disabled (noscript plate) ---');
    const t0 = Date.now();
    const mintBefore = serverMintCount;

    const outcome = await runRelicPage(fixtures[0]!.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      disableScripts: true,
    });
    runsExecuted++;

    // 1. mint count 0
    assert.equal(
      serverMintCount,
      mintBefore,
      'Server mint count must be 0 when scripts disabled'
    );

    // 2. Query DOM via CDP DOM/CSS domains
    const doc = (await cdp.send('DOM.getDocument', {}, outcome.sessionId)) as {
      root: { nodeId: number };
    };

    // Check .stage-loading is hidden via CSS
    const loadingNode = (await cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: '.stage-loading' },
      outcome.sessionId
    )) as { nodeId: number };

    if (loadingNode.nodeId !== 0) {
      const styles = (await cdp.send(
        'CSS.getComputedStyleForNode',
        { nodeId: loadingNode.nodeId },
        outcome.sessionId
      )) as { computedStyle: Array<{ name: string; value: string }> };
      const display = styles.computedStyle.find(
        (s) => s.name === 'display'
      )?.value;
      assert.equal(
        display,
        'none',
        '.stage-loading must have display: none in noscript'
      );
    }

    // Check noscript card is in DOM
    const noscriptNode = (await cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: 'noscript' },
      outcome.sessionId
    )) as { nodeId: number };
    assert.ok(noscriptNode.nodeId !== 0, 'noscript element must be in DOM');

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '07-noscript-card.png'),
        outcome.readyShot
      );
    }

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 7: Noscript execution disabled',
      durationMs: dur,
      status: 'pass',
    });
    console.log(
      `  ✓ Noscript card rendered, .stage-loading hidden, 0 mints (${dur}ms)`
    );
  }

  // =========================================================================
  // RUN 8: Fetch.enable failing viewer.js with BlockedByClient
  // =========================================================================
  if (!onlyFilter || onlyFilter === '8' || onlyFilter === 'run8') {
    console.log('\n--- Run 8: viewer.js blocked (static plate visible) ---');
    const t0 = Date.now();
    await Bun.sleep(100);
    const targetFix = fixtures[1]!;
    const relicMintBefore = relicMintCounts.get(targetFix.relicId) ?? 0;
    const mintBefore = serverMintCount;

    const outcome = await runRelicPage(targetFix.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      blockViewerJs: true,
    });
    runsExecuted++;

    // 1. mint count 0
    assert.equal(
      relicMintCounts.get(targetFix.relicId) ?? 0,
      relicMintBefore,
      'Relic mint count must be 0 when viewer.js blocked'
    );
    assert.equal(
      serverMintCount,
      mintBefore,
      'Server mint count must be 0 when viewer.js blocked'
    );
    // 2. Static plate is visible with Opening…
    const plateCheck = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const plate = document.querySelector('[data-load-plate]');
          const phase = document.querySelector('.load-phase')?.textContent;
          const policy = document.querySelector('a[href*="/policy"]');
          const abuse = document.querySelector('a[href*="/abuse"]');
          return {
            hasPlate: !!plate,
            phase,
            hasPolicy: !!policy,
            hasAbuse: !!abuse
          };
        })()`,
        returnByValue: true,
      },
      outcome.sessionId
    )) as {
      result?: {
        value?: {
          hasPlate: boolean;
          phase?: string;
          hasPolicy: boolean;
          hasAbuse: boolean;
        };
      };
    };

    const pv = plateCheck.result?.value;
    assert.ok(pv?.hasPlate, 'Static plate must be present in HTML shell');
    assert.equal(pv?.phase, 'Opening…', 'Static plate must show Opening…');
    assert.ok(
      pv?.hasPolicy && pv?.hasAbuse,
      'Policy and abuse links must be present'
    );

    if (outcome.readyShot) {
      await writeFile(
        join(proofDir, '08-blocked-viewer-static-plate.png'),
        outcome.readyShot
      );
    }

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 8: Blocked viewer.js static plate',
      durationMs: dur,
      status: 'pass',
    });
    console.log(`  ✓ Static plate visible with Opening…, 0 mints (${dur}ms)`);
  }

  // =========================================================================
  // RUN 9: Version switch on republished md
  // =========================================================================
  if (!onlyFilter || onlyFilter === '9' || onlyFilter === 'run9') {
    console.log('\n--- Run 9: Version switch on republished md ---');
    const t0 = Date.now();

    // fixtures[0] was republished to v2. Open it:
    const outcome = await runRelicPage(fixtures[0]!.shareUrl, {
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    runsExecuted++;

    // Assert v2 is currently ready
    const v2StageText = (await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          "document.querySelector('main.stage:not(.stage-loading):not(.stage-dead)')?.textContent || ''",
        returnByValue: true,
      },
      outcome.sessionId
    )) as { result?: { value?: string } };

    assert.ok(
      v2StageText.result?.value?.includes('Version 2 Document'),
      'Initial render must be version 2'
    );

    // Click version 1 option
    await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const opt = document.querySelector('.version-option[data-version="1"]');
          if (!opt) throw new Error('version 1 option not found');
          opt.click();
        })()`,
      },
      outcome.sessionId
    );

    // During loading, current stage must stay visible while status pill shows
    let sawStageDuringLoad = false;
    let sawPillOpening = false;
    let sawPillFetching = false;
    let v1Rendered = false;

    const v1Start = Date.now();
    while (Date.now() - v1Start < 15_000) {
      await Bun.sleep(20);
      const state = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const stage = document.querySelector('main.stage:not(.stage-loading):not(.stage-dead)');
              const pill = document.querySelector('.render-status, [data-render-status]');
              const pillText = pill?.textContent || '';
              const stageText = stage?.textContent || '';
              return {
                hasStage: !!stage,
                pillText,
                stageText
              };
            })()`,
            returnByValue: true,
          },
          outcome.sessionId
        )
        .catch(() => null)) as {
        result?: {
          value?: { hasStage: boolean; pillText: string; stageText: string };
        };
      } | null;

      const val = state?.result?.value;
      if (!val) continue;

      if (val.hasStage && val.pillText.length > 0) {
        sawStageDuringLoad = true;
      }
      if (val.pillText.includes('Opening version 1')) {
        sawPillOpening = true;
      }
      if (
        val.pillText.includes('Version 1: Fetching') ||
        val.pillText.includes('Fetching')
      ) {
        sawPillFetching = true;
      }
      if (val.stageText.includes('Relik Load Progress Report')) {
        v1Rendered = true;
        break;
      }
    }

    assert.ok(
      sawStageDuringLoad,
      'Current stage must remain visible in DOM during version switch'
    );
    const pillEvents = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => window.__relicRenderEvents || [])()`,
          returnByValue: true,
        },
        outcome.sessionId
      )
      .catch(() => null)) as {
      result?: { value?: RenderEvent[] };
    } | null;
    const recordedPillEvents = pillEvents?.result?.value ?? [];
    const sawPillOpeningRecorded = recordedPillEvents.some(
      (e) => e.kind === 'pill' && e.text?.includes('Opening version 1')
    );
    const sawPillFetchingRecorded = recordedPillEvents.some(
      (e) =>
        e.kind === 'pill' &&
        (e.text?.includes('Version 1: Fetching') ||
          e.text?.includes('Fetching'))
    );

    assert.ok(
      sawPillOpening ||
        sawPillFetching ||
        sawPillOpeningRecorded ||
        sawPillFetchingRecorded,
      'Status pill must show version 1 progress'
    );
    assert.ok(v1Rendered, 'Version 1 content must render after loading');
    const v1Shot = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      outcome.sessionId
    )) as { data: string };
    await writeFile(
      join(proofDir, '09-version-switch-v1-ready.png'),
      Buffer.from(v1Shot.data, 'base64')
    );

    await outcome.close();
    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 9: Version switch v2 -> v1',
      durationMs: dur,
      status: 'pass',
    });
    console.log(
      `  ✓ Version switch smoothly preserved stage, showed status pill, and rendered v1 (${dur}ms)`
    );
  }

  // =========================================================================
  // RUN 10: JSX component relic (frame, comparison, compiler-load recovery)
  // =========================================================================
  if (
    !onlyFilter ||
    onlyFilter === '10' ||
    onlyFilter === 'run10' ||
    onlyFilter === 'jsx'
  ) {
    console.log(
      '\n--- Run 10: JSX component relic (frame, comparison, compiler-load recovery) ---'
    );
    const t0 = Date.now();
    const viewport = { width: 1440, height: 900 };
    const summaryExpr = `Array.from(document.querySelectorAll('.diff-summary span')).map((s) => s.textContent || '')`;

    // Steps 1 and 2 share one page: open v2, then open its comparison.
    const jsxRun = await runRelicPage(compareUrl, {
      viewport,
      colorScheme: 'light',
    });
    runsExecuted++;
    const jsxSid = jsxRun.sessionId;

    // Step 1: v2 renders in one sandboxed frame, without the source notice.
    await waitUntil(
      () =>
        evalMain<boolean>(
          jsxSid,
          `Boolean(document.querySelector('main.stage.stage-sandboxed-jsx[data-render-state="ready"]'))`
        ),
      30_000,
      'JSX stage to reach render state ready'
    );
    const sandboxFrames = await evalMain<number>(
      jsxSid,
      `document.querySelectorAll('iframe.usercontent-frame[sandbox="allow-scripts"]').length`
    );
    assert.equal(
      sandboxFrames,
      1,
      `JSX step 1: expected one sandboxed frame, found ${sandboxFrames}`
    );
    const stageText = await evalMain<string>(
      jsxSid,
      `document.querySelector('main.stage')?.textContent || ''`
    );
    assert.ok(
      !stageText.includes('do not compile'),
      'JSX step 1: the component must render, not show the do-not-compile notice'
    );
    let v2Texts: string[] = [];
    await waitUntil(
      async () => {
        v2Texts = await usercontentTexts(jsxSid, 'main.stage');
        return v2Texts.some((t) => t.includes('version two'));
      },
      15_000,
      'version two inside the rendered frame'
    );
    assert.ok(
      !v2Texts.some((t) => t.includes('This component could not be rendered.')),
      'JSX step 1: the frame reports a render failure'
    );
    const v2Shot = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      jsxSid
    )) as { data: string };
    await writeFile(
      join(proofDir, '10-jsx-v2-frame.png'),
      Buffer.from(v2Shot.data, 'base64')
    );
    console.log('JSX_STEP_1_FRAME_OK');

    // Step 2: the comparison frames both versions, each in its own pane.
    await evalMain(
      jsxSid,
      `(() => {
        const button = document.querySelector('.action-history');
        if (!button) throw new Error('action-history button missing');
        button.click();
        return true;
      })()`
    );
    await waitUntil(
      async () =>
        (await evalMain<number>(
          jsxSid,
          `document.querySelectorAll('.compare-pane iframe.usercontent-frame').length`
        )) === 2,
      30_000,
      'two comparison panes'
    );
    await waitUntil(
      async () => {
        const texts = await evalMain<string[]>(jsxSid, summaryExpr);
        return (
          texts.length > 0 &&
          texts.every((t) => t !== 'Rendering both versions.')
        );
      },
      30_000,
      'comparison summary to settle'
    );
    const summaryTexts = await evalMain<string[]>(jsxSid, summaryExpr);
    assert.ok(
      !summaryTexts.some((t) =>
        t.includes('could not read their rendered structure')
      ),
      `JSX step 2: comparison could not read rendered structure: ${summaryTexts.join(' | ')}`
    );
    let cmpTexts: string[] = [];
    await waitUntil(
      async () => {
        cmpTexts = await usercontentTexts(jsxSid, '.compare-pane');
        return (
          cmpTexts.length === 2 &&
          cmpTexts.some((t) => t.includes('version one')) &&
          cmpTexts.some((t) => t.includes('version two'))
        );
      },
      30_000,
      'both comparison frames to show their versions'
    );
    const cmpShot = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      jsxSid
    )) as { data: string };
    await writeFile(
      join(proofDir, '10-jsx-compare.png'),
      Buffer.from(cmpShot.data, 'base64')
    );
    console.log('JSX_STEP_2_COMPARE_OK panes=2');
    await jsxRun.close();

    // Step 3: a failed compiler fetch never shows damaged content or source.
    // The page reloads at most once. The vault supplies the key on reload, and
    // no reload carries the fragment. Each block is counted where it is
    // intercepted, so a case that blocks nothing cannot pass.
    const compilerPattern = `*${await findCompilerChunk(viewerDist)}*`;
    const probePattern = '*/assets/icon.svg*';
    const compareKey = compareUrl.split('#')[1] ?? '';
    assert.ok(
      compareKey !== '',
      'JSX step 3: the compare link must carry a key'
    );
    const readyExpr = `Boolean(document.querySelector('main.stage[data-render-state="ready"]'))`;
    const deadExpr = `Boolean(document.querySelector('main.stage.stage-dead'))`;
    const stateExpr = `(() => ({
      dead: document.querySelector('main.stage.stage-dead') !== null,
      accession: document.querySelector('main.stage-dead .card .accession')?.textContent || '',
      body: document.body?.textContent || '',
      stageCode: document.querySelector('.stage-code') !== null,
    }))()`;
    // A check during navigation reads as not yet, not as a failure.
    const isTrue = (sid: string, expr: string): Promise<boolean> =>
      evalMain<boolean>(sid, expr).catch(() => false);
    const clickSelector = async (
      sid: string,
      selector: string
    ): Promise<void> => {
      await evalMain(
        sid,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error(${JSON.stringify(selector + ' missing')});
          el.click();
          return true;
        })()`
      );
    };
    type StageState = {
      dead: boolean;
      accession: string;
      body: string;
      stageCode: boolean;
    };
    const assertUnreachable = async (
      sid: string,
      label: string
    ): Promise<void> => {
      const s = await evalMain<StageState>(sid, stateExpr);
      assert.ok(s.dead, `${label}: the dead card must show`);
      assert.ok(
        s.accession.includes('service_unreachable'),
        `${label}: accession must be service_unreachable, found "${s.accession}"`
      );
      assert.ok(
        s.body.includes('Something went wrong reaching the service.'),
        `${label}: the card must say the service could not be reached`
      );
      assert.ok(
        !s.body.includes('content_damaged'),
        `${label}: must not read as damaged content`
      );
      assert.equal(
        s.stageCode,
        false,
        `${label}: must not fall back to the source view`
      );
    };
    const savePng = async (sid: string, name: string): Promise<void> => {
      const shot = (await cdp.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sid
      )) as { data: string };
      await writeFile(join(proofDir, name), Buffer.from(shot.data, 'base64'));
    };
    const assertNoKeyInReloads = (run: RunOutcome, label: string): void => {
      for (const url of run.navigationUrls.slice(1)) {
        assert.ok(
          !url.includes('#') && !url.includes(compareKey),
          `${label}: a reload carried the fragment: ${url}`
        );
      }
    };
    const mintsOfCompare = (): number =>
      relicMintCounts.get(compareRelicId) ?? 0;

    // 3a: the first compiler fetch fails once. One reload, the vault supplies
    // the key, and the component renders.
    {
      const mints = mintsOfCompare();
      const run = await runRelicPage(compareUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 1 }],
      });
      runsExecuted++;
      await waitUntil(
        () => isTrue(run.sessionId, readyExpr),
        45_000,
        '3a: component ready after one reload'
      );
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        run.blocks[compilerPattern] ?? 0,
        1,
        `3a: expected one intercepted compiler fetch, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      assert.equal(
        reloads,
        1,
        `3a: expected exactly one reload, saw ${reloads}`
      );
      assertNoKeyInReloads(run, '3a');
      assert.equal(
        await evalMain<string>(run.sessionId, 'location.hash'),
        '',
        '3a: the reloaded page must not keep a fragment'
      );
      await waitUntil(
        async () =>
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        15_000,
        '3a: version two inside the frame'
      );
      const minted = mintsOfCompare() - mints;
      assert.equal(
        minted,
        1 + reloads,
        `3a: one open plus one reload must mint ${1 + reloads} times, saw ${minted}`
      );
      await savePng(run.sessionId, '10-3a-heal-once.png');
      console.log(
        `JSX_STEP_3A_HEAL_ONCE_OK reloads=${reloads} blocked=${run.blocks[compilerPattern] ?? 0}`
      );
      await run.close();
    }

    // 3b: every compiler fetch fails. One reload is allowed; the second failure
    // shows the card and nothing reloads again.
    {
      const run = await runRelicPage(compareUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 'all' }],
      });
      runsExecuted++;
      await waitUntil(
        async () =>
          run.navigationUrls.length >= 2 &&
          (await isTrue(run.sessionId, deadExpr)),
        45_000,
        '3b: second attempt fails after the one reload'
      );
      await Bun.sleep(1500);
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        reloads,
        1,
        `3b: at most one reload is allowed, saw ${reloads}`
      );
      assert.ok(
        (run.blocks[compilerPattern] ?? 0) >= 2,
        `3b: the reloaded attempt must also be intercepted, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      await assertUnreachable(run.sessionId, '3b');
      assertNoKeyInReloads(run, '3b');
      await savePng(run.sessionId, '10-3b-no-loop.png');
      console.log(
        `JSX_STEP_3B_NO_LOOP_OK reloads=${reloads} blocked=${run.blocks[compilerPattern] ?? 0}`
      );
      await run.close();
    }

    // 3c: the network is down, so the server check fails. No reload happens and
    // the card stays. Try again reloads once the network is back.
    {
      const run = await runRelicPage(compareUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [
          { urlPattern: compilerPattern, times: 'all' },
          { urlPattern: probePattern, times: 'all' },
        ],
      });
      runsExecuted++;
      await waitUntil(
        () => isTrue(run.sessionId, deadExpr),
        45_000,
        '3c: card while the network is down'
      );
      assert.equal(
        run.navigationUrls.length - 1,
        0,
        '3c: the page reloaded while the server check was failing'
      );
      assert.ok(
        (run.blocks[probePattern] ?? 0) >= 1,
        '3c: the server check was never intercepted'
      );
      await assertUnreachable(run.sessionId, '3c');
      run.setBlocks([]);
      await clickSelector(run.sessionId, '[data-dead-action="retry"]');
      await waitUntil(
        () => isTrue(run.sessionId, readyExpr),
        45_000,
        '3c: component ready after Try again'
      );
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        reloads,
        1,
        `3c: Try again should reload once when the network is back, saw ${reloads}`
      );
      assertNoKeyInReloads(run, '3c');
      await savePng(run.sessionId, '10-3c-network-retry.png');
      console.log(
        `JSX_STEP_3C_NETWORK_RETRY_OK reloads=${reloads} probes=${run.blocks[probePattern] ?? 0}`
      );
      await run.close();
    }

    // 3d: a typed key whose first compiler fetch fails recovers the same way. A
    // separate relic keeps the vault empty until the key is typed.
    {
      const typedPath = join(compareDir, 'Typed.jsx');
      await writeFile(typedPath, compareJsx('Relik JSX typed key', ['Alpha']));
      const typedRes = await callMcp('relic_publish', {
        path: typedPath,
        cover: false,
        title: '',
      });
      const typedUrl = String(typedRes['url'] ?? typedRes['share_url'] ?? '');
      const typedKey = typedUrl.split('#')[1] ?? '';
      assert.ok(typedKey !== '', '3d: publish must return a key');
      const bareUrl = typedUrl.split('#')[0] ?? '';
      const run = await runRelicPage(bareUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 1 }],
      });
      runsExecuted++;
      await waitUntil(
        () =>
          isTrue(
            run.sessionId,
            `Boolean(document.querySelector('.key-entry-form'))`
          ),
        30_000,
        '3d: key entry form'
      );
      await evalMain(
        run.sessionId,
        `(() => {
          const input = document.querySelector('#relic-key-input');
          if (!input) throw new Error('#relic-key-input not found');
          input.value = ${JSON.stringify(typedKey)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const form = document.querySelector('.key-entry-form');
          if (!form) throw new Error('.key-entry-form not found');
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return true;
        })()`
      );
      await waitUntil(
        () => isTrue(run.sessionId, readyExpr),
        45_000,
        '3d: component ready after the typed key'
      );
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        run.blocks[compilerPattern] ?? 0,
        1,
        `3d: expected one intercepted compiler fetch, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      assert.equal(
        reloads,
        1,
        `3d: expected exactly one reload, saw ${reloads}`
      );
      assert.ok(
        run.navigationUrls.every((url) => !url.includes(typedKey)),
        '3d: a navigation carried the key'
      );
      await savePng(run.sessionId, '10-3d-typed-key.png');
      console.log(
        `JSX_STEP_3D_TYPED_KEY_OK reloads=${reloads} blocked=${run.blocks[compilerPattern] ?? 0}`
      );
      await run.close();
    }

    // Watches the page body for `text` over `ms`, and reports whether it was
    // ever present. A proof that a page stays put needs this window, not a
    // single read.
    const watchForText = async (
      sid: string,
      text: string,
      ms: number
    ): Promise<boolean> => {
      let seen = false;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (!seen) {
          seen = await isTrue(
            sid,
            `(document.body?.textContent ?? '').includes(${JSON.stringify(text)})`
          );
        }
        await Bun.sleep(100);
      }
      return seen;
    };

    // 3e: the current version is HTML and the comparison needs the v1 JSX. The
    // compiler fetch fails once during Compare. The page must not reload on its
    // own: it shows an explanatory error. A manual reload then recovers, and
    // Compare frames both versions.
    {
      const mixedPath = join(compareDir, 'Mixed.jsx');
      await writeFile(
        mixedPath,
        compareJsx('Relik JSX version one', ['Alpha', 'Beta'])
      );
      const mixedRes = await callMcp('relic_publish', {
        path: mixedPath,
        cover: false,
        title: '',
      });
      const mixedId = String(mixedRes['relic_id'] ?? '');
      const mixedUrl = String(mixedRes['url'] ?? mixedRes['share_url'] ?? '');
      assert.ok(
        mixedId !== '' && mixedUrl.includes('#'),
        '3e: publish must return an id and key'
      );
      const mixedHtmlPath = join(compareDir, 'Mixed.html');
      await writeFile(
        mixedHtmlPath,
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mixed</title></head><body><h1>Relik HTML version two</h1></body></html>\n'
      );
      const mixedRepub = await callMcp('relic_republish', {
        path: mixedHtmlPath,
        relic_id: mixedId,
        notify: false,
        cover: false,
      });
      assert.equal(
        mixedRepub['version'],
        2,
        '3e: the HTML republish must advance to version 2'
      );
      const run = await runRelicPage(mixedUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 0 }],
      });
      runsExecuted++;
      await waitUntil(
        async () =>
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        45_000,
        '3e: current HTML version rendered'
      );
      run.setBlocks([{ urlPattern: compilerPattern, times: 1 }]);
      await clickSelector(run.sessionId, '.action-history');
      await waitUntil(
        async () => (run.blocks[compilerPattern] ?? 0) >= 1,
        30_000,
        '3e: compiler fetch intercepted'
      );
      // Long enough for a stale automatic reload, which needs the server check,
      // to have run if it were going to.
      const errorShown = await watchForText(
        run.sessionId,
        'could not be loaded for comparison',
        6_000
      );
      const autoReloads = run.navigationUrls.length - 1;
      assert.equal(
        autoReloads,
        0,
        `3e: the failed comparison reloaded the page on its own (${autoReloads} reloads)`
      );
      assert.ok(
        errorShown,
        '3e: the failed comparison must tell the reader it could not be loaded'
      );
      const errorText = await evalMain<string>(
        run.sessionId,
        `document.body?.textContent ?? ''`
      );
      assert.ok(
        errorText.includes('Reload this page to try again.'),
        '3e: the failure must end with the instruction "Reload this page to try again."'
      );
      await savePng(run.sessionId, '10-3e-error-no-auto-reload.png');

      // The reader reloads by hand. Page.reload is that user action, counted as
      // one navigation, and the vault must still reopen the relic.
      await cdp.send('Page.reload', {}, run.sessionId);
      await waitUntil(
        async () =>
          run.navigationUrls.length >= 2 &&
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        45_000,
        '3e: manual reload shows the current version'
      );
      const manualReloads = run.navigationUrls.length - 1;
      assert.equal(
        manualReloads,
        1,
        `3e: expected exactly one manual reload, saw ${manualReloads}`
      );
      assertNoKeyInReloads(run, '3e');

      await clickSelector(run.sessionId, '.action-history');
      await waitUntil(
        async () =>
          (await evalMain<number>(
            run.sessionId,
            `document.querySelectorAll('.compare-pane iframe.usercontent-frame').length`
          )) === 2,
        30_000,
        '3e: two comparison panes after manual reload'
      );
      await waitUntil(
        async () => {
          const texts = await evalMain<string[]>(run.sessionId, summaryExpr);
          return (
            texts.length > 0 &&
            texts.every((t) => t !== 'Rendering both versions.')
          );
        },
        30_000,
        '3e: comparison summary to settle'
      );
      const summaryTexts = await evalMain<string[]>(run.sessionId, summaryExpr);
      assert.ok(
        !summaryTexts.some((t) =>
          t.includes('could not read their rendered structure')
        ),
        `3e: comparison could not read rendered structure: ${summaryTexts.join(' | ')}`
      );
      await waitUntil(
        async () => {
          const cmp = await usercontentTexts(run.sessionId, '.compare-pane');
          return (
            cmp.length === 2 &&
            cmp.some((t) => t.includes('version one')) &&
            cmp.some((t) => t.includes('version two'))
          );
        },
        30_000,
        '3e: both comparison frames show their versions'
      );
      await savePng(run.sessionId, '10-3e-manual-recovery.png');
      console.log(
        `JSX_STEP_3E_MANUAL_RECOVERY_OK auto_reloads=0 manual_reloads=1 blocked=${run.blocks[compilerPattern] ?? 0}`
      );
      await run.close();
    }

    // 3f: a compare whose compiler reply returns after the reader has left it
    // must neither reload the page nor take a draft with it. The compiler reply
    // is held. The reader exits compare, opens Share and types a draft. Then the
    // held reply is released, and the page must stay put.
    {
      const staleJsxPath = join(compareDir, 'Stale.jsx');
      await writeFile(
        staleJsxPath,
        compareJsx('Relik JSX version one', ['Alpha', 'Beta'])
      );
      const staleRes = await callMcp('relic_publish', {
        path: staleJsxPath,
        cover: false,
        title: '',
      });
      const staleId = String(staleRes['relic_id'] ?? '');
      const staleUrl = String(staleRes['url'] ?? staleRes['share_url'] ?? '');
      assert.ok(
        staleId !== '' && staleUrl.includes('#'),
        '3f: publish must return an id and key'
      );
      const staleHtmlPath = join(compareDir, 'Stale.html');
      await writeFile(
        staleHtmlPath,
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Stale</title></head><body><h1>Relik HTML version two</h1></body></html>\n'
      );
      const staleRepub = await callMcp('relic_republish', {
        path: staleHtmlPath,
        relic_id: staleId,
        notify: false,
        cover: false,
      });
      assert.equal(
        staleRepub['version'],
        2,
        '3f: the HTML republish must advance to version 2'
      );
      const run = await runRelicPage(staleUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 0 }],
      });
      runsExecuted++;
      await waitUntil(
        async () =>
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        45_000,
        '3f: current HTML version rendered'
      );
      run.setBlocks([{ urlPattern: compilerPattern, times: 1, hold: true }]);
      await clickSelector(run.sessionId, '.action-history');
      await waitUntil(
        async () => (run.blocks[compilerPattern] ?? 0) >= 1,
        30_000,
        '3f: compiler request held'
      );
      await clickSelector(run.sessionId, '.action-history');
      const pressed = await evalMain<string>(
        run.sessionId,
        `document.querySelector('.action-history')?.getAttribute('aria-pressed') ?? ''`
      );
      assert.equal(
        pressed,
        'false',
        '3f: the reader must have left comparison while the reply is held'
      );
      await clickSelector(run.sessionId, '.action-share');
      await waitUntil(
        () =>
          isTrue(
            run.sessionId,
            `Boolean(document.querySelector('.share-panel input[type="email"]'))`
          ),
        15_000,
        '3f: sign-in draft field'
      );
      const draft = 'reader@example.com';
      await evalMain(
        run.sessionId,
        `(() => {
          const box = document.querySelector('.share-panel input[type="email"]');
          if (!box) throw new Error('sign-in draft field missing');
          box.value = ${JSON.stringify(draft)};
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`
      );
      run.releaseHeld();
      // Longer than the server check, so a stale reload would have happened by now.
      await Bun.sleep(6_000);
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        reloads,
        0,
        `3f: a stale compare reloaded the page after the reader left it (${reloads} reloads)`
      );
      assert.equal(
        run.blocks[compilerPattern] ?? 0,
        1,
        `3f: expected the held compiler fetch to be intercepted once, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      assert.equal(
        await evalMain<string>(
          run.sessionId,
          `document.querySelector('.share-panel input[type="email"]')?.value ?? ''`
        ),
        draft,
        '3f: the draft did not survive the stale reply'
      );
      assert.ok(
        await isTrue(run.sessionId, readyExpr),
        '3f: the single view must still be ready'
      );
      await savePng(run.sessionId, '10-3f-stale-compare-kept-draft.png');
      console.log('JSX_STEP_3F_STALE_COMPARE_OK reloads=0 draft=kept');
      await run.close();
    }

    // 3g: a version switch whose compiler reply returns after the reader has
    // chosen the current version must neither reload the page nor take a draft
    // with it. The historical request is held, the reader picks the current
    // version again, opens Share and types a draft, and the held reply is
    // released. The page must stay on the current version and keep the draft.
    {
      const switchJsxPath = join(compareDir, 'Switch.jsx');
      await writeFile(
        switchJsxPath,
        compareJsx('Relik JSX version one', ['Alpha', 'Beta'])
      );
      const switchRes = await callMcp('relic_publish', {
        path: switchJsxPath,
        cover: false,
        title: '',
      });
      const switchId = String(switchRes['relic_id'] ?? '');
      const switchUrl = String(
        switchRes['url'] ?? switchRes['share_url'] ?? ''
      );
      assert.ok(
        switchId !== '' && switchUrl.includes('#'),
        '3g: publish must return an id and key'
      );
      const switchHtmlPath = join(compareDir, 'Switch.html');
      await writeFile(
        switchHtmlPath,
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Switch</title></head><body><h1>Relik HTML version two</h1></body></html>\n'
      );
      const switchRepub = await callMcp('relic_republish', {
        path: switchHtmlPath,
        relic_id: switchId,
        notify: false,
        cover: false,
      });
      assert.equal(
        switchRepub['version'],
        2,
        '3g: the HTML republish must advance to version 2'
      );
      const run = await runRelicPage(switchUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 0 }],
      });
      runsExecuted++;
      await waitUntil(
        async () =>
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        45_000,
        '3g: current HTML version rendered'
      );
      run.setBlocks([{ urlPattern: compilerPattern, times: 1, hold: true }]);
      await clickSelector(run.sessionId, '.version-option[data-version="1"]');
      await waitUntil(
        async () => (run.blocks[compilerPattern] ?? 0) >= 1,
        30_000,
        '3g: historical compiler request held'
      );
      await clickSelector(run.sessionId, '.version-option[data-version="2"]');
      await clickSelector(run.sessionId, '.action-share');
      await waitUntil(
        () =>
          isTrue(
            run.sessionId,
            `Boolean(document.querySelector('.share-panel input[type="email"]'))`
          ),
        15_000,
        '3g: sign-in draft field'
      );
      const draft = 'reader@example.com';
      await evalMain(
        run.sessionId,
        `(() => {
          const box = document.querySelector('.share-panel input[type="email"]');
          if (!box) throw new Error('sign-in draft field missing');
          box.value = ${JSON.stringify(draft)};
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`
      );
      run.releaseHeld();
      // Longer than the server check, so a stale reload would have happened by now.
      await Bun.sleep(6_000);
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        reloads,
        0,
        `3g: a stale version switch reloaded the page after the reader chose the current version (${reloads} reloads)`
      );
      assert.equal(
        run.blocks[compilerPattern] ?? 0,
        1,
        `3g: expected the held compiler fetch to be intercepted once, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      assert.ok(
        (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
          t.includes('version two')
        ),
        '3g: the page must still show the current version'
      );
      assert.equal(
        await evalMain<string>(
          run.sessionId,
          `document.querySelector('.share-panel input[type="email"]')?.value ?? ''`
        ),
        draft,
        '3g: the draft did not survive the stale reply'
      );
      assert.ok(
        await isTrue(run.sessionId, readyExpr),
        '3g: the current view must still be ready'
      );
      await savePng(run.sessionId, '10-3g-stale-switch-kept-draft.png');
      console.log('JSX_STEP_3G_STALE_SWITCH_OK reloads=0 draft=kept');
      await run.close();
    }

    // 3h: the reader stays in the same comparison view, opens Share and types an
    // unsent sign-in address while the historical compiler reply is held. When the
    // reply fails, the page must not reload, the draft must remain, and the reader
    // must see the comparison failure instead of a silent blank.
    {
      const sameJsxPath = join(compareDir, 'SameView.jsx');
      await writeFile(
        sameJsxPath,
        compareJsx('Relik JSX version one', ['Alpha', 'Beta'])
      );
      const sameRes = await callMcp('relic_publish', {
        path: sameJsxPath,
        cover: false,
        title: '',
      });
      const sameId = String(sameRes['relic_id'] ?? '');
      const sameUrl = String(sameRes['url'] ?? sameRes['share_url'] ?? '');
      assert.ok(
        sameId !== '' && sameUrl.includes('#'),
        '3h: publish must return an id and key'
      );
      const sameHtmlPath = join(compareDir, 'SameView.html');
      await writeFile(
        sameHtmlPath,
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SameView</title></head><body><h1>Relik HTML version two</h1></body></html>\n'
      );
      const sameRepub = await callMcp('relic_republish', {
        path: sameHtmlPath,
        relic_id: sameId,
        notify: false,
        cover: false,
      });
      assert.equal(
        sameRepub['version'],
        2,
        '3h: the HTML republish must advance to version 2'
      );
      const run = await runRelicPage(sameUrl, {
        viewport,
        colorScheme: 'light',
        bypassServiceWorker: true,
        fixedWait: true,
        blocks: [{ urlPattern: compilerPattern, times: 0 }],
      });
      runsExecuted++;
      await waitUntil(
        async () =>
          (await usercontentTexts(run.sessionId, 'main.stage')).some((t) =>
            t.includes('version two')
          ),
        45_000,
        '3h: current HTML version rendered'
      );
      run.setBlocks([{ urlPattern: compilerPattern, times: 1, hold: true }]);
      await clickSelector(run.sessionId, '.action-history');
      await waitUntil(
        async () => (run.blocks[compilerPattern] ?? 0) >= 1,
        30_000,
        '3h: compiler request held'
      );
      const stillComparing = await evalMain<string>(
        run.sessionId,
        `document.querySelector('.action-history')?.getAttribute('aria-pressed') ?? ''`
      );
      assert.equal(
        stillComparing,
        'true',
        '3h: the reader must still be in the comparison view'
      );
      await clickSelector(run.sessionId, '.action-share');
      await waitUntil(
        () =>
          isTrue(
            run.sessionId,
            `Boolean(document.querySelector('.share-panel input[type="email"]'))`
          ),
        15_000,
        '3h: sign-in draft field in the comparison view'
      );
      const draft = 'reader@example.com';
      await evalMain(
        run.sessionId,
        `(() => {
          const box = document.querySelector('.share-panel input[type="email"]');
          if (!box) throw new Error('sign-in draft field missing');
          box.value = ${JSON.stringify(draft)};
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`
      );
      run.releaseHeld();
      // Watch for the failure text for the whole window a stale reload needs.
      const errorText = 'could not be loaded for comparison';
      let errorSeen = false;
      const watchEnd = Date.now() + 6_000;
      while (Date.now() < watchEnd) {
        if (!errorSeen) {
          errorSeen = await isTrue(
            run.sessionId,
            `document.body?.textContent?.includes(${JSON.stringify(errorText)}) === true`
          );
        }
        await Bun.sleep(100);
      }
      const reloads = run.navigationUrls.length - 1;
      assert.equal(
        reloads,
        0,
        `3h: the pending compare failure reloaded the page over a live draft (${reloads} reloads)`
      );
      assert.equal(
        run.blocks[compilerPattern] ?? 0,
        1,
        `3h: expected the held compiler fetch to be intercepted once, saw ${run.blocks[compilerPattern] ?? 0}`
      );
      assert.ok(
        errorSeen,
        `3h: the reader was never told the comparison failed ("${errorText}")`
      );
      assert.equal(
        await evalMain<string>(
          run.sessionId,
          `document.querySelector('.share-panel input[type="email"]')?.value ?? ''`
        ),
        draft,
        '3h: the unsent draft did not survive the pending failure'
      );
      await savePng(run.sessionId, '10-3h-same-view-draft-kept.png');
      console.log(
        'JSX_STEP_3H_SAME_VIEW_DRAFT_OK reloads=0 draft=kept error=shown'
      );
      await run.close();
    }

    console.log('JSX_COMPONENT_PATH_OK');

    const dur = Date.now() - t0;
    runSummary.push({
      name: 'Run 10: JSX component relic frame, comparison, compiler-load recovery',
      durationMs: dur,
      status: 'pass',
    });
  }

  // =========================================================================
  // Final Summary and Output
  // =========================================================================
  const summary = {
    classes: 12,
    runs: runsExecuted,
    timestamp: new Date().toISOString(),
    headSha: shortSha,
    proofDir,
    runsSummary: runSummary,
  };

  await writeFile(
    join(proofDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log(
    `\nWrote ${runsExecuted} runs summary and screenshots to: ${proofDir}`
  );
  console.log(
    `LOAD_PROGRESS_PATH_OK fixtures=${fixtures.length} runs=${runsExecuted}`
  );
} finally {
  child.kill('SIGKILL');
  service.stop(true);
  usercontentService.stop(true);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
