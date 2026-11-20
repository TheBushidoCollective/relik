import { describe, expect, test } from 'bun:test';
import {
  parseSubtitles,
  SUBTITLE_LIMIT_BYTES,
  SUBTITLE_MAX_CUES,
  SUBTITLE_MAX_TEXT_CHARS,
  type SubtitleCue,
  type SubtitleFile,
  type SubtitleParseResult,
  subtitleFormatFor,
  utf8ByteLength,
} from '../src/subtitles.ts';

function read(text: string, format: 'srt' | 'vtt'): SubtitleFile {
  const result: SubtitleParseResult = parseSubtitles(text, format);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.file;
}

function cuesOf(file: SubtitleFile): SubtitleCue[] {
  return file.entries.filter(
    (entry): entry is SubtitleCue => entry.kind === 'cue'
  );
}

/** The rendered runs of a cue as `[text, flags]` pairs, for exact assertions. */
function runsOf(cue: SubtitleCue): string[] {
  return cue.segments.map((segment) => {
    const flags = [
      segment.bold ? 'b' : '',
      segment.italic ? 'i' : '',
      segment.underline ? 'u' : '',
    ].join('');
    return flags === '' ? segment.text : `${flags}:${segment.text}`;
  });
}

// The S1 fixture from the mock (docs/plans/structured-formats/mockup.html,
// `CUES`): a WebVTT file with a STYLE block, two NOTE blocks, speakers and italics.
const S1_VTT = [
  'WEBVTT',
  '',
  'STYLE',
  '::cue(v[voice="Lena Brandt"]) { color: #a7ded6; }',
  '',
  'NOTE',
  'Recorded 2026-09-11 at Tamarack yard. Timings checked against the 25 fps master.',
  '',
  '00:00:01.200 --> 00:00:04.800',
  '<v Lena Brandt>This is Larkspur Field 4.12, on a tablet with no signal.',
  '',
  '00:00:05.100 --> 00:00:08.900',
  '<v Lena Brandt>I\u2019m filling in a hydrant inspection the way the crews do it.',
  '',
  '00:00:09.300 --> 00:00:12.600',
  '<i>Tap, tap. Photo of the bonnet.</i>',
  '',
  '00:00:13.000 --> 00:00:17.400',
  '<v Lena Brandt>The form saves to the device. The queue banner says <i>one form waiting</i>.',
  '',
  '00:00:17.900 --> 00:00:21.200',
  '<v Marcus Ohene>And if she drives out of the dead zone?',
  '',
  '00:00:21.400 --> 00:00:25.900',
  '<v Lena Brandt>It sends on its own. No button. The server checks every form by checksum.',
  '',
  '00:00:26.300 --> 00:00:30.100',
  '<v Marcus Ohene>What you must not do is clear the app\u2019s data while forms are waiting.',
  '',
  'NOTE',
  'Legal asked for this line word for word. Do not shorten it in the cut.',
  '',
  '00:00:30.500 --> 00:00:34.800',
  '<v Marcus Ohene>Those forms live only on the device until the server confirms them.',
  '',
  '00:00:35.200 --> 00:00:38.600',
  '<i>Banner turns green: 0 forms waiting.</i>',
  '',
  '00:00:39.000 --> 00:00:43.400',
  '<v Lena Brandt>That\u2019s the whole trick. Fill it in where you stand.',
  '',
  '00:00:43.800 --> 00:00:46.200',
  '<v Lena Brandt>Sync when you can.',
  '',
  '00:00:46.900 --> 00:00:51.000',
  '<img src=x onerror=alert(1)> Ask the crew lead before a device changes hands.',
  '',
  '00:00:51.400 --> 00:00:55.000',
  '<v Marcus Ohene>Version 4.12 is on the managed tablets from Monday.',
  '',
].join('\n');

// The S3 fixture: an SRT whose four blocks cannot be read as cues.
const S3_SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'First cue.',
  '',
  'x',
  '00:00:03,000 -> 00:00:04,000',
  'Broken arrow.',
  '',
  '3',
  '00:00:05,000 --> 00:00:04,000',
  'Ends before it starts.',
  '',
  '4',
  '00:00:06,000 --> 00:00:07,000',
  '',
  '5',
  '00:01,000 --> 00:00:09,000',
  'No hours in SubRip.',
  '',
  '6',
  '00:00:10,000 --> 00:00:11,000',
  'Last cue.',
  '',
].join('\n');

