import type { Notebook, NotebookCell } from '@relic/format/notebook';
import {
  renderMarkdownWithSource,
  type SourceSegment,
} from './markdown-source.ts';
import type { SuggestionSurface } from './suggestion-surface.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';

interface Unit {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly token: number;
  readonly offset: number;
}

export function escapeNotebookText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}
/** Encode a complete draft only when its replaced range stays in one string. */
export function encodeNotebookDraft(
  text: string,
  start: number,
  end: number,
  token: { readonly start: number; readonly end: number } | undefined
): { ok: true; source: string } | { ok: false; refusal: SuggestRefusal } {
  if (!token || start < token.start + 1 || end > token.end - 1 || start > end)
    return { ok: false, refusal: notebookNotEditable() };
  return { ok: true, source: escapeNotebookText(text) };
}

export function notebookNotEditable(): SuggestRefusal {
  return {
    kind: 'refused',
    code: 'not-editable',
    message: 'Only notebook cell source can be edited.',
  };
}

export function notebookAcceptsSelection(
  root: HTMLElement,
  node: Node
): true | SuggestRefusal {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const segment = element?.closest('[data-seg]');
  const target = segment?.closest(
    '.nb-box > article.prose, .nb-box > pre.nb-src'
  );
  return target && root.contains(target) ? true : notebookNotEditable();
}

/** Decode source strings while retaining their exact UTF-16 offsets. */
export function notebookSourceUnits(
  source: string,
  cell: NotebookCell
): Unit[] {
  const units: Unit[] = [];
  let offset = 0;
  for (const [token, range] of cell.sourceTokens.entries()) {
    let at = range.start + 1;
    if (at === range.end - 1)
      units.push({ text: '', start: at, end: at, token, offset });
    while (at < range.end - 1) {
      const start = at;
      if (source[at] === '\\') {
        at += source[at + 1] === 'u' ? 6 : 2;
        if (
          /^\\u[dD][89aAbB][0-9a-fA-F]{2}$/.test(source.slice(start, at)) &&
          /^\\u[dD][c-fC-F][0-9a-fA-F]{2}/.test(source.slice(at, at + 6))
        )
          at += 6;
      } else {
        while (at < range.end - 1 && source[at] !== '\\') at++;
      }
      const raw = source.slice(start, at);
      const text = JSON.parse(`"${raw}"`) as string;
      units.push({ text, start, end: at, token, offset });
      offset += text.length;
    }
  }
  return units;
}

export function notebookSuggestionSurface(
  root: HTMLElement,
  notebook: Notebook
): SuggestionSurface & {
  encode(
    block: number,
    text: string,
    start: number,
    end: number
  ): { ok: true; source: string } | { ok: false; refusal: SuggestRefusal };
  acceptsSelection(node: Node): true | SuggestRefusal;
} {
  const kinds = new Map<number, SuggestBlockKind>();
  const allowed = new Set<number>();
  const tokens = new Map<
    number,
    { readonly start: number; readonly end: number }
  >();
  let nextBlock = 0;
  return {
    root,
    segments(source) {
      const result: SourceSegment[] = [];
      kinds.clear();
      allowed.clear();
      tokens.clear();
      nextBlock = 0;
      for (const cell of notebook.cells) {
        const box = root.querySelector<HTMLElement>(
          `.nb-cell[data-cell="${cell.index}"] .nb-box`
        );
        const target = box?.querySelector<HTMLElement>(
          cell.kind === 'markdown' ? 'article.prose' : 'pre.nb-src'
        );
        if (!target) continue;
        const units = notebookSourceUnits(source, cell);
        const decoded = units.map((unit) => unit.text).join('');
        if (decoded !== cell.source.text || cell.source.truncated) continue;
        const tokenBlocks = new Map<string, number>();
        const blockFor = (token: number, markdownBlock: number): number => {
          const key = `${token}:${markdownBlock}`;
          let block = tokenBlocks.get(key);
          if (block === undefined) {
            block = nextBlock++;
            tokenBlocks.set(key, block);
            kinds.set(block, `nb-${cell.kind}` as SuggestBlockKind);
            const range = cell.sourceTokens[token];
            if (range) tokens.set(block, range);
            allowed.add(block);
          }
          return block;
        };
        const appendUnit = (
          parent: ParentNode,
          unit: Unit,
          markdownBlock: number
        ): void => {
          const span = root.ownerDocument.createElement('span');
          span.dataset['seg'] = String(result.length);
          span.textContent = unit.text;
          parent.append(span);
          const raw = source.slice(unit.start, unit.end);
          result.push({
            text: unit.text,
            start: unit.start,
            end: unit.end,
            block: blockFor(unit.token, markdownBlock),
            kind: raw === unit.text ? 'text' : 'escape',
          });
        };
        if (cell.kind !== 'markdown') {
          target.replaceChildren();
          for (const unit of units) appendUnit(target, unit, 0);
        } else {
          const mapped = renderMarkdownWithSource(decoded);
          target.innerHTML = mapped.html;
          const spans = Array.from(
            target.querySelectorAll<HTMLElement>('[data-seg]')
          );
          if (decoded === '' && units.length > 0)
            appendUnit(target, units[0]!, 0);
          let cursor = 0;
          for (const [index, span] of spans.entries()) {
            const segment = mapped.segments[index];
            if (!segment) continue;
            while (
              cursor < units.length &&
              units[cursor]!.offset + units[cursor]!.text.length <=
                segment.start
            )
              cursor++;
            const subset: Unit[] = [];
            for (
              let j = cursor;
              j < units.length && units[j]!.offset < segment.end;
              j++
            ) {
              const unit = units[j]!;
              const from = Math.max(0, segment.start - unit.offset);
              const to = Math.min(unit.text.length, segment.end - unit.offset);
              const raw = source.slice(unit.start, unit.end);
              if ((from !== 0 || to !== unit.text.length) && raw !== unit.text)
                continue;
              subset.push(
                raw === unit.text
                  ? {
                      ...unit,
                      text: unit.text.slice(from, to),
                      offset: unit.offset + from,
                      start: unit.start + from,
                      end: unit.start + to,
                    }
                  : unit
              );
            }
            if (subset.map((unit) => unit.text).join('') !== segment.text) {
              span.removeAttribute('data-seg');
              continue;
            }
            const fragment = root.ownerDocument.createDocumentFragment();
            for (const unit of subset)
              appendUnit(fragment, unit, segment.block);
            span.replaceWith(fragment);
          }
        }
      }
      return result;
    },
    blockKind(block) {
      return kinds.get(block) ?? 'nb-raw';
    },
    editable(block) {
      return allowed.has(block)
        ? true
        : {
            kind: 'refused',
            code: 'not-editable',
            message: 'Only notebook cell source can be edited.',
          };
    },
    encode(block, text, start, end) {
      return encodeNotebookDraft(text, start, end, tokens.get(block));
    },
    acceptsSelection(node) {
      return notebookAcceptsSelection(root, node);
    },
    repaint() {},
  };
}
