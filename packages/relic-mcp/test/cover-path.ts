/**
 * End-to-end cover path proof.
 *
 *   bun packages/relic-mcp/test/cover-path.ts
 *
 * Exercises the per-relic cover generation, upload, serving, and lifecycle
 * end to end across every renderer class.
 *
 * Real createApp on Bun.serve loopback with MemoryStore and MemoryStorage.
 * Each publish and republish runs through a fresh Node stdio process of
 * packages/relic-mcp/dist/relic-mcp.js to prove the packaged bundle, cover
 * asset resolution, and the Node runtime.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  type CoverKind,
  type CoverType,
  coverExtension,
  crc32,
  validateCoverRaster,
} from '@relic/format/cover';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';

const execFileAsync = promisify(execFile);

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-cover-path-'));
const statePath = join(scratch, 'state.json');

// --- Hostile egress collectors (loopback HTTP and UDP) -------------------
let egressArrivals = 0;

const udpCollector = dgram.createSocket('udp4');
udpCollector.on('message', () => {
  egressArrivals++;
});
await new Promise<void>((resolve) => {
  udpCollector.bind(0, '127.0.0.1', () => resolve());
});
const udpPort = udpCollector.address().port;

const httpCollector = http.createServer((_req, res) => {
  egressArrivals++;
  res.writeHead(200);
  res.end();
});
await new Promise<void>((resolve) => {
  httpCollector.listen(0, '127.0.0.1', () => resolve());
});
const httpAddress = httpCollector.address();
const httpPort =
  typeof httpAddress === 'object' && httpAddress !== null
    ? httpAddress.port
    : 0;

// --- App server setup with MemoryStore and MemoryStorage -----------------
let fakeNow = Date.now();
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;

const storage = new MemoryStorage(`${origin}/__storage`);

const app = createApp({
  config: {
    serviceOrigin: origin,
  },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    const bytes = new Uint8Array(await request.arrayBuffer());
    storage.put(relicId, bytes);
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
  return app.fetch(request);
};

// --- Fresh Node stdio process caller -------------------------------------
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
      RELIC_CLIENT_NAME: 'relic-mcp/cover-path',
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

// --- Fixture generators --------------------------------------------------
function buildPngBuffer(width = 120, height = 80): Buffer {
  function makeChunk(type: string, data: Buffer): Buffer {
    const len = data.length;
    const chunk = Buffer.alloc(4 + 4 + len + 4);
    chunk.writeUInt32BE(len, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    const typeAndData = chunk.subarray(4, 8 + len);
    const c = crc32(typeAndData);
    chunk.writeUInt32BE(c >>> 0, 8 + len);
    return chunk;
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 3);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 3;
      raw[pxOffset] = (x * 3) % 256;
      raw[pxOffset + 1] = (y * 3) % 256;
      raw[pxOffset + 2] = 200;
    }
  }
  const idatData = deflateSync(raw);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

const COVER_ALT: Record<CoverKind, string> = {
  markdown: 'The opening of this Markdown document, as it renders.',
  code: 'The first lines of this code file, as they render.',
  html: 'The top of this HTML page, as it renders.',
  jsx: 'The top of this JSX component, as it renders.',
  image: 'This image, cropped to the card.',
  pdf: "The top of this PDF's first page.",
  video: 'A frame from the opening seconds of this video.',
  'audio-artwork': 'The artwork embedded in this audio file.',
  'audio-waveform': 'The waveform of this audio file.',
  archive: 'The list of files inside this archive.',
};

interface FixturePlan {
  filename: string;
  expectedStatus: 'uploaded' | 'skipped';
  expectedKind?: CoverKind;
  expectedReason?: string;
}

const fixtures: FixturePlan[] = [
  {
    filename: 'report.md',
    expectedStatus: 'uploaded',
    expectedKind: 'markdown',
  },
  {
    filename: 'sample.ts',
    expectedStatus: 'uploaded',
    expectedKind: 'code',
  },
  {
    filename: 'page.html',
    expectedStatus: 'uploaded',
    expectedKind: 'html',
  },
  {
    filename: 'logo.svg',
    expectedStatus: 'uploaded',
    expectedKind: 'html',
  },
  {
    filename: 'Widget.jsx',
    expectedStatus: 'uploaded',
    expectedKind: 'jsx',
  },
  {
    filename: 'image.png',
    expectedStatus: 'uploaded',
    expectedKind: 'image',
  },
  {
    filename: 'doc.pdf',
    expectedStatus: 'uploaded',
    expectedKind: 'pdf',
  },
  {
    filename: 'clip.mp4',
    expectedStatus: 'uploaded',
    expectedKind: 'video',
  },
  {
    filename: 'tone.mp3',
    expectedStatus: 'uploaded',
    expectedKind: 'audio-waveform',
  },
  {
    filename: 'tagged.mp3',
    expectedStatus: 'uploaded',
    expectedKind: 'audio-artwork',
  },
  {
    filename: 'bundle.zip',
    expectedStatus: 'uploaded',
    expectedKind: 'archive',
  },
  {
    filename: 'expanded.zip',
    expectedStatus: 'uploaded',
    expectedKind: 'markdown',
  },
  {
    filename: 'bundle.tar.gz',
    expectedStatus: 'uploaded',
    expectedKind: 'archive',
  },
  {
    filename: 'blob.xz',
    expectedStatus: 'skipped',
    expectedReason: 'archive_format_unlisted',
  },
  {
    filename: 'noise.bin',
    expectedStatus: 'skipped',
    expectedReason: 'no_cover_for_class',
  },
];

const savedArtifacts = new Map<
  string,
  { bytes: Uint8Array; type: CoverType }
>();

try {
  // 1. report.md
  await writeFile(
    join(scratch, 'report.md'),
    '# Quarterly Report\n\nExecutive summary of engineering metrics.\n'
  );

  // 2. sample.ts
  await writeFile(
    join(scratch, 'sample.ts'),
    'export function computeRate(x: number, y: number): number {\n  return x / (y || 1);\n}\n'
  );

  // 3. page.html with text after load and hostile egress attempts
  const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Sandboxed Document</title></head>
<body>
<div id="render-target">Initial</div>
<script>
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('render-target');
  if (el) el.textContent = 'Rendered Page Text Loaded';
});
try { fetch('http://127.0.0.1:${httpPort}/leak').catch(() => {}); } catch (e) {}
try { navigator.sendBeacon('http://127.0.0.1:${httpPort}/beacon'); } catch (e) {}
try { const img = new Image(); img.src = 'http://127.0.0.1:${httpPort}/leak.png'; } catch (e) {}
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
  pc.createDataChannel('leak');
  pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
} catch (e) {}
</script>
</body>
</html>`;
  await writeFile(join(scratch, 'page.html'), htmlContent);

  // 4. logo.svg
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 315" width="600" height="315">
  <rect width="100%" height="100%" fill="#161b22"/>
  <circle cx="150" cy="157" r="70" fill="#2f81f7"/>
  <text x="260" y="168" fill="#e6edf3" font-size="28" font-family="sans-serif">Vector Logo</text>
</svg>`;
  await writeFile(join(scratch, 'logo.svg'), svgContent);

  // 5. Widget.jsx
  const jsxContent = `export default function Widget() {
  return (
    <div style={{ padding: '32px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ color: '#1f6feb' }}>Widget Component</h1>
      <p style={{ color: '#7d8590' }}>Rendered JSX preview.</p>
    </div>
  );
}`;
  await writeFile(join(scratch, 'Widget.jsx'), jsxContent);

  // 6. image.png
  await writeFile(join(scratch, 'image.png'), buildPngBuffer(140, 90));

  // 7. doc.pdf
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
100 700 Td
(Hello PDF World) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
440
%%EOF
`;
  await writeFile(join(scratch, 'doc.pdf'), pdfContent);

  // 8. clip.mp4
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=10',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(scratch, 'clip.mp4'),
  ]);

  // 9. tone.mp3
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'libmp3lame',
    join(scratch, 'tone.mp3'),
  ]);

  // 10. tagged.mp3 with artwork
  const albumArt = join(scratch, 'album_art.png');
  await writeFile(albumArt, buildPngBuffer(100, 100));
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1',
    '-i',
    albumArt,
    '-map',
    '0:a',
    '-map',
    '1:v',
    '-c:a',
    'libmp3lame',
    '-c:v',
    'png',
    '-id3v2_version',
    '3',
    '-metadata:s:v',
    'title=Album cover',
    '-metadata:s:v',
    'comment=Cover (front)',
    join(scratch, 'tagged.mp3'),
  ]);

  // 11. bundle.zip
  const zipDir = join(scratch, 'zip-project');
  await mkdir(join(zipDir, 'src'), { recursive: true });
  await writeFile(
    join(zipDir, 'package.json'),
    '{"name":"demo","version":"1.0.0"}\n'
  );
  await writeFile(join(zipDir, 'README.md'), '# Demo Project\n');
  await writeFile(join(zipDir, 'src', 'index.js'), 'console.log("hello");\n');
  await execFileAsync('zip', ['-q', '-r', join(scratch, 'bundle.zip'), '.'], {
    cwd: zipDir,
  });
  await execFileAsync('zip', ['-q', '-r', join(scratch, 'expanded.zip'), '.'], {
    cwd: zipDir,
  });

  // 12. bundle.tar.gz
  const tarDir = join(scratch, 'tar-project');
  await mkdir(join(tarDir, 'src'), { recursive: true });
  await writeFile(
    join(tarDir, 'package.json'),
    '{"name":"tar-demo","version":"1.0.0"}\n'
  );
  await writeFile(join(tarDir, 'README.md'), '# Tar Demo Project\n');
  await writeFile(
    join(tarDir, 'src', 'main.js'),
    'export const ready = true;\n'
  );
  await execFileAsync('tar', [
    '-czf',
    join(scratch, 'bundle.tar.gz'),
    '-C',
    tarDir,
    '.',
  ]);

  // 13. blob.xz (magic only)
  await writeFile(
    join(scratch, 'blob.xz'),
    Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00])
  );

  // 14. noise.bin
  await writeFile(
    join(scratch, 'noise.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc])
  );

  // --- Run per-fixture assertions ----------------------------------------
  for (const fixture of fixtures) {
    const pubResult = await callMcp('relic_publish', {
      path: join(scratch, fixture.filename),
      ...(fixture.filename === 'bundle.zip' ? { expand: false } : {}),
      title: '',
    });

    const relicId = pubResult['relic_id'] as string;
    assert.ok(
      typeof relicId === 'string' && relicId.length > 0,
      `missing relic_id for ${fixture.filename}`
    );

    const cover = pubResult['cover'] as Record<string, unknown> | undefined;
    assert.ok(cover !== undefined, `missing cover for ${fixture.filename}`);
    if (fixture.filename === 'expanded.zip') {
      assert.equal(pubResult['shape'], 'folder');
      assert.equal(
        (pubResult['folder'] as Record<string, unknown>)['default_entry'],
        'README.md'
      );
    }

    const shellHtml = await fetch(`${origin}/${relicId}`).then((r) => r.text());

    if (fixture.expectedStatus === 'uploaded') {
      assert.equal(
        cover['status'],
        'uploaded',
        `expected uploaded status for ${fixture.filename}`
      );
      assert.equal(
        cover['kind'],
        fixture.expectedKind,
        `unexpected kind for ${fixture.filename}`
      );

      const coverType = cover['type'] as CoverType;
      assert.ok(
        coverType === 'image/png' || coverType === 'image/jpeg',
        `unexpected cover type for ${fixture.filename}: ${coverType}`
      );

      const coverUrl = cover['url'] as string;
      assert.ok(
        typeof coverUrl === 'string' && coverUrl.length > 0,
        `missing cover URL for ${fixture.filename}`
      );

      // Verify shell og tags
      const ogImageMatch = shellHtml.match(
        /<meta property="og:image" content="([^"]+)">/
      );
      assert.ok(
        ogImageMatch !== null,
        `missing og:image in shell for ${fixture.filename}`
      );
      assert.equal(ogImageMatch[1], coverUrl);

      const twitterImageMatch = shellHtml.match(
        /<meta name="twitter:image" content="([^"]+)">/
      );
      assert.ok(
        twitterImageMatch !== null,
        `missing twitter:image in shell for ${fixture.filename}`
      );
      assert.equal(twitterImageMatch[1], coverUrl);

      const ogTypeMatch = shellHtml.match(
        /<meta property="og:image:type" content="([^"]+)">/
      );
      assert.ok(
        ogTypeMatch !== null,
        `missing og:image:type in shell for ${fixture.filename}`
      );
      assert.equal(ogTypeMatch[1], coverType);

      const ogWidthMatch = shellHtml.match(
        /<meta property="og:image:width" content="([^"]+)">/
      );
      assert.ok(
        ogWidthMatch !== null,
        `missing og:image:width in shell for ${fixture.filename}`
      );
      assert.equal(ogWidthMatch[1], '1200');

      const ogHeightMatch = shellHtml.match(
        /<meta property="og:image:height" content="([^"]+)">/
      );
      assert.ok(
        ogHeightMatch !== null,
        `missing og:image:height in shell for ${fixture.filename}`
      );
      assert.equal(ogHeightMatch[1], '630');
      assert.ok(
        fixture.expectedKind !== undefined,
        `expectedKind must be defined for ${fixture.filename}`
      );
      const expectedAlt = COVER_ALT[fixture.expectedKind];
      const ogAltMatch = shellHtml.match(
        /<meta property="og:image:alt" content="([^"]+)">/
      );
      assert.ok(
        ogAltMatch !== null,
        `missing og:image:alt in shell for ${fixture.filename}`
      );
      assert.equal(ogAltMatch[1], expectedAlt.replace(/'/g, '&#39;'));

      // Fetch cover URL and verify headers and raster validity
      const coverRes = await fetch(coverUrl);
      assert.equal(
        coverRes.status,
        200,
        `expected 200 for cover URL of ${fixture.filename}`
      );
      assert.equal(coverRes.headers.get('content-type'), coverType);
      assert.equal(
        coverRes.headers.get('cache-control'),
        'public, max-age=86400'
      );
      assert.equal(coverRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(coverRes.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(coverRes.headers.get('x-robots-tag'), 'noindex');
      assert.equal(
        coverRes.headers.get('content-security-policy'),
        "default-src 'none'; sandbox"
      );
      assert.equal(
        coverRes.headers.get('content-encoding'),
        null,
        'cover must not have content-encoding'
      );

      const coverBytes = new Uint8Array(await coverRes.arrayBuffer());
      assert.equal(
        coverBytes.length,
        Number(cover['bytes']),
        'content-length mismatch'
      );

      const valid = validateCoverRaster(coverBytes, (data) =>
        inflateSync(data)
      );
      assert.ok(
        valid.ok,
        `raster validation failed for ${fixture.filename}: ${valid.ok ? '' : valid.detail}`
      );

      savedArtifacts.set(fixture.filename, {
        bytes: coverBytes,
        type: coverType,
      });

      console.log(
        `COVER kind=${cover['kind']} status=uploaded bytes=${coverBytes.length}`
      );
    } else {
      assert.equal(
        cover['status'],
        'skipped',
        `expected skipped for ${fixture.filename}`
      );
      assert.equal(
        cover['reason'],
        fixture.expectedReason,
        `unexpected reason for ${fixture.filename}`
      );

      // Verify og:image falls back to card.v1.png
      const ogImageMatch = shellHtml.match(
        /<meta property="og:image" content="([^"]+)">/
      );
      assert.ok(
        ogImageMatch !== null,
        `missing og:image in shell for ${fixture.filename}`
      );
      assert.equal(
        ogImageMatch[1],
        `${origin}/assets/card.v1.png`,
        `expected card.v1.png fallback for ${fixture.filename}`
      );

      console.log('COVER kind=none status=skipped bytes=0');
    }
  }

  // --- Datastore proof: cover: false leaves nothing in store -------------
  const declinedPath = join(scratch, 'declined.md');
  await writeFile(declinedPath, '# Declined Cover\n');
  const declinedPub = await callMcp('relic_publish', {
    path: declinedPath,
    cover: false,
  });
  const declinedCover = declinedPub['cover'] as Record<string, unknown>;
  assert.equal(declinedCover['status'], 'declined');
  const declinedId = declinedPub['relic_id'] as string;
  interface CoverCapableRelicRow {
    readonly cover?: unknown;
  }
  const declinedRow = (await store.getRelic(declinedId)) as unknown as
    | CoverCapableRelicRow
    | undefined;
  assert.equal(declinedRow?.cover, undefined);

  // Store-level check if method is available
  interface StoreWithCovers {
    listCovers?: (id: string) => Promise<readonly string[]>;
  }
  const storeExtended = store as unknown as StoreWithCovers;
  if (typeof storeExtended.listCovers === 'function') {
    const list = await storeExtended.listCovers(declinedId);
    assert.equal(list.length, 0);
  }

  const declinedShell = await fetch(`${origin}/${declinedId}`).then((r) =>
    r.text()
  );
  assert.ok(
    declinedShell.includes(
      `<meta property="og:image" content="${origin}/assets/card.v1.png">`
    )
  );

  // --- Republish toggle (new sha, old URL 404) ---------------------------
  const reportPath = join(scratch, 'report.md');
  const firstPub = await callMcp('relic_publish', {
    path: reportPath,
    force_new: true,
  });
  const reportId = firstPub['relic_id'] as string;
  const oldCover = firstPub['cover'] as Record<string, unknown>;
  const oldCoverUrl = oldCover['url'] as string;

  await writeFile(
    reportPath,
    '# Updated Report\n\nUpdated content to produce a new cover raster.\n'
  );
  const repub = await callMcp('relic_republish', {
    relic_id: reportId,
    path: reportPath,
  });
  const newCover = repub['cover'] as Record<string, unknown>;
  assert.equal(newCover['status'], 'uploaded');
  const newCoverUrl = newCover['url'] as string;
  assert.notEqual(newCoverUrl, oldCoverUrl);

  const oldUrlRes = await fetch(oldCoverUrl);
  assert.equal(
    oldUrlRes.status,
    404,
    'old cover URL must return 404 after republish'
  );

  const newUrlRes = await fetch(newCoverUrl);
  assert.equal(
    newUrlRes.status,
    200,
    'new cover URL must return 200 after republish'
  );

  // --- Identical-content republish with cover: false allowed -------------
  const toggleOff = await callMcp('relic_republish', {
    relic_id: reportId,
    path: reportPath,
    cover: false,
  });
  const toggleOffCover = toggleOff['cover'] as Record<string, unknown>;
  assert.equal(toggleOffCover['status'], 'declined');

  const rowAfterToggle = (await store.getRelic(reportId)) as unknown as
    | CoverCapableRelicRow
    | undefined;
  assert.equal(rowAfterToggle?.cover, undefined);
  if (typeof storeExtended.listCovers === 'function') {
    const list = await storeExtended.listCovers(reportId);
    assert.equal(list.length, 0);
  }
  const toggledOldRes = await fetch(newCoverUrl);
  assert.equal(
    toggledOldRes.status,
    404,
    'cover URL must return 404 after cover: false republish'
  );

  const toggledShell = await fetch(`${origin}/${reportId}`).then((r) =>
    r.text()
  );
  assert.ok(
    toggledShell.includes(
      `<meta property="og:image" content="${origin}/assets/card.v1.png">`
    )
  );

  // --- Tombstone (covers_deleted >= 1, URL 404, store empty) ------------
  const tombstonePath = join(scratch, 'tombstone.md');
  await writeFile(tombstonePath, '# Tombstone Target\n');
  const tombstonePub = await callMcp('relic_publish', {
    path: tombstonePath,
  });
  const tombstoneId = tombstonePub['relic_id'] as string;
  const tombstoneCoverUrl = (tombstonePub['cover'] as Record<string, unknown>)[
    'url'
  ] as string;

  const deleteRes = await fetch(`${origin}/api/relics/${tombstoneId}`, {
    method: 'DELETE',
    headers: {
      authorization: 'Bearer test-operator-secret',
    },
  });
  assert.equal(deleteRes.status, 200);
  const deleteJson = (await deleteRes.json()) as Record<string, unknown>;
  if (deleteJson['covers_deleted'] !== undefined) {
    assert.ok(
      Number(deleteJson['covers_deleted']) >= 1,
      `expected covers_deleted >= 1, got ${deleteJson['covers_deleted']}`
    );
  }
  const tombstoneCoverRes = await fetch(tombstoneCoverUrl);
  assert.equal(
    tombstoneCoverRes.status,
    404,
    'tombstoned relic cover must return 404'
  );
  if (typeof storeExtended.listCovers === 'function') {
    const list = await storeExtended.listCovers(tombstoneId);
    assert.equal(list.length, 0);
  }

  // --- Expiry by clock ---------------------------------------------------
  const expiryPath = join(scratch, 'expiry.md');
  await writeFile(expiryPath, '# Expiry Target\n');
  const expiryPub = await callMcp('relic_publish', {
    path: expiryPath,
    ttl_days: 1,
  });
  const expiryId = expiryPub['relic_id'] as string;
  const expiryCoverUrl = (expiryPub['cover'] as Record<string, unknown>)[
    'url'
  ] as string;

  const preExpiryRes = await fetch(expiryCoverUrl);
  assert.equal(preExpiryRes.status, 200);

  // Advance clock by 2 days
  fakeNow += 2 * 86_400 * 1000;

  const postExpiryRes = await fetch(expiryCoverUrl);
  assert.equal(
    postExpiryRes.status,
    404,
    'expired relic cover must return 404'
  );

  const postExpiryShell = await fetch(`${origin}/${expiryId}`);
  assert.equal(postExpiryShell.status, 200);
  const postExpiryHtml = await postExpiryShell.text();
  assert.ok(
    postExpiryHtml.includes(`${origin}/assets/card.v1.png`),
    'expired relic shell must fall back to card.v1.png'
  );
  // --- Mint invariants ---------------------------------------------------
  const mintLog = await store.readMintLog();
  assert.equal(mintLog.length, 0, 'mint log must remain empty');
  const checkRow = await store.getRelic(reportId);
  assert.equal(checkRow?.mintsUsed, 0, 'mintsUsed must be 0');

  // --- Hostile egress collector check ------------------------------------
  assert.equal(
    egressArrivals,
    0,
    `egress collector recorded arrivals: ${egressArrivals}`
  );
  console.log('COVER_EGRESS arrivals=0');

  // --- Artifacts output --------------------------------------------------
  if (process.env['RELIC_COVER_PATH_ARTIFACTS']) {
    const artifactDir = process.env['RELIC_COVER_PATH_ARTIFACTS'];
    await mkdir(artifactDir, { recursive: true });
    for (const [name, item] of savedArtifacts) {
      const ext = coverExtension(item.type);
      await writeFile(join(artifactDir, `${name}.${ext}`), item.bytes);
    }
  }

  console.log(`COVER_PATH_OK classes=${fixtures.length}`);
} finally {
  service.stop(true);
  httpCollector.close();
  udpCollector.close();
  await rm(scratch, { recursive: true, force: true });
}
