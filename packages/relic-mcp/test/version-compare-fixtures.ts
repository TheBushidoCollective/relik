// Proof fixtures for side-by-side version comparison (B5, spec section 6).
// Each builder is deterministic. The browser stage and the unit test both read
// these exports, so the expected facts live beside the bytes that produce them.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  writeZipCentralRecord,
  writeZipEnd,
  writeZipLocalHeader,
  type ZipEntryRecord,
} from '@relic/format';
import { indexZip, crc32, type ZipIndex } from '@relic/format/zip-index';
// docx is a relic-viewer dependency, not relic-mcp's. docx-frame-path.mjs loads
// it from the sibling install, and this module does the same.
import type * as DocxTypes from '../../relic-viewer/node_modules/docx/dist/index.js';
// @ts-expect-error The .mjs build has no declaration file; index.d.ts types it. relic-mcp does not depend on docx itself.
import * as docxRuntime from '../../relic-viewer/node_modules/docx/dist/index.mjs';
const docx: typeof DocxTypes = docxRuntime;

/** Viewer ZIP limits for documents (document-route.ts LIMITS). */
const READ_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const;

/** Per-version comparison ceiling (diff.ts MAX_DIFF_BYTES). */
export const COMPARE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Stored padding entry in the oversize DOCX. */
export const PADDING_BYTES = 17 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Adapts node:zlib to the InflaterFn callback shape indexZip expects.
export const inflate = (data: Uint8Array): Uint8Array => inflateRawSync(data);

export interface FixtureEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** 0 stores the bytes, 8 deflates them. */
  readonly method: 0 | 8;
}

/**
 * Write a ZIP32 archive with the same record writers the existing proof
 * builders use (spreadsheet-path.ts, epub-viewer-path.ts).
 */
export function zipFiles(files: readonly FixtureEntry[]): Uint8Array {
  const prepared = files.map((file) => {
    const nameBytes = encoder.encode(file.name);
    const packed = file.method === 8 ? deflateRawSync(file.bytes) : file.bytes;
    return {
      nameBytes,
      packed,
      method: file.method,
      size: file.bytes.length,
      crc: crc32(file.bytes),
    };
  });
  const records: ZipEntryRecord[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of prepared) {
    records.push({
      nameBytes: entry.nameBytes,
      method: entry.method,
      crc32: entry.crc,
      compressedSize: entry.packed.length,
      uncompressedSize: entry.size,
      localHeaderOffset: offset,
    });
    offset += 30 + entry.nameBytes.length + entry.packed.length;
    directorySize += 46 + entry.nameBytes.length;
  }
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  prepared.forEach((entry, i) => {
    at += writeZipLocalHeader(out, at, records[i]!);
    out.set(entry.packed, at);
    at += entry.packed.length;
  });
  const directoryOffset = at;
  for (const record of records) at += writeZipCentralRecord(out, at, record);
  writeZipEnd(out, at, {
    entryCount: records.length,
    directorySize,
    directoryOffset,
    comment: new Uint8Array(),
  });
  return out;
}

/** Index an archive with the viewer's ZIP checks. Throws if it is not a ZIP. */
export async function indexFixture(bytes: Uint8Array): Promise<ZipIndex> {
  const result = await indexZip(bytes, READ_LIMITS, inflate);
  if (!result.ok)
    throw new Error(`fixture is not a readable ZIP: ${result.reason}`);
  return result.index;
}

/** Every file entry in archive order, with its stored method. */
export async function fixtureEntries(
  bytes: Uint8Array
): Promise<FixtureEntry[]> {
  const index = await indexFixture(bytes);
  const entries: FixtureEntry[] = [];
  for (const [name, info] of index.entries) {
    if (info.kind !== 'file') continue;
    const read = await index.read(name);
    if (!read.ok) throw new Error(`fixture entry ${name}: ${read.reason}`);
    entries.push({
      name,
      bytes: read.bytes,
      method: info.method === 0 ? 0 : 8,
    });
  }
  return entries;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------- DOCX

/**
 * A 1x1 RGB PNG, one red pixel, with every chunk length and CRC correct. The
 * viewer reads it through ImageBudget (frame-zip-entries.ts), as it reads a
 * reader's own picture. version-compare-fixtures.test.ts checks each chunk.
 */
export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64'
  )
);

export const DOCX_AUTHOR = 'Fixture author';
export const DOCX_REVIEWER = 'Fixture reviewer';

const cell = (text: string) =>
  new docx.TableCell({ children: [new docx.Paragraph(text)] });
