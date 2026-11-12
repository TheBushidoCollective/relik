/**
 * Owner panel, rekey, delete and device approval. The DOM is a small stub,
 * the same as the other viewer tests run under Bun. The service is a fake
 * fetch. Key material is real: identities come from `generateIdentityKeys`,
 * so the signatures and wraps the browser makes are checked by the format
 * package's own verifiers and openers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnlockedIdentity } from '../src/private/keys.ts';
import type { PrivateKeyOps } from '../src/private/ops.ts';
import { typedFingerprint } from '../src/private/fingerprint-input.ts';
import { createRevokeDialog } from '../src/private/rekey.ts';
import {
  encodeBase64url,
  identityFingerprint,
  type GrantJSON,
  generateIdentityKeys,
  type IdentityKeys,
  identityIdOf,
  kemKeyIdOf,
  parseStatement,
  keyCommitment,
  type PrivateAccessJSON,
  statementBytes,
  signStatement,
  unwrapVersionKey,
  verifyStatement,
  deviceFingerprint,
  deviceIdOf,
} from '@relic/format/private';
import { openRelic, sha256Hex } from '@relic/format';

// ---------------------------------------------------------------------------
// A minimal DOM stub: elements, attributes, text, listeners and the compound
// selectors the owner surfaces use.
// ---------------------------------------------------------------------------

class StubText {
  constructor(readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type StubChild = StubElement | StubText;

class StubElement {
  readonly attributes = new Map<string, string>();
  readonly children: StubChild[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  open = false;
  value = '';
  checked = false;

  constructor(readonly tagName: string) {}

  get childNodes(): StubChild[] {
    return this.children;
  }
  get firstChild(): StubChild | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', value);
  }
  get dataset(): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [name, value] of this.attributes) {
      if (!name.startsWith('data-')) continue;
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      data[key] = value;
    }
    return data;
  }
  get classList(): { toggle(name: string, on?: boolean): void } {
    return {
      toggle: (name: string, on?: boolean) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const enable = on ?? !classes.has(name);
        if (enable) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: StubChild[]): void {
    for (const node of nodes) this.children.push(node);
  }
  replaceChildren(...nodes: StubChild[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }
  after(node: StubChild): void {
    this.append(node);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): StubElement[] {
    const found: StubElement[] = [];
    const walk = (node: StubElement): void => {
      for (const child of node.children) {
        if (child instanceof StubElement) {
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return found;
  }
}

/** Compound selectors only: tag, `#id`, `.class`, and `[attr]` or `[attr="value"]`. */
function matches(element: StubElement, selector: string): boolean {
  const pattern = /^([a-z]+)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
  const match = pattern.exec(selector);
  if (!match) throw new Error(`unsupported selector ${selector}`);
  const [, tag, rest = ''] = match;
  if (tag && element.tagName.toLowerCase() !== tag) return false;
  for (const part of rest.match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ??
    []) {
    if (part.startsWith('#')) {
      if (element.getAttribute('id') !== part.slice(1)) return false;
    } else if (part.startsWith('.')) {
      if (!element.className.split(/\s+/).includes(part.slice(1))) return false;
    } else {
      const [name, value] = part.slice(1, -1).split('=');
      const actual = element.getAttribute(name ?? '');
      if (actual === null) return false;
      if (value !== undefined && actual !== value.slice(1, -1)) return false;
    }
  }
  return true;
}

const stubDocument = {
  createElement: (tag: string) => new StubElement(tag),
  createElementNS: (_namespace: string, tag: string) => new StubElement(tag),
  createTextNode: (text: string) => new StubText(text),
};

