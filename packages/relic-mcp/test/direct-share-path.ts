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
  encodeBase64url,
  generateInviteKeyPair,
  inviteRecipient,
  parseInviteFragment,
  unwrapVersionKey,
  identityFingerprint,
  kemKeyIdOf,
  parseStatement,
  statementBytes,
  verifyStatement,
  signStatement,
} from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import { loadPublishState } from '../src/state.ts';
import { clickPrivateControl } from './confirmation-private-proof.ts';
import { callMcp, type RunningProofBrowser } from './decision-proof-steps.ts';
import {
  FILE_NAME,
  type Actor,
  type CapturedMail,
  type PrivateShareEnv,
  attestationFor,
  callMcpRaw,
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
  localPrivateState,
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
process.env['RELIC_PUBLISH_STATE'] = statePath;

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: CapturedMail[] = [];
const defects: string[] = [];
/** Every request body the service received, for the fragment and key assertions. */
const requestBodies: string[] = [];
let serviceCalls = 0;
/** Invitation claims as the browser sent them, for the single-use replay in step 5. */
const claimCalls: Array<{ path: string; body: Json; status: number }> = [];
const grantStatuses: number[] = [];
let claimTapProbe: (() => Promise<number>) | undefined;
let setupTapCount: number | undefined;
let claimTapCount: number | undefined;
let substitutedLookup: Record<string, unknown> | undefined;
/** Harness clock: real time plus an offset that the expiry steps move and restore. */
let clockOffsetMs = 0;
/** Counts the viewer's address lookups, so a public signer can be shown to make none. */
let lookupCalls = 0;
/** The next private grant POST is answered by the kill-switch app; its request is kept for a replay. */
let killNextGrant = false;
let killedGrant:
  | {
      url: string;
      headers: Headers;
      body: Uint8Array;
      status: number;
      code: string;
    }
  | undefined;
/** The next signing request has its grant rewritten and re-signed by the owner key, then is refused. */
let tamperMode: 'grantee' | 'versions' | undefined;
let tamperTarget: { email: string; identityId: string } | undefined;
let tamperSign: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
let tamperResult:
  | { status: number; code: string; statementCheck: unknown }
  | undefined;
const clock = (): number => Date.now() + clockOffsetMs;
/** Section 10 receipts, printed in plan order at the end of the run. */
const proofLines: Array<{ order: number; line: string }> = [];
function emit(order: number, line: string): void {
  proofLines.push({ order, line });
}
/** The key text after `#k=` in an invitation link: the only place the invite key lives. */
function fragmentKeyOf(url: string): string {
  return new URL(url).hash.slice('#k='.length);
}

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
  config: { serviceOrigin, authRateLimit: { limit: 100, windowSeconds: 3600 } },
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
/** Refuses every write with the kill switch engaged, over the same store. */
const killedApp = createApp({
  ...appOptions,
  config: { ...appOptions.config, killSwitchEngaged: true },
});
/** Answers only the budget probes, so the main apps' budgets stay intact. */
let budgetApp = createApp(appOptions);
let budgetProbe = false;
let nextApp = 0;

handler = async (request: Request): Promise<Response> => {
  // Browsers keep talking to the service in the background; relic-mcp and the harness are plain fetch clients.
  if (!(request.headers.get('user-agent') ?? '').includes('Mozilla'))
    serviceCalls++;
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
  if (request.method === 'POST' && url.pathname.endsWith('/grants/lookup'))
    lookupCalls++;
  if (
    killNextGrant &&
    request.method === 'POST' &&
    bytes !== undefined &&
    /\/api\/relics\/[^/]+\/grants$/.test(url.pathname)
  ) {
    killNextGrant = false;
    const refused = await killedApp.fetch(
      new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: bytes.slice(0),
      })
    );
    const problem = (await refused
      .clone()
      .json()
      .catch(() => ({}))) as Json;
    killedGrant = {
      url: request.url,
      headers: request.headers,
      body: bytes.slice(0),
      status: refused.status,
      code: String(problem['code'] ?? ''),
    };
    return refused;
  }
  if (
    tamperMode !== undefined &&
    tamperTarget !== undefined &&
    tamperSign !== undefined &&
    request.method === 'POST' &&
    bytes !== undefined &&
    url.pathname.endsWith('/signing/requests')
  ) {
    const mode = tamperMode;
    tamperMode = undefined;
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    const entry = (json['grants'] as Json[])[0]!;
    const statement: Json = { ...(entry['statement'] as Json) };
    if (mode === 'grantee') {
      statement['grantee_identity_id'] = tamperTarget.identityId;
      statement['grantee_email'] = tamperTarget.email;
    } else {
      statement['versions'] = [1];
    }
    entry['statement'] = statement;
    entry['identity_signature'] = await signStatement(
      tamperSign,
      statementBytes('grant', parseStatement('grant', statement))
    );
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const refused = await apps[0]!.fetch(
      new Request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(json),
      })
    );
    const problem = (await refused
      .clone()
      .json()
      .catch(() => ({}))) as Json;
    tamperResult = {
      status: refused.status,
      code: String(problem['code'] ?? ''),
      statementCheck: problem['statement_check'],
    };
    return refused;
  }
  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(bytes === undefined ? {} : { body: bytes.slice(0) }),
  });
  const target = budgetProbe ? budgetApp : apps[nextApp++ % apps.length]!;
  const answered = await target.fetch(replay);
  if (
    claimTapProbe &&
    request.method === 'POST' &&
    url.pathname === '/api/identity' &&
    answered.status === 201
  ) {
    setupTapCount = await claimTapProbe();
  }
  if (
    claimTapProbe &&
    request.method === 'POST' &&
    /\/invites\/[^/]+\/claim$/.test(url.pathname)
  ) {
    claimTapCount = await claimTapProbe();
  }
  if (
    request.method === 'POST' &&
    /\/api\/relics\/[^/]+\/grants$/.test(url.pathname)
  ) {
    grantStatuses.push(answered.status);
  }
  if (
    request.method === 'POST' &&
    /\/invites\/[^/]+\/claim$/.test(url.pathname)
  ) {
    claimCalls.push({
      path: url.pathname,
      body: JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())),
      status: answered.status,
    });
  }
  if (
    substitutedLookup &&
    request.method === 'POST' &&
    url.pathname.endsWith('/grants/lookup')
  ) {
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
const SIXTH = 'sixth+direct-share@example.test';
const INVITEE_TWO = 'invitee-two+direct-share@example.test';
const INVITEE_THREE = 'invitee-three+direct-share@example.test';
const INVITEE_FOUR = 'invitee-four+direct-share@example.test';
const INVITEE_FIVE = 'invitee-five+direct-share@example.test';
const INVITEE_SIX = 'invitee-six+direct-share@example.test';
const DELETE_INVITEE = 'invitee-delete+direct-share@example.test';

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

/** One access-log line as the owner's service answers it. */
interface LogEvent {
  readonly kind: string;
  readonly actor?: { readonly email: string | null } | undefined;
  readonly subject_email?: string | null | undefined;
}

/** The invitation cards on the owner's page that still hold their link. */
interface InviteLinkView {
  readonly inviteId: string;
  readonly email: string;
  readonly url: string;
}

async function linksShown(actor: Actor): Promise<InviteLinkView[]> {
  return actor.browser.evaluate<InviteLinkView[]>(`(() =>
    Array.from(document.querySelectorAll('[data-invite-link]')).flatMap((card) => {
      const url = card.querySelector('[data-link-text]')?.textContent ?? '';
      return url === '' ? [] : [{
        inviteId: card.getAttribute('data-invite-link') ?? '',
        email: card.querySelector('strong')?.textContent ?? '',
        url,
      }];
    }))()`);
}

/** Opens the owner's Share section with no rows, so each batch starts clean. */
async function freshSharePanel(actor: Actor, relicUrl: string): Promise<void> {
  await goto(actor.browser, 'about:blank');
  await goto(actor.browser, `${relicUrl}?access=share`);
  await actor.browser.waitForSelector('[data-share-section]', 25000);
}

/** Sets the panel's version picks to `wanted`. The current version is locked on by the page. */
async function pickVersions(
  actor: Actor,
  wanted: readonly number[]
): Promise<void> {
  await actor.browser.evaluate<void>(`(() => {
    for (const box of document.querySelectorAll('[data-share-version]')) {
      const version = Number(box.getAttribute('data-share-version'));
      const want = ${JSON.stringify(wanted)}.includes(version);
      if (box.checked !== want && !box.disabled) box.click();
    }
  })()`);
}

/** One passkey tap, then waits until `links` invitation cards show their link. */
async function tapInvites(actor: Actor, links: number): Promise<void> {
  await click(actor.browser, '[data-action="share-passkey"]');
  await poll(`${links} invitation links`, 60000, async () =>
    (await linksShown(actor)).length === links ? true : undefined
  );
}

/** Puts the browser's passkey prompt on or off, so a sign-in code can be typed first. */
async function setPresence(actor: Actor, enabled: boolean): Promise<void> {
  await actor.browser.cdp.send(
    'WebAuthn.setAutomaticPresenceSimulation',
    { authenticatorId: actor.browser.authenticatorId, enabled },
    actor.browser.sessionId
  );
}

/** Email-code sign-in from an invitation link. Relik sends the code to the invited address. */
async function signInFromLink(actor: Actor, link: string): Promise<void> {
  await goto(actor.browser, link);
  await waitForState(
    actor.browser,
    ['invite-signin'],
    `${actor.name} invitation sign-in`
  );
  await codeSignInOnPage(actor);
}

/** The code steps of the invitation sign-in, on the page that already shows the form. */
async function codeSignInOnPage(actor: Actor): Promise<void> {
  await setPresence(actor, false);
  const since = env.mailbox.mark();
  await setField(actor.browser, '#signin-email', actor.email);
  await actor.browser.evaluate<void>(
    `document.querySelector('#signin-email-form').requestSubmit()`
  );
  const mail = await env.mailbox.await(
    actor.email,
    since,
    (m) => m.code !== undefined,
    `${actor.name} invitation code`
  );
  await poll(`${actor.name} code form`, 15000, async () =>
    (await actor.browser.evaluate<boolean>(
      `!document.querySelector('#signin-code-form')?.hidden`
    ))
      ? true
      : undefined
  );
  await setField(actor.browser, '#signin-code', mail.code ?? '');
  await actor.browser.evaluate<void>(
    `document.querySelector('#signin-code-form').requestSubmit()`
  );
  await setPresence(actor, true);
}

const UNREGISTERED = 'unregistered+direct-share@example.test';
const TAMPER = 'tamper+direct-share@example.test';
const SIGNER = 'signer+direct-share@example.test';
const PUBLIC_SIGNER = 'public-signer+direct-share@example.test';

/** One signing request as relic_read_signing reports it. */
interface SigningRequestView {
  readonly status?: string;
  readonly signers: ReadonlyArray<{
    readonly email: string;
    readonly status: string;
  }>;
}

/** The relik's signing requests, read through relic-mcp. */
async function requestsOf(relicId: string): Promise<SigningRequestView[]> {
  const result = await mcp('relic_read_signing', { relic_id: relicId });
  return (result['requests'] ?? []) as SigningRequestView[];
}

/** The signing composer's visible text, which carries its notices. */
async function panelText(browser: RunningProofBrowser): Promise<string> {
  return browser.evaluate<string>(
    `document.querySelector('.signing-panel')?.innerText ?? ''`
  );
}

/** Whether a button with this text is shown and enabled, inside `scope` when given. */
async function hasButton(
  browser: RunningProofBrowser,
  text: string,
  scope = ''
): Promise<boolean> {
  return browser.evaluate<boolean>(`(() => {
    const root = ${JSON.stringify(scope)} ? document.querySelector(${JSON.stringify(scope)}) : document;
    return Array.from(root?.querySelectorAll('button') ?? []).some(
      (b) => b.textContent === ${JSON.stringify(text)} && !b.disabled
    );
  })()`);
}

/** Clicks the enabled button with this text, inside `scope` when given. */
async function clickButton(
  browser: RunningProofBrowser,
  text: string,
  scope = ''
): Promise<void> {
  await browser.evaluate<void>(`(() => {
    const root = ${JSON.stringify(scope)} ? document.querySelector(${JSON.stringify(scope)}) : document;
    const button = Array.from(root?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === ${JSON.stringify(text)} && !b.disabled
    );
    if (!button) throw new Error('no enabled button ' + ${JSON.stringify(text)});
    button.click();
  })()`);
}

/** Opens the owner's signing composer on a private relik. */
async function openComposer(actor: Actor, relicUrl: string): Promise<void> {
  await goto(actor.browser, relicUrl);
  await waitForState(
    actor.browser,
    ['unlock'],
    `${actor.name} composer unlock`
  );
  await click(actor.browser, '[data-action="private-unlock"]');
  await waitForOpened(actor.browser, `${actor.name} composer`);
  await actor.browser.waitForSelector('[data-action="open-signing"]', 25000);
  await actor.browser.evaluate<void>(
    `document.querySelector('[data-action="open-signing"]').click()`
  );
  await actor.browser.waitForSelector('.signing-panel', 25000);
}

/** Types an address into signer row `index` (1-based) of the composer. */
async function setSigner(
  actor: Actor,
  index: number,
  email: string
): Promise<void> {
  await setField(actor.browser, `[aria-label="Signer ${index} email"]`, email);
}

/** Adds a signer row, then waits until its field shows. */
async function addSigner(actor: Actor, index: number): Promise<void> {
  await clickButton(actor.browser, 'Add signer', '.signing-panel');
  await poll(`signer row ${index}`, 25000, async () =>
    (await actor.browser.evaluate<boolean>(
      `!!document.querySelector('[aria-label="Signer ${index} email"]')`
    ))
      ? true
      : undefined
  );
}

/**
 * One signer's signature: opens the relik, signs with the page's own signing
 * panel, and waits until the service records that signer as signed.
 */
async function signAs(
  actor: Actor,
  relicUrl: string,
  email: string,
  relicId: string,
  name: string
): Promise<void> {
  await goto(actor.browser, `${relicUrl}?refresh=${actor.name}-sign`);
  await waitForState(actor.browser, ['unlock'], `${actor.name} signing unlock`);
  await click(actor.browser, '[data-action="private-unlock"]');
  await waitForOpened(actor.browser, `${actor.name} signing`);
  await poll(`${actor.name} sign control`, 25000, async () =>
    (await hasButton(actor.browser, 'Sign here')) ? true : undefined
  );
  await clickButton(actor.browser, 'Sign here');
  await actor.browser.waitForSelector('.signing-panel input', 25000);
  await actor.browser.evaluate<void>(`(() => {
    const panel = document.querySelector('.signing-panel');
    const field = panel.querySelector('input:not([type=checkbox])');
    field.value = ${JSON.stringify(name)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
    panel.querySelector('input[type=checkbox]').click();
  })()`);
  await poll(`${actor.name} signature prepared`, 25000, async () =>
    (await actor.browser.evaluate<boolean>(
      `!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`
    ))
      ? true
      : undefined
  );
  await actor.browser.evaluate<void>(
    `document.querySelector('.signing-panel .sign-row button.primary').click()`
  );
  await poll(`${actor.name} recorded as signed`, 60000, async () =>
    (await requestsOf(relicId))[0]?.signers.some(
      (signerRow) => signerRow.email === email && signerRow.status === 'signed'
    )
      ? true
      : undefined
  );
}

async function run(): Promise<void> {
  const owner = await launchActor(env, 'owner', env.owner, true);
  const reader = await launchActor(env, 'reader', env.reader, true);
  const third = await launchActor(env, 'third', env.third, true);
  const fourth = await launchActor(env, 'fourth', FOURTH, true);
  const fifth = await launchActor(env, 'fifth', FIFTH, true);
  const invitee = await launchActor(env, 'invitee', INVITEE, true);
  const sixth = await launchActor(env, 'sixth', SIXTH, true);
  const inviteeTwo = await launchActor(env, 'invitee-two', INVITEE_TWO, true);
  const inviteeThree = await launchActor(
    env,
    'invitee-three',
    INVITEE_THREE,
    true
  );
  const actors = [
    owner,
    reader,
    third,
    fourth,
    fifth,
    sixth,
    invitee,
    inviteeTwo,
    inviteeThree,
  ];
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
    await setUpIdentity(sixth, relicUrl);

    // Step 1. Lookup gate.
    const readerCookie = await cookieHeader(reader.browser);
    const publicPath = join(scratch, 'public-proof.txt');
    await writeFile(publicPath, 'A public relik for the lookup gate.\n');
    const publicPublished = await mcp('relic_publish', { path: publicPath });
    const publicId = stringAt(publicPublished, 'relic_id', 'public relik');
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
    assert.equal(
      fourthMails.length,
      1,
      'the fourth reader did not get exactly one notice'
    );
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
    await owner.browser.waitForSelector(
      '#rekey[data-rekey-state="done"]',
      90000
    );
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

    const currentVersion = Math.max(
      ...(await store.listWraps(relicId)).map((wrap) => wrap.version)
    );
    const lookupFifth = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        cookie: ownerCookie,
        body: { emails: [FIFTH] },
      }
    );
    assert.equal(lookupFifth.status, 200);
    const fifthEntry = (lookupFifth.json['results'] as Json[])[0];
    assert.ok(fifthEntry);
    const fifthParty = fifthEntry['party'] as Json;
    substitutedLookup = {
      results: [
        {
          ...fifthEntry,
          email: env.third,
          standing: 'none',
          party: { ...fifthParty, email: env.third },
        },
      ],
    };
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [env.third], 1);
    const substituteFingerprint = await identityFingerprint(
      fifthId.identityId,
      env.third
    );
    const substitutedRow = await poll(
      'substituted identity refused',
      25000,
      async () => {
        const row = (await rowsOf(owner))[0];
        return row?.state === 'unverified' ? row : undefined;
      }
    );
    assert.equal(substitutedRow.state, 'unverified');
    const fifthFingerprint = await identityFingerprint(
      fifthId.identityId,
      FIFTH
    );
    const refusedSelf = await postGrant(env, owner, ownerKeys, {
      relicId,
      granteeEmail: env.owner,
      granteeIdentityId: ownerKeys.identityId,
      fingerprint: await identityFingerprint(ownerKeys.identityId, env.owner),
      versions: [currentVersion],
    });
    assert.equal(refusedSelf.status, 400);
    assert.equal(refusedSelf.json['statement_check'], 'grantee');
    const refusedFingerprint = await postGrant(env, owner, ownerKeys, {
      relicId,
      granteeEmail: FIFTH,
      granteeIdentityId: fifthId.identityId,
      fingerprint: `${fifthFingerprint.slice(0, -1)}${fifthFingerprint.endsWith('0') ? '1' : '0'}`,
      versions: [currentVersion],
    });
    assert.equal(refusedFingerprint.status, 409);
    assert.equal(problemCode(refusedFingerprint), 'fingerprint_mismatch');
    const substituted = await postGrant(env, owner, ownerKeys, {
      relicId,
      granteeEmail: env.third,
      granteeIdentityId: fifthId.identityId,
      fingerprint: substituteFingerprint,
      versions: [currentVersion],
    });
    assert.equal(substituted.status, 400);
    assert.equal(substituted.json['statement_check'], 'grantee');
    const fifthKem = hexOf(await kemKeyIdOf(fifthId.kemPublicKey));
    assert.equal(
      (await store.listWraps(relicId)).filter(
        (wrap) => wrap.recipientKeyId === fifthKem
      ).length,
      0
    );
    const originalFifth = await store.getIdentity(fifthId.identityId);
    assert.ok(originalFifth);
    await store.updateIdentity(fifthId.identityId, (row) => ({
      ...row,
      retiredAt: Date.now(),
    }));
    try {
      const retired = await postGrant(env, owner, ownerKeys, {
        relicId,
        granteeEmail: FIFTH,
        granteeIdentityId: fifthId.identityId,
        fingerprint: fifthFingerprint,
        versions: [currentVersion],
      });
      assert.equal(retired.status, 400);
      assert.equal(retired.json['statement_check'], 'grantee');
    } finally {
      await store.updateIdentity(fifthId.identityId, () => originalFifth);
    }
    console.log(
      'DIRECT_STEP_9_REFUSALS self=400_grantee wrong_fingerprint=409 substituted_lookup=ui_rejects_unverified substituted_api=400_grantee substitute_wraps=0 retired_identity=400_grantee'
    );
    lastReceipt = 9;

    // A pending request still follows the original grant mail and log path.
    await click(fifth.browser, '[data-action="private-request"]');
    await waitForState(fifth.browser, ['requested'], 'fifth requested');
    const requestedLookup = await api(
      env,
      'POST',
      `/api/relics/${relicId}/grants/lookup`,
      {
        cookie: ownerCookie,
        body: { emails: [FIFTH] },
      }
    );
    assert.equal(requestedLookup.status, 200);
    assert.equal(
      (requestedLookup.json['results'] as Json[])[0]?.['standing'],
      'requested'
    );
    const requestMailMark = mailbox.mark();
    const requestEventsBefore = (await accessEventsOf(ownerCookie, relicId))
      .length;
    await goto(owner.browser, `${relicUrl}?access=share`);
    await owner.browser.waitForSelector('[data-share-section]', 25000);
    await addToPanel(owner, [FIFTH], 1);
    await tapShare(owner);
    await mailbox.await(
      FIFTH,
      requestMailMark,
      (mail) => mail.subject === 'You have access to a relik',
      'request grant mail'
    );
    const requestGrantEvents = (await accessEventsOf(ownerCookie, relicId))
      .slice(requestEventsBefore)
      .filter((event) => event.kind !== 'wrap_fetch');
    assert.deepEqual(
      requestGrantEvents.map((event) => event.kind),
      ['grant']
    );
    console.log(
      'DIRECT_STEP_10_REQUEST_PATH lookup_standing=requested grant_log=grant grant_mail=unchanged'
    );
    lastReceipt = 10;
    // Stage B. Invitations (plan section 10, INVITE_STEP_1 to 13).
    const DAY_MS = 86_400_000;
    const logOf = async (cookie: string, id: string): Promise<LogEvent[]> => {
      const answer = await api(
        env,
        'GET',
        `/api/identity/access-log?relic_id=${id}`,
        { cookie }
      );
      return (answer.json['events'] ?? []) as LogEvent[];
    };
    const versionOf = async (): Promise<number> =>
      Math.max(...(await store.listWraps(relicId)).map((wrap) => wrap.version));

    // INVITE_STEP_1. One tap grants a registered address and invites two.
    const current = await versionOf();
    await freshSharePanel(owner, relicUrl);
    await pickVersions(owner, [current]);
    await addToPanel(owner, [SIXTH, INVITEE, INVITEE_TWO], 3);
    const signBeforeB1 = await signCountTotal(owner.browser);
    const mailB1 = mailbox.mark();
    await tapInvites(owner, 2);
    const signB1 = (await signCountTotal(owner.browser)) - signBeforeB1;
    const shownB1 = await linksShown(owner);
    const linkOne = shownB1.find((link) => link.email === INVITEE);
    const linkTwo = shownB1.find((link) => link.email === INVITEE_TWO);
    assert.ok(
      linkOne && linkTwo,
      'the owner page does not show both invitation links'
    );
    const sixthGrant = (await grantsOf(ownerCookie, relicId)).some(
      (grant) => grant.grantee.email === SIXTH && grant.revoked_at === null
    );
    assert.equal(sixthGrant, true, 'the batch grant did not store');
    const openRows = (await store.listInvites(relicId)).filter(
      (row) => row.status === 'open'
    );
    let opensUnderKey = true;
    for (const row of openRows) {
      const link = row.invitedEmail === INVITEE ? linkOne : linkTwo;
      const d = parseInviteFragment(new URL(link.url).hash.slice(1));
      assert.ok(d, 'the invitation link carries no key');
      const recipient = await inviteRecipient(
        d,
        decodeBase64url(row.invitePublicKey)
      );
      for (const wrap of row.wraps) {
        const opened = await unwrapVersionKey({
          recipient,
          relicId,
          version: wrap.version,
          enc: wrap.enc,
          ct: wrap.ct,
        }).catch(() => undefined);
        if (opened === undefined) opensUnderKey = false;
      }
    }
    const keyOne = fragmentKeyOf(linkOne.url);
    const keyTwo = fragmentKeyOf(linkTwo.url);
    const keyInRequest = requestBodies.some(
      (body) => body.includes(keyOne) || body.includes(keyTwo)
    );
    const inviteSubject = `${env.owner} invited you to a relik`;
    await mailbox.await(
      INVITEE,
      mailB1,
      (m) => m.subject === inviteSubject,
      'invitation notice'
    );
    await mailbox.await(
      INVITEE_TWO,
      mailB1,
      (m) => m.subject === inviteSubject,
      'second invitation notice'
    );
    const notices = mailbox
      .all()
      .slice(mailB1)
      .filter((m) => m.subject === inviteSubject);
    const noticeNamesOwner = notices.every((m) => m.text.includes(env.owner));
    const noticeLink = notices.some((m) =>
      /https?:|#k=|\?invite=/.test(m.text)
    );
    const noticeKey = notices.some(
      (m) => m.text.includes(keyOne) || m.text.includes(keyTwo)
    );
    emit(
      101,
      `INVITE_STEP_1_CREATE batch=grant:1,invite:2 owner_sign_count_delta=${signB1} invite_rows=${openRows.length} wraps_open_under_invite_key=${opensUnderKey} d_in_any_request=${keyInRequest} notice_mails=${notices.length} notice_names_owner=${noticeNamesOwner} notice_link=${noticeLink ? 'present' : 'absent'} notice_key=${noticeKey ? 'present' : 'absent'} links_shown=${shownB1.length}`
    );
    assert.equal(signB1, 1, 'the batch used more than one passkey assertion');
    assert.equal(
      openRows.length,
      2,
      'the batch did not store two open invitations'
    );
    assert.equal(
      opensUnderKey,
      true,
      'a wrap does not open under its invite key'
    );
    assert.equal(keyInRequest, false, 'an invite key reached a request body');
    assert.equal(notices.length, 2, 'each invitee did not get one notice');
    assert.equal(noticeNamesOwner, true, 'a notice does not name the owner');
    assert.equal(noticeLink, false, 'a notice carries a link');
    assert.equal(noticeKey, false, 'a notice carries a key');
    const recipientsBeforeClaim = await api(
      env,
      'POST',
      `/api/relics/${relicId}/recipients`,
      {
        cookie: ownerCookie,
        body: {},
      }
    );
    assert.equal(recipientsBeforeClaim.status, 200);

    // INVITE_STEP_2. Each invitation opens only for its own address.
    const inviteeCookie = await nodeSignIn(env, INVITEE);
    const readerNow = await cookieHeader(reader.browser);
    const inviteOne = linkOne.inviteId;
    const openPath = `/api/relics/${relicId}/invites/${inviteOne}/open`;
    const signedOutOpen = await api(env, 'POST', openPath, { body: {} });
    const otherOpen = await api(env, 'POST', openPath, {
      cookie: readerNow,
      body: {},
    });
    const bogusOpen = await api(
      env,
      'POST',
      `/api/relics/${relicId}/invites/${'0'.repeat(32)}/open`,
      { cookie: inviteeCookie, body: {} }
    );
    const keyOther = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${current}/key`,
      { cookie: readerNow, body: { invite_id: inviteOne } }
    );
    const mintOther = await api(env, 'POST', `/api/relics/${relicId}/mint`, {
      cookie: readerNow,
      body: { invite_id: inviteOne, version: current },
    });
    // `instance` is the problem's per-response occurrence id, not part of the answer.
    const withoutInstance = (body: Json): Json => {
      const { instance: _instance, ...rest } = body;
      return rest;
    };
    const sameBody =
      otherOpen.status === bogusOpen.status &&
      JSON.stringify(withoutInstance(otherOpen.json)) ===
        JSON.stringify(withoutInstance(bogusOpen.json));
    emit(
      102,
      `INVITE_STEP_2_ADDRESS_BOUND signed_out=${signedOutOpen.status} other_address=${otherOpen.status} bogus_id=${bogusOpen.status} same_body=${sameBody} key_other=${keyOther.status} mint_other=${mintOther.status}`
    );
    assert.equal(signedOutOpen.status, 401, 'a signed-out open is not 401');
    assert.equal(
      otherOpen.status,
      404,
      'another address can open the invitation'
    );
    assert.equal(bogusOpen.status, 404, 'a bogus invitation id is not 404');
    assert.equal(
      sameBody,
      true,
      'the other-address and bogus-id answers differ'
    );
    assert.equal(
      keyOther.status,
      403,
      'another address fetched the invitation key'
    );
    assert.equal(
      mintOther.status,
      403,
      'another address minted from the invitation'
    );

    // INVITE_STEP_3. The invitee signs in with a code from the link and reads the file.
    const receiptsBeforeOpen = (await store.listReceipts(relicId)).length;
    await signInFromLink(invitee, linkOne.url);
    // The ready view replaces the private host, so invite-ready shows as the banner on the file.
    await poll('invitee banner', 25000, async () =>
      (await invitee.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    await waitForOpened(invitee.browser, 'invitee');
    const hashAfterOpen =
      await invitee.browser.evaluate<string>('location.hash');
    const commentsPresent = await invitee.browser.evaluate<boolean>(
      `!!document.querySelector('.compose-textarea')`
    );
    const signingPresent = await invitee.browser.evaluate<boolean>(
      `!!document.querySelector('[data-action="sign"], [data-signing-request]')`
    );
    const unlistedKey = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${current - 1}/key`,
      {
        cookie: await cookieHeader(invitee.browser),
        body: { invite_id: inviteOne },
      }
    );
    const logAfterOpen = await logOf(ownerCookie, relicId);
    const wrapFetchByInvitee = logAfterOpen.some(
      (event) => event.kind === 'wrap_fetch' && event.actor?.email === INVITEE
    );
    const receiptsOpenDelta =
      (await store.listReceipts(relicId)).length - receiptsBeforeOpen;
    // The invitation key lives only in the link's fragment: no body the service received may carry it.
    const keyInBody = requestBodies.some(
      (body) => body.includes(keyOne) || body.includes(keyTwo)
    );
    emit(
      103,
      `INVITE_STEP_3_OPEN_WITH_CODE sign_in=code state=invite-ready listed=opened unlisted_key=${unlistedKey.status} comments=${commentsPresent ? 'present' : 'absent'} signing=${signingPresent ? 'present' : 'absent'} fragment_after_open=${hashAfterOpen === '' ? 'absent' : 'present'} log=${wrapFetchByInvitee ? 'wrap_fetch:address' : 'absent'} receipts=${receiptsOpenDelta} key_in_body=${keyInBody ? 'present' : 'absent'}`
    );
    assert.equal(keyInBody, false, 'an invitation key reached a request body');
    assert.equal(unlistedKey.status, 403, 'an unlisted version key was served');
    assert.equal(
      commentsPresent,
      false,
      'the invitee sees the comment composer'
    );
    assert.equal(signingPresent, false, 'the invitee sees signing controls');
    assert.equal(hashAfterOpen, '', 'the fragment is still in the location');
    assert.equal(
      wrapFetchByInvitee,
      true,
      'the owner log lacks the invitee key fetch'
    );
    assert.equal(receiptsOpenDelta, 0, 'opening wrote a receipt');

    // INVITE_STEP_4. Keep access sets up a passkey and claims; the claim outlives the invitation.
    const logBeforeKeep = (await logOf(ownerCookie, relicId)).length;
    const mailKeep = mailbox.mark();
    claimTapProbe = () => signCountTotal(invitee.browser);
    await click(invitee.browser, '[data-action="invite-keep"]');
    await poll('claim recorded', 25000, async () =>
      (await store.getInvite(relicId, inviteOne))?.status === 'claimed'
        ? true
        : undefined
    ).catch(async (error: unknown) => {
      const page = await invitee.browser.evaluate<string>(
        `JSON.stringify({state: document.querySelector('#relic-private')?.getAttribute('data-private-state'), text: document.body.innerText.slice(0, 700)})`
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; page=${page}`
      );
    });
    claimTapProbe = undefined;
    assert.notEqual(
      setupTapCount,
      undefined,
      'identity registration was not observed'
    );
    assert.notEqual(claimTapCount, undefined, 'claim request was not observed');
    const signKeepDelta = claimTapCount! - setupTapCount!;
    const credentials = (await invitee.browser.cdp.send(
      'WebAuthn.getCredentials',
      { authenticatorId: invitee.browser.authenticatorId },
      invitee.browser.sessionId
    )) as { credentials: unknown[] };
    const inviteeIdentity = await identityOf(env, invitee);
    const inviteeKem = hexOf(await kemKeyIdOf(inviteeIdentity.kemPublicKey));
    const claimWraps = (await store.listWraps(relicId)).filter(
      (wrap) => wrap.recipientKeyId === inviteeKem && wrap.source === 'claim'
    );
    const inviteAfterClaim = await store.getInvite(relicId, inviteOne);
    const roleAnswer = await api(env, 'GET', `/api/relics/${relicId}/access`, {
      cookie: await cookieHeader(invitee.browser),
    });
    clockOffsetMs = 8 * DAY_MS;
    let readsAfterExpiry = 'failed';
    try {
      const afterExpiry = await api(
        env,
        'POST',
        `/api/relics/${relicId}/versions/${current}/key`,
        {
          cookie: await cookieHeader(invitee.browser),
          body: {},
        }
      );
      assert.equal(
        afterExpiry.status,
        200,
        'claim key unavailable after invitation expiry'
      );
      readsAfterExpiry = 'ok';
    } finally {
      clockOffsetMs = 0;
    }
    await goto(invitee.browser, relicUrl);
    await waitForState(
      invitee.browser,
      ['unlock'],
      'invitee unlock after expiry'
    );
    await click(invitee.browser, '[data-action="private-unlock"]');
    await waitForOpened(invitee.browser, 'invitee after expiry');
    const ownerClaimMail = mailbox
      .all()
      .slice(mailKeep)
      .filter(
        (m) =>
          m.to.toLowerCase() === env.owner &&
          m.subject === `${INVITEE} accepted your invitation`
      ).length;
    const claimLog = (await logOf(ownerCookie, relicId))
      .slice(logBeforeKeep)
      .filter((event) => event.kind !== 'wrap_fetch')
      .map((event) => event.kind)
      .join(',');
    emit(
      104,
      `INVITE_STEP_4_CLAIM passkey_created=${credentials.credentials.length} identity=registered extra_claim_taps=${signKeepDelta} claim_wraps=${claimWraps.length === 1 ? 'listed' : 'mismatch'} invite_wraps=${inviteAfterClaim?.wraps.length ?? 'missing'} role=${String((roleAnswer.json['me'] as Json)?.['role'])} reads_after_invite_expiry=${readsAfterExpiry} log=${claimLog} owner_mail=${ownerClaimMail}`
    );
    assert.equal(
      credentials.credentials.length,
      1,
      'the claim did not leave one passkey'
    );
    assert.equal(signKeepDelta, 0, 'the claim took a passkey assertion');
    assert.equal(
      claimWraps.length,
      1,
      'the claim did not write one wrap per listed version'
    );
    assert.equal(
      inviteAfterClaim?.wraps.length,
      0,
      'the invitation kept its wraps'
    );
    assert.equal(
      (roleAnswer.json['me'] as Json)?.['role'],
      'invited',
      'the claimant is not invited'
    );
    assert.equal(
      readsAfterExpiry,
      'ok',
      'the claimant cannot read after the invitation expired'
    );
    assert.equal(claimLog, 'claim', 'the owner log lacks the claim');
    assert.equal(ownerClaimMail, 1, 'the owner did not get one claim email');
    lastReceipt = 104;

    const claimCall = claimCalls.find((call) =>
      call.path.endsWith(`/${inviteOne}/claim`)
    );
    assert.ok(claimCall, 'the claim request was not captured');
    const winningWraps = await store.listWraps(relicId);
    const repeatedClaim = await api(env, 'POST', claimCall.path, {
      cookie: await cookieHeader(invitee.browser),
      body: claimCall.body,
    });
    assert.ok(
      repeatedClaim.status === 201 ||
        (repeatedClaim.status === 409 &&
          problemCode(repeatedClaim) === 'invite_claimed'),
      `unexpected claim replay ${repeatedClaim.status} ${problemCode(repeatedClaim)}`
    );
    assert.deepEqual(await store.listWraps(relicId), winningWraps);
    await goto(invitee.browser, relicUrl);
    await waitForState(invitee.browser, ['unlock'], 'claimant reopens');
    await click(invitee.browser, '[data-action="private-unlock"]');
    await waitForOpened(invitee.browser, 'claimant reopens');
    emit(
      105,
      `INVITE_STEP_5_SINGLE_USE second_tab=${repeatedClaim.status}${repeatedClaim.status === 409 ? '_invite_claimed' : '_same_claimant_repeat'} winner_wraps_intact=true reopen_same_identity=reader`
    );
    lastReceipt = 105;

    const recipientsAfterClaim = await api(
      env,
      'POST',
      `/api/relics/${relicId}/recipients`,
      {
        cookie: ownerCookie,
        body: {},
      }
    );
    assert.equal(recipientsAfterClaim.status, 200);
    assert.deepEqual(
      recipientsAfterClaim.json,
      recipientsBeforeClaim.json,
      'claim changed the publisher roster'
    );
    await writeFile(docPath, 'Direct share invitation proof, later version.\n');
    await mcp('relic_republish', { relic_id: relicId, path: docPath });
    const laterVersion = await versionOf();
    assert.equal(
      (await store.listWraps(relicId)).some(
        (wrap) =>
          wrap.version === laterVersion && wrap.recipientKeyId === inviteeKem
      ),
      false,
      'republish included an unconfirmed claimant'
    );
    emit(
      106,
      'INVITE_STEP_6_INVISIBLE recipients_equal_without_invites=true mcp_republish=sealed new_version_wrapped_to_claimant=false'
    );
    lastReceipt = 106;

    // Confirm the claimed invitation in the owner panel with one assertion.
    await goto(owner.browser, `${relicUrl}?access=invites`);
    await owner.browser.waitForSelector(
      `[data-invite="${inviteOne}"][data-invite-state="claimed"]`,
      25000
    );
    const beforeConfirm = await signCountTotal(owner.browser);
    await click(owner.browser, '[data-action="invite-confirm"]');
    await poll('confirmed claimant grant', 25000, async () =>
      (await grantsOf(ownerCookie, relicId)).some(
        (grant) =>
          grant.grantee.identity.identity_id === inviteeIdentity.identityId &&
          grant.revoked_at === null
      )
        ? true
        : undefined
    );
    const confirmTaps = (await signCountTotal(owner.browser)) - beforeConfirm;
    assert.equal(confirmTaps, 1);
    assert.equal(
      await store.getInviteClaim(relicId, inviteeIdentity.identityId),
      undefined
    );
    await writeFile(
      docPath,
      'Direct share invitation proof, confirmed version.\n'
    );
    await mcp('relic_republish', { relic_id: relicId, path: docPath });
    const confirmedVersion = await versionOf();
    assert.ok(
      (await store.listWraps(relicId)).some(
        (wrap) =>
          wrap.version === confirmedVersion &&
          wrap.recipientKeyId === inviteeKem
      ),
      'confirmed claimant was not included in the new seal'
    );
    await goto(invitee.browser, relicUrl);
    await waitForState(invitee.browser, ['unlock'], 'confirmed claimant');
    await click(invitee.browser, '[data-action="private-unlock"]');
    await waitForOpened(invitee.browser, 'confirmed claimant');
    emit(
      107,
      `INVITE_STEP_7_CONFIRM owner_sign_count_delta=${confirmTaps} grant=live claim_row=superseded mcp_republish_after=wraps_claimant claimant_opens_new_version=ok`
    );
    lastReceipt = 107;

    const inviteTwoCookie = await nodeSignIn(env, INVITEE_TWO);
    clockOffsetMs = 8 * DAY_MS;
    try {
      const expiredOpen = await api(
        env,
        'POST',
        `/api/relics/${relicId}/invites/${linkTwo.inviteId}/open`,
        {
          cookie: inviteTwoCookie,
          body: {},
        }
      );
      const expiredKey = await api(
        env,
        'POST',
        `/api/relics/${relicId}/versions/${current}/key`,
        {
          cookie: inviteTwoCookie,
          body: { invite_id: linkTwo.inviteId },
        }
      );
      const expiredMint = await api(
        env,
        'POST',
        `/api/relics/${relicId}/mint`,
        {
          cookie: inviteTwoCookie,
          body: { invite_id: linkTwo.inviteId, version: current },
        }
      );
      const expiredClaim = await api(
        env,
        'POST',
        `/api/relics/${relicId}/invites/${linkTwo.inviteId}/claim`,
        {
          cookie: inviteTwoCookie,
          body: claimCall.body,
        }
      );
      assert.equal(expiredOpen.status, 200);
      assert.equal(expiredOpen.json['status'], 'expired');
      assert.equal(expiredKey.status, 403);
      assert.equal(expiredMint.status, 403);
      assert.equal(expiredClaim.status, 410);
      assert.equal(problemCode(expiredClaim), 'invite_expired');
      emit(
        108,
        'INVITE_STEP_8_EXPIRY open_status=expired key=403 mint=403 claim=410_invite_expired'
      );
      lastReceipt = 108;
    } finally {
      clockOffsetMs = 0;
    }

    // Use a separate pair so cancel and removal each exercise the correct state.
    await freshSharePanel(owner, relicUrl);
    await addToPanel(owner, [INVITEE_THREE, INVITEE_FOUR], 2);
    await tapInvites(owner, 2);
    const linksForRemoval = await linksShown(owner);
    const toRemove = linksForRemoval.find(
      (link) => link.email === INVITEE_THREE
    );
    const toCancel = linksForRemoval.find(
      (link) => link.email === INVITEE_FOUR
    );
    assert.ok(toRemove && toCancel);
    await signInFromLink(inviteeThree, toRemove.url);
    await poll('third invitee ready', 25000, async () =>
      (await inviteeThree.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    await inPage(inviteeThree.browser, pageCreatePasskey, { prf: true });
    await click(inviteeThree.browser, '[data-action="invite-keep"]');
    await poll('third invitation claimed', 25000, async () =>
      (await store.getInvite(relicId, toRemove.inviteId))?.status === 'claimed'
        ? true
        : undefined
    );
    const removedIdentity = await identityOf(env, inviteeThree);
    const removedKem = hexOf(await kemKeyIdOf(removedIdentity.kemPublicKey));
    assert.ok(
      (await store.listWraps(relicId)).some(
        (wrap) => wrap.recipientKeyId === removedKem && wrap.source === 'claim'
      )
    );
    const cancelled = await api(
      env,
      'POST',
      `/api/relics/${relicId}/invites/${toCancel.inviteId}/revoke`,
      {
        cookie: ownerCookie,
        body: {},
      }
    );
    assert.equal(cancelled.status, 200);
    assert.equal(
      (await store.getInvite(relicId, toCancel.inviteId))?.wraps.length,
      0
    );
    const fourthInvitee = await launchActor(
      env,
      'invitee-four',
      INVITEE_FOUR,
      true
    );
    actors.push(fourthInvitee);
    await signInFromLink(fourthInvitee, toCancel.url);
    await waitForState(
      fourthInvitee.browser,
      ['invite-withdrawn'],
      'cancelled invitation'
    );
    const removed = await api(
      env,
      'POST',
      `/api/relics/${relicId}/invites/${toRemove.inviteId}/revoke`,
      {
        cookie: ownerCookie,
        body: {},
      }
    );
    assert.equal(removed.status, 200);
    assert.equal(
      (await store.listWraps(relicId)).filter(
        (wrap) => wrap.recipientKeyId === removedKem
      ).length,
      0
    );
    const removedAccess = await api(
      env,
      'GET',
      `/api/relics/${relicId}/access`,
      {
        cookie: await cookieHeader(inviteeThree.browser),
      }
    );
    assert.equal((removedAccess.json['me'] as Json)?.['role'], 'revoked');
    emit(
      109,
      'INVITE_STEP_9_REVOKE cancel_open=wraps_0 link_state=invite-withdrawn remove_claimed=claim_wraps_0 role=revoked'
    );
    lastReceipt = 109;

    await freshSharePanel(owner, relicUrl);
    await addToPanel(owner, [INVITEE_FIVE], 1);
    await tapInvites(owner, 1);
    const remainingInvite = (await linksShown(owner))[0];
    assert.ok(remainingInvite);
    const remainingCookie = await nodeSignIn(env, INVITEE_FIVE);
    await openPanel(owner, relicUrl);
    await clickPrivateControl(
      owner.browser,
      `button[data-action="revoke"][aria-label="Revoke ${SIXTH}"]`
    );
    await owner.browser.waitForSelector('#revoke-dialog[open]', 25000);
    await click(owner.browser, '[data-action="confirm-revoke"]');
    await owner.browser.waitForSelector(
      '#rekey[data-rekey-state="done"]',
      90000
    );
    const rekeyVersion = await versionOf();
    assert.ok(rekeyVersion > confirmedVersion);
    const remainingRow = await store.getInvite(
      relicId,
      remainingInvite.inviteId
    );
    assert.equal(remainingRow?.status, 'open');
    const oldInviteKey = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${confirmedVersion}/key`,
      {
        cookie: remainingCookie,
        body: { invite_id: remainingInvite.inviteId },
      }
    );
    const newInviteKey = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${rekeyVersion}/key`,
      {
        cookie: remainingCookie,
        body: { invite_id: remainingInvite.inviteId },
      }
    );
    assert.equal(oldInviteKey.status, 200);
    assert.equal(newInviteKey.status, 403);
    emit(
      110,
      'INVITE_STEP_10_REKEY revoke_other=new_version open_invite_listed=ok open_invite_new_version=403'
    );
    lastReceipt = 110;

    // An invitation to an already registered address is refused only after
    // consuming the same lookup budget. An isolated app exposes that charge.
    const registeredInviteKey = await generateInviteKeyPair();
    const nonce = await api(env, 'POST', '/api/attest/nonce', {
      cookie: ownerCookie,
      body: { purpose: 'grant', relic_id: relicId },
    });
    assert.equal(nonce.status, 200);
    const { attestation } = await attestationFor(
      owner,
      ownerKeys,
      stringAt(nonce.json, 'nonce', 'nonce'),
      nonce.json['public_key'] as Json,
      [
        {
          kind: 'invite',
          statement: {
            at: Date.now(),
            expires_at: Date.now() + 7 * DAY_MS,
            invite_public_key: encodeBase64url(registeredInviteKey.publicKey),
            invited_email: env.third,
            owner_identity_id: ownerKeys.identityId,
            relic_id: relicId,
            versions: [rekeyVersion],
          },
        },
      ]
    );
    budgetApp = createApp({
      ...appOptions,
      config: {
        ...appOptions.config,
        identityLookupRateLimit: { limit: 1, windowSeconds: 3600 },
      },
    });
    budgetProbe = true;
    try {
      const registeredInvite = await api(
        env,
        'POST',
        `/api/relics/${relicId}/grants`,
        {
          cookie: ownerCookie,
          body: { attestation, wraps: [] },
        }
      );
      assert.equal(registeredInvite.status, 409);
      assert.equal(problemCode(registeredInvite), 'identity_exists');
      const chargedLookup = await api(
        env,
        'POST',
        `/api/relics/${relicId}/grants/lookup`,
        {
          cookie: ownerCookie,
          body: { emails: [env.third] },
        }
      );
      assert.equal(
        chargedLookup.status,
        429,
        'refused invitation did not consume lookup budget'
      );
    } finally {
      budgetProbe = false;
    }

    // The address registers after its invitation was created. Its existing
    // identity signs in through the link (a fresh code) and claims.
    const fifthInvitee = await launchActor(
      env,
      'invitee-five',
      INVITEE_FIVE,
      true
    );
    actors.push(fifthInvitee);
    const existingIdentity = await setUpIdentity(fifthInvitee, relicUrl);
    await goto(fifthInvitee.browser, 'about:blank');
    await goto(fifthInvitee.browser, remainingInvite.url);
    await poll('existing identity invitation ready', 25000, async () =>
      (await fifthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    // Keep access asks for a fresh code, because this page has no sign-in of its own (plan 4.2, 5.2).
    await click(fifthInvitee.browser, '[data-action="invite-keep"]');
    await poll('keep access asks for a fresh code', 25000, async () =>
      (await fifthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('#signin-email-form')`
      ))
        ? true
        : undefined
    );
    await codeSignInOnPage(fifthInvitee);
    await poll('existing identity invitation ready again', 25000, async () =>
      (await fifthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    await click(fifthInvitee.browser, '[data-action="invite-keep"]');
    await poll('existing identity claims', 25000, async () =>
      (await store.getInvite(relicId, remainingInvite.inviteId))?.status ===
      'claimed'
        ? true
        : undefined
    ).catch(async (error: unknown) => {
      const page = await fifthInvitee.browser.evaluate<string>(
        `JSON.stringify({state: document.querySelector('#relic-private')?.getAttribute('data-private-state'), text: document.body.innerText.slice(0, 500)})`
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; page=${page}`
      );
    });
    assert.equal(
      (await identityOf(env, fifthInvitee)).identityId,
      existingIdentity.identityId
    );

    // An invitation is created while its address has no identity. The address
    // then registers and receives a direct grant, so claiming it consumes the
    // invitation with no new wraps.
    await freshSharePanel(owner, relicUrl);
    await addToPanel(owner, [INVITEE_SIX], 1);
    await tapInvites(owner, 1);
    const alreadyReaderInvite = (await linksShown(owner))[0];
    assert.ok(alreadyReaderInvite);
    const sixthInvitee = await launchActor(
      env,
      'invitee-six',
      INVITEE_SIX,
      true
    );
    actors.push(sixthInvitee);
    const alreadyReader = await setUpIdentity(sixthInvitee, relicUrl);
    await freshSharePanel(owner, relicUrl);
    await addToPanel(owner, [INVITEE_SIX], 1);
    await tapShare(owner);
    const beforeAlreadyReader = await store.listWraps(relicId);
    await goto(sixthInvitee.browser, 'about:blank');
    await goto(sixthInvitee.browser, alreadyReaderInvite.url);
    await poll('already reader invitation ready', 25000, async () =>
      (await sixthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    await click(sixthInvitee.browser, '[data-action="invite-keep"]');
    await poll('sixth keep asks for a fresh code', 25000, async () =>
      (await sixthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('#signin-email-form')`
      ))
        ? true
        : undefined
    );
    await codeSignInOnPage(sixthInvitee);
    await poll('already reader invitation ready again', 25000, async () =>
      (await sixthInvitee.browser.evaluate<boolean>(
        `!!document.querySelector('[data-invite-banner]')`
      ))
        ? true
        : undefined
    );
    await click(sixthInvitee.browser, '[data-action="invite-keep"]');
    await poll('already reader invitation consumed', 25000, async () =>
      (await store.getInvite(relicId, alreadyReaderInvite.inviteId))?.status ===
      'claimed'
        ? true
        : undefined
    );
    const alreadyReaderCall = claimCalls.find((call) =>
      call.path.endsWith(`/${alreadyReaderInvite.inviteId}/claim`)
    );
    assert.equal(alreadyReaderCall?.status, 200);
    assert.deepEqual(await store.listWraps(relicId), beforeAlreadyReader);
    assert.equal(
      await store.getInviteClaim(relicId, alreadyReader.identityId),
      undefined
    );
    emit(
      111,
      'INVITE_STEP_11_REGISTERED invite_for_registered=409_identity_exists lookup_charged=true existing_identity=unlock_then_claim already_reader=consumed_no_writes'
    );
    lastReceipt = 111;

    // Exercise deletion while an invitation still covers more than one version.
    await freshSharePanel(owner, relicUrl);
    await pickVersions(owner, [confirmedVersion, rekeyVersion]);
    await addToPanel(owner, [DELETE_INVITEE], 1);
    await tapInvites(owner, 1);
    const deletionInvite = (await linksShown(owner))[0];
    assert.ok(deletionInvite);
    const deletionActor = await launchActor(
      env,
      'invitee-delete',
      DELETE_INVITEE,
      true
    );
    actors.push(deletionActor);
    await signInFromLink(deletionActor, deletionInvite.url);
    await waitForOpened(
      deletionActor.browser,
      'invitee before version deletion'
    );
    const deleteNonce = await api(env, 'POST', '/api/attest/nonce', {
      cookie: ownerCookie,
      body: { purpose: 'delete', relic_id: relicId },
    });
    assert.equal(deleteNonce.status, 200);
    const deletionDrafts = [
      {
        kind: 'delete',
        statement: {
          at: Date.now(),
          owner_identity_id: ownerKeys.identityId,
          relic_id: relicId,
          versions: [confirmedVersion],
        },
      },
    ];
    const deleteAttestation = await attestationFor(
      owner,
      ownerKeys,
      stringAt(deleteNonce.json, 'nonce', 'nonce'),
      deleteNonce.json['public_key'] as Json,
      deletionDrafts as unknown as Parameters<typeof attestationFor>[4]
    );
    const deletion = await api(env, 'POST', `/api/relics/${relicId}/delete`, {
      cookie: ownerCookie,
      body: { attestation: deleteAttestation.attestation },
    });
    assert.equal(deletion.status, 200);
    const remaining = await store.getInvite(relicId, deletionInvite.inviteId);
    assert.deepEqual(remaining?.versions, [rekeyVersion]);
    assert.deepEqual(
      remaining?.wraps.map((wrap) => wrap.version),
      [rekeyVersion]
    );
    await goto(deletionActor.browser, 'about:blank');
    await goto(deletionActor.browser, deletionInvite.url);
    await waitForOpened(
      deletionActor.browser,
      'invitee after version deletion'
    );
    const deletionCookie = await cookieHeader(deletionActor.browser);
    const survivingKey = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${rekeyVersion}/key`,
      { cookie: deletionCookie, body: { invite_id: deletionInvite.inviteId } }
    );
    const deletedKey = await api(
      env,
      'POST',
      `/api/relics/${relicId}/versions/${confirmedVersion}/key`,
      { cookie: deletionCookie, body: { invite_id: deletionInvite.inviteId } }
    );
    assert.equal(
      survivingKey.status,
      200,
      'the surviving version key was refused'
    );
    assert.equal(deletedKey.status, 403, 'a deleted version key was served');
    const versionsEmptied = (
      await store.getInvite(relicId, deletionInvite.inviteId)
    )?.versions;
    assert.deepEqual(versionsEmptied, [rekeyVersion]);
    emit(
      112,
      `INVITE_STEP_12_DELETE version_delete=versions_stripped surviving_key=${survivingKey.status} deleted_key=${deletedKey.status}`
    );
    lastReceipt = 112;

    // INVITE_STEP_13. relic-mcp grants nothing: its share returns a link for the owner, with no service call.
    const callsBeforeShare = serviceCalls;
    const mcpShare = await mcp('relic_share', {
      relic_id: relicId,
      emails: [DELETE_INVITEE],
    });
    assert.equal(
      serviceCalls,
      callsBeforeShare,
      'private share made a service call'
    );
    const grantUrl = new URL(stringAt(mcpShare, 'grant_url', 'private share'));
    assert.equal(grantUrl.searchParams.get('access'), 'share');
    assert.equal(
      new URLSearchParams(grantUrl.hash.slice(1)).get('to'),
      DELETE_INVITEE
    );
    const refusedSigner = await callMcpRaw(env, 'relic_request_signatures', {
      relic_id: relicId,
      signers: [{ email: DELETE_INVITEE }],
    });
    assert.equal(refusedSigner.isError, true);
    assert.equal(refusedSigner.structured['code'], 'recipient_forged_grant');
    assert.equal(refusedSigner.structured['grant_url'] !== undefined, true);
    assert.equal(refusedSigner.structured['signer_email'], DELETE_INVITEE);
    emit(
      113,
      `INVITE_STEP_13_MCP grant_url_unregistered=invite_offered service_calls=0 refusal=recipient_forged_grant grant_url_in_refusal=true`
    );
    lastReceipt = 113;

    {
      // ---- Stage C: signing (plan section 10, DIRECT_STEP_11 to 13). ----
      // A fresh revision gives the request a version the browser can check.
      await writeFile(
        docPath,
        'Direct share signing proof, version for signing.\n'
      );
      await mcp('relic_republish', { relic_id: relicId, path: docPath });
      const signedVersion = await versionOf();

      const tamperActor = await launchActor(env, 'tamper', TAMPER, true);
      actors.push(tamperActor);
      const tamperIdentity = await setUpIdentity(tamperActor, relicUrl);
      tamperTarget = { email: env.third, identityId: thirdId.identityId };
      // The owner key re-signs a tampered grant, so only the grant rule can refuse it.
      tamperSign = async (message: Uint8Array): Promise<Uint8Array> =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            ownerKeys.keys.sig.privateKey,
            new Uint8Array(message)
          )
        );

      // DIRECT_STEP_12, part one: a public relik takes no grants. A session is refused
      // by the owner check first; the publish-token path reaches the grant rule.
      const publicOwnerAnswer = await api(
        env,
        'POST',
        `/api/relics/${publicId}/signing/requests`,
        {
          cookie: ownerCookie,
          body: { grants: [{ statement: {}, identity_signature: '' }] },
        }
      );
      assert.equal(
        publicOwnerAnswer.status,
        400,
        `session answer: ${JSON.stringify(publicOwnerAnswer.json)}`
      );
      assert.equal(problemCode(publicOwnerAnswer), 'invalid_statement');
      const publicToken =
        (await loadPublishState(publicId))?.publish_token ?? '';
      const publicGrants = await api(
        env,
        'POST',
        `/api/relics/${publicId}/signing/requests`,
        {
          body: {
            publish_token: publicToken,
            grants: [{ statement: {}, identity_signature: '' }],
          },
        }
      );
      assert.equal(
        publicGrants.status,
        400,
        `public grants answer: ${JSON.stringify(publicGrants.json)}`
      );
      assert.equal(problemCode(publicGrants), 'invalid_statement');

      // DIRECT_STEP_12, part two: an address with no identity is refused before any tap.
      await openComposer(owner, relicUrl);
      await setSigner(owner, 1, UNREGISTERED);
      await clickButton(owner.browser, 'Review and send', '.signing-panel');
      await poll('unregistered signer refused', 25000, async () =>
        (await panelText(owner.browser)).includes("can't open this relik yet")
          ? true
          : undefined
      );
      const unregisteredSendOffered = await hasButton(
        owner.browser,
        'Send with passkey',
        '.signing-panel'
      );
      assert.equal(
        unregisteredSendOffered,
        false,
        'the composer offered a send'
      );
      assert.equal((await requestsOf(relicId)).length, 0, 'a request was made');
      assert.equal(
        mailbox.all().filter((m) => m.to.toLowerCase() === UNREGISTERED).length,
        0,
        'a mail went to an unregistered address'
      );

      // DIRECT_STEP_12, part three: the browser's grant, rewritten in transit, is refused by the grant rule.
      await setSigner(owner, 1, TAMPER);
      await clickButton(owner.browser, 'Review and send', '.signing-panel');
      await poll('tamper review', 25000, async () =>
        (await hasButton(owner.browser, 'Send with passkey', '.signing-panel'))
          ? true
          : undefined
      );
      tamperMode = 'grantee';
      await clickButton(owner.browser, 'Send with passkey', '.signing-panel');
      const granteeRefusal = await poll(
        'grantee refusal',
        60000,
        async () => tamperResult
      );
      tamperResult = undefined;
      assert.equal(
        granteeRefusal.status,
        400,
        'a non-signer grantee was accepted'
      );
      assert.equal(granteeRefusal.code, 'invalid_statement');
      assert.equal(granteeRefusal.statementCheck, 'grants');
      tamperMode = 'versions';
      await clickButton(owner.browser, 'Send with passkey', '.signing-panel');
      const versionRefusal = await poll(
        'versions refusal',
        60000,
        async () => tamperResult
      );
      tamperResult = undefined;
      assert.equal(
        versionRefusal.status,
        400,
        'a grant for another version was accepted'
      );
      assert.equal(versionRefusal.code, 'invalid_statement');
      assert.equal(versionRefusal.statementCheck, 'grants');
      assert.equal(
        await store.getGrant(relicId, tamperIdentity.identityId),
        undefined,
        'a refused grant was stored'
      );
      emit(
        116,
        `DIRECT_STEP_12_SIGNING_REFUSALS unregistered_signer=refused_no_request send_offered=${unregisteredSendOffered} grants_on_public_session=${publicOwnerAnswer.status} grants_on_public_publish_token=${publicGrants.status} grantee_not_signer=${granteeRefusal.status} versions_not_request=${versionRefusal.status} unregistered_mail=0 refused_grants_stored=0`
      );
      lastReceipt = 116;

      // DIRECT_STEP_13, part one: the grant route refuses under the kill switch before it consumes the challenge.
      killNextGrant = true;
      await freshSharePanel(owner, relicUrl);
      await addToPanel(owner, [TAMPER], 1);
      await click(owner.browser, '[data-action="share-passkey"]');
      const killed = await poll(
        'kill switch answer',
        60000,
        async () => killedGrant
      );
      killNextGrant = false;
      assert.equal(killed.status, 503);
      assert.equal(killed.code, 'service_paused');
      // The browser's own grant body, with its wraps, is replayed unchanged.
      const replayedGrant = await apps[0]!.fetch(
        new Request(killed.url, {
          method: 'POST',
          headers: killed.headers,
          body: killed.body.slice(0),
        })
      );
      const replayedText = await replayedGrant.clone().text();
      assert.equal(replayedGrant.status, 201, `replay answer: ${replayedText}`);
      assert.ok(await store.getGrant(relicId, tamperIdentity.identityId));

      // DIRECT_STEP_11. One tap grants the signers who have no grant and sends the request.
      const signer = await launchActor(env, 'direct-signer', SIGNER, true);
      actors.push(signer);
      const signerIdentity = await setUpIdentity(signer, relicUrl);
      await openComposer(owner, relicUrl);
      await setSigner(owner, 1, SIGNER);
      await addSigner(owner, 2);
      await setSigner(owner, 2, INVITEE_FIVE);
      await addSigner(owner, 3);
      await setSigner(owner, 3, INVITEE);
      await addSigner(owner, 4);
      await setSigner(owner, 4, env.owner);
      await clickButton(owner.browser, 'Review and send', '.signing-panel');
      await poll('composer review', 25000, async () =>
        (await hasButton(owner.browser, 'Send with passkey', '.signing-panel'))
          ? true
          : undefined
      );
      assert.ok(
        (await panelText(owner.browser)).includes('access when you send'),
        'the composer did not say the signers will be granted'
      );
      // Editing a signer after review invalidates the review: nothing is sent.
      await setSigner(owner, 1, env.reader);
      if (await hasButton(owner.browser, 'Send with passkey', '.signing-panel'))
        await clickButton(owner.browser, 'Send with passkey', '.signing-panel');
      await poll('review invalidated', 25000, async () =>
        (await hasButton(owner.browser, 'Review and send', '.signing-panel'))
          ? true
          : undefined
      );
      // The composer either says so on the next tap or drops the review on the edit.
      const reviewEdit = (await panelText(owner.browser)).includes(
        'Review it again'
      )
        ? 'notice'
        : 'reset_on_edit';
      assert.equal(
        await hasButton(owner.browser, 'Send with passkey', '.signing-panel'),
        false,
        'the edited review still offers a send'
      );
      assert.equal(
        (await requestsOf(relicId)).length,
        0,
        'an invalidated review sent'
      );
      await setSigner(owner, 1, SIGNER);
      await clickButton(owner.browser, 'Review and send', '.signing-panel');
      await poll('composer review again', 25000, async () =>
        (await hasButton(owner.browser, 'Send with passkey', '.signing-panel'))
          ? true
          : undefined
      );

      const mailMark = mailbox.mark();
      const signBeforeSend = await signCountTotal(owner.browser);
      await clickButton(owner.browser, 'Send with passkey', '.signing-panel');
      await poll('request sent', 60000, async () =>
        (await panelText(owner.browser)).includes('Relik emailed')
          ? true
          : undefined
      );
      const signDelta = (await signCountTotal(owner.browser)) - signBeforeSend;
      const openRequest = (await requestsOf(relicId))[0];
      assert.ok(openRequest, 'the request was not recorded');
      assert.deepEqual(
        openRequest.signers.map((signerRow) => signerRow.email).sort(),
        [SIGNER, INVITEE_FIVE, INVITEE, env.owner].sort(),
        'the request does not name the four signers'
      );
      const sendBody = [...requestBodies]
        .reverse()
        .map((body) => {
          try {
            return JSON.parse(body) as Json;
          } catch {
            return undefined;
          }
        })
        .find(
          (body) =>
            Array.isArray(body?.['grants']) &&
            (body['grants'] as unknown[]).length > 0
        );
      assert.ok(sendBody, 'the send carried no grants');
      const grantRows = sendBody['grants'] as Json[];
      const grantedEmails = grantRows
        .map((grant) => String((grant['statement'] as Json)['grantee_email']))
        .sort();
      assert.deepEqual(
        grantedEmails,
        [SIGNER, INVITEE_FIVE].sort(),
        'the send granted a signer that already had a grant, or missed one'
      );
      const grantVersions = grantRows.map(
        (grant) => (grant['statement'] as Json)['versions']
      );
      assert.deepEqual(
        grantVersions,
        grantRows.map(() => [signedVersion])
      );
      assert.ok(
        await store.getGrant(relicId, signerIdentity.identityId),
        'the new signer was not granted'
      );
      assert.ok(
        await store.getGrant(relicId, existingIdentity.identityId),
        'the invited claimant was not granted by the send'
      );
      const signerMail = await mailbox.await(
        SIGNER,
        mailMark,
        (mail) => mail.subject.includes('turn to sign'),
        'signer invitation'
      );
      const signerMails = mailbox
        .all()
        .slice(mailMark)
        .filter(
          (mail) =>
            mail.to.toLowerCase() === SIGNER &&
            mail.subject.includes('turn to sign')
        ).length;
      assert.ok(signerMail);
      assert.equal(
        signDelta,
        1,
        'the send used more than one passkey assertion'
      );

      // The public relik still takes a signer through the device path, with no lookup.
      const lookupsBeforePublic = lookupCalls;
      await mcp('relic_request_signatures', {
        relic_id: publicId,
        signers: [{ email: PUBLIC_SIGNER }],
      });
      const publicOpen = (await requestsOf(publicId)).length;
      const publicNoLookup =
        lookupCalls === lookupsBeforePublic && publicOpen === 1;
      assert.equal(
        publicNoLookup,
        true,
        'a public signer used the private lookup'
      );

      await signAs(signer, relicUrl, SIGNER, relicId, 'Direct Signer');
      await signAs(
        fifthInvitee,
        relicUrl,
        INVITEE_FIVE,
        relicId,
        'Direct Invitee'
      );
      await signAs(
        invitee,
        relicUrl,
        INVITEE,
        relicId,
        'Direct Confirmed Invitee'
      );
      await signAs(owner, relicUrl, env.owner, relicId, 'Direct Owner');

      const certificatePath = join(scratch, 'direct-signing.json');
      await mcp('relic_read_signing', {
        relic_id: relicId,
        save_certificate_to: certificatePath,
      });
      const verifiedCertificate = await mcp('relic_verify_certificate', {
        certificate_path: certificatePath,
        file_path: docPath,
        trusted_owner_identity_id: ownerKeys.identityId,
      });
      assert.equal(
        verifiedCertificate['valid'],
        true,
        JSON.stringify(verifiedCertificate)
      );
      assert.equal(verifiedCertificate['content'], 'match');
      emit(
        115,
        `DIRECT_STEP_11_SIGNING_ONE_TAP owner_sign_count_delta=${signDelta} grants=${grantedEmails.length} new_signer_versions=[${signedVersion}] owner_as_signer=accepted request=${openRequest.status ?? 'unreported'} signer_mails=${signerMails} signed=ok certificate=valid public_signer=no_lookup known_signer=no_new_grant invited_claimant=granted_on_send review_edit=${reviewEdit}`
      );
      lastReceipt = 115;

      // DIRECT_STEP_13, part two: the MCP share lines, and the enumeration lines.
      const callsBeforeShare = serviceCalls;
      const directShare = await mcp('relic_share', {
        relic_id: relicId,
        emails: [UNREGISTERED],
      });
      const shareCalls = serviceCalls - callsBeforeShare;
      const localState = await localPrivateState(env, relicId);
      const shareOutput = JSON.stringify(directShare);
      const keyInOutput = [localState.publishToken, ...localState.keys].some(
        (secret) => shareOutput.includes(secret)
      );
      assert.equal(shareCalls, 0, 'relic_share made a service call');
      assert.equal(keyInOutput, false, 'a key reached relic_share output');
      const refusedSigner = await callMcpRaw(env, 'relic_request_signatures', {
        relic_id: relicId,
        signers: [{ email: UNREGISTERED }],
      });
      assert.equal(refusedSigner.isError, true);
      assert.equal(refusedSigner.structured['code'], 'recipient_forged_grant');
      assert.ok(refusedSigner.structured['grant_url'] !== undefined);
      emit(
        117,
        `DIRECT_STEP_13_MCP share_grant_url=fragment_addresses service_calls=${shareCalls} key_in_output=${keyInOutput} request_signatures=recipient_forged_grant grant_url_in_refusal=true`
      );
      emit(
        119,
        `DIRECT_STEP_13_KILL_SWITCH grant=${killed.status}_${killed.code} replay=${replayedGrant.status} nonce_consumed_by_refusal=false`
      );
      const stripInstance = (body: Json): Json => {
        const { instance: _instance, ...rest } = body;
        return rest;
      };
      const readerNow = await cookieHeader(reader.browser);
      const registeredLookup = await api(
        env,
        'POST',
        `/api/relics/${relicId}/grants/lookup`,
        { cookie: readerNow, body: { emails: [env.third] } }
      );
      const unregisteredLookup = await api(
        env,
        'POST',
        `/api/relics/${relicId}/grants/lookup`,
        { cookie: readerNow, body: { emails: [UNREGISTERED] } }
      );
      const identicalRefusal =
        registeredLookup.status === unregisteredLookup.status &&
        JSON.stringify(stripInstance(registeredLookup.json)) ===
          JSON.stringify(stripInstance(unregisteredLookup.json));
      assert.equal(
        identicalRefusal,
        true,
        'a non-owner can tell registered from unregistered'
      );
      emit(
        118,
        `DIRECT_STEP_13_ENUMERATION non_owner_registered=${registeredLookup.status} non_owner_unregistered=${unregisteredLookup.status} identical=${identicalRefusal}`
      );
      lastReceipt = 119;
    }

    // Whole-relik deletion: every invitation and claim of this relik goes with it.
    const wholeNonce = await api(env, 'POST', '/api/attest/nonce', {
      cookie: ownerCookie,
      body: { purpose: 'delete', relic_id: relicId },
    });
    assert.equal(wholeNonce.status, 200);
    const wholeAttestation = await attestationFor(
      owner,
      ownerKeys,
      stringAt(wholeNonce.json, 'nonce', 'nonce'),
      wholeNonce.json['public_key'] as Json,
      [
        {
          kind: 'delete',
          statement: {
            at: Date.now(),
            owner_identity_id: ownerKeys.identityId,
            relic_id: relicId,
            versions: 'all',
          },
        },
      ] as unknown as Parameters<typeof attestationFor>[4]
    );
    const wholeDelete = await api(
      env,
      'POST',
      `/api/relics/${relicId}/delete`,
      {
        cookie: ownerCookie,
        body: { attestation: wholeAttestation.attestation },
      }
    );
    assert.equal(wholeDelete.status, 200);
    const invitesLeft = (await store.listInvites(relicId)).length;
    const claimsLeft = (await store.listInviteClaims(relicId)).length;
    assert.equal(invitesLeft, 0);
    assert.equal(claimsLeft, 0);
    emit(
      114,
      `INVITE_STEP_12_RELIK_DELETE whole_relik=invites_${invitesLeft},claims_${claimsLeft}`
    );
    lastReceipt = 114;
  } finally {
    for (const actor of actors) await actor.browser.close().catch(() => {});
  }
}

function flushProofLines(): void {
  for (const { line } of [...proofLines].sort((a, b) => a.order - b.order)) {
    console.log(line);
  }
}

try {
  await run();
  flushProofLines();
  if (defects.length > 0) {
    console.error(`DIRECT_SHARE_PATH_BLOCKED defects=${defects.join(',')}`);
    process.exitCode = 1;
  } else {
    console.log('DIRECT_SHARE_PATH_OK');
  }
} catch (error) {
  flushProofLines();
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `DIRECT_SHARE_PATH_FAILED last_receipt_step=${lastReceipt} ${message}`
  );
  process.exitCode = 1;
} finally {
  service.stop(true);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
