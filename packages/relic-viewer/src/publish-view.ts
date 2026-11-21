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

import { MAX_FILENAME_BYTES, normalizeTitle } from '@relic/format';
import { prepareBrowserDirectory } from './browser-folder-source.ts';
import { droppedFrom } from './drop-anywhere.ts';
import {
  PrivateRequestError,
  type ReviewedPrivateOwner,
} from './private/keys.ts';
import {
  createPrivatePublisher,
  type PrivatePublisher,
} from './private/publish.ts';
import { mountPrivatePublishSetup } from './private/publish-setup.ts';
import {
  generateCoverPreview,
  type CoverPreviewResult,
} from './publish-cover.ts';
import {
  canExpandZip,
  type PreparePublishSourceOptions,
  PublishSourceFailure,
  type ReviewedFolderSource,
  preparePublishSource,
  type ReviewedPublishSource,
} from './publish-source.ts';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
  type PublishDeps,
  PublishFailure,
  type PublishPhase,
  type PublishResult,
  type PublishSource,
  publishFile,
} from './publish.ts';
import { pickFile } from './upload-button.ts';
import { localStorageKeyVault } from './vault.ts';
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
  body: Uint8Array | Blob,
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

function buildBar(onUpload: () => void): HTMLElement {
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
    link('Report', '/abuse', ICONS.flag),
    // Last, like on every other bar. On this page it chooses the file for the
    // publisher already here instead of opening a dialog over it.
    action('Upload', ICONS.upload, onUpload)
  );
  bar.appendChild(actions);
  return bar;
}

/** What a publisher is agreeing to, stated before they drop anything. */
function terms(): HTMLElement {
  const list = el('ul', 'pub-terms');
  for (const line of [
    'This page encrypts your file before it leaves your device. Relik serves the code that encrypts it.',
    'A public link contains the decryption key. Its title and any preview image you choose can be read without the key.',
    'To remove a public relic you published here, report it with its ID.',
    'A public relic published here cannot be updated later. Publishing makes a new link; existing relics stay as they are.',
  ]) {
    list.appendChild(el('li', 'pub-term', line));
  }
  return list;
}

/** Loads the page's own stylesheet and resolves once it has applied. */
function loadStylesheet(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const existing = document.querySelector('link[data-publish-view]');
  if (existing !== null) {
    resolve();
    return promise;
  }
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = '/assets/publish-view.css';
  sheet.dataset['publishView'] = '';
  // A failed stylesheet must not strand the page on a blank screen: unstyled
  // controls still publish.
  sheet.onload = () => resolve();
  sheet.onerror = () => resolve();
  document.head.appendChild(sheet);
  return promise;
}

export interface PublishReviewDraft {
  readonly filename: string;
  readonly title: string;
  readonly ttlDays?: number;
  readonly decisions: boolean;
  readonly expand: boolean;
  readonly openFirst?: string;
  readonly cover: boolean;
  readonly private: boolean;
}

type ApprovedCover = Extract<
  CoverPreviewResult,
  { status: 'ready' }
>['preview'];

export type PublishReviewSubmission = Omit<
  PublishReviewDraft,
  'title' | 'cover' | 'private'
> & {
  readonly file?: File;
  readonly source?: ReviewedPublishSource;
} & (
    | {
        readonly private: false;
        readonly title: string;
        readonly cover?: ApprovedCover;
      }
    | {
        readonly private: true;
        readonly owner: ReviewedPrivateOwner;
        readonly title?: never;
        readonly cover?: never;
      }
  );

export type PublishPrivateSetup =
  | {
      readonly kind: 'ready';
      readonly defaultTtlDays: number;
      readonly maxTtlDays: number;
      readonly owner: ReviewedPrivateOwner;
    }
  | {
      readonly kind: 'blocked';
      readonly message: string;
      readonly retryable?: boolean;
    };

export type PublishReviewResult = PublishResult;

export interface PublishReviewAdapter {
  /** Prepare locally, without asking the service for a publish grant. */
  readonly prepareSource?: (
    file: File,
    options: PreparePublishSourceOptions
  ) => Promise<ReviewedPublishSource>;
  readonly generateCover?: (
    source: ReviewedPublishSource['preview']
  ) => Promise<CoverPreviewResult>;
  /** Mount the sign-in and passkey flow; abort when the review relinquishes its slot. */
  readonly setupPrivate?: (
    slot: HTMLElement,
    signal: AbortSignal
  ) => Promise<PublishPrivateSetup>;
  /** Forget any retained incomplete private publication. */
  readonly dispose?: () => void;
  readonly submit: (
    submission: PublishReviewSubmission,
    onPhase: (phase: PublishPhase) => void
  ) => Promise<PublishReviewResult>;
}

