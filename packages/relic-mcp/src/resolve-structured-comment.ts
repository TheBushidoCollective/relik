/**
 * Ties a `cell` or `path` comment to the version it was written on (plan
 * section 5). The comment resolves against that version only. A version the
 * service cannot give back, or a cell or path comment that records no version,
 * is "not found in this version", never a guess at the current file. A
 * subtitle time comment with no version belongs to version 1, as the viewer
 * places it; the caller reads version 1 for it.
 */

import type {
  CellCommentAnchor,
  CommentAnchor,
  PathCommentAnchor,
} from '@relic/format';
import type { CommentRecord } from './comments.ts';
import { deriveRendererClass } from '@relic/format';
import { resolveWorkbookCell } from './resolve-workbook.ts';
import {
  type CellResolution,
  type PathResolution,
  type StructuredReader,
  type TimeCuesResolution,
  structuredReaderFor,
} from './resolve-structured.ts';

/** The decrypted fields of one version this module reads. */
export interface VersionContent {
  readonly envelope: {
    readonly entries: readonly {
      readonly filename: string;
      readonly mimetype: string;
    }[];
  };
  readonly content: Uint8Array;
}

export type VersionFetch =
  | { readonly ok: true; readonly opened: VersionContent }
  | { readonly ok: false; readonly error: string };

const readers = new WeakMap<VersionContent, StructuredReader>();

/** One reader per decrypted version, so each format parses once per version. */
export function readerForVersion(opened: VersionContent): StructuredReader {
  let reader = readers.get(opened);
  if (reader === undefined) {
    const entry = opened.envelope.entries[0];
    reader = structuredReaderFor(
      opened.content,
      entry?.filename ?? '',
      entry?.mimetype ?? ''
    );
    readers.set(opened, reader);
  }
  return reader;
}

function notFound(
  kind: 'cell' | 'path',
  why: string
): CellResolution | PathResolution {
  return {
    kind,
    status: 'unresolvable',
    explanation: `The ${kind} is not found in this version: ${why}`,
  } as CellResolution | PathResolution;
}

/** Resolves one `cell` or `path` comment against the version it was written on. */
export async function resolveStructuredComment(
  comment: CommentRecord,
  anchor: CellCommentAnchor | PathCommentAnchor,
  load: (version: number) => Promise<VersionFetch>
): Promise<CommentRecord> {
  if (comment.version === null) {
    return {
      ...comment,
      resolved: notFound(anchor.kind, 'the comment records no version.'),
    };
  }
  const fetched = await load(comment.version);
  if (!fetched.ok) {
    return { ...comment, resolved: notFound(anchor.kind, fetched.error) };
  }
  const entry = fetched.opened.envelope.entries[0];
  if (
    anchor.kind === 'cell' &&
    deriveRendererClass(fetched.opened.content, entry?.filename ?? '') ===
      'spreadsheet'
  ) {
    return {
      ...comment,
      resolved: await resolveWorkbookCell(fetched.opened.content, anchor),
    };
  }

  const reader = readerForVersion(fetched.opened);
  return {
    ...comment,
    resolved:
      anchor.kind === 'cell' ? reader.cell(anchor) : reader.path(anchor),
  };
}

/**
 * Resolves one subtitle time anchor against the reader the caller passes: the
 * version the comment was written on, or version 1 when it records none.
 */
export function resolveSubtitleTime(
  anchor: Extract<CommentAnchor, { kind: 'time' }>,
  reader: StructuredReader
): TimeCuesResolution {
  return reader.subtitleTime(anchor);
}
