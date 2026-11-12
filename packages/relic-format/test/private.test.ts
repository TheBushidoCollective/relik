import { describe, expect, test } from 'bun:test';
import { RelicFormatError } from '../src/errors.ts';
import { hpkeOpen } from '../src/hpke.ts';
import {
  attestationChallenge,
  canonicalJson,
  decodeBase64url,
  decryptIdentityBundle,
  deriveKek,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  encryptIdentityBundle,
  fingerprintsEqual,
  formatFingerprint,
  generateIdentityKeys,
  type HpkeRecipient,
  identityFingerprint,
  identityIdOf,
  IdentityBundleError,
  type IdentityKeys,
  InvalidFingerprintError,
  InvalidStatementError,
  kemKeyIdOf,
  PRF_SALT,
  parseStatement,
  parseTypedFingerprint,
  signStatement,
  STATEMENT_KINDS,
  type StatementKind,
  type StatementMap,
  statementBytes,
  unwrapVersionKey,
  verifyStatement,
  WrapOpenError,
  wrapVersionKey,
} from '../src/private.ts';

// The keys below are the RFC 9180 A.3.1 fixed points (valid P-256 public keys,
// not secrets). Using them as identity keys makes every value below a
// deterministic function of public inputs.
const RFC_PK_RM = Buffer.from(
  '04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0',
  'hex'
);
const RFC_PK_EM = Buffer.from(
  '04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
  'hex'
);

const KEM_PUB = new Uint8Array(RFC_PK_RM);
const SIG_PUB = new Uint8Array(RFC_PK_EM);
const RELIC = '7k2m9qxah3tb0p4dvw8cr1nezf';
const CRED = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
const NONCE = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

// Known answers, computed once by an independent Python implementation
// (hashlib, hmac, and a separate Crockford encoder), then checked in.
const KAT = {
  kemKeyId: '8710cee59cfe355aed7b658ce51b8269ee732b1f70a97c25c7e9cece1e6b14aa',
  identityId:
    '61acd9e678454d81e039ee5b4ea6900d69cb3a47f8e25d5c53a5634462b7b787',
  deviceId: '48c39be2e6d41775e3662b5b1a283b5957da9eeed2e4e9c10a001e43e5c3134b',
  identityFingerprint: '6n6pv1j8q02nyw298frz0rkf91c7x9em',
  identityFingerprintDisplay: '6N6P V1J8 Q02N YW29 8FRZ 0RKF 91C7 X9EM',
  deviceFingerprint: 'zw109rh7xfqs7pfp74tzd9ttf9g4gk3f',
  attestationChallenge:
    '4dd6bd6a6e4d2ea5b5e7602ee2a461d9693eceffc2410a729c93241f70de7ae2',
  kekForPrfRange:
    '51de0f05ab295c8b47ec5af2b30929bf13cdf6fd2740cf8e5e0413692a3c9a08',
  prfSalt: '72656c69632f6964656e746974792d7072662f7631',
} as const;

/** SHA-256 of each statement's bytes, computed by the same Python run. */
const STATEMENT_SHA256: { readonly [K in StatementKind]: string } = {
  identity_register:
    '51b4d2bc4015d88e8f088cbc073ca5e60c7ee9d87449f636f7c74593ee927bb8',
  identity_bind:
    '91043cdd478f8651bd4bb406a9012ef77805a6a8687b96f5d990e4f8e3da3992',
  identity_settings:
    '8994a2699172de897fc6a40c44576356750e0cae7a8bb451b17b10d23d8d6009',
  access_request:
    '336c1a39f01ec70b323fa4b5c9c2e3da76f5fb38d4e8e4629a363e4bad998a56',
  grant: '34562fdb5e1fdfd87a55f6ec02a757411dba9d86348fbb435d41d2dcf6990c6b',
  revocation:
    '738a07dab901939870b67ee6f0ecaa5469176c943bf8550bdaa26a81e78a8ec6',
  republish: '8fd76c5a6a3a4e6f1cead1c7a24cc032d74a5decbecd6343ea438b0dcf974af3',
  delete: 'd832bafe0a0e22394eda80bd39399a52ba25e2d42b1886aca7effff43503a44d',
  device_cert:
    '83d52d43b53a09874b104e3cd49118f9b1d82dee974a55bf484030379f46bbca',
  device_revocation:
    '23d0e2a9ab65385995b9522857897a261a00fb45929a33676793292bd1f1a3d3',
  recovery_designation:
    '094223160307e232f85edc9e9412f34348b98ca60bd35a030b9f1c07cda8a894',
  seal: 'd339360e202cc96dc56106c14057c2810d21c2dbaede84f98d05b12b887ed6e8',
  device_enroll:
    'e66d593656ac8ef83f8a165312b37e8d673b39990f53dbbd0edc19168f0cb631',
  device_request:
    '0537bd3c1c3c3e5b73626eff784ca12ccd38970a50e543c2b3ee3557d6a7c017',
  owner_bind:
    '1ad3d9327bb97b46beeaa3554045fe7fef66e115b79149ab6bfed4dcb2c7df63',
  private_publish:
    '8b28eacc8c614029e6c3d3d4f496a3a2453a4655f598e4c527ae591fee743f5e',
};

