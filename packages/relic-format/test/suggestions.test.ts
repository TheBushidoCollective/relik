import { describe, expect, it } from 'bun:test';
import {
  SUGGESTION_RESOLVE_LIMIT,
  SUGGESTION_SOURCE_LIMIT_BYTES,
  locate,
  mergeSuggestions,
  resolveSuggestions,
  suggestionFallbackBody,
  suggestionSource,
  suggestionStates,
  type ResolvedSuggestion,
  type SuggestionInput,
  type ThreadFact,
} from '../src/suggestions.ts';
import type { SuggestionMode } from '../src/comments.ts';
import { emptyNotebookSourceOffsets } from '../src/notebook.ts';

const encoder = new TextEncoder();

function edit(
  id: string,
  exact: string,
  mode: SuggestionMode,
  replacement: string,
  created_at = id
): SuggestionInput {
  return { id, exact, created_at, suggestion: { v: 1, mode, replacement } };
}

function resolved(
  results: readonly ResolvedSuggestion[],
  id: string
): Extract<ResolvedSuggestion, { status: 'resolved' }> {
  const result = results.find((entry) => entry.id === id);
  if (!result || result.status !== 'resolved') throw new Error(`missing ${id}`);
  return result;
}

function fact(id: string, values: Partial<ThreadFact> = {}): ThreadFact {
  return {
    id,
    author: 'reader@example.com',
    version: 1,
    created_at: '2026-11-18T10:00:00Z',
    addresses: null,
    suggestion_outcome: null,
    resolution: null,
    has_suggestion: false,
    ...values,
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (rest) => [value, ...rest]
    )
  );
}

describe('suggestionSource', () => {
  it('decodes strict UTF-8 and reports and strips only the first BOM', () => {
    expect(suggestionSource(encoder.encode('plain\n\t😀'))).toEqual({
      ok: true,
      source: 'plain\n\t😀',
      bom: false,
    });
    expect(suggestionSource(encoder.encode('\ufeff\ufefftext'))).toEqual({
      ok: true,
      source: '\ufefftext',
      bom: true,
    });
    expect(suggestionSource(new Uint8Array())).toEqual({
      ok: true,
      source: '',
      bom: false,
    });
  });

  it('rejects CR, NUL, invalid UTF-8, and sources over one MiB', () => {
    expect(suggestionSource(encoder.encode('a\rb'))).toEqual({
      ok: false,
      reason: 'has_cr',
    });
    expect(suggestionSource(encoder.encode('a\0b'))).toEqual({
      ok: false,
      reason: 'has_nul',
    });
    expect(suggestionSource(new Uint8Array([0xc3, 0x28]))).toEqual({
      ok: false,
      reason: 'not_utf8',
    });
    expect(suggestionSource(new Uint8Array([0xef, 0xbb]))).toEqual({
      ok: false,
      reason: 'not_utf8',
    });
    expect(
      suggestionSource(new Uint8Array(SUGGESTION_SOURCE_LIMIT_BYTES).fill(0x61))
        .ok
    ).toBe(true);
    expect(
      suggestionSource(new Uint8Array(SUGGESTION_SOURCE_LIMIT_BYTES + 1))
    ).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(SUGGESTION_RESOLVE_LIMIT).toBe(200);
  });
});

describe('locate', () => {
  it('requires the whole context and returns UTF-16 offsets', () => {
    expect(locate('😀 left target right', 'target', 'left ', ' right')).toEqual(
      {
        status: 'resolved',
        start: 8,
        end: 14,
      }
    );
    expect(locate('a foo b c foo d', 'foo', 'c ', ' d')).toEqual({
      status: 'resolved',
      start: 10,
      end: 13,
    });
    expect(locate('a foo b', 'foo', 'z ', ' b')).toEqual({ status: 'lost' });
    expect(locate('abc', 'missing')).toEqual({ status: 'lost' });
  });

  it('rejects ambiguous matches instead of using first occurrence', () => {
    expect(locate('abc abc', 'abc')).toEqual({ status: 'ambiguous' });
    expect(locate('aaaa', 'aaa')).toEqual({ status: 'ambiguous' });
    expect(locate('x abc y x abc y', 'abc', 'x ', ' y')).toEqual({
      status: 'ambiguous',
    });
  });
});

