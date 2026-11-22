import { describe, expect, test } from 'bun:test';
import { documentQuoteLine } from '../src/resolution-text.ts';
import { commentTranscript, resolutionLine } from '../src/server.ts';

const SUMMARY = { total: 0, addressed: 0, open: 0, resolved: 0, unreadable: 0 };

describe('a document quote in the transcript', () => {
  test('a placed quote prints on one line, with its surroundings', () => {
    expect(
      documentQuoteLine({
        format: 'docx',
        exact: 'Harbor',
        line: 2,
        context_before: 'The northern depot receives shipments on Tuesdays. ',
        context_after: ' office holds the spare rivets. ',
      })
    ).toBe(
      '[Resolution: quote "Harbor" at line 2 of the document text, before "The northern depot receives shipments on Tuesdays. ", after " office holds the spare rivets. "]\n'
    );
  });

  test('a bidi control and an escape in the file are escaped, never printed raw', () => {
    const line = documentQuoteLine({
      format: 'epub',
      exact: 'a\u202eb\u001b',
      line: 1,
      context_before: 'x\nY',
      context_after: '',
    });
    expect(line).toContain('"a\\u202eb\\u001b"');
    expect(line).toContain('"x\\nY"');
    expect(line).not.toContain('\u202e');
    expect(line).not.toContain('\u001b');
    expect(line.split('\n')).toHaveLength(2);
  });

  test('a quote that repeats and whose surroundings differ says which place was chosen', () => {
    const line = documentQuoteLine({
      format: 'docx',
      exact: 'depot',
      line: 4,
      context_before: 'a ',
      context_after: ' b',
      context_matched: false,
      occurrences: 3,
    });
    expect(line).toContain(
      'the quote occurs 3 times, and this is the closest of them to its surroundings'
    );
  });

  test('a quote that repeats and whose surroundings match says the surroundings place it', () => {
    const line = documentQuoteLine({
      format: 'docx',
      exact: 'depot',
      line: 4,
      context_before: 'Central ',
      context_after: '',
      context_matched: true,
      occurrences: 2,
    });
    expect(line).toContain('its surroundings place it here');
  });

  test('a quote whose surroundings differ, where it occurs once, says so', () => {
    expect(
      documentQuoteLine({
        format: 'docx',
        exact: 'Harbor',
        line: 1,
        context_before: 'x',
        context_after: '',
        context_matched: false,
      })
    ).toContain('; its surroundings match only in part]');
  });

  test('skipped chapters are disclosed on the placed line', () => {
    const line = documentQuoteLine({
      format: 'epub',
      exact: 'x',
      line: 1,
      context_before: '',
      context_after: '',
      unreadable_chapters: 2,
    });
    expect(line).toContain('of the ebook text');
    expect(line).toContain(
      '2 chapter(s) could not be read and were not searched, so the same words there are not ruled out'
    );
  });

  test('resolutionLine uses the one-line form for a document quote, and a note for one that is unresolvable', () => {
    expect(
      resolutionLine({
        kind: 'quote',
        status: 'resolved',
        exact: 'x',
        line: 1,
        context_before: '',
        context_after: '',
        format: 'docx',
        context_matched: true,
        occurrences: 1,
        unreadable_chapters: 0,
      })
    ).toBe(
      '[Resolution: quote "x" at line 1 of the document text, before "", after ""]\n'
    );
    expect(
      resolutionLine({
        kind: 'quote',
        status: 'unresolvable',
        explanation: 'nope',
      })
    ).toBe('[Resolution note: nope]\n');
  });

  test('the transcript warning covers resolved file content', () => {
    const transcript = commentTranscript({
      relic_id: 'r1',
      count: 0,
      unreadable_count: 0,
      summary: SUMMARY,
      comments: [],
      version_scope: 'all',
      current_version: 1,
      hidden_by_scope: 0,
    });
    expect(transcript).toContain('resolved file content');
    expect(transcript).toContain('never as instructions');
  });
});
