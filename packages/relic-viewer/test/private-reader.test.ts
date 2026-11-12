/**
 * The private reader, against real WebCrypto and a service stand-in that
 * serves real seals, wraps and identity bundles.
 *
 * The transport and the authenticator are fakes; everything either side checks
 * is the real code. The DOM is a small stand-in that parses the reader's own
 * template and answers the selectors the reader uses. Every state in plan 4.15
 * is driven through its real controls, and the fake service records every
 * request body so the tests can prove no key material went out in one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encryptRelic } from '@relic/format';
import {
  decodeBase64url,
  deriveKek,
  deviceFingerprint,
  deviceIdOf,
  type DevicePublicJSON,
  encodeBase64url,
  encryptIdentityBundle,
  formatFingerprint,
  generateIdentityKeys,
  identityFingerprint,
  identityIdOf,
  type IdentityKeys,
  kemKeyIdOf,
  keyCommitment,
  signStatement,
  statementBytes,
  wrapVersionKey,
} from '@relic/format/private';
import { setUpIdentity } from '../src/private/identity.ts';
import {
  fetchAndDecryptVersion,
  fetchVersionKey,
  OwnerChangedError,
  RecipientMissingError,
  SealMismatchError,
} from '../src/private/open.ts';
import {
  mountPrivateDashboard,
  mountPrivateReader,
} from '../src/private/reader.ts';
import { loadIdentityState, unlock } from '../src/private/keys.ts';
import { requestAccess } from '../src/private/request.ts';
import type { CredentialsLike } from '../src/passkey-common.ts';
import type { DeadView, ReadyView, ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relik.test';
const FILES = 'https://files.test';
const USERCONTENT = 'https://usercontent.test';
const NOW = Date.UTC(2026, 10, 11);
const KEY_BYTES = 16;
const READER_EMAIL = 'ada@example.com';

/** A route handler: the request body in, the response out. */
type Handler = (body: unknown) => Response | Promise<Response>;

interface Recorded {
  readonly route: string;
  readonly text: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  );
}

/** Relic ids are 26 characters from the id alphabet; digits serve. */
let relicCounter = 100;
function freshRelicId(): string {
  relicCounter += 1;
  return String(relicCounter).padStart(26, '0');
}

/** The credential the fake authenticator returns for one assertion. */
function assertion(rawId: Uint8Array, prf: Uint8Array | undefined): Credential {
  return {
    id: encodeBase64url(rawId),
    rawId: buffer(rawId),
    type: 'public-key',
    response: {
      clientDataJSON: buffer(bytesOf('{"type":"webauthn.get"}')),
      authenticatorData: buffer(bytesOf('auth')),
      signature: buffer(bytesOf('sig')),
      userHandle: null,
    },
    getClientExtensionResults: () =>
      prf === undefined ? {} : { prf: { results: { first: buffer(prf) } } },
  } as unknown as Credential;
}

/** A registration the fake authenticator makes for the replacement passkey. */
function registration(): Credential {
  const rawId = randomBytes(32);
  return {
    id: encodeBase64url(rawId),
    rawId: buffer(rawId),
    type: 'public-key',
    response: {
      clientDataJSON: buffer(bytesOf('{"type":"webauthn.create"}')),
      attestationObject: buffer(bytesOf('attestation')),
      getTransports: () => ['internal'],
    },
  } as unknown as Credential;
}

/** The stand-in authenticator: assertions answer with `credential()`. */
function authenticator(
  credential: () => Credential,
  create: () => Credential = registration
): CredentialsLike {
  return {
    get: async () => credential(),
    create: async () => create(),
  };
}

/** The service stand-in: records each request and answers from a route table. */
function service(routes: Record<string, Handler>): {
  readonly fetch: typeof globalThis.fetch;
  readonly seen: Recorded[];
} {
  const seen: Recorded[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
    const route = `${method} ${path}`;
    const text = typeof init?.body === 'string' ? init.body : '';
    seen.push({ route, text });
    const handler = routes[route];
    if (handler === undefined) return new Response('no route', { status: 404 });
    return handler(text === '' ? undefined : JSON.parse(text));
  };
  return { fetch: Object.assign(fetch, { preconnect: () => {} }), seen };
}

function depsFor(
  fetch: typeof globalThis.fetch,
  credentials: CredentialsLike,
  keyVault: ViewerDeps['keyVault'] = {
    remember() {},
    recall: () => undefined,
    forget() {},
  }
): ViewerDeps {
  return {
    serviceOrigin: ORIGIN,
    fetch,
    locationHref: `${ORIGIN}/r`,
    keyVault,
    now: () => NOW,
    credentials,
  };
}

interface ReaderPasskey {
  readonly rawId: Uint8Array;
  readonly prf: Uint8Array;
}

interface Sealed {
  readonly relicId: string;
  readonly plaintext: Uint8Array;
  readonly key: Uint8Array;
  readonly owner: IdentityKeys;
  readonly ownerId: string;
  readonly reader: IdentityKeys;
  readonly readerId: string;
  readonly readerPasskey: ReaderPasskey;
  readonly routes: Record<string, Handler>;
  readonly digest: string;
}

interface WorldOptions {
  readonly owner?: IdentityKeys;
  /** The seal predates the grant: it lists the owner, and the wrap is still the reader's. */
  readonly sealPredatesGrant?: boolean;
  /** The version the seal and wrap are for. Defaults to 1. */
  readonly version?: number;
  /** The wrap is addressed to a key other than the reader's. */
  readonly wrapToOtherKey?: boolean;
  /** The wrap's ciphertext is altered, so it does not open. */
  readonly tamperWrap?: boolean;
  readonly tamperSeal?: boolean;
  readonly tamperCiphertext?: boolean;
  /** The wrap carries a key the service chose, not the one the owner sealed. */
  readonly substituteKey?: boolean;
  readonly role?: string;
  /** The seal is signed by a device the owner certified, not by the owner. */
  readonly device?: {
    readonly notAfter: number;
    readonly recordLabel?: string;
  };
}

/** A device the owner certified, and the record the service serves for it. */
async function deviceFor(
  owner: IdentityKeys,
  ownerId: string,
  options: { readonly notAfter: number; readonly recordLabel?: string }
): Promise<{
  readonly keys: IdentityKeys;
  readonly deviceId: string;
  readonly json: DevicePublicJSON;
}> {
  const keys = await generateIdentityKeys();
  const deviceId = await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const kem = encodeBase64url(keys.kemPublicKey);
  const sig = encodeBase64url(keys.sigPublicKey);
  const certStatement = {
    at: NOW,
    device_fingerprint_typed: await deviceFingerprint(deviceId),
    device_id: deviceId,
    kem_public_key: kem,
    label: 'laptop',
    not_after: options.notAfter,
    owner_identity_id: ownerId,
    sig_public_key: sig,
  };
  const certSignature = await signStatement(
    async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          owner.sig.privateKey,
          new Uint8Array(message)
        )
      ),
    statementBytes('device_cert', certStatement)
  );
  return {
    keys,
    deviceId,
    json: {
      device_id: deviceId,
      owner_identity_id: ownerId,
      kem_public_key: kem,
      sig_public_key: sig,
      label: options.recordLabel ?? 'laptop',
      backend: 'file',
      not_after: options.notAfter,
      certified_at: '2026-11-11T00:00:00Z',
      revoked_at: null,
      cert: { statement: certStatement, identity_signature: certSignature },
    },
  };
}

