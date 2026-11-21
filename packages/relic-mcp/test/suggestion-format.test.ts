import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveRendererClass } from '@relic/format';
import { suggestionSourceFor } from '@relic/format/suggestions';
import {
  buildCachedFormat,
  cachedEntryFormat,
  formatFilename,
  formatForFilename,
  loadCachedVersionFormat,
  nextVersionFormats,
  recordedVersionFormat,
  saveCachedVersionFormat,
  versionFormatFor,
  withVersionFormat,
  withVersionFormatLock,
  type VersionFormat,
} from '../src/suggestion-format.ts';

const RELIC = '0123456789abcdefghjkmnpqrs';
const OTHER_RELIC = 'tvwxyz0123456789abcdefghjk';
const KEY = Uint8Array.from({ length: 16 }, (_, index) => index);
const OTHER_KEY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
let dir: string;
let priorState: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-suggestion-format-'));
  priorState = process.env['RELIC_PUBLISH_STATE'];
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'publish-state.json');
});

afterEach(async () => {
  if (priorState === undefined) delete process.env['RELIC_PUBLISH_STATE'];
  else process.env['RELIC_PUBLISH_STATE'] = priorState;
  await rm(dir, { recursive: true, force: true });
});

function cacheFile(relicId: string, version: number): string {
  return join(
    dir,
    'publish-state.json.suggestion-formats',
    `${relicId}.${version}.bin`
  );
}

