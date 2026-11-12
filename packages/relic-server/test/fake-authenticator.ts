/**
 * Fake WebAuthn authenticator for testing (spec §4.5).
 *
 * Implements Level 3 registration and assertion using WebCrypto,
 * a test CBOR encoder, and ASN.1 DER encoding.
 */

import { createHash, createHmac } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  CreationOptionsJSON,
  RegistrationResponseJSON,
  RequestOptionsJSON,
} from '@relic/format';
import { rawToDerEcdsa } from '../src/webauthn.ts';

/** Encode definite-length uint for CBOR major types. */
function encodeUint(majorType: number, val: number): Uint8Array {
  const m = majorType << 5;
  if (val <= 23) {
    return new Uint8Array([m | val]);
  }
  if (val <= 0xff) {
    return new Uint8Array([m | 24, val]);
  }
  if (val <= 0xffff) {
    return new Uint8Array([m | 25, (val >> 8) & 0xff, val & 0xff]);
  }
  if (val <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = m | 26;
    new DataView(buf.buffer, buf.byteOffset + 1, 4).setUint32(0, val, false);
    return buf;
  }
  const buf = new Uint8Array(9);
  buf[0] = m | 27;
  new DataView(buf.buffer, buf.byteOffset + 1, 8).setBigUint64(
    0,
    BigInt(val),
    false
  );
  return buf;
}

/** Encode JavaScript value into definite-length CBOR. */
export function encodeCbor(val: unknown): Uint8Array {
  if (typeof val === 'number') {
    if (val >= 0) return encodeUint(0, val);
    return encodeUint(1, -1 - val);
  }
  if (typeof val === 'string') {
    const b = Buffer.from(val, 'utf-8');
    return Buffer.concat([encodeUint(3, b.byteLength), b]);
  }
  if (val instanceof Uint8Array) {
    return Buffer.concat([encodeUint(2, val.byteLength), val]);
  }
  if (val instanceof Map) {
    const chunks: Uint8Array[] = [encodeUint(5, val.size)];
    for (const [k, v] of val) {
      chunks.push(encodeCbor(k), encodeCbor(v));
    }
    return Buffer.concat(chunks);
  }
  if (val === true) return new Uint8Array([0xf5]);
  if (val === false) return new Uint8Array([0xf4]);
  throw new Error(`unsupported CBOR type: ${typeof val}`);
}

export interface FakeAuthenticatorInit {
  alg?: -7 | -257;
  userVerified?: boolean;
  userPresent?: boolean;
  signCount?: number;
  credentialId?: string;
  userHandle?: string | null;
  /** A PRF-capable provider. Only a credential created with `prf` requested answers PRF at assertion. */
  hasPrf?: boolean;
}

