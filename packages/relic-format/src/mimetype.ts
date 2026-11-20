/**
 * The declared mimetype a publishing client writes into the envelope header.
 *
 * It lives here rather than in either client because the two publishers, the
 * local MCP server and the web page, must agree on it: a component's `.jsx`
 * declaring `text/jsx` from one and `text/javascript` from the other would
 * render as source or as a component depending on which door the file came in
 * by.
 */

import { modelFormatFromFilename } from './model.ts';
import type { RendererClass } from './renderer-class.ts';

const MIMETYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ipynb: 'application/x-ipynb+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  gz: 'application/gzip',
  pdf: 'application/pdf',
  // Component source declares what it is. text/plain or text/javascript
  // would both read as `code` on the far side and the relic would render
  // as escaped source, silently, which is the one outcome a component
  // author would never guess had happened.
  jsx: 'text/jsx',
  tsx: 'text/tsx',
};

const CLASS_FALLBACK: Readonly<Record<RendererClass, string>> = {
  markdown: 'text/markdown',
  code: 'text/plain',
  html: 'text/html',
  jsx: 'text/jsx',
  notebook: 'application/x-ipynb+json',
  // Declared precisely rather than as octet-stream, unlike the other binary
  // formats below it. The viewer routes a pdf to a renderer, and the sniffed
  // and declared classes are reconciled by taking the least privileged of the
  // two, so an octet-stream fallback here would demote a real PDF to a
  // download whenever the publishing client could not read an extension.
  pdf: 'application/pdf',
  image: 'application/octet-stream',
  media: 'application/octet-stream',
  model: 'application/octet-stream',
  otio: 'application/x-otioz',
  archive: 'application/octet-stream',
  binary: 'application/octet-stream',
};

/**
 * The declared mimetype for the envelope header.
 *
 * It is untrusted display text on the far side, and the viewer treats a
 * disagreement between it and the sniffed type by routing to the least
 * privileged path either would allow.
 */
export function guessMimetype(
  filename: string,
  rendererClass: RendererClass
): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase();
  const modelFormat = modelFormatFromFilename(base);
  if (modelFormat !== undefined) return `model/${modelFormat}`;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) {
    const found = MIMETYPES[base.slice(dot + 1)];
    if (found !== undefined) return found;
  }
  return CLASS_FALLBACK[rendererClass];
}
