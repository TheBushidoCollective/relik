import type { RendererClass } from './renderer-class.ts';

export interface HomepageFormat {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly classes: readonly RendererClass[];
  readonly structuredKinds: readonly string[];
  readonly extensions: readonly string[];
  /**
   * A `pending` row names a format the viewer already handles but that readers
   * cannot yet receive end to end (nothing can publish it). The homepage omits
   * it, and the coverage guard still requires it, so it cannot be forgotten.
   * Removing the flag is the release step for the format.
   */
  readonly availability?: 'pending';
}

export const HOMEPAGE_FORMATS: readonly HomepageFormat[] = [
  {
    id: 'text',
    label: 'Markdown, code, text',
    description: 'Documents and source rendered inline.',
    classes: ['markdown', 'code'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'images',
    label: 'Images, SVG',
    description: 'Images inline; SVG in a sandboxed frame.',
    classes: ['image'],
    structuredKinds: [],
    extensions: ['svg'],
  },
  {
    id: 'pdf',
    label: 'PDF',
    description: 'An in-browser document viewer.',
    classes: ['pdf'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'tables',
    label: 'CSV, TSV',
    description: 'A sortable table.',
    classes: [],
    structuredKinds: ['table'],
    extensions: ['csv', 'tsv'],
  },
  {
    id: 'json',
    label: 'JSON',
    description: 'A collapsible tree.',
    classes: [],
    structuredKinds: ['tree'],
    extensions: ['json'],
  },
  {
    id: 'subtitles',
    label: 'SRT, VTT',
    description: 'A list of subtitle cues.',
    classes: [],
    structuredKinds: ['cues'],
    extensions: ['srt', 'vtt'],
  },
  {
    id: 'notebook',
    label: 'Jupyter notebooks',
    description: 'A notebook with outputs.',
    classes: ['notebook'],
    structuredKinds: ['notebook'],
    extensions: ['ipynb'],
  },
  {
    id: 'document',
    label: 'Word documents, EPUB',
    description: 'Document and ebook files.',
    classes: ['document'],
    structuredKinds: [],
    extensions: ['docx', 'epub'],
    availability: 'pending',
  },
  {
    id: 'spreadsheet',
    label: 'Excel workbooks',
    description: 'Spreadsheet files.',
    classes: ['spreadsheet'],
    structuredKinds: [],
    extensions: ['xlsx'],
    availability: 'pending',
  },
  {
    id: 'model',
    label: 'STL, OBJ',
    description: 'A rotatable 3D view.',
    classes: ['model'],
    structuredKinds: [],
    extensions: ['stl', 'obj'],
  },
  {
    id: 'media',
    label: 'Audio, video',
    description: 'An in-browser player.',
    classes: ['media'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'otio',
    label: 'OpenTimelineIO',
    description: 'A timeline player with tracks, trims and dissolves.',
    classes: ['otio'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'html',
    label: 'HTML, JSX',
    description:
      'A sandboxed frame that blocks web requests. Inline what the page needs.',
    classes: ['html', 'jsx'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'folder',
    label: 'Folders and .zip files',
    description: 'A file tree. Each file opens as it would on its own.',
    classes: ['folder'],
    structuredKinds: [],
    extensions: [],
  },
  {
    id: 'download',
    label: 'Anything else',
    description: 'Archives and unrecognized binary files download.',
    classes: ['archive', 'binary'],
    structuredKinds: [],
    extensions: [],
  },
];

/** The rows of a registry that readers can receive today (pending rows are not). */
export function releasedFormats(
  rows: readonly HomepageFormat[]
): readonly HomepageFormat[] {
  return rows.filter((row) => row.availability !== 'pending');
}

/** The rows the homepage lists: every format a reader can receive today. */
export const RELEASED_HOMEPAGE_FORMATS: readonly HomepageFormat[] =
  releasedFormats(HOMEPAGE_FORMATS);
