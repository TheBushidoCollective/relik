import { expect, test } from 'bun:test';
import { suggestionIssueFor } from '../src/suggestion-gate.ts';
import type { ReadyView } from '../src/viewer.ts';

function view(filename: string, source: string, route = 'code'): ReadyView {
  return {
    filename,
    route,
    declaredMimetype: '',
    version: 1,
    currentVersion: 1,
    document: { bytes: new TextEncoder().encode(source), truncated: false },
  } as unknown as ReadyView;
}

test('CRLF suggestions require a registered structured surface', () => {
  const csv = view('table.csv', 'name,value\r\na,1\r\n');
  expect(suggestionIssueFor(csv, false)).toContain('off in Source');
  expect(suggestionIssueFor(csv, true)).toBeNull();
  expect(suggestionIssueFor(view('table.csv', 'a\r\nb\nc'), true)).toContain(
    'mixes CRLF and LF'
  );
  expect(
    suggestionIssueFor(view('notes.md', 'a\r\nb', 'markdown'), true)
  ).toContain('carriage returns');
  expect(
    suggestionIssueFor(view('notes.ipynb', '{}', 'notebook'), false)
  ).toBeNull();
});

test('unsupported documents have format-specific reasons', () => {
  expect(suggestionIssueFor(view('file.xlsx', '', 'download'), false)).toBe(
    'Suggestions work on text files. This is a spreadsheet.'
  );
  expect(suggestionIssueFor(view('file.epub', '', 'download'), false)).toBe(
    'Suggestions work on text files. This is an ebook.'
  );
  expect(suggestionIssueFor(view('file.docx', '', 'download'), false)).toBe(
    'Suggestions work on text files. This is a Word document.'
  );
});
