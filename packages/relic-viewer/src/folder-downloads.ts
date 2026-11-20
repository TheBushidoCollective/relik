import { Crc32, planStoredZip } from '@relic/format';
import type { FolderRelic } from './folder-relic.ts';

const CHUNK_BYTES = 8 * 1024 * 1024;

export async function folderZip(
  folder: FolderRelic,
  signal: AbortSignal,
  progress: (done: number, total: number) => void
): Promise<Blob> {
  const whole = folder.whole.blob('application/octet-stream');
  const entries = folder.manifest.entries;
  const slices = entries.map((entry) =>
    whole.slice(entry.offset, entry.offset + entry.length)
  );
  const records = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const slice = slices[i]!;
    const crc = new Crc32();
    for (let at = 0; at < slice.size; at += CHUNK_BYTES) {
      signal.throwIfAborted();
      crc.update(
        new Uint8Array(await slice.slice(at, at + CHUNK_BYTES).arrayBuffer())
      );
    }
    signal.throwIfAborted();
    records.push({ name: entry.path, size: entry.length, crc32: crc.value() });
    progress(i + 1, entries.length);
  }
  const layout = planStoredZip(records);
  const parts: BlobPart[] = [];
  for (let i = 0; i < entries.length; i++) {
    parts.push(Uint8Array.from(layout.localHeaders[i]!), slices[i]!);
  }
  parts.push(
    Uint8Array.from(layout.centralDirectory),
    Uint8Array.from(layout.end)
  );
  return new Blob(parts, { type: 'application/zip' });
}
