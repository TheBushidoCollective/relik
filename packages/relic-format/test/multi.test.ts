import { describe, expect, test } from 'bun:test';
import {
  checkEntrySet,
  decodeManifest,
  encodeManifest,
  entryPathRule,
  normaliseEntryPath,
} from '../src/multi.ts';
import {
  decryptComment,
  deriveCommentKey,
  encryptComment,
} from '../src/comments.ts';
import { MalformedCommentError, StrictParseError } from '../src/errors.ts';

describe('folder paths and manifests', () => {
  test.each([
    ['\ud800', 'not_utf8'],
    ['e\u0301', 'not_nfc'],
    ['/a', 'empty_segment'],
    ['a/../b', 'dot_segment'],
    [Array(33).fill('a').join('/'), 'too_deep'],
    ['a'.repeat(256), 'segment_too_long'],
    [Array(5).fill('a'.repeat(205)).join('/'), 'path_too_long'],
    ['a\u202eb', 'forbidden_character'],
    ['C:x', 'drive_prefix'],
  ])('refuses path %s as %s', (path, rule) =>
    expect<string | undefined>(entryPathRule(path)).toBe(rule)
  );
  test.each([
    [['a', 'a'], 'duplicate'],
    [['b', 'a'], 'out_of_order'],
    [['A/x', 'a/y'], 'fold_collision'],
    [['a', 'a/b'], 'file_and_directory'],
    [['SS', 'ß'], 'fold_collision'],
    [['é/a', 'é/b'], undefined],
  ])('checks entry set %j', (paths, rule) => {
    const result = checkEntrySet(paths as string[]);
    if (rule === undefined) expect(result.ok).toBe(true);
    else
      expect<string | undefined>(result.ok ? undefined : result.rule).toBe(
        rule
      );
  });
  test('writer normalizes paths but reader refuses decomposed input', () => {
    expect(normaliseEntryPath('e\u0301/file')).toEqual({
      ok: true,
      path: 'é/file',
    });
    expect(entryPathRule('e\u0301/file')).toBe('not_nfc');
  });
  test.each([1, 5000])('round trips a manifest with %i entries', (count) => {
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `${String(i).padStart(5, '0')}.txt`,
      mimetype: 'text/plain',
      length: i,
    }));
    const bytes = encodeManifest(0, entries);
    const header = {
      version: 2 as const,
      name: '',
      entryCount: count,
      manifestLength: bytes.length,
      contentLength: bytes.length + (count * (count - 1)) / 2,
    };
    const result = decodeManifest(bytes, header);
    expect(result.entries.length).toBe(count);
    expect(result.entries.at(-1)?.length).toBe(count - 1);
    expect(() =>
      decodeManifest(bytes, {
        ...header,
        contentLength: header.contentLength + 1,
      })
    ).toThrow(StrictParseError);
  });
});

describe('comment entry', () => {
  test('round trips a canonical path and refuses an invalid write', async () => {
    const key = await deriveCommentKey(new Uint8Array(16));
    const ciphertext = await encryptComment(key, {
      body: 'hi',
      display_name: null,
      entry: 'dir/file.md',
    });
    expect((await decryptComment(key, ciphertext)).entry).toBe('dir/file.md');
    await expect(
      encryptComment(key, { body: 'hi', display_name: null, entry: '../bad' })
    ).rejects.toBeInstanceOf(MalformedCommentError);
  });
  test('reports an invalid entry when reading sealed JSON', async () => {
    const key = await deriveCommentKey(new Uint8Array(16));
    const nonce = new Uint8Array(12);
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ body: 'hi', display_name: null, entry: '../bad' })
    );
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        key,
        plaintext
      )
    );
    const framed = new Uint8Array(nonce.length + encrypted.length);
    framed.set(nonce);
    framed.set(encrypted, nonce.length);
    await expect(
      decryptComment(key, Buffer.from(framed).toString('base64url'))
    ).rejects.toBeInstanceOf(MalformedCommentError);
  });
});