describe('subtitleFormatFor', () => {
  test('the extension decides before the declared type', () => {
    expect(subtitleFormatFor('a.vtt', 'application/x-subrip')).toBe('vtt');
    expect(subtitleFormatFor('a.srt', 'text/vtt')).toBe('srt');
  });

  test('the declared type decides when the extension does not map', () => {
    expect(subtitleFormatFor('captions', 'text/vtt; charset=utf-8')).toBe(
      'vtt'
    );
    expect(subtitleFormatFor('captions', 'application/x-subrip')).toBe('srt');
  });
});

describe('SRT and WebVTT: the file as a reader sees it', () => {
  test('S1: the cue list reads speakers, italics, NOTE and STYLE blocks', () => {
    const file = read(S1_VTT, 'vtt');
    const cues = cuesOf(file);
    expect(file.cueCount).toBe(13);
    expect(cues).toHaveLength(13);
    expect(file.skipped).toBe(0);
    expect(cues[0]?.start).toBe(1.2);
    expect(cues[0]?.end).toBe(4.8);
    expect(cues[0]?.speaker).toBe('Lena Brandt');
    expect(runsOf(cues[2] as SubtitleCue)).toEqual([
      'i:Tap, tap. Photo of the bonnet.',
    ]);
    expect(runsOf(cues[3] as SubtitleCue)).toEqual([
      'The form saves to the device. The queue banner says ',
      'i:one form waiting',
      '.',
    ]);
    const blocks = file.entries.filter((entry) => entry.kind !== 'cue');
    expect(blocks.map((block) => block.kind)).toEqual([
      'style',
      'note',
      'note',
    ]);
    expect(blocks[1]?.kind === 'note' && blocks[1].text).toContain(
      'Tamarack yard'
    );
  });

  test('S1: markup in a cue is text, not an element (the hostile cue)', () => {
    const cue = cuesOf(read(S1_VTT, 'vtt'))[11] as SubtitleCue;
    expect(cue.text).toBe(
      '<img src=x onerror=alert(1)> Ask the crew lead before a device changes hands.'
    );
    expect(cue.speaker).toBeUndefined();
    expect(
      cue.segments.every((segment) => !segment.italic && !segment.bold)
    ).toBe(true);
  });

  test('S3: four unreadable blocks are skipped and counted, the rest still reads', () => {
    const file = read(S3_SRT, 'srt');
    expect(cuesOf(file).map((cue) => cue.text)).toEqual([
      'First cue.',
      'Last cue.',
    ]);
    expect(file.skipped).toBe(4);
    expect(file.firstSkipped).toEqual({ line: 5, reason: 'no timing line' });
  });

  test('a BOM and CRLF line endings are read as LF', () => {
    const file = read(
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n',
      'srt'
    );
    expect(cuesOf(file).map((cue) => cue.text)).toEqual(['Hello', 'World']);
  });

  test('a lone CR is a line break in WebVTT too', () => {
    const file = read(
      'WEBVTT\r\r00:00:01.000 --> 00:00:02.000\rline one\rline two',
      'vtt'
    );
    expect(cuesOf(file)[0]?.text).toBe('line one\nline two');
  });

  test('numeric, missing and text identifiers are all accepted and kept when present', () => {
    const file = read(
      [
        '7',
        '00:00:01,000 --> 00:00:02,000',
        'numeric id',
        '',
        '00:00:02,000 --> 00:00:03,000',
        'no id',
        '',
        'intro-cue',
        '00:00:03,000 --> 00:00:04,000',
        'text id',
      ].join('\n'),
      'srt'
    );
    const cues = cuesOf(file);
    expect(cues.map((cue) => cue.id)).toEqual(['7', undefined, 'intro-cue']);
    expect(cues.map((cue) => cue.index)).toEqual([1, 2, 3]);
  });

  test('SubRip needs hours, WebVTT takes mm:ss.mmm and hours are optional there', () => {
    const vtt = read('WEBVTT\n\n01:02.500 --> 01:04.000\nshort form', 'vtt');
    expect(cuesOf(vtt)[0]?.start).toBe(62.5);
    const srt = parseSubtitles('1\n01:02,500 --> 01:04,000\nno hours', 'srt');
    expect(srt).toEqual({ ok: false, reason: 'no-cues', skipped: 1 });
  });

  test('commas and dots are both accepted as the decimal mark', () => {
    const file = read('1\n00:00:01,250 --> 00:00:02.750\nmixed', 'srt');
    expect(cuesOf(file)[0]).toMatchObject({ start: 1.25, end: 2.75 });
  });

  test('overlapping cues are both kept, in file order', () => {
    const file = read(
      'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nfirst\n\n00:00:03.000 --> 00:00:04.000\nsecond',
      'vtt'
    );
    expect(cuesOf(file).map((cue) => cue.text)).toEqual(['first', 'second']);
  });

  test('a zero-length cue is accepted, a reversed one is skipped', () => {
    const file = read(
      'WEBVTT\n\n00:00:02.000 --> 00:00:02.000\npoint\n\n00:00:04.000 --> 00:00:03.000\nreversed',
      'vtt'
    );
    expect(cuesOf(file).map((cue) => cue.text)).toEqual(['point']);
    expect(file.skipped).toBe(1);
  });

  test('a cue with timing but no text is skipped and counted', () => {
    const result = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n', 'srt');
    expect(result).toEqual({ ok: false, reason: 'no-cues', skipped: 1 });
  });

  test('NOTE, STYLE and REGION blocks are kept as blocks, never as cues', () => {
    const file = read(
      'WEBVTT\n\nREGION\nid:fred\nwidth:40%\n\nSTYLE\n::cue { color: red; }\n\nNOTE A note on one line\n\n00:00:01.000 --> 00:00:02.000\nreal cue',
      'vtt'
    );
    expect(file.entries.map((entry) => entry.kind)).toEqual([
      'region',
      'style',
      'note',
      'cue',
    ]);
    expect(file.entries[2]).toMatchObject({ text: 'A note on one line' });
  });

  test('a NOTE block that contains --> is refused as malformed', () => {
    const file = read(
      'WEBVTT\n\nNOTE 00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nkept',
      'vtt'
    );
    expect(cuesOf(file).map((cue) => cue.text)).toEqual(['kept']);
    expect(file.skipped).toBe(1);
  });

  test('in SubRip, NOTE and STYLE are ordinary blocks, not blocks of their own', () => {
    const file = read(
      '1\n00:00:01,000 --> 00:00:02,000\nNOTE then text',
      'srt'
    );
    expect(file.entries.map((entry) => entry.kind)).toEqual(['cue']);
  });

  test('a file with no cues returns no-cues with the skipped count', () => {
    expect(parseSubtitles('WEBVTT\n\nNOTE only a note', 'vtt')).toEqual({
      ok: false,
      reason: 'no-cues',
      skipped: 0,
    });
    expect(parseSubtitles('', 'srt')).toEqual({
      ok: false,
      reason: 'no-cues',
      skipped: 0,
    });
  });
});

