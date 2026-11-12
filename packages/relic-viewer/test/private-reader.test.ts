/**
 * The reader's protocol, against real WebCrypto and a service stand-in that
 * serves real seals, wraps and identity bundles.
 *
 * The transport and the authenticator are fakes; everything either side checks
 * is the real code. The fake authenticator answers each assertion with a PRF
 * output the test chose, and the fake service records every request body so
 * the test can prove no key material went out in one.
 */

import { describe, expect, test } from 'bun:test';

import { encryptRelic } from '@relic/format';
import {
  decodeBase64url,
  deriveKek,
  encodeBase64url,
  encryptIdentityBundle,
  generateIdentityKeys,
  identityIdOf,
  type IdentityKeys,
  kemKeyIdOf,
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
import { loadIdentityState, unlock } from '../src/private/keys.ts';
import { requestAccess } from '../src/private/request.ts';
import type { CredentialsLike } from '../src/passkey-common.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relik.test';
const FILES = 'https://files.test';
const NOW = Date.UTC(2026, 10, 11);
const KEY_BYTES = 16;

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
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** The credential the fake authenticator returns for one ceremony. */
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

/** The stand-in authenticator: every assertion answers with `credential()`. */
function authenticator(credential: () => Credential): CredentialsLike {
  return {
    get: async () => credential(),
    create: async () => {
      throw new Error('no creation in this test');
    },
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
  return { fetch, seen };
}

function depsFor(
  fetch: typeof globalThis.fetch,
  credentials: CredentialsLike
): ViewerDeps {
  return {
    serviceOrigin: ORIGIN,
    fetch,
    locationHref: `${ORIGIN}/r`,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
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
  readonly readerPasskey: ReaderPasskey;
  readonly routes: Record<string, Handler>;
  readonly digest: string;
}

interface WorldOptions {
  readonly owner?: IdentityKeys;
  readonly omitRecipient?: boolean;
  readonly tamperSeal?: boolean;
  readonly tamperCiphertext?: boolean;
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

  const sealStatement = {
    access_epoch: 0,
    at: NOW,
    ciphertext_sha256: digest,
    owner_epoch: 0,
    recipient_key_ids: options.omitRecipient ? [ownerKeyId] : [readerKeyId],
    relic_id: relicId,
    signer_id: ownerId,
    version: 1,
  };
  const signed = await signStatement(
    async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          owner.sig.privateKey,
          message
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

  const wrap = await wrapVersionKey({
    recipientPublicKey: reader.kemPublicKey,
    relicId,
    version: 1,
    key,
  });
  const keyResponse = {
    relic_id: relicId,
    version: 1,
    wrap: {
      recipient_key_id: wrap.recipientKeyId,
      version: 1,
      enc: wrap.enc,
      ct: wrap.ct,
    },
    seal: { statement: sealStatement, signature, signer_kind: 'identity' },
    signer: { kind: 'identity' },
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
      email: 'ada@example.com',
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
    'GET /api/identity': () => json(identityState),
    'POST /api/attest/nonce': () => json(nonceResponse(readerPasskey.rawId)),
    [`POST /api/relics/${relicId}/requests`]: () =>
      json({ status: 'pending', requested_at: '2026-11-11T00:00:00Z' }, 201),
    [`POST /api/relics/${relicId}/versions/1/key`]: () => json(keyResponse),
    [`POST /api/relics/${relicId}/mint`]: () =>
      json({
        url: `${FILES}/ct/${relicId}`,
        url_expires_at: '2026-11-11T01:00:00Z',
        relic_expires_at: null,
        object_length: ciphertext.length,
        object_crc32c: 'AAAAAA==',
        mints_remaining: 9,
        version: 1,
        current_version: 1,
      }),
    [`GET ${FILES}/ct/${relicId}`]: () => new Response(served),
  };
  return { relicId, plaintext, key, readerPasskey, routes, digest };
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

/** Deps for the reader of one sealed world, answering with that reader's passkey. */
function readerDeps(world: Sealed) {
  const { fetch, seen } = service(world.routes);
  const credentials = authenticator(() =>
    assertion(world.readerPasskey.rawId, world.readerPasskey.prf)
  );
  return { deps: depsFor(fetch, credentials), seen };
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

describe('the private reader opens a sealed version', () => {
  test('unlocks with one passkey tap and decrypts the exact content', async () => {
    const world = await sealedWorld('00000000000000000000000001');
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
    const world = await sealedWorld('00000000000000000000000002');
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    const fetched = await fetchVersionKey(deps, world.relicId, 1, identity);

    expect(Array.from(fetched.key)).toEqual(Array.from(world.key));
  });
});

describe('every request in the private flows is free of key material', () => {
  test('no body carries prf results, extension results or a key encoding', async () => {
    const world = await sealedWorld('00000000000000000000000003');
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
    const world = await sealedWorld('00000000000000000000000004', {
      tamperSeal: true,
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchAndDecryptVersion(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a ciphertext whose digest differs from the seal is refused', async () => {
    const world = await sealedWorld('00000000000000000000000005', {
      tamperCiphertext: true,
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchAndDecryptVersion(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(SealMismatchError);
  });

  test('a seal that does not name this reader is refused as a missing recipient', async () => {
    const world = await sealedWorld('00000000000000000000000006', {
      omitRecipient: true,
    });
    const { deps } = readerDeps(world);
    const identity = await unlock(deps, await loadIdentityState(deps));

    await expect(
      fetchVersionKey(deps, world.relicId, 1, identity)
    ).rejects.toBeInstanceOf(RecipientMissingError);
  });

  test('an owner whose key differs from the pinned one is refused', async () => {
    const relicId = '00000000000000000000000007';
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

describe('setup refuses a passkey that cannot hold a key', () => {
  test('without PRF output, setup offers a replacement and sends no identity', async () => {
    const { fetch, seen } = service({
      'POST /api/attest/nonce': () => json(nonceResponse(randomBytes(32))),
    });
    const deps = depsFor(
      fetch,
      authenticator(() => assertion(randomBytes(32), undefined))
    );

    const outcome = await setUpIdentity(deps, 'ada@example.com');

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
        outcome.identity.sigPublicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      ),
      await outcome.identity.sign(message),
      message
    );
    expect(verified).toBe(true);
  });
});
