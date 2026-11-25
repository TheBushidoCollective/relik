import { expect, test } from 'bun:test';
import type { SigningRequestJSON } from '@relic/format/signing';
import {
  buildCertificate,
  RELIC_ID,
  VERSION,
} from '../../relic-format/test/support/signing-builder.ts';
import { contentFromBytes } from '../src/content.ts';
import {
  signingApi,
  signingContent,
  verifyViewerSigningRequest,
} from '../src/signing/api.ts';
import { signingPagesFit } from '../src/signing/boxes.ts';
import { showPausedSigning } from '../src/signing/controller.ts';
import type { ViewerDeps } from '../src/viewer.ts';

test('signing transport sends the exact public and private wire bodies', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({});
  };
  const deps = {
    serviceOrigin: 'https://relik.test',
    fetch,
  } as unknown as ViewerDeps;
  const publicApi = signingApi(deps, 'abc', 'proof');
  await publicApi.read();
  await publicApi.options('request');
  await publicApi.signature('request', { nonce: 'n' }, 'sealed');
  await publicApi.certificate('request');
  const privateApi = signingApi(deps, 'abc');
  await privateApi.read();
  await privateApi.request({ nonce: 'owner' }, 'layout');
  await privateApi.cancel({ nonce: 'cancel' });
  expect(calls).toEqual([
    {
      url: 'https://relik.test/api/relics/abc/signing/read',
      body: { share_proof: 'proof' },
    },
    {
      url: 'https://relik.test/api/relics/abc/signing/options',
      body: { share_proof: 'proof', request_id: 'request' },
    },
    {
      url: 'https://relik.test/api/relics/abc/signing/signatures',
      body: {
        share_proof: 'proof',
        request_id: 'request',
        attestation: { nonce: 'n' },
        mark_ciphertext: 'sealed',
      },
    },
    {
      url: 'https://relik.test/api/relics/abc/signing/certificate',
      body: { share_proof: 'proof', request_id: 'request' },
    },
    { url: 'https://relik.test/api/relics/abc/signing/read', body: {} },
    {
      url: 'https://relik.test/api/relics/abc/signing/requests',
      body: { attestation: { nonce: 'owner' }, layout_ciphertext: 'layout' },
    },
    {
      url: 'https://relik.test/api/relics/abc/signing/cancel',
      body: { attestation: { nonce: 'cancel' } },
    },
  ]);
});

test('a paused signing notice is limited to listed signers of trusted open requests', () => {
  expect(showPausedSigning(false, 'open', true, true)).toBe(true);
  expect(showPausedSigning(true, 'open', true, true)).toBe(false);
  expect(showPausedSigning(false, undefined, true, true)).toBe(false);
  expect(showPausedSigning(false, 'complete', true, true)).toBe(false);
  expect(showPausedSigning(false, 'open', false, true)).toBe(false);
  expect(showPausedSigning(false, 'open', true, false)).toBe(false);
});

test('a private request cannot substitute another owner', async () => {
  const request = {
    owner: { identity: { identity_id: 'attacker' } },
  } as SigningRequestJSON;
  await expect(
    verifyViewerSigningRequest({
      request,
      relicId: 'r',
      version: 1,
      digest: 'digest',
      content: contentFromBytes(new Uint8Array()),
      signingKey: new Uint8Array(32),
      access: 'private',
      origin: 'https://relik.test',
      pinnedOwnerIdentityId: 'owner',
      pdf: false,
    })
  ).rejects.toThrow('signing_owner_mismatch');
});

test('signing content uses the complete stored content', async () => {
  const content = contentFromBytes(new Uint8Array([1, 2, 3]));
  const chunks = [];
  for await (const chunk of signingContent(content)) chunks.push(...chunk);
  expect(chunks).toEqual([1, 2, 3]);
});

test('a valid signed request opens its layout and rejects changed content', async () => {
  const built = await buildCertificate({ access: 'public', signers: 1 });
  const payload = built.cert.request as SigningRequestJSON['request'];
  const statement = payload.statement;
  const request = {
    request_id: statement['request_id'],
    version: VERSION,
    request: payload,
    owner: built.cert.owner,
  } as SigningRequestJSON;
  const input = {
    request,
    relicId: RELIC_ID,
    version: VERSION,
    digest: built.cert.ciphertext_sha256 as string,
    content: contentFromBytes(built.content),
    signingKey: built.signingKey,
    access: 'public' as const,
    origin: built.origin,
    pdf: true,
  };
  expect((await verifyViewerSigningRequest(input)).boxes).toHaveLength(1);
  await expect(
    verifyViewerSigningRequest({
      ...input,
      content: contentFromBytes(new Uint8Array([1, 2, 3])),
    })
  ).rejects.toThrow('signing_content_mismatch');
});

test('PDF signing refuses a box beyond the last page or unknown page count', () => {
  const box = { signer: 0, page: 7, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } };
  expect(signingPagesFit([box], 7)).toBe(true);
  expect(signingPagesFit([box], 6)).toBe(false);
  expect(signingPagesFit([box], 0)).toBe(false);
});
