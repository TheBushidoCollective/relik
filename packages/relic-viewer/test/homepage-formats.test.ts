import { describe, expect, test } from 'bun:test';
import {
  CLASS_BEHAVIOUR,
  EXTENSIONS,
  HOMEPAGE_FORMATS,
  modelFormatFromFilename,
  RENDERER_CLASSES,
} from '@relic/format';
import {
  EXTENSION_KINDS,
  STRUCTURED_MARKER_LABELS,
} from '../src/structured-view-bridge.ts';

describe('homepage format coverage', () => {
  test('each renderer class is represented exactly once, including downloads', () => {
    const classes = HOMEPAGE_FORMATS.flatMap((row) => row.classes);
    for (const cls of RENDERER_CLASSES) {
      expect(classes.filter((value) => value === cls)).toHaveLength(1);
      const row = HOMEPAGE_FORMATS.find((entry) => entry.classes.includes(cls));
      expect(row?.id === 'download').toBe(CLASS_BEHAVIOUR[cls] === 'downloads');
    }
    for (const cls of classes) expect(RENDERER_CLASSES).toContain(cls);
    expect(new Set(HOMEPAGE_FORMATS.map((row) => row.id)).size).toBe(
      HOMEPAGE_FORMATS.length
    );
  });

  test('each structured kind and extension is represented exactly once', () => {
    const kinds = HOMEPAGE_FORMATS.flatMap((row) => row.structuredKinds);
    const extensions = HOMEPAGE_FORMATS.flatMap((row) => row.extensions);
    const actualKinds = Object.keys(STRUCTURED_MARKER_LABELS);
    for (const kind of actualKinds)
      expect(kinds.filter((value) => value === kind)).toHaveLength(1);
    for (const kind of kinds) expect(actualKinds).toContain(kind);
    for (const [extension, kind] of Object.entries(EXTENSION_KINDS)) {
      expect(extensions.filter((value) => value === extension)).toHaveLength(1);
      expect(
        HOMEPAGE_FORMATS.find((row) => row.extensions.includes(extension))
          ?.structuredKinds
      ).toContain(kind);
    }
    for (const extension of extensions) {
      expect(extensions.filter((value) => value === extension)).toHaveLength(1);
      expect(
        Object.hasOwn(EXTENSION_KINDS, extension) ||
          Object.hasOwn(EXTENSIONS, extension) ||
          modelFormatFromFilename(`x.${extension}`) !== undefined
      ).toBe(true);
    }
  });
});