describe('stacking and merging suggestions', () => {
  const source = 'abcdefghij';

  it('applies disjoint and touching ranges', () => {
    const disjoint = [
      edit('a', 'ab', 'replace', 'AB'),
      edit('b', 'ef', 'replace', 'EF'),
    ];
    const touching = [
      edit('a', 'bc', 'replace', 'BC'),
      edit('b', 'de', 'replace', 'DE'),
    ];
    expect(
      mergeSuggestions(
        source,
        resolveSuggestions(source, disjoint),
        disjoint,
        'defaults'
      ).text
    ).toBe('ABcdEFghij');
    expect(
      mergeSuggestions(
        source,
        resolveSuggestions(source, touching),
        touching,
        'defaults'
      ).text
    ).toBe('aBCDEfghij');
  });

  it('applies insertions at both the start and end boundaries of a range', () => {
    const suggestions = [
      edit('replace', 'cde', 'replace', 'R'),
      edit('before', 'cde', 'before', '<'),
      edit('after', 'cde', 'after', '>'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(
      results.every(
        (result) => result.status === 'resolved' && result.group === null
      )
    ).toBe(true);
    expect(
      mergeSuggestions(source, results, suggestions, 'defaults').text
    ).toBe('ab<R>fghij');
  });

  it('orders distinct insertions at one point by creation time then id', () => {
    const suggestions = [
      edit('z', 'cd', 'before', 'Z', '2'),
      edit('b', 'ab', 'after', 'B', '1'),
      edit('a', 'cd', 'before', 'A', '1'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(
      results.every(
        (result) => result.status === 'resolved' && result.group === null
      )
    ).toBe(true);
    expect(
      mergeSuggestions(source, results, suggestions, 'defaults').text
    ).toBe('abABZcdefghij');
  });

  it('treats alternative fills of one empty notebook array as a conflict', () => {
    const notebook =
      '{"nbformat":4,"cells":[{"cell_type":"code","source":[],"outputs":[]}]}';
    const inputs = ['first', 'second'].map((name) => ({
      ...edit(name, '[', 'after', JSON.stringify(name)),
      prefix: '"source":',
      suffix: '],"outputs"',
    }));
    const offsets = emptyNotebookSourceOffsets(notebook);
    expect(
      offsets.has(notebook.indexOf('"source":[') + '"source":['.length)
    ).toBe(true);
    const results = resolveSuggestions(notebook, inputs, offsets);
    expect(resolved(results, 'first').group).toBe('first');
    expect(resolved(results, 'second').group).toBe('first');
    const merged = mergeSuggestions(notebook, results, inputs, 'defaults');
    expect(JSON.parse(merged.text).cells[0].source).toEqual(['first']);
    expect(() =>
      mergeSuggestions(notebook, results, inputs, new Set(['first', 'second']))
    ).toThrow();
  });

  it('keeps fills of different empty notebook cells independent', () => {
    const notebook =
      '{"nbformat":4,"cells":[{"cell_type":"code","id":"a","source":[]},{"cell_type":"code","id":"b","source":[]}]}';
    const inputs = ['a', 'b'].map((id) => ({
      ...edit(id, '[', 'after', JSON.stringify(id)),
      prefix: `"id":"${id}","source":`,
      suffix: ']}',
    }));
    const results = resolveSuggestions(
      notebook,
      inputs,
      emptyNotebookSourceOffsets(notebook)
    );
    expect(resolved(results, 'a').group).toBeNull();
    expect(resolved(results, 'b').group).toBeNull();
    const merged = JSON.parse(
      mergeSuggestions(notebook, results, inputs, 'defaults').text
    );
    expect(
      merged.cells.map((cell: { source: string[] }) => cell.source)
    ).toEqual([['a'], ['b']]);
  });

  it('treats an insertion strictly inside a range as a conflict', () => {
    const suggestions = [
      edit('range', 'bcde', 'replace', 'W'),
      edit('insert', 'cd', 'before', 'X'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(resolved(results, 'range').group).toBe('range');
    expect(resolved(results, 'insert').group).toBe('range');
    expect(mergeSuggestions(source, results, suggestions, 'defaults')).toEqual({
      text: 'aWfghij',
      applied: [{ id: 'range', start: 1, end: 5 }],
      skipped: [{ id: 'insert', reason: 'conflict' }],
    });
    expect(
      mergeSuggestions(source, results, suggestions, new Set(['insert'])).text
    ).toBe('abXcdefghij');
    expect(() =>
      mergeSuggestions(
        source,
        results,
        suggestions,
        new Set(['range', 'insert'])
      )
    ).toThrow();
  });

  it('conflicts overlapping and nested ranges', () => {
    for (const other of ['def', 'cd']) {
      const suggestions = [
        edit('outer', 'bcde', 'replace', 'W'),
        edit('other', other, 'replace', 'Z'),
      ];
      const results = resolveSuggestions(source, suggestions);
      expect(resolved(results, 'outer').group).toBe('outer');
      expect(resolved(results, 'other').group).toBe('outer');
      expect(
        mergeSuggestions(source, results, suggestions, 'defaults').text
      ).toBe('aWfghij');
    }
  });

  it('conflicts a delete and a replace on the same range', () => {
    const suggestions = [
      edit('a', 'cde', 'replace', ''),
      edit('b', 'cde', 'replace', 'Z'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(resolved(results, 'a').group).toBe('a');
    expect(resolved(results, 'b').group).toBe('a');
    expect(
      mergeSuggestions(source, results, suggestions, 'defaults').text
    ).toBe('abfghij');
    expect(
      mergeSuggestions(source, results, suggestions, new Set(['b'])).text
    ).toBe('abZfghij');
  });

  it('collapses identical edits and permits explicitly choosing an alias', () => {
    const suggestions = [
      edit('b', 'cde', 'replace', 'Z', '2'),
      edit('a', 'cde', 'replace', 'Z', '1'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(results).toEqual([
      {
        status: 'resolved',
        id: 'a',
        start: 2,
        end: 5,
        group: null,
        also: ['b'],
      },
    ]);
    expect(mergeSuggestions(source, results, suggestions, 'defaults')).toEqual({
      text: 'abZfghij',
      applied: [
        { id: 'a', start: 2, end: 5 },
        { id: 'b', start: 2, end: 5 },
      ],
      skipped: [],
    });
    expect(
      mergeSuggestions(source, results, suggestions, new Set(['b']))
    ).toEqual({
      text: 'abZfghij',
      applied: [{ id: 'b', start: 2, end: 5 }],
      skipped: [{ id: 'a', reason: 'not_picked' }],
    });
    expect(
      mergeSuggestions(source, results, suggestions, new Set(['b', 'a'])).text
    ).toBe('abZfghij');
  });

  it('groups a connected conflict component, including disjoint endpoints', () => {
    const suggestions = [
      edit('left', 'ab', 'replace', 'L'),
      edit('bridge', 'bcde', 'replace', 'B'),
      edit('right', 'ef', 'replace', 'R'),
    ];
    const results = resolveSuggestions(source, suggestions);
    expect(
      results.map((result) => result.status === 'resolved' && result.group)
    ).toEqual(['left', 'left', 'left']);
    expect(
      mergeSuggestions(source, results, suggestions, 'defaults').text
    ).toBe('Lcdefghij');
    expect(() =>
      mergeSuggestions(source, results, suggestions, new Set(['left', 'right']))
    ).toThrow();
  });

  it('reports unresolved entries and rejects unresolved or unknown explicit ids', () => {
    const suggestions = [
      edit('lost', 'zzz', 'replace', 'Z'),
      edit('ok', 'b', 'replace', 'B'),
    ];
    const results = resolveSuggestions('abcabc', suggestions);
    expect(results).toEqual([
      { status: 'lost', id: 'lost' },
      { status: 'ambiguous', id: 'ok' },
    ]);
    expect(
      mergeSuggestions('abcabc', results, suggestions, 'defaults')
    ).toEqual({
      text: 'abcabc',
      applied: [],
      skipped: [
        { id: 'lost', reason: 'lost' },
        { id: 'ok', reason: 'ambiguous' },
      ],
    });
    for (const id of ['lost', 'ok', 'unknown']) {
      expect(() =>
        mergeSuggestions('abcabc', results, suggestions, new Set([id]))
      ).toThrow();
    }
  });

  it('returns identical resolutions and merges for all orderings of six suggestions', () => {
    const text = 'abcdefghi';
    const suggestions = [
      edit('a', 'bcd', 'replace', 'X', '1'),
      edit('b', 'cde', 'replace', 'Y', '2'),
      edit('duplicate', 'bcd', 'replace', 'X', '3'),
      edit('before-a', 'b', 'before', '<', '1'),
      edit('before-b', 'b', 'before', '[', '2'),
      edit('end', 'gh', 'replace', 'Q', '1'),
    ];
    const expectedResolved = resolveSuggestions(text, suggestions);
    const expected = mergeSuggestions(
      text,
      expectedResolved,
      suggestions,
      'defaults'
    );
    expect(expected.text).toBe('a<[XefQi');
    expect(resolved(expectedResolved, 'a').also).toEqual(['duplicate']);
    const orders = permutations(suggestions);
    expect(orders).toHaveLength(720);
    for (const order of orders) {
      const result = resolveSuggestions(text, order);
      expect(result).toEqual(expectedResolved);
      expect(mergeSuggestions(text, result, order, 'defaults')).toEqual(
        expected
      );
      expect(
        mergeSuggestions(text, result, order, new Set(['before-b', 'b', 'end']))
      ).toEqual(
        mergeSuggestions(
          text,
          expectedResolved,
          suggestions,
          new Set(['end', 'b', 'before-b'])
        )
      );
    }
  });
});

describe('suggestionStates', () => {
  it('uses only publisher outcomes and applies outcome before resolution and reply', () => {
    const rows = [
      fact('s', {
        has_suggestion: true,
        resolution: { at: 'now', by: 'reader@example.com' },
      }),
      fact('fake', {
        addresses: 's',
        suggestion_outcome: 'declined',
        version: 4,
      }),
      fact('old', {
        author: 'publisher',
        addresses: 's',
        suggestion_outcome: 'deferred',
        version: 1,
        created_at: 'z',
      }),
      fact('accepted', {
        author: 'publisher',
        addresses: 's',
        suggestion_outcome: 'accepted',
        version: 2,
        created_at: 'a',
      }),
      fact('reply', { author: 'publisher', addresses: 's', version: 3 }),
    ];
    expect(suggestionStates(rows, 3).get('s')).toEqual({
      state: 'accepted',
      text: 'Accepted in v2',
      answer: { comment_id: 'accepted', version: 2, outcome: 'accepted' },
    });
    expect(suggestionStates([...rows].reverse(), 3).get('s')).toEqual(
      suggestionStates(rows, 3).get('s')
    );
  });

  it('orders same-version outcomes by time and breaks exact ties by id', () => {
    const rows = [
      fact('s', { has_suggestion: true }),
      fact('a', {
        author: 'publisher',
        addresses: 's',
        suggestion_outcome: 'accepted',
        version: 2,
        created_at: '1',
      }),
      fact('b', {
        author: 'publisher',
        addresses: 's',
        suggestion_outcome: 'declined',
        version: 2,
        created_at: '2',
      }),
      fact('c', {
        author: 'publisher',
        addresses: 's',
        suggestion_outcome: 'superseded',
        version: 2,
        created_at: '2',
      }),
    ];
    expect(suggestionStates(rows, 2).get('s')).toEqual({
      state: 'superseded',
      text: 'Superseded',
      answer: { comment_id: 'c', version: 2, outcome: 'superseded' },
    });
  });

  it('provides card text for each outcome', () => {
    const expected = [
      ['accepted', 'Accepted in v2'],
      ['superseded', 'Superseded'],
      ['declined', 'Not taken'],
      ['deferred', 'Seen by the publisher, not applied yet'],
    ] as const;
    for (const [outcome, text] of expected) {
      const rows = [
        fact('s', { has_suggestion: true }),
        fact('answer', {
          author: 'publisher',
          addresses: 's',
          suggestion_outcome: outcome,
          version: 2,
        }),
      ];
      expect(suggestionStates(rows, 2).get('s')).toEqual({
        state: outcome,
        text,
        answer: { comment_id: 'answer', version: 2, outcome },
      });
    }
  });

  it('orders withdrawal, closure, reply, pending and unanswered; ignores reader outcomes', () => {
    const rows = [
      fact('withdrawn', {
        has_suggestion: true,
        resolution: { at: 'now', by: 'reader@example.com' },
      }),
      fact('closed', {
        has_suggestion: true,
        resolution: { at: 'now', by: 'publisher' },
      }),
      fact('replied', { has_suggestion: true }),
      fact('pending', {
        has_suggestion: true,
        version: 2,
        resolution: { at: 'now', by: 'stranger' },
      }),
      fact('unanswered', { has_suggestion: true }),
      fact('publisher-reply', {
        author: 'publisher',
        addresses: 'replied',
        version: 2,
      }),
      fact('withdrawn-reply', {
        author: 'publisher',
        addresses: 'withdrawn',
        version: 2,
      }),
      fact('closed-reply', {
        author: 'publisher',
        addresses: 'closed',
        version: 2,
      }),
      fact('fake-outcome', {
        addresses: 'pending',
        suggestion_outcome: 'accepted',
        version: 2,
      }),
      fact('reader-reply', { addresses: 'unanswered', version: 2 }),
      fact('ordinary'),
    ];
    const states = suggestionStates(rows, 2);
    expect(states.get('withdrawn')).toEqual({
      state: 'withdrawn',
      text: 'Withdrawn',
      answer: null,
    });
    expect(states.get('closed')).toEqual({
      state: 'closed',
      text: 'Closed by the publisher',
      answer: null,
    });
    expect(states.get('replied')).toEqual({
      state: 'replied',
      text: 'The publisher replied',
      answer: { comment_id: 'publisher-reply', version: 2, outcome: null },
    });
    expect(states.get('pending')).toEqual({
      state: 'pending',
      text: 'Suggested',
      answer: null,
    });
    expect(states.get('unanswered')).toEqual({
      state: 'unanswered',
      text: 'No answer from the publisher is visible to you',
      answer: null,
    });
    expect(states.has('ordinary')).toBe(false);
  });
});

describe('suggestionFallbackBody', () => {
  it('describes replacement, deletion, and insertions with LF and TAB as spaces', () => {
    expect(
      suggestionFallbackBody('old\nvalue', {
        v: 1,
        mode: 'replace',
        replacement: 'new\tvalue',
      })
    ).toBe(
      'Suggested edit: replace "old value" with "new value". A current Relic viewer shows it in place.'
    );
    expect(
      suggestionFallbackBody('old', { v: 1, mode: 'replace', replacement: '' })
    ).toBe(
      'Suggested edit: delete "old". A current Relic viewer shows it in place.'
    );
    expect(
      suggestionFallbackBody('old', {
        v: 1,
        mode: 'before',
        replacement: 'new',
      })
    ).toBe(
      'Suggested edit: insert "new" before "old". A current Relic viewer shows it in place.'
    );
    expect(
      suggestionFallbackBody('old', { v: 1, mode: 'after', replacement: 'new' })
    ).toBe(
      'Suggested edit: insert "new" after "old". A current Relic viewer shows it in place.'
    );
  });

  it('clips each excerpt to 96 UTF-8 bytes without cutting a code point', () => {
    const text = suggestionFallbackBody('😀'.repeat(50), {
      v: 1,
      mode: 'replace',
      replacement: 'é'.repeat(60),
    });
    const excerpts = [...text.matchAll(/"([^"]*)"/g)].map(
      (match) => match[1] ?? ''
    );
    expect(excerpts).toHaveLength(2);
    expect(
      excerpts.every((excerpt) => encoder.encode(excerpt).byteLength <= 96)
    ).toBe(true);
    expect(excerpts.every((excerpt) => excerpt.endsWith('…'))).toBe(true);
    expect(excerpts.every((excerpt) => !excerpt.includes('\ufffd'))).toBe(true);
    const exactly = suggestionFallbackBody('a'.repeat(96), {
      v: 1,
      mode: 'replace',
      replacement: 'b',
    });
    expect(exactly).toContain(`"${'a'.repeat(96)}"`);
  });
});
