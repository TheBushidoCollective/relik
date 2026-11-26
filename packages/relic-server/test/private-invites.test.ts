import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  attestationChallenge,
  decodeBase64url,
  inviteRecipient,
  unwrapVersionKey,
  kemKeyIdOf,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  generateInviteKeyPair,
  identityFingerprint,
  formatFingerprint,
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
import { attestation, DAY, NOW, RELIC_ID } from './private-fixtures.ts';

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

  test('invitation lifetimes outside 1 to 30 days, or past the relik, are refused as expires_at', async () => {
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

/** Seed the invitation and index as an atomic claim would leave them. */
async function claimFor(
  invitee: Person,
  owner: Person,
  versions: number[]
): Promise<void> {
  const inviteId =
    (await store.listInvites(RELIC_ID)).find(
      (invite) => invite.invitedEmail === invitee.email && invite.status === 'open'
    )?.inviteId ?? invitee.identityId!;
  if ((await store.getInvite(RELIC_ID, inviteId)) === undefined) {
    await store.putInvite({
      relicId: RELIC_ID,
      inviteId,
      ownerIdentityId: owner.identityId!,
      invitedEmail: invitee.email,
      invitePublicKey: 'public',
      versions,
      expiresAt: now + DAY,
      createdAt: now,
      status: 'open',
      wraps: [],
      attestation: attestation(),
    });
  }
  await store.addInviteClaimIndex(RELIC_ID, invitee.identityId!, inviteId);
  await store.updateInvite(RELIC_ID, inviteId, (current) => ({
    ...current,
    status: 'claimed',
    claimantIdentityId: invitee.identityId!,
    claimedAt: now,
    wraps: [],
    claimWraps: versions.map((version) => ({ version, enc: 'enc', ct: 'ct' })),
  }));
}

describe('the invited role (decision D14)', () => {
  test('a claimed invitee reads the listed versions and comments, and is refused every owner route', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    await registerIdentity(invitee);
    await claimFor(invitee, owner, [1]);

    const access = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: invitee.cookie,
    });
    expect(access.status).toBe(200);
    const me = access.body['me'] as {
      role: string;
      readable_versions: number[];
    };
    expect(me.role).toBe('invited');
    expect(me.readable_versions).toEqual([1]);

    const comments = await send(`/api/relics/${RELIC_ID}/comments`, {
      cookie: invitee.cookie,
    });
    expect(comments.status).toBe(200);

    for (const path of [
      `/api/relics/${RELIC_ID}/grants/lookup`,
      `/api/relics/${RELIC_ID}/grants`,
      `/api/relics/${RELIC_ID}/revocations`,
    ]) {
      const refused = await send(
        path,
        post(
          { emails: ['x@example.com'], attestation: {}, wraps: [] },
          invitee.cookie
        )
      );
      expect(refused.status).toBe(403);
      expect(refused.body['code']).toBe('owner_required');
    }
  });

  test('an identity with an open invitation but no claim has no standing, so it cannot comment', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    await registerIdentity(invitee);
    const access = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: invitee.cookie,
    });
    expect((access.body['me'] as { role: string }).role).toBe('none');
    const comments = await send(`/api/relics/${RELIC_ID}/comments`, {
      cookie: invitee.cookie,
    });
    expect(comments.status).toBe(403);
  });

  test('a claim revoked by the owner reads as revoked and loses its versions', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    await registerIdentity(invitee);
    await claimFor(invitee, owner, [1]);
    const index = await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!);
    expect(index).toBeDefined();
    await store.updateInvite(RELIC_ID, index!.inviteIds[0]!, (current) => ({
      ...current,
      status: 'revoked',
      revokedAt: now,
      claimWraps: [],
    }));
    const access = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: invitee.cookie,
    });
    const me = access.body['me'] as {
      role: string;
      readable_versions: number[];
    };
    expect(me.role).toBe('revoked');
    expect(me.readable_versions).toEqual([]);
  });

  test('a grant confirms a claim without discarding its versions', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    await registerIdentity(invitee);
    await claimFor(invitee, owner, [1]);
    const grant = await grantStatementFor(owner, invitee, [1]);
    const response = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
        },
        owner.cookie
      )
    );
    expect(response.status).toBe(201);
    expect(
      (await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!))?.inviteIds
    ).toHaveLength(1);
    const access = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: invitee.cookie,
    });
    expect((access.body['me'] as { role: string }).role).toBe('grantee');
  });
});

/** A batch invitation for one address, created through route B, and its key pair. */
async function createInvite(
  owner: Person,
  email: string,
  versionKey: Uint8Array,
  options: { readonly expiresAt?: number } = {}
): Promise<{
  readonly pair: { publicKey: Uint8Array; d: Uint8Array };
  readonly inviteId: string;
}> {
  const invite = await inviteFor(owner, email, [1], options);
  const response = await send(
    `/api/relics/${RELIC_ID}/grants`,
    post(
      {
        attestation: await attest(owner, 'grant', RELIC_ID, [invite.statement]),
        wraps: [await wrap(invite.pair.publicKey, versionKey, 1)],
      },
      owner.cookie
    )
  );
  expect(response.status).toBe(201);
  return {
    pair: invite.pair,
    inviteId: await inviteIdOf(invite.pair.publicKey),
  };
}

