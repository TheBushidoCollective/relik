import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import {
  type CapturedMail,
  type Mailbox,
  runPrivateFolderRekey,
} from '../private-shares-steps.ts';

const chromePath = findHeadlessShell();
if (!chromePath) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  console.log('MULTI_FILE_STAGE private-rekey SKIP (headless shell missing)');
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'relic-private-folder-'));
  const store = new MemoryStore();
  const mails: CapturedMail[] = [];
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const service = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      handler ? handler(request) : new Response('Not ready', { status: 503 }),
  });
  const serviceOrigin = `http://localhost:${service.port}`;
  const storage = new MemoryStorage(`${serviceOrigin}/__storage`);
  const app = createApp({
    config: { serviceOrigin },
    store,
    storage,
    now: () => Date.now(),
    operatorTokens: new Map([['operator-token', 'test-operator-secret']]),
    assets: diskAssets(
      fileURLToPath(new URL('../../../relic-viewer/dist/', import.meta.url))
    ),
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
  handler = async (request) => {
    const url = new URL(request.url);
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
      return bytes
        ? new Response(Buffer.from(bytes), { status: 200 })
        : new Response('Not found', { status: 404 });
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
      throw new Error(`${label} for ${to} did not arrive`);
    },
  };
  try {
    await runPrivateFolderRekey({
      serviceOrigin,
      scratchDir: scratch,
      statePath: join(scratch, 'state.json'),
      mcpCommand: [
        'node',
        fileURLToPath(new URL('../../dist/relic-mcp.js', import.meta.url)),
      ],
      chromePath,
      owner: 'owner+folder@example.test',
      reader: 'revoked+folder@example.test',
      third: 'survivor+folder@example.test',
      noPrf: 'noprf+folder@example.test',
      mailbox,
      store,
      storage,
      receipt: (_step, line) => console.log(line),
      defect: (id, evidence) => {
        throw new Error(`${id}: ${evidence}`);
      },
    });
  } finally {
    service.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
}
