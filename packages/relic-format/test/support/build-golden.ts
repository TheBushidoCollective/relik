/**
 * Writes the golden signing certificates under test/fixtures/signing/. Run once
 * with `bun test/support/build-golden.ts` when the wire format changes on
 * purpose. The files hold public keys, signatures and sealed appearance only.
 * No private key is written, so they are safe to commit.
 */

import { buildCertificate } from './signing-builder.ts';

const dir = new URL('../fixtures/signing/', import.meta.url);

const golden = {
  'public-sequential': { access: 'public', signers: 2, order: 'sequential' },
  'private-opened': { access: 'private', signers: 2, requireOpened: true },
  'private-device': { access: 'private', signers: 1, requestSigner: 'device' },
} as const;

for (const [name, options] of Object.entries(golden)) {
  const built = await buildCertificate(options);
  await Bun.write(
    new URL(`${name}.json`, dir),
    `${JSON.stringify(built.cert, null, 2)}\n`
  );
  console.log(`wrote ${name}.json`);
}
