import { compareEntryPaths } from '@relic/format';
import { CONTENT_BATCH_BYTES, type RelicContent } from './content.ts';
import type { ReadyView } from './viewer.ts';

interface Side {
  readonly path: string;
  readonly content: RelicContent;
  readonly offset: number;
  readonly length: number;
  readonly index?: number;
}

export interface FileComparison {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed' | 'unchanged';
  readonly beforeIndex?: number;
  readonly afterIndex?: number;
}

function entries(view: ReadyView, safeName: (name: string) => string): Side[] {
  if (!view.folder)
    return [
      {
        path: safeName(view.filename) || 'file',
        content: view.content,
        offset: 0,
        length: view.content.size,
      },
    ];
  return view.folder.manifest.entries.map((entry, index) => ({
    path: entry.path,
    content: view.folder!.whole,
    offset: entry.offset,
    length: entry.length,
    index,
  }));
}

async function equal(a: Side, b: Side): Promise<boolean> {
  if (a.length !== b.length) return false;
  for (let offset = 0; offset < a.length; offset += CONTENT_BATCH_BYTES) {
    const size = Math.min(CONTENT_BATCH_BYTES, a.length - offset);
    const [left, right] = await Promise.all([
      a.content.read(a.offset + offset, a.offset + offset + size),
      b.content.read(b.offset + offset, b.offset + offset + size),
    ]);
    if (
      left.length !== right.length ||
      !left.every((byte, i) => byte === right[i])
    )
      return false;
  }
  return true;
}

export async function compareFolderFiles(
  before: ReadyView,
  after: ReadyView,
  safeName: (name: string) => string
): Promise<FileComparison[]> {
  const left = new Map(
    entries(before, safeName).map((entry) => [entry.path, entry])
  );
  const right = new Map(
    entries(after, safeName).map((entry) => [entry.path, entry])
  );
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort(
    compareEntryPaths
  );
  const result: FileComparison[] = [];
  for (const path of paths) {
    const a = left.get(path);
    const b = right.get(path);
    result.push({
      path,
      kind: !a
        ? 'added'
        : !b
          ? 'removed'
          : (await equal(a, b))
            ? 'unchanged'
            : 'changed',
      ...(a?.index === undefined ? {} : { beforeIndex: a.index }),
      ...(b?.index === undefined ? {} : { afterIndex: b.index }),
    });
  }
  return result;
}
