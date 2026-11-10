/**
 * In-browser PDF renderer using pdfjs-dist.
 *
 * Renders pages onto a single canvas.relic-page element with pagination
 * controls. Having one live canvas element at a time satisfies the single-canvas
 * requirement of anchorSurfaceFor and provides meaningful page-anchored
 * annotation context.
 */

import * as pdfjsLib from 'pdfjs-dist';

import { MAX_CONTENT_READ_BYTES, type RelicContent } from './content.ts';

const PDF_INITIAL_BYTES = 1024 * 1024;
const PDF_RANGE_CHUNK_SIZE = 65_536;

/**
 * PDF.js transfers range buffers to its worker. RelicContent reads are fresh
 * buffers, so transfers never detach or mutate the Blob used for Download.
 */
export class RelicPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private aborted = false;
  private failed = false;

  constructor(
    private readonly content: RelicContent,
    initialData: Uint8Array,
    private readonly onError: (error: unknown) => void
  ) {
    super(content.size, initialData);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.aborted || this.failed) return;
    void this.readRange(begin, end)
      .then((bytes) => {
        if (!this.aborted && !this.failed) this.onDataRange(begin, bytes);
      })
      .catch((error: unknown) => {
        if (this.aborted || this.failed) return;
        this.failed = true;
        this.onError(error);
      });
  }

  override abort(): void {
    this.aborted = true;
  }

  private async readRange(begin: number, end: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end < begin ||
      end > this.content.size
    ) {
      throw new RangeError('Invalid PDF range');
    }

    const length = end - begin;
    if (length <= MAX_CONTENT_READ_BYTES) {
      const bytes = await this.content.read(begin, end);
      if (bytes.byteLength !== length) throw new Error('Short PDF range read');
      return bytes;
    }

    // PDF.js delivers one contiguous response per range, but its coalesced
    // requests can exceed our store's maximum individual read.
    const bytes = new Uint8Array(length);
    for (let start = begin; start < end; start += MAX_CONTENT_READ_BYTES) {
      if (this.aborted) return new Uint8Array(0);
      const stop = Math.min(start + MAX_CONTENT_READ_BYTES, end);
      const chunk = await this.content.read(start, stop);
      if (chunk.byteLength !== stop - start)
        throw new Error('Short PDF range read');
      bytes.set(chunk, start - begin);
    }
    return bytes;
  }
}

export async function createPdfLoadingTask(
  content: RelicContent,
  signal?: AbortSignal
): Promise<{
  task: pdfjsLib.PDFDocumentLoadingTask;
  failure: Promise<never>;
}> {
  const initialData = await content.read(
    0,
    Math.min(content.size, PDF_INITIAL_BYTES)
  );
  if (signal?.aborted) throw new Error('PDF loading cancelled');
  if (initialData.byteLength !== Math.min(content.size, PDF_INITIAL_BYTES))
    throw new Error('Short PDF initial read');

  const { promise: failure, reject: rejectFailure } =
    Promise.withResolvers<never>();
  // A later range can fail after the document itself has opened.
  void failure.catch(() => undefined);
  const range = new RelicPdfRangeTransport(content, initialData, rejectFailure);
  const task = pdfjsLib.getDocument({
    range,
    length: content.size,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    // The worker fetches only what parsing reaches. With
    // patches/pdfjs-dist@5.4.149.patch parsing stops at each object's endobj, so
    // a whitespace run between objects is never requested.
    disableAutoFetch: true,
    disableStream: true,
  });
  return { task, failure };
}

