/**
 * Shared proof steps for Relic private shares (plan section 5 S8).
 *
 * Used by:
 *   - packages/relic-mcp/test/private-shares-path.ts (loopback proof)
 *   - packages/relic-mcp/test/private-shares-live-probe.ts (operator-run probe)
 *
 * The steps drive the real viewer in isolated headless browsers (one PRF
 * virtual authenticator per person, plus one authenticator without PRF) and the
 * real relic-mcp over stdio. A browser holds only its own person's keys.
 *
 * Owner bootstrap: a publisher's first identity has no entry point in the
 * viewer. Identity setup is offered only on a private relic page, and a private
 * relic needs a confirmed owner device, which needs the owner identity. The
 * owner's identity is therefore registered here through the same routes and the
 * same format functions the viewer uses. Its keys stay in this process.
 *
 * Product defects are reported through `defect` with their evidence, never
 * hidden. Where a defect blocks a viewer action, the same server contract is
 * performed from this process, signed with the owner keys it holds, so the
 * steps after it still run. A run with any defect exits nonzero.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeEmail } from '@relic/format';
import {
  attestationChallenge,
  decodeBase64url,
  deriveKek,
  encodeBase64url,
  encryptIdentityBundle,
  generateIdentityKeys,
  type IdentityKeys,
  identityFingerprint,
  identityIdOf,
  kemKeyIdOf,
  PRF_SALT,
  parseStatement,
  parseTypedFingerprint,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import type { RelicStore } from '@relic/server/src/store.ts';
import type { ObjectStorage } from '@relic/server/src/storage.ts';
import {
  callMcp,
  launchProofBrowser,
  type RunningProofBrowser,
} from './decision-proof-steps.ts';

/** One captured mail. Sign-in codes carry `code` and `link`; other mail has a subject and text. */
export interface CapturedMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly code?: string;
  readonly link?: string;
}

/** Where mail comes from: captured in process for the loopback path, read from the operator for the live probe. */
export interface Mailbox {
  /** How many mails have been seen, so a wait can be limited to newer mail. */
  mark(): number;
  /** Every mail seen so far. */
  all(): readonly CapturedMail[];
  /** The first mail to `to` after `since` that satisfies `match`. */
  await(
    to: string,
    since: number,
    match: (mail: CapturedMail) => boolean,
    label: string
  ): Promise<CapturedMail>;
}

export interface PrivateShareEnv {
  readonly serviceOrigin: string;
  readonly scratchDir: string;
  readonly statePath: string;
  readonly mcpCommand: readonly string[];
  readonly chromePath: string;
  readonly owner: string;
  readonly reader: string;
  readonly third: string;
  readonly noPrf: string;
  readonly mailbox: Mailbox;
  /** Loopback only: direct reads of the service's records. Absent for the live probe. */
  readonly store?: RelicStore;
  readonly storage?: ObjectStorage;
  /** Receives one finished step's receipt line. */
  readonly receipt: (step: number, line: string) => void;
  /** Receives one product defect with the evidence that shows it. */
  readonly defect: (id: string, evidence: string) => void;
}

/** A person's browser and what the steps learn about that person. */
interface Actor {
  readonly name: string;
  readonly email: string;
  readonly browser: RunningProofBrowser;
  identityId?: string;
  /** POST /api/identity requests this browser sent, counted from the wire. */
  identityPosts: number;
}

export const FILE_NAME = 'private-proof.txt';
export const COMMENT_TEXT = 'The reader comment for the private shares proof.';
const DOCUMENT_TEXT =
  'Relic private shares proof document\nOne reader, one grant, one revocation.\n';
const DEVICE_CERT_MS = 30 * 24 * 60 * 60 * 1000;
/** The relic notification subjects from plan 4.14. Account mail (passkey and key notices) is not one of them. */
const RELIC_NOTICE_SUBJECTS: readonly string[] = [
  'Someone asked for access to a relic',
  'You have access to a relic',
  'Activity on a relic',
];

/** D1: renderDashboard detaches the shell root, so the private dashboard sections never show. */
export const DEFECT_DASHBOARD_DETACHED = 'D1_dashboard_root_detached';
/** D2: renderReady detaches the shell root, so the private strip and the owner's access control never show. */
export const DEFECT_READY_DETACHED = 'D2_ready_view_root_detached';
/** D3: a grant of a version sealed before the grant cannot be opened, because the seal does not list the grantee. */
export const DEFECT_GRANT_UNOPENABLE =
  'D3_granted_reader_cannot_open_sealed_version';
/** D4: after a revocation republishes, the owner's viewer cannot open the new version (an unclassified failure). */
export const DEFECT_REPUBLISHED_UNOPENABLE =
  'D4_owner_cannot_open_republished_version';
/* -------------------------------------------------------------------------- */
/* Typed reads of service JSON                                                */
/* -------------------------------------------------------------------------- */

/** The public assertion a page returns, plus the PRF bytes when the salt was evaluated. */
interface PageAssertion {
  readonly id: string;
  readonly rawId: string;
  readonly response: Record<string, string | null>;
  readonly prf: string | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Json;
}

function stringAt(object: Json, key: string, what: string): string {
  const value = object[key];
  if (typeof value !== 'string')
    throw new TypeError(`${what}.${key} is not a string`);
  return value;
}

function numberAt(object: Json, key: string, what: string): number {
  const value = object[key];
  if (typeof value !== 'number')
    throw new TypeError(`${what}.${key} is not a number`);
  return value;
}

