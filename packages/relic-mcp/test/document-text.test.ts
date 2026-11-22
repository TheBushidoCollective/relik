import { describe, expect, test } from 'bun:test';
import {
  DOCUMENT_TEXT_LIMIT,
  docxMainText,
  findDocumentQuote,
  resolveDocumentQuote,
} from '../src/document-text.ts';
import { type FixtureEntry, zipFixture } from './zip-fixture.ts';

const encoder = new TextEncoder();
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const run = (value: string): string =>
  `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
const paragraph = (runs: string): string => `<w:p>${runs}</w:p>`;
const documentXml = (body: string, doctype = ''): string =>
  `${doctype}<w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`;

/** A DOCX whose main story is `body`, with its parts deflated as Word writes them. */
function docx(body: string, extra: readonly FixtureEntry[] = []): Uint8Array {
  return zipFixture([
    { name: '[Content_Types].xml', text: '<Types/>' },
    { name: 'word/document.xml', text: documentXml(body), deflate: true },
    ...extra,
  ]);
}

interface Chapter {
  readonly id: string;
  readonly xhtml: string;
}

/** An EPUB whose manifest lists `chapters` in order and whose spine is `spine`. */
function epub(
  chapters: readonly Chapter[],
  spine: readonly string[],
  extra: readonly FixtureEntry[] = []
): Uint8Array {
  const manifest = chapters
    .map(
      (chapter) =>
        `<item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="application/xhtml+xml"/>`
    )
    .join('');
  const itemrefs = spine.map((id) => `<itemref idref="${id}"/>`).join('');
  return zipFixture([
    { name: 'mimetype', text: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      text: '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OPS/book.opf',
      text: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title></metadata><manifest>${manifest}</manifest><spine>${itemrefs}</spine></package>`,
    },
    ...chapters.map((chapter) => ({
      name: `OPS/${chapter.id}.xhtml`,
      text: chapter.xhtml,
      deflate: true,
    })),
    ...extra,
  ]);
}

const xhtml = (body: string, head = ''): string =>
  `<html xmlns="http://www.w3.org/1999/xhtml"><head>${head}</head><body>${body}</body></html>`;

const DOCX = 'report.docx';
const BOOK = 'book.epub';

describe('quotes in a Word document', () => {
  test('a quote that crosses runs resolves, with its paragraph line and the words around it', async () => {
    const book = docx(
      paragraph(run('The northern ') + run('depot receives shipments.')) +
        paragraph(run('Second paragraph names the Harbor office.'))
    );
    const resolved = await resolveDocumentQuote(book, DOCX, {
      kind: 'quote',
      exact: 'northern depot',
    });
    expect(resolved).toMatchObject({
      kind: 'quote',
      status: 'resolved',
      exact: 'northern depot',
      line: 1,
    });
    expect(resolved).toMatchObject({
      context_before: expect.stringContaining('The '),
      context_after: expect.stringMatching(/^ receives shipments\./),
    });
  });

  test('a quote in a later paragraph reports that paragraph as its line', async () => {
    const book = docx(
      paragraph(run('First paragraph.')) +
        paragraph(run('Second paragraph names the Harbor office.'))
    );
    expect(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'Harbor office',
      })
    ).toMatchObject({ status: 'resolved', line: 2 });
  });

  test('a tab in the paragraph is whitespace, so a quote with a space still matches', async () => {
    const book = docx(
      paragraph(`${run('alpha')}<w:r><w:tab/></w:r>${run('beta')}`)
    );
    expect(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'alpha beta',
      })
    ).toMatchObject({ status: 'resolved', exact: 'alpha beta' });
  });

  test('a selection that joins two paragraphs with a line break matches the two paragraphs', async () => {
    const book = docx(
      paragraph(run('end of first')) + paragraph(run('start of second'))
    );
    expect(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'end of first\nstart of second',
      })
    ).toMatchObject({
      status: 'resolved',
      exact: 'end of first start of second',
      line: 1,
    });
  });

  test('field instructions are never text, and a field shows its result', () => {
    const book = documentXml(
      paragraph(
        '<w:r><w:instrText>HYPERLINK "https://example.invalid"</w:instrText></w:r>' +
          run('Result text')
      )
    );
    const text = docxMainText(book);
    expect(text).toEqual({ ok: true, text: 'Result text\n' });
  });

  test('the prefix picks the occurrence whose surroundings agree, and the first occurrence wins without one', async () => {
    const book = docx(
      paragraph(run('Harbor depot')) + paragraph(run('Central depot'))
    );
    expect(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'depot',
        prefix: 'Central ',
      })
    ).toMatchObject({ status: 'resolved', line: 2 });
    expect(
      await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact: 'depot' })
    ).toMatchObject({ status: 'resolved', line: 1 });
  });

  test('text that sits only in a header part is not searched, and says so', async () => {
    const book = docx(paragraph(run('Body text only.')), [
      {
        name: 'word/header1.xml',
        text: documentXml(paragraph(run('Confidential'))),
      },
    ]);
    expect(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'Confidential',
      })
    ).toEqual({
      kind: 'quote',
      status: 'unresolvable',
      explanation:
        'The quoted text was not found in the document text this reader searches (it may have been edited or removed in a newer version, or it may sit in a header, footer or note).',
    });
  });

  test('a document part with a DOCTYPE is refused, and the quote is not searched', async () => {
    const book = zipFixture([
      { name: '[Content_Types].xml', text: '<Types/>' },
      {
        name: 'word/document.xml',
        text: documentXml(paragraph(run('Hidden')), '<!DOCTYPE w:document>'),
      },
    ]);
    expect(
      await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact: 'Hidden' })
    ).toEqual({
      kind: 'quote',
      status: 'unresolvable',
      explanation:
        'The document could not be read, so the quoted text cannot be checked.',
    });
  });

  test('a document with more text than the search limit is refused as too large, not searched', async () => {
    const book = docx(paragraph(run('x'.repeat(DOCUMENT_TEXT_LIMIT + 1))));
    expect(
      await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact: 'xxx' })
    ).toEqual({
      kind: 'quote',
      status: 'unresolvable',
      explanation: 'The document is too large to search for the quoted text.',
    });
  });

  test('a relic that is neither a Word document nor an EPUB is left to the caller', async () => {
    expect(
      await resolveDocumentQuote(encoder.encode('plain text'), 'notes.md', {
        kind: 'quote',
        exact: 'plain',
      })
    ).toBeUndefined();
  });
});

