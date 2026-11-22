import { isRecord } from '../../relic-format/src/guards.ts';
import type { Anchor, Mark } from './rendered-tree.ts';

export interface EpubBook {
  readonly title: string;
  readonly creator?: string;
  readonly language?: string;
  readonly progression: 'ltr' | 'rtl' | 'default';
  readonly layout: 'reflowable' | 'pre-paginated';
  readonly resources: readonly {
    readonly path: string;
    readonly mediaType: string;
  }[];
  readonly spine: readonly {
    readonly path: string;
    readonly linear: boolean;
  }[];
  readonly toc: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
    readonly depth: number;
  }[];
  readonly pageList: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
  }[];
}

export interface DocumentInput {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly book?: EpubBook;
  readonly requestExternalLink?: (
    event: MouseEvent,
    href: string | null
  ) => void;
}

export interface DocumentRenderHooks {
  registerImageIdentities(
    identities: ReadonlyMap<string, Promise<string>>
  ): void;
}

export type DocumentOutcome =
  | { readonly state: 'ready' }
  | {
      readonly state: 'failed';
      readonly reason:
        | 'corrupt'
        | 'unsupported'
        | 'too-large'
        | 'image-dimensions-unknown';
    };
export interface RenderDocumentMessage {
  readonly type: 'relic:render-document';
  readonly format: 'docx' | 'epub';
  readonly module: string;
  readonly entries: readonly (readonly [string, Uint8Array])[];
  readonly book?: EpubBook;
  /** Asks the frame to report its blocks once it has rendered. */
  readonly compare?: true;
}
export type DocumentStateMessage = DocumentOutcome & {
  readonly type: 'relic:document-state';
};

/** The most blocks one version may contribute to a comparison. */
export const MAX_DOCUMENT_BLOCKS = 50_000;
/** UTF-8 bytes of block text one version may contribute. */
export const MAX_DOCUMENT_BLOCK_BYTES = 16 * 1024 * 1024;
/** Render parts: EPUB spine items, and the spine cap `isBook` enforces. */
export const MAX_DOCUMENT_PARTS = 2_000;

const DOCUMENT_BLOCK_KINDS = [
  'paragraph',
  'heading',
  'list-item',
  'table-cell',
  'quote',
  'code',
  'caption',
  'image',
  'media',
  'text',
] as const;
export type DocumentBlockKind = (typeof DOCUMENT_BLOCK_KINDS)[number];

/**
 * One leaf of a rendered document, as text. The frame collapses whitespace and
 * trims before it sends, and only images and media have no text. `part` is the
 * render index of the EPUB chapter the block sits in, and 0 for a DOCX.
 */
export interface DocumentBlock {
  readonly kind: DocumentBlockKind;
  readonly text: string;
  readonly part: number;
}

/** The one message a comparison frame posts after it is ready. Text only. */
export interface DocumentBlocksMessage {
  readonly type: 'relic:document-blocks';
  readonly blocks: readonly DocumentBlock[] | null;
}

/** Frame-only: one render's blocks, with the elements they were read from. */
export interface DocumentBlockSnapshot {
  readonly blocks: readonly DocumentBlock[];
  readonly elements: readonly Element[];
}

/** What the DOCX and EPUB frame modules export. */
export interface DocumentModule {
  render(
    root: HTMLElement,
    input: DocumentInput,
    hooks?: DocumentRenderHooks
  ): Promise<DocumentOutcome>;
  blocks(root: HTMLElement): DocumentBlockSnapshot | null;
  annotate(
    snapshot: DocumentBlockSnapshot,
    marks: readonly Mark[],
    anchors: readonly Anchor[]
  ): number;
}

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';
function isBook(value: unknown): value is EpubBook {
  if (
    !isRecord(value) ||
    typeof value['title'] !== 'string' ||
    !optionalString(value['creator']) ||
    !optionalString(value['language']) ||
    !['ltr', 'rtl', 'default'].includes(value['progression'] as string) ||
    !['reflowable', 'pre-paginated'].includes(value['layout'] as string) ||
    !Array.isArray(value['spine']) ||
    value['spine'].length > MAX_DOCUMENT_PARTS ||
    !Array.isArray(value['resources']) ||
    value['resources'].length > 10000 ||
    !Array.isArray(value['toc']) ||
    !Array.isArray(value['pageList']) ||
    value['toc'].length + value['pageList'].length > 5000
  )
    return false;
  return (
    value['resources'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['path'] === 'string' &&
        typeof item['mediaType'] === 'string'
    ) &&
    value['spine'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['path'] === 'string' &&
        typeof item['linear'] === 'boolean'
    ) &&
    value['toc'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['label'] === 'string' &&
        typeof item['path'] === 'string' &&
        optionalString(item['fragment']) &&
        Number.isSafeInteger(item['depth']) &&
        (item['depth'] as number) >= 0
    ) &&
    value['pageList'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['label'] === 'string' &&
        typeof item['path'] === 'string' &&
        optionalString(item['fragment'])
    )
  );
}

