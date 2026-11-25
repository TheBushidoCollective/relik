import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptRelic } from '@relic/format';
import { contentMac, deriveSigningKey } from '@relic/format/signing';
import { makeDevice, makePerson, pinDevice } from './private-fixtures.ts';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import { handleMessage } from '../src/server.ts';
import { readSigning } from '../src/signing.ts';
import { savePublishState } from '../src/state.ts';
import { fetchUpload } from './upload-fixture.ts';

const id = '0123456789abcdefghjkmnpqrs';
let dir: string;
let deps: PublishDeps;
let sent: unknown;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-signing-'));
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'state.json');
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device.json');
  await savePublishState(id, {
    key: 'AAAAAAAAAAAAAAAAAAAAAA',
    publish_token: 'secret-token',
    version: 1,
  });
  deps = {
    serviceOrigin: 'https://svc.test',
    relicOrigin: 'https://svc.test',
    files: nodeFiles,
    clientName: 'test',
    upload: fetchUpload,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'not used',
    }),
    fetch: (async (url, init) => {
      expect(String(url)).toBe(
        `https://svc.test/api/relics/${id}/signing/read`
      );
      sent = JSON.parse(String(init?.body));
      return Response.json({
        relic_id: id,
        current_version: 1,
        locked_versions: [],
        me: null,
        requests: [],
        secret: 'hidden',
      });
    }) as typeof fetch,
  };
});
afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  delete process.env['RELIC_DEVICE_KEYS'];
  await rm(dir, { recursive: true, force: true });
});

test('reads signing state with token without returning secrets', async () => {
  const result = await readSigning({ relicId: id }, deps);
  expect(sent).toEqual({ publish_token: 'secret-token' });
  expect(result).toEqual({
    relic_id: id,
    current_version: 1,
    locked_versions: [],
    requests: [],
  });
});

test('rejects unknown request ids', async () => {
  await expect(
    readSigning({ relicId: id, requestId: 'not-found' }, deps)
  ).rejects.toMatchObject({ code: 'signing_request_not_found' });
});

test('cannot save a certificate without a completed request', async () => {
  await expect(
    readSigning(
      { relicId: id, saveCertificateTo: join(dir, 'certificate.json') },
      deps
    )
  ).rejects.toMatchObject({ code: 'certificate_not_ready' });
});

test('signing refusal carries actionable guidance without exposing the token', async () => {
  deps = {
    ...deps,
    fetch: (async () =>
      Response.json(
        { code: 'signing_closed', detail: 'paused' },
        { status: 409 }
      )) as unknown as typeof fetch,
  };
  const result = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'relic_read_signing', arguments: { relic_id: id } },
    },
    deps
  );
  expect(JSON.stringify(result)).toContain('Signing is paused');
  expect(JSON.stringify(result)).not.toContain('secret-token');
});

test('creates a public request for the encrypted version and returns unsent invitation drafts', async () => {
  const owner = await makePerson('owner@example.com');
  const device = await makeDevice('test');
  await pinDevice('https://svc.test', owner, device);
  const content = new TextEncoder().encode('Signing content');
  const key = new Uint8Array(16);
  const ciphertext = await encryptRelic({
    content,
    filename: 'file.txt',
    mimetype: 'text/plain',
    key,
  });
  const bodies: string[] = [];
  deps = {
    ...deps,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.body) bodies.push(String(init.body));
      if (path.endsWith('/owner'))
        return Response.json({ code: 'owner_exists' }, { status: 409 });
      if (path.endsWith('/mint'))
        return Response.json({
          url: 'https://storage.test/object',
          object_length: ciphertext.length,
          version: 1,
          current_version: 1,
        });
      if (path === 'https://storage.test/object')
        return new Response(ciphertext.slice().buffer as ArrayBuffer);
      if (path.endsWith('/signing/requests')) {
        const body = JSON.parse(String(init?.body));
        expect(body.request.statement.content_mac).toBe(
          await contentMac(await deriveSigningKey(key), content)
        );
        expect(body.request.signer_kind).toBe('device');
        return Response.json(
          { request_id: body.request.statement.request_id, status: 'open' },
          { status: 201 }
        );
      }
      throw new Error(`unexpected route ${path}`);
    }) as typeof fetch,
  };
  const res = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'relic_request_signatures',
        arguments: { relic_id: id, signers: [{ email: 'signer@example.com' }] },
      },
    },
    deps
  );
  const result = res?.result as {
    structuredContent: { invitations: { text: string }[] };
  };
  expect(result.structuredContent.invitations[0]?.text).toContain('#');
  expect(bodies.join('\n')).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
});
