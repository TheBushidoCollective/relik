import { describe, expect, test } from 'bun:test';
import {
  COMMENT_ANCHOR_CELL_MAX_COL,
  COMMENT_ANCHOR_CELL_MAX_ROW,
  COMMENT_ANCHOR_POINTER_LIMIT_BYTES,
  COMMENT_ANCHOR_SHEET_LIMIT_BYTES,
  COMMENT_NONCE_BYTES,
  decryptComment,
  deriveCommentKey,
  encryptComment,
} from '../src/comments.ts';
import { MalformedCommentError } from '../src/errors.ts';
import { generateKey } from '../src/fragment.ts';

/**
 * Seal an arbitrary anchor value under a comment key, bypassing the writer so
 * the reader's own validation is what is under test.
 */
async function sealAnchor(key: CryptoKey, anchor: unknown): Promise<string> {
  const json = JSON.stringify({
    body: 'a remark',
    display_name: null,
    anchor,
  });
  const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer },
      key,
      new TextEncoder().encode(json).slice().buffer as ArrayBuffer
    )
  );
  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce, 0);
  framed.set(sealed, nonce.length);
  return Buffer.from(framed).toString('base64url');
}

/** What a reader makes of an anchor value written by some other client. */
async function readAnchor(anchor: unknown): Promise<unknown> {
  const key = await deriveCommentKey(generateKey());
  return (await decryptComment(key, await sealAnchor(key, anchor))).anchor;
}

/** What this package's writer does with an anchor value. */
async function writeAnchor(anchor: unknown): Promise<string> {
  const key = await deriveCommentKey(generateKey());
  return encryptComment(key, {
    body: 'a remark',
    display_name: null,
    anchor,
  } as Parameters<typeof encryptComment>[1]);
}

async function expectReaderRefuses(anchor: unknown): Promise<void> {
  await expect(readAnchor(anchor)).rejects.toBeInstanceOf(
    MalformedCommentError
  );
}

async function expectWriterRefuses(anchor: unknown): Promise<void> {
  await expect(writeAnchor(anchor)).rejects.toBeInstanceOf(
    MalformedCommentError
  );
}

describe('cell anchors: accepted', () => {
  const accepted: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a single cell', { kind: 'cell', row: 14, col: 3 }],
    [
      'a range with a sheet',
      {
        kind: 'cell',
        row: 4,
        col: 2,
        row_end: 9,
        col_end: 4,
        sheet: 'Q3 budget',
      },
    ],
    ['the header row, which is row 1', { kind: 'cell', row: 1, col: 1 }],
    [
      'a row end alone, with the column as its start',
      { kind: 'cell', row: 2, col: 3, row_end: 5 },
    ],
    [
      'the largest coordinates',
      {
        kind: 'cell',
        row: COMMENT_ANCHOR_CELL_MAX_ROW,
        col: COMMENT_ANCHOR_CELL_MAX_COL,
      },
    ],
    [
      'a sheet name at the byte cap',
      {
        kind: 'cell',
        row: 1,
        col: 1,
        sheet: 'é'.repeat(COMMENT_ANCHOR_SHEET_LIMIT_BYTES / 2),
      },
    ],
  ];

  for (const [name, anchor] of accepted) {
    test(`${name} reads back as written`, async () => {
      expect(await readAnchor(anchor)).toEqual(anchor);
    });

    test(`${name} is accepted by the writer`, async () => {
      const key = await deriveCommentKey(generateKey());
      const sealed = await encryptComment(key, {
        body: 'a remark',
        display_name: null,
        anchor: anchor as never,
      });
      expect((await decryptComment(key, sealed)).anchor).toEqual(
        anchor as never
      );
    });
  }
});