describe('the invitee reads (plan 3.3 G, H, I)', () => {
  test('the invitee opens the invitation, takes the wrap, and it opens under the invite key', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const { pair, inviteId } = await createInvite(
      owner,
      invitee.email,
      versionKey
    );

    const opened = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({}, invitee.cookie)
    );
    expect(opened.status).toBe(200);
    expect(opened.body['status']).toBe('open');
    expect(opened.body['versions']).toEqual([1]);
    expect(opened.body['sealed_version']).toBe(1);
    expect(opened.body['claimed_by_identity_id']).toBeNull();
    expect(
      (opened.body['invite'] as { statement: { invited_email: string } })
        .statement.invited_email
    ).toBe(invitee.email);

    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: inviteId }, invitee.cookie)
    );
    expect(key.status).toBe(200);
    expect(await store.listReceipts(RELIC_ID)).toEqual([]);
    const served = key.body['wrap'] as {
      recipient_key_id: string;
      enc: string;
      ct: string;
    };
    expect(served.recipient_key_id).toBe(inviteId);
    const opensUnder = await unwrapVersionKey({
      recipient: await inviteRecipient(pair.d, pair.publicKey),
      relicId: RELIC_ID,
      version: 1,
      enc: served.enc,
      ct: served.ct,
    });
    expect(Buffer.from(opensUnder).toString('hex')).toBe(
      Buffer.from(versionKey).toString('hex')
    );

    const events = await store.listAccessEvents(
      owner.identityId as string,
      now,
      RELIC_ID
    );
    const fetched = events.filter(
      (e) => e.kind === 'wrap_fetch' && e.subjectEmail === invitee.email
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.actorEmail).toBe(invitee.email);
  });

  test('a different address and a bogus id get the same refusals, and no session is 401', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const other = await person('grace@example.com');
    const { inviteId } = await createInvite(owner, invitee.email, versionKey);
    const bogus = 'f'.repeat(64);

    const signedOut = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({})
    );
    expect(signedOut.status).toBe(401);

    const wrongOpen = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({}, other.cookie)
    );
    const bogusOpen = await send(
      `/api/relics/${RELIC_ID}/invites/${bogus}/open`,
      post({}, other.cookie)
    );
    expect(wrongOpen.status).toBe(404);
    expect(wrongOpen.body['code']).toBe('invite_not_found');
    expect({ status: bogusOpen.status, code: bogusOpen.body['code'] }).toEqual({
      status: wrongOpen.status,
      code: wrongOpen.body['code'],
    });

    const wrongKey = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: inviteId }, other.cookie)
    );
    const bogusKey = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: bogus }, other.cookie)
    );
    expect(wrongKey.status).toBe(403);
    expect(wrongKey.body['code']).toBe('private_access_denied');
    expect({ status: bogusKey.status, code: bogusKey.body['code'] }).toEqual({
      status: wrongKey.status,
      code: wrongKey.body['code'],
    });

    const wrongMint = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 1, invite_id: inviteId }, other.cookie)
    );
    expect({ status: wrongMint.status, code: wrongMint.body['code'] }).toEqual({
      status: wrongKey.status,
      code: wrongKey.body['code'],
    });
  });

  test('an expired invitation reads as expired and loses its wraps; the relik expiry refuses first', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const { inviteId } = await createInvite(owner, invitee.email, versionKey, {
      expiresAt: now + DAY,
    });

    now += 2 * DAY;
    const opened = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({}, invitee.cookie)
    );
    expect(opened.status).toBe(200);
    expect(opened.body['status']).toBe('expired');
    expect((await store.getInvite(RELIC_ID, inviteId))?.wraps).toHaveLength(0);
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: inviteId }, invitee.cookie)
    );
    expect(key.status).toBe(403);
    expect(key.body['code']).toBe('private_access_denied');

    // Only the relik's own expiry is moved, so the session stays valid.
    await store.updateRelic(RELIC_ID, (r) => ({ ...r, expiresAt: now - 1 }));
    const refused = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({}, invitee.cookie)
    );
    expect(refused.status).not.toBe(200);
    expect(refused.body['code']).toBe('relic_expired');
  });

  test('a withdrawn invitation reads as withdrawn and serves no key', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const { inviteId } = await createInvite(owner, invitee.email, versionKey);
    await store.updateInvite(RELIC_ID, inviteId, (r) => ({
      ...r,
      status: 'revoked',
      revokedAt: now,
      wraps: [],
    }));
    const opened = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
      post({}, invitee.cookie)
    );
    expect(opened.body['status']).toBe('revoked');
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: inviteId }, invitee.cookie)
    );
    expect(key.status).toBe(403);
  });

  test('a version the invitation did not list is refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const { inviteId } = await createInvite(owner, invitee.email, versionKey);
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/2/key`,
      post({ invite_id: inviteId }, invitee.cookie)
    );
    expect(key.status).toBe(403);
    expect(key.body['code']).toBe('private_access_denied');
  });

  test('a mint with an invitation is capped at the invitation expiry, and is logged with the address', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const expiresAt = now + DAY;
    const { inviteId } = await createInvite(owner, invitee.email, versionKey, {
      expiresAt,
    });
    const minted = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 1, invite_id: inviteId }, invitee.cookie)
    );
    expect(minted.status).toBe(200);
    expect(
      String(minted.body['url_expires_at']) <= new Date(expiresAt).toISOString()
    ).toBe(true);
    const events = await store.listAccessEvents(
      owner.identityId as string,
      now,
      RELIC_ID
    );
    expect(
      events.some(
        (e) => e.kind === 'wrap_fetch' && e.subjectEmail === invitee.email
      )
    ).toBe(true);
  });
});

describe('owner invitation management', () => {
  test('only the owner can list and cancel, and cancellation is idempotent', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const other = await person('other@example.com');
    await registerIdentity(other);
    const { inviteId } = await createInvite(
      owner,
      'ada@example.com',
      versionKey
    );
    const path = `/api/relics/${RELIC_ID}/invites`;
    expect((await send(path)).status).toBe(401);
    expect((await send(path, { cookie: other.cookie })).status).toBe(403);
    const list = await send(path, { cookie: owner.cookie });
    expect(list.status).toBe(200);
    expect((list.body['invites'] as { status: string }[])[0]?.status).toBe(
      'open'
    );
    expect(
      (await send(`${path}/${inviteId}/revoke`, post({}, other.cookie))).status
    ).toBe(403);
    expect(
      (await send(`${path}/${inviteId}/revoke`, post({}, owner.cookie))).status
    ).toBe(200);
    expect((await store.getInvite(RELIC_ID, inviteId))?.wraps).toEqual([]);
    expect(
      (await send(`${path}/${inviteId}/revoke`, post({}, owner.cookie))).status
    ).toBe(200);
    const events = await store.listAccessEvents(
      owner.identityId!,
      now,
      RELIC_ID
    );
    expect(events.filter((event) => event.kind === 'revoke')).toHaveLength(1);
  });

  test('lists a claimant and refuses removal once a grant confirms them', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const invitee = await person('ada@example.com');
    const { inviteId } = await createInvite(owner, invitee.email, versionKey);
    await registerIdentity(invitee);
    await claimFor(invitee, owner, [1]);
    await store.updateInvite(RELIC_ID, inviteId, (row) => ({
      ...row,
      status: 'claimed',
      wraps: [],
      claimedAt: now,
      claimantIdentityId: invitee.identityId,
    }));
    const path = `/api/relics/${RELIC_ID}/invites`;
    const before = await send(path, { cookie: owner.cookie });
    const claimed = (
      before.body['invites'] as {
        status: string;
        claimed_by: { identity: { identity_id: string } };
      }[]
    )[0]!;
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimed_by.identity.identity_id).toBe(invitee.identityId!);
    const grant = await grantStatementFor(owner, invitee, [1]);
    const result = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
        },
        owner.cookie
      )
    );
    expect(result.status).toBe(201);
    const after = await send(path, { cookie: owner.cookie });
    expect((after.body['invites'] as { status: string }[])[0]?.status).toBe(
      'confirmed'
    );
    const refused = await send(
      `${path}/${inviteId}/revoke`,
      post({}, owner.cookie)
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('grant_exists');
  });
});

test('an orphan wrap cannot authorize a key fetch', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  await registerIdentity(invitee);
  const identity = await store.getIdentity(invitee.identityId!);
  await store.putWrap({
    relicId: RELIC_ID,
    version: 1,
    recipientKeyId: identity!.kemKeyId,
    enc: 'enc',
    ct: 'ct',
    createdAt: now,
    source: 'grant',
  });
  const response = await send(
    `/api/relics/${RELIC_ID}/versions/1/key`,
    post({}, invitee.cookie)
  );
  expect(response.status).toBe(403);
  expect(response.body['code']).toBe('private_access_denied');
});

test('an invited identity claims and retains exactly its versions', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  const result = await send(path, post(body, invitee.cookie));
  expect(result.status).toBe(201);
  expect(result.body['status']).toBe('claimed');
  const claimed = await store.getInvite(RELIC_ID, inviteId);
  expect(claimed?.wraps).toEqual([]);
  expect(claimed?.claimWraps).toHaveLength(1);
  const identity = await store.getIdentity(invitee.identityId!);
  expect(await store.getWrap(RELIC_ID, 1, identity!.kemKeyId)).toBeUndefined();
  expect(
    (await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!))?.inviteIds
  ).toEqual([inviteId]);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(200);
  expect((await send(path, post(body, invitee.cookie))).status).toBe(201);
  expect(
    sent.filter((item) =>
      item.mail.subject.includes('accepted your invitation')
    )
  ).toHaveLength(1);
  now += 8 * DAY;
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(200);
});

test('a claim remains readable after a post-CAS write fails', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const append = store.appendAccessEvent.bind(store);
  let fail = true;
  store.appendAccessEvent = async (...args) => {
    if (fail && args[0].kind === 'claim') {
      fail = false;
      throw new Error('injected post-claim failure');
    }
    return append(...args);
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  await expect(send(path, post(body, invitee.cookie))).rejects.toThrow(
    'injected post-claim failure'
  );
  expect((await store.getInvite(RELIC_ID, inviteId))?.status).toBe('claimed');
  const opened = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/open`,
    post({}, invitee.cookie)
  );
  expect(opened.body['claimed_by_identity_id']).toBe(invitee.identityId);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(200);
});

