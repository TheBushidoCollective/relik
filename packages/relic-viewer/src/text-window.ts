import type { RelicContent } from './content.ts';
import type { TextWindowHandle, WindowMark } from './text-window-bridge.ts';

const SCAN_BYTES = 1024 * 1024;
const ROW_BYTES = 16 * 1024;
const INDEX_STRIDE = 1024;
const WINDOW_ROWS = 80;

export interface SourceRow {
  readonly row: number;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** Sparse rows also split pathological single lines, without losing any bytes. */
export class TextWindowIndex {
  private readonly offsets = [0];
  private readonly lines = [1];
  rowCount = 0;
  lineCount = 1;

  private constructor(readonly content: RelicContent) {}

  private async *scan(
    start: number,
    line: number,
    row: number
  ): AsyncGenerator<SourceRow> {
    let rowStart = start;
    for (let offset = start; offset < this.content.size; offset += SCAN_BYTES) {
      const bytes = await this.content.read(
        offset,
        Math.min(offset + SCAN_BYTES, this.content.size)
      );
      for (let i = 0; i < bytes.length; i++) {
        const at = offset + i;
        const byte = bytes[i]!;
        // A UTF-8 continuation stays with the preceding fragment.
        if (at - rowStart >= ROW_BYTES && (byte & 0xc0) !== 0x80) {
          yield { row: row++, line, start: rowStart, end: at };
          rowStart = at;
        }
        if (byte === 10) {
          yield { row: row++, line: line++, start: rowStart, end: at + 1 };
          rowStart = at + 1;
        }
      }
    }
    yield { row, line, start: rowStart, end: this.content.size };
  }

  static async build(
    content: RelicContent,
    signal?: AbortSignal
  ): Promise<TextWindowIndex> {
    const index = new TextWindowIndex(content);
    for await (const row of index.scan(0, 1, 0)) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (row.row > 0 && row.row % INDEX_STRIDE === 0) {
        index.offsets.push(row.start);
        index.lines.push(row.line);
      }
      index.rowCount = row.row + 1;
      index.lineCount = row.line;
    }
    return index;
  }

  async rows(first: number, count: number): Promise<SourceRow[]> {
    first = Math.max(0, Math.min(this.rowCount - 1, Math.floor(first)));
    count = Math.max(0, Math.min(WINDOW_ROWS, Math.floor(count)));
    if (count === 0) return [];
    const checkpoint = Math.floor(first / INDEX_STRIDE);
    const result: SourceRow[] = [];
    for await (const row of this.scan(
      this.offsets[checkpoint]!,
      this.lines[checkpoint]!,
      checkpoint * INDEX_STRIDE
    )) {
      if (row.row >= first) result.push(row);
      if (result.length >= count) break;
    }
    return result;
  }

  async rowAtByte(byte: number): Promise<number> {
    let lo = 0;
    let hi = this.offsets.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid]! <= byte) lo = mid;
      else hi = mid;
    }
    for await (const row of this.scan(
      this.offsets[lo]!,
      this.lines[lo]!,
      lo * INDEX_STRIDE
    )) {
      if (byte < row.end || row.end === this.content.size) return row.row;
    }
    return this.rowCount - 1;
  }

  async rowAtLine(line: number): Promise<number> {
    line = Math.max(1, Math.min(this.lineCount, Math.floor(line)));
    let lo = 0;
    let hi = this.lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lines[mid]! < line) lo = mid;
      else hi = mid;
    }
    for await (const row of this.scan(
      this.offsets[lo]!,
      this.lines[lo]!,
      lo * INDEX_STRIDE
    )) {
      if (row.line >= line) return row.row;
    }
    return this.rowCount - 1;
  }
}

