/**
 * Tests for minimal WebAuthn verifier (spec §4.5, §5).
 *
 * Verifies:
 *   - ES256 and RS256 registration and assertion round trips
 *   - ClientDataJSON extra keys accepted
 *   - DER conversion handling leading-zero r/s and short integers
 *   - Every 403 check rejected by name:
 *       challenge, type, origin, cross_origin, rp_id, user_present,
 *       user_verified, signature, counter, credential, user_handle
 *   - Every 400 check rejected by name:
 *       encoding, cbor, auth_data, algorithm, key, shape
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { CreationOptionsJSON, RequestOptionsJSON } from '@relic/format';
import {
  challengeOf,
  checkCounter,
  credentialIdOf,
  derToRawEcdsa,
  rawToDerEcdsa,
  verifyAssertion,
  verifyRegistration,
  WebauthnError,
} from '../src/webauthn.ts';
import { encodeCbor, fakeAuthenticator } from './fake-authenticator.ts';

const ORIGIN = 'https://relik.link';
const RP_ID = 'relik.link';
const USER_HANDLE = 'dGVzdC11c2VyLWhhbmRsZQ'; // base64url 'test-user-handle'

function creationOptions(challenge = 'Y2hhbGxlbmdlLTE'): CreationOptionsJSON {
  return {
    challenge,
    rp: { id: RP_ID, name: 'Relic' },
    user: {
      id: USER_HANDLE,
      name: 'alice@example.com',
      displayName: 'Alice',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
  };
}

function requestOptions(challenge = 'Y2hhbGxlbmdlLTI'): RequestOptionsJSON {
  return {
    challenge,
    rpId: RP_ID,
  };
}

/** Helper to assert a promise rejects with specific WebauthnError kind and check. */
async function expectWebauthnError(
  promise: Promise<unknown>,
  kind: 'malformed' | 'verification',
  check: string
): Promise<void> {
  try {
    await promise;
    expect.unreachable(
      `expected WebauthnError(${kind}, ${check}) but resolved`
    );
  } catch (err) {
    expect(err).toBeInstanceOf(WebauthnError);
    const we = err as WebauthnError;
    expect(we.kind).toBe(kind);
    expect(we.check).toBe(check);
  }
}

