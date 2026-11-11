/**
 * Markdown to a Word document, built in the browser.
 *
 * The decrypted source never leaves the viewer, which is the reason this runs
 * here and not on the server: a server-side converter would be a service that
 * reads the plaintext. This file is loaded on demand, as its own chunk, when a
 * reader asks for a `.docx`, so the app shell does not carry the library.
 *
 * It walks the same blocks the page renders from (`parseMarkdown`) and reads
 * inline styling through the same engine (`inlineRuns`), so the export and
 * the page cannot disagree about structure, emphasis, or which links are
 * links. The result is inert data, a zip of XML, so exporting adds no
 * execution surface. What it can get wrong is validity: Word refuses a file
 * whose text holds a character XML 1.0 forbids, and the source is untrusted
 * bytes, so every string goes through `xmlSafe` first.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  type Block,
  type InlineRun,
  inlineRuns,
  parseMarkdown,
} from './markdown.ts';

type Child = Paragraph | Table;

/** US Letter with one-inch margins, in twentieths of a point. */
const CONTENT_WIDTH = 9360;
const INDENT_STEP = 720;

const INK = '16191A';
const INK_SOFT = '5A6163';
const RULE = 'B3B8B4';
const SURFACE = 'F1F2F0';

const BODY_FONT = 'Calibri';
const CODE_FONT = 'Consolas';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Half-points, so 32 is sixteen point. */
const HEADING_SIZES = [36, 30, 26, 24, 22, 22] as const;

const BULLETS = 'relic-bullets';
const NUMBERED = 'relic-numbered';

/**
 * Text Word will open.
 *
 * XML 1.0 has no representation for most C0 controls or the two noncharacters
 * at the top of the BMP, and a lone surrogate is not text at all. A single one
 * makes the whole file unreadable, and none of them is visible in the source,
 * so they are dropped (or, for a lone surrogate, replaced) rather than trusted.
 */
export function xmlSafe(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the controls is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (match) =>
        match.length === 2 ? match : '\uFFFD'
      )
  );
}

/** Formatting a whole paragraph imposes, such as a table header or a quote. */
interface BaseStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
}

/**
 * Only formatting that is on is written. An explicit `bold: false` is not a
 * no-op: it becomes `<w:b w:val="false"/>`, which overrides the bold a
 * heading style supplies and renders every heading in regular weight.
 */
function styledRun(run: InlineRun, base: BaseStyle = {}): TextRun {
  const bold = run.bold || base.bold === true;
  const italics = run.italic || run.image || base.italics === true;
  const text = xmlSafe(run.text);
  if (run.href !== undefined) {
    return new TextRun({
      text,
      style: 'Hyperlink',
      ...(bold ? { bold: true } : {}),
      ...(italics ? { italics: true } : {}),
      ...(run.strike ? { strike: true } : {}),
    });
  }
  return new TextRun({
    text,
    ...(bold ? { bold: true } : {}),
    ...(italics ? { italics: true } : {}),
    ...(run.strike ? { strike: true } : {}),
    ...(run.code
      ? {
          font: CODE_FONT,
          size: 20,
          shading: { type: ShadingType.CLEAR, fill: SURFACE },
        }
      : {}),
    ...(run.image ? { color: INK_SOFT } : {}),
  });
}

/**
 * Inline children of one paragraph. A link becomes a hyperlink wrapping its
 * runs, and only a link `inline` already let through carries an `href`, so a
 * `javascript:` target cannot reach the document.
 */
function inlineChildren(
  source: string,
  base: BaseStyle = {}
): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  let pending: { href: string; runs: TextRun[] } | undefined;

  const flush = (): void => {
    if (pending === undefined) return;
    out.push(
      new ExternalHyperlink({ link: pending.href, children: pending.runs })
    );
    pending = undefined;
  };

  for (const run of inlineRuns(source)) {
    if (run.href === undefined) {
      flush();
      out.push(styledRun(run, base));
      continue;
    }
    if (pending !== undefined && pending.href !== run.href) flush();
    pending ??= { href: run.href, runs: [] };
    pending.runs.push(styledRun(run, base));
  }
  flush();
  return out;
}