/**
 * One sealed version for one reader. The seal is signed by the owner, the wrap
 * is for the reader, and the reader's identity bundle sits under a KEK only the
 * reader's PRF output derives.
 */
async function sealedWorld(
  relicId: string,
  options: WorldOptions = {}
): Promise<Sealed> {
  const version = options.version ?? 1;
  const owner = options.owner ?? (await generateIdentityKeys());
  const ownerId = await identityIdOf(owner.kemPublicKey, owner.sigPublicKey);
  const reader = await generateIdentityKeys();
  const readerId = await identityIdOf(reader.kemPublicKey, reader.sigPublicKey);
  const readerKeyId = hex(await kemKeyIdOf(reader.kemPublicKey));
  const ownerKeyId = hex(await kemKeyIdOf(owner.kemPublicKey));
  const readerPasskey = { rawId: randomBytes(32), prf: randomBytes(32) };

  const plaintext = bytesOf('Intake form changes for January.');
  const key = randomBytes(KEY_BYTES);
  const ciphertext = await encryptRelic({
    content: plaintext,
    filename: 'intake.md',
    mimetype: 'text/markdown',
    key,
  });
  const served = options.tamperCiphertext
    ? Uint8Array.from(ciphertext, (byte, index) =>
        index === ciphertext.length - 1 ? byte ^ 1 : byte
      )
    : ciphertext;
  const digest = await sha256Hex(ciphertext);

  const device =
    options.device === undefined
      ? undefined
      : await deviceFor(owner, ownerId, options.device);
  const signer = device?.keys ?? owner;
  const sealStatement = {
    access_epoch: 0,
    at: NOW,
    ciphertext_sha256: digest,
    key_commitment: await keyCommitment({
      relicId,
      version,
      key,
    }),
    owner_epoch: 0,
    recipient_key_ids: options.sealPredatesGrant ? [ownerKeyId] : [readerKeyId],
    relic_id: relicId,
    signer_id: device?.deviceId ?? ownerId,
    version,
  };
  const signed = await signStatement(
    async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signer.sig.privateKey,
          new Uint8Array(message)
        )
      ),
    statementBytes('seal', sealStatement)
  );
  const signature = options.tamperSeal
    ? encodeBase64url(
        decodeBase64url(signed).map((byte, index) =>
          index === 0 ? byte ^ 0xff : byte
        )
      )
    : signed;

  const wrappedKey = options.substituteKey ? randomBytes(KEY_BYTES) : key;
  const wrapRecipient = options.wrapToOtherKey
    ? (await generateIdentityKeys()).kemPublicKey
    : reader.kemPublicKey;
  const wrap = await wrapVersionKey({
    recipientPublicKey: wrapRecipient,
    relicId,
    version,
    key: wrappedKey,
  });
  const wrapCt = options.tamperWrap
    ? encodeBase64url(
        decodeBase64url(wrap.ct).map((byte, index) =>
          index === 0 ? byte ^ 0xff : byte
        )
      )
    : wrap.ct;
  const keyResponse = {
    relic_id: relicId,
    version,
    wrap: {
      recipient_key_id: wrap.recipientKeyId,
      version,
      enc: wrap.enc,
      ct: wrapCt,
    },
    seal: {
      statement: sealStatement,
      signature,
      signer_kind: device === undefined ? 'identity' : 'device',
    },
    signer:
      device === undefined
        ? { kind: 'identity' }
        : { kind: 'device', device: device.json },
    owner: {
      email: 'sam@example.com',
      identity: {
        identity_id: ownerId,
        email: 'sam@example.com',
        kem_public_key: encodeBase64url(owner.kemPublicKey),
        sig_public_key: encodeBase64url(owner.sigPublicKey),
        created_at: '2026-11-01T00:00:00Z',
        retired_at: null,
      },
    },
  };

  const bundle = await encryptIdentityBundle(
    await deriveKek(readerPasskey.prf, readerPasskey.rawId),
    reader,
    readerPasskey.rawId
  );
  const identityState = {
    identity: {
      identity_id: readerId,
      email: READER_EMAIL,
      kem_public_key: encodeBase64url(reader.kemPublicKey),
      sig_public_key: encodeBase64url(reader.sigPublicKey),
      created_at: '2026-11-02T00:00:00Z',
      retired_at: null,
      credentials: [
        {
          credential_id: encodeBase64url(readerPasskey.rawId),
          encrypted_bundle: bundle,
          bound_at: '2026-11-02T00:00:00Z',
        },
      ],
      recovery: null,
      access_log_retention_days: 2190,
      recipients_epoch: 0,
    },
    passkeys: [
      { credential_id: encodeBase64url(readerPasskey.rawId), bound: true },
    ],
  };

  const routes: Record<string, Handler> = {
    'GET /api/auth/session': () => json({ email: READER_EMAIL }),
    'GET /api/identity/relics?coverage=1': () =>
      json({ owned: [], shared_with_me: [] }),
    'GET /api/devices': () => json({ devices: [] }),
    'GET /api/identity': () => json(identityState),
    'POST /api/attest/nonce': () => json(nonceResponse(readerPasskey.rawId)),
    [`GET /api/relics/${relicId}/access`]: () =>
      json(
        accessBody(
          relicId,
          options.role ?? 'grantee',
          ownerDigest(owner),
          version
        )
      ),
    [`POST /api/relics/${relicId}/requests`]: () =>
      json({ status: 'pending', requested_at: '2026-11-11T00:00:00Z' }, 201),
    [`POST /api/relics/${relicId}/versions/${version}/key`]: () =>
      json(keyResponse),
    [`POST /api/relics/${relicId}/mint`]: () =>
      json({
        url: `${FILES}/ct/${relicId}`,
        url_expires_at: '2026-11-11T01:00:00Z',
        relic_expires_at: null,
        object_length: ciphertext.length,
        object_crc32c: 'AAAAAA==',
        mints_remaining: 9,
        version,
        current_version: version,
      }),
    [`GET ${FILES}/ct/${relicId}`]: () => new Response(new Uint8Array(served)),
  };
  return {
    relicId,
    plaintext,
    key,
    owner,
    ownerId,
    reader,
    readerId,
    readerPasskey,
    routes,
    digest,
  };
}

/** A short fingerprint of the owner's keys, for the access body's owner party. */
function ownerDigest(owner: IdentityKeys): string {
  return encodeBase64url(owner.kemPublicKey.slice(0, 8));
}