const H = KAT.identityId;
const DEV = KAT.deviceId;
const PK_KEM = Buffer.from(KEM_PUB).toString('base64url');
const PK_SIG = Buffer.from(SIG_PUB).toString('base64url');
const NONCE_B64 = Buffer.from(NONCE).toString('base64url');
const CRED_B64 = Buffer.from(CRED).toString('base64url');

/** One valid sample per kind. The same values the Python run hashed. */
const SAMPLES: { readonly [K in StatementKind]: StatementMap[K] } = {
  identity_register: {
    at: 1767225600000,
    email: 'ada@example.com',
    identity_id: H,
    kem_public_key: PK_KEM,
    replaces: null,
    sig_public_key: PK_SIG,
  },
  identity_bind: { at: 1767225600001, credential_id: CRED_B64, identity_id: H },
  identity_settings: {
    access_log_retention_days: 2190,
    at: 1767225600002,
    identity_id: H,
  },
  access_request: {
    at: 1767225600003,
    relic_id: RELIC,
    requester_identity_id: H,
  },
  grant: {
    at: 1767225600004,
    fingerprint_typed: KAT.identityFingerprint,
    grantee_email: 'ada@example.com',
    grantee_identity_id: H,
    owner_identity_id: H,
    relic_id: RELIC,
    versions: [1, 2, 5],
  },
  revocation: {
    at: 1767225600005,
    grantee_identity_id: H,
    owner_identity_id: H,
    relic_id: RELIC,
  },
  republish: {
    at: 1767225600006,
    owner_identity_id: H,
    previous_version: 5,
    reason: 'rekey',
    relic_id: RELIC,
  },
  delete: {
    at: 1767225600007,
    owner_identity_id: H,
    relic_id: RELIC,
    versions: 'all',
  },
  device_cert: {
    at: 1767225600008,
    device_fingerprint_typed: KAT.deviceFingerprint,
    device_id: DEV,
    kem_public_key: PK_KEM,
    label: 'Mac mini',
    not_after: 1798761600000,
    owner_identity_id: H,
    sig_public_key: PK_SIG,
  },
  device_revocation: {
    at: 1767225600009,
    device_id: DEV,
    owner_identity_id: H,
  },
  recovery_designation: {
    at: 1767225600010,
    fingerprint_typed: KAT.identityFingerprint,
    owner_identity_id: H,
    recovery_email: 'ada@example.com',
    recovery_identity_id: H,
  },
  seal: {
    access_epoch: 3,
    at: 1767225600011,
    ciphertext_sha256:
      '305531dcc50ebca31cf1d5b31e9fc76ed51f66b3b6dd5a030c6539ae6532f979',
    owner_epoch: 4,
    recipient_key_ids: [
      KAT.kemKeyId,
      'd9298a10d1b0735837dc4bd85dac641b0f3cef27a47e5d53a54f2f3f5b2fcffa',
    ],
    relic_id: RELIC,
    signer_id: DEV,
    version: 5,
  },
  device_enroll: { at: 1767225600012, device_id: DEV, label: 'Mac mini' },
  device_request: {
    at: 1767225600013,
    body_sha256:
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    device_id: DEV,
    method: 'POST',
    nonce: NONCE_B64,
    path: `/api/relics/${RELIC}/versions`,
  },
  owner_bind: {
    at: 1767225600014,
    device_id: DEV,
    nonce: NONCE_B64,
    owner_identity_id: H,
    relic_id: RELIC,
  },
  private_publish: {
    at: 1767225600015,
    challenge_nonce: NONCE_B64,
    device_id: DEV,
    relic_id: RELIC,
    ttl_days: 30,
  },
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', asBuffer(bytes))).toString(
    'hex'
  );

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  // A copy into an array of its own. Buffer.slice is a view into the shared pool.
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

/** Flip the low bit of one byte. Buffer indexing is `number | undefined` under noUncheckedIndexedAccess. */
function flipBit(bytes: Buffer, index: number): void {
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
}

function sampleOf(kind: StatementKind): Record<string, unknown> {
  return { ...SAMPLES[kind] } as Record<string, unknown>;
}

