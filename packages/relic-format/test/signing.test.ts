import { describe, expect, test } from 'bun:test';
import {
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  signStatement,
  statementBytes,
  parseStatement,
  verifyStatement,
} from '../src/private.ts';
import {
  type CertificateReport,
  openReceiptSha256,
  type CertificateVerifyOptions,
  contentMac,
  deriveSigningKey,
  openSignatureMark,
  openSigningLayout,
  parseSignatureMark,
  parseSigningCertificate,
  parseSigningLayout,
  sealSignatureMark,
  SIGN_CONSENT_TEXT,
  SigningInputError,
  type SigningRequestPayload,
  type SignatureRecordJSON,
  verifySignatureRecord,
  verifySigningCertificate,
  verifySigningRequest,
  type WebAuthnProofJSON,
} from '../src/signing.ts';
import type { IdentityPublicJSON } from '../src/private-wire.ts';
import type { SignatureStatement } from '../src/private.ts';
import {
  type Built,
  type BuildOptions,
  buildCertificate,
  clone,
  CONTENT,
  identityWire,
  RELIC_ID,
  VERSION,
} from './support/signing-builder.ts';
import type { SigningCertificateOwner } from '../src/signing.ts';
import type { IdentityKeys, OpenReceiptStatement } from '../src/private.ts';

type Obj = Record<string, unknown>;

// Independent Python hashlib, hmac, HKDF and AES-GCM known answers.
// Regenerate with test/support/signing-vectors.py (requires cryptography).
const CONTENT_KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const KAT = {
  signingKey:
    '0099549adf510cc2336695ac9f0bc399c7c2b56f3aa40540f36a67a7ca7dc083',
  contentMac:
    '266afbab329264d62eeb71d5f396383cea36c4e529015aa6b010810900494706',
  layoutSealed:
    'MDEyMzQ1Njc4OTo76hf-lZTkRjluKD36kkYSBTxOL3jJboseo6gtMvsPk1tZ8cVS_21AcelEgRk7wDieMBGwUM1tzLH6ZT0E0rhMhGmRn6KML0HdGi25B-uJIezgJ6sHmKUTX8o0NjaeFIZyFQ',
  markSealed:
    'QEFCQ0RFRkdISUpL0ik2GFgwjDKD0sjCqqFfbEyOvuXchUoith_Q4fHrxiQAjH-IOoMVqvw1PkFKNrbrXcY-AK3Rmm8',
};
const KAT_CONTENT = new TextEncoder().encode(
  'Studio lease, Unit 4B. The tenant pays on the first.'
);
const ORIGIN = 'https://relik.link';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function unhex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  );
}

/** Flip the last bit of a base64url value, keeping it valid base64url. */
function flipLast(text: string): string {
  const bytes = decodeBase64url(text);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
  return encodeBase64url(bytes);
}

function sig(cert: Obj, index: number): Obj {
  return (cert.signatures as Obj[])[index] as Obj;
}

function req(cert: Obj): Obj {
  return cert.request as Obj;
}

function failing(report: CertificateReport): string[] {
  return report.checks.filter((check) => !check.ok).map((check) => check.id);
}

async function readFixture(name: string): Promise<Obj> {
  return (await Bun.file(
    new URL(`./fixtures/signing/${name}.json`, import.meta.url)
  ).json()) as Obj;
}

async function signingKeyOf(): Promise<Uint8Array> {
  return deriveSigningKey(CONTENT_KEY);
}

describe('known answers', () => {
  test('the signing key is HKDF(content key, "relic/signing/v1")', async () => {
    expect(hex(await deriveSigningKey(CONTENT_KEY))).toBe(KAT.signingKey);
  });

  test('a content key that is not 16 bytes is refused', async () => {
    await expect(deriveSigningKey(new Uint8Array(15))).rejects.toThrow(
      'content key must be 16 bytes'
    );
  });

  test('the content MAC of a file is HMAC-SHA256 under the derived MAC key', async () => {
    expect(await contentMac(unhex(KAT.signingKey), KAT_CONTENT)).toBe(
      KAT.contentMac
    );
  });

  test('the content MAC is the same however the bytes are chunked or streamed', async () => {
    const key = unhex(KAT.signingKey);
    const chunks = [
      KAT_CONTENT.subarray(0, 7),
      KAT_CONTENT.subarray(7, 30),
      KAT_CONTENT.subarray(30),
    ];
    expect(await contentMac(key, chunks)).toBe(KAT.contentMac);
    async function* stream(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    }
    expect(await contentMac(key, stream())).toBe(KAT.contentMac);
  });

  test('a sealed layout opens to its known plaintext under the known key, relik and version', async () => {
    const layout = await openSigningLayout({
      signingKey: unhex(KAT.signingKey),
      relicId: RELIC_ID,
      version: VERSION,
      ciphertext: KAT.layoutSealed,
      signerCount: 1,
    });
    expect(layout).toEqual({
      v: 1,
      boxes: [
        { signer: 0, page: 2, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } },
      ],
    });
  });

  test('a sealed mark opens to its known name', async () => {
    const mark = await openSignatureMark({
      signingKey: unhex(KAT.signingKey),
      relicId: RELIC_ID,
      version: VERSION,
      ciphertext: KAT.markSealed,
    });
    expect(mark).toEqual({ v: 1, name: 'Ana Ruiz', strokes: null });
  });

  test('the consent text is the one the plan fixes, word for word', () => {
    expect(SIGN_CONSENT_TEXT).toBe(
      'I agree to sign this document electronically. My passkey approval is my signature on this exact version.'
    );
  });
});

