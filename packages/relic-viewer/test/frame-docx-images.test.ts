import { afterEach, describe, expect, test } from 'bun:test';
import { boundedRenderFactory, guardImageSources } from '../src/frame-docx.ts';
import EntryArchive, { ImageBudget } from '../src/frame-zip-entries.ts';

const animatedImages = [
  {
    mime: 'image/gif',
    bytes: Buffer.from(
      'R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAACAoRRACH5BAAKAAAALAAAAAACAAIAgAAA/wAAAAIChFEAOw==',
      'base64'
    ),
  },
  {
    mime: 'image/webp',
    bytes: Buffer.from(
      'UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMAAAANABAJ0BKgIAAgACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAQAAZAAAAFZQOCAsAAAAlAEAnQEqAgACAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=',
      'base64'
    ),
  },
  {
    mime: 'image/png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABJJREFUeJxj/MvAyMDAwMIABgANHAEEhmSuyAAAABpmY1RMAAAAAQAAAAIAAAACAAAAAAAAAAAAAQAKAABzJzbUAAAAFmZkQVQAAAACeJxjZGT4y8DAwMIABgALJAEET/99TwAAAABJRU5ErkJggg==',
      'base64'
    ),
  },
];

class TestImage {
  attributes = new Map<string, string>();
  set src(value: string) {
    this.attributes.set('src', String(value));
  }
  get src() {
    return this.attributes.get('src') ?? '';
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
}
class TestSvgImage {
  localName = 'image';
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
}
const originalSvg = Object.getOwnPropertyDescriptor(globalThis, 'SVGElement');
const original = Object.getOwnPropertyDescriptor(
  globalThis,
  'HTMLImageElement'
);
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'HTMLImageElement', original);
  else Reflect.deleteProperty(globalThis, 'HTMLImageElement');
  if (originalSvg) Object.defineProperty(globalThis, 'SVGElement', originalSvg);
  else Reflect.deleteProperty(globalThis, 'SVGElement');
});

describe('DOCX image source guard', () => {
  test('rejects unresolved and linked image sources before assigning them', () => {
    Object.defineProperty(globalThis, 'HTMLImageElement', {
      configurable: true,
      value: TestImage,
    });
    Object.defineProperty(globalThis, 'SVGElement', {
      configurable: true,
      value: TestSvgImage,
    });
    const svgAttribute = TestSvgImage.prototype.setAttribute;
    const control = new TestImage();
    control.src = 'https://example.invalid/image.png';
    expect(control.attributes.has('src')).toBe(true);
    const priorSrc = Object.getOwnPropertyDescriptor(
      TestImage.prototype,
      'src'
    )?.set;
    const priorAttribute = TestImage.prototype.setAttribute;
    const restore = guardImageSources();
    try {
      for (const source of [
        null,
        undefined,
        'null',
        'https://example.invalid/image.png',
        'http://example.invalid/image.png',
      ]) {
        const image = new TestImage();
        Reflect.set(image, 'src', source);
        expect(image.attributes.has('src')).toBe(false);
        expect(image.attributes.has('data-relic-image-unavailable')).toBe(true);
        const viaAttribute = new TestImage();
        viaAttribute.setAttribute('SRC', String(source));
        expect(viaAttribute.attributes.has('SRC')).toBe(false);
        expect(
          viaAttribute.attributes.has('data-relic-image-unavailable')
        ).toBe(true);
        const svg = new TestSvgImage();
        svg.setAttribute('href', String(source));
        expect(svg.attributes.has('href')).toBe(false);
        expect(svg.attributes.has('data-relic-image-unavailable')).toBe(true);
      }
      for (const source of ['data:image/png;base64,AA==', 'blob:null/123']) {
        const image = new TestImage();
        image.src = source;
        expect(image.src).toBe(source);
      }
    } finally {
      restore();
    }
    expect(
      Object.getOwnPropertyDescriptor(TestImage.prototype, 'src')?.set
    ).toBe(priorSrc);
    expect(TestImage.prototype.setAttribute).toBe(priorAttribute);
    expect(TestSvgImage.prototype.setAttribute).toBe(svgAttribute);
  });
});

test('bounds document nodes and pages before constructing them', () => {
  const create = () => ({}) as Node;
  const boundedNodes = boundedRenderFactory(create, 3, 10);
  boundedNodes({ tagName: 'p', children: ['First'] });
  expect(() => boundedNodes({ tagName: 'p', children: ['Second'] })).toThrow();

  const boundedPages = boundedRenderFactory(create, 10, 1);
  boundedPages({ tagName: 'section', className: 'docx' });
  expect(() =>
    boundedPages({ tagName: 'section', className: 'docx' })
  ).toThrow();
});

