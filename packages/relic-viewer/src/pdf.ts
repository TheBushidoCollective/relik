/**
 * In-browser PDF renderer using pdfjs-dist.
 *
 * Renders pages onto a single canvas.relic-page element with pagination
 * controls. Having one live canvas element at a time satisfies the single-canvas
 * requirement of anchorSurfaceFor and provides meaningful page-anchored
 * annotation context.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Point to the same-origin worker bundle served under /assets/ as an ES module worker
if (typeof Worker !== 'undefined') {
  try {
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
      '/assets/pdf.worker.js',
      { type: 'module' }
    );
  } catch {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.js';
  }
}

export async function mountPdf(
  wrapper: HTMLElement,
  content: Uint8Array,
  _filename: string
): Promise<void> {
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

  try {
    const loadingTask = pdfjsLib.getDocument({ data: content });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    let currentPage = 1;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null =
      null;

    async function renderPage(pageNum: number): Promise<void> {
      if (renderTask !== null) {
        try {
          renderTask.cancel();
        } catch {
          // Cancellation is expected when quickly navigating pages
        }
        renderTask = null;
      }

      const page = await pdfDoc.getPage(pageNum);
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
        await task.promise;
      } catch (err: unknown) {
        if (
          (err as { name?: string })?.name === 'RenderingCancelledException'
        ) {
          return;
        }
        throw err;
      }
      renderTask = null;
    }

    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage -= 1;
        void renderPage(currentPage);
      }
    });

    nextBtn.addEventListener('click', () => {
      if (currentPage < numPages) {
        currentPage += 1;
        void renderPage(currentPage);
      }
    });

    wrapper.addEventListener('relic:turn-page', (event: Event) => {
      const customEvent = event as CustomEvent<{ page: number }>;
      const detail = customEvent.detail;
      if (
        detail !== undefined &&
        detail.page >= 1 &&
        detail.page <= numPages &&
        detail.page !== currentPage
      ) {
        currentPage = detail.page;
        void renderPage(currentPage);
      }
    });

    await renderPage(1);
    wrapper.dispatchEvent(
      new CustomEvent('relic:render-state', { detail: 'ready', bubbles: true })
    );
  } catch {
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
  }
}