/** The check a refused statement reports. Fails the test if the statement is accepted. */
function refusal(kind: StatementKind, value: unknown): string {
  try {
    parseStatement(kind, value);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStatementError);
    return (error as InvalidStatementError).check;
  }
  throw new Error(`${kind} was accepted`);
}

describe('canonicalJson', () => {
  test('sorts object keys, writes no whitespace, and keeps array order', () => {
    expect(canonicalJson({ b: [true, null, 'x'], a: 0 })).toBe(
      '{"a":0,"b":[true,null,"x"]}'
    );
  });

  test('writes negative zero as 0 and escapes strings as JSON does', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson('a"\n')).toBe('"a\\"\\n"');
  });

  test('refuses every value outside strings, booleans, null, safe integers, arrays and plain objects', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    const refused: unknown[] = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      undefined,
      { x: undefined },
      10n,
      new Map(),
      sparse,
    ];
    for (const value of refused) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });
});

describe('statementBytes', () => {
  test('is the prefix, the kind, and canonical JSON, exactly', () => {
    const text = new TextDecoder().decode(
      statementBytes('identity_bind', SAMPLES.identity_bind)
    );
    expect(text).toBe(
      `relic-statement/v1\nidentity_bind\n{"at":1767225600001,"credential_id":"${CRED_B64}","identity_id":"${H}"}`
    );
  });

  for (const kind of STATEMENT_KINDS) {
    test(`${kind}: matches its independently computed known answer`, async () => {
      expect(await sha256Hex(statementBytes(kind, SAMPLES[kind]))).toBe(
        STATEMENT_SHA256[kind]
      );
    });
  }

  test('covers every statement kind in the contract', () => {
    const expected: string[] = Object.keys(STATEMENT_SHA256).sort();
    expect([...STATEMENT_KINDS].map(String).sort()).toEqual(expected);
    expect(STATEMENT_KINDS.length).toBe(16);
  });
});

