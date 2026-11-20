import { folderZip } from './folder-downloads.ts';
import type { FolderRelic } from './folder-relic.ts';

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  index?: number;
  size?: number;
}
interface Row {
  node: TreeNode;
  depth: number;
}

const CSS = `
.folder-pane{width:280px;flex:0 0 280px;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--rule);background:var(--surface);color:var(--ink)}
.folder-heading{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--rule)}
.folder-heading strong{flex:1}.folder-pane button,.folder-toolbar button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
.folder-pane button:focus-visible,.folder-toolbar button:focus-visible,.folder-pane input:focus-visible{outline:2px solid var(--patina);outline-offset:-2px}
.folder-filter{margin:8px;min-height:36px;min-width:0;color:var(--ink);background:var(--ground);border:1px solid var(--rule-strong);padding:4px 8px}
.folder-tree{position:relative;overflow:auto;flex:1;min-height:0}.folder-spacer{position:relative}.folder-row{position:absolute;left:0;right:0;height:28px;display:flex;align-items:center;gap:6px;width:100%;text-align:left;white-space:nowrap}.folder-row-name{overflow:hidden;text-overflow:ellipsis;flex:1}.folder-row-meta{font-size:11px;color:var(--ink-soft);padding-right:8px}.folder-row[aria-current=true]{background:var(--ground);color:var(--patina);font-weight:600}.folder-toolbar{display:flex;min-width:0;align-items:center;gap:8px;padding:4px 12px;border-bottom:1px solid var(--rule);background:var(--surface)}.folder-breadcrumb{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.folder-toggle,.folder-close{display:none}.folder-status{font-size:12px;padding:0 8px}
@media(max-width:700px){.folder-toggle,.folder-close{display:inline-block;min-height:44px;min-width:44px}.folder-pane{display:none;position:fixed;inset:0;z-index:1000;width:100%;height:100%;border:0}.folder-pane[data-open=true]{display:flex}.folder-heading button{min-height:44px}.folder-filter{min-height:44px}.folder-row{height:44px}.folder-toolbar{min-height:52px}.folder-breadcrumb{direction:rtl;text-align:left}}
@media(pointer:coarse){.folder-row{height:44px}.folder-heading button{min-height:44px}}
`;

function buildTree(folder: FolderRelic): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  folder.manifest.entries.forEach((entry, index) => {
    const parts = entry.path.split('/');
    let children = roots;
    let path = '';
    parts.forEach((name, i) => {
      path = path ? `${path}/${name}` : name;
      if (i === parts.length - 1) {
        children.push({ name, path, children: [], index, size: entry.length });
      } else {
        let dir = dirs.get(path);
        if (!dir) {
          dir = { name, path, children: [] };
          dirs.set(path, dir);
          children.push(dir);
        }
        children = dir.children;
      }
    });
  });
  return roots;
}