describe('appearance sealing and its binding', () => {
  test('a mark round-trips, and two seals of one mark differ (fresh nonce)', async () => {
    const key = await signingKeyOf();
    const mark = {
      v: 1 as const,
      name: 'Ben Okafor',
      strokes: [[0.1, 0.2, 0.3, 0.4]],
    };
    const first = await sealSignatureMark({
      signingKey: key,
      relicId: RELIC_ID,
      version: VERSION,
      mark,
    });
    const second = await sealSignatureMark({
      signingKey: key,
      relicId: RELIC_ID,
      version: VERSION,
      mark,
    });
    expect(first).not.toBe(second);
    expect(
      await openSignatureMark({
        signingKey: key,
        relicId: RELIC_ID,
        version: VERSION,
        ciphertext: first,
      })
    ).toEqual(mark);
  });

  test('a sealed layout does not open under a different signing key', async () => {
    const other = await deriveSigningKey(new Uint8Array(16).fill(9));
    await expect(
      openSigningLayout({
        signingKey: other,
        relicId: RELIC_ID,
        version: VERSION,
        ciphertext: KAT.layoutSealed,
        signerCount: 1,
      })
    ).rejects.toThrow('did not open under this key');
  });

  test('a sealed appearance is bound to its relik: another relik refuses to open it', async () => {
    await expect(
      openSignatureMark({
        signingKey: unhex(KAT.signingKey),
        relicId: '0000000000000000000000000z',
        version: VERSION,
        ciphertext: KAT.markSealed,
      })
    ).rejects.toThrow('did not open');
  });

  test('a sealed appearance is bound to its version', async () => {
    await expect(
      openSignatureMark({
        signingKey: unhex(KAT.signingKey),
        relicId: RELIC_ID,
        version: 4,
        ciphertext: KAT.markSealed,
      })
    ).rejects.toThrow('did not open');
  });

  test('a sealed layout does not open as a mark, because the kind is in the AAD', async () => {
    await expect(
      openSignatureMark({
        signingKey: unhex(KAT.signingKey),
        relicId: RELIC_ID,
        version: VERSION,
        ciphertext: KAT.layoutSealed,
      })
    ).rejects.toThrow('did not open');
  });

  test('a tampered sealed mark is refused', async () => {
    const bytes = decodeBase64url(KAT.markSealed);
    bytes[20] = (bytes[20] ?? 0) ^ 0x80;
    await expect(
      openSignatureMark({
        signingKey: unhex(KAT.signingKey),
        relicId: RELIC_ID,
        version: VERSION,
        ciphertext: encodeBase64url(bytes),
      })
    ).rejects.toThrow('did not open');
  });

  test('text that is not base64url is refused as an appearance', async () => {
    await expect(
      openSignatureMark({
        signingKey: unhex(KAT.signingKey),
        relicId: RELIC_ID,
        version: VERSION,
        ciphertext: '!!',
      })
    ).rejects.toThrow('not base64url');
  });
});