export function isRenderDocumentMessage(
  value: unknown
): value is RenderDocumentMessage {
  if (
    !isRecord(value) ||
    value['type'] !== 'relic:render-document' ||
    (value['format'] !== 'docx' && value['format'] !== 'epub') ||
    typeof value['module'] !== 'string' ||
    value['module'].length > 2 * 1024 * 1024 ||
    new TextEncoder().encode(value['module']).byteLength > 2 * 1024 * 1024 ||
    !Array.isArray(value['entries']) ||
    value['entries'].length > 10000 ||
    (value['book'] !== undefined && !isBook(value['book'])) ||
    (value['compare'] !== undefined && value['compare'] !== true)
  )
    return false;
  let total = 0;
  const names = new Set<string>();
  for (const entry of value['entries']) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      names.has(entry[0]) ||
      !(entry[1] instanceof Uint8Array)
    )
      return false;
    names.add(entry[0]);
    total += entry[1].byteLength;
    if (total > 200 * 1024 * 1024) return false;
  }
  return true;
}

export function isDocumentStateMessage(
  value: unknown
): value is DocumentStateMessage {
  if (!isRecord(value) || value['type'] !== 'relic:document-state')
    return false;
  const keys = Object.keys(value);
  if (value['state'] === 'ready') return keys.length === 2;
  return (
    value['state'] === 'failed' &&
    keys.length === 3 &&
    (value['reason'] === 'corrupt' ||
      value['reason'] === 'unsupported' ||
      value['reason'] === 'too-large' ||
      value['reason'] === 'image-dimensions-unknown')
  );
}

const DOCUMENT_BLOCK_KIND_SET: ReadonlySet<unknown> = new Set<unknown>(
  DOCUMENT_BLOCK_KINDS
);

/**
 * The UTF-8 bytes left in `budget` after `value`, or -1 once it no longer fits.
 * Counted from the code units, so a refused text is never encoded.
 */
function spendUtf8(value: string, budget: number): number {
  if (value.length > budget) return -1;
  let left = budget;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) left -= 1;
    else if (code < 0x800) left -= 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      left -= 4;
      i++;
    } else left -= 3;
    if (left < 0) return -1;
  }
  return left;
}

/**
 * Validate a blocks message from a frame totally.
 *
 * One bad entry refuses the whole message: a partly read snapshot would compare
 * text nobody checked. Keys are exact, the array is dense, and the text across
 * every block fits the budget.
 */
export function isDocumentBlocksMessage(
  value: unknown
): value is DocumentBlocksMessage {
  if (
    !isRecord(value) ||
    value['type'] !== 'relic:document-blocks' ||
    Object.keys(value).length !== 2
  )
    return false;
  const blocks = value['blocks'];
  if (blocks === null) return true;
  if (
    !Array.isArray(blocks) ||
    blocks.length > MAX_DOCUMENT_BLOCKS ||
    Object.keys(blocks).length !== blocks.length
  )
    return false;
  let budget = MAX_DOCUMENT_BLOCK_BYTES;
  for (const block of blocks) {
    if (!isRecord(block) || Object.keys(block).length !== 3) return false;
    const kind = block['kind'];
    const text = block['text'];
    const part = block['part'];
    if (
      !DOCUMENT_BLOCK_KIND_SET.has(kind) ||
      typeof text !== 'string' ||
      typeof part !== 'number' ||
      !Number.isSafeInteger(part) ||
      part < 0 ||
      part >= MAX_DOCUMENT_PARTS
    )
      return false;
    budget = spendUtf8(text, budget);
    if (budget < 0) return false;
  }
  return true;
}