/** The access the service reports for the reader. */
function accessBody(
  relicId: string,
  role: string,
  _owner: string,
  version: number
) {
  return {
    access: 'private',
    relic_id: relicId,
    current_version: version,
    sealed_version: version,
    expires_at: '2026-12-11T12:00:00Z',
    owner: { email: 'sam@example.com', identity: null },
    recovery: null,
    me: {
      role,
      identity: null,
      readable_versions:
        role === 'grantee' || role === 'owner' ? [version] : [],
      deleted_versions: [],
    },
  };
}

/** The nonce the service issues, naming the passkey the reader asserts with. */
function nonceResponse(rawId: Uint8Array) {
  return {
    nonce: encodeBase64url(randomBytes(32)),
    expires_at: '2026-11-11T00:05:00Z',
    public_key: {
      rpId: 'relik.test',
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [{ id: encodeBase64url(rawId), type: 'public-key' }],
    },
  };
}

/** Creation options for the replacement passkey, as the service issues them. */
function creationOptions() {
  return {
    public_key: {
      challenge: encodeBase64url(randomBytes(32)),
      rp: { id: 'relik.test', name: 'Relic' },
      user: {
        id: encodeBase64url(randomBytes(16)),
        name: READER_EMAIL,
        displayName: READER_EMAIL,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [],
      extensions: { prf: {} },
    },
  };
}

/** Deps for the reader of one sealed world, answering with that reader's passkey. */
function readerDeps(world: Sealed, keyVault?: ViewerDeps['keyVault']) {
  const { fetch, seen } = service(world.routes);
  const credentials = authenticator(() =>
    assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
  );
  return { deps: depsFor(fetch, credentials, keyVault), seen };
}

/** Every key and every string value a body carries, for the secrecy checks. */
function fieldsOf(
  value: unknown,
  into: { readonly keys: string[]; readonly strings: string[] }
): void {
  if (typeof value === 'string') {
    into.strings.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    into.keys.push(key);
    fieldsOf(nested, into);
  }
}

/* ---------- a stand-in DOM, for the reader's template and controls ---------- */

const VOID_TAGS: Record<string, true> = {
  input: true,
  br: true,
  img: true,
  hr: true,
  meta: true,
  link: true,
};

class TextNode {
  parentNode: El | null = null;
  constructor(readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeEvent {
  defaultPrevented = false;
  constructor(
    readonly type: string,
    readonly target: El
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Content = El | TextNode | string;

function toNode(content: Content): El | TextNode {
  return typeof content === 'string' ? new TextNode(content) : content;
}

function detach(node: El | TextNode): void {
  const parent = node.parentNode;
  if (parent === null) return;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentNode = null;
}

interface Compound {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attrs: readonly { readonly name: string; readonly value?: string }[];
}

interface Step {
  readonly combinator: ' ' | '>';
  readonly compound: Compound;
}

function parseCompound(text: string): Compound {
  const tag = /^[a-zA-Z][\w-]*/.exec(text)?.[0];
  const rest = tag === undefined ? text : text.slice(tag.length);
  let id: string | undefined;
  const classes: string[] = [];
  const attrs: { name: string; value?: string }[] = [];
  for (const match of rest.matchAll(
    /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g
  )) {
    if (match[1] !== undefined) id = match[1];
    else if (match[2] !== undefined) classes.push(match[2]);
    else if (match[3] !== undefined) {
      attrs.push(
        match[4] === undefined
          ? { name: match[3] }
          : { name: match[3], value: match[4] }
      );
    }
  }
  return {
    ...(tag === undefined ? {} : { tag: tag.toLowerCase() }),
    ...(id === undefined ? {} : { id }),
    classes,
    attrs,
  };
}

/** Compound selectors joined by descendant or child combinators, with `:scope`. */
function parseSelector(selector: string): Step[] {
  let text = selector.trim();
  if (text.startsWith(':scope')) text = text.slice(':scope'.length).trim();
  const steps: Step[] = [];
  let combinator: ' ' | '>' = ' ';
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    steps.push({ combinator, compound: parseCompound(token) });
    combinator = ' ';
  }
  return steps;
}

function matchesCompound(element: El, compound: Compound): boolean {
  if (
    compound.tag !== undefined &&
    element.tagName.toLowerCase() !== compound.tag
  ) {
    return false;
  }
  if (compound.id !== undefined && element.id !== compound.id) return false;
  const classes = element.className.split(/\s+/).filter(Boolean);
  if (!compound.classes.every((name) => classes.includes(name))) return false;
  return compound.attrs.every(
    (attr) =>
      element.attrs.has(attr.name) &&
      (attr.value === undefined || element.attrs.get(attr.name) === attr.value)
  );
}

function isWithin(element: El, root: El): boolean {
  for (let node = element.parentNode; node !== null; node = node.parentNode) {
    if (node === root) return true;
  }
  return false;
}

function matchesAt(
  element: El,
  steps: readonly Step[],
  index: number,
  root: El
): boolean {
  const step = steps[index];
  if (step === undefined || !matchesCompound(element, step.compound)) {
    return false;
  }
  if (index === 0) {
    return step.combinator === '>'
      ? element.parentNode === root
      : isWithin(element, root);
  }
  if (step.combinator === '>') {
    return (
      element.parentNode !== null &&
      matchesAt(element.parentNode, steps, index - 1, root)
    );
  }
  for (let node = element.parentNode; node !== null; node = node.parentNode) {
    if (matchesAt(node, steps, index - 1, root)) return true;
  }
  return false;
}

class El {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly childNodes: (El | TextNode)[] = [];
  parentNode: El | null = null;
  value = '';
  private readonly listeners = new Map<
    string,
    ((event: FakeEvent) => void)[]
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(value: string) {
    this.attrs.set('id', value);
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', value);
  }
  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  get disabled(): boolean {
    return this.attrs.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of this.attrs) {
      if (!name.startsWith('data-')) continue;
      out[
        name
          .slice('data-'.length)
          .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      ] = value;
    }
    return out;
  }
  get children(): El[] {
    return this.childNodes.filter((node): node is El => node instanceof El);
  }
  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren(value);
  }
  get innerHTML(): string {
    return '';
  }
  set innerHTML(html: string) {
    this.replaceChildren();
    parseInto(this, html);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(...nodes: Content[]): void {
    for (const node of nodes.map(toNode)) {
      detach(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  prepend(...nodes: Content[]): void {
    const created = nodes.map(toNode);
    for (const node of created) {
      detach(node);
      node.parentNode = this;
    }
    this.childNodes.unshift(...created);
  }
  replaceChildren(...nodes: Content[]): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }
  remove(): void {
    detach(this);
  }

  after(...nodes: Content[]): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const created = nodes.map(toNode);
    const index = parent.childNodes.indexOf(this);
    for (const node of created) {
      detach(node);
      node.parentNode = parent;
    }
    parent.childNodes.splice(index + 1, 0, ...created);
  }
  focus(): void {}
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  /** The class list, backed by the class attribute. */
  get classList(): {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  } {
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]): void => {
      this.className = list.join(' ');
    };
    return {
      add: (...add) => write([...new Set([...names(), ...add])]),
      remove: (...remove) =>
        write(names().filter((name) => !remove.includes(name))),
      toggle: (name, force) => {
        const present = names().includes(name);
        const want = force ?? !present;
        write(
          want
            ? [...new Set([...names(), name])]
            : names().filter((existing) => existing !== name)
        );
        return want;
      },
      contains: (name) => names().includes(name),
    };
  }
  /** A dialog's open state, as the attribute the browser reflects. */
  showModal(): void {
    this.attrs.set('open', '');
  }
  close(): void {
    this.attrs.delete('open');
  }
  removeEventListener(): void {}

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  /** Fires an event at this element, as a user action would. */
  dispatch(type: string): void {
    const event = new FakeEvent(type, this);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  querySelectorAll(selector: string): El[] {
    const steps = parseSelector(selector);
    const last = steps.length - 1;
    const found: El[] = [];
    const visit = (node: El): void => {
      for (const child of node.children) {
        if (matchesAt(child, steps, last, this)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Parses the reader's markup: elements, attributes and text, nothing more. */
function parseInto(root: El, html: string): void {
  const open: El[] = [root];
  for (const token of html.split(/(<[^>]+>)/)) {
    if (token === '') continue;
    const top = open[open.length - 1];
    if (top === undefined) break;
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim().toLowerCase();
      for (let index = open.length - 1; index > 0; index -= 1) {
        const candidate = open[index];
        if (candidate?.tagName.toLowerCase() === name) {
          open.length = index;
          break;
        }
      }
      continue;
    }
    if (token.startsWith('<')) {
      const match = /^<([a-zA-Z][\w-]*)([^>]*?)(\/?)>$/.exec(token);
      if (match === null) throw new Error(`unparsed tag ${token}`);
      const name = match[1] ?? '';
      const element = new El(name);
      for (const attr of (match[2] ?? '').matchAll(
        /([^\s=/]+)(?:="([^"]*)")?/g
      )) {
        element.attrs.set(attr[1] ?? '', attr[2] ?? '');
      }
      top.append(element);
      if (match[3] !== '/' && VOID_TAGS[name.toLowerCase()] === undefined) {
        open.push(element);
      }
      continue;
    }
    top.append(token);
  }
}

/** The stand-in page's body, held so a test can attach the shell root to it. */
let pageBody: El | undefined;

/** Installs the stand-in document for one test, and returns its body. */
function installDocument(): El {
  const body = new El('body');
  pageBody = body;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new El(tag),
      createElementNS: (_namespace: string, tag: string) => new El(tag),
      createTextNode: (text: string) => new TextNode(text),
      body,
      getElementById: (id: string) => body.querySelector(`#${id}`),
    },
  });
  return body;
}

// Async WebCrypto completes off the event loop and emits no event the reader
// could be awaited on, so a yield to the loop is the only signal available.
// This is the one real-time wait in these tests, named as the exception.
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Mounted {
  readonly root: El;
  readonly views: ReadyView[];
  readonly dead: DeadView[];
  /** A render of the same view, as a version switch or a comparison makes. */
  readonly reRender: () => void;
}

/** The stand-in page body, cleared for one mount. The reader resolves document.body after each render. */
function shellRootInPage(): El {
  if (pageBody === undefined) throw new Error('no stand-in page is installed');
  pageBody.replaceChildren();
  return pageBody;
}

/** Mounts the reader into a fresh root and waits for its first state. */
async function mountReader(
  deps: ViewerDeps,
  relicId: string
): Promise<Mounted> {
  const root = shellRootInPage();
  const views: ReadyView[] = [];
  const dead: DeadView[] = [];
  let afterRender: ((page: HTMLElement) => void) | undefined;
  // The stand-in renderer does what the viewer does: it replaces the shell
  // root's content with a taskbar, then hands the root to the reader's hook.
  const paint = (): void => {
    const bar = new El('header');
    bar.className = 'bar';
    root.replaceChildren(bar);
    afterRender?.(root as unknown as HTMLElement);
  };
  await mountPrivateReader({
    relicId,
    usercontentOrigin: USERCONTENT,
    deps,
    renderReady: (view, _relicId, _origin, _deps, hook) => {
      views.push(view);
      afterRender = hook;
      paint();
    },
    renderDead: (view) => {
      dead.push(view);
    },
  });
  return { root, views, dead, reRender: paint };
}

/** The stage the reader is showing, from its own state attribute. */
function stateOf(root: El): string | undefined {
  return root.querySelector('#relic-private')?.attrs.get('data-private-state');
}

function stageOf(root: El, name: string): El {
  const stage = root.querySelector(`#relic-private [data-for="${name}"]`);
  if (stage === null) throw new Error(`no stage ${name}`);
  return stage;
}

function visibleStages(root: El): string[] {
  return (root.querySelectorAll('#relic-private > [data-for]') ?? [])
    .filter((stage) => !stage.hidden)
    .map((stage) => stage.dataset['for'] ?? '');
}

function press(root: El, selector: string): void {
  const control = root.querySelector(selector);
  if (control === null) throw new Error(`no control ${selector}`);
  control.dispatch('click');
}

/** Reads a fingerprint's groups, one per span, as the reader laid them out. */
function groupsOf(element: El): string[] {
  return element.children.map((span) => span.textContent);
}

let storageWrites: string[] = [];

beforeEach(() => {
  installDocument();
  storageWrites = [];
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('the private reader opens a sealed version', () => {
  test('unlocks with one passkey tap and decrypts the exact content', async () => {
    const world = await sealedWorld(freshRelicId());
    const { deps } = readerDeps(world);

    const identity = await unlock(deps, await loadIdentityState(deps));
    const opened = await fetchAndDecryptVersion(
      deps,
      world.relicId,
      1,
      identity
    );

    expect(Array.from(opened.content)).toEqual(Array.from(world.plaintext));
    expect(opened.digest).toBe(world.digest);
  });

  test('the key fetched for the reader is the one that sealed the version', async () => {
    const world = await sealedWorld(freshRelicId());
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const fetched = await fetchVersionKey(deps, world.relicId, 1, identity);

    expect(Array.from(fetched.key)).toEqual(Array.from(world.key));
  });
});

describe('every request in the private flows is free of key material', () => {
  test('no body carries prf results, extension results or a key encoding', async () => {
    const world = await sealedWorld(freshRelicId());
    const { deps, seen } = readerDeps(world);

    const identity = await unlock(deps, await loadIdentityState(deps));
    await fetchAndDecryptVersion(deps, world.relicId, 1, identity);
    await requestAccess(deps, world.relicId);

    const bodies = seen.filter((entry) => entry.text !== '');
    expect(bodies.length).toBeGreaterThan(0);
    const forbidden = [
      encodeBase64url(world.key),
      hex(world.key),
      encodeBase64url(world.readerPasskey.prf),
      hex(world.readerPasskey.prf),
    ];
    for (const entry of bodies) {
      const into = { keys: [] as string[], strings: [] as string[] };
      fieldsOf(JSON.parse(entry.text), into);
      expect(into.keys).not.toContain('prf');
      expect(into.keys).not.toContain('clientExtensionResults');
      for (const text of [entry.text, ...into.strings]) {
        for (const secret of forbidden) {
          expect(text.includes(secret)).toBe(false);
        }
      }
    }
  });
});

describe('a version that does not verify is refused', () => {
  test('a tampered seal signature refuses before any content is decrypted', async () => {
    const world = await sealedWorld(freshRelicId(), { tamperSeal: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchAndDecryptVersion(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a ciphertext whose digest differs from the seal is refused', async () => {
    const world = await sealedWorld(freshRelicId(), { tamperCiphertext: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchAndDecryptVersion(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a grantee added after the version was sealed opens it: the seal lists only the owner', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { sealPredatesGrant: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const { key } = await fetchVersionKey(deps, relicId, 1, identity);
    expect(key).toEqual(world.key);
  });

  test('a wrap addressed to another key is refused as a missing recipient', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { wrapToOtherKey: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchVersionKey(deps, relicId, 1, identity)
    ).rejects.toBeInstanceOf(RecipientMissingError);
  });

  test('a wrap addressed to this reader that does not open is refused as a seal mismatch', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { tamperWrap: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchVersionKey(deps, relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a version sealed after a republish opens: its envelope carries the format version', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { version: 2 });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const opened = await fetchAndDecryptVersion(deps, relicId, 2, identity);
    expect(opened.content).toEqual(world.plaintext);
  });

  test('an owner whose key differs from the pinned one is refused', async () => {
    const relicId = freshRelicId();
    const first = await sealedWorld(relicId);
    const firstReader = readerDeps(first);
    const identity = await unlock(
      firstReader.deps,
      await loadIdentityState(firstReader.deps)
    );
    await fetchVersionKey(firstReader.deps, relicId, 1, identity);

    const replacement = await sealedWorld(relicId);
    const { fetch } = service(replacement.routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(first.readerPasskey.rawId, first.readerPasskey.prf)
      )
    );

    await expect(
      fetchVersionKey(deps, relicId, 1, identity)
    ).rejects.toBeInstanceOf(OwnerChangedError);
  });
});

describe('a device signer is checked against its certificate', () => {
  test('a certificate that expired before the seal was made is refused', async () => {
    const world = await sealedWorld(freshRelicId(), {
      device: { notAfter: NOW - 1 },
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchVersionKey(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a device record whose label differs from its certificate is refused', async () => {
    const world = await sealedWorld(freshRelicId(), {
      device: { notAfter: NOW + 86_400_000, recordLabel: 'phone' },
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchVersionKey(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a device certified past the seal time opens the version it sealed', async () => {
    const world = await sealedWorld(freshRelicId(), {
      device: { notAfter: NOW + 86_400_000 },
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const fetched = await fetchVersionKey(deps, world.relicId, 1, identity);

    expect(Array.from(fetched.key)).toEqual(Array.from(world.key));
  });
});

describe('the dashboard shows the identity fingerprint only from an unlocked key', () => {
  test('the identity card waits for one passkey tap, then shows the fingerprint of the unlocked key', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { fetch } = service(world.routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
      )
    );
    const root = shellRootInPage();
    await mountPrivateDashboard(deps);
    await until(
      () =>
        root.querySelector('#private-dashboard [data-private-dashboard]') !==
        null,
      'the private dashboard'
    );

    expect(
      root.querySelector('[data-fingerprint="identity"]')?.textContent ?? ''
    ).toBe('');
    press(root, '[data-reveal-fingerprint="identity"]');
    await until(
      () =>
        (root.querySelector('[data-fingerprint="identity"]')?.textContent ??
          '') !== '',
      'the fingerprint after one tap'
    );
    const shown = root.querySelector('[data-fingerprint="identity"]');
    if (shown === null) throw new Error('no identity fingerprint');
    expect(groupsOf(shown)).toEqual(
      formatFingerprint(
        await identityFingerprint(world.readerId, READER_EMAIL)
      ).split(' ')
    );
  });
});

describe('setup refuses a passkey that cannot hold a key', () => {
  test('without PRF output, setup offers a replacement and sends no identity', async () => {
    const { fetch, seen } = service({
      'POST /api/attest/nonce': () => json(nonceResponse(randomBytes(32))),
    });
    const deps = depsFor(
      fetch,
      authenticator(() => assertion(randomBytes(32), undefined))
    );

    const outcome = await setUpIdentity(deps, READER_EMAIL);

    expect(outcome.kind).toBe('replace-offer');
    expect(seen.map((entry) => entry.route)).not.toContain(
      'POST /api/identity'
    );
  });

  test('with PRF output, setup registers an identity whose key signs', async () => {
    const rawId = randomBytes(32);
    const prf = randomBytes(32);
    const { fetch, seen } = service({
      'POST /api/attest/nonce': () => json(nonceResponse(rawId)),
      'POST /api/identity': () => json({ identity: {} }, 201),
    });
    const deps = depsFor(
      fetch,
      authenticator(() => assertion(rawId, prf))
    );

    const outcome = await setUpIdentity(deps, 'Ada@Example.com');
    if (outcome.kind !== 'ready') throw new Error(`setup: ${outcome.kind}`);

    expect(seen.map((entry) => entry.route)).toContain('POST /api/identity');
    const message = bytesOf('signed by the new identity');
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await crypto.subtle.importKey(
        'raw',
        new Uint8Array(outcome.identity.sigPublicKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      ),
      new Uint8Array(await outcome.identity.sign(message)),
      new Uint8Array(message)
    );
    expect(verified).toBe(true);
  });
});

describe('the reader drives every state of plan 4.15', () => {
  test('signin: an anonymous visitor sees the sign-in stage and nothing else', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { fetch } = service({
      ...world.routes,
      'GET /api/auth/session': () => json({ email: null }),
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    expect(stateOf(root)).toBe('signin');
    expect(visibleStages(root)).toEqual(['signin']);
    expect(stageOf(root, 'signin').querySelector('h1')?.textContent).toBe(
      'This relic is private'
    );
  });

  test('signin to setup: asking for a code reveals the entry, and the code signs the reader in', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    let signedIn = false;
    const requests: string[] = [];
    const { fetch } = service({
      ...world.routes,
      'GET /api/auth/session': () =>
        json({ email: signedIn ? READER_EMAIL : null }),
      'GET /api/identity': () => json({ identity: null, passkeys: [] }),
      'POST /api/auth/request': (body) => {
        requests.push(JSON.stringify(body));
        return new Response(null, { status: 202 });
      },
      'POST /api/auth/code': () => {
        signedIn = true;
        return json({ email: READER_EMAIL });
      },
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    const codeForm = root.querySelector('#signin-code-form');
    expect(codeForm?.hidden).toBe(true);
    const emailInput = root.querySelector('#signin-email');
    if (emailInput === null) throw new Error('no email input');
    emailInput.value = READER_EMAIL;
    root.querySelector('#signin-email-form')?.dispatch('submit');
    await until(() => codeForm?.hidden === false, 'the code form');
    expect(requests).toEqual([
      JSON.stringify({ email: READER_EMAIL, relic_id: relicId }),
    ]);

    const codeInput = root.querySelector('#signin-code');
    if (codeInput === null) throw new Error('no code input');
    codeInput.value = '402817';
    root.querySelector('#signin-code-form')?.dispatch('submit');
    await until(() => stateOf(root) === 'setup', 'setup after sign-in');
    expect(
      stageOf(root, 'setup').querySelector('.card-meta')?.textContent
    ).toBe(`Signed in as ${READER_EMAIL}`);
  });

  test('setup: a verified session with no identity lands on the setup stage', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { fetch } = service({
      ...world.routes,
      'GET /api/identity': () => json({ identity: null, passkeys: [] }),
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    expect(stateOf(root)).toBe('setup');
    expect(
      stageOf(root, 'setup').querySelectorAll('.card-body p')[1]?.textContent
    ).toBe('Setting it up takes one tap.');
  });

  test('setup to replace-offer: a passkey without PRF offers a replacement, with the load-bearing copy', async () => {
    const relicId = freshRelicId();
    const { fetch } = service({
      'GET /api/auth/session': () => json({ email: READER_EMAIL }),
      'GET /api/identity': () => json({ identity: null, passkeys: [] }),
      'POST /api/attest/nonce': () => json(nonceResponse(randomBytes(32))),
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    press(root, '[data-action="private-setup"]');
    await until(() => stateOf(root) === 'replace-offer', 'the replace offer');
    expect(
      stageOf(root, 'replace-offer').querySelector('.load-bearing')?.textContent
    ).toBe(
      "This passkey was made before private shares existed and can't hold your key. Make a replacement passkey on this device?"
    );
  });

  test('replace-offer to setup-refused: a replacement that still cannot hold a key is refused and registers nothing', async () => {
    const relicId = freshRelicId();
    const seen: string[] = [];
    const { fetch } = service({
      'GET /api/auth/session': () => json({ email: READER_EMAIL }),
      'GET /api/identity': () => json({ identity: null, passkeys: [] }),
      'POST /api/attest/nonce': () => json(nonceResponse(randomBytes(32))),
      'POST /api/auth/passkeys/options': () => json(creationOptions()),
      'POST /api/auth/passkeys': () => {
        seen.push('passkeys');
        return json({ credential_id: 'created' }, 201);
      },
      'POST /api/identity': () => {
        seen.push('identity');
        return json({ identity: {} }, 201);
      },
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    press(root, '[data-action="private-setup"]');
    await until(() => stateOf(root) === 'replace-offer', 'the replace offer');
    press(root, '[data-action="private-replace-passkey"]');
    await until(() => stateOf(root) === 'setup-refused', 'the refusal');

    expect(
      stageOf(root, 'setup-refused').querySelector('.load-bearing')?.textContent
    ).toBe(
      "Your passkey provider can't hold a private-share key. Private relics need a provider or security key that supports the WebAuthn PRF extension."
    );
    expect(seen).toEqual(['passkeys']);
  });

  test('replace-offer, not now: declining the replacement shows the refusal without registering', async () => {
    const relicId = freshRelicId();
    const { fetch } = service({
      'GET /api/auth/session': () => json({ email: READER_EMAIL }),
      'GET /api/identity': () => json({ identity: null, passkeys: [] }),
      'POST /api/attest/nonce': () => json(nonceResponse(randomBytes(32))),
    });
    const { root } = await mountReader(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      relicId
    );

    press(root, '[data-action="private-setup"]');
    await until(() => stateOf(root) === 'replace-offer', 'the replace offer');
    press(root, '#replace-not-now');
    expect(stateOf(root)).toBe('setup-refused');
  });

  test('request: a signed-in reader with no request yet is offered the request', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'none' });
    const { deps } = readerDeps(world);
    const { root } = await mountReader(deps, relicId);

    expect(stateOf(root)).toBe('request');
    expect(stageOf(root, 'request').querySelector('h1')?.textContent).toBe(
      'Ask the owner for access'
    );
  });

  test('request to requested: the request shows the locally computed 32-character fingerprint', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'none' });
    const { deps, seen } = readerDeps(world);
    const { root } = await mountReader(deps, relicId);

    press(root, '[data-action="private-request"]');
    await until(() => stateOf(root) === 'requested', 'the requested state');

    const expected = formatFingerprint(
      await identityFingerprint(world.readerId, READER_EMAIL)
    );
    const mine = stageOf(root, 'requested').querySelector(
      '[data-fingerprint="mine"]'
    );
    if (mine === null) throw new Error('no fingerprint');
    expect(groupsOf(mine)).toEqual(expected.split(' '));
    expect(groupsOf(mine).join('')).toHaveLength(32);
    expect(
      stageOf(root, 'requested').querySelector('[data-request-note]')
        ?.textContent
    ).toBe(
      `When the owner lets you in, Relic emails ${READER_EMAIL}. Open that link and confirm with your passkey.`
    );
    expect(seen.map((entry) => entry.route)).toContain(
      `POST /api/relics/${relicId}/requests`
    );
  });

  test('requested: a reader whose request is already pending sees the same fingerprint', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'requested' });
    const { deps } = readerDeps(world);
    const { root } = await mountReader(deps, relicId);

    await until(
      () => stateOf(root) === 'requested-locked',
      'the locked pending request'
    );
    press(root, '[data-action="private-unlock-requested"]');
    await until(() => stateOf(root) === 'requested', 'the fingerprint');
    const mine = stageOf(root, 'requested').querySelector(
      '[data-fingerprint="mine"]'
    );
    if (mine === null) throw new Error('no fingerprint');
    expect(groupsOf(mine)).toEqual(
      formatFingerprint(
        await identityFingerprint(world.readerId, READER_EMAIL)
      ).split(' ')
    );
  });

  test('requested on reload waits for one passkey tap before any fingerprint is shown', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'requested' });
    const { root } = await mountReader(readerDeps(world).deps, relicId);

    await until(
      () => stateOf(root) === 'requested-locked',
      'the locked pending request'
    );
    expect(
      stageOf(root, 'requested').querySelector('[data-fingerprint="mine"]')
        ?.textContent ?? ''
    ).toBe('');
  });

  test('requested on reload never shows a fingerprint for an identity id the service substituted', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'requested' });
    const attacker = await generateIdentityKeys();
    const attackerId = await identityIdOf(
      attacker.kemPublicKey,
      attacker.sigPublicKey
    );
    const original = world.routes['GET /api/identity'];
    if (original === undefined) throw new Error('no identity route');
    world.routes['GET /api/identity'] = async (body) => {
      const state = await (await original(body)).json();
      state.identity.identity_id = attackerId;
      return json(state);
    };
    const { root } = await mountReader(readerDeps(world).deps, relicId);

    await until(
      () => ['requested', 'requested-locked'].includes(stateOf(root) ?? ''),
      'the pending request'
    );
    expect(
      stageOf(root, 'requested').querySelector('[data-fingerprint="mine"]')
        ?.textContent ?? ''
    ).toBe('');
  });

  test('declined: the owner declined stays declined', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'declined' });
    const { root } = await mountReader(readerDeps(world).deps, relicId);

    expect(stateOf(root)).toBe('declined');
    expect(stageOf(root, 'declined').querySelector('h1')?.textContent).toBe(
      'The owner declined your request'
    );
  });

  test('revoked: a removed reader is told the access was removed', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'revoked' });
    const { root } = await mountReader(readerDeps(world).deps, relicId);

    expect(stateOf(root)).toBe('revoked');
    expect(stageOf(root, 'revoked').querySelector('h1')?.textContent).toBe(
      'Your access was removed'
    );
  });

  test('unlock to ready: unlocking opens the sealed version, mounts the relic, and pins the strip', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { deps } = readerDeps(world);
    const { root, views } = await mountReader(deps, relicId);

    expect(stateOf(root)).toBe('unlock');
    expect(
      stageOf(root, 'unlock').querySelector('[data-expiry]')?.textContent
    ).toBe(`Signed in as ${READER_EMAIL} · expires 11 Dec 2026`);

    press(root, '[data-action="private-unlock"]');
    await until(() => views.length === 1, 'the ready view');

    const view = views[0];
    if (view === undefined) throw new Error('no view');
    expect(view.access).toBe('private');
    expect(view.filename).toBe('intake.md');
    expect(view.versionDigest).toBe(world.digest);
    expect(view.shareUrl.includes('#')).toBe(false);
    expect(root.querySelector('#relic-private')).toBeNull();
    // The mock places the strip under the taskbar, so the bar comes first.
    expect(root.children[0]?.className).toBe('bar');
    expect(root.children[1]?.className).toBe('private-strip');
    expect(root.querySelector('#strip-who')?.textContent).toBe(
      'Private. Shared by sam@example.com. Expires 11 Dec 2026.'
    );
    expect(Array.from((await view.keyFor?.(1)) ?? [])).toEqual(
      Array.from(world.key)
    );
  });

  test('unlock to denied: a wrap addressed to another key is refused, and the switch returns to sign-in', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { wrapToOtherKey: true });
    const { root, views } = await mountReader(readerDeps(world).deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => stateOf(root) === 'denied', 'the denied state');
    expect(views).toHaveLength(0);
    expect(stageOf(root, 'denied').querySelector('h1')?.textContent).toBe(
      "You don't have access to this relic"
    );

    press(root, '#denied-switch');
    expect(stateOf(root)).toBe('signin');
  });

  test('unlock to seal-mismatch: a tampered seal shows the mismatch copy and no relic', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { tamperSeal: true });
    const { root, views } = await mountReader(readerDeps(world).deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => stateOf(root) === 'seal-mismatch', 'seal-mismatch');
    expect(views).toHaveLength(0);
    expect(
      stageOf(root, 'seal-mismatch').querySelector('[data-version-meta]')
        ?.textContent
    ).toBe(`Version 1 · Signed in as ${READER_EMAIL}`);
    expect(
      stageOf(root, 'seal-mismatch').querySelector('.load-bearing')?.textContent
    ).toBe(
      "This version doesn't match the owner's signature. Relic won't show it."
    );
  });

  test('unlock to owner-changed: a different owner key for a pinned relic shows both fingerprints', async () => {
    const relicId = freshRelicId();
    const first = await sealedWorld(relicId);
    const opened = await mountReader(readerDeps(first).deps, relicId);
    press(opened.root, '[data-action="private-unlock"]');
    await until(() => opened.views.length === 1, 'the first open');

    const replaced = await sealedWorld(relicId);
    const { root, views } = await mountReader(
      readerDeps(replaced).deps,
      relicId
    );
    press(root, '[data-action="private-unlock"]');
    await until(() => stateOf(root) === 'owner-changed', 'owner-changed');
    expect(views).toHaveLength(0);

    const stage = stageOf(root, 'owner-changed');
    const firstSeen = stage.querySelector('[data-fingerprint="first-seen"]');
    const reported = stage.querySelector('[data-fingerprint="reported"]');
    if (firstSeen === null || reported === null)
      throw new Error('no fingerprints');
    expect(groupsOf(firstSeen)).toEqual(
      formatFingerprint(
        await identityFingerprint(first.ownerId, 'sam@example.com')
      ).split(' ')
    );
    expect(groupsOf(reported)).toEqual(
      formatFingerprint(
        await identityFingerprint(replaced.ownerId, 'sam@example.com')
      ).split(' ')
    );
    expect(stage.querySelector('.load-bearing')?.textContent).toBe(
      "The owner's key for this relic isn't the one you saw when you first opened it. Relic won't open it. Contact the person who shared it."
    );
  });
});

