import { describe, expect, test } from 'bun:test';
import { locate } from '@relic/format/suggestions';
import {
  codeSegments,
  renderMarkdownWithSource,
} from '../src/markdown-source.ts';
import {
  SuggestDraftModel,
  type PendingSuggestion,
  type SuggestCommit,
} from '../src/suggest-draft.ts';

function markdown(
  source: string,
  pending: readonly PendingSuggestion[] = []
): SuggestDraftModel {
  const map = renderMarkdownWithSource(source);
  return new SuggestDraftModel({
    source,
    segments: map.segments,
    delimiters: map.delimiters,
    version: 3,
    reader: 'reader@example.com',
    pending,
  });
}

function code(
  source: string,
  pending: readonly PendingSuggestion[] = []
): SuggestDraftModel {
  return new SuggestDraftModel({
    source,
    segments: codeSegments(source),
    delimiters: [],
    version: 3,
    reader: 'reader@example.com',
    pending,
  });
}

function saved(result: SuggestCommit) {
  if (result.kind !== 'save')
    throw new Error(`expected save, got ${result.kind}`);
  if (
    result.plaintext.anchor?.kind !== 'source' ||
    !result.plaintext.suggestion
  )
    throw new Error('missing suggestion');
  return {
    ...result,
    anchor: result.plaintext.anchor,
    suggestion: result.plaintext.suggestion,
  };
}