describe('suggestion format records', () => {
  test('keeps only known formats and constructs equivalent synthetic names', () => {
    const names = [
      'Dockerfile',
      'a.tar.gz',
      '.bashrc',
      'data.CSV',
      'notes.MD',
      'captions.srt',
      'subtitles.VTT',
      'spreadsheet.tsv',
      'notebook.ipynb',
      'model.stl',
      'part.obj',
      'secret.private-suffix',
      'no-extension',
    ];
    const content = new TextEncoder().encode('alpha\r\nbeta\r\n');
    for (const filename of names) {
      const synthetic = formatFilename(formatForFilename(filename));
      expect(deriveRendererClass(content, synthetic)).toBe(
        deriveRendererClass(content, filename)
      );
      expect(suggestionSourceFor(content, synthetic)).toEqual(
        suggestionSourceFor(content, filename)
      );
    }
    expect(formatForFilename('private/client.CSV')).toBe('csv');
    expect(formatForFilename('private/client.private-suffix')).toBeNull();
    expect(formatForFilename('x.constructor')).toBeNull();
    expect(formatForFilename('Dockerfile')).toBe('dockerfile');
    expect(formatFilename('dockerfile')).toBe('Dockerfile');
  });

  test('adds records without trusting malformed legacy values', () => {
    const one = versionFormatFor('file', 'hidden.CSV');
    const two = versionFormatFor('folder', 'sensitive folder');
    const state = { version_formats: withVersionFormat({}, 1, one) };
    const both = withVersionFormat(state, 2, two);
    expect(recordedVersionFormat({ version_formats: both }, 1)).toEqual(one);
    expect(recordedVersionFormat({ version_formats: both }, 2)).toEqual(two);
    expect(recordedVersionFormat({ version_formats: both }, 3)).toBeUndefined();
    const malformed = {
      version_formats: {
        '1': { shape: 'file', extension: 'secret-name' },
        '2': { shape: 'file' },
        '3': { shape: 'other' },
      },
    } as unknown as { version_formats: Record<string, VersionFormat> };
    for (const version of [1, 2, 3]) {
      expect(recordedVersionFormat(malformed, version)).toBeUndefined();
    }
    expect(recordedVersionFormat(state, 0)).toBeUndefined();
  });

  test('backfills only a known legacy single-file format on republish', () => {
    const next = { shape: 'folder' } as const;
    expect(
      nextVersionFormats({ version: 1, filename: 'notes.CSV' }, 2, next)
    ).toEqual({
      '1': { shape: 'file', extension: 'csv' },
      '2': next,
    });
    expect(
      nextVersionFormats(
        { version: 1, shape: 'file', filename: 'notes.private-suffix' },
        2,
        next
      )
    ).toEqual({
      '1': { shape: 'file', extension: null },
      '2': next,
    });

    const recorded = {
      version: 1,
      filename: 'notes.csv',
      version_formats: { '1': { shape: 'file', extension: 'txt' } as const },
    };
    expect(nextVersionFormats(recorded, 2, next)).toEqual({
      '1': { shape: 'file', extension: 'txt' },
      '2': next,
    });
    expect(recorded.version_formats['1'].extension).toBe('txt');

    const malformed = {
      version: 1,
      filename: 'notes.csv',
      version_formats: { '1': { shape: 'file', extension: 'secret-name' } },
    } as unknown as {
      version: number;
      filename: string;
      version_formats: Record<string, VersionFormat>;
    };
    expect(nextVersionFormats(malformed, 2, next)).toEqual({
      '1': { shape: 'file', extension: 'csv' },
      '2': next,
    });

    for (const state of [
      { version: 1 },
      { version: 1, filename: '' },
      { version: 1, shape: 'folder' as const, filename: 'site.md' },
    ]) {
      expect(nextVersionFormats(state, 2, next)).toEqual({ '2': next });
    }
  });

  test('keeps existing records for folder and nameless legacy states', () => {
    const existing = {
      '1': { shape: 'file', extension: 'txt' } as const,
      '2': { shape: 'folder' } as const,
    };
    const next = { shape: 'file', extension: 'md' } as const;
    for (const state of [
      { version: 2, filename: 'site.md', shape: 'folder' as const },
      { version: 2 },
    ]) {
      expect(
        nextVersionFormats({ ...state, version_formats: existing }, 3, next)
      ).toEqual({ ...existing, '3': next });
    }
  });

  test('entry digests are scoped to each relic and version, and distinguish absent entries', () => {
    const paths = ['private/client.csv', 'private/unknown.secret-suffix'];
    const one = buildCachedFormat({ shape: 'folder' }, paths, KEY, RELIC, 1);
    const next = buildCachedFormat({ shape: 'folder' }, paths, KEY, RELIC, 2);
    const other = buildCachedFormat(
      { shape: 'folder' },
      paths,
      KEY,
      OTHER_RELIC,
      1
    );
    if (
      one.shape !== 'folder' ||
      next.shape !== 'folder' ||
      other.shape !== 'folder'
    ) {
      throw new Error('expected folder cache');
    }
    expect(Object.keys(one.entries)).not.toEqual(Object.keys(next.entries));
    expect(Object.keys(one.entries)).not.toEqual(Object.keys(other.entries));
    expect(JSON.stringify(one)).not.toContain('private');
    expect(cachedEntryFormat(one, paths[0]!, KEY, RELIC, 1)).toEqual({
      found: true,
      extension: 'csv',
    });
    expect(cachedEntryFormat(one, paths[1]!, KEY, RELIC, 1)).toEqual({
      found: true,
      extension: null,
    });
    expect(cachedEntryFormat(one, 'not-present.csv', KEY, RELIC, 1)).toEqual({
      found: false,
      extension: null,
    });
    expect(cachedEntryFormat(one, paths[0]!, KEY, RELIC, 2)).toEqual({
      found: false,
      extension: null,
    });
  });

  test('encrypts and authenticates the cache under the version key', async () => {
    const path = 'confidential/client-plan.csv';
    const format = buildCachedFormat(
      { shape: 'folder' },
      [path],
      KEY,
      RELIC,
      1
    );
    expect(await loadCachedVersionFormat(RELIC, 1, KEY)).toBeUndefined();
    await saveCachedVersionFormat(RELIC, 1, KEY, format);
    expect(await loadCachedVersionFormat(RELIC, 1, KEY)).toEqual(format);
    const file = cacheFile(RELIC, 1);
    const bytes = await readFile(file);
    expect(bytes.includes(Buffer.from(path))).toBe(false);
    expect(bytes.includes(Buffer.from('client-plan'))).toBe(false);
    expect(bytes.includes(Buffer.from('"shape":"folder"'))).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(dir, 'publish-state.json.suggestion-formats'))).mode &
        0o777
    ).toBe(0o700);
    await expect(
      loadCachedVersionFormat(RELIC, 1, OTHER_KEY)
    ).rejects.toThrow();
    await copyFile(file, cacheFile(RELIC, 2));
    await expect(loadCachedVersionFormat(RELIC, 2, KEY)).rejects.toThrow();
    await copyFile(file, cacheFile(OTHER_RELIC, 1));
    await expect(
      loadCachedVersionFormat(OTHER_RELIC, 1, KEY)
    ).rejects.toThrow();
  });

  test('refuses corruption or conflicting contents rather than replacing them', async () => {
    const format = buildCachedFormat(
      { shape: 'folder' },
      ['one.md'],
      KEY,
      RELIC,
      1
    );
    await saveCachedVersionFormat(RELIC, 1, KEY, format);
    const file = cacheFile(RELIC, 1);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(file, bytes);
    await expect(loadCachedVersionFormat(RELIC, 1, KEY)).rejects.toThrow();
    await expect(
      saveCachedVersionFormat(RELIC, 1, KEY, format)
    ).rejects.toThrow();
    expect(await readFile(file)).toEqual(bytes);

    const other = buildCachedFormat(
      { shape: 'folder' },
      ['one.md'],
      KEY,
      RELIC,
      2
    );
    const conflict = buildCachedFormat(
      { shape: 'folder' },
      ['two.md'],
      KEY,
      RELIC,
      2
    );
    await saveCachedVersionFormat(RELIC, 2, KEY, other);
    await expect(
      saveCachedVersionFormat(RELIC, 2, KEY, conflict)
    ).rejects.toThrow();
    expect(await loadCachedVersionFormat(RELIC, 2, KEY)).toEqual(other);
  });

  test('does not report success when the cache directory cannot be created', async () => {
    await writeFile(
      join(dir, 'publish-state.json.suggestion-formats'),
      'not a directory'
    );
    const format = buildCachedFormat(
      { shape: 'folder' },
      ['one.md'],
      KEY,
      RELIC,
      1
    );
    await expect(
      saveCachedVersionFormat(RELIC, 1, KEY, format)
    ).rejects.toThrow();
  });

  test('serializes recovery for the same relic and version', async () => {
    const events: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withVersionFormatLock(RELIC, 1, async () => {
      events.push('first start');
      started();
      await gate;
      events.push('first end');
    });
    const second = withVersionFormatLock(RELIC, 1, async () => {
      events.push('second start');
    });
    await firstStarted;
    expect(events).toEqual(['first start']);
    unblock();
    await Promise.all([first, second]);
    expect(events).toEqual(['first start', 'first end', 'second start']);
  });
});
