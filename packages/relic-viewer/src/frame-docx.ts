import { defaultOptions, type HElement, renderAsync } from 'docx-preview';
import type {
  DocumentInput,
  DocumentOutcome,
} from './frame-document-protocol.ts';
import { ImageBudget } from './frame-zip-entries.ts';

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
export function guardImageSources(): () => void {
  const prototype = HTMLImageElement.prototype;
  const source = Object.getOwnPropertyDescriptor(prototype, 'src');
  const attribute = Object.getOwnPropertyDescriptor(prototype, 'setAttribute');
  if (!source?.set || !source.get) throw new Error('Missing image src setter');
  const setAttribute = prototype.setAttribute;
  const allowed = (value: unknown): value is string =>
    typeof value === 'string' && /^(?:data:|blob:)/i.test(value);
  const unavailable = (image: HTMLImageElement) => {
    setAttribute.call(image, 'data-relic-image-unavailable', '');
  };
  Object.defineProperty(prototype, 'src', {
    ...source,
    set(value: unknown) {
      if (allowed(value)) source.set!.call(this, value);
      else unavailable(this as HTMLImageElement);
    },
  });
  Object.defineProperty(prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: HTMLImageElement, name: string, value: string) {
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
        if (
          this.localName === 'image' &&
          /^(?:href|xlink:href)$/i.test(name) &&
          !allowed(value)
        ) {
          svgSetAttribute.call(this, 'data-relic-image-unavailable', '');
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
  input: DocumentInput
): Promise<DocumentOutcome> {
  try {
    const styles = document.createElement('div');
    document.head.append(styles);
    const budget = new ImageBudget();
    const restoreImages = guardImageSources();
    try {
      const archive = { entries: input.entries, budget };
      await renderAsync(archive as unknown as Blob, root, styles, {
        renderAltChunks: false,
        useBase64URL: true,
        h: boundedRenderFactory(),
        renderComments: false,
        renderChanges: false,
        experimental: false,
      });
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
      const placeholder = document.createElement('span');
      placeholder.textContent = 'Image not available';
      image.replaceWith(placeholder);
    }
    for (const image of root.querySelectorAll('img[src]')) {
      if (
        /^data:image\/(?:x-)?(?:emf|wmf|x-emf|x-wmf)[;,]/i.test(
          image.getAttribute('src') ?? ''
        )
      ) {
        const placeholder = document.createElement('span');
        placeholder.textContent = 'Unsupported EMF or WMF image';
        image.replaceWith(placeholder);
      }
    }
    for (const image of root.querySelectorAll('svg image')) {
      const href =
        image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
      const unavailable = image.hasAttribute('data-relic-image-unavailable');
      if (unavailable || /^data:image\/(?:x-)?(?:emf|wmf)[;,]/i.test(href)) {
        const placeholder = document.createElement('span');
        placeholder.textContent = unavailable
          ? 'Image not available'
          : 'Unsupported EMF or WMF image';
        (image.closest('svg') ?? image).replaceWith(placeholder);
      }
    }
    const decoder = new TextDecoder();
    if (
      [...input.entries].some(
        ([name, data]) =>
          /^word\/.*\.xml$/i.test(name) &&
          /<(?:[\w.-]+:)?altChunk(?:\s|\/|>)/.test(decoder.decode(data))
      )
    ) {
      const notice = document.createElement('p');
      notice.textContent = 'Embedded content was not shown.';
      root.prepend(notice);
    }
    const fit = () => {
      for (const page of root.querySelectorAll<HTMLElement>(
        '.docx-wrapper > section.docx'
      )) {
        page.style.zoom = '';
        const width = page.offsetWidth;
        if (width > 0)
          page.style.zoom = String(
            Math.min(1, Math.max(1, root.clientWidth - 60) / width)
          );
      }
    };
    fit();
    window.addEventListener('resize', fit, { passive: true });
    return { state: 'ready' };
  } catch (error) {
    return {
      state: 'failed',
      reason: error instanceof DocumentTooLarge ? 'too-large' : 'corrupt',
    };
  }
}
