import { describe, expect, test, spyOn } from 'bun:test';
import {
  attestationChallenge,
  encodeBase64url,
  parseStatement,
  statementBytes,
} from '../src/private.ts';
import { verifySigningCertificate } from '../src/signing.ts';
import { buildCertificate, clone, ORIGIN } from './support/signing-builder.ts';

type MutableSignature = {
  signer_index: number;
  statement: unknown;
  signer_identity: { email: string };
  webauthn: { nonce: string; credential: { response: { signature: string } } };
};
type Obj = {
  owner: { identity: { email: string } };
  request: {
    statement: { signers: [{ identity_id: string }, { identity_id: string }] };
  };
  signatures: [MutableSignature, MutableSignature];
};

describe('certificate security boundaries', () => {
  test('unsigned slot relabeling cannot count one signature twice', async () => {
    const b = await buildCertificate({ access: 'public', signers: 2 });
    const cert = clone(b.cert) as Obj;
    cert.signatures[1] = clone(cert.signatures[0]);
    cert.signatures[1].signer_index = 1;
    const report = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(report.valid).toBe(false);
    expect(report.checks.find((c) => c.id === 'signers_complete')?.ok).toBe(
      false
    );
    expect(report.signers[1]?.signed_at).toBeNull();
  });
  test('unsigned relabeling cannot hide a sequential order violation', async () => {
    const b = await buildCertificate({
      access: 'public',
      signers: 2,
      order: 'sequential',
      signAt: [200, 100],
    });
    const cert = clone(b.cert) as Obj;
    cert.signatures[0].signer_index = 1;
    cert.signatures[1].signer_index = 0;
    const report = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(report.checks.find((c) => c.id === 'order')?.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'signers_complete')?.ok).toBe(
      false
    );
  });
  test('a signed out of range index fails completeness independently', async () => {
    const b = await buildCertificate({ access: 'public', signers: 2 });
    const cert = clone(b.cert) as Obj;
    const changed = {
      ...parseStatement('signature', cert.signatures[1].statement),
      signer_index: 5,
    };
    cert.signatures[1].statement = changed;
    cert.signatures[1].signer_index = 5;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    cert.signatures[1].webauthn.nonce = encodeBase64url(nonce);
    cert.signatures[1].webauthn.credential = await b.passkeys[1]!.assert({
      challenge: encodeBase64url(
        await attestationChallenge(nonce, [
          statementBytes('signature', changed),
        ])
      ),
      origin: ORIGIN,
      rpId: 'relik.link',
    });
    const report = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(report.checks.find((c) => c.id === 'signers_complete')?.ok).toBe(
      false
    );
  });
  test('owner pin controls trust, and unsigned email remains a claim', async () => {
    const b = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(b.cert) as Obj;
    cert.owner.identity.email = 'impostor@example.com';
    const unchecked = await verifySigningCertificate(cert);
    expect(unchecked.internal_consistency).toBe(true);
    expect(unchecked.valid).toBe(false);
    expect(unchecked.trust.owner).toBe('unchecked');
    expect(unchecked.owner?.email_status).toBe('claimed');
    expect(unchecked.owner?.fingerprint).toBe(b.owner.identityId);
    const matched = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(matched.valid).toBe(true);
    expect(matched.trust.owner).toBe('matches');
    const wrong = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: 'f'.repeat(64),
    });
    expect(wrong.valid).toBe(false);
    expect(wrong.trust.owner).toBe('mismatch');
    expect(matched.trust.signers[0]?.method).toBe('trust_on_first_use');
  });
  test('private signer identity and address are unique and pinned', async () => {
    const b = await buildCertificate({ access: 'private', signers: 2 });
    const cert = clone(b.cert) as Obj;
    cert.request.statement.signers[1].identity_id =
      cert.request.statement.signers[0].identity_id;
    expect(() =>
      parseStatement('signing_request', cert.request.statement)
    ).toThrow();
    const other = clone(b.cert) as Obj;
    other.signatures[0].signer_identity.email = 'impostor@example.com';
    const report = await verifySigningCertificate(other, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(
      report.checks.find(
        (c) => c.id === 'signature_identity' && c.signer_index === 0
      )?.ok
    ).toBe(false);
    const wrongPin = await verifySigningCertificate(b.cert, {
      trustedOwnerIdentityId: b.owner.identityId,
      trustedSignerIdentityIds: { 0: 'f'.repeat(64) },
    });
    expect(wrongPin.trust.signers[0]?.status).toBe('mismatch');
    expect(wrongPin.valid).toBe(false);
  });
  test('ten thousand records are rejected before any cryptographic verification', async () => {
    const b = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(b.cert) as Obj;
    cert.signatures = Array(10000).fill(
      cert.signatures[0]
    ) as Obj['signatures'];
    const spy = spyOn(crypto.subtle, 'verify');
    try {
      const report = await verifySigningCertificate(cert);
      expect(report.checks[0]?.id).toBe('format');
      expect(report.checks[0]?.detail).toContain('too many signatures');
      expect(report.valid).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  test('oversized individual proof fields are rejected before verification', async () => {
    const b = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(b.cert) as Obj;
    cert.signatures[0].webauthn.credential.response.signature = 'A'.repeat(
      48001
    );
    const spy = spyOn(crypto.subtle, 'verify');
    try {
      expect((await verifySigningCertificate(cert)).valid).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  test('a signed public statement cannot name a signer identity', async () => {
    const b = await buildCertificate({ access: 'public', signers: 1 });
    const cert = clone(b.cert) as Obj;
    const s = parseStatement('signature', cert.signatures[0].statement);
    const changed = { ...s, signer_identity_id: 'a'.repeat(64) };
    cert.signatures[0].statement = changed;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    cert.signatures[0].webauthn.nonce = encodeBase64url(nonce);
    cert.signatures[0].webauthn.credential = await b.passkeys[0]!.assert({
      challenge: encodeBase64url(
        await attestationChallenge(nonce, [
          statementBytes('signature', changed),
        ])
      ),
      origin: ORIGIN,
      rpId: 'relik.link',
    });
    const report = await verifySigningCertificate(cert, {
      trustedOwnerIdentityId: b.owner.identityId,
    });
    expect(report.checks.find((c) => c.id === 'signature_binding')?.ok).toBe(
      false
    );
    expect(report.valid).toBe(false);
  });
});
