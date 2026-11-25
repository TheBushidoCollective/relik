import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyWebauthnAssertion } from '@relic/format/signing';
import { verifyAssertion } from '../src/webauthn.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';

const origin = 'https://relik.link';
const rpId = 'relik.link';
const challenge = 'Y2hhbGxlbmdl';
const handle = 'dXNlcg';

for (const alg of [-7, -257] as const) {
  test(`portable and server assertion verification agree for ${alg}`, async () => {
    const auth = await fakeAuthenticator({ alg, userHandle: handle });
    const valid = await auth.assert({ challenge, rpId }, origin);
    const expected = {
      challenge,
      origin,
      rpId,
      credentialId: auth.credentialId,
      publicKeyJwk: auth.publicJwk,
      alg,
    };
    const mutateClient = (patch: Record<string, unknown>) => {
      const copy = structuredClone(valid);
      const client = JSON.parse(
        Buffer.from(copy.response.clientDataJSON, 'base64url').toString()
      );
      return {
        ...copy,
        response: {
          ...copy.response,
          clientDataJSON: Buffer.from(
            JSON.stringify({ ...client, ...patch })
          ).toString('base64url'),
        },
      };
    };
    const mutateAuth = (fn: (bytes: Buffer) => Buffer) => {
      const copy = structuredClone(valid);
      return {
        ...copy,
        response: {
          ...copy.response,
          authenticatorData: fn(
            Buffer.from(copy.response.authenticatorData, 'base64url')
          ).toString('base64url'),
        },
      };
    };
    const flags = (value: number) =>
      mutateAuth((bytes) => {
        bytes[32] = value;
        return bytes;
      });
    const wrongSignature = {
      ...valid,
      response: { ...valid.response, signature: 'AA' },
    };
    const wrongCredential = { ...valid, id: 'YQ', rawId: 'YQ' };
    const vectors = [
      ['valid', valid, true],
      ['shape', { ...valid, type: 'wrong' }, false],
      [
        'encoding',
        { ...valid, response: { ...valid.response, clientDataJSON: '!!!' } },
        false,
      ],
      ['type', mutateClient({ type: 'webauthn.create' }), false],
      ['challenge', mutateClient({ challenge: 'wrong' }), false],
      ['origin', mutateClient({ origin: 'https://evil.test' }), false],
      ['cross origin', mutateClient({ crossOrigin: true }), false],
      ['credential', wrongCredential, false],
      [
        'rp id',
        mutateAuth((bytes) => {
          bytes[0] = (bytes[0] ?? 0) ^ 1;
          return bytes;
        }),
        false,
      ],
      ['user presence', flags(4), false],
      ['user verification', flags(1), false],
      ['attested data', flags(0x45), false],
      ['truncated data', mutateAuth((bytes) => bytes.subarray(0, 20)), false],
      [
        'trailing data',
        mutateAuth((bytes) => Buffer.concat([bytes, Buffer.from([0])])),
        false,
      ],
      [
        'invalid extensions',
        mutateAuth((bytes) => {
          bytes[32] = 0x85;
          return Buffer.concat([bytes, Buffer.from([0])]);
        }),
        false,
      ],
      ['signature', wrongSignature, false],
    ] as const;
    for (const [name, credential, accepted] of vectors) {
      const portable = await verifyWebauthnAssertion(credential, expected).then(
        () => true,
        () => false
      );
      const server = await verifyAssertion(credential, {
        challenge,
        origin,
        rpId,
        stored: expected,
        userHandle: handle,
      }).then(
        () => true,
        () => false
      );
      expect({ name, portable, server }).toEqual({
        name,
        portable: accepted,
        server: accepted,
      });
    }
  });
}

test('portable verifier is stricter on signed trailing authenticator data when ED is clear', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = Buffer.alloc(32, 7).toString('base64url');
  const client = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin })
  );
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([0x05, 0, 0, 0, 1, 0xff]),
  ]);
  const signed = Buffer.concat([
    authData,
    createHash('sha256').update(client).digest(),
  ]);
  const credential = {
    type: 'public-key',
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: client.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: sign('sha256', signed, pair.privateKey).toString('base64url'),
      userHandle: handle,
    },
  };
  const expected = {
    challenge,
    origin,
    rpId,
    credentialId,
    publicKeyJwk: pair.publicKey.export({ format: 'jwk' }) as JsonWebKey,
    alg: -7 as const,
  };
  await expect(
    verifyAssertion(credential, {
      challenge,
      origin,
      rpId,
      stored: expected,
      userHandle: handle,
    })
  ).resolves.toMatchObject({ credentialId });
  await expect(
    verifyWebauthnAssertion(credential, expected)
  ).rejects.toMatchObject({
    kind: 'malformed',
    check: 'auth_data',
  });
});

test('server checks the stored user handle, which the offline verifier does not possess', async () => {
  const auth = await fakeAuthenticator({ userHandle: handle });
  const credential = await auth.assert({ challenge, rpId }, origin);
  const expected = {
    challenge,
    origin,
    rpId,
    credentialId: auth.credentialId,
    publicKeyJwk: auth.publicJwk,
    alg: -7 as const,
  };
  await expect(
    verifyWebauthnAssertion(credential, expected)
  ).resolves.toBeUndefined();
  await expect(
    verifyAssertion(credential, {
      challenge,
      origin,
      rpId,
      stored: expected,
      userHandle: 'b3RoZXI',
    })
  ).rejects.toMatchObject({ kind: 'verification', check: 'user_handle' });
});

test('server checks the stored signature counter, which the offline verifier does not possess', async () => {
  const auth = await fakeAuthenticator({ userHandle: handle });
  const credential = await auth.assert({ challenge, rpId }, origin);
  const expected = {
    challenge,
    origin,
    rpId,
    credentialId: auth.credentialId,
    publicKeyJwk: auth.publicJwk,
    alg: -7 as const,
  };
  await expect(
    verifyWebauthnAssertion(credential, expected)
  ).resolves.toBeUndefined();
  await expect(
    verifyAssertion(credential, {
      challenge,
      origin,
      rpId,
      stored: { ...expected, signCount: 1 },
      userHandle: handle,
    })
  ).rejects.toMatchObject({ kind: 'verification', check: 'counter' });
});
