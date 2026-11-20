/**
 * The DOM layer.
 *
 * Everything that decides anything lives in `viewer.ts`, which has no DOM in
 * it and is tested directly. This file only draws what that decided, so the
 * rules cannot quietly diverge from their tests.
 *
 * Two things here are security, not presentation:
 *
 * 1. **Content reaches the DOM through `textContent` or through the escaping
 *    renderer, never through `innerHTML` on raw bytes.**
 * 2. **HTML content is never rendered on this origin.** It goes to the
 *    usercontent origin through an iframe that gets the markup and never the
 *    key.
 */

import { button, ICONS, icon, toast, WORDMARK } from './chrome.ts';
import { transpileJsx } from './jsx.ts';
import { highlightCode, renderMarkdown } from './markdown.ts';
import { mountPublish } from './publish-view.ts';
import {
  type DeadView,
  formatBytes,
  type KeyVault,
  load,
  type ReadyView,
  type ViewerDeps,
} from './viewer.ts';

const SERVICE_ORIGIN =
  typeof window === 'undefined' ? '' : window.location.origin;

/**
 * The marker beside the actions, in one place.
 *
 * It is the visible label, the accessible name, and the stem of the tooltip,
 * and it was three separate strings until two of them disagreed.
 */
const MARKER_LABEL = 'Runs author code, isolated';

/**
 * The filename is untrusted and is used here as a lookup key, which is the
 * same defect class as archive entry names. Path separators and leading dots
 * are stripped rather than trusted.
 */
export function safeDownloadName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'relic';
}

/**
 * The mimetype handed to a Blob is derived from magic bytes, never from the
 * declared type. A declared `image/svg+xml` would otherwise be a route into
 * script execution, which is why SVG is classified as a web page instead.
 */
export function sniffImageType(content: Uint8Array): string {
  const starts = (...bytes: number[]): boolean =>
    bytes.every((byte, index) => content[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    content[8] === 0x57 &&
    content[9] === 0x45
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function decodeText(content: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(content);
}

/**
 * A one-off statement above the content.
 *
 * The pre-render statement that used to greet every sandboxed relic is gone,
 * demoted to a marker in the bar, because the risk it described was removed.
 * This remains for the cases that are genuinely about this file: a downgrade,
 * or a component that would not compile. Those are conditions of the content
 * in front of the reader, not a standing warning.
 */
function notice(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'notice';
  element.appendChild(icon(ICONS.flag));
  const span = document.createElement('span');
  span.textContent = text;
  element.appendChild(span);
  return element;
}

function downloadContent(view: ReadyView): void {
  const blob = new Blob([view.content as unknown as BlobPart], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(view.filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The taskbar, built as an accession label rather than app chrome.
 *
 * The relic ID is a catalog number and reads as one: monospace, letterspaced,
 * selectable. The filename is untrusted display text and goes in through
 * `textContent`.
 */
export function buildBar(view: ReadyView, relicId: string): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'bar';

  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);

  const identity = document.createElement('div');
  identity.className = 'identity';

  const name = document.createElement('div');
  name.className = 'filename';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';
  name.title = view.filename;

  const accession = document.createElement('div');
  accession.className = 'accession';
  accession.textContent = relicId;

  identity.append(name, accession);
  bar.appendChild(identity);

  const actions = document.createElement('div');
  actions.className = 'actions';

  // A statement of fact, sitting with the actions rather than above the
  // content. It used to be a banner, and the risk it warned about, content
  // reaching the network, no longer exists.
  //
  // It collapses to its icon at narrow widths exactly like the buttons beside
  // it. Keeping this label while hiding theirs put a fact ahead of the
  // actions and pushed Report off the row, so the accessible name carries the
  // meaning once the text is gone.
  const marker = document.createElement('a');
  marker.className = 'action marker';
  marker.href = `${SERVICE_ORIGIN}/policy`;
  marker.rel = 'noopener noreferrer';
  // One string for the label and the accessible name, because WCAG 2.5.3
  // wants the name to contain the visible text and these had drifted: the
  // label read "Runs author code" while the name read "the author's code",
  // which is exactly the mismatch that breaks speech control.
  marker.setAttribute('aria-label', MARKER_LABEL);
  marker.title = `${MARKER_LABEL}. What Relic knows.`;
  marker.appendChild(icon(ICONS.source));
  const markerText = document.createElement('span');
  markerText.textContent = MARKER_LABEL;
  marker.appendChild(markerText);
  actions.appendChild(marker);

  // The fragment was stripped from the address bar, so re-sharing has to come
  // from somewhere. This is that affordance, backed by the in-memory key.
  actions.appendChild(
    button('Copy link', ICONS.copy, () => {
      void navigator.clipboard.writeText(view.shareUrl).then(
        () => toast('Link copied. It contains the decryption key.'),
        () => toast('Could not copy. Copy the link from where you opened it.')
      );
    })
  );

  actions.appendChild(
    button('Download', ICONS.download, () => downloadContent(view))
  );

  const report = document.createElement('a');
  report.className = 'action';
  report.href = `${SERVICE_ORIGIN}/abuse`;
  report.rel = 'noopener noreferrer';
  report.appendChild(icon(ICONS.flag));
  const reportText = document.createElement('span');
  reportText.textContent = 'Report';
  report.appendChild(reportText);
  actions.appendChild(report);

  bar.appendChild(actions);
  return bar;
}

function renderMarkdownView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);

  const prose = document.createElement('article');
  prose.className = 'prose';
  // renderMarkdown escapes before it adds markup, and nothing in the source
  // can become an element. That property is asserted directly in
  // test/markdown.test.ts against fifteen attack payloads.
  prose.innerHTML = renderMarkdown(source);

  const raw = document.createElement('pre');
  raw.className = 'raw';
  raw.hidden = true;
  raw.textContent = source;

  let showingSource = false;
  const toggle = button('View source', ICONS.source, () => {
    showingSource = !showingSource;
    prose.hidden = showingSource;
    raw.hidden = !showingSource;
    toggle.replaceChildren();
    toggle.appendChild(icon(showingSource ? ICONS.rendered : ICONS.source));
    const label = document.createElement('span');
    label.textContent = showingSource ? 'View rendered' : 'View source';
    toggle.appendChild(label);
  });

  const toggleRow = document.createElement('div');
  toggleRow.className = 'toggle-row';
  toggleRow.appendChild(toggle);

  wrapper.append(toggleRow, prose, raw);
  return wrapper;
}

function renderCodeView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);
  const lines = source.split('\n');

  const table = document.createElement('div');
  table.className = 'code';

  const gutter = document.createElement('pre');
  gutter.className = 'gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_line, index) => index + 1).join('\n');

  const body = document.createElement('pre');
  body.className = 'code-body';
  // highlightCode escapes before it marks up.
  body.innerHTML = highlightCode(source);

  table.append(gutter, body);
  wrapper.appendChild(table);
  return wrapper;
}