describe('WebAuthn verifier: Happy path round trips', () => {
  test('ES256 registration and assertion round trip passes', async () => {
    const auth = await fakeAuthenticator({ alg: -7 });
    const regOptions = creationOptions('reg-chal-1');
    const regCred = await auth.register(regOptions, ORIGIN);

    const regResult = await verifyRegistration(regCred, {
      challenge: 'reg-chal-1',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    expect(regResult.credentialId).toBe(auth.credentialId);
    expect(regResult.alg).toBe(-7);
    expect(regResult.signCount).toBe(0);
    expect(regResult.transports).toEqual(['internal']);
    expect(regResult.publicKeyJwk.kty).toBe('EC');
    expect(regResult.publicKeyJwk.crv).toBe('P-256');
    expect(typeof regResult.publicKeyJwk.x).toBe('string');
    expect(typeof regResult.publicKeyJwk.y).toBe('string');

    // Assertion round trip
    const assertOptions = requestOptions('assert-chal-1');
    const assertCred = await auth.assert(assertOptions, ORIGIN);

    const assertResult = await verifyAssertion(assertCred, {
      challenge: 'assert-chal-1',
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: regResult.credentialId,
        publicKeyJwk: regResult.publicKeyJwk,
        alg: regResult.alg,
        signCount: regResult.signCount,
      },
      userHandle: USER_HANDLE,
    });

    expect(assertResult.credentialId).toBe(auth.credentialId);
    expect(assertResult.signCount).toBe(1);

    // Second assertion advances sign count
    const assertCred2 = await auth.assert(
      requestOptions('assert-chal-2'),
      ORIGIN
    );
    const assertResult2 = await verifyAssertion(assertCred2, {
      challenge: 'assert-chal-2',
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: regResult.credentialId,
        publicKeyJwk: regResult.publicKeyJwk,
        alg: regResult.alg,
        signCount: assertResult.signCount,
      },
      userHandle: USER_HANDLE,
    });
    expect(assertResult2.signCount).toBe(2);
  });

  test('RS256 registration and assertion round trip passes', async () => {
    const auth = await fakeAuthenticator({ alg: -257 });
    const regOptions = creationOptions('reg-rsa-chal');
    const regCred = await auth.register(regOptions, ORIGIN);

    const regResult = await verifyRegistration(regCred, {
      challenge: 'reg-rsa-chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    expect(regResult.credentialId).toBe(auth.credentialId);
    expect(regResult.alg).toBe(-257);
    expect(regResult.signCount).toBe(0);
    expect(regResult.publicKeyJwk.kty).toBe('RSA');
    expect(typeof regResult.publicKeyJwk.n).toBe('string');
    expect(typeof regResult.publicKeyJwk.e).toBe('string');

    const assertOptions = requestOptions('assert-rsa-chal');
    const assertCred = await auth.assert(assertOptions, ORIGIN);

    const assertResult = await verifyAssertion(assertCred, {
      challenge: 'assert-rsa-chal',
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: regResult.credentialId,
        publicKeyJwk: regResult.publicKeyJwk,
        alg: regResult.alg,
      },
      userHandle: USER_HANDLE,
    });

    expect(assertResult.credentialId).toBe(auth.credentialId);
    expect(assertResult.signCount).toBe(1);
  });

  test('clientDataJSON carrying an extra random key is accepted', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('extra-reg'), ORIGIN);

    // Parse and mutate clientDataJSON with extra random key
    const clientData = JSON.parse(
      Buffer.from(regCred.response.clientDataJSON, 'base64url').toString(
        'utf-8'
      )
    );
    clientData['extraRandomKey'] = 'chrome-introduced-noise-12345';
    clientData['anotherField'] = { nested: true };

    const mutatedRegCred = {
      ...regCred,
      response: {
        ...regCred.response,
        clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
          'base64url'
        ),
      },
    };

    const regResult = await verifyRegistration(mutatedRegCred, {
      challenge: 'extra-reg',
      origin: ORIGIN,
      rpId: RP_ID,
    });
    expect(regResult.credentialId).toBe(auth.credentialId);

    // Also for assertion: extra keys in clientDataJSON must be accepted
    // Note: since signature signs sha256(clientDataJSON), we must resign with extra key
    const assertChal = 'extra-assert';
    const assertClientData = {
      type: 'webauthn.get',
      challenge: assertChal,
      origin: ORIGIN,
      crossOrigin: false,
      extraKeyFromBrowser: 42,
    };
    const assertClientDataBytes = Buffer.from(JSON.stringify(assertClientData));
    const assertClientDataB64 = assertClientDataBytes.toString('base64url');

    // Create valid authenticatorData
    const rpIdHash = createHash('sha256').update(RP_ID).digest();
    const flags = 0x01 | 0x04; // UP and UV
    const signCountBuf = Buffer.alloc(4);
    signCountBuf.writeUInt32BE(10, 0);
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCountBuf,
    ]);
    const clientDataHash = createHash('sha256')
      .update(assertClientDataBytes)
      .digest();
    const signedData = Buffer.concat([authData, clientDataHash]);

    // Sign with same key via WebCrypto generateKey
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const rawSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      signedData
    );
    const derSig = rawToDerEcdsa(new Uint8Array(rawSig));
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const assertCred = {
      id: 'cred-extra',
      rawId: 'cred-extra',
      type: 'public-key',
      response: {
        clientDataJSON: assertClientDataB64,
        authenticatorData: Buffer.from(authData).toString('base64url'),
        signature: Buffer.from(derSig).toString('base64url'),
        userHandle: null,
      },
    };

    const res = await verifyAssertion(assertCred, {
      challenge: assertChal,
      origin: ORIGIN,
      rpId: RP_ID,
      stored: {
        credentialId: 'cred-extra',
        publicKeyJwk: jwk,
        alg: -7,
      },
      userHandle: USER_HANDLE,
    });
    expect(res.credentialId).toBe('cred-extra');
    expect(res.signCount).toBe(10);
  });
});

