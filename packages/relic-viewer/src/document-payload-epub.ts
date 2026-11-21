import { readEpubPackage } from '../../relic-format/src/epub-package.ts';
import { scanForbiddenDtd } from '../../relic-format/src/xml.ts';
import type { ZipIndex } from '../../relic-format/src/zip-index.ts';
import type { EpubBook } from './frame-document-protocol.ts';

export async function epubPayload(
  index: ZipIndex
): Promise<
  | { ok: true; book: EpubBook; entries: [string, Uint8Array][] }
  | { ok: false; reason: 'protected' | 'corrupt' | 'too-large' }
> {
  const result = await readEpubPackage(index);
  if (!result.ok) return result;
  const entries: [string, Uint8Array][] = [];
  for (const name of result.parts) {
    const read = await index.read(name);
    if (!read.ok)
      return {
        ok: false,
        reason: read.reason.includes('large') ? 'too-large' : 'corrupt',
      };
    const prefix = read.bytes.subarray(0, 256);
    const looksXml =
      /(?:\.xml|\.xhtml|\.html|\.htm|\.opf|\.ncx|\.svg)$/i.test(name) ||
      /^\s*</.test(new TextDecoder().decode(prefix)) ||
      (prefix[0] === 0xff && prefix[1] === 0xfe) ||
      (prefix[0] === 0xfe && prefix[1] === 0xff) ||
      (prefix[0] === 0x3c && prefix[1] === 0) ||
      (prefix[0] === 0 && prefix[1] === 0x3c);
    if (looksXml && scanForbiddenDtd(read.bytes, 'epub'))
      return { ok: false, reason: 'corrupt' };
    entries.push([name, read.bytes]);
  }
  return { ok: true, book: result.book, entries };
}
