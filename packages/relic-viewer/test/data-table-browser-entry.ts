// The one module the headless browser tests bundle: the table view with its
// compare grid, the scroll mirror, and the parser they draw from, so the page
// and the test share one copy of each.
export { mountCompareTable, mountDataTable } from '../src/data-table.ts';
export { mirrorScrollers } from '../src/scroll-sync.ts';
export { csvTableSource } from '../src/table-source.ts';
export { parseTable } from '@relic/format/csv';
