import { expect, test } from 'bun:test';
import { ContentTooLargeError } from '../src/errors.ts';
import { readOtioDocument } from '../src/otio-identity.ts';
import { OTIO_DOCUMENT_MAX_BYTES } from '../src/otio-zip.ts';

test('rejects an oversized raw OTIO document before hashing or parsing', () => {
  const source = {
    length: OTIO_DOCUMENT_MAX_BYTES + 1,
  } as unknown as Uint8Array;
  expect(() => readOtioDocument(source)).toThrow(ContentTooLargeError);
});
