import { encryptFolderStream, type FolderHeader } from '@relic/format';
import type { RelicContent } from '../content.ts';
import { openFolderRelic } from '../folder-relic.ts';
import { ciphertextBlob } from './ciphertext-blob.ts';

/** Rekey file slices without materializing folder plaintext or ciphertext as an array. */
export async function rekeyFolder(
  header: FolderHeader,
  content: RelicContent,
  key: Uint8Array
): Promise<{ blob: Blob; digest: string }> {
  const folder = await openFolderRelic(header, content);
  const entries = folder.manifest.entries;
  const original = await content.read(0, header.manifestLength);
  const whole = content.blob('application/octet-stream');
  return ciphertextBlob(
    encryptFolderStream({
      key,
      name: header.name,
      defaultIndex: folder.manifest.defaultIndex,
      originalManifest: original,
      entries: entries.map((entry) => ({
        path: entry.path,
        mimetype: entry.mimetype,
        bytes: {
          size: entry.length,
          async *chunks() {
            const reader = whole
              .slice(entry.offset, entry.offset + entry.length)
              .stream()
              .getReader();
            try {
              while (true) {
                const result = await reader.read();
                if (result.done) break;
                yield result.value;
              }
            } finally {
              reader.releaseLock();
            }
          },
        },
      })),
    })
  );
}
