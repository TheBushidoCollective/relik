import { isRecord } from '../../relic-format/src/guards.ts';

export interface EpubBook {
  readonly title: string;
  readonly creator?: string;
  readonly language?: string;
  readonly progression: 'ltr' | 'rtl' | 'default';
  readonly layout: 'reflowable' | 'pre-paginated';
  readonly resources: readonly {
    readonly path: string;
    readonly mediaType: string;
  }[];
  readonly spine: readonly {
    readonly path: string;
    readonly linear: boolean;
  }[];
  readonly toc: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
    readonly depth: number;
  }[];
  readonly pageList: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
  }[];
}

export interface DocumentInput {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly book?: EpubBook;
  readonly requestExternalLink?: (
    event: MouseEvent,
    href: string | null
  ) => void;
}
export type DocumentOutcome =
  | { readonly state: 'ready' }
  | {
      readonly state: 'failed';
      readonly reason: 'corrupt' | 'unsupported' | 'too-large';
    };
export interface RenderDocumentMessage {
  readonly type: 'relic:render-document';
  readonly format: 'docx' | 'epub';
  readonly module: string;
  readonly entries: readonly (readonly [string, Uint8Array])[];
  readonly book?: EpubBook;
}
export type DocumentStateMessage = DocumentOutcome & {
  readonly type: 'relic:document-state';
};

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';
function isBook(value: unknown): value is EpubBook {
  if (
    !isRecord(value) ||
    typeof value['title'] !== 'string' ||
    !optionalString(value['creator']) ||
    !optionalString(value['language']) ||
    !['ltr', 'rtl', 'default'].includes(value['progression'] as string) ||
    !['reflowable', 'pre-paginated'].includes(value['layout'] as string) ||
    !Array.isArray(value['spine']) ||
    value['spine'].length > 2000 ||
    !Array.isArray(value['resources']) ||
    value['resources'].length > 10000 ||
    !Array.isArray(value['toc']) ||
    !Array.isArray(value['pageList']) ||
    value['toc'].length + value['pageList'].length > 5000
  )
    return false;
  return (
    value['resources'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['path'] === 'string' &&
        typeof item['mediaType'] === 'string'
    ) &&
    value['spine'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['path'] === 'string' &&
        typeof item['linear'] === 'boolean'
    ) &&
    value['toc'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['label'] === 'string' &&
        typeof item['path'] === 'string' &&
        optionalString(item['fragment']) &&
        Number.isSafeInteger(item['depth']) &&
        (item['depth'] as number) >= 0
    ) &&
    value['pageList'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['label'] === 'string' &&
        typeof item['path'] === 'string' &&
        optionalString(item['fragment'])
    )
  );
}

export function isRenderDocumentMessage(
  value: unknown
): value is RenderDocumentMessage {
  if (
    !isRecord(value) ||
    value['type'] !== 'relic:render-document' ||
    (value['format'] !== 'docx' && value['format'] !== 'epub') ||
    typeof value['module'] !== 'string' ||
    value['module'].length > 2 * 1024 * 1024 ||
    new TextEncoder().encode(value['module']).byteLength > 2 * 1024 * 1024 ||
    !Array.isArray(value['entries']) ||
    value['entries'].length > 10000 ||
    (value['book'] !== undefined && !isBook(value['book']))
  )
    return false;
  let total = 0;
  const names = new Set<string>();
  for (const entry of value['entries']) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      names.has(entry[0]) ||
      !(entry[1] instanceof Uint8Array)
    )
      return false;
    names.add(entry[0]);
    total += entry[1].byteLength;
    if (total > 200 * 1024 * 1024) return false;
  }
  return true;
}

export function isDocumentStateMessage(
  value: unknown
): value is DocumentStateMessage {
  if (!isRecord(value) || value['type'] !== 'relic:document-state')
    return false;
  const keys = Object.keys(value);
  if (value['state'] === 'ready') return keys.length === 2;
  return (
    value['state'] === 'failed' &&
    keys.length === 3 &&
    (value['reason'] === 'corrupt' ||
      value['reason'] === 'unsupported' ||
      value['reason'] === 'too-large')
  );
}