describe('parseStatement', () => {
  test('accepts the sample of every kind and returns it unchanged', () => {
    for (const kind of STATEMENT_KINDS) {
      expect(parseStatement(kind, SAMPLES[kind])).toEqual(SAMPLES[kind]);
    }
  });

  for (const kind of STATEMENT_KINDS) {
    test(`${kind}: refuses an extra key, a missing key, a float, and a wrong type`, () => {
      const sample = sampleOf(kind);
      expect(refusal(kind, { ...sample, bogus: 1 })).toBe('extra_key');

      const missing = { ...sample };
      delete missing[Object.keys(sample)[0] as string];
      expect(refusal(kind, missing)).toBe('missing_key');

      expect(refusal(kind, { ...sample, at: 1.5 })).toBe('type');

      const stringField = Object.keys(sample).find(
        (key) => typeof sample[key] === 'string'
      );
      expect(stringField).toBeDefined();
      expect(refusal(kind, { ...sample, [stringField as string]: 7 })).toBe(
        'type'
      );
    });

    test(`${kind}: refuses a value that is not a plain object`, () => {
      expect(refusal(kind, [])).toBe('type');
      expect(refusal(kind, null)).toBe('type');
      expect(refusal(kind, 'statement')).toBe('type');
    });
  }

  test('refuses an unknown kind by name only', () => {
    expect(() => parseStatement('nope' as StatementKind, {})).toThrow(
      InvalidStatementError
    );
  });

  test('refuses an own key named __proto__ as an extra key', () => {
    const withProto = JSON.parse(
      `${JSON.stringify(sampleOf('seal')).slice(0, -1)},"__proto__":1}`
    ) as unknown;
    expect(refusal('seal', withProto)).toBe('extra_key');
  });

  test('a recovery designation names all three parties or none', () => {
    expect(
      refusal('recovery_designation', {
        ...sampleOf('recovery_designation'),
        recovery_email: null,
      })
    ).toBe('designation');
    const removed = {
      ...sampleOf('recovery_designation'),
      fingerprint_typed: null,
      recovery_email: null,
      recovery_identity_id: null,
    };
    expect(() => parseStatement('recovery_designation', removed)).not.toThrow();
  });

  test('seal recipients are sorted and unique', () => {
    const unsorted = {
      ...sampleOf('seal'),
      recipient_key_ids: [KAT.kemKeyId, KAT.kemKeyId],
    };
    expect(refusal('seal', unsorted)).toBe('order');
    const empty = { ...sampleOf('seal'), recipient_key_ids: [] };
    expect(refusal('seal', empty)).toBe('format');
  });

  test('grant versions are ascending, unique and at least 1', () => {
    expect(refusal('grant', { ...sampleOf('grant'), versions: [2, 1] })).toBe(
      'order'
    );
    expect(refusal('grant', { ...sampleOf('grant'), versions: [1, 1] })).toBe(
      'order'
    );
    expect(refusal('grant', { ...sampleOf('grant'), versions: [] })).toBe(
      'format'
    );
    expect(refusal('grant', { ...sampleOf('grant'), versions: [0] })).toBe(
      'range'
    );
  });

  test('delete versions is "all" or an ascending list', () => {
    expect(() =>
      parseStatement('delete', { ...sampleOf('delete'), versions: [1, 3] })
    ).not.toThrow();
    expect(refusal('delete', { ...sampleOf('delete'), versions: 'some' })).toBe(
      'type'
    );
  });

  test('a label is 1 to 64 UTF-8 bytes with no control characters', () => {
    expect(
      refusal('device_enroll', { ...sampleOf('device_enroll'), label: '' })
    ).toBe('format');
    expect(
      refusal('device_enroll', {
        ...sampleOf('device_enroll'),
        label: 'a\nb',
      })
    ).toBe('format');
    expect(
      refusal('device_enroll', {
        ...sampleOf('device_enroll'),
        label: 'x'.repeat(65),
      })
    ).toBe('format');
    expect(() =>
      parseStatement('device_enroll', {
        ...sampleOf('device_enroll'),
        label: 'é'.repeat(32),
      })
    ).not.toThrow();
  });

  test('an email must already be in its normalized form', () => {
    expect(
      refusal('grant', {
        ...sampleOf('grant'),
        grantee_email: 'Ada@example.com',
      })
    ).toBe('format');
  });

  test('republish reason is the literal "rekey"', () => {
    expect(
      refusal('republish', { ...sampleOf('republish'), reason: 'rekey2' })
    ).toBe('format');
  });

  test('device requests carry an uppercase method and an absolute path', () => {
    expect(
      refusal('device_request', {
        ...sampleOf('device_request'),
        method: 'post',
      })
    ).toBe('format');
    expect(
      refusal('device_request', {
        ...sampleOf('device_request'),
        path: 'api/x',
      })
    ).toBe('format');
  });

  test('a public key must be a 65-byte uncompressed point', () => {
    const compressed = Buffer.from(KEM_PUB);
    compressed[0] = 0x03;
    expect(
      refusal('identity_register', {
        ...sampleOf('identity_register'),
        kem_public_key: compressed.toString('base64url'),
      })
    ).toBe('format');
    expect(
      refusal('identity_register', {
        ...sampleOf('identity_register'),
        kem_public_key: PK_KEM.slice(0, -2),
      })
    ).toBe('format');
  });

  test('a nonce is exactly 32 bytes of canonical base64url', () => {
    const short = encodeBase64url(new Uint8Array(31));
    expect(
      refusal('owner_bind', { ...sampleOf('owner_bind'), nonce: short })
    ).toBe('format');
    expect(
      refusal('owner_bind', {
        ...sampleOf('owner_bind'),
        nonce: `${NONCE_B64}=`,
      })
    ).toBe('format');
  });

  test('private_publish accepts the service challenge as an opaque token', () => {
    // The service issues 32 hex characters from POST /api/challenge.
    const hexChallenge = 'e511d0b9fe27c13a5c37f442ba4b5ddd';
    expect(() =>
      parseStatement('private_publish', {
        ...sampleOf('private_publish'),
        challenge_nonce: hexChallenge,
      })
    ).not.toThrow();
    // The base64url form of 32 bytes, as the other nonces use.
    expect(() =>
      parseStatement('private_publish', {
        ...sampleOf('private_publish'),
        challenge_nonce: NONCE_B64,
      })
    ).not.toThrow();
  });

  test('private_publish refuses an empty, over-long, padded, or non-alphabet challenge', () => {
    const challenge = (value: string) =>
      refusal('private_publish', {
        ...sampleOf('private_publish'),
        challenge_nonce: value,
      });
    expect(challenge('')).toBe('format');
    expect(challenge('a'.repeat(65))).toBe('format');
    expect(challenge(`${'a'.repeat(62)}==`)).toBe('format');
    expect(challenge('ab+cd')).toBe('format');
    expect(challenge(7 as unknown as string)).toBe('type');
  });

  test('the other nonce fields still require exactly 32 bytes', () => {
    expect(
      refusal('device_request', {
        ...sampleOf('device_request'),
        nonce: 'e511d0b9fe27c13a5c37f442ba4b5ddd',
      })
    ).toBe('format');
  });

  test('a hex identifier must be 64 lowercase characters', () => {
    expect(
      refusal('identity_bind', {
        ...sampleOf('identity_bind'),
        identity_id: H.toUpperCase(),
      })
    ).toBe('format');
    expect(
      refusal('identity_bind', {
        ...sampleOf('identity_bind'),
        identity_id: H.slice(1),
      })
    ).toBe('format');
  });

  test('InvalidStatementError names the check and the field, never a value', () => {
    let refused: InvalidStatementError | undefined;
    try {
      parseStatement('seal', { ...sampleOf('seal'), version: 0 });
    } catch (error) {
      refused = error as InvalidStatementError;
    }
    expect(refused).toBeInstanceOf(InvalidStatementError);
    expect(refused?.check).toBe('range');
    expect(refused?.field).toBe('version');
    expect(refused?.message).not.toContain(RELIC);
  });
});