describe('cell anchors: refused by the reader and the writer', () => {
  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ['row zero', { kind: 'cell', row: 0, col: 1 }],
    [
      'a row past the sanity cap',
      { kind: 'cell', row: COMMENT_ANCHOR_CELL_MAX_ROW + 1, col: 1 },
    ],
    ['a fractional row', { kind: 'cell', row: 1.5, col: 1 }],
    ['a string row', { kind: 'cell', row: '3', col: 1 }],
    ['a missing row', { kind: 'cell', col: 1 }],
    ['column zero', { kind: 'cell', row: 1, col: 0 }],
    [
      'a column past Excel width',
      { kind: 'cell', row: 1, col: COMMENT_ANCHOR_CELL_MAX_COL + 1 },
    ],
    ['a negative column', { kind: 'cell', row: 1, col: -2 }],
    [
      'a row end before its start',
      { kind: 'cell', row: 9, col: 1, row_end: 4 },
    ],
    [
      'a column end before its start',
      { kind: 'cell', row: 1, col: 5, col_end: 2 },
    ],
    ['a row end of zero', { kind: 'cell', row: 1, col: 1, row_end: 0 }],
    ['a null column end', { kind: 'cell', row: 1, col: 1, col_end: null }],
    ['an unknown field', { kind: 'cell', row: 1, col: 1, formula: '=A1' }],
    ['an empty sheet name', { kind: 'cell', row: 1, col: 1, sheet: '' }],
    [
      'a sheet name past the byte cap',
      {
        kind: 'cell',
        row: 1,
        col: 1,
        sheet: 'a'.repeat(COMMENT_ANCHOR_SHEET_LIMIT_BYTES + 1),
      },
    ],
    [
      'a sheet name with a control character',
      { kind: 'cell', row: 1, col: 1, sheet: 'Q3\u0007' },
    ],
    [
      'a sheet name with a bidi override',
      { kind: 'cell', row: 1, col: 1, sheet: 'Q3\u202ebudget' },
    ],
    [
      'a sheet name with an isolate control',
      { kind: 'cell', row: 1, col: 1, sheet: 'Q3\u2066x' },
    ],
    [
      'a sheet name that is a number',
      { kind: 'cell', row: 1, col: 1, sheet: 7 },
    ],
  ];

  for (const [name, anchor] of refused) {
    test(`${name} is refused on read`, async () => {
      await expectReaderRefuses(anchor);
    });

    test(`${name} is refused on write`, async () => {
      await expectWriterRefuses(anchor);
    });
  }
});

describe('path anchors: accepted', () => {
  const accepted: readonly string[] = [
    '',
    '/cells/7/outputs/0',
    '/a~0b/c~1d',
    `/${'a'.repeat(COMMENT_ANCHOR_POINTER_LIMIT_BYTES - 1)}`,
  ];

  for (const pointer of accepted) {
    test(`pointer of ${pointer.length} characters reads back as written`, async () => {
      const anchor = { kind: 'path', pointer };
      expect(await readAnchor(anchor)).toEqual(anchor);
    });
  }

  test('the empty pointer is the whole document and the writer accepts it', async () => {
    const key = await deriveCommentKey(generateKey());
    const sealed = await encryptComment(key, {
      body: 'about the whole file',
      display_name: null,
      anchor: { kind: 'path', pointer: '' },
    });
    expect((await decryptComment(key, sealed)).anchor).toEqual({
      kind: 'path',
      pointer: '',
    });
  });
});

describe('path anchors: refused by the reader and the writer', () => {
  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ['no leading slash', { kind: 'path', pointer: 'cells/7' }],
    ['a bare tilde at the end', { kind: 'path', pointer: '/a~' }],
    ['a tilde escape other than 0 or 1', { kind: 'path', pointer: '/a~2b' }],
    ['a tilde before a letter', { kind: 'path', pointer: '/~x' }],
    ['a NUL', { kind: 'path', pointer: '/a\u0000b' }],
    ['a carriage return', { kind: 'path', pointer: '/a\rb' }],
    [
      'a pointer past the byte cap',
      {
        kind: 'path',
        pointer: `/${'a'.repeat(COMMENT_ANCHOR_POINTER_LIMIT_BYTES)}`,
      },
    ],
    ['a missing pointer', { kind: 'path' }],
    ['a numeric pointer', { kind: 'path', pointer: 3 }],
    ['an unknown field', { kind: 'path', pointer: '/a', index: 3 }],
  ];

  for (const [name, anchor] of refused) {
    test(`${name} is refused on read`, async () => {
      await expectReaderRefuses(anchor);
    });

    test(`${name} is refused on write`, async () => {
      await expectWriterRefuses(anchor);
    });
  }
});
