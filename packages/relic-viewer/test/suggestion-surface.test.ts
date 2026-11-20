import { expect, test } from 'bun:test';
import {
  registerSuggestionSurface,
  suggestionSurfaceFor,
  type SuggestionSurface,
} from '../src/suggestion-surface.ts';

function fixture() {
  let attached = true;
  const root = {} as HTMLElement;
  const owner = {
    contains: (node: HTMLElement) => attached && node === root,
  } as HTMLElement;
  const host = { querySelector: () => owner } as unknown as HTMLElement;
  const surface: SuggestionSurface = {
    root,
    segments: () => [{ text: 'x', start: 0, end: 1, block: 4, kind: 'text' }],
    blockKind: () => 'csv-bare',
    editable: () => true,
    repaint() {},
  };
  return {
    host,
    owner,
    surface,
    detach: () => {
      attached = false;
    },
  };
}

test('surface lookup follows the currently mounted structured root', () => {
  const { host, owner, surface, detach } = fixture();
  expect(suggestionSurfaceFor(host)).toBeUndefined();
  const unregister = registerSuggestionSurface(owner, surface);
  expect(suggestionSurfaceFor(host)).toBe(surface);
  expect(surface.blockKind(4)).toBe('csv-bare');
  expect(surface.editable(4)).toBe(true);
  detach();
  expect(suggestionSurfaceFor(host)).toBeUndefined();
  unregister();
});

test('cleanup cannot unregister a replacement surface', () => {
  const { host, owner, surface } = fixture();
  const removeOld = registerSuggestionSurface(owner, surface);
  const replacement = { ...surface, blockKind: () => 'cue' as const };
  const removeNew = registerSuggestionSurface(owner, replacement);
  removeOld();
  expect(suggestionSurfaceFor(host)).toBe(replacement);
  removeNew();
  expect(suggestionSurfaceFor(host)).toBeUndefined();
});