describe('attestationChallenge', () => {
  test('matches the independently computed known answer over two statements', async () => {
    const challenge = await attestationChallenge(NONCE, [
      statementBytes('identity_register', SAMPLES.identity_register),
      statementBytes('grant', SAMPLES.grant),
    ]);
    expect(Buffer.from(challenge).toString('hex')).toBe(
      KAT.attestationChallenge
    );
  });

  test('changes when the statement order changes', async () => {
    const forward = await attestationChallenge(NONCE, [
      statementBytes('identity_bind', SAMPLES.identity_bind),
      statementBytes('grant', SAMPLES.grant),
    ]);
    const reversed = await attestationChallenge(NONCE, [
      statementBytes('grant', SAMPLES.grant),
      statementBytes('identity_bind', SAMPLES.identity_bind),
    ]);
    expect(Buffer.from(forward).toString('hex')).not.toBe(
      Buffer.from(reversed).toString('hex')
    );
  });

  test('refuses an empty statement list and a nonce that is not 32 bytes', async () => {
    await expect(attestationChallenge(NONCE, [])).rejects.toThrow(
      RelicFormatError
    );
    await expect(
      attestationChallenge(new Uint8Array(31), [new Uint8Array(1)])
    ).rejects.toThrow(RelicFormatError);
  });
});

describe('identifiers and fingerprints', () => {
  test('the KEM key ID, identity ID and device ID match the known answers', async () => {
    expect(Buffer.from(await kemKeyIdOf(KEM_PUB)).toString('hex')).toBe(
      KAT.kemKeyId
    );
    expect(await identityIdOf(KEM_PUB, SIG_PUB)).toBe(KAT.identityId);
    expect(await deviceIdOf(KEM_PUB, SIG_PUB)).toBe(KAT.deviceId);
  });

  test('identity and device IDs over the same keys differ by domain label', async () => {
    expect(await identityIdOf(KEM_PUB, SIG_PUB)).not.toBe(
      await deviceIdOf(KEM_PUB, SIG_PUB)
    );
  });

  test('the identity fingerprint matches the known answer and normalizes the email', async () => {
    const fp = await identityFingerprint(KAT.identityId, ' Ada@Example.COM ');
    expect(fp).toBe(KAT.identityFingerprint);
    expect(await identityFingerprint(KAT.identityId, 'ada@example.com')).toBe(
      fp
    );
  });

  test('the device fingerprint matches the known answer', async () => {
    expect(await deviceFingerprint(KAT.deviceId)).toBe(KAT.deviceFingerprint);
  });

  test('display form is uppercase, eight groups of four, single spaces', () => {
    expect(formatFingerprint(KAT.identityFingerprint)).toBe(
      KAT.identityFingerprintDisplay
    );
  });

  test('typed input folds spaces, hyphens, case and the aliases i, l and o', () => {
    const display = KAT.identityFingerprintDisplay;
    expect(parseTypedFingerprint(display)).toBe(KAT.identityFingerprint);
    expect(
      parseTypedFingerprint(display.toLowerCase().replace(/ /g, '-'))
    ).toBe(KAT.identityFingerprint);
    // "V1J8" typed with the letter l and "0RKF" with the letter O.
    const aliased = display.replace('V1J8', 'VlJ8').replace('0RKF', 'ORKF');
    expect(parseTypedFingerprint(aliased)).toBe(KAT.identityFingerprint);
  });

  test('typed input of the wrong length or with an absent letter is refused', () => {
    const fp = KAT.identityFingerprint;
    expect(parseTypedFingerprint(fp.slice(1))).toBeUndefined();
    expect(parseTypedFingerprint(`${fp}0`)).toBeUndefined();
    expect(parseTypedFingerprint('')).toBeUndefined();
    expect(parseTypedFingerprint(fp.replace('6', 'u'))).toBeUndefined();
    expect(parseTypedFingerprint(fp.replace('6', '!'))).toBeUndefined();
    expect(() => formatFingerprint(fp.slice(1))).toThrow(
      InvalidFingerprintError
    );
  });

  test('fingerprints compare for equality in constant time over equal lengths', () => {
    expect(
      fingerprintsEqual(KAT.identityFingerprint, KAT.identityFingerprint)
    ).toBe(true);
    expect(
      fingerprintsEqual(KAT.identityFingerprint, KAT.deviceFingerprint)
    ).toBe(false);
    expect(
      fingerprintsEqual(
        KAT.identityFingerprint,
        KAT.identityFingerprint.slice(1)
      )
    ).toBe(false);
  });
});

