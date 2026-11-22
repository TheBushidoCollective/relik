import { describe, expect, test } from 'bun:test';
import { contentFromBytes } from '../src/content.ts';
import {
  type ComparableView,
  comparisonAvailability,
  createImageDiff,
  createTextDiff,
  diffCeilingFor,
  diffModeForView,
  diffModeForViews,
  MAX_DIFF_BYTES,
  uncomparableClassNoun,
  unpromptedComparisonNotice,
  versionHistoryCopy,
} from '../src/diff.ts';
import type { ReadyView, RenderRoute } from '../src/viewer.ts';

const encoder = new TextEncoder();

const viewOf = (route: RenderRoute): ComparableView => ({ route });

function ready(
  route: ReadyView['route'],
  content: Uint8Array,
  currentVersion = 3
): ReadyView {
  return {
    filename: 'artifact.txt',
    declaredMimetype: 'text/plain',
    content: contentFromBytes(content),
    document: { bytes: content, truncated: false },
    route,
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#key',
    version: currentVersion,
    currentVersion,
    versionDigest: '0'.repeat(64),
  };
}

describe('the code line comparison', () => {
  test('reports changed lines and inline edits', () => {
    const result = createTextDiff(
      'const answer = 41;\nkeep();\n',
      'const answer = 42;\nkeep();\n'
    );

    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.parts.some((part) => part.kind === 'added')).toBe(true);
    expect(result.parts.some((part) => part.kind === 'removed')).toBe(true);
    expect(
      result.parts
        .flatMap((part) => part.segments ?? [])
        .some((segment) => segment.kind === 'added' && segment.text === '42')
    ).toBe(true);
    expect(
      result.parts
        .flatMap((part) => part.segments ?? [])
        .some((segment) => segment.kind === 'removed' && segment.text === '41')
    ).toBe(true);
  });

  test('names identical content instead of producing an empty diff', () => {
    const result = createTextDiff('same\ncontent\n', 'same\ncontent\n');

    expect(result.changed).toBe(false);
    expect(result.parts).toEqual([]);
    expect(result.summary).toBe(
      'No changes. These versions have identical content.'
    );
  });
});

describe('image version comparisons', () => {
  test('describes a changed image and its dimension delta', () => {
    const result = createImageDiff(
      encoder.encode('old pixels'),
      encoder.encode('new pixels'),
      { width: 640, height: 480 },
      { width: 800, height: 450 }
    );

    expect(result.changed).toBe(true);
    expect(result.summary).toBe(
      'Version dimensions: 640 x 480 px to 800 x 450 px. Width +160 px, height -30 px.'
    );
  });

  test('names byte-identical images instead of rendering an empty comparison', () => {
    const bytes = encoder.encode('same pixels');
    const result = createImageDiff(
      bytes,
      bytes.slice(),
      { width: 640, height: 480 },
      { width: 640, height: 480 }
    );

    expect(result.changed).toBe(false);
    expect(result.summary).toBe(
      'No changes. These versions have identical content.'
    );
  });
});

describe('version history labels', () => {
  test('names both versions and says which one is current history', () => {
    expect(versionHistoryCopy(5, 2)).toEqual({
      headline: 'Comparing version 2 with version 5',
      detail:
        'Version 5 is current. Version 2 is retained history and may contain ' +
        'content removed from the current artifact.',
    });
  });
});

