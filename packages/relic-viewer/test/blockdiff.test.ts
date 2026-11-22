import { describe, expect, test } from 'bun:test';
import type { EpubBook } from '../../relic-format/src/epub-package.ts';
import {
  type BlockDiff,
  chapterRows,
  diffBlocks,
  epubDiffOptions,
  MAX_BLOCK_EDITS,
  MAX_DOCUMENT_ANCHORS,
  renderedChapters,
} from '../src/blockdiff.ts';
import type { DocumentBlock } from '../src/frame-document-protocol.ts';

const NO_TEXT_CHANGES =
  'No text changes. Formatting, layout and image content are not compared.';

const p = (text: string, part = 0): DocumentBlock => ({
  kind: 'paragraph',
  text,
  part,
});
const h = (text: string, part = 0): DocumentBlock => ({
  kind: 'heading',
  text,
  part,
});
const cell = (text: string, part = 0): DocumentBlock => ({
  kind: 'table-cell',
  text,
  part,
});
const image = (part = 0): DocumentBlock => ({ kind: 'image', text: '', part });

/** The diff, asserted to be a block diff rather than the size refusal. */
function diffOf(
  before: readonly DocumentBlock[],
  after: readonly DocumentBlock[],
  options?: Parameters<typeof diffBlocks>[2]
): BlockDiff {
  const result = diffBlocks(before, after, options);
  if (result === 'too-many-changes') throw new Error('expected a block diff');
  return result;
}

function book(
  spine: readonly string[],
  toc: readonly { readonly path: string; readonly label: string }[]
): EpubBook {
  return {
    title: 'The crossing',
    progression: 'default',
    layout: 'reflowable',
    resources: [],
    spine: spine.map((path) => ({ path, linear: true })),
    toc: toc.map((entry) => ({ ...entry, depth: 0 })),
    pageList: [],
  };
}

/** Exactly `length` characters, ending in a space, built from whole words. */
function filler(length: number): string {
  const text = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(length / 27));
  return `${text.slice(0, length - 1)} `;
}