describe('inline markup: a fixed set of names, everything else text', () => {
  test('b, i and u become runs, and nest', () => {
    const [cue] = cuesOf(
      read(
        '1\n00:00:01,000 --> 00:00:02,000\n<b>bold <i>both</i></b> <u>under</u>',
        'srt'
      )
    ) as [SubtitleCue];
    expect(runsOf(cue)).toEqual(['b:bold ', 'bi:both', ' ', 'u:under']);
  });

  test('a voice tag sets the speaker and its text is kept', () => {
    const [cue] = cuesOf(
      read(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana &amp; Ben>hello</v>',
        'vtt'
      )
    ) as [SubtitleCue];
    expect(cue.speaker).toBe('Ana & Ben');
    expect(cue.text).toBe('hello');
  });

  test('class, language, ruby and timestamp tags are markup and drop out of the text', () => {
    const [cue] = cuesOf(
      read(
        'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c.yellow>yes</c> <lang en>hi</lang> <ruby>漢<rt>kan</rt></ruby> <00:00:02.000>now',
        'vtt'
      )
    ) as [SubtitleCue];
    expect(cue.text).toBe('yes hi 漢kan now');
  });

  test('any other tag is text, shown as written', () => {
    const [cue] = cuesOf(
      read(
        '1\n00:00:01,000 --> 00:00:02,000\n<font color=red>x</font> <3 you',
        'srt'
      )
    ) as [SubtitleCue];
    expect(cue.text).toBe('<font color=red>x</font> <3 you');
    expect(
      cue.segments.every((segment) => !segment.bold && !segment.italic)
    ).toBe(true);
  });

  test('entities decode once, so &amp;lt; is the text &lt;', () => {
    const [cue] = cuesOf(
      read(
        '1\n00:00:01,000 --> 00:00:02,000\nA &amp; B &lt;tag&gt; &amp;lt; &nbsp;x',
        'srt'
      )
    ) as [SubtitleCue];
    expect(cue.text).toBe('A & B <tag> &lt; \u00a0x');
  });

  test('a closing tag with no open tag is ignored', () => {
    const [cue] = cuesOf(
      read(
        '1\n00:00:01,000 --> 00:00:02,000\nplain </i> and <b>bold</b>',
        'srt'
      )
    ) as [SubtitleCue];
    expect(runsOf(cue)).toEqual(['plain  and ', 'b:bold']);
  });
});

