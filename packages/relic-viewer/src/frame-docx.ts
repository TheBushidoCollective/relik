import { docxImageSourceDigest } from '@relic/format/image-identity';
import { defaultOptions, type HElement, renderAsync } from 'docx-preview';
import {
  annotateBlocks,
  collectBlocks,
  installHighlightCss,
} from './document-blocks.ts';
import { DocxLimitError, XmlReadBudget } from './document-xml-budget.ts';
import type {
  DocumentBlockSnapshot,
  DocumentInput,
  DocumentRenderHooks,
  DocumentOutcome,
} from './frame-document-protocol.ts';
import { ImageBudget } from './frame-zip-entries.ts';
import type { Anchor, Mark } from './rendered-tree.ts';

const MAX_ELEMENTS = 250_000;
const MAX_PAGES = 2_000;

class DocumentTooLarge extends Error {}

/** Bound allocations while docx-preview constructs its detached page tree. */
export function boundedRenderFactory(
  create: typeof defaultOptions.h = defaultOptions.h,
  maxNodes = MAX_ELEMENTS,
  maxPages = MAX_PAGES
): typeof defaultOptions.h {
  let nodes = 0;
  let pages = 0;
  const count = (value: HElement | Node | string): void => {
    if (typeof value !== 'string') {
      if (typeof Node !== 'undefined' && value instanceof Node) return;
      const element = value as HElement;
      if (
        element.tagName === 'section' &&
        element.className?.split(/\s+/).includes('docx')
      ) {
        pages++;
      }
      if (++nodes > maxNodes || pages > maxPages) throw new DocumentTooLarge();
      for (const child of element.children ?? []) count(child);
    } else if (++nodes > maxNodes) {
      throw new DocumentTooLarge();
    }
  };
  return (value) => {
    count(value);
    return create(value);
  };
}

/** Prevent a missing or externally linked image from starting a request. */
export function guardImageSources(
  onUnavailable?: (image: Element, reason: 'unavailable' | 'decode') => void
): () => void {
  const prototype = HTMLImageElement.prototype;
  const source = Object.getOwnPropertyDescriptor(prototype, 'src');
  const attribute = Object.getOwnPropertyDescriptor(prototype, 'setAttribute');
  if (!source?.set || !source.get) throw new Error('Missing image src setter');
  const setAttribute = prototype.setAttribute;
  const allowed = (value: unknown): value is string =>
    typeof value === 'string' && /^(?:data:|blob:)/i.test(value);
  const observed = new WeakSet<object>();
  const decodedBlobs = new Map<string, Promise<void>>();
  const unavailable = (
    image: HTMLImageElement,
    reason: 'unavailable' | 'decode' = 'unavailable'
  ) => {
    setAttribute.call(image, 'data-relic-image-unavailable', reason);
    onUnavailable?.(image, reason);
  };
  const observe = (image: HTMLImageElement | SVGElement): void => {
    if (observed.has(image) || typeof image.addEventListener !== 'function')
      return;
    observed.add(image);
    image.addEventListener('error', () => {
      if (image instanceof HTMLImageElement) unavailable(image, 'decode');
      else {
        image.setAttribute('data-relic-image-unavailable', 'decode');
        onUnavailable?.(image, 'decode');
      }
    });
    if (image instanceof HTMLImageElement) {
      image.addEventListener('load', () => {
        if (typeof image.decode !== 'function') return;
        const url = image.currentSrc || image.src;
        try {
          let decoded = url.startsWith('blob:')
            ? decodedBlobs.get(url)
            : undefined;
          if (!decoded) {
            decoded = image.decode();
            if (url.startsWith('blob:')) decodedBlobs.set(url, decoded);
          }
          void decoded.catch(() => unavailable(image, 'decode'));
        } catch {
          unavailable(image, 'decode');
        }
      });
    }
  };
  Object.defineProperty(prototype, 'src', {
    ...source,
    set(value: unknown) {
      observe(this as HTMLImageElement);
      if (allowed(value)) source.set!.call(this, value);
      else unavailable(this as HTMLImageElement);
    },
  });
  Object.defineProperty(prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: HTMLImageElement, name: string, value: string) {
      if (name.toLowerCase() === 'src') observe(this);
      if (name.toLowerCase() === 'src' && !allowed(value)) {
        unavailable(this);
      } else {
        setAttribute.call(this, name, value);
      }
    },
  });
  const svgPrototype =
    typeof SVGElement === 'undefined' ? undefined : SVGElement.prototype;
  const svgAttribute =
    svgPrototype &&
    Object.getOwnPropertyDescriptor(svgPrototype, 'setAttribute');
  const svgSetAttribute = svgPrototype?.setAttribute;
  if (svgPrototype && svgSetAttribute) {
    Object.defineProperty(svgPrototype, 'setAttribute', {
      configurable: true,
      writable: true,
      value(this: SVGElement, name: string, value: string) {
        if (this.localName === 'image' && /^(?:href|xlink:href)$/i.test(name))
          observe(this);
        if (
          this.localName === 'image' &&
          /^(?:href|xlink:href)$/i.test(name) &&
          !allowed(value)
        ) {
          svgSetAttribute.call(this, 'data-relic-image-unavailable', '');
          onUnavailable?.(this, 'unavailable');
        } else {
          svgSetAttribute.call(this, name, value);
        }
      },
    });
  }
  return () => {
    Object.defineProperty(prototype, 'src', source);
    if (svgPrototype) {
      if (svgAttribute)
        Object.defineProperty(svgPrototype, 'setAttribute', svgAttribute);
      else Reflect.deleteProperty(svgPrototype, 'setAttribute');
    }
    if (attribute) Object.defineProperty(prototype, 'setAttribute', attribute);
    else Reflect.deleteProperty(prototype, 'setAttribute');
  };
}

