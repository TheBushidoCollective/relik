import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  attestationChallenge,
  decodeBase64url,
  kemKeyIdOf,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  generateInviteKeyPair,
  identityFingerprint,
  identityIdOf,
  inviteIdOf,
  keyCommitment,
  signStatement,
  statementBytes,
  wrapVersionKey,
  deviceFingerprint,
  type IdentityKeys,
} from '@relic/format/private';
import { encryptedSize, type RequestOptionsJSON } from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import type { OutboundMail } from '../src/mail.ts';
import type { Mailer } from '../src/app.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import { DAY, NOW, RELIC_ID } from './private-fixtures.ts';

type FakeAuthenticator = Awaited<ReturnType<typeof fakeAuthenticator>>;

const ORIGIN = 'https://relic.example';
const RP = 'relic.example';
const PRF_FIRST = Buffer.from('relic/identity-prf/v1').toString('base64url');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

let now = NOW;
let app: RelicApp;
let store: MemoryStore;
let storage: MemoryStorage;
let sent: { to: string; mail: OutboundMail }[];

const mailer: Mailer = {
  async sendMail(to: string, mail: OutboundMail) {
    sent.push({ to, mail });
  },
} as unknown as Mailer;

beforeEach(() => {
  now = NOW;
  store = new MemoryStore();
  storage = new MemoryStorage();
  sent = [];
  app = build();
});

function build(config: Record<string, unknown> = {}): RelicApp {
  return createApp({
    store,
    storage,
    now: () => now,
    mailer,
    config,
  } as Parameters<typeof createApp>[0]);
}

interface Person {
  readonly email: string;
  readonly auth: FakeAuthenticator;
  readonly cookie: string;
  keys?: IdentityKeys;
  identityId?: string;
}

async function person(email: string): Promise<Person> {
  const auth = await fakeAuthenticator({ hasPrf: true });
  await auth.register(
    {
      challenge: encodeBase64url(randomBytes(32)),
      rp: { id: RP, name: 'Relik' },
      user: { id: 'dXNlcg', name: email, displayName: email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      extensions: { prf: {} },
    } as never,
    ORIGIN
  );
  await store.createPasskeys({
    email,
    userHandle: 'dXNlcg',
    credentials: [
      {
        credentialId: auth.credentialId,
        publicKeyJwk: auth.publicJwk,
        alg: -7,
        signCount: 0,
        createdAt: now,
      },
    ],
  });
  const token = encodeBase64url(randomBytes(32));
  await store.putSession({
    tokenHash: hex(new Uint8Array(createHash('sha256').update(token).digest())),
    email,
    createdAt: now,
    expiresAt: now + 30 * DAY,
    via: 'passkey',
  });
  return { email, auth, cookie: `relic_session=${token}` };
}

function post(
  body: unknown,
  cookie?: string
): RequestInit & { cookie?: string } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function send(
  path: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', '198.51.100.30, 130.211.0.1');
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  const response = await app.fetch(
    new Request(`https://relic.example${path}`, { ...init, headers })
  );
  const text = await response.text();
  return {
    status: response.status,
    body:
      text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function signer(keys: IdentityKeys) {
  return (bytes: Uint8Array) =>
    crypto.subtle
      .sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.sig.privateKey,
        bytes as BufferSource
      )
      .then((sig) => new Uint8Array(sig));
}

async function registerIdentity(who: Person): Promise<void> {
  const keys = await generateIdentityKeys();
  who.keys = keys;
  who.identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const statement = {
    at: now,
    email: who.email,
    identity_id: who.identityId,
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    replaces: null,
    sig_public_key: encodeBase64url(keys.sigPublicKey),
  };
  const attestation = await attest(who, 'identity_register', undefined, [
    { kind: 'identity_register', statement, sign: false },
  ]);
  const response = await send(
    '/api/identity',
    post(
      {
        attestation,
        encrypted_bundle: encodeBase64url(randomBytes(64)),
        replace: false,
      },
      who.cookie
    )
  );
  expect(response.status).toBe(201);
}

async function attest(
  who: Person,
  purpose: string,
  relicId: string | undefined,
  statements: {
    kind: string;
    statement: Record<string, unknown>;
    sign?: boolean;
  }[]
): Promise<Record<string, unknown>> {
  const nonceResponse = await send(
    '/api/attest/nonce',
    post(
      relicId === undefined ? { purpose } : { purpose, relic_id: relicId },
      who.cookie
    )
  );
  expect(nonceResponse.status).toBe(200);
  const nonce = nonceResponse.body['nonce'] as string;
  const bytes = statements.map((s) =>
    statementBytes(s.kind as never, s.statement as never)
  );
  const challenge = encodeBase64url(
    await attestationChallenge(decodeBase64url(nonce), bytes)
  );
  const credential = await who.auth.assert(
    {
      challenge,
      rpId: RP,
      timeout: 300_000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: who.auth.credentialId }],
      extensions: { prf: { eval: { first: PRF_FIRST } } },
    } as RequestOptionsJSON,
    ORIGIN
  );
  const signed = [];
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i] as (typeof statements)[number];
    signed.push({
      kind: s.kind,
      statement: s.statement,
      identity_signature: await signStatement(
        signer(who.keys as IdentityKeys),
        bytes[i] as Uint8Array
      ),
    });
  }
  const { clientExtensionResults: _prfOutput, ...wire } =
    credential as unknown as Record<string, unknown>;
  return { nonce, statements: signed, credential: wire };
}