test('a crash before invitation CAS leaves an inert index and can retry', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const update = store.updateInvite.bind(store);
  let fail = true;
  store.updateInvite = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('injected invitation CAS failure');
    }
    return update(...args);
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  await expect(send(path, post(body, invitee.cookie))).rejects.toThrow(
    'injected invitation CAS failure'
  );
  expect((await store.getInvite(RELIC_ID, inviteId))?.status).toBe('open');
  expect(
    (await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!))?.inviteIds
  ).toEqual([inviteId]);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(403);
  expect((await send(path, post(body, invitee.cookie))).status).toBe(201);
});

test('cancellation wins the claim CAS and a second invitation can be claimed', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  const second = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const update = store.updateInvite.bind(store);
  let revoke = true;
  store.updateInvite = async (...args) => {
    if (revoke) {
      revoke = false;
      const response = await send(
        `/api/relics/${RELIC_ID}/invites/${inviteId}/revoke`,
        post({}, owner.cookie)
      );
      expect(response.status).toBe(200);
    }
    return update(...args);
  };
  const response = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
    post(body, invitee.cookie)
  );
  expect(response.status).toBe(410);
  expect(response.body['code']).toBe('invite_revoked');
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(403);
  const secondStatement = { ...statement, invite_id: second.inviteId };
  const secondBody = {
    ...body,
    statement: secondStatement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', secondStatement)
    ),
  };
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/invites/${second.inviteId}/claim`,
      post(secondBody, invitee.cookie)
    )).status
  ).toBe(201);
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, invitee.cookie)))
      .status
  ).toBe(200);
});

test('two tabs claiming the same invitation retain the winning wrap', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  const update = store.updateInvite.bind(store);
  let interleave = true;
  let winnerStatus = 0;
  store.updateInvite = async (...args) => {
    if (interleave) {
      interleave = false;
      winnerStatus = (await send(path, post(body, invitee.cookie))).status;
    }
    return update(...args);
  };
  const result = await send(path, post(body, invitee.cookie));
  expect(winnerStatus).toBe(201);
  expect(result.status).toBe(201);
  const response = await send(
    `/api/relics/${RELIC_ID}/versions/1/key`,
    post({}, invitee.cookie)
  );
  expect(response.status).toBe(200);
  const saved = response.body['wrap'] as { enc: string; ct: string };
  const opened = await unwrapVersionKey({
    recipient: {
      publicKey: invitee.keys!.kemPublicKey,
      dh: async (peer) => {
        const key = await crypto.subtle.importKey(
          'raw',
          peer as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        return new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'ECDH', public: key },
            invitee.keys!.kem.privateKey,
            256
          )
        );
      },
    },
    relicId: RELIC_ID,
    version: 1,
    enc: saved.enc,
    ct: saved.ct,
  });
  expect(Buffer.from(opened)).toEqual(Buffer.from(versionKey));
});

test('invitation operations share the 240 per hour IP budget', async () => {
  const invitee = await person('ada@example.com');
  const path = `/api/relics/${RELIC_ID}/invites/${'a'.repeat(64)}/open`;
  for (let i = 0; i < 240; i++) {
    const response = await send(path, post({}, invitee.cookie));
    expect(response.status).not.toBe(429);
  }
  const exhausted = await send(path, post({}, invitee.cookie));
  expect(exhausted.status).toBe(429);
  expect(exhausted.body['code']).toBe('private_rate_limited');
});

test('direct sharing looks up, grants, refuses repeats and sends a fingerprint notice', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const reader = await person('reader@example.com');
  await registerIdentity(reader);
  const lookup = await send(
    `/api/relics/${RELIC_ID}/grants/lookup`,
    post(
      { emails: [reader.email, owner.email, 'absent@example.com'] },
      owner.cookie
    )
  );
  expect(lookup.status).toBe(200);
  const results = lookup.body['results'] as {
    standing: string | null;
    party: unknown;
  }[];
  expect(results.map((result) => result.standing)).toEqual([
    'none',
    'owner',
    null,
  ]);
  const grant = await grantStatementFor(owner, reader, [1]);
  const sendGrant = async () =>
    send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
        },
        owner.cookie
      )
    );
  expect((await sendGrant()).status).toBe(201);
  const repeated = await sendGrant();
  expect(repeated.status).toBe(409);
  expect(repeated.body['code']).toBe('grant_exists');
  const notices = sent.filter(
    (item) =>
      item.to === reader.email && item.mail.subject.includes('shared a relik')
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]!.mail.text).toContain(owner.email);
  expect(notices[0]!.mail.text).toContain('fingerprint');
  expect(notices[0]!.mail.text).toContain(
    formatFingerprint(
      await identityFingerprint(reader.identityId!, reader.email)
    )
  );
  expect(notices[0]!.mail.text).not.toContain('#');
  const events = await store.listAccessEvents(owner.identityId!, now, RELIC_ID);
  expect(events.filter((event) => event.kind === 'share')).toHaveLength(1);
});

test('multiple claimed invitations union their versions through a narrower confirmation', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const first = await createInvite(owner, invitee.email, versionKey);
  const seal = (await store.getSeal(RELIC_ID, 1))!;
  await store.putSeal({ ...seal, version: 2 });
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    version: 2,
    sealedVersion: 2,
  }));
  const second = await inviteFor(owner, invitee.email, [2]);
  const secondId = await inviteIdOf(second.pair.publicKey);
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [second.statement]),
          wraps: [await wrap(second.pair.publicKey, versionKey, 2)],
        },
        owner.cookie
      )
    )).status
  ).toBe(201);
  await registerIdentity(invitee);
  const claim = async (inviteId: string, version: number) => {
    const statement = {
      at: now,
      claimant_identity_id: invitee.identityId!,
      invite_id: inviteId,
      relic_id: RELIC_ID,
      versions: [version],
    };
    return send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
      post(
        {
          statement,
          identity_signature: await signStatement(
            signer(invitee.keys!),
            statementBytes('invite_claim', statement)
          ),
          wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, version)],
        },
        invitee.cookie
      )
    );
  };
  expect((await claim(first.inviteId, 1)).status).toBe(201);
  expect((await claim(secondId, 2)).status).toBe(201);
  const access = await send(`/api/relics/${RELIC_ID}/access`, {
    cookie: invitee.cookie,
  });
  expect(access.body['me']).toMatchObject({ readable_versions: [1, 2] });
  const grant = await grantStatementFor(owner, invitee, [2]);
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 2)],
        },
        owner.cookie
      )
    )).status
  ).toBe(201);
  const confirmed = await send(`/api/relics/${RELIC_ID}/access`, {
    cookie: invitee.cookie,
  });
  expect(confirmed.body['me']).toMatchObject({
    role: 'grantee',
    readable_versions: [1, 2],
  });
  for (const version of [1, 2]) {
    expect(
      (await send(
        `/api/relics/${RELIC_ID}/versions/${version}/key`,
        post({}, invitee.cookie)
      )).status
    ).toBe(200);
  }
});

test('identity replacement after the claim CAS leaves the old identity claimed', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const old = (await store.getIdentity(invitee.identityId!))!;
  const replacement = await generateIdentityKeys();
  const update = store.updateInvite.bind(store);
  let change = true;
  store.updateInvite = async (...args) => {
    const result = await update(...args);
    if (change) {
      change = false;
      expect(
        await store.replaceIdentity(
          {
            ...old,
            identityId: await identityIdOf(
              replacement.kemPublicKey,
              replacement.sigPublicKey
            ),
            kemPublicKey: encodeBase64url(replacement.kemPublicKey),
            sigPublicKey: encodeBase64url(replacement.sigPublicKey),
            kemKeyId: hex(await kemKeyIdOf(replacement.kemPublicKey)),
          },
          old.identityId,
          now
        )
      ).toBe('replaced');
    }
    return result;
  };
  const result = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
    post(body, invitee.cookie)
  );
  expect(result.status).toBe(409);
  expect(result.body['code']).toBe('identity_changed');
  expect(
    (await store.getInviteClaimIndex(RELIC_ID, old.identityId))?.inviteIds
  ).toEqual([inviteId]);
  expect((await store.getInvite(RELIC_ID, inviteId))?.status).toBe('claimed');
});

test('a different claimant wins the CAS without inheriting the losing claim', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const firstId = invitee.identityId!;
  const statement = {
    at: now,
    claimant_identity_id: firstId,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const old = (await store.getIdentity(firstId))!;
  const replacement = await generateIdentityKeys();
  const secondId = await identityIdOf(
    replacement.kemPublicKey,
    replacement.sigPublicKey
  );
  const secondStatement = { ...statement, claimant_identity_id: secondId };
  const secondBody = {
    statement: secondStatement,
    identity_signature: await signStatement(
      signer(replacement),
      statementBytes('invite_claim', secondStatement)
    ),
    wraps: [await wrap(replacement.kemPublicKey, versionKey, 1)],
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  const update = store.updateInvite.bind(store);
  let interleave = true;
  let winnerStatus = 0;
  store.updateInvite = async (...args) => {
    if (interleave) {
      interleave = false;
      expect(
        await store.replaceIdentity(
          {
            ...old,
            identityId: secondId,
            kemPublicKey: encodeBase64url(replacement.kemPublicKey),
            sigPublicKey: encodeBase64url(replacement.sigPublicKey),
            kemKeyId: hex(await kemKeyIdOf(replacement.kemPublicKey)),
          },
          firstId,
          now
        )
      ).toBe('replaced');
      winnerStatus = (await send(path, post(secondBody, invitee.cookie)))
        .status;
    }
    return update(...args);
  };
  const loser = await send(path, post(body, invitee.cookie));
  expect(winnerStatus).toBe(201);
  expect(loser.status).toBe(409);
  expect(loser.body['code']).toBe('invite_claimed');
  expect((await store.getInviteClaimIndex(RELIC_ID, firstId))?.inviteIds).toEqual([
    inviteId,
  ]);
  expect((await store.getInviteClaimIndex(RELIC_ID, secondId))?.inviteIds).toEqual([
    inviteId,
  ]);
  expect((await store.getInvite(RELIC_ID, inviteId))?.claimantIdentityId).toBe(
    secondId
  );
  const result = await send(
    `/api/relics/${RELIC_ID}/versions/1/key`,
    post({}, invitee.cookie)
  );
  expect(result.status).toBe(200);
  const saved = result.body['wrap'] as { enc: string; ct: string };
  const opened = await unwrapVersionKey({
    recipient: {
      publicKey: replacement.kemPublicKey,
      dh: async (peer) => {
        const key = await crypto.subtle.importKey(
          'raw',
          peer as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        return new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'ECDH', public: key },
            replacement.kem.privateKey,
            256
          )
        );
      },
    },
    relicId: RELIC_ID,
    version: 1,
    enc: saved.enc,
    ct: saved.ct,
  });
  expect(Buffer.from(opened)).toEqual(Buffer.from(versionKey));
});

test('removing an accepted invitee revokes the claim and removes its wraps', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
        post(body, invitee.cookie)
      )
    ).status
  ).toBe(201);
  const wrapsBefore = await store.listWraps(RELIC_ID);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/invites/${inviteId}/revoke`,
        post({}, owner.cookie)
      )
    ).status
  ).toBe(200);
  const claim = await store.getInvite(RELIC_ID, inviteId);
  expect(claim?.status).toBe('revoked');
  expect(claim?.revokedAt).toBe(now);
  expect(claim?.claimWraps).toEqual([]);
  expect(await store.listWraps(RELIC_ID)).toEqual(wrapsBefore);
  const access = await send(`/api/relics/${RELIC_ID}/access`, {
    cookie: invitee.cookie,
  });
  expect(access.body['me']).toMatchObject({ role: 'revoked' });
  const identity = await store.getIdentity(invitee.identityId!);
  expect(await store.getWrap(RELIC_ID, 1, identity!.kemKeyId)).toBeUndefined();
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, invitee.cookie)
      )
    ).status
  ).toBe(403);
});

