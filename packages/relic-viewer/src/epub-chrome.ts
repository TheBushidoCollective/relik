import type { EpubBook } from './frame-document-protocol.ts';
import { epubAnchor } from './epub-sanitize.ts';

export function mountEpubChrome(
  root: HTMLElement,
  book: EpubBook,
  chapterByPath: ReadonlyMap<string, number>,
  requestExternalLink?: (event: MouseEvent, href: string | null) => void
): (content: Element) => void {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    ':host{position:fixed;z-index:2147483000;bottom:0;left:0;right:0;font:14px system-ui;color:#222} .bar{display:flex;align-items:center;gap:12px;padding:8px 14px;background:#fff;border-top:1px solid #aaa} button{font:inherit;padding:5px 10px;cursor:pointer} .position{margin-left:auto} .panel{position:absolute;bottom:48px;left:8px;width:min(360px,90vw);max-height:60vh;overflow:auto;background:#fff;border:1px solid #aaa;padding:12px;box-shadow:0 4px 16px #0003} .panel[hidden]{display:none} .panel button{display:block;text-align:left;border:0;background:none;width:100%} .note-content{position:relative;isolation:isolate;contain:paint;overflow-wrap:anywhere} .note-content img,.note-content svg{max-width:100%;height:auto}';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const toggle = document.createElement('button');
  toggle.textContent = 'Contents';
  toggle.type = 'button';
  const smaller = document.createElement('button');
  smaller.textContent = 'A−';
  smaller.setAttribute('aria-label', 'Decrease text size');
  const larger = document.createElement('button');
  larger.textContent = 'A+';
  larger.setAttribute('aria-label', 'Increase text size');
  const position = document.createElement('span');
  position.className = 'position';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  const footnote = document.createElement('aside');
  footnote.className = 'panel';
  footnote.hidden = true;
  let currentChapter = 0;
  let noteChapter: number | undefined;
  const hideFootnote = () => {
    footnote.hidden = true;
    noteChapter = undefined;
  };
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  let zoom = 1;
  const setZoom = (value: number) => {
    const next = Math.min(1.5, Math.max(0.9, Math.round(value * 10) / 10));
    if (next === zoom) return;

    // Keep a heading already at the reading edge whole as it wraps. Otherwise
    // anchor visible text, or the viewport of an image or SVG chapter.
    const bounds = root.getBoundingClientRect();
    const x = Math.min(
      Math.max(0, innerWidth - 1),
      Math.max(0, bounds.left + bounds.width / 2)
    );
    const y = Math.min(32, Math.max(0, innerHeight - 1));
    const hit = document.elementFromPoint(x, y);
    const topHit = document.elementFromPoint(x, Math.min(1, y));
    const heading =
      hit?.closest('h1, h2, h3, h4, h5, h6') ??
      topHit?.closest('h1, h2, h3, h4, h5, h6');
    const headingRect = heading?.getBoundingClientRect();
    const headingAnchor =
      heading &&
      root.contains(heading) &&
      headingRect &&
      headingRect.top >= -4 &&
      headingRect.top <= y &&
      headingRect.bottom > 0
        ? heading
        : undefined;
    const visual = hit?.closest('svg, img, video');
    const visualAnchor = visual && root.contains(visual) ? visual : undefined;
    const blockAnchor = headingAnchor ?? visualAnchor;
    const caretDocument = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = blockAnchor
      ? null
      : caretDocument.caretPositionFromPoint?.(x, y);
    let range: Range | null = null;
    if (caret) {
      range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      range.collapse(true);
    } else if (!blockAnchor) {
      range = caretDocument.caretRangeFromPoint?.(x, y) ?? null;
    }
    const rect = range?.getBoundingClientRect();
    let before: number;
    let measure: () => number;
    if (
      range &&
      root.contains(range.startContainer) &&
      rect &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.top < innerHeight &&
      Math.max(rect.top - y, y - rect.bottom, 0) <= Math.max(24, rect.height)
    ) {
      const anchor = range;
      before = rect.top;
      measure = () => anchor.getBoundingClientRect().top;
    } else {
      const anchor = blockAnchor ?? (hit && root.contains(hit) ? hit : root);
      const start = anchor.getBoundingClientRect();
      const fraction =
        anchor === headingAnchor
          ? 0
          : start.height > 0
            ? Math.min(1, Math.max(0, (y - start.top) / start.height))
            : 0;
      before = start.top + fraction * start.height;
      measure = () => {
        const current = anchor.getBoundingClientRect();
        return current.top + fraction * current.height;
      };
    }
    zoom = next;
    root.style.zoom = String(zoom);
    window.scrollBy(0, measure() - before);
    if (headingAnchor) {
      const top = headingAnchor.getBoundingClientRect().top;
      if (top < 0) window.scrollBy(0, Math.floor(top));
    }
    update();
  };
  smaller.addEventListener('click', () => setZoom(zoom - 0.1));
  larger.addEventListener('click', () => setZoom(zoom + 0.1));
  for (const item of book.toc) {
    const chapter = chapterByPath.get(item.path);
    if (chapter === undefined) continue;
    const button = document.createElement('button');
    button.textContent = item.label;
    button.style.paddingInlineStart = `${10 + item.depth * 14}px`;
    button.addEventListener('click', () => {
      hideFootnote();
      (
        document.getElementById(epubAnchor(chapter, item.fragment ?? '')) ??
        document.getElementById(epubAnchor(chapter, ''))
      )?.scrollIntoView();
      panel.hidden = true;
      update();
    });
    panel.append(button);
  }
  const chapters = Array.from(
    root.querySelectorAll<HTMLElement>('[data-epub-chapter]')
  );
  const pages = book.pageList.flatMap((entry) => {
    const chapter = chapterByPath.get(entry.path);
    if (chapter === undefined) return [];
    const node = document.getElementById(
      epubAnchor(chapter, entry.fragment ?? '')
    );
    return node ? [{ node, label: entry.label }] : [];
  });
  pages.sort((a, b) => {
    if (a.node === b.node) return 0;
    return a.node.compareDocumentPosition(b.node) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
  });
  const update = () => {
    let current = 0;
    for (let i = 0; i < chapters.length; i++)
      if (chapters[i]!.getBoundingClientRect().top <= 120) current = i;
    const max = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight
    );
    if (
      document.documentElement.scrollHeight > innerHeight &&
      scrollY >= max - 2
    )
      current = Math.max(0, chapters.length - 1);
    if (noteChapter !== undefined && noteChapter !== current) hideFootnote();
    currentChapter = current;
    const percent = Math.max(
      0,
      Math.min(100, Math.round((scrollY / max) * 100))
    );
    let low = 0;
    let high = pages.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (pages[mid]!.node.getBoundingClientRect().top <= 120) low = mid + 1;
      else high = mid;
    }
    const page = low > 0 ? ` · Page ${pages[low - 1]!.label}` : '';
    position.textContent = `Chapter ${Math.min(chapters.length, current + 1)} of ${chapters.length} · ${percent}%${page}`;
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  bar.append(toggle, smaller, larger, position);
  footnote.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#ep-')) {
      const id = href.slice(1);
      const node =
        document.getElementById(id) ??
        document.getElementById(id.replace(/^(ep-\d+-).*$/, '$1'));
      if (node) {
        hideFootnote();
        node.scrollIntoView();
        update();
      }
    } else {
      requestExternalLink?.(event, href);
    }
  });
  root.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href^="#ep-"]');
      if (link && !link.hasAttribute('data-epub-noteref')) hideFootnote();
    },
    true
  );
  shadow.append(footnote);
  shadow.append(style, panel, bar);
  root.after(host);
  update();
  return (content) => {
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', hideFootnote);
    const noteContent = document.createElement('div');
    noteContent.className = 'note-content';
    noteContent.append(content.cloneNode(true));
    footnote.replaceChildren(close, noteContent);
    update();
    noteChapter = currentChapter;
    footnote.hidden = false;
  };
}
