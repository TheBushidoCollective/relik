/**
 * Shared loopback harness for the rendered-program proofs. One Relic server app on a loopback
 * port, one storage, one store, and one fresh `relic-mcp` process per tool call, exactly as the
 * existing OTIO path runs them. Imported by otio-program-path.ts, otio-program-controls.ts and
 * otio-program-comments.ts; the only copy in this directory.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeKey,
  encryptRelic,
  openRelic,
  otioBundleMediaIndex,
  otioDocumentMediaPaths,
  readOtioDocument,
  type OtioZipIndex,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { loadPublishState } from '../src/state.ts';

export const RELIC_MCP_BUNDLE = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
export const VIEWER_DIST =
  process.env['RELIC_POPOVER_VIEWER_DIST'] ??
  process.env['RELIC_VIEWER_DIST'] ??
  fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));

export function sha256Text(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** A publish the service refused with a JSON-RPC error, such as program_refused. */
export class PublishRefusedError extends Error {
  readonly payload: unknown;

  constructor(payload: unknown) {
    super('relic_publish refused the request');
    this.payload = payload;
  }
}

function runProcess(
  command: string,
  args: readonly string[]
): Promise<{ stdout: Buffer; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: Buffer;
    stderr: string;
  }>();
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    const stderr = Buffer.concat(err).toString('utf8');
    if (code !== 0)
      reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    else resolve({ stdout: Buffer.concat(out), stderr });
  });
  return promise;
}

/** Zip access through Python's zipfile, independent of Relic's ZIP reader. */
const ZIP_HELPER = String.raw`
import json, os, sys, zipfile
mode, src = sys.argv[1], sys.argv[2]
if mode == "list":
    with zipfile.ZipFile(src) as z:
        print(json.dumps(z.namelist()))
elif mode == "read":
    with zipfile.ZipFile(src) as z:
        sys.stdout.buffer.write(z.read(sys.argv[3]))
elif mode == "rewrite":
    dst, replacements = sys.argv[3], sys.argv[4]
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            name = info.filename
            path = os.path.join(replacements, name.replace("/", "__"))
            data = open(path, "rb").read() if os.path.exists(path) else zin.read(name)
            zout.writestr(name, data, compress_type=info.compress_type)
`;

