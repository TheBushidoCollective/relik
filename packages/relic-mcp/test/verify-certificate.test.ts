import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCertificate } from '../src/verify-certificate.ts';

test('requires independent owner trust and rejects tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relik-certificate-'));
  try {
    const fixture = new URL(
      '../../relic-format/test/fixtures/signing/public-sequential.json',
      import.meta.url
    );
    const certificate = JSON.parse(await readFile(fixture, 'utf8'));
    const path = join(dir, 'certificate.json');
    await writeFile(path, JSON.stringify(certificate));
    const origin = certificate.service.origin as string;
    const owner = certificate.request.statement.owner_identity_id as string;
    const unchecked = await verifyCertificate({
      certificatePath: path,
      origin,
    });
    expect(unchecked.internal_consistency).toBe(true);
    expect(unchecked.valid).toBe(false);
    expect(
      (
        await verifyCertificate({
          certificatePath: path,
          origin,
          trustedOwnerIdentityId: owner,
        })
      ).valid
    ).toBe(true);
    expect(
      (
        await verifyCertificate({
          certificatePath: path,
          origin,
          trustedOwnerIdentityId: '0'.repeat(64),
        })
      ).valid
    ).toBe(false);
    certificate.version += 1;
    await writeFile(path, JSON.stringify(certificate));
    expect(
      (
        await verifyCertificate({
          certificatePath: path,
          origin,
          trustedOwnerIdentityId: owner,
        })
      ).valid
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