export interface WindowQuote {
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

/** Stream a quote and its context. No whole-document string is constructed. */
export async function findSourceQuote(
  content: RelicContent,
  quote: WindowQuote,
  signal?: AbortSignal
): Promise<{ start: number; end: number } | undefined> {
  const needle = `${quote.prefix ?? ''}${quote.exact}${quote.suffix ?? ''}`;
  if (!quote.exact) return undefined;
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const encoder = new TextEncoder();
  let carry = '';
  let consumed = 0;
  for (let offset = 0; offset < content.size; offset += SCAN_BYTES) {
    if (signal?.aborted) return undefined;
    const bytes = await content.read(
      offset,
      Math.min(offset + SCAN_BYTES, content.size)
    );
    const text =
      carry +
      decoder.decode(bytes, { stream: offset + bytes.length < content.size });
    const at = text.indexOf(needle);
    if (at >= 0) {
      const start =
        consumed -
        encoder.encode(carry).length +
        encoder.encode(text.slice(0, at) + (quote.prefix ?? '')).length;
      return { start, end: start + encoder.encode(quote.exact).length };
    }
    // Decoded length, rather than input length, accounts for a UTF-8 sequence
    // still buffered inside TextDecoder at the chunk boundary.
    consumed += encoder.encode(text.slice(carry.length)).length;
    carry = text.slice(-Math.max(0, needle.length - 1));
    if (needle.length === 1) carry = '';
  }
  return undefined;
}

/**
 * Fixed DOM size and a native range control avoid browser element-height
 * limits. Only `text-window-bridge.ts` calls this; it owns registration and
 * cleanup.
 */
export function renderTextWindow(
  root: HTMLElement,
  content: RelicContent
): TextWindowHandle {
  const controller = new AbortController();
  const toolbar = document.createElement('form');
  toolbar.className = 'text-window-tools';
  const label = document.createElement('label');
  label.textContent = 'Line';
  const line = document.createElement('input');
  line.type = 'number';
  line.min = '1';
  line.value = '1';
  line.setAttribute('aria-label', 'Line');
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'action';
  go.textContent = 'Go';
  label.appendChild(line);
  const status = document.createElement('output');
  status.textContent = 'Loading source';
  status.setAttribute('aria-live', 'polite');
  toolbar.append(label, go, status);
  const body = document.createElement('div');
  body.className = 'text-window-body';
  const page = document.createElement('pre');
  page.className = 'text-window-page';
  page.tabIndex = 0;
  page.setAttribute('aria-label', 'Source');
  const scroll = document.createElement('input');
  scroll.type = 'range';
  scroll.className = 'text-window-scroll';
  scroll.min = '0';
  scroll.max = '0';
  scroll.step = '1';
  scroll.value = '0';
  scroll.setAttribute('aria-label', 'Source position');
  body.append(page, scroll);
  root.append(toolbar, body);
  let index: TextWindowIndex | undefined;
  let first = 0;
  let generation = 0;
  let marks: readonly WindowMark[] = [];
  let markKey = '';
  let markGeneration = 0;
  let locating: Promise<void> = Promise.resolve();
  const positions = new Map<string, { start: number; end: number }>();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let pendingPaint: Promise<void> | undefined;
  // Rows the page can show, so a resize knows whether the window must change.
  const rowsInView = (): number =>
    Math.max(
      1,
      Math.min(WINDOW_ROWS, Math.floor(page.clientHeight / 20) || 40)
    );
  let paintedRows = 0;

  const paintOnce = async (request: number): Promise<void> => {
    if (!index || controller.signal.aborted) return;
    first = Math.max(0, Math.min(index.rowCount - 1, first));
    const visibleRows = rowsInView();
    const rows = await index.rows(first, visibleRows);
    const start = rows[0]!.start;
    const bytes = await content.read(start, rows[rows.length - 1]!.end);
    if (request !== generation || controller.signal.aborted) return;
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const node = document.createElement('span');
      node.className = 'text-window-row';
      node.dataset['line'] = String(row.line);
      node.dataset['row'] = String(row.row);
      // Split only at range boundaries, then nest every covering identity.
      // Source bytes occur once even when identical or crossing quotes overlap.
      const edges: { offset: number; mark: WindowMark; starts: boolean }[] = [];
      for (const mark of marks) {
        const at = positions.get(mark.id);
        if (!at || at.end <= row.start || at.start >= row.end) continue;
        edges.push(
          { offset: Math.max(row.start, at.start), mark, starts: true },
          { offset: Math.min(row.end, at.end), mark, starts: false }
        );
      }
      edges.sort((a, b) => a.offset - b.offset);
      let cursor = row.start;
      const active = new Set<WindowMark>();
      const appendUntil = (end: number): void => {
        if (end <= cursor) return;
        let parent = node;
        for (const mark of active) {
          const highlight = document.createElement('mark');
          highlight.className = `relic-text-mark${mark.resolved ? ' is-resolved' : ''}`;
          highlight.dataset['commentId'] = mark.id;
          parent.appendChild(highlight);
          parent = highlight;
        }
        parent.appendChild(
          document.createTextNode(
            decoder.decode(bytes.subarray(cursor - start, end - start))
          )
        );
        cursor = end;
      };
      for (const edge of edges) {
        appendUntil(edge.offset);
        if (edge.starts) active.add(edge.mark);
        else active.delete(edge.mark);
      }
      appendUntil(row.end);
      fragment.appendChild(node);
    }
    page.replaceChildren(fragment);
    paintedRows = visibleRows;
    scroll.value = String(first);
    line.value = String(rows[0]!.line);
    status.textContent = `${rows[0]!.line.toLocaleString()} / ${index.lineCount.toLocaleString()}`;
    scroll.setAttribute(
      'aria-valuetext',
      `Line ${rows[0]!.line} of ${index.lineCount}`
    );
    root.dispatchEvent(
      new CustomEvent('relic:text-window-paint', { bubbles: true })
    );
  };
  const paint = (): Promise<void> => {
    generation++;
    if (pendingPaint) return pendingPaint;
    pendingPaint = (async () => {
      let painted: number;
      do {
        painted = generation;
        await paintOnce(painted);
      } while (painted !== generation && !controller.signal.aborted);
    })().finally(() => {
      pendingPaint = undefined;
    });
    return pendingPaint;
  };
  const move = (row: number): void => {
    first = row;
    void paint().catch(failed);
  };
  const failed = (): void => {
    if (controller.signal.aborted) return;
    status.textContent = 'Source could not be loaded.';
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { bubbles: true, detail: 'error' })
    );
  };
  page.addEventListener('keydown', (event) => {
    const jump =
      event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'PageDown'
            ? 40
            : event.key === 'PageUp'
              ? -40
              : undefined;
    if (jump !== undefined) {
      event.preventDefault();
      move(first + jump);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(Math.max(0, (index?.rowCount ?? 1) - rowsInView()));
    }
  });
  let wheelRemainder = 0;
  page.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.ctrlKey)
        return;
      event.preventDefault();
      wheelRemainder +=
        event.deltaY *
        (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 800 : 1);
      const rows = Math.trunc(wheelRemainder / 20);
      wheelRemainder -= rows * 20;
      if (rows) move(first + rows);
    },
    { passive: false }
  );
  let touchY = 0;
  page.addEventListener(
    'touchstart',
    (event) => {
      touchY = event.touches[0]?.clientY ?? 0;
    },
    { passive: true }
  );
  page.addEventListener(
    'touchmove',
    (event) => {
      const y = event.touches[0]?.clientY ?? touchY;
      const rows = Math.trunc((touchY - y) / 20);
      if (rows) {
        event.preventDefault();
        touchY = y;
        move(first + rows);
      }
    },
    { passive: false }
  );
  scroll.addEventListener('input', () => move(Number(scroll.value)));
  toolbar.addEventListener('submit', (event) => {
    event.preventDefault();
    if (index && Number.isFinite(line.valueAsNumber))
      void index
        .rowAtLine(line.valueAsNumber)
        .then((row) => {
          move(row);
          page.focus();
        })
        .catch(failed);
  });
  const ready = TextWindowIndex.build(content, controller.signal).then(
    async (built) => {
      index = built;
      line.max = String(index.lineCount);
      scroll.max = String(Math.max(0, index.rowCount - 1));
      await paint();
      root.dispatchEvent(
        new CustomEvent('relic:render-state', {
          bubbles: true,
          detail: 'ready',
        })
      );
    }
  );
  void ready.catch(failed);
  // The window holds only the rows that fit, so a page that grows or shrinks
  // (a resized viewport, a sidebar closing) needs a new window.
  if (typeof ResizeObserver === 'function') {
    const resized = new ResizeObserver(() => {
      if (index && paintedRows !== rowsInView()) move(first);
    });
    resized.observe(page);
    controller.signal.addEventListener('abort', () => resized.disconnect(), {
      once: true,
    });
  }
  const handle: TextWindowHandle = {
    ready,
    setMarks(next) {
      const key = JSON.stringify(next);
      if (key === markKey) return;
      markKey = key;
      marks = next;
      positions.clear();
      const request = ++markGeneration;
      locating = (async () => {
        for (const mark of next) {
          if (request !== markGeneration || controller.signal.aborted) return;
          const quote =
            mark.anchor.kind === 'quote'
              ? mark.anchor
              : mark.anchor.kind === 'text'
                ? { exact: mark.anchor.quote }
                : undefined;
          if (!quote) continue;
          const at = await findSourceQuote(content, quote, controller.signal);
          if (request !== markGeneration) return;
          if (at) positions.set(mark.id, at);
        }
        marks = [...next].sort(
          (a, b) =>
            (positions.get(a.id)?.start ?? Infinity) -
            (positions.get(b.id)?.start ?? Infinity)
        );
        await ready;
        await paint();
      })();
      void locating.catch(failed);
    },
    async reveal(id) {
      await ready;
      await locating;
      const at = positions.get(id);
      if (!at || !index || controller.signal.aborted) return;
      first = await index.rowAtByte(at.start);
      await paint();
      if (controller.signal.aborted) return;
      // A long line can hold the quote beyond the page's right edge. The
      // page's scroll padding keeps it clear of the sticky line numbers.
      [...page.querySelectorAll<HTMLElement>('mark')]
        .find((mark) => mark.dataset['commentId'] === id)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      page.focus();
    },
    dispose() {
      controller.abort();
      generation++;
      markGeneration++;
    },
  };
  return handle;
}
