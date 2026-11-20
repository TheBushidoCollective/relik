import { describe, expect, test } from 'bun:test';
import type { CommentAnchor } from '@relic/format';
import { registerBuiltInAnchorAdapters } from '../src/anchor-adapters.ts';
import {
  adapterFor,
  anchorKindIsKnown,
  anchorLabel,
} from '../src/anchoring.ts';
import { cueAnchorAdapter } from '../src/annotate-cue.ts';
import {
  drawnStructuredView,
  isNbformat4Notebook,
  mountStructuredView,
  type StructuredKind,
  NOTEBOOK_RENDER_LIMIT_BYTES,
  structuredKindFor,
  structuredViewFor,
} from '../src/structured-view-bridge.ts';

// The bridge contract with no DOM. A fake root records what the route draws
// and what it announces, so the rules are checked directly: the source view
// is drawn at once, a view that cannot mount leaves the source in place, and
// no structured mark is offered to a view that is not drawn.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface FakeRoot {
  readonly classes: Set<string>;
  children: unknown[];
  events: Array<{ type: string; detail: unknown }>;
}

function fakeRoot(): { root: HTMLElement; state: FakeRoot } {
  const state: FakeRoot = { classes: new Set(), children: [], events: [] };
  const root = {
    classList: {
      add: (...names: string[]) => {
        for (const name of names) state.classes.add(name);
      },
    },
    replaceChildren: (...nodes: unknown[]) => {
      state.children = nodes;
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      state.events.push({ type: event.type, detail: event.detail });
      return true;
    },
    addEventListener: () => {},
    matches: (selector: string) =>
      selector === '.structured-view' && state.classes.has('structured-view'),
    querySelector: () => null,
  };
  return { root: root as unknown as HTMLElement, state };
}

/** A host with no structured view inside it, for the adapter checks. */
const bareHost = {
  matches: () => false,
  querySelector: () => null,
} as unknown as HTMLElement;

describe('structuredKindFor: which view a code-route file opens in', () => {
  const byName: ReadonlyArray<
    readonly [string, string, StructuredKind | undefined]
  > = [
    ['data.csv', 'text/csv', 'table'],
    ['data.tsv', 'text/tab-separated-values', 'table'],
    ['data.json', 'application/json', 'tree'],
    ['cues.srt', 'application/x-subrip', 'cues'],
    ['captions.vtt', 'text/vtt', 'cues'],
    ['notes.md', 'text/markdown', undefined],
    ['report.ipynb', 'application/x-ipynb+json', undefined],
  ];

  for (const [filename, mimetype, kind] of byName) {
    test(`${filename} (${mimetype}) opens as ${kind ?? 'no structured view'}`, () => {
      expect(structuredKindFor(filename, mimetype)).toBe(kind);
    });
  }

  test('the extension decides before the declared type', () => {
    expect(structuredKindFor('data.json', 'text/csv')).toBe('tree');
  });

  test('the declared type decides when the extension does not map', () => {
    expect(structuredKindFor('data.txt', 'text/csv')).toBe('table');
    expect(structuredKindFor('data', 'text/vtt')).toBe('cues');
  });

  test('an inherited name such as constructor never matches a file', () => {
    expect(
      structuredKindFor('report.constructor', 'application/octet-stream')
    ).toBeUndefined();
    expect(structuredKindFor('report.toString', '')).toBeUndefined();
  });
});

