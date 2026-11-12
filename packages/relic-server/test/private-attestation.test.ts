import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { CreationOptionsJSON, RequestOptionsJSON } from '@relic/format';
import { assertConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { verifyAssertion, WebauthnError } from '../src/webauthn.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';

const ORIGIN = 'https://relic.example';
const RP_ID = 'relic.example';
const PRF_FIRST = Buffer.from('relic/identity-prf/v1').toString('base64url');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function creation(challenge: string, prf: boolean): CreationOptionsJSON {
  return {
    challenge,
    rp: { id: RP_ID, name: 'Relic' },
    user: {
      id: 'dXNlcg',
      name: 'owner@example.com',
      displayName: 'owner@example.com',
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 300_000,
    attestation: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    excludeCredentials: [],
    ...(prf ? { extensions: { prf: {} } } : {}),
  } as CreationOptionsJSON;
}

function request(
  credentialId: string,
  first: string
): RequestOptionsJSON & { challenge: string } {
  return {
    challenge: b64(randomBytes(32)),
    rpId: RP_ID,
    timeout: 300_000,
    userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: credentialId }],
    extensions: { prf: { eval: { first } } },
  } as RequestOptionsJSON & { challenge: string };
}

function prfResult(credential: {
  clientExtensionResults?: unknown;
}): string | undefined {
  const ext = credential.clientExtensionResults as
    | { prf?: { results?: { first?: string } } }
    | undefined;
  return ext?.prf?.results?.first;
}

describe('WebAuthn assertions carrying PRF output', () => {
  test('an assertion with the ED flag and an hmac-secret map verifies', async () => {
    const auth = await fakeAuthenticator({ hasPrf: true });
    await auth.register(creation(b64(randomBytes(32)), true), ORIGIN);
    const options = request(auth.credentialId, PRF_FIRST);
    const credential = await auth.assert(options, ORIGIN);

    const flags = Buffer.from(
      credential.response.authenticatorData,
      'base64url'
    )[32];
    expect((flags ?? 0) & 0x80).toBe(0x80);

    const verified = await verifyAssertion(credential, {
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: auth.credentialId,
        publicKeyJwk: auth.publicJwk,
        alg: -7,
      },
      userHandle: '',
    });
    expect(verified.credentialId).toBe(auth.credentialId);
  });

  test('an ED map that does not fill the authenticator data is malformed', async () => {
    const auth = await fakeAuthenticator({ hasPrf: true });
    await auth.register(creation(b64(randomBytes(32)), true), ORIGIN);
    const options = request(auth.credentialId, PRF_FIRST);
    const credential = await auth.assert(options, ORIGIN);
    const authData = Buffer.from(
      credential.response.authenticatorData,
      'base64url'
    );
    const tampered = {
      ...credential,
      response: {
        ...credential.response,
        authenticatorData: Buffer.concat([
          authData,
          Buffer.from([0x00]),
        ]).toString('base64url'),
      },
    };

    const failure = await verifyAssertion(tampered, {
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: auth.credentialId,
        publicKeyJwk: auth.publicJwk,
        alg: -7,
      },
      userHandle: '',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebauthnError);
    expect((failure as WebauthnError).kind).toBe('malformed');
  });

  test('PRF output differs by salt and exists only for a credential created with prf', async () => {
    const withPrf = await fakeAuthenticator({ hasPrf: true });
    await withPrf.register(creation(b64(randomBytes(32)), true), ORIGIN);
    const first = prfResult(
      await withPrf.assert(request(withPrf.credentialId, PRF_FIRST), ORIGIN)
    );
    const second = prfResult(
      await withPrf.assert(
        request(
          withPrf.credentialId,
          Buffer.from('another salt').toString('base64url')
        ),
        ORIGIN
      )
    );
    expect(Buffer.from(first ?? '', 'base64url').byteLength).toBe(32);
    expect(second).not.toBe(first);

    const withoutPrf = await fakeAuthenticator({ hasPrf: true });
    await withoutPrf.register(creation(b64(randomBytes(32)), false), ORIGIN);
    const none = await withoutPrf.assert(
      request(withoutPrf.credentialId, PRF_FIRST),
      ORIGIN
    );
    expect(prfResult(none)).toBeUndefined();
  });
});

describe('assertConfig: the usercontent origin under the RP ID', () => {
  const base = { ...DEFAULT_CONFIG, serviceOrigin: ORIGIN };

  test('a usercontent hostname beneath the RP ID is refused', () => {
    expect(() =>
      assertConfig({
        ...base,
        usercontentOrigin: 'https://frames.relic.example',
      })
    ).toThrow(/RP ID/);
  });

  test('a usercontent hostname equal to the RP ID is refused', () => {
    expect(() =>
      assertConfig({ ...base, usercontentOrigin: 'https://relic.example:8443' })
    ).toThrow(/distinct host|RP ID/);
  });

  test('a sibling registrable domain is accepted', () => {
    expect(() =>
      assertConfig({
        ...base,
        usercontentOrigin: 'https://relic-usercontent.example',
      })
    ).not.toThrow();
  });

  test('retention and TTL bounds are ordered', () => {
    expect(() => assertConfig({ ...base, privateDefaultTtlDays: 400 })).toThrow(
      /privateDefaultTtlDays/
    );
    expect(() =>
      assertConfig({ ...base, accessLogRetentionDefaultDays: 10 })
    ).toThrow(/retention/);
  });
});
