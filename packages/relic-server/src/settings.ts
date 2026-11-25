import type { RelicSettingsJSON } from '@relic/format/private';
import type { RelicRow } from './store.ts';

/** The effective settings of a row, including defaults for legacy reliks. */
export function settingsView(row: RelicRow): RelicSettingsJSON {
  return {
    suggestions: row.settings?.suggestions ?? true,
    comments: row.settings?.comments ?? true,
    decisions: row.decisionsOpen ?? false,
    signing: row.settings?.signing ?? true,
    notifications: row.settings?.notifications ?? true,
    changed_at:
      row.settingsChangedAt === undefined
        ? null
        : new Date(row.settingsChangedAt).toISOString(),
    changed_by: row.settingsChangedBy ?? null,
    expires_at:
      row.expiresAt === undefined
        ? null
        : new Date(row.expiresAt).toISOString(),
  };
}
