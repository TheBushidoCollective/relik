import { renderAsync } from 'docx-preview';
import type {
  DocumentInput,
  DocumentOutcome,
} from './frame-document-protocol.ts';

const MAX_ELEMENTS = 1_500_000;

export async function render(
  root: HTMLElement,
  input: DocumentInput
): Promise<DocumentOutcome> {
  try {
    const styles = document.createElement('div');
    document.head.append(styles);
    await renderAsync(input.entries as unknown as Blob, root, styles, {
      renderAltChunks: false,
      useBase64URL: true,
      renderComments: false,
      renderChanges: false,
      experimental: false,
    });
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
            Math.min(1, Math.max(1, root.clientWidth - 32) / width)
          );
      }
    };
    fit();
    window.addEventListener('resize', fit, { passive: true });
    return { state: 'ready' };
  } catch {
    return { state: 'failed', reason: 'corrupt' };
  }
}
