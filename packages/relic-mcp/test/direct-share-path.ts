/**
 * Direct share and invitations acceptance path (plan section 10).
 *
 *   RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/direct-share-path.ts
 *
 * Boots the real server on loopback: two createApp instances over one store
 * answer the traffic, and a third instance answers only the budget probes,
 * because budgets are per instance. The viewer is served from the built dist,
 * the browsers are isolated headless shells with virtual authenticators, and
 * relic-mcp runs over stdio. A harness-controlled clock is injected through
 * createApp `now`. Every request body is captured for the key assertions.
 *
 * Prints one receipt per step in order. A failed assertion or a product defect
 * names its step and exits nonzero. Steps not yet written fail with a message
 * naming them, so a partial run can never print DIRECT_SHARE_PATH_OK.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { callMcp } from './decision-proof-steps.ts';
import {
  FILE_NAME,
  api,
  click,
  cookieHeader,
  goto,
  identityOf,
  inPage,
  launchActor,
  nodeSignIn,
  pageCreatePasskey,
  poll,
  setField,
  signCountTotal,
  stepsOneToThree,
  stringAt,
  textOf,
  viewerSignIn,
  waitForOpened,
  waitForState,
  type Actor,
  type CapturedMail,
  type PrivateShareEnv,
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
const scratch = await mkdtemp(join(tmpdir(), 'relic-direct-share-path-'));
const statePath = join(scratch, 'publish-state.json');

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: CapturedMail[] = [];
const defects: string[] = [];
/** Every request body the service received, for the fragment and key assertions. */
const requestBodies: string[] = [];
/** Harness clock: real time plus an offset that the expiry steps move and restore. */
const clockOffsetMs = 0;
const clock = (): number => Date.now() + clockOffsetMs;

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

const appOptions = {
  config: { serviceOrigin },
  store,
  storage,
  now: clock,
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async (to: string, link: string, code?: string) => {
      mails.push({
        to,
        subject: 'sign-in',
        text: link,
        link,
        ...(code === undefined ? {} : { code }),
      });
    },
    sendMail: async (to: string, mail: { subject: string; text: string }) => {
      mails.push({ to, subject: mail.subject, text: mail.text });
    },
  },
};
const apps = [createApp(appOptions), createApp(appOptions)];
/** Answers only the budget probes, so the main apps' budgets stay intact. */
const budgetApp = createApp(appOptions);
let budgetProbe = false;
let nextApp = 0;

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
  const bytes =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
  if (bytes !== undefined) requestBodies.push(new TextDecoder().decode(bytes));
  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(bytes === undefined ? {} : { body: bytes.slice(0) }),
  });
  const target = budgetProbe ? budgetApp : apps[nextApp++ % apps.length]!;
  return target.fetch(replay);
};

const mailbox = {
  mark: () => mails.length,
  all: () => mails,
  async await(
    to: string,
    since: number,
    match: (mail: CapturedMail) => boolean,
    label: string
  ): Promise<CapturedMail> {
    return poll(label, 20000, async () =>
      mails
        .slice(since)
        .find(
          (mail) => mail.to.toLowerCase() === to.toLowerCase() && match(mail)
        )
    );
  },
};