/** A device that seals the relic at version 1, with the owner as a recipient. */
async function sealedPrivateRelic(
  owner: Person
): Promise<{ versionKey: Uint8Array }> {
  const deviceKeys = await generateIdentityKeys();
  const deviceId = await deviceIdOf(
    deviceKeys.kemPublicKey,
    deviceKeys.sigPublicKey
  );
  const label = 'laptop';
  const proofStatement = { at: now, device_id: deviceId, label };
  const enrolled = await send(
    '/api/devices/enrollments',
    post({
      kem_public_key: encodeBase64url(deviceKeys.kemPublicKey),
      sig_public_key: encodeBase64url(deviceKeys.sigPublicKey),
      label,
      backend: 'file',
      proof: {
        statement: proofStatement,
        signature: await signStatement(
          signer(deviceKeys),
          statementBytes('device_enroll', proofStatement as never)
        ),
      },
    })
  );
  expect(enrolled.status).toBe(201);
  const certStatement = {
    at: now,
    device_fingerprint_typed: await deviceFingerprint(deviceId),
    device_id: deviceId,
    kem_public_key: encodeBase64url(deviceKeys.kemPublicKey),
    label,
    not_after: now + 365 * DAY,
    owner_identity_id: owner.identityId,
    sig_public_key: encodeBase64url(deviceKeys.sigPublicKey),
  };
  const approved = await send(
    `/api/devices/enrollments/${String(enrolled.body['enrollment_id'])}/approve`,
    post(
      {
        attestation: await attest(owner, 'device_approve', undefined, [
          { kind: 'device_cert', statement: certStatement },
        ]),
      },
      owner.cookie
    )
  );
  expect(approved.status).toBe(200);

  const content = randomBytes(64);
  const challenge = await send('/api/challenge', { method: 'POST' });
  const nonce = challenge.body['challenge_nonce'] as string;
  const granted = await send(
    '/api/grant',
    post({
      challenge_nonce: nonce,
      relic_id: RELIC_ID,
      renderer_class: 'markdown',
      publishing_client: 'relic-test/1',
      access: 'private',
      declared_size_bytes: content.byteLength,
      declared_ciphertext_bytes: encryptedSize(content.byteLength),
      device_auth: {
        device_id: deviceId,
        nonce,
        at: now,
        signature: await signStatement(
          signer(deviceKeys),
          statementBytes('private_publish', {
            at: now,
            challenge_nonce: nonce,
            device_id: deviceId,
            relic_id: RELIC_ID,
            ttl_days: null,
          } as never)
        ),
      },
    })
  );
  expect(granted.status).toBe(200);
  storage.put(RELIC_ID, content);
  const digest = hex(
    new Uint8Array(createHash('sha256').update(content).digest())
  );
  const versionKey = randomBytes(16);
  const ownerRecord = await store.getIdentity(owner.identityId as string);
  const sealStatement = {
    access_epoch: 0,
    at: now,
    ciphertext_sha256: digest,
    key_commitment: await keyCommitment({
      relicId: RELIC_ID,
      version: 1,
      key: versionKey,
    }),
    owner_epoch: ownerRecord!.recipientsEpoch,
    recipient_key_ids: [
      ownerRecord!.kemKeyId,
      hex(await kemKeyIdOf(deviceKeys.kemPublicKey)),
    ].sort(),
    relic_id: RELIC_ID,
    signer_id: deviceId,
    version: 1,
  };
  const sealed = await send(
    `/api/relics/${RELIC_ID}/complete`,
    post({
      seal: {
        statement: sealStatement,
        signature: await signStatement(
          signer(deviceKeys),
          statementBytes('seal', sealStatement as never)
        ),
        signer_kind: 'device',
      },
      wraps: [
        await wrap(owner.keys!.kemPublicKey, versionKey, 1),
        await wrap(deviceKeys.kemPublicKey, versionKey, 1),
      ],
    })
  );
  expect(sealed.status).toBe(200);
  return { versionKey };
}