function renderImageView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-image';

  const blob = new Blob([view.content as unknown as BlobPart], {
    type: sniffImageType(view.content),
  });
  const url = URL.createObjectURL(blob);

  const image = document.createElement('img');
  image.src = url;
  image.alt = view.filename;
  image.addEventListener('load', () => URL.revokeObjectURL(url));
  image.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    wrapper.replaceChildren(
      notice('This image could not be decoded by the browser.')
    );
  });

  wrapper.appendChild(image);
  return wrapper;
}

/**
 * HTML renders on the usercontent origin and nowhere else.
 *
 * The iframe carries `sandbox` without `allow-same-origin`, so the document
 * lands in an opaque origin: it cannot reach this origin, it cannot reach
 * the usercontent origin's storage, and it cannot read `parent.location`.
 * The markup is posted in; the key never is.
 */
export function renderSandboxedHtml(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-html';

  const frame = document.createElement('iframe');
  frame.className = 'usercontent-frame';
  // Scripts and nothing else. Popups are removed by dropping the flag, not
  // by CSP: a popup opens a new top-level context this frame's policy does
  // not govern.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = `${usercontentOrigin}/sandbox.html`;
  frame.title = view.filename;

  const html = decodeText(view.content);

  // An opaque-origin frame has no origin to target, so '*' is the only option
  // the platform offers. It is safe here because the payload is the content
  // that frame is about to display anyway. The key is never in it.
  const post = (): void => {
    frame.contentWindow?.postMessage({ type: 'relic:render', html }, '*');
  };

  // Both paths, because the race runs in either direction: `load` can fire
  // before the frame's own script attaches its listener, and the frame's
  // ready message can arrive before `load`. The frame renders at most once,
  // so posting twice is harmless and losing the message is not.
  const onReady = (event: MessageEvent): void => {
    if (
      event.source === frame.contentWindow &&
      (event.data as { type?: unknown } | null)?.type === 'relic:sandbox-ready'
    ) {
      post();
      window.removeEventListener('message', onReady);
    }
  };
  window.addEventListener('message', onReady);
  frame.addEventListener('load', post);

  wrapper.appendChild(frame);
  return wrapper;
}

