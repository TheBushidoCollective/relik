/**
 * The publish page.
 *
 * Everything that decides anything lives in `publish.ts`. This file draws a
 * drop zone, a review step, progress, and the link. Text reaches the DOM
 * through `textContent` only, and that includes the filename, which is the
 * visitor's own but is still not markup.
 *
 * It is a lazy chunk: only a visitor who came to publish loads it.
 */

import { MAX_TITLE_CHARS, normalizeTitle } from '@relic/format';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
  type PublishDeps,
  PublishFailure,
  type PublishPhase,
  type PublishResult,
  type PublishSource,
  publishFile,
} from './publish.ts';
import { formatBytes } from './viewer.ts';

const WORDMARK = 'relik.link';

const ICONS = {
  upload:
    'M8 1.8l3.8 3.8-.7.7-2.6-2.6V11h-1V3.7L4.9 6.3l-.7-.7L8 1.8zM2 12h12v1H2v-1z',
  copy: 'M5 2h7a1 1 0 0 1 1 1v8h-1V3H5V2zM3 4h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 1v8h7V5H3z',
  open: 'M9 2h5v5h-1V3.7L7.7 9 7 8.3 12.3 3H9V2zM3 4h4v1H4v7h7V9h1v4H3V4z',
  back: 'M7 3 2 8l5 5 .7-.7L4.4 8.5H14v-1H4.4l3.3-3.3L7 3z',
  source:
    'M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z',
  flag: 'M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

/** A labelled action: an inline icon and a span, so narrow widths can hide the text. */
function labelled<T extends HTMLElement>(
  node: T,
  label: string,
  iconPath: string
): T {
  node.setAttribute('aria-label', label);
  const text = document.createElement('span');
  text.textContent = label;
  node.append(icon(iconPath), text);
  return node;
}

function link(label: string, href: string, iconPath: string): HTMLElement {
  const anchor = el('a', 'action');
  anchor.href = href;
  anchor.rel = 'noopener noreferrer';
  return labelled(anchor, label, iconPath);
}

function action(
  label: string,
  iconPath: string,
  onClick: () => void
): HTMLButtonElement {
  const control = el('button', 'action');
  control.type = 'button';
  control.addEventListener('click', onClick);
  return labelled(control, label, iconPath);
}

/** PUT with progress, which `fetch` cannot report for an upload body. */
function xhrUpload(
  url: string,
  body: Uint8Array,
  onProgress: (sent: number, total: number) => void
): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = new XMLHttpRequest();
  request.open('PUT', url);
  request.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(event.loaded, event.total);
  };
  request.onload = () => resolve(request.status);
  request.onerror = () => reject(new Error('transport failure'));
  request.onabort = () => reject(new Error('aborted'));
  // No headers are set. The grant signs the content length, which the
  // browser derives from the body itself, and anything else would have to
  // be allowed by the bucket's CORS rule and covered by the signature.
  request.send(body as unknown as XMLHttpRequestBodyInit);
  return promise;
}

function phaseText(phase: PublishPhase, name: string): string {
  switch (phase.kind) {
    case 'preparing':
      return `Checking ${name} against the size limit`;
    case 'encrypting':
      return `Encrypting ${name} in this page`;
    case 'uploading':
      return `Uploading ${formatBytes(phase.sent)} of ${formatBytes(phase.total)}`;
    case 'finishing':
      return 'Finishing';
  }
}

function buildBar(): HTMLElement {
  const bar = el('header', 'bar');
  const mark = el('a', 'mark', WORDMARK);
  mark.href = '/';
  bar.appendChild(mark);

  const identity = el('div', 'identity');
  identity.appendChild(el('div', 'filename', 'Publish a file'));
  identity.appendChild(
    el('div', 'accession', 'Encrypted here, stored as ciphertext')
  );
  bar.appendChild(identity);

  const actions = el('div', 'actions');
  actions.append(
    link('What Relik knows', '/policy', ICONS.source),
    link('Report', '/abuse', ICONS.flag)
  );
  bar.appendChild(actions);
  return bar;
}