function codeBlock(text: string, depth: number): Paragraph {
  const lines = text.split('\n');
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: SURFACE },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 },
      left: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 },
      right: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 },
    },
    indent: { left: depth * INDENT_STEP + 120, right: 120 },
    spacing: { before: 120, after: 200, line: 260 },
    children: lines.map(
      (line, index) =>
        new TextRun({
          // A tab character is not a tab in WordprocessingML text.
          text: xmlSafe(line.replace(/\t/g, '    ')),
          font: CODE_FONT,
          size: 18,
          ...(index > 0 ? { break: 1 } : {}),
        })
    ),
  });
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[]
): Table {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const width = Math.floor(CONTENT_WIDTH / columns);
  const cell = (text: string | undefined, head: boolean): TableCell =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      ...(head ? { shading: { type: ShadingType.CLEAR, fill: SURFACE } } : {}),
      children: [
        new Paragraph({
          spacing: { after: 0 },
          children: inlineChildren(text ?? '', head ? { bold: true } : {}),
        }),
      ],
    });

  const line = { style: BorderStyle.SINGLE, size: 4, color: RULE } as const;

  const padded = (cells: readonly string[], head: boolean): TableRow =>
    new TableRow({
      tableHeader: head,
      cantSplit: true,
      children: Array.from({ length: columns }, (_, index) =>
        cell(cells[index], head)
      ),
    });

  return new Table({
    width: { size: columns * width, type: WidthType.DXA },
    columnWidths: Array.from({ length: columns }, () => width),
    borders: {
      top: line,
      bottom: line,
      left: line,
      right: line,
      insideHorizontal: line,
      insideVertical: line,
    },
    rows: [padded(header, true), ...rows.map((row) => padded(row, false))],
  });
}

interface Context {
  /** Each ordered list restarts at one, which Word does per numbering instance. */
  nextInstance: number;
}

function convert(
  blocks: readonly Block[],
  context: Context,
  depth: number
): Child[] {
  const out: Child[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        out.push(
          new Paragraph({
            heading: HEADINGS[block.level - 1] as (typeof HEADINGS)[number],
            ...(depth > 0 ? { indent: { left: depth * INDENT_STEP } } : {}),
            children: inlineChildren(block.text),
          })
        );
        break;
      case 'paragraph':
        out.push(
          new Paragraph({
            ...(depth > 0 ? { indent: { left: depth * INDENT_STEP } } : {}),
            ...(depth > 0
              ? {
                  border: {
                    left: {
                      style: BorderStyle.SINGLE,
                      size: 12,
                      color: RULE,
                      space: 8,
                    },
                  },
                }
              : {}),
            children: inlineChildren(block.text, { italics: depth > 0 }),
          })
        );
        break;
      case 'code':
        out.push(codeBlock(block.text, depth));
        break;
      case 'rule':
        out.push(
          new Paragraph({
            spacing: { before: 240, after: 240 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: RULE,
                space: 1,
              },
            },
          })
        );
        break;
      case 'quote':
        out.push(...convert(block.blocks, context, depth + 1));
        break;
      case 'list': {
        const instance = block.ordered ? context.nextInstance++ : 0;
        for (const [position, item] of block.items.entries()) {
          out.push(
            new Paragraph({
              numbering: {
                reference: block.ordered ? NUMBERED : BULLETS,
                level: 0,
                ...(block.ordered ? { instance } : {}),
              },
              indent: {
                left: (depth + 1) * INDENT_STEP,
                hanging: 360,
              },
              spacing: {
                after: position === block.items.length - 1 ? 160 : 80,
              },
              children: inlineChildren(item),
            })
          );
        }
        break;
      }
      case 'table':
        out.push(table(block.header, block.rows));
        // A table must be followed by a paragraph for Word to place the next
        // block below it rather than merge into it.
        out.push(new Paragraph({ spacing: { after: 120 } }));
        break;
    }
  }
  return out;
}

function listLevel(
  format: (typeof LevelFormat)[keyof typeof LevelFormat],
  text: string
) {
  return {
    level: 0,
    format,
    text,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: INDENT_STEP, hanging: 360 } } },
  } as const;
}

export async function markdownToDocx(
  source: string,
  title: string
): Promise<Blob> {
  const children = convert(parseMarkdown(source), { nextInstance: 1 }, 0);
  // A section with no block at all is a document some readers refuse to open.
  if (children.length === 0) children.push(new Paragraph({}));

  const heading = (index: number) => ({
    id: `Heading${index + 1}`,
    name: `Heading ${index + 1}`,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: {
      font: BODY_FONT,
      bold: true,
      color: INK,
      size: HEADING_SIZES[index] as number,
    },
    paragraph: { spacing: { before: index === 0 ? 360 : 280, after: 120 } },
  });

  const document = new Document({
    title: xmlSafe(title),
    creator: 'Relic',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22, color: INK },
          paragraph: { spacing: { after: 160, line: 288 } },
        },
      },
      paragraphStyles: HEADINGS.map((_level, index) => heading(index)),
    },
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [listLevel(LevelFormat.BULLET, '\u2022')],
        },
        {
          reference: NUMBERED,
          levels: [listLevel(LevelFormat.DECIMAL, '%1.')],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(document);
}