describe('hostile input stays text and stays bounded', () => {
  test('script and event-handler markup creates no element and no flags', () => {
    const [cue] = cuesOf(
      read(
        '1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script><img src=x onerror="alert(2)">',
        'srt'
      )
    ) as [SubtitleCue];
    expect(cue.text).toBe(
      '<script>alert(1)</script><img src=x onerror="alert(2)">'
    );
    expect(
      cue.segments.every(
        (segment) => !segment.bold && !segment.italic && !segment.underline
      )
    ).toBe(true);
  });

  test('a 10 MB single cue is cut to the cap, flagged, and read in bounded time', () => {
    const body = 'a'.repeat(10 * 1024 * 1024);
    const started = performance.now();
    const file = read(`1\n00:00:01,000 --> 00:00:02,000\n${body}`, 'srt');
    const elapsed = performance.now() - started;
    const [cue] = cuesOf(file) as [SubtitleCue];
    expect(cue.truncated).toBe(true);
    expect(cue.text.length).toBe(SUBTITLE_MAX_TEXT_CHARS);
    expect(cue.start).toBe(1);
    expect(cue.end).toBe(2);
    expect(elapsed).toBeLessThan(2000);
  });

  test('a surrogate pair at the cut is not split', () => {
    const body = `${'a'.repeat(SUBTITLE_MAX_TEXT_CHARS - 1)}\u{1F600}tail`;
    const [cue] = cuesOf(
      read(`1\n00:00:01,000 --> 00:00:02,000\n${body}`, 'srt')
    ) as [SubtitleCue];
    expect(cue.truncated).toBe(true);
    expect(cue.text.endsWith('\uD83D') || cue.text.endsWith('\u{1F600}')).toBe(
      false
    );
    expect(cue.text.length).toBe(SUBTITLE_MAX_TEXT_CHARS - 1);
  });

  test('exactly the cue limit is accepted, one more is refused whole', () => {
    const cueBlock = (n: number): string =>
      `${n}\n00:00:01,000 --> 00:00:02,000\nx`;
    const atLimit = Array.from({ length: SUBTITLE_MAX_CUES }, (_, i) =>
      cueBlock(i + 1)
    ).join('\n\n');
    expect(read(atLimit, 'srt').cueCount).toBe(SUBTITLE_MAX_CUES);
    const over = `${atLimit}\n\n${cueBlock(SUBTITLE_MAX_CUES + 1)}`;
    const started = performance.now();
    expect(parseSubtitles(over, 'srt')).toEqual({
      ok: false,
      reason: 'too-many',
      skipped: 0,
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('a file over the byte limit is refused before any parsing', () => {
    const big = 'x'.repeat(SUBTITLE_LIMIT_BYTES + 1);
    expect(parseSubtitles(big, 'srt')).toEqual({
      ok: false,
      reason: 'too-large',
      skipped: 0,
    });
  });

  test('a long run of < characters costs linear time and reads as text', () => {
    const spam = `1\n00:00:01,000 --> 00:00:02,000\n${'<'.repeat(2_000_000)}`;
    const started = performance.now();
    const [cue] = cuesOf(read(spam, 'srt')) as [SubtitleCue];
    expect(performance.now() - started).toBeLessThan(2000);
    expect(cue.text.length).toBe(SUBTITLE_MAX_TEXT_CHARS);
    expect(cue.truncated).toBe(true);
  });

  test('deep nesting is capped with no stack growth', () => {
    const deep = `1\n00:00:01,000 --> 00:00:02,000\n${'<b>'.repeat(5000)}x`;
    const [cue] = cuesOf(read(deep, 'srt')) as [SubtitleCue];
    expect(cue.text).toBe('x');
    expect(cue.segments).toHaveLength(1);
    expect(cue.segments[0]?.bold).toBe(true);
  });

  test('the UTF-8 length matches the encoder, surrogates included', () => {
    for (const text of ['abc', 'é', '漢字', '\u{1F600}', 'a\uD800b']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
    }
  });
});
