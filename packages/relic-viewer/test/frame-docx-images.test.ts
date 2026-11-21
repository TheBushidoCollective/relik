import { afterEach, describe, expect, test } from 'bun:test';
import { boundedRenderFactory, guardImageSources } from '../src/frame-docx.ts';
import EntryArchive, { ImageBudget } from '../src/frame-zip-entries.ts';

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
  expect(await first.async('blob')).toBe(blob);
  expect(await archive.files['second.png']!.async('blob')).toBeNull();
  expect(budget.reason).toBe('too-large');

  const individual = new ImageBudget(1, 10);
  expect(individual.admit('second.png', twoPixels)).toBe(false);
  expect(individual.reason).toBe('too-large');
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