export async function mountPdf(
  wrapper: HTMLElement,
  content: RelicContent,
  _filename: string
): Promise<() => void> {
  wrapper.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'action';
  prevBtn.textContent = 'Previous';
  prevBtn.disabled = true;

  const indicator = document.createElement('span');
  indicator.className = 'pdf-page-indicator';
  indicator.textContent = 'Loading...';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'action';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = true;

  toolbar.append(prevBtn, indicator, nextBtn);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'pdf-page-container';

  const canvas = document.createElement('canvas');
  canvas.className = 'relic-page';
  canvas.dataset['pageNumber'] = '1';
  canvasWrap.appendChild(canvas);

  wrapper.append(toolbar, canvasWrap);
  let disposed = false;
  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | undefined;
  let renderTask: pdfjsLib.RenderTask | null = null;
  let observer: MutationObserver | undefined;
  let hasConnected = wrapper.isConnected;
  const abort = new AbortController();
  const cancelled = Promise.withResolvers<never>();
  void cancelled.promise.catch(() => undefined);
  const win = wrapper.ownerDocument.defaultView;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    abort.abort();
    cancelled.reject(new Error('PDF loading cancelled'));
    observer?.disconnect();
    wrapper.removeEventListener('cleanup', dispose);
    win?.removeEventListener('pagehide', dispose);
    try {
      renderTask?.cancel();
    } catch {
      // The render may already have completed.
    }
    renderTask = null;
    if (loadingTask) void loadingTask.destroy().catch(() => undefined);
  }

  function showError(): void {
    if (disposed) return;
    wrapper.dispatchEvent(
      new CustomEvent('relic:render-state', { detail: 'error', bubbles: true })
    );
    wrapper.replaceChildren();
    const errorCard = document.createElement('div');
    errorCard.className = 'pdf-status-card';
    const title = document.createElement('p');
    title.className = 'pdf-status-title';
    title.textContent = 'Could not render PDF document';
    const detail = document.createElement('p');
    detail.className = 'thread-note';
    detail.textContent =
      'This document could not be parsed as a PDF by the browser viewer.';
    errorCard.append(title, detail);
    wrapper.appendChild(errorCard);
    dispose();
  }

  wrapper.addEventListener('cleanup', dispose, { once: true });
  win?.addEventListener('pagehide', dispose, { once: true });
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((records) => {
      if (wrapper.isConnected) hasConnected = true;
      else if (
        hasConnected ||
        records.some((record) =>
          Array.from(record.removedNodes).some(
            (node) => node === wrapper || node.contains(wrapper)
          )
        )
      )
        dispose();
    });
    observer.observe(wrapper.ownerDocument, { childList: true, subtree: true });
  }

  try {
    // A task owns its worker, allowing previews to be disposed independently.
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.js';
    const opening = createPdfLoadingTask(content, abort.signal);
    void opening.then(
      ({ task }) => {
        if (disposed) void task.destroy().catch(() => undefined);
      },
      () => undefined
    );
    const opened = await Promise.race([opening, cancelled.promise]);
    if (disposed) {
      if (!opened.task.destroyed)
        void opened.task.destroy().catch(() => undefined);
      return dispose;
    }
    loadingTask = opened.task;
    void opened.failure.catch(showError);
    const pdfDoc = await Promise.race([
      loadingTask.promise,
      opened.failure,
      cancelled.promise,
    ]);
    const numPages = pdfDoc.numPages;
    let currentPage = 1;
    let renderGeneration = 0;

    async function renderPage(pageNum: number): Promise<void> {
      const generation = ++renderGeneration;
      if (renderTask !== null) {
        try {
          renderTask.cancel();
        } catch {
          // Cancellation is expected when quickly navigating pages
        }
        renderTask = null;
      }

      const page = await Promise.race([
        pdfDoc.getPage(pageNum),
        opened.failure,
        cancelled.promise,
      ]);
      if (disposed || generation !== renderGeneration) return;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const targetWidth = Math.min(
        typeof window !== 'undefined' && window.innerWidth > 900
          ? 800
          : (typeof window !== 'undefined' ? window.innerWidth : 800) - 60,
        900
      );
      const scale = targetWidth / unscaledViewport.width;
      const dpr =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const viewport = page.getViewport({ scale: scale * dpr });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      canvas.dataset['pageNumber'] = String(pageNum);
      indicator.textContent = `Page ${pageNum} of ${numPages}`;
      prevBtn.disabled = pageNum <= 1;
      nextBtn.disabled = pageNum >= numPages;

      canvas.dispatchEvent(
        new CustomEvent('relic:page-changed', {
          detail: { page: pageNum },
          bubbles: true,
        })
      );

      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const task = page.render({ canvasContext: ctx, viewport, canvas });
      renderTask = task;
      try {
        await Promise.race([task.promise, opened.failure, cancelled.promise]);
      } catch (err: unknown) {
        if (
          (err as { name?: string })?.name === 'RenderingCancelledException'
        ) {
          return;
        }
        throw err;
      }
      if (renderTask === task) renderTask = null;
    }

    prevBtn.addEventListener(
      'click',
      () => {
        if (currentPage > 1) {
          currentPage -= 1;
          void renderPage(currentPage).catch(showError);
        }
      },
      { signal: abort.signal }
    );

    nextBtn.addEventListener(
      'click',
      () => {
        if (currentPage < numPages) {
          currentPage += 1;
          void renderPage(currentPage).catch(showError);
        }
      },
      { signal: abort.signal }
    );

    wrapper.addEventListener(
      'relic:turn-page',
      (event: Event) => {
        const customEvent = event as CustomEvent<{ page: number }>;
        const detail = customEvent.detail;
        if (
          detail !== undefined &&
          detail.page >= 1 &&
          detail.page <= numPages &&
          detail.page !== currentPage
        ) {
          currentPage = detail.page;
          void renderPage(currentPage).catch(showError);
        }
      },
      { signal: abort.signal }
    );

    await renderPage(1);
    if (!disposed) {
      wrapper.dispatchEvent(
        new CustomEvent('relic:render-state', {
          detail: 'ready',
          bubbles: true,
        })
      );
    }
  } catch {
    showError();
  }
  return dispose;
}
