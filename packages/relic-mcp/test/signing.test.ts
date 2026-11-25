import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      )) as typeof fetch,
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