describe('layout parsing', () => {
  const ok = {
    v: 1 as const,
    boxes: [{ signer: 0, page: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
  };

  test('a full-page box on a PDF parses', () => {
    expect(parseSigningLayout(ok, { signerCount: 1, pdf: true })).toEqual(ok);
  });

  test('boxes on a class that is not PDF are refused', () => {
    expect(() =>
      parseSigningLayout(ok, { signerCount: 1, pdf: false })
    ).toThrow(SigningInputError);
  });

  test('an empty layout parses on any class, the block after the document carries the signer', () => {
    expect(
      parseSigningLayout({ v: 1, boxes: [] }, { signerCount: 2, pdf: false })
    ).toEqual({ v: 1, boxes: [] });
  });

  test('a box that names a signer who does not exist is refused', () => {
    const box = {
      v: 1,
      boxes: [{ signer: 1, page: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
    };
    expect(() =>
      parseSigningLayout(box, { signerCount: 1, pdf: true })
    ).toThrow('signer');
  });

  test('a page outside 1 to 10000 is refused', () => {
    for (const page of [0, 10_001]) {
      const box = {
        v: 1,
        boxes: [{ signer: 0, page, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
      };
      expect(() =>
        parseSigningLayout(box, { signerCount: 1, pdf: true })
      ).toThrow('page');
    }
  });

  test('a rectangle with no area, or one that runs off the page, is refused', () => {
    for (const rect of [
      { x: 0, y: 0, w: 0, h: 0.5 },
      { x: 0.8, y: 0, w: 0.3, h: 0.5 },
      { x: 0, y: 0.9, w: 0.5, h: 0.2 },
      { x: 1.5, y: 0, w: 0.1, h: 0.1 },
    ]) {
      const box = { v: 1, boxes: [{ signer: 0, page: 1, rect }] };
      expect(() =>
        parseSigningLayout(box, { signerCount: 1, pdf: true })
      ).toThrow('rect');
    }
  });

  test('more than twenty boxes for one signer are refused', () => {
    const boxes = Array.from({ length: 21 }, () => ({
      signer: 0,
      page: 1,
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
    }));
    expect(() =>
      parseSigningLayout({ v: 1, boxes }, { signerCount: 1, pdf: true })
    ).toThrow('too many boxes');
  });

  test('an unknown field is refused, not ignored', () => {
    expect(() =>
      parseSigningLayout(
        { ...ok, colour: 'red' },
        { signerCount: 1, pdf: true }
      )
    ).toThrow('unknown field colour');
  });

  test('a version other than 1 is refused', () => {
    expect(() =>
      parseSigningLayout({ ...ok, v: 2 }, { signerCount: 1, pdf: true })
    ).toThrow('version');
  });
});

describe('mark parsing', () => {
  test('a typed name with no strokes parses', () => {
    expect(parseSignatureMark({ v: 1, name: 'Ana', strokes: null })).toEqual({
      v: 1,
      name: 'Ana',
      strokes: null,
    });
  });

  test('a name with a bidirectional override is refused', () => {
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana\u202Eevil', strokes: null })
    ).toThrow('name');
  });

  test('a name with a control character is refused', () => {
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana\u0007', strokes: null })
    ).toThrow('name');
  });

  test('an empty name, and one over 128 bytes, are refused', () => {
    expect(() => parseSignatureMark({ v: 1, name: '', strokes: null })).toThrow(
      'name'
    );
    expect(() =>
      parseSignatureMark({ v: 1, name: 'a'.repeat(129), strokes: null })
    ).toThrow('name');
    expect(
      parseSignatureMark({ v: 1, name: 'a'.repeat(128), strokes: null }).name
        .length
    ).toBe(128);
  });

  test('a stroke with an odd number of coordinates is refused', () => {
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana', strokes: [[0.1, 0.2, 0.3]] })
    ).toThrow('stroke');
  });

  test('a coordinate with more than three decimals, or outside [0,1], is refused', () => {
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana', strokes: [[0.1234, 0.2]] })
    ).toThrow('coordinate');
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana', strokes: [[1.5, 0.2]] })
    ).toThrow('coordinate');
  });

  test('more than sixty-four strokes, or more than 2048 points, are refused', () => {
    const many = Array.from({ length: 65 }, () => [0.1, 0.1]);
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana', strokes: many })
    ).toThrow('too many strokes');
    const long = Array.from({ length: 2 }, () => new Array(2 * 1025).fill(0.5));
    expect(() =>
      parseSignatureMark({ v: 1, name: 'Ana', strokes: long })
    ).toThrow('too many points');
  });
});