test('charges image pixels per member and reuses its admitted blob', async () => {
  const onePixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const twoPixels = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAA1BMVEUAAP+KeNJXAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==',
    'base64'
  );
  const budget = new ImageBudget(2, 2);
  const archive = await EntryArchive.loadAsync({
    entries: new Map([
      ['first.png', onePixel],
      ['second.png', twoPixels],
    ]),
    budget,
  });
  const first = archive.files['first.png']!;
  const blob = await first.async('blob');
  expect(blob).toBeInstanceOf(Blob);
  expect((blob as Blob).type).toBe('image/png');
  expect(await first.async('blob')).toBe(blob);
  expect(await archive.files['second.png']!.async('blob')).toBeNull();
  expect(budget.reason).toBe('too-large');

  const individual = new ImageBudget(1, 10);
  expect(individual.admit('second.png', twoPixels)).toBe(false);
  expect(individual.reason).toBe('too-large');
});

test('charges every frame of ordinary animated GIF, WebP and PNG images', async () => {
  for (const image of animatedImages) {
    const budget = new ImageBudget(8, 16);
    const archive = await EntryArchive.loadAsync({
      entries: new Map([
        ['first.data', image.bytes],
        ['second.data', image.bytes],
      ]),
      budget,
    });
    const first = archive.files['first.data']!;
    const blob = (await first.async('blob')) as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(image.mime);
    expect(blob.size).toBe(image.bytes.length);
    expect(await first.async('blob')).toBe(blob);
    expect(await archive.files['second.data']!.async('blob')).toBeInstanceOf(
      Blob
    );
    expect(budget.reason).toBeUndefined();

    const individual = new ImageBudget(7, 100);
    expect(individual.admit('animated.data', image.bytes)).toBe(false);
    expect(individual.reason).toBe('too-large');

    const aggregate = new ImageBudget(8, 15);
    expect(aggregate.admit('first.data', image.bytes)).toBe(true);
    expect(aggregate.admit('first.data', image.bytes)).toBe(true);
    expect(aggregate.admit('second.data', image.bytes)).toBe(false);
    expect(aggregate.reason).toBe('too-large');
  }
});

test('charges the canvas for each partial animated GIF frame', () => {
  const gif = Buffer.from(animatedImages[0]!.bytes);
  gif.writeUInt16LE(4, 6);
  expect(new ImageBudget(16, 16).admit('partial.gif', gif)).toBe(true);
  const budget = new ImageBudget(15, 100);
  expect(budget.admit('partial.gif', gif)).toBe(false);
  expect(budget.reason).toBe('too-large');
});

test('admits small still images with their detected MIME', async () => {
  const animatedWebp = animatedImages[1]!.bytes;
  const chunkOffset = animatedWebp.indexOf(Buffer.from('VP8 '), 12);
  const chunkLength = animatedWebp.readUInt32LE(chunkOffset + 4);
  const chunk = animatedWebp.subarray(
    chunkOffset,
    chunkOffset + 8 + chunkLength + (chunkLength & 1)
  );
  const webpHeader = Buffer.alloc(12);
  webpHeader.write('RIFF', 0);
  webpHeader.writeUInt32LE(chunk.length + 4, 4);
  webpHeader.write('WEBP', 8);
  const bmp = Buffer.alloc(62);
  bmp.write('BM');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(2, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(8, 34);
  const iconImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const iconHeader = Buffer.alloc(22);
  iconHeader.writeUInt16LE(1, 2);
  iconHeader.writeUInt16LE(1, 4);
  iconHeader.writeUInt8(1, 6);
  iconHeader.writeUInt8(1, 7);
  iconHeader.writeUInt16LE(1, 10);
  iconHeader.writeUInt16LE(32, 12);
  iconHeader.writeUInt32LE(iconImage.length, 14);
  iconHeader.writeUInt32LE(iconHeader.length, 18);
  const fixtures = [
    {
      mime: 'image/gif',
      bytes: Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64'
      ),
      pixels: 1,
    },
    {
      mime: 'image/webp',
      bytes: Buffer.concat([webpHeader, chunk]),
      pixels: 4,
    },
    {
      mime: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
      pixels: 1,
    },
    {
      mime: 'image/bmp',
      bytes: bmp,
      pixels: 2,
    },
    {
      mime: 'image/vnd.microsoft.icon',
      bytes: Buffer.concat([iconHeader, iconImage]),
      pixels: 1,
    },
  ];
  for (const fixture of fixtures) {
    const archive = await EntryArchive.loadAsync({
      entries: new Map([['image.bin', fixture.bytes]]),
      budget: new ImageBudget(fixture.pixels, fixture.pixels),
    });
    const blob = (await archive.files['image.bin']!.async('blob')) as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(fixture.mime);
    expect(blob.size).toBe(fixture.bytes.length);
  }
});

