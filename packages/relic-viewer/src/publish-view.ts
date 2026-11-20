/**
 * The publish page.
 *
 * Everything that decides anything lives in `publish.ts`. This file draws a
 * drop zone, reports progress, and hands back the link. Text reaches the DOM
 * through `textContent` only, and that includes the filename, which is the
 * visitor's own but is still not markup.
 */

import { PLAINTEXT_CAP_BYTES } from '@relic/format';
import { button, ICONS, icon, toast, WORDMARK } from './chrome.ts';
import {
  type PublishDeps,
  PublishFailure,
  type PublishPhase,
  type PublishResult,
  type PublishSource,
  publishFile,
} from './publish.ts';
import { formatBytes } from './viewer.ts';

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

function link(label: string, href: string, className: string): HTMLElement {
  const anchor = el('a', className);
  anchor.href = href;
  anchor.rel = 'noopener noreferrer';
  anchor.setAttribute('aria-label', label);
  const text = document.createElement('span');
  text.textContent = label;
  anchor.append(text);
  return anchor;
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
  bar.appendChild(el('div', 'mark', WORDMARK));

  const identity = el('div', 'identity');
  identity.appendChild(el('div', 'filename', 'Publish a file'));
  identity.appendChild(
    el('div', 'accession', 'Encrypted here, stored as ciphertext')
  );
  bar.appendChild(identity);

  const actions = el('div', 'actions');
  const policy = link('What Relik knows', '/policy', 'action');
  policy.prepend(icon(ICONS.source));
  const report = link('Report', '/abuse', 'action');
  report.prepend(icon(ICONS.flag));
  actions.append(policy, report);
  bar.appendChild(actions);
  return bar;
}

/** What a publisher is agreeing to, stated before they drop anything. */
function terms(): HTMLElement {
  const list = el('ul', 'terms');
  for (const line of [
    'The link contains the decryption key. Anyone who has it can read the file, and nobody else can, including us.',
    'We never receive the key. The code that encrypts your file is served by us, which is a trust you are extending; the policy page says so in full.',
    'A relic is kept until it is deleted, and you cannot delete it yourself. To take one down, report it with its id.',
    'A relic published here cannot be updated later. Publishing again makes a new link.',
  ]) {
    list.appendChild(el('li', 'term', line));
  }
  return list;
}

export function mountPublish(body: HTMLElement): void {
  const deps: PublishDeps = {
    serviceOrigin: window.location.origin,
    fetch: globalThis.fetch.bind(globalThis),
    upload: xhrUpload,
  };
  const main = el('main', 'stage stage-publish');
  const panel = el('div', 'publish');
  main.appendChild(panel);
  body.replaceChildren(buildBar(), main);

  const status = el('div', 'visually-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  body.appendChild(status);

  let busy = false;

  const show = (...nodes: Node[]): void => panel.replaceChildren(...nodes);

  const idle = (problem?: string): void => {
    busy = false;
    status.textContent = '';

    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'visually-hidden';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    const zone = el('div', 'drop');
    zone.tabIndex = 0;
    zone.setAttribute('role', 'button');
    zone.setAttribute('aria-label', 'Choose a file to publish');

    const mark = icon(ICONS.upload);
    mark.classList.add('drop-icon');
    zone.append(
      mark,
      el('h1', 'drop-title', 'Drop a file to publish it'),
      el(
        'p',
        'drop-note',
        `or click to choose one. One file, up to ${formatBytes(PLAINTEXT_CAP_BYTES)}.`
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
      if (file !== undefined) void start([file], false);
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
      void start([...transfer.files], entry?.isDirectory === true);
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

  const done = (result: PublishResult): void => {
    busy = false;
    status.textContent = 'Published. Your link is ready.';

    const card = el('div', 'card');
    card.appendChild(el('h1', 'card-title', 'Published'));
    card.appendChild(
      el(
        'p',
        'card-note',
        'This link holds the key. Copy it now: this page does not keep it, and we cannot recover it for you.'
      )
    );

    const field = document.createElement('textarea');
    field.rows = 3;
    field.readOnly = true;
    field.className = 'link-field';
    field.value = result.url;
    field.setAttribute('aria-label', 'Link, including the decryption key');
    field.addEventListener('focus', () => field.select());

    const row = el('div', 'link-row');
    const copy = button('Copy link', ICONS.copy, () => {
      void navigator.clipboard.writeText(result.url).then(
        () => toast('Link copied. It contains the decryption key.'),
        () => {
          field.select();
          toast('Could not copy. The link is selected; copy it by hand.');
        }
      );
    });
    copy.classList.add('primary');
    const open = link('Open', result.url, 'action');
    open.setAttribute('target', '_blank');
    open.prepend(icon(ICONS.rendered));
    row.append(field, copy, open);
    card.appendChild(row);

    card.appendChild(el('div', 'accession', result.relicId));

    const again = button('Publish another', ICONS.upload, () => idle());
    card.appendChild(again);
    show(card);
    field.select();
  };

  const start = async (files: File[], isFolder: boolean): Promise<void> => {
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
    busy = true;

    const label = el('p', 'card-note');
    const meter = document.createElement('progress');
    meter.className = 'meter';
    const card = el('div', 'card');
    card.append(el('h1', 'card-title', file.name), label, meter);
    show(card);

    const source: PublishSource = {
      name: file.name,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    };

    try {
      const result = await publishFile(source, deps, (phase) => {
        const text = phaseText(phase, file.name);
        label.textContent = text;
        status.textContent = text;
        if (phase.kind === 'uploading' && phase.total > 0) {
          meter.max = phase.total;
          meter.value = phase.sent;
        } else {
          // No value is an indeterminate bar, which is honest for steps with
          // no measurable progress.
          meter.removeAttribute('value');
        }
      });
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