test('removing a claim cannot delete a concurrent confirmation wrap', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  await claimFor(invitee, owner, [1]);
  const grant = await grantStatementFor(owner, invitee, [1]);
  const grantBody = {
    attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const getGrant = store.getGrant.bind(store);
  let interleaved = false;
  store.getGrant = async (...args) => {
    const prior = await getGrant(...args);
    if (!interleaved && args[1] === invitee.identityId) {
      interleaved = true;
      expect(
        (await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(grantBody, owner.cookie)
        )).status
      ).toBe(201);
    }
    return prior;
  };
  const removed = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/revoke`,
    post({}, owner.cookie)
  );
  expect(interleaved).toBe(true);
  expect(removed.status).toBe(200);
  expect((await store.getInvite(RELIC_ID, inviteId))?.status).toBe('revoked');
  expect((await store.getGrant(RELIC_ID, invitee.identityId!))?.revokedAt)
    .toBeUndefined();
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, invitee.cookie)))
      .status
  ).toBe(200);
});

test('owner deletion removes invitation and claim rows and wraps', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  await claimFor(invitee, owner, [1]);
  const attestation = await attest(owner, 'delete', RELIC_ID, [
    {
      kind: 'delete',
      statement: {
        at: now,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
        versions: 'all',
      },
    },
  ]);
  const response = await send(
    `/api/relics/${RELIC_ID}/delete`,
    post({ attestation }, owner.cookie)
  );
  expect(response.status).toBe(200);
  expect(await store.getInvite(RELIC_ID, inviteId)).toBeUndefined();
  expect(
    await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!)
  ).toBeUndefined();
  expect(await store.listWraps(RELIC_ID)).toEqual([]);
});

test('version deletion strips invitation versions and claimant wraps', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  await claimFor(invitee, owner, [1]);
  await store.updateRelic(RELIC_ID, (row) => ({ ...row, version: 2 }));
  const attestation = await attest(owner, 'delete', RELIC_ID, [
    {
      kind: 'delete',
      statement: {
        at: now,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
        versions: [1],
      },
    },
  ]);
  const response = await send(
    `/api/relics/${RELIC_ID}/delete`,
    post({ attestation }, owner.cookie)
  );
  expect(response.status).toBe(200);
  const invite = await store.getInvite(RELIC_ID, inviteId);
  expect(invite?.status).toBe('claimed');
  expect(invite?.versions).toEqual([]);
  expect(invite?.wraps).toEqual([]);
  expect(invite?.claimWraps).toEqual([]);
  expect(await store.listWraps(RELIC_ID, 1)).toEqual([]);
});

test('open, claimed and confirmed invitation records do not alter recipients', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const before = await recipientsOf(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  expect(await recipientsOf(owner)).toEqual(before);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const claim = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
        post(claim, invitee.cookie)
      )
    ).status
  ).toBe(201);
  expect(await recipientsOf(owner)).toEqual(before);
  const grant = await grantStatementFor(owner, invitee, [1]);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/grants`,
        post(
          {
            attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
            wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
          },
          owner.cookie
        )
      )
    ).status
  ).toBe(201);
  const confirmed = await recipientsOf(owner);
  await store.deleteInvite(RELIC_ID, inviteId);
  expect(await recipientsOf(owner)).toEqual(confirmed);
});