test('tags recognized metafiles as cached empty blobs independent of file metadata', async () => {
  // A standard WMF header followed by its end-of-file record.
  const wmf = Buffer.from([
    1, 0, 9, 0, 0, 3, 12, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0,
  ]);
  const placeable = Buffer.alloc(22);
  placeable.writeUInt32LE(0x9ac6cdd7, 0);
  placeable.writeUInt16LE(2, 10);
  placeable.writeUInt16LE(2, 12);
  placeable.writeUInt16LE(1440, 14);
  let checksum = 0;
  for (let i = 0; i < 20; i += 2) checksum ^= placeable.readUInt16LE(i);
  placeable.writeUInt16LE(checksum, 20);

  // A minimal EMF header and end-of-file record.
  const emf = Buffer.alloc(108);
  emf.writeUInt32LE(1, 0);
  emf.writeUInt32LE(88, 4);
  emf.writeInt32LE(2, 16);
  emf.writeInt32LE(2, 20);
  emf.writeInt32LE(53, 32);
  emf.writeInt32LE(53, 36);
  emf.writeUInt32LE(0x464d4520, 40);
  emf.writeUInt32LE(0x10000, 44);
  emf.writeUInt32LE(emf.length, 48);
  emf.writeUInt32LE(2, 52);
  emf.writeUInt16LE(1, 56);
  emf.writeInt32LE(2, 72);
  emf.writeInt32LE(2, 76);
  emf.writeInt32LE(1, 80);
  emf.writeInt32LE(1, 84);
  emf.writeUInt32LE(14, 88);
  emf.writeUInt32LE(20, 92);
  emf.writeUInt32LE(20, 104);

  const entries = new Map([
    ['one.data', wmf],
    ['two.data', Buffer.concat([placeable, wmf])],
    ['three.data', emf],
  ]);
  const archive = await EntryArchive.loadAsync({
    entries,
    budget: new ImageBudget(1, 1),
  });
  for (const [path, type] of [
    ['one.data', 'image/x-wmf'],
    ['two.data', 'image/x-wmf'],
    ['three.data', 'image/x-emf'],
  ] as const) {
    const entry = archive.files[path]!;
    const blob = (await entry.async('blob')) as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(type);
    expect(blob.size).toBe(0);
    expect(await entry.async('blob')).toBe(blob);
  }
});

test('admits SVG with explicit intrinsic dimensions and rejects viewBox-only SVG', async () => {
  const sized = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>'
  );
  const archive = await EntryArchive.loadAsync({
    entries: new Map([['image.data', sized]]),
    budget: new ImageBudget(4, 4),
  });
  const blob = (await archive.files['image.data']!.async('blob')) as Blob;
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe('image/svg+xml');
  const ratio = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" viewBox="0 0 2 1"><rect width="2" height="1"/></svg>'
  );
  expect(new ImageBudget(2, 2).admit('ratio.svg', ratio)).toBe(true);
  const styled = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><style>rect { fill: blue }</style><rect width="2" height="2"><animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></rect></svg>'
  );
  const styledArchive = await EntryArchive.loadAsync({
    entries: new Map([['styled.svg', styled]]),
    budget: new ImageBudget(4, 4),
  });
  const styledBlob = (await styledArchive.files['styled.svg']!.async(
    'blob'
  )) as Blob;
  expect(styledBlob.type).toBe('image/svg+xml');
  expect(await styledBlob.text()).toBe(new TextDecoder().decode(styled));
  const viewBoxOnly = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>'
  );
  const budget = new ImageBudget();
  expect(budget.admit('image.svg', viewBoxOnly)).toBe(false);
  expect(budget.reason).toBe('image-dimensions-unknown');
});

test('uses download fallback for font-relative SVG dimensions', () => {
  for (const unit of ['em', 'ex']) {
    for (const dimension of ['width', 'height']) {
      const width = dimension === 'width' ? `2${unit}` : '2px';
      const height = dimension === 'height' ? `2${unit}` : '2px';
      const svg = new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`
      );
      const budget = new ImageBudget();
      expect(budget.admit('relative.svg', svg)).toBe(false);
      expect(budget.reason).toBe('image-dimensions-unknown');
    }
  }
  const absolute = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1pt" height="2px"><rect width="1" height="1"/></svg>'
  );
  expect(new ImageBudget(4, 4).admit('absolute.svg', absolute)).toBe(true);
  const limited = new ImageBudget(3, 3);
  expect(limited.admit('absolute.svg', absolute)).toBe(false);
  expect(limited.reason).toBe('too-large');
});

test('reports an image with unknown dimensions for download fallback', () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'
  );
  const budget = new ImageBudget();
  expect(budget.admit('image.svg', svg)).toBe(false);
  expect(budget.reason).toBe('image-dimensions-unknown');
});

test('decodes UTF-16 XML entries for the document renderer', async () => {
  const text = '<document>Résumé</document>';
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, 'utf16le'),
  ]);
  const archive = await EntryArchive.loadAsync(
    new Map([['document.xml', bytes]])
  );
  expect(await archive.files['document.xml']!.async('string')).toBe(text);
});
