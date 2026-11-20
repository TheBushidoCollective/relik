import type { FolderRelic } from './folder-relic.ts';
import type { MarkdownResolver } from './markdown.ts';

export const FOLDER_IMAGE_MAX_COUNT = 200;
export const FOLDER_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const FOLDER_IMAGE_TOTAL_BYTES = 64 * 1024 * 1024;

interface Reference {
  index: number;
  fragment: string;
}

/** Paths and fragments are never placed in the URL or an HTML attribute. */
export function resolveFolderReference(
  folder: FolderRelic,
  target: string
): Reference | undefined {
  const split = target.search(/[?#]/);
  const rawPath = split < 0 ? target : target.slice(0, split);
  const hash = target.indexOf('#');
  let path: string;
  let fragment: string;
  try {
    path = decodeURIComponent(rawPath);
    fragment = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
  } catch {
    return undefined;
  }
  if (
    path.startsWith('//') ||
    path.includes('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    Array.from(path).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return undefined;
  const current = folder.manifest.entries[folder.index]?.path;
  if (current === undefined) return undefined;
  const rootRelative = path.startsWith('/');
  const parts = rootRelative ? [] : current.split('/');
  if (path !== '') {
    if (!rootRelative) parts.pop();
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return undefined;
        parts.pop();
      } else parts.push(part);
    }
  }
  const index = folder.manifest.entries.findIndex(
    (entry) => entry.path === parts.join('/')
  );
  return index < 0 ? undefined : { index, fragment };
}

export function scrollToFolderFragment(
  root: HTMLElement,
  fragment: string
): void {
  if (!fragment) return;
  const target = Array.from(
    root.querySelectorAll<HTMLElement>('[id], h1, h2, h3, h4, h5, h6')
  ).find(
    (element) =>
      element.id === fragment ||
      (element.textContent ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-') === fragment.toLowerCase()
  );
  target?.scrollIntoView();
}

function rasterType(bytes: Uint8Array): string | undefined {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8')
    return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

export function folderMarkdown(folder: FolderRelic): {
  resolver: MarkdownResolver;
  mount: (
    prose: HTMLElement,
    open: (index: number, fragment: string) => void
  ) => void;
} {
  const refs: Reference[] = [];
  let count = 0;
  let total = 0;
  const resolver: MarkdownResolver = {
    resolve(target, image) {
      const ref = resolveFolderReference(folder, target);
      if (!ref) return undefined;
      const entry = folder.manifest.entries[ref.index];
      if (!entry) return undefined;
      const id = refs.push(ref) - 1;
      let embed = false;
      if (
        image &&
        !/\.svg$/i.test(entry.path) &&
        count < FOLDER_IMAGE_MAX_COUNT &&
        entry.length <= FOLDER_IMAGE_MAX_BYTES &&
        total + entry.length <= FOLDER_IMAGE_TOTAL_BYTES
      ) {
        count++;
        total += entry.length;
        embed = true;
      }
      return { id, image: embed };
    },
  };
  return {
    resolver,
    mount(prose, open) {
      let disposed = false;
      let decodedBytes = 0;
      const urls: string[] = [];
      const observer = new MutationObserver(() => {
        if (!prose.isConnected) {
          disposed = true;
          observer.disconnect();
          for (const url of urls) URL.revokeObjectURL(url);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      prose.addEventListener('click', (event) => {
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('a.md-entry-link')
            : null;
        if (!element) return;
        const ref = refs[Number(element.dataset.relicReference)];
        if (!ref) return;
        event.preventDefault();
        open(ref.index, ref.fragment);
      });
      for (const placeholder of prose.querySelectorAll<HTMLElement>(
        '.md-entry-image'
      )) {
        const ref = refs[Number(placeholder.dataset.relicReference)];
        const entry = ref && folder.manifest.entries[ref.index];
        if (!entry || !ref) continue;
        const blob = folder.whole
          .blob('application/octet-stream')
          .slice(entry.offset, entry.offset + entry.length);
        void blob
          .slice(0, 16)
          .arrayBuffer()
          .then((head) => {
            if (disposed) return;
            const type = rasterType(new Uint8Array(head));
            const fallback = (node: HTMLElement): void => {
              const alt = document.createElement('span');
              alt.className = 'md-image';
              alt.textContent = placeholder.textContent;
              const link = document.createElement('a');
              link.href = '#';
              link.className = 'md-entry-link';
              link.dataset.relicReference = placeholder.dataset.relicReference;
              link.textContent = placeholder.textContent;
              node.replaceWith(alt, ' ', link);
            };
            if (!type) {
              fallback(placeholder);
              return;
            }
            const image = document.createElement('img');
            image.className = 'md-entry-image';
            image.alt = placeholder.textContent ?? '';
            const url = URL.createObjectURL(blob.slice(0, blob.size, type));
            urls.push(url);
            image.onload = () => {
              const size = image.naturalWidth * image.naturalHeight * 4;
              if (decodedBytes + size > FOLDER_IMAGE_TOTAL_BYTES) {
                URL.revokeObjectURL(url);
                fallback(image);
              } else {
                decodedBytes += size;
              }
            };
            image.onerror = () => {
              URL.revokeObjectURL(url);
              fallback(image);
            };
            image.src = url;
            placeholder.replaceWith(image);
          });
      }
    },
  };
}
