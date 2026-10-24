import { describe, expect, test } from 'bun:test';
import {
  deriveRendererClass,
  isRenderable,
  isRendererClass,
  leastPrivileged,
  privilegeTier,
  RENDERER_CLASSES,
  type RendererClass,
  sniffContentClass,
} from '../src/renderer-class.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the taxonomy', () => {
  test('keeps OTIO outside the telemetry renderable wedge', () => {
    expect(isRenderable('otio')).toBe(false);
  });

  test('rejects a value outside the taxonomy', () => {
    expect(isRendererClass('spreadsheet')).toBe(false);
    expect(isRendererClass('markdown')).toBe(true);
    expect(isRendererClass('jsx')).toBe(true);
  });
});

describe('the zero-byte rule', () => {
  // `spec/format.md` 3.9, unconditional.
  const names = ['script.py', 'notes.md', 'page.html', 'photo.png', ''];

  for (const filename of names) {
    test(`a zero-byte ${filename || 'unnamed'} file is binary`, () => {
      expect(deriveRendererClass(new Uint8Array(0), filename)).toBe('binary');
    });
  }

  test('a one-byte file is not caught by the rule', () => {
    expect(deriveRendererClass(utf8('x'), 'notes.md')).toBe('markdown');
  });
});

describe('magic bytes beat the extension', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test('a PNG named .txt is still an image', () => {
    expect(deriveRendererClass(png, 'secret.txt')).toBe('image');
  });

  test('a ZIP named .md is still an archive', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(deriveRendererClass(zip, 'readme.md')).toBe('archive');
  });

  test('gzip is an archive', () => {
    expect(deriveRendererClass(new Uint8Array([0x1f, 0x8b, 0x08]), 'x')).toBe(
      'archive'
    );
  });

  test('%PDF- bytes classify as pdf from magic, ahead of any extension', () => {
    const pdf = utf8('%PDF-1.7\n');
    expect(deriveRendererClass(pdf, 'report.txt')).toBe('pdf');
    expect(deriveRendererClass(pdf, 'report.pdf')).toBe('pdf');
    expect(sniffContentClass(pdf)).toBe('pdf');
  });
});

describe('the extension fallback', () => {
  const cases: ReadonlyArray<readonly [string, RendererClass]> = [
    ['notes.md', 'markdown'],
    ['README.markdown', 'markdown'],
    ['index.html', 'html'],
    ['page.HTM', 'html'],
    ['App.jsx', 'jsx'],
    ['Widget.tsx', 'jsx'],
    ['main.ts', 'code'],
    ['server.go', 'code'],
    ['config.yaml', 'code'],
    ['query.sql', 'code'],
    ['Dockerfile', 'code'],
    ['data.csv', 'code'],
    ['clip.mp4', 'media'],
    ['song.flac', 'media'],
    ['bundle.zip', 'archive'],
    ['diagram.svg', 'image'],
    ['document.pdf', 'pdf'],
  ];

  for (const [filename, expected] of cases) {
    test(`${filename} is ${expected}`, () => {
      expect(
        deriveRendererClass(utf8('some plausible content'), filename)
      ).toBe(expected);
    });
  }
});

describe('the content fallback', () => {
  test('unnamed HTML sniffs as html', () => {
    expect(deriveRendererClass(utf8('<!DOCTYPE html><p>hi'), 'thing')).toBe(
      'html'
    );
  });

  test('unnamed plain text is code', () => {
    expect(deriveRendererClass(utf8('just some prose here'), 'thing')).toBe(
      'code'
    );
  });

  test('unnamed binary with NUL bytes is binary', () => {
    const blob = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]);
    expect(deriveRendererClass(blob, 'thing')).toBe('binary');
  });

  test('an unknown extension falls through to the content check', () => {
    expect(deriveRendererClass(utf8('plain words'), 'thing.wat')).toBe('code');
  });
});

describe('sniffContentClass ignores the filename entirely', () => {
  test('HTML named .png sniffs as html, which deriveRendererClass cannot do', () => {
    const html = utf8('<!doctype html><script>steal()</script>');
    // The publish-side classifier trusts the extension, and that is correct
    // for telemetry.
    expect(deriveRendererClass(html, 'innocent.png')).toBe('image');
    // The viewer-side sniff must not, or the disagreement rule compares the
    // filename against itself and agrees in exactly the attack case.
    expect(sniffContentClass(html)).toBe('html');
  });

  test('a real PNG sniffs as an image whatever it is called', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(sniffContentClass(png)).toBe('image');
  });

  test('plain text sniffs as code, and it cannot tell markdown apart', () => {
    expect(sniffContentClass(utf8('# A heading\n\nSome prose.'))).toBe('code');
  });

  test('a zero-byte payload sniffs as binary', () => {
    expect(sniffContentClass(new Uint8Array(0))).toBe('binary');
  });

  test('bytes with NULs sniff as binary', () => {
    expect(sniffContentClass(new Uint8Array([0, 1, 2, 0, 255]))).toBe('binary');
  });
});

