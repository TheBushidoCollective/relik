/**
 * Loopback proof for Relic passkey decisions (spec §7).
 *
 *   RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/decision-path.ts
 *
 * Starts a loopback server with MemoryStore and MemoryStorage, binding 127.0.0.1
 * with serviceOrigin = http://localhost:<port> so WebAuthn RP ID checks pass.
 * Runs all 10 steps of the decision proof sequence and ends with DECISION_PATH_OK.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { runDecisionProofSequence } from './decision-proof-steps.ts';

const clientMode = process.env['RELIC_DECISION_PATH_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): readonly string[] {
  if (isNpxMode) {
    const pkg = clientMode.slice(4);
    return ['npx', '-y', `relic-mcp@${pkg}`];
  }
  return ['node', relicMcpBundlePath];
}

async function resolveChrome(): Promise<string> {
  const envChrome = process.env['RELIC_CHROME_PATH'];
  if (envChrome && envChrome !== 'none') {
    return envChrome;
  }
  const discovered = await discoverChrome(undefined);
  if (discovered.kind === 'found') {
    return discovered.path;
  }
  throw new Error(
    'RELIC_CHROME_PATH must be set to an executable Chrome binary or headless shell'
  );
}

const chromePath = await resolveChrome();
const scratch = await mkdtemp(join(tmpdir(), 'relic-decision-path-'));
const statePath = join(scratch, 'state.json');

// --- App server setup with MemoryStore and MemoryStorage -----------------
const fakeNow = Date.now();
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: { to: string; mail: OutboundMail }[] = [];

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});

const serviceOrigin = `http://localhost:${service.port}`;
const storage = new MemoryStorage(`${serviceOrigin}/__storage`);

const app = createApp({
  config: {
    serviceOrigin,
  },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async (to, mail) => {
      mails.push({ to, mail });
    },
  },
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

async function resolveMagicLink(email: string): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = mails.find((m) => m.to.toLowerCase() === email.toLowerCase());
    if (found) {
      const match = found.mail.text.match(
        new RegExp(
          `http://localhost:${service.port}/api/auth/callback\\?token=[A-Za-z0-9_-]{43}`
        )
      );
      if (match) return match[0];
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`Magic link for ${email} did not arrive in captured mailer`);
}

try {
  await runDecisionProofSequence({
    serviceOrigin,
    scratchDir: scratch,
    statePath,
    mcpCommand: resolveCommand(),
    chromePath,
    readerEmail: 'reader+relic-decision-loopback@example.test',
    resolveMagicLink,
    isLive: false,
  });

  console.log('DECISION_PATH_OK');
} finally {
  service.stop();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