describe('golden certificates recorded from a virtual authenticator', () => {
  const options: CertificateVerifyOptions = { expectedOrigin: ORIGIN };

  test('a public relik signed in sequence verifies, and the signing key recovers the names', async () => {
    const cert = await readFixture('public-sequential');
    const report = await verifySigningCertificate(cert, {
      ...options,
      signingKey: unhex(KAT.signingKey),
      content: CONTENT,
    });
    expect(failing(report)).toEqual([]);
    expect(report.internal_consistency).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.access).toBe('public');
    expect(report.content).toBe('match');
    expect(report.signers.map((signer) => signer.name)).toEqual([
      'Signer 0',
      'Signer 1',
    ]);
    expect(report.signers.map((signer) => signer.opened)).toEqual([null, null]);
  });

  test('without the signing key the signatures still verify, and no name is shown', async () => {
    const report = await verifySigningCertificate(
      await readFixture('public-sequential'),
      options
    );
    expect(failing(report)).toEqual([]);
    expect(report.content).toBe('not_checked');
    expect(report.signers.map((signer) => signer.name)).toEqual([null, null]);
  });

  test('a private relik with opened receipts verifies and reports both readers opened it', async () => {
    const report = await verifySigningCertificate(
      await readFixture('private-opened'),
      {
        ...options,
        signingKey: unhex(KAT.signingKey),
        content: CONTENT,
      }
    );
    expect(failing(report)).toEqual([]);
    expect(report.signers.map((signer) => signer.opened)).toEqual([true, true]);
    expect(report.signers.map((signer) => signer.name)).toEqual([
      'Signer 0',
      'Signer 1',
    ]);
    expect(report.owner?.fingerprint).toHaveLength(64);
  });

  test('a private relik signed through a device verifies under the owner-signed device certificate', async () => {
    const report = await verifySigningCertificate(
      await readFixture('private-device'),
      options
    );
    expect(failing(report)).toEqual([]);
    expect(report.internal_consistency).toBe(true);
    expect(report.valid).toBe(false);
  });
});

/** Build a fresh valid certificate, change one thing, and report which checks now fail. */
async function mutate(
  options: BuildOptions,
  change: (cert: Obj, built: Built) => void | Promise<void>,
  verifyOptions: CertificateVerifyOptions = {}
): Promise<CertificateReport> {
  const built = await buildCertificate(options);
  const cert = clone(built.cert) as Obj;
  await change(cert, built);
  return verifySigningCertificate(cert, {
    expectedOrigin: ORIGIN,
    ...verifyOptions,
  });
}

