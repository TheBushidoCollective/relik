/**
 * The table view for `.csv` and `.tsv` (plan A1). It reads the file's text with
 * the table parser and draws it with the data-table view. A file the parser
 * refuses is shown as its source, with the reason above it.
 */

import {
  parseTable,
  TABLE_BYTE_LIMIT,
  type TableParseFailure,
} from '@relic/format/csv';
import { mountDataTable } from './data-table.ts';
import { csvTableSource } from './table-source.ts';
import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';

/** What a reader is told when the file cannot be shown as a table, by reason. */
export function unreadableTableNotice(failure: TableParseFailure): string {
  switch (failure.reason) {
    case 'empty':
      return 'This file is empty, so there is no table to show. Its text is shown.';
    case 'binary':
      return 'This file holds binary data, not a table, so its text is shown.';
    case 'unclosed-quote':
      return (
        'This file could not be read as a table, so its text is shown. ' +
        `A quote opened on line ${failure.line} is never closed.`
      );
    case 'too-large':
      return failure.limit === 'bytes'
        ? `This table is too large to show as a table, so its text is shown. Tables are drawn up to ${TABLE_BYTE_LIMIT / (1024 * 1024)} MiB.`
        : 'This table is too large to show as a table, so its text is shown.';
  }
}

export function mountView(mount: StructuredMount): StructuredPart | undefined {
  const forcedTab =
    mount.filename.toLowerCase().endsWith('.tsv') ||
    mount.mimetype.toLowerCase().startsWith('text/tab-separated-values');
  // The viewer's TextDecoder already removed the file BOM.
  const parsed = parseTable(mount.source, {
    delimiter: forcedTab ? '\t' : 'auto',
    skipBom: false,
  });
  if (!parsed.ok) {
    mount.reportUnshown(unreadableTableNotice(parsed));
    return undefined;
  }
  return mountDataTable(mount.root, csvTableSource(parsed.table), {
    filename: mount.filename,
  });
}
