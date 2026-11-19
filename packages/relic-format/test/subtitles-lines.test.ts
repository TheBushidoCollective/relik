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
  test('it costs less than half of splitting the same text into lines', () => {
    // The whole-file split built a 16-million element array before the entry
    // cap applied. Both timings are taken in this process, so the bound holds
    // on a slow machine as well as a fast one.
    const text = '\n'.repeat(SUBTITLE_LIMIT_BYTES);
    expect('1\n2'.split(/\r\n|\r|\n/)).toHaveLength(2);
    expect(parseSubtitles('\n\n', 'srt').ok).toBe(false);
    const splitStarted = performance.now();
    text.split(/\r\n|\r|\n/);
    const split = performance.now() - splitStarted;
    const parseStarted = performance.now();
    expect(parseSubtitles(text, 'srt').ok).toBe(false);
    const parse = performance.now() - parseStarted;
    expect(parse).toBeLessThan(split / 2);
  });
});
