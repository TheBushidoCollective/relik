import { expect, test } from 'bun:test';
import { metadataBoundary, StorageClient } from './ephemeral-operator.ts';

test('metadata boundary rejects an altered current generation', async () => {
  const id = '1'.repeat(26); const name = 'm/relic/' + id + '.json'; const bytes = new TextEncoder().encode('{}');
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response(bytes, { headers: { 'x-goog-generation': '11' } }); };
  const client = new StorageClient('fake-bucket', 'fake-cloud-token', transport);
  const snapshot = { objects: new Map([[name, '10']]), rows: new Map([[id, {}]]), bodies: new Map([[name, bytes]]), blocks: new Map() };
  const guard = metadataBoundary(client, snapshot, () => id, 'fake');
  const url = 'https://storage.googleapis.com/storage/v1/b/fake-bucket/o/' + encodeURIComponent(name) + '?alt=media';
  await expect(guard.fetch(url, { headers: { authorization: 'Bearer fake-cloud-token' } })).rejects.toThrow();
  expect(calls).toBe(1); expect(guard.faulted()).toBe(true);
});