describe('comparison availability', () => {
  test('maps each renderable class onto its comparison mode', () => {
    expect(diffModeForView(viewOf('markdown'))).toBe('markdown');
    expect(diffModeForView(viewOf('code'))).toBe('code');
    expect(diffModeForView(viewOf('notebook'))).toBe('code');
    expect(diffModeForView(viewOf('sandboxed-html'))).toBe('rendered');
    expect(diffModeForView(viewOf('sandboxed-jsx'))).toBe('rendered');
    expect(diffModeForView(viewOf('image'))).toBe('image');
  });

  test('leaves documents and workbooks without a mode until they are on', () => {
    expect(
      diffModeForView({ route: 'sandboxed-document', documentKind: 'docx' })
    ).toBeUndefined();
    expect(
      diffModeForView({ route: 'sandboxed-document', documentKind: 'epub' })
    ).toBeUndefined();
    expect(diffModeForView(viewOf('spreadsheet'))).toBeUndefined();
  });

  test('gives classes that play, show or only download no mode', () => {
    for (const route of ['otio', 'media', 'pdf', 'model', 'download'] as const)
      expect(diffModeForView(viewOf(route))).toBeUndefined();
  });

  test('pairs two versions only when both render in the same mode', () => {
    expect(diffModeForViews(viewOf('markdown'), viewOf('markdown'))).toBe(
      'markdown'
    );
    expect(diffModeForViews(viewOf('code'), viewOf('code'))).toBe('code');
    expect(diffModeForViews(viewOf('image'), viewOf('image'))).toBe('image');
    expect(
      diffModeForViews(viewOf('sandboxed-html'), viewOf('sandboxed-html'))
    ).toBe('rendered');
  });

  test('refuses a pair whose two versions render in different modes', () => {
    // Feeding a rendered page to the prose comparison, or an image to
    // either, produces a confident result with no meaning.
    expect(
      diffModeForViews(viewOf('markdown'), viewOf('sandboxed-html'))
    ).toBeUndefined();
    expect(
      diffModeForViews(viewOf('code'), viewOf('markdown'))
    ).toBeUndefined();
    expect(diffModeForViews(viewOf('image'), viewOf('code'))).toBeUndefined();
    expect(
      diffModeForViews(viewOf('markdown'), viewOf('download'))
    ).toBeUndefined();
    expect(
      diffModeForViews(viewOf('download'), viewOf('markdown'))
    ).toBeUndefined();
  });

  test('does not offer history to a version 1 relic', () => {
    expect(
      comparisonAvailability(ready('code', encoder.encode('one'), 1))
    ).toEqual({
      kind: 'none',
    });
  });

  test('offers history to a diffable version 2 or higher relic', () => {
    expect(
      comparisonAvailability(ready('code', encoder.encode('two'), 2))
    ).toEqual({
      kind: 'available',
      mode: 'code',
    });
  });

  test('states why a download-only relic cannot be compared', () => {
    const result = comparisonAvailability(
      ready('download', encoder.encode('zip bytes'))
    );

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.code).toBe('comparison_not_renderable');
    expect(result.detail).toContain('download-only');
  });

  test('otio, media and pdf give comparison_not_supported naming the class noun without saying download-only', () => {
    for (const [route, expectedNoun] of [
      ['otio', 'timeline'],
      ['media', 'recording'],
      ['pdf', 'PDF'],
    ] as const) {
      expect(uncomparableClassNoun(route)).toBe(expectedNoun);
      const result = comparisonAvailability(
        ready(route, encoder.encode('bytes'), 2)
      );
      expect(result.kind).toBe('unavailable');
      if (result.kind !== 'unavailable') return;
      expect(result.code).toBe('comparison_not_supported');
      expect(result.detail).not.toContain('download-only');
      expect(result.detail).toContain(expectedNoun);
    }
  });

  test('unpromptedComparisonNotice gives notice for download and oversize, undefined for otio, media, pdf and comparable', () => {
    const downloadView = ready('download', encoder.encode('bytes'), 2);
    expect(unpromptedComparisonNotice(downloadView)).toContain('download-only');

    const oversizeView = ready('code', new Uint8Array(MAX_DIFF_BYTES + 1), 2);
    expect(unpromptedComparisonNotice(oversizeView)).toContain('16 MiB');

    for (const route of ['otio', 'media', 'pdf'] as const) {
      const view = ready(route, encoder.encode('bytes'), 2);
      expect(unpromptedComparisonNotice(view)).toBeUndefined();
    }

    const comparableView = ready('code', encoder.encode('code'), 2);
    expect(unpromptedComparisonNotice(comparableView)).toBeUndefined();
  });

  test('refuses content over the diff ceiling without changing the current view', () => {
    const current = ready('code', new Uint8Array(MAX_DIFF_BYTES + 1));
    const result = comparisonAvailability(current);

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.code).toBe('comparison_too_large');
    expect(result.detail).toContain('16 MiB');
    expect(current.route).toBe('code');
    expect(current.content.size).toBe(MAX_DIFF_BYTES + 1);
  });

  test('every comparable mode shares the same ceiling', () => {
    const ceiling = diffCeilingFor('code');
    expect(ceiling.bytes).toBe(MAX_DIFF_BYTES);
    expect(ceiling.label).toBe('16 MiB');
    for (const mode of ['markdown', 'rendered', 'image'] as const) {
      expect(diffCeilingFor(mode)).toEqual(ceiling);
    }
  });

  test('refuses a markdown payload over the ceiling and leaves the current view', () => {
    const current = ready('markdown', new Uint8Array(MAX_DIFF_BYTES + 1));
    const result = comparisonAvailability(current);

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.code).toBe('comparison_too_large');
    expect(result.detail).toContain('16 MiB');
    expect(current.route).toBe('markdown');
    expect(current.content.size).toBe(MAX_DIFF_BYTES + 1);
  });
});