export function folderTreeView(
  folder: FolderRelic,
  name: string,
  open: (index: number) => void,
  save: (blob: Blob, filename: string) => void
): { pane: HTMLElement; toolbar: HTMLElement } {
  if (!document.getElementById('folder-tree-styles')) {
    const style = document.createElement('style');
    style.id = 'folder-tree-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const roots = buildTree(folder);
  const current = folder.manifest.entries[folder.index]!;
  const expanded = new Set<string>();
  const expandAll = folder.manifest.entries.length <= 50;
  function seed(nodes: TreeNode[]): void {
    for (const node of nodes)
      if (node.index === undefined) {
        if (expandAll || current.path.startsWith(`${node.path}/`))
          expanded.add(node.path);
        seed(node.children);
      }
  }
  seed(roots);
  const pane = document.createElement('aside');
  pane.className = 'folder-pane';
  pane.setAttribute('aria-label', 'Files');
  const heading = document.createElement('div');
  heading.className = 'folder-heading';
  const title = document.createElement('strong');
  title.textContent = 'Files';
  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'Download all';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'folder-close';
  close.textContent = 'Close';
  heading.append(title, download, close);
  const status = document.createElement('div');
  status.className = 'folder-status';
  status.setAttribute('role', 'status');
  const filter = document.createElement('input');
  filter.className = 'folder-filter';
  filter.type = 'search';
  filter.placeholder = 'Filter files';
  filter.setAttribute('aria-label', 'Filter files');
  const tree = document.createElement('div');
  tree.className = 'folder-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Files');
  const spacer = document.createElement('div');
  spacer.className = 'folder-spacer';
  tree.appendChild(spacer);
  pane.append(heading);
  if (folder.manifest.entries.length > 50) pane.append(filter);
  pane.append(status, tree);
  const toolbar = document.createElement('div');
  toolbar.className = 'folder-toolbar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'folder-toggle';
  toggle.textContent = 'Files';
  toggle.setAttribute('aria-haspopup', 'dialog');
  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'folder-breadcrumb';
  breadcrumb.textContent = `${name} / ${current.path.split('/').join(' / ')}`;
  breadcrumb.setAttribute('title', `${name} / ${current.path}`);
  toolbar.append(toggle, breadcrumb);
  const show = (): void => {
    pane.dataset['open'] = 'true';
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-modal', 'true');
    rebuild();
    close.focus();
  };
  const hide = (): void => {
    delete pane.dataset['open'];
    pane.removeAttribute('role');
    pane.removeAttribute('aria-modal');
    toggle.focus();
  };
  toggle.addEventListener('click', show);
  close.addEventListener('click', hide);
  pane.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pane.dataset['open']) {
      event.preventDefault();
      hide();
    }
    if (event.key === 'Tab' && pane.dataset['open']) {
      const focusable = Array.from(
        pane.querySelectorAll<HTMLElement>(
          'button:not([hidden]),input:not([hidden])'
        )
      ).filter((item) => item.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  let controller: AbortController | undefined;
  download.addEventListener('click', () => {
    if (controller) {
      controller.abort();
      return;
    }
    controller = new AbortController();
    download.textContent = 'Cancel';
    void folderZip(folder, controller.signal, (done, total) => {
      status.textContent = `Preparing ${done} of ${total}`;
    })
      .then((blob) => {
        save(blob, `${name}.zip`);
        status.textContent = '';
      })
      .catch((error: unknown) => {
        status.textContent =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'Download cancelled.'
            : 'Download could not be prepared.';
      })
      .finally(() => {
        controller = undefined;
        download.textContent = 'Download all';
      });
  });
  let rows: Row[] = [];
  let focused = 0;
  const rowHeight = (): number =>
    matchMedia('(max-width: 700px), (pointer: coarse)').matches ? 44 : 28;
  function rebuild(): void {
    const query = filter.value.trim().toLocaleLowerCase();
    rows = [];
    function visit(nodes: TreeNode[], depth: number): boolean {
      let matched = false;
      for (const node of nodes) {
        if (node.index !== undefined) {
          if (!query || node.path.toLocaleLowerCase().includes(query)) {
            rows.push({ node, depth });
            matched = true;
          }
        } else if (query) {
          const pos = rows.length;
          const childMatched = visit(node.children, depth + 1);
          if (childMatched) {
            rows.splice(pos, 0, { node, depth });
            matched = true;
          }
        } else {
          rows.push({ node, depth });
          matched = true;
          if (expanded.has(node.path)) visit(node.children, depth + 1);
        }
      }
      return matched;
    }
    visit(roots, 0);
    focused = Math.min(focused, Math.max(rows.length - 1, 0));
    spacer.style.height = `${rows.length * rowHeight()}px`;
    paint();
  }
  function paint(): void {
    const height = rowHeight();
    const start = Math.max(0, Math.floor(tree.scrollTop / height) - 20);
    const end = Math.min(
      rows.length,
      start + Math.min(120, Math.ceil((tree.clientHeight || 700) / height) + 40)
    );
    spacer.replaceChildren();
    for (let i = start; i < end; i++) {
      const { node, depth } = rows[i]!;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder-row';
      button.setAttribute('role', 'treeitem');
      button.setAttribute('aria-level', String(depth + 1));
      button.tabIndex = i === focused ? 0 : -1;
      button.style.top = `${i * height}px`;
      button.style.paddingLeft = `${Math.min(8 + depth * 14, 180)}px`;
      button.setAttribute('title', node.path);
      if (node.index === undefined)
        button.setAttribute(
          'aria-expanded',
          String(Boolean(filter.value) || expanded.has(node.path))
        );
      else if (node.index === folder.index)
        button.setAttribute('aria-current', 'true');
      const marker = document.createElement('span');
      marker.textContent =
        node.index === undefined
          ? expanded.has(node.path) || filter.value
            ? '▾'
            : '▸'
          : '·';
      const label = document.createElement('span');
      label.className = 'folder-row-name';
      label.textContent = node.name;
      const meta = document.createElement('span');
      meta.className = 'folder-row-meta';
      meta.textContent =
        node.index === undefined
          ? String(node.children.length)
          : `${node.size} B`;
      button.append(marker, label, meta);
      button.addEventListener('focus', () => {
        focused = i;
      });
      const activate = (): void => {
        if (node.index !== undefined) {
          open(node.index);
        } else {
          if (expanded.has(node.path)) expanded.delete(node.path);
          else expanded.add(node.path);
          rebuild();
          focusRow(i);
        }
      };
      button.addEventListener('click', activate);
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusRow(
            Math.max(
              0,
              Math.min(
                rows.length - 1,
                i + (event.key === 'ArrowDown' ? 1 : -1)
              )
            )
          );
        } else if (event.key === 'ArrowRight' && node.index === undefined) {
          event.preventDefault();
          expanded.add(node.path);
          rebuild();
          focusRow(i);
        } else if (event.key === 'ArrowLeft' && node.index === undefined) {
          event.preventDefault();
          expanded.delete(node.path);
          rebuild();
          focusRow(i);
        }
      });
      spacer.appendChild(button);
    }
  }
  function focusRow(index: number): void {
    focused = index;
    const height = rowHeight();
    if (index * height < tree.scrollTop) tree.scrollTop = index * height;
    else if ((index + 1) * height > tree.scrollTop + tree.clientHeight)
      tree.scrollTop = (index + 1) * height - tree.clientHeight;
    paint();
    spacer.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }
  tree.addEventListener('scroll', paint);
  filter.addEventListener('input', () => {
    tree.scrollTop = 0;
    rebuild();
  });
  rebuild();
  return { pane, toolbar };
}
