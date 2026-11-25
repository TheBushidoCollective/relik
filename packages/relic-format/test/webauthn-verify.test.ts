import { describe, expect, test } from 'bun:test';
import { decodeBase64url, encodeBase64url } from '../src/private.ts';
import type { AuthenticationResponseJSON } from '../src/passkey.ts';
import {
  derToP1363,
  verifyWebauthnAssertion,
  WebauthnAssertionError,
} from '../src/webauthn-verify.ts';
import {
  virtualPasskey,
  type VirtualPasskey,
} from './support/virtual-passkey.ts';

const ORIGIN = 'https://relik.link';
const RP_ID = 'relik.link';
const CHALLENGE = encodeBase64url(
  new TextEncoder().encode('attestation challenge for tests')
);

/** The `hmac-secret` extension map, `{"hmac-secret": true}`, as CBOR. */
const HMAC_SECRET_MAP = Uint8Array.from([
  0xa1,
  0x6b,
  ...new TextEncoder().encode('hmac-secret'),
  0xf5,
]);

async function fixture(): Promise<{
  passkey: VirtualPasskey;
  expected: Parameters<typeof verifyWebauthnAssertion>[1];
}> {
  const passkey = await virtualPasskey();
  return {
    passkey,
    expected: {
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      publicKeyJwk: passkey.publicKeyJwk,
      alg: -7,
      credentialId: passkey.credentialId,
    },
  };
}

/** The refusal's kind and check. Fails the test if the assertion was accepted. */
async function refusal(
  promise: Promise<void>
): Promise<{ kind: string; check: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebauthnAssertionError) {
      return { kind: error.kind, check: error.check };
    }
    throw error;
  }
  throw new Error('the assertion was accepted');
}

/** The response fields a test may corrupt. The real type is read-only. */
function mutable(assertion: AuthenticationResponseJSON): {
  id: string;
  rawId: string;
  response: Record<string, string | null>;
} {
  return assertion as unknown as {
    id: string;
    rawId: string;
    response: Record<string, string | null>;
  };
}

describe('verifyWebauthnAssertion: accepts a real assertion', () => {
  test('an ES256 assertion with user presence and verification', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    await expect(
      verifyWebauthnAssertion(assertion, expected)
    ).resolves.toBeUndefined();
  });

  test('extension data that fills the rest of the authenticator data', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: HMAC_SECRET_MAP,
    });
    await expect(
      verifyWebauthnAssertion(assertion, expected)
    ).resolves.toBeUndefined();
  });
});

