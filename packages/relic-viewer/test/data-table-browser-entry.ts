// The one module the headless browser test bundles: the table view and the
// parser it draws from, so the page and the test share one copy of each.
export { mountDataTable } from '../src/data-table.ts';
export { csvTableSource } from '../src/table-source.ts';
export { parseTable } from '@relic/format/csv';