describe('PRF salt', () => {
  test('is UTF8 of relic/identity-prf/v1', () => {
    expect(Buffer.from(PRF_SALT).toString('hex')).toBe(KAT.prfSalt);
  });
});

describe('base64url', () => {
  test('round trips and refuses characters outside the alphabet', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255, 128]);
    expect(decodeBase64url(encodeBase64url(bytes))).toEqual(bytes);
    expect(() => decodeBase64url('ab+c')).toThrow(RelicFormatError);
    expect(() => decodeBase64url('ab=')).toThrow(RelicFormatError);
    expect(() => decodeBase64url('a')).toThrow(RelicFormatError);
  });

  test('refuses a non-canonical encoding of the same bytes', () => {
    // Zero trailing bits are canonical. "AB" would leave 0001 in the last byte.
    expect(decodeBase64url('AA')).toEqual(Uint8Array.of(0));
    expect(() => decodeBase64url('AB')).toThrow(RelicFormatError);
  });
});

function recipientOf(keys: IdentityKeys): HpkeRecipient {
  return {
    publicKey: keys.kemPublicKey,
    dh: async (peer) => {
      const peerKey = await crypto.subtle.importKey(
        'raw',
        asBuffer(peer),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: peerKey },
          keys.kem.privateKey,
          256
        )
      );
    },
  };
}

describe('version key wraps', () => {
  test('a wrap opens for its recipient and returns the 16-byte key', async () => {
    const keys = await generateIdentityKeys();
    const key = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await wrapVersionKey({
      recipientPublicKey: keys.kemPublicKey,
      relicId: RELIC,
      version: 5,
      key,
    });
    const opened = await unwrapVersionKey({
      recipient: recipientOf(keys),
      relicId: RELIC,
      version: 5,
      enc: wrap.enc,
      ct: wrap.ct,
    });
    expect(opened).toEqual(key);
  });

  test('the recipient key ID is the lowercase hex of the SHA-256 of the KEM public key', async () => {
    const keys = await generateIdentityKeys();
    const wrap = await wrapVersionKey({
      recipientPublicKey: keys.kemPublicKey,
      relicId: RELIC,
      version: 1,
      key: new Uint8Array(16),
    });
    const digest = await crypto.subtle.digest(
      'SHA-256',
      asBuffer(keys.kemPublicKey)
    );
    expect(wrap.recipientKeyId).toBe(Buffer.from(digest).toString('hex'));
  });

  test('the wrap is bound to "relic/wrap/v1", the relic ID, the version, and the key ID as AAD', async () => {
    const keys = await generateIdentityKeys();
    const key = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await wrapVersionKey({
      recipientPublicKey: keys.kemPublicKey,
      relicId: RELIC,
      version: 258,
      key,
    });
    // Built here from the spec, not from the implementation's helpers.
    const info = Buffer.concat([
      Buffer.from('relic/wrap/v1\u0000'),
      Buffer.from(RELIC),
      Buffer.from([0, 0, 1, 2]),
    ]);
    const aad = Buffer.from(
      await crypto.subtle.digest('SHA-256', asBuffer(keys.kemPublicKey))
    );
    const opened = await hpkeOpen({
      recipient: recipientOf(keys),
      enc: Buffer.from(wrap.enc, 'base64url'),
      info,
      aad,
      ct: Buffer.from(wrap.ct, 'base64url'),
    });
    expect(opened).toEqual(key);
  });

  test('refuses a wrong relic ID, a wrong version, a different recipient, and a tampered wrap', async () => {
    const keys = await generateIdentityKeys();
    const other = await generateIdentityKeys();
    const key = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await wrapVersionKey({
      recipientPublicKey: keys.kemPublicKey,
      relicId: RELIC,
      version: 5,
      key,
    });
    const open = (overrides: {
      relicId?: string;
      version?: number;
      recipient?: HpkeRecipient;
      enc?: string;
      ct?: string;
    }) =>
      unwrapVersionKey({
        recipient: recipientOf(keys),
        relicId: RELIC,
        version: 5,
        enc: wrap.enc,
        ct: wrap.ct,
        ...overrides,
      });

    await expect(
      open({ relicId: '0123456789abcdefghjkmnpqrs' })
    ).rejects.toThrow(WrapOpenError);
    await expect(open({ relicId: RELIC.toUpperCase() })).rejects.toThrow(
      WrapOpenError
    );
    await expect(open({ version: 6 })).rejects.toThrow(WrapOpenError);
    await expect(open({ recipient: recipientOf(other) })).rejects.toThrow(
      WrapOpenError
    );

    const ctBytes = Buffer.from(wrap.ct, 'base64url');
    flipBit(ctBytes, 0);
    await expect(open({ ct: ctBytes.toString('base64url') })).rejects.toThrow(
      WrapOpenError
    );

    const encBytes = Buffer.from(wrap.enc, 'base64url');
    flipBit(encBytes, encBytes.length - 1);
    await expect(open({ enc: encBytes.toString('base64url') })).rejects.toThrow(
      WrapOpenError
    );
  });

  test('a wrap of a key that is not 16 bytes is refused before any work', async () => {
    const keys = await generateIdentityKeys();
    await expect(
      wrapVersionKey({
        recipientPublicKey: keys.kemPublicKey,
        relicId: RELIC,
        version: 1,
        key: new Uint8Array(15),
      })
    ).rejects.toThrow(RelicFormatError);
  });

  test('a version outside 1 to 2^32 - 1 is refused', async () => {
    const keys = await generateIdentityKeys();
    for (const version of [0, -1, 1.5, 2 ** 32]) {
      await expect(
        wrapVersionKey({
          recipientPublicKey: keys.kemPublicKey,
          relicId: RELIC,
          version,
          key: new Uint8Array(16),
        })
      ).rejects.toThrow(RelicFormatError);
    }
  });
});

