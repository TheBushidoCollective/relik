interface Coordinate {
  readonly row: number;
  readonly column: number;
}
function parts(ref: string): Coordinate | undefined {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref);
  if (!match) return undefined;
  let column = 0;
  for (const c of match[1]!.toUpperCase())
    column = column * 26 + c.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}
function letters(column: number): string {
  let result = '';
  while (column > 0) {
    column--;
    result = String.fromCharCode(65 + (column % 26)) + result;
    column = Math.floor(column / 26);
  }
  return result;
}
/** Shift relative A1 references, leaving quoted formula strings untouched. */
export function translateSharedFormula(
  formula: string,
  from: string,
  to: string
): string {
  const source = parts(from),
    dest = parts(to);
  if (!source || !dest) return formula;
  const dr = dest.row - source.row,
    dc = dest.column - source.column;
  return formula.replace(
    /"(?:[^"]|"")*"|'(?:[^']|'')*'|(?<![A-Za-z0-9_.])\$?[A-Za-z]{1,3}\$?[1-9]\d*(?![A-Za-z0-9_.!(])/g,
    (match) => {
      if (match.startsWith('"') || match.startsWith("'")) return match;
      const parsed = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)$/.exec(match)!;
      const old = parts(match)!;
      const col = old.column + (parsed[1] ? 0 : dc),
        row = old.row + (parsed[3] ? 0 : dr);
      if (col < 1 || col > 16384 || row < 1 || row > 1048576) return '#REF!';
      return `${parsed[1]}${letters(col)}${parsed[3]}${row}`;
    }
  );
}
