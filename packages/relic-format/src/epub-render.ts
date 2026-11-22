/**
 * What the EPUB frame shows, in one place. The viewer's sanitizer and the MCP's
 * text search both read these, so a quote is only searched in text a reader can
 * see.
 */

/** Elements the sanitizer removes together with everything inside them. */
const DROPPED_ELEMENTS = new Set([
  'script',
  'style',
  'iframe',
  'embed',
  'portal',
  'frame',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'meta',
  'base',
  'link',
  'foreignobject',
  'animate',
  'set',
]);

/** Whether the frame removes an element, and its content, before anything is shown. */
export function isDroppedEpubElement(localName: string): boolean {
  return DROPPED_ELEMENTS.has(localName.toLowerCase());
}

/**
 * The content types the frame renders as chapters. The frame refuses an ebook
 * whose spine holds any other type, and so does the text search, so none of its
 * text is shown or searched.
 */
export const RENDERED_EPUB_MEDIA: ReadonlySet<string> = new Set([
  'application/xhtml+xml',
  'text/html',
  'image/svg+xml',
]);