describe('WebAuthn helper functions', () => {
  test('challengeOf extracts challenge unverified', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal-xyz'), ORIGIN);
    expect(challengeOf(regCred)).toBe('chal-xyz');

    const assertCred = await auth.assert(requestOptions('chal-abc'), ORIGIN);
    expect(challengeOf(assertCred)).toBe('chal-abc');
  });

  test('challengeOf throws malformed shape on non-object', () => {
    expect(() => challengeOf(null)).toThrow(WebauthnError);
    try {
      challengeOf('not-an-object');
    } catch (err) {
      expect((err as WebauthnError).kind).toBe('malformed');
      expect((err as WebauthnError).check).toBe('shape');
    }
  });

  test('credentialIdOf returns id when id === rawId', () => {
    const cred = { id: 'dGVzdA', rawId: 'dGVzdA', type: 'public-key' };
    expect(credentialIdOf(cred)).toBe('dGVzdA');
  });

  test('credentialIdOf throws malformed shape when id !== rawId', () => {
    const cred = { id: 'dGVzdDE', rawId: 'dGVzdDI', type: 'public-key' };
    expect(() => credentialIdOf(cred)).toThrow(WebauthnError);
    try {
      credentialIdOf(cred);
    } catch (err) {
      expect((err as WebauthnError).kind).toBe('malformed');
      expect((err as WebauthnError).check).toBe('shape');
    }
  });

  test('credentialIdOf throws malformed encoding on invalid base64url', () => {
    const cred = {
      id: 'bad+base64=',
      rawId: 'bad+base64=',
      type: 'public-key',
    };
    expect(() => credentialIdOf(cred)).toThrow(WebauthnError);
    try {
      credentialIdOf(cred);
    } catch (err) {
      expect((err as WebauthnError).kind).toBe('malformed');
      expect((err as WebauthnError).check).toBe('encoding');
    }
  });

  test('checkCounter throws verification counter on replay/rollback', () => {
    // new <= stored when either > 0
    expect(() => checkCounter(5, 5)).toThrow(WebauthnError);
    expect(() => checkCounter(5, 4)).toThrow(WebauthnError);
    expect(() => checkCounter(0, 0)).not.toThrow(); // authenticators with no counter stay 0
    expect(() => checkCounter(0, 1)).not.toThrow();
    expect(() => checkCounter(1, 2)).not.toThrow();
  });
});

describe('DER conversion handling: leading-zero r/s and short integers', () => {
  test('handles 33-byte r with leading 0x00 byte', async () => {
    // Construct DER with 33-byte r (0x00 leading) and 32-byte s
    const r33 = new Uint8Array(33);
    r33[0] = 0x00;
    r33.fill(0x85, 1);
    const s32 = new Uint8Array(32).fill(0x42);

    const derSeq = new Uint8Array(2 + 2 + 33 + 2 + 32);
    derSeq[0] = 0x30;
    derSeq[1] = derSeq.length - 2;
    derSeq[2] = 0x02;
    derSeq[3] = 33;
    derSeq.set(r33, 4);
    derSeq[4 + 33] = 0x02;
    derSeq[5 + 33] = 32;
    derSeq.set(s32, 6 + 33);

    const raw = derToRawEcdsa(derSeq);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(64);
    expect(raw?.[0]).toBe(0x85); // leading 0x00 stripped
    expect(raw?.[31]).toBe(0x85);
    expect(raw?.[32]).toBe(0x42);
  });

  test('handles 33-byte s with leading 0x00 byte', async () => {
    const r32 = new Uint8Array(32).fill(0x71);
    const s33 = new Uint8Array(33);
    s33[0] = 0x00;
    s33.fill(0x99, 1);

    const derSeq = new Uint8Array(2 + 2 + 32 + 2 + 33);
    derSeq[0] = 0x30;
    derSeq[1] = derSeq.length - 2;
    derSeq[2] = 0x02;
    derSeq[3] = 32;
    derSeq.set(r32, 4);
    derSeq[4 + 32] = 0x02;
    derSeq[5 + 32] = 33;
    derSeq.set(s33, 6 + 32);

    const raw = derToRawEcdsa(derSeq);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(64);
    expect(raw?.[0]).toBe(0x71);
    expect(raw?.[32]).toBe(0x99); // leading 0x00 stripped
    expect(raw?.[63]).toBe(0x99);
  });

  test('handles short r integer (< 32 bytes) with left zero-padding', async () => {
    // 31-byte r
    const r31 = new Uint8Array(31).fill(0x55);
    const s32 = new Uint8Array(32).fill(0x66);

    const derSeq = new Uint8Array(2 + 2 + 31 + 2 + 32);
    derSeq[0] = 0x30;
    derSeq[1] = derSeq.length - 2;
    derSeq[2] = 0x02;
    derSeq[3] = 31;
    derSeq.set(r31, 4);
    derSeq[4 + 31] = 0x02;
    derSeq[5 + 31] = 32;
    derSeq.set(s32, 6 + 31);

    const raw = derToRawEcdsa(derSeq);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(64);
    expect(raw?.[0]).toBe(0x00); // left padded with zero
    expect(raw?.[1]).toBe(0x55);
    expect(raw?.[31]).toBe(0x55);
    expect(raw?.[32]).toBe(0x66);
  });

  test('handles short s integer (< 32 bytes) with left zero-padding', async () => {
    const r32 = new Uint8Array(32).fill(0x11);
    const s30 = new Uint8Array(30).fill(0x22);

    const derSeq = new Uint8Array(2 + 2 + 32 + 2 + 30);
    derSeq[0] = 0x30;
    derSeq[1] = derSeq.length - 2;
    derSeq[2] = 0x02;
    derSeq[3] = 32;
    derSeq.set(r32, 4);
    derSeq[4 + 32] = 0x02;
    derSeq[5 + 32] = 30;
    derSeq.set(s30, 6 + 32);

    const raw = derToRawEcdsa(derSeq);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(64);
    expect(raw?.[0]).toBe(0x11);
    expect(raw?.[32]).toBe(0x00); // padded
    expect(raw?.[33]).toBe(0x00); // padded
    expect(raw?.[34]).toBe(0x22);
    expect(raw?.[63]).toBe(0x22);
  });

  test('real WebCrypto ECDSA signature verification with converted DER', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const msg = new TextEncoder().encode('message to verify');
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        msg
      )
    );

    // Convert raw to DER and then back to raw
    const der = rawToDerEcdsa(rawSig);
    const backToRaw = derToRawEcdsa(der);
    expect(backToRaw).not.toBeNull();
    expect(backToRaw).toEqual(rawSig);

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      backToRaw as unknown as BufferSource,
      msg
    );
    expect(ok).toBe(true);
  });
});