function browserReviewAdapter(deps: PublishDeps): PublishReviewAdapter {
  const privateDeps = {
    serviceOrigin: deps.serviceOrigin,
    fetch: deps.fetch,
    locationHref: window.location.href,
    keyVault: localStorageKeyVault(),
  };
  let pending:
    | {
        publisher: PrivatePublisher;
        file: File | undefined;
        fingerprint: string;
      }
    | undefined;
  let reportPhase: (phase: PublishPhase) => void = () => {};
  const dispose = (): void => {
    pending?.publisher.dispose();
    pending = undefined;
  };
  return {
    prepareSource: preparePublishSource,
    generateCover: generateCoverPreview,
    setupPrivate: (slot, signal) =>
      mountPrivatePublishSetup(slot, privateDeps, signal),
    dispose,
    async submit(submission, onPhase) {
      if (submission.private) {
        reportPhase = onPhase;
        const fingerprint = JSON.stringify([
          submission.filename,
          submission.expand,
          submission.openFirst,
          submission.ttlDays,
          submission.decisions,
          submission.owner.identityId,
          submission.owner.email,
        ]);
        if (
          pending === undefined ||
          pending.file !== submission.file ||
          pending.fingerprint !== fingerprint
        ) {
          dispose();
          const reviewed =
            submission.source ??
            (submission.file === undefined
              ? undefined
              : await preparePublishSource(submission.file, {
                  filename: submission.filename,
                  expand: submission.expand,
                  ...(submission.openFirst === undefined
                    ? {}
                    : { openFirst: submission.openFirst }),
                }));
          if (reviewed === undefined)
            throw new Error('Choose a file or folder to publish.');
          const publisher = createPrivatePublisher({
            deps: privateDeps,
            source: reviewed,
            owner: submission.owner,
            decisions: submission.decisions,
            ...(submission.ttlDays === undefined
              ? {}
              : { ttlDays: submission.ttlDays }),
            onPhase: (phase) => reportPhase(phase),
          });
          pending = { publisher, file: submission.file, fingerprint };
        }
        const result = await pending.publisher.publish();
        dispose();
        return { ...result, filename: submission.filename, title: undefined };
      }
      dispose();
      const { file, filename, title, ttlDays, decisions } = submission;
      const source: PublishSource | undefined =
        file === undefined
          ? undefined
          : {
              name: file.name,
              size: file.size,
              read: async () => new Uint8Array(await file.arrayBuffer()),
            };
      return publishFile(
        source,
        {
          filename,
          title,
          decisions,
          ...(submission.source === undefined
            ? {}
            : { prepared: submission.source }),
          ...(submission.cover === undefined
            ? {}
            : { cover: submission.cover }),
          ...(ttlDays === undefined ? {} : { ttlDays }),
        },
        deps,
        onPhase
      );
    },
  };
}

const MAX_PUBLIC_TTL_DAYS = 3650;
const FILENAME_ENCODER = new TextEncoder();
let reviewSequence = 0;

function reviewField(
  id: string,
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
  helpText = ''
): { row: HTMLElement; label: HTMLLabelElement; help: HTMLElement } {
  const row = el('div', 'pub-field-row');
  const label = el('label', 'pub-label', labelText);
  label.htmlFor = id;
  input.id = id;
  const help = el('p', 'pub-help', helpText);
  help.id = `${id}-help`;
  input.setAttribute('aria-describedby', help.id);
  row.append(label, input, help);
  return { row, label, help };
}

function reviewChoice(input: HTMLInputElement, text: string): HTMLLabelElement {
  const label = el('label', 'pub-choice');
  label.append(input, el('span', '', text));
  return label;
}

interface Publisher {
  readonly idle: (problem?: string) => void;
  readonly review: (
    files: File[],
    isFolder: boolean,
    entries?: FileSystemEntry[]
  ) => void;
  readonly isBusy: () => boolean;
  readonly dispose: () => void;
}

/**
 * The publisher, drawn into `panel`.
 *
 * On its own page it ends where it began, at the drop zone, so a visitor can
 * publish another file. In a dialog opened by a drop elsewhere it has a place
 * to go back to, and `onClose` is that: every step that would return to the
 * drop zone closes the dialog instead.
 */
