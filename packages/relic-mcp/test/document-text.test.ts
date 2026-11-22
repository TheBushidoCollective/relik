import { describe, expect, test } from 'bun:test';
import { indexZip, type ZipIndex } from '@relic/format/zip-index';
import {
  type DocumentKind,
  type DocumentLimits,
  type DocumentQuoteResolution,
  type DocumentText,
  DOCUMENT_LIMITS,
  DOCUMENT_ZIP_LIMITS,
  documentIndexFor,
  documentKindOf,
  indexFromBytes,
  indexFromZip,
  lineAt,
  placeQuote,
  resolveDocumentQuote,
  resolveQuote,
} from '../src/document-text.ts';
import { nodeInflater } from '../src/node-inflater.ts';
import { type FixtureEntry, zipFixture } from './zip-fixture.ts';

const encoder = new TextEncoder();
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const PACKAGE_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const run = (value: string): string =>
  `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
const paragraph = (runs: string): string => `<w:p>${runs}</w:p>`;
const documentXml = (body: string, doctype = ''): string =>
  `${doctype}<w:document xmlns:w="${WORD_NS}" xmlns:mc="${MC_NS}"><w:body>${body}</w:body></w:document>`;
const rootRelationships = (target: string): string =>
  `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="${target}"/></Relationships>`;

interface DocxOptions {
  readonly main?: string;
  /** The root relationships part. `null` leaves the part out. */
  readonly rels?: string | null;
  readonly extra?: readonly FixtureEntry[];
}

/** A Word package whose main story is `body`, with its main part deflated as Word writes it. */
function docx(body: string, options: DocxOptions = {}): Uint8Array {
  const main = options.main ?? 'word/document.xml';
  const rels =
    options.rels === undefined ? rootRelationships(main) : options.rels;
  return zipFixture([
    { name: '[Content_Types].xml', text: '<Types/>' },
    ...(rels === null ? [] : [{ name: '_rels/.rels', text: rels }]),
    { name: main, text: documentXml(body), deflate: true },
    ...(options.extra ?? []),
  ]);
}

interface Chapter {
  readonly id: string;
  readonly xhtml: string;
  /** The manifest's media type. An XHTML chapter unless a test says otherwise. */
  readonly mediaType?: string;
  /** Whether the spine reads the chapter in order. It does unless a test says otherwise. */
  readonly linear?: boolean;
}

/** An EPUB whose manifest lists `chapters`, and whose spine names `spine` in order. */
function epub(
  chapters: readonly Chapter[],
  spine: readonly string[],
  extra: readonly FixtureEntry[] = []
): Uint8Array {
  const byId = new Map(
    chapters.map((chapter) => [chapter.id, chapter] as const)
  );
  const manifest = chapters
    .map(
      (chapter) =>
        `<item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="${chapter.mediaType ?? 'application/xhtml+xml'}"/>`
    )
    .join('');
  const itemrefs = spine
    .map(
      (id) =>
        `<itemref idref="${id}"${byId.get(id)?.linear === false ? ' linear="no"' : ''}/>`
    )
    .join('');
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

async function textOf(
  bytes: Uint8Array,
  kind: DocumentKind,
  limits?: DocumentLimits
): Promise<DocumentText> {
  const outcome = await indexFromBytes(bytes, kind, limits);
  if (!outcome.ok)
    throw new Error(`the document is not indexed: ${outcome.reason}`);
  return outcome.text;
}

function resolvedOf<T extends { readonly status: string }>(
  result: T | undefined
): Extract<T, { readonly status: 'resolved' }> {
  if (result === undefined || result.status !== 'resolved')
    throw new Error(`not resolved: ${JSON.stringify(result)}`);
  return result as Extract<T, { readonly status: 'resolved' }>;
}

function unresolvableOf(result: DocumentQuoteResolution | undefined): string {
  if (result === undefined || result.status !== 'unresolvable')
    throw new Error(`unexpectedly resolved: ${JSON.stringify(result)}`);
  return result.explanation;
}

describe('a Word document', () => {
  test('a quote across runs is placed at its paragraph line, with the words around it', async () => {
    const book = docx(
      paragraph(run('The northern ') + run('depot receives shipments.')) +
        paragraph(run('Second paragraph names the Harbor office.'))
    );
    const resolved = resolvedOf(
      await resolveDocumentQuote(book, DOCX, {
        kind: 'quote',
        exact: 'northern depot',
      })
    );
    expect(resolved).toMatchObject({
      kind: 'quote',
      format: 'docx',
      exact: 'northern depot',
      line: 1,
      context_before: 'The ',
      context_matched: true,
      occurrences: 1,
      unreadable_chapters: 0,
    });
    expect(resolved.context_after.startsWith(' receives shipments.')).toBe(
      true
    );
  });

  test('a quote in a later paragraph is at that paragraph line', async () => {
    const book = docx(
      paragraph(run('First paragraph.')) +
        paragraph(run('Second paragraph names the Harbor office.'))
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Harbor office',
        })
      )
    ).toMatchObject({ line: 2 });
  });

  test('a tab is whitespace, so a quote with a space still matches', async () => {
    const book = docx(
      paragraph(`${run('alpha')}<w:r><w:tab/></w:r>${run('beta')}`)
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'alpha beta',
        })
      )
    ).toMatchObject({ exact: 'alpha beta', line: 1 });
  });

  test('a selection that spans two paragraphs matches with the break collapsed', async () => {
    const book = docx(
      paragraph(run('end of first')) + paragraph(run('start of second'))
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'end of first\nstart of second',
        })
      )
    ).toMatchObject({ exact: 'end of first start of second', line: 1 });
  });

  test('a field shows its result, and its instruction is never searched', async () => {
    const book = docx(
      paragraph(
        '<w:r><w:instrText>HYPERLINK "https://example.invalid"</w:instrText></w:r>' +
          run('Result text')
      )
    );
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'HYPERLINK',
        })
      )
    ).toContain('was not found');
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Result text',
        })
      )
    ).toMatchObject({ exact: 'Result text' });
  });

  test('a quote with no surrounding text that repeats is ambiguous, and names its lines', async () => {
    const book = docx(
      paragraph(run('Harbor depot')) + paragraph(run('Central depot'))
    );
    const explanation = unresolvableOf(
      await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact: 'depot' })
    );
    expect(explanation).toContain('occurs 2 times');
    expect(explanation).toContain('no surrounding text to tell them apart');
    expect(explanation).toContain('Candidate lines: 1, 2.');
  });

  test('surrounding text places a repeated quote at the paragraph it belongs to', async () => {
    const book = docx(
      paragraph(run('Harbor depot')) + paragraph(run('Central depot'))
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'depot',
          prefix: 'Central ',
        })
      )
    ).toMatchObject({ line: 2, context_matched: true, occurrences: 2 });
  });

  test('a prefix that differs only in paragraph spacing still places the quote', async () => {
    const book = docx(
      paragraph(run('Alpha one two.')) + paragraph(run('Harbor office.'))
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Harbor',
          prefix: 'one two.',
        })
      )
    ).toMatchObject({ line: 2, context_matched: true });
  });

  test('a single occurrence is placed even when its surroundings differ, and the difference is reported', async () => {
    const book = docx(paragraph(run('Harbor office.')));
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Harbor',
          prefix: 'Completely different ',
        })
      )
    ).toMatchObject({ line: 1, context_matched: false, occurrences: 1 });
  });

  test('a repeated quote whose surroundings single out one occurrence is placed there, and says it only partly matches', async () => {
    const book = docx(
      paragraph(run('Alpha Harbor.')) + paragraph(run('Beta Harbor.'))
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Harbor',
          prefix: 'Zeta Beta ',
        })
      )
    ).toMatchObject({ line: 2, context_matched: false, occurrences: 2 });
  });

  test('a line break inside a paragraph counts as a line', async () => {
    const book = docx(
      paragraph(run('A')) +
        paragraph(`${run('B')}<w:r><w:br/></w:r>${run('C')}`)
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact: 'C' })
      )
    ).toMatchObject({ line: 3 });
  });

  test('text in a header part is not searched, and the quote is reported as not found', async () => {
    const book = docx(paragraph(run('Body text.')), {
      extra: [
        {
          name: 'word/header1.xml',
          text: documentXml(paragraph(run('Confidential'))),
        },
      ],
    });
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Confidential',
        })
      )
    ).toContain('was not found');
  });

  test('a DOCTYPE in the main part refuses the whole document', async () => {
    const book = zipFixture([
      { name: '[Content_Types].xml', text: '<Types/>' },
      { name: '_rels/.rels', text: rootRelationships('word/document.xml') },
      {
        name: 'word/document.xml',
        text: documentXml(paragraph(run('Hidden')), '<!DOCTYPE w:document>'),
      },
    ]);
    expect(await indexFromBytes(book, 'docx')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Hidden',
        })
      )
    ).toBe(
      'The document could not be read, so the quoted text cannot be checked.'
    );
  });

  test('the office document is the part the package names, so a decoy at the conventional path is never read', async () => {
    const book = docx(paragraph(run('Real text')), {
      main: 'word/main.xml',
      extra: [
        {
          name: 'word/document.xml',
          text: documentXml(paragraph(run('Decoy text'))),
          deflate: true,
        },
      ],
    });
    expect(await indexFromBytes(book, 'docx')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Decoy text',
        })
      )
    ).toContain('could not be read');
  });

  test('a package with no root relationships part is refused', async () => {
    const book = docx(paragraph(run('Body text.')), { rels: null });
    expect(await indexFromBytes(book, 'docx')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });

  test('an absolute office document target names the same part', async () => {
    const book = docx(paragraph(run('Absolute target text.')), {
      rels: rootRelationships('/word/document.xml'),
    });
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Absolute target',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('tracked deletions are not searched, and tracked insertions are', async () => {
    const book = docx(
      paragraph(
        '<w:ins w:id="1" w:author="a"><w:r><w:t>Inserted words</w:t></w:r></w:ins>' +
          '<w:del w:id="2" w:author="a"><w:r><w:delText>Removed words</w:delText></w:r></w:del>'
      )
    );
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Removed words',
        })
      )
    ).toContain('was not found');
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Inserted words',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('hidden runs are not searched, unless their value turns hiding off', async () => {
    const book = docx(
      paragraph(
        '<w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden words</w:t></w:r>' +
          '<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>Shown words</w:t></w:r>'
      )
    );
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Hidden words',
        })
      )
    ).toContain('was not found');
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Shown words',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('an alternate-content block in a run shows the first element of its fallback, never its choice', async () => {
    const book = docx(
      paragraph(
        '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:t>Choice words</w:t></mc:Choice>' +
          '<mc:Fallback><w:t>Fallback words</w:t><w:t>Second fallback</w:t></mc:Fallback>' +
          '</mc:AlternateContent></w:r>'
      )
    );
    for (const exact of ['Choice words', 'Second fallback']) {
      expect(
        unresolvableOf(
          await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact })
        )
      ).toContain('was not found');
    }
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Fallback words',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('alternate content outside a run is not shown', async () => {
    const book = docx(
      paragraph(
        '<mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>Outside choice</w:t></w:r></mc:Choice>' +
          '<mc:Fallback><w:r><w:t>Outside fallback</w:t></w:r></mc:Fallback></mc:AlternateContent>'
      ) + paragraph(run('Plain words.'))
    );
    for (const exact of ['Outside choice', 'Outside fallback']) {
      expect(
        unresolvableOf(
          await resolveDocumentQuote(book, DOCX, { kind: 'quote', exact })
        )
      ).toContain('was not found');
    }
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Plain words.',
        })
      )
    ).toMatchObject({ exact: 'Plain words.' });
  });

  test('a main part past the part limit is refused as too large', async () => {
    const book = docx(paragraph(run('Long enough text here.')));
    expect(
      await indexFromBytes(book, 'docx', { ...DOCUMENT_LIMITS, part: 10 })
    ).toEqual({ ok: false, reason: 'too-large' });
  });
  test('legacy field data is never shown, so it is never searched', async () => {
    const book = docx(
      paragraph(
        '<w:r><w:fldChar w:fldCharType="begin"><w:fldData>SGVsbG8gd29ybGQ=</w:fldData></w:fldChar></w:r>' +
          run('Visible words.')
      )
    );
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'SGVsbG8gd29ybGQ',
        })
      )
    ).toContain('was not found');
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, DOCX, {
          kind: 'quote',
          exact: 'Visible words.',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('a file that is not a package is refused', async () => {
    expect(await indexFromBytes(encoder.encode('not a zip'), 'docx')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
});

describe('an EPUB', () => {
  test('chapters are searched in spine order, not manifest order', async () => {
    const book = epub(
      [
        { id: 'b', xhtml: xhtml('<p>In B: the shared phrase here.</p>') },
        { id: 'a', xhtml: xhtml('<p>In A: the shared phrase here.</p>') },
      ],
      ['a', 'b']
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'shared phrase',
          prefix: 'In A: the ',
        })
      )
    ).toMatchObject({ format: 'epub', line: 1 });
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'shared phrase',
          prefix: 'In B: the ',
        })
      )
    ).toMatchObject({ line: 2 });
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
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'washers ship\u2014slowly',
        })
      )
    ).toMatchObject({
      exact: 'washers ship\u2014slowly',
      context_before: 'Rivets & ',
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
      unresolvableOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'hidden',
        })
      )
    ).toContain('was not found');
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'secret',
        })
      )
    ).toContain('was not found');
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Visible text.',
        })
      )
    ).toMatchObject({ line: 1 });
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
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Heading in SVG',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('hidden and aria-hidden attributes hide nothing in the frame, so their text is searched', async () => {
    const book = epub(
      [
        {
          id: 'h',
          xhtml: xhtml(
            '<p hidden="">Hidden paragraph words.</p><p aria-hidden="true">Aria words.</p>'
          ),
        },
      ],
      ['h']
    );
    for (const exact of ['Hidden paragraph words.', 'Aria words.']) {
      expect(
        resolvedOf(
          await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact })
        )
      ).toMatchObject({ exact });
    }
  });

  test('text the frame does not show is not searched', async () => {
    const book = epub(
      [
        {
          id: 'h',
          xhtml: xhtml(
            '<p style="display: none">Styled words.</p>' +
              '<p style="visibility: hidden">Unseen words.</p>' +
              '<form>Form words.</form>' +
              '<button>Button words.</button>' +
              '<select><option>Option words.</option></select>' +
              '<textarea>Area words.</textarea>' +
              '<iframe>Frame words.</iframe>' +
              '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>Foreign words.</foreignObject></svg>' +
              '<p>Visible words.</p>',
            '<title>Head words.</title>'
          ),
        },
      ],
      ['h']
    );
    for (const exact of [
      'Styled words.',
      'Unseen words.',
      'Form words.',
      'Button words.',
      'Option words.',
      'Area words.',
      'Frame words.',
      'Foreign words.',
      'Head words.',
    ]) {
      expect(
        unresolvableOf(
          await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact })
        )
      ).toContain('was not found');
    }
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Visible words.',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('in SVG, title and desc are not drawn, and a display attribute hides its element', async () => {
    const book = epub(
      [
        {
          id: 'art',
          mediaType: 'image/svg+xml',
          xhtml:
            '<svg xmlns="http://www.w3.org/2000/svg"><title>Title words.</title>' +
            '<desc>Desc words.</desc><g display="none"><text>Unshown vector.</text></g>' +
            '<text>Shown vector.</text></svg>',
        },
      ],
      ['art']
    );
    for (const exact of ['Title words.', 'Desc words.', 'Unshown vector.']) {
      expect(
        unresolvableOf(
          await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact })
        )
      ).toContain('was not found');
    }
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Shown vector.',
        })
      )
    ).toMatchObject({ line: 1 });
  });

  test('text the frame shows is searched, including noscript, template and an HTML display attribute', async () => {
    const book = epub(
      [
        {
          id: 'h',
          xhtml: xhtml(
            '<noscript><p>Noscript words.</p></noscript>' +
              '<template><p>Template words.</p></template>' +
              '<p display="none">Attribute words.</p>'
          ),
        },
      ],
      ['h']
    );
    for (const exact of [
      'Noscript words.',
      'Template words.',
      'Attribute words.',
    ]) {
      expect(
        resolvedOf(
          await resolveDocumentQuote(book, BOOK, { kind: 'quote', exact })
        )
      ).toMatchObject({ exact });
    }
  });

  test('an SVG chapter in the spine is searched, as the frame draws it', async () => {
    const book = epub(
      [
        {
          id: 'art',
          mediaType: 'image/svg+xml',
          xhtml:
            '<svg xmlns="http://www.w3.org/2000/svg"><text>Vector words.</text></svg>',
        },
      ],
      ['art']
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Vector words.',
        })
      )
    ).toMatchObject({ line: 1, unreadable_chapters: 0 });
  });

  test('an ebook with a spine item the viewer does not render is refused whole, as the viewer refuses it', async () => {
    const chapters = [
      { id: 'style', mediaType: 'text/css', xhtml: 'p { margin: 0 }' },
      { id: 'body', xhtml: xhtml('<p>Body words.</p>') },
    ];
    expect(
      unresolvableOf(
        await resolveDocumentQuote(epub(chapters, ['style', 'body']), BOOK, {
          kind: 'quote',
          exact: 'Body words.',
        })
      )
    ).toContain('cannot show this ebook');
    expect(
      resolvedOf(
        await resolveDocumentQuote(epub(chapters.slice(1), ['body']), BOOK, {
          kind: 'quote',
          exact: 'Body words.',
        })
      )
    ).toMatchObject({ line: 1, unreadable_chapters: 0 });
  });

  test('the spine is read linear items first, as the frame reads it', async () => {
    const book = epub(
      [
        { id: 'notes', linear: false, xhtml: xhtml('<p>Footnote words.</p>') },
        { id: 'body', xhtml: xhtml('<p>Body words.</p>') },
      ],
      ['notes', 'body']
    );
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Body words.',
        })
      )
    ).toMatchObject({ line: 1 });
    expect(
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Footnote words.',
        })
      )
    ).toMatchObject({ line: 2 });
  });

  test('a chapter that cannot be read is counted, and a placement in the readable text says so', async () => {
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
      resolvedOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Readable chapter text.',
        })
      )
    ).toMatchObject({ unreadable_chapters: 1, line: 1 });
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Refused chapter text.',
        })
      )
    ).toBe(
      'The quoted text was not found in the document text this reader searches (it may have been edited or removed in a newer version, or it may sit in a header, footer or note). 1 chapter(s) could not be read and were not searched.'
    );
  });

  test('a DRM-protected ebook is refused with the reason', async () => {
    const book = epub(
      [{ id: 'k', xhtml: xhtml('<p>Protected text.</p>') }],
      ['k'],
      [{ name: 'META-INF/rights.xml', text: '<rights/>' }]
    );
    expect(
      unresolvableOf(
        await resolveDocumentQuote(book, BOOK, {
          kind: 'quote',
          exact: 'Protected text.',
        })
      )
    ).toBe(
      'The ebook is protected by DRM, so the quoted text cannot be checked against it.'
    );
  });

  test('two thousand spine references to one chapter read that chapter once, and search it once', async () => {
    const refs = Array.from({ length: 2000 }, () => 'c');
    const bytes = epub(
      [{ id: 'c', xhtml: xhtml('<p>Repeated chapter.</p>') }],
      refs
    );
    const zip = await indexZip(bytes, DOCUMENT_ZIP_LIMITS, nodeInflater);
    if (!zip.ok) throw new Error('the fixture is not a package');
    const reads: string[] = [];
    const counting: ZipIndex = {
      entries: zip.index.entries,
      read: (name) => {
        reads.push(name);
        return zip.index.read(name);
      },
    };
    const outcome = await indexFromZip(counting, 'epub');
    expect(outcome.ok).toBe(true);
    expect(reads.filter((name) => name === 'OPS/c.xhtml')).toHaveLength(1);
    expect(
      resolvedOf(
        await resolveDocumentQuote(bytes, BOOK, {
          kind: 'quote',
          exact: 'Repeated chapter.',
        })
      )
    ).toMatchObject({ occurrences: 1, line: 1 });
  });

  test('two thousand references to one 16 MB chapter are refused quickly, as too large', async () => {
    const huge = `<html xmlns="http://www.w3.org/1999/xhtml"><body>${'<i/>'.repeat(4_000_000)}</body></html>`;
    const bytes = epub(
      [{ id: 'c', xhtml: huge }],
      Array.from({ length: 2000 }, () => 'c')
    );
    const started = performance.now();
    const outcome = await indexFromBytes(bytes, 'epub');
    expect(outcome).toEqual({ ok: false, reason: 'too-large' });
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test('distinct chapters that together pass the markup budget are refused as too large', async () => {
    const chapter = xhtml('<p>x</p>'.repeat(300));
    const bytes = epub(
      [
        { id: 'a', xhtml: chapter },
        { id: 'b', xhtml: chapter },
      ],
      ['a', 'b']
    );
    expect(
      await indexFromBytes(bytes, 'epub', { ...DOCUMENT_LIMITS, tags: 1000 })
    ).toEqual({ ok: false, reason: 'too-large' });
  });

  test('distinct chapters that together pass the byte budget are refused as too large', async () => {
    const chapter = xhtml('x'.repeat(600));
    const bytes = epub(
      [
        { id: 'a', xhtml: chapter },
        { id: 'b', xhtml: chapter },
      ],
      ['a', 'b']
    );
    expect(
      await indexFromBytes(bytes, 'epub', { ...DOCUMENT_LIMITS, bytes: 1000 })
    ).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('placing a quote', () => {
  test('an empty quote is never placed', async () => {
    const text = await textOf(docx(paragraph(run('Some text.'))), 'docx');
    expect(placeQuote(text, { exact: '   ' })).toEqual({ kind: 'absent' });
  });

  test('a quote is placed past ten thousand earlier occurrences by its surroundings', async () => {
    const paragraphs =
      Array.from({ length: 12_000 }, () =>
        paragraph(run('Routine item.'))
      ).join('') + paragraph(run('Rare item.'));
    const text = await textOf(docx(paragraphs), 'docx');
    const resolved = resolvedOf(
      resolveQuote(text, { exact: 'item', prefix: 'Rare ' })
    );
    expect(resolved).toMatchObject({
      line: 12_001,
      context_matched: true,
      occurrences: 12_001,
    });
  });

  test('a repeated quote whose surroundings are equally far from every place is ambiguous', async () => {
    const text = await textOf(
      docx(paragraph(run('Harbor depot')) + paragraph(run('Central depot'))),
      'docx'
    );
    const resolution = resolveQuote(text, { exact: 'depot', prefix: 'zzz ' });
    expect(resolution).toMatchObject({ status: 'unresolvable' });
    expect('explanation' in resolution ? resolution.explanation : '').toContain(
      'no closer to any one of them than to the others'
    );
  });

  test('the search stops at its step limit, and says the quote occurs too often', async () => {
    const text = await textOf(docx(paragraph(run('x x x x x'))), 'docx');
    const resolution = resolveQuote(
      text,
      { exact: 'x', prefix: 'zzz' },
      { ...DOCUMENT_LIMITS, steps: 3 }
    );
    expect(resolution).toMatchObject({ status: 'unresolvable' });
    expect('explanation' in resolution ? resolution.explanation : '').toContain(
      'occurs too often'
    );
  });

  test('a repeated quote with no surroundings stops at its second exact match, and says at least', async () => {
    const sentence =
      'Every paragraph here repeats one long sentence about harbors, depots, ferries and tides.';
    const text = await textOf(
      docx(Array.from({ length: 50 }, () => paragraph(run(sentence))).join('')),
      'docx'
    );
    const resolution = resolveQuote(
      text,
      { exact: sentence },
      { ...DOCUMENT_LIMITS, steps: 2 * sentence.length + 1 }
    );
    expect(resolution).toMatchObject({ status: 'unresolvable' });
    const explanation =
      'explanation' in resolution ? resolution.explanation : '';
    expect(explanation).toContain('occurs at least 2 times');
    expect(explanation).toContain('Candidate lines: 1, 2.');
  });

  test('a repeated quote whose surroundings never match stops within its step limit', async () => {
    const sentence =
      'Every paragraph here repeats one long sentence about harbors, depots, ferries and tides.';
    const text = await textOf(
      docx(Array.from({ length: 50 }, () => paragraph(run(sentence))).join('')),
      'docx'
    );
    const resolution = resolveQuote(
      text,
      { exact: sentence, prefix: 'zzz' },
      { ...DOCUMENT_LIMITS, steps: 2 * sentence.length + 1 }
    );
    expect(resolution).toMatchObject({ status: 'unresolvable' });
    const explanation =
      'explanation' in resolution ? resolution.explanation : '';
    expect(explanation).toContain('occurs too often');
  });

  test('context is cut on whole characters', async () => {
    const text = await textOf(
      docx(paragraph(run(`${'\u{1F600}'.repeat(200)}xXYZ`))),
      'docx'
    );
    const resolved = resolvedOf(resolveQuote(text, { exact: 'XYZ' }));
    expect(resolved.context_before.length).toBe(119);
    const first = resolved.context_before.charCodeAt(0);
    expect(first >= 0xd800 && first <= 0xdbff).toBe(true);
  });

  test('a line is counted from the text breaks before it, not from characters', () => {
    const text = {
      flat: 'one two three ',
      breakAt: [3, 7],
      breakLines: [0, 2, 3],
      unreadable: 0,
    } satisfies DocumentText;
    expect(lineAt(text, 1)).toBe(1);
    expect(lineAt(text, 5)).toBe(3);
    expect(lineAt(text, 9)).toBe(4);
  });
});

describe('caching and kinds', () => {
  test('one index serves every quote on the same version', async () => {
    const bytes = docx(paragraph(run('Cached text.')));
    expect(documentIndexFor(bytes, 'docx')).toBe(
      documentIndexFor(bytes, 'docx')
    );
  });

  test('a Word document and an EPUB are documents; other files are not', () => {
    expect(documentKindOf(docx(paragraph(run('x'))), DOCX)).toBe('docx');
    expect(
      documentKindOf(epub([{ id: 'a', xhtml: xhtml('<p>x</p>') }], ['a']), BOOK)
    ).toBe('epub');
    expect(
      documentKindOf(encoder.encode('plain text'), 'notes.txt')
    ).toBeUndefined();
  });
});
