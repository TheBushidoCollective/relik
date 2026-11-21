import { describe, expect, test } from 'bun:test';
import type { ZipEntryInfo, ZipIndex } from '@relic/format/zip-index';
import {
  includeDocxPart,
  selectDocxParts,
} from '../src/document-payload-docx.ts';
import EntryArchive from '../src/frame-zip-entries.ts';

function indexFor(
  files: Readonly<Record<string, string | Uint8Array>>,
  reads: string[] = []
): ZipIndex {
  const encoder = new TextEncoder();
  const contents = new Map<string, Uint8Array>();
  const entries = new Map<string, ZipEntryInfo>();
  for (const [name, value] of Object.entries(files)) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    contents.set(name, bytes);
    entries.set(name, {
      name,
      kind: 'file',
      method: 0,
      compressedSize: bytes.byteLength,
      size: bytes.byteLength,
      encrypted: false,
    });
  }
  return {
    entries,
    async read(name) {
      reads.push(name);
      const bytes = contents.get(name);
      return bytes === undefined
        ? { ok: false, reason: 'not-a-file', message: 'missing' }
        : { ok: true, bytes };
    },
  };
}

function utf16(xml: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const offset = bom ? 2 : 0;
  const bytes = new Uint8Array(offset + xml.length * 2);
  if (bom) {
    bytes[0] = littleEndian ? 0xff : 0xfe;
    bytes[1] = littleEndian ? 0xfe : 0xff;
  }
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    bytes[offset + i * 2 + (littleEndian ? 0 : 1)] = code & 0xff;
    bytes[offset + i * 2 + (littleEndian ? 1 : 0)] = code >>> 8;
  }
  return bytes;
}

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
    const selected = await selectDocxParts(indexFor(files));
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
  test('accepts UTF-16 metadata with either byte order and optional BOM', async () => {
    const office =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const types =
      '<Types><Default Extension="xml" ContentType="application/xml"/></Types>';
    const rels = `<Relationships><Relationship Id="r1" Type="${office}officeDocument" Target="word/document.xml"/></Relationships>`;
    for (const littleEndian of [true, false]) {
      for (const bom of [true, false]) {
        const selected = await selectDocxParts(
          indexFor({
            '[Content_Types].xml': utf16(types, littleEndian, bom),
            '_rels/.rels': utf16(rels, littleEndian, bom),
            'word/document.xml': '<document/>',
          })
        );
        expect(selected.xmlParts.has('word/document.xml')).toBe(true);
        expect(selected.xmlParts.has('_rels/.rels')).toBe(true);
      }
    }
  });

  test('follows custom-properties relationships and rejects invalid direct children', async () => {
    const office =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const packageRel =
      'http://schemas.openxmlformats.org/package/2006/relationships/';
    const selected = await selectDocxParts(
      indexFor({
        '[Content_Types].xml': '<Types/>',
        '_rels/.rels': `<r:Relationships xmlns:r="urn:rels"><r:Relationship Id="r1" Type="${packageRel}metadata/custom-properties" Target="docProps/extra.payload"/></r:Relationships>`,
        'docProps/extra.payload': '<properties/>',
        'docProps/_rels/extra.payload.rels': `<Relationships><Relationship Id="r2" Type="${office}header" Target="nested.payload"/></Relationships>`,
        'docProps/nested.payload': '<header/>',
      })
    );
    expect(selected.xmlParts.has('docProps/extra.payload')).toBe(true);
    expect(selected.xmlParts.has('docProps/nested.payload')).toBe(true);

    for (const rels of [
      '<Relationships><Other Id="r1" Type="urn:test" Target="part.xml"/></Relationships>',
      '<Relationships><Relationship Id="r1" Type="urn:test"/></Relationships>',
    ]) {
      await expect(
        selectDocxParts(
          indexFor({ '[Content_Types].xml': '<Types/>', '_rels/.rels': rels })
        )
      ).rejects.toThrow('Invalid DOCX relationship');
    }
  });

  test('stops selection when a metadata read finishes after cancellation', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: string[] = [];
    const source = indexFor({
      '[Content_Types].xml': '<Types/>',
      '_rels/.rels': '<Relationships/>',
    });
    const held: ZipIndex = {
      entries: source.entries,
      async read(name) {
        attempts.push(name);
        started.resolve();
        await release.promise;
        return source.read(name);
      },
    };
    const controller = new AbortController();
    const selection = selectDocxParts(held, controller.signal);
    await started.promise;
    controller.abort();
    release.resolve();
    await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toEqual(['[Content_Types].xml']);

    await expect(
      selectDocxParts(held, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toEqual(['[Content_Types].xml']);
  });

  test('caps the aggregate expanded metadata bytes before and after reads', async () => {
    const limit = 4 * 1024 * 1024;
    const rels = '<Relationships/>';
    const prefix = '<Types>';
    const suffix = '</Types>';
    const types =
      prefix +
      ' '.repeat(limit - rels.length - prefix.length - suffix.length) +
      suffix;
    const withinLimit = await selectDocxParts(
      indexFor({ '[Content_Types].xml': types, '_rels/.rels': rels })
    );
    expect(withinLimit.xmlParts.has('_rels/.rels')).toBe(true);

    const reads: string[] = [];
    await expect(
      selectDocxParts(
        indexFor(
          {
            '[Content_Types].xml': types,
            '_rels/.rels': '<Relationships> </Relationships>',
          },
          reads
        )
      )
    ).rejects.toThrow('DOCX metadata byte limit exceeded');
    expect(reads).toEqual(['[Content_Types].xml']);

    const actualReads: string[] = [];
    const source = indexFor(
      {
        '[Content_Types].xml': '<Types/>',
        '_rels/.rels': `<Relationships>${' '.repeat(limit)}</Relationships>`,
      },
      actualReads
    );
    const entries = new Map(source.entries);
    entries.set('_rels/.rels', { ...entries.get('_rels/.rels')!, size: 1 });
    await expect(selectDocxParts({ ...source, entries })).rejects.toThrow(
      'DOCX metadata byte limit exceeded'
    );
    expect(actualReads).toEqual(['[Content_Types].xml', '_rels/.rels']);
  });

  test('shares the element budget across metadata files', async () => {
    const defaults = Array.from(
      { length: 49_998 },
      (_, i) =>
        `<Default Extension="e${i}" ContentType="application/octet-stream"/>`
    ).join('');
    const rels = '<Relationships/>';
    const types = `<Types>${defaults}</Types>`;
    await expect(
      selectDocxParts(
        indexFor({ '[Content_Types].xml': types, '_rels/.rels': rels })
      )
    ).resolves.toBeDefined();

    const extra =
      '<Default Extension="extra" ContentType="application/octet-stream"/>';
    await expect(
      selectDocxParts(
        indexFor({
          '[Content_Types].xml': `<Types>${defaults}${extra}</Types>`,
          '_rels/.rels': rels,
        })
      )
    ).rejects.toThrow('DOCX metadata element limit exceeded');
  });

  test('shares the relationship budget across the reachable graph', async () => {
    const office =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const unused = (count: number, prefix: string, target: string) =>
      Array.from(
        { length: count },
        (_, i) =>
          `<Relationship Id="${prefix}${i}" Type="urn:example" Target="${target}"/>`
      ).join('');
    const root = `<Relationships><Relationship Id="doc" Type="${office}officeDocument" Target="word/document.xml"/>${unused(5000, 'root', 'word/media/image.png')}</Relationships>`;
    const make = (count: number) =>
      indexFor({
        '[Content_Types].xml': '<Types/>',
        '_rels/.rels': root,
        'word/document.xml': '<document/>',
        'word/_rels/document.xml.rels': `<Relationships>${unused(count, 'doc', 'media/image.png')}</Relationships>`,
        'word/media/image.png': 'image',
      });
    await expect(selectDocxParts(make(4999))).resolves.toBeDefined();
    await expect(selectDocxParts(make(5000))).rejects.toThrow(
      'DOCX relationship limit exceeded'
    );
    const truncated = `<Relationships>${unused(10_001, 'r', 'part.xml')}`;
    await expect(
      selectDocxParts(
        indexFor({
          '[Content_Types].xml': '<Types/>',
          '_rels/.rels': truncated,
        })
      )
    ).rejects.toThrow('DOCX relationship limit exceeded');
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
