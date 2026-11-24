import { describe, expect, test } from 'bun:test';
import {
  type ConfirmPref,
  createConfirmPrefs,
  parseConfirmPrefs,
  readerConfirmed,
} from '../src/confirm-prefs.ts';

function proof() {
  const confirmed = readerConfirmed({ isTrusted: true } as Event);
  if (!confirmed) throw new Error('trusted test event was refused');
  return confirmed;
}

describe('confirmation wiring', () => {
  test('large files are scoped to the signed relik version', () => {
    const prefs = createConfirmPrefs(undefined);
    prefs.remember(proof(), { kind: 'large-open', relicId: 'r1', version: 2 });
    expect(prefs.has('large-open', 'r1', 2)).toBe(true);
    expect(prefs.has('large-open', 'r1', 3)).toBe(false);
    expect(prefs.has('large-open', 'r2', 2)).toBe(false);
  });

  test('private deletion and rekey cannot be represented or remembered', () => {
    const prefs = createConfirmPrefs(undefined);
    const entries = ['private-delete', 'private-rekey', 'private-revoke'].map(
      (kind) => ({ kind, relicId: 'r1', version: 1 })
    );
    for (const entry of entries) {
      expect(prefs.remember(proof(), entry as ConfirmPref)).toBe(false);
    }
    expect(parseConfirmPrefs(JSON.stringify(entries))).toEqual([]);
    expect(prefs.list('r1')).toEqual([]);
  });

  test('preference observers see changes and can unsubscribe', () => {
    const prefs = createConfirmPrefs(undefined);
    let changes = 0;
    const stop = prefs.subscribe(() => changes++);
    const choice = { kind: 'delete-comment', relicId: 'r1' } as const;
    prefs.remember(proof(), choice);
    prefs.forget(choice);
    expect(changes).toBe(2);
    stop();
    prefs.remember(proof(), choice);
    expect(changes).toBe(2);
  });
});
