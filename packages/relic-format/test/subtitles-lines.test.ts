import { describe, expect, test } from 'bun:test';
import { parseSubtitles, SUBTITLE_LIMIT_BYTES } from '../src/subtitles.ts';

describe('subtitle lines are read one at a time, with the same numbers as before', () => {
  test('cue line numbers count CR, CRLF and LF breaks alike', () => {
    const text =
      '1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\r2\n00:00:03,000 --> 00:00:04,000\nthere';
    const parsed = parseSubtitles(text, 'srt');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cues = parsed.file.entries.filter((entry) => entry.kind === 'cue');
    expect(cues.map((cue) => cue.line)).toEqual([1, 5]);
    expect(cues.map((cue) => cue.text)).toEqual(['hi', 'there']);
  });

  test('a byte-order mark is skipped and the first line is line 1', () => {
    const parsed = parseSubtitles(
      '\ufeff1\n00:00:01,000 --> 00:00:02,000\nhi\n',
      'srt'
    );
    expect(parsed.ok && parsed.file.entries[0]).toMatchObject({
      kind: 'cue',
      line: 1,
    });
  });

  test('a file of nothing but line feeds is refused as having no cues, without a line array', () => {
    const text = '\n'.repeat(SUBTITLE_LIMIT_BYTES);
    expect(parseSubtitles(text, 'srt')).toEqual({
      ok: false,
      reason: 'no-cues',
      skipped: 0,
    });
  });
});

describe('subtitle parsing: a 16 MiB file of line feeds costs no line array', () => {
  test('it never splits the text into a line array', () => {
    // The whole-file split built a 16-million element array before the entry
    // cap applied. Count what the parse asks String.prototype.split to build
    // instead of timing it, so a slow or busy machine cannot change the answer.
    const text = '\n'.repeat(SUBTITLE_LIMIT_BYTES);
    const realSplit = String.prototype.split;
    let largest = 0;
    String.prototype.split = function (this: string, ...args: unknown[]) {
      const out = (realSplit as (...a: unknown[]) => string[]).apply(
        this,
        args
      );
      largest = Math.max(largest, out.length);
      return out;
    } as typeof String.prototype.split;
    try {
      expect(parseSubtitles(text, 'srt').ok).toBe(false);
    } finally {
      String.prototype.split = realSplit;
    }
    expect(largest).toBeLessThan(1000);
    // The same text split the old way is the array the parse must not build.
    expect(text.split(/\r\n|\r|\n/).length).toBeGreaterThan(1_000_000);
  });
});
