import { expect, test } from 'bun:test';
import { createSandboxHandler } from '../src/sandbox.ts';

const annotation = {
  type: 'relic:annotate',
  marks: [{ path: [0], kind: 'changed' }],
};

test('cover HTML disables image controls and rejects annotation', () => {
  let controlsEnabled: boolean | undefined;
  let annotations = 0;
  const handle = createSandboxHandler(
    (_markup, enabled) => {
      controlsEnabled = enabled;
    },
    () => {},
    () => {
      annotations++;
    }
  );
  expect(handle({ type: 'relic:render', html: '<img>', cover: true })).toBe(
    true
  );
  expect(controlsEnabled).toBe(false);
  expect(handle(annotation)).toBe(false);
  expect(annotations).toBe(0);
});

test('cover JSX rejects annotation', () => {
  let annotations = 0;
  const handle = createSandboxHandler(
    () => {},
    () => {},
    () => {
      annotations++;
    }
  );
  expect(handle({ type: 'relic:render-jsx', code: '', cover: true })).toBe(
    true
  );
  expect(handle(annotation)).toBe(false);
  expect(annotations).toBe(0);
});

test('reader HTML retains image controls and annotation', () => {
  let controlsEnabled: boolean | undefined;
  let annotations = 0;
  const handle = createSandboxHandler(
    (_markup, enabled) => {
      controlsEnabled = enabled;
    },
    () => {},
    () => {
      annotations++;
    }
  );
  expect(handle({ type: 'relic:render', html: '<img>' })).toBe(true);
  expect(controlsEnabled).toBe(true);
  expect(handle(annotation)).toBe(true);
  expect(annotations).toBe(1);
});