async function wrap(
  kemPublicKey: Uint8Array,
  key: Uint8Array,
  version: number
) {
  const w = await wrapVersionKey({
    recipientPublicKey: kemPublicKey,
    relicId: RELIC_ID,
    version,
    key,
  });
  return { recipient_key_id: w.recipientKeyId, version, enc: w.enc, ct: w.ct };
}

/** One `invite` statement the owner signs, and the invitation's own key pair. */
async function inviteFor(
  owner: Person,
  email: string,
  versions: number[],
  options: { expiresAt?: number } = {}
) {
  const pair = await generateInviteKeyPair();
  return {
    pair,
    statement: {
      kind: 'invite',
      statement: {
        at: now,
        expires_at: options.expiresAt ?? now + 7 * DAY,
        invite_public_key: encodeBase64url(pair.publicKey),
        invited_email: email,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
        versions,
      },
    },
  };
}

async function grantStatementFor(
  owner: Person,
  reader: Person,
  versions: number[]
) {
  return {
    kind: 'grant',
    statement: {
      at: now,
      fingerprint_typed: await identityFingerprint(
        reader.identityId as string,
        reader.email
      ),
      grantee_email: reader.email,
      grantee_identity_id: reader.identityId,
      owner_identity_id: owner.identityId,
      relic_id: RELIC_ID,
      versions,
    },
  };
}

async function recipientsOf(owner: Person) {
  return send(`/api/relics/${RELIC_ID}/recipients`, post({}, owner.cookie));
}

