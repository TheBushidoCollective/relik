/**
 * DEFLATE for the ZIP readers the MCP runs over decrypted content (OTIO
 * bundles, XLSX workbooks, DOCX and EPUB text). The caller's byte budget caps
 * the output, and a result past the budget is refused rather than returned.
 *
 * The executor form is deliberate: the newer promise helpers are past the
 * Node floor this package supports, and node-compat.test.ts forbids them.
 */

import { inflateRaw } from 'node:zlib';
import type { InflaterFn } from '@relic/format';

export const nodeInflater: InflaterFn = (
  compressed,
  uncompressedSize,
  maxBytes
) => {
  if (
    !Number.isSafeInteger(uncompressedSize) ||
    uncompressedSize < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  ) {
    return Promise.reject(
      new Error('decompression sizes must be non-negative safe integers')
    );
  }
  if (uncompressedSize > maxBytes) {
    return Promise.reject(
      new Error(
        `declared decompressed size ${uncompressedSize} exceeds ${maxBytes}`
      )
    );
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      // zlib requires a positive cap; an empty entry still has a zero-byte result budget.
      inflateRaw(
        compressed,
        { maxOutputLength: Math.max(1, maxBytes) },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          if (result.length > maxBytes) {
            reject(
              new Error(`inflated size ${result.length} exceeds ${maxBytes}`)
            );
            return;
          }
          resolve(result);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
};
