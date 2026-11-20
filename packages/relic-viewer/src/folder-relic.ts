import {
  decodeManifest,
  type FolderHeader,
  type FolderManifest,
  StrictParseError,
} from '@relic/format';
import { contentFromBlob, type RelicContent } from './content.ts';
import { routeContent, type ReadyView } from './viewer.ts';

export interface FolderRelic {
  readonly header: FolderHeader;
  readonly manifest: FolderManifest;
  readonly whole: RelicContent;
  readonly index: number;
}

/** Reads only the bounded manifest; entry bodies remain in the shared Blob. */
export async function openFolderRelic(
  header: FolderHeader,
  whole: RelicContent
): Promise<FolderRelic> {
  if (whole.size !== header.contentLength)
    throw new StrictParseError('folder content length mismatch');
  const manifest = decodeManifest(
    await whole.read(0, header.manifestLength),
    header
  );
  return { header, manifest, whole, index: manifest.defaultIndex };
}

export async function entryView(
  view: ReadyView,
  index: number
): Promise<ReadyView> {
  const folder = view.folder;
  const entry = folder?.manifest.entries[index];
  if (!folder || !entry) throw new RangeError('Invalid folder entry');
  const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  const content = await contentFromBlob(
    folder.whole
      .blob('application/octet-stream')
      .slice(entry.offset, entry.offset + entry.length)
  );
  const route = await routeContent(filename, entry.mimetype, content);
  return {
    ...view,
    filename,
    declaredMimetype: entry.mimetype,
    content,
    document: route.document,
    route: route.route,
    downgradeNotice: route.notice,
    componentModule: route.componentModule,
    folder: { ...folder, index },
  };
}
