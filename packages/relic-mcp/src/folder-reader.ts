import {
  contentRangeToObjectRange,
  decodeAnyEnvelope,
  decodeHeader,
  decodeManifest,
  decryptContentRange,
  decryptRecord,
  deriveKeys,
  ENVELOPE_VERSIONS,
  envelopePrefixLength,
  HEADER_BYTES,
  type FolderHeader,
  type FolderManifest,
} from '@relic/format';
import type { PublishDeps } from './publish.ts';

export class FolderReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
  }
}

async function range(
  url: string,
  start: number,
  end: number,
  objectLength: number,
  deps: PublishDeps
): Promise<Uint8Array> {
  const boundedEnd = Math.min(end, objectLength - 1);
  const response = await deps.fetch(url, {
    headers: { range: `bytes=${start}-${boundedEnd}` },
  });
  if (response.status === 200 && start === 0 && boundedEnd < objectLength - 1) {
    if (response.body === null)
      throw new Error('storage returned no response body');
    const reader = response.body.getReader();
    const prefix = new Uint8Array(boundedEnd + 1);
    let offset = 0;
    try {
      while (offset < prefix.length) {
        const next = await reader.read();
        if (next.done) throw new Error('storage returned an incomplete range');
        const length = Math.min(next.value.length, prefix.length - offset);
        prefix.set(next.value.subarray(0, length), offset);
        offset += length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return prefix;
  }
  if (
    response.status !== 206 &&
    !(response.status === 200 && start === 0 && boundedEnd === objectLength - 1)
  ) {
    throw new Error(
      `storage did not return the requested range: ${response.status}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== boundedEnd - start + 1)
    throw new Error('storage returned an incomplete range');
  return bytes;
}

export async function readFolderIndex(
  url: string,
  key: Uint8Array,
  objectLength: number,
  deps: PublishDeps
): Promise<{
  header: FolderHeader;
  manifest: FolderManifest;
  read(start: number, length: number): Promise<Uint8Array>;
} | null> {
  let prefix = await range(
    url,
    0,
    envelopePrefixLength() - 1,
    objectLength,
    deps
  );
  const framing = decodeHeader(prefix);
  const prefixLength = Math.min(objectLength, HEADER_BYTES + framing.rs);
  if (prefix.length < prefixLength)
    prefix = await range(url, 0, prefixLength - 1, objectLength, deps);
  const record = await decryptRecord(
    await deriveKeys(key, framing.salt),
    0,
    prefix.subarray(HEADER_BYTES)
  );
  const envelope = decodeAnyEnvelope(record.data, {
    admitted: ENVELOPE_VERSIONS,
  });
  if (envelope.version !== 2) return null;
  const header = envelope as FolderHeader;
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    if (length === 0) return new Uint8Array();
    const bounds = contentRangeToObjectRange(start, start + length, framing.rs);
    const bytes = await range(
      url,
      bounds.start,
      bounds.end,
      objectLength,
      deps
    );
    const plaintext = await decryptContentRange(
      bytes,
      bounds,
      framing.salt,
      key,
      framing.rs,
      length
    );
    if (plaintext.length !== length)
      throw new Error('folder content range is incomplete');
    return plaintext;
  };
  const manifest = decodeManifest(await read(0, header.manifestLength), header);
  return { header, manifest, read };
}
