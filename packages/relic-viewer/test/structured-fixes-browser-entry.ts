// The browser bundle for structured-fixes-browser.test.ts. It re-exports what
// the page drives: nothing else is shipped to the page.
export { mountDataTable } from '../src/data-table.ts';
export { mountView as mountJsonTree } from '../src/json-tree-view.ts';
export { parseTable } from '@relic/format/csv';