describe('invitation creation (plan 3.3 B)', () => {
  test('a mixed batch of one grant and two invitations returns 201 with their rows, wraps and notices', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const first = await inviteFor(owner, 'ada@example.com', [1]);
    const second = await inviteFor(owner, 'grace@example.com', [1]);
    const readerGrant = await grantStatementFor(owner, reader, [1]);
    const attestation = await attest(owner, 'grant', RELIC_ID, [
      readerGrant,
      first.statement,
      second.statement,
    ]);
    const response = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation,
          wraps: [
            await wrap(reader.keys!.kemPublicKey, versionKey, 1),
            await wrap(first.pair.publicKey, versionKey, 1),
            await wrap(second.pair.publicKey, versionKey, 1),
          ],
        },
        owner.cookie
      )
    );
    expect(response.status).toBe(201);
    expect((response.body['grants'] as unknown[]).length).toBe(1);
    const invites = response.body['invites'] as {
      invite_id: string;
      invited_email: string;
    }[];
    expect(invites.map((i) => i.invited_email).sort()).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
    for (const invite of invites) {
      const row = await store.getInvite(RELIC_ID, invite.invite_id);
      expect(row?.status).toBe('open');
      expect(row?.wraps).toHaveLength(1);
      expect(row?.expiresAt).toBe(now + 7 * DAY);
    }
    expect(
      await store.getInvite(RELIC_ID, await inviteIdOf(first.pair.publicKey))
    ).toBeDefined();
    // The seal's two wraps and the grant's one. Invitation wraps live in their rows.
    expect(await store.listWraps(RELIC_ID)).toHaveLength(3);

    const notices = sent.filter((m) => m.mail.subject.includes('invited you'));
    expect(notices.map((m) => m.to).sort()).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
    for (const notice of notices) {
      expect(notice.mail.text).toContain(owner.email);
      expect(notice.mail.text).not.toContain('http');
      expect(notice.mail.text).not.toContain('reader@example.com');
    }
    const events = await store.listAccessEvents(
      owner.identityId as string,
      now,
      RELIC_ID
    );
    expect(
      events
        .filter((e) => e.kind === 'invite')
        .map((e) => e.subjectEmail)
        .sort()
    ).toEqual(['ada@example.com', 'grace@example.com']);
  });

  test('an invitation to an address that already has an identity is refused with identity_exists, after the lookup budget is charged', async () => {
    app = build({ identityLookupRateLimit: { limit: 1, windowSeconds: 3600 } });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const registered = await person('registered@example.com');
    await registerIdentity(registered);
    const invite = await inviteFor(owner, registered.email, [1]);
    const response = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [
            invite.statement,
          ]),
          wraps: [await wrap(invite.pair.publicKey, randomBytes(16), 1)],
        },
        owner.cookie
      )
    );
    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('identity_exists');
    expect(response.body['email']).toBe(registered.email);
    expect(await store.listInvites(RELIC_ID)).toHaveLength(0);

    const lookup = await send(
      `/api/relics/${RELIC_ID}/grants/lookup`,
      post({ emails: ['another@example.com'] }, owner.cookie)
    );
    expect(lookup.status).toBe(429);
    expect(lookup.body['code']).toBe('private_rate_limited');
  });

  test('invitation lifetimes outside 1 to 30 days, or past the relic, are refused as expires_at', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    for (const expiresAt of [now + 31 * DAY, now + DAY / 2]) {
      const invite = await inviteFor(owner, 'late@example.com', [1], {
        expiresAt,
      });
      const response = await send(
        `/api/relics/${RELIC_ID}/grants`,
        post(
          {
            attestation: await attest(owner, 'grant', RELIC_ID, [
              invite.statement,
            ]),
            wraps: [await wrap(invite.pair.publicKey, randomBytes(16), 1)],
          },
          owner.cookie
        )
      );
      expect(response.status).toBe(400);
      expect(response.body['code']).toBe('invalid_statement');
      expect(response.body['statement_check']).toBe('expires_at');
    }
    expect(await store.listInvites(RELIC_ID)).toHaveLength(0);
  });

  test('a batch that omits an invitation wrap is refused as invalid_wrap and writes nothing', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invite = await inviteFor(owner, 'ada@example.com', [1]);
    const response = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [
            invite.statement,
          ]),
          wraps: [],
        },
        owner.cookie
      )
    );
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('invalid_wrap');
    expect(await store.listInvites(RELIC_ID)).toHaveLength(0);
    expect(versionKey.length).toBeGreaterThan(0);
  });

  test('the open-invitation cap refuses the batch that would pass it with invitation_limit_reached', async () => {
    app = build({ privateInvitesMaxOpen: 1 });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const one = await inviteFor(owner, 'one@example.com', [1]);
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(
            {
              attestation: await attest(owner, 'grant', RELIC_ID, [
                one.statement,
              ]),
              wraps: [await wrap(one.pair.publicKey, randomBytes(16), 1)],
            },
            owner.cookie
          )
        )
      ).status
    ).toBe(201);
    const two = await inviteFor(owner, 'two@example.com', [1]);
    const refused = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [two.statement]),
          wraps: [await wrap(two.pair.publicKey, randomBytes(16), 1)],
        },
        owner.cookie
      )
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('invite_limit_reached');
  });

  test('invitations leave /recipients exactly as it was', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const before = await recipientsOf(owner);
    const invite = await inviteFor(owner, 'ada@example.com', [1]);
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(
            {
              attestation: await attest(owner, 'grant', RELIC_ID, [
                invite.statement,
              ]),
              wraps: [await wrap(invite.pair.publicKey, randomBytes(16), 1)],
            },
            owner.cookie
          )
        )
      ).status
    ).toBe(201);
    expect(await recipientsOf(owner)).toEqual(before);
  });

  test('the lookup lists open invitations only for an address without an identity', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const invite = await inviteFor(owner, 'ada@example.com', [1]);
    await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [
            invite.statement,
          ]),
          wraps: [await wrap(invite.pair.publicKey, randomBytes(16), 1)],
        },
        owner.cookie
      )
    );
    const lookup = await send(
      `/api/relics/${RELIC_ID}/grants/lookup`,
      post({ emails: ['ada@example.com'] }, owner.cookie)
    );
    expect(lookup.status).toBe(200);
    const [result] = lookup.body['results'] as {
      party: unknown;
      invites: { invite_id: string }[];
    }[];
    expect(result!.party).toBeNull();
    expect(result!.invites.map((i) => i.invite_id)).toEqual([
      await inviteIdOf(invite.pair.publicKey),
    ]);
  });
});