describe('All 403 verification checks (spec §4.3, §5)', () => {
  // Baseline valid authenticator
  test('check: challenge fails on challenge mismatch', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(
      creationOptions('expected-chal'),
      ORIGIN
    );

    // Registration challenge mismatch
    await expectWebauthnError(
      verifyRegistration(regCred, {
        challenge: 'wrong-chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'challenge'
    );

    // Assertion challenge mismatch
    const assertCred = await auth.assert(
      requestOptions('expected-chal-2'),
      ORIGIN
    );
    const regRes = await verifyRegistration(regCred, {
      challenge: 'expected-chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });
    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'wrong-chal-2',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: USER_HANDLE,
      }),
      'verification',
      'challenge'
    );
  });

  test('check: type fails on wrong clientDataJSON type', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    // Mutate registration clientDataJSON to webauthn.get
    const clientData = JSON.parse(
      Buffer.from(regCred.response.clientDataJSON, 'base64url').toString(
        'utf-8'
      )
    );
    clientData.type = 'webauthn.get';
    const badRegCred = {
      ...regCred,
      response: {
        ...regCred.response,
        clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
          'base64url'
        ),
      },
    };

    await expectWebauthnError(
      verifyRegistration(badRegCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'type'
    );

    // Mutate assertion clientDataJSON to webauthn.create
    const assertCred = await auth.assert(requestOptions('chal-2'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });
    const assertClientData = JSON.parse(
      Buffer.from(assertCred.response.clientDataJSON, 'base64url').toString(
        'utf-8'
      )
    );
    assertClientData.type = 'webauthn.create';
    const badAssertCred = {
      ...assertCred,
      response: {
        ...assertCred.response,
        clientDataJSON: Buffer.from(JSON.stringify(assertClientData)).toString(
          'base64url'
        ),
      },
    };

    await expectWebauthnError(
      verifyAssertion(badAssertCred, {
        challenge: 'chal-2',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: USER_HANDLE,
      }),
      'verification',
      'type'
    );
  });

  test('check: origin fails on origin mismatch', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    await expectWebauthnError(
      verifyRegistration(regCred, {
        challenge: 'chal',
        origin: 'https://attacker.site',
        rpId: RP_ID,
      }),
      'verification',
      'origin'
    );
  });

  test('check: cross_origin fails when crossOrigin is true', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    const clientData = JSON.parse(
      Buffer.from(regCred.response.clientDataJSON, 'base64url').toString(
        'utf-8'
      )
    );
    clientData.crossOrigin = true;
    const badCred = {
      ...regCred,
      response: {
        ...regCred.response,
        clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
          'base64url'
        ),
      },
    };

    await expectWebauthnError(
      verifyRegistration(badCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'cross_origin'
    );
  });

  test('check: rp_id fails on rpId hash mismatch', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    await expectWebauthnError(
      verifyRegistration(regCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: 'different-rp.com',
      }),
      'verification',
      'rp_id'
    );
  });

  test('check: user_present fails when UP bit (0x01) is not set', async () => {
    const auth = await fakeAuthenticator({ userPresent: false });
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    await expectWebauthnError(
      verifyRegistration(regCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'user_present'
    );
  });

  test('check: user_verified fails when UV bit (0x04) is not set', async () => {
    const auth = await fakeAuthenticator({ userVerified: false });
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    await expectWebauthnError(
      verifyRegistration(regCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'user_verified'
    );
  });

  test('check: signature fails on invalid/corrupted signature', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);
    // Corrupt signature bytes
    const sigBytes = Buffer.from(assertCred.response.signature, 'base64url');
    sigBytes[sigBytes.length - 2] = (sigBytes[sigBytes.length - 2] ?? 0) ^ 0xff;
    const badAssertCred = {
      ...assertCred,
      response: {
        ...assertCred.response,
        signature: sigBytes.toString('base64url'),
      },
    };

    await expectWebauthnError(
      verifyAssertion(badAssertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: USER_HANDLE,
      }),
      'verification',
      'signature'
    );
  });

  test('check: counter fails on replay or counter rollback', async () => {
    const auth = await fakeAuthenticator({ signCount: 5 });
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    // Authenticator assert produces signCount 6
    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);

    // Stored signCount is 10 (higher than authenticator's 6)
    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
          signCount: 10,
        },
        userHandle: USER_HANDLE,
      }),
      'verification',
      'counter'
    );
  });

  test('check: credential fails when credential id does not match stored', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);

    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: 'some-other-stored-credential-id',
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: USER_HANDLE,
      }),
      'verification',
      'credential'
    );

    // Registration: attested credential ID does not match credential.id
    const badRegCred = {
      ...regCred,
      id: 'YW5vdGhlci1jcmVkLWlk',
      rawId: 'YW5vdGhlci1jcmVkLWlk',
    };
    await expectWebauthnError(
      verifyRegistration(badRegCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'verification',
      'credential'
    );
  });

  test('check: user_handle fails when non-null userHandle does not match stored', async () => {
    const auth = await fakeAuthenticator({ userHandle: 'handle-alice' });
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });

    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);

    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: 'handle-bob', // Expected handle does not match handle-alice
      }),
      'verification',
      'user_handle'
    );
  });
});