/**
 * A component renders on the usercontent origin and nowhere else, exactly
 * like HTML, but what crosses the frame boundary is different: the source is
 * transpiled here, on the service origin, into plain JavaScript first.
 *
 * The service origin must never execute relic content, and the transform
 * never does: it is a text-to-text rewrite, and its output is posted as a
 * string. The frame turns that string back into running code by importing it
 * as a module, and supplies React from a CDN because an opaque origin cannot
 * fetch same-origin assets.
 */
export function renderSandboxedJsx(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-jsx';

  let code: string;
  try {
    code = transpileJsx(decodeText(view.content), view.filename);
  } catch {
    // Routing already established the bytes parse, so landing here means a
    // path the route decision could not see. Source view is the honest
    // fallback: it shows exactly what was published without running it.
    wrapper.appendChild(
      notice(
        'This file is named like a React component, but its contents do not ' +
          'compile as one. It is shown as source.'
      )
    );
    wrapper.appendChild(renderCodeView(view));
    return wrapper;
  }

  const frame = document.createElement('iframe');
  frame.className = 'usercontent-frame';
  // Scripts and nothing else, as with the HTML route: a popup would open a
  // top-level context this frame's policy does not govern, so the flag is
  // dropped rather than left to CSP.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = `${usercontentOrigin}/sandbox.html`;
  frame.title = view.filename;

  // An opaque-origin frame has no origin to target, so '*' is the only option
  // the platform offers, for the same reason as the HTML route: the payload
  // is the content that frame is about to display anyway, and the key is
  // never in it.
  const post = (): void => {
    frame.contentWindow?.postMessage({ type: 'relic:render-jsx', code }, '*');
  };

  // Both paths, as with HTML: `load` can fire before the frame's script
  // attaches its listener, and the ready message can arrive before `load`.
  // The frame renders at most once, so posting twice is harmless and losing
  // the message is not.
  const onReady = (event: MessageEvent): void => {
    if (
      event.source === frame.contentWindow &&
      (event.data as { type?: unknown } | null)?.type === 'relic:sandbox-ready'
    ) {
      post();
      window.removeEventListener('message', onReady);
    }
  };
  window.addEventListener('message', onReady);
  frame.addEventListener('load', post);

  wrapper.appendChild(frame);
  return wrapper;
}

