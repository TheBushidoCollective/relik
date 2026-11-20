/**
 * Whether a drag carries files, as opposed to text, a link, or a page element.
 *
 * Shared by the page's drop handler and the sandbox shim's drag signal, which
 * must agree on it exactly: a drag one of them takes and the other ignores is
 * a file dropped on a relic that goes nowhere.
 */
export function isFileDrag(
  types: ArrayLike<string> | null | undefined
): boolean {
  return (
    types !== null && types !== undefined && Array.from(types).includes('Files')
  );
}