export async function render(
  root: HTMLElement,
  input: DocumentInput,
  hooks?: DocumentRenderHooks
): Promise<DocumentOutcome> {
  const budget = new ImageBudget();
  const xmlBudget = new XmlReadBudget();
  let styles: HTMLElement | undefined;
  let omittedMetafile = false;
  let rendered: unknown;
  let ready = false;
  let notice: HTMLElement | undefined;
  const imageNotices = new Set<string>();
  const showImageNotice = (): void => {
    if (!ready || imageNotices.size === 0) return;
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.cssText =
        'position:fixed;bottom:1rem;left:1rem;z-index:2147483647;' +
        'max-width:min(32rem,calc(100vw - 2rem));padding:.5rem .75rem;' +
        'background:#fff;color:#222;border:1px solid #555;font:14px/1.4 sans-serif;';
      root.insertAdjacentElement('afterend', notice);
    }
    notice.textContent = [...imageNotices].join(' ');
  };
  const markImage = (image: Element, message: string): void => {
    image.setAttribute(
      'data-relic-image-unavailable',
      message === 'Image could not be displayed' ? 'decode' : ''
    );
    if (image instanceof HTMLImageElement && !image.getAttribute('alt'))
      image.setAttribute('alt', message);
    else if (
      !(image instanceof HTMLImageElement) &&
      !image.hasAttribute('aria-label')
    )
      image.setAttribute('aria-label', message);
    imageNotices.add(message);
    showImageNotice();
  };
  try {
    styles = document.createElement('div');
    document.head.append(styles);
    const restoreImages = guardImageSources((image, reason) =>
      markImage(
        image,
        reason === 'decode'
          ? 'Image could not be displayed'
          : 'Image not available'
      )
    );
    try {
      const archive = { entries: input.entries, budget, xmlBudget };
      rendered = await renderAsync(archive as unknown as Blob, root, styles, {
        renderAltChunks: false,
        trimXmlDeclaration: false,
        useBase64URL: true,
        h: boundedRenderFactory(),
        renderComments: false,
        renderChanges: false,
        experimental: false,
      });
      omittedMetafile =
        typeof rendered === 'object' &&
        rendered !== null &&
        'relicOmittedMetafile' in rendered &&
        rendered.relicOmittedMetafile === true;
    } finally {
      restoreImages();
    }
    if (budget.reason !== undefined) {
      root.replaceChildren();
      styles.remove();
      return { state: 'failed', reason: budget.reason };
    }
    if (root.getElementsByTagName('*').length > MAX_ELEMENTS) {
      root.replaceChildren();
      styles.remove();
      return { state: 'failed', reason: 'too-large' };
    }
    for (const link of root.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      const hash = href.indexOf('#');
      if (hash >= 0 && href.slice(0, hash) === location.href.split('#')[0]) {
        link.setAttribute('href', href.slice(hash));
      } else if (!/^(?:https?:|mailto:|#)/i.test(href)) {
        link.removeAttribute('href');
      }
    }
    root.addEventListener('click', (event) => {
      const link = (event.target as Element | null)?.closest('a[href^="#"]');
      if (!link || !event.isTrusted) return;
      event.preventDefault();
      const id = link.getAttribute('href')?.slice(1);
      if (id) document.getElementById(id)?.scrollIntoView();
    });
    for (const image of root.querySelectorAll(
      'img[data-relic-image-unavailable]'
    )) {
      markImage(
        image,
        image.getAttribute('data-relic-image-unavailable') === 'decode'
          ? 'Image could not be displayed'
          : 'Image not available'
      );
    }
    for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
      if (
        /^data:image\/(?:x-)?(?:emf|wmf|x-emf|x-wmf)[;,]/i.test(
          image.getAttribute('src') ?? ''
        )
      ) {
        markImage(image, 'Unsupported EMF or WMF image');
      }
      if (image.complete && image.naturalWidth === 0)
        markImage(image, 'Image could not be displayed');
    }
    for (const image of root.querySelectorAll('svg image')) {
      const href =
        image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
      const unavailable = image.hasAttribute('data-relic-image-unavailable');
      if (unavailable || /^data:image\/(?:x-)?(?:emf|wmf)[;,]/i.test(href)) {
        markImage(
          image,
          unavailable
            ? image.getAttribute('data-relic-image-unavailable') === 'decode'
              ? 'Image could not be displayed'
              : 'Image not available'
            : 'Unsupported EMF or WMF image'
        );
      }
    }
    if (xmlBudget.omittedEmbeddedContent || omittedMetafile)
      imageNotices.add('Embedded content was not shown.');
    const fit = () => {
      for (const page of root.querySelectorAll<HTMLElement>(
        '.docx-wrapper > section.docx'
      )) {
        page.style.zoom = '';
        page.style.removeProperty('--relic-page-zoom');
        const width = page.offsetWidth;
        if (width > 0) {
          const zoom = String(
            Math.min(1, Math.max(1, root.clientWidth - 60) / width)
          );
          page.style.zoom = zoom;
          // The current-change outline divides by this, so it stays 3px on screen.
          page.style.setProperty('--relic-page-zoom', zoom);
        }
      }
    };
    fit();
    window.addEventListener('resize', fit, { passive: true });
    if (
      hooks &&
      typeof rendered === 'object' &&
      rendered !== null &&
      'imageUrls' in rendered &&
      rendered.imageUrls instanceof Map
    ) {
      const identities = new Map<string, Promise<string>>();
      await Promise.all(
        [...rendered.imageUrls].map(async ([key, pending]) => {
          if (typeof key !== 'string') return;
          const normalized = key.startsWith('/') ? key.slice(1) : key;
          const name = input.entries.has(normalized)
            ? normalized
            : normalized.replace(/\//g, '\\');
          const bytes = input.entries.get(name);
          if (!bytes) return;
          try {
            const url: unknown = await pending;
            if (typeof url === 'string' && url.startsWith('blob:')) {
              const digest = docxImageSourceDigest(name, bytes);
              // The hook owns the result, but a rejection can precede registration.
              void digest.catch(() => {});
              identities.set(url, digest);
            }
          } catch {
            // A failed image load is reported by its element, not as a
            // failure of the rest of the document.
          }
        })
      );
      hooks.registerImageIdentities(identities);
    } else {
      hooks?.registerImageIdentities(new Map());
    }
    ready = true;
    showImageNotice();
    return { state: 'ready' };
  } catch (error) {
    root.replaceChildren();
    styles?.remove();
    const limited =
      error instanceof DocumentTooLarge ||
      error instanceof DocxLimitError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'RELIC_DOCX_TOO_LARGE');
    return {
      state: 'failed',
      reason: budget.reason ?? (limited ? 'too-large' : 'corrupt'),
    };
  }
}

/** The blocks this page's text is made of, for a comparison. */
export function blocks(root: HTMLElement): DocumentBlockSnapshot | null {
  return collectBlocks(root, 'docx');
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
