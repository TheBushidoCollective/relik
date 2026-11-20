import { StrictParseError } from './errors.ts';

export const ENVELOPE_VERSIONS: readonly number[] = [1, 2];
export const MAX_ENTRIES = 5_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_DEPTH = 32;
export const MAX_NAME_BYTES = 1024;

export interface FolderHeader {
  readonly version: 2;
  readonly name: string;
  readonly entryCount: number;
  readonly manifestLength: number;
  readonly contentLength: number;
}
export interface FolderEntry {
  readonly path: string;
  readonly mimetype: string;
  readonly offset: number;
  readonly length: number;
}
export interface FolderManifest {
  readonly defaultIndex: number;
  readonly entries: readonly FolderEntry[];
}
export type PathRule =
  | 'not_utf8'
  | 'not_nfc'
  | 'empty_segment'
  | 'dot_segment'
  | 'too_deep'
  | 'segment_too_long'
  | 'path_too_long'
  | 'forbidden_character'
  | 'drive_prefix';
export type SetRule =
  | 'out_of_order'
  | 'duplicate'
  | 'fold_collision'
  | 'file_and_directory';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const forbidden =
  /[\u0000-\u001f\u007f-\u009f\\\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

export function entryPathRule(path: string): PathRule | undefined {
  if (decoder.decode(encoder.encode(path)) !== path) return 'not_utf8';
  if (path !== path.normalize('NFC')) return 'not_nfc';
  const segments = path.split('/');
  if (segments.some((s) => s.length === 0)) return 'empty_segment';
  if (segments.some((s) => s === '.' || s === '..')) return 'dot_segment';
  if (segments.length > MAX_PATH_DEPTH) return 'too_deep';
  if (segments.some((s) => encoder.encode(s).length > MAX_SEGMENT_BYTES))
    return 'segment_too_long';
  if (encoder.encode(path).length > MAX_PATH_BYTES) return 'path_too_long';
  if (forbidden.test(path)) return 'forbidden_character';
  if (/^[A-Za-z]:/.test(segments[0]!)) return 'drive_prefix';
  return undefined;
}
export function normaliseEntryPath(
  raw: string
): { ok: true; path: string } | { ok: false; rule: PathRule } {
  if (decoder.decode(encoder.encode(raw)) !== raw)
    return { ok: false, rule: 'not_utf8' };
  const path = raw.normalize('NFC');
  const rule = entryPathRule(path);
  return rule === undefined ? { ok: true, path } : { ok: false, rule };
}
export function compareEntryPaths(a: string, b: string): number {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function foldEntryPath(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}
export function checkEntrySet(
  sorted: readonly string[]
):
  | { ok: true }
  | { ok: false; rule: SetRule; paths: readonly [string, string] } {
  const prefixes = new Map<
    string,
    { path: string; owner: string; file: boolean }
  >();
  for (let i = 0; i < sorted.length; i++) {
    const path = sorted[i]!;
    if (i > 0) {
      const previous = sorted[i - 1]!;
      const order = compareEntryPaths(previous, path);
      if (order === 0)
        return { ok: false, rule: 'duplicate', paths: [previous, path] };
      if (order > 0)
        return { ok: false, rule: 'out_of_order', paths: [previous, path] };
    }
    const parts = path.split('/');
    let prefix = '';
    for (let j = 0; j < parts.length; j++) {
      prefix = prefix ? `${prefix}/${parts[j]}` : parts[j]!;
      const file = j === parts.length - 1;
      const folded = foldEntryPath(prefix);
      const existing = prefixes.get(folded);
      if (existing) {
        if (existing.file !== file)
          return {
            ok: false,
            rule: 'file_and_directory',
            paths: [existing.owner, path],
          };
        if (existing.path !== prefix)
          return {
            ok: false,
            rule: 'fold_collision',
            paths: [existing.owner, path],
          };
      } else prefixes.set(folded, { path: prefix, owner: path, file });
    }
  }
  return { ok: true };
}
function validLength(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}
export function encodeFolderHeader(
  header: Omit<FolderHeader, 'version'>
): Uint8Array {
  const name = encoder.encode(header.name);
  if (
    name.length > MAX_NAME_BYTES ||
    !Number.isInteger(header.entryCount) ||
    header.entryCount < 1 ||
    header.entryCount > MAX_ENTRIES ||
    !Number.isInteger(header.manifestLength) ||
    header.manifestLength < 17 ||
    header.manifestLength > MAX_MANIFEST_BYTES ||
    !validLength(header.contentLength) ||
    header.contentLength < header.manifestLength ||
    header.contentLength > 524288000
  )
    throw new StrictParseError('invalid folder header');
  const out = new Uint8Array(19 + name.length),
    view = new DataView(out.buffer);
  out[0] = 2;
  view.setUint16(1, name.length);
  out.set(name, 3);
  let p = 3 + name.length;
  view.setUint32(p, header.entryCount);
  p += 4;
  view.setUint32(p, header.manifestLength);
  p += 4;
  view.setBigUint64(p, BigInt(header.contentLength));
  return out;
}
export function encodeManifest(
  defaultIndex: number,
  entries: readonly { path: string; mimetype: string; length: number }[]
): Uint8Array {
  if (
    entries.length < 1 ||
    entries.length > MAX_ENTRIES ||
    !Number.isInteger(defaultIndex) ||
    defaultIndex < 0 ||
    defaultIndex >= entries.length
  )
    throw new StrictParseError('invalid manifest count or default');
  const check = checkEntrySet(entries.map((entry) => entry.path));
  if (!check.ok) throw new StrictParseError(`invalid entry set: ${check.rule}`);
  const parts = entries.map((entry) => {
    const rule = entryPathRule(entry.path);
    if (rule) throw new StrictParseError(`invalid entry path: ${rule}`);
    const path = encoder.encode(entry.path),
      mime = encoder.encode(entry.mimetype);
    if (mime.length > 255 || !validLength(entry.length))
      throw new StrictParseError('invalid entry metadata');
    return { path, mime, length: entry.length };
  });
  const size =
    4 +
    parts.reduce(
      (sum, part) => sum + 12 + part.path.length + part.mime.length,
      0
    );
  if (size > MAX_MANIFEST_BYTES)
    throw new StrictParseError('manifest too large');
  const out = new Uint8Array(size),
    view = new DataView(out.buffer);
  view.setUint32(0, defaultIndex);
  let p = 4;
  for (const part of parts) {
    view.setUint16(p, part.path.length);
    p += 2;
    out.set(part.path, p);
    p += part.path.length;
    view.setUint16(p, part.mime.length);
    p += 2;
    out.set(part.mime, p);
    p += part.mime.length;
    view.setBigUint64(p, BigInt(part.length));
    p += 8;
  }
  return out;
}
export function decodeManifest(
  bytes: Uint8Array,
  header: FolderHeader
): FolderManifest {
  if (
    bytes.length !== header.manifestLength ||
    bytes.length > MAX_MANIFEST_BYTES ||
    header.entryCount < 1 ||
    header.entryCount > MAX_ENTRIES ||
    bytes.length < 4
  )
    throw new StrictParseError('invalid manifest size or count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const take = (n: number): number => {
    const old = p;
    p += n;
    if (p > bytes.length) throw new StrictParseError('truncated manifest');
    return old;
  };
  const defaultIndex = view.getUint32(take(4));
  if (defaultIndex >= header.entryCount)
    throw new StrictParseError('invalid default index');
  const entries: FolderEntry[] = [];
  let offset = header.manifestLength;
  for (let i = 0; i < header.entryCount; i++) {
    const pathLength = view.getUint16(take(2));
    let path: string;
    try {
      path = fatalDecoder.decode(
        bytes.subarray(p, take(pathLength) + pathLength)
      );
    } catch {
      throw new StrictParseError('invalid entry path: not_utf8');
    }
    const rule = entryPathRule(path);
    if (rule) throw new StrictParseError(`invalid entry path: ${rule}`);
    const mimeLength = view.getUint16(take(2));
    if (mimeLength > 255) throw new StrictParseError('mimetype too long');
    const mimeStart = take(mimeLength);
    const mimetype = decoder.decode(bytes.subarray(mimeStart, p));
    const value = view.getBigUint64(take(8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new StrictParseError('entry length exceeds safe range');
    const length = Number(value);
    entries.push({ path, mimetype, offset, length });
    offset += length;
    if (!Number.isSafeInteger(offset))
      throw new StrictParseError('content length exceeds safe range');
  }
  if (p !== bytes.length)
    throw new StrictParseError('manifest has trailing bytes');
  const check = checkEntrySet(entries.map((entry) => entry.path));
  if (!check.ok) throw new StrictParseError(`invalid entry set: ${check.rule}`);
  if (offset !== header.contentLength)
    throw new StrictParseError('manifest content length mismatch');
  return { defaultIndex, entries };
}
export function chooseDefaultEntry(
  entries: readonly { path: string; renderable: boolean }[],
  openFirst?: string
): { ok: true; index: number } | { ok: false } {
  if (openFirst !== undefined) {
    const normalized = normaliseEntryPath(openFirst);
    if (!normalized.ok) return { ok: false };
    const index = entries.findIndex((entry) => entry.path === normalized.path);
    return index < 0 ? { ok: false } : { ok: true, index };
  }
  for (const name of [
    'readme.md',
    'readme.markdown',
    'readme.txt',
    'readme',
    'index.md',
    'index.html',
    'index.htm',
  ]) {
    const index = entries.findIndex(
      (entry) => entry.path.toLowerCase() === name
    );
    if (index >= 0) return { ok: true, index };
  }
  const index = entries.findIndex((entry) => entry.renderable);
  return entries.length
    ? { ok: true, index: Math.max(0, index) }
    : { ok: false };
}
export function resolveEntryReference(
  manifest: FolderManifest,
  fromPath: string,
  target: string
): number | undefined {
  if (
    !target ||
    target.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
    target.includes('\\')
  )
    return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
  } catch {
    return undefined;
  }
  const parts = fromPath.split('/');
  parts.pop();
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join('/').normalize('NFC');
  if (entryPathRule(path)) return undefined;
  const index = manifest.entries.findIndex((entry) => entry.path === path);
  return index < 0 ? undefined : index;
}
