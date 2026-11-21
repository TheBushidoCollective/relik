import { describe, expect, test } from 'bun:test';
import {
  type HomepageFormat,
  HOMEPAGE_FORMATS,
  RELEASED_HOMEPAGE_FORMATS,
  releasedFormats,
} from '../src/supported-formats.ts';

const row = (id: string, availability?: 'pending'): HomepageFormat => ({
  id,
  label: id,
  description: `${id} description`,
  classes: [],
  structuredKinds: [],
  extensions: [],
  ...(availability === undefined ? {} : { availability }),
});

describe('releasedFormats', () => {
  test('leaves out a pending row and keeps every other row in order', () => {
    const rows = [row('a'), row('b', 'pending'), row('c')];
    expect(releasedFormats(rows).map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  test('a registry with no pending row is returned whole', () => {
    const rows = [row('a'), row('b')];
    expect(releasedFormats(rows)).toEqual(rows);
  });

  test('the homepage registry is released through the same filter', () => {
    expect(RELEASED_HOMEPAGE_FORMATS).toEqual(
      releasedFormats(HOMEPAGE_FORMATS)
    );
  });
});