test.each(['grant', 'seal', 'backfill'] as const)(
  'a leftover %s wrap cannot broaden a later partial grant',
  async (source) => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const orphan = await wrap(reader.keys!.kemPublicKey, versionKey, 1);
    await store.putWrap({
      relicId: RELIC_ID,
      version: 1,
      recipientKeyId: orphan.recipient_key_id,
      enc: orphan.enc,
      ct: orphan.ct,
      createdAt: now,
      source,
    });
    const seal = (await store.getSeal(RELIC_ID, 1))!;
    await store.putSeal({ ...seal, version: 2 });
    await store.updateRelic(RELIC_ID, (row) => ({
      ...row,
      version: 2,
      sealedVersion: 2,
    }));
    const grant = await grantStatementFor(owner, reader, [2]);
    const granted = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
        },
        owner.cookie
      )
    );
    expect(granted.status).toBe(201);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
    expect(
      (await send(`/api/relics/${RELIC_ID}/mint`, post({ version: 1 }, reader.cookie)))
        .status
    ).toBe(403);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
        .status
    ).toBe(200);
    const access = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: reader.cookie,
    });
    expect(access.body['me']).toMatchObject({ readable_versions: [2] });
  }
);

test('claiming an expired invitation refuses before creating a claim', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey, {
    expiresAt: now + DAY,
  });
  await registerIdentity(invitee);
  now += DAY + 1;
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const response = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
    post(body, invitee.cookie)
  );
  expect(response.status).toBe(410);
  expect(response.body['code']).toBe('invite_expired');
  expect(
    await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!)
  ).toBeUndefined();
});

test('claiming is bound to the address and the current identity signature', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const other = await person('other@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  await registerIdentity(invitee);
  const statement = {
    at: now,
    claimant_identity_id: invitee.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const body = {
    statement,
    identity_signature: await signStatement(
      signer(invitee.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(invitee.keys!.kemPublicKey, versionKey, 1)],
  };
  const path = `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`;
  const otherAddress = await send(path, post(body, other.cookie));
  const missing = await send(
    `/api/relics/${RELIC_ID}/invites/${'f'.repeat(64)}/claim`,
    post(body, other.cookie)
  );
  expect(otherAddress.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(otherAddress.body['code']).toBe(missing.body['code']);
  const forged = await send(
    path,
    post(
      { ...body, identity_signature: encodeBase64url(randomBytes(64)) },
      invitee.cookie
    )
  );
  expect(forged.status).toBe(400);
  expect(forged.body['statement_check']).toBe('signature');
  expect(
    await store.getInviteClaimIndex(RELIC_ID, invitee.identityId!)
  ).toBeUndefined();
});

test('an invited claimant cannot use the private share route', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  await registerIdentity(invitee);
  await claimFor(invitee, owner, [1]);
  const response = await send(
    `/api/relics/${RELIC_ID}/share`,
    post({ emails: ['stranger@example.net'] }, invitee.cookie)
  );
  expect(response.status).toBe(403);
  expect(response.body['code']).toBe('private_access_denied');
});

test('invited decisions refuse versions outside the claim', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  await registerIdentity(invitee);
  await claimFor(invitee, owner, [1]);
  const seal = (await store.getSeal(RELIC_ID, 1))!;
  await store.putSeal({ ...seal, version: 2 });
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    version: 2,
    sealedVersion: 2,
    decisionsOpen: true,
  }));
  await store.recordVersionDigest(RELIC_ID, 2, 'a'.repeat(64));
  for (const path of ['decisions/options', 'decisions', 'decisions/list']) {
    const response = await send(
      `/api/relics/${RELIC_ID}/${path}`,
      post({ version: 2, verdict: 'approve' }, invitee.cookie)
    );
    expect(response.status).toBe(403);
    expect(response.body['code']).toBe('private_access_denied');
  }
});

test('a losing batch cannot remove the winning grant wrap', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const h = await person('h@example.com');
  const g = await person('g@example.com');
  await registerIdentity(h);
  await registerIdentity(g);
  const hs = await grantStatementFor(owner, h, [1]);
  const gs = await grantStatementFor(owner, g, [1]);
  const hw = await wrap(h.keys!.kemPublicKey, versionKey, 1);
  const gw = await wrap(g.keys!.kemPublicKey, versionKey, 1);
  const a = {
    attestation: await attest(owner, 'grant', RELIC_ID, [hs, gs]),
    wraps: [hw, gw],
  };
  const c = {
    attestation: await attest(owner, 'grant', RELIC_ID, [hs]),
    wraps: [hw],
  };
  const b = {
    attestation: await attest(owner, 'grant', RELIC_ID, [gs]),
    wraps: [gw],
  };
  const path = `/api/relics/${RELIC_ID}/grants`;
  const put = store.putGrant.bind(store);
  let started = false;
  let deletes = 0;
  const remove = store.deleteWraps.bind(store);
  store.deleteWraps = async (...args) => {
    deletes++;
    return remove(...args);
  };
  store.putGrant = async (row) => {
    if (!started && row.granteeIdentityId === h.identityId) {
      started = true;
      expect((await send(path, post(c, owner.cookie))).status).toBe(201);
    }
    return put(row);
  };
  const lost = await send(path, post(a, owner.cookie));
  expect(lost.status).toBe(409);
  expect((await send(path, post(b, owner.cookie))).status).toBe(201);
  expect(deletes).toBe(0);
  const key = await send(
    `/api/relics/${RELIC_ID}/versions/1/key`,
    post({}, g.cookie)
  );
  expect(key.status).toBe(200);
  const saved = key.body['wrap'] as { enc: string; ct: string };
  const opened = await unwrapVersionKey({
    recipient: {
      publicKey: g.keys!.kemPublicKey,
      dh: async (peer) => {
        const publicKey = await crypto.subtle.importKey(
          'raw',
          peer as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        return new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'ECDH', public: publicKey },
            g.keys!.kem.privateKey,
            256
          )
        );
      },
    },
    relicId: RELIC_ID,
    version: 1,
    enc: saved.enc,
    ct: saved.ct,
  });
  expect(Buffer.from(opened)).toEqual(Buffer.from(versionKey));
});