export async function fakeAuthenticator(init?: FakeAuthenticatorInit): Promise<{
  register(
    o: CreationOptionsJSON,
    origin: string
  ): Promise<RegistrationResponseJSON>;
  assert(
    o: RequestOptionsJSON,
    origin: string,
    userHandleOverride?: string | null
  ): Promise<AuthenticationResponseJSON>;
  setSignCount(n: number): void;
  readonly credentialId: string;
  readonly publicJwk: JsonWebKey;
}> {
  const alg = init?.alg ?? -7;
  const userVerified = init?.userVerified ?? true;
  const userPresent = init?.userPresent ?? true;
  let currentSignCount = init?.signCount ?? 0;
  // PRF (WebAuthn `prf`, CTAP `hmac-secret`). Measured in Chrome 157 and
  // HeadlessChrome 149: a credential created without `prf` gives no PRF result,
  // and one created with it gives a result that differs by salt.
  const hasPrf = init?.hasPrf ?? false;
  const prfSecret = new Uint8Array(32);
  crypto.getRandomValues(prfSecret);
  let prfCapable = false;
  const credentialId =
    init?.credentialId ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'base64url'
    );

  let keyPair: CryptoKeyPair;
  if (alg === -7) {
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
  } else if (alg === -257) {
    keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
  } else {
    throw new Error(`Unsupported algorithm for fakeAuthenticator: ${alg}`);
  }

  const register = async (
    o: CreationOptionsJSON,
    origin: string
  ): Promise<RegistrationResponseJSON> => {
    const clientData = {
      type: 'webauthn.create',
      challenge: o.challenge,
      origin,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString(
      'base64url'
    );

    const rpIdHash = createHash('sha256').update(o.rp.id).digest();
    prfCapable = hasPrf && o.extensions?.prf !== undefined;
    const flags =
      (userPresent ? 0x01 : 0) |
      (userVerified ? 0x04 : 0) |
      0x40 |
      (prfCapable ? 0x80 : 0); // AT set; ED set when the hmac-secret map follows
    const signCountBuf = Buffer.alloc(4);
    signCountBuf.writeUInt32BE(currentSignCount, 0);
    const aaguid = Buffer.alloc(16, 0);
    const credIdBytes = Buffer.from(credentialId, 'base64url');
    const credIdLenBuf = Buffer.alloc(2);
    credIdLenBuf.writeUInt16BE(credIdBytes.byteLength, 0);

    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const coseMap = new Map<unknown, unknown>();

    if (alg === -7) {
      if (!jwk.x || !jwk.y) throw new Error('invalid EC key export');
      coseMap.set(1, 2); // kty: EC2
      coseMap.set(3, -7); // alg: ES256
      coseMap.set(-1, 1); // crv: P-256
      coseMap.set(-2, new Uint8Array(Buffer.from(jwk.x, 'base64url')));
      coseMap.set(-3, new Uint8Array(Buffer.from(jwk.y, 'base64url')));
    } else {
      if (!jwk.n || !jwk.e) throw new Error('invalid RSA key export');
      coseMap.set(1, 3); // kty: RSA
      coseMap.set(3, -257); // alg: RS256
      coseMap.set(-1, new Uint8Array(Buffer.from(jwk.n, 'base64url')));
      coseMap.set(-2, new Uint8Array(Buffer.from(jwk.e, 'base64url')));
    }

    const coseKeyBytes = encodeCbor(coseMap);
    // The registration extension map: `hmac-secret` advertised when PRF was created.
    const extensionBytes = prfCapable
      ? encodeCbor(new Map<unknown, unknown>([['hmac-secret', true]]))
      : new Uint8Array(0);
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCountBuf,
      aaguid,
      credIdLenBuf,
      credIdBytes,
      coseKeyBytes,
      Buffer.from(extensionBytes),
    ]);

    const attMap = new Map<unknown, unknown>();
    attMap.set('fmt', 'none');
    attMap.set('attStmt', new Map());
    attMap.set('authData', new Uint8Array(authData));

    const attestationObjectB64 = Buffer.from(encodeCbor(attMap)).toString(
      'base64url'
    );

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: prfCapable ? { prf: { enabled: true } } : {},
      response: {
        clientDataJSON,
        attestationObject: attestationObjectB64,
        transports: ['internal'],
      },
    };
  };

  const assert = async (
    o: RequestOptionsJSON,
    origin: string,
    userHandleOverride?: string | null
  ): Promise<AuthenticationResponseJSON> => {
    currentSignCount += 1;
    const clientData = {
      type: 'webauthn.get',
      challenge: o.challenge,
      origin,
      crossOrigin: false,
    };
    const clientDataRaw = Buffer.from(JSON.stringify(clientData));
    const clientDataJSON = clientDataRaw.toString('base64url');

    const rpIdHash = createHash('sha256').update(o.rpId).digest();
    let flags = (userPresent ? 0x01 : 0) | (userVerified ? 0x04 : 0);
    const signCountBuf = Buffer.alloc(4);
    signCountBuf.writeUInt32BE(currentSignCount, 0);
    // The PRF output for this assertion: HMAC over the WebAuthn salt, returned
    // in the authenticator data's extension map with ED set, as CTAP does.
    let prfOutput: Uint8Array | undefined;
    const prfFirst = o.extensions?.prf?.eval?.first;
    if (prfCapable && prfFirst !== undefined) {
      const salt = createHash('sha256')
        .update(
          Buffer.concat([
            Buffer.from('WebAuthn PRF'),
            Buffer.from([0]),
            Buffer.from(prfFirst, 'base64url'),
          ])
        )
        .digest();
      prfOutput = new Uint8Array(
        createHmac('sha256', prfSecret).update(salt).digest()
      );
      flags |= 0x80;
    }
    const extensionBytes =
      prfOutput === undefined
        ? new Uint8Array(0)
        : encodeCbor(new Map<unknown, unknown>([['hmac-secret', prfOutput]]));
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      signCountBuf,
      extensionBytes,
    ]);

    const clientDataHash = createHash('sha256').update(clientDataRaw).digest();
    const signedData = Buffer.concat([authData, clientDataHash]);

    let signatureB64: string;
    if (alg === -7) {
      const rawSig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        signedData
      );
      const derSig = rawToDerEcdsa(new Uint8Array(rawSig));
      signatureB64 = Buffer.from(derSig).toString('base64url');
    } else {
      const sigBytes = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        keyPair.privateKey,
        signedData
      );
      signatureB64 = Buffer.from(sigBytes).toString('base64url');
    }

    const userHandle =
      userHandleOverride !== undefined
        ? userHandleOverride
        : (init?.userHandle ?? null);

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON,
        authenticatorData: Buffer.from(authData).toString('base64url'),
        signature: signatureB64,
        userHandle,
      },
      clientExtensionResults:
        prfOutput === undefined
          ? {}
          : {
              prf: {
                results: {
                  first: Buffer.from(prfOutput).toString('base64url'),
                },
              },
            },
    };
  };

  return {
    register,
    publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
    assert,
    setSignCount(n: number) {
      currentSignCount = n;
    },
    credentialId,
  };
}
