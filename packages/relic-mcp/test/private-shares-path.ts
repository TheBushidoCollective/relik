/**
 * Loopback proof for Relic private shares (plan section 5 S8).
 *
 *   RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/private-shares-path.ts
 *
 * Boots the real server (createApp, MemoryStore, MemoryStorage) on loopback with
 * a captured mailer, serves the built viewer, drives four isolated headless
 * browsers (three PRF virtual authenticators and one without PRF) and the real
 * relic-mcp over stdio. Prints the eleven PRIVATE_STEP receipts in order, then
 * PRIVATE_SHARES_PATH_OK when every step passed and no product defect was
 * found. A failed assertion, or any defect, names its step or defect and exits
 * nonzero.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import {
  type CapturedMail,
  type Mailbox,
  type PrivateShareEnv,
  runPrivateShares,
} from './private-shares-steps.ts';

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundle = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

async function resolveChrome(): Promise<string> {
  const envChrome = process.env['RELIC_CHROME_PATH'];
  if (envChrome && envChrome !== 'none') return envChrome;
  const discovered = await discoverChrome(undefined);
  if (discovered.kind === 'found') return discovered.path;
  throw new Error(
    'RELIC_CHROME_PATH must name an owned headless Chrome or chrome-headless-shell binary'
  );
}

const chromePath = await resolveChrome();
const scratch = await mkdtemp(join(tmpdir(), 'relic-private-shares-path-'));
const statePath = join(scratch, 'publish-state.json');

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: CapturedMail[] = [];
const defects: string[] = [];

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
  config: { serviceOrigin },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async (to, link, code) => {
      mails.push({
        to,
        subject: 'sign-in',
        text: link,
        link,
        ...(code === undefined ? {} : { code }),
      });
    },
    sendMail: async (to, mail) => {
      mails.push({ to, subject: mail.subject, text: mail.text });
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
    storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
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

const mailbox: Mailbox = {
  mark: () => mails.length,
  all: () => mails,
  async await(to, since, match, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const found = mails
        .slice(since)
        .find(
          (mail) => mail.to.toLowerCase() === to.toLowerCase() && match(mail)
        );
      if (found) return found;
      await Bun.sleep(50);
    }
    throw new Error(`${label} for ${to} did not arrive in the captured mailer`);
  },
};

let lastReceipt = 0;
try {
  const env: PrivateShareEnv = {
    serviceOrigin,
    scratchDir: scratch,
    statePath,
    mcpCommand: ['node', relicMcpBundle],
    chromePath,
    owner: 'owner+private-shares@example.test',
    reader: 'reader+private-shares@example.test',
    third: 'third+private-shares@example.test',
    noPrf: 'noprf+private-shares@example.test',
    mailbox,
    store,
    storage,
    receipt: (step, line) => {
      lastReceipt = step;
      console.log(line);
    },
    defect: (id, evidence) => {
      defects.push(id);
      console.error(`DEFECT ${id}: ${evidence}`);
    },
  };
  await runPrivateShares(env);
  if (defects.length > 0) {
    console.error(`PRIVATE_SHARES_PATH_BLOCKED defects=${defects.join(',')}`);
    process.exitCode = 1;
  } else {
    console.log('PRIVATE_SHARES_PATH_OK');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `PRIVATE_SHARES_PATH_FAILED last_receipt_step=${lastReceipt} (the failing step is the one after it, or the one that was printing) ${message}`
  );
  process.exitCode = 1;
} finally {
  service.stop(true);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