describe('identity bundles', () => {
  test('the KEK for a PRF output and credential ID matches the independent HKDF known answer', async () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => i);
    const credId = new Uint8Array(16).fill(0xaa);
    const keys = await generateIdentityKeys();
    const bundle = await encryptIdentityBundle(
      await deriveKek(prf, credId),
      keys,
      credId
    );

    // Decrypt with the raw known-answer KEK and the AAD written out from the spec.
    const rawKek = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(Buffer.from(KAT.kekForPrfRange, 'hex'))
        .buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const sealed = Buffer.from(bundle, 'base64url');
    const aad = Buffer.concat([
      Buffer.from('relic/identity-bundle/v1\u0000'),
      Buffer.from(keys.identityId, 'hex'),
      Buffer.from(credId),
    ]);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: asBuffer(sealed.subarray(0, 12)),
          additionalData: asBuffer(aad),
          tagLength: 128,
        },
        rawKek,
        asBuffer(sealed.subarray(12))
      )
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    expect(payload.v).toBe(1);
    expect(
      Buffer.from(keys.kemPublicKey.slice(1, 33)).toString('base64url')
    ).toBe(payload.kem.x);
    expect(
      Buffer.from(keys.sigPublicKey.slice(33, 65)).toString('base64url')
    ).toBe(payload.sig.y);
  });

  test('round trips and the decrypted signing key verifies against the original public key', async () => {
    const keys = await generateIdentityKeys();
    const credId = crypto.getRandomValues(new Uint8Array(20));
    const kek = await deriveKek(
      crypto.getRandomValues(new Uint8Array(32)),
      credId
    );
    const bundle = await encryptIdentityBundle(kek, keys, credId);
    const opened = await decryptIdentityBundle(
      kek,
      bundle,
      keys.identityId,
      credId
    );
    expect(opened.identityId).toBe(keys.identityId);
    expect(opened.kemPublicKey).toEqual(keys.kemPublicKey);

    const bytes = new TextEncoder().encode('sign with the reopened key');
    const signature = await signStatement(
      async (data) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            opened.sig.privateKey,
            asBuffer(data)
          )
        ),
      bytes
    );
    expect(await verifyStatement(keys.sigPublicKey, bytes, signature)).toBe(
      true
    );
  });

  test('a bundle refuses a different credential ID', async () => {
    const keys = await generateIdentityKeys();
    const credId = new Uint8Array(16).fill(1);
    const kek = await deriveKek(new Uint8Array(32).fill(2), credId);
    const bundle = await encryptIdentityBundle(kek, keys, credId);
    const otherCred = new Uint8Array(16).fill(3);
    await expect(
      decryptIdentityBundle(
        await deriveKek(new Uint8Array(32).fill(2), otherCred),
        bundle,
        keys.identityId,
        otherCred
      )
    ).rejects.toThrow(IdentityBundleError);
    await expect(
      decryptIdentityBundle(kek, bundle, keys.identityId, otherCred)
    ).rejects.toThrow(IdentityBundleError);
  });

  test('a bundle refuses a different identity ID', async () => {
    const keys = await generateIdentityKeys();
    const credId = new Uint8Array(16).fill(1);
    const kek = await deriveKek(new Uint8Array(32).fill(2), credId);
    const bundle = await encryptIdentityBundle(kek, keys, credId);
    await expect(
      decryptIdentityBundle(kek, bundle, KAT.identityId, credId)
    ).rejects.toThrow(IdentityBundleError);
  });

  test('a bundle refuses a KEK derived from another PRF output, and a tampered bundle', async () => {
    const keys = await generateIdentityKeys();
    const credId = new Uint8Array(16).fill(1);
    const kek = await deriveKek(new Uint8Array(32).fill(2), credId);
    const bundle = await encryptIdentityBundle(kek, keys, credId);
    const wrongKek = await deriveKek(new Uint8Array(32).fill(9), credId);
    await expect(
      decryptIdentityBundle(wrongKek, bundle, keys.identityId, credId)
    ).rejects.toThrow(IdentityBundleError);
    const tampered = Buffer.from(bundle, 'base64url');
    flipBit(tampered, 20);
    await expect(
      decryptIdentityBundle(
        kek,
        tampered.toString('base64url'),
        keys.identityId,
        credId
      )
    ).rejects.toThrow(IdentityBundleError);
  });

  test('a refused bundle error names no part of the bundle or of the key', async () => {
    const keys = await generateIdentityKeys();
    const credId = new Uint8Array(16).fill(1);
    const kek = await deriveKek(new Uint8Array(32).fill(2), credId);
    const bundle = await encryptIdentityBundle(kek, keys, credId);
    let refused: Error | undefined;
    try {
      await decryptIdentityBundle(
        kek,
        bundle,
        keys.identityId,
        new Uint8Array(16).fill(7)
      );
    } catch (error) {
      refused = error as Error;
    }
    expect(refused).toBeInstanceOf(IdentityBundleError);
    expect(refused?.message).not.toContain(bundle);
    expect(refused?.message).not.toContain(
      Buffer.from(keys.sigPublicKey).toString('hex')
    );
  });

  test('encryption refuses keys whose public halves do not hash to the claimed identity ID', async () => {
    const keys = await generateIdentityKeys();
    const credId = new Uint8Array(16).fill(1);
    const kek = await deriveKek(new Uint8Array(32).fill(2), credId);
    await expect(
      encryptIdentityBundle(
        kek,
        { ...keys, identityId: KAT.identityId },
        credId
      )
    ).rejects.toThrow(RelicFormatError);
  });
});