function hasLoneSurrogate(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

// The section 6 DOCX fixture, as the frame reports its blocks. The header and
// footer are not blocks, so "Draft" and "Final" never reach the diff.
const quarterlyBefore: DocumentBlock[] = [
  h('Quarterly plan'),
  p('Revenue grew in every region.'),
  p('Hiring stays flat.'),
  cell('Region'),
  cell('Target'),
  cell('West'),
  cell('120'),
  p('This sentence is removed in version 2.'),
  image(),
];
const quarterlyAfter: DocumentBlock[] = [
  h('Quarterly plan'),
  p('Revenue grew in every region, except the north.'),
  p('Hiring stays flat.'),
  cell('Region'),
  cell('Target'),
  cell('West'),
  cell('135'),
  image(),
  p('Launch in May.'),
];

describe('diffBlocks on the DOCX fixture', () => {
  test('counts, orders and marks the changes', () => {
    const diff = diffOf(quarterlyBefore, quarterlyAfter);
    expect(diff.changed).toBe(true);
    expect(diff.summary).toBe('1 added, 1 removed, 2 changed.');
    expect(diff.total).toBe(4);
    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(1);
    expect(diff.jumps.map(({ side, kind }) => [side, kind])).toEqual([
      ['after', 'changed'],
      ['after', 'changed'],
      ['before', 'removed'],
      ['after', 'added'],
    ]);
    expect(diff.jumpParts.map(({ side }) => side)).toEqual([
      'after',
      'after',
      'before',
      'after',
    ]);
    expect(diff.removedMarks).toEqual([
      { path: [1], kind: 'changed', syncId: 'd0' },
      { path: [6], kind: 'changed', syncId: 'd1' },
      { path: [7], kind: 'removed', changeId: 'c2' },
    ]);
    expect(diff.addedMarks).toEqual([
      { path: [1], kind: 'changed', syncId: 'd0', changeId: 'c0' },
      { path: [6], kind: 'changed', syncId: 'd1', changeId: 'c1' },
      { path: [8], kind: 'added', changeId: 'c3' },
    ]);
  });

  test('lists each change with its kind, label and words', () => {
    const { changes } = diffOf(quarterlyBefore, quarterlyAfter);
    expect(changes.map(({ kind, label }) => [kind, label])).toEqual([
      ['changed', 'paragraph'],
      ['changed', 'table cell'],
      ['removed', 'paragraph'],
      ['added', 'paragraph'],
    ]);
    const [revenue, region, removed, added] = changes;
    expect(revenue?.before).toBe('Revenue grew in every region.');
    expect(revenue?.after).toBe(
      'Revenue grew in every region, except the north.'
    );
    const inserted = revenue?.segments?.after
      .filter((segment) => segment.kind === 'added')
      .map((segment) => segment.text)
      .join('');
    expect(inserted).toBe(', except the north');
    expect(revenue?.segments?.before.some((s) => s.kind === 'removed')).toBe(
      false
    );
    expect([region?.before, region?.after]).toEqual(['120', '135']);
    expect(removed?.before).toBe('This sentence is removed in version 2.');
    expect(removed?.after).toBe('');
    expect(added?.before).toBe('');
    expect(added?.after).toBe('Launch in May.');
    expect(changes.map(({ jumpIndex }) => jumpIndex)).toEqual([0, 1, 2, 3]);
  });

  test('anchors every shared block when they fit, paired by one id', () => {
    const diff = diffOf(quarterlyBefore, quarterlyAfter);
    expect(diff.beforeAnchors.map(({ path }) => path[0])).toEqual([
      0, 2, 3, 4, 5, 8,
    ]);
    expect(diff.afterAnchors.map(({ path }) => path[0])).toEqual([
      0, 2, 3, 4, 5, 7,
    ]);
    expect(diff.beforeAnchors.map(({ syncId }) => syncId)).toEqual(
      diff.afterAnchors.map(({ syncId }) => syncId)
    );
  });

  test('identical versions say there are no text changes', () => {
    const copy = quarterlyBefore.map((block) => ({ ...block }));
    const diff = diffOf(quarterlyBefore, copy);
    expect(diff.changed).toBe(false);
    expect(diff.summary).toBe(NO_TEXT_CHANGES);
    expect(diff.total).toBe(0);
    expect(diff.jumps).toEqual([]);
    expect(diff.changes).toEqual([]);
    expect(diff.beforeAnchors).toHaveLength(quarterlyBefore.length);
    expect(diffOf([], []).summary).toBe(NO_TEXT_CHANGES);
  });

  test('images count by presence and position, not by content', () => {
    const diff = diffOf(
      [p('Before.'), image(), p('After.')],
      [p('Before.'), p('After.')]
    );
    expect(diff.summary).toBe('1 removed.');
    expect(diff.changes[0]?.label).toBe('image');
  });
});

const crossingBefore = book(
  ['ch1.xhtml', 'ch2.xhtml', 'ch3.xhtml'],
  [
    { path: 'ch1.xhtml', label: 'Opening' },
    { path: 'ch2.xhtml', label: 'The crossing' },
    { path: 'ch3.xhtml', label: 'Interlude' },
  ]
);
const crossingAfter = book(
  ['ch1.xhtml', 'ch2.xhtml', 'ch4.xhtml'],
  [
    { path: 'ch1.xhtml', label: 'Opening' },
    { path: 'ch2.xhtml', label: 'The crossing' },
    { path: 'ch4.xhtml', label: 'Afterword' },
  ]
);
// Render order is spine order, so the Afterword sits at part 2 as Interlude
// does. The two must not pair: their chapter paths differ.
const crossingBlocksBefore: DocumentBlock[] = [
  h('Opening', 0),
  p('It began.', 0),
  h('The crossing', 1),
  p('We crossed at dawn.', 1),
  h('Interlude', 2),
  p('Nothing happened.', 2),
];
const crossingBlocksAfter: DocumentBlock[] = [
  h('Opening', 0),
  p('It began.', 0),
  h('The crossing', 1),
  p('We crossed at noon.', 1),
  h('Afterword', 2),
  p('Thanks for reading.', 2),
];

describe('EPUB comparison', () => {
  test('a removed chapter does not pair with an added one', () => {
    const diff = diffOf(
      crossingBlocksBefore,
      crossingBlocksAfter,
      epubDiffOptions(crossingBefore, crossingAfter)
    );
    expect(diff.summary).toBe('2 added, 2 removed, 1 changed.');
    expect(diff.changes.map(({ kind, label }) => [kind, label])).toEqual([
      ['changed', 'paragraph in The crossing'],
      ['removed', 'heading in Interlude'],
      ['removed', 'paragraph in Interlude'],
      ['added', 'heading in Afterword'],
      ['added', 'paragraph in Afterword'],
    ]);
  });

  test('chapter rows name each chapter and count the unchanged ones', () => {
    const diff = diffOf(
      crossingBlocksBefore,
      crossingBlocksAfter,
      epubDiffOptions(crossingBefore, crossingAfter)
    );
    const rows = chapterRows(
      { blocks: crossingBlocksBefore, book: crossingBefore },
      { blocks: crossingBlocksAfter, book: crossingAfter },
      diff
    );
    expect(rows).toEqual([
      { path: 'ch1.xhtml', label: 'Opening', status: 'unchanged', changes: 0 },
      {
        path: 'ch2.xhtml',
        label: 'The crossing',
        status: 'changed',
        changes: 1,
        firstJump: 0,
      },
      {
        path: 'ch3.xhtml',
        label: 'Interlude',
        status: 'removed',
        changes: 2,
        firstJump: 1,
      },
      {
        path: 'ch4.xhtml',
        label: 'Afterword',
        status: 'added',
        changes: 2,
        firstJump: 3,
      },
    ]);
  });

  test('a chapter with no contents title is named Section n', () => {
    const untitled = book(
      ['ch1.xhtml', 'ch2.xhtml', 'ch3.xhtml'],
      [
        { path: 'ch1.xhtml', label: '  Opening \n' },
        { path: 'ch2.xhtml', label: 'The   crossing' },
      ]
    );
    expect(renderedChapters(untitled).map(({ label }) => label)).toEqual([
      'Opening',
      'The crossing',
      'Section 3',
    ]);
    const diff = diffOf(
      crossingBlocksBefore,
      crossingBlocksAfter,
      epubDiffOptions(untitled, crossingAfter)
    );
    expect(diff.changes[1]?.label).toBe('heading in Section 3');
    const rows = chapterRows(
      { blocks: crossingBlocksBefore, book: untitled },
      { blocks: crossingBlocksAfter, book: crossingAfter },
      diff
    );
    expect(rows.find(({ path }) => path === 'ch3.xhtml')).toEqual({
      path: 'ch3.xhtml',
      label: 'Section 3',
      status: 'removed',
      changes: 2,
      firstJump: 1,
    });
  });

  test('a spine that repeats a file merges its rows and sums its changes', () => {
    const repeated = book(
      ['a.xhtml', 'b.xhtml', 'a.xhtml'],
      [
        { path: 'a.xhtml', label: 'Alpha' },
        { path: 'b.xhtml', label: 'Bravo' },
      ]
    );
    const before = [p('one', 0), p('two', 0), p('bee', 1), p('three', 2)];
    const after = [
      p('one', 0),
      p('deux', 0),
      p('bee', 1),
      p('three', 2),
      p('four', 2),
    ];
    const diff = diffOf(before, after, epubDiffOptions(repeated, repeated));
    const rows = chapterRows(
      { blocks: before, book: repeated },
      { blocks: after, book: repeated },
      diff
    );
    expect(rows).toEqual([
      {
        path: 'a.xhtml',
        label: 'Alpha',
        status: 'changed',
        changes: 2,
        firstJump: 0,
      },
      { path: 'b.xhtml', label: 'Bravo', status: 'unchanged', changes: 0 },
    ]);
  });

  test('a chapter that moved keeps its new place, and its blocks count as changes', () => {
    const toc = [
      { path: 'a.xhtml', label: 'Alpha' },
      { path: 'b.xhtml', label: 'Bravo' },
      { path: 'c.xhtml', label: 'Charlie' },
    ];
    const beforeBook = book(['a.xhtml', 'b.xhtml', 'c.xhtml'], toc);
    const afterBook = book(['c.xhtml', 'a.xhtml', 'b.xhtml'], toc);
    const before = [p('alpha', 0), p('bravo', 1), p('charlie', 2)];
    const after = [p('charlie', 0), p('alpha', 1), p('bravo', 2)];
    const diff = diffOf(before, after, epubDiffOptions(beforeBook, afterBook));
    expect(diff.summary).toBe('1 added, 1 removed.');
    const rows = chapterRows(
      { blocks: before, book: beforeBook },
      { blocks: after, book: afterBook },
      diff
    );
    expect(
      rows.map(({ path, status, changes }) => [path, status, changes])
    ).toEqual([
      ['c.xhtml', 'changed', 2],
      ['a.xhtml', 'unchanged', 0],
      ['b.xhtml', 'unchanged', 0],
    ]);
  });
});

describe('the edit cap', () => {
  const distinct = (count: number, stem: string): DocumentBlock[] =>
    Array.from({ length: count }, (_, at) => p(`${stem} ${at}`));

  test('5,001 edits are refused and 5,000 still diff', () => {
    expect(MAX_BLOCK_EDITS).toBe(5_000);
    const olds = distinct(2_500, 'old');
    const news = distinct(2_500, 'new');
    // 2,500 changed pairs: each is one removal and one addition, 5,000 edits.
    const atLimit = diffBlocks(olds, news);
    expect(atLimit).not.toBe('too-many-changes');
    expect((atLimit as BlockDiff).total).toBe(2_500);
    // One more removal makes 5,001.
    expect(diffBlocks([...olds, p('extra')], news)).toBe('too-many-changes');
  });

  test('a removal counts one edit per block, on either side', () => {
    expect(diffBlocks(distinct(5_001, 'gone'), [])).toBe('too-many-changes');
    expect(diffBlocks([], distinct(5_001, 'added'))).toBe('too-many-changes');
    expect(diffOf(distinct(5_000, 'gone'), []).summary).toBe('5000 removed.');
  });
});

describe('changed paragraphs', () => {
  test('a change at character 2,500 of a 3,000-character paragraph shows within 400 characters', () => {
    const head = filler(2_500);
    const tail = ` ${filler(494)}`;
    const diff = diffOf([p(`${head}alpha${tail}`)], [p(`${head}beta${tail}`)]);
    expect(diff.summary).toBe('1 changed.');
    const [change] = diff.changes;
    expect(change?.before.length).toBeLessThanOrEqual(400);
    expect(change?.after.length).toBeLessThanOrEqual(400);
    expect(change?.before).toContain('alpha');
    expect(change?.after).toContain('beta');
    // 40 characters of context on the side that touches the change, and the
    // gap marked by an ellipsis, on each side.
    expect(change?.before).toBe(
      `\u2026${head.slice(-40)}alpha${tail.slice(0, 40)}\u2026`
    );
    expect(change?.after).toBe(
      `\u2026${head.slice(-40)}beta${tail.slice(0, 40)}\u2026`
    );
  });

  test('a long changed run is cut to 400 characters per side', () => {
    const before = 'alpha '.repeat(200).trimEnd();
    const after = 'beta '.repeat(200).trimEnd();
    const [change] = diffOf([p(before)], [p(after)]).changes;
    expect(change?.before.length).toBe(400);
    expect(change?.after.length).toBe(400);
    expect(change?.before.endsWith('\u2026')).toBe(true);
    expect(change?.segments).toBeDefined();
  });

  test('words that differ too much fall back to plain quotes', () => {
    const before = Array.from({ length: 1_500 }, (_, at) => `old${at}`).join(
      ' '
    );
    const after = Array.from({ length: 1_500 }, (_, at) => `new${at}`).join(
      ' '
    );
    const [change] = diffOf([p(before)], [p(after)]).changes;
    expect(change?.segments).toBeUndefined();
    expect(change?.before.length).toBe(400);
    expect(change?.before.startsWith('old0 old1')).toBe(true);
    expect(change?.after.startsWith('new0 new1')).toBe(true);
  });

  test('an excerpt never splits a surrogate pair', () => {
    const emoji = '\u{1F600}';
    // One unit, then 1,249 emoji (2,498 units), then a space: 2,500 in all.
    const head = `a${emoji.repeat(1_249)} `;
    const tail = ` ${filler(494)}`;
    const [change] = diffOf(
      [p(`${head}alpha${tail}`)],
      [p(`${head}beta${tail}`)]
    ).changes;
    expect(hasLoneSurrogate(change?.before ?? '')).toBe(false);
    expect(hasLoneSurrogate(change?.after ?? '')).toBe(false);
    expect(change?.before).toContain(emoji);
  });

  test('removed and added blocks quote 160 characters', () => {
    const long = 'word '.repeat(80).trim();
    const diff = diffOf([p(long), p('stay')], [p('stay')]);
    expect(diff.changes[0]?.before.length).toBe(161);
    expect(diff.changes[0]?.before.endsWith('\u2026')).toBe(true);
  });
});

describe('the listed changes', () => {
  test('the list stops at 40 rows, while the count and the jumps keep going', () => {
    const added = Array.from({ length: 60 }, (_, at) => p(`Added ${at}.`));
    const diff = diffOf([], added);
    expect(diff.summary).toBe('60 added.');
    expect(diff.total).toBe(60);
    expect(diff.changes).toHaveLength(40);
    expect(diff.jumps).toHaveLength(60);
    expect(diff.changes[39]?.jumpIndex).toBe(39);
  });
});

describe('anchors', () => {
  test('past the cap, each change keeps its neighbours and the total stays at the cap', () => {
    const size = 5_000;
    const changed = new Set([100, 2_000, 4_500]);
    const before = Array.from({ length: size }, (_, at) =>
      p(`Block ${at} text.`)
    );
    const after = before.map((block, at) =>
      changed.has(at) ? p(`Block ${at} edited.`) : block
    );
    const diff = diffOf(before, after);
    expect(diff.total).toBe(3);
    expect(diff.beforeAnchors).toHaveLength(MAX_DOCUMENT_ANCHORS);
    expect(diff.afterAnchors).toHaveLength(MAX_DOCUMENT_ANCHORS);
    expect(diff.beforeAnchors.map(({ syncId }) => syncId)).toEqual(
      diff.afterAnchors.map(({ syncId }) => syncId)
    );
    const beforeAt = new Set(diff.beforeAnchors.map(({ path }) => path[0]));
    const afterAt = new Set(diff.afterAnchors.map(({ path }) => path[0]));
    for (const at of changed) {
      expect(beforeAt.has(at - 1)).toBe(true);
      expect(beforeAt.has(at + 1)).toBe(true);
      expect(afterAt.has(at - 1)).toBe(true);
      expect(afterAt.has(at + 1)).toBe(true);
    }
  });
});

describe('scale', () => {
  test('50,000 blocks with 5,000 edits: the time is logged as evidence, never gated', () => {
    const count = 50_000;
    const before = Array.from({ length: count }, (_, at) =>
      p(`Paragraph ${at} keeps its words.`)
    );
    const after = before.map((block, at) =>
      at % 20 === 0 ? p(`Paragraph ${at} changed its words.`) : block
    );
    const started = performance.now();
    const diff = diffBlocks(before, after);
    const elapsed = performance.now() - started;
    console.log(
      `blockdiff: ${count} blocks, 5,000 edits (2,500 changed pairs): ${elapsed.toFixed(1)} ms`
    );
    expect(diff).not.toBe('too-many-changes');
    expect((diff as BlockDiff).total).toBe(2_500);
  }, 120_000);
});
