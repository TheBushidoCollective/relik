import { encryptedSize, openRelic, type OpenedRelic } from './container.ts';
import { decodeEnvelope, type Envelope } from './envelope.ts';
import {
  ContentTooLargeError,
  MalformedContainerError,
  StrictParseError,
  TruncatedContainerError,
  VersionMismatchError,
} from './errors.ts';
import { PLAINTEXT_CAP_BYTES } from './limits.ts';
import {
  decodeManifest,
  encodeFolderHeader,
  encodeManifest,
  MAX_ENTRIES,
  MAX_MANIFEST_BYTES,
  MAX_NAME_BYTES,
  type FolderHeader,
  type FolderManifest,
} from './multi.ts';
import {
  decodeHeader,
  decryptRecord,
  deriveKeys,
  encodeHeader,
  encryptRecord,
  HEADER_BYTES,
  RECORD_SIZE,
  recordCapacity,
} from './rfc8188.ts';

export type EnvelopeV2 = FolderHeader;
export type AnyEnvelope = Envelope | EnvelopeV2;

export class UnsupportedEnvelopeVersionError extends MalformedContainerError {
  override readonly name = 'UnsupportedEnvelopeVersionError';
  constructor(readonly envelopeVersion: number) {
    super(`unsupported envelope version ${envelopeVersion}`);
  }
}

