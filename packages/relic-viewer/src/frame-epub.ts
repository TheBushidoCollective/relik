import { mountEpubChrome } from './epub-chrome.ts';
import { sanitizeEpubChapter } from './epub-sanitize.ts';
import type {
  DocumentInput,
  DocumentOutcome,
} from './frame-document-protocol.ts';

export async function render(
  root: HTMLElement,
  input: DocumentInput
): Promise<DocumentOutcome> {
  const book = input.book;
  if (!book) return { state: 'failed', reason: 'corrupt' };
  try {
    const spine = [
      ...book.spine.filter((item) => item.linear),
      ...book.spine.filter((item) => !item.linear),
    ];
    const chapters = new Map(spine.map((item, index) => [item.path, index]));
    const blobs: string[] = [];
    const context = {
      entries: input.entries,
      path: '',
      chapter: 0,
      chapterByPath: chapters,
      blobs,
      count: 0,
    };
    const style = document.createElement('style');
    style.textContent =
      '#relic-document{max-width:52rem;margin:0 auto;padding:1.5rem 1.5rem 5rem;overflow-wrap:anywhere}#relic-document img,#relic-document video{max-width:100%;height:auto}.epub-footnote{position:fixed;z-index:2147482999;bottom:4rem;right:1rem;max-width:min(32rem,80vw);max-height:45vh;overflow:auto;padding:1rem;background:white;border:1px solid #999;box-shadow:0 4px 12px #0003}';
    document.head.append(style);
    for (let index = 0; index < spine.length; index++) {
      const part = spine[index]!;
      const bytes = input.entries.get(part.path);
      if (!bytes) return { state: 'failed', reason: 'corrupt' };
      context.path = part.path;
      context.chapter = index;
      const article = sanitizeEpubChapter(
        new TextDecoder().decode(bytes),
        context
      );
      root.append(article);
    }
    if (book.progression !== 'default') root.dir = book.progression;
    if (book.layout === 'pre-paginated') {
      const resize = () => {
        for (const article of root.querySelectorAll<HTMLElement>(
          'article[data-epub-chapter]'
        )) {
          const width = article.scrollWidth;
          if (width > root.clientWidth && width > 0)
            article.style.zoom = String(root.clientWidth / width);
        }
      };
      resize();
      addEventListener('resize', resize);
    }
    root.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('a[href^="#ep-"]');
        if (!link) return;
        event.preventDefault();
        const id = link.getAttribute('href')?.slice(1);
        const dest = id && document.getElementById(id);
        if (!dest) return;
        if (link.hasAttribute('data-epub-noteref')) {
          root.querySelector('.epub-footnote')?.remove();
          const popover = document.createElement('aside');
          popover.className = 'epub-footnote';
          const close = document.createElement('button');
          close.textContent = 'Close';
          close.addEventListener('click', () => popover.remove());
          popover.append(close, dest.cloneNode(true));
          root.append(popover);
        } else dest.scrollIntoView();
      },
      true
    );
    mountEpubChrome(root, book, chapters);
    addEventListener(
      'pagehide',
      () => {
        for (const url of blobs) URL.revokeObjectURL(url);
      },
      { once: true }
    );
    return { state: 'ready' };
  } catch (error) {
    return {
      state: 'failed',
      reason:
        error instanceof Error && error.message.includes('limit')
          ? 'too-large'
          : 'corrupt',
    };
  }
}