function renderDownloadView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-download';

  const card = document.createElement('div');
  card.className = 'card';

  const name = document.createElement('div');
  name.className = 'card-title';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${view.declaredMimetype} · ${formatBytes(view.content.length)}`;

  const action = button('Download', ICONS.download, () =>
    downloadContent(view)
  );
  action.classList.add('primary');

  const note = document.createElement('p');
  note.className = 'card-note';
  note.textContent =
    'This kind of file is not displayed in the browser. It has already been ' +
    'decrypted here, so downloading it does not contact the service again.';

  card.append(name, meta, action, note);
  wrapper.appendChild(card);
  return wrapper;
}

function renderReady(
  view: ReadyView,
  relicId: string,
  usercontentOrigin: string
): void {
  document.body.replaceChildren(buildBar(view, relicId));

  const main = document.createElement('main');
  main.className = `stage stage-${view.route}`;

  if (view.downgradeNotice !== undefined) {
    main.appendChild(notice(view.downgradeNotice));
  }

  switch (view.route) {
    case 'markdown':
      main.appendChild(renderMarkdownView(view));
      break;
    case 'code':
      main.appendChild(renderCodeView(view));
      break;
    case 'image':
      main.appendChild(renderImageView(view));
      break;
    case 'sandboxed-html':
      main.appendChild(renderSandboxedHtml(view, usercontentOrigin));
      break;
    case 'sandboxed-jsx':
      main.appendChild(renderSandboxedJsx(view, usercontentOrigin));
      break;
    default:
      main.appendChild(renderDownloadView(view));
      break;
  }

  document.body.appendChild(main);
}

function renderDead(dead: DeadView): void {
  const bar = document.createElement('header');
  bar.className = 'bar';
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);
  document.body.replaceChildren(bar);

  const main = document.createElement('main');
  main.className = 'stage stage-dead';

  const card = document.createElement('div');
  card.className = 'card';

  const headline = document.createElement('h1');
  headline.className = 'card-title';
  headline.textContent = dead.headline;

  const detail = document.createElement('p');
  detail.className = 'card-note';
  detail.textContent = dead.detail;

  card.append(headline, detail);

  if (dead.action === 'retry') {
    const retry = button('Try again', ICONS.rendered, () =>
      window.location.reload()
    );
    retry.classList.add('primary');
    card.appendChild(retry);
  }
  if (dead.action === 'report') {
    const link = document.createElement('a');
    link.className = 'action primary';
    link.href = `${SERVICE_ORIGIN}/abuse`;
    link.textContent = 'Contact us';
    card.appendChild(link);
  }

  const code = document.createElement('div');
  code.className = 'accession';
  code.textContent = dead.code;
  card.appendChild(code);

  main.appendChild(card);
  document.body.appendChild(main);
}

const VAULT_PREFIX = 'relic:key:';

/**
 * Keys remembered in this browser's storage for the service origin.
 *
 * Storage can be absent or refuse to write: private browsing, a quota, an
 * embedded webview, or a user who has blocked site data. None of that should
 * cost somebody the relic they are currently looking at, so every operation
 * degrades to doing nothing. The worst case is the behaviour that existed
 * before this: a reload asks for the original link.
 *
 * Entries carry their relic's expiry and are swept on every read, so storage
 * does not accumulate keys to relics that stopped existing days ago.
 */
export function localStorageKeyVault(
  storage: Storage | undefined = globalThis.localStorage,
  now: () => number = Date.now
): KeyVault {
  const read = (): Storage | undefined => {
    try {
      // Touching localStorage throws outright in some embedded contexts,
      // rather than being absent, so the guard has to be a try and not a null
      // check.
      return storage ?? undefined;
    } catch {
      return undefined;
    }
  };

  const sweep = (store: Storage): void => {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name === null || !name.startsWith(VAULT_PREFIX)) continue;
      try {
        const entry = JSON.parse(store.getItem(name) ?? '') as {
          expiresAt?: number | null;
        };
        // null is how a never-expires entry is persisted; JSON has no
        // Infinity. Any other non-number is corruption, and swept.
        if (
          (entry.expiresAt !== null && typeof entry.expiresAt !== 'number') ||
          (typeof entry.expiresAt === 'number' && entry.expiresAt <= now())
        ) {
          stale.push(name);
        }
      } catch {
        // Unreadable entry. Not ours to interpret, and not worth keeping.
        stale.push(name);
      }
    }
    for (const name of stale) store.removeItem(name);
  };

  return {
    remember(relicId, fragment, expiresAt) {
      const store = read();
      if (store === undefined) return;
      // NaN stays refused: an unparsable date is corruption, not forever.
      // Infinity passes, because a relic with no lifetime is worth keeping
      // the key for until it is deleted.
      if (Number.isNaN(expiresAt) || expiresAt <= now()) return;
      try {
        store.setItem(
          `${VAULT_PREFIX}${relicId}`,
          JSON.stringify({
            fragment,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
          })
        );
      } catch {
        // Quota, or storage disabled mid-session. A remembered key is a
        // convenience; failing to store one is not worth an error page.
      }
    },

    recall(relicId) {
      const store = read();
      if (store === undefined) return undefined;
      try {
        sweep(store);
        const raw = store.getItem(`${VAULT_PREFIX}${relicId}`);
        if (raw === null) return undefined;
        const entry = JSON.parse(raw) as {
          fragment?: unknown;
          expiresAt?: unknown;
        };
        if (typeof entry.fragment !== 'string') return undefined;
        if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now()) {
          return undefined;
        }
        // null means never expires. Anything else that is not a number is
        // corruption, and recalls nothing.
        if (entry.expiresAt !== null && typeof entry.expiresAt !== 'number') {
          return undefined;
        }
        return entry.fragment;
      } catch {
        return undefined;
      }
    },

    forget(relicId) {
      const store = read();
      if (store === undefined) return;
      try {
        store.removeItem(`${VAULT_PREFIX}${relicId}`);
      } catch {
        // Nothing to do, and nothing worth telling the reader about.
      }
    },
  };
}

export function makeBrowserDeps(): ViewerDeps {
  return {
    serviceOrigin: SERVICE_ORIGIN,
    fetch: globalThis.fetch.bind(globalThis),
    keyVault: localStorageKeyVault(),
    takeFragment: () => window.location.hash,
    stripFragment: () => {
      // Replace the current entry with the fragment removed. The URL that
      // carried it already existed, so this shrinks the window rather than
      // closing it.
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    },
    locationHref: window.location.href,
  };
}

async function main(): Promise<void> {
  const root = document.getElementById('relic-root');
  const usercontentOrigin = root?.dataset['usercontentOrigin'] ?? '';

  // The root path has no relic in it. The server marks that shell so this
  // page offers publishing instead of trying to open an id called "Relic".
  if (root?.dataset['mode'] === 'publish') {
    mountPublish(document.body);
    return;
  }

  const relicId = root?.dataset['relicId'] ?? '';
  const state = await load(relicId, makeBrowserDeps());

  if (state.kind === 'ready')
    renderReady(state.view, relicId, usercontentOrigin);
  else if (state.kind === 'dead') renderDead(state.dead);
}

if (typeof document !== 'undefined') {
  void main();
}
