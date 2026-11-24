import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  EXTENSIONS,
  filenameExtension,
  KEY_BYTES,
  modelFormatFromFilename,
  parseRelicId,
} from '@relic/format';
import { publishStatePath } from './state.ts';

export type VersionFormat =
  | { readonly shape: 'file'; readonly extension: string | null }
  | { readonly shape: 'folder' };

export type CachedVersionFormat =
  | { readonly shape: 'file'; readonly extension: string | null }
  | {
      readonly shape: 'folder';
      readonly entries: Readonly<Record<string, string | null>>;
    };

const EXTRA_EXTENSIONS = ['csv', 'tsv', 'json', 'ipynb', 'srt', 'vtt'];
const MAGIC = Buffer.from('RSF1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Keep only a known format, never a source name or an arbitrary suffix. */
export function formatForFilename(filename: string): string | null {
  const model = modelFormatFromFilename(filename);
  if (model !== undefined) return model;
  const extension = filenameExtension(filename);
  if (
    extension !== undefined &&
    (Object.hasOwn(EXTENSIONS, extension) ||
      EXTRA_EXTENSIONS.includes(extension))
  ) {
    return extension;
  }
  return null;
}

function validExtension(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      formatForFilename(`revision.${value}`) === value)
  );
}

/** Construct a filename with no source information for existing format detectors. */
export function formatFilename(extension: string | null): string {
  if (!validExtension(extension)) throw new Error('Invalid version format.');
  if (extension === null) return 'revision';
  return extension === 'dockerfile' ? 'Dockerfile' : `revision.${extension}`;
}

export function versionFormatFor(
  shape: 'file' | 'folder',
  filename: string
): VersionFormat {
  return shape === 'folder'
    ? { shape: 'folder' }
    : { shape: 'file', extension: formatForFilename(filename) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVersionFormat(value: unknown): value is VersionFormat {
  if (!isObject(value)) return false;
  if (value['shape'] === 'folder') return true;
  return value['shape'] === 'file' && validExtension(value['extension']);
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid relik version.');
  }
}

export function recordedVersionFormat(
  state: { readonly version_formats?: Readonly<Record<string, VersionFormat>> },
  version: number
): VersionFormat | undefined {
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  const formats: unknown = state.version_formats;
  if (!isObject(formats)) return undefined;
  const value = formats[String(version)];
  if (!isVersionFormat(value)) return undefined;
  return value.shape === 'folder'
    ? { shape: 'folder' }
    : { shape: 'file', extension: value.extension };
}

export function withVersionFormat(
  state: { readonly version_formats?: Readonly<Record<string, VersionFormat>> },
  version: number,
  format: VersionFormat
): Readonly<Record<string, VersionFormat>> {
  assertVersion(version);
  if (!isVersionFormat(format)) throw new Error('Invalid version format.');
  const formats = isObject(state.version_formats) ? state.version_formats : {};
  const normalized =
    format.shape === 'folder'
      ? { shape: 'folder' as const }
      : { shape: 'file' as const, extension: format.extension };
  return { ...formats, [String(version)]: normalized } as Readonly<
    Record<string, VersionFormat>
  >;
}

/** Preserve a known legacy single-file format before recording its successor. */
export function nextVersionFormats(
  state: {
    readonly version: number;
    readonly shape?: 'file' | 'folder' | undefined;
    readonly filename?: string | undefined;
    readonly version_formats?: Readonly<Record<string, VersionFormat>>;
  },
  version: number,
  format: VersionFormat
): Readonly<Record<string, VersionFormat>> {
  const outgoing =
    state.shape !== 'folder' &&
    typeof state.filename === 'string' &&
    state.filename.length > 0 &&
    recordedVersionFormat(state, state.version) === undefined
      ? {
          version_formats: withVersionFormat(
            state,
            state.version,
            versionFormatFor('file', state.filename)
          ),
        }
      : state;
  return withVersionFormat(outgoing, version, format);
}

function context(
  relicId: string,
  version: number
): { id: string; aad: Buffer } {
  const id = parseRelicId(relicId);
  assertVersion(version);
  return {
    id,
    aad: Buffer.from(JSON.stringify(['relic-suggestion-formats', id, version])),
  };
}

function derivedKey(
  key: Uint8Array,
  relicId: string,
  version: number,
  purpose: 'encryption' | 'entry-hmac'
): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Invalid relik content key.');
  const { aad } = context(relicId, version);
  return Buffer.from(
    hkdfSync('sha256', key, aad, `relic-suggestion-formats:${purpose}:v1`, 32)
  );
}

function pathDigest(path: string, key: Buffer): string {
  return createHmac('sha256', key).update(path, 'utf8').digest('hex');
}

