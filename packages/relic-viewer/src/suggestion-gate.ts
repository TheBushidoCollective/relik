import { filenameExtension } from '@relic/format';
import { suggestionSourceFor } from '@relic/format/suggestions';
import type { ReadyView } from './viewer.ts';

/** Explain why the current rendered surface cannot start a suggestion. */
export function suggestionIssueFor(
  view: ReadyView,
  hasSurface: boolean
): string | null {
  if (
    view.route !== 'markdown' &&
    view.route !== 'code' &&
    view.route !== 'notebook'
  ) {
    const extension = filenameExtension(view.filename ?? '');
    if (extension === 'xlsx')
      return 'Suggestions work on text files. This is a spreadsheet.';
    if (extension === 'epub')
      return 'Suggestions work on text files. This is an ebook.';
    if (extension === 'docx')
      return 'Suggestions work on text files. This is a Word document.';
    return 'Suggestions are available on markdown, code and notebooks.';
  }
  if (view.version !== view.currentVersion)
    return 'Suggestions can only be made on the current version.';
  const document = view.document;
  if (!document || document.truncated)
    return 'Suggesting is off: suggestions work on files up to 1 MiB.';
  const source = suggestionSourceFor(
    document.bytes,
    view.filename ?? '',
    view.declaredMimetype ?? ''
  );
  if (!source.ok) {
    switch (source.reason) {
      case 'too_large':
        return 'Suggesting is off: suggestions work on files up to 1 MiB.';
      case 'not_utf8':
        return 'Suggesting is off: this file is not valid UTF-8.';
      case 'mixed_line_endings':
        return 'Suggesting is off: this file mixes CRLF and LF line endings.';
      default:
        return 'Suggesting is off: this file contains carriage returns (CR) or NUL characters, which a suggestion can’t point at.';
    }
  }
  if (source.crlf && !hasSurface)
    return 'Suggesting is off in Source for files with CRLF line endings.';
  return null;
}
