import { describe, expect, test } from 'bun:test';
import type { ZipIndex } from '@relic/format/zip-index';
import {
  includeDocxPart,
  selectDocxParts,
} from '../src/document-payload-docx.ts';
import EntryArchive from '../src/frame-zip-entries.ts';

describe('DOCX package input', () => {
  test('selects declared XML and relationship targets regardless of filename', async () => {
    const office =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const files: Record<string, string> = {
      '[Content_Types].xml':
        '<Types><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="strange" ContentType="application/xml; charset=utf-8"/></Types>',
      '_rels/.rels': `<Relationships><Relationship Type="${office}officeDocument" Target="word/body.payload"/></Relationships>`,
      'word/body.payload': '<document/>',
      'word/_rels/body.payload.rels': `<Relationships><Relationship Type="${office}header" Target="nested/header.data"/></Relationships>`,
      'word/nested/header.data': '<header/>',
      'word/metadata.strange': '<metadata/>',
      'word/media/image.png': 'image',
      'word/embeddings/private.xml': '<private/>',
    };
    const index = {
      entries: new Map(
        Object.keys(files).map((name) => [name, { kind: 'file' }])
      ),
      async read(name: string) {
        const value = files[name];
        return value === undefined
          ? { ok: false, reason: 'not-a-file', message: 'missing' }
          : { ok: true, bytes: new TextEncoder().encode(value) };
      },
    } as unknown as ZipIndex;
    const selected = await selectDocxParts(index);
    expect(selected.parts).not.toContain('word/embeddings/private.xml');
    for (const path of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/body.payload',
      'word/_rels/body.payload.rels',
      'word/nested/header.data',
      'word/metadata.strange',
    ]) {
      expect(selected.xmlParts.has(path)).toBe(true);
    }
    expect(selected.xmlParts.has('word/media/image.png')).toBe(false);
  });
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
    expect(archive.files['missing']).toBeUndefined();
  });
});