// The owner surfaces read `document` when a test runs. The stub is installed
// for this file only, and removed after it, so no later file inherits it.
beforeAll(() => {
  Object.assign(globalThis, { document: stubDocument });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

/** The stub, as the element type the owner surfaces hand back to tests. */
function stubOf(node: unknown): StubElement {
  return node as StubElement;
}

// ---------------------------------------------------------------------------
// Fixtures: real identities, a fake keys module, and a fake service.
// ---------------------------------------------------------------------------

const RELIC_ID = '0123456789abcdefghjkmnpqrs';
const FP_EXPECTED = '7k2m9qxah3tb0p4dvw8cr1nezf6gy5sj';

interface Identity {
  readonly keys: IdentityKeys;
  readonly id: string;
  readonly kem: Uint8Array;
  readonly sig: Uint8Array;
}

async function identityOf(): Promise<Identity> {
  const keys = await generateIdentityKeys();
  return {
    keys,
    id: await identityIdOf(keys.kemPublicKey, keys.sigPublicKey),
    kem: keys.kemPublicKey,
    sig: keys.sigPublicKey,
  };
}

/** A WebCrypto-backed identity for the owner: ECDH for unwrap, ECDSA for signing. */
function unlockedFrom(
  identity: Identity,
  email: string,
  kemKeyId: Uint8Array
): UnlockedIdentity {
  const dh = async (peer: Uint8Array): Promise<Uint8Array> => {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(peer),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      identity.keys.kem.privateKey,
      256
    );
    return new Uint8Array(bits);
  };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        identity.keys.sig.privateKey,
        new Uint8Array(bytes)
      )
    );
  return {
    identityId: identity.id,
    email,
    kemPublicKey: identity.kem,
    sigPublicKey: identity.sig,
    kemKeyId,
    credentialId: 'cred',
    dh,
    sign,
  };
}

interface Attest {
  identity: UnlockedIdentity | undefined;
  content: Uint8Array;
}
const fixture: Attest = { identity: undefined, content: new Uint8Array() };

const stubKeys = {
  attest: async () => ({
    identity: fixture.identity,
    bundle: { nonce: 'n', statements: [], credential: {} },
  }),
  loadIdentityState: async () => {
    throw new Error('not used in the rekey test');
  },
  unlock: async () => {
    throw new Error('not used in the rekey test');
  },
  fetchVersionKey: async () => {
    throw new Error('not used in the rekey test');
  },
  fetchAndDecryptVersion: async () => ({
    envelope: {
      version: 1,
      entries: [
        {
          filename: 'notes.md',
          mimetype: 'text/markdown',
          offset: 0,
          length: fixture.content.length,
        },
      ],
    },
    content: fixture.content,
    digest: '',
  }),
} as unknown as PrivateKeyOps;

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly bytes?: Uint8Array;
}

