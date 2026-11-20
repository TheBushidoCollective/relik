import assert from 'node:assert/strict';
import {
  decryptRecord,
  deriveKeys,
  decodeHeader,
  HEADER_BYTES,
  decodeEnvelope,
  decodeManifest,
  encodeManifest,
  openAnyRelic,
  openFolder,
  reencryptFolder,
  VersionMismatchError,
} from '@relic/format';
import golden from '../../relic-format/test/folder-golden.json';

const key = Uint8Array.from(Buffer.from(golden.key, 'hex'));
const salt = Uint8Array.from(Buffer.from(golden.salt, 'hex'));
const bytes = Uint8Array.from(Buffer.from(golden.object, 'hex'));
const opened = await openAnyRelic(bytes, key, { admitted: [1, 2] });
const folder = openFolder(opened);
assert.deepEqual(folder.header, {
  version: 2,
  name: 'Example',
  entryCount: 3,
  manifestLength: 108,
  contentLength: 116,
});
assert.deepEqual(
  folder.manifest.entries.map((entry) => entry.path),
  ['README.md', 'data/a.json', 'empty.txt']
);
assert.deepEqual(
  await reencryptFolder({
    header: folder.header,
    parts: [opened.content],
    key,
    salt,
    rs: golden.rs,
  }),
  bytes
);
const framing = decodeHeader(bytes);
const first = await decryptRecord(
  await deriveKeys(key, framing.salt),
  0,
  bytes.subarray(HEADER_BYTES, HEADER_BYTES + framing.rs)
);
assert.throws(() => decodeEnvelope(first.data, 1), VersionMismatchError);
console.log('MULTI_FILE_STAGE codec OK');
for (const count of [1000, 5000]) {
  const entries = Array.from({ length: count }, (_, i) => ({
    path: `${String(i).padStart(5, '0')}-${'a'.repeat(54)}`,
    mimetype: '',
    length: 0,
  }));
  const manifest = encodeManifest(0, entries);
  const header = {
    version: 2 as const,
    name: '',
    entryCount: count,
    manifestLength: manifest.length,
    contentLength: manifest.length,
  };
  const start = performance.now();
  decodeManifest(manifest, header);
  console.log(
    `MULTI_FILE_TIMING runtime=bun entries=${count} decode_and_check_ms=${(performance.now() - start).toFixed(3)}`
  );
}
// Stages mutate process env and must not run concurrently.
await import('./multi-file-stages/open-entries.ts');
await import('./multi-file-stages/downloads.ts');
await import('./multi-file-stages/folder-publish.ts');
await import('./multi-file-stages/zip-publish.ts');
await import('./multi-file-stages/private-publish.ts');
await import('./multi-file-stages/private-rekey.ts');
await import('./multi-file-stages/private-zip.ts');
await import('./multi-file-stages/show.ts');
await import('./multi-file-stages/comments-mcp.ts');
await import('./multi-file-stages/apply.ts');
await import('./multi-file-stages/comments-viewer.ts');
await import('./multi-file-stages/compare.ts');
await import('./multi-file-stages/shape-switch.ts');
console.log('MULTI_FILE_PATH_OK');
