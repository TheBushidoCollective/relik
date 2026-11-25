import { expect, test } from 'bun:test';
import type { SigningRequestJSON } from '@relic/format/signing';
import { contentFromBytes } from '../src/content.ts';
import { signingApi, signingContent, verifyViewerSigningRequest } from '../src/signing/api.ts';
import type { ViewerDeps } from '../src/viewer.ts';

test('signing transport sends the exact public and private wire bodies', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({});
  };
  const deps = { serviceOrigin: 'https://relik.test', fetch } as unknown as ViewerDeps;
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
    { url: 'https://relik.test/api/relics/abc/signing/read', body: { share_proof: 'proof' } },
    { url: 'https://relik.test/api/relics/abc/signing/options', body: { share_proof: 'proof', request_id: 'request' } },
    { url: 'https://relik.test/api/relics/abc/signing/signatures', body: { share_proof: 'proof', request_id: 'request', attestation: { nonce: 'n' }, mark_ciphertext: 'sealed' } },
    { url: 'https://relik.test/api/relics/abc/signing/certificate', body: { share_proof: 'proof', request_id: 'request' } },
    { url: 'https://relik.test/api/relics/abc/signing/read', body: {} },
    { url: 'https://relik.test/api/relics/abc/signing/requests', body: { attestation: { nonce: 'owner' }, layout_ciphertext: 'layout' } },
    { url: 'https://relik.test/api/relics/abc/signing/cancel', body: { attestation: { nonce: 'cancel' } } },
  ]);
});

test('a private request cannot substitute another owner', async () => {
  const request = { owner: { identity: { identity_id: 'attacker' } } } as SigningRequestJSON;
  await expect(verifyViewerSigningRequest({
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
  })).rejects.toThrow('signing_owner_mismatch');
});

test('signing content uses the complete stored content', async () => {
  const content = contentFromBytes(new Uint8Array([1, 2, 3]));
  const chunks = [];
  for await (const chunk of signingContent(content)) chunks.push(...chunk);
  expect(chunks).toEqual([1, 2, 3]);
});