describe('one mutation flips exactly its named check', () => {
  test('a valid certificate passes every check (the control for every mutation below)', async () => {
    const built = await buildCertificate({
      access: 'public',
      signers: 2,
      order: 'sequential',
    });
    const report = await verifySigningCertificate(built.cert, {
      expectedOrigin: ORIGIN,
      trustedOwnerIdentityId: built.owner.identityId,
      signingKey: built.signingKey,
      content: built.content,
    });
    expect(failing(report)).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.content).toBe('match');
  });

  test('a tampered top-level field is caught by request_statement', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      cert.version = 4;
    });
    expect(failing(report)).toEqual(['request_statement']);
    expect(report.valid).toBe(false);
  });

  test('a service origin that is not the relying-party host is caught by format', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      cert.service = { origin: 'https://evil.test', rp_id: 'relik.link' };
    });
    expect(failing(report)).toEqual(['format']);
  });

  test('an origin other than the expected one is caught by format', async () => {
    const report = await mutate(
      { access: 'public', signers: 1, origin: 'https://other.relik.test' },
      () => {},
      {
        expectedOrigin: ORIGIN,
      }
    );
    expect(failing(report)).toEqual(['format']);
    expect(report.valid).toBe(false);
  });

  test('a flipped bit in the owner signature is caught by request_signer', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      req(cert).signature = flipLast(req(cert).signature as string);
    });
    expect(failing(report)).toEqual(['request_signer']);
  });

  test('a flipped bit in the owner passkey assertion is caught by request_attestation', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      const credential = (req(cert).attestation as Obj).credential as {
        response: Obj;
      };
      credential.response.signature = flipLast(
        credential.response.signature as string
      );
    });
    expect(failing(report)).toEqual(['request_attestation']);
  });

  test('a signature list with one signer removed is caught by signers_complete', async () => {
    const report = await mutate(
      { access: 'public', signers: 2, order: 'parallel' },
      (cert) => {
        (cert.signatures as unknown[]).pop();
      }
    );
    expect(failing(report)).toContain('signers_complete');
    expect(report.valid).toBe(false);
  });

  test('a signature list with one signer repeated is caught by signers_complete', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      (cert.signatures as unknown[])[1] = clone(
        (cert.signatures as unknown[])[0]
      );
    });
    expect(failing(report)).toContain('signers_complete');
  });

  test('a signature naming another signer identity is caught by signature_identity', async () => {
    const report = await mutate({ access: 'private', signers: 2 }, (cert) => {
      sig(cert, 0).signer_identity = clone(sig(cert, 1).signer_identity);
    });
    expect(failing(report)).toContain('signature_identity');
    expect(report.valid).toBe(false);
  });

  test('a passkey assertion from another signer is caught by signature_webauthn (a wrong signer)', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      sig(cert, 0).webauthn = clone(sig(cert, 1).webauthn);
    });
    expect(failing(report)).toEqual(['signature_webauthn']);
    expect(report.checks.find((check) => !check.ok)?.signer_index).toBe(0);
  });

  test('a passkey nonce replayed onto another signature is caught by signature_webauthn', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      (sig(cert, 1).webauthn as Obj).nonce = (
        sig(cert, 0).webauthn as Obj
      ).nonce;
    });
    expect(failing(report)).toEqual(['signature_webauthn']);
    expect(report.checks.find((check) => !check.ok)?.signer_index).toBe(1);
  });

  test('a flipped bit in a signer passkey signature is caught by signature_webauthn', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      const credential = (sig(cert, 0).webauthn as Obj).credential as {
        response: Obj;
      };
      credential.response.signature = flipLast(
        credential.response.signature as string
      );
    });
    expect(failing(report)).toEqual(['signature_webauthn']);
  });

  test('a flipped bit in a private identity signature is caught by signature_identity', async () => {
    const report = await mutate({ access: 'private', signers: 1 }, (cert) => {
      sig(cert, 0).identity_signature = flipLast(
        sig(cert, 0).identity_signature as string
      );
    });
    expect(failing(report)).toEqual(['signature_identity']);
  });

  test('an identity signature on a public signature is refused by signature_identity', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      sig(cert, 0).identity_signature = 'AAAA';
    });
    expect(failing(report)).toEqual(['signature_identity']);
  });

  test('a mark swapped for another signer mark is caught by mark_hash', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      sig(cert, 0).mark_ciphertext = sig(cert, 1).mark_ciphertext;
    });
    expect(failing(report)).toEqual(['mark_hash']);
    expect(report.checks.find((check) => !check.ok)?.signer_index).toBe(0);
  });

  test('a signature that names the wrong signer email is caught by signature_binding, not hidden', async () => {
    const report = await mutate({ access: 'public', signers: 2 }, (cert) => {
      (sig(cert, 0).statement as Obj).signer_email = 'mallory@harbor.test';
    });
    expect(failing(report)).toContain('signature_binding');
    expect(report.valid).toBe(false);
  });

  test('a signature bound to another version is caught by signature_binding', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      (sig(cert, 0).statement as Obj).version = 9;
    });
    expect(failing(report)).toContain('signature_binding');
  });

  test('a signature for other content is caught by signature_binding', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      (sig(cert, 0).statement as Obj).content_mac = '0'.repeat(64);
    });
    expect(failing(report)).toContain('signature_binding');
  });

  test('a consent other than the one signed is refused when the statement is parsed', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      (sig(cert, 0).statement as Obj).consent = 'relic/sign-consent/v0';
    });
    expect(failing(report)).toContain('signature_statement');
  });

  test('a sequential request signed out of order is caught by order', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const report = await mutate(
      {
        access: 'public',
        signers: 2,
        order: 'sequential',
        signAt: [now + 120_000, now + 60_000],
      },
      () => {}
    );
    expect(failing(report)).toEqual(['order']);
    expect(report.valid).toBe(false);
  });

  test('a device certificate that expired before the request is caught by request_signer', async () => {
    const report = await mutate(
      {
        access: 'private',
        signers: 1,
        requestSigner: 'device',
        deviceNotAfter: 1,
      },
      () => {}
    );
    expect(failing(report)).toEqual(['request_signer']);
  });

  test('a required opened receipt that is missing is caught by opened_receipt', async () => {
    const report = await mutate(
      { access: 'private', signers: 2, requireOpened: true },
      (cert) => {
        (sig(cert, 1).receipts as Obj).opened = null;
      }
    );
    expect(failing(report)).toEqual(['opened_receipt']);
  });

  test('a receipt signature that does not verify is caught by opened_receipt', async () => {
    const report = await mutate(
      { access: 'private', signers: 1, requireOpened: true },
      (cert) => {
        const opened = (sig(cert, 0).receipts as Obj).opened as Obj;
        opened.identity_signature = flipLast(
          opened.identity_signature as string
        );
      }
    );
    expect(failing(report)).toEqual(['opened_receipt']);
  });

  test('a layout swapped for another is caught by request_statement', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      req(cert).layout_ciphertext = KAT.layoutSealed;
    });
    expect(failing(report)).toEqual(['request_statement']);
  });

  test('a mark ciphertext that does not open under the signing key is caught by appearance', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(built.cert) as Obj;
    const tampered = decodeBase64url(sig(cert, 0).mark_ciphertext as string);
    tampered[20] = (tampered[20] ?? 0) ^ 0x80;
    sig(cert, 0).mark_ciphertext = encodeBase64url(tampered);
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
      signingKey: built.signingKey,
    });
    expect(failing(report)).toEqual(['mark_hash', 'appearance']);
  });

  test('a wrong signing key is refused by appearance, and names are not shown', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const report = await verifySigningCertificate(built.cert, {
      expectedOrigin: ORIGIN,
      signingKey: new Uint8Array(32).fill(7),
    });
    expect(failing(report)).toEqual(['appearance']);
    expect(report.signers.map((signer) => signer.name)).toEqual([null]);
  });

  test('a file that is not the signed one is a content mismatch, not a passing check', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const report = await verifySigningCertificate(built.cert, {
      expectedOrigin: ORIGIN,
      signingKey: built.signingKey,
      content: new TextEncoder().encode(
        'Studio lease, Unit 4B. The tenant pays nothing at all.'
      ),
    });
    expect(report.content).toBe('mismatch');
    expect(failing(report)).toEqual(['content']);
    expect(report.valid).toBe(false);
  });

  test('a certificate whose top-level content MAC was edited no longer matches the signed request', async () => {
    const report = await mutate({ access: 'public', signers: 1 }, (cert) => {
      cert.content_mac = '1'.repeat(64);
    });
    expect(failing(report)).toEqual(['request_statement']);
  });
});

