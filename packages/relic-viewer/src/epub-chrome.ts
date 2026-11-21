import type { EpubBook } from './frame-document-protocol.ts';
import { epubAnchor } from './epub-sanitize.ts';

export function mountEpubChrome(
  root: HTMLElement,
  book: EpubBook,
  chapterByPath: ReadonlyMap<string, number>
): void {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    ':host{position:fixed;z-index:2147483000;bottom:0;left:0;right:0;font:14px system-ui;color:#222} .bar{display:flex;align-items:center;gap:12px;padding:8px 14px;background:#fff;border-top:1px solid #aaa} button{font:inherit;padding:5px 10px;cursor:pointer} .position{margin-left:auto} .panel{position:absolute;bottom:48px;left:8px;width:min(360px,90vw);max-height:60vh;overflow:auto;background:#fff;border:1px solid #aaa;padding:12px;box-shadow:0 4px 16px #0003} .panel[hidden]{display:none} .panel button{display:block;text-align:left;border:0;background:none;width:100%}';
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
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  let zoom = 1;
  const setZoom = (value: number) => {
    zoom = Math.min(1.5, Math.max(0.9, Math.round(value * 10) / 10));
    root.style.zoom = String(zoom);
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
      document
        .getElementById(epubAnchor(chapter, item.fragment ?? ''))
        ?.scrollIntoView();
      panel.hidden = true;
    });
    panel.append(button);
  }
  const chapters = Array.from(
    root.querySelectorAll<HTMLElement>('[data-epub-chapter]')
  );
  const update = () => {
    let current = 0;
    for (let i = 0; i < chapters.length; i++)
      if (chapters[i]!.getBoundingClientRect().top <= 120) current = i;
    const max = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight
    );
    const percent = Math.max(
      0,
      Math.min(100, Math.round((scrollY / max) * 100))
    );
    let page = '';
    for (const entry of book.pageList) {
      const chapter = chapterByPath.get(entry.path);
      if (chapter === undefined) continue;
      const node = document.getElementById(
        epubAnchor(chapter, entry.fragment ?? '')
      );
      if (node && node.getBoundingClientRect().top <= 120)
        page = ` · Page ${entry.label}`;
    }
    position.textContent = `Chapter ${Math.min(chapters.length, current + 1)} of ${chapters.length} · ${percent}%${page}`;
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
  bar.append(toggle, smaller, larger, position);
  shadow.append(style, panel, bar);
  root.after(host);
}