export function decodeAnyEnvelope(
  bytes: Uint8Array,
  options: { admitted: readonly number[] }
): AnyEnvelope {
  if (bytes.length < 2)
    throw new StrictParseError('envelope header is shorter than its prelude');
  const version = bytes[0]!;
  if (!options.admitted.includes(version)) {
    if (version > Math.max(...options.admitted))
      throw new UnsupportedEnvelopeVersionError(version);
    throw new VersionMismatchError(options.admitted[0] ?? 1, version);
  }
  if (version === 1) return decodeEnvelope(bytes, 1);
  if (version !== 2) throw new UnsupportedEnvelopeVersionError(version);
  if (bytes.length < 19)
    throw new StrictParseError('folder header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(1);
  if (nameLength > MAX_NAME_BYTES || bytes.length !== 19 + nameLength)
    throw new StrictParseError('invalid folder header name or length');
  const name = new TextDecoder().decode(bytes.subarray(3, 3 + nameLength));
  const start = 3 + nameLength;
  const entryCount = view.getUint32(start);
  const manifestLength = view.getUint32(start + 4);
  const contentBig = view.getBigUint64(start + 8);
  if (contentBig > BigInt(Number.MAX_SAFE_INTEGER))
    throw new StrictParseError('folder content length exceeds safe range');
  const contentLength = Number(contentBig);
  if (
    entryCount < 1 ||
    entryCount > MAX_ENTRIES ||
    manifestLength < 17 ||
    manifestLength > MAX_MANIFEST_BYTES ||
    contentLength < manifestLength ||
    contentLength > PLAINTEXT_CAP_BYTES
  )
    throw new StrictParseError('invalid folder header values');
  return { version: 2, name, entryCount, manifestLength, contentLength };
}
export function contentLengthOf(envelope: AnyEnvelope): number {
  return envelope.version === 2
    ? (envelope as EnvelopeV2).contentLength
    : (envelope as Envelope).entries[0]!.length;
}
export interface FolderByteSource {
  readonly size: number;
  chunks(): AsyncIterable<Uint8Array>;
}
export type FolderEntryBytes = Uint8Array | FolderByteSource;

export class EntrySizeMismatchError extends MalformedContainerError {
  override readonly name = 'EntrySizeMismatchError';
  readonly code = 'entry-size-mismatch';
  constructor(
    readonly path: string,
    readonly expected: number,
    readonly actual: number
  ) {
    super(
      `entry-size-mismatch: ${path} declared ${expected} bytes, received ${actual}`
    );
  }
}
export interface EncryptFolderInput {
  readonly name: string;
  readonly defaultIndex: number;
  readonly entries: readonly {
    readonly path: string;
    readonly mimetype: string;
    readonly bytes: FolderEntryBytes;
  }[];
  readonly key: Uint8Array;
  readonly rs?: number;
  readonly salt?: Uint8Array;
}
export function folderPlaintext(
  input: Omit<EncryptFolderInput, 'key' | 'rs' | 'salt'>
): {
  header: FolderHeader;
  headerBytes: Uint8Array;
  parts: readonly FolderEntryBytes[];
} {
  const manifest = encodeManifest(
    input.defaultIndex,
    input.entries.map((e) => ({
      path: e.path,
      mimetype: e.mimetype,
      length: e.bytes instanceof Uint8Array ? e.bytes.length : e.bytes.size,
    }))
  );
  const parts = [manifest, ...input.entries.map((e) => e.bytes)];
  const contentLength = parts.reduce(
    (sum, part) => sum + (part instanceof Uint8Array ? part.length : part.size),
    0
  );
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > PLAINTEXT_CAP_BYTES
  )
    throw new ContentTooLargeError(contentLength, PLAINTEXT_CAP_BYTES);
  const header: FolderHeader = {
    version: 2,
    name: input.name,
    entryCount: input.entries.length,
    manifestLength: manifest.length,
    contentLength,
  };
  return { header, headerBytes: encodeFolderHeader(header), parts };
}
export async function encryptFolder(
  input: EncryptFolderInput
): Promise<Uint8Array> {
  const { header, parts } = folderPlaintext(input);
  const materialized: Uint8Array[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part instanceof Uint8Array) {
      materialized.push(part);
      continue;
    }
    const bytes = new Uint8Array(part.size);
    let written = 0;
    for await (const chunk of part.chunks()) {
      written += chunk.length;
      if (written > part.size)
        throw new EntrySizeMismatchError(
          input.entries[index - 1]!.path,
          part.size,
          written
        );
      bytes.set(chunk, written - chunk.length);
    }
    if (written !== part.size)
      throw new EntrySizeMismatchError(
        input.entries[index - 1]!.path,
        part.size,
        written
      );
    materialized.push(bytes);
  }
  return reencryptFolder({
    header,
    parts: materialized,
    key: input.key,
    rs: input.rs,
    salt: input.salt,
  });
}
export async function reencryptFolder(input: {
  header: FolderHeader;
  parts: readonly Uint8Array[];
  key: Uint8Array;
  rs?: number | undefined;
  salt?: Uint8Array | undefined;
}): Promise<Uint8Array> {
  const headerBytes = encodeFolderHeader(input.header);
  const total = input.parts.reduce((sum, p) => sum + p.length, 0);
  if (!Number.isSafeInteger(total) || total !== input.header.contentLength)
    throw new StrictParseError('folder content length mismatch');
  const rs = input.rs ?? RECORD_SIZE,
    capacity = recordCapacity(rs);
  if (headerBytes.length > capacity)
    throw new MalformedContainerError('folder header exceeds record capacity');
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveKeys(input.key, salt);
  const out = new Uint8Array(encryptedSize(total, rs, headerBytes.length));
  const framing = encodeHeader(salt, rs);
  out.set(framing);
  let outOffset = framing.length;
  const first = await encryptRecord(keys, 0, headerBytes, false, capacity);
  out.set(first, outOffset);
  outOffset += first.length;
  let partIndex = 0,
    partOffset = 0,
    consumed = 0,
    sequence = 1;
  while (consumed < total) {
    const size = Math.min(capacity, total - consumed),
      chunk = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const part = input.parts[partIndex]!;
      const n = Math.min(size - written, part.length - partOffset);
      chunk.set(part.subarray(partOffset, partOffset + n), written);
      written += n;
      partOffset += n;
      if (partOffset === part.length) {
        partIndex++;
        partOffset = 0;
      }
    }
    consumed += size;
    const sealed = await encryptRecord(
      keys,
      sequence++,
      chunk,
      consumed === total
    );
    out.set(sealed, outOffset);
    outOffset += sealed.length;
  }
  return out;
}
export interface OpenedAnyRelic {
  readonly envelope: AnyEnvelope;
  readonly content: Uint8Array;
}
export interface OpenedFolder {
  readonly header: FolderHeader;
  readonly manifest: FolderManifest;
  entryBytes(index: number): Uint8Array;
}
export function openFolder(opened: OpenedAnyRelic): OpenedFolder {
  if (opened.envelope.version !== 2)
    throw new StrictParseError('not a folder relik');
  const header = opened.envelope as FolderHeader;
  const manifest = decodeManifest(
    opened.content.subarray(0, header.manifestLength),
    header
  );
  return {
    header,
    manifest,
    entryBytes(index) {
      const e = manifest.entries[index];
      if (!e) throw new RangeError('invalid folder entry index');
      return opened.content.subarray(e.offset, e.offset + e.length);
    },
  };
}
export async function openAnyRelic(
  container: Uint8Array,
  key: Uint8Array,
  options: { admitted: readonly number[] }
): Promise<OpenedAnyRelic> {
  const framing = decodeHeader(container);
  const keys = await deriveKeys(key, framing.salt);
  const end0 = Math.min(container.length, HEADER_BYTES + framing.rs);
  const first = await decryptRecord(
    keys,
    0,
    container.subarray(HEADER_BYTES, end0)
  );
  const envelope = decodeAnyEnvelope(first.data, options);
  if (envelope.version !== 2)
    return openRelic(container, key, 1) as Promise<OpenedRelic>;
  const header = envelope as FolderHeader;
  if (first.isLast || end0 !== HEADER_BYTES + framing.rs)
    throw new TruncatedContainerError('folder content is missing');
  const content = new Uint8Array(header.contentLength);
  let written = 0,
    seq = 1;
  for (let offset = end0; offset < container.length; offset += framing.rs) {
    const end = Math.min(container.length, offset + framing.rs);
    const record = await decryptRecord(
      keys,
      seq++,
      container.subarray(offset, end)
    );
    if (record.isLast !== (end === container.length))
      throw new MalformedContainerError('invalid final record delimiter');
    if (written + record.data.length > content.length)
      throw new MalformedContainerError(
        'folder content exceeds declared length'
      );
    content.set(record.data, written);
    written += record.data.length;
  }
  if (written !== content.length)
    throw new TruncatedContainerError('folder content is truncated');
  decodeManifest(content.subarray(0, header.manifestLength), header);
  return { envelope: header, content };
}
