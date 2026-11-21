import { resolveEpubPath } from '../../relic-format/src/epub-package.ts';
import { epubCss, epubDataUrl } from './epub-css.ts';

const HTML_TAGS = new Set(
  'a abbr address article aside audio b blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p picture pre q rp rt ruby s samp section small source span strong sub summary sup table tbody td tfoot th thead time tr u ul var video'.split(
    ' '
  )
);
const SVG_TAGS = new Set(
  'svg g path rect circle ellipse line polyline polygon text tspan defs clipPath mask linearGradient radialGradient stop use title desc'
    .toLowerCase()
    .split(' ')
);
const MATH_TAGS = new Set(
  'math mrow mi mn mo mtext mspace ms mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mtable mtr mtd semantics annotation'.split(
    ' '
  )
);
const DROP = new Set(
  'script style iframe embed portal frame form input button select textarea meta base link foreignobject animate set'.split(
    ' '
  )
);
const MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
const SAFE_ATTR = new Set(
  'alt title lang dir class width height colspan rowspan scope start reversed value open role aria-label aria-hidden viewbox d x y x1 x2 y1 y2 cx cy r rx ry points fill stroke stroke-width opacity transform preserveaspectratio xmlns display mathvariant'.split(
    ' '
  )
);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

export interface EpubSanitizeContext {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly path: string;
  readonly chapter: number;
  readonly chapterByPath: ReadonlyMap<string, number>;
  readonly blobs: string[];
  count: number;
}
export function epubAnchor(chapter: number, id: string): string {
  return `ep-${chapter}-${id}`;
}

export function sanitizeEpubChapter(
  source: string,
  ctx: EpubSanitizeContext
): HTMLElement {
  const parser = new DOMParser();
  let parsed = parser.parseFromString(source, 'application/xhtml+xml');
  if (parsed.querySelector('parsererror'))
    parsed = parser.parseFromString(source, 'text/html');
  const output = document.createElement('article');
  output.id = epubAnchor(ctx.chapter, '');
  output.dataset.epubChapter = String(ctx.chapter);
  const viewport =
    parsed.querySelector('meta[name="viewport"]')?.getAttribute('content') ??
    '';
  const width = /(?:^|,)\s*width\s*=\s*(\d+(?:\.\d+)?)/i.exec(viewport);
  const height = /(?:^|,)\s*height\s*=\s*(\d+(?:\.\d+)?)/i.exec(viewport);
  if (width && height && Number(width[1]) > 0 && Number(height[1]) > 0) {
    output.dataset.epubViewportWidth = width[1];
    output.dataset.epubViewportHeight = height[1];
  }
  const process = (node: Node, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.nodeValue ?? ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const input = node as Element;
    const tag = input.localName.toLowerCase();
    if (tag === 'style') {
      const style = document.createElement('style');
      style.textContent = epubCss(
        ctx.entries,
        ctx.path,
        input.textContent ?? ''
      );
      parent.appendChild(style);
      return;
    }
    if (tag === 'link') {
      if (
        (input.getAttribute('rel') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .includes('stylesheet')
      ) {
        const target = resolveEpubPath(
          ctx.path,
          input.getAttribute('href') ?? ''
        );
        const bytes = target && ctx.entries.get(target.path);
        if (target && bytes) {
          const style = document.createElement('style');
          style.textContent = epubCss(
            ctx.entries,
            target.path,
            new TextDecoder().decode(bytes)
          );
          parent.appendChild(style);
        }
      }
      return;
    }
    if (DROP.has(tag)) return;
    const svg = input.namespaceURI === SVG_NS || tag === 'svg';
    const math = input.namespaceURI === MATH_NS || tag === 'math';
    if (!(svg ? SVG_TAGS : math ? MATH_TAGS : HTML_TAGS).has(tag)) {
      if (tag === 'maction') {
        const first = input.firstElementChild;
        if (first) process(first, parent);
        return;
      }
      for (const child of Array.from(input.childNodes)) process(child, parent);
      return;
    }
    if (++ctx.count > 1500000) throw new Error('EPUB element limit exceeded');
    const el = svg
      ? document.createElementNS(SVG_NS, input.localName)
      : math
        ? document.createElementNS(MATH_NS, input.localName)
        : document.createElement(tag);
    for (const attr of Array.from(input.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'id' && attr.value)
        el.setAttribute('id', epubAnchor(ctx.chapter, attr.value));
      else if (name === 'style')
        el.setAttribute('style', epubCss(ctx.entries, ctx.path, attr.value));
      else if (SAFE_ATTR.has(name) && !/url\s*\(/i.test(attr.value))
        el.setAttribute(attr.name, attr.value);
    }
    if (tag === 'a') {
      const href = input.getAttribute('href') ?? '';
      const target = resolveEpubPath(ctx.path, href);
      const chapter = target && ctx.chapterByPath.get(target.path);
      if (target && chapter !== undefined) {
        el.setAttribute(
          'href',
          `#${epubAnchor(chapter, target.fragment ?? '')}`
        );
        const epubType =
          input.getAttribute('epub:type') ?? input.getAttribute('role') ?? '';
        if (/\b(?:noteref|doc-noteref)\b/.test(epubType))
          el.setAttribute('data-epub-noteref', '');
      } else if (/^(?:https?:|mailto:)/i.test(href))
        el.setAttribute('href', href);
    } else if (tag === 'use') {
      const href =
        input.getAttribute('href') ?? input.getAttribute('xlink:href') ?? '';
      if (href.startsWith('#'))
        el.setAttribute('href', `#${epubAnchor(ctx.chapter, href.slice(1))}`);
    } else if (tag === 'img') {
      const src = epubDataUrl(
        ctx.entries,
        ctx.path,
        input.getAttribute('src') ?? ''
      );
      if (src) el.setAttribute('src', src);
    } else if (tag === 'audio' || tag === 'video' || tag === 'source') {
      if (tag !== 'source') el.setAttribute('controls', '');
      const target = resolveEpubPath(ctx.path, input.getAttribute('src') ?? '');
      const bytes = target && ctx.entries.get(target.path);
      const extension = target?.path.split('.').pop()?.toLowerCase() ?? '';
      const mime = MEDIA_TYPES[extension];
      if (target && bytes && mime) {
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: mime })
        );
        ctx.blobs.push(url);
        el.setAttribute('src', url);
      }
    }
    parent.appendChild(el);
    for (const child of Array.from(input.childNodes)) process(child, el);
  };
  const head = parsed.querySelector('head');
  if (head) {
    for (const child of Array.from(head.children)) {
      if (
        child.localName.toLowerCase() === 'style' ||
        child.localName.toLowerCase() === 'link'
      )
        process(child, output);
    }
  }
  const body = parsed.querySelector('body');
  if (body)
    for (const child of Array.from(body.childNodes)) process(child, output);
  else
    for (const child of Array.from(parsed.documentElement.childNodes))
      process(child, output);
  return output;
}
