import { resolveEpubPath } from '../../relic-format/src/epub-package.ts';
import {
  epubCss,
  epubDataUrl,
  scopeEpubCss,
  type EpubResources,
} from './epub-css.ts';

const HTML_TAGS = new Set(
  'html body a abbr address article aside audio b blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p picture pre q rp rt ruby s samp section small source span strong sub summary sup table tbody td tfoot th thead time tr u ul var video'.split(
    ' '
  )
);
const SVG_TAGS = new Set(
  'svg g path rect circle ellipse line polyline polygon image text tspan defs clipPath mask linearGradient radialGradient stop use title desc'
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
const MEDIA_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);
const SAFE_ATTR = new Set(
  'alt title lang dir class width height colspan rowspan scope start reversed value open role aria-label aria-hidden viewbox d x y x1 x2 y1 y2 cx cy r rx ry points fill stroke stroke-width clip-path mask filter opacity transform preserveaspectratio xmlns display mathvariant'.split(
    ' '
  )
);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

const MAX_GRADIENT_TRANSFORM_LENGTH = 4096;
const GRADIENT_TRANSFORMS = new Set([
  'matrix',
  'translate',
  'scale',
  'rotate',
  'skewx',
  'skewy',
]);

/** Check static SVG transform lists with bounded, single-pass scanning. */
function isGradientTransform(value: string): boolean {
  if (value.length > MAX_GRADIENT_TRANSFORM_LENGTH) return false;
  const input = value.trim();
  if (input === 'none') return true;
  let at = 0;
  let found = false;
  const skipSpace = () => {
    while (at < input.length && /\s/.test(input[at]!)) at++;
  };
  while (at < input.length) {
    skipSpace();
    if (found && input[at] === ',') {
      at++;
      skipSpace();
    }
    const start = at;
    while (at < input.length && /[a-z]/i.test(input[at]!)) at++;
    if (!GRADIENT_TRANSFORMS.has(input.slice(start, at).toLowerCase()))
      return false;
    skipSpace();
    if (input[at++] !== '(') return false;
    let digit = false;
    while (at < input.length && input[at] !== ')') {
      const char = input[at++]!;
      if (/[0-9]/.test(char)) digit = true;
      else if (!/[,\s.eE+-]/.test(char)) return false;
    }
    if (!digit || input[at++] !== ')') return false;
    found = true;
    skipSpace();
  }
  return found;
}

export interface EpubSanitizeContext {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly resources: EpubResources;
  readonly path: string;
  readonly chapter: number;
  readonly chapterByPath: ReadonlyMap<string, number>;
  readonly blobs: string[];
  readonly isolatedSvg?: boolean;
  readonly budget: { nodes: number };
}
export function epubAnchor(chapter: number, id: string): string {
  return `ep-${chapter}-${id}`;
}

