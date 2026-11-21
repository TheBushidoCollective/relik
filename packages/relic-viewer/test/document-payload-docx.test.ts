import { describe, expect, test } from 'bun:test';
import { includeDocxPart } from '../src/document-payload-docx.ts';
import EntryArchive from '../src/frame-zip-entries.ts';

describe('DOCX package input', () => {
  test('excludes embedded objects, custom XML, binary parts, and thumbnails', () => {
    for (const path of [
      'word/embeddings/a.docx',
      'customXml/item1.xml',
      'word/data.bin',
      'docProps/thumbnail.jpeg',
    ]) {
      expect(includeDocxPart(path)).toBe(false);
    }
    for (const path of [
      'word/document.xml',
      'word/media/image1.png',
      'docProps/app.xml',
    ]) {
      expect(includeDocxPart(path)).toBe(true);
    }
  });
  test('exposes only supplied entries in all formats consumed by the renderer', async () => {
    const archive = await EntryArchive.loadAsync(
      new Map([['word/document.xml', new TextEncoder().encode('hello')]])
    );
    const entry = archive.files['word/document.xml']!;
    expect(await entry.async('string')).toBe('hello');
    expect(
      new TextDecoder().decode((await entry.async('uint8array')) as Uint8Array)
    ).toBe('hello');
    expect(await ((await entry.async('blob')) as Blob).text()).toBe('hello');
    expect(archive.files['__proto__']).toBeUndefined();
    expect(archive.files['missing']).toBeUndefined();
  });
});