describe('the certificate parser refuses what it does not recognise', () => {
  test('a value that is not an object yields a report whose only check is format', async () => {
    const report = await verifySigningCertificate('not a certificate');
    expect(failing(report)).toEqual(['format']);
    expect(report.valid).toBe(false);
    expect(report.relic_id).toBeNull();
  });

  test('an unknown top-level field is refused', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    expect(() =>
      parseSigningCertificate({ ...built.cert, extra: true })
    ).toThrow('unknown field extra');
  });

  test('a private certificate that carries a title is refused', async () => {
    const built = await buildCertificate({ access: 'private', signers: 1 });
    expect(() =>
      parseSigningCertificate({ ...built.cert, title: 'Leaked' })
    ).toThrow('a private relik has no title');
  });

  test('a certificate with the wrong format string is refused', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    expect(() =>
      parseSigningCertificate({
        ...built.cert,
        format: 'relic/signing-certificate/v2',
      })
    ).toThrow('format');
  });

  test('a signature list that is missing is refused', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const { signatures: _omitted, ...rest } = built.cert;
    expect(() => parseSigningCertificate(rest)).toThrow('missing signatures');
  });

  test('a signer index that is negative is refused', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(built.cert) as Obj;
    sig(cert, 0).signer_index = -1;
    expect(() => parseSigningCertificate(cert)).toThrow('signer_index');
  });
});

describe('the per-record verifiers agree with the certificate verifier', () => {
  test('a valid signature record and request pass every per-record check', async () => {
    const built = await buildCertificate({
      access: 'private',
      signers: 1,
      requireOpened: true,
    });
    const cert = built.cert;
    const record = sig(cert, 0);
    const results = await verifySignatureRecord({
      request: req(cert) as unknown as SigningRequestPayload,
      record: {
        statement: record.statement as Obj,
        identity_signature: record.identity_signature as string,
        mark_ciphertext: record.mark_ciphertext as string,
        webauthn: record.webauthn as WebAuthnProofJSON,
        signer_identity: record.signer_identity as IdentityPublicJSON | null,
        opened_receipt: (record.receipts as Obj)
          .opened as SignatureRecordJSON['opened_receipt'],
      },
      origin: ORIGIN,
      rpId: 'relik.link',
    });
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.map((result) => result.id)).toContain('opened_receipt');
  });

  test('a valid request passes the request checks for its owner', async () => {
    const built = await buildCertificate({
      access: 'public',
      signers: 2,
      order: 'sequential',
    });
    const cert = built.cert;
    const results = await verifySigningRequest({
      request: req(cert) as unknown as SigningRequestPayload,
      owner: cert.owner as unknown as SigningCertificateOwner,
      expect: {
        access: 'public',
        relicId: RELIC_ID,
        version: VERSION,
        ciphertextSha256: cert.ciphertext_sha256 as string,
        contentMac: cert.content_mac as string,
        origin: ORIGIN,
        rpId: 'relik.link',
      },
    });
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });

  test('a signature record checked against another request is refused, with a name', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const other = await buildCertificate({ access: 'public', signers: 1 });
    const record = sig(built.cert, 0);
    const results = await verifySignatureRecord({
      request: req(other.cert) as unknown as SigningRequestPayload,
      record: {
        statement: record.statement as Obj,
        identity_signature: '',
        mark_ciphertext: record.mark_ciphertext as string,
        webauthn: record.webauthn as WebAuthnProofJSON,
        signer_identity: null,
        opened_receipt: null,
      },
      origin: ORIGIN,
      rpId: 'relik.link',
    });
    expect(
      results.find((result) => result.id === 'signature_binding')?.ok
    ).toBe(false);
  });
});