function descriptorsOf(options: Json): Array<{ id: string }> {
  const list = options['allowCredentials'];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({
    id: stringAt(asObject(entry, 'allowCredentials'), 'id', 'allowCredentials'),
  }));
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/** Lowercase canonical form of a displayed fingerprint (groups separated by spaces). */
function canonicalOf(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/** The same fingerprint with its last character changed. Always a valid alphabet character. */
function altered(fingerprint: string): string {
  return `${fingerprint.slice(0, 31)}${fingerprint.endsWith('0') ? '1' : '0'}`;
}

/* -------------------------------------------------------------------------- */
/* Waiting                                                                    */
/* -------------------------------------------------------------------------- */

async function poll<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* -------------------------------------------------------------------------- */
/* Browser driving                                                            */
/* -------------------------------------------------------------------------- */

/** Runs a self-contained function in the page and returns its serialized result. */
async function inPage<A, R>(
  browser: RunningProofBrowser,
  fn: (args: A) => Promise<R> | R,
  args: A
): Promise<R> {
  return browser.evaluate<R>(`(${fn.toString()})(${JSON.stringify(args)})`);
}

async function goto(browser: RunningProofBrowser, url: string): Promise<void> {
  const loaded = browser.cdp.waitForEvent('Page.loadEventFired', {
    sessionId: browser.sessionId,
    timeoutMs: 25000,
  });
  await browser.cdp.send('Page.navigate', { url }, browser.sessionId);
  await loaded;
}

async function currentState(
  browser: RunningProofBrowser
): Promise<string | undefined> {
  return browser.evaluate<string | undefined>(
    `document.querySelector('#relic-private')?.getAttribute('data-private-state') ?? undefined`
  );
}

async function waitForState(
  browser: RunningProofBrowser,
  states: readonly string[],
  label: string,
  timeoutMs = 25000
): Promise<string> {
  return poll(`${label} (${states.join(' or ')})`, timeoutMs, async () => {
    const state = await currentState(browser);
    return state !== undefined && states.includes(state) ? state : undefined;
  });
}

/**
 * The relic's content is open when the shell shows the file name. The private
 * strip is not used for this check, because defect D2 keeps it out of the page.
 */
async function waitForOpened(
  browser: RunningProofBrowser,
  label: string
): Promise<void> {
  await poll(`${label} opened relic`, 25000, async () => {
    const shown = await browser.evaluate<boolean>(
      `document.body.innerText.includes(${JSON.stringify(FILE_NAME)})`
    );
    return shown ? true : undefined;
  }).catch(async (error: unknown) => {
    const stage = await currentState(browser);
    const text = await browser.evaluate<string>(
      `document.body.innerText.slice(0, 1400)`
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; stage=${stage ?? 'none'}; page=${JSON.stringify(text)}`
    );
  });
}

async function setField(
  browser: RunningProofBrowser,
  selector: string,
  value: string
): Promise<void> {
  await browser.waitForSelector(selector, 20000);
  await browser.evaluate<void>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      throw new Error('not a field: ' + ${JSON.stringify(selector)});
    }
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function submitForm(
  browser: RunningProofBrowser,
  selector: string
): Promise<void> {
  await browser.waitForSelector(selector, 20000);
  await browser.evaluate<void>(`(() => {
    const form = document.querySelector(${JSON.stringify(selector)});
    if (!(form instanceof HTMLFormElement)) throw new Error('not a form: ' + ${JSON.stringify(selector)});
    form.requestSubmit();
  })()`);
}

/** Clicks a control once it exists and is enabled. */
async function click(
  browser: RunningProofBrowser,
  selector: string,
  timeoutMs = 25000
): Promise<void> {
  await poll(`enabled ${selector}`, timeoutMs, async () => {
    const enabled = await browser.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el instanceof HTMLButtonElement && !el.disabled;
    })()`);
    return enabled ? true : undefined;
  });
  await browser.evaluate<void>(
    `document.querySelector(${JSON.stringify(selector)}).click()`
  );
}

async function textOf(
  browser: RunningProofBrowser,
  selector: string
): Promise<string> {
  await browser.waitForSelector(selector, 25000);
  return browser.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`
  );
}

/** Session cookies for the service origin as one Cookie header value. */
async function cookieHeader(browser: RunningProofBrowser): Promise<string> {
  const cookies = await browser.getCookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Counts POST /api/identity requests this browser sends, from the wire. */
function countIdentityPosts(actor: Actor): void {
  actor.browser.cdp.onEvent((event) => {
    if (event.method !== 'Network.requestWillBeSent') return;
    if (event.sessionId !== actor.browser.sessionId) return;
    const request = (
      event.params as { request?: { url?: string; method?: string } }
    ).request;
    if (request?.method === 'POST' && request.url?.endsWith('/api/identity')) {
      actor.identityPosts += 1;
    }
  });
}

/** Total signCount over the browser's virtual authenticator credentials, read from the authenticator. */
async function signCountTotal(browser: RunningProofBrowser): Promise<number> {
  const res = (await browser.cdp.send(
    'WebAuthn.getCredentials',
    { authenticatorId: browser.authenticatorId },
    browser.sessionId
  )) as { credentials?: Array<{ signCount?: number }> };
  return (res.credentials ?? []).reduce(
    (sum, credential) => sum + (credential.signCount ?? 0),
    0
  );
}

async function launchActor(
  env: PrivateShareEnv,
  name: string,
  email: string,
  hasPrf: boolean
): Promise<Actor> {
  const browser = await launchProofBrowser(env.chromePath, env.serviceOrigin, {
    hasPrf,
  });
  const actor: Actor = { name, email, browser, identityPosts: 0 };
  countIdentityPosts(actor);
  return actor;
}

/* -------------------------------------------------------------------------- */
/* In-page ceremonies. Each is self-contained: it is serialized into the page. */
/* -------------------------------------------------------------------------- */

/** A first passkey, created through the options endpoint the sign-in offer uses. */
async function pageCreatePasskey(args: {
  readonly prf: boolean;
}): Promise<string> {
  const toBytes = (text: string): Uint8Array => {
    const pad = '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const fromBytes = (buffer: ArrayBuffer): string => {
    let bin = '';
    for (const byte of new Uint8Array(buffer)) bin += String.fromCharCode(byte);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const post = async (
    path: string,
    body: unknown
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new Error(
        `${path} ${response.status} ${String(json['code'] ?? '')}`
      );
    return json;
  };
  const first = await post('/api/auth/passkeys/options', {});
  const options = first['public_key'] as Record<string, unknown> | undefined;
  if (!options || typeof options['challenge'] !== 'string') {
    throw new Error('the server returned no creation options');
  }
  const user = options['user'] as { id: string };
  const exclude =
    (options['excludeCredentials'] as Array<{ id: string }> | undefined) ?? [];
  const publicKey: Record<string, unknown> = {
    ...options,
    challenge: toBytes(options['challenge']),
    user: { ...user, id: toBytes(user.id) },
    excludeCredentials: exclude.map((credential) => ({
      ...credential,
      id: toBytes(credential.id),
    })),
  };
  if (!args.prf) delete publicKey['extensions'];
  const created = (await navigator.credentials.create({
    publicKey: publicKey as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!created) throw new Error('passkey creation was cancelled');
  const response = created.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === 'function'
      ? response.getTransports()
      : undefined;
  await post('/api/auth/passkeys', {
    credential: {
      id: created.id,
      rawId: fromBytes(created.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: fromBytes(response.clientDataJSON),
        attestationObject: fromBytes(response.attestationObject),
        ...(transports === undefined ? {} : { transports }),
      },
    },
  });
  return created.id;
}

/**
 * One assertion, optionally evaluating the identity PRF salt. The PRF bytes
 * come back only to the test process, which derives the identity KEK from them
 * in memory. They are never sent to the service.
 */
async function pageAssert(args: {
  readonly challenge: string;
  readonly rpId: string;
  readonly allowCredentials: ReadonlyArray<{ readonly id: string }>;
  readonly prfSalt?: string;
}): Promise<{
  readonly id: string;
  readonly rawId: string;
  readonly response: Record<string, string | null>;
  readonly prf: string | null;
}> {
  const toBytes = (text: string): Uint8Array => {
    const pad = '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const fromBytes = (buffer: ArrayBuffer | null | undefined): string | null => {
    if (!buffer) return null;
    let bin = '';
    for (const byte of new Uint8Array(buffer)) bin += String.fromCharCode(byte);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const publicKey: Record<string, unknown> = {
    challenge: toBytes(args.challenge),
    rpId: args.rpId,
    allowCredentials: args.allowCredentials.map((credential) => ({
      type: 'public-key',
      id: toBytes(credential.id),
    })),
    userVerification: 'required',
  };
  if (args.prfSalt !== undefined) {
    publicKey['extensions'] = {
      prf: { eval: { first: toBytes(args.prfSalt) } },
    };
  }
  const credential = (await navigator.credentials.get({
    publicKey: publicKey as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('the assertion was cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  const results = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  return {
    id: credential.id,
    rawId: fromBytes(credential.rawId) ?? '',
    response: {
      clientDataJSON: fromBytes(response.clientDataJSON),
      authenticatorData: fromBytes(response.authenticatorData),
      signature: fromBytes(response.signature),
      userHandle: fromBytes(response.userHandle),
    },
    prf: fromBytes(results.prf?.results?.first),
  };
}

/* -------------------------------------------------------------------------- */
/* Service calls from the test process                                        */
/* -------------------------------------------------------------------------- */

interface ApiResult {
  readonly status: number;
  readonly json: Json;
}

async function api(
  env: PrivateShareEnv,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly cookie?: string; readonly body?: unknown } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['cookie'] = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${env.serviceOrigin}${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return { status: response.status, json: asObject(parsed, path) };
}

function problemCode(result: ApiResult): string | undefined {
  const code = result.json['code'];
  return typeof code === 'string' ? code : undefined;
}

function setCookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ');
}

/** Sign in from the test process. Used only for the owner bootstrap. Returns the session cookie. */
async function nodeSignIn(
  env: PrivateShareEnv,
  email: string
): Promise<string> {
  const since = env.mailbox.mark();
  const requested = await fetch(`${env.serviceOrigin}/api/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.status, 202, 'the sign-in request was not accepted');
  const pending = setCookiePairs(requested);
  const mail = await env.mailbox.await(
    email,
    since,
    (m) => m.code !== undefined,
    'owner sign-in code'
  );
  const verified = await fetch(`${env.serviceOrigin}/api/auth/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: pending },
    body: JSON.stringify({ code: mail.code }),
  });
  assert.equal(
    verified.status,
    200,
    `the sign-in code was refused (${verified.status})`
  );
  return setCookiePairs(verified);
}

/** The session cookie as a CDP cookie for the service origin. */
function sessionCookieParams(
  env: PrivateShareEnv,
  cookie: string
): Record<string, unknown> {
  const pair = cookie.split(';')[0] ?? '';
  const split = pair.indexOf('=');
  return {
    name: pair.slice(0, split),
    value: pair.slice(split + 1),
    url: env.serviceOrigin,
    httpOnly: true,
    sameSite: 'Lax',
  };
}

/* -------------------------------------------------------------------------- */
/* Viewer sign-in and identity on a private relic page                        */
/* -------------------------------------------------------------------------- */

/** Email-code sign-in through the viewer's own form on the private relic page. */
async function viewerSignIn(
  env: PrivateShareEnv,
  actor: Actor,
  relicUrl: string
): Promise<void> {
  await goto(actor.browser, relicUrl);
  await waitForState(actor.browser, ['signin'], `${actor.name} sign-in`);
  const since = env.mailbox.mark();
  await setField(actor.browser, '#signin-email', actor.email);
  await submitForm(actor.browser, '#signin-email-form');
  const mail = await env.mailbox.await(
    actor.email,
    since,
    (m) => m.code !== undefined,
    `${actor.name} sign-in code`
  );
  await poll(`${actor.name} code form`, 15000, async () => {
    const shown = await actor.browser.evaluate<boolean>(
      `!document.querySelector('#signin-code-form')?.hidden`
    );
    return shown ? true : undefined;
  });
  await setField(actor.browser, '#signin-code', mail.code ?? '');
  await submitForm(actor.browser, '#signin-code-form');
  await waitForState(
    actor.browser,
    [
      'setup',
      'request',
      'requested',
      'unlock',
      'revoked',
      'declined',
      'denied',
    ],
    `${actor.name} after sign-in`
  );
}

/** The signed-in identity, read from the service for this browser's session. */
async function identityOf(
  env: PrivateShareEnv,
  actor: Actor
): Promise<{ identityId: string; kemPublicKey: Uint8Array }> {
  const state = await api(env, 'GET', '/api/identity', {
    cookie: await cookieHeader(actor.browser),
  });
  const identity = asObject(state.json['identity'], `${actor.name} identity`);
  const identityId = stringAt(
    identity,
    'identity_id',
    `${actor.name} identity`
  );
  actor.identityId = identityId;
  return {
    identityId,
    kemPublicKey: decodeBase64url(
      stringAt(identity, 'kem_public_key', `${actor.name} identity`)
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Owner identity keys (test process) and the statements it signs             */
/* -------------------------------------------------------------------------- */

interface OwnerKeys {
  readonly keys: IdentityKeys;
  readonly identityId: string;
}

type Draft = {
  readonly kind: 'identity_register' | 'grant' | 'device_cert';
  readonly statement: Json;
};

/**
 * The attestation for drafts signed with the owner keys. The passkey assertion
 * is over the attestation challenge. With `prfSalt`, the same assertion also
 * evaluates the PRF, and the result is returned for the caller's KEK.
 */
async function attestationFor(
  owner: Actor,
  ownerKeys: OwnerKeys,
  nonce: string,
  options: Json,
  drafts: readonly Draft[],
  prfSalt?: string
): Promise<{
  attestation: Json;
  assertion: PageAssertion;
}> {
  const bytes = drafts.map((draft) =>
    statementBytes(draft.kind, parseStatement(draft.kind, draft.statement))
  );
  const challenge = await attestationChallenge(decodeBase64url(nonce), bytes);
  const assertion = await inPage(owner.browser, pageAssert, {
    challenge: encodeBase64url(challenge),
    rpId: stringAt(options, 'rpId', 'public_key'),
    allowCredentials: descriptorsOf(options),
    ...(prfSalt === undefined ? {} : { prfSalt }),
  });
  const signer = async (message: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        ownerKeys.keys.sig.privateKey,
        new Uint8Array(message)
      )
    );
  const statements = [];
  for (const [index, draft] of drafts.entries()) {
    statements.push({
      kind: draft.kind,
      statement: draft.statement,
      identity_signature: await signStatement(
        signer,
        bytes[index] as Uint8Array
      ),
    });
  }
  return {
    attestation: {
      nonce,
      statements,
      credential: {
        id: assertion.id,
        rawId: assertion.rawId,
        type: 'public-key',
        response: assertion.response,
      },
    },
    assertion,
  };
}

/**
 * Registers the owner identity as the viewer's identity ceremony does: a fresh
 * key pair, a server nonce, one passkey assertion that carries the PRF output,
 * the bundle encrypted under the PRF-derived KEK, and a registration whose
 * statement is signed by the identity's signature key.
 */
async function bootstrapOwner(
  env: PrivateShareEnv,
  owner: Actor,
  cookie: string
): Promise<OwnerKeys> {
  const keys = await generateIdentityKeys();
  const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const issued = await api(env, 'POST', '/api/attest/nonce', {
    cookie,
    body: { purpose: 'identity_register' },
  });
  assert.equal(
    issued.status,
    200,
    `the identity nonce was refused (${issued.status})`
  );
  const { attestation, assertion } = await attestationFor(
    owner,
    { keys, identityId },
    stringAt(issued.json, 'nonce', 'nonce'),
    asObject(issued.json['public_key'], 'public_key'),
    [
      {
        kind: 'identity_register',
        statement: {
          at: Date.now(),
          email: normalizeEmail(owner.email),
          identity_id: identityId,
          kem_public_key: encodeBase64url(keys.kemPublicKey),
          replaces: null,
          sig_public_key: encodeBase64url(keys.sigPublicKey),
        },
      },
    ],
    encodeBase64url(PRF_SALT)
  );
  if (assertion.prf === null)
    throw new Error('the owner passkey returned no PRF output');
  const rawId = decodeBase64url(assertion.rawId);
  const kek = await deriveKek(decodeBase64url(assertion.prf), rawId);
  const encrypted = await encryptIdentityBundle(kek, keys, rawId);
  const created = await api(env, 'POST', '/api/identity', {
    cookie,
    body: { attestation, encrypted_bundle: encrypted },
  });
  assert.equal(
    created.status,
    201,
    `the identity registration was refused: ${JSON.stringify(created.json)}`
  );
  owner.identityId = identityId;
  return { keys, identityId };
}

/* -------------------------------------------------------------------------- */
/* relic-mcp over stdio                                                       */
/* -------------------------------------------------------------------------- */

interface McpRaw {
  readonly isError: boolean;
  readonly structured: Json;
  readonly text: string;
}

async function callMcpRaw(
  env: PrivateShareEnv,
  toolName: string,
  args: Json
): Promise<McpRaw> {
  const child = Bun.spawn([...env.mcpCommand], {
    cwd: env.scratchDir,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: env.serviceOrigin,
      RELIC_PUBLISH_STATE: env.statePath,
      RELIC_CHROME_PATH: 'none',
      RELIC_CLIENT_NAME: 'relic-mcp/private-shares',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, `relic-mcp exited ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const response = asObject(
    JSON.parse(lines[lines.length - 1] ?? '{}'),
    'mcp response'
  );
  const result = asObject(response['result'] ?? {}, 'mcp result');
  const content = Array.isArray(result['content']) ? result['content'] : [];
  return {
    isError: result['isError'] === true,
    structured: asObject(
      result['structuredContent'] ?? {},
      'structuredContent'
    ),
    text: content
      .map((item) =>
        typeof item === 'object' && item !== null && 'text' in item
          ? String(item.text)
          : ''
      )
      .join('\n'),
  };
}

/** The publish state this machine holds for one private relic. Read from the state file, never echoed. */
async function localPrivateState(
  env: PrivateShareEnv,
  relicId: string
): Promise<{ publishToken: string; keys: string[] }> {
  const parsed = asObject(
    JSON.parse(await readFile(env.statePath, 'utf8')),
    'state'
  );
  const bucket = asObject(parsed['private_relics'] ?? {}, 'private_relics');
  const entry = asObject(bucket[relicId], `private_relics.${relicId}`);
  const versionKeys = asObject(entry['version_keys'] ?? {}, 'version_keys');
  return {
    publishToken: stringAt(entry, 'publish_token', 'private state'),
    keys: Object.values(versionKeys).filter(
      (key): key is string => typeof key === 'string'
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Owner-signed server calls used when a viewer action is blocked (D1)        */
/* -------------------------------------------------------------------------- */

/** A grant signed by the owner identity, with the owner passkey's assertion over the attestation challenge. */
async function postGrant(
  env: PrivateShareEnv,
  owner: Actor,
  ownerKeys: OwnerKeys,
  options: {
    readonly relicId: string;
    readonly granteeEmail: string;
    readonly granteeIdentityId: string;
    readonly fingerprint: string;
    readonly versions: readonly number[];
  }
): Promise<ApiResult> {
  const cookie = await cookieHeader(owner.browser);
  const issued = await api(env, 'POST', '/api/attest/nonce', {
    cookie,
    body: { purpose: 'grant', relic_id: options.relicId },
  });
  assert.equal(
    issued.status,
    200,
    `the grant nonce was refused (${issued.status})`
  );
  const { attestation } = await attestationFor(
    owner,
    ownerKeys,
    stringAt(issued.json, 'nonce', 'nonce'),
    asObject(issued.json['public_key'], 'public_key'),
    [
      {
        kind: 'grant',
        statement: {
          at: Date.now(),
          fingerprint_typed: options.fingerprint,
          grantee_email: normalizeEmail(options.granteeEmail),
          grantee_identity_id: options.granteeIdentityId,
          owner_identity_id: ownerKeys.identityId,
          relic_id: options.relicId,
          versions: [...options.versions],
        },
      },
    ]
  );
  return api(env, 'POST', `/api/relics/${options.relicId}/grants`, {
    cookie,
    body: { attestation, wraps: [] },
  });
}

/**
 * Approves a device with the owner identity: the contract the dashboard
 * approval sends. Used because defect D1 keeps the approval off the page. The
 * device fingerprint is the one relic-mcp displayed.
 */
async function approveDeviceFromProcess(
  env: PrivateShareEnv,
  owner: Actor,
  ownerKeys: OwnerKeys,
  enrollmentId: string,
  deviceFingerprint: string
): Promise<void> {
  const cookie = await cookieHeader(owner.browser);
  const enrollment = await api(
    env,
    'GET',
    `/api/devices/enrollments/${enrollmentId}`
  );
  assert.equal(
    enrollment.status,
    200,
    `the enrollment was refused (${enrollment.status})`
  );
  const typed = parseTypedFingerprint(deviceFingerprint);
  if (typed === undefined)
    throw new Error('relic-mcp displayed a malformed device fingerprint');
  const issued = await api(env, 'POST', '/api/attest/nonce', {
    cookie,
    body: { purpose: 'device_approve' },
  });
  assert.equal(
    issued.status,
    200,
    `the device nonce was refused (${issued.status})`
  );
  const at = Date.now();
  const { attestation } = await attestationFor(
    owner,
    ownerKeys,
    stringAt(issued.json, 'nonce', 'nonce'),
    asObject(issued.json['public_key'], 'public_key'),
    [
      {
        kind: 'device_cert',
        statement: {
          at,
          device_fingerprint_typed: typed,
          device_id: stringAt(enrollment.json, 'device_id', 'enrollment'),
          kem_public_key: stringAt(
            enrollment.json,
            'kem_public_key',
            'enrollment'
          ),
          label: stringAt(enrollment.json, 'label', 'enrollment'),
          not_after: at + DEVICE_CERT_MS,
          owner_identity_id: ownerKeys.identityId,
          sig_public_key: stringAt(
            enrollment.json,
            'sig_public_key',
            'enrollment'
          ),
        },
      },
    ]
  );
  const approved = await api(
    env,
    'POST',
    `/api/devices/enrollments/${enrollmentId}/approve`,
    {
      cookie,
      body: { attestation },
    }
  );
  assert.equal(
    approved.status,
    200,
    `device approval was refused: ${JSON.stringify(approved.json)}`
  );
}

/* -------------------------------------------------------------------------- */
/* Owner request panel helpers                                                */
/* -------------------------------------------------------------------------- */

/** The owner's relic page with the access panel open. The panel mounts before the unlock replaces the page. */
async function openPanel(owner: Actor, relicUrl: string): Promise<void> {
  await goto(owner.browser, `${relicUrl}?access=requests`);
  await waitForState(
    owner.browser,
    ['unlock'],
    'owner page with the access panel'
  );
}

async function typeFingerprint(
  owner: Actor,
  identityId: string,
  value: string
): Promise<void> {
  await setField(
    owner.browser,
    `article[data-request-identity="${identityId}"] [data-fingerprint-input]`,
    value
  );
}

/** The grant button and the typed field's state inside one request, read from the page. */
async function grantState(
  owner: Actor,
  identityId: string
): Promise<{ disabled: boolean; state: string | null }> {
  return owner.browser.evaluate<{
    disabled: boolean;
    state: string | null;
  }>(`(() => {
    const article = document.querySelector('article[data-request-identity="${identityId}"]');
    const grant = article?.querySelector('button[data-action="grant"]');
    const field = article?.querySelector('.fp-field');
    return { disabled: grant ? grant.disabled : true, state: field ? field.getAttribute('data-fingerprint-state') : null };
  })()`);
}

async function currentVersion(
  browser: RunningProofBrowser,
  relicId: string
): Promise<number> {
  const body = await browser.evaluate<string>(
    `fetch(${JSON.stringify(`/api/relics/${relicId}/access`)}, { credentials: 'same-origin' }).then((r) => r.text())`
  );
  return numberAt(
    asObject(JSON.parse(body), 'access'),
    'current_version',
    'access'
  );
}

async function pageStatus(
  browser: RunningProofBrowser,
  method: 'POST' | 'GET',
  path: string,
  body: string
): Promise<number> {
  return browser.evaluate<number>(`fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)}, credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)}
  }).then((r) => r.status)`);
}

/** Records D2 when the ready view's private strip is missing from the page. */
async function checkReadyStrip(
  env: PrivateShareEnv,
  browser: RunningProofBrowser
): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `document.getElementById('ready-strip') !== null`
  );
  if (!present) {
    env.defect(
      DEFECT_READY_DETACHED,
      'the private strip and the owner access control never reach the page: renderReady calls document.body.replaceChildren (relic-viewer/src/main.ts:9301), which detaches #relic-root before mountReady prepends the strip to it (relic-viewer/src/private/reader.ts:712)'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The eleven steps                                                           */
/* -------------------------------------------------------------------------- */

export interface PrivateShareRun {
  readonly relicId: string;
  readonly relicUrl: string;
}

/**
 * Runs the eleven steps in order. A failed assertion throws with its message,
 * and the caller names the last receipt, so the failing step is reported.
 */
export async function runPrivateShares(
  env: PrivateShareEnv
): Promise<PrivateShareRun> {
  const docPath = join(env.scratchDir, FILE_NAME);
  await Bun.write(docPath, DOCUMENT_TEXT);
  const owner = await launchActor(env, 'owner', env.owner, true);
  const reader = await launchActor(env, 'reader', env.reader, true);
  const third = await launchActor(env, 'third', env.third, true);
  const noPrf = await launchActor(env, 'noprf', env.noPrf, false);
  try {
    const first = await stepsOneToThree(env, owner, docPath);
    const thirdEvidence = await setUpThird(env, third, first.relicUrl);
    const readerIdentity = await stepsFourAndFive(
      env,
      owner,
      reader,
      first.relicId,
      first.relicUrl,
      first.ownerKeys
    );
    if (env.store) {
      await stepSix(env, owner, third, first.relicId, readerIdentity);
    } else {
      env.receipt(6, `PRIVATE_STEP_6_SUBSTITUTED_KEY ui=not_run_live`);
    }
    await stepSeven(
      env,
      owner,
      reader,
      first.relicId,
      first.relicUrl,
      readerIdentity
    );
    const version = await stepEight(
      env,
      owner,
      reader,
      first.relicId,
      first.relicUrl
    );
    await stepNine(env, noPrf, thirdEvidence, first.relicUrl);
    await stepTen(env, first.relicId, first.relicUrl, docPath);
    await stepEleven(
      env,
      owner,
      first.relicId,
      first.relicUrl,
      version,
      first.ownerKeys
    );
    return { relicId: first.relicId, relicUrl: first.relicUrl };
  } finally {
    for (const actor of [owner, reader, third, noPrf])
      await actor.browser.close().catch(() => {});
  }
}

async function stepsOneToThree(
  env: PrivateShareEnv,
  owner: Actor,
  docPath: string
): Promise<PrivateShareRun & { ownerKeys: OwnerKeys }> {
  // Step 1. Owner identity: sign in, a PRF passkey, one identity ceremony.
  const ownerCookie = await nodeSignIn(env, owner.email);
  await owner.browser.cdp.send(
    'Network.setCookie',
    sessionCookieParams(env, ownerCookie),
    owner.browser.sessionId
  );
  // The landing page is served with default-src 'none', so page fetches fail there. The
  // dashboard is a viewer shell page with connect-src 'self'.
  await goto(owner.browser, `${env.serviceOrigin}/dashboard`);
  await inPage(owner.browser, pageCreatePasskey, { prf: true });
  const ownerKeys = await bootstrapOwner(env, owner, ownerCookie);
  const ownerFingerprint = await identityFingerprint(
    ownerKeys.identityId,
    env.owner
  );
  await goto(owner.browser, `${env.serviceOrigin}/dashboard`);
  const dashboardShowsIdentity = await poll(
    'the dashboard shell',
    25000,
    async () => {
      const ready = await owner.browser.evaluate<boolean>(
        `document.body.innerText.includes('Dashboard')`
      );
      return ready ? true : undefined;
    }
  ).then(async () =>
    owner.browser.evaluate<boolean>(
      `document.querySelector('[data-fingerprint="identity"]') !== null`
    )
  );
  if (!dashboardShowsIdentity) {
    env.defect(
      DEFECT_DASHBOARD_DETACHED,
      'the private-share sections never reach the page: renderDashboard calls document.body.replaceChildren(bar) (relic-viewer/src/main.ts:10081), which detaches #relic-root before mountPrivateDashboard appends to it (relic-viewer/src/private/reader.ts:957)'
    );
  }
  env.receipt(
    1,
    `PRIVATE_STEP_1_OWNER_IDENTITY fingerprint=${ownerFingerprint}`
  );

  // Step 2. Device: enroll through relic-mcp, approve, and type the owner fingerprint into relic-mcp.
  const enrolled = await callMcp(
    env.mcpCommand,
    env.scratchDir,
    env.statePath,
    env.serviceOrigin,
    'relic_enroll_device',
    {
      label: 'private-shares proof',
    }
  );
  const enrollmentId = stringAt(enrolled, 'enrollment_id', 'enrollment');
  const deviceDisplay = stringAt(enrolled, 'device_fingerprint', 'enrollment');
  if (dashboardShowsIdentity) {
    await goto(
      owner.browser,
      `${env.serviceOrigin}/dashboard?approve-device=${enrollmentId}`
    );
    await setField(
      owner.browser,
      '[data-device-fingerprint-input]',
      deviceDisplay
    );
    await click(owner.browser, '[data-action="approve-device"]');
  } else {
    await approveDeviceFromProcess(
      env,
      owner,
      ownerKeys,
      enrollmentId,
      deviceDisplay
    );
  }
  const refused = await callMcpRaw(env, 'relic_confirm_device', {
    owner_fingerprint: altered(ownerFingerprint),
  });
  assert.equal(
    refused.isError,
    true,
    'relic_confirm_device accepted a wrong owner fingerprint'
  );
  await callMcp(
    env.mcpCommand,
    env.scratchDir,
    env.statePath,
    env.serviceOrigin,
    'relic_confirm_device',
    {
      owner_fingerprint: ownerFingerprint,
    }
  );
  env.receipt(
    2,
    'PRIVATE_STEP_2_DEVICE_PINNED wrong_owner_fingerprint=refused'
  );

  // Step 3. Tap-free publish: no fragment, no key in the output, and the owner passkey is not used.
  const before = await signCountTotal(owner.browser);
  const published = await callMcp(
    env.mcpCommand,
    env.scratchDir,
    env.statePath,
    env.serviceOrigin,
    'relic_publish',
    {
      path: docPath,
      private: true,
    }
  );
  const after = await signCountTotal(owner.browser);
  const relicId = stringAt(published, 'relic_id', 'publish');
  const relicUrl = stringAt(published, 'url', 'publish');
  const local = await localPrivateState(env, relicId);
  const output = JSON.stringify(published);
  const keyInOutput = [local.publishToken, ...local.keys].some((secret) =>
    output.includes(secret)
  );
  const fragment = relicUrl.includes('#');
  await goto(owner.browser, relicUrl);
  await waitForState(owner.browser, ['unlock'], 'owner unlock');
  await click(owner.browser, '[data-action="private-unlock"]');
  await waitForOpened(owner.browser, 'owner');
  await checkReadyStrip(env, owner.browser);
  env.receipt(
    3,
    `PRIVATE_STEP_3_TAP_FREE_PUBLISH fragment=${fragment} key_in_output=${keyInOutput} owner_sign_count_delta=${after - before} owner_open=ok`
  );
  assert.equal(fragment, false, 'the private link carries a fragment');
  assert.equal(
    keyInOutput,
    false,
    'a key or the publish token reached the publish output'
  );
  assert.equal(after - before, 0, 'the MCP publish used the owner passkey');
  return { relicId, relicUrl, ownerKeys };
}

/** Third identity: a passkey made without PRF is offered a replacement first, then a PRF passkey makes the identity. */
interface ThirdEvidence {
  readonly offer: string;
  readonly postsBeforeReplacement: number;
}

async function setUpThird(
  env: PrivateShareEnv,
  third: Actor,
  relicUrl: string
): Promise<ThirdEvidence> {
  await viewerSignIn(env, third, relicUrl);
  await inPage(third.browser, pageCreatePasskey, { prf: false });
  await click(third.browser, '[data-action="private-setup"]');
  await waitForState(
    third.browser,
    ['replace-offer'],
    'third replacement offer'
  );
  const postsBeforeReplacement = third.identityPosts;
  await click(third.browser, '[data-action="private-replace-passkey"]');
  await waitForState(
    third.browser,
    ['request'],
    'third identity after replacement'
  );
  await identityOf(env, third);
  return { offer: 'replace_offered', postsBeforeReplacement };
}

interface ReaderIdentity {
  readonly identityId: string;
  readonly shown: string;
}

async function stepsFourAndFive(
  env: PrivateShareEnv,
  owner: Actor,
  reader: Actor,
  relicId: string,
  relicUrl: string,
  ownerKeys: OwnerKeys
): Promise<ReaderIdentity> {
  // Step 4. Reader asks: sign in, a PRF passkey, set up the key, request, read the fingerprint.
  await viewerSignIn(env, reader, relicUrl);
  await inPage(reader.browser, pageCreatePasskey, { prf: true });
  await click(reader.browser, '[data-action="private-setup"]');
  await waitForState(reader.browser, ['request'], 'reader request');
  const identity = await identityOf(env, reader);
  const mailMark = env.mailbox.mark();
  await click(reader.browser, '[data-action="private-request"]');
  await waitForState(reader.browser, ['requested'], 'reader requested');
  const shown = canonicalOf(
    await textOf(reader.browser, '[data-fingerprint="mine"]')
  );
  assert.equal(
    shown,
    await identityFingerprint(identity.identityId, env.reader),
    'the reader page shows a fingerprint other than the computed one'
  );
  const askMail = await env.mailbox.await(
    env.owner,
    mailMark,
    (m) => m.subject === 'Someone asked for access to a relic',
    'access request mail'
  );
  // The review link carries the relic id, as the plan's requestUrl requires. Naming the relic means its file name.
  const namesRelic = askMail.text.includes(FILE_NAME);
  const namesRequester = askMail.text.includes(env.reader);
  env.receipt(
    4,
    `PRIVATE_STEP_4_REQUESTED mail_names_relic=${namesRelic} mail_names_requester=${namesRequester}`
  );
  assert.equal(namesRelic, false, 'the request mail names the relic');
  assert.equal(namesRequester, false, 'the request mail names the requester');

  // Step 5. The owner types a wrong fingerprint: the page blocks the grant, and the service refuses a validly
  // signed grant carrying that fingerprint.
  await openPanel(owner, relicUrl);
  await owner.browser.waitForSelector(
    `article[data-request-identity="${identity.identityId}"]`,
    25000
  );
  const wrong = altered(shown);
  await typeFingerprint(owner, identity.identityId, wrong);
  const blocked = await grantState(owner, identity.identityId);
  assert.equal(
    blocked.disabled && blocked.state === 'mismatch',
    true,
    'the grant was not blocked for a wrong fingerprint'
  );
  const refused = await postGrant(env, owner, ownerKeys, {
    relicId,
    granteeEmail: env.reader,
    granteeIdentityId: identity.identityId,
    fingerprint: wrong,
    versions: [1],
  });
  assert.equal(
    refused.status,
    409,
    `expected 409 for a wrong fingerprint, got ${refused.status}`
  );
  assert.equal(
    problemCode(refused),
    'fingerprint_mismatch',
    'the refusal is not fingerprint_mismatch'
  );
  const store = env.store;
  const readerKemId = hexOf(await kemKeyIdOf(identity.kemPublicKey));
  const wraps = store
    ? (await store.listWraps(relicId)).filter(
        (w) => w.recipientKeyId === readerKemId
      ).length
    : undefined;
  env.receipt(
    5,
    `PRIVATE_STEP_5_WRONG_FINGERPRINT ui=blocked api=${refused.status} requester_wraps=${wraps ?? 'unobserved'}`
  );
  assert.equal(
    wraps ?? 0,
    0,
    'a wrap exists for the requester after a refused grant'
  );
  return { identityId: identity.identityId, shown };
}

async function stepSix(
  env: PrivateShareEnv,
  owner: Actor,
  third: Actor,
  relicId: string,
  reader: ReaderIdentity
): Promise<void> {
  // Step 6. Substitution: the stored request is replaced by the third identity's signed request. The owner types
  // the reader's true fingerprint, and the page blocks it. The stored rows are restored afterwards.
  const store = env.store;
  if (store === undefined)
    throw new Error('PRIVATE_STEP_6 needs the loopback store');
  const thirdIdentity = third.identityId;
  if (thirdIdentity === undefined)
    throw new Error('the third identity was not set up');
  await click(third.browser, '[data-action="private-request"]');
  await waitForState(third.browser, ['requested'], 'third requested');
  const rows = await store.listAccessRequests(relicId);
  const original = rows.find(
    (row) => row.requesterIdentityId === reader.identityId
  );
  const substitute = rows.find(
    (row) => row.requesterIdentityId === thirdIdentity
  );
  if (!original || !substitute)
    throw new Error('step 6 needs both stored requests');
  await store.deleteAccessRequestsForRelic(relicId);
  await store.putAccessRequest(substitute);
  try {
    const relicUrl = `${env.serviceOrigin}/${relicId}`;
    await openPanel(owner, relicUrl);
    await owner.browser.waitForSelector(
      `article[data-request-identity="${thirdIdentity}"]`,
      25000
    );
    await typeFingerprint(owner, thirdIdentity, reader.shown);
    const blocked = await grantState(owner, thirdIdentity);
    assert.equal(
      blocked.disabled && blocked.state === 'mismatch',
      true,
      'the grant was not blocked for a substituted key'
    );
    env.receipt(6, 'PRIVATE_STEP_6_SUBSTITUTED_KEY ui=blocked');
  } finally {
    await store.deleteAccessRequestsForRelic(relicId);
    await store.putAccessRequest(original);
    await store.putAccessRequest(substitute);
  }
}

async function stepSeven(
  env: PrivateShareEnv,
  owner: Actor,
  reader: Actor,
  relicId: string,
  relicUrl: string,
  readerIdentity: ReaderIdentity
): Promise<void> {
  // Step 7. The owner types the true fingerprint, picks versions, and taps once. The reader opens and comments.
  await openPanel(owner, relicUrl);
  await owner.browser.waitForSelector(
    `article[data-request-identity="${readerIdentity.identityId}"]`,
    25000
  );
  await typeFingerprint(owner, readerIdentity.identityId, readerIdentity.shown);
  await poll('grant enabled', 15000, async () => {
    const state = await grantState(owner, readerIdentity.identityId);
    return !state.disabled ? true : undefined;
  });
  await click(
    owner.browser,
    `article[data-request-identity="${readerIdentity.identityId}"] button[data-action="grant"]`
  );
  await poll('grant notice', 60000, async () => {
    const notice = await owner.browser.evaluate<string>(
      `document.getElementById('panel-notice')?.textContent ?? ''`
    );
    return notice.includes('can open') ? notice : undefined;
  });
  const grantMail = await env.mailbox.await(
    env.reader,
    0,
    (m) => m.subject === 'You have access to a relic',
    'grant mail'
  );
  assert.equal(
    grantMail.text.includes(FILE_NAME),
    false,
    'the grant mail names the relic'
  );
  await goto(reader.browser, relicUrl);
  await waitForState(reader.browser, ['unlock'], 'reader unlock');
  // The wrap is stored (see D3); the viewer refuses it because the seal does not list the reader.
  await click(reader.browser, '[data-action="private-unlock"]');
  const opened = await waitForOpened(reader.browser, 'reader').then(
    () => true,
    (error: unknown) => {
      env.defect(
        DEFECT_GRANT_UNOPENABLE,
        `a granted reader cannot open a version that was sealed before the grant: the grant wrap is stored (store: version 1 has a grant wrap for the reader key id), but the viewer requires the reader key id in the seal's recipient_key_ids (relic-viewer/src/private/open.ts:362-366), and the grant route writes the wrap without re-sealing (relic-server/src/private/relic.ts grantAccess). ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  );
  if (!opened) {
    const afterGrant = await callMcpRaw(env, 'relic_read_comments', {
      relic_id: relicId,
    });
    env.receipt(
      7,
      `PRIVATE_STEP_7_GRANTED reader_open=denied comment=not_run agent_read=${afterGrant.isError ? 'failed' : 'ok'}`
    );
    return;
  }
  await poll('comment composer', 25000, async () => {
    const present = await reader.browser.evaluate<boolean>(
      `!!document.querySelector('.compose-textarea')`
    );
    return present ? true : undefined;
  });
  await setField(reader.browser, '.compose-textarea', COMMENT_TEXT);
  await click(reader.browser, '.compose button[type="submit"]');
  const store = env.store;
  const stored = store
    ? await poll('reader comment stored', 25000, async () =>
        (await store.listComments(relicId)).length > 0 ? true : undefined
      )
    : false;
  const agent = await callMcpRaw(env, 'relic_read_comments', {
    relic_id: relicId,
  });
  assert.equal(
    agent.isError,
    false,
    `relic_read_comments failed: ${agent.text}`
  );
  const agentRead = (
    Array.isArray(agent.structured['comments'])
      ? agent.structured['comments']
      : []
  ).some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'body' in item &&
      item.body === COMMENT_TEXT
  );
  assert.equal(agentRead, true, 'the agent did not read the reader comment');
  env.receipt(
    7,
    `PRIVATE_STEP_7_GRANTED reader_open=ok comment=${stored ? 'ok' : 'unobserved'} agent_read=ok`
  );
}

/** Step 8 returns the version the revocation opened, which the later steps use. */
async function stepEight(
  env: PrivateShareEnv,
  owner: Actor,
  reader: Actor,
  relicId: string,
  relicUrl: string
): Promise<number> {
  const previous = await currentVersion(owner.browser, relicId);
  await openPanel(owner, relicUrl);
  await click(
    owner.browser,
    `button[data-action="revoke"][aria-label="Revoke ${env.reader}"]`
  );
  await owner.browser.waitForSelector('#revoke-dialog[open]', 25000);
  await click(owner.browser, '[data-action="confirm-revoke"]');
  await owner.browser.waitForSelector('#rekey[data-rekey-state="done"]', 90000);
  const version = await currentVersion(owner.browser, relicId);
  assert.ok(version > previous, 'the revocation did not open a new version');
  const store = env.store;
  const readerKemId = hexOf(await kemKeyIdOf(await readerKeyOf(env, reader)));
  const readerWraps = store
    ? (await store.listWraps(relicId)).filter(
        (w) => w.recipientKeyId === readerKemId
      ).length
    : undefined;
  const keyStatus = await pageStatus(
    reader.browser,
    'POST',
    `/api/relics/${relicId}/versions/${previous}/key`,
    '{}'
  );
  const mintStatus = await pageStatus(
    reader.browser,
    'POST',
    `/api/relics/${relicId}/mint`,
    JSON.stringify({ version: previous })
  );
  await goto(owner.browser, relicUrl);
  await waitForState(owner.browser, ['unlock'], 'owner unlock after revoke');
  await click(owner.browser, '[data-action="private-unlock"]');
  const ownerOpened = await waitForOpened(
    owner.browser,
    'owner after revoke'
  ).then(
    () => true,
    (error: unknown) => {
      env.defect(
        DEFECT_REPUBLISHED_UNOPENABLE,
        `the owner cannot open the version the revocation republished (version ${version}): the viewer shows the generic failure (relic-viewer/src/private/reader.ts:897). The service answers the key route with a wrap and the seal names the owner, and the mint and the download agree on length. ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  );
  const agent = await callMcpRaw(env, 'relic_read_comments', {
    relic_id: relicId,
  });
  env.receipt(
    8,
    `PRIVATE_STEP_8_REVOKED version=${version} revoked_wraps=${readerWraps ?? 'unobserved'} revoked_key_fetch=${keyStatus} revoked_mint=${mintStatus} owner_open=${ownerOpened ? 'ok' : 'failed'} agent_read=${agent.isError ? 'failed' : 'ok'}`
  );
  assert.equal(keyStatus, 403, `a revoked reader fetched a key (${keyStatus})`);
  assert.equal(mintStatus, 403, `a revoked reader minted (${mintStatus})`);
  assert.equal(readerWraps ?? 0, 0, 'the revoked reader still holds wraps');
  assert.equal(
    agent.isError,
    false,
    `relic_read_comments failed after revoke: ${agent.text}`
  );
  return version;
}

/** The reader's KEM public key, from the service, for store lookups. */
async function readerKeyOf(
  env: PrivateShareEnv,
  reader: Actor
): Promise<Uint8Array> {
  return (await identityOf(env, reader)).kemPublicKey;
}

async function stepNine(
  env: PrivateShareEnv,
  noPrf: Actor,
  third: ThirdEvidence,
  relicUrl: string
): Promise<void> {
  // Step 9. An authenticator without PRF is refused, and no identity is posted.
  await viewerSignIn(env, noPrf, relicUrl);
  await inPage(noPrf.browser, pageCreatePasskey, { prf: true });
  await click(noPrf.browser, '[data-action="private-setup"]');
  await waitForState(
    noPrf.browser,
    ['replace-offer'],
    'no-PRF replacement offer'
  );
  await click(noPrf.browser, '[data-action="private-replace-passkey"]');
  await waitForState(noPrf.browser, ['setup-refused'], 'no-PRF refusal');
  const store = env.store;
  const registered = store
    ? (await store.getIdentityForAddress(normalizeEmail(env.noPrf))) !==
      undefined
    : false;
  const posts = noPrf.identityPosts + third.postsBeforeReplacement;
  env.receipt(
    9,
    `PRIVATE_STEP_9_NO_PRF provider=refused credential_without_prf=${third.offer} identity_posts=${posts}`
  );
  assert.equal(
    registered,
    false,
    'a provider without PRF registered an identity'
  );
  assert.equal(posts, 0, 'an identity was posted before PRF was proven');
}

async function stepTen(
  env: PrivateShareEnv,
  relicId: string,
  relicUrl: string,
  docPath: string
): Promise<void> {
  // Step 10. Regulated profile: the service refuses a title, a cover and a lifetime over the maximum.
  const local = await localPrivateState(env, relicId);
  const title = await api(env, 'POST', `/api/relics/${relicId}/republish`, {
    body: {
      publish_token: local.publishToken,
      title: 'Not allowed',
      cover: false,
    },
  });
  const cover = await api(env, 'POST', `/api/relics/${relicId}/cover`, {
    body: { publish_token: local.publishToken },
  });
  const ttl = await callMcpRaw(env, 'relic_publish', {
    path: docPath,
    private: true,
    ttl_days: 366,
  });
  const shell = await (await fetch(relicUrl)).text();
  const shellTitleAbsent =
    !shell.includes(FILE_NAME) && shell.includes('data-relic-access="private"');
  const relicNotices = env.mailbox
    .all()
    .filter((mail) => RELIC_NOTICE_SUBJECTS.includes(mail.subject));
  const relicMail = relicNotices.filter(
    (mail) =>
      mail.text.includes(FILE_NAME) ||
      mail.text.includes(env.owner) ||
      mail.text.includes(env.reader)
  );
  const noticesGeneric = relicMail.length === 0;
  const ttlRefused = ttl.isError && ttl.text.length > 0;
  env.receipt(
    10,
    `PRIVATE_STEP_10_REGULATED title=${title.status} cover=${cover.status} ttl_over_max=${ttlRefused ? 400 : 'accepted'} shell_title=${shellTitleAbsent ? 'absent' : 'present'} notices_generic=${noticesGeneric}`
  );
  assert.equal(
    title.status,
    400,
    `a private republish accepted a title (${title.status})`
  );
  assert.equal(
    problemCode(title),
    'private_policy_violation',
    'the title refusal is not a policy violation'
  );
  assert.equal(
    cover.status,
    400,
    `a private relic accepted a cover (${cover.status})`
  );
  assert.equal(ttlRefused, true, 'a lifetime over the maximum was accepted');
  assert.equal(
    shellTitleAbsent,
    true,
    'the private shell names the relic or its file'
  );
  assert.equal(
    noticesGeneric,
    true,
    'a notification names the relic or its file'
  );
}

async function stepEleven(
  env: PrivateShareEnv,
  owner: Actor,
  relicId: string,
  relicUrl: string,
  version: number,
  ownerKeys: OwnerKeys
): Promise<void> {
  // Step 11. Owner hard delete of the whole relic, from the access panel.
  await openPanel(owner, relicUrl);
  await click(owner.browser, '[data-action="delete-relic"]');
  await owner.browser.waitForSelector('#delete-dialog[open]', 25000);
  await owner.browser.evaluate<void>(
    `document.querySelector('input[name="delete-scope"][value="all"]').click()`
  );
  await click(owner.browser, '[data-action="confirm-delete"]');
  await poll('delete settled', 60000, async () => {
    const closed = await owner.browser.evaluate<boolean>(
      `document.querySelector('#delete-dialog')?.open === false`
    );
    return closed ? true : undefined;
  });
  const store = env.store;
  if (store === undefined || env.storage === undefined) {
    env.receipt(11, 'PRIVATE_STEP_11_DELETED live=true');
    return;
  }
  const row = await store.getRelic(relicId);
  const stone = await store.getTombstone(relicId);
  const objects = (await env.storage.stat(relicId)) === undefined ? 0 : 1;
  const wraps = (await store.listWraps(relicId)).length;
  let seals = 0;
  for (let v = 1; v <= version; v++) {
    if ((await store.getSeal(relicId, v)) !== undefined) seals += 1;
  }
  const grants = (await store.listGrants(relicId)).length;
  const comments = (await store.listComments(relicId)).length;
  const events = (
    await store.listAccessEvents(ownerKeys.identityId, Date.now(), relicId)
  ).length;
  env.receipt(
    11,
    `PRIVATE_STEP_11_DELETED objects=${objects} wraps=${wraps} seals=${seals} grants=${grants} comments=${comments} row=${row === undefined ? 'absent' : 'present'} tombstone=${stone?.kind ?? 'none'} log_events=${events}`
  );
  assert.equal(
    objects + wraps + seals + grants + comments,
    0,
    'the delete left data behind'
  );
  assert.equal(row, undefined, 'the relic row survived the delete');
  assert.equal(stone?.kind, 'owner', 'the tombstone is not an owner tombstone');
}