describe('isNbformat4Notebook: the route decision for a notebook', () => {
  test('accepts an nbformat 4 object with a cells array', () => {
    expect(isNbformat4Notebook(utf8('{"nbformat": 4, "cells": []}'))).toBe(
      true
    );
  });

  test('refuses nbformat 3, a missing cells array, an array, and bad JSON', () => {
    expect(isNbformat4Notebook(utf8('{"nbformat": 3, "cells": []}'))).toBe(
      false
    );
    expect(isNbformat4Notebook(utf8('{"nbformat": 4, "cells": {}}'))).toBe(
      false
    );
    expect(isNbformat4Notebook(utf8('[{"nbformat": 4, "cells": []}]'))).toBe(
      false
    );
    expect(isNbformat4Notebook(utf8('{"nbformat": 4, "cells": [}'))).toBe(
      false
    );
  });

  test('refuses bytes that are not UTF-8', () => {
    expect(isNbformat4Notebook(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe(false);
  });

  test('the limit is fifty mebibytes', () => {
    expect(NOTEBOOK_RENDER_LIMIT_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('mountStructuredView: the source view stands in until a view draws', () => {
  test('the source view is drawn at once, so the file is never blank', () => {
    const { root, state } = fakeRoot();
    mountStructuredView(root, 'table', {
      filename: 'data.csv',
      mimetype: 'text/csv',
      source: 'a,b\n1,2\n',
      sourceView: () => ({ source: true }) as unknown as HTMLElement,
    });
    expect([...state.classes].sort()).toEqual([
      'structured-table',
      'structured-view',
    ]);
    expect(state.children).toEqual([{ source: true }]);
  });

  test('a view that cannot show the file leaves the source view, and settles', async () => {
    const { root, state } = fakeRoot();
    const handle = mountStructuredView(root, 'table', {
      filename: 'data.csv',
      mimetype: 'text/csv',
      source: 'a,b\n1,2\n',
      sourceView: () => ({ source: true }) as unknown as HTMLElement,
    });
    await handle.ready;
    expect(handle.structured).toBe(false);
    expect(state.children).toEqual([{ source: true }]);
    expect(state.events).toEqual([
      { type: 'relic:structured-state', detail: 'source' },
      { type: 'relic:render-state', detail: 'ready' },
    ]);
  });

  test('a structured mark is refused by a view that is not drawn', async () => {
    const { root } = fakeRoot();
    const handle = mountStructuredView(root, 'table', {
      filename: 'data.csv',
      mimetype: 'text/csv',
      source: 'a,b\n',
      sourceView: () => ({}) as unknown as HTMLElement,
    });
    const cell: CommentAnchor = { kind: 'cell', row: 1, col: 1 };
    expect(handle.paintMark(cell, 'c1')).toBe(false);
    await handle.ready;
    expect(drawnStructuredView(root, 'table')).toBeUndefined();
  });

  test('showSource replaces the view with the source and keeps it there', async () => {
    const { root, state } = fakeRoot();
    const handle = mountStructuredView(root, 'tree', {
      filename: 'data.json',
      mimetype: 'application/json',
      source: '{}',
      sourceView: () => ({ source: true }) as unknown as HTMLElement,
    });
    handle.showSource();
    expect(state.children).toEqual([{ source: true }]);
    await handle.ready;
    expect(handle.structured).toBe(false);
    expect(state.children).toEqual([{ source: true }]);
  });

  test('the route finds its handle from the root, and dispose forgets it', () => {
    const { root } = fakeRoot();
    const handle = mountStructuredView(root, 'cues', {
      filename: 'cues.srt',
      mimetype: 'application/x-subrip',
      source: '',
      sourceView: () => ({}) as unknown as HTMLElement,
    });
    expect(structuredViewFor(root)).toBe(handle);
    handle.dispose();
    expect(structuredViewFor(root)).toBeUndefined();
  });
});

describe('the cell, path and cue adapters', () => {
  registerBuiltInAnchorAdapters();
  const surface = { host: bareHost, content: bareHost };

  test('the cell and path kinds are claimed by an adapter', () => {
    expect(
      anchorKindIsKnown({ kind: 'cell', row: 1, col: 1 } as CommentAnchor)
    ).toBe(true);
    expect(
      anchorKindIsKnown({ kind: 'path', pointer: '' } as CommentAnchor)
    ).toBe(true);
  });

  test('a cell comment on a page that shows the source is unplaceable, not painted', () => {
    expect(
      adapterFor({ kind: 'cell', row: 3, col: 2 } as CommentAnchor, surface)
    ).toBeUndefined();
    expect(
      adapterFor({ kind: 'path', pointer: '/a' } as CommentAnchor, surface)
    ).toBeUndefined();
  });

  test('the cue adapter offers itself only over a drawn cue list', () => {
    expect(cueAnchorAdapter.supports(surface)).toBe(false);
  });

  test('a cell label names one cell, and a range names both corners and the sheet', () => {
    expect(
      anchorLabel({ kind: 'cell', row: 14, col: 3 } as CommentAnchor)
    ).toBe('Commenting on cell C14');
    expect(
      anchorLabel({
        kind: 'cell',
        row: 4,
        col: 2,
        row_end: 9,
        col_end: 4,
        sheet: 'Q3',
      } as CommentAnchor)
    ).toBe('Commenting on cells B4 to D9 of Q3');
  });

  test('a path label names the pointer, and the empty pointer names the whole document', () => {
    expect(
      anchorLabel({ kind: 'path', pointer: '/cells/7' } as CommentAnchor)
    ).toBe('Commenting on /cells/7');
    expect(anchorLabel({ kind: 'path', pointer: '' } as CommentAnchor)).toBe(
      'Commenting on the whole document'
    );
  });

  test('a cue label gives the subtitle clock, and a span gives both ends', () => {
    expect(cueAnchorAdapter.label({ kind: 'time', t: 3725 } as never)).toBe(
      'Commenting on the subtitle at 01:02:05.000'
    );
    expect(
      cueAnchorAdapter.label({ kind: 'time', t: 3, t_end: 9.5 } as never)
    ).toBe('Commenting on subtitles from 00:00:03.000 to 00:00:09.500');
  });
});
