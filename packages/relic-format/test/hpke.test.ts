import { describe, expect, test } from 'bun:test';
import {
  decapsulate,
  encapsulate,
  type HpkeRecipient,
  HpkeOpenError,
  hpkeOpen,
  hpkeSeal,
  keySchedule,
} from '../src/hpke.ts';

// Copied from RFC 9180 Appendix A.3.1 (base setup) and A.3.1.1 (sequence 0)
// of https://www.rfc-editor.org/rfc/rfc9180.txt by a script that reads the RFC
// text. Not typed by hand.
const RFC9180_A31 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '4270e54ffd08d79d5928020af4686d8f6b7d35dbe470265f1f5aa22816ce860e',
  skEm: '4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb',
  pkEm: '04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
  skRm: 'f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2',
  pkRm: '04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0',
  enc: '04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
  shared_secret:
    'c0d26aeab536609a572b07695d933b589dcf363ff9d93c93adea537aeabb8cb8',
  secret: '2eb7b6bf138f6b5aff857414a058a3f1750054a9ba1f72c2cf0684a6f20b10e1',
  key: '868c066ef58aae6dc589b6cfdd18f97e',
  base_nonce: '4e0bc5018beba4bf004cca59',
  exporter_secret:
    '14ad94af484a7ad3ef40e9f3be99ecc6fa9036df9d4920548424df127ee0d99f',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  nonce: '4e0bc5018beba4bf004cca59',
  ct: '5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434',
} as const;

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

const hex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');
const buf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.slice().buffer as ArrayBuffer;

/** The RFC's fixed sender pair: skEm, with pkEm as its uncompressed point. */
async function fixedEphemeral(): Promise<CryptoKeyPair> {
  const pub = hex(RFC9180_A31.pkEm);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64(hex(RFC9180_A31.skEm)),
      x: b64(pub.slice(1, 33)),
      y: b64(pub.slice(33, 65)),
    },
    P256,
    false,
    ['deriveBits']
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    buf(pub),
    P256,
    true,
    []
  );
  return { privateKey, publicKey };
}

/** The RFC's fixed recipient: skRm with pkRm. */
async function rfcRecipient(): Promise<HpkeRecipient> {
  const publicKey = hex(RFC9180_A31.pkRm);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64(hex(RFC9180_A31.skRm)),
      x: b64(publicKey.slice(1, 33)),
      y: b64(publicKey.slice(33, 65)),
    },
    P256,
    false,
    ['deriveBits']
  );
  return recipientFrom(privateKey, publicKey);
}

function recipientFrom(
  privateKey: CryptoKey,
  publicKey: Uint8Array
): HpkeRecipient {
  return {
    publicKey,
    dh: async (peer) => {
      const peerKey = await crypto.subtle.importKey(
        'raw',
        buf(peer),
        P256,
        false,
        []
      );
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: peerKey },
          privateKey,
          256
        )
      );
    },
  };
}

async function freshRecipient(): Promise<HpkeRecipient> {
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey)
  );
  return recipientFrom(pair.privateKey, publicKey);
}

describe('HPKE against RFC 9180 Appendix A.3.1 (DHKEM P-256, HKDF-SHA256, AES-128-GCM, base mode)', () => {
  test('encapsulation reproduces enc and shared_secret', async () => {
    const { enc, sharedSecret } = await encapsulate({
      recipientPublicKey: hex(RFC9180_A31.pkRm),
      ephemeral: await fixedEphemeral(),
    });
    expect(toHex(enc)).toBe(RFC9180_A31.enc);
    expect(toHex(sharedSecret)).toBe(RFC9180_A31.shared_secret);
  });

  test('the key schedule reproduces secret-derived key, base_nonce and exporter_secret', async () => {
    const schedule = await keySchedule(
      hex(RFC9180_A31.shared_secret),
      hex(RFC9180_A31.info)
    );
    expect(toHex(schedule.key)).toBe(RFC9180_A31.key);
    expect(toHex(schedule.baseNonce)).toBe(RFC9180_A31.base_nonce);
    expect(toHex(schedule.exporterSecret)).toBe(RFC9180_A31.exporter_secret);
  });

  test('sequence 0 Seal reproduces enc and ct byte for byte', async () => {
    const sealed = await hpkeSeal({
      recipientPublicKey: hex(RFC9180_A31.pkRm),
      info: hex(RFC9180_A31.info),
      aad: hex(RFC9180_A31.aad),
      plaintext: hex(RFC9180_A31.pt),
      ephemeral: await fixedEphemeral(),
    });
    expect(toHex(sealed.enc)).toBe(RFC9180_A31.enc);
    expect(toHex(sealed.ct)).toBe(RFC9180_A31.ct);
  });

  test('Open with skRm recovers the RFC plaintext', async () => {
    const plaintext = await hpkeOpen({
      recipient: await rfcRecipient(),
      enc: hex(RFC9180_A31.enc),
      info: hex(RFC9180_A31.info),
      aad: hex(RFC9180_A31.aad),
      ct: hex(RFC9180_A31.ct),
    });
    expect(toHex(plaintext)).toBe(RFC9180_A31.pt);
  });

  test('decapsulation alone reproduces the RFC shared_secret', async () => {
    const shared = await decapsulate(
      await rfcRecipient(),
      hex(RFC9180_A31.enc)
    );
    expect(toHex(shared)).toBe(RFC9180_A31.shared_secret);
  });
});