describe('the HTML prefix list recognizes real pages', () => {
  // Found in the field: a genuine page whose first element is not one of
  // doctype/html/comment/svg sniffed as code, the disagreement rule then
  // showed it as escaped text, and the publisher saw a broken product.
  const pages: ReadonlyArray<readonly [string, string]> = [
    ['head first', '<head><title>x</title></head><body>hi</body>'],
    ['div first', '<div class="page"><h1>hi</h1></div>'],
    ['meta first', '<meta charset="utf-8"><title>x</title>'],
    ['section first', '<section><p>hi</p></section>'],
    ['title first', '<title>x</title><p>hi</p>'],
    ['xhtml prologue', '<?xml version="1.0"?><!doctype html><html>hi</html>'],
    ['comment without a space', '<!--generated--><div>hi</div>'],
    ['legacy doctype', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">'],
    ['body first', '<body><p>hi</p></body>'],
    ['script first', '<script>var x = 1;</script><p>hi</p>'],
    ['style first', '<style>p{margin:0}</style><p>hi</p>'],
    ['form first', '<form action="/x"><input></form>'],
  ];

  for (const [name, page] of pages) {
    test(`${name} sniffs as html`, () => {
      expect(sniffContentClass(utf8(page))).toBe('html');
    });
  }

  // The list is tag-shaped for a reason, and the one short tag that could
  // open a word carries its closing bracket. Prose must not become markup.
  const notPages: ReadonlyArray<readonly [string, string]> = [
    ['a line that starts like a tag', '<password: hunter2>\nthe rest is prose'],
    ['a log line', '2026-08-18 02:00:00 INFO something happened'],
    ['a code file', 'const x = 1;\nexport default x;'],
    ['markdown', '# A heading\n\nSome prose.'],
  ];

  for (const [name, text] of notPages) {
    test(`${name} still sniffs as code`, () => {
      expect(sniffContentClass(utf8(text))).toBe('code');
    });
  }
});

describe('privilegeTier', () => {
  test('only html and jsx execute, and they share the top tier', () => {
    expect(privilegeTier('html')).toBe(3);
    expect(privilegeTier('jsx')).toBe(3);
    for (const cls of RENDERER_CLASSES) {
      if (cls !== 'html' && cls !== 'jsx') {
        expect(privilegeTier(cls)).toBeLessThan(3);
      }
    }
  });
  test('image and pdf carry tier 2', () => {
    expect(privilegeTier('image')).toBe(2);
    expect(privilegeTier('pdf')).toBe(2);
  });

  test('markdown and code share a tier, so neither downgrades the other', () => {
    expect(privilegeTier('markdown')).toBe(privilegeTier('code'));
  });

  test('nothing download-only carries any render privilege', () => {
    for (const cls of ['media', 'archive', 'binary'] as const) {
      expect(privilegeTier(cls)).toBe(0);
    }
  });
});

describe('declared versus sniffed disagreement', () => {
  // `spec/format.md` 3.6: route to the least privileged path either type
  // would allow. The publisher is the threat here, not the operator.
  test('html against image resolves to image, never html', () => {
    expect(leastPrivileged('html', 'image')).toBe('image');
    expect(leastPrivileged('image', 'html')).toBe('image');
  });

  test('html against binary resolves to binary', () => {
    expect(leastPrivileged('html', 'binary')).toBe('binary');
  });
  test('html against pdf resolves to pdf, never html', () => {
    expect(leastPrivileged('html', 'pdf')).toBe('pdf');
    expect(leastPrivileged('pdf', 'html')).toBe('pdf');
  });

  test('pdf against binary resolves to binary', () => {
    expect(leastPrivileged('pdf', 'binary')).toBe('binary');
    expect(leastPrivileged('binary', 'pdf')).toBe('binary');
  });

  test('agreement is a no-op', () => {
    for (const cls of RENDERER_CLASSES) {
      expect(leastPrivileged(cls, cls)).toBe(cls);
    }
  });

  test('html never wins against anything outside the executing tier', () => {
    for (const cls of RENDERER_CLASSES) {
      if (cls === 'html' || cls === 'jsx') continue;
      expect(leastPrivileged('html', cls)).not.toBe('html');
    }
  });

  test('jsx against image resolves to image, never jsx', () => {
    expect(leastPrivileged('jsx', 'image')).toBe('image');
    expect(leastPrivileged('image', 'jsx')).toBe('image');
  });

  test('jsx against binary resolves to binary', () => {
    expect(leastPrivileged('jsx', 'binary')).toBe('binary');
  });

  test('jsx never wins against anything outside the executing tier', () => {
    for (const cls of RENDERER_CLASSES) {
      if (cls === 'jsx' || cls === 'html') continue;
      expect(leastPrivileged('jsx', cls)).not.toBe('jsx');
    }
  });

  test('jsx and html share the top rank, so between them either may resolve', () => {
    // Both execute in the frame, so the rule has no safer side to pick
    // between them; what matters is that nothing less privileged ever loses
    // to either, which the tests above hold.
    expect(['html', 'jsx']).toContain(leastPrivileged('jsx', 'html'));
    expect(['html', 'jsx']).toContain(leastPrivileged('html', 'jsx'));
  });
});
