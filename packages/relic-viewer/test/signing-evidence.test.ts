import { expect, test } from 'bun:test';
import { signatureEvidenceStatus } from '../src/signing/controller.ts';

test('withheld receipt is admitted but never treated as a fully verified signature', () => {
  const checks = [
    { id: 'signature_binding', ok: true },
    { id: 'signature_webauthn', ok: true },
    { id: 'opened_receipt', ok: false },
  ];
  expect(signatureEvidenceStatus(checks, true)).toBe('withheld');
  expect(signatureEvidenceStatus(checks, false)).toBe('invalid');
  expect(
    signatureEvidenceStatus(
      [{ id: 'signature_binding', ok: false }, ...checks],
      true
    )
  ).toBe('invalid');
  expect(signatureEvidenceStatus([], true)).toBe('invalid');
});