test('the access log names the invited address on invitation events', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const invitee = await person('ada@example.com');
  const { inviteId } = await createInvite(owner, invitee.email, versionKey);
  const log = await send(`/api/identity/access-log?relic_id=${RELIC_ID}`, {
    cookie: owner.cookie,
  });
  expect(log.status).toBe(200);
  const invite = (
    log.body['events'] as { kind: string; subject_email: string | null }[]
  ).find((event) => event.kind === 'invite');
  expect(invite?.subject_email).toBe(invitee.email);
  const revoke = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/revoke`,
    post({}, owner.cookie)
  );
  expect(revoke.status).toBe(200);
  const after = await send(`/api/identity/access-log?relic_id=${RELIC_ID}`, {
    cookie: owner.cookie,
  });
  const withdrawn = (
    after.body['events'] as { kind: string; subject_email: string | null }[]
  ).find((event) => event.kind === 'revoke');
  expect(withdrawn?.subject_email).toBe(invitee.email);
});

test('an invitation longer than 30 days is refused even on a relik whose lifetime allows it', async () => {
  app = build({ privateMaxTtlDays: 60 });
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    expiresAt: now + 60 * DAY,
  }));
  const invite = await inviteFor(owner, 'ada@example.com', [1], {
    expiresAt: now + 31 * DAY,
  });
  const response = await send(
    `/api/relics/${RELIC_ID}/grants`,
    post(
      {
        attestation: await attest(owner, 'grant', RELIC_ID, [invite.statement]),
        wraps: [await wrap(invite.pair.publicKey, versionKey, 1)],
      },
      owner.cookie
    )
  );
  expect(response.status).toBe(400);
  expect(response.body['code']).toBe('invalid_statement');
  expect(response.body['statement_check']).toBe('expires_at');
});

/** A version-one invitation and a version-two grant to the same identity. */
async function partialGrantFixture(claimFirst: boolean) {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const reader = await person('ada@example.com');
  const first = await createInvite(owner, reader.email, versionKey);
  const spare = await createInvite(owner, reader.email, versionKey);
  await registerIdentity(reader);
  const statement = {
    at: now,
    claimant_identity_id: reader.identityId!,
    invite_id: first.inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const claim = {
    statement,
    identity_signature: await signStatement(
      signer(reader.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
  };
  const claimPath = `/api/relics/${RELIC_ID}/invites/${first.inviteId}/claim`;
  if (claimFirst) {
    expect((await send(claimPath, post(claim, reader.cookie))).status).toBe(201);
  }
  const seal = (await store.getSeal(RELIC_ID, 1))!;
  await store.putSeal({ ...seal, version: 2 });
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    version: 2,
    sealedVersion: 2,
  }));
  const grant = await grantStatementFor(owner, reader, [2]);
  const grantBody = {
    attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
    wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
  };
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(grantBody, owner.cookie)
    )).status
  ).toBe(201);
  return { owner, reader, first, spare, versionKey, claim, claimPath };
}

async function revokeAtVersionTwo(owner: Person, reader: Person) {
  const attestation = await attest(owner, 'revoke', RELIC_ID, [
    {
      kind: 'revocation',
      statement: {
        at: now,
        grantee_identity_id: reader.identityId,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
      },
    },
    {
      kind: 'republish',
      statement: {
        at: now,
        owner_identity_id: owner.identityId,
        previous_version: 2,
        reason: 'rekey',
        relic_id: RELIC_ID,
      },
    },
  ]);
  return {
    attestation,
    renderer_class: 'markdown',
    declared_size_bytes: 64,
    declared_ciphertext_bytes: encryptedSize(64),
  };
}

test('claiming an older invitation keeps versions outside an existing grant', async () => {
  const { reader, first, claim, claimPath, versionKey } =
    await partialGrantFixture(false);
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
      .status
  ).toBe(403);
  const result = await send(claimPath, post(claim, reader.cookie));
  expect(result.status).toBe(201);
  expect(result.body['status']).toBe('claimed');
  expect((await store.getInvite(RELIC_ID, first.inviteId))?.claimWraps).toHaveLength(1);
  expect(
    (await store.getInviteClaimIndex(RELIC_ID, reader.identityId!))?.inviteIds
  ).toEqual([first.inviteId]);
  const key = await send(
    `/api/relics/${RELIC_ID}/versions/1/key`,
    post({}, reader.cookie)
  );
  expect(key.status).toBe(200);
  const saved = key.body['wrap'] as { enc: string; ct: string };
  const opened = await unwrapVersionKey({
    recipient: {
      publicKey: reader.keys!.kemPublicKey,
      dh: async (peer) => {
        const publicKey = await crypto.subtle.importKey(
          'raw',
          peer as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        return new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'ECDH', public: publicKey },
            reader.keys!.kem.privateKey,
            256
          )
        );
      },
    },
    relicId: RELIC_ID,
    version: 1,
    enc: saved.enc,
    ct: saved.ct,
  });
  expect(Buffer.from(opened)).toEqual(Buffer.from(versionKey));
  const access = await send(`/api/relics/${RELIC_ID}/access`, {
    cookie: reader.cookie,
  });
  expect(access.body['me']).toMatchObject({
    role: 'grantee',
    readable_versions: [1, 2],
  });
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
      .status
  ).toBe(200);
});

test.each(['plain', 'cancel', 'regrant'] as const)(
  'a failed revocation preserves claim authority with %s interleaving',
  async (interleaving) => {
    const { owner, reader, first, spare, versionKey } =
      await partialGrantFixture(true);
    const revocation = await revokeAtVersionTwo(owner, reader);
    const grant = await grantStatementFor(owner, reader, [2]);
    const regrant = {
      attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
      wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
    };
    const update = store.updateRelic.bind(store);
    let interleaved = false;
    store.updateRelic = async (id, change) => {
      if (!interleaved && id === RELIC_ID) {
        interleaved = true;
        if (interleaving === 'cancel') {
          expect(
            (await send(
              `/api/relics/${RELIC_ID}/invites/${first.inviteId}/revoke`,
              post({}, owner.cookie)
            )).status
          ).toBe(200);
        }
        if (interleaving === 'regrant') {
          expect(
            (await send(
              `/api/relics/${RELIC_ID}/grants`,
              post(regrant, owner.cookie)
            )).status
          ).toBe(201);
        }
        await update(id, (current) => ({
          ...current,
          version: current.version + 1,
        }));
      }
      return update(id, change);
    };
    const result = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(revocation, owner.cookie)
    );
    expect(interleaved).toBe(true);
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('version_conflict');
    const fence = (await store.getRelic(RELIC_ID))?.accessFence?.[reader.email];
    if (interleaving === 'regrant') {
      expect(fence?.epoch).toBe(2);
    } else {
      expect(fence).toBeUndefined();
    }
    expect((await store.getGrant(RELIC_ID, reader.identityId!))?.revokedAt)
      .toBeUndefined();
    expect((await store.getInvite(RELIC_ID, spare.inviteId))?.status).toBe('open');
    const original = await store.getInvite(RELIC_ID, first.inviteId);
    expect(original?.status).toBe(interleaving === 'cancel' ? 'revoked' : 'claimed');
    expect(original?.claimWraps).toHaveLength(interleaving === 'cancel' ? 0 : 1);
    expect(
      (await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, reader.cookie)
      )).status
    ).toBe(interleaving === 'plain' ? 200 : 403);
    expect(
      (await send(
        `/api/relics/${RELIC_ID}/versions/2/key`,
        post({}, reader.cookie)
      )).status
    ).toBe(200);
  }
);

test('a storage failure before revocation commit retains the claimed wrap', async () => {
  const { owner, reader, first } = await partialGrantFixture(true);
  const revocation = await revokeAtVersionTwo(owner, reader);
  const update = store.updateRelic.bind(store);
  let fail = true;
  store.updateRelic = async (id, change) => {
    if (fail && id === RELIC_ID) {
      fail = false;
      throw new Error('epoch write unavailable');
    }
    return update(id, change);
  };
  await expect(
    send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(revocation, owner.cookie)
    )
  ).rejects.toThrow('epoch write unavailable');
  expect((await store.getInvite(RELIC_ID, first.inviteId))?.claimWraps).toHaveLength(1);
  expect((await store.getGrant(RELIC_ID, reader.identityId!))?.revokedAt)
    .toBeUndefined();
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
      .status
  ).toBe(200);
});

test('a committed revocation fences old claims despite concurrent regrant and failed cleanup', async () => {
  const { owner, reader, first, spare, claim, claimPath, versionKey } =
    await partialGrantFixture(true);
  const revocation = await revokeAtVersionTwo(owner, reader);
  const grant = await grantStatementFor(owner, reader, [2]);
  const regrant = {
    attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
    wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
  };
  const list = store.listInvites.bind(store);
  let interleaved = false;
  store.listInvites = async (relicId) => {
    if (!interleaved && relicId === RELIC_ID) {
      interleaved = true;
      expect(
        (await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(regrant, owner.cookie)
        )).status
      ).toBe(201);
      throw new Error('invitation cleanup unavailable');
    }
    return list(relicId);
  };
  const result = await send(
    `/api/relics/${RELIC_ID}/revocations`,
    post(revocation, owner.cookie)
  );
  store.listInvites = list;
  expect(interleaved).toBe(true);
  expect(result.status).toBe(200);
  expect((await store.getInvite(RELIC_ID, first.inviteId))?.status).toBe('claimed');
  expect((await store.getInvite(RELIC_ID, first.inviteId))?.claimWraps).toHaveLength(1);
  expect((await store.getInvite(RELIC_ID, spare.inviteId))?.status).toBe('open');
  expect((await store.getRelic(RELIC_ID))?.accessFence?.[reader.email]?.nonce)
    .toBeDefined();
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
      .status
  ).toBe(403);
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
      .status
  ).toBe(200);
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: spare.inviteId }, reader.cookie)
    )).status
  ).toBe(403);
  const opened = await send(
    `/api/relics/${RELIC_ID}/invites/${spare.inviteId}/open`,
    post({}, reader.cookie)
  );
  expect(opened.body['status']).toBe('revoked');
  const retried = await send(claimPath, post(claim, reader.cookie));
  expect(retried.status).toBe(410);
  expect(retried.body['code']).toBe('invite_revoked');
  // An invitation created from a stale pre-revocation snapshot is fenced too.
  const oldOpen = (await store.getInvite(RELIC_ID, spare.inviteId))!;
  const lateInviteId = 'f'.repeat(64);
  expect(await store.putInvite({ ...oldOpen, inviteId: lateInviteId })).toBe(true);
  const late = await send(
    `/api/relics/${RELIC_ID}/invites/${lateInviteId}/open`,
    post({}, reader.cookie)
  );
  expect(late.body['status']).toBe('revoked');
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ invite_id: lateInviteId }, reader.cookie)
    )).status
  ).toBe(403);
});

test('a partially covered invitation stores only its uncovered identity wraps', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const { versionKey } = await sealedPrivateRelic(owner);
  const seal = (await store.getSeal(RELIC_ID, 1))!;
  await store.putSeal({ ...seal, version: 2 });
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    version: 2,
    sealedVersion: 2,
  }));
  const reader = await person('ada@example.com');
  const invite = await inviteFor(owner, reader.email, [1, 2]);
  const inviteId = await inviteIdOf(invite.pair.publicKey);
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [invite.statement]),
          wraps: [
            await wrap(invite.pair.publicKey, versionKey, 1),
            await wrap(invite.pair.publicKey, versionKey, 2),
          ],
        },
        owner.cookie
      )
    )).status
  ).toBe(201);
  await registerIdentity(reader);
  const grant = await grantStatementFor(owner, reader, [2]);
  expect(
    (await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
        },
        owner.cookie
      )
    )).status
  ).toBe(201);
  const statement = {
    at: now,
    claimant_identity_id: reader.identityId!,
    invite_id: inviteId,
    relic_id: RELIC_ID,
    versions: [1, 2],
  };
  const result = await send(
    `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
    post(
      {
        statement,
        identity_signature: await signStatement(
          signer(reader.keys!),
          statementBytes('invite_claim', statement)
        ),
        wraps: [
          await wrap(reader.keys!.kemPublicKey, versionKey, 1),
          await wrap(reader.keys!.kemPublicKey, versionKey, 2),
        ],
      },
      reader.cookie
    )
  );
  expect(result.status).toBe(201);
  expect((await store.getInvite(RELIC_ID, inviteId))?.claimWraps?.map((w) => w.version))
    .toEqual([1]);
  const access = await send(`/api/relics/${RELIC_ID}/access`, {
    cookie: reader.cookie,
  });
  expect(access.body['me']).toMatchObject({ readable_versions: [1, 2] });
});

