export type NumberKind = 'number' | 'date' | 'percent';

const DATE_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Classify the subset of Excel formats the viewer supports. */
export function numberKind(id: number, format?: string): NumberKind {
  if (DATE_IDS.has(id)) return 'date';
  if (id === 9 || id === 10) return 'percent';
  if (!format) return 'number';
  const stripped = format
    .replace(/"[^"]*"|\\.|_.|\*./g, '')
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '');
  if (/[ymdhis]/i.test(stripped)) return 'date';
  return stripped.includes('%') ? 'percent' : 'number';
}

/** Serial 60 represents Excel's fictitious 1900-02-29, kept as displayed. */
export function displayDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);
  const day = Math.floor(serial);
  const fraction = serial - day;
  if (!date1904 && day === 60) return `1900-02-29${timePart(fraction)}`;
  const origin = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjusted = !date1904 && day > 60 ? day - 1 : day;
  const date = new Date(origin + adjusted * 86400000);
  if (!Number.isFinite(date.valueOf())) return String(serial);
  return `${date.toISOString().slice(0, 10)}${timePart(fraction)}`;
}
function timePart(fraction: number): string {
  if (!fraction) return '';
  const seconds = Math.round(fraction * 86400) % 86400;
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return ` ${hh}:${mm}:${ss}`;
}
export function displayNumber(
  value: number,
  kind: NumberKind,
  date1904: boolean
): string {
  if (kind === 'date') return displayDate(value, date1904);
  if (kind === 'percent') return `${Number((value * 100).toPrecision(12))}%`;
  return String(value);
}