describe('All 400 malformed checks (spec §4.3, §5)', () => {
  test('check: encoding fails on invalid base64url or invalid UTF-8', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    // Invalid base64url characters in clientDataJSON
    const badB64Cred = {
      ...regCred,
      response: {
        ...regCred.response,
        clientDataJSON: 'not!valid@base64url===',
      },
    };
    await expectWebauthnError(
      verifyRegistration(badB64Cred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'encoding'
    );

    // Invalid UTF-8 in clientDataJSON
    const badUtf8Bytes = new Uint8Array([0xff, 0xff, 0xff]);
    const badUtf8Cred = {
      ...regCred,
      response: {
        ...regCred.response,
        clientDataJSON: Buffer.from(badUtf8Bytes).toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyRegistration(badUtf8Cred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'encoding'
    );
  });

  test('check: cbor fails on invalid CBOR, floats, indefinite lengths, or depth > 16', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    // Truncated / malformed CBOR in attestationObject
    const badCborCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: Buffer.from([0xa5, 0x01]).toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyRegistration(badCborCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'cbor'
    );

    // CBOR with float (major type 7, ai 26: 32-bit float)
    const floatCbor = Buffer.from([0xfa, 0x40, 0x48, 0xf5, 0xc3]);
    const floatCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: floatCbor.toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyRegistration(floatCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'cbor'
    );

    // CBOR with indefinite length map (0xbf ... 0xff)
    const indefCbor = Buffer.from([0xbf, 0xff]);
    const indefCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: indefCbor.toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyRegistration(indefCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'cbor'
    );

    // CBOR with nesting depth > 16
    let deepCbor = Buffer.from([0x01]);
    for (let i = 0; i < 18; i++) {
      deepCbor = Buffer.concat([Buffer.from([0x81]), deepCbor]); // array of 1 item
    }
    const deepCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: deepCbor.toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyRegistration(deepCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'cbor'
    );
  });

  test('check: auth_data fails when authData is truncated or flags invalid', async () => {
    const auth = await fakeAuthenticator();
    const regCred = await auth.register(creationOptions('chal'), ORIGIN);

    // authData < 37 bytes in attestationObject
    const shortAuthData = Buffer.alloc(20, 0);
    const attMap = new Map<unknown, unknown>();
    attMap.set('fmt', 'none');
    attMap.set('attStmt', new Map());
    attMap.set('authData', new Uint8Array(shortAuthData));
    const shortAuthCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: Buffer.from(encodeCbor(attMap)).toString(
          'base64url'
        ),
      },
    };
    await expectWebauthnError(
      verifyRegistration(shortAuthCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'auth_data'
    );

    // Build authData without 0x40 AT flag
    const noAtAuthData = Buffer.alloc(60, 0);
    noAtAuthData.set(createHash('sha256').update(RP_ID).digest(), 0);
    noAtAuthData[32] = 0x01 | 0x04; // UP, UV, but NO AT
    const noAtAttMap = new Map<unknown, unknown>();
    noAtAttMap.set('fmt', 'none');
    noAtAttMap.set('attStmt', new Map());
    noAtAttMap.set('authData', new Uint8Array(noAtAuthData));
    const noAtCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: Buffer.from(encodeCbor(noAtAttMap)).toString(
          'base64url'
        ),
      },
    };
    await expectWebauthnError(
      verifyRegistration(noAtCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'auth_data'
    );

    // Assertion authData has AT flag set (must be clear)
    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);
    const regRes = await verifyRegistration(regCred, {
      challenge: 'chal',
      origin: ORIGIN,
      rpId: RP_ID,
    });
    const assertAuthData = Buffer.from(
      assertCred.response.authenticatorData,
      'base64url'
    );
    assertAuthData[32] = (assertAuthData[32] ?? 0) | 0x40; // Set AT bit in assertion
    const badAssertCred = {
      ...assertCred,
      response: {
        ...assertCred.response,
        authenticatorData: assertAuthData.toString('base64url'),
      },
    };
    await expectWebauthnError(
      verifyAssertion(badAssertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: regRes.credentialId,
          publicKeyJwk: regRes.publicKeyJwk,
          alg: regRes.alg,
        },
        userHandle: USER_HANDLE,
      }),
      'malformed',
      'auth_data'
    );

    // Registration authData with credIdLen > 1023
    const hugeCredIdAuthData = Buffer.alloc(60, 0);
    hugeCredIdAuthData.set(createHash('sha256').update(RP_ID).digest(), 0);
    hugeCredIdAuthData[32] = 0x01 | 0x04 | 0x40; // UP, UV, AT
    hugeCredIdAuthData.writeUInt16BE(1024, 53); // credIdLen 1024 > 1023
    const hugeAttMap = new Map<unknown, unknown>();
    hugeAttMap.set('fmt', 'none');
    hugeAttMap.set('attStmt', new Map());
    hugeAttMap.set('authData', new Uint8Array(hugeCredIdAuthData));
    const hugeCred = {
      ...regCred,
      response: {
        ...regCred.response,
        attestationObject: Buffer.from(encodeCbor(hugeAttMap)).toString(
          'base64url'
        ),
      },
    };
    await expectWebauthnError(
      verifyRegistration(hugeCred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'auth_data'
    );
  });

  test('check: algorithm fails on unsupported or malformed COSE algorithm', async () => {
    // Unsupported algorithm: EdDSA (-8)
    const coseMap = new Map<unknown, unknown>();
    coseMap.set(1, 1); // OKP
    coseMap.set(3, -8); // EdDSA
    coseMap.set(-1, 6); // Ed25519
    coseMap.set(-2, Buffer.alloc(32, 1));

    const rpIdHash = createHash('sha256').update(RP_ID).digest();
    const flags = 0x01 | 0x04 | 0x40;
    const signCountBuf = Buffer.alloc(4, 0);
    const aaguid = Buffer.alloc(16, 0);
    const credId = 'Y3JlZC0x';
    const credIdBytes = Buffer.from(credId, 'base64url');
    const credIdLenBuf = Buffer.alloc(2);
    credIdLenBuf.writeUInt16BE(credIdBytes.byteLength, 0);
    const coseBytes = encodeCbor(coseMap);

    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCountBuf,
      aaguid,
      credIdLenBuf,
      credIdBytes,
      coseBytes,
    ]);

    const attMap = new Map<unknown, unknown>();
    attMap.set('fmt', 'none');
    attMap.set('attStmt', new Map());
    attMap.set('authData', new Uint8Array(authData));

    const clientData = {
      type: 'webauthn.create',
      challenge: 'chal',
      origin: ORIGIN,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString(
      'base64url'
    );

    const cred = {
      id: credId,
      rawId: credId,
      type: 'public-key',
      response: {
        clientDataJSON,
        attestationObject: Buffer.from(encodeCbor(attMap)).toString(
          'base64url'
        ),
      },
    };

    await expectWebauthnError(
      verifyRegistration(cred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'algorithm'
    );

    // Assertion with unsupported stored algorithm
    const auth = await fakeAuthenticator();
    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);
    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: auth.credentialId,
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: '123' },
          alg: -8 as unknown as -7,
        },
        userHandle: USER_HANDLE,
      }),
      'malformed',
      'algorithm'
    );
  });

  test('check: key fails when public key is invalid', async () => {
    // COSE EC key with coordinates not on P-256 curve
    const coseMap = new Map<unknown, unknown>();
    coseMap.set(1, 2); // EC2
    coseMap.set(3, -7); // ES256
    coseMap.set(-1, 1); // P-256
    coseMap.set(-2, Buffer.alloc(32, 0xff)); // Point not on P-256 curve
    coseMap.set(-3, Buffer.alloc(32, 0xff));

    const rpIdHash = createHash('sha256').update(RP_ID).digest();
    const flags = 0x01 | 0x04 | 0x40;
    const signCountBuf = Buffer.alloc(4, 0);
    const aaguid = Buffer.alloc(16, 0);
    const credId = 'Y3JlZC1rZXktZmFpbA';
    const credIdBytes = Buffer.from(credId, 'base64url');
    const credIdLenBuf = Buffer.alloc(2);
    credIdLenBuf.writeUInt16BE(credIdBytes.byteLength, 0);
    const coseBytes = encodeCbor(coseMap);

    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCountBuf,
      aaguid,
      credIdLenBuf,
      credIdBytes,
      coseBytes,
    ]);

    const attMap = new Map<unknown, unknown>();
    attMap.set('fmt', 'none');
    attMap.set('attStmt', new Map());
    attMap.set('authData', new Uint8Array(authData));

    const clientData = {
      type: 'webauthn.create',
      challenge: 'chal',
      origin: ORIGIN,
      crossOrigin: false,
    };
    const cred = {
      id: credId,
      rawId: credId,
      type: 'public-key',
      response: {
        clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
          'base64url'
        ),
        attestationObject: Buffer.from(encodeCbor(attMap)).toString(
          'base64url'
        ),
      },
    };

    await expectWebauthnError(
      verifyRegistration(cred, {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'key'
    );

    // Assertion with stored publicKeyJwk that fails importKey
    const auth = await fakeAuthenticator();
    const assertCred = await auth.assert(requestOptions('chal-assert'), ORIGIN);
    await expectWebauthnError(
      verifyAssertion(assertCred, {
        challenge: 'chal-assert',
        origin: ORIGIN,
        rpId: RP_ID,
        stored: {
          credentialId: auth.credentialId,
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad' },
          alg: -7,
        },
        userHandle: USER_HANDLE,
      }),
      'malformed',
      'key'
    );
  });

  test('check: key fails for RS256 with stripped n < 256 bytes, n > 512 bytes, or e != 65537', async () => {
    function makeRsaCred(n: Uint8Array, e: Uint8Array) {
      const coseMap = new Map<unknown, unknown>();
      coseMap.set(1, 3); // RSA
      coseMap.set(3, -257); // RS256
      coseMap.set(-1, n);
      coseMap.set(-2, e);

      const rpIdHash = createHash('sha256').update(RP_ID).digest();
      const flags = 0x01 | 0x04 | 0x40;
      const signCountBuf = Buffer.alloc(4, 0);
      const aaguid = Buffer.alloc(16, 0);
      const credId = 'Y3JlZC1yc2EtdGVzdA';
      const credIdBytes = Buffer.from(credId, 'base64url');
      const credIdLenBuf = Buffer.alloc(2);
      credIdLenBuf.writeUInt16BE(credIdBytes.byteLength, 0);
      const coseBytes = encodeCbor(coseMap);

      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([flags]),
        signCountBuf,
        aaguid,
        credIdLenBuf,
        credIdBytes,
        coseBytes,
      ]);

      const attMap = new Map<unknown, unknown>();
      attMap.set('fmt', 'none');
      attMap.set('attStmt', new Map());
      attMap.set('authData', new Uint8Array(authData));

      const clientData = {
        type: 'webauthn.create',
        challenge: 'chal',
        origin: ORIGIN,
        crossOrigin: false,
      };
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        response: {
          clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString(
            'base64url'
          ),
          attestationObject: Buffer.from(encodeCbor(attMap)).toString(
            'base64url'
          ),
        },
      };
    }

    const validE = new Uint8Array([0x01, 0x00, 0x01]);

    // 1. Modulus is 256 bytes with leading 0 (255 bytes after strip < 256)
    const shortN = new Uint8Array(256);
    shortN[0] = 0x00;
    shortN.fill(0xaa, 1);
    await expectWebauthnError(
      verifyRegistration(makeRsaCred(shortN, validE), {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'key'
    );

    // 2. Modulus > 512 bytes (513 bytes)
    const hugeN = new Uint8Array(513);
    hugeN.fill(0xaa);
    await expectWebauthnError(
      verifyRegistration(makeRsaCred(hugeN, validE), {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'key'
    );

    // 3. Exponent != 65537 (e = 3)
    const validN = new Uint8Array(256);
    validN.fill(0xaa);
    const badE = new Uint8Array([0x03]);
    await expectWebauthnError(
      verifyRegistration(makeRsaCred(validN, badE), {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'key'
    );
  });

  test('check: shape fails on missing or invalid required envelope fields', async () => {
    // Non-object credential
    await expectWebauthnError(
      verifyRegistration('not-an-object', {
        challenge: 'chal',
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      'malformed',
      'shape'
    );

    // type !== 'public-key'
    await expectWebauthnError(
      verifyRegistration(
        { id: 'x', rawId: 'x', type: 'password', response: {} },
        { challenge: 'chal', origin: ORIGIN, rpId: RP_ID }
      ),
      'malformed',
      'shape'
    );

    // id !== rawId
    await expectWebauthnError(
      verifyRegistration(
        { id: 'id1', rawId: 'id2', type: 'public-key', response: {} },
        { challenge: 'chal', origin: ORIGIN, rpId: RP_ID }
      ),
      'malformed',
      'shape'
    );

    // clientDataJSON is invalid JSON
    await expectWebauthnError(
      verifyRegistration(
        {
          id: 'dGVzdA',
          rawId: 'dGVzdA',
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from('{not json').toString('base64url'),
            attestationObject: Buffer.from([0xa0]).toString('base64url'),
          },
        },
        { challenge: 'chal', origin: ORIGIN, rpId: RP_ID }
      ),
      'malformed',
      'shape'
    );

    // clientDataJSON is JSON array instead of object
    await expectWebauthnError(
      verifyRegistration(
        {
          id: 'dGVzdA',
          rawId: 'dGVzdA',
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from('["array"]').toString('base64url'),
            attestationObject: Buffer.from([0xa0]).toString('base64url'),
          },
        },
        { challenge: 'chal', origin: ORIGIN, rpId: RP_ID }
      ),
      'malformed',
      'shape'
    );
  });
});