describe('verifyWebauthnAssertion: the refusals, each named', () => {
  test('a credential id other than the expected one is refused as a credential', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    const other = { ...expected, credentialId: 'AAAAAAAAAAAAAAAAAAAAAA' };
    expect(await refusal(verifyWebauthnAssertion(assertion, other))).toEqual({
      kind: 'verification',
      check: 'credential',
    });
  });

  test('a clientData type other than webauthn.get is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      type: 'webauthn.create',
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'type' }
    );
  });

  test('a challenge other than the one the statements committed to is refused (a replayed answer)', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: encodeBase64url(
        new TextEncoder().encode('an earlier challenge')
      ),
      origin: ORIGIN,
      rpId: RP_ID,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'challenge' }
    );
  });

  test('a wrong origin is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: 'https://evil.test',
      rpId: RP_ID,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'origin' }
    );
  });

  test('crossOrigin true is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      crossOrigin: true,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'cross_origin' }
    );
  });

  test('an rpIdHash for another relying party is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: 'evil.test',
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'rp_id' }
    );
  });

  test('user presence cleared is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x04,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'user_present' }
    );
  });

  test('user verification cleared is refused, even with a valid signature', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x01,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'user_verified' }
    );
  });

  test('the attested-credential flag set on an assertion is refused as malformed', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x45,
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'auth_data' }
    );
  });

  test('trailing bytes after the counter, with no extension flag, are refused as malformed', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      extensions: Uint8Array.from([1, 2, 3]),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'auth_data' }
    );
  });

  test('extension data that is not a CBOR map is refused as malformed', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.of(0x01),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });
  test('a CBOR integer beyond the safe integer range is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.of(
        0xa1,
        0x61,
        0x61,
        0x1b,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff
      ),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });

  test('extension data with trailing bytes after the map is refused (the walker stops exactly at the end)', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.from([...HMAC_SECRET_MAP, 0x00]),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });

  test('indefinite-length extension data is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.of(0xbf, 0x60, 0xf5, 0xff),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });

  test('a floating-point value in extension data is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.of(0xa1, 0x61, 0x61, 0xf9, 0x3c, 0x00),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });

  test('extension data nested deeper than sixteen levels is refused', async () => {
    const { passkey, expected } = await fixture();
    const nesting = new Uint8Array(17).fill(0x81);
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      flags: 0x85,
      extensions: Uint8Array.from([0xa1, 0x61, 0x61, ...nesting, 0x00]),
    });
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'extensions' }
    );
  });

  test('a signature with a bit flipped is refused', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    const bytes = decodeBase64url(assertion.response.signature);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    mutable(assertion).response.signature = encodeBase64url(bytes);
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'verification', check: 'signature' }
    );
  });

  test('a signature signed by another passkey is refused', async () => {
    const { passkey, expected } = await fixture();
    const other = await virtualPasskey();
    const assertion = await other.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    expect(
      await refusal(
        verifyWebauthnAssertion(assertion, {
          ...expected,
          credentialId: passkey.credentialId,
        })
      )
    ).toEqual({
      kind: 'verification',
      check: 'credential',
    });
    const relabelled = mutable(assertion);
    relabelled.id = passkey.credentialId;
    relabelled.rawId = passkey.credentialId;
    expect(
      await refusal(
        verifyWebauthnAssertion(assertion, {
          ...expected,
          credentialId: passkey.credentialId,
        })
      )
    ).toEqual({
      kind: 'verification',
      check: 'signature',
    });
  });

  test('a stored key that carries its private part is refused as a key', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const leaky = {
      ...expected,
      publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    };
    expect(await refusal(verifyWebauthnAssertion(assertion, leaky))).toEqual({
      kind: 'malformed',
      check: 'key',
    });
  });

  test('an ECDSA signature checked as RS256 is refused as a key, not a signature', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    expect(
      await refusal(
        verifyWebauthnAssertion(assertion, { ...expected, alg: -257 })
      )
    ).toEqual({ kind: 'malformed', check: 'key' });
  });

  test('a non-object credential is refused as a shape', async () => {
    const { expected } = await fixture();
    expect(
      await refusal(verifyWebauthnAssertion('not a credential', expected))
    ).toEqual({ kind: 'malformed', check: 'shape' });
  });

  test('clientDataJSON that is not base64url is refused as an encoding', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    mutable(assertion).response.clientDataJSON = '!!!!';
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'encoding' }
    );
  });

  test('clientDataJSON that is not a JSON object is refused as a shape', async () => {
    const { passkey, expected } = await fixture();
    const assertion = await passkey.assert({
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    mutable(assertion).response.clientDataJSON = encodeBase64url(
      new TextEncoder().encode('[1,2]')
    );
    expect(await refusal(verifyWebauthnAssertion(assertion, expected))).toEqual(
      { kind: 'malformed', check: 'shape' }
    );
  });
});

describe('derToP1363: the signature form browsers send', () => {
  test('a 33-byte integer with a sign pad converts to 32 bytes', () => {
    const r = Uint8Array.from([
      0x00,
      ...Array.from({ length: 32 }, (_, i) => 0x80 + i),
    ]);
    const s = Uint8Array.from([0x01, 0x02]);
    const der = Uint8Array.from([
      0x30,
      0x27,
      0x02,
      0x21,
      ...r,
      0x02,
      0x02,
      ...s,
    ]);
    const raw = derToP1363(der);
    expect(raw).toBeDefined();
    expect(raw?.length).toBe(64);
    expect(Array.from(raw?.subarray(0, 32) ?? [])).toEqual(
      Array.from(r.subarray(1))
    );
    expect(Array.from(raw?.subarray(32) ?? [])).toEqual([
      ...new Array(30).fill(0),
      0x01,
      0x02,
    ]);
  });

  test('trailing bytes after the sequence are refused', () => {
    expect(
      derToP1363(
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00])
      )
    ).toBeUndefined();
  });

  test('a value that is not a sequence is refused', () => {
    expect(
      derToP1363(
        Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])
      )
    ).toBeUndefined();
  });

  test('a sequence length shorter than its contents is refused, even when the bytes add up', () => {
    expect(
      derToP1363(
        Uint8Array.from([0x30, 0x05, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])
      )
    ).toBeUndefined();
  });

  test('a sequence that carries a byte after s, inside its declared length, is refused', () => {
    expect(
      derToP1363(
        Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00])
      )
    ).toBeUndefined();
  });
});
