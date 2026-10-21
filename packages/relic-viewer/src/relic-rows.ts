import type { VaultEntry } from './vault.ts';

export interface KeyVault {
  recall?(relicId: string): string | undefined;
  list?(): readonly VaultEntry[];
}

export interface CommentedRelic {
  readonly relic_id: string;
  readonly title: string;
  readonly renderer_class: string;
  readonly version: number;
  readonly published_at: string;
  readonly expires_at: string | null;
  readonly last_comment_at: string;
}

export type DashboardPreviewKind =
  | 'document'
  | 'code'
  | 'image'
  | 'page'
  | 'component'
  | 'media'
  | 'pdf'
  | 'archive'
  | 'file'
  | 'relic';

export interface DashboardRelicRow {
  readonly relicId: string;
  readonly title: string;
  readonly hasKey: boolean;
  readonly fragment?: string | undefined;
  readonly previewKind: DashboardPreviewKind;
  readonly previewLabel: string;
}

export function dashboardPreview(renderer: string | undefined): {
  readonly kind: DashboardPreviewKind;
  readonly label: string;
} {
  switch (renderer) {
    case 'markdown':
      return { kind: 'document', label: 'Document' };
    case 'code':
      return { kind: 'code', label: 'Code' };
    case 'image':
      return { kind: 'image', label: 'Image' };
    case 'html':
    case 'sandboxed-html':
      return { kind: 'page', label: 'Page' };
    case 'jsx':
    case 'sandboxed-jsx':
      return { kind: 'component', label: 'Component' };
    case 'otio':
      return { kind: 'media', label: 'OTIO timeline' };
    case 'media':
      return { kind: 'media', label: 'Media' };
    case 'pdf':
      return { kind: 'pdf', label: 'PDF' };
    case 'archive':
      return { kind: 'archive', label: 'Archive' };
    case 'binary':
    case 'download':
      return { kind: 'file', label: 'File' };
    default:
      return { kind: 'relic', label: 'Relic' };
  }
}

/**
 * A stored fragment can come from either side of the key-vault cutover.
 *
 * The shipped vault stored `#r1...`; new key entry stores `r1...`. Dashboard
 * links add the address-bar marker themselves, so letting the old marker
 * through produces `##r1...`, which is a different and invalid key. The row
 * model owns canonicalisation so every renderer gets one shape.
 */
export function canonicalStoredFragment(fragment: string): string {
  return fragment.replace(/^#+/, '');
}

export function buildLocalDashboardRows(
  vault: KeyVault
): readonly DashboardRelicRow[] {
  const list = vault.list ? vault.list() : [];
  return list.map((entry: VaultEntry) => {
    const preview = dashboardPreview(entry.renderer);
    return {
      relicId: entry.relicId,
      title:
        entry.title && entry.title.length > 0 ? entry.title : entry.relicId,
      hasKey: true,
      fragment: canonicalStoredFragment(entry.fragment),
      previewKind: preview.kind,
      previewLabel: preview.label,
    };
  });
}

export function buildCommentedDashboardRows(
  commented: readonly CommentedRelic[],
  vault: KeyVault
): readonly DashboardRelicRow[] {
  return commented.map((item) => {
    const recalled = vault.recall ? vault.recall(item.relic_id) : undefined;
    const fragment =
      recalled === undefined ? undefined : canonicalStoredFragment(recalled);
    const preview = dashboardPreview(item.renderer_class);
    return {
      relicId: item.relic_id,
      title: item.title && item.title.length > 0 ? item.title : item.relic_id,
      hasKey: fragment !== undefined,
      fragment,
      previewKind: preview.kind,
      previewLabel: preview.label,
    };
  });
}

/**
 * Returns rows from the local key vault ordered by recency of opening
 * (`lastOpenedAt` descending). Entries without a `lastOpenedAt` timestamp are
 * placed after all opened entries, maintaining their stable relative order from
 * the vault list.
 */
export function homeRelicRows(vault: KeyVault): readonly DashboardRelicRow[] {
  const list = vault.list ? vault.list() : [];
  const indexed = list.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    const aTime = a.entry.lastOpenedAt;
    const bTime = b.entry.lastOpenedAt;
    const aHas = typeof aTime === 'number' && !Number.isNaN(aTime);
    const bHas = typeof bTime === 'number' && !Number.isNaN(bTime);
    if (aHas && bHas) {
      if (bTime !== aTime) {
        return bTime - aTime;
      }
    }
    if (aHas) return -1;
    if (bHas) return 1;
    return a.index - b.index;
  });
  return indexed.map(({ entry }) => {
    const preview = dashboardPreview(entry.renderer);
    return {
      relicId: entry.relicId,
      title:
        entry.title && entry.title.length > 0 ? entry.title : entry.relicId,
      hasKey: true,
      fragment: canonicalStoredFragment(entry.fragment),
      previewKind: preview.kind,
      previewLabel: preview.label,
    };
  });
}