describe('private keys never enter the vault or storage', () => {
  test('an open writes no vault entry, and nothing written to storage carries a key or the bundle', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const remembered: unknown[] = [];
    const written: string[] = [];
    const keyVault = {
      remember: (...args: unknown[]) => {
        remembered.push(args);
      },
      recall: () => undefined,
      forget() {},
    };
    const { fetch } = service(world.routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
      ),
      keyVault
    );
    const storage = {
      getItem: () => null,
      setItem: (key: string, value: string) => {
        written.push(key, value);
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      const { root, views } = await mountReader(deps, relicId);
      press(root, '[data-action="private-unlock"]');
      await until(() => views.length === 1, 'the ready view');
      const view = views[0];
      if (view === undefined) throw new Error('no view');
      await view.keyFor?.(1);
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }

    expect(remembered).toEqual([]);
    const bundleSecret = await crypto.subtle.exportKey(
      'jwk',
      world.reader.sig.privateKey
    );
    const secrets = [
      encodeBase64url(world.key),
      hex(world.key),
      encodeBase64url(world.readerPasskey.prf),
      hex(world.readerPasskey.prf),
      bundleSecret.d ?? '',
    ].filter((secret) => secret.length > 0);
    for (const text of written) {
      for (const secret of secrets) {
        expect(text.includes(secret)).toBe(false);
      }
    }
    storageWrites = written;
    expect(storageWrites.length).toBeGreaterThan(0);
  });
});