let lastReceipt = 0;
const env: PrivateShareEnv = {
  serviceOrigin,
  scratchDir: scratch,
  statePath,
  mcpCommand: ['node', relicMcpBundle],
  chromePath,
  owner: 'owner+direct-share@example.test',
  reader: 'reader+direct-share@example.test',
  third: 'third+direct-share@example.test',
  noPrf: 'noprf+direct-share@example.test',
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
const mcp = (name: string, args: Record<string, unknown>) =>
  callMcp(env.mcpCommand, scratch, statePath, serviceOrigin, name, args);

const FOURTH = 'fourth+direct-share@example.test';
const FIFTH = 'fifth+direct-share@example.test';
const INVITEE = 'invitee+direct-share@example.test';

type Json = Record<string, unknown>;
type Lookup = { results: Array<Json> };

/** Sets up a PRF identity in this person's browser, without any grant. */
async function setUpIdentity(actor: Actor, relicUrl: string): Promise<void> {
  await viewerSignIn(env, actor, relicUrl);
  await inPage(actor.browser, pageCreatePasskey, { prf: true });
  await click(actor.browser, '[data-action="private-setup"]');
  await waitForState(actor.browser, ['request'], `${actor.name} identity`);
  await identityOf(env, actor);
}

/** Grants the owner's Share panel with the listed addresses, one passkey tap. */
async function shareTap(
  owner: Actor,
  relicUrl: string,
  query: string
): Promise<void> {
  await goto(owner.browser, `${relicUrl}?access=share${query}`);
  await owner.browser.waitForSelector('[data-share-section]', 25000);
  await click(owner.browser, '[data-add-address]');
}

async function run(): Promise<void> {
  const owner = await launchActor(env, 'owner', env.owner, true);
  const reader = await launchActor(env, 'reader', env.reader, true);
  const third = await launchActor(env, 'third', env.third, true);
  const fourth = await launchActor(env, 'fourth', FOURTH, true);
  const fifth = await launchActor(env, 'fifth', FIFTH, true);
  const invitee = await launchActor(env, 'invitee', INVITEE, true);
  const actors = [owner, reader, third, fourth, fifth, invitee];
  try {
    const docPath = join(scratch, FILE_NAME);
    await writeFile(docPath, 'Direct share proof document, version one.\n');
    const { relicId, relicUrl } = await stepsOneToThree(env, owner, docPath);
    const ownerCookie = await nodeSignIn(env, env.owner);
    await goto(owner.browser, relicUrl);
    await setUpIdentity(reader, relicUrl);
    await setUpIdentity(third, relicUrl);
    await setUpIdentity(fourth, relicUrl);
    await setUpIdentity(fifth, relicUrl);

    // Step 1. Lookup gate.
    const readerCookie = await cookieHeader(reader.browser);
    const publicPath = join(scratch, 'public-proof.txt');
    await writeFile(publicPath, 'A public relik for the lookup gate.\n');
    const publicId = stringAt(
      await mcp('relic_publish', { path: publicPath }),
      'relic_id',
      'public relik'
    );
    const twoAddresses = { emails: [env.reader, INVITEE] };
    const signedOut = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        body: twoAddresses,
      }
    );
    const otherReader = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        cookie: readerCookie,
        body: twoAddresses,
      }
    );
    const publicRefused = await api(
      env,
      'POST',
      `/api/relics/${publicId}/grants/lookup`,
      {
        cookie: ownerCookie,
        body: twoAddresses,
      }
    );
    const ownerLookup = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        cookie: ownerCookie,
        body: { emails: [env.reader, INVITEE, env.owner] },
      }
    );
    const results =
      (ownerLookup.json['results'] as Lookup['results'] | undefined) ?? [];
    const fingerprintField = results.some((entry) => 'fingerprint' in entry)
      ? 'present'
      : 'absent';
    const unregisteredNull = results[1]?.['party'] === null;
    const selfStanding = results[2]?.['standing'];
    const lookupLine = `DIRECT_STEP_1_LOOKUP_GATE signed_out=${signedOut.status} other_reader=${otherReader.status} public_relik=${publicRefused.status} owner=${ownerLookup.status} fingerprint_field=${fingerprintField} unregistered=${unregisteredNull ? 'null' : 'present'} standing_self=${String(selfStanding)}`;
    console.log(lookupLine);
    assert.equal(signedOut.status, 401, 'signed-out lookup is not 401');
    assert.equal(otherReader.status, 403, 'non-owner lookup is not 403');
    assert.equal(publicRefused.status, 400, 'public relik lookup is not 400');
    assert.equal(ownerLookup.status, 200, 'owner lookup is not 200');
    assert.equal(fingerprintField, 'absent', 'lookup returned a fingerprint');
    assert.equal(
      unregisteredNull,
      true,
      'an address with no identity returned a party'
    );
    assert.equal(selfStanding, 'owner', 'the owner is not shown as owner');
    lastReceipt = 1;

    // Step 2. Budgets, on the budget instance (budgets are per instance).
    // Owner spends 30 address units in ten calls of three; the next call is refused.
    budgetProbe = true;
    const probeRows = (call: number) => [
      env.reader,
      env.third,
      `probe-${call}@direct-share.example.test`,
    ];
    for (let call = 0; call < 10; call++) {
      const spent = await api(
        env,
        'POST',
        `/api/relics/${relicId}/grants/lookup`,
        {
          cookie: ownerCookie,
          body: { emails: probeRows(call) },
        }
      );
      assert.equal(
        spent.status,
        200,
        `budget call ${call} refused before 30 units`
      );
    }
    const perAddressRefused = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        cookie: ownerCookie,
        body: { emails: [env.reader] },
      }
    );
    const sharedRecovery = await api(
      env,
      'POST',
      '/api/identity/recovery/lookup',
      {
        cookie: ownerCookie,
        body: { email: env.reader },
      }
    );
    // A non-owner's refused lookups are not charged: its recovery lookups still pass.
    for (let call = 0; call < 5; call++) {
      await api(env, 'POST', `/api/relics/${relicId}/grants/lookup`, {
        cookie: readerCookie,
        body: twoAddresses,
      });
    }
    const readerRecovery = await api(
      env,
      'POST',
      '/api/identity/recovery/lookup',
      {
        cookie: readerCookie,
        body: { email: env.owner },
      }
    );
    // IP budget (120 units per IP): owner 30, reader 30, third 30 and fourth 30
    // are 120 units. The fifth identity's next lookup is refused by the IP bucket.
    const spendRecovery = async (
      cookie: string,
      count: number,
      label: string
    ) => {
      for (let i = 0; i < count; i++) {
        const answer = await api(env, 'POST', '/api/identity/recovery/lookup', {
          cookie,
          body: { email: `ip-${label}-${i}@direct-share.example.test` },
        });
        assert.equal(
          answer.status,
          200,
          `${label} recovery lookup ${i} refused`
        );
      }
    };
    await spendRecovery(readerCookie, 29, 'reader');
    await spendRecovery(await cookieHeader(third.browser), 30, 'third');
    await spendRecovery(await cookieHeader(fourth.browser), 30, 'fourth');
    const ipRefused = await api(env, 'POST', '/api/identity/recovery/lookup', {
      cookie: await cookieHeader(fifth.browser),
      body: { email: 'ip-final@direct-share.example.test' },
    });
    budgetProbe = false;
    const perAddressOk = perAddressRefused.status === 429;
    const sharedOk = sharedRecovery.status === 429;
    const nonOwnerCharged = readerRecovery.status !== 200;
    console.log(
      `DIRECT_STEP_2_BUDGET per_address=${perAddressOk} shared_with_recovery=${sharedOk} ip_budget=${ipRefused.status} non_owner_charged=${nonOwnerCharged}`
    );
    lastReceipt = 2;
    assert.equal(
      perAddressOk,
      true,
      'per-address charging did not refuse at 30 units'
    );
    assert.equal(
      sharedOk,
      true,
      'the recovery lookup does not share the owner bucket'
    );
    assert.equal(nonOwnerCharged, false, 'the non-owner refusals were charged');
    assert.equal(ipRefused.status, 429, 'the IP budget did not refuse');

    // Setup, not a receipt: the owner republishes v2, then grants the reader (v1 and v2) so the
    // panel has an existing reader.
    await writeFile(docPath, 'Direct share proof document, version two.\n');
    await mcp('relic_republish', { relic_id: relicId, path: docPath });
    await shareTap(owner, relicUrl, '');
    await goto(owner.browser, relicUrl);
    throw new Error('steps 3 to 26 are not yet written in this checkpoint');
  } finally {
    for (const actor of actors) await actor.browser.close().catch(() => {});
  }
}

try {
  await run();
  if (defects.length > 0) {
    console.error(`DIRECT_SHARE_PATH_BLOCKED defects=${defects.join(',')}`);
    process.exitCode = 1;
  } else {
    console.log('DIRECT_SHARE_PATH_OK');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `DIRECT_SHARE_PATH_FAILED last_receipt_step=${lastReceipt} ${message}`
  );
  process.exitCode = 1;
} finally {
  service.stop(true);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