describe('suggestion draft source model', () => {
  test('S6a refuses typing in another reader’s insertion with the mock copy', () => {
    const model = markdown('Alpha beta', [
      {
        id: 'other',
        author: 'other@example.com',
        displayName: 'Priya',
        version: 3,
        start: 5,
        end: 5,
        inserted: 'shift',
      },
    ]);
    expect(model.editInsertion(1, 1, 'x', 'paragraph', 'other')).toEqual({
      kind: 'refused',
      code: 'others-insertion',
      message: 'That text is Priya’s suggestion. Reply to it instead.',
    });
    expect(model.draft).toBeNull();
  });

  test('S6b refuses crossing part of formatting or a link, while an entire pair can be selected', () => {
    const source = 'Words **bold** after [link](https://example.com) end';
    const model = markdown(source);
    expect(
      model.replace(2, source.indexOf('bold') + 2, 'x', 'paragraph')
    ).toEqual({
      kind: 'refused',
      code: 'crosses-formatting',
      message:
        'A suggestion can’t cross formatting or a link. Select inside it, or around it.',
    });
    expect(
      model.replace(
        source.indexOf('after'),
        source.indexOf('link') + 2,
        'x',
        'paragraph'
      ).kind
    ).toBe('refused');
    const around = markdown(source);
    expect(
      around.replace(0, source.indexOf('after') + 5, 'new words', 'paragraph')
        .kind
    ).toBe('changed');
    expect(saved(around.commit(null)).anchor.exact).toBe(
      'Words **bold** after'
    );
    const aroundLink = markdown(source);
    expect(
      aroundLink.replace(
        source.indexOf('after'),
        source.length,
        'revised',
        'paragraph'
      ).kind
    ).toBe('changed');
    expect(saved(aroundLink.commit(null)).anchor.exact).toBe(
      'after [link](https://example.com) end'
    );
    const bold = markdown(source);
    const boldStart = source.indexOf('bold');
    bold.replace(boldStart, boldStart + 4, 'strong', 'paragraph');
    expect(bold.extendStrike('left')).toMatchObject({
      kind: 'refused',
      code: 'crosses-formatting',
    });
  });

  test('does not silently strike an invisible blockquote marker between joined lines', () => {
    const source = '> alpha\n> beta';
    const result = markdown(source).replace(
      source.indexOf('alpha'),
      source.length,
      'words',
      'quote'
    );
    expect(result).toEqual({
      kind: 'refused',
      code: 'crosses-formatting',
      message:
        'A suggestion can’t cross formatting or a link. Select inside it, or around it.',
    });
  });

  test('S6c refuses crossing paragraph boundaries', () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    expect(
      markdown(source).replace(0, source.length, 'x', 'paragraph')
    ).toEqual({
      kind: 'refused',
      code: 'crosses-blocks',
      message:
        'A suggestion stays inside one paragraph. Select within a single block.',
    });
  });

  test('S6d and S6e enforce UTF-8 bytes, keep the prior draft and expose live counters', () => {
    const original = 'é'.repeat(257);
    const strike = code(original);
    expect(strike.replace(0, 257, 'x', 'code')).toEqual({
      kind: 'refused',
      code: 'quote-too-long',
      message: 'That strikes 514 bytes. A suggestion can strike up to 512.',
    });
    expect(strike.replace(0, 256, 'x', 'code').kind).toBe('changed');
    expect(strike.draft?.struckBytes).toBe(512);
    const insert = code('abc');
    expect(insert.replace(1, 1, 'é'.repeat(1025), 'code')).toEqual({
      kind: 'refused',
      code: 'too-long',
      message:
        'That would insert 2,050 bytes. A suggestion can insert up to 2,048.',
    });
    expect(insert.replace(1, 1, 'é'.repeat(1024), 'code').kind).toBe('changed');
    expect(insert.draft?.insertedBytes).toBe(2048);
    expect(insert.editInsertion(2048 / 2, 2048 / 2, 'x', 'code')).toEqual({
      kind: 'refused',
      code: 'too-long',
      message:
        'That would insert 2,049 bytes. A suggestion can insert up to 2,048.',
    });
    expect(insert.draft?.insertedBytes).toBe(2048);
  });

  test('S6f gives the right line-break refusal for each block; Enter and Tab work only where allowed', () => {
    for (const [source, kind, place] of [
      ['- item', 'list', 'a list item'],
      ['> quoted', 'quote', 'a quote'],
      ['# heading', 'heading', 'a heading'],
      ['| cell | x |\n| --- | --- |', 'table-cell', 'a table cell'],
    ] as const) {
      const map = renderMarkdownWithSource(source);
      const pos = map.segments[0]!.start;
      const model = markdown(source);
      const refusal = {
        kind: 'refused',
        code: 'newline-here',
        message: `A line break can’t go inside ${place}. Suggest the words, and reply if the layout should change.`,
      } as const;
      expect(model.enter(pos, pos, kind)).toEqual(refusal);
      expect(model.replace(pos, pos, 'pasted\nline', kind)).toEqual(refusal);
    }
    const paragraph = markdown('one two');
    expect(paragraph.enter(3, 3, 'paragraph').kind).toBe('changed');
    expect(paragraph.draft?.inserted).toBe('\n\n');
    expect(markdown('one').tab(1, 1, 'paragraph')).toEqual({
      kind: 'refused',
      code: 'tab-here',
      message: 'Tab works only in code.',
    });
    const program = code('first\nsecond');
    expect(program.enter(5, 5, 'code').kind).toBe('changed');
    expect(program.editInsertion(1, 1, '\t', 'code').kind).toBe('changed');
    expect(program.draft?.inserted).toBe('\n\t');
    const fencedSource = '```js\nconst x = 1\n```';
    const fencedPos = fencedSource.indexOf('const') + 5;
    const fenced = markdown(fencedSource);
    expect(fenced.enter(fencedPos, fencedPos, 'fenced-code').kind).toBe(
      'changed'
    );
    expect(fenced.draft?.inserted).toBe('\n');
  });

  test('S6g refuses pipe characters in table cells even when pasted', () => {
    const source = '| left | right |\n| --- | --- |';
    const model = markdown(source);
    const pos = source.indexOf('left');
    expect(model.replace(pos, pos, 'a|b', 'table-cell')).toEqual({
      kind: 'refused',
      code: 'pipe-in-cell',
      message:
        'A | would split this table cell. Use another character, or reply describing the change.',
    });
  });

  test('S6h refuses an ambiguous source anchor, with a failing negative control', () => {
    const passage = `${'x'.repeat(128)}word${'y'.repeat(128)}`;
    const source = `${passage}\n\n${passage}`;
    const start = source.indexOf('word');
    const model = markdown(source);
    expect(model.replace(start, start + 4, 'term', 'paragraph').kind).toBe(
      'changed'
    );
    const actual = model.commit(null);
    expect(actual).toEqual({
      kind: 'refused',
      code: 'repeats',
      message: 'This passage repeats in the source. Select a longer passage.',
    });
    expect(model.draft?.inserted).toBe('term');
    const unsafe: SuggestCommit = {
      kind: 'save',
      existingId: null,
      plaintext: {
        body: 'unsafe',
        display_name: null,
        anchor: {
          kind: 'source',
          exact: 'word',
          prefix: 'x'.repeat(128),
          suffix: 'y'.repeat(128),
        },
        suggestion: { v: 1, mode: 'replace', replacement: 'term' },
      },
    };
    const assertNoAmbiguousPost = (result: SuggestCommit): void => {
      if (result.kind !== 'save') return;
      const anchor = result.plaintext.anchor;
      if (anchor?.kind !== 'source') throw new Error('missing anchor');
      expect(
        locate(source, anchor.exact, anchor.prefix, anchor.suffix)
      ).toEqual({ status: 'resolved', start, end: start + 4 });
    };
    assertNoAmbiguousPost(actual);
    expect(() => assertNoAmbiguousPost(unsafe)).toThrow();
  });

  test('coalesces consecutive operations, extends the strike and produces one replacement', () => {
    const model = code('hello world!');
    expect(model.replace(6, 11, 'earth', 'code').kind).toBe('changed');
    expect(model.editInsertion(5, 5, 's', 'code').kind).toBe('changed');
    expect(model.extendStrike('left').kind).toBe('changed');
    expect(model.extendStrike('right').kind).toBe('changed');
    expect(model.draft).toMatchObject({
      start: 5,
      end: 12,
      struck: ' world!',
      inserted: 'earths',
      struckBytes: 7,
      insertedBytes: 6,
    });
    const result = saved(model.commit('Reader'));
    expect(result.anchor.exact).toBe(' world!');
    expect(result.suggestion).toEqual({
      v: 1,
      mode: 'replace',
      replacement: 'earths',
    });
    expect(result.existingId).toBeNull();
  });

  test('coalesces disjoint edits in one block while preserving the intervening source', () => {
    const model = code('one two three');
    expect(model.replace(0, 3, 'ONE', 'code').kind).toBe('changed');
    expect(model.replace(8, 13, 'THREE', 'code').kind).toBe('changed');
    expect(model.draft).toMatchObject({
      struck: 'one two three',
      inserted: 'ONE two THREE',
    });
  });

  test('insertions anchor to a whole adjacent grapheme or join and select after or before', () => {
    const source = 'A👩‍👩‍👦B';
    const before = code(source);
    expect(before.replace(0, 0, 'first', 'code').kind).toBe('changed');
    expect(saved(before.commit(null))).toMatchObject({
      anchor: { exact: 'A' },
      suggestion: { mode: 'before' },
    });
    const after = code(source);
    const familyEnd = source.length - 1;
    expect(after.replace(familyEnd, familyEnd, 'next', 'code').kind).toBe(
      'changed'
    );
    expect(saved(after.commit(null))).toMatchObject({
      anchor: { exact: '👩‍👩‍👦' },
      suggestion: { mode: 'after' },
    });
    const joinedSource = 'alpha\n   beta';
    const joinedMap = renderMarkdownWithSource(joinedSource);
    const join = joinedMap.segments.find((segment) => segment.kind === 'join')!;
    const joined = markdown(joinedSource);
    expect(joined.replace(join.end, join.end, 'x', 'paragraph').kind).toBe(
      'changed'
    );
    expect(saved(joined.commit(null))).toMatchObject({
      anchor: { exact: '\n   ' },
      suggestion: { mode: 'after' },
    });
    expect(code(source).replace(2, 2, 'split', 'code')).toMatchObject({
      kind: 'refused',
      code: 'invalid-range',
    });
  });

  test('context cuts at UTF-8 code point boundaries and resolves to the selected occurrence', () => {
    const source = `${'😀'.repeat(40)}target${'é'.repeat(80)}`;
    const start = source.indexOf('target');
    const model = code(source);
    model.replace(start, start + 6, 'change', 'code');
    const result = saved(model.commit(null));
    expect(new TextEncoder().encode(result.anchor.prefix).length).toBe(128);
    expect(new TextEncoder().encode(result.anchor.suffix).length).toBe(128);
    expect(
      locate(
        source,
        result.anchor.exact,
        result.anchor.prefix,
        result.anchor.suffix
      )
    ).toEqual({ status: 'resolved', start, end: start + 6 });
  });

  test('editing your own current-version suggestion uses its id; reverting deletes it', () => {
    const source = 'hello world';
    const pending: PendingSuggestion = {
      id: 'mine',
      author: 'READER@example.com',
      displayName: 'Me',
      version: 3,
      start: 6,
      end: 11,
      inserted: 'earth',
    };
    const adjacent = markdown(source, [pending]);
    expect(adjacent.replace(11, 11, 's', 'paragraph')).toMatchObject({
      kind: 'changed',
      draft: { existingId: 'mine', inserted: 'earths' },
    });
    expect(saved(adjacent.commit(null)).existingId).toBe('mine');
    const revert = markdown(source, [pending]);
    expect(revert.editInsertion(0, 5, 'world', 'paragraph', 'mine').kind).toBe(
      'changed'
    );
    expect(revert.commit(null)).toEqual({ kind: 'delete', existingId: 'mine' });
    const old = markdown(source, [{ ...pending, version: 2 }]);
    old.replace(11, 11, 's', 'paragraph');
    expect(saved(old.commit(null)).existingId).toBeNull();
  });

  test('commit and cancellation events carry the draft until it can be posted', () => {
    for (const trigger of [
      { type: 'caret', block: 99 },
      { type: 'focus-left' },
      { type: 'suggesting-off' },
      { type: 'shortcut' },
    ] as const) {
      const model = markdown('some words');
      model.replace(0, 4, 'new', 'paragraph');
      expect(
        model.event({ type: 'caret', block: model.draft!.block }, null)
      ).toEqual({ kind: 'none' });
      expect(model.event(trigger, null)).toMatchObject({
        kind: 'commit',
        result: { kind: 'save' },
      });
      expect(model.draft?.inserted).toBe('new');
      expect(model.event({ type: 'escape' }, null)).toEqual({
        kind: 'cancelled',
      });
      expect(model.draft).toBeNull();
    }
  });

  test('refuses forbidden control characters and lone surrogates rather than producing an unsealable payload', () => {
    for (const value of ['\u0000', '\r', '\u202e', '\ud800']) {
      expect(code('abc').replace(1, 1, value, 'code')).toMatchObject({
        kind: 'refused',
        code: 'invalid-character',
      });
    }
  });
});
