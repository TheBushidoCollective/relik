import * as pdfjsLib from 'pdfjs-dist';

const PDF_RENDER_TIMEOUT_MS = 15_000;
const PDF_IMAGE_PIXELS = 16_000_000;

/** PDF.js reads only the local bytes; author actions and external assets are never run. */
export async function drawPublishPdf(
  source: Blob,
  target: HTMLCanvasElement
): Promise<void> {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.js';
  const data = new Uint8Array(await source.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    useWasm: false,
    maxImageSize: PDF_IMAGE_PIXELS,
    canvasMaxAreaInBytes: PDF_IMAGE_PIXELS * 4,
  });
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error('PDF preview timed out')),
    PDF_RENDER_TIMEOUT_MS
  );
  let renderTask: pdfjsLib.RenderTask | undefined;
  let page: pdfjsLib.PDFPageProxy | undefined;
  let rendered = false;
  try {
    const document = await Promise.race([task.promise, timeout]);
    page = await Promise.race([document.getPage(1), timeout]);
    const initial = page.getViewport({ scale: 1 });
    if (
      !Number.isFinite(initial.width) ||
      !Number.isFinite(initial.height) ||
      initial.width <= 0 ||
      initial.height <= 0
    )
      throw new Error('Invalid PDF page size');
    const scale = Math.min(
      target.width / initial.width,
      target.height / initial.height
    );
    const viewport = page.getViewport({ scale });
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    renderTask = page.render({
      canvas: target,
      canvasContext: ctx,
      viewport,
      transform: [1, 0, 0, 1, (target.width - viewport.width) / 2, 0],
      background: '#ffffff',
    });
    await Promise.race([renderTask.promise, timeout]);
    rendered = true;
  } finally {
    clearTimeout(timer);
    if (!rendered) renderTask?.cancel();
    void task.destroy().catch(() => undefined);
  }
}