test.each([false, true])(
  'a fully covered grant with missing wrap %s keeps invitation access',
  async (missingWrap) => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const reader = await person('ada@example.com');
    const { inviteId } = await createInvite(owner, reader.email, versionKey);
    await registerIdentity(reader);
    const grant = await grantStatementFor(owner, reader, [1]);
    expect(
      (await send(
        `/api/relics/${RELIC_ID}/grants`,
        post(
          {
            attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
            wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
          },
          owner.cookie
        )
      )).status
    ).toBe(201);
    const readerKey = (await store.getIdentity(reader.identityId!))!.kemKeyId;
    if (missingWrap) {
      await store.deleteWraps(RELIC_ID, { version: 1, recipientKeyId: readerKey });
    }
    const statement = {
      at: now,
      claimant_identity_id: reader.identityId!,
      invite_id: inviteId,
      relic_id: RELIC_ID,
      versions: [1],
    };
    const claimed = await send(
      `/api/relics/${RELIC_ID}/invites/${inviteId}/claim`,
      post(
        {
          statement,
          identity_signature: await signStatement(
            signer(reader.keys!),
            statementBytes('invite_claim', statement)
          ),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
        },
        reader.cookie
      )
    );
    expect(claimed.status).toBe(missingWrap ? 201 : 200);
    expect(claimed.body['status']).toBe(missingWrap ? 'claimed' : 'already_reader');
    expect((await store.getInvite(RELIC_ID, inviteId))?.claimWraps)
      .toHaveLength(missingWrap ? 1 : 0);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
        .status
    ).toBe(200);
  }
);

