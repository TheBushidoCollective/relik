import assert from 'node:assert/strict';
import { indexZip } from '@relic/format';
import { contentFromBlob } from '../../../relic-viewer/src/content.ts';
import { folderZip } from '../../../relic-viewer/src/folder-downloads.ts';
import type { FolderRelic } from '../../../relic-viewer/src/folder-relic.ts';

for (const [count, size] of [
  [3, 1024 * 1024],
  [200, 37],
] as const) {
  const bodies = Array.from({ length: count }, (_, i) =>
    new Uint8Array(size).fill(i)
  );
  const content = await contentFromBlob(new Blob(bodies));
  const entries = bodies.map((body, i) => ({
    path: `files/${String(i).padStart(4, '0')}.bin`,
    mimetype: 'application/octet-stream',
    length: body.length,
    offset: i * size,
  }));
  const folder: FolderRelic = {
    header: {
      version: 2,
      name: 'test',
      entryCount: count,
      manifestLength: 0,
      contentLength: content.size,
    },
    manifest: { entries, defaultIndex: 0 },
    whole: content,
    index: 0,
  };
  let reported = 0;
  const start = performance.now();
  const zip = await folderZip(folder, new AbortController().signal, (done) => {
    reported = done;
  });
  const elapsed = performance.now() - start;
  assert.equal(reported, count);
  const indexed = await indexZip(
    {
      size: zip.size,
      async read(from, to) {
        return new Uint8Array(await zip.slice(from, to).arrayBuffer());
      },
    },
    {
      maxArchiveBytes: zip.size,
      maxEntries: count,
      maxEntryBytes: size,
      maxTotalBytes: count * size,
    }
  );
  assert.equal(indexed.ok, true);
  if (!indexed.ok) throw new Error(indexed.reason);
  assert.equal(indexed.index.entries.size, count);
  for (let i = 0; i < count; i++) {
    const read = await indexed.index.read(entries[i]!.path);
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error(read.reason);
    assert.deepEqual(read.bytes, bodies[i]);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    folderZip(folder, cancelled.signal, () => {}),
    { name: 'AbortError' }
  );
  console.log(
    `MULTI_FILE_STAGE downloads OK count=${count} file_bytes=${size} zip_bytes=${zip.size} assembly_ms=${elapsed.toFixed(2)}`
  );
}
