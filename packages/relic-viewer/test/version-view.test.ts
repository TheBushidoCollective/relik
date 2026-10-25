/**
 * Viewing an earlier version that cannot be compared.
 *
 * The reported defect: a reader opens an earlier version, Relik cannot show
 * it beside the current one, and the reader is shown a sentence explaining
 * that instead of the version they asked for. The version they asked for is
 * the thing they came for. The comparison was the bonus.
 *
 * Three causes produce it and all three are covered here, because fixing the
 * one that was noticed would leave the other two.
 *
 * The taskbar assertions live in `version-diff-ui.test.ts`, which already
 * carries a DOM stub; a second stub here would drift from that one.
 */

import { describe, expect, test } from 'bun:test';
import {
  comparisonAvailability,
  versionHistoryAvailability,
} from '../src/diff.ts';
import { uncomparableReason } from '../src/main.ts';
import type { ReadyView } from '../src/viewer.ts';

function view(
  route: ReadyView['route'],
  version: number,
  currentVersion = version,
  filename = 'notes.md',
  content = new TextEncoder().encode('hello\n')
): ReadyView {
  return {
    filename,
    declaredMimetype: 'text/markdown',
    content,
    route,
    downgradeNotice: undefined,
    shareUrl: 'https://relik.link/aaaaaaaaaaaaaaaaaaaaaaaaaa#AByGl0K5dY3iw9g',
    version,
    currentVersion,
    versionDigest: '0'.repeat(64),
  };
}

describe('history is offered separately from comparison', () => {
  test('a relic with earlier versions has history, whatever its class', () => {
    // The two predicates were one, which is the whole defect: a download-only
    // relic reported no history and therefore got no control, while a notice
    // on the page said earlier versions existed.
    for (const route of ['media', 'download', 'code', 'markdown'] as const) {
      const v = view(route as ReadyView['route'], 3, 3);
      expect(versionHistoryAvailability(v).kind).toBe('available');
    }
  });

  test('a first version has no history to offer', () => {
    expect(versionHistoryAvailability(view('code', 1, 1)).kind).toBe('none');
  });

  test('download-only has history but no comparison', () => {
    const v = view('download', 3, 3);
    expect(versionHistoryAvailability(v).kind).toBe('available');
    expect(comparisonAvailability(v).kind).toBe('unavailable');
  });

  test('the unavailable copy never claims the versions are unreachable', () => {
    const availability = comparisonAvailability(view('download', 3, 3));
    if (availability.kind !== 'unavailable')
      throw new Error('expected refusal');
    // The old wording opened with "Earlier versions exist, but" and then
    // described an absence, which reads as the versions being unavailable.
    expect(availability.detail).not.toContain('Earlier versions exist, but');
    expect(availability.detail).toContain('on its own');
  });
});

describe('the reason a version stands alone', () => {
  test('names the historical version when it is the download-only one', () => {
    const reason = uncomparableReason(
      view('code', 3, 3),
      view('download', 2, 3, 'archive.zip'),
      2
    );
    expect(reason).toContain('Version 2 is download-only');
    expect(reason).toContain('open here on its own');
  });

  test('names the current version when it is the download-only one', () => {
    const reason = uncomparableReason(
      view('download', 3, 3, 'archive.zip'),
      view('code', 2, 3),
      2
    );
    expect(reason).toContain('Version 3 is download-only');
    expect(reason).toContain('Version 2 is open here on its own');
  });

  test('says they display differently when both are renderable', () => {
    // The reported case: version 2 was prose, version 3 is a picture. Both
    // open fine and neither can be shown beside the other.
    const reason = uncomparableReason(
      view('image', 3, 3, 'chart.png'),
      view('markdown', 2, 3),
      2
    );
    expect(reason).toContain('display differently');
    expect(reason).toContain('Version 2 is open here on its own');
  });

  test('every reason says the version is open, never only why it is not', () => {
    // The guarantee, stated once over all three causes: whatever the reason,
    // the sentence ends by telling the reader they have the version.
    const pairs: readonly (readonly [ReadyView, ReadyView])[] = [
      [view('code', 3, 3), view('download', 2, 3)],
      [view('download', 3, 3), view('code', 2, 3)],
      [view('image', 3, 3), view('markdown', 2, 3)],
    ];
    for (const [current, historical] of pairs) {
      expect(uncomparableReason(current, historical, 2)).toContain(
        'on its own'
      );
    }
  });
});