const table = (target: string) =>
  new docx.Table({
    rows: [
      new docx.TableRow({ children: [cell('Region'), cell('Target')] }),
      new docx.TableRow({ children: [cell('West'), cell(target)] }),
    ],
  });
const imageParagraph = () =>
  new docx.Paragraph({
    children: [
      new docx.ImageRun({
        type: 'png',
        data: PNG_1X1,
        transformation: { width: 20, height: 20 },
      }),
    ],
  });

async function docxBytes(
  header: string,
  children: (DocxTypes.Paragraph | DocxTypes.Table)[]
): Promise<Uint8Array> {
  const document = new docx.Document({
    creator: DOCX_AUTHOR,
    title: 'Quarterly plan',
    sections: [
      {
        headers: {
          default: new docx.Header({
            children: [new docx.Paragraph(header)],
          }),
        },
        footers: {
          default: new docx.Footer({
            children: [new docx.Paragraph(DOCX_FOOTER)],
          }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await docx.Packer.toBuffer(document));
}

/** Expected body paragraphs of DOCX v1, in reading order, empty ones dropped. */
export const DOCX_V1_TEXT = [
  'Quarterly plan',
  'Revenue grew in every region.',
  'Hiring stays flat.',
  'Region',
  'Target',
  'West',
  '120',
  'This sentence is removed in version 2.',
] as const;

/** Expected body paragraphs of DOCX v2, in reading order, empty ones dropped. */
export const DOCX_V2_TEXT = [
  'Quarterly plan',
  'Revenue grew in every region except the north.',
  'Hiring stays flat.',
  'Region',
  'Target',
  'West',
  '135',
  'Launch in May.',
] as const;

export const DOCX_V1_HEADER = 'Draft';
export const DOCX_V2_HEADER = 'Final';
export const DOCX_FOOTER = 'Internal';

/** DOCX v1: header "Draft", footer "Internal", a table, a removed sentence and an image. */
export function docxV1(): Promise<Uint8Array> {
  return docxBytes(DOCX_V1_HEADER, [
    new docx.Paragraph({
      heading: docx.HeadingLevel.HEADING_1,
      children: [new docx.TextRun('Quarterly plan')],
    }),
    new docx.Paragraph('Revenue grew in every region.'),
    new docx.Paragraph('Hiring stays flat.'),
    table('120'),
    new docx.Paragraph('This sentence is removed in version 2.'),
    imageParagraph(),
  ]);
}

/** DOCX v2: header "Final", the revenue sentence extended, 120 to 135, the removed sentence gone, "Launch in May." after the image. */
export function docxV2(): Promise<Uint8Array> {
  return docxBytes(DOCX_V2_HEADER, [
    new docx.Paragraph({
      heading: docx.HeadingLevel.HEADING_1,
      children: [new docx.TextRun('Quarterly plan')],
    }),
    new docx.Paragraph('Revenue grew in every region except the north.'),
    new docx.Paragraph('Hiring stays flat.'),
    table('135'),
    imageParagraph(),
    new docx.Paragraph('Launch in May.'),
  ]);
}

/** v1 with only docProps/core.xml changed (the creator). The mark check must find no change. */
export async function docxV1CoreOnly(base: Uint8Array): Promise<Uint8Array> {
  // docx writes random ids, so the variant must start from the same build as its base.
  const entries = await fixtureEntries(base);
  const core = 'docProps/core.xml';
  const replaced = entries.map((entry) => {
    if (entry.name !== core) return entry;
    const text = decoder.decode(entry.bytes);
    if (!text.includes(`>${DOCX_AUTHOR}<`))
      throw new Error('docx core.xml does not carry the fixture author');
    return {
      ...entry,
      bytes: encoder.encode(
        text.replaceAll(`>${DOCX_AUTHOR}<`, `>${DOCX_REVIEWER}<`)
      ),
    };
  });
  return zipFiles(replaced);
}

/** DOCX v1 plus a 17 MiB stored padding entry. Its size is above the 16 MiB comparison ceiling. */
export async function docxPadded(): Promise<Uint8Array> {
  const entries = await fixtureEntries(await docxV1());
  return zipFiles([
    ...entries,
    {
      name: 'padding.bin',
      bytes: new Uint8Array(PADDING_BYTES).fill(0x78),
      method: 0,
    },
  ]);
}

// ---------------------------------------------------------------- EPUB

export interface EpubChapter {
  readonly file: string;
  readonly label: string;
  readonly paragraphs: readonly string[];
}

export const EPUB_TITLE = 'Crossings';
export const EPUB_HOSTILE_TEXT = '<img src=x onerror="window.__relicPwned=1">';

/**
 * The unchanged chapter. The filler paragraphs keep it long enough for the
 * EPUB frames to scroll, so the sync check has room to move. Both versions
 * carry the same text, so the filler adds no change.
 */
const OPENING: EpubChapter = {
  file: 'ch1.xhtml',
  label: 'Opening',
  paragraphs: [
    'The first chapter opens the story.',
    ...Array.from(
      { length: 40 },
      (_, index) => `The opening continues, paragraph ${index + 2}.`
    ),
  ],
};
const CROSSING_V1: EpubChapter = {
  file: 'ch2.xhtml',
  label: 'The crossing',
  paragraphs: ['We crossed at dawn.', 'Three boats were tied to the post.'],
};
const CROSSING_V2: EpubChapter = {
  ...CROSSING_V1,
  paragraphs: ['We crossed at noon.', 'Three boats were tied to the post.'],
};
const INTERLUDE: EpubChapter = {
  file: 'ch3.xhtml',
  label: 'Interlude',
  paragraphs: ['A short pause between crossings.'],
};
const AFTERWORD: EpubChapter = {
  file: 'ch4.xhtml',
  label: 'Afterword',
  paragraphs: ['The story ends here.'],
};

function chapterXhtml(chapter: EpubChapter): string {
  const label = escapeXml(chapter.label);
  const paragraphs = chapter.paragraphs
    .map((text) => `<p>${escapeXml(text)}</p>`)
    .join('');
  return `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${label}</title></head><body><h1>${label}</h1>${paragraphs}</body></html>`;
}

function epubBytes(chapters: readonly EpubChapter[]): Uint8Array {
  const items = chapters
    .map(
      (c) =>
        `<item id="${c.file.replace('.xhtml', '')}" href="${c.file}" media-type="application/xhtml+xml"/>`
    )
    .join('');
  const itemrefs = chapters
    .map((c) => `<itemref idref="${c.file.replace('.xhtml', '')}"/>`)
    .join('');
  const navItems = chapters
    .map((c) => `<li><a href="${c.file}">${escapeXml(c.label)}</a></li>`)
    .join('');
  const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:relic:version-compare:crossings</dc:identifier><dc:title>${EPUB_TITLE}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${itemrefs}</spine></package>`;
  const nav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${navItems}</ol></nav></body></html>`;
  const container =
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const files: FixtureEntry[] = [
    {
      name: 'mimetype',
      bytes: encoder.encode('application/epub+zip'),
      method: 0,
    },
    {
      name: 'META-INF/container.xml',
      bytes: encoder.encode(container),
      method: 8,
    },
    { name: 'OPS/book.opf', bytes: encoder.encode(opf), method: 8 },
    { name: 'OPS/nav.xhtml', bytes: encoder.encode(nav), method: 8 },
    ...chapters.map(
      (c): FixtureEntry => ({
        name: `OPS/${c.file}`,
        bytes: encoder.encode(chapterXhtml(c)),
        method: 8,
      })
    ),
  ];
  return zipFiles(files);
}

/** EPUB v1: Opening, The crossing, Interlude. */
export function epubV1(): Uint8Array {
  return epubBytes([OPENING, CROSSING_V1, INTERLUDE]);
}

/** EPUB v2: Opening (unchanged), The crossing (one paragraph changed), Interlude removed, Afterword added at the end. */
export function epubV2(): Uint8Array {
  return epubBytes([OPENING, CROSSING_V2, AFTERWORD]);
}

/** EPUB v2 whose changed paragraph is the literal hostile markup. The reader must show it as text. */
export function epubV2Hostile(): Uint8Array {
  return epubBytes([
    OPENING,
    {
      ...CROSSING_V2,
      paragraphs: [EPUB_HOSTILE_TEXT, CROSSING_V2.paragraphs[1]!],
    },
    AFTERWORD,
  ]);
}

// ---------------------------------------------------------------- XLSX

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const WORKSHEET_TYPE = `${REL_NS}/worksheet`;

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
const num = (ref: string, value: number) => `<c r="${ref}"><v>${value}</v></c>`;
const formula = (ref: string, source: string, cached: number) =>
  `<c r="${ref}"><f>${escapeXml(source)}</f><v>${cached}</v></c>`;

type SheetRows = readonly (readonly [number, readonly string[]])[];

function worksheet(rows: SheetRows): string {
  const body = rows
    .map(([row, cells]) => `<row r="${row}">${cells.join('')}</row>`)
    .join('');
  return `<worksheet xmlns="${SHEET_NS}"><sheetData>${body}</sheetData></worksheet>`;
}

interface SheetEntry {
  readonly name: string;
  readonly sheetId: number;
  readonly state?: 'hidden';
  readonly xml: string;
}

function workbookBytes(sheets: readonly SheetEntry[]): Uint8Array {
  const listed = sheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${s.sheetId}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`
    )
    .join('');
  const workbook = `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${listed}</sheets></workbook>`;
  const relationships = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="${WORKSHEET_TYPE}" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('');
  const files: FixtureEntry[] = [
    {
      name: '[Content_Types].xml',
      bytes: encoder.encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      ),
      method: 8,
    },
    { name: 'xl/workbook.xml', bytes: encoder.encode(workbook), method: 8 },
    {
      name: 'xl/_rels/workbook.xml.rels',
      bytes: encoder.encode(
        `<Relationships xmlns="${PKG_REL_NS}">${relationships}</Relationships>`
      ),
      method: 8,
    },
    ...sheets.map(
      (s, i): FixtureEntry => ({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        bytes: encoder.encode(s.xml),
        method: 8,
      })
    ),
  ];
  return zipFiles(files);
}

const Q3_HEADER_ROWS: SheetRows = [
  [
    1,
    [
      text('A1', 'Region'),
      text('B1', 'Units'),
      text('C1', 'Revenue'),
      text('E1', 'Check'),
    ],
  ],
];

/** Q3 in version 1: C3 1200, E2 a constant 2200, E3 =B2*2, B7 "Draft note". */
const Q3_V1 = worksheet([
  ...Q3_HEADER_ROWS,
  [2, [text('A2', 'North'), num('B2', 1000), num('E2', 2200)]],
  [3, [text('A3', 'South'), num('C3', 1200), formula('E3', 'B2*2', 2000)]],
  [7, [text('B7', 'Draft note')]],
]);

/** Q3 budget in version 2: C3 1250, E2 =SUM(B2:C3) cached 2250, E3 =B2+B2, D5 "Total" added. */
const Q3_BUDGET_V2 = worksheet([
  ...Q3_HEADER_ROWS,
  [
    2,
    [text('A2', 'North'), num('B2', 1000), formula('E2', 'SUM(B2:C3)', 2250)],
  ],
  [3, [text('A3', 'South'), num('C3', 1250), formula('E3', 'B2+B2', 2000)]],
  [5, [text('D5', 'Total')]],
]);

const OLD_DATA = worksheet([
  [1, [text('A1', 'Old header')]],
  [2, [text('A2', 'Old value')]],
]);

const SUMMARY = worksheet([
  [1, [text('A1', 'Summary')]],
  [2, [text('A2', 'Totals')]],
]);

/** Q3 (sheetId 1), Old data (sheetId 2, removed later), Hidden (sheetId 3, hidden) with A1 x. */
export function xlsxV1(): Uint8Array {
  return workbookBytes([
    { name: 'Q3', sheetId: 1, xml: Q3_V1 },
    { name: 'Old data', sheetId: 2, xml: OLD_DATA },
    {
      name: 'Hidden',
      sheetId: 3,
      state: 'hidden',
      xml: worksheet([
        [1, [text('A1', 'x')]],
        [2, [text('A2', 'Stable')]],
      ]),
    },
  ]);
}

/** Q3 renamed to "Q3 budget" (same sheetId 1), Old data removed, Hidden with A1 y, Summary (sheetId 4) added. */
export function xlsxV2(): Uint8Array {
  return workbookBytes([
    { name: 'Q3 budget', sheetId: 1, xml: Q3_BUDGET_V2 },
    {
      name: 'Hidden',
      sheetId: 3,
      state: 'hidden',
      xml: worksheet([
        [1, [text('A1', 'y')]],
        [2, [text('A2', 'Stable')]],
      ]),
    },
    { name: 'Summary', sheetId: 4, xml: SUMMARY },
  ]);
}

/** Version 2 with the added sheet named using a right-to-left override (U+202E). */
export function xlsxV2BidiSheet(): Uint8Array {
  return workbookBytes([
    { name: 'Q3 budget', sheetId: 1, xml: Q3_BUDGET_V2 },
    {
      name: 'Hidden',
      sheetId: 3,
      state: 'hidden',
      xml: worksheet([
        [1, [text('A1', 'y')]],
        [2, [text('A2', 'Stable')]],
      ]),
    },
    { name: 'Sum\u202emary', sheetId: 4, xml: SUMMARY },
  ]);
}