/** Requests the service lists for the relic, for the owner's Access count. */
function requestsBody(statuses: readonly string[]) {
  return {
    requests: statuses.map((status, index) => ({
      requester: { email: `reader${index}@example.com`, identity: null },
      requested_at: '2026-11-11T00:00:00Z',
      status,
      statement: {},
      identity_signature: 'sig',
    })),
  };
}

describe('the owner surfaces are mounted from the reader, lazily', () => {
  test('an owner sees the Access control with the pending count, and it opens the panel', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'owner' });
    const routes = {
      ...world.routes,
      [`GET /api/relics/${relicId}/requests`]: () =>
        json(requestsBody(['pending', 'pending', 'granted'])),
    };
    const { fetch } = service(routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
      )
    );
    const { root, views } = await mountReader(deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => views.length === 1, 'the ready view');
    await until(
      () => root.querySelector('[data-action="open-access-panel"]') !== null,
      'the Access control'
    );
    const access = root.querySelector('[data-action="open-access-panel"]');
    expect(access?.attrs.get('aria-controls')).toBe('access-panel');
    await until(
      () => root.querySelector('#request-count')?.textContent === '2',
      'the pending count'
    );

    press(root, '[data-action="open-access-panel"]');
    await until(
      () => root.querySelector('#access-panel') !== null,
      'the access panel'
    );
    expect(root.querySelector('#access-panel')?.attrs.get('role')).toBe(
      'dialog'
    );
  });

  test('a version switch keeps the strip and the owner Access control, and the control still opens the panel', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'owner' });
    const routes = {
      ...world.routes,
      [`GET /api/relics/${relicId}/requests`]: () =>
        json(requestsBody(['pending', 'pending', 'granted'])),
    };
    const { fetch } = service(routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
      )
    );
    const { root, views, reRender } = await mountReader(deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => views.length === 1, 'the ready view');
    await until(
      () => root.querySelector('[data-action="open-access-panel"]') !== null,
      'the Access control'
    );

    reRender();

    expect(root.querySelector('#ready-strip')).not.toBeNull();
    await until(
      () => root.querySelector('#request-count')?.textContent === '2',
      'the pending count after the switch'
    );
    press(root, '[data-action="open-access-panel"]');
    await until(
      () => root.querySelector('#access-panel') !== null,
      'the access panel after the switch'
    );
  });

  test('a reader keeps the private strip through a version switch', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { root, views, reRender } = await mountReader(
      readerDeps(world).deps,
      relicId
    );

    press(root, '[data-action="private-unlock"]');
    await until(() => views.length === 1, 'the ready view');
    expect(root.querySelector('#ready-strip')).not.toBeNull();

    reRender();

    expect(root.querySelector('#ready-strip')).not.toBeNull();
    expect(root.querySelector('#access-panel')).toBeNull();
  });

  test('a reader who is not the owner gets no Access control and no panel', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'grantee' });
    const { root, views } = await mountReader(readerDeps(world).deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => views.length === 1, 'the ready view');
    expect(root.querySelector('[data-action="open-access-panel"]')).toBeNull();
    expect(root.querySelector('#access-panel')).toBeNull();
  });

  test('the request mail link opens the owner panel straight from the unlock stage', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { role: 'owner' });
    const { fetch } = service(world.routes);
    const deps = {
      ...depsFor(
        fetch,
        authenticator(() =>
          assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
        )
      ),
      locationHref: `${ORIGIN}/r/${relicId}?access=requests`,
    };
    const { root, views } = await mountReader(deps, relicId);

    expect(stateOf(root)).toBe('unlock');
    await until(
      () => root.querySelector('#access-panel') !== null,
      'the access panel from the mail link'
    );
    expect(views).toHaveLength(0);
  });

  test('a signed-in visitor gets the private dashboard sections', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { fetch, seen } = service(world.routes);
    const deps = depsFor(
      fetch,
      authenticator(() =>
        assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
      )
    );
    const root = shellRootInPage();

    await mountPrivateDashboard(deps);

    await until(
      () =>
        root.querySelector('#private-dashboard [data-private-dashboard]') !==
        null,
      'the private dashboard'
    );
    expect(seen.map((entry) => entry.route)).toContain('GET /api/identity');
  });

  test('a signed-out visitor gets no private dashboard and no identity request', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const routes = {
      ...world.routes,
      'GET /api/auth/session': () => json({ email: null }),
    };
    const { fetch, seen } = service(routes);
    const root = shellRootInPage();

    await mountPrivateDashboard(
      depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      )
    );

    expect(root.querySelector('#private-dashboard')).toBeNull();
    expect(seen.map((entry) => entry.route)).not.toContain('GET /api/identity');
  });

  test('the approval link opens the device approval section for the signed-in owner', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const enrollmentId = '01hh0m7x6ytcxbk2ckvd9p9w5a';
    const routes = {
      ...world.routes,
      [`GET /api/devices/enrollments/${enrollmentId}`]: () =>
        json({
          status: 'pending',
          device_id: 'd'.repeat(64),
          label: 'Ada laptop',
          expires_at: '2026-11-11T01:00:00Z',
        }),
      'GET /api/devices': () => json({ devices: [] }),
    };
    const { fetch } = service(routes);
    const deps = {
      ...depsFor(
        fetch,
        authenticator(() =>
          assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
        )
      ),
      locationHref: `${ORIGIN}/dashboard?approve-device=${enrollmentId}`,
    };
    const root = shellRootInPage();

    await mountPrivateDashboard(deps);
    await until(
      () =>
        root.querySelector(`[data-device-approval="${enrollmentId}"]`) !== null,
      'the device approval section'
    );
  });

  test('the approval link does nothing for a signed-out visitor', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const routes = {
      ...world.routes,
      'GET /api/auth/session': () => json({ email: null }),
    };
    const { fetch, seen } = service(routes);
    const deps = {
      ...depsFor(
        fetch,
        authenticator(() => assertion(randomBytes(32), undefined))
      ),
      locationHref: `${ORIGIN}/dashboard?approve-device=01hh0m7x6ytcxbk2ckvd9p9w5a`,
    };
    const root = shellRootInPage();

    await mountPrivateDashboard(deps);
    expect(root.querySelector('[data-device-approval]')).toBeNull();
    expect(seen.map((entry) => entry.route)).not.toContain('GET /api/identity');
  });
});
describe('a version key the seal does not commit to is refused before use', () => {
  test('the key fetch and the content open both refuse a wrap of a substituted key', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { substituteKey: true });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(fetchVersionKey(deps, relicId, 1, identity)).rejects.toThrow(
      'key_commitment'
    );
    await expect(
      fetchAndDecryptVersion(deps, relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a reader shows the mismatch copy and no relic when the service substitutes the key', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId, { substituteKey: true });
    const { root, views } = await mountReader(readerDeps(world).deps, relicId);

    press(root, '[data-action="private-unlock"]');
    await until(() => stateOf(root) === 'seal-mismatch', 'seal-mismatch');
    expect(views).toHaveLength(0);
  });

  test('the same seal opens with the key it commits to', async () => {
    const relicId = freshRelicId();
    const world = await sealedWorld(relicId);
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const { key } = await fetchVersionKey(deps, relicId, 1, identity);
    expect(Array.from(key)).toEqual(Array.from(world.key));
  });
});