/** A fake service: records every request and answers the republish routes. */
function fakeService(answers: {
  recipients: unknown;
  expiredFirstGrant?: boolean;
}) {
  const captured: Captured[] = [];
  const fetch = async (
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      captured.push({ method, url, body: null, bytes });
      return new Response(null, { status: 200 });
    }
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    captured.push({ method, url, body });
    if (url.endsWith('/revocations')) {
      return Response.json({
        revoked_identity_id: REVOKED.id,
        republish: {
          version: 3,
          upload_url: 'https://upload.example/object',
          upload_method: 'PUT',
          upload_headers: { 'content-type': 'application/octet-stream' },
          upload_expires_at: new Date(
            Date.now() + (answers.expiredFirstGrant ? -1000 : 600_000)
          ).toISOString(),
        },
        access_epoch: 4,
        owner_epoch: 2,
      });
    }
    if (url.endsWith('/recipients')) return Response.json(answers.recipients);
    if (url.endsWith('/upload-grant')) {
      return Response.json({
        upload_url: 'https://upload.example/object',
        upload_method: 'PUT',
        upload_headers: { 'content-type': 'application/octet-stream' },
        upload_expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (url.endsWith('/complete')) return Response.json({});
    return new Response('unexpected', { status: 500 });
  };
  return {
    captured,
    deps: {
      serviceOrigin: 'https://relik.example',
      fetch,
      privateKeys: stubKeys,
    } as never,
  };
}

let OWNER: Identity;
let OWNER_UNLOCKED: UnlockedIdentity;
let REVOKED: Identity;
let KEPT: Identity;
let grantA: GrantJSON;

beforeAll(async () => {
  OWNER = await identityOf();
  OWNER_UNLOCKED = unlockedFrom(
    OWNER,
    'sam@example.com',
    await kemKeyIdOf(OWNER.kem)
  );
  REVOKED = await identityOf();
  KEPT = await identityOf();
  const keptSig = KEPT.sig;
  const statement = {
    at: Date.now(),
    fingerprint_typed: await identityFingerprint(KEPT.id, 'ada@example.com'),
    grantee_email: 'ada@example.com',
    grantee_identity_id: KEPT.id,
    owner_identity_id: OWNER.id,
    relic_id: RELIC_ID,
    versions: [1, 2],
  };
  const checked = parseStatement('grant', statement);
  const signature = await signStatement(
    (bytes) => OWNER_UNLOCKED.sign(bytes),
    statementBytes('grant', checked)
  );
  grantA = {
    statement,
    identity_signature: signature,
    granted_at: new Date().toISOString(),
    revoked_at: null,
    grantee: {
      email: 'ada@example.com',
      identity: {
        identity_id: KEPT.id,
        email: 'ada@example.com',
        kem_public_key: encodeBase64url(KEPT.kem),
        sig_public_key: encodeBase64url(keptSig),
        created_at: new Date().toISOString(),
        retired_at: null,
      },
    },
  } as unknown as GrantJSON;
});

function accessAt(version: number): PrivateAccessJSON {
  return {
    access: 'private',
    relic_id: RELIC_ID,
    current_version: version,
    sealed_version: version,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    owner: null,
    recovery: null,
    me: {
      role: 'owner',
      identity: null,
      readable_versions: [1, 2],
      deleted_versions: [],
    },
  } as unknown as PrivateAccessJSON;
}

/** Yield one macrotask at a time until the condition holds. Event-driven, with no wall-clock wait; a stall fails by the test timeout. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('typed fingerprint', () => {
  test('a wrong value never matches, and folding makes the right one match', () => {
    const field = typedFingerprint({
      id: 'fp',
      label: 'Fingerprint',
      inputHook: 'data-fingerprint-input',
      placeholder: '',
      expected: FP_EXPECTED,
      who: 'ada@example.com',
    });
    const states: string[] = [];
    field.onChange((state) => states.push(state));

    field.set('');
    expect(field.state()).toBe('empty');
    expect(field.matched()).toBeUndefined();

    field.set('7k2m9qxah3tb0p4dvw8cr1nezf6gy5s'); // one short
    expect(field.state()).toBe('mismatch');
    expect(field.matched()).toBeUndefined();

    field.set('7k2m9qxah3tb0p4dvw8cr1nezf6gy5sk'); // one character wrong
    expect(field.state()).toBe('mismatch');
    expect(field.matched()).toBeUndefined();

    field.set('7K2M 9QXA-H3TB 0P4D VW8C R1NE ZF6G Y5SJ'); // whitespace, dashes and case do not matter
    expect(field.state()).toBe('match');
    expect(field.matched()).toBe(FP_EXPECTED);

    expect(states).toEqual(['empty', 'mismatch', 'mismatch', 'match']);
  });
});

describe('revoke dialog', () => {
  test('shows the warning and sends nothing until the confirm button is pressed', () => {
    const service = fakeService({ recipients: {} });
    const dialog = createRevokeDialog({
      relicId: RELIC_ID,
      deps: service.deps,
      onSettled: () => {},
    });
    dialog.open(
      { identityId: REVOKED.id, email: 'ben@example.org' },
      accessAt(2)
    );

    expect(dialog.element.open).toBe(true);
    const warning = stubOf(dialog.element).querySelector('#revoke-warning');
    expect(warning?.textContent).toContain('Revoke ben@example.org?');
    expect(warning?.textContent).toContain('republished as version 3');
    expect(service.captured).toHaveLength(0);
  });
});

describe('rekey after revocation', () => {
  test('wraps a fresh key only to the remaining readers and seals what was uploaded', async () => {
    fixture.identity = OWNER_UNLOCKED;
    fixture.content = new TextEncoder().encode(
      '# intake\nthe content the owner keeps'
    );
    const recipients = {
      access_epoch: 4,
      owner_epoch: 2,
      devices: [],
      grants: [grantA],
      recovery: null,
    };
    const service = fakeService({ recipients });
    const dialog = createRevokeDialog({
      relicId: RELIC_ID,
      deps: service.deps,
      onSettled: () => {},
    });
    dialog.open(
      { identityId: REVOKED.id, email: 'ben@example.org' },
      accessAt(2)
    );

    const confirm = stubOf(dialog.element).querySelector(
      '[data-action="confirm-revoke"]'
    );
    if (!confirm) throw new Error('no confirm button');
    confirm.dispatch('click');
    const rekey = stubOf(dialog.element).querySelector('#rekey');
    if (!rekey) throw new Error('no rekey panel');
    await waitUntil(() =>
      ['done', 'failed'].includes(rekey.getAttribute('data-rekey-state') ?? '')
    );
    const outcome = stubOf(dialog.element).querySelector('#rekey-outcome');
    expect(outcome?.textContent).toContain('Done.');

    const revocation = service.captured.find((c) =>
      c.url.endsWith('/revocations')
    );
    const upload = service.captured.find((c) => c.method === 'PUT');
    const complete = service.captured.find((c) => c.url.endsWith('/complete'));
    expect(revocation && upload && complete).toBeTruthy();
    if (!revocation || !upload || !complete || !upload.bytes)
      throw new Error('missing request');

    const revocationBody = revocation.body as Record<string, unknown>;
    expect(Object.keys(revocationBody).sort()).toEqual(
      [
        'attestation',
        'declared_ciphertext_bytes',
        'declared_size_bytes',
        'renderer_class',
      ].sort()
    );
    expect(upload.bytes.length).toBe(
      revocationBody.declared_ciphertext_bytes as number
    );

    const body = complete.body as {
      seal: { statement: Record<string, unknown>; signature: string };
      wraps: Array<{
        recipient_key_id: string;
        version: number;
        enc: string;
        ct: string;
      }>;
    };
    expect(body.seal.statement.ciphertext_sha256).toBe(sha256Hex(upload.bytes));
    expect(body.seal.statement.version).toBe(3);

    const sealOk = await verifyStatement(
      OWNER.sig,
      statementBytes('seal', parseStatement('seal', body.seal.statement)),
      body.seal.signature
    );
    expect(sealOk).toBe(true);

    const wrappedTo = body.wraps.map((wrap) => wrap.recipient_key_id).sort();
    const expectedRecipients = [
      Buffer.from(await kemKeyIdOf(OWNER.kem)).toString('hex'),
      Buffer.from(await kemKeyIdOf(KEPT.kem)).toString('hex'),
    ].sort();
    expect(wrappedTo).toEqual(expectedRecipients);
    expect(body.seal.statement.recipient_key_ids).toEqual(expectedRecipients);
    expect(wrappedTo).not.toContain(
      Buffer.from(await kemKeyIdOf(REVOKED.kem)).toString('hex')
    );

    const ownerHex = Buffer.from(await kemKeyIdOf(OWNER.kem)).toString('hex');
    const ownerWrap = body.wraps.find(
      (wrap) => wrap.recipient_key_id === ownerHex
    );
    if (!ownerWrap) throw new Error('owner was not wrapped');
    const key = await unwrapVersionKey({
      recipient: { publicKey: OWNER.kem, dh: OWNER_UNLOCKED.dh },
      relicId: RELIC_ID,
      version: 3,
      enc: ownerWrap.enc,
      ct: ownerWrap.ct,
    });
    const opened = await openRelic(upload.bytes, key);
    expect(new TextDecoder().decode(opened.content)).toBe(
      '# intake\nthe content the owner keeps'
    );
    expect(body.seal.statement.key_commitment).toBe(
      await keyCommitment({ relicId: RELIC_ID, version: 3, key })
    );

    for (const captured of service.captured) {
      const text = JSON.stringify(captured.body ?? '');
      expect(text).not.toContain(encodeBase64url(key));
      expect(text).not.toContain(Buffer.from(key).toString('hex'));
    }
  });
});

describe('device approval', () => {
  test('refuses a typed device fingerprint that does not match, and sends no approval', async () => {
    const device = await identityOf();
    const deviceId = await deviceIdOf(device.kem, device.sig);
    const requests: string[] = [];
    const deps = {
      serviceOrigin: 'https://relik.example',
      fetch: async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        return Response.json({
          status: 'pending',
          device_id: deviceId,
          label: 'relic-mcp on sam-mbp',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          kem_public_key: encodeBase64url(device.kem),
          sig_public_key: encodeBase64url(device.sig),
        });
      },
    };
    const { deviceApprovalSection } = await import('../src/private/devices.ts');
    const section = deviceApprovalSection('enrollment-1', {
      deps: deps as never,
      state: { identity: null, passkeys: [] } as never,
      onChanged: () => {},
    });
    await waitUntil(
      () =>
        stubOf(section).querySelector('[data-action="approve-device"]') !== null
    );
    const approve = stubOf(section).querySelector(
      '[data-action="approve-device"]'
    );
    const input = stubOf(section).querySelector(
      'input[data-device-fingerprint-input]'
    );
    if (!approve || !input) throw new Error('approval page did not render');
    expect(approve.disabled).toBe(true);

    const expected = await deviceFingerprint(deviceId);
    const wrong = `${expected.slice(0, 31)}${expected[31] === 'z' ? 'y' : 'z'}`;
    input.value = wrong;
    input.dispatch('input');
    expect(approve.disabled).toBe(true);
    expect(requests.some((line) => line.includes('/approve'))).toBe(false);
  });
});

describe('rekey with an expired upload grant', () => {
  test('re-issues the grant for the open version and never revokes again', async () => {
    fixture.identity = OWNER_UNLOCKED;
    fixture.content = new TextEncoder().encode(
      'content behind an expired grant'
    );
    const service = fakeService({
      recipients: {
        access_epoch: 4,
        owner_epoch: 2,
        devices: [],
        grants: [grantA],
        recovery: null,
      },
      expiredFirstGrant: true,
    });
    const dialog = createRevokeDialog({
      relicId: RELIC_ID,
      deps: service.deps,
      onSettled: () => {},
    });
    dialog.open(
      { identityId: REVOKED.id, email: 'ben@example.org' },
      accessAt(2)
    );

    stubOf(dialog.element)
      .querySelector('[data-action="confirm-revoke"]')
      ?.dispatch('click');
    const rekey = stubOf(dialog.element).querySelector('#rekey');
    if (!rekey) throw new Error('no rekey panel');
    await waitUntil(() =>
      ['done', 'failed'].includes(rekey.getAttribute('data-rekey-state') ?? '')
    );

    expect(
      stubOf(dialog.element).querySelector('#rekey-outcome')?.textContent
    ).toContain('Done.');
    const requests = service.captured.map(
      (c) => `${c.method} ${c.url.replace('https://relik.example', '')}`
    );
    expect(
      requests.filter((line) => line.includes('/revocations'))
    ).toHaveLength(1);
    expect(
      requests.filter((line) => line.includes('/upload-grant'))
    ).toHaveLength(1);
    expect(service.captured.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});