export function sanitizeEpubChapter(
  source: string,
  ctx: EpubSanitizeContext
): HTMLElement {
  let openings = 0;
  for (
    let at = source.indexOf('<');
    at !== -1;
    at = source.indexOf('<', at + 1)
  ) {
    if (++openings > 300000) throw new Error('EPUB element limit exceeded');
  }
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
  let pageWidth = Number(width?.[1]);
  let pageHeight = Number(height?.[1]);
  const svgRoot = parsed.documentElement;
  if (svgRoot?.namespaceURI === SVG_NS && svgRoot.localName === 'svg') {
    const pixels = (value: string | null): number => {
      if (
        !value ||
        !/^\s*(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px)?\s*$/i.test(value)
      )
        return 0;
      return Number.parseFloat(value);
    };
    pageWidth = pixels(svgRoot.getAttribute('width'));
    pageHeight = pixels(svgRoot.getAttribute('height'));
    const viewBox = (svgRoot.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      viewBox.length === 4 &&
      viewBox.every(Number.isFinite) &&
      viewBox[2]! > 0 &&
      viewBox[3]! > 0
    ) {
      if (pageWidth > 0 && !(pageHeight > 0))
        pageHeight = (pageWidth * viewBox[3]!) / viewBox[2]!;
      else if (pageHeight > 0 && !(pageWidth > 0))
        pageWidth = (pageHeight * viewBox[2]!) / viewBox[3]!;
      else if (!(pageWidth > 0) && !(pageHeight > 0)) {
        pageWidth = viewBox[2]!;
        pageHeight = viewBox[3]!;
      }
    }
  }
  if (
    Number.isFinite(pageWidth) &&
    Number.isFinite(pageHeight) &&
    pageWidth > 0 &&
    pageHeight > 0
  ) {
    output.dataset.epubViewportWidth = String(pageWidth);
    output.dataset.epubViewportHeight = String(pageHeight);
  }
  const process = (node: Node, parent: Node): void => {
    if (++ctx.budget.nodes > 1500000)
      throw new Error('EPUB element limit exceeded');
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.nodeValue ?? ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const input = node as Element;
    const tag = input.localName.toLowerCase();
    if (tag === 'head') {
      for (const child of Array.from(input.children)) {
        const name = child.localName.toLowerCase();
        if (name === 'style' || name === 'link') process(child, parent);
      }
      return;
    }
    if (tag === 'style') {
      const style =
        input.namespaceURI === SVG_NS
          ? document.createElementNS(SVG_NS, 'style')
          : document.createElement('style');
      const media = input.getAttribute('media');
      if (media !== null) style.setAttribute('media', media);
      style.textContent = scopeEpubCss(
        epubCss(
          ctx.resources,
          ctx.path,
          input.textContent ?? '',
          ctx.chapter,
          true
        ),
        ctx.chapter,
        ctx.isolatedSvg,
        ctx.resources,
        media?.trim() ?? ''
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
        if (
          target &&
          bytes &&
          ctx.resources.mediaTypes.get(target.path) === 'text/css'
        ) {
          const style = document.createElement('style');
          const media = input.getAttribute('media');
          if (media !== null) style.setAttribute('media', media);
          style.textContent = scopeEpubCss(
            epubCss(
              ctx.resources,
              target.path,
              new TextDecoder().decode(bytes),
              ctx.chapter,
              true
            ),
            ctx.chapter,
            ctx.isolatedSvg,
            ctx.resources,
            media?.trim() ?? ''
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
      const id = input.getAttribute('id');
      if (id) {
        const anchor = document.createElement('span');
        anchor.id = epubAnchor(ctx.chapter, id);
        parent.appendChild(anchor);
      }
      for (const child of Array.from(input.childNodes)) process(child, parent);
      return;
    }
    const el = svg
      ? document.createElementNS(SVG_NS, input.localName)
      : math
        ? document.createElementNS(MATH_NS, input.localName)
        : document.createElement(tag);
    if (input === parsed.documentElement) el.setAttribute('data-epub-root', '');
    for (const attr of Array.from(input.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'id' && attr.value)
        el.setAttribute('id', epubAnchor(ctx.chapter, attr.value));
      else if (name === 'style')
        el.setAttribute(
          'style',
          epubCss(ctx.resources, ctx.path, attr.value, ctx.chapter)
        );
      else if (
        svg &&
        ['fill', 'stroke', 'clip-path', 'mask', 'filter'].includes(name) &&
        /^url\(\s*#[A-Za-z0-9_.:-]+\s*\)$/.test(attr.value)
      ) {
        const fragment = /^url\(\s*#([A-Za-z0-9_.:-]+)\s*\)$/.exec(
          attr.value
        )![1]!;
        el.setAttribute(
          attr.name,
          `url(#${epubAnchor(ctx.chapter, fragment)})`
        );
      } else if (svg && tag === 'stop' && name === 'offset') {
        const value = attr.value.trim();
        if (
          /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value) &&
          Number.isFinite(Number.parseFloat(value))
        )
          el.setAttribute(attr.name, value);
      } else if (
        svg &&
        tag === 'stop' &&
        ((name === 'stop-color' && CSS.supports('color', attr.value)) ||
          (name === 'stop-opacity' && CSS.supports('opacity', attr.value)))
      ) {
        el.setAttribute(attr.name, attr.value);
      } else if (
        svg &&
        (tag === 'lineargradient' || tag === 'radialgradient') &&
        name === 'gradientunits'
      ) {
        if (/^(?:userSpaceOnUse|objectBoundingBox)$/.test(attr.value))
          el.setAttribute(attr.name, attr.value);
      } else if (
        svg &&
        (tag === 'lineargradient' || tag === 'radialgradient') &&
        name === 'spreadmethod'
      ) {
        if (/^(?:pad|reflect|repeat)$/.test(attr.value))
          el.setAttribute(attr.name, attr.value);
      } else if (
        svg &&
        (tag === 'lineargradient' || tag === 'radialgradient') &&
        name === 'gradienttransform'
      ) {
        if (isGradientTransform(attr.value))
          el.setAttribute(attr.name, attr.value.trim());
      } else if (
        svg &&
        tag === 'radialgradient' &&
        ['fx', 'fy', 'fr'].includes(name) &&
        !/url\s*\(/i.test(attr.value)
      ) {
        el.setAttribute(attr.name, attr.value);
      } else if (SAFE_ATTR.has(name) && !/url\s*\(/i.test(attr.value))
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
    } else if (
      svg &&
      (tag === 'use' || tag === 'lineargradient' || tag === 'radialgradient')
    ) {
      const href =
        input.getAttribute('href') ?? input.getAttribute('xlink:href') ?? '';
      if (href.startsWith('#'))
        el.setAttribute('href', `#${epubAnchor(ctx.chapter, href.slice(1))}`);
    } else if (tag === 'img' || (svg && tag === 'image')) {
      if (tag === 'img') el.setAttribute('loading', 'lazy');
      const href =
        input.getAttribute('src') ??
        input.getAttribute('href') ??
        input.getAttribute('xlink:href') ??
        '';
      const src = epubDataUrl(ctx.resources, ctx.path, href, 'image');
      if (src) {
        el.setAttribute(svg ? 'href' : 'src', src);
      } else {
        const target = resolveEpubPath(ctx.path, href);
        if (target && ctx.resources.omittedImagePaths?.has(target.path)) {
          const description = (
            input.getAttribute('alt') ??
            input.getAttribute('aria-label') ??
            ''
          ).trim();
          const message = `Image unavailable (reader size limit).${description ? ` ${description}` : ''}`;
          const placeholder = svg
            ? document.createElementNS(SVG_NS, 'g')
            : document.createElement('span');
          placeholder.setAttribute('class', 'epub-image-unavailable');
          placeholder.setAttribute('data-epub-image-unavailable', '');
          placeholder.setAttribute('role', 'img');
          placeholder.setAttribute('aria-label', message);
          const id = el.getAttribute('id');
          if (id) placeholder.setAttribute('id', id);
          if (svg) {
            const rect = document.createElementNS(SVG_NS, 'rect');
            for (const [name, fallback] of [
              ['x', '0'],
              ['y', '0'],
              ['width', '160'],
              ['height', '40'],
            ] as const)
              rect.setAttribute(name, el.getAttribute(name) ?? fallback);
            rect.setAttribute('fill', '#eee');
            rect.setAttribute('stroke', '#555');
            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('x', el.getAttribute('x') ?? '0');
            text.setAttribute('y', el.getAttribute('y') ?? '0');
            text.setAttribute('dx', '4');
            text.setAttribute('dy', '1em');
            text.setAttribute('font-size', '12');
            text.setAttribute('fill', '#333');
            text.textContent = message;
            placeholder.append(rect, text);
          } else {
            placeholder.textContent = message;
          }
          parent.appendChild(placeholder);
          return;
        }
      }
    } else if (tag === 'audio' || tag === 'video' || tag === 'source') {
      if (tag !== 'source') el.setAttribute('controls', '');
      const target = resolveEpubPath(ctx.path, input.getAttribute('src') ?? '');
      const bytes = target && ctx.entries.get(target.path);
      const mime = target && ctx.resources.mediaTypes.get(target.path);
      if (target && bytes && mime && MEDIA_TYPES.has(mime)) {
        let url = ctx.resources.mediaUrls.get(target.path);
        if (!url) {
          ctx.resources.encodedBytes += bytes.length;
          if (ctx.resources.encodedBytes > 64 * 1024 * 1024)
            throw new Error('EPUB resource limit exceeded');
          url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: mime })
          );
          ctx.resources.mediaUrls.set(target.path, url);
          ctx.blobs.push(url);
        }
        el.setAttribute('src', url);
      }
    }
    parent.appendChild(el);
    for (const child of Array.from(input.childNodes)) process(child, el);
  };
  process(parsed.documentElement, output);
  return output;
}
