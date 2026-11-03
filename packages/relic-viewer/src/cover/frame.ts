import type { CoverRenderResult } from '@relic/format/cover';
import { transpileJsx } from '../jsx.ts';

export const FRAME_SETTLE_MS = 1_000;
export const FRAME_TIMEOUT_MS = 14_000;

let cachedFrameHtml: string | undefined;

export async function loadFrameHtml(): Promise<string> {
  if (cachedFrameHtml !== undefined) {
    return cachedFrameHtml;
  }
  const res = await fetch('/frame.html');
  if (!res.ok) {
    throw new Error(`Failed to load /frame.html: ${res.status}`);
  }
  cachedFrameHtml = await res.text();
  return cachedFrameHtml;
}

export async function renderFrameCover(
  kind: 'html' | 'jsx',
  source: string,
  dialect: 'jsx' | 'tsx' | undefined,
  root: HTMLElement
): Promise<CoverRenderResult> {
  let codeToSend = source;

  if (kind === 'jsx') {
    const filename = dialect === 'tsx' ? 'component.tsx' : 'component.jsx';
    try {
      codeToSend = transpileJsx(source, filename);
    } catch (err) {
      return {
        ok: false,
        reason: 'parse_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let frameHtml: string;
  try {
    frameHtml = await loadFrameHtml();
  } catch (err) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const cv = document.createElement('div');
  cv.className = `cv cv-${kind}`;

  const main = document.createElement('main');
  main.className = `stage stage-sandboxed-${kind}`;

  const doc = document.createElement('div');
  doc.className = `doc doc-${kind}`;

  const iframe = document.createElement('iframe');
  iframe.className = 'usercontent-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', kind === 'html' ? 'HTML content' : 'Component');

  doc.appendChild(iframe);
  main.appendChild(doc);
  cv.appendChild(main);
  root.replaceChildren(cv);

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timerId: number | undefined;

  function cleanup(): void {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    window.removeEventListener('message', onMessage);
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'relic:sandbox-ready') {
      if (kind === 'html') {
        iframe.contentWindow?.postMessage(
          { type: 'relic:render', html: codeToSend, cover: true },
          '*'
        );
      } else {
        iframe.contentWindow?.postMessage(
          { type: 'relic:render-jsx', code: codeToSend, cover: true },
          '*'
        );
      }
    } else if (data.type === 'relic:tree') {
      cleanup();
      resolve();
    }
  }

  timerId = window.setTimeout(() => {
    cleanup();
    reject(new Error('Frame render timed out waiting for relic:tree'));
  }, FRAME_TIMEOUT_MS);

  window.addEventListener('message', onMessage);
  iframe.srcdoc = frameHtml;

  try {
    await promise;
    const settle = Promise.withResolvers<void>();
    window.setTimeout(settle.resolve, FRAME_SETTLE_MS);
    await settle.promise;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'timeout',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
