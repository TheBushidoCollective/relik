import { expect, test } from 'bun:test';
import { parseSubtitles, type SubtitleCue } from '@relic/format/subtitles';
import {
  cueSourceSegments,
  decodeCueText,
  encodeCueText,
} from '../src/cue-suggest.ts';
import { SuggestDraftModel } from '../src/suggest-draft.ts';

export const cueFixtures = {
  srt: '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello <i>world</i>!\r\n',
  vtt: 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nA &amp; <b>B</b>\r\n',
};

test('cue segments map displayed text to CRLF source without consuming tags', () => {
  for (const [format, source] of Object.entries(cueFixtures) as [
    'srt' | 'vtt',
    string,
  ][]) {
    const parsed = parseSubtitles(source, format);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('fixture did not parse');
    const cue = parsed.file.entries.find(
      (entry): entry is SubtitleCue => entry.kind === 'cue'
    )!;
    const segments = cueSourceSegments(source, cue);
    expect(segments.map((s) => s.text).join('')).toBe(cue.text);
    expect(
      segments.every((s) => !source.slice(s.start, s.end).includes('<'))
    ).toBe(true);
    if (format === 'vtt') {
      const entity = segments.find((s) => s.text === '&')!;
      expect(entity.kind).toBe('escape');
      expect(source.slice(entity.start, entity.end)).toBe('&amp;');
    }
  }
});

test('cue text encoding rejects structural changes and escapes VTT text', () => {
  expect(encodeCueText('vtt', 'a & <b>')).toBe('a &amp; &lt;b&gt;');
  expect(encodeCueText('srt', '<i>')).toMatchObject({ code: 'markup-in-cue' });
  expect(encodeCueText('srt', 'a\n\nb')).toMatchObject({ code: 'ends-cue' });
  expect(encodeCueText('srt', '-->')).toMatchObject({ code: 'ends-cue' });
  expect(encodeCueText('srt', '>', '--', '')).toMatchObject({
    code: 'ends-cue',
  });
  expect(encodeCueText('srt', '\n', 'a\n', 'b')).toMatchObject({
    code: 'ends-cue',
  });
  expect(decodeCueText('vtt', '&amp;lt;&gt;')).toBe('&lt;>');
});

test('a cue edit cannot consume formatting tags or split an entity', () => {
  const source = cueFixtures.vtt;
  const parsed = parseSubtitles(source, 'vtt');
  if (!parsed.ok) throw new Error('fixture did not parse');
  const cue = parsed.file.entries.find(
    (entry): entry is SubtitleCue => entry.kind === 'cue'
  )!;
  const model = new SuggestDraftModel({
    source,
    segments: cueSourceSegments(source, cue),
    delimiters: [],
    version: 1,
    reader: 'reader@example.test',
    crlf: true,
  });
  const entity = source.indexOf('&amp;');
  expect(model.replace(entity + 1, entity + 2, 'x', 'cue')).toMatchObject({
    kind: 'refused',
  });
  const before = source.indexOf('A &amp;');
  const bold = source.indexOf('B</b>');
  expect(model.replace(before, bold + 1, 'x', 'cue')).toMatchObject({
    code: 'crosses-formatting',
  });
  expect(model.replace(bold, bold + 1, 'C', 'cue')).toMatchObject({
    kind: 'changed',
  });
});
