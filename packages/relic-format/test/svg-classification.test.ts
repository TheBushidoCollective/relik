import { describe, expect, test } from 'bun:test';
import {
  deriveRendererClass,
  leastPrivileged,
  privilegeTier,
  sniffContentClass,
} from '../src/renderer-class.ts';

// Classification of SVG payloads. deriveRendererClass is the publisher-side
// taxonomy (metadata only, never routing). sniffContentClass is the bytes the
// viewer's disagreement rule compares.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const SVG = utf8(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
);
const SVG_WITH_SCRIPT = utf8(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML = utf8('<!doctype html><p>hi</p>');

describe('how an SVG payload sniffs', () => {
  test('a document that opens with <svg> sniffs as html', () => {
    expect(sniffContentClass(SVG)).toBe('html');
  });

  test('a script inside the document does not change its class', () => {
    expect(sniffContentClass(SVG_WITH_SCRIPT)).toBe('html');
  });

  test('an XML prolog, a DOCTYPE, a comment, and leading space all sniff as html', () => {
    for (const prefix of [
      '<?xml version="1.0"?>',
      '<!DOCTYPE svg>',
      '<!-- art -->',
      '  \n\t',
    ]) {
      expect(
        sniffContentClass(
          utf8(`${prefix}<svg xmlns="http://www.w3.org/2000/svg"/>`)
        )
      ).toBe('html');
    }
  });

  test('a byte-order mark before the root does not hide it', () => {
    expect(
      sniffContentClass(utf8('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBe('html');
  });

  test('PNG bytes sniff as an image', () => {
    expect(sniffContentClass(PNG)).toBe('image');
  });

  test('prose sniffs as code, not as markup', () => {
    expect(sniffContentClass(utf8('just some words'))).toBe('code');
  });
});

describe('how a published SVG is classified', () => {
  test('its publisher-visible class follows the extension, so .svg is an image', () => {
    expect(deriveRendererClass(SVG, 'drawing.svg')).toBe('image');
  });

  test('the same bytes under an unknown extension are sniffed, so html', () => {
    expect(deriveRendererClass(SVG, 'drawing.bin')).toBe('html');
  });

  test('an extension beats the sniff for a text name', () => {
    expect(deriveRendererClass(SVG, 'drawing.txt')).toBe('code');
  });

  test('magic bytes beat the name, so PNG bytes named .svg are an image', () => {
    expect(deriveRendererClass(PNG, 'drawing.svg')).toBe('image');
  });

  test('an HTML payload named .svg is classed as an image while it sniffs as html', () => {
    // The class is metadata. Routing reads the declared mimetype and the bytes.
    expect(deriveRendererClass(HTML, 'drawing.svg')).toBe('image');
    expect(sniffContentClass(HTML)).toBe('html');
  });
});

describe('the privilege tiers the disagreement rule compares', () => {
  test('html ranks above image, image above text, text above nothing', () => {
    expect(privilegeTier('html')).toBe(3);
    expect(privilegeTier('image')).toBe(2);
    expect(privilegeTier('code')).toBe(1);
    expect(privilegeTier('binary')).toBe(0);
  });

  test('html against image resolves to image, the less privileged class', () => {
    // viewer.md 1.3: a disagreement renders the less privileged class.
    expect(leastPrivileged('html', 'image')).toBe('image');
    expect(leastPrivileged('image', 'html')).toBe('image');
  });

  test('html loses every disagreement it takes part in', () => {
    expect(leastPrivileged('html', 'code')).toBe('code');
    expect(leastPrivileged('html', 'binary')).toBe('binary');
  });
});
