import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { docxImageSourceDigest } from '../src/image-identity.ts';

const hash = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('DOCX image identity', () => {
  test('hashes the part name and the image content digest', async () => {
    const bytes = new Uint8Array([0, 11, 22, 33, 44]).subarray(1, 4);
    const name = 'word/media/Schéma.png';
    const expected = hash(JSON.stringify(['docx-image', name, hash(bytes)]));
    expect(await docxImageSourceDigest(name, bytes)).toBe(expected);
    expect(await docxImageSourceDigest(name, bytes)).toBe(expected);
  });

  test('different image parts or bytes produce different identities', async () => {
    const bytes = new TextEncoder().encode('first image');
    const original = await docxImageSourceDigest('word/media/a.png', bytes);
    expect(await docxImageSourceDigest('word/media/b.png', bytes)).not.toBe(
      original
    );
    expect(
      await docxImageSourceDigest(
        'word/media/a.png',
        new TextEncoder().encode('second image')
      )
    ).not.toBe(original);
  });

  test('accepts the supplied crypto implementation for both hash operations', async () => {
    const calls: string[] = [];
    const subtle = {
      async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
        calls.push(String(algorithm));
        return crypto.subtle.digest(algorithm, data);
      },
    } as SubtleCrypto;
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await docxImageSourceDigest(
      'word/media/a.png',
      bytes,
      subtle
    );
    expect(result).toBe(
      hash(JSON.stringify(['docx-image', 'word/media/a.png', hash(bytes)]))
    );
    expect(calls).toEqual(['SHA-256', 'SHA-256']);
  });
});