describe('the signature helper signs the bytes the verifier checks', () => {
  test('a signature statement made with a signer key verifies under that key', async () => {
    const built = await buildCertificate({ access: 'private', signers: 1 });
    const pair = built.signerKeys[0];
    if (pair === undefined) throw new Error('no signer key');
    const bytes = statementBytes(
      'signature',
      sig(built.cert, 0).statement as unknown as SignatureStatement
    );
    const signed = await signStatement(
      async (data) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.sig.privateKey,
            data.slice().buffer as ArrayBuffer
          )
        ),
      bytes
    );
    expect(decodeBase64url(signed).length).toBe(64);
    expect(await verifyStatement(pair.sigPublicKey, bytes, signed)).toBe(true);
  });
});

/** A signing function over one identity's signature key, in the shape `signStatement` takes. */
function signerSign(
  keys: IdentityKeys
): (bytes: Uint8Array) => Promise<Uint8Array> {
  return async (bytes) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.sig.privateKey,
        bytes.slice().buffer as ArrayBuffer
      )
    );
}

describe('the guards the review sweep found untested', () => {
  test('an origin with a path is refused by format, even when the host matches', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(built.cert) as Obj;
    cert.service = { origin: 'https://relik.link/x', rp_id: 'relik.link' };
    expect(failing(await verifySigningCertificate(cert))).toEqual(['format']);
  });

  test('a relying-party id that is not the origin host is refused by format, with no expected origin to catch it first', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(built.cert) as Obj;
    cert.service = { origin: 'https://evil.test', rp_id: 'relik.link' };
    expect(failing(await verifySigningCertificate(cert))).toEqual(['format']);
  });

  test('a receipt that verifies but is not the one the signature committed to is refused by opened_receipt', async () => {
    const built = await buildCertificate({
      access: 'private',
      signers: 1,
      requireOpened: true,
    });
    const pair = built.signerKeys[0];
    if (pair === undefined) throw new Error('no signer key');
    const cert = clone(built.cert) as Obj;
    const opened = (sig(cert, 0).receipts as Obj).opened as Obj;
    const statement = {
      ...(opened.statement as Obj),
      at: ((opened.statement as Obj).at as number) + 1,
    };
    opened.statement = statement;
    opened.identity_signature = await signStatement(
      signerSign(pair),
      statementBytes(
        'open_receipt',
        statement as unknown as OpenReceiptStatement
      )
    );
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
    });
    expect(failing(report)).toEqual(['opened_receipt']);
    expect(report.checks.find((check) => !check.ok)?.detail).toContain(
      'digest'
    );
  });

  test('a layout whose boxes are not a list is refused as a layout', () => {
    expect(() =>
      parseSigningLayout(
        { v: 1, boxes: 'one box' },
        { signerCount: 1, pdf: true }
      )
    ).toThrow(SigningInputError);
  });

  test('a request whose signer is not the owner is refused by request_signer, though the owner signed it', async () => {
    const built = await buildCertificate({
      access: 'public',
      signers: 1,
      signerIdOverride: 'f'.repeat(64),
    });
    expect(
      failing(
        await verifySigningCertificate(built.cert, { expectedOrigin: ORIGIN })
      )
    ).toEqual(['request_signer']);
  });

  test('a signature naming another signer identity is refused by signature_identity, though that signer signed it', async () => {
    const built = await buildCertificate({ access: 'private', signers: 2 });
    const other = built.signerKeys[1];
    if (other === undefined) throw new Error('no second signer');
    const cert = clone(built.cert) as Obj;
    const statement = parseStatement('signature', sig(cert, 0).statement);
    sig(cert, 0).signer_identity = identityWire(other, 'signer1@harbor.test');
    sig(cert, 0).identity_signature = await signStatement(
      signerSign(other),
      statementBytes('signature', statement)
    );
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
    });
    expect(failing(report)).toEqual(['signature_identity']);
    expect(report.checks.find((check) => !check.ok)?.detail).toContain(
      'pinned'
    );
  });

  test('a signer index outside the request is caught by signers_complete on its own', async () => {
    const built = await buildCertificate({ access: 'public', signers: 2 });
    const cert = clone(built.cert) as Obj;
    sig(cert, 1).signer_index = 5;
    expect(
      failing(await verifySigningCertificate(cert, { expectedOrigin: ORIGIN }))
    ).toContain('signers_complete');
  });
});

