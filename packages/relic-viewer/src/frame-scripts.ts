/**
 * Author scripts under the shim's policy.
 *
 * The shim's policy has no `'unsafe-inline'` in `script-src`, so an inline
 * `<script>` in author markup would be refused. Each script that executes is
 * moved to a `blob:` URL and written back in place, so the policy's `blob:`
 * source admits it. The script keeps its text, so `document.currentScript` and
 * its `textContent` read the same as before.
 *
 * What is converted, and what is not:
 * - A classic script (no `type`, an empty `type`, or a JavaScript MIME type)
 *   loses `async` and `defer`. An inline classic script ignores both and runs
 *   where it sits, so the blob keeps that timing.
 * - A `type="module"` script keeps its attributes. An inline module already
 *   defers, and `async` on it means the same for a blob.
 * - An SVG `<script>` takes `href`, not `src`, because that is the attribute an
 *   SVG script loads from. Only classic SVG scripts run, as in the browser.
 * - A script that already names an external source is left alone. The policy
 *   refuses it, as it did before.
 * - Any other `type` (a data block, an import map) never executed, and is left
 *   as it is.
 *
 * The markup is parsed into an inert document and serialized back. That is
 * the only way to rewrite a script's source before it is parsed in the live
 * document, and the caller writes the result with `document.write` in the
 * same place it wrote the raw markup. Scripts inside `<template>` are not
 * reached, so they keep their inline text and run only if a script inserts
 * them, which the policy now refuses.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The classic script MIME types the HTML standard lists. */
const CLASSIC_TYPES: Record<string, true> = {
  'application/ecmascript': true,
  'application/javascript': true,
  'application/x-ecmascript': true,
  'application/x-javascript': true,
  'text/ecmascript': true,
  'text/javascript': true,
  'text/javascript1.0': true,
  'text/javascript1.1': true,
  'text/javascript1.2': true,
  'text/javascript1.3': true,
  'text/javascript1.4': true,
  'text/javascript1.5': true,
  'text/jscript': true,
  'text/livescript': true,
  'text/x-ecmascript': true,
  'text/x-javascript': true,
};

export function objectUrlFor(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

export function reemitAuthorScripts(
  markup: string,
  blobUrl: (code: string) => string = objectUrlFor
): string {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const svg = script.namespaceURI === SVG_NS;
    const external = svg
      ? script.hasAttribute('href') || script.hasAttribute('xlink:href')
      : script.hasAttribute('src');
    if (external) continue;

    const type =
      (script.getAttribute('type') ?? '').trim().toLowerCase().split(';')[0] ??
      '';
    const classic = type === '' || CLASSIC_TYPES[type] === true;
    const module = !svg && type === 'module';
    if (!classic && !module) continue;

    if (classic) {
      script.removeAttribute('async');
      script.removeAttribute('defer');
    }
    script.setAttribute(
      svg ? 'href' : 'src',
      blobUrl(script.textContent ?? '')
    );
  }

  const doctype = doc.doctype
    ? new XMLSerializer().serializeToString(doc.doctype)
    : '';
  return doctype + doc.documentElement.outerHTML;
}