/** What a publisher is agreeing to, stated before they drop anything. */
function terms(): HTMLElement {
  const list = el('ul', 'pub-terms');
  for (const line of [
    'The link contains the decryption key. Anyone who has it can read the file, and nobody else can, including us.',
    'We never receive the key. The code that encrypts your file is served by us, which is a trust you are extending; the policy page says so in full.',
    'The title is the one thing we store in the clear. It defaults to the filename, and you can change or clear it before you publish.',
    'A relic is kept until it is deleted, and you cannot delete it yourself. To take one down, report it with its id.',
    'A relic published here cannot be updated later. Publishing again makes a new link.',
  ]) {
    list.appendChild(el('li', 'pub-term', line));
  }
  return list;
}

/** Loads the page's own stylesheet and resolves once it has applied. */
function loadStylesheet(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = '/assets/publish-view.css';
  // A failed stylesheet must not strand the page on a blank screen: unstyled
  // controls still publish.
  sheet.onload = () => resolve();
  sheet.onerror = () => resolve();
  document.head.appendChild(sheet);
  return promise;
}

export async function mountPublish(body: HTMLElement): Promise<void> {
  await loadStylesheet();

  const deps: PublishDeps = {
    serviceOrigin: window.location.origin,
    fetch: globalThis.fetch.bind(globalThis),
    upload: xhrUpload,
  };
  const main = el('main', 'stage pub-stage');
  const panel = el('div', 'pub');
  main.appendChild(panel);
  body.replaceChildren(buildBar(), main);

  const status = el('div', 'pub-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  body.appendChild(status);

  let busy = false;

  const show = (...nodes: Node[]): void => panel.replaceChildren(...nodes);

  const idle = (problem?: string): void => {
    busy = false;
    status.textContent = problem ?? '';

    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'pub-hidden';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    const zone = el('div', 'pub-drop');
    zone.tabIndex = 0;
    zone.setAttribute('role', 'button');
    zone.setAttribute('aria-label', 'Choose a file to publish');

    const mark = icon(ICONS.upload);
    mark.classList.add('pub-drop-icon');
    zone.append(
      mark,
      el('h1', 'pub-drop-title', 'Drop a file to publish it'),
      el(
        'p',
        'pub-drop-note',
        `or click to choose one. One file, up to ${formatBytes(BROWSER_PUBLISH_LIMIT_BYTES)}.`
      )
    );

    const choose = (): void => input.click();
    zone.addEventListener('click', choose);
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file !== undefined) review([file], false);
    });

    // The drag counter, because dragenter and dragleave also fire for every
    // child the pointer crosses and would otherwise flicker the highlight.
    let depth = 0;
    zone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      zone.classList.add('over');
    });
    zone.addEventListener('dragover', (event) => event.preventDefault());
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      zone.classList.remove('over');
      const transfer = event.dataTransfer;
      if (transfer === null) return;
      const entry = transfer.items?.[0]?.webkitGetAsEntry?.();
      review([...transfer.files], entry?.isDirectory === true);
    });

    const nodes: Node[] = [];
    if (problem !== undefined) {
      const failure = el('div', 'notice', problem);
      failure.setAttribute('role', 'alert');
      nodes.push(failure);
    }
    nodes.push(zone, input, terms());
    show(...nodes);
  };

  /** The step between choosing a file and sending anything: what will cross, and the title. */
  const review = (files: File[], isFolder: boolean): void => {
    if (busy) return;
    if (isFolder) {
      idle('A folder cannot be published. Make an archive and publish that.');
      return;
    }
    if (files.length !== 1) {
      idle(
        files.length === 0
          ? 'No file was received. Try again.'
          : 'A relic holds one file. Drop them one at a time, or archive them first.'
      );
      return;
    }
    const file = files[0] as File;

    const card = el('div', 'pub-card');
    card.appendChild(el('h1', 'pub-card-title', file.name));
    card.appendChild(el('p', 'pub-meta', formatBytes(file.size)));

    const label = el('label', 'pub-label', 'Link preview title');
    const field = el('input', 'pub-title');
    field.type = 'text';
    field.maxLength = MAX_TITLE_CHARS;
    field.value = normalizeTitle(file.name);
    field.spellcheck = false;
    field.autocomplete = 'off';
    label.appendChild(field);
    card.appendChild(label);
    card.appendChild(
      el(
        'p',
        'pub-help',
        'Stored in the clear. Relik, and anything that previews the link, can read it. Clear it to publish without one.'
      )
    );

    const row = el('div', 'pub-row');
    const go = action(
      'Encrypt and publish',
      ICONS.upload,
      () => void start(file, field.value)
    );
    go.classList.add('primary');
    row.append(
      go,
      action('Choose a different file', ICONS.back, () => idle())
    );
    card.appendChild(row);

    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void start(file, field.value);
      }
    });
    show(card);
    field.focus();
    field.select();
  };

  const done = (result: PublishResult): void => {
    busy = false;
    status.textContent = 'Published. Your link is ready.';

    const card = el('div', 'pub-card');
    card.appendChild(el('h1', 'pub-card-title', 'Published'));
    card.appendChild(
      el(
        'p',
        'pub-help',
        'This link holds the key. Copy it now: this page does not keep it, and we cannot recover it for you.'
      )
    );

    const field = el('textarea', 'pub-link');
    field.rows = 3;
    field.readOnly = true;
    field.value = result.url;
    field.setAttribute('aria-label', 'Link, including the decryption key');
    field.addEventListener('focus', () => field.select());

    const row = el('div', 'pub-link-row');
    const copy = action('Copy link', ICONS.copy, () => {
      // The live region is for screen readers. A sighted visitor needs the
      // button itself to say it worked, so the label changes for a moment.
      const label = copy.querySelector('span');
      const said = (text: string, buttonText: string): void => {
        status.textContent = text;
        if (label === null) return;
        label.textContent = buttonText;
        window.setTimeout(() => {
          label.textContent = 'Copy link';
        }, 2000);
      };
      void navigator.clipboard.writeText(result.url).then(
        () => said('Link copied. It contains the decryption key.', 'Copied'),
        () => {
          field.select();
          said(
            'Could not copy. The link is selected; copy it by hand.',
            'Select and copy'
          );
        }
      );
    });
    copy.classList.add('primary');
    const open = link('Open', result.url, ICONS.open);
    open.setAttribute('target', '_blank');
    row.append(field, copy, open);
    card.appendChild(row);

    card.appendChild(
      el(
        'p',
        'pub-meta',
        result.title === undefined
          ? 'Published without a title.'
          : `Title stored with the relic: ${result.title}`
      )
    );
    card.appendChild(el('div', 'accession', result.relicId));
    card.appendChild(action('Publish another', ICONS.upload, () => idle()));
    show(card);
    field.select();
  };

  const start = async (file: File, rawTitle: string): Promise<void> => {
    if (busy) return;
    busy = true;

    const label = el('p', 'pub-meta');
    const meter = el('progress', 'pub-meter');
    const card = el('div', 'pub-card');
    card.append(el('h1', 'pub-card-title', file.name), label, meter);
    show(card);

    const source: PublishSource = {
      name: file.name,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    };

    try {
      const result = await publishFile(
        source,
        { title: rawTitle },
        deps,
        (phase) => {
          const text = phaseText(phase, file.name);
          label.textContent = text;
          status.textContent = text;
          if (phase.kind === 'uploading' && phase.total > 0) {
            meter.max = phase.total;
            meter.value = phase.sent;
          } else {
            // No value is an indeterminate bar, which is honest for steps
            // with no measurable progress.
            meter.removeAttribute('value');
          }
        }
      );
      done(result);
    } catch (error) {
      idle(
        error instanceof PublishFailure
          ? error.message
          : 'Something went wrong while publishing. Nothing was published; try again.'
      );
    }
  };

  idle();
}