export function buildCachedFormat(
  format: VersionFormat,
  paths: readonly string[],
  key: Uint8Array,
  relicId: string,
  version: number
): CachedVersionFormat {
  if (!isVersionFormat(format)) throw new Error('Invalid version format.');
  // Validate the binding even for file versions, which have no entry digests.
  context(relicId, version);
  if (key.length !== KEY_BYTES) throw new Error('Invalid relik content key.');
  if (format.shape === 'file') {
    return { shape: 'file', extension: format.extension };
  }
  const digestKey = derivedKey(key, relicId, version, 'entry-hmac');
  const entries: Record<string, string | null> = {};
  for (const path of paths) {
    entries[pathDigest(path, digestKey)] = formatForFilename(path);
  }
  return { shape: 'folder', entries };
}

export function cachedEntryFormat(
  cache: CachedVersionFormat,
  path: string,
  key: Uint8Array,
  relicId: string,
  version: number
): { found: boolean; extension: string | null } {
  if (cache.shape !== 'folder') return { found: false, extension: null };
  const digest = pathDigest(
    path,
    derivedKey(key, relicId, version, 'entry-hmac')
  );
  return Object.hasOwn(cache.entries, digest)
    ? { found: true, extension: cache.entries[digest]! }
    : { found: false, extension: null };
}

function isCachedVersionFormat(value: unknown): value is CachedVersionFormat {
  if (!isObject(value)) return false;
  if (value['shape'] === 'file') return validExtension(value['extension']);
  if (value['shape'] !== 'folder' || !isObject(value['entries'])) return false;
  return Object.entries(value['entries']).every(
    ([digest, extension]) =>
      /^[0-9a-f]{64}$/.test(digest) && validExtension(extension)
  );
}

/** The local cache file for one relic revision. */
export function cachedVersionFormatPath(
  relicId: string,
  version: number
): string {
  const { id } = context(relicId, version);
  const statePath = publishStatePath();
  return join(
    dirname(statePath),
    `${basename(statePath)}.suggestion-formats`,
    `${id}.${version}.bin`
  );
}

/** An absent file is missing; a corrupt, unreadable or unauthentic file throws. */
export async function loadCachedVersionFormat(
  relicId: string,
  version: number,
  key: Uint8Array
): Promise<CachedVersionFormat | undefined> {
  const path = cachedVersionFormatPath(relicId, version);
  const encryptionKey = derivedKey(key, relicId, version, 'encryption');
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    data.length <= MAGIC.length + NONCE_BYTES + TAG_BYTES ||
    !data.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error('The suggestion format cache is corrupt.');
  }
  try {
    const nonceEnd = MAGIC.length + NONCE_BYTES;
    const tagEnd = nonceEnd + TAG_BYTES;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      data.subarray(MAGIC.length, nonceEnd)
    );
    decipher.setAAD(context(relicId, version).aad);
    decipher.setAuthTag(data.subarray(nonceEnd, tagEnd));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(tagEnd)),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!isCachedVersionFormat(parsed))
      throw new Error('Invalid cached format.');
    return parsed.shape === 'file'
      ? { shape: 'file', extension: parsed.extension }
      : { shape: 'folder', entries: parsed.entries };
  } catch {
    throw new Error(
      'The suggestion format cache is corrupt or cannot be authenticated.'
    );
  }
}

function equalCachedFormat(
  a: CachedVersionFormat,
  b: CachedVersionFormat
): boolean {
  if (a.shape === 'file' && b.shape === 'file')
    return a.extension === b.extension;
  if (a.shape !== 'folder' || b.shape !== 'folder') return false;
  const keys = Object.keys(a.entries);
  return (
    keys.length === Object.keys(b.entries).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b.entries, key) && a.entries[key] === b.entries[key]
    )
  );
}

/** A version's cache is immutable once saved. Never replace a damaged cache. */
export async function saveCachedVersionFormat(
  relicId: string,
  version: number,
  key: Uint8Array,
  format: CachedVersionFormat
): Promise<void> {
  if (!isCachedVersionFormat(format))
    throw new Error('Invalid cached version format.');
  const normalized: CachedVersionFormat =
    format.shape === 'file'
      ? { shape: 'file', extension: format.extension }
      : { shape: 'folder', entries: format.entries };
  const path = cachedVersionFormatPath(relicId, version);
  const encryptionKey = derivedKey(key, relicId, version, 'encryption');
  const previous = await loadCachedVersionFormat(relicId, version, key);
  if (previous !== undefined) {
    if (!equalCachedFormat(previous, normalized)) {
      throw new Error(
        'The suggestion format cache conflicts with this version.'
      );
    }
    return;
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(context(relicId, version).aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(normalized), 'utf8'),
    cipher.final(),
  ]);
  const bytes = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const recoveryLocks = new Map<string, Promise<void>>();

/** Serialize recovery for one relic and version within this process. */
export async function withVersionFormatLock<T>(
  relicId: string,
  version: number,
  action: () => Promise<T>
): Promise<T> {
  const lockId = cachedVersionFormatPath(relicId, version);
  const previous = recoveryLocks.get(lockId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoveryLocks.set(lockId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (recoveryLocks.get(lockId) === current) recoveryLocks.delete(lockId);
  }
}
