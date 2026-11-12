/**
 * Manual, human-driven rehearsal of Relic private shares against loopback, with
 * real authenticators (plan section 5 S8, step 7.4 and 7.9).
 *
 *   RELIC_MANUAL_PORT=8787 bun packages/relic-mcp/test/private-shares-manual.ts
 *
 * What Jason does, in order, in Chrome and then Safari on his Mac (iCloud
 * Keychain, plus a security key if he has one). Each person is a different
 * address on the loopback service, and the service prints every mail here:
 *
 *   1. Publish. Run relic-mcp with RELIC_SERVICE_ORIGIN set to the printed origin,
 *      enroll the device (relic_enroll_device), open the approval link printed,
 *      type the device fingerprint, approve with a passkey, then type the owner
 *      fingerprint into relic_confirm_device. Publish with private set to true.
 *   2. Owner opens the printed relic link, signs in with the code printed here,
 *      and unlocks with the passkey.
 *   3. Reader opens the same link with another address, signs in, sets up a key
 *      (a PRF passkey), and asks for access. The reader reads the fingerprint on
 *      the page to the owner.
 *   4. Owner opens ?access=requests, types the reader's fingerprint, and grants
 *      with one passkey tap.
 *   5. Owner revokes the reader from the access panel, and waits for the rekey.
 *   6. Owner deletes the whole relic from the access panel.
 *
 * What it records, per provider (Chrome/iCloud Keychain, Safari/iCloud Keychain,
 * and a security key if used): the answers to the questions the script asks at
 * the end. The file is written to the path the script prints. Each row names the
 * provider, whether PRF worked on the existing passkey, whether the replacement
 * passkey was accepted, whether the unlock opened the relic, and which of steps
 * 1 to 6 Jason completed. Nothing is written to any production system: the
 * loopback service is in memory and is discarded when the script exits.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { fileURLToPath } from 'node:url';

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const port = Number(process.env['RELIC_MANUAL_PORT'] ?? '8787');
const serviceOrigin = `http://localhost:${port}`;

const store = new MemoryStore();
const storage = new MemoryStorage(`${serviceOrigin}/__storage`);
const app = createApp({
  config: { serviceOrigin },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens: new Map([['operator-token', 'manual-operator-secret']]),
  assets: diskAssets(viewerDist),
  mailer: {
    send: async (to, link, code) => {
      console.log(`\nMAIL sign-in to=${to}\n  code: ${code}\n  link: ${link}`);
    },
    sendMail: async (to, mail) => {
      console.log(`\nMAIL to=${to} subject=${mail.subject}\n${mail.text}`);
    },
  },
});

const service = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
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
      if (!bytes) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return app.fetch(request);
  },
});

console.log(`PRIVATE_SHARES_MANUAL_READY origin=${serviceOrigin}`);
console.log(
  `Mail prints above. Scratch directory: ${join(tmpdir(), 'relic-private-shares-manual')}`
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const receipts: Array<Record<string, string>> = [];
try {
  for (;;) {
    const provider = (
      await rl.question('\nProvider to record (blank to finish): ')
    ).trim();
    if (provider === '') break;
    const prf = (
      await rl.question('PRF on the existing passkey? (yes/no): ')
    ).trim();
    const replacement = (
      await rl.question(
        'Replacement passkey: accepted / refused / not_offered: '
      )
    ).trim();
    const unlock = (
      await rl.question('Unlock opened the relic? (yes/no): ')
    ).trim();
    const steps = (
      await rl.question('Steps completed (1-6, comma separated): ')
    ).trim();
    receipts.push({
      provider,
      prf_existing: prf,
      replacement,
      unlock,
      steps_completed: steps,
    });
  }
} finally {
  rl.close();
  service.stop(true);
}

const directory = join(tmpdir(), 'relic-private-shares-manual');
await mkdir(directory, { recursive: true });
const file = join(
  directory,
  `receipts-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
await writeFile(
  file,
  receipts.map((row) => JSON.stringify(row)).join('\n') +
    (receipts.length > 0 ? '\n' : '')
);
console.log(
  `PRIVATE_SHARES_MANUAL_RECEIPTS rows=${receipts.length} file=${file}`
);
