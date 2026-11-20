import {
  cellText,
  delimiterName,
  isNumericText,
  numericValue,
  type CsvTable,
} from '@relic/format/csv';

export interface CellDetail {
  readonly formula?: string;
  readonly sharedFrom?: string;
  readonly type: 'number' | 'text' | 'date' | 'percent' | 'boolean' | 'error';
}

export interface TableSource {
  readonly records: number;
  readonly columns: number;
  text(record: number, column: number): string;
  numeric(record: number, column: number): number | undefined;
  detail?(record: number, column: number): CellDetail | undefined;
  readonly summary: string;
  readonly sheet?: string;
  readonly csv?: CsvTable;
}

export function csvTableSource(table: CsvTable): TableSource {
  return {
    records: table.records,
    columns: table.columns,
    text: (record, column) => cellText(table, record, column),
    numeric: (record, column) => {
      const value = cellText(table, record, column);
      return isNumericText(value) ? numericValue(value) : undefined;
    },
    summary: delimiterName(table.delimiter),
    csv: table,
  };
}