describe('signed statements', () => {
  test('a statement signed by the identity key verifies, and a change or another key refuses', async () => {
    const keys = await generateIdentityKeys();
    const other = await generateIdentityKeys();
    const bytes = statementBytes('identity_bind', SAMPLES.identity_bind);
    const sign = async (data: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.sig.privateKey,
          asBuffer(data)
        )
      );
    const signature = await signStatement(sign, bytes);
    expect(decodeBase64url(signature).length).toBe(64);

    expect(await verifyStatement(keys.sigPublicKey, bytes, signature)).toBe(
      true
    );
    const changed = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace('1767225600001', '1767225600002')
    );
    expect(await verifyStatement(keys.sigPublicKey, changed, signature)).toBe(
      false
    );
    expect(await verifyStatement(other.sigPublicKey, bytes, signature)).toBe(
      false
    );
  });

  test('a malformed signature verifies as false rather than throwing', async () => {
    const keys = await generateIdentityKeys();
    const bytes = statementBytes('identity_bind', SAMPLES.identity_bind);
    expect(
      await verifyStatement(keys.sigPublicKey, bytes, 'not base64url!')
    ).toBe(false);
    expect(
      await verifyStatement(
        keys.sigPublicKey,
        bytes,
        encodeBase64url(new Uint8Array(63))
      )
    ).toBe(false);
  });

  test('a signer that returns other than 64 bytes is refused', async () => {
    await expect(
      signStatement(async () => new Uint8Array(70), new Uint8Array(1))
    ).rejects.toThrow(RelicFormatError);
  });
});

describe('generated identities', () => {
  test('generated keys are 65-byte points whose identity ID is the hash of both', async () => {
    const keys = await generateIdentityKeys();
    expect(keys.kemPublicKey.length).toBe(65);
    expect(keys.sigPublicKey.length).toBe(65);
    expect(keys.kemPublicKey[0]).toBe(4);
    expect(keys.identityId).toBe(
      await identityIdOf(keys.kemPublicKey, keys.sigPublicKey)
    );
  });
});
