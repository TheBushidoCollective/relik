import { afterEach, describe, expect, test } from 'bun:test';
import { boundedRenderFactory, guardImageSources } from '../src/frame-docx.ts';

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