describe('HPKE refusals', () => {
  async function openWith(overrides: {
    info?: Uint8Array;
    aad?: Uint8Array;
    ct?: Uint8Array;
    enc?: Uint8Array;
    recipient?: HpkeRecipient;
  }): Promise<unknown> {
    return hpkeOpen({
      recipient: overrides.recipient ?? (await rfcRecipient()),
      enc: overrides.enc ?? hex(RFC9180_A31.enc),
      info: overrides.info ?? hex(RFC9180_A31.info),
      aad: overrides.aad ?? hex(RFC9180_A31.aad),
      ct: overrides.ct ?? hex(RFC9180_A31.ct),
    });
  }

  function flipLastByte(bytes: Uint8Array): Uint8Array {
    const out = bytes.slice();
    const last = out.length - 1;
    out[last] = (out[last] ?? 0) ^ 0x01;
    return out;
  }

  test('a different info refuses', async () => {
    const info = hex(RFC9180_A31.info);
    const changed = new Uint8Array([...info, 0x00]);
    await expect(openWith({ info: changed })).rejects.toThrow(HpkeOpenError);
  });

  test('a different aad refuses', async () => {
    await expect(openWith({ aad: hex('436f756e742d31') })).rejects.toThrow(
      HpkeOpenError
    );
  });

  test('a tampered ciphertext refuses', async () => {
    await expect(
      openWith({ ct: flipLastByte(hex(RFC9180_A31.ct)) })
    ).rejects.toThrow(HpkeOpenError);
  });

  test('a different recipient refuses', async () => {
    await expect(
      openWith({ recipient: await freshRecipient() })
    ).rejects.toThrow(HpkeOpenError);
  });

  test('an enc that is not a P-256 point refuses', async () => {
    const enc = hex(RFC9180_A31.enc);
    const offCurve = enc.slice();
    offCurve[64] = (offCurve[64] ?? 0) ^ 0x01;
    await expect(openWith({ enc: offCurve })).rejects.toThrow(HpkeOpenError);
  });

  test('an enc of the wrong length refuses', async () => {
    await expect(
      openWith({ enc: hex(RFC9180_A31.enc).slice(0, 64) })
    ).rejects.toThrow(HpkeOpenError);
  });

  test('the refusal message is fixed and names no key or byte', async () => {
    const error = await openWith({
      ct: flipLastByte(hex(RFC9180_A31.ct)),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HpkeOpenError);
    expect((error as Error).message).toBe('HPKE open failed');
  });
});

describe('HPKE round trip with fresh keys', () => {
  test('seal then open returns the plaintext for the holder of the key only', async () => {
    const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey)
    );
    const recipient = recipientFrom(pair.privateKey, publicKey);
    const info = new TextEncoder().encode('round-trip info');
    const aad = new TextEncoder().encode('round-trip aad');
    const plaintext = new TextEncoder().encode('sixteen byte key');

    const sealed = await hpkeSeal({
      recipientPublicKey: publicKey,
      info,
      aad,
      plaintext,
    });
    const opened = await hpkeOpen({
      recipient,
      enc: sealed.enc,
      info,
      aad,
      ct: sealed.ct,
    });
    expect(new TextDecoder().decode(opened)).toBe('sixteen byte key');

    await expect(
      hpkeOpen({
        recipient: await freshRecipient(),
        enc: sealed.enc,
        info,
        aad,
        ct: sealed.ct,
      })
    ).rejects.toThrow(HpkeOpenError);
  });
});