test('a claim crossing a committed revocation cannot authorize its wrap', async () => {
  const { owner, reader, spare, versionKey } = await partialGrantFixture(true);
  const revocation = await revokeAtVersionTwo(owner, reader);
  const statement = {
    at: now,
    claimant_identity_id: reader.identityId!,
    invite_id: spare.inviteId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const claim = {
    statement,
    identity_signature: await signStatement(
      signer(reader.keys!),
      statementBytes('invite_claim', statement)
    ),
    wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
  };
  const update = store.updateInvite.bind(store);
  const atClaim = Promise.withResolvers<void>();
  const continueClaim = Promise.withResolvers<void>();
  let paused = false;
  store.updateInvite = async (...args) => {
    if (!paused && args[1] === spare.inviteId) {
      paused = true;
      atClaim.resolve();
      await continueClaim.promise;
    }
    return update(...args);
  };
  const pending = send(
    `/api/relics/${RELIC_ID}/invites/${spare.inviteId}/claim`,
    post(claim, reader.cookie)
  );
  await Promise.race([
    atClaim.promise,
    pending.then(() => {
      throw new Error('claim did not reach the invitation CAS');
    }),
  ]);
  const list = store.listInvites.bind(store);
  store.listInvites = async () => {
    throw new Error('invitation cleanup unavailable');
  };
  const revoked = await send(
    `/api/relics/${RELIC_ID}/revocations`,
    post(revocation, owner.cookie)
  );
  store.listInvites = list;
  expect(revoked.status).toBe(200);
  continueClaim.resolve();
  const result = await pending;
  expect(result.status).toBe(410);
  expect(result.body['code']).toBe('invite_revoked');
  expect((await store.getInvite(RELIC_ID, spare.inviteId))?.status).toBe('claimed');
  expect(
    (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
      .status
  ).toBe(403);
});

describe('revocation fence, crash recovery and the wrap sweep', () => {
  test('a regrant after a revocation that crashed before its commit fences the claim it left behind', async () => {
    const { owner, reader, versionKey } = await partialGrantFixture(true);
    await store.updateGrant(RELIC_ID, reader.identityId!, (current) => ({
      ...current,
      revokedAt: now,
      revocation: attestation(),
    }));
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
    const grant = await grantStatementFor(owner, reader, [2]);
    const regranted = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 2)],
        },
        owner.cookie
      )
    );
    expect(regranted.status).toBe(201);
    expect((await store.getRelic(RELIC_ID))?.accessFence?.[reader.email]?.epoch).toBe(2);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/1/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
        .status
    ).toBe(200);
  });

  test('a revocation retried after a crash before its commit completes', async () => {
    const { owner, reader } = await partialGrantFixture(true);
    await store.updateGrant(RELIC_ID, reader.identityId!, (current) => ({
      ...current,
      revokedAt: now,
      revocation: attestation(),
    }));
    const retried = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(await revokeAtVersionTwo(owner, reader), owner.cookie)
    );
    expect(retried.status).toBe(200);
    const grant = await store.getGrant(RELIC_ID, reader.identityId!);
    expect((await store.getRelic(RELIC_ID))?.accessFence?.[reader.email]?.nonce).toBe(
      grant?.revocation?.nonce
    );
    for (const version of [1, 2]) {
      expect(
        (await send(`/api/relics/${RELIC_ID}/versions/${version}/key`, post({}, reader.cookie)))
          .status
      ).toBe(403);
    }
  });

  test('an error after the revocation commits keeps the mark, completes the revocation, and sweeps the wrap', async () => {
    const { owner, reader } = await partialGrantFixture(true);
    const readerKey = (await store.getIdentity(reader.identityId!))!.kemKeyId;
    const real = store.updateRelic.bind(store);
    let armed = true;
    store.updateRelic = async (id, change) => {
      const next = await real(id, change);
      if (armed && id === RELIC_ID) {
        armed = false;
        throw new Error('response lost after the commit');
      }
      return next;
    };
    const revoked = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(await revokeAtVersionTwo(owner, reader), owner.cookie)
    );
    expect(armed).toBe(false);
    expect(revoked.status).toBe(200);
    expect(revoked.body['republish']).toBeDefined();
    const grant = await store.getGrant(RELIC_ID, reader.identityId!);
    expect(grant?.revokedAt).toBeDefined();
    const relic = await store.getRelic(RELIC_ID);
    expect(relic?.accessEpoch).toBe(2);
    expect(relic?.accessFence?.[reader.email]?.nonce).toBe(grant?.revocation?.nonce);
    expect(await store.getWrap(RELIC_ID, 2, readerKey)).toBeUndefined();
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
  });

  test('a grant committed between a revocation’s mark and its commit fails the revocation closed, and a retry completes it', async () => {
    const { owner, reader, versionKey } = await partialGrantFixture(true);
    const other = await person('grace@example.com');
    await registerIdentity(other);
    const real = store.updateRelic.bind(store);
    let armed = true;
    store.updateRelic = async (id, change) => {
      if (armed && id === RELIC_ID) {
        armed = false;
        const grant = await grantStatementFor(owner, other, [2]);
        const granted = await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(
            {
              attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
              wraps: [await wrap(other.keys!.kemPublicKey, versionKey, 2)],
            },
            owner.cookie
          )
        );
        expect(granted.status).toBe(201);
      }
      return real(id, change);
    };
    const refused = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(await revokeAtVersionTwo(owner, reader), owner.cookie)
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('version_conflict');
    expect((await store.getGrant(RELIC_ID, reader.identityId!))?.revokedAt).toBeDefined();
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, other.cookie)))
        .status
    ).toBe(200);
    const retried = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(await revokeAtVersionTwo(owner, reader), owner.cookie)
    );
    expect(retried.status).toBe(200);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, reader.cookie)))
        .status
    ).toBe(403);
    expect(
      (await send(`/api/relics/${RELIC_ID}/versions/2/key`, post({}, other.cookie)))
        .status
    ).toBe(200);
  });

  test('a regrant that writes its wrap between a revocation’s listing and its delete keeps the regrant’s wrap', async () => {
    const { owner, reader, versionKey } = await partialGrantFixture(true);
    const readerKey = (await store.getIdentity(reader.identityId!))!.kemKeyId;
    const real = store.deleteWrapIf.bind(store);
    const seen: { status?: number; wrap?: { enc: string; ct: string } } = {};
    store.deleteWrapIf = async (relicId, version, recipientKeyId, matches) => {
      if (seen.status === undefined && recipientKeyId === readerKey) {
        const grant = await grantStatementFor(owner, reader, [2]);
        const wrapped = await wrap(reader.keys!.kemPublicKey, versionKey, 2);
        seen.wrap = wrapped;
        const regranted = await send(
          `/api/relics/${RELIC_ID}/grants`,
          post(
            {
              attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
              wraps: [wrapped],
            },
            owner.cookie
          )
        );
        seen.status = regranted.status;
      }
      return real(relicId, version, recipientKeyId, matches);
    };
    const revoked = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(await revokeAtVersionTwo(owner, reader), owner.cookie)
    );
    expect(revoked.status).toBe(200);
    expect(seen.status).toBe(201);
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/2/key`,
      post({}, reader.cookie)
    );
    expect(key.status).toBe(200);
    const served = key.body['wrap'] as { enc: string; ct: string };
    expect(served.enc).toBe(seen.wrap!.enc);
    expect(served.ct).toBe(seen.wrap!.ct);
    expect((await store.getWrap(RELIC_ID, 2, readerKey))?.epoch).toBe(3);
  });

  test('a grant for a version other than the sealed one is refused before any row or wrap is written', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const { versionKey } = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    await store.updateRelic(RELIC_ID, (row) => ({
      ...row,
      version: 2,
      sealedVersion: 2,
    }));
    const grant = await grantStatementFor(owner, reader, [1]);
    const refused = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [grant]),
          wraps: [await wrap(reader.keys!.kemPublicKey, versionKey, 1)],
        },
        owner.cookie
      )
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('grant_stale_version');
    expect(await store.getGrant(RELIC_ID, reader.identityId!)).toBeUndefined();
    const readerKey = (await store.getIdentity(reader.identityId!))!.kemKeyId;
    expect(await store.getWrap(RELIC_ID, 1, readerKey)).toBeUndefined();
  });
});
