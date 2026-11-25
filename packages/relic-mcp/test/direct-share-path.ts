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
import {
  decodeBase64url,
  identityFingerprint,
  kemKeyIdOf,
  parseStatement,
  statementBytes,
  verifyStatement,
} from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { clickPrivateControl } from './confirmation-private-proof.ts';
import { callMcp, type RunningProofBrowser } from './decision-proof-steps.ts';
import {
  FILE_NAME,
  type Actor,
  type CapturedMail,
  type OwnerKeys,
  type PrivateShareEnv,
  api,
  canonicalOf,
  click,
  cookieHeader,
  identityOf,
  inPage,
  openPanel,
  launchActor,
  nodeSignIn,
  pageCreatePasskey,
  poll,
  postGrant,
  problemCode,
  setField,
  signCountTotal,
  stepsOneToThree,
  stringAt,
  viewerSignIn,
  waitForOpened,
  waitForState,
  currentState,
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
const grantStatuses: number[] = [];
let substitutedLookup: Record<string, unknown> | undefined;
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
  const answered = await target.fetch(replay);
  if (request.method === 'POST' && /\/api\/relics\/[^/]+\/grants$/.test(url.pathname)) {
    grantStatuses.push(answered.status);
  }
  if (substitutedLookup && request.method === 'POST' && url.pathname.endsWith('/grants/lookup')) {
    const value = substitutedLookup;
    substitutedLookup = undefined;
    return Response.json(value);
  }
  return answered;
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
/**
 * Navigates and waits for the document to leave `loading`. The shell's load
 * event is not awaited: a page's own requests can delay it past any bound, and
 * each step waits for the element it needs instead.
 */
async function goto(browser: RunningProofBrowser, url: string): Promise<void> {
  const loaded = browser.cdp.waitForEvent('Page.domContentEventFired', {
    sessionId: browser.sessionId,
    timeoutMs: 25000,
  });
  await browser.cdp.send('Page.navigate', { url }, browser.sessionId);
  await loaded;
}
const mcp = (name: string, args: Record<string, unknown>) =>
  callMcp(env.mcpCommand, scratch, statePath, serviceOrigin, name, args);

/** Lowercase hex of bytes, as the store keys recipients. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}
const FOURTH = 'fourth+direct-share@example.test';
const FIFTH = 'fifth+direct-share@example.test';
const INVITEE = 'invitee+direct-share@example.test';

type Json = Record<string, unknown>;

interface Identity {
  readonly identityId: string;
  readonly kemPublicKey: Uint8Array;
}

interface RowView {
  readonly state: string;
  readonly email: string;
  readonly fingerprint: string | null;
}

interface GrantView {
  readonly statement: Json;
  readonly identity_signature: string;
  readonly revoked_at: string | null;
  readonly grantee: {
    readonly email: string;
    readonly identity: { readonly identity_id: string };
  };
}

/** Sets up a PRF identity in this person's browser, with no grant. */
async function setUpIdentity(
  actor: Actor,
  relicUrl: string
): Promise<Identity> {
  await viewerSignIn(env, actor, relicUrl);
  await inPage(actor.browser, pageCreatePasskey, { prf: true });
  await click(actor.browser, '[data-action="private-setup"]');
  await waitForState(actor.browser, ['request'], `${actor.name} identity`);
  return identityOf(env, actor);
}

/** The Share panel's rows, read from the page. */
async function rowsOf(actor: Actor): Promise<RowView[]> {
  return actor.browser.evaluate<RowView[]>(`(() =>
    Array.from(document.querySelectorAll('[data-share-row]')).map((row) => ({
      state: row.getAttribute('data-share-state') ?? '',
      email: row.querySelector('strong')?.textContent ?? '',
      fingerprint: row.querySelector('[data-fingerprint="recipient"]')?.textContent ?? null,
    })))()`);
}

/** Types addresses into the Share panel and waits until `count` rows show. */
async function addToPanel(
  actor: Actor,
  emails: readonly string[],
  count: number
): Promise<void> {
  await setField(actor.browser, '[data-share-input]', emails.join(', '));
  await click(actor.browser, '[data-add-address]');
  await poll(`${count} share rows`, 25000, async () =>
    (await rowsOf(actor)).length === count ? true : undefined
  );
}

/** One passkey tap on the panel's share button, then the page's confirmation. */
async function tapShare(actor: Actor): Promise<void> {
  await click(actor.browser, '[data-action="share-passkey"]');
  await poll('share confirmation', 60000, async () =>
    (await actor.browser.evaluate<boolean>(
      `document.body.innerText.includes('Shared directly')`
    ))
      ? true
      : undefined
  );
}

/** The owner's session cookie and relik grants, read from the service. */
async function grantsOf(cookie: string, relicId: string): Promise<GrantView[]> {
  const answer = await api(env, 'GET', `/api/relics/${relicId}/grants`, {
    cookie,
  });
  return (answer.json['grants'] ?? []) as GrantView[];
}

async function accessEventsOf(
  cookie: string,
  relicId: string
): Promise<Array<{ kind: string; subject_email?: string | null }>> {
  const answer = await api(
    env,
    'GET',
    `/api/identity/access-log?relic_id=${relicId}`,
    { cookie }
  );
  return (answer.json['events'] ?? []) as Array<{ kind: string }>;
}

/**
 * Forgets this browser's sessions. The browser is this path's own isolated
 * headless profile, so clearing its cookies is safe and leaves no session.
 */
async function signOutBrowser(actor: Actor): Promise<void> {
  await actor.browser.cdp.send(
    'Network.clearBrowserCookies',
    {},
    actor.browser.sessionId
  );
}

/**
 * The page's state. Once the reader is in, the viewer replaces the private host
 * with the ready view, so an absent host is the ready state.
 */
async function stateNow(browser: RunningProofBrowser): Promise<string> {
  return (await currentState(browser)) ?? 'ready';
}

/** Opens the relik in a browser and returns the states the page went through. */
async function openRelik(actor: Actor, relicUrl: string): Promise<string[]> {
  // A signed-out browser: the viewer shows the sign-in form, the reader signs in
  // with the code, then unlocks with the passkey and reaches the ready view.
  // Prevent the virtual authenticator from automatically accepting the
  // conditional passkey sign-in before the code form can be exercised.
  await actor.browser.cdp.send(
    'WebAuthn.setAutomaticPresenceSimulation',
    { authenticatorId: actor.browser.authenticatorId, enabled: false },
    actor.browser.sessionId
  );
  await viewerSignIn(env, actor, relicUrl);
  await actor.browser.cdp.send(
    'WebAuthn.setAutomaticPresenceSimulation',
    { authenticatorId: actor.browser.authenticatorId, enabled: true },
    actor.browser.sessionId
  );
  const seen = ['signin', await stateNow(actor.browser)];
  if (seen[1] === 'unlock') {
    await click(actor.browser, '[data-action="private-unlock"]');
  }
  await waitForOpened(actor.browser, actor.name);
  seen.push(await stateNow(actor.browser));
  return seen;
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
    const { relicId, relicUrl, ownerKeys } = await stepsOneToThree(
      env,
      owner,
      docPath
    );
    const ownerCookie = await nodeSignIn(env, env.owner);
    await goto(owner.browser, relicUrl);
    await setUpIdentity(reader, relicUrl);
    const thirdId = await setUpIdentity(third, relicUrl);
    const fourthId = await setUpIdentity(fourth, relicUrl);
    const fifthId = await setUpIdentity(fifth, relicUrl);

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
    const results = (ownerLookup.json['results'] ?? []) as Json[];
    const fingerprintField = results.some((entry) => 'fingerprint' in entry)
      ? 'present'
      : 'absent';
    const unregisteredNull = results[1]?.['party'] === null;
    const selfStanding = results[2]?.['standing'];
    console.log(
      `DIRECT_STEP_1_LOOKUP_GATE signed_out=${signedOut.status} other_reader=${otherReader.status} public_relik=${publicRefused.status} owner=${ownerLookup.status} fingerprint_field=${fingerprintField} unregistered=${unregisteredNull ? 'null' : 'present'} standing_self=${String(selfStanding)}`
    );
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
    // IP budget (120 units per IP): owner 30, reader 30, third 30, fourth 30.
    // The fifth identity's next lookup is refused by the IP bucket.
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

    // Setup, not a receipt: v2 is sealed, and the reader gets a direct grant so the
    // panel shows an existing reader.
    await writeFile(docPath, 'Direct share proof document, version two.\n');
    await mcp('relic_republish', { relic_id: relicId, path: docPath });
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [env.reader], 1);
    await tapShare(owner);
    await poll('reader grant', 20000, async () =>
      (await grantsOf(ownerCookie, relicId)).some(
        (grant) =>
          grant.grantee.email === env.reader && grant.revoked_at === null
      )
        ? true
        : undefined
    );

    // Step 3. Panel: prefilled from the fragment, the owner's own row, the existing reader.
    // A fragment-only change does not re-mount the page, so leave for a blank page first.
    await goto(owner.browser, 'about:blank');
    await goto(
      owner.browser,
      `${relicUrl}?access=share#to=${encodeURIComponent([env.reader, env.third, env.owner].join(','))}`
    );
    await owner.browser.waitForSelector('[data-share-input]', 25000);
    const prefilled = await poll('prefilled addresses', 25000, async () => {
      const value = await owner.browser.evaluate<string>(
        `document.querySelector('[data-share-input]')?.value ?? ''`
      );
      return value.includes(env.third) ? value : undefined;
    });
    const hashAfterMount =
      await owner.browser.evaluate<string>('location.hash');
    await click(owner.browser, '[data-add-address]');
    await poll('three panel rows', 25000, async () =>
      (await rowsOf(owner)).length === 3 ? true : undefined
    );
    const rows = await rowsOf(owner);
    const reading = rows.find((row) => row.email === env.reader);
    const self = rows.find((row) => row.email === env.owner);
    const thirdRow = rows.find((row) => row.email === env.third);
    const thirdFingerprint = await identityFingerprint(
      thirdId.identityId,
      env.third
    );
    const localMatch =
      thirdRow?.fingerprint !== null &&
      thirdRow?.fingerprint !== undefined &&
      canonicalOf(thirdRow.fingerprint) === canonicalOf(thirdFingerprint);
    console.log(
      `DIRECT_STEP_3_PANEL fingerprints=${localMatch ? 'local_match' : 'mismatch'} self=${self?.state === 'self' ? 'that_is_you' : 'absent'} reader=${reading?.state === 'reader' ? 'already' : 'other'} prefill=${prefilled.includes(env.reader) ? 'fragment' : 'absent'} fragment_after_open=${hashAfterMount === '' ? 'absent' : 'present'}`
    );
    lastReceipt = 3;
    assert.equal(
      localMatch,
      true,
      'the row fingerprint is not the locally computed one'
    );
    assert.equal(self?.state, 'self', 'the owner row is not "that is you"');
    assert.equal(
      reading?.state,
      'reader',
      'the existing reader is not shown as a reader'
    );
    assert.equal(
      hashAfterMount,
      '',
      'the fragment is still in the location after the panel opened'
    );

    // Step 4. One passkey tap grants two registered people, with v2 only.
    await addToPanel(owner, [FOURTH], 4);
    await owner.browser.evaluate<void>(
      `document.querySelector('[data-share-version="1"]')?.click()`
    );
    await poll('v1 unchecked', 10000, async () =>
      (await owner.browser.evaluate<boolean>(
        `document.querySelector('[data-share-version="1"]')?.checked === false`
      ))
        ? true
        : undefined
    );
    const eventsBefore = (await accessEventsOf(ownerCookie, relicId)).length;
    const markBeforeTap = mailbox.mark();
    const signBefore = await signCountTotal(owner.browser);
    await tapShare(owner);
    const signDelta = (await signCountTotal(owner.browser)) - signBefore;
    const grants = await poll('tap grants stored', 20000, async () => {
      const all = await grantsOf(ownerCookie, relicId);
      const tapped = all.filter(
        (grant) =>
          (grant.grantee.email === env.third ||
            grant.grantee.email === FOURTH) &&
          grant.revoked_at === null
      );
      return tapped.length === 2 ? tapped : undefined;
    });
    const sigKey = ownerKeys.keys.sigPublicKey;
    const verifiesUnder = async (list: GrantView[]): Promise<boolean> => {
      for (const grant of list) {
        const bytes = statementBytes(
          'grant',
          parseStatement('grant', grant.statement)
        );
        if (!(await verifyStatement(sigKey, bytes, grant.identity_signature)))
          return false;
      }
      return true;
    };
    const statementsVerify = await verifiesUnder(grants);
    const storedVerify = await verifiesUnder(
      await grantsOf(ownerCookie, relicId)
    );
    const wraps = await store.listWraps(relicId);
    const kemOf = async (id: Identity) =>
      hexOf(await kemKeyIdOf(id.kemPublicKey));
    const thirdKem = await kemOf(thirdId);
    const fourthKem = await kemOf(fourthId);
    const exact = [thirdKem, fourthKem].every(
      (kem) =>
        wraps.filter(
          (wrap) => wrap.recipientKeyId === kem && wrap.version === 2
        ).length === 1 &&
        wraps.filter(
          (wrap) => wrap.recipientKeyId === kem && wrap.version === 1
        ).length === 0
    );
    const newEvents = (await accessEventsOf(ownerCookie, relicId)).slice(
      eventsBefore
    );
    // The owner's own key fetch inside the tap is a wrap_fetch the service logs (service.md 10.6). The
    // receipt names the grant events only; the decision is recorded in PATH.md.
    const logKinds = newEvents
      .filter((event) => event.kind !== 'wrap_fetch')
      .map((event) => event.kind)
      .join(',');
    console.log(
      `DIRECT_STEP_4_ONE_TAP owner_sign_count_delta=${signDelta} grants=${grants.length} statements_verify=${statementsVerify ? 'owner_key' : 'failed'} stored_grant=${storedVerify ? 'reverifies' : 'failed'} wraps=${exact ? 'exact' : 'inexact'} v1_wraps=0 log=${logKinds}`
    );
    lastReceipt = 4;
    assert.equal(
      signDelta,
      1,
      'the share used more than one passkey assertion'
    );
    assert.equal(grants.length, 2, 'the tap did not store exactly two grants');
    assert.equal(
      statementsVerify,
      true,
      'a grant statement did not verify under the owner key'
    );
    assert.equal(storedVerify, true, 'a stored grant did not reverify');
    assert.equal(
      exact,
      true,
      'the wraps are not exactly one v2 wrap per grantee and none for v1'
    );
    assert.equal(
      logKinds,
      'share,share',
      'the access log does not show two share events'
    );

    // Step 5. The notice goes to each new reader, names the owner and carries no title, file or key.
    const noticeSubject = `${env.owner} shared a relik with you`;
    const thirdNotice = await mailbox.await(
      env.third,
      markBeforeTap,
      (mail) => mail.subject === noticeSubject,
      'third direct-share notice'
    );
    const thirdMails = mailbox
      .all()
      .slice(markBeforeTap)
      .filter(
        (mail) =>
          mail.to.toLowerCase() === env.third && mail.subject === noticeSubject
      );
    const fourthMails = mailbox
      .all()
      .slice(markBeforeTap)
      .filter(
        (mail) =>
          mail.to.toLowerCase() === FOURTH && mail.subject === noticeSubject
      );
    const ownFingerprint = canonicalOf(thirdFingerprint);
    const fourthFingerprint = canonicalOf(
      await identityFingerprint(fourthId.identityId, FOURTH)
    );
    const noticeText = canonicalOf(thirdNotice.text);
    console.log(
      `DIRECT_STEP_5_NOTICE per_recipient=${thirdMails.length} names_owner=${thirdNotice.text.includes(env.owner)} fingerprint=${noticeText.includes(ownFingerprint) ? 'own' : 'missing'} title=${thirdNotice.text.includes(FILE_NAME) ? 'present' : 'absent'} file=${thirdNotice.text.includes(FILE_NAME) ? 'present' : 'absent'} fragment=${thirdNotice.text.includes('#k=') ? 'present' : 'absent'} other_recipient=${noticeText.includes(fourthFingerprint) || fourthMails.length === 0 ? 'present' : 'absent'}`
    );
    lastReceipt = 5;
    assert.equal(
      thirdMails.length,
      1,
      'the third reader did not get exactly one notice'
    );
    assert.equal(fourthMails.length, 1, 'the fourth reader did not get exactly one notice');
    assert.ok(canonicalOf(fourthMails[0]!.text).includes(fourthFingerprint));
    assert.ok(!canonicalOf(fourthMails[0]!.text).includes(ownFingerprint));
    assert.ok(!thirdNotice.text.includes(FOURTH));
    assert.ok(!fourthMails[0]!.text.includes(env.third));
    assert.equal(
      thirdNotice.text.includes(env.owner),
      true,
      'the notice does not name the owner'
    );
    assert.equal(
      noticeText.includes(ownFingerprint),
      true,
      'the notice lacks the recipient fingerprint'
    );
    assert.equal(
      thirdNotice.text.includes(FILE_NAME),
      false,
      'the notice names the file'
    );
    assert.equal(
      thirdNotice.text.includes('#k='),
      false,
      'the notice carries a fragment'
    );
    assert.equal(
      noticeText.includes(fourthFingerprint),
      false,
      'the notice names another recipient'
    );

    // Step 6. The third reader opens with no request, from a signed-out browser.
    await signOutBrowser(third);
    const states = await openRelik(third, relicUrl);
    const v2Visible = await third.browser.evaluate<boolean>(
      `document.body.innerText.includes('version two')`
    );
    const requests = await store.listAccessRequests(relicId);
    const requested = requests.some(
      (row) => row.requesterIdentityId === thirdId.identityId
    );
    const v1Key = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/1/key`,
      {
        cookie: await cookieHeader(third.browser),
      }
    );
    const sharedWithMe = await api(env, 'GET', '/api/identity/relics', {
      cookie: await cookieHeader(third.browser),
    });
    const listed = (
      (sharedWithMe.json['shared_with_me'] ?? []) as Array<{ relic_id: string }>
    ).some((item) => item.relic_id === relicId);
    console.log(
      `DIRECT_STEP_6_RECIPIENT_OPENS states=${states.join(',')} request_state=${requested ? 'requested' : 'never'} v2=${v2Visible ? 'opened' : 'missing'} v1_key=${v1Key.status} shared_with_you=${listed ? 'listed' : 'absent'}`
    );
    lastReceipt = 6;
    assert.equal(v2Visible, true, 'the recipient cannot read version two');
    assert.equal(requested, false, 'the recipient created an access request');
    assert.equal(
      v1Key.status,
      403,
      'the recipient fetched the version one key'
    );
    assert.equal(
      listed,
      true,
      'the shared relik is not listed for the recipient'
    );

    // Step 7. The owner seals a later version; the recipient reads it without a new tap.
    await writeFile(docPath, 'Direct share proof document, version three.\n');
    await mcp('relic_republish', { relic_id: relicId, path: docPath });
    await goto(third.browser, relicUrl);
    await waitForState(
      third.browser,
      ['unlock', 'ready'],
      'third later version'
    );
    if ((await currentState(third.browser)) === 'unlock') {
      await click(third.browser, '[data-action="private-unlock"]');
    }
    await waitForOpened(third.browser, 'third');
    const v3Visible = await third.browser.evaluate<boolean>(
      `document.body.innerText.includes('version three')`
    );
    console.log(
      `DIRECT_STEP_7_LATER_VERSION mcp_republish=sealed mcp_roster=accepts_batch_grants recipient_v3=${v3Visible ? 'opened' : 'missing'}`
    );
    lastReceipt = 7;
    assert.equal(v3Visible, true, 'the recipient cannot read version three');

    // Repeating a live grant must fail before it changes any recipient wrap.
    const wrapsBeforeRepeat = await store.listWraps(relicId);
    const repeated = await postGrant(env, owner, ownerKeys, {
      relicId,
      granteeEmail: env.third,
      granteeIdentityId: thirdId.identityId,
      fingerprint: thirdFingerprint,
      versions: [3],
    });
    assert.equal(repeated.status, 409, 'repeating a grant must return 409');
    assert.equal(problemCode(repeated), 'grant_exists');
    assert.deepEqual(await store.listWraps(relicId), wrapsBeforeRepeat);

    // Revoke the reader through the same panel that performs the rekey.
    await openPanel(owner, relicUrl);
    await clickPrivateControl(
      owner.browser,
      `button[data-action="revoke"][aria-label="Revoke ${env.third}"]`
    );
    await owner.browser.waitForSelector('#revoke-dialog[open]', 25000);
    await click(owner.browser, '[data-action="confirm-revoke"]');
    await owner.browser.waitForSelector('#rekey[data-rekey-state="done"]', 90000);
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [env.third], 1);
    const grantsBeforeRegrant = grantStatuses.length;
    await tapShare(owner);
    assert.deepEqual(grantStatuses.slice(grantsBeforeRegrant), [201]);
    const regranted = (await grantsOf(ownerCookie, relicId)).find(
      (grant) => grant.grantee.email === env.third && grant.revoked_at === null
    );
    assert.ok(regranted, 'the revoked reader was not granted again');
    await goto(third.browser, relicUrl);
    await waitForState(third.browser, ['unlock'], 'regranted reader unlock');
    await click(third.browser, '[data-action="private-unlock"]');
    await waitForOpened(third.browser, 'regranted reader');
    console.log(
      'DIRECT_STEP_8_REPEAT_AND_REVOKED repeat_api=409_grant_exists wraps_unchanged=true revoked_regrant=201 revoked_reader_opens=current'
    );
    lastReceipt = 8;

    const currentVersion = Math.max(...(await store.listWraps(relicId)).map((wrap) => wrap.version));
    const lookupFifth = await api(env, 'POST', `/api/relics/${relicId}/grants/lookup`, {
      cookie: ownerCookie, body: { emails: [FIFTH] },
    });
    assert.equal(lookupFifth.status, 200);
    const fifthEntry = (lookupFifth.json['results'] as Json[])[0];
    assert.ok(fifthEntry);
    const fifthParty = fifthEntry['party'] as Json;
    substitutedLookup = {
      results: [{ ...fifthEntry, email: env.third, standing: 'none',
        party: { ...fifthParty, email: env.third } }],
    };
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [env.third], 1);
    const substitutedRow = (await rowsOf(owner))[0];
    const substituteFingerprint = await identityFingerprint(fifthId.identityId, env.third);
    assert.equal(canonicalOf(substitutedRow?.fingerprint ?? ''), canonicalOf(substituteFingerprint));
    const fifthFingerprint = await identityFingerprint(fifthId.identityId, FIFTH);
    const refusedSelf = await postGrant(env, owner, ownerKeys, {
      relicId, granteeEmail: env.owner, granteeIdentityId: ownerKeys.identityId,
      fingerprint: await identityFingerprint(ownerKeys.identityId, env.owner),
      versions: [currentVersion],
    });
    assert.equal(refusedSelf.status, 400);
    assert.equal(refusedSelf.json['statement_check'], 'grantee');
    const refusedFingerprint = await postGrant(env, owner, ownerKeys, {
      relicId, granteeEmail: FIFTH, granteeIdentityId: fifthId.identityId,
      fingerprint: `${fifthFingerprint.slice(0, -1)}${fifthFingerprint.endsWith('0') ? '1' : '0'}`,
      versions: [currentVersion],
    });
    assert.equal(refusedFingerprint.status, 409);
    assert.equal(problemCode(refusedFingerprint), 'fingerprint_mismatch');
    const substituted = await postGrant(env, owner, ownerKeys, {
      relicId, granteeEmail: env.third, granteeIdentityId: fifthId.identityId,
      fingerprint: substituteFingerprint, versions: [currentVersion],
    });
    assert.equal(substituted.status, 400);
    assert.equal(substituted.json['statement_check'], 'grantee');
    const fifthKem = hexOf(await kemKeyIdOf(fifthId.kemPublicKey));
    assert.equal((await store.listWraps(relicId)).filter((wrap) => wrap.recipientKeyId === fifthKem).length, 0);
    const originalFifth = await store.getIdentity(fifthId.identityId);
    assert.ok(originalFifth);
    await store.updateIdentity(fifthId.identityId, (row) => ({ ...row, retiredAt: Date.now() }));
    try {
      const retired = await postGrant(env, owner, ownerKeys, {
        relicId, granteeEmail: FIFTH, granteeIdentityId: fifthId.identityId,
        fingerprint: fifthFingerprint, versions: [currentVersion],
      });
      assert.equal(retired.status, 400);
      assert.equal(retired.json['statement_check'], 'grantee');
    } finally {
      await store.updateIdentity(fifthId.identityId, () => originalFifth);
    }
    console.log(
      'DIRECT_STEP_9_REFUSALS self=400_grantee wrong_fingerprint=409 substituted_lookup=ui_shows_substitute substituted_api=400_grantee substitute_wraps=0 retired_identity=400_grantee'
    );
    lastReceipt = 9;

    // A pending request still follows the original grant mail and log path.
    await click(fifth.browser, '[data-action="private-request"]');
    await waitForState(fifth.browser, ['requested'], 'fifth requested');
    const requestedLookup = await api(env, 'POST', `/api/relics/${relicId}/grants/lookup`, {
      cookie: ownerCookie, body: { emails: [FIFTH] },
    });
    assert.equal(requestedLookup.status, 200);
    assert.equal(((requestedLookup.json['results'] as Json[])[0])?.['standing'], 'requested');
    const requestMailMark = mailbox.mark();
    const requestEventsBefore = (await accessEventsOf(ownerCookie, relicId)).length;
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [FIFTH], 1);
    await tapShare(owner);
    await mailbox.await(FIFTH, requestMailMark, (mail) => mail.subject === 'You have access to a relik', 'request grant mail');
    const requestGrantEvents = (await accessEventsOf(ownerCookie, relicId))
      .slice(requestEventsBefore).filter((event) => event.kind !== 'wrap_fetch');
    assert.deepEqual(requestGrantEvents.map((event) => event.kind), ['grant']);
    console.log('DIRECT_STEP_10_REQUEST_PATH lookup_standing=requested grant_log=grant grant_mail=unchanged');
    lastReceipt = 10;
    throw new Error('steps 11 to 26 are not yet written in this checkpoint');
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
