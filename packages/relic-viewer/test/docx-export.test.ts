import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { markdownToDocx, xmlSafe } from '../src/docx-export.ts';

/**
 * The export is inert data, so the properties worth pinning are the ones that
 * make Word refuse a file or that let the source smuggle something into it:
 * characters XML cannot carry, links the page would not have followed, and
 * structure the reader would see on the page.
 */

async function open(markdown: string) {
  const blob = await markdownToDocx(markdown, 'Q3 report');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (file === null) throw new Error(`missing part ${name}`);
    return file.async('string');
  };
  return {
    blob,
    zip,
    document: await read('word/document.xml'),
    rels: await read('word/_rels/document.xml.rels'),
    core: await read('docProps/core.xml'),
    numbering: await read('word/numbering.xml'),
    parts: await Promise.all(
      Object.keys(zip.files)
        .filter((name) => name.endsWith('.xml') || name.endsWith('.rels'))
        .map(read)
    ),
  };
}

describe('the package', () => {
  test('is a Word document, titled from the file name', async () => {
    const { blob, zip, core } = await open('# Hello');
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(Object.keys(zip.files)).toContain('[Content_Types].xml');
    expect(Object.keys(zip.files)).toContain('word/document.xml');
    expect(core).toContain('Q3 report');
  });

  test('an empty source still has a body to open', async () => {
    const { document } = await open('');
    expect(document).toContain('<w:p');
  });
});

describe('text XML cannot carry', () => {
  // The source is untrusted bytes, and one forbidden character makes the
  // whole file unreadable.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the controls is the point
  const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

  test('xmlSafe drops controls and keeps tab, newline, and real text', () => {
    expect(xmlSafe('a\u0000b\u0001c\u000Bd\u001Fe')).toBe('abcde');
    expect(xmlSafe('a\tb\nc')).toBe('a\tb\nc');
    expect(xmlSafe('x\uFFFEy\uFFFFz')).toBe('xyz');
  });

  test('xmlSafe replaces a lone surrogate and keeps a real pair', () => {
    expect(xmlSafe('a\uD800b')).toBe('a\uFFFDb');
    expect(xmlSafe('a\uDC00b')).toBe('a\uFFFDb');
    expect(xmlSafe('a😀b')).toBe('a😀b');
  });

  test('no part of the file carries one, whatever the source held', async () => {
    const hostile = [
      '# t\u0001itle',
      'para\u0000graph with \u000B and \uFFFE and \uD800',
      '```\ncode\u0002 line\n```',
      '| a\u0003 | b |\n| --- | --- |\n| c\u0004 | d |',
      '- item\u0005',
      '[link\u0006](https://example.com/\u0007)',
    ].join('\n\n');
    const { parts } = await open(hostile);
    for (const part of parts) expect(FORBIDDEN.test(part)).toBe(false);
  });
});

describe('what the source says stays text', () => {
  test('markup in the source is escaped, never an element', async () => {
    const { document } = await open('<script>alert(1)</script> and `<b>x</b>`');
    expect(document).not.toContain('<script>');
    expect(document).not.toContain('<b>x</b>');
    expect(document).toContain('&lt;script&gt;');
  });

  test('a link the page would follow becomes a hyperlink', async () => {
    const { document, rels } = await open(
      '[docs](https://example.com/a?x=1&y=2) and [mail](mailto:a@example.com)'
    );
    expect(document).toContain('<w:hyperlink');
    expect(rels).toContain('Target="https://example.com/a?x=1&amp;y=2"');
    expect(rels).toContain('Target="mailto:a@example.com"');
    expect(rels).toContain('TargetMode="External"');
  });

  const refused = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ];
  for (const target of refused) {
    test(`a ${target.slice(0, 18)} link gets no target`, async () => {
      const { document, rels } = await open(`[click](${target})`);
      expect(document).not.toContain('<w:hyperlink');
      expect(rels).not.toMatch(/javascript|vbscript|file:|data:/i);
    });
  }

  test('an image is its alt text, with no media part and no request', async () => {
    const { document, zip } = await open(
      '![a photo](https://example.com/x.png)'
    );
    expect(document).toContain('a photo');
    expect(document).not.toContain('example.com');
    expect(Object.keys(zip.files).some((name) => /media\//.test(name))).toBe(
      false
    );
  });
});

describe('structure carries over', () => {
  test('headings use the heading styles at every level', async () => {
    const { document } = await open(
      [1, 2, 3, 4, 5, 6].map((n) => `${'#'.repeat(n)} H${n}`).join('\n\n')
    );
    for (let level = 1; level <= 6; level++) {
      expect(document).toContain(`<w:pStyle w:val="Heading${level}"/>`);
    }
  });

  test('formatting that is off is never written, so styles keep their weight', async () => {
    // An explicit `w:val="false"` overrides the bold a heading style supplies
    // and renders every heading in regular weight. Found in a render of the
    // first export, where it passed every structural check.
    const { document } = await open(
      '# Title\n\nplain paragraph\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
    );
    expect(document).not.toMatch(/<w:(b|bCs|i|iCs|strike) w:val="false"/);
  });

  test('table header cells are bold, body cells are not', async () => {
    const { document } = await open(
      '| head | other |\n| --- | --- |\n| body | x |'
    );
    const cells = document.match(/<w:tc>.*?<\/w:tc>/gs) ?? [];
    expect(cells).toHaveLength(4);
    expect(cells[0]).toContain('<w:b/>');
    expect(cells[2]).not.toContain('<w:b/>');
  });

  test('emphasis, strike, and code spans keep their formatting', async () => {
    const { document } = await open('**bold** *italic* ~~gone~~ `mono`');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:strike/>');
    expect(document).toContain('Consolas');
  });

  test('fenced code keeps every line, in a monospace face', async () => {
    const { document } = await open('```ts\nconst a = 1;\n  indented();\n```');
    expect(document).toContain('const a = 1;');
    expect(document).toContain('  indented();');
    expect(document).toContain('<w:br/>');
    expect(document).toContain('Consolas');
  });

  test('a table pads short rows to the header width', async () => {
    const { document } = await open(
      '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 | 6 |'
    );
    expect(document).toContain('<w:tbl>');
    expect(document.match(/<w:tr[ >]/g)).toHaveLength(3);
    // The widest row sets the column count: four columns across three rows.
    expect(document.match(/<w:tc>/g)).toHaveLength(12);
    expect(document).toContain('<w:tblHeader');
  });

  test('each ordered list restarts, and bullets are a separate list', async () => {
    const { document } = await open(
      '1. one\n2. two\n\ntext\n\n1. again\n2. more\n\n- bullet'
    );
    const ids = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(
      (match) => match[1]
    );
    expect(ids).toHaveLength(5);
    const [a1, a2, b1, b2, bullet] = ids;
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
    expect(bullet).not.toBe(a1);
    expect(bullet).not.toBe(b1);
  });

  test('a quote is indented text with a rule beside it', async () => {
    const { document } = await open('> quoted\n>\n> > nested');
    expect(document).toContain('quoted');
    expect(document).toContain('nested');
    expect(document).toContain('<w:left ');
  });

  test('a horizontal rule is a bordered paragraph', async () => {
    const { document } = await open('above\n\n---\n\nbelow');
    expect(document).toContain('<w:bottom ');
  });
});
