import { readFile } from 'node:fs/promises';
import { decodeBase64url } from '@relic/format/private';
import { verifySigningCertificate } from '@relic/format/signing';

/** Verify locally. The owner identity must come from outside the certificate. */
export async function verifyCertificate(input: {
  certificatePath: string;
  filePath?: string;
  origin: string;
  trustedOwnerIdentityId?: string;
}) {
  const certificate: unknown = JSON.parse(
    await readFile(input.certificatePath, 'utf8')
  );
  const key =
    typeof certificate === 'object' &&
    certificate !== null &&
    'signing_key' in certificate &&
    typeof certificate.signing_key === 'string'
      ? decodeBase64url(certificate.signing_key)
      : undefined;
  if (input.filePath !== undefined && key === undefined) {
    throw new Error(
      'The certificate has no signing key, so its content cannot be checked.'
    );
  }
  const content =
    input.filePath === undefined ? undefined : await readFile(input.filePath);
  return verifySigningCertificate(certificate, {
    expectedOrigin: input.origin,
    ...(input.trustedOwnerIdentityId === undefined
      ? {}
      : { trustedOwnerIdentityId: input.trustedOwnerIdentityId }),
    ...(key === undefined ? {} : { signingKey: key }),
    ...(content === undefined ? {} : { content }),
  });
}