export interface ProofHarness {
  readonly scratch: string;
  readonly origin: string;
  readonly storage: MemoryStorage;
  readonly store: MemoryStore;
  createSession(): Promise<string>;
  publish(path: string, env?: Record<string, string>): Promise<PublishResult>;
  /** Decrypts the stored ciphertext with the local publish key. */
  openStored(
    relicId: string
  ): Promise<{ archive: Uint8Array; relicKey: Uint8Array }>;
  /** Writes an archive as the stored ciphertext, sealed with the same key. */
  storeArchive(
    relicId: string,
    archive: Uint8Array,
    relicKey: Uint8Array
  ): Promise<void>;
  listEntries(archive: Uint8Array): Promise<string[]>;
  readEntry(archive: Uint8Array, name: string): Promise<Uint8Array>;
  rewriteEntries(
    archive: Uint8Array,
    replacements: Record<string, Uint8Array>
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ProgramSummary {
  readonly status?: string;
  readonly reason?: string;
  readonly timelines?: ReadonlyArray<{
    readonly timeline_id: string;
    readonly index: number;
    readonly status: string;
    readonly reasons: ReadonlyArray<{
      readonly code: string;
      readonly message: string;
    }>;
  }>;
}

export interface PublishResult {
  readonly relicId: string;
  readonly shareUrl: string;
  readonly program: ProgramSummary;
  readonly structured: Record<string, unknown>;
}

export async function createProofHarness(label: string): Promise<ProofHarness> {
  const scratch = await mkdtemp(
    join(await realpath(tmpdir()), `relic-${label}-`)
  );
  const statePath = join(scratch, 'state.json');
  process.env['RELIC_PUBLISH_STATE'] = statePath;
  const store = new MemoryStore();
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const service = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (!handler) return new Response('Not ready', { status: 503 });
      return handler(request);
    },
  });
  const origin = `http://127.0.0.1:${service.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);
  const app = createApp({
    config: { serviceOrigin: origin },
    store,
    storage,
    now: () => Date.now(),
    operatorTokens: new Map([['operator-token', 'test-operator-secret']]),
    assets: diskAssets(VIEWER_DIST),
    mailer: {
      send: async () => {},
      sendMail: async () => {},
    },
  });
  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    assert.ok(
      url.hostname === '127.0.0.1' || url.hostname === 'localhost',
      `non-loopback request reached the proof server: ${url.hostname}`
    );
    if (
      url.pathname.startsWith('/__storage/upload/') &&
      request.method === 'PUT'
    ) {
      storage.put(
        url.pathname.slice('/__storage/upload/'.length),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const bytes = await storage.read(
        url.pathname.slice('/__storage/o/'.length)
      );
      if (!bytes) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return app.fetch(request);
  };

  const zipScript = join(scratch, 'zip-helper.py');
  await writeFile(zipScript, ZIP_HELPER);
  const withArchive = async <T>(
    archive: Uint8Array,
    use: (path: string) => Promise<T>
  ): Promise<T> => {
    const path = join(
      scratch,
      `archive-${Math.random().toString(16).slice(2)}.otioz`
    );
    await writeFile(path, archive);
    try {
      return await use(path);
    } finally {
      await rm(path, { force: true });
    }
  };

  const harness: ProofHarness = {
    scratch,
    origin,
    storage,
    store,
    async createSession() {
      const token = `proof-token-${Math.random().toString(16).slice(2)}`;
      const now = Date.now();
      await store.putSession({
        tokenHash: sha256Text(new TextEncoder().encode(token)),
        email: 'reader@example.test',
        createdAt: now,
        expiresAt: now + 3600 * 1000,
      });
      return token;
    },
    async publish(path, env = {}) {
      const child = spawn('node', [RELIC_MCP_BUNDLE], {
        cwd: scratch,
        env: {
          ...process.env,
          RELIC_SERVICE_ORIGIN: origin,
          RELIC_PUBLISH_STATE: statePath,
          RELIC_CLIENT_NAME: `relic-mcp/${label}`,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const exit = new Promise<number | null>((resolve) =>
        child.on('close', resolve)
      );
      child.stdin.end(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'relic_publish', arguments: { path } },
        })}\n`
      );
      const code = await exit;
      assert.equal(
        code,
        0,
        `relic_publish exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`
      );
      const line =
        Buffer.concat(stdout).toString('utf8').trim().split('\n').pop() ?? '';
      const response = JSON.parse(line) as {
        result?: { structuredContent?: Record<string, unknown> };
        error?: unknown;
      };
      if (response.error !== undefined)
        throw new PublishRefusedError(response.error);
      const structured = response.result?.structuredContent ?? {};
      const relicId = String(structured['relic_id'] ?? '');
      const shareUrl = String(structured['url'] ?? structured['link'] ?? '');
      return {
        relicId,
        shareUrl,
        program: (structured['program'] ?? {}) as ProgramSummary,
        structured,
      };
    },
    async openStored(relicId) {
      const ciphertext = await storage.read(relicId);
      assert.ok(ciphertext, `nothing stored for ${relicId}`);
      const state = await loadPublishState(relicId);
      assert.ok(state, 'local publish state missing');
      const relicKey = decodeKey(state.key);
      const opened = await openRelic(ciphertext, relicKey);
      return { archive: opened.content, relicKey };
    },
    async storeArchive(relicId, archive, relicKey) {
      const sealed = await encryptRelic({
        content: archive,
        filename: 'proof.otioz',
        mimetype: 'application/x-otioz',
        key: relicKey,
      });
      storage.put(relicId, sealed);
    },
    async listEntries(archive) {
      return withArchive(archive, async (path) => {
        const { stdout } = await runProcess('python3', [
          zipScript,
          'list',
          path,
        ]);
        return JSON.parse(stdout.toString('utf8')) as string[];
      });
    },
    async readEntry(archive, name) {
      return withArchive(archive, async (path) => {
        const { stdout } = await runProcess('python3', [
          zipScript,
          'read',
          path,
          name,
        ]);
        return new Uint8Array(stdout);
      });
    },
    async rewriteEntries(archive, replacements) {
      const dir = join(scratch, `repl-${Math.random().toString(16).slice(2)}`);
      await mkdir(dir, { recursive: true });
      for (const [name, bytes] of Object.entries(replacements))
        await writeFile(join(dir, name.replace(/\//g, '__')), bytes);
      return withArchive(archive, async (src) => {
        const dst = `${src}.rewritten`;
        await runProcess('python3', [zipScript, 'rewrite', src, dst, dir]);
        const out = new Uint8Array(await readFile(dst));
        await rm(dst, { force: true });
        return out;
      });
    },
    async close() {
      handler = undefined;
      await service.stop(true);
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    },
  };
  return harness;
}

/**
 * The document arguments readOtioProgramArchive needs. Every value is derived from content.otio
 * through the format's own reading of it, never from the manifest under test.
 */
export async function programValidatorArgs(
  zip: OtioZipIndex,
  contentOtio: Uint8Array
): Promise<{
  readonly document_sha256: string;
  readonly timeline_ids: readonly string[];
  readonly media_paths: readonly string[];
}> {
  const mediaIndex = await otioBundleMediaIndex(zip);
  const document = readOtioDocument(contentOtio, { mediaIndex });
  return {
    document_sha256: sha256Text(contentOtio),
    timeline_ids: document.timeline_ids,
    media_paths: otioDocumentMediaPaths(document),
  };
}
