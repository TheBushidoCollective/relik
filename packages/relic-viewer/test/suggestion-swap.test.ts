import { expect, test } from 'bun:test';
import { guardSurfaceSwap } from '../src/suggestion-surface.ts';

test('surface swap refuses unsent or failed work but permits an active post', () => {
  const state = (
    draftOpen: boolean,
    postInFlight: boolean,
    pending: boolean
  ) => ({ draftOpen, postInFlight, hasPendingDraft: () => pending });
  expect(guardSurfaceSwap(undefined)).toBeNull();
  expect(guardSurfaceSwap(state(false, false, false))).toBeNull();
  expect(guardSurfaceSwap(state(true, false, true))).toBe(
    'Send or discard your suggestion first'
  );
  expect(guardSurfaceSwap(state(false, false, true))).toBe(
    'Send or discard your suggestion first'
  );
  expect(guardSurfaceSwap(state(false, true, true))).toBeNull();
  expect(guardSurfaceSwap(state(true, true, true))).toBe(
    'Send or discard your suggestion first'
  );
});
