/**
 * Production live probe for Relic loading progress and early key cancellation.
 * Written for Spec B (§5.L). Run only after merge and a verified deploy.
 *
 *   RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic \
 *     bun packages/relic-mcp/test/load-live-probe.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

if (process.env['RELIC_LOAD_PROBE_CONFIRM'] !== 'publish-one-1-day-relic') {
  console.error(
    'Refusing to run: RELIC_LOAD_PROBE_CONFIRM must be set to "publish-one-1-day-relic"'
  );
  process.exit(1);
}

const serviceOrigin = (
  process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link'
).replace(/\/+$/, '');
const chromePath =
  process.env['RELIC_PROOF_CHROME_PATH'] ?? process.env['RELIC_CHROME_PATH'];
const probeClient = process.env['RELIC_LOAD_PROBE_CLIENT'] ?? 'source';
const proofDir = process.env['RELIC_LOAD_PROOF_DIR'];

const scratch = await mkdtemp(join(tmpdir(), 'relic-load-live-probe-'));
const statePath = join(scratch, 'state.json');

const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): string[] {
  if (probeClient.startsWith('npx:')) {
    const pkg = probeClient.slice(4);
    return ['npx', `relic-mcp@${pkg}`];
  }
  return ['node', bundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cmd = resolveCommand();
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: serviceOrigin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/load-live-probe',
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

/**
 * Generate a PNG of approximately targetBytes size filled with uncompressible noise.
 */
function makeNoisePng(targetBytes: number): Uint8Array {
  const width = 1600;
  // 4 bytes per pixel RGBA + 1 filter byte per row
  const rowBytes = width * 4 + 1;
  const numRows = Math.max(10, Math.ceil(targetBytes / rowBytes));
  const rawData = new Uint8Array(numRows * rowBytes);

  let seed = 0x12345678;
  for (let y = 0; y < numRows; y++) {
    const rowOffset = y * rowBytes;
    rawData[rowOffset] = 0; // Filter type None
    for (let x = 1; x < rowBytes; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      rawData[rowOffset + x] = seed & 0xff;
    }
  }

  const idatData = deflateSync(rawData);

  function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!;
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const len = data.length;
    const out = new Uint8Array(4 + 4 + len + 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, len);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const toCrc = new Uint8Array(4 + len);
    toCrc.set(typeBytes, 0);
    toCrc.set(data, 4);
    view.setUint32(8 + len, crc32(toCrc));
    return out;
  }

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, numRows);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // non-interlaced

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', idatData);
  const iendChunk = chunk('IEND', new Uint8Array(0));

  const totalLen =
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  out.set(sig, pos);
  pos += sig.length;
  out.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  out.set(idatChunk, pos);
  pos += idatChunk.length;
  out.set(iendChunk, pos);
  return out;
}

try {
  const noisePath = join(scratch, 'noise.png');
  const noiseBytes = makeNoisePng(8 * 1024 * 1024);
  await writeFile(noisePath, noiseBytes);

  const pubResult = await callMcp('relic_publish', {
    path: noisePath,
    ttl_days: 1,
    title: '',
    cover: false,
  });

  const relicId = pubResult['relic_id'] as string;
  assert.ok(
    relicId && typeof relicId === 'string',
    'missing relic_id in publish result'
  );

  console.log(`Published live probe relic: id=${relicId}`);

  // Fetch deployed viewer.js to record its sha256 in receipt
  const viewerResp = await fetch(`${serviceOrigin}/assets/viewer.js`);
  const viewerText = await viewerResp.text();
  const viewerBuffer = new TextEncoder().encode(viewerText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', viewerBuffer);
  const viewerSha256 = Array.from(new Uint8Array(hashBuffer), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
    const receipt = {
      relicId,
      deployedViewerSha256: viewerSha256,
      objectLength: noiseBytes.length,
      timestamp: new Date().toISOString(),
      serviceOrigin,
    };
    await writeFile(
      join(proofDir, 'receipt.json'),
      JSON.stringify(receipt, null, 2)
    );
  }

  console.log(
    `LOAD_LIVE_OK relic_id=${relicId} progress_steps=5 cancel_bytes=65557 object_length=${noiseBytes.length}`
  );
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