describe('request statement cross-checks in the format', () => {
  async function requestStatement(): Promise<Obj> {
    const built = await buildCertificate({ access: 'public', signers: 2 });
    return clone(req(built.cert).statement as Obj);
  }

  test('a request that names one address twice is refused', async () => {
    const statement = await requestStatement();
    statement.signers = [
      { email: 'ana@harbor.test', identity_id: null },
      { email: 'ana@harbor.test', identity_id: null },
    ];
    expect(() => parseStatement('signing_request', statement)).toThrow(
      'signers'
    );
  });

  test('a request that requires an opened receipt from an anonymous signer is refused', async () => {
    const statement = await requestStatement();
    statement.require_opened = true;
    expect(() => parseStatement('signing_request', statement)).toThrow(
      'require_opened'
    );
  });

  test('a request with no signers, or more than twenty, is refused', async () => {
    const statement = await requestStatement();
    statement.signers = [];
    expect(() => parseStatement('signing_request', statement)).toThrow('range');
    statement.signers = Array.from({ length: 21 }, (_, i) => ({
      email: `s${i}@harbor.test`,
      identity_id: null,
    }));
    expect(() => parseStatement('signing_request', statement)).toThrow('range');
  });

  test('a request id that is not exactly 16 bytes is refused', async () => {
    const statement = await requestStatement();
    for (const bytes of [15, 17]) {
      statement.request_id = encodeBase64url(new Uint8Array(bytes).fill(1));
      expect(() => parseStatement('signing_request', statement)).toThrow(
        'request_id'
      );
    }
  });
});

describe('a receipt names the identity that wrote it', () => {
  test('a receipt by another identity is refused by opened_receipt, even when the digest is re-committed', async () => {
    const built = await buildCertificate({
      access: 'private',
      signers: 2,
      requireOpened: true,
    });
    const [signer0, signer1] = built.signerKeys;
    const passkey0 = built.passkeys[0];
    if (
      signer0 === undefined ||
      signer1 === undefined ||
      passkey0 === undefined
    ) {
      throw new Error('fixture incomplete');
    }
    const cert = clone(built.cert) as Obj;
    const original = (sig(cert, 0).receipts as Obj).opened as Obj;
    const receipt = {
      ...(original.statement as Obj),
      reader_identity_id: signer1.identityId,
    } as unknown as OpenReceiptStatement;
    (sig(cert, 0).receipts as Obj).opened = {
      statement: { ...receipt },
      identity_signature: await signStatement(
        signerSign(signer1),
        statementBytes('open_receipt', receipt)
      ),
    };
    const statement = {
      ...parseStatement('signature', sig(cert, 0).statement),
      opened_receipt_sha256: openReceiptSha256(receipt),
    };
    sig(cert, 0).statement = { ...statement };
    sig(cert, 0).identity_signature = await signStatement(
      signerSign(signer0),
      statementBytes('signature', statement)
    );
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const credential = await passkey0.assert({
      challenge: encodeBase64url(
        await attestationChallenge(nonce, [
          statementBytes('signature', statement),
        ])
      ),
      origin: built.origin,
      rpId: built.rpId,
    });
    sig(cert, 0).webauthn = {
      ...(sig(cert, 0).webauthn as Obj),
      nonce: encodeBase64url(nonce),
      credential,
    };
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
    });
    expect(failing(report)).toEqual(['opened_receipt']);
    expect(report.checks.find((check) => !check.ok)?.detail).toContain(
      'another identity'
    );
  });
});

describe('an identity id is the hash of its keys', () => {
  test('a claimed owner identity that does not match its keys is refused by request_signer', async () => {
    const built = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(built.cert) as Obj;
    const owner = cert.owner as Obj;
    owner.identity = {
      ...(owner.identity as Obj),
      identity_id: 'f'.repeat(64),
    };
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
    });
    expect(failing(report)).toContain('request_signer');
    expect(
      report.checks.find((check) => check.id === 'request_signer')?.detail
    ).toContain('does not match its keys');
  });

  test('a claimed signer identity that does not match its keys is refused by signature_identity', async () => {
    const built = await buildCertificate({ access: 'private', signers: 1 });
    const cert = clone(built.cert) as Obj;
    sig(cert, 0).signer_identity = {
      ...(sig(cert, 0).signer_identity as Obj),
      identity_id: 'f'.repeat(64),
    };
    const report = await verifySigningCertificate(cert, {
      expectedOrigin: ORIGIN,
    });
    expect(failing(report)).toContain('signature_identity');
    expect(
      report.checks.find((check) => check.id === 'signature_identity')?.detail
    ).toContain('does not match its keys');
  });
});