function createPublisher(
  panel: HTMLElement,
  status: HTMLElement,
  suppliedAdapter?: PublishReviewAdapter,
  onClose?: () => void
): Publisher {
  const deps: PublishDeps = {
    serviceOrigin: window.location.origin,
    fetch: globalThis.fetch.bind(globalThis),
    upload: xhrUpload,
  };
  const adapter = suppliedAdapter ?? browserReviewAdapter(deps);
  let releaseReview: (() => void) | undefined;
  const dispose = (): void => {
    releaseReview?.();
    releaseReview = undefined;
    adapter.dispose?.();
  };

  let busy = false;
  let readingDirectory = false;

  const show = (...nodes: Node[]): void => panel.replaceChildren(...nodes);

  const idle = (problem?: string): void => {
    dispose();
    busy = false;
    status.textContent = problem ?? '';

    if (onClose !== undefined) {
      // There is no drop zone here to return to: the file came from a drop
      // on another page, so a refusal is a message and a way out.
      const card = el('div', 'pub-card');
      card.appendChild(el('h1', 'pub-card-title', 'Nothing was published'));
      card.appendChild(el('p', 'pub-help', problem ?? ''));
      card.appendChild(action('Close', ICONS.back, onClose));
      show(card);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'pub-hidden';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    const folderInput = document.createElement('input');
    folderInput.type = 'file';
    folderInput.className = 'pub-hidden';
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.multiple = true;
    folderInput.addEventListener('change', () =>
      review([...(folderInput.files ?? [])], true)
    );

    const zone = el('div', 'pub-drop');
    zone.tabIndex = 0;
    zone.setAttribute('role', 'button');
    zone.setAttribute('aria-label', 'Choose a file to publish');

    const mark = icon(ICONS.upload);
    mark.classList.add('pub-drop-icon');
    zone.append(
      mark,
      el('h1', 'pub-drop-title', 'Drop a file or folder to publish it'),
      el(
        'p',
        'pub-drop-note',
        `or click to choose a file. Up to ${formatBytes(BROWSER_PUBLISH_LIMIT_BYTES)}.`
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
      if (event.dataTransfer === null) return;
      const dropped = droppedFrom(event.dataTransfer);
      review(dropped.files, dropped.isFolder, dropped.entries);
    });

    const nodes: Node[] = [];
    if (problem !== undefined) {
      const failure = el('div', 'notice', problem);
      failure.setAttribute('role', 'alert');
      nodes.push(failure);
    }
    nodes.push(
      zone,
      input,
      folderInput,
      action('Choose a folder', ICONS.upload, () => folderInput.click()),
      terms()
    );
    show(...nodes);
  };

  const review = (
    files: File[],
    isFolder: boolean,
    entries: FileSystemEntry[] = [],
    directory?: ReviewedFolderSource
  ): void => {
    if (busy) return;
    if (isFolder && directory === undefined) {
      dispose();
      busy = true;
      readingDirectory = true;
      const scope = new AbortController();
      releaseReview = () => {
        scope.abort();
        busy = false;
        readingDirectory = false;
      };
      const card = el('div', 'pub-card');
      card.append(
        el('p', 'pub-meta', 'Reading files for review.'),
        action('Cancel', ICONS.back, () => {
          dispose();
          if (onClose === undefined) idle();
          else onClose();
        })
      );
      show(card);
      void prepareBrowserDirectory(entries, files, {
        signal: scope.signal,
      }).then(
        (prepared) => {
          if (scope.signal.aborted) return;
          // The reviewed folder keeps this signal for its later reads, so the
          // review's own dispose must not abort the finished read.
          releaseReview = undefined;
          busy = false;
          readingDirectory = false;
          review(files, true, entries, prepared);
        },
        (error: unknown) => {
          if (scope.signal.aborted) return;
          busy = false;
          readingDirectory = false;
          idle(
            error instanceof Error
              ? error.message
              : 'The files could not be read.'
          );
        }
      );
      return;
    }
    const file = isFolder ? undefined : files[0];
    if (!isFolder && (file === undefined || files.length !== 1)) {
      idle(
        file === undefined
          ? 'No file was received. Try again.'
          : 'Choose one file, or put the files in a ZIP first.'
      );
      return;
    }
    dispose();
    status.textContent = '';

    const id = `pub-review-${++reviewSequence}`;
    const card = el('form', 'pub-card pub-review');
    card.noValidate = true;
    const sourceName = directory?.filename ?? file!.name;
    const heading = el('h1', 'pub-card-title', sourceName);
    heading.id = id;
    heading.tabIndex = -1;
    card.setAttribute('aria-labelledby', id);

    const prepare = adapter.prepareSource;
    const eligible = file !== undefined && canExpandZip(file);
    const expand = el('input', 'pub-expand');
    expand.type = 'checkbox';
    expand.checked = eligible && prepare !== undefined;
    expand.disabled = prepare === undefined;
    const defaultName = (): string =>
      directory?.filename ??
      (expand.checked ? file!.name.replace(/\.zip$/i, '') : file!.name);
    const folderSelected = (): boolean =>
      directory !== undefined || expand.checked;
    const filename = el('input', 'pub-input pub-filename');
    filename.value = defaultName();
    filename.spellcheck = false;
    filename.autocomplete = 'off';
    const nameField = reviewField(
      `${id}-name`,
      'Encrypted filename',
      filename,
      'Stored inside the encrypted relic. It does not change the public title.'
    );
    const expansion = el('div', 'pub-option');
    expansion.hidden = !eligible;
    const zipHelp = el(
      'p',
      'pub-help',
      prepare === undefined
        ? 'ZIP expansion is unavailable here. The original archive will be published as one file.'
        : 'Uncheck to publish the original ZIP as one file.'
    );
    zipHelp.id = `${id}-zip-help`;
    expand.setAttribute('aria-describedby', zipHelp.id);
    const zipStatus = el('p', 'pub-review-status');
    zipStatus.setAttribute('role', 'status');
    expansion.append(
      reviewChoice(expand, 'Expand ZIP as a folder'),
      zipHelp,
      zipStatus
    );

    const openFirst = el('select', 'pub-input pub-open-first');
    const entryField = reviewField(`${id}-entry`, 'Open first', openFirst);
    entryField.row.hidden = true;
    const folderDetails = el('div', 'pub-folder-details');
    folderDetails.hidden = true;
    const sourceGroup = el('fieldset', 'pub-group');
    sourceGroup.append(
      el('legend', '', 'Source'),
      expansion,
      nameField.row,
      entryField.row,
      folderDetails
    );

    const publicMode = el('input', 'pub-public');
    const privateMode = el('input', 'pub-private');
    publicMode.type = privateMode.type = 'radio';
    publicMode.name = privateMode.name = 'publish-access';
    publicMode.checked = true;
    privateMode.disabled = adapter.setupPrivate === undefined;
    const choices = el('div', 'pub-choices');
    choices.append(
      reviewChoice(publicMode, 'Anyone with the link'),
      reviewChoice(privateMode, 'Private')
    );
    const accessHelp = el('p', 'pub-help');
    accessHelp.id = `${id}-access-help`;
    accessHelp.setAttribute('role', 'status');
    const setupStatus = el('p', 'pub-review-status');
    setupStatus.setAttribute('role', 'status');
    const setupSlot = el('div', 'pub-setup-slot');
    const retrySetup = action(
      'Retry private setup',
      ICONS.open,
      () => void preparePrivate()
    );
    retrySetup.hidden = true;
    const setup = el('div', 'pub-setup');
    setup.hidden = true;
    setup.append(setupStatus, setupSlot, retrySetup);

    const ttl = el('input', 'pub-input pub-ttl');
    ttl.inputMode = 'numeric';
    ttl.autocomplete = 'off';
    const ttlField = reviewField(`${id}-ttl`, 'Expires after (days)', ttl);
    const decisions = el('input', 'pub-decisions');
    decisions.type = 'checkbox';
    const decisionsHelp = el(
      'p',
      'pub-help',
      'Readers confirm approvals and rejections with their own passkey.'
    );
    decisionsHelp.id = `${id}-decisions-help`;
    decisions.setAttribute('aria-describedby', decisionsHelp.id);
    const decisionOption = el('div', 'pub-option');
    decisionOption.append(
      reviewChoice(decisions, 'Allow decisions'),
      decisionsHelp
    );
    const accessGroup = el('fieldset', 'pub-group');
    accessGroup.setAttribute('aria-describedby', accessHelp.id);
    accessGroup.append(
      el('legend', '', 'Access'),
      choices,
      accessHelp,
      setup,
      ttlField.row,
      decisionOption
    );

    const title = el('input', 'pub-input pub-title');
    title.value = normalizeTitle(sourceName);
    title.spellcheck = false;
    title.autocomplete = 'off';
    const titleField = reviewField(
      `${id}-title`,
      'Public title',
      title,
      'Defaults to the original source name. Relik and link preview services can read it without the key. Clear the field to omit it.'
    );
    const cover = el('input', 'pub-cover');
    cover.type = 'checkbox';
    const makeCover = prepare === undefined ? undefined : adapter.generateCover;
    cover.disabled = makeCover === undefined;
    const coverStatus = el('p', 'pub-help');
    coverStatus.id = `${id}-cover-help`;
    coverStatus.setAttribute('role', 'status');
    cover.setAttribute('aria-describedby', coverStatus.id);
    const preview = el('div', 'pub-preview');
    preview.hidden = true;
    const coverOption = el('div', 'pub-option');
    coverOption.append(
      reviewChoice(cover, 'Include a public preview image'),
      coverStatus,
      preview
    );
    const publicGroup = el('fieldset', 'pub-group');
    publicGroup.append(
      el('legend', '', 'Link preview'),
      titleField.row,
      coverOption
    );

    const notice = el('div', 'notice pub-review-notice');
    notice.id = `${id}-problem`;
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    notice.tabIndex = -1;
    const row = el('div', 'pub-row');
    const go = labelled(
      el('button', 'action primary'),
      'Encrypt and publish',
      ICONS.upload
    );
    go.type = 'submit';
    row.append(
      go,
      onClose === undefined
        ? action('Choose a different file', ICONS.back, () => idle())
        : action('Cancel', ICONS.back, onClose)
    );
    card.append(
      heading,
      el(
        'p',
        'pub-meta',
        formatBytes(directory?.plaintextLength ?? file!.size)
      ),
      sourceGroup,
      accessGroup,
      publicGroup,
      el(
        'p',
        'pub-help pub-new-link',
        'Publishing makes a new link and leaves existing relics unchanged. This page encrypts your file with code served by Relik.'
      ),
      notice,
      row
    );

    let live = true;
    let editedName = false;
    let invalidField: HTMLInputElement | undefined;
    let folder: ReviewedFolderSource | undefined = directory;
    let loadingFolder = false;
    let folderScope: AbortController | undefined;
    let setupScope: AbortController | undefined;
    let privateSettings:
      | Extract<PublishPrivateSetup, { kind: 'ready' }>
      | undefined;
    let coverRevision = 0;
    let coverScope: AbortController | undefined;
    let coverUrl: string | undefined;
    let approved:
      | {
          cover: ApprovedCover;
          source: ReviewedPublishSource;
          openFirst: string | undefined;
        }
      | undefined;

    const effectiveName = (): string =>
      editedName ? filename.value : defaultName();
    const entry = (): string | undefined =>
      folderSelected() && openFirst.value !== '' ? openFirst.value : undefined;
    const currentCover = () =>
      approved !== undefined &&
      approved.source.filename === effectiveName() &&
      (approved.source.shape === 'folder') === folderSelected() &&
      approved.openFirst === entry()
        ? approved
        : undefined;
    const blocked = (): boolean =>
      (folderSelected() && folder === undefined) ||
      (privateMode.checked
        ? privateSettings === undefined
        : cover.checked && currentCover() === undefined);
    const syncSubmit = (): void => {
      go.disabled = blocked();
    };

    const clearProblem = (): void => {
      notice.hidden = true;
      invalidField?.removeAttribute('aria-invalid');
      invalidField?.removeAttribute('aria-errormessage');
      invalidField = undefined;
    };
    const showProblem = (message: string, input?: HTMLInputElement): void => {
      clearProblem();
      notice.textContent = message;
      notice.hidden = false;
      invalidField = input;
      if (input === undefined) {
        notice.focus();
      } else {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-errormessage', notice.id);
        input.focus();
      }
    };

    const disposeCover = (): void => {
      coverRevision += 1;
      coverScope?.abort();
      coverScope = undefined;
      approved = undefined;
      preview.hidden = true;
      preview.replaceChildren();
      if (coverUrl !== undefined) URL.revokeObjectURL(coverUrl);
      coverUrl = undefined;
    };
    const noCoverLabel =
      makeCover === undefined
        ? 'Custom images are unavailable here. Link previews use the generic Relik image.'
        : 'Anyone can read a public preview image without the key. Leave it off to use the generic Relik image.';
    const reviewFolder = (
      name: string,
      chosen: string | undefined
    ): ReviewedFolderSource => {
      if (folder === undefined)
        throw new Error('The folder needs to be reviewed first.');
      return folder.withSelection(name, chosen);
    };
    const refreshCover = async (): Promise<void> => {
      disposeCover();
      syncSubmit();
      coverStatus.textContent = noCoverLabel;
      if (
        privateMode.checked ||
        !cover.checked ||
        prepare === undefined ||
        makeCover === undefined
      )
        return;
      if (folderSelected() && folder === undefined) {
        coverStatus.textContent =
          'A preview needs the reviewed folder entries.';
        return;
      }
      const revision = coverRevision;
      const scope = new AbortController();
      coverScope = scope;
      const name = effectiveName();
      const chosen = entry();
      const active = (): boolean => live && revision === coverRevision;
      const useGeneric = 'Uncheck to use the generic Relik image.';
      coverStatus.textContent = 'Preparing the preview on this device.';
      try {
        const source = folderSelected()
          ? reviewFolder(name, chosen)
          : await prepare(file!, {
              filename: name,
              expand: false,
              signal: scope.signal,
            });
        if (!active()) return;
        const result = await makeCover(source.preview);
        if (!active()) return;
        if (result.status !== 'ready') {
          coverStatus.textContent =
            result.status === 'unsupported'
              ? `A public preview is unavailable: ${result.reason} ${useGeneric}`
              : `Could not prepare the preview: ${result.reason} ${useGeneric}`;
          return;
        }
        const image = el('img', '');
        image.alt = 'Public link preview';
        image.width = 1200;
        image.height = 630;
        image.addEventListener(
          'load',
          () => {
            if (!active()) return;
            approved = { cover: result.preview, source, openFirst: chosen };
            preview.hidden = false;
            coverStatus.textContent =
              'Anyone with the link can see this image without the key. Publishing uploads the image as shown.';
            syncSubmit();
          },
          { once: true }
        );
        image.addEventListener(
          'error',
          () => {
            if (!active()) return;
            disposeCover();
            coverStatus.textContent = `Could not show the preview. ${useGeneric}`;
            syncSubmit();
          },
          { once: true }
        );
        coverUrl = URL.createObjectURL(result.preview.blob);
        preview.replaceChildren(image);
        image.src = coverUrl;
      } catch {
        if (active())
          coverStatus.textContent = `Could not prepare the preview. ${useGeneric}`;
      }
    };

    const syncFolder = (): void => {
      nameField.label.textContent = folderSelected()
        ? 'Encrypted folder name'
        : 'Encrypted filename';
      folderDetails.hidden = !folderSelected() || folder === undefined;
      entryField.row.hidden = !folderSelected() || folder === undefined;
      zipStatus.hidden = !folderSelected() || zipStatus.textContent === '';
      if (folder !== undefined) {
        const count = folder.entries.length;
        const omitted = folder.omissions.length;
        entryField.help.textContent = `${count} ${count === 1 ? 'file' : 'files'} included.${omitted === 0 ? '' : ` ${omitted} omitted.`} Opens first: ${entry() ?? folder.defaultEntry}`;
      }
      syncSubmit();
    };
    const checkFolder = async (): Promise<void> => {
      if (
        !folderSelected() ||
        (prepare === undefined && folder === undefined) ||
        (folder !== undefined && openFirst.options.length > 0) ||
        loadingFolder
      )
        return;
      loadingFolder = true;
      const scope = new AbortController();
      folderScope = scope;
      zipStatus.textContent = 'Checking folder entries on this device.';
      syncFolder();
      try {
        const source =
          folder ??
          (await prepare!(file!, { expand: true, signal: scope.signal }));
        if (!live || scope.signal.aborted || !folderSelected()) return;
        if (source.shape !== 'folder')
          throw new Error('Could not read this ZIP as a folder.');
        folder = source;
        const automatic = el('option', '', 'Automatic');
        automatic.value = '';
        const list = document.createDocumentFragment();
        list.append(automatic);
        for (const item of source.entries) {
          const option = el('option', '', item.path);
          option.value = item.path;
          list.append(option);
        }
        openFirst.replaceChildren(list);
        const counts = new Map<string, number>();
        for (const omission of source.omissions)
          counts.set(omission.reason, (counts.get(omission.reason) ?? 0) + 1);
        const detail = el(
          'p',
          'pub-help',
          counts.size
            ? `Left out ${source.omissions.length}: ${[...counts].map(([reason, count]) => `${reason.replaceAll('_', ' ')}: ${count}`).join(', ')}.`
            : 'Nothing left out.'
        );
        const warnings: HTMLElement[] = [];
        if (source.source === 'directory')
          warnings.push(
            el(
              'p',
              'pub-help',
              'Ignore rules were applied by this page, not by Git.'
            )
          );
        if (isFolder && entries.length > 0)
          warnings.push(
            el(
              'p',
              'pub-help',
              'Your browser does not tell this page about shortcuts or symbolic links, so check the list before you publish.'
            )
          );
        const fileList = el('div', 'pub-file-list');
        fileList.setAttribute('role', 'list');
        fileList.setAttribute('aria-label', 'Files to publish');
        fileList.tabIndex = 0;
        const rowHeight = 32;
        fileList.style.height = `min(14rem, ${source.entries.length * rowHeight}px)`;
        const paint = (): void => {
          const first = Math.max(
            0,
            Math.floor(fileList.scrollTop / rowHeight) - 2
          );
          const last = Math.min(source.entries.length, first + 14);
          const before = el('div', '');
          before.style.height = `${first * rowHeight}px`;
          const after = el('div', '');
          after.style.height = `${(source.entries.length - last) * rowHeight}px`;
          const rows = source.entries.slice(first, last).map((item, index) => {
            const row = el(
              'div',
              'pub-file-row',
              `${item.path} (${formatBytes(item.size)})`
            );
            row.title = item.path;
            row.setAttribute('role', 'listitem');
            row.setAttribute('aria-setsize', String(source.entries.length));
            row.setAttribute('aria-posinset', String(first + index + 1));
            return row;
          });
          fileList.replaceChildren(before, ...rows, after);
        };
        fileList.addEventListener('scroll', paint);
        paint();
        folderDetails.replaceChildren(detail, ...warnings, fileList);
        zipStatus.textContent = '';
      } catch (error) {
        if (!live || scope.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : 'Could not expand this ZIP.';
        zipStatus.textContent = `${message} You can publish the ZIP as one file instead.`;
      } finally {
        if (folderScope === scope) {
          folderScope = undefined;
          loadingFolder = false;
          if (live) {
            syncFolder();
            if (folderSelected() && cover.checked) void refreshCover();
          }
        }
      }
    };

    const updateExpiry = (): void => {
      ttl.placeholder = privateMode.checked
        ? 'Service default'
        : 'Until removed';
      ttlField.help.textContent = !privateMode.checked
        ? `Leave blank for no expiry, or enter 1 to ${MAX_PUBLIC_TTL_DAYS} days.`
        : privateSettings === undefined
          ? 'Private relics always expire. Set up private access to see the available lifetime.'
          : `Leave blank for the service default of ${privateSettings.defaultTtlDays} days, or enter 1 to ${privateSettings.maxTtlDays}.`;
    };
    const disposeSetup = (): void => {
      setupScope?.abort();
      setupScope = undefined;
      privateSettings = undefined;
      setupSlot.replaceChildren();
    };
    const preparePrivate = async (): Promise<void> => {
      if (!privateMode.checked || adapter.setupPrivate === undefined) return;
      disposeSetup();
      retrySetup.hidden = true;
      setupStatus.textContent = 'Checking private publishing.';
      const scope = new AbortController();
      setupScope = scope;
      const slot = el('div', 'pub-private-controls');
      setupSlot.append(slot);
      updateExpiry();
      syncSubmit();
      let result: PublishPrivateSetup;
      try {
        result = await adapter.setupPrivate(slot, scope.signal);
      } catch {
        result = {
          kind: 'blocked',
          message: 'Could not prepare private publishing. Try again.',
          retryable: true,
        };
      }
      if (!live || scope.signal.aborted) return;
      setupSlot.replaceChildren();
      if (result.kind === 'blocked') {
        setupStatus.textContent = result.message;
        retrySetup.hidden = result.retryable !== true;
      } else if (
        Number.isSafeInteger(result.defaultTtlDays) &&
        Number.isSafeInteger(result.maxTtlDays) &&
        result.defaultTtlDays >= 1 &&
        result.defaultTtlDays <= result.maxTtlDays &&
        typeof result.owner?.identityId === 'string' &&
        result.owner.identityId.length > 0 &&
        typeof result.owner.email === 'string' &&
        result.owner.email.length > 0
      ) {
        privateSettings = result;
        setupStatus.textContent = `Private owner: ${result.owner.email}. Review your options, then publish.`;
      } else {
        setupStatus.textContent =
          'The service did not provide a usable private identity or expiration policy.';
        retrySetup.hidden = false;
      }
      updateExpiry();
      syncSubmit();
    };
    const syncMode = (): void => {
      const isPrivate = privateMode.checked;
      publicGroup.hidden = isPrivate;
      publicGroup.disabled = isPrivate;
      setup.hidden = !isPrivate;
      accessHelp.textContent = isPrivate
        ? 'The link contains no key. Readers need a passkey and your permission to open it. Private relics have no public title or preview image.'
        : 'The link contains the key. Anyone who has it can read the file.';
      if (adapter.setupPrivate === undefined)
        accessHelp.textContent += ' Private publishing is unavailable here.';
      if (isPrivate) cover.checked = false;
      if (!isPrivate) disposeSetup();
      updateExpiry();
      void refreshCover();
      if (isPrivate) void preparePrivate();
    };

    filename.addEventListener('input', () => {
      editedName = true;
      if (cover.checked) {
        disposeCover();
        coverStatus.textContent =
          'Leave the encrypted name field to refresh the preview.';
        syncSubmit();
      }
    });
    filename.addEventListener('change', () => {
      if (cover.checked) void refreshCover();
    });
    title.addEventListener('change', () => {
      title.value = normalizeTitle(title.value);
    });
    expand.addEventListener('change', () => {
      if (!expand.checked) {
        folderScope?.abort();
        folderScope = undefined;
        loadingFolder = false;
        zipStatus.textContent = '';
      }
      if (!editedName) filename.value = defaultName();
      syncFolder();
      void refreshCover();
      void checkFolder();
    });
    openFirst.addEventListener('change', () => {
      syncFolder();
      void refreshCover();
    });
    cover.addEventListener('change', () => void refreshCover());
    publicMode.addEventListener('change', syncMode);
    privateMode.addEventListener('change', syncMode);
    card.addEventListener('input', () => {
      clearProblem();
      adapter.dispose?.();
    });
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || blocked()) return;
      if (file !== undefined && file.size > BROWSER_PUBLISH_LIMIT_BYTES) {
        showProblem(
          `This page publishes files up to ${formatBytes(BROWSER_PUBLISH_LIMIT_BYTES)}. Choose a smaller file.`
        );
        return;
      }
      const name = effectiveName();
      if (FILENAME_ENCODER.encode(name).length > MAX_FILENAME_BYTES) {
        showProblem(
          `Use an encrypted name no longer than ${MAX_FILENAME_BYTES} UTF-8 bytes.`,
          filename
        );
        return;
      }
      const max = privateSettings?.maxTtlDays ?? MAX_PUBLIC_TTL_DAYS;
      const days = ttl.value.trim();
      const ttlDays = days === '' ? undefined : Number(days);
      if (
        ttlDays !== undefined &&
        (!/^[0-9]+$/.test(days) ||
          !Number.isSafeInteger(ttlDays) ||
          ttlDays < 1 ||
          ttlDays > max)
      ) {
        showProblem(
          `Enter a whole number of days from 1 to ${max}, or leave it blank.`,
          ttl
        );
        return;
      }
      const chosen = entry();
      const draft: PublishReviewDraft = {
        filename: name,
        title: privateMode.checked ? '' : normalizeTitle(title.value),
        ...(ttlDays === undefined ? {} : { ttlDays }),
        decisions: decisions.checked,
        expand: folderSelected(),
        ...(chosen === undefined ? {} : { openFirst: chosen }),
        cover: !privateMode.checked && cover.checked,
        private: privateMode.checked,
      };
      try {
        const raster = draft.cover ? currentCover() : undefined;
        if (draft.cover && raster === undefined) return;
        const source =
          raster?.source ??
          (draft.expand
            ? reviewFolder(draft.filename, draft.openFirst)
            : undefined);
        const base = {
          ...(file === undefined ? {} : { file }),
          filename: draft.filename,
          ...(draft.ttlDays === undefined ? {} : { ttlDays: draft.ttlDays }),
          decisions: draft.decisions,
          expand: draft.expand,
          ...(draft.openFirst === undefined
            ? {}
            : { openFirst: draft.openFirst }),
          ...(source === undefined ? {} : { source }),
        };
        if (draft.private && privateSettings === undefined) return;
        const submission: PublishReviewSubmission = draft.private
          ? { ...base, private: true, owner: privateSettings!.owner }
          : {
              ...base,
              private: false,
              title: draft.title,
              ...(raster === undefined ? {} : { cover: raster.cover }),
            };
        void start(submission, card, showProblem, () => {
          adapter.dispose?.();
          disposeSetup();
          setupStatus.textContent =
            'Your private owner changed. Set up and review private access again.';
          retrySetup.hidden = false;
          updateExpiry();
          syncSubmit();
        });
      } catch (error) {
        showProblem(
          error instanceof Error
            ? error.message
            : 'Could not review the chosen file.'
        );
      }
    });

    releaseReview = () => {
      live = false;
      folderScope?.abort();
      folderScope = undefined;
      disposeCover();
      disposeSetup();
    };
    show(card);
    heading.focus({ preventScroll: true });
    syncMode();
    syncFolder();
    void checkFolder();
  };

  const done = (
    result: PublishReviewResult,
    submission: PublishReviewSubmission
  ): void => {
    dispose();
    busy = false;
    status.textContent = 'Published. Your link is ready.';

    const card = el('div', 'pub-card');
    card.appendChild(el('h1', 'pub-card-title', 'Published'));
    if (submission.source?.shape === 'folder')
      card.appendChild(
        el(
          'p',
          'pub-meta',
          `Folder published: ${submission.source.entries.length} files. ${submission.source.omissions.length} omitted.`
        )
      );
    card.appendChild(
      el(
        'p',
        'pub-help',
        submission.private
          ? 'This link contains no key. Open the relic with your passkey to manage who can read it.'
          : 'This link holds the key. Copy it now: this page does not keep it, and we cannot recover it for you.'
      )
    );

    const field = el('textarea', 'pub-link');
    field.rows = 3;
    field.readOnly = true;
    field.value = result.url;
    field.setAttribute(
      'aria-label',
      submission.private
        ? 'Private relic link'
        : 'Link, including the decryption key'
    );
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
        () =>
          said(
            submission.private
              ? 'Private link copied.'
              : 'Link copied. It contains the decryption key.',
            'Copied'
          ),
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

    if (!submission.private) {
      card.appendChild(
        el(
          'p',
          'pub-meta',
          result.title === undefined
            ? 'Published without a public title.'
            : `Public title: ${result.title}`
        )
      );
      if (submission.cover !== undefined) {
        card.appendChild(
          el(
            'p',
            'pub-help',
            result.cover?.status === 'uploaded'
              ? 'The public preview image was published.'
              : result.cover?.status === 'refused'
                ? 'The preview image could not be published. The file link is ready.'
                : 'The preview upload could not be confirmed. The file link is ready.'
          )
        );
      }
    }
    if (result.relicExpiresAt !== null) {
      const expiry = el('p', 'pub-meta', 'Expires: ');
      const when = el('time', '', result.relicExpiresAt);
      when.dateTime = result.relicExpiresAt;
      const date = new Date(result.relicExpiresAt);
      if (!Number.isNaN(date.valueOf())) {
        when.textContent = `${new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'UTC',
        }).format(date)} UTC`;
      }
      expiry.append(when);
      card.appendChild(expiry);
    } else {
      card.appendChild(el('p', 'pub-meta', 'Expiry: until removed.'));
    }
    card.appendChild(el('div', 'accession', result.relicId));
    card.appendChild(
      onClose === undefined
        ? action('Publish another', ICONS.upload, () => idle())
        : action('Close', ICONS.back, onClose)
    );
    show(card);
    field.focus();
  };

  const start = async (
    submission: PublishReviewSubmission,
    reviewCard: HTMLFormElement,
    showProblem: (message: string) => void,
    invalidatePrivateReview: () => void
  ): Promise<void> => {
    if (busy) return;
    busy = true;

    const name =
      submission.filename ||
      submission.file?.name ||
      submission.source?.filename ||
      'Folder';
    const heading = el('h1', 'pub-card-title', name);
    heading.tabIndex = -1;
    const label = el('p', 'pub-meta');
    const meter = el('progress', 'pub-meter');
    meter.setAttribute('aria-label', 'Upload progress');
    const card = el('div', 'pub-card');
    card.append(heading, label, meter);
    show(card);
    heading.focus({ preventScroll: true });

    try {
      const result = await adapter.submit(submission, (phase) => {
        const text = phaseText(phase, name);
        label.textContent = text;
        status.textContent = text;
        if (phase.kind === 'uploading' && phase.total > 0) {
          meter.max = phase.total;
          meter.value = phase.sent;
        } else {
          meter.removeAttribute('value');
        }
      });
      if (submission.private) {
        if (new URL(result.url).hash !== '') {
          throw new PublishFailure(
            'service_response_unusable',
            'A private link came back with a fragment. The link was not shown.'
          );
        }
        if (result.relicExpiresAt === null) {
          throw new PublishFailure(
            'service_response_unusable',
            'Private publishing returned no expiration. The link was not shown.'
          );
        }
      }
      done(result, submission);
    } catch (error) {
      busy = false;
      status.textContent = '';
      show(reviewCard);
      if (
        submission.private &&
        error instanceof PrivateRequestError &&
        error.code === 'private_owner_changed'
      ) {
        invalidatePrivateReview();
        showProblem(
          'Your private owner changed. Review private access again before publishing.'
        );
      } else {
        showProblem(
          error instanceof PublishFailure ||
            error instanceof PublishSourceFailure
            ? error.message
            : error instanceof PrivateRequestError &&
                error.code === 'private_publish_in_progress'
              ? 'Publishing may still be finishing. Try again to check its status.'
              : 'Could not finish publishing. No link was shown.'
        );
      }
    }
  };

  return { idle, review, isBusy: () => busy && !readingDirectory, dispose };
}

