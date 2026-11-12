/**
 * The element the viewer renders into: the shell's `#relic-root` when the page
 * has one, and the page body when it does not, as a page without the shell
 * always has been.
 *
 * A render fills this element and never removes it from the page, so a mount
 * that runs after a render asks for it again rather than keeping a reference
 * across the render. The root is the one the server's shell puts in the page,
 * so the body branch is only taken by documents the server did not produce.
 */
export function shellRoot(): HTMLElement {
  return document.getElementById('relic-root') ?? document.body;
}
