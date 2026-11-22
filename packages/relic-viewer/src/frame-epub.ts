import { epubRenderOrder } from '../../relic-format/src/epub-package.ts';
import { decodeXmlBytes } from '../../relic-format/src/xml.ts';
import {
  annotateBlocks,
  collectBlocks,
  installHighlightCss,
} from './document-blocks.ts';
import type { EpubResources } from './epub-css.ts';
import { mountEpubChrome } from './epub-chrome.ts';
import { sanitizeEpubChapter } from './epub-sanitize.ts';
import type {
  DocumentBlockSnapshot,
  DocumentInput,
  DocumentOutcome,
} from './frame-document-protocol.ts';
import type { Anchor, Mark } from './rendered-tree.ts';

export async function render(
  root: HTMLElement,
  input: DocumentInput
): Promise<DocumentOutcome> {
  const book = input.book;
  if (!book) return { state: 'failed', reason: 'corrupt' };
  const blobs: string[] = [];
  try {
    const spine = epubRenderOrder(book);
    const chapters = new Map<string, number>();
    for (const [index, item] of spine.entries())
      if (!chapters.has(item.path)) chapters.set(item.path, index);
    const mediaTypes = new Map(
      book.resources.map((item) => [item.path, item.mediaType])
    );
    if (mediaTypes.size !== book.resources.length)
      return { state: 'failed', reason: 'corrupt' };
    let chapterBytes = 0;
    for (const item of spine) {
      const bytes = input.entries.get(item.path);
      const type = mediaTypes.get(item.path);
      if (!bytes || !type) return { state: 'failed', reason: 'corrupt' };
      if (
        !['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(type)
      )
        return { state: 'failed', reason: 'unsupported' };
      chapterBytes += bytes.length;
      if (bytes.length > 16 * 1024 * 1024 || chapterBytes > 64 * 1024 * 1024)
        return { state: 'failed', reason: 'too-large' };
    }
    const resources: EpubResources = {
      entries: input.entries,
      mediaTypes,
      dataUrls: new Map<string, string>(),
      mediaUrls: new Map<string, string>(),
      encodedBytes: 0,
      referencedBytes: 0,
      cssBytes: 0,
    };
    const context = {
      entries: input.entries,
      resources,
      path: '',
      chapter: 0,
      chapterByPath: chapters,
      blobs,
      budget: { nodes: 0 },
    };
    const activeSvg = new Set<string>();
    resources.svgDataUrl = (path) => {
      if (activeSvg.has(path)) throw new Error('Cyclic EPUB SVG resource');
      const bytes = input.entries.get(path);
      if (!bytes || resources.mediaTypes.get(path) !== 'image/svg+xml')
        return undefined;
      activeSvg.add(path);
      try {
        const isolated = { ...context, path, chapter: 0, isolatedSvg: true };
        const container = sanitizeEpubChapter(decodeXmlBytes(bytes), isolated);
        const svg = container.firstElementChild;
        if (
          !svg ||
          svg.localName.toLowerCase() !== 'svg' ||
          svg.namespaceURI !== 'http://www.w3.org/2000/svg'
        )
          throw new Error('Invalid EPUB SVG resource');
        const serialized = new TextEncoder().encode(
          new XMLSerializer().serializeToString(svg)
        );
        if (
          serialized.length > 16 * 1024 * 1024 ||
          resources.encodedBytes + 4 * Math.ceil(serialized.length / 3) >
            64 * 1024 * 1024
        )
          throw new Error('EPUB resource limit exceeded');
        let binary = '';
        for (let at = 0; at < serialized.length; at += 8192)
          binary += String.fromCharCode(...serialized.subarray(at, at + 8192));
        return `data:image/svg+xml;base64,${btoa(binary)}`;
      } finally {
        activeSvg.delete(path);
      }
    };
    const style = document.createElement('style');
    style.textContent =
      '#relic-document{position:relative;isolation:isolate;z-index:0;max-width:52rem;margin:0 auto;padding:1.5rem 1.5rem 5rem;overflow-wrap:anywhere}#relic-document img,#relic-document video{max-width:100%;height:auto}#relic-document span.epub-image-unavailable{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:10rem;min-height:3rem;max-width:100%;padding:.5rem;border:1px solid #777;background:#eee;color:#222;font:14px/1.4 system-ui;text-align:center}.epub-footnote{position:fixed;z-index:2147482999;bottom:4rem;right:1rem;max-width:min(32rem,80vw);max-height:45vh;overflow:auto;padding:1rem;background:white;border:1px solid #999;box-shadow:0 4px 12px #0003}';
    document.head.append(style);
    for (let index = 0; index < spine.length; index++) {
      const part = spine[index]!;
      const bytes = input.entries.get(part.path);
      if (!bytes) return { state: 'failed', reason: 'corrupt' };
      context.path = part.path;
      context.chapter = index;
      const article = sanitizeEpubChapter(decodeXmlBytes(bytes), context);
      root.append(article);
    }
    if (resources.omittedImages) {
      const warning = document.createElement('p');
      warning.setAttribute('role', 'status');
      warning.textContent =
        'Some images exceed the reader size limit. Download the original to view them.';
      root.prepend(warning);
    }
    if (book.progression !== 'default') root.dir = book.progression;
    if (book.layout === 'pre-paginated') {
      const resize = () => {
        const rootStyle = getComputedStyle(root);
        const availableWidth =
          root.clientWidth -
          Number.parseFloat(rootStyle.paddingLeft || '0') -
          Number.parseFloat(rootStyle.paddingRight || '0');
        for (const article of root.querySelectorAll<HTMLElement>(
          'article[data-epub-chapter]'
        )) {
          const width = Number(article.dataset.epubViewportWidth);
          const height = Number(article.dataset.epubViewportHeight);
          if (width > 0 && height > 0 && availableWidth > 0) {
            article.style.width = `${width}px`;
            article.style.height = `${height}px`;
            article.style.zoom = String(availableWidth / width);
          }
        }
      };
      resize();
      addEventListener('resize', resize);
    }
    const showFootnote = mountEpubChrome(
      root,
      book,
      chapters,
      input.requestExternalLink
    );
    root.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('a[href^="#ep-"]');
        if (!link) return;
        event.preventDefault();
        const id = link.getAttribute('href')?.slice(1);
        const dest =
          id &&
          (document.getElementById(id) ??
            document.getElementById(id.replace(/^(ep-\d+-).*$/, '$1')));
        if (!dest) return;
        if (link.hasAttribute('data-epub-noteref')) showFootnote(dest);
        else dest.scrollIntoView();
      },
      true
    );
    addEventListener(
      'pagehide',
      () => {
        for (const url of blobs) URL.revokeObjectURL(url);
      },
      { once: true }
    );
    return { state: 'ready' };
  } catch (error) {
    for (const url of blobs) URL.revokeObjectURL(url);
    return {
      state: 'failed',
      reason:
        error instanceof Error && error.message.includes('limit')
          ? 'too-large'
          : error instanceof Error && error.message.startsWith('Unsupported')
            ? 'unsupported'
            : 'corrupt',
    };
  }
}

/** The blocks of this book's chapters, for a comparison. */
export function blocks(root: HTMLElement): DocumentBlockSnapshot | null {
  return collectBlocks(root, 'epub');
}

/** Installs the outline rules, then marks the blocks by index. */
export function annotate(
  snapshot: DocumentBlockSnapshot,
  marks: readonly Mark[],
  anchors: readonly Anchor[]
): number {
  installHighlightCss(document);
  return annotateBlocks(snapshot, marks, anchors);
}