export async function mountPublish(
  body: HTMLElement,
  adapter?: PublishReviewAdapter
): Promise<void> {
  await loadStylesheet();

  const panel = el('div', 'pub');
  const status = el('div', 'pub-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const publisher = createPublisher(panel, status, adapter);

  const main = el('main', 'stage pub-stage');
  main.appendChild(panel);
  body.replaceChildren(
    buildBar(() =>
      pickFile((dropped) => publisher.review(dropped.files, dropped.isFolder))
    ),
    main
  );
  body.appendChild(status);

  publisher.idle();
}

/**
 * Opens the publisher over whatever page the visitor is on, for a file they
 * dropped there. A modal dialog, so the page behind it cannot be clicked and
 * focus stays inside until it is closed.
 */
export async function openPublishDialog(
  files: File[],
  isFolder: boolean,
  entries: FileSystemEntry[] = [],
  adapter?: PublishReviewAdapter
): Promise<void> {
  if (document.querySelector('dialog.pub-dialog') !== null) return;

  const dialog = el('dialog', 'pub-dialog');
  dialog.setAttribute('aria-label', 'Publish a file');
  const panel = el('div', 'pub');
  const status = el('div', 'pub-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  dialog.append(panel, status);

  const publisher = createPublisher(panel, status, adapter, () =>
    dialog.close()
  );
  // Escape would abandon an upload half-way and leave the visitor not knowing
  // whether anything was published, so it waits until the step has ended.
  dialog.addEventListener('cancel', (event) => {
    if (publisher.isBusy()) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    publisher.dispose();
    dialog.remove();
  });

  // In the document before anything is awaited: a second drop a moment later
  // finds it there and does nothing, rather than opening a second dialog. A
  // closed dialog is not displayed, so nothing shows until `showModal`.
  document.body.appendChild(dialog);
  await loadStylesheet();
  dialog.showModal();
  publisher.review(files, isFolder, entries);
}