describe('quotes in an EPUB', () => {
  test('chapters are searched in spine order, not manifest order', async () => {
    const book = epub(
      [
        { id: 'b', xhtml: xhtml('<p>In B: the shared phrase here.</p>') },
        { id: 'a', xhtml: xhtml('<p>In A: the shared phrase here.</p>') },
      ],
      ['a', 'b']
    );
    const first = await resolveDocumentQuote(book, BOOK, {
      kind: 'quote',
      exact: 'shared phrase',
    });
    expect(first).toMatchObject({
      status: 'resolved',
      line: 1,
      context_before: expect.stringContaining('In A: the'),
    });
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'shared phrase',
        prefix: 'In B: the ',
      })
    ).toMatchObject({ status: 'resolved', line: 2 });
  });

  test('entities decode as the frame shows them, and a non-breaking space is a space', async () => {
    const book = epub(
      [
        {
          id: 'c',
          xhtml: xhtml('<p>Rivets &amp; washers&nbsp;ship&mdash;slowly.</p>'),
        },
      ],
      ['c']
    );
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'washers ship\u2014slowly',
      })
    ).toMatchObject({
      status: 'resolved',
      exact: 'washers ship\u2014slowly',
      context_before: expect.stringContaining('Rivets & '),
    });
  });

  test('script and style text is never searched, and visible text is', async () => {
    const book = epub(
      [
        {
          id: 'd',
          xhtml: xhtml(
            '<p>Visible text.</p><script>var hidden = 2;</script>',
            '<style>p { color: red; }</style><script>var secret = 1;</script>'
          ),
        },
      ],
      ['d']
    );
    expect(
      await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact: 'hidden' })
    ).toMatchObject({ status: 'unresolvable' });
    expect(
      await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact: 'secret' })
    ).toMatchObject({ status: 'unresolvable' });
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'Visible text.',
      })
    ).toMatchObject({ status: 'resolved' });
  });

  test('text inside an SVG chapter is searched, as the frame draws it', async () => {
    const book = epub(
      [
        {
          id: 'e',
          xhtml:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><text x="10" y="30">Heading in SVG</text></svg>',
        },
      ],
      ['e']
    );
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'Heading in SVG',
      })
    ).toMatchObject({ status: 'resolved' });
  });

  test('a chapter with an internal DTD subset is refused, the others are read, and the refusal is counted', async () => {
    const book = epub(
      [
        {
          id: 'f',
          xhtml: `<!DOCTYPE html [<!ENTITY x "y">]>${xhtml('<p>Refused chapter text.</p>')}`,
        },
        { id: 'g', xhtml: xhtml('<p>Readable chapter text.</p>') },
      ],
      ['f', 'g']
    );
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'Readable chapter text.',
      })
    ).toMatchObject({ status: 'resolved' });
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'Refused chapter text.',
      })
    ).toEqual({
      kind: 'quote',
      status: 'unresolvable',
      explanation:
        'The quoted text was not found in the document text this reader searches (it may have been edited or removed in a newer version, or it may sit in a header, footer or note). 1 chapter(s) could not be read.',
    });
  });

  test('a DRM-protected ebook is refused with the reason, and its text is not read', async () => {
    const book = epub(
      [{ id: 'h', xhtml: xhtml('<p>Protected text.</p>') }],
      ['h'],
      [{ name: 'META-INF/rights.xml', text: '<rights/>' }]
    );
    expect(
      await resolveDocumentQuote(book, BOOK, {
        kind: 'quote',
        exact: 'Protected text.',
      })
    ).toEqual({
      kind: 'quote',
      status: 'unresolvable',
      explanation:
        'The ebook is protected by DRM, so the quoted text cannot be checked against it.',
    });
  });
});

describe('matching a quote in extracted text', () => {
  test('a quote with no words is never matched', () => {
    expect(findDocumentQuote('some text', '   ')).toBeUndefined();
  });

  test('the same words in different paragraphs match with the line breaks collapsed', () => {
    expect(findDocumentQuote('alpha\nbeta\ngamma', 'alpha  beta')).toEqual({
      exact: 'alpha beta',
      line: 1,
      context_before: '',
      context_after: ' gamma',
    });
  });

  test('a quote is returned as the whole words it matched, and the line counts from the original text', () => {
    const match = findDocumentQuote('one\n\ntwo\nthree', 'three');
    expect(match).toMatchObject({ exact: 'three', line: 4 });
  });

  test('context stops at 120 characters on each side', () => {
    const long = `${'a'.repeat(300)} target ${'b'.repeat(300)}`;
    const match = findDocumentQuote(long, 'target');
    expect(match?.context_before.length).toBe(120);
    expect(match?.context_after.length).toBe(120);
  });
});
